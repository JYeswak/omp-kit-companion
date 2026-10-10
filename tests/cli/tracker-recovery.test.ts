import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce, type FleetWatchConfig } from "../../src/fleet-watch.ts";
import { defaultSessionId, recoverBusyTracker, type TrackerRecoveryResult } from "../../src/tracker-recovery.ts";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { LivenessDeps } from "../../src/scratch.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const fixtures = join(import.meta.dir, "../fixtures/tracker-recovery");
const session = "omp-test";

function plantedTracker(name: "stale-proceeds" | "live-blocks" | "no-lease") {
	const scratchParent = join(repoRoot, "var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = mkdtempSync(join(scratchParent, "tracker-recovery."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=tracker-recovery-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const repo = join(scratch, "repo");
	const runDir = join(repo, ".beads", ".br_recovery", "schema-migrations", "planted-run");
	mkdirSync(runDir, { recursive: true });
	const fixtureDir = join(fixtures, name === "no-lease" ? "stale-proceeds" : name);
	copyFileSync(join(fixtureDir, "recovery-failed.json"), join(runDir, "recovery-failed.json"));
	if (name !== "no-lease") copyFileSync(join(fixtureDir, ".omp-kit-recovery-lease.json"), join(runDir, ".omp-kit-recovery-lease.json"));
	return { scratch, repo, logPath: join(scratch, "fleet-watch.jsonl") };
}

function recoveryDeps(options: { dbHolders?: string; lsof?: { code: number; stdout: string; stderr: string } } = {}) {
	const brCalls: string[][] = [];
	const lsofCalls: string[][] = [];
	const leaseSnapshots: Record<string, unknown>[] = [];
	const liveness: LivenessDeps = {
		signalAlive: pid => pid === 424242,
		psVisible: () => false,
		processStart: pid => pid === 424242 ? "Mon Oct  5 12:00:00 2026" : pid === 700000 ? "current-process" : null,
	};
	const recoverTracker = (repo: string, configuredSession: string) => recoverBusyTracker(repo, configuredSession, {
		pid: 700000,
		liveness,
		sessionId: candidate => candidate === "worker-live" ? "$11" : candidate === session ? "$22" : null,
		run: (args, cwd) => {
			if (args[0] === "lsof") { lsofCalls.push([...args]); return options.lsof ?? { code: 0, stdout: options.dbHolders ?? "", stderr: "" }; }
			if (args[0] === "br") {
				brCalls.push([...args, `cwd=${cwd}`]);
				leaseSnapshots.push(JSON.parse(readFileSync(join(cwd, ".beads", ".br_recovery", "schema-migrations", "planted-run", ".omp-kit-recovery-lease.json"), "utf8")));
			}
			return { code: 0, stdout: "recovered", stderr: "" };
		},
		now: () => 1_791_276_000_000,
		leaseId: () => "current-holder-lease",
	});
	return { brCalls, lsofCalls, leaseSnapshots, recoverTracker };
}

function watchConfig(repo: string): FleetWatchConfig {
	return { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [{
		session, coordinatorPane: "%54", coordinatorSession: session, repo, workerPanes: ["%1"],
	}] };
}

function runOnce(repo: string, logPath: string, recoverTracker: (repo: string, session: string) => TrackerRecoveryResult | null) {
	return runFleetWatchOnce(watchConfig(repo), {
		capture: () => ({ code: 0, stdout: "⠋ worker running", stderr: "" }),
		send: () => { throw new Error("recovery events must be logged, not sent to a worker"); },
		sendKeys: () => { throw new Error("recovery must not steer tmux panes"); },
		logPath,
		recoverTracker,
	});
}

test("planted stale recovery flag proceeds with a lease and logs zero live holders", () => {
	const planted = plantedTracker("stale-proceeds");
	const deps = recoveryDeps();
	try {
		const actions = runOnce(planted.repo, planted.logPath, deps.recoverTracker);
		expect(actions.map(action => action.kind)).toEqual(["RECOVERY_PROCEEDED"]);
		expect(actions[0]?.text).toContain("stale holder");
		expect(actions[0]?.text).toContain("zero live database holders");
		expect(deps.brCalls).toEqual([["br", "doctor", "migrate-schema", "recover", `cwd=${planted.repo}`]]);
		expect(deps.lsofCalls).toEqual([["lsof", "-nP", "-t", "--", join(planted.repo, ".beads", "beads.db")]]);
		expect(deps.leaseSnapshots).toMatchObject([{ schema_version: 1, pid: 700000, process_start: "current-process", session, session_id: "$22" }]);
		const logged = JSON.parse(readFileSync(planted.logPath, "utf8").trim());
		expect(logged).toMatchObject({ kind: "RECOVERY_PROCEEDED", session, pane: "tracker" });
		expect(existsSync(join(planted.repo, ".beads", ".br_recovery", "schema-migrations", "planted-run", ".omp-kit-recovery-lease.json"))).toBe(false);
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("planted live recovery flag and PID/session lease blocks recovery", () => {
	const planted = plantedTracker("live-blocks");
	const deps = recoveryDeps();
	try {
		const actions = runOnce(planted.repo, planted.logPath, deps.recoverTracker);
		expect(actions.map(action => action.kind)).toEqual(["RECOVERY_BLOCKED"]);
		expect(actions[0]?.text).toContain("live holder");
		expect(deps.brCalls).toEqual([]);
		expect(deps.lsofCalls).toEqual([]);
		expect(JSON.parse(readFileSync(planted.logPath, "utf8").trim())).toMatchObject({ kind: "RECOVERY_BLOCKED" });
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("live database descriptor blocks a stale lease-free flag", () => {
	const planted = plantedTracker("no-lease");
	const deps = recoveryDeps({ dbHolders: "424242\n" });
	try {
		const actions = runOnce(planted.repo, planted.logPath, deps.recoverTracker);
		expect(actions.map(action => action.kind)).toEqual(["RECOVERY_BLOCKED"]);
		expect(actions[0]?.text).toContain("database holder PID 424242");
		expect(deps.brCalls).toEqual([]);
		expect(deps.lsofCalls).toEqual([["lsof", "-nP", "-t", "--", join(planted.repo, ".beads", "beads.db")]]);
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("real lsof with no holder (exit 1, no output) is clear and recovery proceeds", () => {
	const planted = plantedTracker("no-lease");
	const deps = recoveryDeps({ lsof: { code: 1, stdout: "", stderr: "" } });
	try {
		const actions = runOnce(planted.repo, planted.logPath, deps.recoverTracker);
		expect(actions.map(action => action.kind)).toEqual(["RECOVERY_PROCEEDED"]);
		expect(deps.brCalls).toEqual([["br", "doctor", "migrate-schema", "recover", `cwd=${planted.repo}`]]);
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("lsof exit 1 with an error message stays unknown and blocks recovery", () => {
	const planted = plantedTracker("no-lease");
	const deps = recoveryDeps({ lsof: { code: 1, stdout: "", stderr: "lsof: status error on beads.db: Permission denied" } });
	try {
		const actions = runOnce(planted.repo, planted.logPath, deps.recoverTracker);
		expect(actions.map(action => action.kind)).toEqual(["RECOVERY_BLOCKED"]);
		expect(actions[0]?.text).toContain("database holder liveness is unknown");
		expect(deps.brCalls).toEqual([]);
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
});

const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
test.skipIf(!tmuxAvailable)("the session probe returns a live tmux session id and null for a missing session", () => {
	const dir = mkdtempSync(join(tmpdir(), "fw-sid-"));
	const socket = join(dir, "s");
	const tmux = (args: readonly string[]) => {
		const result = spawnSync(args[0]!, ["-S", socket, ...args.slice(1)], { encoding: "utf8" });
		return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	try {
		expect(tmux(["tmux", "new-session", "-d", "-s", "omp-test", "-x", "80", "-y", "24"]).code).toBe(0);
		expect(defaultSessionId("omp-test", dir, tmux)).toMatch(/^\$\d+$/);
		expect(defaultSessionId("no-such-session", dir, tmux)).toBeNull();
	} finally {
		tmux(["tmux", "kill-server"]);
		rmSync(dir, { recursive: true, force: true });
	}
});
