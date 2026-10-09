import { recoverBusyTracker, type TrackerRecoveryResult } from "./tracker-recovery.ts";
import { randomUUID } from "node:crypto";
import { appendFileSync, lstatSync, readFileSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { dirname, join } from "node:path";
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

type FleetWatchPaneState = { checks?: number; lastDecision?: number; lastSteeringCount?: number };
type FleetWatchState = { version: 1; panes: Record<string, FleetWatchPaneState> };

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

export function nudgeText(config: FleetWatchSession, pane: string): string {
	const skip = config.skipLabels?.length ? ` Skip any bead labelled ${config.skipLabels.join(",")} (those are Josh's).` : "";
	const ready = config.readyCommand ?? "br ready --json";
	return `Fleet watch: idle for 4+ minutes. (1) If you finished or got blocked, report to ${config.coordinatorPane}: TMUX_TMPDIR=$TMUX_TMPDIR ntm send ${config.coordinatorSession} --panes=${config.coordinatorPane} \"DONE|BLOCKED <bead> <sha or reason> <evidence>; NEXT <item>\". (2) Resume your OWN claim first: br list --status in_progress --assignee <you> in ${config.repo}. (3) Only if none: run ${ready} in ${config.repo} and take the top item you can work.${skip} Never claim a bead you cannot work; blocked claims must be released.`;
}

export class FleetWatcher {
	private readonly checks = new Map<string, number>();
	private readonly lastDecision = new Map<string, number>();
	private readonly lastSteeringCount = new Map<string, number>();
	constructor(private readonly config: FleetWatchConfig, private readonly now: () => number = Date.now, state?: FleetWatchState) {
		for (const [key, pane] of Object.entries(state?.panes ?? {})) {
			if (pane.checks) this.checks.set(key, pane.checks);
			if (pane.lastDecision !== undefined) this.lastDecision.set(key, pane.lastDecision);
			if (pane.lastSteeringCount !== undefined) this.lastSteeringCount.set(key, pane.lastSteeringCount);
		}
	}
	snapshot(): FleetWatchState {
		const panes = Object.create(null) as Record<string, FleetWatchPaneState>;
		for (const [key, checks] of this.checks) if (checks > 0) (panes[key] ??= {}).checks = checks;
		for (const [key, lastDecision] of this.lastDecision) (panes[key] ??= {}).lastDecision = lastDecision;
		for (const [key, lastSteeringCount] of this.lastSteeringCount) (panes[key] ??= {}).lastSteeringCount = lastSteeringCount;
		return { version: 1, panes };
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
};
export function runFleetWatchOnce(config: FleetWatchConfig, deps: FleetWatchOnceDeps, watcher?: FleetWatcher): FleetWatchAction[] {
	if (!config.enabled) return [];
	const statePath = deps.statePath === undefined
		? watcher === undefined ? join(dirname(deps.logPath), "fleet-watch-state.json") : null
		: deps.statePath;
	const activeWatcher = watcher ?? new FleetWatcher(config, deps.now, statePath === null ? undefined : loadFleetWatchState(statePath));
	const actions: FleetWatchAction[] = [];
	const recoveredRepos = new Set<string>();
	for (const session of config.sessions) {
		if (recoveredRepos.has(session.repo)) continue;
		recoveredRepos.add(session.repo);
		const recovery = (deps.recoverTracker ?? recoverBusyTracker)(session.repo, session.session);
		if (!recovery) continue;
		const action: FleetWatchRecoveryAction = { kind: recovery.kind, session: session.session, pane: "tracker", checks: 0, text: recovery.text };
		appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
		actions.push(action);
	}
	let stateDirty = false;
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
			if (action.kind === "STEERING_SUBMITTED") deps.sendKeys(session.session, pane, ["M-Up", "Enter"]);
			else deps.send(action.kind === "NUDGED" ? session.session : session.coordinatorSession, action.kind === "NUDGED" ? pane : session.coordinatorPane, action.text);
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
			actions.push(action);
		}
	}
	if (statePath !== null && stateDirty) saveFleetWatchState(statePath, activeWatcher.snapshot());
	return actions;
}
