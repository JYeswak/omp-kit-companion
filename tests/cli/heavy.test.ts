import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { incarnation, probeIncarnation } from "../../src/kitlib/proc";
import { run } from "../../src/kitlib/run";
import { machineLoadBlockReason } from "../../src/heavy.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { entry, fixture, configure, heavyEnv, invoke, seedJob, QUIET_LOAD, waitForLedgerState, forgeHealthyStatfs } from "./heavy-fixtures.ts";

test.concurrent("machine admission blocks only above 2.5 times the core count", () => {
	expect(machineLoadBlockReason(80, 32)).toBeNull();
	expect(machineLoadBlockReason(80.01, 32)).toContain("LOAD1");
	expect(machineLoadBlockReason(1, 4)).toBeNull();
});

test.concurrent("SCANNERADMIT refuses a zero-budget start while GITHUB_ACTIONS bypasses LOAD1", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 0 });
	const marker = join(root, "scanner-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", `printf ran > '${marker}'`], {
		OMP_KIT_HEAVY_FAKE_LOAD1: "1000000",
		GITHUB_ACTIONS: "true",
	});
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("RESOURCE_DEFERRED");
	expect(result.stderr).toContain("admission deadline expired before child start");
	expect(result.stderr).not.toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("SCANNERADMIT preserves genuine child exit 75 without refusal marker", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 5 });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "exit 75"]);
	expect(result.code).toBe(75);
	expect(result.stderr).not.toContain("RESOURCE_DEFERRED");
});

test.concurrent("heavy streams the child and preserves its exit code", async () => {
 	const root = fixture();
 	configure(root, { slots: 1, max_wait_s: 1 });
 	const result = await invoke(root, ["heavy", "--label", "tiny", "--", "sh", "-c", "printf child; exit 23"], QUIET_LOAD);
 
 	expect(result.code).toBe(23);
 	expect(result.stdout).toBe("child");
 	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
 });

test.concurrent("no-wait defers on a full machine slot without starting the command", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "slot-owner" });
	const marker = join(root, "should-not-run");
 	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", `printf ran > '${marker}'`], QUIET_LOAD);

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual(["slot-owner.json"]);
});

test.concurrent("a pane cannot start a second heavy command when another global slot is free", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 1 });
	await seedJob(root, { id: "pane-owner", pane: "%heavy-pane" });
 	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "exit 0"], { TMUX_PANE: "%heavy-pane", ...QUIET_LOAD });

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("pane already has running job existing");
});

test.concurrent("process-reused ledger entries are reaped before admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "reused-owner", process_start: "not-this-process-start" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "printf fresh"]);

	expect(result.code).toBe(0);
	expect(result.stdout).toBe("fresh");
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual([]);
});

/**
 * ompkit-5m6ej subjects, through kitlib run: /bin/sh forks two sleeps, writes their pids, then exec's into sleep, which
 * never reaps. The first sleep is killed and stays a zombie; the second stays live. `stop` aborts the run's whole group.
 */
async function subjects(root: string): Promise<{ live: { pid: number; start: string }; zombie: { pid: number; start: string }; stop: () => Promise<void> }> {
	const out = join(root, "subject-pids");
	const controller = new AbortController();
	const tree = run(["/bin/sh", "-c", 'sleep 30 & z=$!; sleep 30 & l=$!; echo "$z $l" > "$1.tmp" && mv "$1.tmp" "$1"; exec sleep 30', "subjects", out],
		{ deadline_s: 60, signal: controller.signal }).catch(() => { /* aborted by stop */ });
	const stop = async () => { controller.abort(new Error("subjects done")); await tree; };
	// Real-clock poll for a file a real child writes; no fake timer reaches another process.
	for (let tries = 0; !existsSync(out) && tries < 200; tries++) await Bun.sleep(25);
	if (!existsSync(out)) { await stop(); throw new Error("subject tree did not start"); }
	const [zombiePid, livePid] = readFileSync(out, "utf8").trim().split(" ").map(Number) as [number, number];
	const [zombieSeen, liveSeen] = [await incarnation(zombiePid), await incarnation(livePid)];
	if (zombieSeen === null || liveSeen === null) { await stop(); throw new Error("no incarnation for a subject"); }
	process.kill(zombiePid, "SIGKILL");
	// Real-clock poll: the OS marks the killed child Z on its own schedule, which no fake timer drives.
	for (let tries = 0; tries < 60 && (await probeIncarnation(zombieSeen)).state !== "zombie"; tries++) await Bun.sleep(50);
	return { live: liveSeen, zombie: zombieSeen, stop };
}

