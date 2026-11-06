import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runSync } from "../src/kitlib/run.ts";
import { gateEventsPath, trackerAct } from "./gate-events.ts";
import { releaseVerdictHeads, releaseVerdictLocation, subscribeReleaseVerdicts } from "../src/release-verdict-mail.ts";

/**
 * kit-goal-keepalive (GOALKEEP1 ompkit-fp72.120.16.23.1, J-2026-10-18-51; KEEPALIVE2a ompkit-774u.50.1,
 * J-2026-10-29-18): an idle fleet goal seat is woken with the declared constraint, and a seat off the
 * constraint with no pinned work may report NO-WORK and stop.
 *
 * Measured 2026-10-19: QuietBadger idle 68 min, RusticPine 54 min, TurquoiseSummit
 * 53 min, CopperTrout 33 min, all with goal mode active. Cause in omp 18.12.2:
 * interactive-mode.ts #scheduleGoalContinuation returns early when
 * #goalSuppressNextContinuation (a continuation turn whose activity is empty or
 * repeats the previous) or #goalOpenWorkAllBlocked (todos all blocked) holds; only
 * a non-synthetic user message resets suppression. So a suppressed goal seat stays
 * silent until a human types.
 *
 * This extension does not touch the continuation logic. Goal state is learned from
 * `goal_updated`, and re-learned from the latest `mode_change` transcript entry on
 * `session_start` / `session_switch` (a resumed goal may never see a `goal_updated`;
 * live miss 2026-10-19). After `agent_end` it arms a contained one-shot timer
 * (ctx.setTimeout, auto-cleared on session shutdown); if the session is still idle
 * at 120 s it sends one `deliverAs: "aside"` message, which starts a turn when idle
 * (types.ts 1728-1730). A new turn or user input cancels the timer.
 *
 * The wake text (constraintGuidance) is the one text kit-flywheel-guard's wait
 * refusals also use: line 1 is the CONSTRAINT line read from fleet-watch, then the
 * NO-WORK sentence. Measured 2026-11-02: the older "never wait, pull downtime work"
 * text reached 8 seats 230 times in one day, and RubyMeadow (jev, no pinned work)
 * answered every wake with the same no-change turn, which LOOPCATCH1 flagged as a
 * TEXT-LOOP.
 *
 * Bounds: at most one wake per 10 min per seat. A seat whose last goal continuation
 * omp suppressed because it repeated the previous one is not woken: one
 * GOAL_REPEAT_SUPPRESSED entry goes to the director instead. After 3 consecutive
 * wakes whose turns made no state transition (a commit, a br status change, an
 * ACCEPTED or REWORK comment, a gate pass), the extension stops waking and records
 * GOAL_IDLE_ESCALATE so the sentinel mails the director and logs a prompt review.
 *
 * Identity is the same env names admissionOwner uses (BR_ACTOR, BR_AGENT_NAME,
 * AGENT_NAME). Sessions without a fleet identity never wake.
 *
 * Idle state (GOALBREATHE1 ompkit-fp72.120.16.286, J-2026-11-05-09): a seat whose latest todos hold no in_progress
 * or pending item and at least one blocked item, and that waits on something which delivers its own turn (a live
 * background job, a job result queued for delivery, or an event a blocked item names in its `blocker`), is not
 * woken: the job's async-result delivery, mail or a user message starts its turn, and that turn's agent_end re-reads
 * the state, so the wake resumes once the event has fired and nothing is left to wait on. An idle-state seat is
 * woken at most once per 30 min (IDLE_HEARTBEAT_MS), so a lost event cannot strand it. The todos come from the
 * transcript branch, read the way omp restores them (tools/todo.ts getLatestTodoPhasesFromEntries); the jobs come
 * from ctx.getAsyncJobSnapshot(). An unreadable source, an empty todo list or any actionable item keeps the
 * ordinary wake. omp core owns the 'Continue active goal' turns, which already stop when every todo is blocked;
 * no extension hook can veto one (a custom submission skips the `input` event, and a `before_agent_start`
 * result carries no cancel).
 *
 * VERDICTMAIL1: a terminal blocked seat subscribes to its named release SHA(s) in Git's private state.
 * release-verdict.sh sends an Agent Mail event after both judges finish; kit-inbox-wake delivers the turn.
 * The existing timer remains a fallback, reading the last 2 MiB of release-verdict.log; no file watcher.
 */

