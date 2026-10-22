import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetWatcher, paneIsBusy, paneTarget, runFleetWatchOnce, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
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

test("planted: failed capture with empty stdout sends one NO_DECISION and never nudges", () => {
	let now = 0;
	const failureConfig = { ...config, noDecisionChecks: 1 };
	const watcher = new FleetWatcher(failureConfig, () => now);
	watcher.poll(session, "%1", "idle");
	now = 60_000;
	const sent: { session: string; pane: string; text: string }[] = [];
	const actions = runFleetWatchOnce(failureConfig, {
		capture: () => ({ code: 1, stdout: "", stderr: "tmux socket unavailable" }),
		send: (session, pane, text) => sent.push({ session, pane, text }),
		sendKeys: () => {},
		logPath: "/dev/null",
		now: () => now,
	}, watcher);
	expect(actions.map(action => action.kind)).toEqual(["NO_DECISION"]);
	expect(actions[0]?.text).toContain("tmux socket unavailable");
	expect(watcher.poll(session, "%1", "idle").actions.map(action => action.kind)).not.toContain("NUDGED");
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ session: "omp-test", pane: "%54" });
});

test("planted: successful capture with stderr is also treated as unknown", () => {
	const failureConfig = { ...config, noDecisionChecks: 1 };
	const watcher = new FleetWatcher(failureConfig, () => 60_000);
	watcher.poll(session, "%1", "idle");
	const actions = runFleetWatchOnce(failureConfig, {
		capture: () => ({ code: 0, stdout: "idle", stderr: "tmux warning" }),
		send: () => {},
		sendKeys: () => {},
		logPath: "/dev/null",
		now: () => 60_000,
	}, watcher);
	expect(actions.map(action => action.kind)).toEqual(["NO_DECISION"]);
	expect(actions[0]?.text).toContain("tmux warning");
});

