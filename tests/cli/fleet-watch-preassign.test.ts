import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	FleetWatcher,
	parseReadyRows,
	preassignVerdict,
	runFleetWatchOnce,
	type FleetWatchConfig,
	type FleetWatchSession,
	type PreassignProbes,
	type ReadyRow,
} from "../../src/fleet-watch.ts";
import type { TrackerRecoveryResult } from "../../src/tracker-recovery.ts";

// ompkit-bj08.5.1 PREASSIGN1: nudge eligibility gates with planted negatives.

const repoRoot = resolve(import.meta.dir, "../..");
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 99, sessions: [session] };

const LEAF: ReadyRow = { id: "x-1", status: "open", assignee: null, labels: [], issue_type: "task" };

function scratchLog(): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "fleet-watch-preassign."));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-preassign-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return join(dir, "actions.jsonl");
}

function countKind(logPath: string, kind: string): number {
	return readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes(`"kind":"${kind}"`)).length;
}

function idleDeps(logPath: string, probes: PreassignProbes, recoveries: string[], recovery: TrackerRecoveryResult | null) {
	const sends: { session: string; pane: string; text: string }[] = [];
	return {
		sends,
		coordinatorSends: () => sends.filter((send) => send.pane === "%54"),
		workerSends: () => sends.filter((send) => send.pane === "%1"),
		deps: {
			capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
			send: (session: string, pane: string, text: string) => sends.push({ session, pane, text }),
			sendKeys: () => {},
			logPath,
			now: () => 0,
			recoverTracker: (repo: string, _session: string): TrackerRecoveryResult | null => {
				recoveries.push(repo);
				return recovery;
			},
			preassignProbes: probes,
		},
	};
}
test("[1] planted latched repo: zero nudges, one WRITE_LATCHED naming the flag, silence after", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => ["/repo/.beads/.br_recovery/schema-migrations/flag-1"],
		listReadyRows: () => [LEAF],
	}, recoveries, { kind: "RECOVERY_BLOCKED", text: "Fleet Watch: tracker recovery blocked; live holder." });
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	runFleetWatchOnce(config, run.deps, watcher);
	expect(run.workerSends()).toEqual([]);
	expect(recoveries.length).toBeGreaterThan(0);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("WRITE_LATCHED");
	expect(coordinator[0]?.text).toContain("flag-1");
	expect(countKind(logPath, "WRITE_LATCHED")).toBe(1);
});

test("[2] planted no-free-leaf frontier: zero nudges, one NO_FREE_LEAF with counts", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const skipped: FleetWatchSession = { ...session, skipLabels: ["owner-decision"] };
	const skippedConfig: FleetWatchConfig = { ...config, sessions: [skipped] };
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => [
			{ id: "h-1", status: "open", assignee: "BusyAgent", labels: [], issue_type: "task" },
			{ id: "e-1", status: "open", assignee: null, labels: [], issue_type: "epic" },
			{ id: "s-1", status: "open", assignee: null, labels: ["owner-decision"], issue_type: "task" },
		],
	}, recoveries, null);
	const watcher = new FleetWatcher(skippedConfig, () => 0);
	runFleetWatchOnce(skippedConfig, run.deps, watcher);
	runFleetWatchOnce(skippedConfig, run.deps, watcher);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("NO_FREE_LEAF");
	expect(coordinator[0]?.text).toContain("held 1");
	expect(coordinator[0]?.text).toContain("epics 1");
	expect(countKind(logPath, "NO_FREE_LEAF")).toBe(1);
});

test("[3] positive: writable repo with one open leaf nudges as today", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => [LEAF],
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions.map((action) => action.kind)).toEqual(["NUDGED"]);
	expect(run.workerSends()).toHaveLength(1);
});

test("[4] UNKNOWN readiness refuses with the reason reported", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => null,
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	runFleetWatchOnce(config, run.deps, watcher);
	expect(run.workerSends()).toEqual([]);
	const coordinator = run.coordinatorSends();
	expect(coordinator).toHaveLength(1);
	expect(coordinator[0]?.text).toContain("UNKNOWN");
	expect(countKind(logPath, "UNKNOWN")).toBe(1);
});

test("[5] reverting the check makes the latched case nudge", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, {
		findRecoveryFlags: () => [],
		listReadyRows: () => [LEAF],
	}, recoveries, null);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions.map((action) => action.kind)).toEqual(["NUDGED"]);
	expect(run.workerSends()).toHaveLength(1);
});

test("verdict: PROCEEDED recovery clears the episode", () => {
	expect(preassignVerdict("s", ["flag-1"], "RECOVERY_PROCEEDED", [LEAF], []).ready).toBe(true);
	expect(preassignVerdict("s", ["flag-1"], "RECOVERY_BLOCKED", [LEAF], []).ready).toBe(false);
	expect(preassignVerdict("s", ["flag-1"], null, [LEAF], []).ready).toBe(false);
	expect(preassignVerdict("s", [], null, [LEAF], []).ready).toBe(true);
	expect(preassignVerdict("s", null, null, [LEAF], []).ready).toBe(false);
});

test("rows: malformed tracker output is UNKNOWN, good rows parse", () => {
	expect(parseReadyRows([{ id: "a", status: "open" }])).toEqual([{ id: "a", status: "open", assignee: null, labels: [], issue_type: "" }]);
	expect(parseReadyRows([{ id: "a" }])).toBeNull();
	expect(parseReadyRows("nope")).toBeNull();
	expect(parseReadyRows([{ id: 7, status: "open" }])).toBeNull();
});
