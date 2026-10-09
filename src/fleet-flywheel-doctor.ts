// doctor --scope fleet: Agent Flywheel Kernel invariant 6 (no ringleader), the
// "Communication purgatory" anti-pattern and stuck pending input, measured from
// the live fleet. Read-only except flushPending with apply, which sends keys.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { paneIsBusy } from "./fleet-watch.ts";

export const DIRECTOR_IDLE_LIMIT_MS = 20 * 60_000;
export const PURGATORY_WINDOW_MS = 2 * 60 * 60_000;
export const PURGATORY_MIN_SENDS = 6;
export const PURGATORY_RATIO = 3;
const ATTRIBUTION_DEPTH = 500;

export type FleetProcess = { pid: number; ppid: number; args: string };
export type MailSends = { repo: string; seat: string; count: number };
export interface FleetIo {
	nowMs(): number;
	/** Runs tmux against the resolved fleet socket; null when tmux fails. */
	tmux(args: readonly string[]): string | null;
	processes(): FleetProcess[];
	/** Open omp session transcript paths per pid (lsof). */
	openSessionFiles(pids: readonly number[]): Map<number, string[]>;
	mtimeMs(path: string): number | null;
	sleep(ms: number): void;
	/** Agent Mail messages sent at or after sinceUs, grouped by project and sender; a string is the unavailability reason. */
	mailSends(sinceUs: number): MailSends[] | string;
	readFile(path: string): string | null;
	git(repo: string, args: readonly string[]): string | null;
}

/** Session transcripts live under ~/.omp/agent/sessions or ~/.omp/profiles/<name>/agent/sessions. */
const SESSION_FILE = /\/\.omp\/(?:profiles\/[^/]+\/)?agent\/sessions\/.+\.jsonl$/;
const OMP_ARGV = /(?:^|[\s/])omp(?:\s|$)/;

type Pane = { session: string; window: number; pane: number; pid: number; id: string };
const PANE_FORMAT = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_id}";

function parsePanes(text: string): Pane[] {
	const panes: Pane[] = [];
	for (const line of text.split("\n")) {
		const [session, window, pane, pid, id] = line.split("\t");
		if (!session || window === undefined || pane === undefined || pid === undefined || !id) continue;
		const parsed = { session, window: Number(window), pane: Number(pane), pid: Number(pid), id };
		if ([parsed.window, parsed.pane, parsed.pid].every(Number.isSafeInteger)) panes.push(parsed);
	}
	return panes;
}

function ompDescendants(root: number, children: Map<number, FleetProcess[]>): number[] {
	const found: number[] = [];
	const queue = [root];
	for (let index = 0; index < queue.length; index++) {
		for (const child of children.get(queue[index]!) ?? []) {
			if (OMP_ARGV.test(child.args)) found.push(child.pid);
			queue.push(child.pid);
		}
	}
	return found;
}

type FleetPane = Pane & { target: string; omp: boolean; idle_ms: number | null; session_files: number };
const NO_TMUX = "No live tmux server answered list-panes; fleet panes were not inspected";
const NO_TMUX_ACTION = "Run on the fleet host; set TMUX_TMPDIR when the fleet uses a private socket directory.";

/**
 * Every tmux pane with whether an omp process runs under it and how long that
 * process has been idle: now minus the newest mtime of the omp session
 * transcripts it holds open (lsof). Null idle means no transcript was found.
 */
function observeFleet(io: FleetIo): FleetPane[] | null {
	const listed = io.tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
	if (listed === null) return null;
	const now = io.nowMs();
	const children = new Map<number, FleetProcess[]>();
	for (const proc of io.processes()) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
	const panes = parsePanes(listed).map((pane) => ({ pane, omp: ompDescendants(pane.pid, children) }));
	const files = io.openSessionFiles(panes.flatMap((entry) => entry.omp));
	return panes.map(({ pane, omp }) => {
		const paths = omp.flatMap((pid) => files.get(pid) ?? []);
		const mtimes = paths.map((path) => io.mtimeMs(path)).filter((value): value is number => value !== null);
		return { ...pane, target: `${pane.session}:${pane.window}.${pane.pane}`, omp: omp.length > 0,
			idle_ms: mtimes.length ? Math.max(0, now - Math.max(...mtimes)) : null, session_files: paths.length };
	});
}

