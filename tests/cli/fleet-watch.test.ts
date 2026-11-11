import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadFleetWatchConfig, paneIsBusy, runFleetWatchOnce, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { KNOWN_JOBS } from "../../src/service.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"], readyCommand: "br ready --json", skipLabels: ["directive"] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [session] };

test("retired watcher never nudges an idle configured seat; admission still resolves its coordinator", () => {
	const task = ownedTmp("fleet-watch-retired");
	const path = join(task.path, "fleet-watch.json");
	writeFileSync(path, JSON.stringify(config));
	const loaded = loadFleetWatchConfig(path);
	const sent: string[] = [];
	for (let check = 0; check < 12; check++) {
		const actions = runFleetWatchOnce(loaded, {
			logPath: join(task.path, "actions.jsonl"),
			now: () => check * 120_000, gitLockReap: null,
		});
		expect(actions).toEqual([]);
		expect(actions.map(action => action.kind)).not.toContain("NUDGED");
		expect(actions.map(action => action.kind)).not.toContain("ESCALATED");
		expect(actions.map(action => action.kind)).not.toContain("NO_DECISION");
	}
	expect(sent).toEqual([]);
	expect(KNOWN_JOBS["fleet-watch"]).toBeUndefined();
	const result = runFixture(["python3", "-c",
		"import os,sys; sys.path.insert(0, sys.argv[1]); os.environ['OMP_KIT_FLEET_WATCH_CONFIG']=sys.argv[2]; from br_create_guard_core import project_policy; print(project_policy(sys.argv[3]))",
		resolve(import.meta.dir, "../../scripts"), path, session.repo],
		{ cwd: task.path, label: "retired fleet admission", floor_s: fixtureDeadlineS() });
	expect(result.rc).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).toContain(session.coordinatorSession);
	expect(new TextDecoder().decode(result.stdout)).toContain(session.coordinatorPane);
	task.cleanup();
});

test("shared spinner detection remains available without seat polling", () => {
	expect(paneIsBusy("│ ⠋ working │")).toBe(true);
	expect(paneIsBusy("idle")).toBe(false);
});

test("retained config metadata loads and malformed fields still refuse", () => {
	const task = ownedTmp("fleet-watch-config");
	const write = (extra: Record<string, unknown>) => {
		const path = join(task.path, "config.json");
		writeFileSync(path, JSON.stringify({ sessions: [{ ...session, ...extra }] }));
		return path;
	};
	const loaded = loadFleetWatchConfig(write({ focusEpics: ["x-epic"], mission: "/abs/ROADMAP.md:9", round: 2, phase: "AGREE", pullEnabled: true }));
	expect(loaded.sessions[0]).toMatchObject({ focusEpics: ["x-epic"], mission: "/abs/ROADMAP.md:9", round: 2, phase: "AGREE", pullEnabled: true });
	expect(loadFleetWatchConfig(write({})).sessions[0]?.pullEnabled).toBeUndefined();
	expect(() => loadFleetWatchConfig(write({ mission: "ROADMAP.md" }))).toThrow("sessions[0].mission");
	expect(() => loadFleetWatchConfig(write({ focusEpics: "x-epic" }))).toThrow("sessions[0].focusEpics");
	expect(() => loadFleetWatchConfig(write({ pullEnabled: "no" }))).toThrow("sessions[0].pullEnabled");
	task.cleanup();
});

test("planted GITLOCK1: tick reaps a stale lock and ledgers the receipt; null disables", () => {
	const scratchParent = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = ownedTmp("fleet-watch-gitlock", { root: scratchParent }).path;
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-gitlock-test\nrepo=${resolve(import.meta.dir, "../..")}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const root = realpathSync(ownedTmp("fleet-watch-gitlock-repo").path);
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
		logPath,
		now: () => now,
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

test("a stopped project (pullEnabled false, no pause owner) loads: the pull-pause ownership rule retired with pull nudging", () => {
	const task = ownedTmp("stopped-project-config");
	try {
		const path = join(task.path, "fleet-watch.json");
		writeFileSync(path, JSON.stringify({ ...config, sessions: [{ ...session, pullEnabled: false }] }));
		expect(loadFleetWatchConfig(path).sessions[0]?.pullEnabled).toBe(false);
		writeFileSync(path, JSON.stringify({ ...config, sessions: [{ ...session, pullEnabled: "no" }] }));
		expect(() => loadFleetWatchConfig(path)).toThrow("FLEET_WATCH_CONFIG_INVALID: sessions[0].pullEnabled");
	} finally {
		task.cleanup();
	}
});

afterAll(() => cleanupAllOwnedTmp());
