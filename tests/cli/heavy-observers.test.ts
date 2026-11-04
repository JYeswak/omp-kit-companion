import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { diskVerdict, HEAVY_PREREQ_MISSING } from "../../src/heavy.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { fixture, configure, invoke, seedJob, waitForLedgerState, fakeSbh, observerRefusals, countingSbh, forgeHealthyStatfs } from "./heavy-fixtures.ts";

function refusalDecisionMs(rows: unknown[], finishedAtMs: number): number {
	const row = rows[0];
	if (typeof row !== "object" || row === null || !("timing" in row) ||
		typeof row.timing !== "object" || row.timing === null || !("answer_observed_at_ms" in row.timing) ||
		typeof row.timing.answer_observed_at_ms !== "number") throw new Error("observer refusal has no answer timestamp");
	return finishedAtMs - row.timing.answer_observed_at_ms;
}

function expectFastRefusal(elapsedMs: number, sample: "control" | "mutant" = "control"): void {
	// Preserve calibration before fixture HOME is removed at file teardown.
	console.error("HEAVY_REFUSAL_DECISION", JSON.stringify({ sample, elapsed_ms: elapsedMs }));
	expect(elapsedMs).toBeGreaterThanOrEqual(0);
	expect(elapsedMs).toBeLessThan(8_000); // wallclock: p99=111ms headroom=72x (canonical harness n=14, load1 18.36–28.05; empirical p99 110.808 ms)
}

function refusalElapsedMs(rows: unknown[]): number {
	const row = rows[0];
	if (typeof row !== "object" || row === null || !("timing" in row) ||
		typeof row.timing !== "object" || row.timing === null || !("total_ms" in row.timing) ||
		typeof row.timing.total_ms !== "number") throw new Error("observer refusal has no measured total_ms");
	return row.timing.total_ms;
}