/** Kernel invariant 6: the director (pane x.1 of the first window) is busy while every worker has been idle >= 20 min. */
export function inspectDirectorDoingWork(io: FleetIo): Finding[] {
	const panes = observeFleet(io);
	if (panes === null) return [{ component: "DIRECTOR_DOING_WORK", status: "UNVERIFIED", reason: NO_TMUX, recommended_action: NO_TMUX_ACTION }];
	const sessions = new Map<string, FleetPane[]>();
	for (const pane of panes) sessions.set(pane.session, [...(sessions.get(pane.session) ?? []), pane]);
	const rows: Finding[] = [];
	const checked: string[] = [];
	for (const [session, members] of sessions) {
		const firstWindow = Math.min(...members.map((pane) => pane.window));
		const director = members.find((pane) => pane.window === firstWindow && pane.pane === 1);
		if (!director?.omp) continue;
		const workers = members.filter((pane) => pane !== director && pane.omp);
		if (!workers.length) continue;
		checked.push(session);
		const state = (pane: FleetPane) => ({ target: pane.target, omp: true, busy: paneIsBusy(io.tmux(["capture-pane", "-p", "-t", pane.target]) ?? ""),
			idle_ms: pane.idle_ms, session_files: pane.session_files });
		const directorState = state(director);
		if (!directorState.busy) continue;
		const workerStates = workers.map(state);
		if (!workerStates.every((worker) => !worker.busy && worker.idle_ms !== null && worker.idle_ms >= DIRECTOR_IDLE_LIMIT_MS)) continue;
		const minIdle = Math.min(...workerStates.map((worker) => worker.idle_ms!));
		rows.push({ component: "DIRECTOR_DOING_WORK", status: "DEGRADED",
			reason: `WARN ${session}: director ${directorState.target} is busy while all ${workerStates.length} worker pane(s) have been idle >= ${Math.floor(minIdle / 60_000)} min`,
			recommended_action: "Kernel invariant 6: the director coordinates through artifacts; dispatch the work to an idle worker instead of doing it in the director pane.",
			evidence: { level: "WARN", session, director: directorState, workers: workerStates, idle_limit_ms: DIRECTOR_IDLE_LIMIT_MS, idle_source: "max mtime of omp session transcripts held open (lsof) by the pane's omp process" } });
	}
	if (!rows.length) rows.push({ component: "DIRECTOR_DOING_WORK", status: "OK",
		reason: `No session has a busy director with every worker idle >= ${DIRECTOR_IDLE_LIMIT_MS / 60_000} min (${checked.length} session(s) with a director and workers checked)`,
		recommended_action: "No action required.", evidence: { sessions_checked: checked } });
	return rows;
}

