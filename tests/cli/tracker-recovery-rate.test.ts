import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preassignVerdict } from "../../src/fleet-watch.ts";
import { recoverBusyTracker, recoveryFlagDirs, type TrackerRecoveryCommandResult } from "../../src/tracker-recovery.ts";
import type { LivenessDeps } from "../../src/scratch.ts";

// ompkit-x5iv.2 RECOV2: br never deletes BusyRecovery failed markers, so a
// marker counts only while fresh and recover commands are rate-bounded.

const repoRoot = resolve(import.meta.dir, "../..");
const BUSY = JSON.stringify({ error: "database is busy (recovery in progress)" });
const COMPLETE = JSON.stringify({ status: "complete" });
const T0 = 1_700_000_000_000;
const T1 = 1_791_276_000_000;

function plantedRepo(): { scratch: string; repo: string; root: string } {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, "tracker-recovery-rate."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=tracker-recovery-rate-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const repo = join(scratch, "repo");
	const root = join(repo, ".beads", ".br_recovery", "schema-migrations");
	mkdirSync(root, { recursive: true });
	return { scratch, repo, root };
}

function plantMarker(root: string, dir: string, atMs: number): string {
	const runDir = join(root, dir);
	mkdirSync(runDir, { recursive: true });
	const marker = join(runDir, "recovery-failed.json");
	writeFileSync(marker, BUSY + "\n");
	utimesSync(marker, new Date(atMs), new Date(atMs));
	return runDir;
}

function plantComplete(root: string, dir: string, atMs: number): void {
	const runDir = join(root, dir);
	mkdirSync(runDir, { recursive: true });
	const complete = join(runDir, "recovery-complete.json");
	writeFileSync(complete, COMPLETE + "\n");
	utimesSync(complete, new Date(atMs), new Date(atMs));
}

const liveness: LivenessDeps = {
	signalAlive: () => false,
	psVisible: () => false,
	processStart: (pid) => pid === 700000 ? "Mon Oct  5 12:00:00 2026" : null,
};

function stubRun(brCalls: string[][], code = 0) {
	return (args: readonly string[], cwd: string): TrackerRecoveryCommandResult => {
		if (args[0] === "lsof") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "br") {
			brCalls.push([...args, `cwd=${cwd}`]);
			return { code, stdout: "recovered", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function deps(nowMs: number, brCalls: string[][], code = 0) {
	return {
		pid: 700000,
		liveness,
		sessionId: () => "$22" as string | null,
		run: stubRun(brCalls, code),
		now: () => nowMs,
		leaseId: () => "test-lease",
	};
}

test("[1] old marker followed by a later complete: zero recover commands, preassign ready", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261002T000000.000000Z-1-0", T0);
	plantComplete(planted.root, "20261010T000000.000000Z-2-0", T1);
	expect(recoveryFlagDirs(planted.repo)).toEqual([]);
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result).toBeNull();
	expect(brCalls).toEqual([]);
	expect(preassignVerdict("s", [], null, [{ id: "x-1", status: "open", assignee: null, labels: [], issue_type: "task" }], []).ready).toBe(true);
});

test("[1b] old marker with no complete anywhere still latches", () => {
	const planted = plantedRepo();
	const runDir = plantMarker(planted.root, "20261002T000000.000000Z-1-0", T0);
	expect(recoveryFlagDirs(planted.repo)).toEqual([runDir]);
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_PROCEEDED");
	expect(brCalls).toHaveLength(1);
});

test("[2] fresh marker recovers once, then the rate window refuses with zero commands", () => {
	const planted = plantedRepo();
	const runDir = plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	expect(recoveryFlagDirs(planted.repo)).toEqual([runDir]);
	const brCalls: string[][] = [];
	const first = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(first?.kind).toBe("RECOVERY_PROCEEDED");
	expect(brCalls).toHaveLength(1);
	const receiptPath = join(planted.root, ".omp-kit-last-recover.json");
	expect(existsSync(receiptPath)).toBe(true);
	expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({ schema_version: 1, at_ms: T1 });
	const second = recoverBusyTracker(planted.repo, "omp-test", deps(T1 + 10 * 60_000, brCalls));
	expect(second?.kind).toBe("RECOVERY_BLOCKED");
	expect(second?.text).toContain("rate");
	expect(brCalls).toHaveLength(1);
	expect(existsSync(join(runDir, ".omp-kit-recovery-lease.json"))).toBe(false);
});

test("corrupt rate receipt is ignored, recovery proceeds", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	mkdirSync(planted.root, { recursive: true });
	writeFileSync(join(planted.root, ".omp-kit-last-recover.json"), "not json\n");
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_PROCEEDED");
	expect(brCalls).toHaveLength(1);
});