test.concurrent("HEAVYDISK1 planted: no-wait defers on sbh pressure without starting", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const bin = fakeSbh(root, 1);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "disklow-nowait", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("disk low");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("HEAVYDISK1: healthy disk runs the command", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const bin = fakeSbh(root, 0);
	const marker = join(root, "ran-marker");
	const result = await invoke(root, ["heavy", "--label", "diskok", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test.concurrent("HEAVYDEFER1: a stalled sbh observation times out without killing the caller's process group", async () => {
	const root = fixture();
	const bin = fakeSbh(root, 0, "stalled-bin");
	const groups = join(root, "observer-groups");
	const python = Bun.which("python3");
	if (!python) throw new Error("group fixture requires the suite's Python interpreter");
	// The stub must start and record its group before the observer deadline. A fixed 4 s lost that race
	// once under load (ENOENT at 4002 ms: the freshly written stub's first exec never got to write), so the
	// deadline comes from the load factor and the stub outlives it threefold, which the timeout must cut short.
	const deadlineS = Math.ceil(fixtureDeadlineS(4));
	writeFileSync(join(bin, "sbh"), `#!${python} -S
import os, time
pid, parent = os.getpid(), os.getppid()
with open(${JSON.stringify(groups)}, "w") as output:
    output.write(f"{parent} {os.getpgid(parent)} 0\\n{pid} {os.getpgrp()} {parent}\\n")
time.sleep(${deadlineS * 3})
`, { mode: 0o755 });
	// The 2026-11-04 152b8175 main verdict (load1 17-20 on 32 cores) lost the start race again with the load-scaled
	// deadline: ENOENT at 8001 ms, so the stub never ran its first line within 8 s. That stall is the freshly
	// written stub's start, not the observation, so only an observation whose stub never recorded its group is
	// re-run, inside a load-scaled budget. Every observation must still time out within twice the deadline.
	const until = Date.now() + fixtureDeadlineS(20) * 1000;
	for (;;) {
		const started = Date.now();
		const verdict = await diskVerdict({
			config: { slots: 1, max_wait_s: 20, disk_observer: "sbh", disk_floor_pct: null, sbh_deadline_s: deadlineS },
			cwd: root, sbhBin: join(bin, "sbh"),
		});
		expect(verdict).toMatchObject({ kind: "timeout", observer: "sbh" });
		if (verdict.kind !== "timeout") throw new Error("stalled observer supplied no timeout verdict");
		expect(verdict.text).toContain(`sbh check timed out after ${deadlineS}s`);
		// The timeout, not the stub's own 3x-deadline exit, ends the observation.
		expect(Date.now() - started).toBeLessThan(deadlineS * 2 * 1000);
		if (existsSync(groups) || Date.now() >= until) break;
	}
	// The timeout must target the observer's new group, never the test runner's.
	const rows = readFileSync(groups, "utf8").trim().split("\n")
		.map(line => line.replaceAll("\t", " ").split(" ").filter(Boolean).map(Number));
	const caller = rows.find(row => row[0] === process.pid)!;
	const observer = rows.find(row => row[2] === process.pid)!;
	expect(caller).toBeDefined();
	expect(observer).toBeDefined();
	expect(observer[1]).toBe(observer[0]);
	expect(observer[1]).not.toBe(caller[1]);
}, fixtureDeadlineS(80) * 1000);

test.concurrent("HEAVYDEFER1 planted: an observer timeout defers with 75, persists its timing, and starts nothing", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20, disk_observer: "sbh", sbh_deadline_s: 4 });
	const bin = fakeSbh(root, 0, "stalled-bin");
	writeFileSync(join(bin, "sbh"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "stalled-observer", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code, result.stderr).toBe(75);
	expect(result.stderr).toContain("RESOURCE_DEFERRED");
	expect(result.stderr).toContain("sbh check timed out after 4s");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter(name => name.endsWith(".json"))).toEqual([]);
	const rows = observerRefusals(root);
	expect(rows).toEqual([expect.objectContaining({
		schema_version: 1, label: "stalled-observer", observer: "sbh", kind: "timeout", phase: "precheck",
		reason: expect.stringContaining("timed out after 4s"), load1: expect.any(Number),
		timing: expect.objectContaining({
			start_boundary: "spawn-return", spawn_to_start_ms: expect.any(Number),
			start_to_exit_ms: expect.any(Number), total_ms: expect.any(Number), deadline_ms: 4_000,
		}),
	})]);
	expect(refusalElapsedMs(rows)).toBeGreaterThanOrEqual(4_000);
	expect(refusalElapsedMs(rows)).toBeLessThan(8_000);
}, fixtureDeadlineS(20) * 1000);

test.concurrent("HEAVYCI1 planted: a missing sbh fails fast with 69 on the waiting path, queueing and starting nothing", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20, disk_observer: "sbh" });
	const noSbhPath = "/usr/bin:/bin";
	// Positive control for the planted state: this PATH must really lack sbh.
	const pathProbe = await runFixtureAsync(["/bin/sh", "-c", "command -v sbh"], { cwd: root, env: { PATH: noSbhPath }, floor_s: 30 });
	expect(pathProbe.rc).not.toBe(0);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "nosbh", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: noSbhPath });
	const finishedAtMs = Date.now();
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("heavy: sbh unavailable: sbh binary not runnable");
	// The pre-fix path waited out the whole 20 s budget and returned 75.
	const rows = observerRefusals(root);
	expect(rows).toEqual([expect.objectContaining({
		label: "nosbh", observer: "sbh", kind: "unavailable", phase: "precheck",
		reason: "sbh binary not runnable",
		timing: expect.objectContaining({ spawn_to_start_ms: null, start_to_exit_ms: null, deadline_ms: 30_000 }),
	})]);
	expectFastRefusal(refusalDecisionMs(rows, finishedAtMs));
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
	const again = await invoke(root, ["heavy", "--label", "nosbh-again", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: noSbhPath });
	expect(again.code, again.stderr).toBe(HEAVY_PREREQ_MISSING);
	expect(observerRefusals(root)).toHaveLength(2);
	expect(existsSync(marker)).toBe(false);
}, fixtureDeadlineS(40) * 1000);

test.concurrent("HEAVYCI1 planted: an sbh error answer is a missing prerequisite (69), never a 75 deferral", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const bin = fakeSbh(root, 2);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "diskerr", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	const finishedAtMs = Date.now();
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("heavy: sbh unavailable: sbh check exited 2");
	const rows = observerRefusals(root);
	expect(rows).toEqual([expect.objectContaining({
		label: "diskerr", observer: "sbh", kind: "unavailable", phase: "precheck",
		reason: expect.stringContaining("sbh check exited 2"),
		timing: expect.objectContaining({ spawn_to_start_ms: expect.any(Number), start_to_exit_ms: expect.any(Number), deadline_ms: 30_000 }),
	})]);
	expectFastRefusal(refusalDecisionMs(rows, finishedAtMs));
	expect(existsSync(marker)).toBe(false);
}, fixtureDeadlineS(40) * 1000);

