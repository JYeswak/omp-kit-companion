import { expect, test } from "bun:test";
import { FleetWatcher, runFleetWatchOnce, STRANDED_ESCALATION_LIMIT_MINUTES, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
import type { WorkRepoReport } from "../../src/work-doctor.ts";
import type { StaleReservedEdit } from "../../src/reservation-age.ts";

const director: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"], skipLabels: [] };
const other: FleetWatchSession = { session: "other", coordinatorPane: "%55", coordinatorSession: "other", repo: "/other", workerPanes: ["%2"], skipLabels: [] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 99, sessions: [director, other] };

function stale(age_minutes: number, overrides: Partial<StaleReservedEdit> = {}): StaleReservedEdit {
	return { path: "src/held.ts", path_pattern: "src/*.ts", agent_name: "GreenLake", bead: "br-123", age_minutes, ...overrides };
}

function row(repo: string, overrides: Partial<WorkRepoReport> = {}): WorkRepoReport {
	return {
		name: repo.split("/").pop() ?? repo, path: repo, status: "WARN",
		dirty_file_count: 1, tracked_dirty_file_count: 1, untracked_file_count: 0,
		untracked_file_cap: 1000, untracked_scan_status: "OK",
		commits_ahead: 0, commits_behind: 0, unpushed_commits: 0,
		has_upstream: true, has_remote: true, no_upstream: false, no_remote: false,
		stash_count: 0, detached: false, branch: "main",
		last_commit_epoch: null, last_commit_age_days: null, active_worktrees: 1,
		worktree_paths: [repo], reservation_scan_status: "OK", stale_uncommitted_edits: [],
		risk_score: 0, findings: ["dirty"], stranded: true, conditions: ["dirty"],
		...overrides,
	};
}

function tick(watcher: FleetWatcher, repos: readonly WorkRepoReport[], sent: { session: string; pane: string; text: string }[]) {
	return runFleetWatchOnce(config, {
		capture: () => ({ code: 0, stdout: "⠋ working", stderr: "" }),
		send: (session, pane, text) => sent.push({ session, pane, text }),
		sendKeys: () => {},
		logPath: "/dev/null",
		statePath: null,
		now: () => 0,
		recoverTracker: () => null,
		retainTracker: null,
		workAudit: { repos },
	}, watcher);
}

test("positive: 31min stranded fixture escalates to exactly the repo director queue", () => {
	expect(STRANDED_ESCALATION_LIMIT_MINUTES).toBe(30);
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const actions = tick(watcher, [row("/repo", { stale_uncommitted_edits: [stale(31)] })], sent);
	expect(actions.map((action) => action.kind)).toEqual(["STRANDED_ESCALATED"]);
	const escalated = actions[0];
	expect(escalated).toMatchObject({ session: "omp-test", pane: "%54", repo: "/repo" });
	expect(escalated.text).toContain("/repo");
	expect(escalated.text).toContain("src/held.ts");
	expect(escalated.text).toContain("GreenLake");
	expect(escalated.text).toContain("br-123");
	expect(escalated.text).toContain("save sweep");
	expect(sent).toEqual([{ session: "omp-test", pane: "%54", text: escalated.text }]);
});

test("repeat tick stays silent; clean save/push clears; re-strand escalates again", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const stranded = [row("/repo", { stale_uncommitted_edits: [stale(31)] })];
	expect(tick(watcher, stranded, sent).map((a) => a.kind)).toEqual(["STRANDED_ESCALATED"]);
	expect(tick(watcher, stranded, sent)).toEqual([]);
	const clean = [row("/repo", { status: "OK", dirty_file_count: 0, tracked_dirty_file_count: 0, findings: [], stranded: false, conditions: [], stale_uncommitted_edits: [] })];
	expect(tick(watcher, clean, sent)).toEqual([]);
	expect(sent).toHaveLength(1);
	expect(tick(watcher, stranded, sent).map((a) => a.kind)).toEqual(["STRANDED_ESCALATED"]);
	expect(sent).toHaveLength(2);
});

test("planted negative: 29min fixture is not escalated", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	expect(tick(watcher, [row("/repo", { stale_uncommitted_edits: [stale(29)] })], sent)).toEqual([]);
	expect(sent).toEqual([]);
});

test("planted negative: clean saved repo produces no stranded row", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const clean = row("/repo", { status: "OK", dirty_file_count: 0, tracked_dirty_file_count: 0, findings: [], stranded: false, conditions: [], stale_uncommitted_edits: [] });
	expect(tick(watcher, [clean], sent)).toEqual([]);
	expect(sent).toEqual([]);
});

test("planted negative: another owner's dirty-only turn is not this agent's breach", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const dirtyOnly = row("/other", { stale_uncommitted_edits: [] });
	const actions = tick(watcher, [dirtyOnly], sent);
	expect(actions).toEqual([]);
	expect(sent).toEqual([]);
});

test("planted negative: unknown ownership is unresolved, never misrouted", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const actions = tick(watcher, [row("/nowhere", { stale_uncommitted_edits: [stale(45)] })], sent);
	expect(actions.map((action) => action.kind)).toEqual(["STRANDED_UNRESOLVED"]);
	expect(actions[0]).toMatchObject({ session: "UNKNOWN", repo: "/nowhere" });
	expect(sent).toEqual([]);
});
