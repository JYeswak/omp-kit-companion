import type { WorkRepoReport } from "./work-doctor.ts";
import { admitActuator, type AdmissionInput } from "./actuator-admission.ts";
import { checkTrackerRecoveryCutover, defaultPostRecoverReadback, recoverBusyTracker, retainTrackerQuarantine, type TrackerQuarantineReceipt, type TrackerRecoveryCutoverInput, type TrackerRecoveryResult, type TrackerRetentionOutcome, type TrackerRetentionReceipt } from "./tracker-recovery.ts";
import { appendFileSync, lstatSync, readFileSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { appendReapReceipt, defaultGitLockLedgerPath, reapRepoGitLocks, type RepoReapResult, type ReapReceipt } from "./index-lock.ts";
import { defaultRunner, type ScratchRunner } from "./scratch.ts";
import { atomicReplaceBytes } from "./kitlib/io.ts";

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/;
/** Reserved uncommitted edits must exceed the work audit's 30-minute limit. */
export const STRANDED_ESCALATION_LIMIT_MINUTES = 30;

type ScopedAssignment = { bead: string; role: "builder" | "grader" };
type CutStage = "director" | "chief" | "critical";
type CutExhaustion = { declaration: string; startedAt: number; stage: CutStage };

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
	/** false marks a stopped project: mail wake and the upgrade notice leave its seats alone. */
	pullEnabled?: boolean;
	/** A declared cut selects single-bead goals instead of broad pull nudges. */
	milestone?: { epic: string; declaredAt: string; pinned: string[] };
};
export type FleetWatchConfig = { enabled: boolean; intervalSeconds: number; noDecisionChecks: number; sessions: FleetWatchSession[]; registeredTrackers?: FleetWatchRegisteredTracker[]; chief?: { session: string; pane: string } };

/** Object field ordering is not a new cut declaration; pin order is part of the cut. */
function cutDeclaration(cut: NonNullable<FleetWatchSession["milestone"]>): string {
	return JSON.stringify([cut.epic, cut.declaredAt, cut.pinned]);
}
/**
 * ompkit-ps3lo: MP6-registry seam. Every registered tracker is covered by
 * the health tick even when no session entry names its repo; recovery still
 * runs under the owning director named here. Absent, the legacy
 * sessions-only coverage runs.
 */
export type FleetWatchRegisteredTracker = { repo: string; session: string };

export type FleetWatchRecoveryAction = { kind: TrackerRecoveryResult["kind"]; session: string; pane: string; checks: number; text: string; receipt?: TrackerQuarantineReceipt; repo?: string };
export type FleetWatchRetentionAction = { kind: "TRACKER_QUARANTINE_RETENTION"; session: string; pane: string; checks: number; text: string; receipt: TrackerRetentionReceipt; repo?: string };
/** An audit routing observation, not a delivery or acceptance receipt. */
export type FleetWatchStrandedAction = { kind: "STRANDED_ESCALATED" | "STRANDED_UNRESOLVED"; session: string; pane: string; checks: number; text: string; repo: string };
/** GITLOCK1 (ompkit-fp72.19.1.9): a stale empty git lock renamed aside under every reaper gate; the receipt is in the lock ledger. */
export type FleetWatchGitLockAction = { kind: "GITLOCK_REAPED"; session: string; pane: string; checks: number; text: string; repo: string; receipt: ReapReceipt };
export type FleetWatchAction = FleetWatchRecoveryAction | FleetWatchRetentionAction | FleetWatchStrandedAction | FleetWatchGitLockAction;
/** Routing evidence, not authorization to act on a bead or a seat. */
export interface PullRefusal {
	class: "unsupported_native" | "unauthorized_hands" | "unsafe_custody" | "tool_read_failure";
	bead: string | null;
	actor: string;
	next: string;
	/** A native comment reference, never an authorization inferred from its wording. */
	citation?: string;
}

type FleetWatchPaneState = { checks?: number; lastDecision?: number; lastSteeringCount?: number; parked?: true; scope?: ScopedAssignment };
type FleetWatchState = { version: 1; panes: Record<string, FleetWatchPaneState>; eventSeq?: number; pendingEmitFailures?: number; preassign?: Record<string, { kind: string; atMs: number }>; cutExhaustion?: Record<string, CutExhaustion> };

function parseScopedAssignment(value: unknown): ScopedAssignment {
	if (!value || typeof value !== "object" || !("bead" in value) || !("role" in value)
		|| typeof value.bead !== "string" || !value.bead
		|| (value.role !== "builder" && value.role !== "grader")) throw new Error("FLEET_WATCH_STATE_INVALID");
	return { bead: value.bead, role: value.role };
}

