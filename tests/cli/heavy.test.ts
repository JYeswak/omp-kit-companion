import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { HEAVY_PREREQ_MISSING, machineLoadBlockReason } from "../../src/heavy.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

function fixture(): string {
	const root = join(process.cwd(), "var", "agent-tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(root, `heavy-test.${process.pid}.`));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid} label=heavy-test repo=${process.cwd()} created=${new Date().toISOString()}\n`, { mode: 0o600 });
	return dir;
}

function configure(root: string, values: { slots?: number; max_wait_s?: number }): void {
	const directory = join(root, "config", "omp-kit");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "load.json"), JSON.stringify(values), { mode: 0o600 });
}

// Disk is machine state like load: every run puts a healthy stand-in sbh first
// on PATH so the host's free space never decides a slot, signal or load test.
// The HEAVYDISK1/HEAVYCI1 tests override PATH to plant each disk state.
function heavyEnv(root: string, extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
	const healthy = fakeSbh(root, 0, "healthy-bin");
	return { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${healthy}:${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test", GITHUB_ACTIONS: "", ...QUIET_LOAD, ...extraEnv };
}

async function invoke(root: string, args: string[], extraEnv: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: root,
		env: heavyEnv(root, extraEnv),
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

async function seedJob(root: string, input: { id: string; process_start?: string; pane?: string; state?: "queued" | "running" }): Promise<string> {
	const stateRoot = join(root, "state", "omp-kit", "load");
	const directory = join(stateRoot, "jobs");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let processStart = input.process_start;
	if (!processStart) {
		const child = Bun.spawn(["ps", "-p", String(process.pid), "-o", "lstart="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const output = await new Response(child.stdout).text();
		processStart = await child.exited === 0 ? output.trim() : "";
	}
	if (!processStart) throw new Error("test process start is unavailable");
	writeFileSync(join(directory, `${input.id}.json`), JSON.stringify({
		id: input.id, pid: process.pid, process_start: processStart, label: "existing", repo: root, cwd: root,
		agent: "seed", tmux_pane: input.pane ?? "", argv: ["held-job"], state: input.state ?? "running",
		queued_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
	}), { mode: 0o600 });
	return directory;
}

test("machine admission blocks only above 2.5 times the core count", () => {
	expect(machineLoadBlockReason(80, 32)).toBeNull();
	expect(machineLoadBlockReason(80.01, 32)).toContain("LOAD1");
	expect(machineLoadBlockReason(1, 4)).toBeNull();
});

 // Slot-logic tests pin the heavy-specific load seam so the
 // slot behavior under test, not ambient runner load, decides the outcome.
 // The LOAD1 gate itself stays covered by the machineLoadBlockReason tests.
 const QUIET_LOAD = { OMP_KIT_HEAVY_FAKE_LOAD1: "0.5" };
 test("heavy streams the child and preserves its exit code", async () => {
 	const root = fixture();
 	configure(root, { slots: 1, max_wait_s: 1 });
 	const result = await invoke(root, ["heavy", "--label", "tiny", "--", "sh", "-c", "printf child; exit 23"], QUIET_LOAD);

	expect(result.code).toBe(23);
	expect(result.stdout).toBe("child");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("no-wait defers on a full machine slot without starting the command", async () => {
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

test("a pane cannot start a second heavy command when another global slot is free", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 1 });
	await seedJob(root, { id: "pane-owner", pane: "%heavy-pane" });
 	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "exit 0"], { TMUX_PANE: "%heavy-pane", ...QUIET_LOAD });

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("pane already has running job existing");
});

test("process-reused ledger entries are reaped before admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "reused-owner", process_start: "not-this-process-start" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "printf fresh"]);

	expect(result.code).toBe(0);
	expect(result.stdout).toBe("fresh");
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("a zero wait budget returns 75 when admission remains blocked", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 0 });
	await seedJob(root, { id: "timeout-owner" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "exit 0"]);

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
	expect(result.stderr).toContain("queue timeout");
});
// Integration tests below drive real child processes (slot handoff, signal
// delivery); fake timers cannot stand in, so coordination waits poll the job
// ledger for the awaited state with a deadline instead of sleeping blindly.
async function waitForLedgerState(root: string, want: "queued" | "running" | "empty", timeoutMs: number): Promise<void> {
	const directory = join(root, "state", "omp-kit", "load", "jobs");
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
		} catch { /* jobs dir appears on first write */ }
		if (want === "empty" && entries.length === 0) return;
		if (want === "queued" || want === "running") {
			for (const name of entries) {
				try {
					if (JSON.parse(readFileSync(join(directory, name), "utf8")).state === want) return;
				} catch { /* concurrent write; keep polling */ }
			}
		}
		await Bun.sleep(100);
	}
	throw new Error(`ledger never reached ${want} within ${timeoutMs}ms`);
}


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

