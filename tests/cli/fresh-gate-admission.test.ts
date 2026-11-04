// Coverage: scripts/fresh-gate.sh, scripts/build-manifest.sh, scripts/rule-class.ts,
// scripts/affected-tests.ts, scripts/test-budget.ts, scripts/gate-ci-only.ts, scripts/gate-disk-floor.ts,
// scripts/suite-metrics.py, scripts/full-suite-verdict.sh, scripts/full-suite-verdict-store.py,
// scripts/suite-hermetic-env.sh, scripts/kitlib_run.py, scripts/kitlib_tmp.py, scripts/pysafe.py,
// scripts/kitlib-tmp.sh, src/cli.ts, src/kitlib/run.ts, src/kitlib/tmp.ts.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, fixtureLoad } from "./fixture-process.ts";

import { root, gate, AMPLE, LOW_BASE, NEED_BYTES, freeBytes, runProbe, saveFixture, type SaveFixture } from "./fresh-gate.helpers.ts";
test.skipIf(!AMPLE)("SAVEFIRST1 planted (a): sbh pressure with ample bytes admits the save step and prints one WARN (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(1, { slots: 8, max_wait_s: 1 });
	try {
		// Positive control for the plant: this sbh really vetoes heavy's default admission.
		const veto = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", "src/cli.ts", "heavy", "--no-wait", "--", "true"], { cwd: root, env: { ...process.env, ...fx.env }, deadline_s: fixtureDeadlineS(30) });
		expect(veto.rc).toBe(75);
		expect(Buffer.from(veto.stderr).toString()).toContain("disk low: sbh check --need 10G reports pressure");
		const marker = join(fx.dir, "saved");
		const body = `disk_pressure_flag\nheavy_step cli-compile sh -c 'printf ran > "$1"' sh '${marker}'`;
		const saved = runProbe(fx, source, body);
		expect(saved.code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("ran");
		expect(saved.out.split("\n").filter((line) => line.startsWith("WARN disk-pressure:"))).toEqual([
			"WARN disk-pressure: sbh reports 11.7% free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15)",
		]);
		expect(saved.out).not.toContain("RED");
		// Mutant: the step without its statfs override is vetoed by sbh again.
		const mutant = source.replace("heavy --label \"fresh-gate-$step\" --disk-observer statfs --", "heavy --label \"fresh-gate-$step\" --");
		expect(mutant).not.toBe(source);
		rmSync(marker, { force: true });
		const vetoed = runProbe(fx, mutant, body);
		expect(vetoed.code).toBe(75);
		expect(existsSync(marker)).toBe(false);
		expect(vetoed.out).toContain("FRESH-GATE: RED: heavy refused admission for cli-compile (exit 75)");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(30) * 1000);

test("SAVEFIRST1: no WARN when sbh is healthy or absent", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		expect(runProbe(fx, source, "disk_pressure_flag").out).not.toContain("WARN");
		fx.env.PATH = "/usr/bin:/bin";
		const absent = runProbe(fx, source, "disk_pressure_flag");
		expect(absent.code).toBe(0);
		expect(absent.out).not.toContain("WARN");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test.skipIf(LOW_BASE === null)("SAVEFIRST1 planted (b): below the 10 GiB physical floor the save step is still refused with a typed reason, even with sbh healthy", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	const low = ownedTmp("fresh-gate-lowfs", { root: LOW_BASE as string }).path;
	try {
		writeFileSync(join(low, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-lowfs\ncreated=${new Date().toISOString()}\n`);
		fx.env.FRESH_GATE_TEST_REAL_STATFS = "1";
		expect(freeBytes(low)).toBeLessThan(NEED_BYTES);
		// The step runs in the archive; here the archive's src is the checkout's, reached from the small filesystem.
		symlinkSync(join(root, "src"), join(low, "src"));
		const marker = join(fx.dir, "lowfs-ran");
		const refused = runProbe(fx, source, `heavy_step cli-compile sh -c 'printf ran > "$1"' sh '${marker}'`, low);
		expect(refused.code).toBe(75);
		expect(existsSync(marker)).toBe(false);
		expect(refused.out).toContain("waiting: disk low (statfs)");
		expect(refused.out).toContain("deferred: queue timeout");
		expect(refused.out).toContain("FRESH-GATE: RED: heavy refused admission for cli-compile (exit 75)");
	} finally {
		rmSync(low, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(30) * 1000);

test.skipIf(!AMPLE)("planted: a heavy step runs on the gate's own PATH, never bun run's ancestor node_modules/.bin (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		// The fixture's fake bun drops `run`, and `run` is the PATH injection under test: use the real bun.
		rmSync(join(fx.dir, "bin", "bun"));
		symlinkSync(process.execPath, join(fx.dir, "bin", "bun"));
		mkdirSync(join(fx.dir, "node_modules", ".bin"), { recursive: true });
		const archive = join(fx.dir, "archive");
		mkdirSync(archive);
		symlinkSync(join(root, "src"), join(archive, "src"));
		const marker = join(fx.dir, "step-path");
		const body = `heavy_step tests sh -c 'printf %s "$PATH" > "$1"' sh '${marker}'`;
		expect(runProbe(fx, source, body, archive).code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe(fx.env.PATH);
		// Plant: without the pin, the same step sees the archive's ancestor node_modules/.bin first.
		const mutant = source.replace(`env PATH="$PATH" sh -c 'python3 -c`, `sh -c 'python3 -c`);
		expect(mutant).not.toBe(source);
		expect(runProbe(fx, mutant, body, archive).code).toBe(0);
		expect(readFileSync(marker, "utf8").split(":")).toContain(join(fx.dir, "node_modules", ".bin"));
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(30) * 1000);

// A peer's running heavy job: an orphaned sleep (re-parented, so its exit is reaped while this test
// blocks in spawnSync and heavy's liveness probe sees it end) recorded as the slot holder.
function holdSlot(fx: SaveFixture, seconds: number): void {
	const pid = Buffer.from(runSync(["sh", "-c", 'sleep "$1" >/dev/null 2>&1 & echo $!', "sh", String(seconds)], { deadline_s: fixtureDeadlineS(30) }).stdout).toString().trim();
	const lstart = Buffer.from(runSync(["ps", "-p", pid, "-o", "lstart="], { deadline_s: fixtureDeadlineS(30) }).stdout).toString().trim();
	expect(lstart).not.toBe("");
	const jobs = join(fx.dir, "state", "omp-kit", "load", "jobs");
	mkdirSync(jobs, { recursive: true, mode: 0o700 });
	writeFileSync(join(jobs, "holder.json"), JSON.stringify({
		id: "holder", pid: Number(pid), process_start: lstart, label: "stuck-peer", repo: fx.dir, cwd: fx.dir, agent: "peer",
		tmux_pane: "", argv: ["sleep"], state: "running", queued_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
	}), { mode: 0o600 });
}

test("SAVEFIRST1 planted (c): heavy queue wait is recorded apart from the step's own work", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 1, max_wait_s: 20 });
	const marker = join(fx.dir, "worked");
	// The step still runs 4 s; queue budget seconds stay whole-second truncated for compatibility.
	const body = `heavy_step harness sh -c 'sleep 4; printf ran > "$1"' sh '${marker}'`;
	const queued = (fixture: SaveFixture) => Number(readFileSync(join(fixture.env.WORK, "queued.secs"), "utf8").trim());
	try {
		holdSlot(fx, 3);
		const honest = runProbe(fx, source, body);
		expect(honest.code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("ran");
		const wait = queued(fx);
		expect(wait).toBeGreaterThanOrEqual(2);
		// The holder sleeps 3 s; heavy then notices its exit through liveness polls that load slows (7 s
		// observed at load 25-36 on 32 cores). The seconds-minus-wait check below separates wait from the work.
		expect(wait).toBeLessThanOrEqual(5 * fixtureLoad().factor);
		expect(honest.out).toContain(`heavy admission wait: ${wait}s (harness)`);
		// The 4 s of work is not wait: wall time exceeds the recorded wait by the work, less clock rounding.
		expect(honest.seconds - wait).toBeGreaterThanOrEqual(2.5);
		// Mutant: timing the whole step as wait swallows the work.
		const mutant = source.replace("wait_ms=$((admitted_at_ms - queued_at_ms))", "wait_ms=$((finished_at_ms - queued_at_ms))");
		expect(mutant).not.toBe(source);
		rmSync(join(fx.env.WORK, "queued.secs"));
		holdSlot(fx, 3);
		const swallowed = runProbe(fx, mutant, body);
		expect(swallowed.code).toBe(0);
		expect(swallowed.seconds - queued(fx)).toBeLessThan(2);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

test("SAVEFIRST1 planted (c): the 180 s budget subtracts queue wait but still judges slow gate work", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		const queuedLong = runProbe(fx, source, "judge_budget 200 0 30");
		expect(queuedLong.code).toBe(0);
		expect(queuedLong.out).toContain("FRESH-GATE: GREEN commit=HEAD elapsed=200s tests=0s queued=30s judged=170s");
		const slowWork = runProbe(fx, source, "judge_budget 200 0 15");
		expect(slowWork.code).toBe(1);
		expect(slowWork.out).toContain("FRESH-GATE: RED: elapsed=200s (affected tests 0s, heavy queue wait 15s, judged 185s) exceeds 180s");
		// CIGATE1: the affected tests' own run time is reported beside the machinery budget, not judged by it.
		const testsLong = runProbe(fx, source, "judge_budget 200 30 0");
		expect(testsLong.code).toBe(0);
		expect(testsLong.out).toContain("FRESH-GATE: GREEN commit=HEAD elapsed=200s tests=30s queued=0s judged=170s");
		// Mutant: queue wait judged as gate time fails the push queued behind a stuck job.
		const mutant = source.replace("judged=$(($1 - $2 - $3))", "judged=$(($1 - $2))");
		expect(mutant).not.toBe(source);
		expect(runProbe(fx, mutant, "judge_budget 200 0 30").code).toBe(1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

afterAll(cleanupAllOwnedTmp);
