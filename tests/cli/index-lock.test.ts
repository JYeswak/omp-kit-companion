import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
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


test("dry-run reports a stale holder-less empty lock without moving it", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const before = statSync(lock);
		const first = maybeMoveStaleIndexLock(gitDir, {
			run: clearRun, staleAfterMs: AGE, dryRun: true,
			nowMs: () => Date.now(),
		});
		expect(first.verdict).toBe("WOULD_MOVE");
		expect(first.receipt?.lock).toBe(lock);
		expect(first.receipt?.sizeBytes).toBe(0);
		expect(first.receipt?.staleAfterMs).toBe(AGE);
		expect(first.receipt?.dev).toBe(before.dev);
		expect(first.receipt?.ino).toBe(before.ino);
		expect(first.receipt?.sizeBytes).toBe(before.size);
		expect(first.receipt?.mtimeMs).toBe(before.mtimeMs);
		expect(existsSync(lock)).toBe(true);
		expect(readdirSync(gitDir).some(name => name.startsWith("index.lock.stale-"))).toBe(false);
		const second = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE, dryRun: true });
		expect(second.verdict).toBe("WOULD_MOVE");
		expect(statSync(lock).ino).toBe(before.ino);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("only literal dryRun true is allowed; every other value refuses without probing or changing the lock", () => {
	const modes: Array<{ includeDryRun: boolean; value?: unknown }> = [
		{ includeDryRun: false },
		{ includeDryRun: true, value: false },
		{ includeDryRun: true, value: null },
		{ includeDryRun: true, value: "yes" },
	];
	for (const mode of modes) {
		const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
		try {
			const before = statSync(lock);
			let probes = 0;
			const deps = {
				run: () => { probes++; return clearRun(); },
				staleAfterMs: AGE,
				...(mode.includeDryRun ? { dryRun: mode.value as boolean } : {}),
			};
			const result = maybeMoveStaleIndexLock(gitDir, deps);
			expect(result.verdict).toBe("APPLY_REFUSED");
			expect(probes).toBe(0);
			expect(existsSync(lock)).toBe(true);
			const after = statSync(lock);
			expect(after.ino).toBe(before.ino);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(existsSync(join(gitDir, ".omp-kit-index-lock-mover"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	const { gitDir, root } = gitDirWithLock(AGE + 1000, "");
	try {
		expect(maybeMoveStaleIndexLock(join(gitDir, "missing"), { run: clearRun }).verdict).toBe("APPLY_REFUSED");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}

});

test("lock replacement during lsof probe is not renamed", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const result = maybeMoveStaleIndexLock(gitDir, {
			run: () => {
				rmSync(lock);
				writeFileSync(lock, "live index writer");
				return clearRun();
			},
			staleAfterMs: AGE,
			dryRun: true,
		});
		expect(["CHANGED", "UNKNOWN"]).toContain(result.verdict);
		expect(existsSync(lock)).toBe(true);
		expect(statSync(lock).size).toBeGreaterThan(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("lock removed during lsof probe is not renamed", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const result = maybeMoveStaleIndexLock(gitDir, {
			run: () => {
				rmSync(lock);
				return clearRun();
			},
			staleAfterMs: AGE,
			dryRun: true,
		});
		expect(["CHANGED", "UNKNOWN"]).toContain(result.verdict);
		expect(readdirSync(gitDir).some(name => name.startsWith("index.lock.stale-"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});


test("scratch index-lock --apply is refused without moving the lock", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const result = Bun.spawnSync([process.execPath, "run", join(import.meta.dir, "../../src/cli.ts"),
			"scratch", "index-lock", "--repo", root, "--apply", "--yes", "--json"], {
			cwd: root,
			env: { ...process.env, HOME: root, OMP_KIT_INDEX_LOCK_STALE_MS: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const envelope = JSON.parse(result.stdout.toString()) as { data?: { verdict?: string; receipt?: unknown } };
		expect(result.exitCode).toBe(1);
		expect(envelope.data?.verdict).toBe("APPLY_REFUSED");
		expect(envelope.data?.receipt).toBeNull();
		expect(existsSync(lock)).toBe(true);
		expect(readdirSync(gitDir).some(name => name.startsWith("index.lock.stale-"))).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a second mover for the same repository reports BUSY", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	let secondVerdict: string | undefined;
	const guardPath = join(gitDir, ".omp-kit-index-lock-mover");
	try {
		const first = maybeMoveStaleIndexLock(gitDir, {
			run: () => {
				secondVerdict = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE, dryRun: true }).verdict;
				return clearRun();
			},
			staleAfterMs: AGE,
			dryRun: true,
		});
		expect(first.verdict).toBe("WOULD_MOVE");
		expect(secondVerdict).toBe("BUSY");
		expect(first.receipt?.guardPath).toBe(guardPath);
		expect(existsSync(guardPath)).toBe(false);
		expect(existsSync(lock)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("empty holder-less lock younger than configured age is untouched (removing the age check fails this)", () => {
	const { gitDir, lock, root } = gitDirWithLock(1000, "");
	try {
		const before = Bun.file(lock);
		const result = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE, dryRun: true });
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
		const result = maybeMoveStaleIndexLock(gitDir, { run: clearRun, staleAfterMs: AGE, dryRun: true });
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
		const result = maybeMoveStaleIndexLock(gitDir, { run: held, staleAfterMs: AGE, dryRun: true });
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
			expect(maybeMoveStaleIndexLock(gitDir, { run, staleAfterMs: AGE, dryRun: true }).verdict).toBe("UNKNOWN");
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

test("real repo: git holding index.lock blocks; after kill, dry-run reports without moving it", async () => {
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
		expect(maybeMoveStaleIndexLock(join(root, ".git"), { run: realRun, staleAfterMs: 0, dryRun: true }).verdict).toBe("HELD");
		holder.kill(9);
		await holder.exited;
		expect(existsSync(lockPath)).toBe(true);
		expect(statSync(lockPath).size).toBe(0);
		const before = statSync(lockPath);
		const report = maybeMoveStaleIndexLock(join(root, ".git"), { run: realRun, staleAfterMs: 0, dryRun: true });
		expect(report.verdict).toBe("WOULD_MOVE");
		expect(report.receipt?.lock).toBe(lockPath);
		expect(existsSync(lockPath)).toBe(true);
		expect(statSync(lockPath).ino).toBe(before.ino);
		expect(statSync(lockPath).mtimeMs).toBe(before.mtimeMs);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 120_000);
