import { afterAll, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
import type { RunResult } from "../../src/kitlib/run.ts";

const WRAPPER = join(import.meta.dir, "../../scripts/kit-commit.py");
const CLI = join(import.meta.dir, "../../src/cli.ts");

function git(root: string, args: string[], env?: Record<string, string>): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", ...args], {
		cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore",
		env: { ...process.env, ...env },
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function fixture(label: string, hook: string | null): string {
	const root = realpathSync(ownedTmp(label).path);
	expect(git(root, ["init", "-q"]).code).toBe(0);
	expect(git(root, ["config", "user.email", "t@e.invalid"]).code).toBe(0);
	expect(git(root, ["config", "user.name", "t"]).code).toBe(0);
	if (hook !== null) {
		const hookPath = join(root, ".git", "hooks", "pre-commit");
		writeFileSync(hookPath, hook);
		chmodSync(hookPath, 0o755);
	}
	return root;
}

async function exitedText(proc: Subprocess): Promise<{ code: number; out: string; err: string }> {
	await proc.exited;
	const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: proc.exitCode, out, err };
}

/** Real-clock delay for integration waits below: the awaited conditions (a
 * lock file, a live wrapper process) exist only on the platform clock, so
 * fake timers cannot advance them. */
function delayMs(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll for a guaranteed event; the timeout only fires when the rig itself is broken, never on a race. */
async function pollFor(seen: () => boolean, timeoutMs: number, stepMs = 100): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		if (seen()) return true;
		if (Date.now() >= until) return false;
		await delayMs(stepMs);
	}
}

