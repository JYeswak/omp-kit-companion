import { classifyWorkProjection, type WorkProjectionInput } from "./work-projection.ts";
import type { WorkRepoReport } from "./work-doctor.ts";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { checkTrackerRecoveryCutover, defaultPostRecoverReadback, recoverBusyTracker, recoveryFlagDirs, retainTrackerQuarantine, type TrackerQuarantineReceipt, type TrackerRecoveryCutoverInput, type TrackerRecoveryResult, type TrackerRetentionOutcome, type TrackerRetentionReceipt } from "./tracker-recovery.ts";
import { YAML } from "bun";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { appendReapReceipt, defaultGitLockLedgerPath, reapRepoGitLocks, type RepoReapResult, type ReapReceipt } from "./index-lock.ts";
import { defaultRunner, type ScratchRunner } from "./scratch.ts";
import { ccSpool, type CcSpool } from "./cc-spool.ts";
import { atomicReplaceBytes } from "./kitlib/io.ts";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;
/** Reserved uncommitted edits must exceed the work audit's 30-minute limit. */
export const STRANDED_ESCALATION_LIMIT_MINUTES = 30;

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
export type FleetWatchConfig = { enabled: boolean; intervalSeconds: number; noDecisionChecks: number; sessions: FleetWatchSession[]; registeredTrackers?: FleetWatchRegisteredTracker[] };
/**
 * ompkit-ps3lo: MP6-registry seam. Every registered tracker is covered by
 * the health tick even when no session entry names its repo; recovery still
 * runs under the owning director named here. Absent, the legacy
 * sessions-only coverage runs.
 */
export type FleetWatchRegisteredTracker = { repo: string; session: string };

export type FleetWatchPaneAction = { kind: "NUDGED" | "ESCALATED" | "NO_DECISION" | "STEERING_SUBMITTED"; session: string; pane: string; checks: number; text: string };
export type FleetWatchRecoveryAction = { kind: TrackerRecoveryResult["kind"]; session: string; pane: string; checks: number; text: string; receipt?: TrackerQuarantineReceipt; repo?: string };
export type FleetWatchRetentionAction = { kind: "TRACKER_QUARANTINE_RETENTION"; session: string; pane: string; checks: number; text: string; receipt: TrackerRetentionReceipt; repo?: string };
/** An audit routing observation, not a delivery or acceptance receipt. */
export type FleetWatchStrandedAction = { kind: "STRANDED_ESCALATED" | "STRANDED_UNRESOLVED"; session: string; pane: string; checks: number; text: string; repo: string };
/** GITLOCK1 (ompkit-fp72.19.1.9): a stale empty git lock renamed aside under every reaper gate; the receipt is in the lock ledger. */
export type FleetWatchGitLockAction = { kind: "GITLOCK_REAPED"; session: string; pane: string; checks: number; text: string; repo: string; receipt: ReapReceipt };
/** A routing observation in the existing log, never a delivery or acceptance receipt. */
export type FleetWatchPullAction = {
	kind: "PULL_WARNINGS" | Extract<PreassignVerdict, { ready: false }>["kind"];
	session: string; pane: string; checks: number; text: string; refusals: readonly PullRefusal[];
};
export type FleetWatchAction = FleetWatchPaneAction | FleetWatchRecoveryAction | FleetWatchRetentionAction | FleetWatchPullAction | FleetWatchStrandedAction | FleetWatchGitLockAction;
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

/** Routing evidence, not authorization to act on a bead or a seat. */
export interface PullRefusal {
	class: "unsupported_native" | "unauthorized_hands" | "unsafe_custody" | "tool_read_failure";
	bead: string | null;
	actor: string;
	next: string;
	/** A native comment reference, never an authorization inferred from its wording. */
	citation?: string;
}

export type PreassignVerdict =
	| { ready: true; refusals?: readonly PullRefusal[] }
	| { ready: false; kind: "WRITE_LATCHED" | "NO_FREE_LEAF" | "UNKNOWN" | "NO_TRIAGE_PICK"; text: string; refusals: readonly PullRefusal[] };

export interface ReadyRowsResult {
	rows: ReadyRow[] | null;
	failure: string | null;
}

export interface PreassignProbes {
	/** Unresolved recovery flag dirs, or null when unreadable (UNKNOWN). */
	findRecoveryFlags: (repo: string) => string[] | null;
	/** Ready rows plus the probe failure (null when rows read) for the UNKNOWN notice. */
	listReadyRows: (repo: string, readyCommand?: string) => ReadyRowsResult;
}

const NON_LEAF_LABEL = /epic|umbrella/i;
const WORKER_ROLE_EXCLUSIONS: Readonly<Record<string, true>> = { "human-gate": true, "owner-decision": true, "kind:process": true };

function excludedWorkerLabel(label: string, configured: readonly string[]): boolean {
	return WORKER_ROLE_EXCLUSIONS[label] === true || configured.includes(label);
}
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

function defaultListReadyRows(repo: string, readyCommand?: string): ReadyRowsResult {
	if (!existsSync(repo)) return { rows: null, failure: "repo missing" };
	const argv = (readyCommand ?? "br ready --json").split(" ").filter((part) => part !== "");
	if (argv[0] !== "br" || argv[1] !== "ready") return { rows: null, failure: "readiness requires a native br ready command" };
	if (argv.includes("--no-db")) return { rows: null, failure: "JSONL-only output is not native claim-readiness authority" };
	if (!argv.includes("--no-auto-import")) argv.push("--no-auto-import");
	if (!argv.includes("--no-auto-flush")) argv.push("--no-auto-flush");
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
	if (row.labels.some((label) => NON_LEAF_LABEL.test(label) || excludedWorkerLabel(label, skipLabels))) return false;
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
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (recovery flags unreadable); nudges resume when probes answer.`,
			refusals: [{ class: "tool_read_failure", bead: null, actor: `UNKNOWN director for ${sessionName}`, next: "director restores a readable native write-readiness probe before any claim" }] };
	}
	if (recoveryKind === "RECOVERY_QUARANTINE_GROWTH" || (flags.length > 0 && recoveryKind !== "RECOVERY_PROCEEDED")) {
		const names = flags.length > 0 ? flags.map((flag) => basename(flag)).join(", ") : "quarantine artifacts";
		const reason = recoveryKind === "RECOVERY_QUARANTINE_GROWTH" ? "WAL_QUARANTINE_GROWTH; " : "";
		return { ready: false, kind: "WRITE_LATCHED", text: `Fleet watch (WRITE_LATCHED): no nudge for ${sessionName} workers while the tracker write path is latched (${names}); ${reason}recovery ${recoveryKind ?? "did not proceed"}; nudges resume when flags clear.`,
			refusals: [{ class: "unsafe_custody", bead: null, actor: `UNKNOWN director for ${sessionName}`, next: `director qualifies recovery and verifies that the native write latch clears: ${names}` }] };
	}
	return { ready: true };
}

function leafRefusal(row: ReadyRow, skipLabels: readonly string[], coordinator: string): PullRefusal | null {
	if (isClaimableLeaf(row, skipLabels)) return null;
	const custody = row.assignee !== null || row.status !== "open";
	return {
		class: custody ? "unsafe_custody" : "unsupported_native",
		bead: row.id,
		actor: row.assignee ?? coordinator,
		next: custody
			? `current holder or director resolves native custody and readiness for ${row.id}; do not take another actor's claim`
			: `director resolves ${row.id} (${row.labels.join(", ") || row.issue_type}); only an eligible product leaf belongs in the worker pull`,
	};
}

