import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FleetWatcher, runFleetWatchOnce, type FleetWatchConfig, type FleetWatchSession } from "../../src/fleet-watch.ts";
import type { AdmissionInput } from "../../src/actuator-admission.ts";
import type { TrackerRecoveryResult } from "../../src/tracker-recovery.ts";

// ompkit-bj08.5: pause negatives through the real fleet-watch branch.

const repoRoot = resolve(import.meta.dir, "../..");
const session: FleetWatchSession = { session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: "/repo", workerPanes: ["%1"] };
const config: FleetWatchConfig = { enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [session] };

function scratchLog(): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "fleet-watch-admission."));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fleet-watch-admission-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return join(dir, "actions.jsonl");
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
		governedActions: ["send", "send-keys", "tracker-recovery"],
	};
}

function idleDeps(logPath: string, admission: AdmissionInput | undefined, recoveries: string[]) {
	const sends: { session: string; pane: string; text: string }[] = [];
	const keys: { session: string; pane: string; keys: string[] }[] = [];
	return {
		sends,
		keys,
		deps: {
			capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
			send: (session: string, pane: string, text: string) => sends.push({ session, pane, text }),
			sendKeys: (session: string, pane: string, keys: readonly string[]) => keys.push({ session, pane, keys: [...keys] }),
			logPath,
			now: () => 0,
			recoverTracker: (repo: string, _session: string): TrackerRecoveryResult | null => {
				recoveries.push(repo);
				return null;
			},
			...(admission === undefined ? {} : { admission }),
		},
	};
}

test("[b] planted: paused authority refuses nudges with zero sends", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, snapshot("PAUSED"), recoveries);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions).toEqual([]);
	expect(run.sends).toEqual([]);
	expect(run.keys).toEqual([]);
	expect(recoveries).toEqual([]);
	expect(readFileSync(logPath, "utf8")).toContain("ADMISSION_REFUSED");
});

test("[b] admitted nudge sends through the real branch", () => {
	const logPath = scratchLog();
	const recoveries: string[] = [];
	const run = idleDeps(logPath, snapshot("ACTIVE"), recoveries);
	const watcher = new FleetWatcher(config, () => 0);
	runFleetWatchOnce(config, run.deps, watcher);
	const actions = runFleetWatchOnce(config, run.deps, watcher);
	expect(actions.map((action) => action.kind)).toEqual(["NUDGED"]);
	expect(run.sends).toHaveLength(1);
});
