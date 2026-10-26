import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveTmuxSocket } from "./tmux-socket.ts";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { paneRunsShell, refuseShellPayload } from "./send-payload-guard.ts";
import { paneIsBusy } from "./fleet-watch.ts";
import { defaultTernIo, discoverTernSeatFromInspection, identifyTernSeat, observeTernSeat, parseSessionView, readSessionView,
	resolveDaemonSocket, sessionViewOfText } from "./plane-tern.ts";
import type { SessionJournalView, TernObserverIo, TernSeatBinding } from "./plane-tern.ts";

export const SEND_POLL_MS = 1500;
export const SEND_DEADLINE_MS = 15000;
export const SEND_MAX_SENDS = 2;

export interface SendExec {
	run(argv: string[], env?: NodeJS.ProcessEnv): { code: number; out: string };
}

export interface ProvenSend {
	status: "OK" | "PENDING_SUBMIT" | "NOT_DELIVERED" | "DELIVERED" | "UNDELIVERED" | "BEAD_REQUIRED" | "TMUX_AMBIGUOUS" | "ADMISSION_REFUSED";
	marker: string;
	sends: number;
	drop_path: string | null;
	detail: string;
	bead_ids: string[];
	no_bead_reason: string | null;
	tmux_socket: string | null;
}

/**
 * Tracker id shape across the fleet's .beads stores (72k ids checked):
 * `<prefix>-<seg>[-<seg>...][.<n>...]`, e.g. ompkit-xa5s, cfs-9yrif,
 * core8-h9l.31, beads_rust-abc. Matched against a whole whitespace token so
 * URLs and paths (`https://x/y-z`, `src/kit-flywheel.ts`) never qualify.
 * Linear: every repeated group starts with a distinct literal.
 */
export const BEAD_ID = /^[a-z][a-z0-9_]*(?:-[a-z0-9]+)+(?:\.[0-9]+)*$/;
const TOKEN_EDGE = /^[(\[{"'`<]+|[)\]}"'`>,;:!?.]+$/g;

/**
 * Kernel inv 4: beads are the execution substrate. A work dispatch is a
 * message whose first token is `D` (docs/DISPATCH.md pane line
 * `D AM<id> <slug>`) or that has a line starting `queue:`. The AM id token
 * is a mail reference and never counts; every other token scans, so a
 * known-prefix bead id in the slug position (or in the AM slot) counts as
 * the citation. The names after `queue:` do not count.
 */
export function dispatchBeads(message: string, knownPrefixes?: ReadonlySet<string>): { dispatch: boolean; bead_ids: string[] } {
	const lines = message.split("\n");
	const dLine = /^\s*D /.test(message);
	const queue = lines.some((line) => /^\s*queue:/.test(line));
	const bead_ids: string[] = [];
	lines.forEach((line, index) => {
		let tokens = line.trim().split(/\s+/);
		if (index === 0 && dLine) {
			// SENDBIND1 (ompkit-plii): skip only the D marker and mail ids.
			// A known-prefix bead id in the slug (or AM) slot counts below.
			tokens = tokens.filter((token, tokenIndex) => tokenIndex === 0 || !/^AM[0-9]+$/.test(token.replace(TOKEN_EDGE, "")));
		}
		const queueAt = tokens.findIndex((token) => token.startsWith("queue:"));
		if (queueAt >= 0) tokens = tokens.slice(0, queueAt);
		for (const token of tokens) {
			const bare = token.replace(TOKEN_EDGE, "");
			if (!BEAD_ID.test(bare) || bead_ids.includes(bare)) continue;
			// Shape alone admits ordinary hyphenated words (follow-up, one-line, diff-check0).
			if (!knownPrefixes?.has(bare.slice(0, bare.indexOf("-")))) continue;
			bead_ids.push(bare);
		}
	});
	return { dispatch: dLine || queue, bead_ids };
}

/** A tracker's id prefix: an uncommented `issue_prefix:` in .beads/config.yaml, else the first issue id's prefix. */
export function trackerPrefix(beadsDir: string): string | null {
	try {
		const config = readFileSync(join(beadsDir, "config.yaml"), "utf8");
		const configured = /^issue_prefix:[ \t]*"?([a-z][a-z0-9_]*)"?[ \t]*$/m.exec(config)?.[1];
		if (configured) return configured;
	} catch {}
	try {
		const head = readFileSync(join(beadsDir, "issues.jsonl"), "utf8").slice(0, 65_536);
		const id = /"id":"([a-z][a-z0-9_]*)-/.exec(head)?.[1];
		return id ?? null;
	} catch {
		return null;
	}
}

function nearestBeads(start: string): string | null {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".beads"))) return join(dir, ".beads");
		if (dirname(dir) === dir) return null;
	}
}

/**
 * Prefixes of the trackers this send can be about: OMP_KIT_BEAD_PREFIXES (comma list), every repo in the
 * fleet-watch config, and the nearest tracker above each given directory (sender and target pane). Empty
 * when none is found; then dispatchBeads falls back to the id shape alone.
 */
export function fleetBeadPrefixes(env: NodeJS.ProcessEnv, dirs: readonly string[]): Set<string> {
	const prefixes = new Set<string>();
	for (const name of (env.OMP_KIT_BEAD_PREFIXES ?? "").split(",")) if (/^[a-z][a-z0-9_]*$/.test(name.trim())) prefixes.add(name.trim());
	const home = env.HOME ?? "";
	const configPath = env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "omp-kit", "fleet-watch.json");
	const repos: string[] = [];
	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { sessions?: { repo?: unknown }[] };
		for (const session of parsed.sessions ?? []) if (typeof session.repo === "string") repos.push(session.repo);
	} catch {}
	for (const beads of [...repos.map(repo => join(repo, ".beads")), ...dirs.map(nearestBeads)]) {
		if (!beads) continue;
		const prefix = trackerPrefix(beads);
		if (prefix) prefixes.add(prefix);
	}
	return prefixes;
}

function defaultExec(): SendExec {
	return {
		run(argv, env) {
			const options = { encoding: "utf8" as const, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) };
			const run = spawnSync(argv[0]!, argv.slice(1), options);
			return { code: run.status ?? 1, out: String(run.stdout ?? "") };
		},
	};
}

const waitFor = async (ms: number) => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

function dropMessage(dropDir: string, session: string, pane: string, marker: string, message: string): string {
	mkdirSync(dropDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(dropDir, `${session}-${pane.replace(/[^A-Za-z0-9]+/g, "_")}-${stamp}-${marker}.md`);
	writeFileSync(path, `# Undelivered fleet message\n\n- session: ${session}\n- pane: ${pane}\n- marker: ${marker}\n- at: ${new Date().toISOString()}\n\n${message}\n`);
	return path;
}

/**
 * Bounded composer region as content lines: from the ❯ prompt line (prompt
 * chrome stripped) to the next separator line (starting with ─) exclusive.
 * Everything past the separator is footer chrome (model, context meters),
 * never draft text: the old tail-to-end-of-capture read mistook an idle
 * pane's footer for a draft and admission never passed. Without a ❯ prompt
 * the region falls back to the legacy tail so odd captures keep working.
 */
export function composerRegionLines(capture: string): string[] {
	const lines = capture.split("\n");
	let composerStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimStart();
		if (line.startsWith("╭──")) composerStart = i + 1;
		if (line.startsWith("─") && lines[i + 1]?.trimStart().startsWith("❯")) composerStart = i + 1;
	}
	if (composerStart < 0) return [];
	const tail = lines.slice(composerStart);
	const promptAt = tail.findIndex((line) => /^\s*❯/.test(line));
	if (promptAt < 0) return tail;
	const region: string[] = [tail[promptAt]!.replace(/^\s*❯\s?/, "")];
	for (let i = promptAt + 1; i < tail.length; i++) {
		if (/^\s*─/.test(tail[i]!)) break;
		region.push(tail[i]!);
	}
	return region;
}

/**
 * True when the marker appears in the lower-most composer region: after the
 * latest default `╭──` border or Claude `─` rule immediately above a `❯` prompt.
 */
export function markerInComposer(capture: string, marker: string): boolean {
	return composerRegionLines(capture).some((line) => line.includes(marker));
}

/** Text after the ❯ prompt in the composer region (prompt chrome excluded). */
export function composerTextAfterPrompt(capture: string): string {
	return composerRegionLines(capture).join("\n").trim();
}

/** True when the composer holds text beyond the bare prompt (ours or foreign). */
export function composerHasText(capture: string): boolean {
	return composerTextAfterPrompt(capture).length > 0;
}

/**
 * Per-destination serialization (ompkit-fp72.21 items 6-7): one lock file per
 * target pane so concurrent sends queue behind each other instead of typing
 * into the same composer. Atomic O_EXCL create; a holder whose pid is gone
 * (crashed sender) is stolen. Staleness is pid liveness only, never a clock,
 * so the wait loop stays exact under fake timers.
 */
export function paneLockPath(dropDir: string, session: string, pane: string): string {
	const safe = `${session}-${pane}`.replace(/[^A-Za-z0-9]+/g, "_");
	return resolve(join(dropDir, "..", "send-locks", `${safe}.lock`));
}

function lockHolderDead(lockPath: string): boolean {
	let pid = NaN;
	try {
		pid = Number(readFileSync(lockPath, "utf8").split(/\s/, 1)[0]);
	} catch {
		return true;
	}
	if (!Number.isSafeInteger(pid) || pid <= 0) return true;
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return true;
		return false;
	}
}

async function acquirePaneLock(lockPath: string, attempts: number, pollMs: number, wait: (ms: number) => Promise<void>): Promise<(() => void) | null> {
	mkdirSync(dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				try { rmSync(lockPath, { force: true }); } catch {}
			};
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
			if (lockHolderDead(lockPath)) {
				try { rmSync(lockPath, { force: true }); } catch {}
				continue;
			}
		}
		if (attempt + 1 < attempts) await wait(pollMs);
	}
	return null;
}