test("the child runs ten nice points above its parent", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 5 });
	const result = await invoke(root, ["heavy", "--label", "nicecheck", "--", "sh", "-c", "ps -o nice= -p $$; ps -o nice= -p $PPID"]);
	expect(result.code).toBe(0);
	const [childNice, parentNice] = result.stdout.trim().split("\n").map((line) => Number(line.trim()));
	expect(Number.isInteger(childNice) && Number.isInteger(parentNice)).toBe(true);
	expect(childNice! - parentNice!).toBe(10);
	// macos-15 CI hit the 5 s default at 5008 ms (bun spawn + admission under load); measured cause.
}, 30000);

test("SIGINT releases the slot with exit 130", async () => {
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
}, 30000);

test("SIGTERM releases the slot with exit 143", async () => {
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
}, 30000);

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

test("planted no-wait under contention exits 75 without starting", async () => {
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

test("GITHUB_ACTIONS=true bypasses LOAD1 and starts the command", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const marker = join(root, "gha-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "gha-load", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ GITHUB_ACTIONS: "true", OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test("CI=1 alone does not bypass LOAD1 admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const marker = join(root, "ci-ran");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "ci-load", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ CI: "1", GITHUB_ACTIONS: "", OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
});

test("GITHUB_ACTIONS load exemption preserves slot admission", async () => {
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

function fakeSbh(dir: string, code: number, name = "fakebin"): string {
	const bin = join(dir, name);
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nif [ "$1 $2 $3" = "check --need 10G" ]; then exit ${code}; fi\nexit 0\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	return bin;
}

// First call healthy (the pre-queue observation); every later call exits laterCode.
function countingSbh(dir: string, laterCode: number): string {
	const bin = join(dir, "counting-bin");
	const calls = join(dir, "sbh-calls");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nn=$(cat '${calls}' 2>/dev/null || echo 0)\nn=$((n + 1))\necho "$n" > '${calls}'\n[ "$n" -le 1 ] && exit 0\nexit ${laterCode}\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	return bin;
}

test("HEAVYDISK1 planted: no-wait defers on sbh pressure without starting", async () => {
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

test("HEAVYDISK1: healthy disk runs the command", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const bin = fakeSbh(root, 0);
	const marker = join(root, "ran-marker");
	const result = await invoke(root, ["heavy", "--label", "diskok", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test("HEAVYCI1 planted: a missing sbh fails fast with 69 on the waiting path, queueing and starting nothing", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const noSbhPath = "/usr/bin:/bin";
	// Positive control for the planted state: this PATH must really lack sbh.
	expect(Bun.spawnSync(["/bin/sh", "-c", "command -v sbh"], { env: { PATH: noSbhPath } }).exitCode).not.toBe(0);
	const marker = join(root, "should-not-run");
	const started = Date.now();
	const result = await invoke(root, ["heavy", "--label", "nosbh", "--", "sh", "-c", `printf ran > '${marker}'`], { PATH: noSbhPath });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("heavy: sbh unavailable: sbh binary not runnable");
	// The pre-fix path waited out the whole 20 s budget and returned 75.
	expect(Date.now() - started).toBeLessThan(8_000);
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
}, 40_000);

test("HEAVYCI1 planted: an sbh error answer is a missing prerequisite (69), never a 75 deferral", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const bin = fakeSbh(root, 2);
	const marker = join(root, "should-not-run");
	const started = Date.now();
	const result = await invoke(root, ["heavy", "--label", "diskerr", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("heavy: sbh unavailable: sbh check exited 2");
	expect(Date.now() - started).toBeLessThan(8_000);
	expect(existsSync(marker)).toBe(false);
}, 40_000);

test("HEAVYCI1: --no-wait with a missing sbh also returns 69, not 75", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "nosbh-nowait", "--", "sh", "-c", "exit 0"], { PATH: "/usr/bin:/bin" });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("sbh unavailable");
});

test("HEAVYCI1: an observer lost while queued fails with 69 at admission and leaves no ledger row", async () => {
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
}, 40_000);

test("HEAVYCI1: a queued job re-observes the disk, so pressure that appears while waiting still defers", async () => {
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
}, 40_000);

test("HEAVYCI1: admission observes the disk after acquiring the state mutex, not before the lock wait (QuietBadger AM57798)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 4 });
	const lock = join(root, "state", "omp-kit", "load", "mutex");
	mkdirSync(lock, { recursive: true, mode: 0o700 });
	const ps = Bun.spawn(["ps", "-p", String(process.pid), "-o", "lstart="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
	const processStart = (await new Response(ps.stdout).text()).trim();
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
	while (!existsSync(calls) && Date.now() - waitStart < 15_000) await Bun.sleep(50);
	expect(existsSync(calls)).toBe(true);
	unlinkSync(join(lock, "owner.json"));
	rmdirSync(lock);
	const result = await run;
	expect(result.code).toBe(75);
	expect(existsSync(marker)).toBe(false);
	expect(Number(readFileSync(calls, "utf8").trim())).toBeGreaterThanOrEqual(2);
}, 40_000);

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
