import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveTmuxSocket } from "./tmux-socket.ts";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { paneIsBusy } from "./fleet-watch.ts";

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
 * True when the marker appears in the lower-most composer region: after the
 * latest default `╭──` border or Claude `─` rule immediately above a `❯` prompt.
 */
export function markerInComposer(capture: string, marker: string): boolean {
	const lines = capture.split("\n");
	let composerStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimStart();
		if (line.startsWith("╭──")) composerStart = i + 1;
		if (line.startsWith("─") && lines[i + 1]?.trimStart().startsWith("❯")) composerStart = i + 1;
	}
	return composerStart >= 0 && lines.slice(composerStart).some((line) => line.includes(marker));
}

/** Text after the ❯ prompt in the composer region (prompt chrome excluded). */
export function composerTextAfterPrompt(capture: string): string {
	const lines = capture.split("\n");
	let composerStart = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trimStart();
		if (line.startsWith("╭──")) composerStart = i + 1;
		if (line.startsWith("─") && lines[i + 1]?.trimStart().startsWith("❯")) composerStart = i + 1;
	}
	if (composerStart < 0) return "";
	return lines.slice(composerStart).map((line) => line.replace(/^\s*❯\s?/, "")).join("\n").trim();
}

/** True when the composer holds text beyond the bare prompt (ours or foreign). */
export function composerHasText(capture: string): boolean {
	return composerTextAfterPrompt(capture).length > 0;
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
	const slashBaseline = isSlash ? runTmux(["capture-pane", "-p", "-S", "-200", "-t", input.pane]).out : "";
	const isDispatch = dispatchBeads(input.message).dispatch;
	const paneDir = isDispatch && !input.knownPrefixes && selection.status === "RESOLVED"
		? runTmux(["display-message", "-p", "-t", input.pane, "#{pane_current_path}"]).out.trim()
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
			const got = runTmux(["capture-pane", "-p", "-S", "-200", "-t", input.pane]);
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
					runTmux(["send-keys", "-t", input.pane, "Enter"]);
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
				return completeDeferredSend({ runTmux, wait, pollMs, untilDeliveredMs, session: input.session, pane: input.pane,
					marker, sends, dropPath: busyDropPath, bead_ids, no_bead_reason, tmux_socket });
			}
			return { status: "NOT_DELIVERED", marker, sends, drop_path: busyDropPath, detail: `marker stayed in ${input.pane} composer while the pane was busy; Enter withheld to avoid a double submit; recovery copy written to ${busyDropPath}`, bead_ids, no_bead_reason, tmux_socket };
		}
	}
	const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
	const tailDetail = isSlash ? `no command effect observed in ${input.pane} history; message written to ${dropPath}` : `marker never appeared in ${input.pane} history; message written to ${dropPath}`;
	return { status: "NOT_DELIVERED", marker, sends: SEND_MAX_SENDS, drop_path: dropPath, detail: tailDetail, bead_ids, no_bead_reason, tmux_socket };
}
