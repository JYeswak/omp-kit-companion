import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
import type { AdmissionInput } from "../../src/actuator-admission.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

// ompkit-bj08.5: pause negatives through the real fleet-watch branch.
// ompkit-1ra0d.123 DEADTICK1: recovery/retention/stranded phases are deleted,
// so admission now gates only the git index-lock reap.

const repoRoot = resolve(import.meta.dir, "../..");
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: [] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [session] };

function scratchPaths(): { logPath: string; ledgerPath: string } {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const dir = ownedTmp("fleet-watch-admission", { root: parent }).path;
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-admission-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return { logPath: join(dir, "actions.jsonl"), ledgerPath: join(dir, "ledger.jsonl") };
}

function snapshot(authority: "ACTIVE" | "PAUSED"): AdmissionInput {
	return {
		launcherBinding: "none",
		authority,
		authorityConfirmed: true,
		authorityGeneration: "gen-7",
		launchers: [],
		keeper: null,
		packet: { action: "nudge", ownedAction: "nudge", generation: "gen-7" },
		governedActions: ["send", "send-keys", "tracker-recovery", "git-lock-reap"],
	};
}

// Zero effects: no runner may be invoked on an unconfigured repo, refused or not.
const throwingRun = (): never => { throw new Error("the reaper runs nothing for an unconfigured repo"); };

test("[b] paused authority refuses the git lock reap with zero effects", () => {
	const { logPath, ledgerPath } = scratchPaths();
	const actions = runFleetWatchOnce(config, {
		logPath,
		now: () => 0,
		admission: snapshot("PAUSED"),
		gitLockReap: { run: throwingRun, ledgerPath },
	});
	expect(actions).toEqual([]);
	expect(readFileSync(logPath, "utf8")).toContain("ADMISSION_REFUSED");
});

test("[b] admitted tick with no stale lock stays silent and never steers", () => {
	const { logPath, ledgerPath } = scratchPaths();
	const actions = runFleetWatchOnce(config, {
		logPath,
		now: () => 0,
		admission: snapshot("ACTIVE"),
		gitLockReap: { run: throwingRun, ledgerPath },
	});
	expect(actions).toEqual([]);
	expect(existsSync(logPath)).toBe(false);
});

afterAll(() => cleanupAllOwnedTmp());