function parseCutExhaustion(value: unknown): CutExhaustion {
	if (!value || typeof value !== "object" || !("declaration" in value) || !("startedAt" in value) || !("stage" in value)
		|| typeof value.declaration !== "string" || !value.declaration
		|| typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || value.startedAt < 0
		|| (value.stage !== "director" && value.stage !== "chief" && value.stage !== "critical")) throw new Error("FLEET_WATCH_STATE_INVALID");
	return { declaration: value.declaration, startedAt: value.startedAt, stage: value.stage };
}

function parseFleetWatchState(value: unknown): FleetWatchState {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const state = value as { version?: unknown; panes?: unknown; eventSeq?: unknown; pendingEmitFailures?: unknown; preassign?: unknown; cutExhaustion?: unknown };
	const rawPanes = state.panes;
	if (state.version !== 1 || typeof rawPanes !== "object" || rawPanes === null || Array.isArray(rawPanes)) throw new Error("FLEET_WATCH_STATE_INVALID");
	const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
	for (const [key, raw] of Object.entries(rawPanes as Record<string, unknown>)) {
		if (!key || typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("FLEET_WATCH_STATE_INVALID");
		const candidate = raw as { checks?: unknown; lastDecision?: unknown; lastSteeringCount?: unknown; parked?: unknown; scope?: unknown };
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
		if (candidate.scope !== undefined) pane.scope = parseScopedAssignment(candidate.scope);
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
	if (state.cutExhaustion !== undefined) {
		if (!state.cutExhaustion || typeof state.cutExhaustion !== "object" || Array.isArray(state.cutExhaustion)) throw new Error("FLEET_WATCH_STATE_INVALID");
		parsed.cutExhaustion = Object.create(null) as Record<string, CutExhaustion>;
		for (const [key, episode] of Object.entries(state.cutExhaustion)) parsed.cutExhaustion[key] = parseCutExhaustion(episode);
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

/** Read unresolved critical episodes for the current cut, not a fresh supply or delivery claim. */
export function readFleetWatchCriticalReportLines(configPath: string, statePath: string): string[] {
	const state = loadFleetWatchState(statePath);
	if (state?.cutExhaustion === undefined) return [];
	const episodes = state.cutExhaustion;
	return loadFleetWatchConfig(configPath).sessions.flatMap(session => {
		const episode = episodes[session.session];
		return session.milestone !== undefined && episode?.stage === "critical" && episode.declaration === cutDeclaration(session.milestone)
			? [`CUT-EXHAUSTED ${session.session}: cut ${session.milestone.epic} unresolved since ${new Date(episode.startedAt).toISOString()}; director response overdue`] : [];
	});
}

export function paneIsBusy(paneText: string): boolean {
	return paneText.split("\n").slice(-6).some(line => SPINNER.test(line));
}


function stringList(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/** Episode deduplication for the retained stranded-work audit, not seat polling. */
export class FleetWatcher {
	private readonly episodes = new Map<string, { kind: string; atMs: number }>();
	constructor(_config: FleetWatchConfig, private readonly now: () => number = Date.now, state?: FleetWatchState) {
		for (const [key, episode] of Object.entries(state?.preassign ?? {})) {
			if (key.startsWith("stranded:")) this.episodes.set(key, episode);
		}
	}
	snapshot(): FleetWatchState {
		return { version: 1, panes: {}, preassign: Object.fromEntries(this.episodes) };
	}
	claimStrandedEpisode(key: string): boolean {
		const id = `stranded:${key}`;
		if (this.episodes.has(id)) return false;
		this.episodes.set(id, { kind: "STRANDED_ESCALATED", atMs: this.now() });
		return true;
	}
	clearStrandedRepo(repo: string): boolean {
		let cleared = false;
		for (const key of this.episodes.keys()) if (key.startsWith(`stranded:${repo}\0`)) {
			this.episodes.delete(key);
			cleared = true;
		}
		return cleared;
	}
}


const MISSION_REF = /^[^\n:][^\n]*:[1-9][0-9]{0,6}$/;

function validateSessionSupply(session: FleetWatchSession, index: number): void {
	if (session.milestone !== undefined && (
		!session.milestone || typeof session.milestone !== "object"
		|| typeof session.milestone.epic !== "string" || !session.milestone.epic.trim()
		|| !Number.isFinite(Date.parse(session.milestone.declaredAt))
		|| !Array.isArray(session.milestone.pinned) || session.milestone.pinned.some(id => typeof id !== "string" || !id.trim())
	)) throw new Error(`FLEET_WATCH_CONFIG_INVALID: sessions[${index}].milestone`);
}

function parseChiefRoute(value: unknown): FleetWatchConfig["chief"] {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || !("session" in value) || !("pane" in value)
		|| typeof value.session !== "string" || !value.session.trim()
		|| typeof value.pane !== "string" || !value.pane.trim()) throw new Error("FLEET_WATCH_CONFIG_INVALID: chief");
	return { session: value.session, pane: value.pane };
}

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
		validateSessionSupply(session, index);
	}
	const registeredTrackers = parseRegisteredTrackers((value as Record<string, unknown>).registeredTrackers);
	const chief = parseChiefRoute((value as Record<string, unknown>).chief);
	return {
		enabled: (value as Record<string, unknown>).enabled !== false,
		intervalSeconds: Number((value as Record<string, unknown>).intervalSeconds ?? 120),
		noDecisionChecks: Number((value as Record<string, unknown>).noDecisionChecks ?? 5),
		sessions, ...(registeredTrackers === undefined ? {} : { registeredTrackers }),
		...(chief === undefined ? {} : { chief }),
	};
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


export type FleetWatchOnceDeps = {
	send: (session: string, pane: string, text: string) => void;
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
	 * Pause/custody admission snapshot. Retained audit and recovery effects
	 * consult it first; a refusal performs zero effects and is logged.
	 */
	admission?: AdmissionInput;
	/** Latest work-doctor rows; reuse its reservation and uncommitted ages. */
	workAudit?: { repos: readonly WorkRepoReport[] } | null;
};

function admittedEffect(admission: AdmissionInput | undefined, action: string): boolean {
	if (admission === undefined) return true;
	return admitActuator({ ...admission, packet: { ...admission.packet, action } }).verdict !== "REFUSE";
}

type AdmissionRefusalRecord = { session: string; pane: string; checks?: number; repo?: string; text: string };
function recordAdmissionRefusal(deps: FleetWatchOnceDeps, record: AdmissionRefusalRecord): void {
	const atMs = (deps.now ?? Date.now)();
	appendFileSync(deps.logPath, JSON.stringify({ at: new Date(atMs).toISOString(), kind: "ADMISSION_REFUSED", ...record }) + "\n");
}

/** Route the work audit as one tick phase; return whether persisted episodes changed. */
function recordStrandedAudit(config: FleetWatchConfig, deps: FleetWatchOnceDeps, activeWatcher: FleetWatcher, actions: FleetWatchAction[]): boolean {
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
					recordAdmissionRefusal(deps, { session: owner.coordinatorSession, pane: owner.coordinatorPane, checks: 0, repo: row.path, text: "admission refused stranded escalation; nothing was sent" });
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

export function runFleetWatchOnce(config: FleetWatchConfig, deps: FleetWatchOnceDeps, watcher?: FleetWatcher): FleetWatchAction[] {
	if (!config.enabled) return [];
	const statePath = deps.statePath === undefined
		? watcher === undefined ? join(dirname(deps.logPath), "fleet-watch-state.json") : null
		: deps.statePath;
	const activeWatcher = watcher ?? new FleetWatcher(config, deps.now, statePath === null ? undefined : loadFleetWatchState(statePath));
	const actions: FleetWatchAction[] = [];
	const recoveredRepos = new Set<string>();
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
			recordAdmissionRefusal(deps, { session: session.session, pane: "tracker", checks: 0, text: "admission refused tracker recovery; no recovery ran" });
			continue;
		}
		const recovery = recoverTracker(session.repo, session.session);
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
			recordAdmissionRefusal(deps, { session: tracker.session, pane: "tracker", checks: 0, repo: tracker.repo, text: "admission refused tracker recovery; no recovery ran" });
			continue;
		}
		const registeredRecovery = recoverTracker(tracker.repo, tracker.session);
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
				recordAdmissionRefusal(deps, { session: sessionName, pane: "tracker", checks: 0, repo, text: "admission refused tracker quarantine retention; no artifact was moved" });
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
				recordAdmissionRefusal(deps, { session: sessionName, pane: "git", checks: 0, repo, text: "admission refused the git lock reap; no lock was moved" });
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
	const stateDirty = recordStrandedAudit(config, deps, activeWatcher, actions);
	if (statePath !== null && stateDirty) saveFleetWatchState(statePath, activeWatcher.snapshot());
	return actions;
}
