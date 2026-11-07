import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
import {
	indexLockStaleAfterMs,
	lsofFileClear,
	maybeMoveStaleIndexLock,
	reapStaleIndexLock,
	reportOrphanedGitHelpers,
	type LockHolder,
	DEFAULT_INDEX_LOCK_STALE_MS,
	type ScratchRunner,
} from "../../src/index-lock.ts";

const AGE = 60_000;
const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });

function gitDirWithLock(ageMs: number, bytes: string): { gitDir: string; lock: string; root: string } {
	const root = realpathSync(ownedTmp("index-lock").path);
	const gitDir = join(root, ".git");
	const lock = join(gitDir, "index.lock");
	mkdirSync(gitDir);
	writeFileSync(lock, bytes);
	const back = new Date(Date.now() - ageMs);
	utimesSync(lock, back, back);
	return { gitDir, lock, root };
}

// INDEXLOCKHELD1: lsof calls both the git dispatcher for remote-https and git blame
// `cgit`; only argv distinguishes them from an index-writing command.
function processRunner(root: string, command: string, fileHeld = false): ScratchRunner {
	return args => {
		if (args[0] === "ps") return { code: 0,
			stdout: `95888 1 S 01:00:00 Tue Nov 3 18:13:10 2026 ${command}\n`, stderr: "" };
		return args.includes("-c") || fileHeld
			? { code: 0, stdout: `p95888\ncgit\nfcwd\nn${root}\n`, stderr: "" }
			: clearRun();
	};
}

