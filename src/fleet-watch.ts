import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { recoverBusyTracker, recoveryFlagDirs, type TrackerRecoveryResult } from "./tracker-recovery.ts";
import { YAML } from "bun";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fsyncDirectory, writePrivate } from "./mutations.ts";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;

export type FleetWatchSession = {
	session: string;
	coordinatorPane: string;
	coordinatorSession: string;
	repo: string;
	workerPanes: string[];
	readyCommand?: string;
	skipLabels?: string[];
	/** ompkit-364w Q20 pull context: focus epic ids, mission `file:line`, round and phase. */
	focusEpics?: string[];
	mission?: string;
	round?: string | number;
	phase?: string;
	/** false parks the session's workers: no pull nudge, no escalation. Absent: pulling is on. */
	pullEnabled?: boolean;
};
export type FleetWatchConfig = { enabled: boolean; intervalSeconds: number; noDecisionChecks: number; sessions: FleetWatchSession[] };

export type FleetWatchPaneAction = { kind: "NUDGED" | "ESCALATED" | "NO_DECISION" | "STEERING_SUBMITTED"; session: string; pane: string; checks: number; text: string };
export type FleetWatchRecoveryAction = { kind: TrackerRecoveryResult["kind"]; session: string; pane: string; checks: number; text: string };
export type FleetWatchAction = FleetWatchPaneAction | FleetWatchRecoveryAction;
export type FleetWatchCapture = { code: number; stdout: string; stderr: string };
export type FleetWatchDecision = { busy: boolean; checks: number; actions: FleetWatchPaneAction[] };

/**
 * ompkit-bj08.5.1 PREASSIGN1: eligibility gates evaluated before any NUDGED
 * (or ESCALATED) action is sent. A reader-healthy tracker is not
 * writer-healthy: nudging a worker to claim while the write path is latched
 * or no free leaf exists manufactures SYNC_CONFLICT failures.
 */
export interface ReadyRow {
	id: string;
	status: string;
	assignee: string | null;
	labels: string[];
	issue_type: string;
}

export type PreassignVerdict =
	| { ready: true }
	| { ready: false; kind: "WRITE_LATCHED" | "NO_FREE_LEAF" | "UNKNOWN" | "NO_TRIAGE_PICK"; text: string };

export interface PreassignProbes {
	/** Unresolved recovery flag dirs, or null when unreadable (UNKNOWN). */
	findRecoveryFlags: (repo: string) => string[] | null;
	/** Ready rows plus the probe failure (null when rows read) for the UNKNOWN notice. */
	listReadyRows: (repo: string, readyCommand?: string) => { rows: ReadyRow[] | null; failure: string | null };
}

const NON_LEAF_LABEL = /epic|umbrella/i;
const READY_TIMEOUT_MS = 15000;
const READY_MAX_BUFFER = 16 * 1024 * 1024;
const FAILURE_DETAIL_CHARS = 200;

export type RunJsonFailureKind = "timeout" | "buffer" | "exit" | "signal" | "bad-json" | "spawn";
export type RunJsonFailure = { kind: RunJsonFailureKind; status: number | null; signal: string | null; elapsed_ms: number; detail: string };
export type RunJsonResult = { ok: true; value: unknown } | { ok: false; failure: RunJsonFailure };

const firstLine = (text: string): string => text.split("\n", 1)[0]!.slice(0, FAILURE_DETAIL_CHARS);

/** spawnSync outcome with the failure named (ompkit-fp72.31 FWUNK1): timeouts,
 * buffer overflows, exits, signals and bad JSON stay distinguishable. Timeouts
 * and IO priority are untouched; fail-closed callers map failure to null. */
export function runJson(argv: readonly string[], cwd: string | undefined, bounds: { readonly timeoutMs?: number; readonly maxBuffer?: number } = {}): RunJsonResult {
	const started = performance.now();
	const elapsed = (): number => Math.round(performance.now() - started);
	const timeoutMs = bounds.timeoutMs ?? READY_TIMEOUT_MS;
	const maxBuffer = bounds.maxBuffer ?? READY_MAX_BUFFER;
	let child: { status: number | null; signal: string | null; stdout: string; stderr: string; error?: unknown };
	try {
		child = spawnSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer });
	} catch (error) {
		return { ok: false, failure: { kind: "spawn", status: null, signal: null, elapsed_ms: elapsed(), detail: firstLine(error instanceof Error ? error.message : String(error)) } };
	}
	const message = child.error instanceof Error ? child.error.message : "";
	if (/ETIMEDOUT/.test(message)) return { ok: false, failure: { kind: "timeout", status: child.status, signal: child.signal, elapsed_ms: elapsed(), detail: `timeout after ${timeoutMs} ms` } };
	if (/ENOBUFS|maxBuffer/.test(message)) return { ok: false, failure: { kind: "buffer", status: child.status, signal: child.signal, elapsed_ms: elapsed(), detail: `maxBuffer ${maxBuffer} bytes exceeded` } };
	if (child.error !== undefined && child.error !== null) return { ok: false, failure: { kind: "spawn", status: child.status, signal: child.signal, elapsed_ms: elapsed(), detail: firstLine(message) } };
	if (child.status !== 0) return { ok: false, failure: { kind: child.signal !== null && child.status === null ? "signal" : "exit", status: child.status, signal: child.signal, elapsed_ms: elapsed(), detail: child.signal !== null && child.status === null ? child.signal : firstLine(child.stderr) } };
	try {
		return { ok: true, value: JSON.parse(child.stdout) };
	} catch {
		return { ok: false, failure: { kind: "bad-json", status: child.status, signal: child.signal, elapsed_ms: elapsed(), detail: "non-JSON output" } };
	}
}

function defaultListReadyRows(repo: string, readyCommand?: string): { rows: ReadyRow[] | null; failure: string | null } {
	if (!existsSync(repo)) return { rows: null, failure: "repo missing" };
	const argv = (readyCommand ?? "br ready --json").split(" ").filter((part) => part !== "");
	if (argv[0] !== "br") return { rows: null, failure: "not a br command" };
	const outcome = runJson(argv, repo);
	if (!outcome.ok) return { rows: null, failure: `br ready --json: ${describeRunFailure(outcome.failure)}` };
	const rows = parseReadyRows(outcome.value);
	if (rows === null) return { rows: null, failure: "br ready --json: unexpected ready-rows shape" };
	return { rows, failure: null };
}

/** One line for the UNKNOWN notice and its jsonl record. */
export function describeRunFailure(failure: RunJsonFailure): string {
	switch (failure.kind) {
		case "timeout": return `${failure.detail} (status ${String(failure.status)}, signal ${String(failure.signal)}, ${failure.elapsed_ms} ms)`;
		case "buffer": return `${failure.detail} (status ${String(failure.status)}, signal ${String(failure.signal)}, ${failure.elapsed_ms} ms)`;
		case "exit": return `exit ${String(failure.status)}${failure.detail ? `: ${failure.detail}` : ""} (${failure.elapsed_ms} ms)`;
		case "signal": return `signal ${String(failure.signal)} (${failure.elapsed_ms} ms)`;
		case "bad-json": return `${failure.detail} (status ${String(failure.status)}, ${failure.elapsed_ms} ms)`;
		case "spawn": return `spawn: ${failure.detail} (${failure.elapsed_ms} ms)`;
	}
}