export const PENDING_IDLE_MS = 60_000;
export const STALE_STEER_MS = 5 * 60_000;
export const FLUSH_VERIFY_MS = 15_000;
/** A spinner glyph is not proof of work: a turn whose transcript is this stale is rechecked for a changing screen. */
export const FROZEN_TURN_IDLE_MS = 10 * 60_000;
export const FROZEN_RECHECK_MS = 60_000;
/** omp-kit send appends this marker (src/send.ts) to prove delivery. */
const KIT_SEND_MARKER = /\[kit-send-[0-9a-f]{12}\]/g;
/** QueuedMessagesBand (pi-tui prompt/queued-messages.ts): heading `Label · N` (ASCII theme `Label - N`), rows `N. text`, hint `└ ⌥↑ to edit`. */
const BAND_HEADING = /^\s*(Steering|After yield)(?: · | - )(\d+)$/;
const BAND_ROW = /^\s+\d+\. (.*)$/;
const BAND_HINT = /^\s*(?:└|`-) \S+ to edit$/;
/** Composer gutters: `❯ text` (borderless, rule, claude) or a box whose last row is merged into `╰─ text ─╯`. */
const PROMPT_LINE = /^❯(?: (.*))?$/;
const PROMPT_CONTINUATION = /^ {2}(\S.*)$/;
const BOX_BOTTOM = /^╰─(.*)─╯$/;
const BOX_ROW = /^│(.*)│$/;
/** Status-line spinner followed by the turn's elapsed time, e.g. `⠼ 15s`, `⠏ 23m`, `⠋ 1h5m`. */
const SPINNER_ELAPSED = /[\u2800-\u28ff] (?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?=[\s·>]|$)/;
const BOTTOM_WINDOW = 15;

export type QueuedBand = { start: number; groups: { label: string; count: number }[]; messages: string[] };

/** The queued-messages band in the bottom rows of a pane capture, or null. */
export function parseQueuedBand(lines: readonly string[]): QueuedBand | null {
	for (let hint = lines.length - 1; hint >= Math.max(0, lines.length - BOTTOM_WINDOW); hint--) {
		if (!BAND_HINT.test(lines[hint]!)) continue;
		const groups: QueuedBand["groups"] = [];
		const messages: string[] = [];
		let start = hint;
		for (let index = hint - 1; index >= 0; index--) {
			const heading = BAND_HEADING.exec(lines[index]!);
			const row = heading ? null : BAND_ROW.exec(lines[index]!);
			if (!heading && !row) break;
			if (heading) groups.unshift({ label: heading[1]!, count: Number(heading[2]) });
			else messages.unshift(row![1]!);
			start = index;
		}
		return groups.length ? { start, groups, messages } : null;
	}
	return null;
}

/** Composer text ("" when empty) for the `❯` and box composers; null when no composer is recognized. */
export function parseComposer(lines: readonly string[]): string | null {
	for (let index = lines.length - 1; index >= Math.max(0, lines.length - BOTTOM_WINDOW); index--) {
		const prompt = PROMPT_LINE.exec(lines[index]!);
		if (!prompt) continue;
		const text = [prompt[1] ?? ""];
		for (let next = index + 1; next < lines.length; next++) {
			const continuation = PROMPT_CONTINUATION.exec(lines[next]!);
			if (!continuation) break;
			text.push(continuation[1]!);
		}
		return text.join("\n").trim();
	}
	const filled = lines.filter((line) => line.trim() !== "");
	const bottom = BOX_BOTTOM.exec(filled.at(-1) ?? "");
	if (!bottom || /^─*$/.test(bottom[1]!)) return null;
	const rows = [bottom[1]!];
	for (let index = filled.length - 2; index >= 0; index--) {
		const row = BOX_ROW.exec(filled[index]!);
		if (row) { rows.unshift(row[1]!); continue; }
		if (!filled[index]!.startsWith("╭")) return null;
		return rows.map((row) => row.trim()).filter(Boolean).join("\n");
	}
	return null;
}

/** Turn elapsed time from the status-line spinner in the bottom rows; null when no spinner is shown (idle). */
export function busyElapsedMs(lines: readonly string[], from = lines.length - 6): number | null {
	for (const line of lines.slice(Math.max(0, Math.min(from, lines.length - 6)))) {
		if (!paneIsBusy(line)) continue;
		const match = SPINNER_ELAPSED.exec(line);
		if (!match) return 0;
		const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
		return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 + Number(seconds) * 1000;
	}
	return null;
}

/** Only FLUSH is ever sent; SUBMIT and CLEAR name the remedy for a kit-send composer but stay report-only. */
export type PendingAction = "FLUSH" | "SUBMIT" | "CLEAR" | "ALERT";
export type PendingPane = {
	target: string; pane_id: string; shape: "QUEUED_BAND" | "COMPOSER_TEXT"; action: PendingAction;
	idle_ms: number; preview: string; band: QueuedBand["groups"] | null; composer: string | null;
};
export type StaleSteer = { target: string; pane_id: string; busy_ms: number; band: QueuedBand["groups"]; preview: string };
export type FrozenTurn = { target: string; pane_id: string; shown_ms: number; idle_ms: number; band: QueuedBand["groups"] | null; preview: string };
type PaneView = { lines: string[]; band: QueuedBand | null; composer: string | null; busyMs: number | null };

function viewPane(io: FleetIo, paneId: string): PaneView | null {
	const text = io.tmux(["capture-pane", "-p", "-t", paneId]);
	if (text === null) return null;
	const lines = text.split("\n").map((line) => line.trimEnd());
	while (lines.length && lines.at(-1) === "") lines.pop();
	const band = parseQueuedBand(lines);
	return { lines, band, composer: parseComposer(lines), busyMs: busyElapsedMs(lines, band?.start) };
}

/** What a stuck pane should get: Josh's remedy (dequeue + Enter) only for a band over an empty composer. */
function pendingAction(view: PaneView): PendingAction | null {
	if (view.band) return view.composer === "" ? "FLUSH" : "ALERT";
	if (!view.composer) return null;
	if (!view.composer.match(KIT_SEND_MARKER)) return "ALERT";
	return view.composer.replace(KIT_SEND_MARKER, "").trim() ? "SUBMIT" : "CLEAR";
}

export type PendingScan = { pending: PendingPane[]; stale: StaleSteer[]; frozen: FrozenTurn[]; checked: number; unmeasured: string[] };

/**
 * STUCK_PENDING: an omp pane with no spinner, idle >= 60 s by its session
 * transcript, showing a queued band or composer text. STALE_STEER: a band
 * shown while a live turn has been running >= 5 min. FROZEN_TURN: a spinner
 * glyph over a transcript untouched for 10 min and a screen identical across
 * two captures 60 s apart (the spinner and timer stopped drawing).
 */
export function scanPending(io: FleetIo): PendingScan | null {
	const panes = observeFleet(io);
	if (panes === null) return null;
	const scan: PendingScan = { pending: [], stale: [], frozen: [], checked: 0, unmeasured: [] };
	const suspects: { pane: FleetPane; view: PaneView; preview: string }[] = [];
	const staleCheck = (pane: FleetPane, view: PaneView, preview: string) => {
		if (view.band && view.busyMs !== null && view.busyMs >= STALE_STEER_MS) scan.stale.push({ target: pane.target, pane_id: pane.id, busy_ms: view.busyMs, band: view.band.groups, preview });
	};
	for (const pane of panes) {
		if (!pane.omp) continue;
		const view = viewPane(io, pane.id);
		if (!view) continue;
		scan.checked++;
		const preview = (view.band?.messages[0] ?? view.composer ?? "").slice(0, 80);
		if (view.busyMs !== null) {
			if (pane.idle_ms !== null && pane.idle_ms >= FROZEN_TURN_IDLE_MS) suspects.push({ pane, view, preview });
			else staleCheck(pane, view, preview);
			continue;
		}
		const action = pendingAction(view);
		if (!action) continue;
		if (pane.idle_ms === null) { scan.unmeasured.push(pane.target); continue; }
		if (pane.idle_ms < PENDING_IDLE_MS) continue;
		scan.pending.push({ target: pane.target, pane_id: pane.id, shape: view.band ? "QUEUED_BAND" : "COMPOSER_TEXT", action,
			idle_ms: pane.idle_ms, preview, band: view.band?.groups ?? null, composer: view.composer });
	}
	if (suspects.length) io.sleep(FROZEN_RECHECK_MS);
	for (const { pane, view, preview } of suspects) {
		const again = viewPane(io, pane.id);
		if (again && again.lines.join("\n") === view.lines.join("\n")) scan.frozen.push({ target: pane.target, pane_id: pane.id, shown_ms: view.busyMs!, idle_ms: pane.idle_ms!, band: view.band?.groups ?? null, preview });
		else if (again) staleCheck(pane, again, preview);
	}
	return scan;
}

export function inspectStuckPending(io: FleetIo): Finding[] {
	const scan = scanPending(io);
	if (scan === null) return [{ component: "STUCK_PENDING", status: "UNVERIFIED", reason: NO_TMUX, recommended_action: NO_TMUX_ACTION }];
	const rows: Finding[] = scan.pending.map((pane) => ({ component: "STUCK_PENDING", status: "DEGRADED",
		reason: `WARN ${pane.target} (${pane.pane_id}): ${pane.shape === "QUEUED_BAND" ? `queued ${pane.band!.map((group) => `${group.label} · ${group.count}`).join(", ")}` : "composer text"} idle ${Math.floor(pane.idle_ms / 1000)} s: "${pane.preview}"`,
		recommended_action: pane.action === "FLUSH" ? "omp-kit fleet flush-pending --apply --yes sends Alt+Up then Enter." : pane.action === "ALERT" ? "A human or unknown draft is in the way; inspect the pane, nothing will be sent." : `Report only: the composer holds a kit-send marker; ${pane.action === "SUBMIT" ? "submit" : "clear"} it by hand.`,
		evidence: { level: "WARN", target: pane.target, pane_id: pane.pane_id, shape: pane.shape, action: pane.action, idle_ms: pane.idle_ms, preview: pane.preview } }));
	rows.push(...scan.stale.map((pane): Finding => ({ component: "STALE_STEER", status: "DEGRADED",
		reason: `WARN ${pane.target} (${pane.pane_id}): queued ${pane.band.map((group) => `${group.label} · ${group.count}`).join(", ")} while the turn has run ${Math.floor(pane.busy_ms / 60_000)} min: "${pane.preview}"`,
		recommended_action: "Steering is not reaching the running turn; report only, no keys are sent into a running turn.",
		evidence: { level: "WARN", target: pane.target, pane_id: pane.pane_id, busy_ms: pane.busy_ms, preview: pane.preview } })));
	rows.push(...scan.frozen.map((pane): Finding => ({ component: "FROZEN_TURN", status: "DEGRADED",
		reason: `WARN ${pane.target} (${pane.pane_id}): spinner shows ${Math.floor(pane.shown_ms / 60_000)} min but the screen did not change in ${FROZEN_RECHECK_MS / 1000} s and the session transcript is ${Math.floor(pane.idle_ms / 60_000)} min old${pane.band ? `; queued ${pane.band.map((group) => `${group.label} · ${group.count}`).join(", ")}: "${pane.preview}"` : ""}`,
		recommended_action: "The turn is frozen, not working; report only, no keys are sent to a busy or frozen pane. Inspect the omp process.",
		evidence: { level: "WARN", target: pane.target, pane_id: pane.pane_id, shown_ms: pane.shown_ms, idle_ms: pane.idle_ms, recheck_ms: FROZEN_RECHECK_MS, preview: pane.preview } })));
	if (!scan.pending.length) rows.push({ component: "STUCK_PENDING", status: "OK",
		reason: `No idle omp pane holds a queued band or composer text (${scan.checked} omp pane(s) checked)`,
		recommended_action: "No action required.", evidence: { panes_checked: scan.checked, idle_unmeasured: scan.unmeasured } });
	if (!scan.stale.length) rows.push({ component: "STALE_STEER", status: "OK",
		reason: `No running turn has shown a queued band for >= ${STALE_STEER_MS / 60_000} min (${scan.checked} omp pane(s) checked)`,
		recommended_action: "No action required." });
	if (!scan.frozen.length) rows.push({ component: "FROZEN_TURN", status: "OK",
		reason: `No spinner sat on an unchanged screen over a transcript idle >= ${FROZEN_TURN_IDLE_MS / 60_000} min (${scan.checked} omp pane(s) checked)`,
		recommended_action: "No action required." });
	return rows;
}

export type FlushResult = PendingPane & { result: "PLANNED" | "STARTED" | "STILL_STUCK" | "ALERTED" | "REPORTED" | "SKIPPED_CHANGED"; keys_sent: string[] };
export type FlushReport = { overall: "OK" | "CHANGED" | "FINDINGS" | "UNAVAILABLE"; applied: boolean; panes: FlushResult[]; stale_steer: StaleSteer[]; frozen_turn: FrozenTurn[] };

/**
 * Plan (default) or apply. The only keys ever sent are Alt+Up then Enter, to an
 * idle pane whose queued band sits over an empty composer, re-read just before
 * sending. Busy, frozen and composer-text panes are reported, never touched.
 */
export function flushPending(io: FleetIo, apply: boolean): FlushReport {
	const scan = scanPending(io);
	if (scan === null) return { overall: "UNAVAILABLE", applied: apply, panes: [], stale_steer: [], frozen_turn: [] };
	const panes: FlushResult[] = scan.pending.map((pane) => {
		if (!apply) return { ...pane, result: "PLANNED", keys_sent: [] };
		if (pane.action !== "FLUSH") return { ...pane, result: pane.action === "ALERT" ? "ALERTED" : "REPORTED", keys_sent: [] };
		const now = viewPane(io, pane.pane_id);
		if (!now || now.busyMs !== null || pendingAction(now) !== "FLUSH") return { ...pane, result: "SKIPPED_CHANGED", keys_sent: [] };
		const sent: string[] = [];
		if (io.tmux(["send-keys", "-t", pane.pane_id, "M-Up"]) !== null) {
			sent.push("M-Up");
			io.sleep(400);
			if (io.tmux(["send-keys", "-t", pane.pane_id, "Enter"]) !== null) sent.push("Enter");
		}
		for (let waited = 1000; waited <= FLUSH_VERIFY_MS; waited += 1000) {
			io.sleep(1000);
			if (viewPane(io, pane.pane_id)?.busyMs != null) return { ...pane, result: "STARTED", keys_sent: sent };
		}
		return { ...pane, result: "STILL_STUCK", keys_sent: sent };
	});
	const bad = panes.some((pane) => pane.result !== "STARTED") || scan.stale.length > 0 || scan.frozen.length > 0;
	const changed = panes.some((pane) => pane.keys_sent.length > 0);
	return { overall: bad ? "FINDINGS" : changed ? "CHANGED" : "OK", applied: apply, panes, stale_steer: scan.stale, frozen_turn: scan.frozen };
}

/** Append one JSON line per run that found something; the service's evidence trail. */
export function logFlushReport(path: string, report: FlushReport, nowMs: number): void {
	if (!report.panes.length && !report.stale_steer.length && !report.frozen_turn.length) return;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	appendFileSync(path, `${JSON.stringify({ at: new Date(nowMs).toISOString(), ...report })}\n`, { mode: 0o600 });
}

type Issue = { id?: unknown; status?: unknown; assignee?: unknown; closed_at?: unknown };

function readIssues(io: FleetIo, repo: string): Issue[] | null {
	const text = io.readFile(join(repo, ".beads", "issues.jsonl"));
	if (text === null) return null;
	const issues: Issue[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { issues.push(JSON.parse(line) as Issue); } catch {}
	}
	return issues;
}

type Commit = { author: string; trailerValues: string[]; epochS: number };

function readCommits(io: FleetIo, repo: string): Commit[] | null {
	const text = io.git(repo, ["log", "-n", String(ATTRIBUTION_DEPTH), "--format=%ct%x1f%an%x1f%(trailers:only,unfold,separator=%x1e)%x1d"]);
	if (text === null) return null;
	return text.split("\x1d").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
		const [epoch = "0", author = "", trailers = ""] = record.split("\x1f");
		return { epochS: Number(epoch), author: author.trim(), trailerValues: trailers.split("\x1e").map((line) => line.slice(line.indexOf(":") + 1).trim()).filter(Boolean) };
	});
}

const NAME_TOKEN = /[A-Za-z0-9_-]+/g;
function attributes(commit: Commit, seat: string): boolean {
	const wanted = seat.toLowerCase();
	if (commit.author.toLowerCase() === wanted) return true;
	return commit.trailerValues.some((value) => (value.match(NAME_TOKEN) ?? []).some((token) => token.toLowerCase() === wanted));
}

/** Anti-pattern "Communication purgatory": a seat holding an in_progress bead sends more mail than it lands. */
export function inspectCommunicationPurgatory(io: FleetIo): Finding[] {
	const now = io.nowMs();
	const since = now - PURGATORY_WINDOW_MS;
	const sends = io.mailSends(since * 1000);
	if (typeof sends === "string") return [{ component: "COMMUNICATION_PURGATORY", status: "UNVERIFIED", reason: `Agent Mail store unavailable: ${sends}`, recommended_action: "Point AGENT_MAIL_STORAGE_ROOT at the live Agent Mail root (it holds storage.sqlite3)." }];
	const rows: Finding[] = [];
	let evaluated = 0;
	for (const { repo, seat, count } of sends) {
		if (count < PURGATORY_MIN_SENDS) continue;
		const issues = readIssues(io, repo);
		if (!issues) continue;
		const claimed = issues.filter((issue) => issue.status === "in_progress" && issue.assignee === seat).map((issue) => String(issue.id));
		if (!claimed.length) continue;
		evaluated++;
		const closes = issues.filter((issue) => issue.assignee === seat && typeof issue.closed_at === "string" && Date.parse(issue.closed_at) >= since).length;
		const commits = readCommits(io, repo);
		const base = { seat, repo, sends_2h: count, claimed_beads: claimed, closes_2h: closes };
		if (!commits || !commits.some((commit) => attributes(commit, seat))) {
			rows.push({ component: "COMMUNICATION_PURGATORY", status: "UNVERIFIED",
				reason: `UNKNOWN ${seat} in ${repo}: ${count} sends in 2 h, but no commit in the last ${ATTRIBUTION_DEPTH} names this seat as author or trailer, so its commits cannot be counted`,
				recommended_action: "Add a seat trailer (e.g. Agent: <seat>) to agent commits so landed work can be attributed.",
				evidence: { level: "UNKNOWN", ...base, commits_2h: null, git_readable: commits !== null } });
			continue;
		}
		const landed = commits.filter((commit) => commit.epochS * 1000 >= since && attributes(commit, seat)).length;
		if (count > (landed + closes) * PURGATORY_RATIO) rows.push({ component: "COMMUNICATION_PURGATORY", status: "DEGRADED",
			reason: `WARN ${seat} in ${repo}: ${count} Agent Mail sends in 2 h against ${landed} commit(s) and ${closes} bead close(s) while holding ${claimed.join(", ")}`,
			recommended_action: "Communication purgatory: stop messaging and land the claimed bead (commit, close) or release it.",
			evidence: { level: "WARN", ...base, commits_2h: landed } });
	}
	if (!rows.length) rows.push({ component: "COMMUNICATION_PURGATORY", status: "OK",
		reason: `No seat holding an in_progress bead sent >= ${PURGATORY_MIN_SENDS} messages and more than ${PURGATORY_RATIO}x its commits plus closes in 2 h (${evaluated} claimed seat(s) evaluated)`,
		recommended_action: "No action required.", evidence: { seats_evaluated: evaluated, mail_senders_2h: sends.length } });
	return rows;
}

export function inspectFleetScope(io: FleetIo): Finding[] {
	return [...inspectDirectorDoingWork(io), ...inspectCommunicationPurgatory(io), ...inspectStuckPending(io)];
}

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string | null {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
	return result.status === 0 ? result.stdout : null;
}

/** TMUX_TMPDIR wins; else ~/.tmux-sockets when it holds a live server; else the tmux default. */
export function tmuxSocketArgs(env: NodeJS.ProcessEnv = process.env, probe: (args: readonly string[]) => boolean = (args) => run("tmux", [...args, "list-sessions"]) !== null): string[] {
	if (env.TMUX_TMPDIR) return [];
	const socket = join(env.HOME ?? homedir(), ".tmux-sockets", `tmux-${process.getuid?.() ?? 0}`, "default");
	return existsSync(socket) && probe(["-S", socket]) ? ["-S", socket] : [];
}

export function liveFleetIo(env: NodeJS.ProcessEnv = process.env): FleetIo {
	const socket = tmuxSocketArgs(env);
	return {
		nowMs: () => Date.now(),
		tmux: (args) => run("tmux", [...socket, ...args]),
		processes: () => (run("ps", ["-axo", "pid=,ppid=,args="]) ?? "").split("\n").flatMap((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }] : [];
		}),
		openSessionFiles: (pids) => {
			const map = new Map<number, string[]>();
			if (!pids.length) return map;
			let current = 0;
			// lsof exits 1 when any pid has vanished; its partial stdout is still valid.
			const out = spawnSync("lsof", ["-a", "-p", pids.join(","), "-Fpn"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
			for (const line of out.split("\n")) {
				if (line.startsWith("p")) current = Number(line.slice(1));
				else if (line.startsWith("n") && SESSION_FILE.test(line)) map.set(current, [...(map.get(current) ?? []), line.slice(1)]);
			}
			return map;
		},
		mtimeMs: (path) => { try { return statSync(path).mtimeMs; } catch { return null; } },
		sleep: (ms) => Bun.sleepSync(ms),
		mailSends: (sinceUs) => {
			const root = env.AGENT_MAIL_STORAGE_ROOT;
			if (!root) return "AGENT_MAIL_STORAGE_ROOT is unset";
			const path = join(root, "storage.sqlite3");
			if (!existsSync(path)) return `${path} does not exist`;
			let db: Database | undefined;
			try {
				db = new Database(path, { readonly: true });
				return db.query("SELECT p.human_key AS repo, a.name AS seat, COUNT(*) AS count FROM messages m JOIN agents a ON a.id = m.sender_id JOIN projects p ON p.id = m.project_id WHERE m.created_ts >= ? GROUP BY p.human_key, a.name").all(sinceUs) as MailSends[];
			} catch (error) { return `${path} unreadable: ${error instanceof Error ? error.message : String(error)}`; }
			finally { db?.close(); }
		},
		readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
		git: (repo, args) => run("git", ["-C", repo, ...args]),
	};
}