/**
 * Sweep pattern (regex-engineering §7: required `kit-send-<12hex>` matches;
 * `kit-send-xyz`/short/upper reject; a 13-hex run matches its first 12, kept
 * because only our markers carry the literal prefix and a sweep only
 * reports; 88 KB near-miss scans in 0.1 ms; regexploit silent).
 */
const SWEPT_MARKER = /kit-send-[0-9a-f]{12}/g;

export interface SweptPane {
	pane: string;
	markers: string[];
}

/**
 * Fleet sweep (ompkit-fp72.21 item 7): capture each pane and report markers
 * still sitting in a composer region. Scrollback history never counts;
 * failed captures are skipped, never reported.
 */
export async function sweepUnsentMarkers(args: {
	runTmux: (argv: string[]) => { code: number; out: string };
	panes: string[];
}): Promise<{ panes: number; unsent: SweptPane[] }> {
	const unsent: SweptPane[] = [];
	let panes = 0;
	for (const pane of args.panes) {
		const got = args.runTmux(["capture-pane", "-p", "-S", "-200", "-t", pane]);
		if (got.code !== 0) continue;
		panes++;
		const regionLines = composerRegionLines(got.out);
		if (regionLines.length === 0) continue;
		const region = regionLines.join("\n");
		const markers: string[] = [];
		for (const found of region.match(SWEPT_MARKER) ?? []) {
			if (!markers.includes(found)) markers.push(found);
		}
		if (markers.length > 0) unsent.push({ pane, markers });
	}
	return { panes, unsent };
}

/**
 * Deferred completion (ompkit-fp72.21): a message left sitting in a busy
 * pane's composer is submitted once the pane goes idle, but only while the
 * composer still holds exactly this message (marker match). Never presses
 * Enter into foreign text, never while busy, never past the bound.
 */
export async function completeDeferredSend(args: {
	runTmux: (args: string[]) => { code: number; out: string };
	wait: (ms: number) => Promise<void>;
	pollMs: number;
	untilDeliveredMs: number;
	session: string;
	pane: string;
	marker: string;
	sends: number;
	dropPath: string | null;
	bead_ids: string[];
	no_bead_reason: string | null;
	tmux_socket: string | null;
}): Promise<ProvenSend> {
	const shared = { marker: args.marker, sends: args.sends, bead_ids: args.bead_ids, no_bead_reason: args.no_bead_reason, tmux_socket: args.tmux_socket };
	const capture = () => args.runTmux(["capture-pane", "-p", "-S", "-200", "-t", args.pane]);
	const deadline = Date.now() + args.untilDeliveredMs;
	let entered = false;
	for (;;) {
		const got = capture();
		if (got.code === 0 && !paneIsBusy(got.out)) {
			if (markerInComposer(got.out, args.marker)) {
				if (!entered) {
					args.runTmux(["send-keys", "-t", args.pane, "Enter"]);
					entered = true;
				}
				await args.wait(args.pollMs);
				const again = capture();
				if (again.code !== 0 || markerInComposer(again.out, args.marker)) {
					if (Date.now() >= deadline) break;
					continue;
				}
				if (args.dropPath) { try { rmSync(args.dropPath, { force: true }); } catch {} }
				return { status: "DELIVERED", drop_path: null, detail: `marker left ${args.pane} composer after one deferred Enter`, ...shared };
			}
			if (composerHasText(got.out)) {
				return { status: "UNDELIVERED", drop_path: args.dropPath, detail: `composer of ${args.pane} holds foreign text; Enter withheld`, ...shared };
			}
			if (args.dropPath) { try { rmSync(args.dropPath, { force: true }); } catch {} }
			return { status: "DELIVERED", drop_path: null, detail: `marker gone from ${args.pane} composer without submit; receiver consumed it`, ...shared };
		}
		if (Date.now() >= deadline) break;
		await args.wait(args.pollMs);
	}
	return { status: "UNDELIVERED", drop_path: args.dropPath, detail: entered ? `marker still in ${args.pane} composer after one deferred Enter` : `pane ${args.pane} never idled within the bound; no keys sent`, ...shared };
}

/**
 * ompkit-kdbz.2.4 GOALSEND (AM55009/55134, corrected by 55136): classify a
 * leading `/goal` slash control. A bare `/goal OBJECTIVE` is a provable
 * no-op into an active goal (plain /goal refuses while a goal is active;
 * only `/goal set` replaces it), so the send envelope must never emit one.
 * Known lifecycle verbs (set/pause/resume/drop) pass this gate; adoption
 * proof (a mode_change after the attempt cursor in the bound journal) is a
 * separate live-leg criterion, not decided here.
 */
export function isBareGoalDirective(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/goal")) return false;
	const after = trimmed.slice("/goal".length);
	if (after !== "" && !/^\s/.test(after)) return false;
	const verb = after.trimStart().split(/\s+/, 1)[0] ?? "";
	return verb !== "set" && verb !== "pause" && verb !== "resume" && verb !== "drop";
}

/** USERPROV1: a seat paste is agent-authored, never a human instruction. */
function seatProvenance(text: string, env: NodeJS.ProcessEnv): { text: string; refused: false } | { refused: true; detail: string } {
	const name = (env.AGENT_NAME || env.OMP_AGENT_NAME || "").trim();
	const sender = name.toLowerCase();
	const header = text.trimStart().toLowerCase();
	const claimed = header.startsWith("[from agent ") ? header.slice(12).split(" via ", 1)[0].split("]", 1)[0] : "";
	if (sender === "josh" || sender === "joshua" || claimed === "josh" || claimed === "joshua"
		|| header.startsWith("[from joshua") || header.startsWith("[from user")
		|| name.includes("\n") || name.includes("\r") || name.includes("]")) {
		return { refused: true, detail: "SEND_PROVENANCE_FORGED: agent sends cannot claim human provenance; nothing was sent" };
	}
	if (text.trimStart().startsWith("/") || text.startsWith("[from ")) return { refused: false, text };
	return { refused: false, text: `${name ? `[from agent ${name} via omp-kit send]` : "[from an unnamed agent or kit service via omp-kit send]"}\n${text}` };
}

/**
 * Send via ntm and prove the marker landed in the target pane's capture.
 * A work dispatch citing no bead is refused before anything reaches tmux
 * unless `noBeadReason` records the exception.
 */
