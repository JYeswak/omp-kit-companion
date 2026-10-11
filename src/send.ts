import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	status: "OK" | "PENDING_SUBMIT" | "NOT_DELIVERED" | "BEAD_REQUIRED" | "TMUX_AMBIGUOUS" | "ADMISSION_REFUSED";
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
 * message whose first token is `D` (DISPATCH.md pane line `D AM<id> <slug>`)
 * or that has a line starting `queue:`. Slugs are not beads: the D line's
 * slug position and the names after `queue:` do not count as citations.
 */
export function dispatchBeads(message: string, knownPrefixes?: ReadonlySet<string>): { dispatch: boolean; bead_ids: string[] } {
	const lines = message.split("\n");
	const dLine = /^\s*D /.test(message);
	const queue = lines.some((line) => /^\s*queue:/.test(line));
	const bead_ids: string[] = [];
	lines.forEach((line, index) => {
		let tokens = line.trim().split(/\s+/);
		if (index === 0 && dLine) tokens = tokens.slice(3);
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
	const runTmux = (args: string[]) => exec.run(["tmux", ...tmuxArgs, ...args], sendEnv);
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
	const marker = `kit-send-${randomBytes(6).toString("hex")}`;
	const text = `${input.message}\n[${marker}]`;
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
			if (got.code === 0 && got.out.includes(marker)) {
				markerSeen = true;
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
				} else if (!entered) {
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
			return { status: "NOT_DELIVERED", marker, sends, drop_path: busyDropPath, detail: `marker stayed in ${input.pane} composer while the pane was busy; Enter withheld to avoid a double submit; recovery copy written to ${busyDropPath}`, bead_ids, no_bead_reason, tmux_socket };
		}
	}
	const dropPath = dropMessage(input.dropDir, input.session, input.pane, marker, input.message);
	return { status: "NOT_DELIVERED", marker, sends: SEND_MAX_SENDS, drop_path: dropPath, detail: `marker never appeared in ${input.pane} history; message written to ${dropPath}`, bead_ids, no_bead_reason, tmux_socket };
}