test("planted: idle Steering · 1 submits M-Up then Enter once and logs the event", () => {
	const scratchParent = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = mkdtempSync(join(scratchParent, "fleet-watch."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-test\nrepo=${resolve(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const logPath = join(scratch, "actions.jsonl");
	const keySends: { session: string; pane: string; keys: string[] }[] = [];
	const textSends: string[] = [];
	const deps = {
		capture: () => ({ code: 0, stdout: "worker idle\nSteering · 1\n⌥↑ to edit", stderr: "" }),
		send: (_session: string, _pane: string, text: string) => textSends.push(text),
		sendKeys: (session: string, pane: string, keys: readonly string[]) => keySends.push({ session, pane, keys: [...keys] }),
		logPath,
		now: () => 0,
	};
	const duplicatePaneConfig = { ...config, sessions: [{ ...session, workerPanes: ["%1", "%1"] }] };
	try {
		const first = runFleetWatchOnce(duplicatePaneConfig, deps);
		expect(first.map(action => action.kind)).toEqual(["STEERING_SUBMITTED"]);
		expect(keySends).toEqual([{ session: "omp-test", pane: "%1", keys: ["M-Up", "Enter"] }]);
		expect(textSends).toEqual([]);
		expect(readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line).kind)).toEqual(["STEERING_SUBMITTED"]);
		expect(runFleetWatchOnce(duplicatePaneConfig, deps)).toEqual([]);
		expect(keySends).toHaveLength(1);
	} finally {
		if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
	}
});

test("planted: busy Steering · 1 pane receives no recovery keys", () => {
	const keySends: string[][] = [];
	const actions = runFleetWatchOnce(config, {
		capture: () => ({ code: 0, stdout: "Steering · 1\n⌥↑ to edit\n⠋ worker running", stderr: "" }),
		send: () => {},
		sendKeys: (_session, _pane, keys) => keySends.push([...keys]),
		logPath: "/dev/null",
		statePath: null,
	});
	expect(actions).toEqual([]);
	expect(keySends).toEqual([]);
});

test("healthy captures nudge the worker once at the idle threshold", () => {
	const watchConfig = { ...config, noDecisionChecks: 99 };
	const watcher = new FleetWatcher(watchConfig, () => 0);
	const sent: string[] = [];
	const deps = {
		capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
		send: (_session: string, _pane: string, text: string) => sent.push(text),
		sendKeys: () => {},
		logPath: "/dev/null",
		now: () => 0,
		preassignProbes: {
			findRecoveryFlags: () => [],
			listReadyRows: () => ({ rows: [{ id: "x-1", status: "open", assignee: null, labels: [], issue_type: "task" }], failure: null }),
		},
	};
	expect(runFleetWatchOnce(watchConfig, deps, watcher)).toEqual([]);
	expect(runFleetWatchOnce(watchConfig, deps, watcher).map(action => action.kind)).toEqual(["NUDGED"]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain("idle for 4+ minutes");
});


test("runFleetWatchOnce restores idle and decision-throttle state across fresh invocations", () => {
	const scratchParent = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = mkdtempSync(join(scratchParent, "fleet-watch-state."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-test\nrepo=${resolve(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const logPath = join(scratch, "actions.jsonl");
	const watchConfig = { ...config, noDecisionChecks: 2 };
	let now = 0;
	let capture = { code: 0, stdout: "idle", stderr: "" };
	const deps = {
		capture: () => capture,
		send: () => {},
		sendKeys: () => {},
		logPath,
		now: () => now,
		recoverTracker: () => null,
		preassignProbes: {
			findRecoveryFlags: () => [],
			listReadyRows: () => ({ rows: [{ id: "x-1", status: "open", assignee: null, labels: [], issue_type: "task" }], failure: null }),
		},
	};
	try {
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual([]);
		now = 120_000;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual(["NUDGED", "NO_DECISION"]);
		now = 120_001;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual([]);
		now = 240_000;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual(["NO_DECISION"]);
		now = 240_001;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual(["ESCALATED"]);
		capture = { code: 0, stdout: "⠋ busy", stderr: "" };
		now = 240_002;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual([]);
		capture = { code: 0, stdout: "idle", stderr: "" };
		now = 240_003;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual([]);
		capture = { code: 1, stdout: "", stderr: "capture failed" };
		now = 240_004;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual(["NO_DECISION"]);
		capture = { code: 0, stdout: "idle", stderr: "" };
		now = 240_005;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual([]);
		now = 240_006;
		expect(runFleetWatchOnce(watchConfig, deps).map(action => action.kind)).toEqual(["NUDGED"]);
	} finally {
		if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
	}
});

test("runFleetWatchOnce submits one queued steering message per pending count across fresh invocations", () => {
	const scratchParent = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = mkdtempSync(join(scratchParent, "fleet-watch-steering."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-test\nrepo=${resolve(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	let pane = "Steering · 1\n⌥↑ to edit\n";
	const keys: string[][] = [];
	const deps = {
		capture: () => ({ code: 0, stdout: pane, stderr: "" }),
		send: () => {},
		sendKeys: (_session: string, _pane: string, sent: readonly string[]) => { keys.push([...sent]); },
		logPath: join(scratch, "actions.jsonl"),
		recoverTracker: () => null,
	};
	try {
		expect(runFleetWatchOnce(config, deps).map(action => action.kind)).toEqual(["STEERING_SUBMITTED"]);
		expect(runFleetWatchOnce(config, deps).map(action => action.kind)).toEqual([]);
		pane = "Steering · 2\n⌥↑ to edit\n";
		expect(runFleetWatchOnce(config, deps).map(action => action.kind)).toEqual(["STEERING_SUBMITTED"]);
		expect(keys).toEqual([["M-Up", "Enter"], ["M-Up", "Enter"]]);
	} finally {
		if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
	}
});

test("pane ids target the server-unique pane; other selectors stay scoped to the session", () => {
	expect(paneTarget("workers", "%12")).toBe("%12");
	expect(paneTarget("workers", "0.1")).toBe("workers:0.1");
	expect(paneTarget("workers", "2")).toBe("workers:2");
	expect(paneTarget("workers", "%")).toBe("workers:%");
	expect(paneTarget("workers", "%1a")).toBe("workers:%1a");
});

const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
test.skipIf(!tmuxAvailable)("real tmux: a configured %id pane is captured, where session:%id is refused", () => {
	const socket = join(tmpdir(), `f${process.pid.toString(36)}`);
	expect(Buffer.byteLength(socket)).toBeLessThan(104);
	const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { encoding: "utf8" });
	try {
		expect(tmux("new-session", "-d", "-s", "workers", "-x", "80", "-y", "24").status).toBe(0);
		expect(tmux("split-window", "-t", "workers:0").status).toBe(0);
		const paneId = tmux("display", "-p", "-t", "workers:0.1", "#{pane_id}").stdout.trim();
		expect(paneId).toMatch(/^%\d+$/);
		expect(tmux("capture-pane", "-p", "-t", `workers:${paneId}`).status).not.toBe(0);
		for (const pane of [paneId, "0.1"]) {
			const capture = tmux("capture-pane", "-p", "-t", paneTarget("workers", pane));
			expect({ pane, status: capture.status, stderr: capture.stderr }).toEqual({ pane, status: 0, stderr: "" });
		}
	} finally {
		tmux("kill-server");
		rmSync(socket, { force: true });
		rmSync(`${socket}.lock`, { force: true });
	}
});

test("planted GITLOCK1: tick reaps a stale lock and ledgers the receipt; null disables", () => {
	const scratchParent = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = mkdtempSync(join(scratchParent, "fleet-watch-gitlock."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-gitlock-test\nrepo=${resolve(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-watch-gitlock-repo-")));
	const gitDir = join(root, ".git");
	mkdirSync(gitDir);
	const lock = join(gitDir, "index.lock");
	const ledgerPath = join(scratch, "ledger.jsonl");
	const logPath = join(scratch, "actions.jsonl");
	const now = Date.now();
	const staleLock = () => {
		writeFileSync(lock, "");
		const back = new Date(now - 130_000);
		utimesSync(lock, back, back);
	};
	const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
	const quiet = {
		capture: () => ({ code: 0, stdout: "⠋ working", stderr: "" }),
		send: () => {},
		sendKeys: () => {},
		logPath,
		now: () => now,
		statePath: null,
	};
	try {
		staleLock();
		const repoConfig = { ...config, sessions: [{ ...session, repo: root }] };
		runFleetWatchOnce(repoConfig, { ...quiet, gitLockReap: { run: clearRun, ledgerPath, staleAfterMs: 120_000 } });
		expect(existsSync(lock)).toBe(false);
		expect(readdirSync(gitDir).some((name) => name.startsWith("index.lock.stale-"))).toBe(true);
		const ledger = readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ kind: "GITLOCK_REAPED", lock, repo: root, sizeBytes: 0 });
		const kinds = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind);
		expect(kinds).toEqual(["GITLOCK_REAPED"]);
		// Disabled: the next stale lock survives the tick untouched.
		staleLock();
		runFleetWatchOnce(repoConfig, { ...quiet, gitLockReap: null });
		expect(existsSync(lock)).toBe(true);
		expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(1);
		const kindsAfter = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).kind);
		expect(kindsAfter).toEqual(["GITLOCK_REAPED"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
		if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
	}
});