/** ms of still-idle time before one wake. */
export const IDLE_WAKE_MS = 120_000;
/** Minimum ms between two wakes for one seat. */
export const MIN_WAKE_INTERVAL_MS = 600_000;
/** Consecutive wakes with no state transition before escalation. */
export const MAX_QUIET_WAKES = 3;
/** Custom entry the sentinel watches to mail the director + log prompt review. */
export const GOAL_IDLE_ESCALATE = "GOAL_IDLE_ESCALATE";
/** Custom entry recorded instead of a wake when omp suppressed a repeated continuation. */
export const GOAL_REPEAT_SUPPRESSED = "GOAL_REPEAT_SUPPRESSED";
/** Longest an idle-state seat sleeps without a wake (GOALBREATHE1): one heartbeat per 30 min. */
export const IDLE_HEARTBEAT_MS = 1_800_000;
/** omp's continuation message type (interactive-mode.ts #scheduleGoalContinuation). */
const GOAL_CONTINUATION = "goal-continuation";
/** omp's user todo edit entry (pi-coding-agent tools/todo.ts USER_TODO_EDIT_CUSTOM_TYPE). */
const USER_TODO_EDIT = "user_todo_edit";

const IDENTITY_ENV = ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"] as const;

/** The seat's fleet identity (admissionOwner env names), or null outside a seat. */
export function seatIdentity(env: Record<string, string | undefined>): string | null {
	for (const name of IDENTITY_ENV) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return null;
}

