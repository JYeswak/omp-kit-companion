import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireRunLock, forgeLockForTest, OVERLAP_EXIT } from "../../src/service-run.ts";

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
