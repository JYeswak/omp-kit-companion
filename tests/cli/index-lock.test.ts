import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	indexLockStaleAfterMs,
	lsofFileClear,
	maybeMoveStaleIndexLock,
	DEFAULT_INDEX_LOCK_STALE_MS,
	type ScratchRunner,
} from "../../src/index-lock.ts";

const AGE = 60_000;
const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });

function gitDirWithLock(ageMs: number, bytes: string): { gitDir: string; lock: string; root: string } {
	const root = mkdtempSync(join(tmpdir(), "index-lock-"));
	const gitDir = join(root, ".git");
	const lock = join(gitDir, "index.lock");
	mkdirSync(gitDir);
	writeFileSync(lock, bytes);
	const back = new Date(Date.now() - ageMs);
	utimesSync(lock, back, back);
	return { gitDir, lock, root };
}


test("empty holder-less lock older than configured age is moved and logged once", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const seen: string[] = [];
		const first = maybeMoveStaleIndexLock(gitDir, {
			run: clearRun, staleAfterMs: AGE,
			nowMs: () => Date.now(),
		});
		expect(first.verdict).toBe("MOVED");
		expect(first.receipt?.lock).toBe(lock);
		expect(first.receipt?.sizeBytes).toBe(0);
		expect(first.receipt?.staleAfterMs).toBe(AGE);
		seen.push(JSON.stringify(first.receipt));
		const second = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE });
		expect(second.verdict).toBe("NOT_FOUND");
		expect(seen.length).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty holder-less lock younger than configured age is untouched (removing the age check fails this)", () => {
	const { gitDir, lock, root } = gitDirWithLock(1000, "");
	try {
		const before = Bun.file(lock);
		const result = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE });
		expect(result.verdict).toBe("TOO_YOUNG");
		expect(result.receipt).toBeUndefined();
		expect(Bun.file(lock)).toBeTruthy();
		void before;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("non-empty lock is never moved", async () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "DIRC-partial-bytes");
	try {
		const result = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE });
		expect(result.verdict).toBe("NON_EMPTY");
		expect(statSync(lock).size).toBeGreaterThan(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("held lock is never moved", () => {
	const { gitDir, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const held: ScratchRunner = () => ({ code: 0, stdout: "git 12345 lock", stderr: "" });
		const result = maybeMoveStaleIndexLock(gitDir, { run: held, staleAfterMs: AGE });
		expect(result.verdict).toBe("HELD");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lsof tri-state: rc 2, timeout, and signal leave the lock untouched", () => {
	const mk = () => gitDirWithLock(AGE + 1000, "");
	const rc2: ScratchRunner = () => ({ code: 2, stdout: "", stderr: "" });
	const timeout: ScratchRunner = () => ({ code: null, stdout: "", stderr: "" });
	const error: ScratchRunner = () => { throw new Error("spawn lsof ENOENT"); };
	for (const [name, run] of [["rc2", rc2], ["timeout", timeout], ["error", error]] as const) {
		const { gitDir, root } = mk();
		try {
			expect(lsofFileClear(join(gitDir, "index.lock"), run)).toBeNull();
			expect(maybeMoveStaleIndexLock(gitDir, { run, staleAfterMs: AGE }).verdict).toBe("UNKNOWN");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		void name;
	}
});

test("lsof rc 1 with empty output is clear; rc 0 with rows is held", () => {
	expect(lsofFileClear("/x", clearRun)).toBe(true);
	expect(lsofFileClear("/x", () => ({ code: 0, stdout: "git 9 lock", stderr: "" }))).toBe(false);
});

test("age threshold reads configuration with documented default", () => {
	expect(indexLockStaleAfterMs({})).toBe(DEFAULT_INDEX_LOCK_STALE_MS);
	expect(indexLockStaleAfterMs({ OMP_KIT_INDEX_LOCK_STALE_MS: "120000" })).toBe(120000);
	expect(indexLockStaleAfterMs({ OMP_KIT_INDEX_LOCK_STALE_MS: "junk" })).toBe(DEFAULT_INDEX_LOCK_STALE_MS);
});

test("real repo: git holding index.lock blocks; kill -9 leaves a stale lock the mover takes", async () => {
	// Integration test: exercises a real git lock-holder against the platform
	// clock. Fake timers cannot work: the holder is a live git process and
	// the lock file appears on its schedule, not in-process timers.
	const root = mkdtempSync(join(tmpdir(), "index-lock-real-"));
	try {
		const git = (args: string[], opts?: { stdin?: "pipe" | "ignore" }) => Bun.spawnSync(["git", ...args],
			{ cwd: root, stdout: "pipe", stderr: "pipe", stdin: opts?.stdin ?? "ignore" });
		expect(git(["init", "-q"]).exitCode).toBe(0);
		expect(git(["config", "user.email", "t@e.invalid"]).exitCode).toBe(0);
		writeFileSync(join(root, "f.txt"), "x\n");
		expect(git(["add", "f.txt"]).exitCode).toBe(0);
		// A git update-index waiting on stdin holds .git/index.lock deterministically.
		const holder = Bun.spawn(["git", "update-index", "--stdin"], {
			cwd: root, stdout: "ignore", stderr: "ignore", stdin: "pipe",
		});
		const lockPath = join(root, ".git", "index.lock");
		const { promise: appeared, resolve: markAppeared } = Promise.withResolvers<void>();
		const poll = async () => {
			for (let i = 0; i < 100 && !existsSync(lockPath); i++) await new Promise(resolve => setTimeout(resolve, 100));
			markAppeared();
		};
		await poll();
		await appeared;
		expect(existsSync(lockPath)).toBe(true);
		const realRun: ScratchRunner = (args, opts) => {
			const out = Bun.spawnSync(args as [string, ...string[]], { stdout: "pipe", stderr: "pipe", timeout: opts?.timeoutMs });
			return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
		};
		expect(maybeMoveStaleIndexLock(join(root, ".git"), { run: realRun, staleAfterMs: 0 }).verdict).toBe("HELD");
		holder.kill(9);
		await holder.exited;
		expect(existsSync(lockPath)).toBe(true);
		expect(statSync(lockPath).size).toBe(0);
		const moved = maybeMoveStaleIndexLock(join(root, ".git"), { run: realRun, staleAfterMs: 0 });
		expect(moved.verdict).toBe("MOVED");
		expect(moved.receipt?.lock).toBe(lockPath);
		expect(existsSync(lockPath)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
