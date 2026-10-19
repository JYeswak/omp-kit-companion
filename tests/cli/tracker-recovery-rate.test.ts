import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { preassignVerdict } from "../../src/fleet-watch.ts";
import { RECOVERY_ARTIFACT_BOUND, recoverBusyTracker, recoveryFlagDirs, type TrackerRecoveryCommandResult } from "../../src/tracker-recovery.ts";
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

function plantRecoveryArtifact(root: string, dir: string, atMs: number): void {
	const runDir = join(root, dir);
	mkdirSync(join(runDir, "recovery-before"), { recursive: true });
	const complete = join(runDir, "recovery-complete.json");
	writeFileSync(complete, COMPLETE + "\n");
	utimesSync(complete, new Date(atMs), new Date(atMs));
}

const liveness: LivenessDeps = {
	signalAlive: () => false,
	psVisible: () => false,
	processStart: (pid) => pid === 700000 ? "Mon Oct  5 12:00:00 2026" : null,
};

function stubRun(brCalls: string[][], code = 0, onRecover?: () => void) {
	return (args: readonly string[], cwd: string): TrackerRecoveryCommandResult => {
		if (args[0] === "lsof") return { code: 0, stdout: "", stderr: "" };
		if (args[0] === "br" && args[1] === "--version") return { code: 0, stdout: "br 0.7.4\n", stderr: "" };
		if (args[0] === "br") {
			brCalls.push([...args, `cwd=${cwd}`]);
			onRecover?.();
			return { code, stdout: "recovered", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

function deps(nowMs: number, brCalls: string[][], code = 0, onRecover?: () => void) {
	return {
		pid: 700000,
		liveness,
		sessionId: () => "$22" as string | null,
		run: stubRun(brCalls, code, onRecover),
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

test("recovery artifacts hit a stable bound and report quarantine growth", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	const brCalls: string[][] = [];
	const first = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls, 0, () => {
		plantRecoveryArtifact(planted.root, "20261030T000000.000000Z-100-0", T1);
	}));
	expect(first?.kind).toBe("RECOVERY_PROCEEDED");
	expect(first?.receipt).toMatchObject({ cycle_count: 1, wal_index_artifact_count: 0, artifact_count: 1, artifact_bound: RECOVERY_ARTIFACT_BOUND, growth: 1, upstream: { issue: "beads_rust#532", br_version: "0.7.4", disposition: "UNCONFIRMED; mitigation only" } });
	expect(brCalls).toHaveLength(1);

	const nextRun = plantMarker(planted.root, "20261031T000000.000000Z-101-0", T1 + 2 * 60 * 60_000);
	const second = recoverBusyTracker(planted.repo, "omp-test", deps(T1 + 2 * 60 * 60_000, brCalls));
	expect(second?.kind).toBe("RECOVERY_QUARANTINE_GROWTH");
	expect(second?.text).toContain("WAL_QUARANTINE_GROWTH");
	expect(second?.receipt).toMatchObject({ cycle_count: 1, wal_index_artifact_count: 0, artifact_count: 1, artifact_bound: RECOVERY_ARTIFACT_BOUND, growth: 0 });
	const gate = preassignVerdict("omp-test", [nextRun], second?.kind ?? null, [], []);
	expect(gate.ready).toBe(false);
	if (!gate.ready) expect(gate.kind).toBe("WRITE_LATCHED");
	expect(brCalls).toHaveLength(1);
	expect(JSON.parse(readFileSync(join(planted.root, ".omp-kit-last-recover.json"), "utf8")).at_ms).toBe(T1);
});

test("a live foreign database holder prevents the recovery command", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	const brCalls: string[][] = [];
	const run = stubRun(brCalls);
	const result = recoverBusyTracker(planted.repo, "omp-test", {
		...deps(T1, brCalls),
		liveness: { ...liveness, signalAlive: (pid) => pid === 700001 },
		run: (args, cwd) => args[0] === "lsof" ? { code: 0, stdout: "700001\n", stderr: "" } : run(args, cwd),
	});
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(result?.text).toContain("DATABASE_HOLDER_LATCH");
	expect(result?.text).toContain("database holder PID 700001 is live");
	expect(brCalls).toEqual([]);
});

test("quarantined WAL artifacts latch writes without an active recovery marker", () => {
	const planted = plantedRepo();
	mkdirSync(join(planted.repo, ".beads"), { recursive: true });
	writeFileSync(join(planted.repo, ".beads", ".br-wal-index-quarantined"), "fixture\n");
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_QUARANTINE_GROWTH");
	expect(result?.receipt).toMatchObject({ cycle_count: 0, wal_index_artifact_count: 1, artifact_count: 1, artifact_bound: RECOVERY_ARTIFACT_BOUND, growth: 0 });
	const gate = preassignVerdict("omp-test", [], result?.kind ?? null, [], []);
	expect(gate.ready).toBe(false);
	if (!gate.ready) {
		expect(gate.kind).toBe("WRITE_LATCHED");
		expect(gate.text).toContain("WAL_QUARANTINE_GROWTH");
		expect(gate.text).toContain("quarantine artifacts");
	}
	expect(brCalls).toEqual([]);
});

test("symlinked migration run entry refuses recovery before intervention with zero commands", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	const real = join(planted.root, "20261010T000000.000000Z-9-0");
	const link = join(planted.root, "20261011T000000.000000Z-10-0");
	symlinkSync(real, link);
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(result?.text).toContain("quarantine artifact inventory is unknown");
	expect(result?.text).toContain("is a symbolic link");
	expect(brCalls).toEqual([]);
});

test("wrong-type retained artifact refuses recovery before intervention with zero commands", () => {
	const planted = plantedRepo();
	plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	writeFileSync(join(planted.root, "20261010T000000.000000Z-9-0", "recovery-before"), "not-a-directory\n");
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(result?.text).toContain("quarantine artifact inventory is unknown");
	expect(result?.text).toContain("unexpected type");
	expect(brCalls).toEqual([]);
});

test("wrong-type prepared marker refuses recovery before intervention with zero commands", () => {
	const planted = plantedRepo();
	const runDir = plantMarker(planted.root, "20261010T000000.000000Z-9-0", T1);
	mkdirSync(join(runDir, "recovery-prepared.json"));
	const brCalls: string[][] = [];
	const result = recoverBusyTracker(planted.repo, "omp-test", deps(T1, brCalls));
	expect(result?.kind).toBe("RECOVERY_BLOCKED");
	expect(result?.text).toContain("quarantine artifact inventory is unknown");
	expect(result?.text).toContain("unexpected type");
	expect(brCalls).toEqual([]);
});