test.concurrent("5m6ej planted: a zombie ledger row is reaped before admission; control: a live row with a raw multi-space lstart holds its slot", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const { live, zombie, stop } = await subjects(root);
	try {
		expect((await probeIncarnation(zombie)).state).toBe("zombie");
		// The pre-5m6ej probe (kill -0, then compare the start) read this row alive: kill -0 succeeds on a zombie.
		expect(() => process.kill(zombie.pid, 0)).not.toThrow();
		const jobs = await seedJob(root, { id: "zombie-owner", pid: zombie.pid, process_start: zombie.start });
		const reaped = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "printf fresh"], QUIET_LOAD);
		expect(reaped.code).toBe(0);
		expect(reaped.stdout).toBe("fresh");
		expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual([]);
		// Control: a live owner recorded with the raw pre-5m6ej lstart (a run of spaces) still holds the only slot.
		await seedJob(root, { id: "live-owner", pid: live.pid, process_start: live.start.replace(" ", "   ") });
		const held = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "printf fresh"], QUIET_LOAD);
		expect(held.code).toBe(75);
		expect(held.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
		expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual(["live-owner.json"]);
	} finally {
		await stop();
	}
}, 60_000);

test.concurrent("a zero wait budget returns 75 when admission remains blocked", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 0 });
	await seedJob(root, { id: "timeout-owner" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "exit 0"]);

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
	expect(result.stderr).toContain("queue timeout");
});

test("two concurrent runs serialize on one slot", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const firstEnd = join(root, "first.end");
	const secondStart = join(root, "second.start");
	const a = invoke(root, ["heavy", "--label", "first", "--", "sh", "-c", `sleep 2; date +%s%N > '${firstEnd}'`]);
	await waitForLedgerState(root, "running", 15000);
	const b = invoke(root, ["heavy", "--label", "second", "--", "sh", "-c", `date +%s%N > '${secondStart}'`]);
	const [ra, rb] = await Promise.all([a, b]);
	expect(ra.code).toBe(0);
	expect(rb.code).toBe(0);
	const firstEndNs = Number(readFileSync(firstEnd, "utf8").trim());
	const secondStartNs = Number(readFileSync(secondStart, "utf8").trim());
	expect(secondStartNs).toBeGreaterThanOrEqual(firstEndNs);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test.concurrent("the child runs ten nice points above its parent when the platform can raise it", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 5 });
	const result = await invoke(root, ["heavy", "--label", "nicecheck", "--", "sh", "-c", "ps -o nice= -p $$; ps -o nice= -p $PPID"]);
	expect(result.code).toBe(0);
	const [childNice, parentNice] = result.stdout.trim().split("\n").map((line) => Number(line.trim()));
	expect(Number.isInteger(childNice) && Number.isInteger(parentNice)).toBe(true);
	// Platforms differ in their maximum nice value. When the parent is already
	// >= 10, the requested +10 may be capped or otherwise platform-specific.
	if (parentNice! >= 10) return;
	expect(childNice! - parentNice!).toBe(10);
	// macos-15 CI hit the 5 s default at 5008 ms (bun spawn + admission under load); measured cause.
}, 30000);

test.concurrent("SIGINT releases the slot with exit 130", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const child = Bun.spawn([process.execPath, entry, "heavy", "--label", "interruptible", "--", "sleep", "30"], {
		cwd: root,
		env: heavyEnv(root),
		stdin: "ignore", stdout: "ignore", stderr: "pipe",
	});
	await waitForLedgerState(root, "running", 15000);
	child.kill("SIGINT");
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	expect(code).toBe(130);
	expect(stderr).toBe("");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
// macos-15 CI hit the 5 s default at 5002 ms (spawn + ledger poll under load); measured cause.
}, fixtureDeadlineS(30) * 1000);