/** Live wrapper processes running this run's commits, matched by the checkout-unique wrapper path in their argv. */
function wrapperCount(cwd: string): number {
	const found = runFixture(["pgrep", "-f", WRAPPER], { cwd, floor_s: 10 });
	if (found.rc !== 0) return 0;
	return new TextDecoder().decode(found.stdout).trim().split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Hold a wrapper lock file from a fixture child with an exclusive flock until
 * the test writes the release file, so two wrapper commits spawned meanwhile
 * provably queue behind it. Resolves once the hold is up; the caller writes
 * the release file to let go and the holder exits itself before the release
 * resolves, so no abort handle or signal is needed.
 */
async function holdWrapperLock(lockPath: string, dir: string, label: string): Promise<() => Promise<void>> {
	const readyPath = join(dir, `${label}-ready`);
	const releasePath = join(dir, `${label}-release`);
	const pending = runFixtureAsync(["python3", "-c",
		"import fcntl,os,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); "
		+ "open(sys.argv[2],'w').write('held\\n'); end=time.time()+300\n"
		+ "while not os.path.exists(sys.argv[3]) and time.time()<end: time.sleep(0.1)", lockPath, readyPath, releasePath],
		{ cwd: dir, floor_s: 120 });
	pending.then(() => {}, () => {});
	const held = await pollFor(() => existsSync(readyPath), Math.round(fixtureDeadlineS(30) * 1000));
	expect(held).toBe(true);
	return async () => {
		writeFileSync(releasePath, "go\n");
		await pending.then(() => {}, () => {});
	};
}

/** Decode a settled fixture result. */
function decoded(finished: RunResult): { code: number; out: string; err: string } {
	expect(finished.timed_out).toBe(false);
	const text = new TextDecoder();
	return { code: finished.rc ?? 1, out: text.decode(finished.stdout), err: text.decode(finished.stderr) };
}

test("planted GITLOCK1: two concurrent wrapper commits queue behind a held lock and both land", async () => {
	const root = fixture("kit-commit-queue", null);
	const release = await holdWrapperLock(join(root, ".git", "omp-kit-commit.lock"), root, "queue");
	try {
		writeFileSync(join(root, "A"), "a1\n");
		writeFileSync(join(root, "B"), "b1\n");
		expect(git(root, ["add", "A", "B"]).code).toBe(0);
		const p1p = runFixtureAsync(["python3", WRAPPER, "commit", "--only", "A", "-m", "one [test]"], { cwd: root, floor_s: 60 });
		const p2p = runFixtureAsync(["python3", WRAPPER, "commit", "--only", "B", "-m", "two [test]"], { cwd: root, floor_s: 60 });
		// Both wrappers are alive while the test still holds the serializer:
		// neither can have passed it, so whichever acquires second queued.
		try {
			const both = await pollFor(() => wrapperCount(root) >= 2, Math.round(fixtureDeadlineS(60) * 1000));
			expect(both).toBe(true);
			// Grace after both wrappers are observed alive: a live wrapper still
			// runs imports and rev-parse before its first flock attempt, and that
			// prefix exists only on the platform clock.
			await delayMs(Math.round(fixtureDeadlineS(5) * 1000));
		} finally {
			await release();
		}
		const [r1, r2] = await Promise.all([p1p, p2p]).then(([a, b]) => [decoded(a), decoded(b)]);
		expect({ one: r1.code, two: r2.code }).toEqual({ one: 0, two: 0 });
		expect(r1.out + r1.err + r2.out + r2.err).not.toContain("index.lock");
		const log = git(root, ["log", "--format=%s"]);
		expect(log.code).toBe(0);
		expect(log.out).toContain("one [test]");
		expect(log.out).toContain("two [test]");
		expect(log.out.trim().split("\n")).toHaveLength(2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, Math.round(fixtureDeadlineS(300) * 1000));

test("planted GITLOCK1: without the serializer the same contended commit fails on index.lock", async () => {
	// Explicit barrier, not a sleep race: the first raw commit's hook holds
	// index.lock until the hold below expires, so the second raw commit's lock
	// attempt lands inside the hold by construction.
	const holdS = Math.ceil(fixtureDeadlineS(12));
	const root = fixture("kit-commit-raw-race", null);
	const barrier = join(root, "barrier");
	mkdirSync(barrier);
	writeFileSync(join(root, ".git", "hooks", "pre-commit"),
		`#!/bin/sh\nB="${barrier}"\nif [ -e "$B/arrived" ]; then exit 0; fi\n: > "$B/arrived"\nsleep ${holdS} | git update-index --stdin\n`);
	chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		writeFileSync(join(root, "B"), "b1\n");
		expect(git(root, ["add", "A", "B"]).code).toBe(0);
		const p1p = runFixtureAsync(["git", "commit", "--only", "A", "-m", "one [test]"], { cwd: root, floor_s: 60 });
		expect(await pollFor(() => existsSync(join(barrier, "arrived")), Math.round(fixtureDeadlineS(30) * 1000))).toBe(true);
		expect(await pollFor(() => existsSync(join(root, ".git", "index.lock")), Math.round(fixtureDeadlineS(30) * 1000))).toBe(true);
		const r2 = decoded(await runFixtureAsync(["git", "commit", "--only", "B", "-m", "two [test]"], { cwd: root, floor_s: 60 }));
		expect(r2.code).not.toBe(0);
		expect(r2.out + r2.err).toContain("index.lock");
		const r1 = decoded(await p1p);
		expect(r1.code).toBe(0);
		const log = git(root, ["log", "--format=%s"]);
		expect(log.code).toBe(0);
		expect(log.out).toContain("one [test]");
		expect(log.out).not.toContain("two [test]");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, Math.round(fixtureDeadlineS(300) * 1000));

test("planted GITLOCK1: a live lock holder is never reaped by a failed wrapper commit", async () => {
	const root = fixture("kit-commit-live-holder", null);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);

		// The holder keeps update-index blocked on an open pipe, so it holds
		// index.lock; writing the release file lets it exit cleanly by itself.
		const releasePath = join(root, "holder-release");
		const pending = runFixtureAsync(["python3", "-c",
			"import os,subprocess,sys,time; p=subprocess.Popen(['git','update-index','--stdin'],stdin=subprocess.PIPE); "
			+ "end=time.time()+300\n"
			+ "while not os.path.exists(sys.argv[1]) and time.time()<end: time.sleep(0.1)",
			releasePath], { cwd: root, floor_s: 120 });
		pending.then(() => {}, () => {});
		try {
			const lock = join(root, ".git", "index.lock");
			expect(await pollFor(() => existsSync(lock), Math.round(fixtureDeadlineS(30) * 1000))).toBe(true);
			const result = decoded(runFixture(["python3", WRAPPER, "--retries", "0", "commit", "-m", "held [test]"], { cwd: root, floor_s: 60 }));
			expect(result.code).not.toBe(0);
			expect(result.out + result.err).toContain("index.lock");
			// The live holder's lock is untouched: never moved aside, never unlinked.
			expect(existsSync(lock)).toBe(true);
			expect(git(root, ["rev-parse", "--verify", "HEAD"]).code).not.toBe(0);
		} finally {
			writeFileSync(releasePath, "go\n");
			await pending.then(() => {}, () => {});
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, Math.round(fixtureDeadlineS(180) * 1000));

test("planted GITLOCK1: a wrapper commit preserves peer staged and worktree bytes", async () => {
	const root = fixture("kit-commit-peer", null);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		writeFileSync(join(root, "peer.txt"), "peer staged\n");
		writeFileSync(join(root, "work.txt"), "work bytes\n");
		expect(git(root, ["add", "A", "peer.txt"]).code).toBe(0);
		const result = decoded(runFixture(["python3", WRAPPER, "commit", "--only", "A", "-m", "one [test]"], { cwd: root, floor_s: 60 }));
		expect(result.code).toBe(0);
		// The unrelated staged entry is still staged; the commit holds only A.
		const staged = git(root, ["diff", "--cached", "--name-only"]);
		expect(staged.code).toBe(0);
		expect(staged.out.trim().split("\n")).toEqual(["peer.txt"]);
		const show = git(root, ["show", "--name-only", "--format=", "HEAD"]);
		expect(show.code).toBe(0);
		expect(show.out.trim().split("\n")).toEqual(["A"]);
		expect(readFileSync(join(root, "work.txt"), "utf8")).toBe("work bytes\n");
		expect(git(root, ["status", "--porcelain"]).out).toContain("?? work.txt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, Math.round(fixtureDeadlineS(120) * 1000));

test("planted GITLOCK1: --repo commits in the named checkout regardless of caller cwd", async () => {
	const root = fixture("kit-commit-repo", null);
	const elsewhere = realpathSync(ownedTmp("kit-commit-elsewhere").path);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);
		const ok = decoded(runFixture(["python3", WRAPPER, "--repo", root, "commit", "-m", "via repo [test]"], { cwd: elsewhere, floor_s: 60 }));
		expect(ok.code).toBe(0);
		expect(git(root, ["log", "--format=%s"]).out).toContain("via repo [test]");
		const bad = decoded(runFixture(["python3", WRAPPER, "--repo", join(root, "missing"), "commit", "-m", "x [test]"], { cwd: elsewhere, floor_s: 60 }));
		expect(bad.code).not.toBe(0);
		expect(bad.out + bad.err).toContain("cannot enter --repo");
		expect(git(root, ["log", "--format=%s"]).out).not.toContain("x [test]");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
	}
}, Math.round(fixtureDeadlineS(120) * 1000));

test("planted GITLOCK1: commit TERM-killed during its pre-commit hook leaves no index.lock", async () => {
	// The lock appears only after python3, the wrapper, git and the hook have started. The 2026-11-04
	// b9e77980c8 verdict (load1 17-22 on 32 cores) ran out the old fixed 100 x 100 ms wait (10196 ms,
	// lock not yet present). The wait and the hook's hold scale with load; the hold stays three times
	// the wait so the lock is still held when the kill lands.
	const waitS = fixtureDeadlineS(10);
	const root = fixture("kit-commit-killed", `#!/bin/sh\n# Hold .git/index.lock like a hook-spawned git command (the outer\n# commit itself holds no lock during hooks on modern git): sleep keeps the\n# stdin pipe open so update-index blocks holding the lock.\nsleep ${Math.ceil(waitS * 3)} | git update-index --stdin\n`);
	const shim = realpathSync(ownedTmp("kit-commit-shim").path);
	try {
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);
		// PATH omp-kit delegating to the workspace CLI, so the wrapper's
		// termination path exercises graceful child shutdown and the gated reaper.
		const ompKit = join(shim, "omp-kit");
		writeFileSync(ompKit, `#!/bin/sh\nexec "${process.execPath}" run "${CLI}" "$@"\n`);
		chmodSync(ompKit, 0o755);
		const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, HOME: root };
		const proc = Bun.spawn(["python3", WRAPPER, "commit", "-m", "killed [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const lock = join(root, ".git", "index.lock");
		// Live git holder: fake timers cannot work, the lock appears on the platform clock.
		const { promise: appeared, resolve: markAppeared } = Promise.withResolvers<void>();
		const poll = async () => {
			const until = Date.now() + waitS * 1000;
			while (Date.now() < until && !existsSync(lock)) await new Promise((resolve) => setTimeout(resolve, 100));
			markAppeared();
		};
		await poll();
		await appeared;
		expect(existsSync(lock)).toBe(true);
		proc.kill("SIGTERM");
		const result = await exitedText(proc);
		expect(result.code).toBe(143);
		expect(existsSync(lock)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(shim, { recursive: true, force: true });
	}
}, fixtureDeadlineS(120) * 1000);

test("planted GITLOCK1: one transient lock collision is retried, not surfaced", async () => {
	const root = fixture("kit-commit-retry", null);
	const shim = realpathSync(ownedTmp("kit-commit-gitshim").path);
	try {
		const realGit = Bun.spawnSync(["sh", "-c", "command -v git"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" }).stdout.toString().trim();
		expect(realGit).not.toBe("");
		writeFileSync(join(root, "A"), "a1\n");
		expect(git(root, ["add", "A"]).code).toBe(0);
		// PATH git fails the first commit with git's lock text, then delegates.
		writeFileSync(join(shim, "git"), `#!/bin/sh
if [ "$1" = "commit" ] && [ ! -e "${shim}/failed-once" ]; then
  touch "${shim}/failed-once"
  echo "error: Unable to create '${root}/.git/index.lock': File exists" >&2
  exit 128
fi
echo "git $*" >> "${shim}/calls.log"
exec "${realGit}" "$@"
`);
		chmodSync(join(shim, "git"), 0o755);
		const env = { ...process.env, PATH: `${shim}:${process.env.PATH}` };
		const proc = Bun.spawn(["python3", WRAPPER, "--retries", "1", "commit", "-m", "retried [test]"], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
		const result = await exitedText(proc);
		expect(result.code).toBe(0);
		expect(result.out + result.err).not.toContain("index.lock");
		const calls = readFileSync(join(shim, "calls.log"), "utf8").split("\n").filter((line) => line.startsWith("git commit"));
		expect(calls.length).toBe(1);
		expect(existsSync(join(shim, "failed-once"))).toBe(true);
		expect(git(root, ["log", "--format=%s"]).out).toContain("retried [test]");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(shim, { recursive: true, force: true });
	}
}, 120_000);

afterAll(() => cleanupAllOwnedTmp());