function noFreeLeafText(sessionName: string, rows: readonly ReadyRow[]): string {
	let open = 0;
	let held = 0;
	let epics = 0;
	for (const row of rows) {
		if (row.status !== "open") continue;
		open += 1;
		if (row.assignee !== null) held += 1;
		if (row.issue_type.toLowerCase() === "epic" || row.labels.some(label => NON_LEAF_LABEL.test(label))) epics += 1;
	}
	return `Fleet watch (NO_FREE_LEAF): no nudge for ${sessionName} workers: no claimable leaf (ready ${open}, held ${held}, epics ${epics}); nudges resume when a leaf frees.`;
}

function leafVerdict(sessionName: string, rows: ReadyRow[] | null, skipLabels: readonly string[], readyFailure: string | null = null, coordinator = `UNKNOWN director for ${sessionName}`): PreassignVerdict {
	if (rows === null) {
		const cause = readyFailure === null ? "ready rows unreadable" : `ready rows unreadable: ${readyFailure}`;
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (${cause}); nudges resume when probes answer.`,
			refusals: [{ class: "tool_read_failure", bead: null, actor: coordinator, next: `director repairs the native ready read; ${cause}` }] };
	}
	let claimable = false;
	let refusals: PullRefusal[] | undefined;
	for (const row of rows) {
		const refusal = leafRefusal(row, skipLabels, coordinator);
		if (refusal === null) claimable = true;
		else (refusals ??= []).push(refusal);
	}
	if (claimable) return refusals === undefined ? { ready: true } : { ready: true, refusals };
	return { ready: false, kind: "NO_FREE_LEAF", text: noFreeLeafText(sessionName, rows),
		refusals: refusals ?? [{ class: "unsafe_custody", bead: null, actor: coordinator, next: "director supplies an eligible native product leaf; absence of supply is not permission to take protected work" }] };
}
type FleetWatchPaneState = { checks?: number; lastDecision?: number; lastSteeringCount?: number; parked?: true };
type FleetWatchState = { version: 1; panes: Record<string, FleetWatchPaneState>; eventSeq?: number; pendingEmitFailures?: number; preassign?: Record<string, { kind: string; atMs: number }> };

function parseFleetWatchState(value: unknown): FleetWatchState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const state = value as { version?: unknown; panes?: unknown; eventSeq?: unknown; pendingEmitFailures?: unknown; preassign?: unknown };
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
	if (state.eventSeq !== undefined) {
		if (typeof state.eventSeq !== "number" || !Number.isSafeInteger(state.eventSeq) || state.eventSeq < 0) throw new Error("FLEET_WATCH_STATE_INVALID");
		parsed.eventSeq = state.eventSeq;
	}
	if (state.pendingEmitFailures !== undefined) {
		if (typeof state.pendingEmitFailures !== "number" || !Number.isSafeInteger(state.pendingEmitFailures) || state.pendingEmitFailures < 0) throw new Error("FLEET_WATCH_STATE_INVALID");
		parsed.pendingEmitFailures = state.pendingEmitFailures;
	}
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
	atomicReplaceBytes(resolve(path), Buffer.from(`${JSON.stringify(state)}\n`, "utf8"), { mode: 0o600, durability: "full" });
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
export type PullChoice = { ready: true; pick: PullPick; refusals?: readonly PullRefusal[] } | Extract<PreassignVerdict, { ready: false }>;

export type PullWorkerIdentity = { agent: string; binding: string | null };
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
	/** CC binding_id when known; Agent Mail's binding status is not a CC binding id. */
	resolveWorkerIdentity?: (repo: string, pane: string) => PullWorkerIdentity | null;
	/** Current blockers/owners from the same native namespace as readiness; never export authority. */
	readNativeState: (repo: string, ids: readonly string[], coordinator: string | null, readyCommand?: string) => NativePullState;

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

/** Parked workflow states are never review work, even when they can close (ompkit-rz5.102.1
 * FWDEFER1: jev deferred has a closed edge but is parked, not awaiting verification). */
const PARKED_STATUSES = ["deferred", "blocked"];

/** Statuses that hold work awaiting verification: reachable from in_progress, able to close, not ready work, never parked. */
export function reviewStatuses(policy: TrackerPolicy): string[] {
	return (policy.transitions.in_progress ?? []).filter((status) => status !== "closed" && !policy.ready.includes(status) && !PARKED_STATUSES.includes(status) && (policy.transitions[status] ?? []).includes("closed"));
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

export interface PullCoordinator {
	actor: string | null;
	session: string;
	pane: string;
}

export type NativePullState =
	| ({ ok: true } & NativePullFacts)
	| { ok: false; reason: string };

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
	/** Fresh native observations only; exported comments/edges are not decision or custody authority. */
	nativeState?: NativePullState | undefined;
	coordinator?: PullCoordinator;
	/** Director-facing work-coordination projection (jq88); absent: native rows stay the sole authority. */
	workProjection?: WorkProjectionInput | undefined;
	/** Observation clock for the projection above; required when it is present. */
	workProjectionNowMs?: number | undefined;
}

interface NativeDecisionReference {
	citation: string;
	closed: boolean;
}

interface NativeIssueFacts {
	nativeOwners: ReadonlyMap<string, string | null>;
	decisions: ReadonlyMap<string, NativeDecisionReference>;
}

export interface NativePullFacts extends NativeIssueFacts {
	blockers: ReadonlyMap<string, readonly string[]>;
}

function parseNativeBlockers(value: unknown): Map<string, readonly string[]> | undefined {
	if (typeof value !== "object" || value === null || !("issues" in value) || !Array.isArray(value.issues)) return undefined;
	const blockers = new Map<string, readonly string[]>();
	for (const row of value.issues) {
		if (typeof row !== "object" || row === null || Array.isArray(row) || !("id" in row) || typeof row.id !== "string" || !("blocked_by" in row)) return undefined;
		const ids = stringList(row.blocked_by);
		if (ids === null || ids.some(id => id === "")) return undefined;
		blockers.set(row.id, ids);
	}
	return blockers;
}

function parseNativeIssues(value: unknown, coordinator: string | null): NativeIssueFacts | undefined {
	if (!Array.isArray(value)) return undefined;
	const nativeOwners = new Map<string, string | null>();
	const decisions = new Map<string, NativeDecisionReference>();
	for (const row of value) {
		if (typeof row !== "object" || row === null || Array.isArray(row) || !("id" in row) || typeof row.id !== "string"
			|| !("status" in row) || typeof row.status !== "string" || nativeOwners.has(row.id)) return undefined;
		const owner = "assignee" in row ? row.assignee : null;
		if (owner !== null && typeof owner !== "string") return undefined;
		nativeOwners.set(row.id, owner);
		if (coordinator === null || !("comments" in row)) continue;
		if (!Array.isArray(row.comments)) return undefined;
		for (const comment of row.comments) {
			if (typeof comment !== "object" || comment === null || Array.isArray(comment)
				|| !("id" in comment) || typeof comment.id !== "number" || !Number.isInteger(comment.id) || comment.id <= 0
				|| !("author" in comment) || typeof comment.author !== "string"
				|| !("text" in comment) || typeof comment.text !== "string") return undefined;
			if (comment.author !== coordinator || !comment.text.startsWith("DECISION:")) continue;
			// A native reference, not generic DONE/PASS and not permission to execute.
			decisions.set(row.id, { citation: `comment ${comment.id} by ${coordinator}`, closed: row.status === "closed" });
		}
	}
	return { nativeOwners, decisions };
}

function triageRefusals(input: PullInput, coordinator: string, facts: NativePullFacts | undefined) {
	if (!input.triage.usable) return undefined;
	const observedOrExplained = new Set<string>();
	for (const row of input.readyRows ?? []) observedOrExplained.add(row.id);
	const state = input.nativeState;
	let refusals: PullRefusal[] | undefined;
	for (const id of input.triage.ids) {
		if (observedOrExplained.has(id) || input.taken.has(id)) continue;
		observedOrExplained.add(id);
		const blockedBy = facts?.blockers.get(id);
		if (blockedBy !== undefined && blockedBy.length > 0) {
			for (const blocker of blockedBy) {
				const owner = facts?.nativeOwners.get(blocker);
				(refusals ??= []).push({
					class: "tool_read_failure",
					bead: id,
					actor: typeof owner === "string" && owner !== "" ? owner : coordinator,
					next: `stale export: native prerequisite ${blocker} must satisfy its original acceptance and receive a non-author close; then reread native ready for ${id}${typeof owner === "string" && owner !== "" ? "" : "; blocker owner UNKNOWN, director resolves the native controller"}`,
				});
			}
			continue;
		}
		const owner = facts?.nativeOwners.get(id);
		const why = input.readyRows === null ? "native ready UNKNOWN"
			: state === undefined ? "native explanation UNKNOWN"
				: !state.ok ? state.reason : "native ready does not include this exported candidate";
		(refusals ??= []).push({
			class: "tool_read_failure",
			bead: id,
			actor: typeof owner === "string" && owner !== "" ? owner : coordinator,
			next: `verify native readiness of ${id}, not its export rank (${why}); keep unrelated eligible product work moving`,
		});
	}
	return refusals;
}

function selectedPull(pick: PullPick, refusals: readonly PullRefusal[] | undefined): PullChoice {
	if (refusals === undefined) return { ready: true, pick };
	return { ready: true, pick, refusals };
}

/** Interpret current supply/evidence without choosing or awarding a task. */
function workerSupplyVerdict(input: PullInput, rows: ReadyRow[] | null): PreassignVerdict {
	const coordinator = input.coordinator?.actor ?? `UNKNOWN director for ${input.sessionName}${input.coordinator ? ` (${input.coordinator.session}:${input.coordinator.pane})` : ""}`;
	const facts = input.nativeState?.ok ? input.nativeState : undefined;
	const verdict = leafVerdict(input.sessionName, rows, input.skipLabels, input.readyFailure ?? null, coordinator);
	// jq88: a stale/unavailable work-coordination projection is UNKNOWN, never an empty queue.
	// Fresh native rows below stay the dispatch authority; the projection only withholds.
	if (input.workProjection !== undefined && input.workProjectionNowMs !== undefined) {
		const projection = classifyWorkProjection(input.workProjection, new Date(input.workProjectionNowMs));
		if (projection.kind === "STALE" || projection.kind === "UNAVAILABLE") {
			return { ready: false, kind: "UNKNOWN",
				text: `Fleet watch (UNKNOWN): no nudge for ${input.sessionName} workers: work-coordination projection ${projection.kind} (${projection.warning}); reread fresh native br ready before dispatch, never dispatch from the empty projection.`,
				refusals: [{ class: "tool_read_failure", bead: null, actor: coordinator,
					next: `director rereads fresh native br ready for ${input.sessionName}; ${projection.warning}` }] };
		}
	}
	const stale = triageRefusals(input, coordinator, facts);
	let refusals = verdict.refusals;
	if (stale !== undefined) {
		const emptyFrontier = !verdict.ready && rows?.length === 0;
		refusals = refusals === undefined || emptyFrontier ? stale : [...stale, ...refusals];
	}
	let unknownAuthors: PullRefusal[] | undefined;
	for (const item of input.grading) {
		if (item.author !== null || input.taken.has(item.id)) continue;
		(unknownAuthors ??= []).push({
			class: "unsafe_custody", bead: item.id, actor: coordinator,
			next: `director resolves the actual implementer of ${item.id} before assigning an independent non-author verifier`,
		});
	}
	if (unknownAuthors !== undefined) refusals = refusals === undefined ? unknownAuthors : [...refusals, ...unknownAuthors];
	for (const refusal of refusals ?? []) {
		if (refusal.bead === null) continue;
		const decision = facts?.decisions.get(refusal.bead);
		if (decision === undefined) continue;
		refusal.citation = decision.citation;
		if (refusal.class === "unsupported_native") {
			refusal.actor = coordinator;
			refusal.next = `director checks the current scope and applicability of ${decision.citation} for ${refusal.bead}; a later question is not new permission or a reason to reopen a resolved decision`;
		}
	}
	if (refusals !== undefined) verdict.refusals = refusals;
	return verdict;
}

export function choosePull(input: PullInput): PullChoice {
	const grade = input.worker === null ? undefined : input.grading.find((item) => item.author !== null && item.author !== input.worker && !input.taken.has(item.id) && !item.labels.some((label) => excludedWorkerLabel(label, input.skipLabels)));
	if (grade !== undefined) {
		const rework = (input.policy.transitions[grade.status] ?? []).includes(REWORK_LABEL) ? "set status rework" : `set status open, add label ${REWORK_LABEL}`;
		return { ready: true, pick: { kind: "GRADE", id: grade.id, via: grade.via, author: grade.author, rework } };
	}
	// A rework item waits for its implementer while that implementer holds a live seat here.
	const rework = input.rework.find((item) => !input.taken.has(item.id) && !item.labels.some((label) => excludedWorkerLabel(label, input.skipLabels))
		&& (item.implementer === null || item.implementer === input.worker || !input.liveWorkers.has(item.implementer)));
	if (rework !== undefined) return { ready: true, pick: { kind: "REWORK", id: rework.id, implementer: rework.implementer } };
	const queued = new Set([...input.grading.map((item) => item.id), ...input.rework.map((item) => item.id)]);
	const rows = input.readyRows?.filter((row) => !input.taken.has(row.id) && !queued.has(row.id)) ?? null;
	const leaves = workerSupplyVerdict(input, rows);
	if (!leaves.ready) return leaves;
	const refusals = leaves.refusals;
	const leafRows = rows!.filter((row) => isClaimableLeaf(row, input.skipLabels));
	const leafIds = new Set(leafRows.map((row) => row.id));
	const parents = input.issues === null ? null : new Map(input.issues.map((issue) => [issue.id, issue.parents]));
	const focusOn = input.focus.length > 0 && parents !== null;
	const focus = input.focus.length ? ` under focus ${input.focus.join(", ")}` : "";
	if (input.triage.usable && (input.focus.length === 0 || parents !== null)) {
		for (const [index, id] of input.triage.ids.entries()) {
			if (!leafIds.has(id)) continue;
			const epic = focusOn ? focusEpicOf(id, parents!, input.focus) : null;
			if (!focusOn || epic !== null) return selectedPull({ kind: "TRIAGE", id, rank: index + 1, epic }, refusals);
		}
		// FWFOCUS1 (ompkit-fp72.28): bv's top-N can hold no focus leaf while br ready does; take the first such leaf.
		const fallback = focusOn ? leafRows.find((row) => focusEpicOf(row.id, parents!, input.focus) !== null) : leafRows[0];
		if (fallback !== undefined)
			return selectedPull({ kind: "READY", id: fallback.id, reason: `bv top-${input.triage.ids.length} has no ${focusOn ? "focus" : "eligible native"} leaf`, epic: focusOn ? focusEpicOf(fallback.id, parents!, input.focus) : null }, refusals);
		return { ready: false, kind: "NO_TRIAGE_PICK", text: `Fleet watch (NO_TRIAGE_PICK): ${input.sessionName} workers parked: nothing to grade or rework, and none of the ${input.triage.ids.length} bv --robot-triage recommendations is a claimable br ready leaf${focus}; set focus or unblock. Seats wake when an item becomes eligible.`,
			refusals: refusals ?? [{ class: "tool_read_failure", bead: null, actor: input.coordinator?.actor ?? `UNKNOWN director for ${input.sessionName}`, next: "director reconciles the exported triage with native ready eligibility and the selected focus" }] };
	}
	const reason = input.triage.usable ? "DAG unreadable (.beads/issues.jsonl)" : `bv unusable: ${input.triage.reason}`;
	for (const row of leafRows) {
		const epic = focusOn ? focusEpicOf(row.id, parents!, input.focus) : null;
		if (!focusOn || epic !== null) return selectedPull({ kind: "READY", id: row.id, reason, epic }, refusals);
	}
	return { ready: false, kind: "NO_FREE_LEAF", text: `Fleet watch (NO_FREE_LEAF): ${input.sessionName} workers parked: nothing to grade or rework and no claimable br ready leaf${focus} (${reason}). Seats wake when an item becomes eligible.`,
		refusals: refusals ?? [{ class: "unsafe_custody", bead: null, actor: input.coordinator?.actor ?? `UNKNOWN director for ${input.sessionName}`, next: "director resolves the selected focus and supplies a native eligible product leaf" }] };
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
	private eventSeq = 0;
	private pendingEmitFailures = 0;
	constructor(private readonly config: FleetWatchConfig, private readonly now: () => number = Date.now, state?: FleetWatchState) {
		this.eventSeq = state?.eventSeq ?? 0;
		this.pendingEmitFailures = state?.pendingEmitFailures ?? 0;
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
	nextEventSequence(): number | null {
		if (this.eventSeq === Number.MAX_SAFE_INTEGER) return null;
		this.eventSeq += 1;
		return this.eventSeq;
	}
	takePendingEmitFailures(): number {
		const pending = this.pendingEmitFailures;
		this.pendingEmitFailures = 0;
		return pending;
	}
	addPendingEmitFailures(count: number): void {
		if (Number.isSafeInteger(count) && count > 0) this.pendingEmitFailures = Math.min(Number.MAX_SAFE_INTEGER, this.pendingEmitFailures + count);
	}
	snapshot(): FleetWatchState {
		const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
		for (const [key, checks] of this.checks) if (checks > 0) (panes[key] ??= {}).checks = checks;
		for (const [key, lastDecision] of this.lastDecision) (panes[key] ??= {}).lastDecision = lastDecision;
		for (const [key, lastSteeringCount] of this.lastSteeringCount) (panes[key] ??= {}).lastSteeringCount = lastSteeringCount;
		for (const key of this.parked) (panes[key] ??= {}).parked = true;
		const state: FleetWatchState = { version: 1, panes };
		if (this.eventSeq > 0) state.eventSeq = this.eventSeq;
		if (this.pendingEmitFailures > 0) state.pendingEmitFailures = this.pendingEmitFailures;
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
	/** Claim an admitted escalation once per persisted episode. */
	claimStrandedEpisode(key: string): boolean {
		return this.settlePreassignReport(`stranded:${key}`, "STRANDED_ESCALATED");
	}
	/** A clean audit ends every previously reported episode for this repo. */
	clearStrandedRepo(repo: string): boolean {
		const prefix = `stranded:${repo}\0`;
		let cleared = false;
		for (const key of this.preassignReports.keys()) {
			if (key.startsWith(prefix)) {
				this.preassignReports.delete(key);
				cleared = true;
			}
		}
		return cleared;
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
	const registeredTrackers = parseRegisteredTrackers((value as Record<string, unknown>).registeredTrackers);
	return { enabled: (value as Record<string, unknown>).enabled !== false, intervalSeconds: Number((value as Record<string, unknown>).intervalSeconds ?? 120), noDecisionChecks: Number((value as Record<string, unknown>).noDecisionChecks ?? 5), sessions, ...(registeredTrackers === undefined ? {} : { registeredTrackers }) };
}

/**
 * ompkit-ps3lo: optional MP6-registry seam. Undefined when absent (legacy
 * sessions-only coverage); otherwise every entry names a non-empty repo and
 * its owning-director session. Anything else is a config error.
 */
function parseRegisteredTrackers(value: unknown): FleetWatchRegisteredTracker[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("FLEET_WATCH_CONFIG_INVALID: registeredTrackers");
	return value.map((entry, index) => {
		const invalid = new Error(`FLEET_WATCH_CONFIG_INVALID: registeredTrackers[${index}]`);
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid;
		const { repo, session } = entry as Record<string, unknown>;
		if (typeof repo !== "string" || repo.trim() === "" || typeof session !== "string" || session.trim() === "") throw invalid;
		return { repo, session };
	});
}

function readNativePullState(repo: string, ids: readonly string[], coordinator: string | null, readyCommand?: string): NativePullState {
	if (!existsSync(repo)) return { ok: false, reason: "native inspection repo missing" };
	const namespace: string[] = [];
	const tokens = (readyCommand ?? "br ready --json").split(" ").filter(token => token !== "");
	for (let index = 2; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--no-db") return { ok: false, reason: "JSONL-only output cannot explain native claim eligibility" };
		if (token === "--db") {
			const path = tokens[++index];
			if (path === undefined || path === "") return { ok: false, reason: "native inspection database scope missing" };
			namespace.push("--db", path);
		} else if (token.startsWith("--db=")) namespace.push("--db", token.slice(5));
	}
	const readFlags = ["--json", "--no-auto-import", "--no-auto-flush", ...namespace];
	const blocked = runJson(["br", "blocked", "--limit", "0", ...readFlags], repo);
	if (!blocked.ok) return { ok: false, reason: `br blocked: ${describeRunFailure(blocked.failure)}` };
	const blockers = parseNativeBlockers(blocked.value);
	if (blockers === undefined) return { ok: false, reason: "br blocked returned an unqualified native shape" };
	const wanted = new Set(ids);
	for (const id of ids) for (const blocker of blockers.get(id) ?? []) {
		// Preserve typed external dependencies without pretending they are local issues.
		if (!blocker.startsWith("external:")) wanted.add(blocker);
	}
	if (wanted.size === 0) return { ok: true, blockers, nativeOwners: new Map(), decisions: new Map() };
	const observed = runJson(["br", "show", ...readFlags, "--", ...wanted], repo);
	if (!observed.ok) return { ok: false, reason: `br show native subjects: ${describeRunFailure(observed.failure)}` };
	const issues = parseNativeIssues(observed.value, coordinator);
	if (issues === undefined) return { ok: false, reason: "br show returned an unqualified native issue/owner shape" };
	for (const id of wanted) {
		if (!issues.nativeOwners.has(id)) return { ok: false, reason: `br show omitted native subject ${id}` };
	}
	return { ok: true, blockers, ...issues };
}

function resolvePullWorkerIdentity(repo: string, pane: string): PullWorkerIdentity | null {
	if (pane.trim() === "") return null;
	const outcome = runJson(["am", "agents", "resolve-pane", "--project", repo, "--pane", pane, "--json"], undefined);
	if (!outcome.ok || !outcome.value || typeof outcome.value !== "object" || Array.isArray(outcome.value)) return null;
	const row = outcome.value as Record<string, unknown>;
	const agent = row.agent_name;
	if (typeof agent !== "string" || agent === "") return null;
	return { agent, binding: null };
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
		const child = spawnSync("bv", ["--robot-triage", "--db", join(repo, ".beads", "issues.jsonl")], { cwd: repo, encoding: "utf8", timeout: READY_TIMEOUT_MS, maxBuffer: READY_MAX_BUFFER });
		if (child.error) return { usable: false, reason: `bv --robot-triage did not run (${child.error.message}; status ${String(child.status)}, signal ${String(child.signal)}, ${elapsed()} ms)` };
		if (child.status !== 0) return { usable: false, reason: `bv --robot-triage exited ${child.status} (signal ${String(child.signal)}, ${elapsed()} ms)${child.stderr ? `: ${child.stderr.split("\n", 1)[0]!.slice(0, FAILURE_DETAIL_CHARS)}` : ""}` };
		try { return parseTriage(JSON.parse(child.stdout)); } catch { return { usable: false, reason: `bv --robot-triage printed non-JSON (status ${String(child.status)}, ${elapsed()} ms)` }; }
	},
	readNativeState: readNativePullState,
	resolveWorkerIdentity: resolvePullWorkerIdentity,
	resolveWorker: (repo, pane) => resolvePullWorkerIdentity(repo, pane)?.agent ?? null,
};

export type FleetWatchOnceDeps = {
	capture: (session: string, pane: string) => FleetWatchCapture;
	send: (session: string, pane: string, text: string) => void;
	sendKeys: (session: string, pane: string, keys: readonly string[]) => void;
	logPath: string;
	statePath?: string | null;
	now?: () => number;
	recoverTracker?: (repo: string, session: string) => TrackerRecoveryResult | null;
	/** Retire the incumbent only with successor evidence and a configured registry recovery path. */
	recoveryCutover?: ((repo: string) => TrackerRecoveryCutoverInput | null) | null;
	/**
	 * ompkit-rhy9.15 RET1: bounded quarantine retention per repo per tick.
	 * Absent, the canonical retainTrackerQuarantine runs (silent unless it
	 * reaps); null disables retention for the tick.
	 */
	retainTracker?: ((repo: string) => TrackerRetentionOutcome | null) | null;
	/**
	 * GITLOCK1 (ompkit-fp72.19.1.9): reap stale empty git locks once per repo per tick through every
	 * gate in src/index-lock.ts (empty, age, lsof file and git-cwd clear, identity). Absent, the
	 * canonical reapRepoGitLocks runs with the kit's bounded runner, the default 120 s age and the
	 * kit's lock ledger; each field overrides one of those; null disables the phase.
	 */
	gitLockReap?: { run?: ScratchRunner; ledgerPath?: string; staleAfterMs?: number } | null;
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
	/** Optional command-center spool state; inert when absent or no fleet state exists. */
	ccStateDir?: string;
	ccProducer?: string;
	/** ompkit-364w pull probes (policy, review/rework rows, issues.jsonl, bv triage, seat identity). Absent, the native defaults run. */
	pullProbes?: PullProbes;
	/** Latest work-doctor rows; reuse its reservation and uncommitted ages. */
	workAudit?: { repos: readonly WorkRepoReport[] } | null;
};

function admittedEffect(admission: AdmissionInput | undefined, action: string): boolean {
	if (admission === undefined) return true;
	return admitActuator({ ...admission, packet: { ...admission.packet, action } }).verdict !== "REFUSE";
}
/** Query only native subjects that ranking or worker policy could not admit. */
function nativeInspectionTargets(rows: readonly ReadyRow[] | null, triage: TriageResult, skipLabels: readonly string[]): string[] {
	const targets = new Set<string>();
	const nativeReady = new Set<string>();
	for (const row of rows ?? []) {
		nativeReady.add(row.id);
		if (!isClaimableLeaf(row, skipLabels)) targets.add(row.id);
	}
	if (triage.usable) for (const id of triage.ids) if (!nativeReady.has(id)) targets.add(id);
	return [...targets];
}

type PullAttemptRecorder = (session: string, repo: string, pane: string, outcome: string, refusalClass: string | null, pickedBead: string | null, atMs: number) => void;
type AdmissionRefusalRecord = { session: string; pane: string; checks?: number; repo?: string; text: string };
function recordAdmissionRefusal(
	deps: FleetWatchOnceDeps,
	recordAttempt: PullAttemptRecorder | undefined,
	identityRepo: string,
	record: AdmissionRefusalRecord,
	pickedBead: string | null = null,
): void {
	const atMs = (deps.now ?? Date.now)();
	appendFileSync(deps.logPath, JSON.stringify({ at: new Date(atMs).toISOString(), kind: "ADMISSION_REFUSED", ...record }) + "\n");
	recordAttempt?.(record.session, identityRepo, record.pane, "ADMISSION_REFUSED", "ADMISSION_REFUSED", pickedBead, atMs);
}
/** Persist a routing observation and attempt its admitted pointer; never claim delivery. */
function recordPullNotice(
	session: FleetWatchSession, action: FleetWatchPaneAction, choice: PullChoice,
	deps: FleetWatchOnceDeps, watcher: FleetWatcher, actions: FleetWatchAction[],
	recordAttempt?: PullAttemptRecorder,
): boolean {
	const refusals = choice.refusals;
	const episode = refusals === undefined || refusals.length === 0 ? null : JSON.stringify(refusals);
	if (!watcher.settlePreassignReport(session.session, episode)) return false;
	if (refusals === undefined || refusals.length === 0) {
		appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "PREASSIGN_CLEARED", session: session.session, pane: action.pane, checks: action.checks, text: `pre-assignment clear for ${session.session}; nudges resume` }) + "\n");
		return true;
	}
	const notice: FleetWatchPullAction = {
		kind: choice.ready ? "PULL_WARNINGS" : choice.kind,
		session: session.session, pane: action.pane, checks: action.checks,
		text: choice.ready ? `Fleet watch: withheld native candidates for ${session.session}; eligible work continues.` : choice.text,
		refusals,
	};
	const noticeAtMs = (deps.now ?? Date.now)();
	appendFileSync(deps.logPath, JSON.stringify({ at: new Date(noticeAtMs).toISOString(), ...notice }) + "\n");
	actions.push(notice);
	if (!choice.ready) recordAttempt?.(session.session, session.repo, action.pane, choice.kind, choice.kind, null, noticeAtMs);
	if (!admittedEffect(deps.admission, "send")) {
		recordAdmissionRefusal(deps, recordAttempt, session.repo, { session: session.session, pane: action.pane, text: "admission refused coordinator notice; no notice was sent" });
		return true;
	}
	try {
		deps.send(session.coordinatorSession, session.coordinatorPane, `${notice.text} Read ${refusals.length} structured refusal(s) in ${deps.logPath}.`);
	} catch (error) {
		appendFileSync(deps.logPath, JSON.stringify({
			at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "NOTICE_UNPROVEN", session: session.session, pane: action.pane,
			text: "coordinator notice raised; delivery UNKNOWN; no automatic resend and eligible work continues",
			cause: error instanceof Error ? error.name : "non-error",
		}) + "\n");
	}
	return true;
}

/** Route the work audit as one tick phase; return whether persisted episodes changed. */
function recordStrandedAudit(config: FleetWatchConfig, deps: FleetWatchOnceDeps, activeWatcher: FleetWatcher, actions: FleetWatchAction[], recordAttempt?: PullAttemptRecorder): boolean {
	let stateDirty = false;
	// ompkit-rhy9.24: route aged owned work through the configured director,
	// never infer ownership from dirty files or choose an unrelated queue.
	if (deps.workAudit) {
		const owners = new Map<string, FleetWatchSession>();
		for (const session of config.sessions) if (!owners.has(session.repo)) owners.set(session.repo, session);
		for (const tracker of config.registeredTrackers ?? []) {
			if (owners.has(tracker.repo)) continue;
			const owner = config.sessions.find((session) => session.session === tracker.session);
			if (owner) owners.set(tracker.repo, owner);
		}
		const audited = new Set<string>();
		const stamp = () => new Date((deps.now ?? Date.now)()).toISOString();
		for (const row of deps.workAudit.repos) {
			if (audited.has(row.path)) continue;
			audited.add(row.path);
			const overLimit = (row.stale_uncommitted_edits ?? []).filter((edit) => edit.age_minutes > STRANDED_ESCALATION_LIMIT_MINUTES);
			const owner = owners.get(row.path);
			if (!row.stranded || overLimit.length === 0) {
				if (activeWatcher.clearStrandedRepo(row.path)) {
					stateDirty = true;
					appendFileSync(deps.logPath, JSON.stringify({ at: stamp(), kind: "STRANDED_CLEARED", session: owner?.session ?? "UNKNOWN", pane: "director", checks: 0, repo: row.path, text: `stranded finding cleared for ${row.path}; the next over-limit audit escalates again` }) + "\n");
				}
				continue;
			}
			if (!owner) {
				const text = `Fleet watch STRANDED_UNRESOLVED: ${row.path} is stranded over the ${STRANDED_ESCALATION_LIMIT_MINUTES}min limit (${overLimit.map((edit) => `${edit.path} ${edit.age_minutes}min`).join(", ")}) but names no configured session; no director was notified. Configure the repo under a session or registeredTracker.`;
				const action: FleetWatchStrandedAction = { kind: "STRANDED_UNRESOLVED", session: "UNKNOWN", pane: "director", checks: 0, text, repo: row.path };
				appendFileSync(deps.logPath, JSON.stringify({ at: stamp(), ...action }) + "\n");
				actions.push(action);
				continue;
			}
			for (const edit of overLimit) {
				if (!admittedEffect(deps.admission, "send")) {
					recordAdmissionRefusal(deps, recordAttempt, owner.repo, { session: owner.coordinatorSession, pane: owner.coordinatorPane, checks: 0, repo: row.path, text: "admission refused stranded escalation; nothing was sent" });
					continue;
				}
				if (!activeWatcher.claimStrandedEpisode(`${row.path}\0${edit.bead}\0${edit.path}`)) continue;
				stateDirty = true;
				const text = `Fleet watch STRANDED_ESCALATED to ${owner.coordinatorSession}: ${row.path} stranded ${edit.age_minutes}min over the ${STRANDED_ESCALATION_LIMIT_MINUTES}min limit; holder ${edit.agent_name} owns ${edit.path_pattern} (${edit.path}, bead ${edit.bead}). Save-sweep remediation: run the save sweep (planRepoSweep) for the held paths, commit releasable work and push; the finding clears on the next clean audit.`;
				const action: FleetWatchStrandedAction = { kind: "STRANDED_ESCALATED", session: owner.coordinatorSession, pane: owner.coordinatorPane, checks: 0, text, repo: row.path };
				deps.send(owner.coordinatorSession, owner.coordinatorPane, text);
				appendFileSync(deps.logPath, JSON.stringify({ at: stamp(), ...action }) + "\n");
				actions.push(action);
			}
		}
	}
	return stateDirty;
}
function watcherSpool(deps: FleetWatchOnceDeps, now: () => number): CcSpool | null {
	try {
		return ccSpool(deps.ccProducer ?? "watcher", { stateDir: deps.ccStateDir, clock: now });
	} catch {
		return null;
	}
}

function emitWatcherEnvelope(
	spool: CcSpool | null, type: string, data: Record<string, unknown>, key: string, timeMs: number,
	ctx?: Record<string, unknown>,
): number {
	if (!spool) return 0;
	try {
		const env = spool.envelope(type, data, { key, timeMs, observedMs: timeMs, ctx });
		return spool.append([env]) === 1 ? 1 : 0;
	} catch {
		spool.failures += 1;
		return 0;
	}
}
class WatcherEventRecorder {
	private recordsSeen = 0;
	private recordsEmitted = 0;
	private recordsQuarantined = 0;
	private readonly outcomeCounts = new Map<string, number>();
	private dirty = false;

	constructor(
		private readonly spool: CcSpool | null,
		private readonly watcher: FleetWatcher,
		private readonly now: () => number,
		private readonly identityFor: (repo: string, pane: string) => PullWorkerIdentity | null,
	) {
		if (!spool) return;
		const pending = watcher.takePendingEmitFailures();
		this.recordsSeen = pending;
		this.recordsQuarantined = pending;
		this.dirty = pending > 0;
	}

	readonly recordAttempt: PullAttemptRecorder = (sessionName, repo, pane, outcome, refusalClass, pickedBead, atMs) => {
		const spool = this.spool;
		if (!spool) return;
		this.recordsSeen += 1;
		const sequence = this.watcher.nextEventSequence();
		const eventTime = atMs;
		const identity = this.identityFor(repo, pane);
		const emitted = sequence === null ? 0 : emitWatcherEnvelope(spool, "pull.attempt", {
			outcome,
			refusal_class: refusalClass,
			picked_bead: pickedBead,
		}, `fw:${pane}:${eventTime}:${sequence}`, eventTime, {
			seat: `${sessionName}/${pane}`,
			binding: identity?.binding ?? null,
			agent: identity?.agent ?? null,
			session: sessionName,
		});
		if (emitted === 1) {
			this.recordsEmitted += 1;
			this.outcomeCounts.set(outcome, (this.outcomeCounts.get(outcome) ?? 0) + 1);
		} else {
			this.recordsQuarantined += 1;
		}
	};

	finish(): boolean {
		const spool = this.spool;
		if (!spool) return false;
		const tickAt = this.now();
		const tickSequence = this.watcher.nextEventSequence();
		this.dirty = true;
		const coverage: Array<Record<string, unknown>> = [...this.outcomeCounts].map(([outcome, count]) => ({
			record_type: `record:${outcome}`,
			runtime_version: "1",
			disposition: "emitted",
			reason: null,
			count,
		}));
		if (this.recordsQuarantined > 0) coverage.push({
			record_type: "record:emit_failed",
			runtime_version: "1",
			disposition: "unknown",
			reason: "SPOOL_APPEND_FAILED",
			count: this.recordsQuarantined,
		});
		const tick = tickSequence === null ? 0 : emitWatcherEnvelope(spool, "source.tick", {
			instance: "fleet-watch",
			records_seen: this.recordsSeen,
			records_emitted: this.recordsEmitted,
			records_ignored: 0,
			records_quarantined: this.recordsQuarantined,
			complete_through_ms: tickAt,
			position: tickSequence,
			event_count: this.recordsEmitted,
			coverage,
		}, `fw:tick:${tickAt}:${tickSequence}`, tickAt);
		if (tick === 0) this.watcher.addPendingEmitFailures(this.recordsQuarantined + 1);
		return this.dirty;
	}
}



export function runFleetWatchOnce(config: FleetWatchConfig, deps: FleetWatchOnceDeps, watcher?: FleetWatcher): FleetWatchAction[] {
	if (!config.enabled) return [];
	const now = deps.now ?? Date.now;
	const spool = watcherSpool(deps, now);
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
	const rowsCache = new Map<string, ReadyRowsResult>();
	const policyCache = new Map<string, TrackerPolicy | null>();
	const statusCache = new Map<string, ReadyRow[] | null>();
	const issuesCache = new Map<string, TrackerIssue[] | null>();
	const triageCache = new Map<string, TriageResult>();
	const seatCache = new Map<string, PullWorkerIdentity | null>();
	const nativeStateCache = new Map<string, NativePullState>();
	const takenBySession = new Map<string, Set<string>>();
	function cached<T>(cache: Map<string, T>, key: string, load: () => T): T {
		if (!cache.has(key)) cache.set(key, load());
		return cache.get(key) as T;
	}
	const identityFor = (repo: string, pane: string): PullWorkerIdentity | null =>
		cached(seatCache, `${repo}\0${pane}`, () => {
			if (pull.resolveWorkerIdentity !== undefined) return pull.resolveWorkerIdentity(repo, pane);
			const agent = pull.resolveWorker(repo, pane);
			return agent === null ? null : { agent, binding: null };
		});
	const eventRecorder = new WatcherEventRecorder(spool, activeWatcher, now, identityFor);
	const seat = (session: FleetWatchSession, pane: string): string | null => identityFor(session.repo, pane)?.agent ?? null;
	const recoverTracker = deps.recoverTracker ?? ((repo: string, session: string) =>
		recoverBusyTracker(repo, session, { postRecoverReadback: defaultPostRecoverReadback }));
	const configuredRecoverySessions = new Set(config.sessions.map((session) => session.session));
	const cutoverRepos = new Set<string>();
	for (const session of config.sessions) {
		if (recoveredRepos.has(session.repo)) continue;
		if (cutoverRepos.has(session.repo)) continue;
		const evidence = deps.recoveryCutover?.(session.repo);
		const registered = config.registeredTrackers?.some((tracker) =>
			tracker.repo === session.repo && configuredRecoverySessions.has(tracker.session)) ?? false;
		if (evidence && registered && checkTrackerRecoveryCutover(evidence).retired) {
			cutoverRepos.add(session.repo);
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "TRACKER_RECOVERY_CUTOVER", session: session.session, pane: "tracker", checks: 0, repo: session.repo, text: `successor kit owns tracker recovery for ${session.repo}; duplicated project recovery branch retired` }) + "\n");
			continue;
		}
		recoveredRepos.add(session.repo);
		if (!admittedEffect(deps.admission, "tracker-recovery")) {
			recordAdmissionRefusal(deps, eventRecorder.recordAttempt, session.repo, { session: session.session, pane: "tracker", checks: 0, text: "admission refused tracker recovery; no recovery ran" });
			recoveryKinds.set(session.repo, null);
			continue;
		}
		const recovery = recoverTracker(session.repo, session.session);
		recoveryKinds.set(session.repo, recovery?.kind ?? null);
		if (!recovery) continue;
		const action: FleetWatchRecoveryAction = { kind: recovery.kind, session: session.session, pane: "tracker", checks: 0, text: recovery.text, ...(recovery.receipt === undefined ? {} : { receipt: recovery.receipt }), repo: session.repo };
		appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
		actions.push(action);
	}
	// ompkit-ps3lo: MP6-registered trackers are covered even without a
	// session entry. Recovery still needs its owning director: a registered
	// session no configured session names is covered exactly once with a
	// named NO_OWNING_DIRECTOR block and zero recover commands.
	const configuredSessions = new Set(config.sessions.map((session) => session.session));
	for (const tracker of config.registeredTrackers ?? []) {
		if (recoveredRepos.has(tracker.repo)) continue;
		if (!configuredSessions.has(tracker.session)) {
			recoveredRepos.add(tracker.repo);
			const text = `Fleet Watch: tracker recovery blocked; NO_OWNING_DIRECTOR: registered tracker ${tracker.repo} names session ${tracker.session}, which is not a configured session; zero recover commands ran.`;
			const blockedAction: FleetWatchRecoveryAction = { kind: "RECOVERY_BLOCKED", session: tracker.session, pane: "tracker", checks: 0, text, repo: tracker.repo };
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...blockedAction }) + "\n");
			actions.push(blockedAction);
			continue;
		}
		recoveredRepos.add(tracker.repo);
		if (!admittedEffect(deps.admission, "tracker-recovery")) {
			recordAdmissionRefusal(deps, eventRecorder.recordAttempt, tracker.repo, { session: tracker.session, pane: "tracker", checks: 0, repo: tracker.repo, text: "admission refused tracker recovery; no recovery ran" });
			recoveryKinds.set(tracker.repo, null);
			continue;
		}
		const registeredRecovery = recoverTracker(tracker.repo, tracker.session);
		recoveryKinds.set(tracker.repo, registeredRecovery?.kind ?? null);
		if (!registeredRecovery) continue;
		const registeredAction: FleetWatchRecoveryAction = { kind: registeredRecovery.kind, session: tracker.session, pane: "tracker", checks: 0, text: registeredRecovery.text, ...(registeredRecovery.receipt === undefined ? {} : { receipt: registeredRecovery.receipt }), repo: tracker.repo };
		appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...registeredAction }) + "\n");
		actions.push(registeredAction);
	}
	// ompkit-rhy9.15 RET1: one bounded retention pass per unique repo per
	// tick, after recovery. The canonical operation is silent (null) unless
	// it reaps, so healthy ticks log nothing new. Admission gates the pass
	// like every other tracker effect; a refusal performs zero effects.
	const retentionRepos = new Map<string, string>();
	for (const session of config.sessions) if (!retentionRepos.has(session.repo)) retentionRepos.set(session.repo, session.session);
	for (const tracker of config.registeredTrackers ?? []) if (!retentionRepos.has(tracker.repo)) retentionRepos.set(tracker.repo, tracker.session);
	const retainOne = deps.retainTracker === null ? null : (deps.retainTracker ?? ((target: string) => retainTrackerQuarantine(target, { now: deps.now })));
	if (retainOne !== null) {
		for (const [repo, sessionName] of retentionRepos) {
			if (!admittedEffect(deps.admission, "tracker-quarantine-retention")) {
				recordAdmissionRefusal(deps, eventRecorder.recordAttempt, repo, { session: sessionName, pane: "tracker", checks: 0, repo, text: "admission refused tracker quarantine retention; no artifact was moved" });
				continue;
			}
			const retention = retainOne(repo);
			if (!retention) continue;
			const action: FleetWatchRetentionAction = { kind: "TRACKER_QUARANTINE_RETENTION", session: sessionName, pane: "tracker", checks: 0, text: retention.text, receipt: retention.receipt, repo };
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
			actions.push(action);
		}
	}
	// GITLOCK1 (ompkit-fp72.19.1.9): one gated reap pass per unique repo per tick, after retention.
	// Silent unless a lock is renamed aside; HELD, TOO_YOUNG, NON_EMPTY and UNKNOWN leave it in place.
	const reapOptions = deps.gitLockReap;
	if (reapOptions !== null) {
		const ledger = reapOptions?.ledgerPath ?? defaultGitLockLedgerPath(homedir());
		const reapOne = (target: string): RepoReapResult[] => reapRepoGitLocks(target, {
			run: reapOptions?.run ?? defaultRunner, nowMs: deps.now, staleAfterMs: reapOptions?.staleAfterMs,
		});
		for (const [repo, sessionName] of retentionRepos) {
			if (!admittedEffect(deps.admission, "git-lock-reap")) {
				recordAdmissionRefusal(deps, eventRecorder.recordAttempt, repo, { session: sessionName, pane: "git", checks: 0, repo, text: "admission refused the git lock reap; no lock was moved" });
				continue;
			}
			for (const result of reapOne(repo)) {
				if (result.verdict !== "REAPED" || !result.receipt) continue;
				const recorded = appendReapReceipt(ledger, result.receipt);
				const action: FleetWatchGitLockAction = {
					kind: "GITLOCK_REAPED", session: sessionName, pane: "git", checks: 0, repo, receipt: result.receipt,
					text: `stale empty ${basename(result.file)} in ${repo} renamed aside to ${result.receipt.movedTo} (age ${Math.round(result.receipt.ageMs / 1000)}s; checks ${result.receipt.checks})${recorded ? "" : "; ledger write FAILED"}`,
				};
				appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
				actions.push(action);
			}
		}
	}
	let stateDirty = recordStrandedAudit(config, deps, activeWatcher, actions, eventRecorder.recordAttempt);
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
		const triage = cached(triageCache, session.repo, () => pull.triage(session.repo));
		const targets = nativeInspectionTargets(readyRows, triage, session.skipLabels ?? []);
		const coordinator: PullCoordinator = {
			actor: targets.length === 0 ? null : seat(session, session.coordinatorPane),
			session: session.coordinatorSession, pane: session.coordinatorPane,
		};
		const nativeState = targets.length === 0 ? undefined : cached(nativeStateCache,
			`${session.repo}\0${session.readyCommand ?? ""}\0${coordinator.actor ?? ""}\0${targets.join("\0")}`,
			() => pull.readNativeState(session.repo, targets, coordinator.actor, session.readyCommand));
		return choosePull({
			sessionName: session.session,
			worker: grading.length > 0 || rework.length > 0 ? seat(session, pane) : null,
			liveWorkers: new Set(rework.length > 0 ? session.workerPanes.flatMap((seatPane) => seat(session, seatPane) ?? []) : []),
			grading,
			rework,
			triage,
			issues,
			readyRows,
			readyFailure: ready.failure,
			policy,
			focus: session.focusEpics ?? [],
			skipLabels: session.skipLabels ?? [],
			taken: takenBySession.get(session.session) ?? new Set(),
			coordinator,
			nativeState,
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
			let pickedBead: string | null = null;
			if (action.kind === "NUDGED" || action.kind === "ESCALATED") {
				const choice = pullFor(session, pane);
				if (recordPullNotice(session, action, choice, deps, activeWatcher, actions, eventRecorder.recordAttempt)) stateDirty = true;
				if (!choice.ready) {
					if (choice.kind === "NO_FREE_LEAF" || choice.kind === "NO_TRIAGE_PICK") activeWatcher.setParked(session, pane, true);
					continue;
				}
				pickedBead = choice.pick.id;
				activeWatcher.setParked(session, pane, false);
				stateDirty = true;
				if (action.kind === "NUDGED") {
					const taken = takenBySession.get(session.session) ?? new Set<string>();
					taken.add(choice.pick.id);
					takenBySession.set(session.session, taken);
					action = { ...action, text: nudgeText(session, choice.pick) };
				}
			}
			const effect = action.kind === "STEERING_SUBMITTED" ? "send-keys" : "send";
			if (!admittedEffect(deps.admission, effect)) {
				recordAdmissionRefusal(deps, eventRecorder.recordAttempt, session.repo, { session: session.session, pane, checks: action.checks, text: `admission refused ${action.kind}; nothing was sent` }, pickedBead);
				continue;
			}
			if (action.kind === "STEERING_SUBMITTED") deps.sendKeys(session.session, pane, ["M-Up", "Enter"]);
			else deps.send(action.kind === "NUDGED" ? session.session : session.coordinatorSession, action.kind === "NUDGED" ? pane : session.coordinatorPane, action.text);
			const actionAtMs = now();
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date(actionAtMs).toISOString(), ...action }) + "\n");
			eventRecorder.recordAttempt(session.session, session.repo, pane, action.kind, null, pickedBead, actionAtMs);
			actions.push(action);
		}
	}
	if (eventRecorder.finish()) stateDirty = true;
	if (statePath !== null && stateDirty) saveFleetWatchState(statePath, activeWatcher.snapshot());
	return actions;
}