test.concurrent("SIGTERM releases the slot with exit 143", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const child = Bun.spawn([process.execPath, entry, "heavy", "--label", "terminable", "--", "sleep", "30"], {
		cwd: root,
		env: heavyEnv(root),
		stdin: "ignore", stdout: "ignore", stderr: "pipe",
	});
	await waitForLedgerState(root, "running", 15000);
	child.kill("SIGTERM");
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	expect(code).toBe(143);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
// Same measured cause as above.
}, fixtureDeadlineS(30) * 1000);

test("planted contention queues the job even with a free slot", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 2 });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "contended", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred:");
	expect(result.stderr).toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("planted no-wait under contention exits 75 without starting", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 30 });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "contended-nowait", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred:");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("a waiting job reports position, running jobs and the contention reason", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 3 });
	const result = await invoke(root, ["heavy", "--label", "waiter", "--", "sh", "-c", "exit 0"],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("heavy: queue position 1;");
	expect(result.stderr).toContain("running=none");
	expect(result.stderr).toContain("LOAD1");
	expect(result.stderr).toContain("deferred:");
});

// RELFAILFAST1 (ompkit-fp72.120.16.104, Joshua J-2026-11-03-34): a caller with a short budget caps the queue wait, so a
// held queue is named in seconds instead of surfacing as the caller's own timeout (0.2.86: a 900 s ladder test against
// the 900 s default queue wait).
test.concurrent("RELFAILFAST1 OMP_KIT_HEAVY_MAX_WAIT_S defers a held job at the cap, below load.json's wait", async () => {
	const root = fixture();
	// load.json allows a 600 s wait; only the 2 s cap can end the queue inside the 45 s deadline. kitlib run() owns the
	// child's process group, so an uncapped (mutant) child is stopped at the deadline instead of queueing on for 600 s.
	configure(root, { slots: 2, max_wait_s: 600 });
	const marker = join(root, "should-not-run");
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(heavyEnv(root, { OMP_KIT_HEAVY_FAKE_LOAD1: "9999", OMP_KIT_HEAVY_MAX_WAIT_S: "2" })))
		if (value !== undefined) env[name] = value;
	const result = await run([process.execPath, "--preload", forgeHealthyStatfs, entry, "heavy", "--label", "capped", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ deadline_s: 45, cwd: root, env });
	const stderr = new TextDecoder().decode(result.stderr);
	expect(result.timed_out, stderr).toBe(false);
	expect(result.rc).toBe(75);
	const deferral = stderr.split("\n").find(line => line.startsWith("deferred:"));
	expect(deferral).toBeDefined();
	expect(deferral).toContain("queue timeout");
	expect(stderr).toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
}, 60000);

test.concurrent("RELFAILFAST1 an invalid OMP_KIT_HEAVY_MAX_WAIT_S refuses before running anything", async () => {
	const root = fixture();
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "bad-cap", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_MAX_WAIT_S: "2m" });
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("OMP_KIT_HEAVY_MAX_WAIT_S must be whole seconds");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("GITHUB_ACTIONS=true bypasses LOAD1 and starts the command", async () => {
	const root = fixture();
	// This checks the LOAD1 exemption, not a one-second admission deadline.
	// Allow the measured process-start tail without changing no-wait behaviour.
	configure(root, { slots: 1, max_wait_s: fixtureDeadlineS(30) });
	const marker = join(root, "gha-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "gha-load", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ GITHUB_ACTIONS: "true", OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test.concurrent("CI=1 alone does not bypass LOAD1 admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const marker = join(root, "ci-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "ci-load", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ CI: "1", GITHUB_ACTIONS: "", OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
});

test.concurrent("GITHUB_ACTIONS load exemption preserves slot admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "gha-slot-owner" });
	const marker = join(root, "slot-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "gha-slot", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ GITHUB_ACTIONS: "true", OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("all 1 heavy-work slot is occupied");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual(["gha-slot-owner.json"]);
});

afterAll(() => cleanupAllOwnedTmp());
