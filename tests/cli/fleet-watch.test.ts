import { expect, test } from "bun:test";
import { FleetWatcher, paneIsBusy, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"], readyCommand: "br ready --json", skipLabels: ["directive"] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [session] };

test("idle pane nudges at two checks and escalates at five", () => {
	const watcher = new FleetWatcher(config, () => 0);
	const actions = Array.from({ length: 10 }, (_, index) => watcher.poll(session, "%1", "idle").actions.map(action => ({ check: index + 1, kind: action.kind })));
	expect(actions.flat()).toEqual(expect.arrayContaining([{ check: 2, kind: "NUDGED" }, { check: 5, kind: "ESCALATED" }, { check: 10, kind: "ESCALATED" }]));
});

test("spinner pane never accumulates idle checks", () => {
	const watcher = new FleetWatcher(config);
	for (let i = 0; i < 10; i++) expect(watcher.poll(session, "%1", "│ ⠋ working │").actions).toEqual([]);
	expect(paneIsBusy("│ ⠋ working │")).toBe(true);
});

test("no-decision alert fires when watcher remains silent", () => {
	let now = 0; const watcher = new FleetWatcher(config, () => now);
	for (let i = 0; i < 9; i++) { now += 60_000; watcher.poll(session, "%1", "idle"); }
	now += 60_000;
	expect(watcher.poll(session, "%1", "idle").actions.map(action => action.kind)).toContain("NO_DECISION");
});