export function parseReadyRows(value: unknown): ReadyRow[] | null {
	if (!Array.isArray(value)) return null;
	const rows: ReadyRow[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object" || Array.isArray(row)) return null;
		if (!("id" in row) || !("status" in row)) return null;
		const id: unknown = row.id;
		const status: unknown = row.status;
		if (typeof id !== "string" || typeof status !== "string") return null;
		const assignee: unknown = "assignee" in row ? row.assignee : null;
		const labels: unknown = "labels" in row ? row.labels : [];
		const issueType: unknown = "issue_type" in row ? row.issue_type : "";
		rows.push({
			id,
			status,
			assignee: typeof assignee === "string" && assignee ? assignee : null,
			labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [],
			issue_type: typeof issueType === "string" ? issueType : "",
		});
	}
	return rows;
}

export const defaultPreassignProbes: PreassignProbes = {
	findRecoveryFlags: (repo) => recoveryFlagDirs(repo),
	listReadyRows: defaultListReadyRows,
};

function isClaimableLeaf(row: ReadyRow, skipLabels: readonly string[]): boolean {
	if (row.status !== "open" || row.assignee !== null) return false;
	if (row.issue_type.toLowerCase() === "epic") return false;
	if (row.labels.some((label) => NON_LEAF_LABEL.test(label) || skipLabels.includes(label))) return false;
	return true;
}

/**
 * Pure pre-assignment verdict. recoveryKind is this run's recovery outcome
 * for the repo (null when no recovery ran): flags that survive anything but
 * a PROCEEDED recovery stay latched. No completion store exists anywhere, so
 * a PROCEEDED attempt clears the episode; legacy checks below still apply.
 */
export function preassignVerdict(
	sessionName: string,
	flags: string[] | null,
	recoveryKind: TrackerRecoveryResult["kind"] | null,
	rows: ReadyRow[] | null,
	skipLabels: readonly string[],
): PreassignVerdict {
	const gate = writeGate(sessionName, flags, recoveryKind);
	if (!gate.ready) return gate;
	return leafVerdict(sessionName, rows, skipLabels);
}

/** Write-path gate shared by every nudge: grading and rework write the tracker too. */
export function writeGate(sessionName: string, flags: string[] | null, recoveryKind: TrackerRecoveryResult["kind"] | null): PreassignVerdict {
	if (flags === null) {
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (recovery flags unreadable); nudges resume when probes answer.` };
	}
	if (flags.length > 0 && recoveryKind !== "RECOVERY_PROCEEDED") {
		const names = flags.map((flag) => basename(flag)).join(", ");
		return { ready: false, kind: "WRITE_LATCHED", text: `Fleet watch (WRITE_LATCHED): no nudge for ${sessionName} workers while the tracker write path is latched (${names}); recovery ${recoveryKind ?? "did not proceed"}; nudges resume when flags clear.` };
	}
	return { ready: true };
}

function leafVerdict(sessionName: string, rows: ReadyRow[] | null, skipLabels: readonly string[], readyFailure: string | null = null): PreassignVerdict {
	if (rows === null) {
		const cause = readyFailure === null ? "ready rows unreadable" : `ready rows unreadable: ${readyFailure}`;
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (${cause}); nudges resume when probes answer.` };
	}
	const open = rows.filter((row) => row.status === "open");
	const leaves = open.filter((row) => isClaimableLeaf(row, skipLabels));
	if (leaves.length === 0) {
		const held = open.filter((row) => row.assignee !== null).length;
		const epics = open.filter((row) => row.issue_type.toLowerCase() === "epic" || row.labels.some((label) => NON_LEAF_LABEL.test(label))).length;
		return { ready: false, kind: "NO_FREE_LEAF", text: `Fleet watch (NO_FREE_LEAF): no nudge for ${sessionName} workers: no claimable leaf (ready ${open.length}, held ${held}, epics ${epics}); nudges resume when a leaf frees.` };
	}
	return { ready: true };
}
type FleetWatchPaneState = { checks?: number; lastDecision?: number; lastSteeringCount?: number; parked?: true };
type FleetWatchState = { version: 1; panes: Record<string, FleetWatchPaneState>; preassign?: Record<string, { kind: string; atMs: number }> };

function parseFleetWatchState(value: unknown): FleetWatchState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const state = value as { version?: unknown; panes?: unknown; preassign?: unknown };
	const rawPanes = state.panes;
	if (state.version !== 1 || typeof rawPanes !== "object" || rawPanes === null || Array.isArray(rawPanes)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
	for (const [key, raw] of Object.entries(rawPanes as Record<string, unknown>)) {
		if (!key || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("FLEET_WATCH_STATE_INVALID");
		const candidate = raw as { checks?: unknown; lastDecision?: unknown; lastSteeringCount?: unknown; parked?: unknown };
		const pane: FleetWatchPaneState = {};
		const checks = candidate.checks;
		if (checks !== undefined) {
			if (typeof checks !== "number" || !Number.isSafeInteger(checks) || checks < 0) throw new Error("FLEET_WATCH_STATE_INVALID");
			pane.checks = checks;
		}
		const lastDecision = candidate.lastDecision;
		if (lastDecision !== undefined) {
			if (typeof lastDecision !== "number" || !Number.isFinite(lastDecision) || lastDecision < 0) throw new Error("FLEET_WATCH_STATE_INVALID");
			pane.lastDecision = lastDecision;
		}
		const lastSteeringCount = candidate.lastSteeringCount;
		if (lastSteeringCount !== undefined) {
			if (typeof lastSteeringCount !== "number" || !Number.isSafeInteger(lastSteeringCount) || lastSteeringCount < 1) throw new Error("FLEET_WATCH_STATE_INVALID");
			pane.lastSteeringCount = lastSteeringCount;
		}
		if (candidate.parked !== undefined) {
			if (candidate.parked !== true) throw new Error("FLEET_WATCH_STATE_INVALID");
			pane.parked = true;
		}
		panes[key] = pane;
	}
	const parsed: FleetWatchState = { version: 1, panes };
	if (state.preassign !== undefined) {
		if (typeof state.preassign !== "object" || state.preassign === null || Array.isArray(state.preassign)) throw new Error("FLEET_WATCH_STATE_INVALID");
		parsed.preassign = Object.create(null) as Record<string, { kind: string; atMs: number }>;
		for (const [key, raw] of Object.entries(state.preassign as Record<string, unknown>)) {
			const report = raw as { kind?: unknown; atMs?: unknown } | null;
			if (!key || typeof report !== "object" || report === null || typeof report.kind !== "string" || !report.kind || typeof report.atMs !== "number" || !Number.isFinite(report.atMs) || report.atMs < 0) throw new Error("FLEET_WATCH_STATE_INVALID");
			parsed.preassign[key] = { kind: report.kind, atMs: report.atMs };
		}
	}
	return parsed;
}

function loadFleetWatchState(path: string): FleetWatchState | undefined {
	let info: Stats | undefined;
	try { info = lstatSync(path); }
	catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	if (!info) return undefined;
	if (!info.isFile() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("FLEET_WATCH_STATE_INVALID");
	return parseFleetWatchState(JSON.parse(readFileSync(path, "utf8")));
}

function saveFleetWatchState(path: string, state: FleetWatchState): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writePrivate(temporaryPath, `${JSON.stringify(state)}\n`);
		renameSync(temporaryPath, path);
		fsyncDirectory(dirname(path));
	} catch (error) {
		try { unlinkSync(temporaryPath); } catch {}
		throw error;
	}
}

