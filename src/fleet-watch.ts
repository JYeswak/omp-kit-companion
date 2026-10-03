import { appendFileSync, readFileSync } from "node:fs";

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
export type FleetWatchAction = { kind: "NUDGED" | "ESCALATED" | "NO_DECISION"; session: string; pane: string; checks: number; text: string };
export type FleetWatchDecision = { busy: boolean; checks: number; actions: FleetWatchAction[] };

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
	constructor(private readonly config: FleetWatchConfig, private readonly now: () => number = Date.now) {}
	poll(session: FleetWatchSession, pane: string, paneText: string): FleetWatchDecision {
		if (!this.config.enabled) return { busy: paneIsBusy(paneText), checks: 0, actions: [] };
		const key = `${session.session}:${pane}`;
		const busy = paneIsBusy(paneText);
		if (busy) { this.checks.set(key, 0); return { busy, checks: 0, actions: [] }; }
		const checks = (this.checks.get(key) ?? 0) + 1;
		this.checks.set(key, checks);
		const actions: FleetWatchAction[] = [];
		if (checks === 2) actions.push({ kind: "NUDGED", session: session.session, pane, checks, text: nudgeText(session, pane) });
		else if (checks >= 5 && checks % 5 === 0) actions.push({ kind: "ESCALATED", session: session.session, pane, checks, text: `Fleet watch ESCALATION (${session.session}): ${pane} still idle after nudge (${checks} checks). Dispatch it now.` });
		const last = this.lastDecision.get(key) ?? 0;
		if (checks >= this.config.noDecisionChecks && this.now() - last >= this.config.intervalSeconds * 1000 * this.config.noDecisionChecks) {
			actions.push({ kind: "NO_DECISION", session: session.session, pane, checks, text: `Fleet watch: ${pane} has been idle for ${checks} checks without a decision; coordinator attention required.` });
		}
		if (actions.length) this.lastDecision.set(key, this.now());
		return { busy, checks, actions };
	}
}

export function loadFleetWatchConfig(path: string): FleetWatchConfig {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || !Array.isArray((value as Record<string, unknown>).sessions)) throw new Error("FLEET_WATCH_CONFIG_INVALID");
	return { enabled: (value as Record<string, unknown>).enabled !== false, intervalSeconds: Number((value as Record<string, unknown>).intervalSeconds ?? 120), noDecisionChecks: Number((value as Record<string, unknown>).noDecisionChecks ?? 5), sessions: (value as Record<string, unknown>).sessions as FleetWatchSession[] };
}

export type FleetWatchOnceDeps = { capture: (session: string, pane: string) => string; send: (session: string, pane: string, text: string) => void; logPath: string; now?: () => number };
export function runFleetWatchOnce(config: FleetWatchConfig, deps: FleetWatchOnceDeps, watcher = new FleetWatcher(config, deps.now)): FleetWatchAction[] {
	if (!config.enabled) return [];
	const actions: FleetWatchAction[] = [];
	for (const session of config.sessions) for (const pane of session.workerPanes) {
		for (const action of watcher.poll(session, pane, deps.capture(session.session, pane)).actions) {
			deps.send(action.kind === "NUDGED" ? session.session : session.coordinatorSession, action.kind === "NUDGED" ? pane : session.coordinatorPane, action.text);
			appendFileSync(deps.logPath, JSON.stringify({ at: new Date((deps.now ?? Date.now)()).toISOString(), ...action }) + "\n");
			actions.push(action);
		}
	}
	return actions;
}
