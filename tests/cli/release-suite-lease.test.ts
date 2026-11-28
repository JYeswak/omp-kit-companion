import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
import { gitFixtureEnv, ROOT } from "./release-fixture.ts";

afterAll(cleanupAllOwnedTmp);

// SUITESERIAL1 (ompkit-fp72.120.16.264): one full suite at a time machine-wide, whatever launched it. Every case runs the
// real judge (scripts/full-suite-verdict.sh, or land's archived copy of it) on a fixture repository whose whole declared
// suite is stub python files that mark when they start and end, with an isolated verdict store and lease dir; the real
// suite never runs. Suite overlap is read from those marks and from the verdict records' per-file started_ms/finished_ms.
{
	const judge = join(ROOT, "scripts/full-suite-verdict.sh");
	const decoder = new TextDecoder();
	type LeaseFixture = { work: string; repo: string; marks: string; lease: string; store: string; env: Record<string, string> };
	type Launch = { done: Promise<{ rc: number | null; out: string; err: string }>; out: string; err: string };

	function leaseFixture(label: string): LeaseFixture {
		const work = realpathSync(ownedTmp(`suite-lease-${label}`, { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
		const repo = join(work, "repo"), marks = join(work, "marks");
		mkdirSync(join(repo, "scripts"), { recursive: true });
		mkdirSync(join(repo, "tests", "cli"), { recursive: true });
		mkdirSync(marks);
		cpSync(join(ROOT, "scripts/kitlib-tmp.sh"), join(repo, "scripts/kitlib-tmp.sh"));
		const env: Record<string, string> = { ...gitFixtureEnv(work), FULL_SUITE_LEASE_DIR: join(work, "lease"), FULL_SUITE_JOBS: "1",
			OMP_KIT_OMP_SRC_FETCH: "0", KITROOT: ROOT };
		for (const name of ["OMP_KIT_SUITE_HERMETIC_ENABLE", "OMP_KIT_SUITE_FENCE_ENABLE", "FULL_SUITE_LEASE_WAIT_SECS", "FULL_SUITE_LEASE_QUEUE_MAX",
			"FULL_SUITE_VERDICT_CACHE_DIR", "FULL_SUITE_TIMEOUT_SECS"]) delete env[name];
		fixtureGit(repo, env, "init", "-q");
		return { work, repo, marks, lease: join(work, "lease"), store: join(work, "store"), env };
	}
	function fixtureGit(cwd: string, env: Record<string, string>, ...args: string[]): string {
		const result = runFixture(["git", "-c", "user.name=SUITESERIAL1 test", "-c", "user.email=suiteserial1@example.invalid", "-C", cwd, ...args],
			{ cwd, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${decoder.decode(result.stderr)}`);
		return decoder.decode(result.stdout).trim();
	}
	// A stub suite file: it marks start, then waits for <marks>/open ("gate"), sleeps 1 s ("sleep") or ends ("fast"), and marks end.
	function stub(fx: LeaseFixture, file: string, tag: string, mode: "gate" | "sleep" | "fast"): void {
		const body = mode === "gate"
			? "deadline = time.monotonic() + 300\nwhile not os.path.exists(os.path.join(marks, 'open')) and time.monotonic() < deadline:\n    time.sleep(0.05)\n"
			: mode === "sleep" ? "time.sleep(1.0)\n" : "";
		writeFileSync(join(fx.repo, "tests", "cli", file), "import os, time\n"
			+ `marks, tag = ${JSON.stringify(fx.marks)}, ${JSON.stringify(tag)}\n`
			+ "def mark(kind):\n    with open(os.path.join(marks, '%s.%s.%d' % (kind, tag, os.getpid())), 'w') as handle:\n        handle.write(str(time.time_ns()))\n"
			+ "mark('start')\n" + body + "mark('end')\n");
	}
	function commit(fx: LeaseFixture, message: string): { sha: string; tree: string } {
		fixtureGit(fx.repo, fx.env, "add", "-A");
		fixtureGit(fx.repo, fx.env, "commit", "-qm", `[test] ${message}`);
		return { sha: fixtureGit(fx.repo, fx.env, "rev-parse", "HEAD"), tree: fixtureGit(fx.repo, fx.env, "rev-parse", "HEAD^{tree}") };
	}
	// Mark times (ns) by kind and tag prefix, e.g. marks(fx, "start", "a").
	function marks(fx: LeaseFixture, kind: "start" | "end", tag: string): number[] {
		return readdirSync(fx.marks).filter(name => name.startsWith(`${kind}.${tag}`)).map(name => Number(readFileSync(join(fx.marks, name), "utf8")));
	}
	// One judge run with stdout/stderr in files, so a test can read them while it runs.
	function launch(fx: LeaseFixture, sha: string, name: string, extra: Record<string, string> = {}, script = judge): Launch {
		const out = join(fx.work, `${name}.out`), err = join(fx.work, `${name}.err`);
		writeFileSync(out, ""); writeFileSync(err, "");
		const done = runFixtureAsync(["sh", "-c", 'exec sh "$0" --repo "$1" --commit "$2" --cache-dir "$3" >"$4" 2>"$5"', script, fx.repo, sha, fx.store, out, err],
			{ cwd: fx.work, env: { ...fx.env, ...extra }, floor_s: 90 })
			.then(result => ({ rc: result.rc, out: readFileSync(out, "utf8"), err: readFileSync(err, "utf8") }));
		return { done, out, err };
	}
	// The awaited conditions live in other processes (stub marks, a judge's stderr, lease tickets) and emit no event this
	// process can await, so they are polled against a load-scaled deadline.
	async function waitFor(what: string, ready: () => boolean, floorS = 60): Promise<void> {
		const deadline = Date.now() + fixtureDeadlineS(floorS) * 1_000;
		while (!ready()) {
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
			await Bun.sleep(50);
		}
	}
	const openGate = (fx: LeaseFixture) => writeFileSync(join(fx.marks, "open"), "");
	// The lease queue's tickets; one taken (removed) between listing and reading is skipped.
	function tickets(lease: string): Record<string, unknown>[] {
		const queue = join(lease, "suite-lease", "queue");
		const found: Record<string, unknown>[] = [];
		for (const name of existsSync(queue) ? readdirSync(queue) : []) {
			if (!name.endsWith(".json")) continue;
			try { found.push(JSON.parse(readFileSync(join(queue, name), "utf8")) as Record<string, unknown>); } catch { /* taken meanwhile */ }
		}
		return found;
	}
	// The kitlib flock behind the lease, tried once: RELEASED when it was free.
	function leaseFree(lease: string): string {
		const result = runFixture(["python3", "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import kitlib_lock; "
			+ "print(kitlib_lock.private_lock({'namespace': 'suite-lease', 'name': 'full-suite'}, deadline_s=0, state_dir=sys.argv[2]).release())",
		join(ROOT, "scripts"), lease], { cwd: ROOT, floor_s: 30 });
		return decoder.decode(result.stdout).trim() || decoder.decode(result.stderr).trim();
	}

	test("SUITESERIAL1 suite lease planted: two concurrent launches on one tree run one suite and both read its verdict", async () => {
		const fx = leaseFixture("planted");
		const runs: Launch[] = [];
		try {
			stub(fx, "lease_stub_test.py", "a", "gate");
			const { sha, tree } = commit(fx, "one stub suite");
			runs.push(launch(fx, sha, "first"));
			await waitFor("the first suite to start", () => marks(fx, "start", "a").length === 1);
			runs.push(launch(fx, sha, "second"));
			await waitFor("the second launch to join", () => readFileSync(runs[1]!.err, "utf8").includes("suite-lease: JOINING run "));
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			expect(first!.rc, first!.out + first!.err).toBe(0);
			expect(second!.rc, second!.out + second!.err).toBe(0);
			expect(first!.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			const firstRun = first!.out.split("FULL-SUITE: suite lease held by run ")[1]?.split(" ")[0];
			expect(second!.err).toContain(`suite-lease: JOINING run ${firstRun} (full-suite-verdict): it judges the same tree ${tree} role base`);
			expect(second!.out).toContain(`FULL-SUITE: JOINED the suite run for tree ${tree} role=base`);
			expect(second!.out).toContain(`FULL-SUITE: VERDICT REUSED PASS tree=${tree} role=base`);
			expect(second!.out).not.toContain("FULL-SUITE: VERDICT PASS ");
			expect(marks(fx, "start", "a").length).toBe(1);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	test("SUITESERIAL1 suite lease negative: a suite on another tree queues while one runs; a full queue or the wait bound refuses", async () => {
		const fx = leaseFixture("negative");
		const runs: Launch[] = [];
		try {
			stub(fx, "lease_stub_test.py", "a", "gate");
			const a = commit(fx, "tree a");
			stub(fx, "lease_stub_test.py", "b", "gate");
			const b = commit(fx, "tree b");
			stub(fx, "lease_stub_test.py", "c", "gate");
			const c = commit(fx, "tree c");
			runs.push(launch(fx, a.sha, "a"));
			await waitFor("suite a to start", () => marks(fx, "start", "a").length === 1);
			runs.push(launch(fx, b.sha, "b"));
			await waitFor("tree b to queue", () => readFileSync(runs[1]!.err, "utf8").includes(`suite-lease: QUEUED tree ${b.tree} role base at position 1 behind run `));
			expect(tickets(fx.lease).map(t => [t.tree, t.launcher, t.commit])).toEqual([[b.tree, "full-suite-verdict", b.sha]]);
			expect(marks(fx, "start", "b")).toEqual([]);
			// A full queue refuses at once with its code; nothing runs and nothing is recorded.
			const full = await launch(fx, c.sha, "c-full", { FULL_SUITE_LEASE_QUEUE_MAX: "1" }).done;
			expect(full.rc, full.out + full.err).toBe(75);
			expect(full.err).toContain("suite-lease: REFUSED SUITE_LEASE_QUEUE_FULL 1 request(s) already wait (FULL_SUITE_LEASE_QUEUE_MAX=1) behind run ");
			expect(full.err).toContain(`FULL-SUITE: REFUSED: no suite lease for tree ${c.tree} role=base (rc=75)`);
			// The wait bound refuses too, and drops its own ticket.
			const late = await launch(fx, c.sha, "c-late", { FULL_SUITE_LEASE_WAIT_SECS: "1" }).done;
			expect(late.rc, late.out + late.err).toBe(75);
			expect(late.err).toContain(`suite-lease: QUEUED tree ${c.tree} role base at position 2 behind run `);
			expect(late.err).toContain("suite-lease: REFUSED SUITE_LEASE_WAIT_TIMEOUT waited 1 s (FULL_SUITE_LEASE_WAIT_SECS)");
			expect(marks(fx, "start", "c")).toEqual([]);
			expect(tickets(fx.lease).map(t => t.tree)).toEqual([b.tree]);
			expect(marks(fx, "start", "b")).toEqual([]);
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			expect(first!.rc, first!.out + first!.err).toBe(0);
			expect(second!.rc, second!.out + second!.err).toBe(0);
			expect(second!.out).toContain(`FULL-SUITE: VERDICT PASS tree=${b.tree} role=base`);
			// Serialized: suite b started only after suite a ended.
			expect(marks(fx, "start", "b")[0]!).toBeGreaterThanOrEqual(marks(fx, "end", "a")[0]!);
			expect(tickets(fx.lease)).toEqual([]);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	test("SUITESERIAL1 suite lease caps inner workers at 6 when FULL_SUITE_JOBS asks for 28", async () => {
		const fx = leaseFixture("workers");
		try {
			for (let index = 0; index < 8; index++) stub(fx, `lease_stub_${index}_test.py`, `w${index}`, "sleep");
			const { sha, tree } = commit(fx, "eight stub suites");
			const result = await launch(fx, sha, "workers", { FULL_SUITE_JOBS: "28" }).done;
			expect(result.rc, result.out + result.err).toBe(0);
			expect(result.out).toContain("full-suite: FULL_SUITE_JOBS=28 exceeds the inner-worker cap; using 6 (SUITESERIAL1)");
			expect(result.out).toContain("full-suite: global timing-split pool: 6 workers");
			expect(result.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			const starts = marks(fx, "start", "w"), ends = marks(fx, "end", "w");
			expect([starts.length, ends.length]).toEqual([8, 8]);
			const intervals = readdirSync(fx.marks).filter(name => name.startsWith("start.w")).map(name => {
				const [, tag, pid] = name.split(".");
				return [Number(readFileSync(join(fx.marks, name), "utf8")), Number(readFileSync(join(fx.marks, `end.${tag}.${pid}`), "utf8"))] as const;
			});
			const peak = Math.max(...intervals.map(([start]) => intervals.filter(([s, e]) => s <= start && start < e).length));
			expect(peak).toBeGreaterThanOrEqual(1);
			expect(peak).toBeLessThanOrEqual(6);
		} finally { rmSync(fx.work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(120) * 1_000);

	test("SUITESERIAL1 suite lease control: one launch alone runs as before, releases the lease at exit, and a cache hit takes none", async () => {
		const fx = leaseFixture("control");
		try {
			stub(fx, "lease_stub_test.py", "a", "fast");
			const { sha, tree } = commit(fx, "one stub suite");
			const alone = await launch(fx, sha, "alone").done;
			expect(alone.rc, alone.out + alone.err).toBe(0);
			expect(alone.out).toContain(`FULL-SUITE: cache miss for tree ${tree} role=base (no reusable verdict); running the complete suite`);
			expect(alone.out).toContain("FULL-SUITE: suite lease held by run ");
			expect(alone.out).toContain(`for tree ${tree} role=base (holder=`);
			expect(alone.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			for (const word of ["QUEUED", "JOIN", "SUITE_LEASE_ABSENT", "REFUSED"]) expect(alone.out + alone.err).not.toContain(word);
			expect(marks(fx, "start", "a").length).toBe(1);
			// Released on exit: the holder is gone, its record removed, no ticket left, and the flock is free.
			const holder = Number(alone.out.split("(holder=")[1]?.split(" ")[0]);
			expect(Number.isInteger(holder)).toBe(true);
			expect(() => process.kill(holder, 0)).toThrow();
			expect(existsSync(join(fx.lease, "suite-lease", "holder.json"))).toBe(false);
			expect(tickets(fx.lease)).toEqual([]);
			expect(leaseFree(fx.lease)).toBe("RELEASED");
			// RELEASEDIET1: historical optional minimum_run metadata remains readable.
			const recordPath = join(fx.store, readdirSync(fx.store).find(name => name.endsWith(".json"))!);
			const historical = JSON.parse(readFileSync(recordPath, "utf8"));
			historical.minimum_run = { version: 1, status: "PASS", policy: { max_count_drop: { bun: 0, shell: 0, python: 0 }, wall_floor_ms: 1, wall_floor_percent: 25 }, baseline: null, counts: { bun: 0, shell: 0, python: 1 }, wall_ms: historical.timing.wall_ms, shortfalls: [] };
			writeFileSync(recordPath, JSON.stringify(historical));
			const again = await launch(fx, sha, "again").done;
			expect(again.rc, again.out + again.err).toBe(0);
			expect(again.out).toContain(`FULL-SUITE: VERDICT REUSED PASS tree=${tree} role=base`);
			expect(again.out).not.toContain("suite lease held");
			expect(marks(fx, "start", "a").length).toBe(1);
		} finally { rmSync(fx.work, { recursive: true, force: true }); }
	}, fixtureDeadlineS(120) * 1_000);

	test("SUITESERIAL1 suite lease mutant: a judge without the lease runs two suites; a closure that lists it refuses without it", async () => {
		const fx = leaseFixture("mutant");
		const runs: Launch[] = [];
		try {
			// A copy of the judge's own closure, as land archives it, without scripts/suite-lease.sh.
			const copy = join(fx.work, "judge");
			const listed = runFixture(["python3", "-B", join(ROOT, "scripts/suite-metrics.py"), "judging-files"], { cwd: ROOT, floor_s: 30 });
			expect(listed.rc).toBe(0);
			const closure = decoder.decode(listed.stdout).trim().split("\n");
			expect(closure).toContain("scripts/suite-lease.sh");
			for (const path of [...closure, "scripts/gate-ci-only.tsv"]) {
				if (path === "scripts/suite-lease.sh" || !existsSync(join(ROOT, path))) continue;
				mkdirSync(join(copy, path, ".."), { recursive: true });
				cpSync(join(ROOT, path), join(copy, path));
			}
			const script = join(copy, "scripts/full-suite-verdict.sh");
			stub(fx, "lease_stub_test.py", "a", "gate");
			const { sha, tree } = commit(fx, "one stub suite");
			// Closure lists the lease, file missing: refused before any suite.
			const missing = await launch(fx, sha, "missing", {}, script).done;
			expect(missing.rc, missing.out + missing.err).toBe(1);
			expect(missing.err).toContain("FULL-SUITE: RED: SUITE_LEASE_MISSING: scripts/suite-lease.sh is absent beside the gate, but this judge's JUDGING_FILES list it");
			expect(marks(fx, "start", "a")).toEqual([]);
			// The mutant: a closure that predates the lease. Two launches on one tree now run two suites at once.
			const metrics = join(copy, "scripts/suite-metrics.py");
			const source = readFileSync(metrics, "utf8");
			const predating = source.replace('"scripts/suite-lease.sh", ', "");
			expect(predating).not.toBe(source);
			writeFileSync(metrics, predating);
			runs.push(launch(fx, sha, "first", {}, script), launch(fx, sha, "second", {}, script));
			await waitFor("both suites to run at once", () => marks(fx, "start", "a").length === 2);
			openGate(fx);
			const [first, second] = await Promise.all(runs.map(r => r.done));
			for (const result of [first!, second!]) {
				expect(result.rc, result.out + result.err).toBe(0);
				expect(result.out).toContain("FULL-SUITE: SUITE_LEASE_ABSENT: this judge's JUDGING_FILES predate scripts/suite-lease.sh, so this run takes no suite lease and may overlap another suite");
				expect(result.out).toContain(`FULL-SUITE: VERDICT PASS tree=${tree} role=base`);
			}
			expect(marks(fx, "start", "a").length).toBe(2);
		} finally {
			openGate(fx);
			await Promise.allSettled(runs.map(r => r.done));
			rmSync(fx.work, { recursive: true, force: true });
		}
	}, fixtureDeadlineS(180) * 1_000);

	// `omp-kit land` with PRE_PUSH_FULL_SUITE=push judges the candidate with a judge archived from the base's JUDGING_FILES
	// (src/land.ts archiveFullSuiteJudge). Planted: a second suite holds the lease, so land's judge queues and its suite
	// starts only after that suite ends. Mutant: a base whose closure predates the lease runs land's suite beside it.
	for (const variant of ["leased", "mutant"] as const) {
		test(`SUITESERIAL1 suite lease ${variant === "leased" ? "planted: an inline land judge queues behind a running suite" : "mutant: an inline land judge without the lease overlaps a running suite"}`, async () => {
			// Dynamic on purpose: the helpers build a git template (bare origin, clone, push) when loaded, a cost only these two
			// cases need; a static import would charge every release-local test with it.
			const land = await import("./private-index-land.helpers.ts");
			const fx = leaseFixture(`land-${variant}`);
			const { work, fakeBin } = land.fixture();
			const runs: Launch[] = [];
			try {
				if (variant === "mutant") {
					const metrics = join(work, "scripts/suite-metrics.py");
					const source = readFileSync(metrics, "utf8");
					const predating = source.replace('"scripts/suite-lease.sh", ', "");
					expect(predating).not.toBe(source);
					writeFileSync(metrics, predating);
					land.git(work, ["rm", "-q", "scripts/suite-lease.sh"]);
					land.git(work, ["commit", "-qam", "base predating the suite lease [test]"]);
					land.git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
				}
				writeFileSync(join(work, "owned.txt"), `land candidate beside a running suite (${variant})\n`);
				const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
				stub(fx, "lease_stub_test.py", "held", "gate");
				const planted = commit(fx, "planted suite");
				runs.push(launch(fx, planted.sha, "planted"));
				await waitFor("the planted suite to start", () => marks(fx, "start", "held").length === 1);
				const landEnv = land.commandEnvironment(work, hold, { amDir: fakeBin, gitEnv: { PRE_PUSH_FULL_SUITE: "push", FULL_SUITE_LEASE_DIR: fx.lease } });
				const landRun = runFixtureAsync(["bun", land.cliPath, "land", ...land.landArgs("owned.txt"), "--json"],
					{ cwd: work, env: land.stringEnvironment(landEnv), floor_s: 180 });
				let queued: Record<string, unknown> | undefined;
				if (variant === "leased") {
					await waitFor("land's judge to queue for the lease", () => (queued = tickets(fx.lease).find(t => t.launcher === "full-suite-verdict" && t.role === "base")) !== undefined, 120);
					expect(marks(fx, "end", "held")).toEqual([]);
					openGate(fx);
				}
				const landed = await landRun;
				openGate(fx);
				const plantedResult = await runs[0]!.done;
				expect(plantedResult.rc, plantedResult.out + plantedResult.err).toBe(0);
				const stdout = decoder.decode(landed.stdout);
				expect(landed.rc, stdout + decoder.decode(landed.stderr)).toBe(0);
				const data = JSON.parse(stdout).data as { overall: string; commit: string };
				expect(data.overall).toBe("PUSHED");
				const tree = land.git(work, ["rev-parse", `${data.commit}^{tree}`]).trim();
				const record = JSON.parse(readFileSync(land.verdictPath(work, tree, "base", landEnv), "utf8")) as { verdict: string; evidence: { files: { started_ms: number }[] } };
				expect(record.verdict).toBe("PASS");
				const landStartedMs = Math.min(...record.evidence.files.map(row => row.started_ms));
				const plantedEndMs = marks(fx, "end", "held")[0]! / 1e6;
				if (variant === "leased") {
					expect(queued?.commit).toBe(data.commit);
					expect(landStartedMs).toBeGreaterThanOrEqual(Math.floor(plantedEndMs));
				} else {
					expect(landStartedMs).toBeLessThan(plantedEndMs);
				}
				expect(tickets(fx.lease)).toEqual([]);
			} finally {
				openGate(fx);
				await Promise.allSettled(runs.map(r => r.done));
				rmSync(fx.work, { recursive: true, force: true });
			}
		}, fixtureDeadlineS(300) * 1_000);
	}
}
