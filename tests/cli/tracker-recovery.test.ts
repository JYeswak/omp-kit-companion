import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp";
import { runFleetWatchOnce, type FleetWatchConfig } from "../../src/fleet-watch.ts";

// ompkit-1ra0d.123 DEADTICK1: busy-tracker recovery (recoverBusyTracker) was
// called only from the retired fleet-watch tick and nothing schedules it, so
// it is deleted and the tick performs no recovery. A planted stale
// BusyRecovery flag is ignored: zero actions, zero log lines, planted files
// untouched. There is no runner left in the tick that could invoke br.

const repoRoot = resolve(import.meta.dir, "../..");
const fixtures = join(import.meta.dir, "../fixtures/tracker-recovery");
const session = "omp-test";

function plantedTracker(name: "stale-proceeds" | "live-blocks"): { scratch: string; repo: string; runDir: string; logPath: string } {
	const scratchParent = join(repoRoot, "var/agent-tmp");
	mkdirSync(scratchParent, { recursive: true });
	const scratch = ownedTmp("tracker-recovery", { root: scratchParent }).path;
	const repo = join(scratch, "repo");
	const runDir = join(repo, ".beads", ".br_recovery", "schema-migrations", "planted-run");
	mkdirSync(runDir, { recursive: true });
	const fixtureDir = join(fixtures, name);
	copyFileSync(join(fixtureDir, "recovery-failed.json"), join(runDir, "recovery-failed.json"));
	copyFileSync(join(fixtureDir, ".omp-kit-recovery-lease.json"), join(runDir, ".omp-kit-recovery-lease.json"));
	return { scratch, repo, runDir, logPath: join(scratch, "fleet-watch.jsonl") };
}

function watchConfig(repo: string): FleetWatchConfig {
	return { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [{
		session, coordinatorPane: "%54", coordinatorSession: session, repo, workerPanes: ["%1"],
	}] };
}

function expectIgnored(planted: { scratch: string; repo: string; runDir: string; logPath: string }): void {
	try {
		const actions = runFleetWatchOnce(watchConfig(planted.repo), { logPath: planted.logPath, gitLockReap: null });
		expect(actions).toEqual([]);
		// Nothing was logged: no recovery, retention or stranded routing.
		expect(existsSync(planted.logPath)).toBe(false);
		// The planted flag and lease are untouched: no lease claim, no br run.
		expect(existsSync(join(planted.runDir, "recovery-failed.json"))).toBe(true);
		expect(existsSync(join(planted.runDir, ".omp-kit-recovery-lease.json"))).toBe(true);
	} finally {
		if (existsSync(planted.scratch)) rmSync(planted.scratch, { recursive: true, force: true });
	}
}

test("DEADTICK1: retired tick performs no tracker recovery on a planted stale BusyRecovery flag", () => {
	expectIgnored(plantedTracker("stale-proceeds"));
});

test("DEADTICK1: retired tick performs no tracker recovery on a planted live-holder flag", () => {
	expectIgnored(plantedTracker("live-blocks"));
});