export async function proveSend(input: {
	session: string;
	pane: string;
	message: string;
	dropDir: string;
	noBeadReason?: string;
	/** Tracker prefixes a cited id must carry; default: fleetBeadPrefixes over the sender cwd and the target pane cwd. */
	knownPrefixes?: ReadonlySet<string>;
	exec?: SendExec;
	env?: NodeJS.ProcessEnv;
	pollMs?: number;
	deadlineMs?: number;
	wait?: (ms: number) => Promise<void>;
	/**
	 * ompkit-fp72.21: bound in ms for deferred completion of a busy-pane
	 * NOT_DELIVERED. Default 300 s for dispatches, off otherwise; explicit 0 disables.
	 */
	untilDeliveredMs?: number;
	/**
	 * ompkit-bj08.5: pause/custody admission snapshot from the caller. When
	 * present it is consulted before anything reaches tmux; a refusal sends
	 * nothing, writes no drop file and performs zero exec calls. Absent, the
	 * legacy path runs (operator invocation carries no pause declaration).
	 */
	admission?: AdmissionInput;
}): Promise<ProvenSend> {
	const provenance = seatProvenance(input.message, input.env ?? process.env);
	if (provenance.refused) {
		return { status: "ADMISSION_REFUSED", marker: "", sends: 0, drop_path: null, bead_ids: [], no_bead_reason: null, tmux_socket: null,
			detail: provenance.detail };
	}
	if (input.admission !== undefined) {
		const decision = admitActuator(input.admission);
		if (decision.verdict === "REFUSE") {
			return { status: "ADMISSION_REFUSED", marker: "", sends: 0, drop_path: null, bead_ids: [], no_bead_reason: null, tmux_socket: null,
				detail: `admission refused the send: ${decision.reason}; nothing was sent` };
		}
	}
	// ompkit-kdbz.2.4 GOALSEND: a bare /goal directive is a provable no-op
	// into an active goal. Refuse before any exec call; goal delivery uses
	// `/goal set BODY`.
	if (isBareGoalDirective(input.message)) {
		return { status: "ADMISSION_REFUSED", marker: "", sends: 0, drop_path: null, bead_ids: [], no_bead_reason: null, tmux_socket: null,
			detail: `GOAL_REQUIRES_SET_FORM: bare /goal directive refused: goal delivery requires /goal set BODY; nothing was sent` };
	}

	const exec = input.exec ?? defaultExec();
	const env = input.env ?? process.env;
	const selection = resolveTmuxSocket(env, (socket, probeEnv) =>
		exec.run(["tmux", "-S", socket, "list-sessions"], probeEnv).code === 0);
	const tmuxArgs = selection.status === "RESOLVED" ? selection.tmuxArgs : [];
	const sendEnv = selection.status === "RESOLVED" && selection.tmuxTmpdir
		? { ...env, TMUX_TMPDIR: selection.tmuxTmpdir }
		: env;
	const firstToken = input.message.trimStart().split(/\s+/, 1)[0] ?? "";
	const isSlash = firstToken.startsWith("/");
	const runTmux = (args: string[]) => exec.run(["tmux", ...tmuxArgs, ...args], sendEnv);
	// SENDX1 (ompkit-fp72.39): verify against the pane that was typed into.
	// ntm resolves `--panes=<pane>` inside SESSION, but an unqualified index
	// resolves against the caller's window, so captures must use the target
	// resolved once here: global %ids pass through, anything already
	// qualified passes through, anything else resolves via display-message
	// with a qualified fallback that still beats an unqualified index.
	const paneTarget = (() => {
		if (/^%\d+$/.test(input.pane) || input.pane.includes(":")) return input.pane;
		const probed = runTmux(["display-message", "-p", "-t", `${input.session}:${input.pane}`, "#{pane_id}"]);
		const id = probed.code === 0 ? /%\d+/.exec(probed.out)?.[0] : undefined;
		return id ?? `${input.session}:${input.pane}`;
	})();
	const slashBaseline = isSlash ? runTmux(["capture-pane", "-p", "-S", "-200", "-t", paneTarget]).out : "";
	const beads = beadAdmission(input.message, input.knownPrefixes, env, input.noBeadReason, () => [process.cwd(),
		selection.status === "RESOLVED" ? runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_current_path}"]).out.trim() : ""]);
	const { dispatch, bead_ids, no_bead_reason } = beads;
	const tmux_socket = selection.status === "RESOLVED" ? selection.socket : null;
	if (beads.required) {
		return { status: "BEAD_REQUIRED", marker: "", sends: 0, drop_path: null, bead_ids, no_bead_reason, tmux_socket,
			detail: beads.detail };
	}
	if (selection.status === "AMBIGUOUS") {
		return { status: "TMUX_AMBIGUOUS", marker: "", sends: 0, drop_path: null, bead_ids, no_bead_reason, tmux_socket: null,
			detail: `multiple live tmux servers found (${selection.sockets.join(", ")}); nothing was sent` };
	}
	const pollMs = input.pollMs ?? SEND_POLL_MS;
	const deadlineMs = input.deadlineMs ?? SEND_DEADLINE_MS;
	const wait = input.wait ?? waitFor;
	const untilDeliveredMs = input.untilDeliveredMs ?? (dispatch ? 300_000 : 0);
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	// SENDRESUME1 (ompkit-q3mw): a slash command must reach the pane verbatim.
	// Send it with no appended marker (the marker stays out of band in the
	// drop record); delivery is proved by the command effect below, never by
	// marker text echoed in the composer. Never press Enter into a slash
	// command: that would execute it twice.
	const text = isSlash ? input.message : `${provenance.text}\n[${marker}]`;
	// Per-destination serialization (ompkit-fp72.21 items 6-7): concurrent
	// sends to this pane queue behind one lock for the whole attempt,
	// including deferred completion. A lock that outlives the bound is never
	// acquired: UNDELIVERED with a recovery copy, no keys typed.
	// SENDGATE1 (ompkit-send-payload-gate-6hk3): a destructive payload typed
	// into a shell pane executes there, bypassing every command gate (the
	// gate only sees the send). The cheap local match runs first so benign
	// sends cost zero extra tmux calls; only a suspicious payload pays for
	// the pane-type query, and only a shell pane is refused. The same text
	// to an agent pane is prose and still passes.
	const payloadHit = refuseShellPayload(input.message);
	if (payloadHit) {
		const paneCmd = runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_current_command}"]);
		if (paneCmd.code === 0 && paneRunsShell(paneCmd.out)) {
			return { status: "ADMISSION_REFUSED", marker: "", sends: 0, drop_path: null, bead_ids, no_bead_reason, tmux_socket,
				detail: `send payload refused by ${payloadHit.rule}: target pane runs a shell; nothing was sent` };
		}
	}
	const lockAttempts = Math.max(1, Math.ceil((untilDeliveredMs > 0 ? untilDeliveredMs : deadlineMs) / pollMs));
	const releaseLock = await acquirePaneLock(paneLockPath(input.dropDir, input.session, input.pane), lockAttempts, pollMs, wait);
	if (!releaseLock) {
		const lockDrop = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
		return { status: "UNDELIVERED", marker, sends: 0, drop_path: lockDrop, bead_ids, no_bead_reason, tmux_socket,
			detail: `pane ${input.pane} stayed locked by another send within the bound; nothing typed, no keys sent` };
	}
	try {
		// Empty-composer admission (ompkit-fp72.21 item 7): on the armed
		// (fleet) path, never type into a composer that already holds text
		// (another send or a human draft). Wait within the bound, else
		// UNDELIVERED with no keys. Plain sends keep the legacy path.
		if (untilDeliveredMs > 0) {
			const admitAttempts = Math.max(1, Math.ceil(untilDeliveredMs / pollMs));
			let admitted = false;
			for (let i = 0; i < admitAttempts; i++) {
				const pre = runTmux(["capture-pane", "-p", "-S", "-200", "-t", paneTarget]);
				if (pre.code !== 0 || !composerHasText(pre.out)) { admitted = true; break; }
				if (i + 1 < admitAttempts) await wait(pollMs);
			}
			if (!admitted) {
				const admitDrop = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
				return { status: "UNDELIVERED", marker, sends: 0, drop_path: admitDrop, bead_ids, no_bead_reason, tmux_socket,
					detail: `composer of ${input.pane} never emptied within the bound; nothing typed, no keys sent` };
			}
		}
		if (selection.status === "UNAVAILABLE") {
			const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
			return { status: "NOT_DELIVERED", marker, sends: 0, drop_path: dropPath, bead_ids, no_bead_reason, tmux_socket: null,
				detail: `no live tmux server found; candidates checked: ${selection.candidates.join(", ")}; message written to ${dropPath}` };
		}
		for (let sends = 1; sends <= SEND_MAX_SENDS; sends++) {
			if (exec.run(["ntm", "send", input.session, "--panes=" + input.pane, text], sendEnv).code !== 0) continue;
			const started = Date.now();
			let entered = false;
			let markerSeen = false;
			let receiverActive = false;
			while (Date.now() - started < deadlineMs) {
				// Bare pane id: session:pane is parsed as a window and misses.
				// -S -200 reads scrollback history: a rendered message scrolls off
				// the visible screen but stays provable in history.
				const got = runTmux(["capture-pane", "-p", "-S", "-200", "-t", paneTarget]);
				if (got.code === 0 && (isSlash ? got.out !== slashBaseline : got.out.includes(marker))) {
					markerSeen = true;
					if (isSlash) {
						return { status: "OK", marker, sends, drop_path: null, detail: `command effect observed in ${input.pane} history after ${sends} send(s)`, bead_ids, no_bead_reason, tmux_socket };
					}
					// Text typed into the input box but never submitted is not a delivery.
					if (!markerInComposer(got.out, marker)) {
						const how = entered ? " after one Enter" : "";
						const active = receiverActive || paneIsBusy(got.out) ? ", receiver active" : "";
						return { status: "OK", marker, sends, drop_path: null, detail: `marker seen in ${input.pane} history after ${sends} send(s)${how}${active}`, bead_ids, no_bead_reason, tmux_socket };
					}
					// ompkit-rq59: a fast pickup clears the composer on its own.
					// Never force Enter into a working pane: that submits into
					// the agent's live turn and the static scrollback then reads
					// as forever-pending. Only a truly idle pane gets the single
					// bounded Enter; a busy pane is watched for a self-clear.
					if (paneIsBusy(got.out)) {
						receiverActive = true;
					} else if (!entered && !isSlash) {
						runTmux(["send-keys", "-t", paneTarget, "Enter"]);
						entered = true;
					}
				}
				await wait(pollMs);
			}
			// The text is on the pane: resending or dropping would duplicate it.
			if (entered) {
				return { status: "PENDING_SUBMIT", marker, sends, drop_path: null, detail: `marker still unsubmitted in ${input.pane} input box after one Enter`, bead_ids, no_bead_reason, tmux_socket };
			}
			// Marker visible but the pane stayed busy: the receiver owns the
			// composer now and Enter was withheld, so this send is unproven.
			// Report NOT_DELIVERED under the same marker key (no second blind
			// submit) with a recovery copy instead of a duplicate delivery.
			if (markerSeen && receiverActive) {
				const busyDropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
				if (untilDeliveredMs > 0) {
					return completeDeferredSend({ runTmux, wait, pollMs, untilDeliveredMs, session: input.session, pane: paneTarget,
						marker, sends, dropPath: busyDropPath, bead_ids, no_bead_reason, tmux_socket });
				}
				return { status: "NOT_DELIVERED", marker, sends, drop_path: busyDropPath, detail: `marker stayed in ${input.pane} composer while the pane was busy; Enter withheld to avoid a double submit; recovery copy written to ${busyDropPath}`, bead_ids, no_bead_reason, tmux_socket };
			}
		}
		const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
		const tailDetail = isSlash ? `no command effect observed in ${input.pane} history; message written to ${dropPath}` : `marker never appeared in ${input.pane} history; message written to ${dropPath}`;
		return { status: "NOT_DELIVERED", marker, sends: SEND_MAX_SENDS, drop_path: dropPath, detail: tailDetail, bead_ids, no_bead_reason, tmux_socket };
	} finally {
		releaseLock();
	}
}

/** One bead-citation admission for every send path: a work dispatch must cite a bead id of a known tracker, or carry
 * an explicit reason. `dirs` names the sender and target cwds whose trackers supply the prefixes; it runs only for a
 * dispatch with no caller-supplied prefixes (the tmux path pays for a pane query only then). */
function beadAdmission(message: string, known: ReadonlySet<string> | undefined, env: NodeJS.ProcessEnv,
	noBeadReason: string | undefined, dirs: () => string[]): { dispatch: boolean; bead_ids: string[]; no_bead_reason: string | null; required: boolean; detail: string } {
	const isDispatch = dispatchBeads(message).dispatch;
	const prefixes = !isDispatch ? new Set<string>() : known ?? fleetBeadPrefixes(env, dirs().filter((dir) => dir.startsWith("/")));
	const { dispatch, bead_ids } = dispatchBeads(message, prefixes);
	const no_bead_reason = dispatch && bead_ids.length === 0 ? noBeadReason?.trim() || null : null;
	return { dispatch, bead_ids, no_bead_reason, required: dispatch && bead_ids.length === 0 && !no_bead_reason,
		detail: `work dispatch cites no bead id${prefixes.size ? ` (tracker prefixes: ${[...prefixes].sort().join(", ")})` : ""}; nothing was sent` };
}

/** SEND1 router (rz5.125): `tern:<decimal block id>` is a Tern seat, anything else a tmux pane (bare digits are pane
 * indexes there). A `tern:` prefix without a decimal id refuses before delivery. */
export function routeSendTarget(pane: string): { route: "tern" } | { route: "tmux" } | { route: "refused"; code: "TERN_MALFORMED_ADDRESS"; detail: string } {
	if (!pane.startsWith("tern:")) return { route: "tmux" };
	return ternPaneId(pane) === null
		? { route: "refused", code: "TERN_MALFORMED_ADDRESS", detail: `${pane} is not tern:<decimal block id>; zero sends` }
		: { route: "tern" };
}