for (const command of ["git remote-https origin https://example.invalid/repo", "git fetch-pack origin",
	"git blame f.txt", "git log", "git show HEAD"]) {
	test(`INDEXLOCKHELD1 stale empty lock is reaped despite ${command}`, () => {
		const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
		try {
			const result = reapStaleIndexLock(gitDir, { run: processRunner(root, command), staleAfterMs: AGE });
			expect(result.verdict).toBe("REAPED");
			expect(existsSync(lock)).toBe(false);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}

test("INDEXLOCKHELD1 live index writer without an open fd blocks plan and reap with pid and command", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const run = processRunner(root, "git -c core.fsmonitor=false commit -m fixture");
		for (const result of [
			maybeMoveStaleIndexLock(gitDir, { run, staleAfterMs: AGE, dryRun: true }),
			reapStaleIndexLock(gitDir, { run, staleAfterMs: AGE }),
		]) {
			expect(result).toMatchObject({ verdict: "HELD", holders: [{
				pid: 95888, command: "git -c core.fsmonitor=false commit -m fixture", reason: "index-writer",
			}] });
		}
		expect(existsSync(lock)).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("INDEXLOCKHELD1 open lock fd blocks even a read-only command and names the holder", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const run = processRunner(root, "git blame f.txt", true);
		for (const result of [
			maybeMoveStaleIndexLock(gitDir, { run, staleAfterMs: AGE, dryRun: true }),
			reapStaleIndexLock(gitDir, { run, staleAfterMs: AGE }),
		]) expect(result).toMatchObject({ verdict: "HELD",
			holders: [{ pid: 95888, command: "git blame f.txt", reason: "open-file" }] });
		expect(existsSync(lock)).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
test("INDEXLOCKHELD1 reports old orphan network helpers, never readers or young/non-orphan helpers", () => {
	const { root } = gitDirWithLock(AGE + 1000, "");
	try {
		const command = "git remote-https origin https://example.invalid/repo";
		expect(reportOrphanedGitHelpers(root, processRunner(root, command))).toMatchObject({
			status: "OK", helpers: [{ pid: 95888, ppid: 1, startedAt: "Tue Nov 3 18:13:10 2026", ageSeconds: 3600, command }],
		});
		for (const replacement of ["95888 2 S 01:00:00", "95888 1 S 30:00", "95888 1 Z 01:00:00"]) {
			const runner = processRunner(root, command);
			expect(reportOrphanedGitHelpers(root, (args, opts) => {
				const out = runner(args, opts);
				return args[0] === "ps" ? { ...out, stdout: out.stdout.replace("95888 1 S 01:00:00", replacement) } : out;
			})).toEqual({ status: "OK", helpers: [] });
		}
		expect(reportOrphanedGitHelpers(root, processRunner(root, "git blame f.txt")).helpers).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("INDEXLOCKHELD1 unknown argv or unreadable process evidence preserves the lock without inventing a holder", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		for (const command of ["git custom-alias", "git -c", "git -C /space path commit", "git " + "x".repeat(65_536)]) {
			expect(reapStaleIndexLock(gitDir, { run: processRunner(root, command), staleAfterMs: AGE }).verdict).toBe("UNKNOWN");
			expect(existsSync(lock)).toBe(true);
		}
		const runner = processRunner(root, "git add f.txt");
		expect(reapStaleIndexLock(gitDir, { run: (args, opts) => args[0] === "ps"
			? { code: null, stdout: "", stderr: "" } : runner(args, opts), staleAfterMs: AGE }).verdict).toBe("UNKNOWN");
		expect(existsSync(lock)).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("INDEXLOCKHELD1 writer in a worktree subdirectory counts; sibling worktree does not", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		expect(reapStaleIndexLock(gitDir, { run: processRunner(join(root, "subdir"), "git add f.txt"),
			staleAfterMs: AGE })).toMatchObject({ verdict: "HELD", holders: [{ pid: 95888, reason: "index-writer" }] });
		expect(reapStaleIndexLock(gitDir, { run: processRunner(`${root}-other`, "git add f.txt"),
			staleAfterMs: AGE }).verdict).toBe("REAPED");
		expect(existsSync(lock)).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});



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
		const result = runFixture([process.execPath, "run", join(import.meta.dir, "../../src/cli.ts"),
			"scratch", "index-lock", "--repo", root, "--apply", "--yes", "--json"], {
			cwd: root, env: { ...process.env, HOME: root, OMP_KIT_INDEX_LOCK_STALE_MS: "1" },
		});
		const envelope = JSON.parse(new TextDecoder().decode(result.stdout)) as { data?: { verdict?: string; receipt?: unknown } };
		expect(result.rc).toBe(1);
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
		const held = processRunner(root, "git update-index --stdin", true);
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
	expect(lsofFileClear("/x", processRunner("/x", "git update-index --stdin", true))).toBe(false);
});

test("age threshold reads configuration with documented default", () => {
	expect(indexLockStaleAfterMs({})).toBe(DEFAULT_INDEX_LOCK_STALE_MS);
	expect(indexLockStaleAfterMs({ OMP_KIT_INDEX_LOCK_STALE_MS: "120000" })).toBe(120000);
	expect(indexLockStaleAfterMs({ OMP_KIT_INDEX_LOCK_STALE_MS: "junk" })).toBe(DEFAULT_INDEX_LOCK_STALE_MS);
});

// Native git/lsof and the helper's HTTP request run outside this VM; fake timers cannot advance their readiness.
async function waitForFixture(ready: () => boolean): Promise<void> {
	const deadline = Date.now() + fixtureDeadlineS() * 1000;
	while (!ready()) {
		if (Date.now() >= deadline) throw new Error("fixture did not become ready before its deadline");
		await Bun.sleep(20);
	}
}

test("INDEXLOCKHELD1 live git add holds an empty lock; plan and reap name its exact pid", async () => {
	const root = realpathSync(ownedTmp("index-lock-writer").path);
	const env = { ...process.env, HOME: root, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
	expect(runFixture(["git", "init", "-q"], { cwd: root, env }).rc).toBe(0);
	writeFileSync(join(root, "f.txt"), "x\n");
	writeFileSync(join(root, ".gitattributes"), "f.txt filter=hold\n");
	const ready = join(root, ".git", "writer.ready"), stop = join(root, ".git", "writer.stop");
	writeFileSync(join(root, ".git", "hold-clean.py"), [
		"import os, sys, time",
		"from pathlib import Path",
		"Path('.git/writer.ready').write_text(str(os.getppid()))",
		"deadline = time.monotonic() + float(sys.argv[1])",
		"while not Path('.git/writer.stop').exists():",
		"    if time.monotonic() >= deadline: raise TimeoutError('filter fixture expired')",
		"    time.sleep(0.02)",
		"sys.stdout.buffer.write(sys.stdin.buffer.read(65536))",
	].join("\n"));
	const writer = runFixtureAsync(["git", "-c", `filter.hold.clean=exec python3 .git/hold-clean.py ${fixtureDeadlineS()}`,
		"add", "f.txt"], { cwd: root, env });
	try {
		await waitForFixture(() => existsSync(ready));
		const pid = Number(readFileSync(ready, "utf8"));
		const lock = join(root, ".git", "index.lock");
		expect(statSync(lock).size).toBe(0);
		for (const flags of [[], ["--reap", "--yes"]]) {
			const result = reapCli(root, [...flags, "--min-age-ms", "0", "--ledger", join(root, "ledger.jsonl")]);
			const observation = result.data.results?.find(row => row.file === lock) ?? result.data;
			expect(observation.verdict).toBe("HELD");
			expect(observation.holders?.some(holder => holder.pid === pid && holder.command.endsWith("add f.txt"))).toBe(true);
			expect(existsSync(lock)).toBe(true);
		}
		expect(existsSync(join(root, "ledger.jsonl"))).toBe(false);
	} finally {
		writeFileSync(stop, "");
		const result = await writer;
		rmSync(root, { recursive: true, force: true });
		expect(result.rc).toBe(0);
	}
}, fixtureDeadlineS() * 1000);

test("INDEXLOCKHELD1 live remote-https cannot hold a stale lock by worktree cwd alone", async () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	expect(runFixture(["git", "init", "-q"], { cwd: root, env: { ...process.env, GIT_CEILING_DIRECTORIES: root } }).rc).toBe(0);
	const response = Promise.withResolvers<Response>();
	let requested = false;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
		fetch: () => { requested = true; return response.promise; } });
	const helper = runFixtureAsync(["git", "remote-https", "origin", `http://127.0.0.1:${server.port}/repo`], {
		cwd: root, stdin: "list\n", env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	});
	try {
		await waitForFixture(() => requested);
		const plan = reapCli(root, ["--min-age-ms", String(AGE)]);
		expect(plan.data.verdict).toBe("WOULD_MOVE");
		expect(existsSync(lock)).toBe(true);
		const reap = reapCli(root, ["--reap", "--yes", "--min-age-ms", String(AGE), "--ledger", join(root, "ledger.jsonl")]);
		expect(reap.data.results?.find(row => row.file === lock)?.verdict).toBe("REAPED");
		expect(existsSync(lock)).toBe(false);
		expect(readdirSync(gitDir).some(name => name.startsWith("index.lock.stale-"))).toBe(true);
	} finally {
		response.resolve(new Response("fixture complete", { status: 500 }));
		await helper;
		server.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}, fixtureDeadlineS() * 1000);

// REAPCLI1 (ompkit-fp72.19.1.9.1): `scratch index-lock --reap --yes` runs the gated reaper the help documents; it used to
// print WOULD_MOVE from the dry-run reporter and move nothing (jev's lock sat 7 days, 2026-11-01).
interface LockCliObservation { verdict?: string; holders?: LockHolder[] }
function reapCli(root: string, extra: string[]): { code: number; data: LockCliObservation & {
	overall?: string; results?: Array<LockCliObservation & { file: string }>; ledger?: string | null;
} } {
	const result = runFixture([process.execPath, "run", join(import.meta.dir, "../../src/cli.ts"),
		"scratch", "index-lock", "--repo", root, ...extra, "--json"], { cwd: root, env: { ...process.env, HOME: root } });
	const envelope = JSON.parse(new TextDecoder().decode(result.stdout));
	return { code: result.rc ?? -1, data: envelope.data };
}

test("REAPCLI1 --reap --yes renames a stale holder-less empty lock aside with one ledger receipt", () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	const ledger = join(root, "reap-ledger.jsonl");
	try {
		const out = reapCli(root, ["--reap", "--yes", "--min-age-ms", String(AGE), "--ledger", ledger]);
		expect(out.code).toBe(0);
		expect(out.data.overall).toBe("CHANGED");
		expect(out.data.results?.find(r => r.file === lock)?.verdict).toBe("REAPED");
		expect(existsSync(lock)).toBe(false);
		expect(readdirSync(gitDir).filter(name => name.startsWith("index.lock.stale-"))).toHaveLength(1);
		const rows = readFileSync(ledger, "utf8").trim().split("\n").map(line => JSON.parse(line) as { kind: string; lock: string });
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "GITLOCK_REAPED", lock });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("REAPCLI1 planted: a lock held open by a live process stays in place and reports HELD; no ledger row", async () => {
	const { gitDir, lock, root } = gitDirWithLock(AGE + 1000, "");
	const ledger = join(root, "reap-ledger.jsonl");
	const ready = join(root, "holder.ready");
	const stop = join(root, "holder.stop");
	const holder = runFixtureAsync(["sh", "-c", 'exec 3<"$1"; printf "%s" "$$" > "$2"; while [ ! -e "$3" ]; do sleep 0.1; done', "holder", lock, ready, stop], { cwd: root });
	try {
		// A real separate process must hold the fd (lsof is the gate under test); poll for its ready file, no fixed wait.
		await waitForFixture(() => existsSync(ready));
		const out = reapCli(root, ["--reap", "--yes", "--min-age-ms", String(AGE), "--ledger", ledger]);
		expect(out.code).toBe(0);
		expect(out.data.results?.find(r => r.file === lock)?.verdict).toBe("HELD");
		expect(out.data.results?.find(r => r.file === lock)?.holders).toContainEqual({
			pid: Number(readFileSync(ready, "utf8")),
			command: expect.stringContaining("holder"),
			reason: "open-file",
		});
		expect(existsSync(lock)).toBe(true);
		expect(readdirSync(gitDir).some(name => name.startsWith("index.lock.stale-"))).toBe(false);
		expect(existsSync(ledger)).toBe(false);
	} finally {
		writeFileSync(stop, "");
		await holder;
		rmSync(root, { recursive: true, force: true });
	}
}, fixtureDeadlineS() * 1000);

test("REAPCLI1 --reap without --yes stays a dry-run report; a lock younger than --min-age-ms is TOO_YOUNG and stays", () => {
	const { lock, root } = gitDirWithLock(AGE + 1000, "");
	try {
		const dry = reapCli(root, ["--reap", "--min-age-ms", String(AGE)]);
		expect(dry.code).toBe(0);
		expect(dry.data.verdict).toBe("WOULD_MOVE");
		expect(existsSync(lock)).toBe(true);
		const young = reapCli(root, ["--reap", "--yes", "--min-age-ms", String(10 * AGE), "--ledger", join(root, "l.jsonl")]);
		expect(young.code).toBe(0);
		expect(young.data.results?.find(r => r.file === lock)?.verdict).toBe("TOO_YOUNG");
		expect(existsSync(lock)).toBe(true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

afterAll(() => cleanupAllOwnedTmp());
