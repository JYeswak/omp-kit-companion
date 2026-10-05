import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireRunLock, forgeLockForTest, gateRunLoad, LOAD_GATE_FACTOR, OVERLAP_EXIT, runWithCap, SKIPPED_LOAD_EXIT, type CapExec } from "../../src/service-run.ts";

mkdirSync(join(resolve(import.meta.dir, "../.."), "var", "agent-tmp"), { recursive: true });
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jobsDir(): string {
	const dir = mkdtempSync(join(scratchRoot, "service-run-"));
	roots.push(dir);
	return dir;
}

test("SVC1 planted: two overlapping runs, the second exits SKIPPED-OVERLAP", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	expect(first.status).toBe("ACQUIRED");
	const second = acquireRunLock(dir, "load-watch", 1_001_000);
	expect(second.status).toBe("OVERLAP");
	if (second.status !== "OVERLAP") throw new Error("expected OVERLAP");
	expect(second.holderPid).toBe(process.pid);
	expect(OVERLAP_EXIT).toBe(4);
	if (first.status === "ACQUIRED") first.lock.release();
});

test("SVC1: release frees the job for the next run", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	if (first.status !== "ACQUIRED") throw new Error("expected ACQUIRED");
	first.lock.release();
	first.lock.release();
	const second = acquireRunLock(dir, "load-watch", 1_002_000);
	expect(second.status).toBe("ACQUIRED");
	if (second.status === "ACQUIRED") second.lock.release();
});

test("SVC1: a stale lock from a dead PID is broken", () => {
	const dir = jobsDir();
	forgeLockForTest(dir, "load-watch", 2147483647, 1_000_000);
	const next = acquireRunLock(dir, "load-watch", 1_001_000);
	expect(next.status).toBe("ACQUIRED");
	if (next.status === "ACQUIRED") next.lock.release();
});

test("SVC1: an ancient lock is broken even with an uncheckable holder", () => {
	const dir = jobsDir();
	forgeLockForTest(dir, "load-watch", 1, 1_000_000);
	const next = acquireRunLock(dir, "load-watch", 1_000_000 + 3 * 60 * 60 * 1000);
	expect(next.status).toBe("ACQUIRED");
	if (next.status === "ACQUIRED") next.lock.release();
});

test("SVC1: a live holder is never broken", () => {
	const dir = jobsDir();
	forgeLockForTest(dir, "load-watch", process.pid, Date.now());
	const next = acquireRunLock(dir, "load-watch", Date.now() + 1000);
	expect(next.status).toBe("OVERLAP");
	if (next.status !== "OVERLAP") throw new Error("expected OVERLAP");
	expect(next.holderPid).toBe(process.pid);
});

test("SVC1: a stale empty lock dir is broken", () => {
	const dir = jobsDir();
	const lock = join(dir, "load-watch.lock");
	mkdirSync(lock, { recursive: true, mode: 0o700 });
	utimesSync(lock, new Date(1_000_000), new Date(1_000_000));
	const next = acquireRunLock(dir, "load-watch", 1_000_000 + 120_000);
	expect(next.status).toBe("ACQUIRED");
	if (next.status === "ACQUIRED") next.lock.release();
});

test("SVC1: a fresh empty lock dir stays overlapped", () => {
	const dir = jobsDir();
	mkdirSync(join(dir, "load-watch.lock"), { recursive: true, mode: 0o700 });
	const next = acquireRunLock(dir, "load-watch", Date.now());
	expect(next.status).toBe("OVERLAP");
});


test("SVC1 planted: a run under high load writes SKIPPED-LOAD and does no work", () => {
	expect(LOAD_GATE_FACTOR).toBe(2.5);
	const verdict = gateRunLoad(87, 32);
	expect(verdict.proceed).toBe(false);
	if (verdict.proceed) throw new Error("expected skip");
	expect(verdict.status).toBe("SKIPPED-LOAD");
	expect(verdict.exit).toBe(SKIPPED_LOAD_EXIT);
	expect(verdict.detail).toContain("No work was done");
});

test("SVC1: a run under normal load proceeds", () => {
	expect(gateRunLoad(10, 32)).toEqual({ proceed: true });
	expect(gateRunLoad(80, 32).proceed).toBe(true);
});


test("SVC1: a fast run returns OK with elapsed time and output", async () => {
	const seen: string[][] = [];
	const exec: CapExec = {
		spawn: (argv) => {
			seen.push([...argv]);
			return { pid: 4242, wait: () => Promise.resolve({ code: 0, out: "ok\n" }), kill: () => {} };
		},
		sleep: () => new Promise<void>(() => {}),
		now: () => 0,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(seen).toEqual([["bun", "test"]]);
	expect(result.status).toBe("OK");
	if (result.status !== "OK") throw new Error("expected OK");
	expect(result.exit).toBe(0);
	expect(result.out).toBe("ok\n");
});

test("SVC1 planted: a slow run is killed at the cap and recorded TIMEOUT", async () => {
	let t = 0;
	let killed = false;
	let waited = false;
	const exec: CapExec = {
		spawn: () => ({
			pid: 4243,
			wait: () => {
				if (!killed) return new Promise<{ code: number | null; out: string }>(() => {});
				waited = true;
				return Promise.resolve({ code: null, out: "partial\n" });
			},
			kill: () => {
				killed = true;
			},
		}),
		sleep: (ms) => {
			t += ms;
			return Promise.resolve();
		},
		now: () => t,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(killed).toBe(true);
	expect(waited).toBe(true);
	expect(result.status).toBe("TIMEOUT");
	if (result.status !== "TIMEOUT") throw new Error("expected TIMEOUT");
	expect(result.exit).toBeNull();
	expect(result.elapsedMs).toBe(60000);
	expect(result.out).toBe("partial\n");
});

test("SVC1: a failing run reports FAILED with its exit", async () => {
	const exec: CapExec = {
		spawn: () => ({ pid: 4244, wait: () => Promise.resolve({ code: 3, out: "boom\n" }), kill: () => {} }),
		sleep: () => new Promise<void>(() => {}),
		now: () => 0,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(result.status).toBe("FAILED");
	if (result.status !== "FAILED") throw new Error("expected FAILED");
	expect(result.exit).toBe(3);
});