/** A fleet label without a configured Tern session is a discovery request, not a Tern address. */
export function ternSendSeat(config: unknown, session: string, pane: string,
	flags: { cwd?: string; ternSession?: string; windowKey?: string }, callerCwd: string = process.cwd()): TernSeatBinding {
	const root = config !== null && typeof config === "object" ? config as Record<string, unknown> : {};
	const entry = [root.chief, ...(Array.isArray(root.sessions) ? root.sessions : [])]
		.find((item): item is Record<string, unknown> => item !== null && typeof item === "object" && (item as Record<string, unknown>).session === session);
	const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
	return { session: flags.ternSession?.trim() || text(entry?.ternSession) || (entry ? session : ""), pane,
		windowKey: flags.windowKey?.trim() || text(entry?.windowKey),
		cwd: flags.cwd?.trim() || text(entry?.cwd) || text(entry?.repo) || (entry ? callerCwd : "") };
}

/** SEND1 Tern route (rz5.125) for the CLI: a malformed address and an uncited dispatch each refuse with zero io and no
 * drop file; anything else is deliverToTernSeat (observe, identify, one admission, session-file proof). A window key
 * admits by one native ctl turn; no key admits by `tern send BLOCK paste` + `keys Enter` (TERNADDR1, ompkit-fixjo). */
export async function proveTernCliSend(input: {
	session: string;
	pane: string;
	message: string;
	dropDir: string;
	cwd?: string;
	windowKey?: string;
	noBeadReason?: string;
	knownPrefixes?: ReadonlySet<string>;
	env?: NodeJS.ProcessEnv;
	untilDeliveredMs?: number;
	pollMs?: number;
	deadlineMs?: number;
	wait?: (ms: number) => Promise<void>;
	io?: TernObserverIo;
	composer?: (sessionFile: string) => ComposerVerdict;
}): Promise<TernDeliverResult & { bead_ids: string[]; no_bead_reason: string | null }> {
	const refuse = (code: string, detail: string, bead_ids: string[] = [], no_bead_reason: string | null = null) =>
		({ status: "REFUSED" as const, code, marker: "", sends: 0, sessionFile: null, offset: null, drop_path: null, detail, bead_ids, no_bead_reason });
	const route = routeSendTarget(input.pane);
	if (route.route === "refused") return refuse(route.code, route.detail);
	if (route.route === "tmux") return refuse("TERN_ROUTE_MISMATCH", `${input.pane} is a tmux pane; zero sends`);
	const cwd = input.cwd ?? process.cwd();
	const beads = beadAdmission(input.message, input.knownPrefixes, input.env ?? process.env, input.noBeadReason, () => [process.cwd(), cwd]);
	if (beads.required) return refuse("BEAD_REQUIRED", beads.detail, beads.bead_ids, beads.no_bead_reason);
	const io = input.io ?? defaultTernIo();
	const env = input.env ?? process.env;
	const windowKey = input.windowKey?.trim() ?? "";
	let session = input.session.trim();
	let targetCwd = cwd.trim();
	if (!session || !targetCwd) {
		const socket = resolveDaemonSocket(env);
		const window = windowKey ? ["--window", windowKey] : [];
		let inspection: { code: number; out: string };
		try {
			inspection = io.run(["tern", ...window, "inspect", "--json"], socket === null ? undefined : { TERN_DAEMON_SOCKET: socket });
		} catch {
			return refuse("OBSERVATION_UNKNOWN", "Tern inspect failed while resolving an unconfigured target; zero sends", beads.bead_ids, beads.no_bead_reason);
		}
		if (inspection.code !== 0)
			return refuse("OBSERVATION_UNKNOWN", "Tern inspect failed while resolving an unconfigured target; zero sends", beads.bead_ids, beads.no_bead_reason);
		const discovery = discoverTernSeatFromInspection(inspection.out, input.pane, { cwd: targetCwd, windowKey });
		if (discovery.status !== "FOUND")
			return refuse(discovery.status === "REFUSED" ? discovery.code : "OBSERVATION_UNKNOWN", discovery.reason, beads.bead_ids, beads.no_bead_reason);
		session ||= discovery.seat.session;
		targetCwd ||= discovery.seat.cwd;
	}
	const result = await deliverToTernSeat({ seat: { session, pane: input.pane, windowKey, cwd: targetCwd }, text: input.message,
		dropDir: input.dropDir, io, untilDeliveredMs: input.untilDeliveredMs ?? 300_000,
		pollMs: input.pollMs, deadlineMs: input.deadlineMs, wait: input.wait, composer: input.composer, env });
	return { ...result, bead_ids: beads.bead_ids, no_bead_reason: beads.no_bead_reason };
}


/**
 * Tern verified delivery (ompkit-kdbz.2.4 TERNSEND). Observation and identity
 * come from plane-tern.ts (observeTernSeat/identifyTernSeat, imported, never
 * reimplemented); this file owns the send envelope: gating, one admission,
 * session-file proof, pending persistence and drop files. tmux/herdr paths
 * above are untouched.
 *
 * Admission (TERNADDR1, ompkit-fixjo): a seat with a window key (a `tern
 * --control EP` endpoint) gets one native turn via `tern ctl carly lua`, never
 * paste or keys. A seat with no key gets `tern send BLOCK paste PAYLOAD` then
 * `tern send BLOCK keys Enter` (the pane's own window, else the first), and
 * only when the seat's own fresh kit-composer-state record says its composer
 * is empty: a draft refuses TERN_COMPOSER_BUSY, a missing/stale record
 * refuses TERN_COMPOSER_UNKNOWN, never a blind paste.
 *
 * Proof model (no screen parsing, no API receipt): a complete typed journal
 * entry strictly past the pre-send cursor, in the bound session file whose
 * pre-cursor bytes are unchanged, descending from the pre-send active leaf,
 * whose exact content hashes to what was sent: a USER message for text, a
 * new active goal mode_change with objective exactly BODY for `/goal set
 * BODY`. Stale, quoted, assistant/tool echo, wrong-session, rewritten,
 * partial and abandoned-branch entries never prove (F4).
 */

/** Mirrors respawn_seat.COMPOSER_RECORD_MAX_AGE_S (COMPOSERTRUTH1): the writer refreshes every 5 s. */
export const COMPOSER_RECORD_MAX_AGE_MS = 15_000;

export type ComposerVerdict = { state: "EMPTY" } | { state: "DRAFT" } | { state: "UNKNOWN"; reason: string };

/**
 * The seat's own kit-composer-state record (extensions/kit-composer-state.ts), read with the same freshness rule as
 * respawn_seat.composer_record: keyed by sha1(realpath(session file))[:16], schema 1, naming this session file, at
 * most COMPOSER_RECORD_MAX_AGE_MS old, writer pid alive (EPERM counts as alive). Anything else is UNKNOWN.
 */
export function readComposerRecord(sessionFile: string, opts: { dir?: string; now?: number; pidAlive?: (pid: number) => boolean } = {}): ComposerVerdict {
	let real = sessionFile;
	try { real = realpathSync(sessionFile); } catch { /* not on disk: the raw path is what the writer keyed */ }
	const dir = opts.dir ?? join(homedir(), ".local", "state", "omp-kit", "composer");
	const path = join(dir, `${createHash("sha1").update(real).digest("hex").slice(0, 16)}.json`);
	let rec: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object") return { state: "UNKNOWN", reason: "composer record is not an object" };
		rec = parsed as Record<string, unknown>;
	} catch {
		return { state: "UNKNOWN", reason: `no readable composer record at ${path}` };
	}
	if (rec.schema !== 1 || rec.session_file !== real) return { state: "UNKNOWN", reason: "composer record names another session file or schema" };
	if (typeof rec.at !== "number" || (opts.now ?? Date.now()) - rec.at > COMPOSER_RECORD_MAX_AGE_MS) {
		return { state: "UNKNOWN", reason: "composer record is stale" };
	}
	const pidAlive = opts.pidAlive ?? ((pid: number) => {
		try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
	});
	if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0 || !pidAlive(rec.pid)) {
		return { state: "UNKNOWN", reason: "composer record writer is not alive" };
	}
	if (rec.empty === true) return { state: "EMPTY" };
	if (rec.empty === false) return { state: "DRAFT" };
	return { state: "UNKNOWN", reason: "composer record has no empty flag" };
}

export const TERN_PROOF_POLL_MS = 1000;
export const TERN_PROOF_DEADLINE_MS = 20_000;
/**
 * Resolve the tern binary without hardcoding a home directory (AM58562-5):
 * explicit `TERN_CTL_BIN` env override, else `$HOME/.local/bin/tern`.
 * The path is consumed locally when spawning; GUI-process argv still needs
 * it absolute (AM58464).
 */
export function ternCtlBin(): string {
	const override = process.env.TERN_CTL_BIN;
	if (typeof override === "string" && override.trim() !== "") return override;
	const home = process.env.HOME ?? "";
	return home === "" ? "tern" : `${home}/.local/bin/tern`;
}

/**
 * Encode arbitrary text as lua `string.char(...)` byte codes (AM58562-1).
 * `tern ctl` reads its arguments as one scenario command line (`tern help
 * dev`: `#` comments, "quoted" strings, one command per line), so the Lua it
 * hands to carly is not the bytes that were sent: lines are joined, a
 * whitespace-delimited "quoted" token loses its quotes (`local x = "none"`
 * becomes `local x = none`, a nil global; `local blk = "<digits>"` becomes a
 * number), and `#` starts a comment. Verified live 2026-10-19 on an owned
 * scratch pane: carly's own echo of the turn shows the stripped quotes, and
 * `cx.session:pane` found the pane by decimal string but not by number. The
 * 2026-10-16 symptoms (`..`/`#`/backslash/`or` misparses, `sess/pane`
 * dividing) follow from the same tokenizer. The generated turn therefore
 * contains no whitespace-delimited quoted token, no `#` and no `--`, and
 * carries the payload and the block id only as decimal byte codes, so no
 * text (including `]]`, commas, quotes or newlines) can disturb parsing.
 * Caveat: carly last_tool is a single shared channel, so verdict reads during
 * concurrent fleet probing need nonce tagging; unhashed reads are
 * attribution-unsafe.
 */