test.concurrent("HEAVYDEFER1 planted mutant: a 69 that waits twenty seconds fails the unchanged fast-refusal guard", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const bin = fakeSbh(root, 2);
	const preload = join(root, "waiting-refusal-mutant.ts");
	// This mutant must wait on the independent CLI's real clock: parent fake
	// timers cannot prove that a twenty-second regression fails the eight-second guard.
	writeFileSync(preload, `
import ${JSON.stringify(forgeHealthyStatfs)};
import { plugin } from "bun";
import { readFileSync } from "node:fs";
plugin({ name: "waiting-refusal-mutant", setup(build) {
	build.onLoad({ filter: /heavy[.]ts$/ }, ({ path }) => {
		const contents = readFileSync(path, "utf8");
		const original = 'if (precheck.kind === "unavailable" || precheck.kind === "timeout") return refuseObserver(precheck);';
		if (!contents.includes(original)) throw new Error("waiting-refusal mutant target missing");
		return { contents: contents.replace(original,
			'if (precheck.kind === "unavailable" || precheck.kind === "timeout") { await Bun.sleep(20_000); return refuseObserver(precheck); }'), loader: "ts" };
	});
}});
`);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "waiting-mutant", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` }, { preload });
	const finishedAtMs = Date.now();
	expect(result.code, result.stderr).toBe(HEAVY_PREREQ_MISSING);
	expect(existsSync(marker)).toBe(false);
	const elapsedMs = refusalDecisionMs(observerRefusals(root), finishedAtMs);
	expect(elapsedMs).toBeGreaterThanOrEqual(20_000);
	expect(() => expectFastRefusal(elapsedMs, "mutant")).toThrow();
}, fixtureDeadlineS(60) * 1000);

test.concurrent("HEAVYCI1: --no-wait with a missing sbh also returns 69, not 75", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "sbh" });
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "nosbh-nowait", "--", "sh", "-c", "exit 0"], { PATH: "/usr/bin:/bin" });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("sbh unavailable");
});

test.concurrent("HEAVYCI1: an observer lost while queued returns 69, removes its job, and retains refusal evidence", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 20 });
	const jobs = await seedJob(root, { id: "slot-owner" });
	const bin = countingSbh(root, 2);
	const marker = join(root, "should-not-run");
	const run = invoke(root, ["heavy", "--label", "lost-observer", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	await waitForLedgerState(root, "queued", 15_000);
	unlinkSync(join(jobs, "slot-owner.json"));
	const result = await run;
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("heavy: sbh unavailable: sbh check exited 2");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual([]);
	expect(observerRefusals(root)).toEqual([expect.objectContaining({
		label: "lost-observer", phase: "admission", observer: "sbh", kind: "unavailable",
		reason: expect.stringContaining("sbh check exited 2"),
	})]);
}, fixtureDeadlineS(40) * 1000);

test.concurrent("HEAVYDEFER1: a queued observer timeout returns 75, removes its job, and retains refusal evidence", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 20, disk_observer: "sbh" });
	const jobs = await seedJob(root, { id: "slot-owner" });
	const bin = countingSbh(root, 0);
	const calls = join(root, "sbh-calls");
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nn=0\nif [ -r '${calls}' ]; then IFS= read -r n < '${calls}'; fi\nn=$((n + 1))\nprintf '%s\\n' "$n" > '${calls}'\n[ "$n" -le 1 ] && exit 0\nexec sleep 30\n`, { mode: 0o755 });
	const marker = join(root, "should-not-run");
	const pending = invoke(root, ["heavy", "--label", "queued-timeout", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	await waitForLedgerState(root, "queued", 15_000);
	// The short guard belongs to the planted stalled observation, not the
	// healthy bootstrap. Change it only after the real queued row is visible.
	configure(root, { slots: 1, max_wait_s: 20, disk_observer: "sbh", sbh_deadline_s: 4 });
	unlinkSync(join(jobs, "slot-owner.json"));
	const result = await pending;
	expect(result.code, result.stderr).toBe(75);
	expect(result.stderr).toContain("RESOURCE_DEFERRED");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(jobs).filter(name => name.endsWith(".json"))).toEqual([]);
	expect(Number(readFileSync(calls, "utf8").trim())).toBeGreaterThanOrEqual(2);
	expect(observerRefusals(root)).toEqual([expect.objectContaining({
		label: "queued-timeout", phase: "admission", observer: "sbh", kind: "timeout",
		reason: expect.stringContaining("sbh check timed out after 4s"),
	})]);
}, fixtureDeadlineS(25) * 1000);

