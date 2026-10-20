import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetWatcher, runFleetWatchOnce, STRANDED_ESCALATION_LIMIT_MINUTES, type FleetWatchConfig, type FleetWatchSession, type FleetWatchOnceDeps } from "../../src/fleet-watch.ts";
import { inspectWorkFleet, type WorkRepoReport } from "../../src/work-doctor.ts";
import { projectSlug, type StaleReservedEdit } from "../../src/reservation-age.ts";

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

function tick(watcher: FleetWatcher | undefined, repos: readonly WorkRepoReport[], sent: { session: string; pane: string; text: string }[], overrides: Partial<FleetWatchOnceDeps> = {}, watchConfig = config) {
	return runFleetWatchOnce(watchConfig, {
		capture: () => ({ code: 0, stdout: "⠋ working", stderr: "" }),
		send: (session, pane, text) => sent.push({ session, pane, text }),
		sendKeys: () => {},
		logPath: "/dev/null",
		statePath: null,
		now: () => 0,
		recoverTracker: () => null,
		retainTracker: null,
		workAudit: { repos },
		...overrides,
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

test("persisted episodes survive watcher restart and clear after save/push", () => {
	const scratch = mkdtempSync(join(tmpdir(), "stranded-rhy9-24-"));
	try {
		const statePath = join(scratch, "state.json");
		const logPath = join(scratch, "actions.jsonl");
		const sent: { session: string; pane: string; text: string }[] = [];
		const stranded = [row("/repo", { stale_uncommitted_edits: [stale(31)] })];
		expect(tick(undefined, stranded, sent, { statePath, logPath }).map((a) => a.kind)).toEqual(["STRANDED_ESCALATED"]);
		expect(tick(undefined, stranded, sent, { statePath, logPath })).toEqual([]);
		const saved = [row("/repo", { status: "OK", dirty_file_count: 0, tracked_dirty_file_count: 0, stranded: false, conditions: [], findings: [] })];
		expect(tick(undefined, saved, sent, { statePath, logPath })).toEqual([]);
		expect(readFileSync(logPath, "utf8")).toContain('"kind":"STRANDED_CLEARED"');
		expect(tick(undefined, stranded, sent, { statePath, logPath }).map((a) => a.kind)).toEqual(["STRANDED_ESCALATED"]);
		expect(sent).toHaveLength(2);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("registered tracker routes to its configured director, not another repo's queue", () => {
	const watchConfig = { ...config, registeredTrackers: [{ repo: "/registered", session: "other" }] };
	const sent: { session: string; pane: string; text: string }[] = [];
	const actions = tick(new FleetWatcher(watchConfig, () => 0), [row("/registered", { stale_uncommitted_edits: [stale(31)] })], sent, {}, watchConfig);
	expect(actions).toHaveLength(1);
	expect(actions[0]).toMatchObject({ kind: "STRANDED_ESCALATED", session: "other", pane: "%55", repo: "/registered" });
	expect(sent).toEqual([{ session: "other", pane: "%55", text: actions[0]!.text }]);
});

test("refused escalation is not consumed and can be sent after admission recovers", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const sent: { session: string; pane: string; text: string }[] = [];
	const stranded = [row("/repo", { stale_uncommitted_edits: [stale(31)] })];
	expect(tick(watcher, stranded, sent, { admission: { launcherBinding: "none", authority: "OFF", authorityConfirmed: true, authorityGeneration: null, launchers: [], keeper: null, packet: { action: "send", ownedAction: "send", generation: null }, governedActions: ["send"] } })).toEqual([]);
	expect(sent).toEqual([]);
	expect(tick(watcher, stranded, sent).map((a) => a.kind)).toEqual(["STRANDED_ESCALATED"]);
	expect(sent).toHaveLength(1);
});

test("real work audit feeds the watcher at 29/31 minutes and clears after a local save/push", async () => {
	const scratch = mkdtempSync(join(tmpdir(), "stranded-audit-boundary-"));
	const git = (cwd: string, ...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	try {
		const repo = join(scratch, "repo");
		const remote = join(scratch, "remote.git");
		mkdirSync(repo);
		git(repo, "init", "--quiet", "-b", "main");
		git(repo, "config", "user.email", "fixture@example.invalid");
		git(repo, "config", "user.name", "fixture");
		git(repo, "config", "commit.gpgsign", "false");
		git(repo, "config", "core.hooksPath", "/dev/null");
		const held = join(repo, "held.txt");
		writeFileSync(held, "saved\n");
		git(repo, "add", "held.txt");
		git(repo, "commit", "--quiet", "-m", "seed [test]");
		git(scratch, "init", "--bare", "--quiet", remote);
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "--quiet", "--set-upstream", "origin", "main");
		const nowMs = Date.now();
		const storage = join(scratch, "mail");
		const project = join(storage, "projects", projectSlug(repo));
		mkdirSync(join(project, "file_reservations"), { recursive: true });
		writeFileSync(join(project, "project.json"), JSON.stringify({ slug: projectSlug(repo), human_key: repo }));
		writeFileSync(join(project, "file_reservations", "held.json"), JSON.stringify({ id: 1, agent_name: "GreenLake", path_pattern: "held.txt", exclusive: true, reason: "ompkit-rhy9.24", created_ts: new Date(nowMs - 60 * 60_000).toISOString(), expires_ts: new Date(nowMs + 60 * 60_000).toISOString() }));
		git(repo, "config", "omp-kit.agent-mail-storage-root", storage);
		const watchConfig = { ...config, sessions: [{ ...director, repo }] };
		const watcher = new FleetWatcher(watchConfig, () => nowMs);
		const sent: { session: string; pane: string; text: string }[] = [];
		const auditTick = async () => {
			const audit = await inspectWorkFleet({ roots: [repo], nowMs, staleEditLimitMinutes: 30, perRepoTimeoutMs: 5_000 });
			return tick(watcher, audit.repos, sent, { now: () => nowMs }, watchConfig);
		};
		writeFileSync(held, "dirty\n");
		const age = (minutes: number) => { const stamp = new Date(nowMs - minutes * 60_000); utimesSync(held, stamp, stamp); };
		age(29);
		expect(await auditTick()).toEqual([]);
		age(31);
		const actions = await auditTick();
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ kind: "STRANDED_ESCALATED", session: "omp-test", pane: "%54", repo });
		expect(actions[0]!.text).toContain("GreenLake");
		expect(actions[0]!.text).toContain("held.txt");
		expect(sent).toEqual([{ session: "omp-test", pane: "%54", text: actions[0]!.text }]);
		git(repo, "add", "held.txt");
		git(repo, "commit", "--quiet", "-m", "save [test]");
		git(repo, "push", "--quiet", "origin", "main");
		expect(await auditTick()).toEqual([]);
		expect(sent).toHaveLength(1);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}, 30_000);