export function luaCharCodes(text: string): string {
	const codes: number[] = [];
	for (const b of Buffer.from(text, "utf8")) codes.push(b);
	return codes.join(",");
}

/**
 * ompkit-kdbz.2.4 native admission turn (AM58464, revised AM58562): one
 * carly-lua turn that re-reads the pane (absent, busy or exited ends the
 * turn), reads the live dock surface, admits only a single sendable editor
 * with an empty draft and no modal layer content, then emits a single
 * evsend. Every check reads the window's own snapshot inside one
 * synchronous turn, so a BUSY/draft/modal transition the window has seen
 * before the effect cannot slip through; the OMP backend revalidates at
 * handle time (live editor id match, sendable, blank-text drop). The editor
 * test is per-node scoped: the editor id must immediately precede its
 * `"k":"editor"` tag, sendable and empty-draft markers must follow within a
 * bounded window containing no other `"k":` tag, and exactly one eligible
 * editor may exist. `block` is the bare decimal pane id (what
 * `pane`/`surface`/`event` address); anything else is refused. Returns null
 * without running anything when the block is not a bare id.
 *
 * Residual (F1, unqualified): the window's snapshot can lag the program, and
 * the event carries no program-side compare-and-send incarnation witness;
 * Tern 0.9.4's plugin API (types sha 9de89a72) offers none. A program that
 * turned busy after the window's last report journals the text as a
 * steering entry, which the proof reports as PROVEN_STEERED instead of
 * hiding it. A silent in-turn refusal leaves pending retained, never
 * auto-resent.
 */
export function buildNativeSendTurn(block: string, payload: string): string | null {
	if (!/^[0-9]+$/.test(block)) return null;
	return [
		`local blk = string.char(${luaCharCodes(block)})`,
		`local pi = cx.session:pane(blk)`,
		`if pi == nil then return end`,
		`local pb = pi.busy`,
		`if pb == true then return end`,
		`local px = pi.exited`,
		`if px == nil then`,
		`local jd = cx.session:surface(blk, {root="dock", nodes=100, max_chars=16})`,
		`if jd == nil then return end`,
		`local dj = tern.json.encode(jd)`,
		`local Q = string.char(34)`,
		`local C = string.char(44)`,
		`local SURF = jd.surface`,
		`if SURF == nil then return end`,
		`local sf = SURF.id`,
		`if sf == nil then return end`,
		`local ly = cx.session:surface(blk, {root="layer", nodes=100, max_chars=16})`,
		`local lj = tern.json.encode(ly)`,
		`local lc = lj:find([["c":]], 1, true)`,
		`if lc == nil then`,
		`local EN = 0`,
		`local EL = false`,
		`local init = 1`,
		`while true do`,
		`local ks, ke = dj:find([["k":"editor"]], init, true)`,
		`if ks == nil then break end`,
		`init = ke + 1`,
		`local eid = false`,
		`local pre = dj:sub(ks-1, ks-1)`,
		`local cq = dj:sub(ks-2, ks-2)`,
		`if pre == C then`,
		`if cq == Q then`,
		`local vs = ks - 3`,
		`while vs > 1 do`,
		`local ch = dj:sub(vs, vs)`,
		`if ch == Q then break end`,
		`vs = vs - 1`,
		`end`,
		`local tag = dj:sub(vs-5, vs-1)`,
		`if tag == [["id":]] then`,
		`eid = dj:sub(vs+1, ks-3)`,
		`end`,
		`end`,
		`end`,
		`if eid == false then return end`,
		`local nk = dj:find([["k":]], ke, true)`,
		`if nk == nil then nk = ke + 600 end`,
		`local win = dj:sub(ke, nk)`,
		`local s1 = win:find([["sendable":true]], 1, true)`,
		`if s1 == nil then return end`,
		`local t1 = win:find([["text":""]], 1, true)`,
		`if t1 == nil then return end`,
		`EN = EN + 1`,
		`if EN == 1 then EL = eid end`,
		`if EN == 2 then return end`,
		`end`,
		`if EN == 0 then return end`,
		`local text = string.char(` + luaCharCodes(payload) + `)`,
		`cx.session:event(blk, {ev="send", sf=sf, id=EL, text=text})`,
		`end`,
		`end`,
	].join("\n");
}

export type TernDeliverStatus = "OK" | "PENDING_CONSUME" | "NOT_DELIVERED" | "REFUSED";
export type TernQueueState = "QUEUED" | "DELIVERED" | "EXPIRED" | "PENDING_CONSUME" | "REFUSED";
/** Caller-declared seat posture; any stated bad value refuses with zero sends. */
export interface TernSendGate {
	paused?: boolean;
	custodyDisabled?: boolean;
	pullEnabled?: boolean;
	admitted?: boolean;
	insight?: boolean;
}
export interface TernDeliverResult {
	status: TernDeliverStatus;
	marker: string;
	sends: number;
	sessionFile: string | null;
	offset: number | null;
	drop_path: string | null;
	detail: string;
	code: string;
	queue_states?: readonly TernQueueState[];
}

/** ASCII whitespace as String.prototype.trim and the OMP sigil checks see it (tab, LF, VT, FF, CR, space). */
function isAsciiSpace(code: number): boolean {
	return code === 32 || (code >= 9 && code <= 13);
}

function firstSpaceAt(text: string): number {
	for (let i = 0; i < text.length; i++) if (isAsciiSpace(text.charCodeAt(i))) return i;
	return -1;
}

/** Pane id of a Tern seat: exact decimal digits, optionally `tern:`-prefixed. */
export function ternPaneId(pane: string): number | null {
	const digits = pane.startsWith("tern:") ? pane.slice("tern:".length) : pane;
	if (digits.length === 0) return null;
	for (let i = 0; i < digits.length; i++) {
		const code = digits.charCodeAt(i);
		if (code < 48 || code > 57) return null;
	}
	const id = Number(digits);
	return Number.isSafeInteger(id) ? id : null;
}

/**
 * What a Tern payload is to the OMP composer it lands in (2.4 GOALSEND,
 * SENDGATE1). The composer trims the submission, then runs `!cmd`/`!!cmd`
 * as bash and `$ code`/`$$ code` as Python (input-controller.ts, omp
 * 18.12.2), dispatches `/name` as a slash control, and journals anything
 * else as a USER message. `/goal set BODY` replaces or starts a goal whose
 * objective is BODY trimmed (interactive-mode.ts parseGoalSubcommand and
 * #handleGoalSetSubcommand); its proof is a new goal mode_change, so it
 * travels without a marker. Other slash controls have no journal proof
 * contract here (`/goal drop` opens a confirmation picker; `/goal set` with
 * no body opens an editor).
 */
export type TernPayloadKind =
	| { kind: "message" }
	| { kind: "goal-set"; objective: string }
	| { kind: "slash" }
	| { kind: "shell-escape"; command: string };

export function classifyTernPayload(text: string): TernPayloadKind {
	const trimmed = text.trim();
	if (trimmed.startsWith("!")) return { kind: "shell-escape", command: trimmed.slice(trimmed.startsWith("!!") ? 2 : 1).trim() };
	if (trimmed.startsWith("$")) {
		const sigil = trimmed.startsWith("$$") ? 2 : 1;
		if (trimmed.length > sigil && isAsciiSpace(trimmed.charCodeAt(sigil))) {
			return { kind: "shell-escape", command: trimmed.slice(sigil).trim() };
		}
	}
	if (!trimmed.startsWith("/")) return { kind: "message" };
	const commandEnd = firstSpaceAt(trimmed);
	if (commandEnd < 0 || trimmed.slice(0, commandEnd) !== "/goal") return { kind: "slash" };
	const args = trimmed.slice(commandEnd).trim();
	const verbEnd = firstSpaceAt(args);
	if (verbEnd < 0 || args.slice(0, verbEnd) !== "set") return { kind: "slash" };
	const objective = args.slice(verbEnd).trim();
	return objective ? { kind: "goal-set", objective } : { kind: "slash" };
}

/** What a Tern attempt must find past its cursor to prove itself (F4). */
export interface TernProofKey {
	kind: "message" | "goal-set";
	marker: string;
	/** sha256 of what the composer journals: the payload, trimmed. */
	payloadSha256: string;
	/** goal-set: the exact objective; "" for messages. */
	objective: string;
	/** goal-set: goal ids already in the prefix (a progress update of an old goal is not adoption). */
	priorGoalIds: string[];
	sessionId: string;
	leafId: string;
	cursorBytes: number;
	/** Where the journal body starts: OMP rewrites a leading title record in place. */
	bodyStart: number;
	/** Start of the pinned pre-send bytes: bodyStart for a whole read, else the last TERN_PROOF_ANCHOR_BYTES
	 * before the cursor (ompkit-774u.1.3: an over-cap journal is read as a bounded tail). */
	prefixStart: number;
	/** sha256 of journal bytes [prefixStart, cursorBytes): the pinned pre-send prefix. */
	prefixSha256: string;
	/** `dev:ino` of the pre-send file when the read reported it; a proof read of another inode never proves. */
	fileIdentity: string | null;
	/** goal-set: priorGoalIds came from the whole body; false for a tail read, so only a goal's creation record proves. */
	priorGoalIdsComplete: boolean;
}
export type TernProof =
	| { status: "PROVEN"; offset: number; entryId: string; steering: boolean }
	| { status: "ABSENT"; reason: string }
	| { status: "UNCERTAIN"; reason: string };