test.concurrent("HEAVYCI1: a queued job re-observes the disk, so pressure that appears while waiting still defers", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 4 });
	const jobs = await seedJob(root, { id: "slot-owner" });
	const bin = countingSbh(root, 1);
	const marker = join(root, "should-not-run");
	const run = invoke(root, ["heavy", "--label", "late-pressure", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	await waitForLedgerState(root, "queued", 15_000);
	unlinkSync(join(jobs, "slot-owner.json"));
	const result = await run;
	expect(result.code).toBe(75);
	// Re-observed: the pre-queue reading (call 1) was not reused after the wait.
	expect(Number(readFileSync(join(root, "sbh-calls"), "utf8").trim())).toBeGreaterThanOrEqual(2);
	expect(existsSync(marker)).toBe(false);
	expect(observerRefusals(root)).toEqual(expect.arrayContaining([expect.objectContaining({
		label: "late-pressure", phase: "admission", observer: "sbh", kind: "pressure",
		reason: expect.stringContaining("reports pressure"),
	})]));
}, fixtureDeadlineS(40) * 1000);

test.concurrent("HEAVYCI1: admission observes the disk after acquiring the state mutex, not before the lock wait (QuietBadger AM57798)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 4 });
	const lock = join(root, "state", "omp-kit", "load", "mutex");
	mkdirSync(lock, { recursive: true, mode: 0o700 });
	const ps = await runFixtureAsync(["ps", "-p", String(process.pid), "-o", "lstart="], { cwd: root, floor_s: 30 });
	expect(ps.rc).toBe(0);
	const processStart = new TextDecoder().decode(ps.stdout).trim();
	writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_start: processStart }), { mode: 0o600 });
	const bin = countingSbh(root, 1);
	const calls = join(root, "sbh-calls");
	const marker = join(root, "should-not-run");
	const run = invoke(root, ["heavy", "--label", "lock-drift", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	// Release the live mutex once the pre-queue observation (healthy) has
	// happened; every later observation reports pressure. The CLI is a separate
	// process with no event to await, so this polls its observable side effect,
	// as waitForLedgerState does above.
	const waitStart = Date.now();
	const readinessMs = fixtureDeadlineS(30) * 1000;
	while (!existsSync(calls) && Date.now() - waitStart < readinessMs) await Bun.sleep(50);
	expect(existsSync(calls)).toBe(true);
	unlinkSync(join(lock, "owner.json"));
	rmdirSync(lock);
	const result = await run;
	expect(result.code).toBe(75);
	expect(existsSync(marker)).toBe(false);
	expect(Number(readFileSync(calls, "utf8").trim())).toBeGreaterThanOrEqual(2);
}, fixtureDeadlineS(60) * 1000);

test("HEAVYDISK1: waiting status names the disk reason", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 2 });
	const bin = fakeSbh(root, 1);
	const result = await invoke(root, ["heavy", "--label", "diskwait", "--", "sh", "-c", "exit 0"],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("heavy: queue position 1;");
	expect(result.stderr).toContain("disk low");
});

test.concurrent("oq1h.1: auto prefers a failing sbh over healthy statfs (sbh precedence)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const bin = fakeSbh(root, 1);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "sbh-wins", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("disk low: sbh check");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("oq1h.1: auto with an erroring sbh fails fast with 69 naming the escape", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const bin = fakeSbh(root, 2);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "sbh-err-auto", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("disk_observer");
	expect(existsSync(marker)).toBe(false);
}, fixtureDeadlineS(40) * 1000);

afterAll(() => cleanupAllOwnedTmp());
