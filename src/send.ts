import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveTmuxSocket } from "./tmux-socket.ts";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { paneRunsShell, refuseShellPayload } from "./send-payload-guard.ts";
import { paneIsBusy } from "./fleet-watch.ts";
import { identifyTernSeat, observeTernSeat, parseSessionJournal } from "./plane-tern.ts";
import type { TernObserverIo, TernSeatBinding } from "./plane-tern.ts";

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
	const isDispatch = dispatchBeads(input.message).dispatch;
	const paneDir = isDispatch && !input.knownPrefixes && selection.status === "RESOLVED"
		? runTmux(["display-message", "-p", "-t", paneTarget, "#{pane_current_path}"]).out.trim()
		: "";
	const knownPrefixes = !isDispatch ? new Set<string>()
		: input.knownPrefixes ?? fleetBeadPrefixes(env, [process.cwd(), paneDir].filter(dir => dir.startsWith("/")));
	const { dispatch, bead_ids } = dispatchBeads(input.message, knownPrefixes);
	const no_bead_reason = dispatch && bead_ids.length === 0 ? input.noBeadReason?.trim() || null : null;
	const tmux_socket = selection.status === "RESOLVED" ? selection.socket : null;
	if (dispatch && bead_ids.length === 0 && !no_bead_reason) {
		return { status: "BEAD_REQUIRED", marker: "", sends: 0, drop_path: null, bead_ids, no_bead_reason, tmux_socket,
			detail: `work dispatch cites no bead id${knownPrefixes.size ? ` (tracker prefixes: ${[...knownPrefixes].sort().join(", ")})` : ""}; nothing was sent` };
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
	const text = isSlash ? input.message : `${input.message}\n[${marker}]`;
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

/**
 * Tern verified delivery (ompkit-kdbz.2.4 TERNSEND). Observation and identity
 * come from Silver's plane-tern.ts (observeTernSeat/identifyTernSeat, owned
 * on 2.3 — imported, never reimplemented); this file owns only the send
 * envelope: gating, paste/Enter actuation via the `tern` CLI, session-file
 * marker proof, pending persistence and drop files. tmux/herdr paths above
 * are untouched.
 *
 * Proof model (no screen parsing, no API receipt — `tern pane.write` is
 * fire-and-forget): the exact marker must appear as a USER-role journal line
 * at a byte offset strictly past the pre-send cursor, in the same session
 * file. Stale (offset<=cursor), assistant-echo (role!=user) and wrong-session
 * markers never prove. See F4.
 */
import { createHash as ternCreateHash } from "node:crypto";
import { identifyTernSeat, observeTernSeat, parseSessionJournal } from "./plane-tern.ts";
import type { TernObserverIo, TernSeatBinding } from "./plane-tern.ts";

export const TERN_PROOF_POLL_MS = 1000;
export const TERN_PROOF_DEADLINE_MS = 20_000;
/** `tern send` keys vocabulary is unverified live; T3 scratch proof must confirm. */
export const TERN_ENTER_KEYS = ["Enter"];

export type TernDeliverStatus = "OK" | "PENDING_CONSUME" | "NOT_DELIVERED" | "REFUSED";
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
}
export interface TernPendingRecord {
	marker: string;
	textSha256: string;
	seatKey: string;
	sessionSha: string;
	leafId: string;
	cursorBytes: number;
	createdAt: string;
}