function sha256Hex(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function ternJournalBodyStart(bytes: Buffer): number {
	const newline = bytes.indexOf(0x0a);
	if (newline < 0) return 0;
	try {
		return recordOf(JSON.parse(bytes.subarray(0, newline).toString("utf8")))?.type === "title" ? newline + 1 : 0;
	} catch {
		return 0;
	}
}

function journalUserText(message: Record<string, unknown>): string | null {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return null;
	let text = "";
	for (const raw of message.content) {
		const block = recordOf(raw);
		if (!block || block.type !== "text" || typeof block.text !== "string") return null;
		text += block.text;
	}
	return text;
}

function goalOf(record: Record<string, unknown>): Record<string, unknown> | null {
	if (record.type !== "mode_change" || record.mode !== "goal") return null;
	return recordOf(recordOf(record.data)?.goal);
}

function entryProves(record: Record<string, unknown>, key: TernProofKey): { steering: boolean } | null {
	if (key.kind === "message") {
		const message = record.type === "message" ? recordOf(record.message) : null;
		if (!message || message.role !== "user") return null;
		const text = journalUserText(message);
		if (text === null || !text.includes(key.marker) || sha256Hex(text) !== key.payloadSha256) return null;
		return { steering: message.steering === true };
	}
	const goal = goalOf(record);
	if (!goal || goal.status !== "active" || goal.objective !== key.objective
		|| typeof goal.id !== "string" || key.priorGoalIds.includes(goal.id)) return null;
	// An older goal outside a tail read is not in priorGoalIds; a goal this send created is first journaled
	// with createdAt === updatedAt, while an older goal's later progress record has moved updatedAt on.
	if (!key.priorGoalIdsComplete && (goal.createdAt === undefined || goal.createdAt !== goal.updatedAt)) return null;
	return { steering: false };
}

function descendsFromLeaf(parentId: string | null, leafId: string, parents: ReadonlyMap<string, string | null>): boolean {
	let current = parentId;
	for (let hops = 0; hops <= parents.size; hops++) {
		if (current === null) return false;
		if (current === leafId) return true;
		if (!parents.has(current)) return false;
		current = parents.get(current) ?? null;
	}
	return false;
}

/** Bytes a tail-read proof key pins just before its cursor, beside the file's inode. */
const TERN_PROOF_ANCHOR_BYTES = 64 * 1024;

/**
 * F4 proof: only complete, newline-terminated, typed entries strictly past
 * the cursor count, and only when the pinned pre-cursor bytes are identical
 * (same session header, nothing rotated, truncated or rewritten; same inode
 * when both reads report it). The entry must descend from the pre-send leaf
 * through post-cursor entries, so a marker on another branch never proves.
 * Transcript admission is not model consumption or an ACK. A bounded view
 * whose tail no longer holds the pinned bytes proves from its proofRange (the
 * key's range read on the same fd and snapshot); without one it stays UNCERTAIN,
 * and a range that stops before the file's end never reports ABSENT.
 */
export function proveTernEntry(journal: string | SessionJournalView, key: TernProofKey): TernProof {
	const view = typeof journal === "string" ? sessionViewOfText(journal) : journal;
	if (view.fileSize < key.cursorBytes) return { status: "UNCERTAIN", reason: "JOURNAL_SHRANK" };
	if (key.fileIdentity !== null && view.identity !== null && view.identity !== key.fileIdentity) {
		return { status: "UNCERTAIN", reason: "JOURNAL_REPLACED" };
	}
	let bytes = view.tail;
	let base = view.tailStart;
	let reachesEnd = true;
	if (key.prefixStart < view.tailStart) {
		const range = view.proofRange;
		if (!range || range.start !== key.prefixStart || range.start + range.bytes.length < key.cursorBytes) {
			return { status: "UNCERTAIN", reason: "JOURNAL_PREFIX_BEYOND_WINDOW" };
		}
		base = range.start;
		const rangeEnd = range.start + range.bytes.length;
		bytes = rangeEnd >= view.tailStart
			? Buffer.concat([range.bytes.subarray(0, view.tailStart - range.start), view.tail]) : range.bytes;
		reachesEnd = rangeEnd >= view.tailStart;
	}
	if (ternJournalBodyStart(view.head) !== key.bodyStart
		|| sha256Hex(bytes.subarray(key.prefixStart - base, key.cursorBytes - base)) !== key.prefixSha256) {
		return { status: "UNCERTAIN", reason: "JOURNAL_PREFIX_CHANGED" };
	}
	const parents = new Map<string, string | null>();
	const hits: { offset: number; parentId: string | null; id: string; steering: boolean }[] = [];
	let partial = false;
	let malformed = false;
	let position = key.cursorBytes - base;
	while (position < bytes.length) {
		const newline = bytes.indexOf(0x0a, position);
		if (newline < 0) {
			partial = true;
			break;
		}
		const start = position;
		position = newline + 1;
		if (newline === start) continue;
		let record: Record<string, unknown> | null;
		try {
			record = recordOf(JSON.parse(bytes.subarray(start, newline).toString("utf8")));
		} catch {
			record = null;
		}
		if (!record) {
			malformed = true;
			continue;
		}
		if (typeof record.id !== "string" || !record.id) continue;
		if (parents.has(record.id)) {
			malformed = true;
			continue;
		}
		const parentId = typeof record.parentId === "string" ? record.parentId : null;
		parents.set(record.id, parentId);
		const match = entryProves(record, key);
		if (match) hits.push({ offset: base + start, parentId, id: record.id, steering: match.steering });
	}
	for (const hit of hits) {
		if (descendsFromLeaf(hit.parentId, key.leafId, parents)) {
			return { status: "PROVEN", offset: hit.offset, entryId: hit.id, steering: hit.steering };
		}
	}
	if (hits.length > 0) return { status: "UNCERTAIN", reason: "ENTRY_OFF_ACTIVE_BRANCH" };
	if (!reachesEnd) return { status: "UNCERTAIN", reason: "JOURNAL_PROOF_RANGE_BEYOND_WINDOW" };
	if (partial || malformed) return { status: "UNCERTAIN", reason: "PARTIAL_OR_MALFORMED_TAIL" };
	return { status: "ABSENT", reason: "NO_MATCHING_ENTRY" };
}

/** Build the proof key for an attempt from the exact pre-send journal snapshot (whole text or bounded view). */
export function buildTernProofKey(journalRead: string | SessionJournalView, journal: { sessionId: string; leafId: string },
	sent: { kind: "message" | "goal-set"; payload: string; marker: string; objective: string }): TernProofKey {
	const view = typeof journalRead === "string" ? sessionViewOfText(journalRead) : journalRead;
	const bodyStart = ternJournalBodyStart(view.head);
	const cursorBytes = view.fileSize;
	const prefixStart = view.tailStart === 0 ? bodyStart
		: Math.max(bodyStart, view.tailStart, cursorBytes - TERN_PROOF_ANCHOR_BYTES);
	const priorGoalIds: string[] = [];
	if (sent.kind === "goal-set") {
		for (const line of view.tail.toString("utf8").split("\n")) {
			if (!line.includes(`"mode_change"`)) continue;
			try {
				const goal = goalOf(recordOf(JSON.parse(line)) ?? {});
				if (goal && typeof goal.id === "string" && !priorGoalIds.includes(goal.id)) priorGoalIds.push(goal.id);
			} catch {}
		}
	}
	return {
		kind: sent.kind, marker: sent.marker, payloadSha256: sha256Hex(sent.payload.trim()), objective: sent.objective,
		priorGoalIds, sessionId: journal.sessionId, leafId: journal.leafId, cursorBytes, bodyStart, prefixStart,
		prefixSha256: sha256Hex(view.tail.subarray(prefixStart - view.tailStart)), fileIdentity: view.identity,
		priorGoalIdsComplete: view.tailStart <= bodyStart,
	};
}

export interface TernPendingRecord extends TernProofKey {
	seatKey: string;
	sessionSha: string;
	textSha256: string;
	createdAt: string;
}

const TERN_PENDING_STRINGS = ["marker", "payloadSha256", "objective", "sessionId", "leafId", "prefixSha256",
	"seatKey", "sessionSha", "textSha256", "createdAt"];

function readTernPending(path: string): TernPendingRecord | null {
	let rec: Record<string, unknown> | null;
	try {
		rec = recordOf(JSON.parse(readFileSync(path, "utf8") as string));
	} catch {
		return null;
	}
	if (!rec) return null;
	for (const field of TERN_PENDING_STRINGS) if (typeof rec[field] !== "string") return null;
	for (const value of [rec.cursorBytes, rec.bodyStart]) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
	}
	if (rec.kind !== "message" && rec.kind !== "goal-set") return null;
	if (!Array.isArray(rec.priorGoalIds) || !rec.priorGoalIds.every((id) => typeof id === "string")) return null;
	// Records written before bounded reads pinned the whole body and carry no inode.
	const prefixStart = rec.prefixStart === undefined ? rec.bodyStart : rec.prefixStart;
	if (typeof prefixStart !== "number" || !Number.isSafeInteger(prefixStart) || prefixStart < (rec.bodyStart as number)
		|| prefixStart > (rec.cursorBytes as number)) return null;
	const fileIdentity = rec.fileIdentity === undefined ? null : rec.fileIdentity;
	if (fileIdentity !== null && typeof fileIdentity !== "string") return null;
	const priorGoalIdsComplete = rec.priorGoalIdsComplete === undefined ? true : rec.priorGoalIdsComplete;
	if (typeof priorGoalIdsComplete !== "boolean") return null;
	return { ...rec, prefixStart, fileIdentity, priorGoalIdsComplete } as unknown as TernPendingRecord;
}