export function paneIsBusy(paneText: string): boolean {
	return paneText.split("\n").slice(-6).some(line => SPINNER.test(line));
}

/**
 * The tmux target for a configured worker pane. A pane id (`%12`) is server-unique and must be passed
 * alone: tmux reads `session:%12` as a window named `%12` and fails with "can't find window". Any other
 * selector (`0.1`, `window.pane`) is scoped to the session.
 */
export function paneTarget(session: string, pane: string): string {
	return /^%\d+$/.test(pane) ? pane : `${session}:${pane}`;
}

/**
 * ompkit-364w, decisions Q20/Q22. Idle workers pull: (1) the grading queue (beads awaiting
 * verification the worker did not author), (2) the rework queue (original implementer first while
 * that implementer holds a live seat), (3) the next `bv --robot-triage` recommendation under the
 * session's focus epics that `br ready` confirms is a claimable leaf; the `br ready` order is the
 * fallback only when bv or the DAG is unusable. Shapes read are cited in docs/fleet-watch.md.
 */

/**
 * Q22 worker reply vocabulary: the one table that renders the report lines in every nudge and parses
 * replies found in bead comments. `role` says what a parsed reply means for the queues: an
 * implementer reply makes its commenter the bead's author, a verdict ends a pending DONE.
 */