function formatIdle(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60 === 0 ? "" : ` ${s % 60}s`}`;
}

/** fleet-watch.json, as every kit reader resolves it. */
export function fleetWatchPath(env: Record<string, string | undefined>, home: string = homedir()): string {
	return env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
}

const FLEET_WATCH_MAX_BYTES = 4 * 1024 * 1024;
const ISSUES_MAX_BYTES = 128 * 1024 * 1024;
const GATE_EVENTS_TAIL_BYTES = 2 * 1024 * 1024;

function readBounded(path: string, max: number): string | null {
	try {
		const info = statSync(path);
		if (!info.isFile() || info.size > max) return null;
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function realOrResolved(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}

/** The declared reading, validated as launch_check.py _constraint_record (CONSTRAINT1a) does; never runs its producer. */
function validConstraint(record: unknown, now: number): { ok: true } | { ok: false; error: string } {
	if (record === undefined || record === null) return { ok: false, error: "not declared" };
	if (typeof record !== "object" || Array.isArray(record)) return { ok: false, error: "constraint must be a record" };
	for (const key of ["name", "read_at", "clearing_bead", "set_by", "decision"]) {
		if (!nonempty(prop(record, key))) return { ok: false, error: `constraint ${key} missing` };
	}
	const producer = prop(record, "producer");
	if (!nonempty(prop(producer, "command")) || !nonempty(prop(producer, "field"))) {
		return { ok: false, error: "constraint producer command and field missing" };
	}
	for (const key of ["value", "budget"]) {
		const n = prop(record, key);
		if (typeof n !== "number") return { ok: false, error: `constraint ${key} must be a number` };
		if (!Number.isFinite(n) || n < 0 || (key === "budget" && n === 0)) {
			return { ok: false, error: `constraint ${key} must be a finite ${key === "budget" ? "positive" : "nonnegative"} number` };
		}
	}
	const readAt = String(prop(record, "read_at"));
	if (!/(?:Z|[+-]\d\d:?\d\d)$/.test(readAt)) return { ok: false, error: "constraint read_at must include its timezone" };
	const at = Date.parse(readAt);
	if (Number.isNaN(at)) return { ok: false, error: "constraint read_at is not a timestamp" };
	if (at > now) return { ok: false, error: "constraint producer reading is in the future" };
	if (now - at > 24 * 3600_000) return { ok: false, error: "constraint producer reading older than 24 h" };
	return { ok: true };
}

/** The clearing bead's assignee from the session repo's tracker export: "none" unassigned, "unknown" unreadable. */
function clearingHolder(repo: string, id: string): string {
	const text = readBounded(join(repo, ".beads", "issues.jsonl"), ISSUES_MAX_BYTES);
	if (text === null) return "unknown";
	const at = text.indexOf(`{"id":${JSON.stringify(id)},`);
	if (at < 0 || (at > 0 && text[at - 1] !== "\n")) return "unknown";
	const end = text.indexOf("\n", at);
	try {
		const assignee = prop(JSON.parse(text.slice(at, end < 0 ? undefined : end)), "assignee");
		return nonempty(assignee) ? assignee : "none";
	} catch {
		return "unknown";
	}
}

export interface ConstraintSource {
	/** fleet-watch.json path (fleetWatchPath). */
	fleetWatch: string;
	/** The seat's working directory; the session whose repo holds it supplies the constraint. */
	cwd: string;
	now: number;
}

/** The fleet-watch session (or herdr) row whose repo most deeply contains `cwd`, or undefined. */
function sessionRowFor(watch: unknown, cwdPath: string): unknown {
	const cwd = realOrResolved(cwdPath);
	let row: unknown;
	let depth = -1;
	for (const candidate of [prop(watch, "sessions"), prop(watch, "herdr")].flatMap(v => Array.isArray(v) ? v : [])) {
		const repo = prop(candidate, "repo");
		if (!nonempty(repo)) continue;
		const root = realOrResolved(repo);
		if ((cwd === root || cwd.startsWith(`${root}/`)) && root.length > depth) {
			row = candidate;
			depth = root.length;
		}
	}
	return row;
}

/** KEEPALIVEPAUSE1 (ompkit-1ra0d.3): true when the seat's session is paused (pullEnabled false). A paused project
 * spends no keepalive turns (2026-11-06: omp-test's director logged 145 keepalive entries while paused). An unreadable
 * config or a seat outside every session reads false, keeping the wake. */
export function sessionPaused(source: Omit<ConstraintSource, "now">): boolean {
	const text = readBounded(source.fleetWatch, FLEET_WATCH_MAX_BYTES);
	if (text === null) return false;
	let watch: unknown;
	try { watch = JSON.parse(text); } catch { return false; }
	return prop(sessionRowFor(watch, source.cwd), "pullEnabled") === false;
}

/** CONSTRAINT1 line 1 for this seat, in sitrep's form without the pin (launch_check.py constraint_header):
 * `CONSTRAINT <name> <value>/<budget> clearing=<id> holder=<seat|none|unknown>`, `CONSTRAINT none declarer=<lead>`,
 * `CONSTRAINT INVALID <error> declarer=<lead>` or `CONSTRAINT UNKNOWN (<why>)`. Never invents a constraint. */
export function constraintLine(source: ConstraintSource): string {
	const text = readBounded(source.fleetWatch, FLEET_WATCH_MAX_BYTES);
	if (text === null) return `CONSTRAINT UNKNOWN (fleet-watch unreadable: ${source.fleetWatch})`;
	let watch: unknown;
	try { watch = JSON.parse(text); } catch { return `CONSTRAINT UNKNOWN (fleet-watch is not JSON: ${source.fleetWatch})`; }
	const agent = prop(prop(watch, "chief"), "agent");
	const lead = nonempty(agent) ? agent : "unknown";
	const row = sessionRowFor(watch, source.cwd);
	const record = prop(prop(row, "milestone"), "constraint");
	const valid = validConstraint(record, source.now);
	if (!valid.ok) return valid.error === "not declared" ? `CONSTRAINT none declarer=${lead}` : `CONSTRAINT INVALID ${valid.error} declarer=${lead}`;
	const clearing = String(prop(record, "clearing_bead"));
	const holder = clearingHolder(realOrResolved(String(prop(row, "repo"))), clearing);
	return `CONSTRAINT ${prop(record, "name")} ${prop(record, "value")}/${prop(record, "budget")} clearing=${clearing} holder=${holder}`;
}

/** The one wake and wait-refusal text (KEEPALIVE2 (a)-(c), J-2026-10-29-18): line 1 is the constraint line, then the
 * NO-WORK sentence, then the rule for a seat on the constraint and for a finding off it. `blockedBead` adds
 * GIVEUP1's command line; the caller passes it only when the installed kit carries `omp-kit preflight blocked`. */
export function constraintGuidance(line: string, blockedBead: string | null = null): string {
	const lines = [line];
	const declarer = /^CONSTRAINT (?:none|INVALID .*) declarer=(\S+)$/.exec(line)?.[1];
	if (declarer !== undefined) lines.push(`No valid constraint is declared for this project; the lead (${declarer}) declares it, and no seat invents one.`);
	lines.push(
		"If your next action does not move this line and you hold no pinned bead and no review you did not author, "
			+ "send one NO-WORK line to your director and end the turn; idle is correct off the constraint.",
		"A seat on the declared constraint never idles: resume your held bead, or verify another worker's in_review bead.",
		"Do not invent work: a finding off the constraint is a comment on the nearest bead.",
	);
	if (blockedBead !== null) lines.push(`If the bead you hold is blocked, run omp-kit preflight blocked ${blockedBead} and do its rungs; a comment is not a fix.`);
	return lines.join("\n");
}

/** The wake body: the shared guidance, then the seat and its idle time. An idle-state heartbeat (GOALBREATHE1) adds
 * what the seat waits on. */
export function downtimeMessage(seat: string, idleMs: number, constraint: string, blockedBead: string | null = null, wait: IdleWait | null = null): string {
	const body = `${constraintGuidance(constraint, blockedBead)}\n[kit-goal-keepalive] ${seat}: goal active, idle ${formatIdle(idleMs)}.`;
	if (wait === null) return body;
	const on = [...wait.jobs.map(id => `job ${id}`), ...wait.events].join("; ");
	return `${body}\n[kit-goal-keepalive] ${seat}: idle-state heartbeat (at most one per ${formatIdle(IDLE_HEARTBEAT_MS)}): `
		+ `all ${wait.blocked} open todo item(s) are blocked, waiting on ${on}. If that event already arrived, act on it; otherwise end the turn.`;
}

/** An assistant message block, as seen in AgentEndEvent messages. */
export interface KeepaliveBlock {
	type: string;
	[key: string]: unknown;
}

/** An agent message, as seen in AgentEndEvent messages. */
export interface KeepaliveMessage {
	role: string;
	content?: KeepaliveBlock[] | unknown;
	[key: string]: unknown;
}

function toolCalls(messages: readonly KeepaliveMessage[]): KeepaliveBlock[] {
	return messages.flatMap(m => m.role === "assistant" && Array.isArray(m.content) ? (m.content as KeepaliveBlock[]).filter(b => b.type === "toolCall") : []);
}

/** State-transition commands (KEEPALIVE2 (e)). Each is anchored at a command start (line start or after `;`, `&`, `|`,
 * `(`) and its words are separated by single whitespace runs, so a long near-miss stays linear. */
const GIT_COMMIT = /(?:^|[;&|(]\s*)git\s+(?:-C\s+\S+\s+)?commit\b/m;
const VERDICT_COMMENT = /(?:^|[;&|(]\s*)br\s+comments\s+add\s[^;&|\n]*\b(?:ACCEPTED|REWORK)\b/m;
const GATE_RUN = /(?:^|[;&|(]\s*)omp-kit\s+(?:preflight|verify)\b/m;
const STATUS_ACTS: Record<string, true> = { close: true, claim: true, "in-review": true, release: true };

/** True when the turn made a state transition (KEEPALIVE2 (e)): a successful bash call that commits, changes a br
 * status, adds an ACCEPTED or REWORK comment, or passes an omp-kit gate (preflight or verify). Reads, mail and a
 * failed call are no transition. */
export function turnChangedState(messages: readonly KeepaliveMessage[] | undefined): boolean {
	if (!messages) return false;
	const ok = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && typeof m.toolCallId === "string" && m.isError !== true) ok.add(m.toolCallId);
	}
	for (const call of toolCalls(messages)) {
		const command = prop(call.arguments, "command");
		if (String(call.name).toLowerCase() !== "bash" || typeof command !== "string" || typeof call.id !== "string" || !ok.has(call.id)) continue;
		const act = trackerAct(command)?.act;
		if ((act !== undefined && (STATUS_ACTS[act] === true || act.startsWith("status:")))
			|| GIT_COMMIT.test(command) || VERDICT_COMMENT.test(command) || GATE_RUN.test(command)) return true;
	}
	return false;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** The activity omp compares between goal continuations (pi-coding-agent goals/state.ts goalContinuationActivity):
 * every tool call and tool result of the turn, digested. Empty for a text-only turn. */
export function turnActivity(messages: readonly KeepaliveMessage[]): string {
	const digests: string[] = [];
	for (const m of messages) {
		const parts = m.role === "assistant" ? toolCalls([m]).map(b => ["call", b.name, b.arguments])
			: m.role === "toolResult" ? [["result", m.toolName, m.content, m.isError === true]] : [];
		for (const part of parts) {
			const s = stable(part);
			digests.push(`${s.length}:${Bun.hash(s).toString(16)}`);
		}
	}
	return digests.join(":");
}

export interface GoalKeepaliveApi {
	on(event: string, handler: (e: never, ctx: GoalKeepaliveContext) => unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { deliverAs?: string },
	): void;
	appendEntry(customType: string, data?: unknown): void;
}

/** A persisted session entry this extension reads: a mode transition, as pi's goal runtime writes it
 * (`appendModeChange("goal" | "goal_paused" | "none", { goal })`), or a todo snapshot, as omp restores todos
 * (tools/todo.ts canonicalTodoPhases: a `todo` tool result, or a `user_todo_edit` custom entry). */
export interface KeepaliveEntry {
	type?: string;
	mode?: string;
	customType?: string;
	data?: { goal?: { status?: string } | null; phases?: unknown } | null;
	message?: { role?: string; toolName?: string; isError?: boolean; details?: { op?: unknown; phases?: unknown } | null } | null;
}

/** The part of omp's async job snapshot the idle state reads (session/agent-session-types.ts AsyncJobSnapshot). */
export interface AsyncJobView {
	running?: readonly unknown[];
	delivery?: { queued?: number; delivering?: boolean } | null;
}

export interface GoalKeepaliveContext {
	cwd?: string;
	isIdle?: () => boolean;
	setTimeout(callback: (...args: unknown[]) => void, ms?: number): unknown;
	clearTimer(timer: unknown): void;
	sessionManager?: { getEntries?: () => readonly KeepaliveEntry[]; getBranch?: () => readonly KeepaliveEntry[] };
	/** Background jobs this session owns (ExtensionContext.getAsyncJobSnapshot). */
	getAsyncJobSnapshot?: () => AsyncJobView | null;
}

export interface GoalKeepaliveDeps {
	env?: Record<string, string | undefined>;
	now?: () => number;
	home?: string;
	/** The seat's directory when the host context carries none. */
	cwd?: string;
	/** Whether the installed kit carries `omp-kit preflight blocked` (GIVEUP1a); default: the kit's command registry. */
	preflightBlocked?: boolean;
	/** The seat's in_progress bead ids; default: `br list --status in_progress --assignee <seat> --json` in its cwd. */
	heldBeads?: (seat: string, cwd: string) => string[];
}

/** The newest gate-events row kind for one bead, from the ledger's last 2 MiB; null when none is there. */
export function newestGateKind(ledger: string, bead: string): string | null {
	let text: string;
	try {
		const fd = openSync(ledger, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, GATE_EVENTS_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			text = buffer.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i]!.includes(JSON.stringify(bead))) continue;
		try {
			const row = JSON.parse(lines[i]!);
			if (prop(row, "target") === bead) return String(prop(row, "kind"));
		} catch { /* a torn first line of the tail window */ }
	}
	return null;
}

/** The seat's latest persisted todo phases, decoded as omp restores them (tools/todo.ts
 * getLatestTodoPhasesFromEntries): the newest `user_todo_edit` entry or successful non-view `todo` result; [] when
 * none. */
export function latestTodoPhases(entries: readonly KeepaliveEntry[]): unknown[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = entry?.message;
		const phases = entry?.type === "custom" && entry.customType === USER_TODO_EDIT ? entry.data?.phases
			: entry?.type === "message" && message?.role === "toolResult" && message.toolName === "todo" && message.isError !== true
				&& message.details?.op !== "view" ? message.details?.phases : undefined;
		if (Array.isArray(phases)) return phases;
	}
	return [];
}

/** What an idle-state seat waits on (GOALBREATHE1). */
export interface IdleWait {
	/** Open todo items, every one blocked. */
	blocked: number;
	/** Live background job ids, plus a result queued for delivery. */
	jobs: string[];
	/** The events blocked items name in their `blocker`. */
	events: string[];
}

/** The idle state: every open todo item is blocked (omp's own test, interactive-mode #goalOpenWorkAllBlocked: no
 * in_progress or pending item, at least one blocked) and the seat waits on a live job, a queued job result or a named
 * event. Null for an actionable item, an item of unknown status, an empty list, or nothing to wait on. */
export function idleWait(phases: readonly unknown[], jobs: AsyncJobView | null): IdleWait | null {
	let blocked = 0;
	const events: string[] = [];
	for (const phase of phases) {
		const tasks = prop(phase, "tasks");
		if (!Array.isArray(tasks)) return null;
		for (const task of tasks) {
			const status = prop(task, "status");
			if (status === "completed" || status === "abandoned") continue;
			if (status !== "blocked") return null;
			blocked += 1;
			const blocker = prop(task, "blocker");
			if (nonempty(blocker)) events.push(blocker.trim());
		}
	}
	if (blocked === 0) return null;
	const running = (jobs?.running ?? []).map(job => { const id = prop(job, "id"); return nonempty(id) ? id : "unnamed"; });
	if ((jobs?.delivery?.queued ?? 0) > 0 || jobs?.delivery?.delivering === true) running.push("result queued for delivery");
	return running.length > 0 || events.length > 0 ? { blocked, jobs: running, events } : null;
}

/** Only complete durable lines count. Bound reads like the gate ledger; retain the latest rc per kind/head. */
export function matchingReleaseVerdicts(path: string, events: readonly string[]): string[] {
	let text: string;
	try {
		const fd = openSync(path, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, GATE_EVENTS_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			text = buffer.toString("utf8");
			if (size > length) text = text.slice(text.indexOf("\n") + 1);
		} finally { closeSync(fd); }
	} catch { return []; }
	const named = releaseVerdictHeads(events);
	const verdicts = new Map<string, Map<string, string>>();
	for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n")) {
		const row = /^release-verdict: ([0-9a-f]{40}) ((?:producer|ci_only)_rc)=(-?\d+)\s*$/i.exec(line);
		if (!row) continue;
		const sha = row[1]!.toLowerCase();
		if (!named.some(prefix => sha.startsWith(prefix))) continue;
		const values = verdicts.get(sha) ?? new Map<string, string>();
		values.set(row[2]!.toLowerCase(), row[3]!);
		verdicts.set(sha, values);
	}
	return [...verdicts].map(([sha, values]) => `release-verdict: ${sha} ${[...values].map(([key, rc]) => `${key}=${rc}`).join(" ")}`);
}

function brHeldBeads(seat: string, cwd: string): string[] {
	const result = runSync(["br", "list", "--status", "in_progress", "--assignee", seat, "--json"], { deadline_s: 10, cwd }); // product-deadline: one wake, at most every 10 min
	if (result.rc !== 0) return [];
	try {
		const issues = prop(JSON.parse(new TextDecoder().decode(result.stdout)), "issues");
		return Array.isArray(issues) ? issues.map(issue => prop(issue, "id")).filter(nonempty) : [];
	} catch {
		return [];
	}
}

export default async function kitGoalKeepalive(
	pi: GoalKeepaliveApi,
	deps: GoalKeepaliveDeps = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const home = deps.home ?? env.HOME ?? homedir();
	const heldBeads = deps.heldBeads ?? brHeldBeads;
	// GIVEUP1a's act is named only when the installed kit carries it (KEEPALIVE2 round 5); a session outside the
	// fleet never wakes, so it never loads the registry.
	let preflightBlocked = deps.preflightBlocked ?? false;
	if (deps.preflightBlocked === undefined && seatIdentity(env) !== null) {
		try {
			const { findCommand } = await import("../src/commands.ts");
			preflightBlocked = findCommand("preflight")?.subcommands?.some(sub => sub.name === "blocked") === true;
		} catch {
			preflightBlocked = false;
		}
	}
	let goal: { enabled: boolean; status: string } | null = null;
	let timer: unknown = null;
	let timerCtx: GoalKeepaliveContext | null = null;
	let lastWakeAt = 0;
	let quietWakes = 0;
	let escalated = false;
	/** A wake fired and the next agent_end attributes that turn's state transitions. */
	let wakePending = false;
	let idleSince = 0;
	/** omp's comparison state: the previous goal continuation's activity, reset by any other turn. */
	let previousContinuation: string | undefined;
	/** One GOAL_REPEAT_SUPPRESSED entry per repeat streak. */
	let repeatRecorded = false;
	// Do not repeat a durable result on every quiet turn; reset when switching sessions.
	const deliveredVerdicts = new Set<string>();
	let unsubscribeVerdict: (() => void) | null = null;
	let verdictSubscriptionCwd: string | null = null;
	const clearVerdictSubscription = () => {
		try { unsubscribeVerdict?.(); } catch { /* timer fallback remains when private state is unavailable */ }
		unsubscribeVerdict = null;
		verdictSubscriptionCwd = null;
	};
	const updateVerdictSubscription = (ctx: GoalKeepaliveContext) => {
		const seat = seatIdentity(env);
		if (!eligible() || seat === null) { clearVerdictSubscription(); return; }
		const cwd = ctx.cwd ?? deps.cwd ?? process.cwd();
		if (verdictSubscriptionCwd !== null && verdictSubscriptionCwd !== cwd) clearVerdictSubscription();
		try {
			unsubscribeVerdict = subscribeReleaseVerdicts(cwd, seat, idleState(ctx)?.events ?? [], env.AGENT_MAIL_PROJECT);
			verdictSubscriptionCwd = cwd;
		} catch { /* mail cannot disable the existing keepalive fallback */ }
	};

	const cancel = (ctx: GoalKeepaliveContext) => {
		if (timer !== null) {
			try {
				ctx.clearTimer(timer);
			} catch {
				// A failed clear leaves a contained one-shot that re-checks
				// eligibility before sending; never throw out of a handler.
			}
			timer = null;
			timerCtx = null;
		}
	};

	const eligible = (): boolean => {
		if (escalated) return false;
		if (seatIdentity(env) === null) return false;
		if (goal === null || goal.enabled !== true || goal.status !== "active") return false;
		return true;
	};

	/** Arm the one timer; an unwired timer stays silent and never throws out of a handler. */
	const schedule = (ctx: GoalKeepaliveContext, ms: number) => {
		timerCtx = ctx;
		try {
			timer = ctx.setTimeout(fire, ms);
		} catch {
			timer = null;
			timerCtx = null;
		}
	};

	/** GOALBREATHE1's reading at fire time; an unreadable transcript or job snapshot reads null, keeping the wake. */
	const idleState = (ctx: GoalKeepaliveContext): IdleWait | null => {
		try {
			return idleWait(latestTodoPhases(ctx.sessionManager?.getBranch?.() ?? []), ctx.getAsyncJobSnapshot?.() ?? null);
		} catch {
			return null;
		}
	};

	/** The timer callback: uses the ctx captured at arm time (contained timers pass no ctx). */
	const fire = () => {
		const ctx = timerCtx;
		timer = null;
		timerCtx = null;
		if (ctx === null || !eligible()) return;
		if (ctx.isIdle?.() === false) return; // busy: that turn's agent_end re-arms
		const at = now();
		if (at - lastWakeAt < MIN_WAKE_INTERVAL_MS) {
			// Throttled, but the seat is still idle and no later agent_end may
			// ever come: re-arm for the remainder so the wake lands at the
			// interval edge instead of never (RusticPine/QuietBadger 2026-10-20
			// HOLDING-turn idles: the 120 s timer fired inside the 10-min
			// window, returned, and nothing was armed again).
			schedule(ctx, lastWakeAt + MIN_WAKE_INTERVAL_MS - at);
			return;
		}
		const wait = idleState(ctx);
		const ready = releaseResults(ctx, wait);
		if (ready.length === 0 && wait !== null && at - idleSince < IDLE_HEARTBEAT_MS) {
			// GOALBREATHE1: the awaited event delivers its own turn, whose agent_end re-arms; sleep to the ceiling.
			schedule(ctx, idleSince + IDLE_HEARTBEAT_MS - at);
			return;
		}
		const seat = seatIdentity(env);
		if (seat === null) return;
		const cwd = ctx.cwd ?? deps.cwd ?? process.cwd();
		if (sessionPaused({ fleetWatch: fleetWatchPath(env, home), cwd })) {
			// KEEPALIVEPAUSE1: a paused project gets no wake, but the timer stays armed (a config read, no model turn) so
			// the seat wakes on the next interval after pullEnabled turns true; nothing else re-arms an idle seat.
			schedule(ctx, MIN_WAKE_INTERVAL_MS);
			return;
		}
		let blocked: string | null = null;
		if (preflightBlocked) {
			try {
				const ledger = gateEventsPath(env, home);
				blocked = heldBeads(seat, cwd).find(id => newestGateKind(ledger, id) === "refuse") ?? null;
			} catch {
				blocked = null; // an unreadable tracker omits the line, never invents a bead
			}
		}
		pi.sendMessage(
			{
				customType: "kit-goal-keepalive",
				content: downtimeMessage(seat, at - idleSince, constraintLine({ fleetWatch: fleetWatchPath(env, home), cwd, now: at }), blocked, ready.length > 0 ? null : wait)
					+ (ready.length > 0 ? `\n[kit-goal-keepalive] Awaited release verdict recorded:\n${ready.join("\n")}` : ""),
				display: true,
			},
			{ deliverAs: "aside" },
		);
		lastWakeAt = at;
		for (const result of ready) deliveredVerdicts.add(result);
		wakePending = true;
	};

	const releaseResults = (ctx: GoalKeepaliveContext, wait: IdleWait | null): string[] => {
		if (wait === null) return [];
		const location = releaseVerdictLocation(ctx.cwd ?? deps.cwd ?? process.cwd());
		return location === null ? [] : matchingReleaseVerdicts(join(location.state, "release-verdict.log"), wait.events).filter(result => !deliveredVerdicts.has(result));
	};

	const arm = (ctx: GoalKeepaliveContext) => {
		cancel(ctx);
		if (!eligible()) return;
		idleSince = now();
		schedule(ctx, IDLE_WAKE_MS);
	};

	type GoalEvent = { goal?: { status?: string } | null; state?: { enabled?: boolean } | null };
	type EndEvent = { messages?: KeepaliveMessage[]; willContinue?: boolean };

	/**
	 * Re-learn goal state from the persisted transcript. A seat whose goal was
	 * restored by a session resume may never see a `goal_updated` after this
	 * extension loads, so the timer would never arm; the latest `mode_change`
	 * entry carries the same truth the resume path restores from
	 * (`agent-session.ts` persist: `appendModeChange(mode, { goal })`).
	 * `goal_updated` stays authoritative afterwards: every later transition
	 * overwrites this. Never arms, never throws.
	 */
	const reconcileFromSession = (ctx: GoalKeepaliveContext) => {
		let entries: readonly KeepaliveEntry[];
		try {
			entries = ctx.sessionManager?.getEntries?.() ?? [];
		} catch {
			return; // unreadable transcript: keep last known state
		}
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type !== "mode_change") continue;
			if (entry.mode === "goal") {
				goal = { enabled: true, status: String(entry.data?.goal?.status ?? "") };
			} else if (entry.mode === "goal_paused") {
				goal = { enabled: false, status: String(entry.data?.goal?.status ?? "") };
			} else if (entry.mode === "none") {
				goal = null;
			}
			return; // the latest mode_change wins; older modes are history
		}
	};
	const reconcileAs = (reset: boolean) =>
		((_e: never, ctx: GoalKeepaliveContext) => {
			if (reset) goal = null; // a switch may land on a goal-less session
			clearVerdictSubscription();
			cancel(ctx);
			if (reset) deliveredVerdicts.clear();
			previousContinuation = undefined;
			reconcileFromSession(ctx);
		}) as (e: never, ctx: GoalKeepaliveContext) => unknown;
	pi.on("goal_updated", (event: GoalEvent) => {
		if (event.goal === undefined && event.state === undefined) return;
		goal = { enabled: event.state?.enabled === true, status: String(event.goal?.status ?? "") };
		if (!goal.enabled || goal.status !== "active") clearVerdictSubscription();
	});
	pi.on("session_start", reconcileAs(false));
	pi.on("session_switch", reconcileAs(true));
	pi.on("agent_end", ((event: EndEvent, ctx: GoalKeepaliveContext) => {
		updateVerdictSubscription(ctx);
		const messages = event.messages ?? [];
		// KEEPALIVE2 (d): mirror omp's suppression (interactive-mode.ts #handleGoalSessionEvent): a continuation whose
		// activity repeats the previous continuation's gets no next continuation, and a wake would only repeat it.
		let repeated = false;
		if (messages.some(m => m.customType === GOAL_CONTINUATION)) {
			const activity = turnActivity(messages);
			repeated = activity.length > 0 && activity === previousContinuation;
			previousContinuation = activity;
		} else {
			previousContinuation = undefined;
		}
		if (!repeated) repeatRecorded = false;
		if (wakePending) {
			wakePending = false;
			if (turnChangedState(messages)) {
				quietWakes = 0;
			} else {
				quietWakes += 1;
				if (quietWakes >= MAX_QUIET_WAKES && !escalated) {
					escalated = true;
					cancel(ctx);
					pi.appendEntry(GOAL_IDLE_ESCALATE, {
						seat: seatIdentity(env),
						quietWakes,
						reason: "no commit, br status change, ACCEPTED/REWORK comment or gate pass after each wake",
						at: new Date(now()).toISOString(),
						next: "sentinel mails the director and logs a prompt review",
					});
					return;
				}
			}
		}
		if (event.willContinue === true) {
			cancel(ctx); // not a terminal settle: a continuation is already scheduled
			return;
		}
		if (repeated) {
			cancel(ctx);
			if (!repeatRecorded && eligible()) {
				repeatRecorded = true;
				pi.appendEntry(GOAL_REPEAT_SUPPRESSED, {
					seat: seatIdentity(env),
					at: new Date(now()).toISOString(),
					next: "omp suppressed a repeated goal continuation; the director decides, the seat is not woken",
				});
			}
			return;
		}
		arm(ctx);
	}) as (e: never, ctx: GoalKeepaliveContext) => unknown);
	const cancelOn = (event: string) => {
		pi.on(event, ((_e: never, ctx: GoalKeepaliveContext) => cancel(ctx)) as (e: never, ctx: GoalKeepaliveContext) => unknown);
	};
	// A new turn or user input ends the idle window the timer watches.
	cancelOn("agent_start");
	cancelOn("turn_start");
	cancelOn("input");
	pi.on("session_stop", ((_e: never, ctx: GoalKeepaliveContext) => {
		cancel(ctx);
		clearVerdictSubscription();
	}) as (e: never, ctx: GoalKeepaliveContext) => unknown);
}