/** F5: the attempt is durable (file and directory fsynced) before any effect; false means nothing was persisted. */
function persistTernAttempt(path: string, record: TernPendingRecord): boolean {
	let fd: number | null = null;
	try {
		mkdirSync(dirname(path), { recursive: true });
		fd = openSync(path, "wx");
	} catch {
		return false;
	}
	try {
		writeSync(fd, JSON.stringify(record) + "\n");
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		const dirFd = openSync(dirname(path), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
		return true;
	} catch {
		if (fd !== null) try { closeSync(fd); } catch {}
		try { rmSync(path, { force: true }); } catch {}
		return false;
	}
}

/** A later consumption or a gone incarnation changes the ledger only; nothing is ever resent. */
function settleTernPending(pendingDir: string, name: string, rec: TernPendingRecord, status: string, offset: number | null): void {
	try {
		appendFileSync(join(pendingDir, "ledger.jsonl"), JSON.stringify({ at: new Date().toISOString(), status,
			marker: rec.marker, seatKey: rec.seatKey, sessionId: rec.sessionId, offset }) + "\n");
	} catch {}
	try { rmSync(join(pendingDir, name), { force: true }); } catch {}
}

/**
 * Deliver text to a bound Tern seat with session-file proof (2.4 [a]).
 *
 * Flow: GOALSEND form and payload class (an OMP shell escape is refused
 * outright, SENDGATE1) -> gate flags -> exact seat binding -> observe
 * (BUSY waits up to untilDeliveredMs, then NOT_DELIVERED with a drop file;
 * a destructive payload to a pane not proven to run OMP is refused by rule
 * id) -> identify -> observe/identify/configured-pane fence (SENDX1) ->
 * eligibility from the very snapshot observe hashed -> refuse slash
 * controls with no proof contract -> sweep settled pendings (ledger only)
 * -> suppress while an attempt on this incarnation is unproven -> persist
 * the attempt durably -> lock -> re-read (incarnation pre-filter, not
 * atomicity) -> ONE native admission turn -> poll for proof (default 20 s).
 *
 * Statuses: OK (entry proven; offset is its byte offset in sessionFile),
 * PENDING_CONSUME (an effect may have happened and is unproven; pending
 * retained, never auto-resent, drop copy written), NOT_DELIVERED (nothing
 * typed: lock contention or until-delivered exhaustion; drop copy written),
 * REFUSED (zero effects, decided before any actuation).
 *
 * Actuation transport lessons (verified live 2026-10-16 on owned panes):
 * the turn travels as one plain argv string; the payload rides as
 * `string.char(...)` byte codes so no text can disturb parsing; the block
 * is the bare decimal pane id. Tern binary resolves from `TERN_CTL_BIN` or
 * `$HOME/.local/bin/tern`.
 */
export async function deliverToTernSeat(input: {
	seat: TernSeatBinding;
	text: string;
	dropDir: string;
	io: TernObserverIo;
	gate?: TernSendGate;
	env?: NodeJS.ProcessEnv;
	pollMs?: number;
	deadlineMs?: number;
	/** Wall-clock bound in ms for a working seat, including observation time; default 0 refuses immediately. */
	untilDeliveredMs?: number;
	wait?: (ms: number) => Promise<void>;
	/** Monotonic clock seam for deterministic bound tests. */
	now?: () => number;
	/** Overridable for tests; production uses plane-tern's functions. */
	observe?: typeof observeTernSeat;
	identify?: typeof identifyTernSeat;
	/** Composer truth for paste admission (no window key); default reads the seat's kit-composer-state record. */
	composer?: (sessionFile: string) => ComposerVerdict;
}): Promise<TernDeliverResult> {
	const observe = input.observe ?? observeTernSeat;
	const identify = input.identify ?? identifyTernSeat;
	const wait = input.wait ?? (async (ms: number) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
	const now = input.now ?? (() => performance.now());
	const pollMs = input.pollMs ?? TERN_PROOF_POLL_MS;
	const deadlineMs = input.deadlineMs ?? TERN_PROOF_DEADLINE_MS;
	let queued = false;
	const fail = (code: string, detail: string): TernDeliverResult =>
		({ status: "REFUSED", marker: "", sends: 0, sessionFile: null, offset: null, drop_path: null, detail, code,
			...(queued ? { queue_states: ["QUEUED", "REFUSED"] as const } : {}) });
	const provenance = seatProvenance(input.text, input.env ?? process.env);
	if (provenance.refused) return fail("SEND_PROVENANCE_FORGED", provenance.detail);
	const gate = input.gate ?? {};
	// GOALSEND: bare /goal text is refused before any seat observation or
	// send; goal delivery uses `/goal set BODY`.
	if (isBareGoalDirective(input.text)) return fail("GOAL_REQUIRES_SET_FORM", "bare /goal directive refused: goal delivery requires /goal set BODY; zero sends");
	if (!input.text.trim()) return fail("EMPTY_PAYLOAD", "blank text is never sent (an empty submit aborts a streaming turn); zero sends");
	const payloadKind = classifyTernPayload(input.text);
	if (payloadKind.kind === "shell-escape") {
		// SENDGATE1 on the Tern plane: the OMP composer executes `!`/`$` text,
		// so the send would bypass every command gate. Never a message.
		const rule = refuseShellPayload(payloadKind.command);
		return fail(rule ? rule.rule : "OMP_SHELL_ESCAPE", "payload would run as a shell/Python command in the OMP composer; zero sends");
	}

	if (gate.paused === true) return fail("GATE_PAUSED", "seat is paused; zero sends");
	if (gate.custodyDisabled === true) return fail("GATE_CUSTODY_DISABLED", "seat custody disabled; zero sends");
	if (gate.pullEnabled === false) return fail("GATE_PULL_DISABLED", "pullEnabled is false; zero sends");
	if (gate.admitted === false) return fail("GATE_UNADMITTED", "seat is unadmitted; zero sends");
	if (gate.insight === true) return fail("GATE_INSIGHT", "INSIGHT seat; zero sends");
	const paneId = ternPaneId(input.seat.pane);
	if (typeof input.seat.session !== "string" || !input.seat.session.trim()
		|| typeof input.seat.windowKey !== "string" || paneId === null) {
		return fail("PLANE_SEAT_UNBOUND", "seat needs a configured session and exact pane id; zero sends");
	}
	// TERNADDR1: no window key means no ctl endpoint; admit by paste + Enter into the pane's own window.
	const windowKey = input.seat.windowKey.trim();
	const pasteMode = windowKey === "";
	const seatKey = `${input.seat.session}/${input.seat.pane}@${input.seat.windowKey}`.replace(/[^A-Za-z0-9]+/g, "_");
	let observation = await observe(input.seat, input.io);
	const untilDeliveredMs = Math.max(0, input.untilDeliveredMs ?? 0);
	const busyRetries = Math.ceil(untilDeliveredMs / pollMs);
	const untilDeliveredDeadline = now() + untilDeliveredMs;
	let deadlineExpired = false;
	const waitsForTurnBoundary = () => observation.state === "BUSY"
		|| (observation.state === "UNKNOWN" && observation.working === true
			&& (observation.reason === "SESSION_TURN_IN_FLIGHT" || observation.reason === "ACTIVE_BRANCH_UNAVAILABLE"
				|| observation.reason === "SESSION_FILE_UNAVAILABLE"));
	queued = waitsForTurnBoundary() && busyRetries > 0;
	for (let retry = 0; waitsForTurnBoundary() && retry < busyRetries; retry++) {
		const remainingMs = untilDeliveredDeadline - now();
		if (remainingMs <= 0) {
			deadlineExpired = true;
			break;
		}
		await wait(Math.min(pollMs, remainingMs));
		if (now() >= untilDeliveredDeadline) {
			deadlineExpired = true;
			break;
		}
		observation = await observe(input.seat, input.io);
		if (now() >= untilDeliveredDeadline) {
			deadlineExpired = true;
			break;
		}
	}
	const shellRule = observation.fg === null ? refuseShellPayload(input.text) : null;
	if (shellRule) return fail(shellRule.rule, "destructive payload to a pane not proven to run OMP; zero sends");
	if (deadlineExpired || waitsForTurnBoundary()) {
		if (busyRetries === 0)
			return fail(observation.state === "BUSY" ? "SEAT_BUSY" : "OBSERVATION_UNKNOWN",
				`seat is working but not provably idle (${observation.reason ?? "unknown"}); zero sends`);
		const detail = deadlineExpired && observation.state === "IDLE"
			? `seat became idle only after the ${untilDeliveredMs} ms until-delivered bound`
			: `seat remained ${observation.state === "BUSY" ? "BUSY" : `working with unproven session state (${observation.reason ?? "unknown"})`}`
				+ ` through the ${untilDeliveredMs} ms until-delivered bound`;
		return { status: "NOT_DELIVERED", marker: "", sends: 0, sessionFile: observation.sessionFile, offset: null,
			drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, "tern-busy", input.text),
			detail: `${detail}; nothing typed; recovery copy written`,
			code: "UNTIL_DELIVERED_EXHAUSTED", queue_states: ["QUEUED", "EXPIRED"] };
	}
	if (observation.state === "DEAD") return fail("SEAT_DEAD", "seat pane is dead; zero sends");
	if (observation.state !== "IDLE" || observation.runtimeBinding === null) {
		const code = observation.reason === "PLANE_SEAT_UNBOUND" || observation.reason === "TERN_WINDOW_UNBOUND"
			|| observation.reason === "SEAT_REBOUND" || observation.reason === "SEAT_CWD_MISMATCH"
			? observation.reason
			: "OBSERVATION_UNKNOWN";
		return fail(code, `seat not provably idle (${observation.reason ?? "unknown"}); zero sends`);
	}
	const identity = await identify(input.seat, input.io);
	if (identity.status !== "IDENTIFIED" || identity.runtimeBinding === null) {
		const code = identity.status === "REFUSED" ? identity.code : "IDENTITY_UNKNOWN";
		const reason = identity.reason;
		return fail(code, `seat identity not bound (${reason}); zero sends`);
	}
	// ACT58584 + SENDX1: the seat must not move between observe and identify,
	// and both must be the configured pane, so the effect and its proof can
	// only ever address the bound seat and its own session file.
	const ob = observation.runtimeBinding;
	const ib = identity.runtimeBinding;
	if (ob.sessionFile !== ib.sessionFile || ob.sessionUuid !== ib.sessionUuid
		|| ob.paneId !== ib.paneId || ob.sessionId !== ib.sessionId
		|| ob.foregroundPid !== ib.foregroundPid || ob.foregroundStarted !== ib.foregroundStarted) {
		return fail("SEAT_REBOUND", `observe/identify runtime bindings differ; seat moved, zero sends`);
	}
	if (ob.paneId !== paneId || observation.sessionFile !== ob.sessionFile) {
		return fail("SEAT_REBOUND", `observed pane ${ob.paneId} is not configured pane ${paneId}; zero sends`);
	}
	const sessionFile = ob.sessionFile;
	// ompkit-774u.1.3: the same bounded view the observer decided from (whole within the cap, else head plus
	// tail of one inode); its fingerprint covers inode, size and every byte read.
	const journalView = readSessionView(input.io, sessionFile);
	if (journalView === null) return fail("ELIGIBILITY_UNKNOWN", "session file unreadable; zero sends");
	if (journalView.sha256 !== observation.sessionSha) {
		return fail("SEAT_REBOUND", "session file changed since observation; zero sends");
	}
	const journal = parseSessionView(journalView);
	if (journal.status !== "KNOWN" || journal.oracleBusy !== false || !journal.terminalAssistantStop || journal.unresolvedAsyncTool
		|| journal.lastMessageRole !== "assistant") {
		return fail("ELIGIBILITY_UNSETTLED", "turn not settled (parse, stop, pending tools or live user turn); zero sends");
	}
	if (journal.sessionId !== ob.sessionUuid) return fail("SEAT_REBOUND", "journal session differs from the bound runtime; zero sends");
	if (payloadKind.kind === "slash") {
		return fail("SLASH_UNPROVABLE", "slash control has no journal proof contract (only /goal set BODY does); zero sends");
	}
	// Pending records for this seat: a consumed one, or one whose incarnation
	// is gone, is settled in the ledger (never resent); one still unproven on
	// THIS incarnation suppresses every new send. The key is the stable
	// journal session identity, never the mutable content hash, so appends
	// and BUSY/IDLE flaps cannot release suppression (AM58562-4, B5).
	const pendingDir = resolve(join(input.dropDir, "..", "tern-pending"));
	let pendingNames: string[] = [];
	try {
		pendingNames = readdirSync(pendingDir);
	} catch {
		pendingNames = [];
	}
	for (const name of pendingNames) {
		if (!name.startsWith(`${seatKey}.`) || !name.endsWith(".json")) continue;
		const rec = readTernPending(join(pendingDir, name));
		if (rec === null) continue;
		if (rec.sessionId !== journal.sessionId) {
			settleTernPending(pendingDir, name, rec, "INCARNATION_GONE", null);
			continue;
		}
		// A key pinned before this view's tail re-reads with its own range on one snapshot.
		const proofView = rec.prefixStart < journalView.tailStart
			? readSessionView(input.io, sessionFile, { start: rec.prefixStart, cursor: rec.cursorBytes }) : journalView;
		const proof = proofView === null ? null : proveTernEntry(proofView, rec);
		if (proof?.status === "PROVEN") settleTernPending(pendingDir, name, rec, "CONSUMED_LATER", proof.offset);
	}
	const pendingPath = resolve(join(pendingDir, `${seatKey}.${sha256Hex(journal.sessionId).slice(0, 16)}.json`));
	const pending = readTernPending(pendingPath);
	if (pending !== null && pending.sessionId === journal.sessionId) {
		return { status: "PENDING_CONSUME", marker: pending.marker, sends: 0, sessionFile, offset: null, drop_path: null,
			detail: `earlier attempt unproven on this runtime incarnation; new send suppressed`, code: "SUPPRESSED_PENDING",
			...(queued ? { queue_states: ["QUEUED", "PENDING_CONSUME"] as const } : {}) };
	}
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	const payload = payloadKind.kind === "goal-set" ? input.text.trim() : `${provenance.text}\n[${marker}]`;
	const key = buildTernProofKey(journalView, journal, { kind: payloadKind.kind, payload, marker,
		objective: payloadKind.kind === "goal-set" ? payloadKind.objective : "" });
	const attempt: TernPendingRecord = { ...key, seatKey, sessionSha: observation.sessionSha ?? "",
		textSha256: sha256Hex(input.text), createdAt: new Date().toISOString() };
	if (!persistTernAttempt(pendingPath, attempt)) return fail("PENDING_WRITE_FAILED", "attempt record not persisted; zero sends");
	const releaseLock = await acquirePaneLock(paneLockPath(input.dropDir, input.seat.session, input.seat.pane),
		Math.max(1, Math.ceil(deadlineMs / pollMs)), pollMs, wait);
	if (!releaseLock) {
		try { rmSync(pendingPath, { force: true }); } catch {}
		return { status: "NOT_DELIVERED", marker, sends: 0, sessionFile: null, offset: null,
			drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
			detail: `destination locked by another send within the bound; nothing typed`, code: "LOCK_BUSY",
			...(queued ? { queue_states: ["QUEUED", "EXPIRED"] as const } : {}) };
	}
	try {
		// F1: this re-read is a cheap incarnation pre-filter, NOT atomicity;
		// on the ctl path the admission checks live inside the one native turn.
		const fresh = readSessionView(input.io, sessionFile);
		if (fresh === null || fresh.sha256 !== observation.sessionSha) {
			try { rmSync(pendingPath, { force: true }); } catch {}
			return { status: "REFUSED", marker, sends: 0, sessionFile, offset: null, drop_path: null,
				detail: `session moved between observe and effect; zero sends`, code: "SEAT_REBOUND",
				...(queued ? { queue_states: ["QUEUED", "REFUSED"] as const } : {}) };
		}
		// F5: a failed or crashed dispatch does not prove zero native effects;
		// the attempt stays pending and proof is still reconciled below.
		let dispatched = false;
		if (pasteMode) {
			// Paste has no atomic admission, so the seat's own composer record must
			// prove an empty composer first; a running agent is fine (omp queues the
			// submit as a steer). Enter is never pressed after a failed paste: an
			// empty submit aborts a streaming turn.
			const composer = (input.composer ?? readComposerRecord)(sessionFile);
			if (composer.state !== "EMPTY") {
				try { rmSync(pendingPath, { force: true }); } catch {}
				return { status: "REFUSED", marker, sends: 0, sessionFile, offset: null, drop_path: null,
					detail: composer.state === "DRAFT" ? "seat composer holds unsent text; nothing pasted, zero sends"
						: `seat composer state UNKNOWN (${composer.reason}); never paste blind, zero sends`,
					code: composer.state === "DRAFT" ? "TERN_COMPOSER_BUSY" : "TERN_COMPOSER_UNKNOWN",
					...(queued ? { queue_states: ["QUEUED", "REFUSED"] as const } : {}) };
			}
			const socket = resolveDaemonSocket();
			const env = socket === null ? undefined : { TERN_DAEMON_SOCKET: socket };
			try {
				if (input.io.run([ternCtlBin(), "send", String(paneId), "paste", payload], env).code === 0) {
					dispatched = input.io.run([ternCtlBin(), "send", String(paneId), "keys", "Enter"], env).code === 0;
				}
			} catch {
				dispatched = false;
			}
		} else {
			const lua = buildNativeSendTurn(String(paneId), payload);
			if (lua === null) {
				try { rmSync(pendingPath, { force: true }); } catch {}
				return { status: "REFUSED", marker, sends: 0, sessionFile, offset: null, drop_path: null,
					detail: `block not a bare decimal pane id; zero sends`, code: "BLOCK_UNWIREABLE",
					...(queued ? { queue_states: ["QUEUED", "REFUSED"] as const } : {}) };
			}
			try {
				dispatched = input.io.run([ternCtlBin(), "--window", windowKey, "ctl", "carly", "lua", lua]).code === 0;
			} catch {
				dispatched = false;
			}
		}
		const via = pasteMode ? " via paste+Enter" : "";
		let last: TernProof = { status: "ABSENT", reason: "NOT_READ" };
		const polls = Math.max(1, Math.ceil(deadlineMs / pollMs));
		for (let poll = 0; ; poll++) {
			const current = readSessionView(input.io, sessionFile, { start: key.prefixStart, cursor: key.cursorBytes });
			last = current === null ? { status: "UNCERTAIN", reason: "SESSION_FILE_UNREADABLE" } : proveTernEntry(current, key);
			if (last.status === "PROVEN") {
				try { rmSync(pendingPath, { force: true }); } catch {}
				const steered = last.steering ? " as a steering entry (program was busy at handle time)" : "";
				return { status: "OK", marker, sends: 1, sessionFile, offset: last.offset, drop_path: null,
					detail: `${payloadKind.kind === "goal-set" ? "goal adopted" : "USER entry"} proven at offset ${last.offset}${via}${steered}`,
					code: last.steering ? "PROVEN_STEERED" : "PROVEN",
					...(queued ? { queue_states: ["QUEUED", "DELIVERED"] as const } : {}) };
			}
			if (poll + 1 >= polls) break;
			await wait(pollMs);
		}
		let note = "";
		if (payloadKind.kind === "message") {
			const cap = input.io.run([ternCtlBin(), ...(pasteMode ? [] : ["--window", windowKey]), "capture", `${input.seat.session}/${paneId}`, "--surfaces"]);
			note = cap.code !== 0 ? `; capture failed (rc=${cap.code})`
				: cap.out.includes(`[${marker}]`) ? "; composer holds marker" : "; composer shows no marker";
		}
		return { status: "PENDING_CONSUME", marker, sends: 1, sessionFile, offset: null,
			drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
			detail: `${dispatched ? `sent${via}` : "dispatch failed, effect unknown"}; proof ${last.status} (${last.reason})${note}; pending retained, never auto-resent`,
			code: !dispatched ? "SEND_AMBIGUOUS" : payloadKind.kind === "goal-set" ? "GOAL_NOT_ADOPTED" : "PROOF_TIMEOUT",
			...(queued ? { queue_states: ["QUEUED", "PENDING_CONSUME"] as const } : {}) };
	} finally {
		releaseLock();
	}
}

/**
 * submitQueued is DISABLED (2.4 F6): native queue-item/promotion/admission
 * semantics are unqualified, so no M-Up/Enter actuation exists. Every call
 * refuses with zero exec calls; the tests below pin the refusal so removing
 * it fails them. Banner pixels, oracle state and seat posture change nothing.
 */
export function submitQueuedToTernSeat(_seat: TernSeatBinding): TernDeliverResult {
	return { status: "REFUSED", marker: "", sends: 0, sessionFile: null, offset: null, drop_path: null,
		detail: `submitQueued disabled pending native queue admission qualification (F6); zero sends`, code: "SUBMITQUEUED_DISABLED" };
}
