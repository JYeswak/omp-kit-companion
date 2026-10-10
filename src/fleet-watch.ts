import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { recoverBusyTracker, recoveryFlagDirs, type TrackerRecoveryResult } from "./tracker-recovery.ts";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, renameSync, unlinkSync, type Stats } from "node:fs";
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
	| { ready: false; kind: "WRITE_LATCHED" | "NO_FREE_LEAF" | "UNKNOWN"; text: string };

export interface PreassignProbes {
	/** Unresolved recovery flag dirs, or null when unreadable (UNKNOWN). */
	findRecoveryFlags: (repo: string) => string[] | null;
	/** Ready rows, or null when unreadable (UNKNOWN). */
	listReadyRows: (repo: string) => ReadyRow[] | null;
}

const NON_LEAF_LABEL = /epic|umbrella/i;
const READY_TIMEOUT_MS = 15000;

function defaultListReadyRows(repo: string): ReadyRow[] | null {
	let stdout: string;
	try {
		const child = spawnSync("br", ["ready", "--json"], { cwd: repo, encoding: "utf8", timeout: READY_TIMEOUT_MS });
		if (child.status !== 0) return null;
		stdout = child.stdout;
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	return parseReadyRows(parsed);
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
	if (flags === null) {
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (recovery flags unreadable); nudges resume when probes answer.` };
	}
	if (flags.length > 0 && recoveryKind !== "RECOVERY_PROCEEDED") {
		const names = flags.map((flag) => basename(flag)).join(", ");
		return { ready: false, kind: "WRITE_LATCHED", text: `Fleet watch (WRITE_LATCHED): no nudge for ${sessionName} workers while the tracker write path is latched (${names}); recovery ${recoveryKind ?? "did not proceed"}; nudges resume when flags clear.` };
	}
	if (rows === null) {
		return { ready: false, kind: "UNKNOWN", text: `Fleet watch (UNKNOWN): no nudge for ${sessionName} workers: write readiness UNKNOWN (ready rows unreadable); nudges resume when probes answer.` };
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
type FleetWatchPaneState = { checks?: number; lastDecision?: number; lastSteeringCount?: number };
type FleetWatchState = { version: 1; panes: Record<string, FleetWatchPaneState>; preassign?: Record<string, { kind: string; atMs: number }> };

function parseFleetWatchState(value: unknown): FleetWatchState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const state = value as { version?: unknown; panes?: unknown };
	const rawPanes = state.panes;
	if (state.version !== 1 || typeof rawPanes !== "object" || rawPanes === null || Array.isArray(rawPanes)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
	for (const [key, raw] of Object.entries(rawPanes as Record<string, unknown>)) {
		if (!key || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("FLEET_WATCH_STATE_INVALID");
		const candidate = raw as { checks?: unknown; lastDecision?: unknown; lastSteeringCount?: unknown };
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
		panes[key] = pane;
	}
	return { version: 1, panes };
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

export function nudgeText(config: FleetWatchSession, pane: string): string {
	const skip = config.skipLabels?.length ? ` Skip any bead labelled ${config.skipLabels.join(",")} (those are Josh's).` : "";
	const ready = config.readyCommand ?? "br ready --json";
	return `Fleet watch: idle for 4+ minutes. (1) If you finished or got blocked, report to ${config.coordinatorPane}: TMUX_TMPDIR=$TMUX_TMPDIR ntm send ${config.coordinatorSession} --panes=${config.coordinatorPane} \"DONE|BLOCKED <bead> <sha or reason> <evidence>; NEXT <item>\". (2) Resume your OWN claim first: br list --status in_progress --assignee <you> in ${config.repo}. (3) Only if none: run ${ready} in ${config.repo} and take the top item you can work.${skip} Never claim a bead you cannot work; blocked claims must be released.`;
}

export class FleetWatcher {
	private readonly checks = new Map<string, number>();
	private readonly lastDecision = new Map<string, number>();
	private readonly lastSteeringCount = new Map<string, number>();
	private readonly preassignReports = new Map<string, { kind: string; atMs: number }>();
	constructor(private readonly config: FleetWatchConfig, private readonly now: () => number = Date.now, state?: FleetWatchState) {
		for (const [key, pane] of Object.entries(state?.panes ?? {})) {
			if (pane.checks) this.checks.set(key, pane.checks);
			if (pane.lastDecision !== undefined) this.lastDecision.set(key, pane.lastDecision);
			if (pane.lastSteeringCount !== undefined) this.lastSteeringCount.set(key, pane.lastSteeringCount);
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
		if (busy) { this.checks.set(key, 0); return { busy, checks: 0, actions: [] }; }
		if (steeringMatch) {
			this.checks.set(key, 0);
			if (!paneText.includes("⌥↑ to edit")) return { busy, checks: 0, actions: [] };
			const count = Number(steeringMatch[1]);
			if (this.lastSteeringCount.get(key) === count) return { busy, checks: 0, actions: [] };
			this.lastSteeringCount.set(key, count);
			return { busy, checks: 0, actions: [{ kind: "STEERING_SUBMITTED", session: session.session, pane, checks: 0, text: `Fleet watch: submitted one queued steering message from ${pane} with M-Up then Enter.` }] };
		}
		const idleChecks = (this.checks.get(key) ?? 0) + 1;
		this.checks.set(key, idleChecks);
		const actions: FleetWatchPaneAction[] = [];
		if (idleChecks === 2) actions.push({ kind: "NUDGED", session: session.session, pane, checks: idleChecks, text: nudgeText(session, pane) });
		else if (idleChecks >= 5 && idleChecks % 5 === 0) actions.push({ kind: "ESCALATED", session: session.session, pane, checks: idleChecks, text: `Fleet watch ESCALATION (${session.session}): ${pane} still idle after nudge (${idleChecks} checks). Dispatch it now.` });
		const last = this.lastDecision.get(key) ?? 0;
		if (idleChecks >= this.config.noDecisionChecks && this.now() - last >= this.config.intervalSeconds * 1000 * this.config.noDecisionChecks) {
			actions.push({ kind: "NO_DECISION", session: session.session, pane, checks: idleChecks, text: `Fleet watch: ${pane} has been idle for ${idleChecks} checks without a decision; coordinator attention required.` });
		}
		if (actions.length) this.lastDecision.set(key, this.now());
		return { busy, checks: idleChecks, actions };
	}
}


export function loadFleetWatchConfig(path: string): FleetWatchConfig {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).sessions)) throw new Error("FLEET_WATCH_CONFIG_INVALID");
	return { enabled: (value as Record<string, unknown>).enabled !== false, intervalSeconds: Number((value as Record<string, unknown>).intervalSeconds ?? 120), noDecisionChecks: Number((value as Record<string, unknown>).noDecisionChecks ?? 5), sessions: (value as Record<string, unknown>).sessions as FleetWatchSession[] };
}

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
	const flagCache = new Map<string, string[] | null>();
	const rowsCache = new Map<string, ReadyRow[] | null>();
	const verdictCache = new Map<string, PreassignVerdict>();
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
	const verdictForSession = (session: FleetWatchSession): PreassignVerdict => {
		const cached = verdictCache.get(session.session);
		if (cached !== undefined) return cached;
		let flags = flagCache.get(session.repo);
		if (flags === undefined) {
			flags = probes.findRecoveryFlags(session.repo);
			flagCache.set(session.repo, flags);
		}
		let rows = rowsCache.get(session.repo);
		if (rows === undefined) {
			rows = probes.listReadyRows(session.repo);
			rowsCache.set(session.repo, rows);
		}
		const verdict = preassignVerdict(session.session, flags, recoveryKinds.get(session.repo) ?? null, rows, session.skipLabels ?? []);
		verdictCache.set(session.session, verdict);
		return verdict;
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
		for (const action of decisions) {
			if (action.kind === "NUDGED" || action.kind === "ESCALATED") {
				const verdict = verdictForSession(session);
				if (!verdict.ready) {
					if (activeWatcher.settlePreassignReport(session.session, verdict.kind)) {
						appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: verdict.kind, session: session.session, pane, checks: action.checks, text: verdict.text }) + "\n");
						deps.send(session.coordinatorSession, session.coordinatorPane, verdict.text);
						if (statePath !== null) saveFleetWatchState(statePath, activeWatcher.snapshot());
						stateDirty = true;
					}
					continue;
				}
				if (activeWatcher.settlePreassignReport(session.session, null)) {
					appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), kind: "PREASSIGN_CLEARED", session: session.session, pane, checks: action.checks, text: `pre-assignment clear for ${session.session}; nudges resume` }) + "\n");
					stateDirty = true;
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
