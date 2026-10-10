import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recoverBusyTracker } from "../../src/tracker-recovery.ts";
import type { AdmissionInput } from "../../src/actuator-admission.ts";
import type { LivenessDeps } from "../../src/scratch.ts";

// ompkit-bj08.5: pause and dead-owner negatives through the real recovery branch.

const repoRoot = resolve(import.meta.dir, "../..");

function plantedRepo(): { scratch: string; repo: string; runDir: string } {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, "tracker-recovery-admission."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=tracker-recovery-admission-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const repo = join(scratch, "repo");
	const runDir = join(repo, ".beads", ".br_recovery", "schema-migrations", "run");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "recovery-failed.json"), JSON.stringify({ error: "database is busy (recovery in progress)" }));
	return { scratch, repo, runDir };
}

function snapshot(authority: "ACTIVE" | "PAUSED"): AdmissionInput {
	return {
		launcherBinding: "none",
		authority,
		authorityConfirmed: true,
		authorityGeneration: "gen-7",
		launchers: [],
		keeper: null,
		packet: { action: "tracker-recovery", ownedAction: "tracker-recovery", generation: "gen-7" },
		governedActions: ["tracker-recovery"],
	};
}

const liveLiveness: LivenessDeps = {
	signalAlive: () => false,
	psVisible: () => false,
	processStart: (pid) => pid === 700000 ? "Mon Oct  5 12:00:00 2026" : null,
};

const deadLiveness: LivenessDeps = {
	signalAlive: () => false,
	psVisible: () => false,
	processStart: () => null,
};

test("[b] planted: dead-owner observation blocks recovery with zero commands", () => {
	const planted = plantedRepo();
	const runCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", {
		pid: 700000,
		liveness: deadLiveness,
		sessionId: () => "$22",
		run: (args, _cwd) => {
			runCalls.push([...args]);
			return { code: 0, stdout: "", stderr: "" };
		},
	});
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(runCalls).toEqual([]);
	expect(existsSync(join(planted.runDir, ".omp-kit-recovery-lease.json"))).toBe(false);
});

test("[b] planted: paused authority blocks recovery with zero commands and zero lease writes", () => {
	const planted = plantedRepo();
	const runCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", {
		pid: 700000,
		liveness: liveLiveness,
		sessionId: () => "$22",
		run: (args, _cwd) => {
			runCalls.push([...args]);
			return { code: 0, stdout: "", stderr: "" };
		},
		admission: snapshot("PAUSED"),
	});
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(result?.text).toContain("admission");
	expect(runCalls).toEqual([]);
	expect(existsSync(join(planted.runDir, ".omp-kit-recovery-lease.json"))).toBe(false);
});

test("[b] admitted recovery with no flags stays null through the real branch", () => {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, "tracker-recovery-admission-empty."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=tracker-recovery-admission-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const runCalls: string[][] = [];
	const result = recoverBusyTracker(join(scratch, "repo"), "omp-test", {
		pid: 700000,
		liveness: liveLiveness,
		sessionId: () => "$22",
		run: (args, _cwd) => {
			runCalls.push([...args]);
			return { code: 0, stdout: "", stderr: "" };
		},
		admission: snapshot("ACTIVE"),
	});
	expect(result).toBeNull();
	expect(runCalls).toEqual([]);
});