function readTernPending(path: string): TernPendingRecord | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8") as string) as unknown;
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const rec = raw as { [key: string]: unknown };
	const marker = typeof rec.marker === "string" ? rec.marker : null;
	const textSha256 = typeof rec.textSha256 === "string" ? rec.textSha256 : null;
	const seatKey = typeof rec.seatKey === "string" ? rec.seatKey : null;
	const sessionSha = typeof rec.sessionSha === "string" ? rec.sessionSha : null;
	const leafId = typeof rec.leafId === "string" ? rec.leafId : null;
	const createdAt = typeof rec.createdAt === "string" ? rec.createdAt : null;
	const cursorBytes = typeof rec.cursorBytes === "number" && Number.isInteger(rec.cursorBytes) && rec.cursorBytes >= 0
		? rec.cursorBytes
		: null;
	if (marker === null || textSha256 === null || seatKey === null || sessionSha === null
		|| leafId === null || createdAt === null || cursorBytes === null) return null;
	return { marker, textSha256, seatKey, sessionSha, leafId, cursorBytes, createdAt };
}
/** Scan raw session text for the marker on a USER-role line past a cursor offset. */
export function findTernUserMarker(text: string, marker: string, afterOffset: number): number | null {
	let offset = 0;
	for (const line of text.split("\n")) {
		const start = offset;
		offset += Buffer.byteLength(line, "utf8") + 1;
		if (start < afterOffset || !line.includes(marker)) continue;
		try {
			const decoded: unknown = JSON.parse(line);
			if (typeof decoded !== "object" || decoded === null) continue;
			if ("role" in decoded && decoded.role === "user") return start;
			if ("message" in decoded) {
				const inner = decoded.message;
				if (typeof inner === "object" && inner !== null && "role" in inner && inner.role === "user") return start;
			}
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Deliver text to a bound Tern seat with session-file proof (2.4 [a]).
 *
 * Flow: gate flags -> validate seat -> observe (must be IDLE) -> identify
 * (must be IDENTIFIED) -> journal eligibility (settled turn) -> clear any
 * already-consumed pending marker (log status only, never resend) ->
 * suppress-while-pending check -> persist attempt record -> lock ->
 * re-read session file (incarnation unchanged) -> paste -> Enter once ->
 * poll for the USER marker past the pre-send cursor (default 20 s).
 *
 * Statuses: OK (USER marker proven), PENDING_CONSUME (sent but consumption
 * written, pending retained, never auto-resent), NOT_DELIVERED (send
 * commands failed; recovery copy written), REFUSED (zero sends: gates,
 * observation, identity, eligibility or incarnation).
 *
 * Actuation note: `tern send BLOCK keys Enter` is accepted with rc 0 on an
 * owned sandbox pane (2026-10-16); evsend has no CLI/Lua emit surface found.
 */
export async function deliverToTernSeat(input: {
	seat: TernSeatBinding;
	text: string;
	dropDir: string;
	io: TernObserverIo;
	gate?: TernSendGate;
	pollMs?: number;
	deadlineMs?: number;
	wait?: (ms: number) => Promise<void>;
	/** Overridable for tests; production passes Silver's plane-tern functions. */
	observe?: typeof observeTernSeat;
	identify?: typeof identifyTernSeat;
}): Promise<TernDeliverResult> {
	const observe = input.observe ?? observeTernSeat;
	const identify = input.identify ?? identifyTernSeat;
	const wait = input.wait ?? (async (ms: number) => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
	const pollMs = input.pollMs ?? TERN_PROOF_POLL_MS;
	const deadlineMs = input.deadlineMs ?? TERN_PROOF_DEADLINE_MS;
	const fail = (code: string, detail: string): TernDeliverResult =>
		({ status: "REFUSED", marker: "", sends: 0, sessionFile: null, offset: null, drop_path: null, detail, code });
	const gate = input.gate ?? {};
	// ompkit-kdbz.2.4 GOALSEND: bare /goal text is refused before any seat
	// observation or send; goal delivery uses `/goal set BODY`.
	if (isBareGoalDirective(input.text)) return fail("GOAL_REQUIRES_SET_FORM", "bare /goal directive refused: goal delivery requires /goal set BODY; zero sends");

	if (gate.paused === true) return fail("GATE_PAUSED", "seat is paused; zero sends");
	if (gate.custodyDisabled === true) return fail("GATE_CUSTODY_DISABLED", "seat custody disabled; zero sends");
	if (gate.pullEnabled === false) return fail("GATE_PULL_DISABLED", "pullEnabled is false; zero sends");
	if (gate.admitted === false) return fail("GATE_UNADMITTED", "seat is unadmitted; zero sends");
	if (gate.insight === true) return fail("GATE_INSIGHT", "INSIGHT seat; zero sends");
	if (typeof input.seat.session !== "string" || !input.seat.session.trim()
		|| typeof input.seat.windowKey !== "string" || !input.seat.windowKey.trim()) {
		return fail("PLANE_SEAT_UNBOUND", "seat needs a configured session and explicit window key; zero sends");
	}
	const seatKey = `${input.seat.session}/${input.seat.pane}@${input.seat.windowKey}`.replace(/[^A-Za-z0-9]+/g, "_");
	const observation = await observe(input.seat, input.io);
	if (observation.state === "BUSY") return fail("SEAT_BUSY", `seat is BUSY (${observation.reason ?? "working"}); zero sends`);
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
		return fail(code, `seat identity not bound (${identity.reason}); zero sends`);
	}
	if (observation.sessionFile === null) return fail("ELIGIBILITY_UNKNOWN", "no session file to prove against; zero sends");
	const journalText = input.io.readSessionFile(observation.sessionFile);
	if (journalText === null) return fail("ELIGIBILITY_UNKNOWN", "session file unreadable; zero sends");
	const journal = parseSessionJournal(journalText);
	if (journal.status !== "KNOWN" || !journal.terminalAssistantStop || journal.unresolvedAsyncTool
		|| journal.lastMessageRole !== "assistant") {
		return fail("ELIGIBILITY_UNSETTLED", "turn not settled (parse, stop, pending tools or live user turn); zero sends");
	}
	const preCursor = Buffer.byteLength(journalText, "utf8");
	const preSha = observation.sessionSha;
	// A pending marker already consumed upgrades log status only: sweep every
	// pending record for this seat (any incarnation) against the eligibility
	// snapshot and clear consumed ones. Never resend old text. A remaining
	// pending on THIS incarnation suppresses the new send.
	const pendingDir = resolve(join(input.dropDir, "..", "tern-pending"));
	let pendingDirNames: string[] = [];
	try {
		pendingDirNames = readdirSync(pendingDir);
	} catch {
		pendingDirNames = [];
	}
	for (const name of pendingDirNames) {
		if (!name.startsWith(`${seatKey}.`) || !name.endsWith(".json")) continue;
		const rec = readTernPending(join(pendingDir, name));
		if (rec !== null && findTernUserMarker(journalText, rec.marker, rec.cursorBytes) !== null) {
			try { rmSync(join(pendingDir, name), { force: true }); } catch {}
		}
	}
	const pendingPath = resolve(join(pendingDir, `${seatKey}.${(preSha ?? "").slice(0, 16)}.json`));
	const pending = readTernPending(pendingPath);
	if (pending !== null) {
		return { status: "PENDING_CONSUME", marker: pending.marker, sends: 0, sessionFile: observation.sessionFile,
			offset: null, drop_path: null, detail: `earlier marker unconsumed on this incarnation; new send suppressed`, code: "SUPPRESSED_PENDING" };
	}
	// F5: persist the attempt BEFORE any irreversible effect; one lock per
	// destination serializes concurrent senders.
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	const textSha256 = createHash("sha256").update(input.text, "utf8").digest("hex");
	const attempt: TernPendingRecord = { marker, textSha256, seatKey, sessionSha: preSha ?? "",
		leafId: journal.leafId, cursorBytes: preCursor, createdAt: new Date().toISOString() };
	try {
		mkdirSync(dirname(pendingPath), { recursive: true });
		writeFileSync(pendingPath, JSON.stringify(attempt) + "\n", { flag: "wx" });
	} catch {
		return fail("PENDING_WRITE_FAILED", "attempt record not persisted; zero sends");
	}
	const releaseLock = await acquirePaneLock(paneLockPath(input.dropDir, input.seat.session, input.seat.pane),
		Math.max(1, Math.ceil(deadlineMs / pollMs)), pollMs, wait);
	if (!releaseLock) {
		try { rmSync(pendingPath, { force: true }); } catch {}
		return { status: "UNDELIVERED", marker, sends: 0, sessionFile: null, offset: null,
			drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
			detail: `destination locked by another send within the bound; nothing typed`, code: "LOCK_BUSY" };
	}
	try {
		// F1 atomic admission: the session file must be unchanged since the
		// eligibility read; any incarnation move refuses before effect.
		const fresh = input.io.readSessionFile(observation.sessionFile);
		const freshSha = fresh === null ? null : createHash("sha256").update(fresh, "utf8").digest("hex");
		if (fresh === null || freshSha !== preSha) {
			try { rmSync(pendingPath, { force: true }); } catch {}
			return { status: "REFUSED", marker, sends: 0, sessionFile: observation.sessionFile, offset: null, drop_path: null,
				detail: `session moved between observe and effect; zero sends`, code: "SEAT_REBOUND" };
		}
		const block = `${input.seat.session}/${observation.runtimeBinding.paneId}`;
		const base = ["tern", "--window", input.seat.windowKey, "send", block];
		if (input.io.run([...base, "paste", `${input.text}\n[${marker}]`]).code !== 0) {
			try { rmSync(pendingPath, { force: true }); } catch {}
			return { status: "NOT_DELIVERED", marker, sends: 0, sessionFile: observation.sessionFile, offset: null,
				drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
				detail: `paste command failed; recovery copy written`, code: "SEND_FAILED" };
		}
		if (input.io.run([...base, "keys", ...TERN_ENTER_KEYS]).code !== 0) {
			return { status: "PENDING_CONSUME", marker, sends: 1, sessionFile: observation.sessionFile, offset: null,
				drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
				detail: `pasted but Enter unproven; consumption unknown, pending retained`, code: "ENTER_FAILED" };
		}
		const started = Date.now();
		for (;;) {
			const current = input.io.readSessionFile(observation.sessionFile);
			if (current !== null) {
				const at = findTernUserMarker(current, marker, preCursor);
				if (at !== null) {
					try { rmSync(pendingPath, { force: true }); } catch {}
					return { status: "OK", marker, sends: 1, sessionFile: observation.sessionFile, offset: at,
						drop_path: null, detail: `marker proven as USER entry at offset ${at}`, code: "PROVEN" };
				}
			}
			if (Date.now() - started >= deadlineMs) break;
			await wait(pollMs);
		}
		return { status: "PENDING_CONSUME", marker, sends: 1, sessionFile: observation.sessionFile, offset: null,
			drop_path: dropMessage(input.dropDir, input.seat.session, input.seat.pane, marker, input.text),
			detail: `sent but USER marker unproven within the bound; pending retained, never auto-resent`, code: "PROOF_TIMEOUT" };
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