export const WORKER_REPLIES = [
	{ verb: "CLOSED", args: "<bead> <sha> <evidence>", role: "verdict", pattern: /^CLOSED[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+[0-9a-f]{7,40}[ \t]+\S/ },
	{ verb: "REWORK", args: "<bead> <gaps>", role: "verdict", pattern: /^REWORK[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
	{ verb: "DONE", args: "<bead> <sha> <evidence>", role: "implementer", pattern: /^DONE[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+[0-9a-f]{7,40}[ \t]+\S/ },
	{ verb: "PROGRESS", args: "<bead> <sha> <remaining>", role: "implementer", pattern: /^PROGRESS[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+[0-9a-f]{7,40}[ \t]+\S/ },
	{ verb: "SPLIT", args: "<bead> <child ids>", role: "status", pattern: /^SPLIT[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+[A-Za-z0-9]/ },
	{ verb: "FILED", args: "<bead> <parent|no-epic reason>", role: "status", pattern: /^FILED[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
	{ verb: "OBSOLETE", args: "<bead> <evidence>", role: "implementer", pattern: /^OBSOLETE[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
	{ verb: "BLOCKED", args: "<bead> <dependency|environment|credential|reservation|quota|external|live-action|owner-decision> cmd=<exact failing command and its output> tried=<two or more approaches, each with its result> fix=<researched unblock: command, patch, owner or route, with its source file:line, doc or skill> next=<item you pulled meanwhile>", role: "status", pattern: /^BLOCKED[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+(?:dependency|environment|credential|reservation|quota|external|live-action|owner-decision)[ \t]+cmd=\S(?=[^\n]*[ \t]tried=\S)(?=[^\n]*[ \t]fix=\S)(?=[^\n]*[ \t]next=\S)/ },
	{ verb: "QUESTION", args: "<bead> <question>", role: "status", pattern: /^QUESTION[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
	{ verb: "SKIP", args: "<bead> <reason>", role: "status", pattern: /^SKIP[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
	{ verb: "NO-WORK", args: "<queue counts>", role: "status", pattern: /^NO-WORK[ \t]+()\S/ },
	{ verb: "UNHEALTHY", args: "<tracker|git|disk|auth|quota|model|tool> <detail>", role: "status", pattern: /^UNHEALTHY[ \t]+()(?:tracker|git|disk|auth|quota|model|tool)[ \t]+\S/ },
	{ verb: "HANDOFF", args: "<bead> <comment ref>", role: "status", pattern: /^HANDOFF[ \t]+([A-Za-z0-9][A-Za-z0-9._-]{0,127})[ \t]+\S/ },
] as const;
export type WorkerVerb = (typeof WORKER_REPLIES)[number]["verb"];
export type WorkerReply = { verb: WorkerVerb; role: (typeof WORKER_REPLIES)[number]["role"]; bead: string | null };

/** Parse a reply: the text's first line, matched against the table. Null when it is not a Q22 reply. */
export function parseWorkerReply(text: string): WorkerReply | null {
	const start = text.trimStart();
	const end = start.indexOf("\n");
	const line = (end === -1 ? start : start.slice(0, end)).slice(0, 512);
	for (const reply of WORKER_REPLIES) {
		const match = reply.pattern.exec(line);
		if (match) return { verb: reply.verb, role: reply.role, bead: match[1] || null };
	}
	return null;
}

/** Verdict comments graders wrote before Q22 (observed in the omp-kit, uds and cfs trackers); they still end a pending DONE. */
const LEGACY_VERDICT = /^(?:CONTROLLER[ \t]+|TRIAGE[ \t]+)?(?:GRADE[DS]?|VERIF(?:IED|ICATION|Y)|VERDICT|REVIEW(?:ED)?|REJECT(?:ED)?|ACCEPT(?:ED)?|INTEGRATE[DS]?|PASS(?:ED)?|FAIL(?:ED)?)\b/;

export interface TrackerPolicy { statuses: string[]; transitions: Record<string, string[]>; ready: string[] }
export interface TrackerIssue { id: string; status: string; priority: number; labels: string[]; parents: string[]; comments: { author: string; text: string }[] }
export interface GradingItem { id: string; status: string; author: string | null; via: string; labels: string[] }
export interface ReworkItem { id: string; implementer: string | null; labels: string[] }
export type TriageResult = { usable: true; ids: string[] } | { usable: false; reason: string };
export type PullPick =
	| { kind: "GRADE"; id: string; via: string; author: string | null; rework: string }
	| { kind: "REWORK"; id: string; implementer: string | null }
	| { kind: "TRIAGE"; id: string; rank: number; epic: string | null }
	| { kind: "READY"; id: string; reason: string; epic: string | null };
export type PullChoice = { ready: true; pick: PullPick } | Extract<PreassignVerdict, { ready: false }>;

export interface PullProbes {
	/** `.beads/policy.yaml`; the empty policy when absent, null when unparsable. */
	readPolicy: (repo: string) => TrackerPolicy | null;
	/** `br list --status S... --json` rows, or null when unreadable. */
	listStatuses: (repo: string, statuses: readonly string[]) => ReadyRow[] | null;
	/** `.beads/issues.jsonl` (comments and parent-child edges), or null when unreadable. */
	readIssues: (repo: string) => TrackerIssue[] | null;
	/** `bv --robot-triage` recommendation ids in order, or why bv is unusable. */
	triage: (repo: string) => TriageResult;
	/** Agent Mail identity of a pane id (`am agents resolve-pane`), or null. */
	resolveWorker: (repo: string, pane: string) => string | null;
}

const EMPTY_POLICY: TrackerPolicy = { statuses: [], transitions: {}, ready: ["open"] };
const IDLE_HEAD = "Fleet watch: idle for 4+ minutes.";
const REWORK_LABEL = "rework";

function stringList(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

export function parsePolicy(value: unknown): TrackerPolicy | null {
	if (value === null || value === undefined) return EMPTY_POLICY;
	if (typeof value !== "object" || Array.isArray(value)) return null;
	const workflow: unknown = (value as Record<string, unknown>).workflow;
	if (workflow === undefined) return EMPTY_POLICY;
	if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) return null;
	const record = workflow as Record<string, unknown>;
	const statuses = record.statuses === undefined ? [] : stringList(record.statuses);
	if (statuses === null) return null;
	const transitions: Record<string, string[]> = {};
	if (record.transitions !== undefined) {
		if (typeof record.transitions !== "object" || record.transitions === null || Array.isArray(record.transitions)) return null;
		for (const [from, to] of Object.entries(record.transitions)) {
			const list = stringList(to);
			if (list === null) return null;
			transitions[from] = list;
		}
	}
	const groups: unknown = record.status_groups;
	const ready = typeof groups === "object" && groups !== null && !Array.isArray(groups) ? stringList((groups as Record<string, unknown>).ready) ?? ["open"] : ["open"];
	return { statuses, transitions, ready };
}

/** Statuses that hold work awaiting verification: reachable from in_progress, able to close, not ready work. */
export function reviewStatuses(policy: TrackerPolicy): string[] {
	return (policy.transitions.in_progress ?? []).filter((status) => status !== "closed" && !policy.ready.includes(status) && (policy.transitions[status] ?? []).includes("closed"));
}

export function parseIssuesJsonl(text: string): TrackerIssue[] | null {
	const issues: TrackerIssue[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let value: unknown;
		try { value = JSON.parse(line); } catch { return null; }
		if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
		const row = value as Record<string, unknown>;
		if (typeof row.id !== "string" || typeof row.status !== "string") return null;
		const id = row.id;
		const parents = Array.isArray(row.dependencies)
			? row.dependencies.flatMap((dep: unknown) => {
				const edge = dep as Record<string, unknown> | null;
				return edge && edge.type === "parent-child" && edge.issue_id === id && typeof edge.depends_on_id === "string" ? [edge.depends_on_id] : [];
			})
			: [];
		const comments = Array.isArray(row.comments)
			? row.comments.flatMap((entry: unknown) => {
				const comment = entry as Record<string, unknown> | null;
				return comment && typeof comment.author === "string" && typeof comment.text === "string" ? [{ author: comment.author, text: comment.text }] : [];
			})
			: [];
		issues.push({ id, status: row.status, priority: typeof row.priority === "number" ? row.priority : 4, labels: stringList(row.labels) ?? [], parents, comments });
	}
	return issues;
}

export function parseTriage(value: unknown): TriageResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { usable: false, reason: "output is not a JSON object" };
	const top = value as Record<string, unknown>;
	const authority = top.source_authority as Record<string, unknown> | undefined;
	if (authority && typeof authority === "object" && authority.claim_safe === false) return { usable: false, reason: `source not claim-safe (${typeof authority.state === "string" ? authority.state : "state unknown"})` };
	const triage = top.triage as Record<string, unknown> | undefined;
	const recommendations: unknown = triage && typeof triage === "object" ? triage.recommendations : undefined;
	if (!Array.isArray(recommendations)) return { usable: false, reason: "no triage.recommendations array" };
	const ids: string[] = [];
	for (const rec of recommendations) {
		const id: unknown = rec && typeof rec === "object" ? (rec as Record<string, unknown>).id : undefined;
		if (typeof id !== "string" || id === "") return { usable: false, reason: "recommendation without an id" };
		ids.push(id);
	}
	return { usable: true, ids };
}

/** The last implementer reply's author: who built the bead (DONE, PROGRESS or OBSOLETE). */
function implementerOf(issue: TrackerIssue): string | null {
	let author: string | null = null;
	for (const comment of issue.comments) {
		const reply = parseWorkerReply(comment.text);
		if (reply?.role === "implementer" && reply.bead === issue.id) author = comment.author;
	}
	return author;
}

/** A DONE callback that no other author has answered with a verdict, or null. */
function pendingDone(issue: TrackerIssue): string | null {
	let pending: string | null = null;
	for (const comment of issue.comments) {
		const reply = parseWorkerReply(comment.text);
		if (reply?.verb === "DONE" && reply.bead === issue.id) { pending = comment.author; continue; }
		if (pending === null || comment.author === pending) continue;
		if ((reply?.role === "verdict" && reply.bead === issue.id) || LEGACY_VERDICT.test(comment.text.trimStart().slice(0, 80))) pending = null;
	}
	return pending;
}

/** Grading queue: review-status rows first (tracker order), then unanswered DONE callbacks by priority. */
export function gradingQueue(statusRows: ReadyRow[] | null, issues: TrackerIssue[] | null, review: readonly string[]): GradingItem[] {
	const byId = new Map((issues ?? []).map((issue) => [issue.id, issue]));
	const items: GradingItem[] = [];
	const seen = new Set<string>();
	for (const row of statusRows ?? []) {
		if (!review.includes(row.status)) continue;
		const issue = byId.get(row.id);
		items.push({ id: row.id, status: row.status, author: row.assignee ?? (issue ? implementerOf(issue) : null), via: row.status, labels: row.labels });
		seen.add(row.id);
	}
	const callbacks = (issues ?? [])
		.filter((issue) => !seen.has(issue.id) && (issue.status === "open" || issue.status === "in_progress") && !issue.labels.includes(REWORK_LABEL))
		.flatMap((issue) => {
			const author = pendingDone(issue);
			return author === null ? [] : [{ priority: issue.priority, item: { id: issue.id, status: issue.status, author, via: "DONE callback", labels: issue.labels } }];
		})
		.sort((left, right) => left.priority - right.priority);
	return [...items, ...callbacks.map((entry) => entry.item)];
}

/** Rework queue: unassigned `rework` status rows, or open rows labelled `rework` where the policy lacks the status. */
export function reworkQueue(statusRows: ReadyRow[] | null, readyRows: ReadyRow[] | null, issues: TrackerIssue[] | null): ReworkItem[] {
	const byId = new Map((issues ?? []).map((issue) => [issue.id, issue]));
	const items: ReworkItem[] = [];
	const seen = new Set<string>();
	for (const row of [...(statusRows ?? []), ...(readyRows ?? [])]) {
		if (seen.has(row.id) || row.assignee !== null) continue;
		if (row.status !== REWORK_LABEL && !(row.status === "open" && row.labels.includes(REWORK_LABEL))) continue;
		seen.add(row.id);
		const issue = byId.get(row.id);
		items.push({ id: row.id, implementer: issue ? implementerOf(issue) : null, labels: row.labels });
	}
	return items;
}

/** First focus epic above `id` through parent-child edges and dotted child ids, or null. */
export function focusEpicOf(id: string, parents: ReadonlyMap<string, readonly string[]>, focus: readonly string[]): string | null {
	const seen = new Set([id]);
	const queue = [id];
	while (queue.length > 0) {
		const current = queue.shift()!;
		const dot = current.lastIndexOf(".");
		for (const parent of [...(parents.get(current) ?? []), ...(dot > 0 ? [current.slice(0, dot)] : [])]) {
			if (focus.includes(parent)) return parent;
			if (!seen.has(parent)) { seen.add(parent); queue.push(parent); }
		}
	}
	return null;
}

export interface PullInput {
	sessionName: string;
	/** The idle seat's identity; null when unresolved, which withholds grading (authorship unprovable). */
	worker: string | null;
	/** Identities holding a configured seat in this session. */
	liveWorkers: ReadonlySet<string>;
	grading: readonly GradingItem[];
	rework: readonly ReworkItem[];
	triage: TriageResult;
	issues: TrackerIssue[] | null;
	readyRows: ReadyRow[] | null;
	/** Probe failure behind null readyRows, named in the UNKNOWN notice; absent in older callers. */
	readyFailure?: string | null;
	policy: TrackerPolicy;
	focus: readonly string[];
	skipLabels: readonly string[];
	/** Beads already handed to another seat this tick. */
	taken: ReadonlySet<string>;
}

export function choosePull(input: PullInput): PullChoice {
	const grade = input.worker === null ? undefined : input.grading.find((item) => item.author !== input.worker && !input.taken.has(item.id) && !item.labels.some((label) => input.skipLabels.includes(label)));
	if (grade !== undefined) {
		const rework = (input.policy.transitions[grade.status] ?? []).includes(REWORK_LABEL) ? "set status rework" : `set status open, add label ${REWORK_LABEL}`;
		return { ready: true, pick: { kind: "GRADE", id: grade.id, via: grade.via, author: grade.author, rework } };
	}
	// A rework item waits for its implementer while that implementer holds a live seat here.
	const rework = input.rework.find((item) => !input.taken.has(item.id) && !item.labels.some((label) => input.skipLabels.includes(label))
		&& (item.implementer === null || item.implementer === input.worker || !input.liveWorkers.has(item.implementer)));
	if (rework !== undefined) return { ready: true, pick: { kind: "REWORK", id: rework.id, implementer: rework.implementer } };
	const queued = new Set([...input.grading.map((item) => item.id), ...input.rework.map((item) => item.id)]);
	const rows = input.readyRows?.filter((row) => !input.taken.has(row.id) && !queued.has(row.id)) ?? null;
	const leaves = leafVerdict(input.sessionName, rows, input.skipLabels, input.readyFailure ?? null);
	if (!leaves.ready) return leaves;
	const leafRows = rows!.filter((row) => isClaimableLeaf(row, input.skipLabels));
	const leafIds = new Set(leafRows.map((row) => row.id));
	const parents = input.issues === null ? null : new Map(input.issues.map((issue) => [issue.id, issue.parents]));
	const focusOn = input.focus.length > 0 && parents !== null;
	const focus = input.focus.length ? ` under focus ${input.focus.join(", ")}` : "";
	if (input.triage.usable && (input.focus.length === 0 || parents !== null)) {
		for (const [index, id] of input.triage.ids.entries()) {
			if (!leafIds.has(id)) continue;
			const epic = focusOn ? focusEpicOf(id, parents!, input.focus) : null;
			if (!focusOn || epic !== null) return { ready: true, pick: { kind: "TRIAGE", id, rank: index + 1, epic } };
		}
		// FWFOCUS1 (ompkit-fp72.28): bv's top-N can hold no focus leaf while br ready does; take the first such leaf.
		const fallback = focusOn ? leafRows.find((row) => focusEpicOf(row.id, parents!, input.focus) !== null) : undefined;
		if (fallback !== undefined)
			return { ready: true, pick: { kind: "READY", id: fallback.id, reason: `bv top-${input.triage.ids.length} has no focus leaf`, epic: focusEpicOf(fallback.id, parents!, input.focus) } };
		return { ready: false, kind: "NO_TRIAGE_PICK", text: `Fleet watch (NO_TRIAGE_PICK): ${input.sessionName} workers parked: nothing to grade or rework, and none of the ${input.triage.ids.length} bv --robot-triage recommendations is a claimable br ready leaf${focus}; set focus or unblock. Seats wake when an item becomes eligible.` };
	}
	const reason = input.triage.usable ? "DAG unreadable (.beads/issues.jsonl)" : `bv unusable: ${input.triage.reason}`;
	for (const row of leafRows) {
		const epic = focusOn ? focusEpicOf(row.id, parents!, input.focus) : null;
		if (!focusOn || epic !== null) return { ready: true, pick: { kind: "READY", id: row.id, reason, epic } };
	}
	return { ready: false, kind: "NO_FREE_LEAF", text: `Fleet watch (NO_FREE_LEAF): ${input.sessionName} workers parked: nothing to grade or rework and no claimable br ready leaf${focus} (${reason}). Seats wake when an item becomes eligible.` };
}

/** Null when the session may pull; otherwise why its workers are parked (round INSIGHT or pullEnabled false). */
export function pullPausedReason(session: FleetWatchSession): string | null {
	if (session.pullEnabled === false) return "pullEnabled false";
	if (session.phase?.toUpperCase() === "INSIGHT") return "phase INSIGHT";
	return null;
}

/**
 * Q23: one escalation chain, worker -> director (:0.1) -> chief -> Josh. Every worker reply goes only
 * to the session's director pane; the director escalates. Worker-facing text names no other route.
 */
export function reportCommand(config: FleetWatchSession, verb: WorkerVerb, bead: string): string {
	const row = WORKER_REPLIES.find((entry) => entry.verb === verb)!;
	return `omp-kit send ${config.coordinatorSession} ${config.coordinatorPane} "${verb} ${row.args.replace("<bead>", bead)}"`;
}

/**
 * Josh, 2026-10-12: BLOCKED is a last resort. Every nudge states the bar the BLOCKED row's pattern
 * enforces (cmd=, tried=, fix=, next=); the director rejects any BLOCKED that misses a field.
 */
const BLOCKED_BAR = "BLOCKED is a last resort, not a status: send it only after you have researched the fix. It counts only with all four fields: cmd= the exact failing command and its output, tried= two or more approaches you ran and their results, fix= the researched unblock (exact command, patch, owner or route) with its source (file:line, doc or skill), next= the item you pulled meanwhile. Long output goes in a bead comment that the line cites. Your director rejects any BLOCKED missing a field (REJECTED-BLOCKED) and sends you back to research it.";

export function nudgeText(config: FleetWatchSession, pick: PullPick): string {
	const round = config.round !== undefined ? `round ${config.round}${config.phase ? ` ${config.phase}` : ""}` : config.phase ? `phase ${config.phase}` : null;
	const context = [config.mission ? `mission ${config.mission}` : null, round, config.focusEpics?.length ? `focus ${config.focusEpics.join(", ")}` : null].filter((part) => part !== null);
	const head = `${IDLE_HEAD}${context.length ? ` ${context.join("; ")}.` : ""}`;
	const route = `Every reply, including UNHEALTHY and BLOCKED owner-decision or live-action, goes only to your director ${config.coordinatorPane}; the director escalates.`;
	const work = (id: string) => `Report with one line: ${reportCommand(config, "DONE", id)}, or the same command with ${(["PROGRESS", "BLOCKED", "QUESTION", "SPLIT", "OBSOLETE"] as const).map((verb) => `${verb} ${WORKER_REPLIES.find((entry) => entry.verb === verb)!.args.replace("<bead>", id)}`).join(" | ")}. ${BLOCKED_BAR} ${route} Close only a bead you did not author, after verifying every acceptance item, with the evidence in the close reason.`;
	switch (pick.kind) {
		case "GRADE":
			return `${head} Grade ${pick.id} first (${pick.via}${pick.author ? `, author ${pick.author}` : ""}; never grade your own). Every acceptance item verified: br close it with the evidence in the close reason, then ${reportCommand(config, "CLOSED", pick.id)}. Any gap: one bead comment naming each failed item with its evidence command and output and what success looks like (concrete, checkable, citing the skill that applies, e.g. regex-engineering, verification-before-completion); ${pick.rework}; unassign; then ${reportCommand(config, "REWORK", pick.id)}. ${BLOCKED_BAR} ${route}`;
		case "REWORK":
			return `${head} Nothing to grade; rework ${pick.id}${pick.implementer ? ` (implementer ${pick.implementer})` : ""}: its latest rework comment is the brief. Claim it, close every gap, set it in_review again. ${work(pick.id)}`;
		case "TRIAGE":
			return `${head} Nothing to grade or rework; take ${pick.id} (bv --robot-triage #${pick.rank}${pick.epic ? `, under ${pick.epic}` : ""}): claim it and work it. ${work(pick.id)}`;
		case "READY":
			return `${head} Nothing to grade or rework; ${pick.reason}, so this is the br ready fallback: take ${pick.id}${pick.epic ? ` (under ${pick.epic})` : ""}: claim it and work it. ${work(pick.id)}`;
	}
}

export class FleetWatcher {
	private readonly checks = new Map<string, number>();
	private readonly lastDecision = new Map<string, number>();
	private readonly lastSteeringCount = new Map<string, number>();
	private readonly preassignReports = new Map<string, { kind: string; atMs: number }>();
	/** NO-WORK seats: no repeated empty-queue nudge, but every idle tick re-checks the queues. */
	private readonly parked = new Set<string>();
	constructor(private readonly config: FleetWatchConfig, private readonly now: () => number = Date.now, state?: FleetWatchState) {
		for (const [key, pane] of Object.entries(state?.panes ?? {})) {
			if (pane.checks) this.checks.set(key, pane.checks);
			if (pane.lastDecision !== undefined) this.lastDecision.set(key, pane.lastDecision);
			if (pane.lastSteeringCount !== undefined) this.lastSteeringCount.set(key, pane.lastSteeringCount);
			if (pane.parked) this.parked.add(key);
		}
		for (const [key, report] of Object.entries(state?.preassign ?? {})) {
			if (!key || !report || typeof report !== "object" || Array.isArray(report)) continue;
			if (!("kind" in report) || !("atMs" in report)) continue;
			const kind: unknown = report.kind;
			const atMs: unknown = report.atMs;
			if (typeof kind !== "string" || !kind || typeof atMs !== "number" || !Number.isFinite(atMs) || atMs < 0) continue;
			this.preassignReports.set(key, { kind, atMs });
		}
	}
	snapshot(): FleetWatchState {
		const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
		for (const [key, checks] of this.checks) if (checks > 0) (panes[key] ??= {}).checks = checks;
		for (const [key, lastDecision] of this.lastDecision) (panes[key] ??= {}).lastDecision = lastDecision;
		for (const [key, lastSteeringCount] of this.lastSteeringCount) (panes[key] ??= {}).lastSteeringCount = lastSteeringCount;
		for (const key of this.parked) (panes[key] ??= {}).parked = true;
		const state: FleetWatchState = { version: 1, panes };
		if (this.preassignReports.size > 0) {
			state.preassign = Object.create(null) as Record<string, { kind: string; atMs: number }>;
			for (const [key, report] of this.preassignReports) state.preassign[key] = { ...report };
		}
		return state;
	}
	/**
	 * Once-per-change preassign reporting. kind null clears a resolved
	 * episode. Returns true when the caller must send (new episode) or log a
	 * resolution; false means already reported, stay silent.
	 */
	settlePreassignReport(key: string, kind: string | null): boolean {
		const prev = this.preassignReports.get(key);
		if (kind === null) {
			if (prev === undefined) return false;
			this.preassignReports.delete(key);
			return true;
		}
		if (prev !== undefined && prev.kind === kind) return false;
		this.preassignReports.set(key, { kind, atMs: this.now() });
		return true;
	}
	/** Park (NO-WORK) or wake a seat; parked seats are re-checked on every idle tick, and a woken seat restarts at the nudge count. */
	setParked(session: FleetWatchSession, pane: string, parked: boolean): void {
		const key = `${session.session}:${pane}`;
		if (parked) this.parked.add(key);
		else if (this.parked.delete(key)) this.checks.set(key, 2);
	}
	captureFailed(session: FleetWatchSession, pane: string, capture: FleetWatchCapture): FleetWatchPaneAction {
		this.checks.set(`${session.session}:${pane}`, 0);
		const stderr = capture.stderr.trim().slice(0, 200);
		const cause = capture.code !== 0 ? `tmux capture-pane exited ${capture.code}` : "tmux capture-pane wrote to stderr";
		return {
			kind: "NO_DECISION",
			session: session.session,
			pane,
			checks: 0,
			text: `Fleet watch: ${pane} could not be inspected (${cause}${stderr ? `: ${stderr}` : ""}); pane state is unknown, so no nudge was sent.`,
		};
	}
	poll(session: FleetWatchSession, pane: string, paneText: string): FleetWatchDecision {
		if (!this.config.enabled) return { busy: paneIsBusy(paneText), checks: 0, actions: [] };
		const key = `${session.session}:${pane}`;
		const busy = paneIsBusy(paneText);
		const steeringMatch = paneText.match(/(?:^|\n)[ \t]*Steering · ([1-9]\d*)[ \t]*(?:\n|$)/);
		if (!steeringMatch) this.lastSteeringCount.delete(key);
		if (busy) { this.checks.set(key, 0); this.parked.delete(key); return { busy, checks: 0, actions: [] }; }
		if (steeringMatch) {
			this.checks.set(key, 0);
			if (!paneText.includes("⌥↑ to edit")) return { busy, checks: 0, actions: [] };
			const count = Number(steeringMatch[1]);
			if (this.lastSteeringCount.get(key) === count) return { busy, checks: 0, actions: [] };
			this.lastSteeringCount.set(key, count);
			return { busy, checks: 0, actions: [{ kind: "STEERING_SUBMITTED", session: session.session, pane, checks: 0, text: `Fleet watch: submitted one queued steering message from ${pane} with M-Up then Enter.` }] };
		}
		if (pullPausedReason(session) !== null) {
			this.checks.set(key, 0);
			this.parked.delete(key);
			return { busy, checks: 0, actions: [] };
		}
		const idleChecks = (this.checks.get(key) ?? 0) + 1;
		this.checks.set(key, idleChecks);
		if (this.parked.has(key)) return { busy, checks: idleChecks, actions: [{ kind: "NUDGED", session: session.session, pane, checks: idleChecks, text: IDLE_HEAD }] };
		const actions: FleetWatchPaneAction[] = [];
		if (idleChecks === 2) actions.push({ kind: "NUDGED", session: session.session, pane, checks: idleChecks, text: IDLE_HEAD });
		else if (idleChecks >= 5 && idleChecks % 5 === 0) actions.push({ kind: "ESCALATED", session: session.session, pane, checks: idleChecks, text: `Fleet watch ESCALATION (${session.session}): ${pane} still idle after nudge (${idleChecks} checks). Dispatch it now.` });
		const last = this.lastDecision.get(key) ?? 0;
		if (idleChecks >= this.config.noDecisionChecks && this.now() - last >= this.config.intervalSeconds * 1000 * this.config.noDecisionChecks) {
			actions.push({ kind: "NO_DECISION", session: session.session, pane, checks: idleChecks, text: `Fleet watch: ${pane} has been idle for ${idleChecks} checks without a decision; coordinator attention required.` });
		}
		if (actions.length) this.lastDecision.set(key, this.now());
		return { busy, checks: idleChecks, actions };
	}
}


const MISSION_REF = /^[^\n:][^\n]*:[1-9][0-9]{0,6}$/;

export function loadFleetWatchConfig(path: string): FleetWatchConfig {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).sessions)) throw new Error("FLEET_WATCH_CONFIG_INVALID");
	const sessions = (value as Record<string, unknown>).sessions as FleetWatchSession[];
	for (const [index, session] of sessions.entries()) {
		const invalid = (field: string) => new Error(`FLEET_WATCH_CONFIG_INVALID: sessions[${index}].${field}`);
		if (!session || typeof session !== "object") throw invalid("entry");
		if (session.focusEpics !== undefined && stringList(session.focusEpics) === null) throw invalid("focusEpics");
		if (session.mission !== undefined && (typeof session.mission !== "string" || !MISSION_REF.test(session.mission))) throw invalid("mission");
		if (session.round !== undefined && typeof session.round !== "string" && typeof session.round !== "number") throw invalid("round");
		if (session.phase !== undefined && (typeof session.phase !== "string" || session.phase === "")) throw invalid("phase");
		if (session.pullEnabled !== undefined && typeof session.pullEnabled !== "boolean") throw invalid("pullEnabled");
	}
	return { enabled: (value as Record<string, unknown>).enabled !== false, intervalSeconds: Number((value as Record<string, unknown>).intervalSeconds ?? 120), noDecisionChecks: Number((value as Record<string, unknown>).noDecisionChecks ?? 5), sessions };
}

export const defaultPullProbes: PullProbes = {
	readPolicy: (repo) => {
		const path = join(repo, ".beads", "policy.yaml");
		if (!existsSync(path)) return existsSync(repo) ? EMPTY_POLICY : null;
		try { return parsePolicy(YAML.parse(readFileSync(path, "utf8"))); } catch { return null; }
	},
	listStatuses: (repo, statuses) => {
		if (statuses.length === 0) return [];
		if (!existsSync(repo)) return null;
		// br 0.7.4 `list --json` prints {issues, total, limit, offset, has_more}; the default limit is unlimited.
		const outcome = runJson(["br", "list", ...statuses.flatMap((status) => ["--status", status]), "--json", "--no-auto-import", "--no-auto-flush"], repo);
		if (!outcome.ok) return null;
		return parseReadyRows(outcome.value && typeof outcome.value === "object" && !Array.isArray(outcome.value) ? (outcome.value as Record<string, unknown>).issues : undefined);
	},
	readIssues: (repo) => {
		try { return parseIssuesJsonl(readFileSync(join(repo, ".beads", "issues.jsonl"), "utf8")); } catch { return null; }
	},
	triage: (repo) => {
		if (!existsSync(repo)) return { usable: false, reason: "repo missing" };
		const started = performance.now();
		const elapsed = (): number => Math.round(performance.now() - started);
		const child = spawnSync("bv", ["--robot-triage"], { cwd: repo, encoding: "utf8", timeout: READY_TIMEOUT_MS, maxBuffer: READY_MAX_BUFFER });
		if (child.error) return { usable: false, reason: `bv --robot-triage did not run (${child.error.message}; status ${String(child.status)}, signal ${String(child.signal)}, ${elapsed()} ms)` };
		if (child.status !== 0) return { usable: false, reason: `bv --robot-triage exited ${child.status} (signal ${String(child.signal)}, ${elapsed()} ms)${child.stderr ? `: ${child.stderr.split("\n", 1)[0]!.slice(0, FAILURE_DETAIL_CHARS)}` : ""}` };
		try { return parseTriage(JSON.parse(child.stdout)); } catch { return { usable: false, reason: `bv --robot-triage printed non-JSON (status ${String(child.status)}, ${elapsed()} ms)` }; }
	},
	resolveWorker: (repo, pane) => {
		if (!/^%\d+$/.test(pane)) return null;
		// am.agents.resolve-pane.v1 prints {schema_version, agent_name, pane_id, project_key, source, binding}.
		const outcome = runJson(["am", "agents", "resolve-pane", "--project", repo, "--pane", pane, "--json"], undefined);
		if (!outcome.ok) return null;
		const name: unknown = outcome.value && typeof outcome.value === "object" ? (outcome.value as Record<string, unknown>).agent_name : undefined;
		return typeof name === "string" && name !== "" ? name : null;
	},
};

export type FleetWatchOnceDeps = {
	capture: (session: string, pane: string) => FleetWatchCapture;
	send: (session: string, pane: string, text: string) => void;
	sendKeys: (session: string, pane: string, keys: readonly string[]) => void;
	logPath: string;
	statePath?: string | null;
	now?: () => number;
	recoverTracker?: (repo: string, session: string) => TrackerRecoveryResult | null;
	/**
	 * ompkit-bj08.5: pause/custody admission snapshot. Every send, sendKeys
	 * and tracker-recovery effect consults it first; a refusal performs zero
	 * effects and is recorded in the log. Absent, the legacy path runs.
	 */
	admission?: AdmissionInput;
	/**
	 * ompkit-bj08.5.1 PREASSIGN1: write-readiness and free-leaf probes.
	 * Absent, the native defaults run (recovery-flag scan plus br ready).
	 */
	preassignProbes?: PreassignProbes;
	/** ompkit-364w pull probes (policy, review/rework rows, issues.jsonl, bv triage, seat identity). Absent, the native defaults run. */
	pullProbes?: PullProbes;
};

function admittedEffect(admission: AdmissionInput | undefined, action: string): boolean {
	if (admission === undefined) return true;
	return admitActuator({ ...admission, packet: { ...admission.packet, action } }).verdict !== "REFUSE";
}
export function runFleetWatchOnce(config: FleetWatchConfig, deps: FleetWatchOnceDeps, watcher?: FleetWatcher): FleetWatchAction[] {
	if (!config.enabled) return [];
	const statePath = deps.statePath === undefined
		? watcher === undefined ? join(dirname(deps.logPath), "fleet-watch-state.json") : null
		: deps.statePath;
	const activeWatcher = watcher ?? new FleetWatcher(config, deps.now, statePath === null ? undefined : loadFleetWatchState(statePath));
	const actions: FleetWatchAction[] = [];
	const recoveredRepos = new Set<string>();
	const recoveryKinds = new Map<string, TrackerRecoveryResult["kind"] | null>();
	const probes = deps.preassignProbes ?? defaultPreassignProbes;
	const pull = deps.pullProbes ?? defaultPullProbes;
	const flagCache = new Map<string, string[] | null>();
	const rowsCache = new Map<string, ReadyRow[] | null>();
	const policyCache = new Map<string, TrackerPolicy | null>();
	const statusCache = new Map<string, ReadyRow[] | null>();
	const issuesCache = new Map<string, TrackerIssue[] | null>();
	const triageCache = new Map<string, TriageResult>();
	const seatCache = new Map<string, string | null>();
	const takenBySession = new Map<string, Set<string>>();
	function cached<T>(cache: Map<string, T>, key: string, load: () => T): T {
		if (!cache.has(key)) cache.set(key, load());
		return cache.get(key) as T;
	}
	for (const session of config.sessions) {
		if (recoveredRepos.has(session.repo)) continue;
		recoveredRepos.add(session.repo);
		if (!admittedEffect(deps.admission, "tracker-recovery")) {
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "ADMISSION_REFUSED", session: session.session, pane: "tracker", checks: 0, text: "admission refused tracker recovery; no recovery ran" }) + "\n");
			recoveryKinds.set(session.repo, null);
			continue;
		}
		const recovery = (deps.recoverTracker ?? recoverBusyTracker)(session.repo, session.session);
		recoveryKinds.set(session.repo, recovery?.kind ?? null);
		if (!recovery) continue;
		const action: FleetWatchRecoveryAction = { kind: recovery.kind, session: session.session, pane: "tracker", checks: 0, text: recovery.text };
		appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
		actions.push(action);
	}
	let stateDirty = false;
	const pullFor = (session: FleetWatchSession, pane: string): PullChoice => {
		const gate = writeGate(session.session, cached(flagCache, session.repo, () => probes.findRecoveryFlags(session.repo)), recoveryKinds.get(session.repo) ?? null);
		if (!gate.ready) return gate;
		const policy = cached(policyCache, session.repo, () => pull.readPolicy(session.repo)) ?? EMPTY_POLICY;
		const review = reviewStatuses(policy);
		const statusRows = cached(statusCache, session.repo, () => pull.listStatuses(session.repo, policy.statuses.includes(REWORK_LABEL) ? [...review, REWORK_LABEL] : review));
		const ready = cached(rowsCache, `${session.repo}\0${session.readyCommand ?? ""}`, () => probes.listReadyRows(session.repo, session.readyCommand));
		const readyRows = ready.rows;
		const issues = cached(issuesCache, session.repo, () => pull.readIssues(session.repo));
		const grading = gradingQueue(statusRows, issues, review);
		const rework = reworkQueue(statusRows, readyRows, issues);
		const seat = (seatPane: string) => cached(seatCache, `${session.repo}\0${seatPane}`, () => pull.resolveWorker(session.repo, seatPane));
		return choosePull({
			sessionName: session.session,
			worker: grading.length > 0 || rework.length > 0 ? seat(pane) : null,
			liveWorkers: new Set(rework.length > 0 ? session.workerPanes.flatMap((seatPane) => seat(seatPane) ?? []) : []),
			grading,
			rework,
			triage: cached(triageCache, session.repo, () => pull.triage(session.repo)),
			issues,
			readyRows,
			readyFailure: ready.failure,
			policy,
			focus: session.focusEpics ?? [],
			skipLabels: session.skipLabels ?? [],
			taken: takenBySession.get(session.session) ?? new Set(),
		});
	};
	for (const session of config.sessions) for (const pane of session.workerPanes) {
		const capture = deps.capture(session.session, pane);
		const decisions = capture.code !== 0 || capture.stderr.length > 0
			? [activeWatcher.captureFailed(session, pane, capture)]
			: activeWatcher.poll(session, pane, capture.stdout).actions;
		if (statePath !== null) {
			stateDirty = true;
			if (decisions.length > 0) {
				saveFleetWatchState(statePath, activeWatcher.snapshot());
				stateDirty = false;
			}
		}
		for (const decision of decisions) {
			let action = decision;
			if (action.kind === "NUDGED" || action.kind === "ESCALATED") {
				const choice = pullFor(session, pane);
				if (!choice.ready) {
					// NO-WORK: park the seat; it stays silent but is re-checked every idle tick.
					if (choice.kind === "NO_FREE_LEAF" || choice.kind === "NO_TRIAGE_PICK") activeWatcher.setParked(session, pane, true);
					stateDirty = true;
					if (activeWatcher.settlePreassignReport(session.session, choice.kind)) {
						appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: choice.kind, session: session.session, pane, checks: action.checks, text: choice.text }) + "\n");
						deps.send(session.coordinatorSession, session.coordinatorPane, choice.text);
						if (statePath !== null) saveFleetWatchState(statePath, activeWatcher.snapshot());
					}
					continue;
				}
				activeWatcher.setParked(session, pane, false);
				stateDirty = true;
				if (activeWatcher.settlePreassignReport(session.session, null)) {
					appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "PREASSIGN_CLEARED", session: session.session, pane, checks: action.checks, text: `pre-assignment clear for ${session.session}; nudges resume` }) + "\n");
				}
				if (action.kind === "NUDGED") {
					const taken = takenBySession.get(session.session) ?? new Set<string>();
					taken.add(choice.pick.id);
					takenBySession.set(session.session, taken);
					action = { ...action, text: nudgeText(session, choice.pick) };
				}
			}
			const effect = action.kind === "STEERING_SUBMITTED" ? "send-keys" : "send";
			if (!admittedEffect(deps.admission, effect)) {
				appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "ADMISSION_REFUSED", session: session.session, pane, checks: action.checks, text: `admission refused ${action.kind}; nothing was sent` }) + "\n");
				continue;
			}
			if (action.kind === "STEERING_SUBMITTED") deps.sendKeys(session.session, pane, ["M-Up", "Enter"]);
			else deps.send(action.kind === "NUDGED" ? session.session : session.coordinatorSession, action.kind === "NUDGED" ? pane : session.coordinatorPane, action.text);
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
			actions.push(action);
		}
	}
	if (statePath !== null && stateDirty) saveFleetWatchState(statePath, activeWatcher.snapshot());
	return actions;
}
