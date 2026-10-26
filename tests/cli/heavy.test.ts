import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { incarnation, probeIncarnation } from "../../src/kitlib/proc";
import { run } from "../../src/kitlib/run";
import { type DiskCapacity, decideDiskPressure, type DiskVerdict, diskVerdict, HEAVY_DISK_NEED_BYTES, HEAVY_PREREQ_MISSING, machineLoadBlockReason } from "../../src/heavy.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

function fixture(): string {
	const root = join(process.cwd(), "var", "agent-tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = ownedTmp("heavy-test", { root }).path;
	return dir;
}

function configure(root: string, values: { slots?: number; max_wait_s?: number; disk_observer?: "sbh" | "statfs" | "auto"; disk_floor_pct?: number | null; default_runtime_s?: number; runtime_budget_s?: Record<string, number> }): void {
	const directory = join(root, "config", "omp-kit");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "load.json"), JSON.stringify(values), { mode: 0o600 });
}

// Queue and load tests run at a controlled healthy disk reading; the native
// cases below separately exercise the real pressure boundary and its mutant.
function heavyEnv(root: string, extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
	const healthy = fakeSbh(root, 0, "healthy-bin");
	return { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${healthy}:${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test", GITHUB_ACTIONS: "", OMP_KIT_DISK_OBSERVER: "", ...QUIET_LOAD, ...extraEnv };
}

async function invoke(root: string, args: string[], extraEnv: Record<string, string> = {}, options: { cwd?: string; preload?: string | null } = {}) {
	const preloadPath = options.preload === null ? undefined : options.preload ?? forgeHealthyStatfs;
	const preload = preloadPath ? ["--preload", preloadPath] : [];
	const child = Bun.spawn([process.execPath, ...preload, entry, ...args], {
		cwd: options.cwd ?? root,
		env: heavyEnv(root, extraEnv),
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

async function seedJob(root: string, input: { id: string; pid?: number; process_start?: string; pane?: string; state?: "queued" | "running" }): Promise<string> {
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
		id: input.id, pid: input.pid ?? process.pid, process_start: processStart, label: "existing", repo: root, cwd: root,
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

test("SCANNERADMIT refuses a zero-budget start while GITHUB_ACTIONS bypasses LOAD1", async () => {
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

test("SCANNERADMIT preserves genuine child exit 75 without refusal marker", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 5 });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "exit 75"]);
	expect(result.code).toBe(75);
	expect(result.stderr).not.toContain("RESOURCE_DEFERRED");
});

// Separate processes own these platform-clock deadlines; parent fake timers cannot drive them. They run through the
// real CLI entry (`omp-kit heavy --max-runtime`), the path users and gates take.
async function invokeRuntime(root: string, maxRuntime?: string, label = "runtime", childCode = "setTimeout(() => process.exit(7), 30000)") {
	return invoke(root, ["heavy", "--label", label, ...(maxRuntime === undefined ? [] : ["--max-runtime", maxRuntime]),
		"--", process.execPath, "-e", childCode]);
}

test("HEAVYRUNTIME planted: admitted child outlives admission wait and preserves exit 7", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 2 });
	const result = await invokeRuntime(root, "30", "planted", "setTimeout(() => process.exit(7), 4000)");
	expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 7, stderr: "" });
}, 15000);

test("HEAVYRUNTIME control: never admitted still defers at queue timeout", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "held" });
	const result = await invoke(root, ["heavy", "--", process.execPath, "-e", "process.exit(7)"]);
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("RESOURCE_DEFERRED");
	expect(result.stderr).toContain("queue timeout");
	expect(readdirSync(jobs)).toEqual(["held.json"]);
}, 10000);

test("HEAVYRUNTIME cuts runtime at flag budget and removes the job", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5, runtime_budget_s: { runtime: 3 } });
	const result = await invokeRuntime(root, "2");
	expect(result.code).toBe(124);
	expect(result.stderr).toContain("RUNTIME_BUDGET_EXCEEDED: child ran ");
	expect(result.stderr).toContain("> --max-runtime 2s (label runtime)");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs"))).toEqual([]);
}, 15000);

test("HEAVYRUNTIME declared label table stops child; undeclared label has no global default", async () => {
	const root = fixture();
	// The removed global fallback is scaled to one second; the child crosses it.
	configure(root, { max_wait_s: 5, default_runtime_s: 1, runtime_budget_s: { runtime: 1 } });
	const labeled = await invokeRuntime(root);
	expect(labeled.code).toBe(124);
	expect(labeled.stderr).toContain("1s (label runtime)");
	expect(labeled.stderr).toContain("source=label table load.json runtime_budget_s.runtime");
	const fallback = await invokeRuntime(root, undefined, "other", "setTimeout(() => process.exit(7), 2200)");
	expect({ code: fallback.code, stderr: fallback.stderr }).toEqual({ code: 7, stderr: "" });
}, 15000);

test("HEAVYRUNTIME explicit flag overrides the label table", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5, runtime_budget_s: { runtime: 1 } });
	const result = await invokeRuntime(root, "4", "runtime", "setTimeout(() => process.exit(7), 2200)");
	expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 7, stderr: "" });
}, 10000);

test("HEAVYRUNTIME shipped label table and global-default mutant use the real CLI", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5 });
	// The child uses a real process clock; parent fake timers cannot drive it.
	// Scale only this shipped row to 1s, then restore the old global fallback in memory.
	const preload = join(root, "runtime-probe.ts");
	const probe = (mutant: boolean) => {
		writeFileSync(preload, `
			import ${JSON.stringify(forgeHealthyStatfs)};
			import { plugin } from "bun";
			import { readFileSync } from "node:fs";
			plugin({ name: "runtime-budget-probe", setup(build) {
				build.onLoad({ filter: /heavy[.]ts$/ }, ({ path }) => {
					let contents = readFileSync(path, "utf8");
					const original = "const runtimeSeconds = flagRuntime ?? configured ?? declared?.seconds;";
					const replacement = ${JSON.stringify(mutant
						? "const runtimeSeconds = flagRuntime ?? configured ?? (job.label === \"cli-tests\" && declared ? 1 : declared?.seconds) ?? 1;"
						: "const runtimeSeconds = flagRuntime ?? configured ?? (job.label === \"cli-tests\" && declared ? 1 : declared?.seconds);")};
					if (!contents.includes(original)) throw new Error("runtime probe target missing");
					contents = contents.replace(original, replacement);
					return { contents, loader: "ts" };
				});
			}});
		`);
	};
	const args = (label: string) => ["heavy", "--label", label, "--", process.execPath, "-e",
		'console.log("CHILD_START"); setTimeout(() => { console.log("CHILD_DONE"); process.exit(7) }, 2200)'];
	probe(false);
	const declared = await invoke(root, args("cli-tests"), {}, { preload });
	expect(declared.code).toBe(124);
	expect(declared.stdout).toContain("CHILD_START");
	expect(declared.stdout).not.toContain("CHILD_DONE");
	expect(declared.stderr).toContain("1s (label cli-tests)");
	expect(declared.stderr).toContain("source=label table config/heavy-labels.json");
	const control = await invoke(root, args("undeclared-runtime-probe"), {}, { preload });
	expect(control.code).toBe(7);
	expect(control.stdout).toContain("CHILD_DONE");
	expect(control.stderr).toBe("");
	probe(true);
	const mutant = await invoke(root, args("undeclared-runtime-probe"), {}, { preload });
	expect(mutant.stdout).toContain("CHILD_START");
	expect(mutant.stdout).not.toContain("CHILD_DONE");
	expect(mutant.code).toBe(124);
	expect(mutant.stderr).toContain("source=none");
}, 15000);

test("HEAVYRUNTIME rejects nonpositive and noninteger flag budgets", async () => {
	const root = fixture();
	for (const value of ["0", "abc", "1.5", "-1"]) {
		const result = await invokeRuntime(root, value);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("--max-runtime");
	}
}, 15000);

test("HEAVYRUNTIME escalates a SIGTERM-resistant child after the grace period", async () => {
	const root = fixture();
	configure(root, { max_wait_s: 5 });
	const result = await invokeRuntime(root, "1", "resistant",
		'process.on("SIGTERM", () => process.stdout.write("term-received")); setTimeout(() => process.exit(7), 30000)');
	expect(result.code).toBe(124);
	expect(result.stdout).toBe("term-received");
	expect(result.stderr).toContain("> --max-runtime 1s (label resistant)");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs"))).toEqual([]);
}, 20000);

test("HEAVYRUNTIME long positive budgets do not overflow native timers", async () => {
	const root = fixture();
	const result = await invokeRuntime(root, "2147484", "long", "setTimeout(() => process.exit(7), 100)");
	expect(result.code).toBe(7);
	expect(result.stderr).toBe("");
}, 10000);

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

test("5m6ej planted: a zombie ledger row is reaped before admission; control: a live row with a raw multi-space lstart holds its slot", async () => {
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

test("the child runs ten nice points above its parent when the platform can raise it", async () => {
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
	configure(root, { slots: 8, max_wait_s: 20, disk_observer: "sbh" });
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
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "sbh" });
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
const GIB = 1024 ** 3;

type Decide = (capacity: DiskCapacity | null, floorPct: number | null) => DiskVerdict;

// The original oq1h.1 decision matrix as named cases, so the same assertions can also be pointed at
// planted mutants through the injected boundary (no environment seam).
const HEALTHY_CASE = "healthy: 100 GiB free runs";
const PRESSURE_CASE = "pressure: 5 GiB free defers";
const FLOOR_CASE = "floor: percent below disk_floor_pct defers";
const FAILURE_CASE = "failure: an unreadable statfs is unavailable, never healthy";
const STATFS_CASES: Record<string, (decide: Decide) => void> = {
	[HEALTHY_CASE]: (decide) => {
		expect(decide({ freeBytes: 100 * GIB, freePct: 50 }, null)).toEqual({ kind: "ok", observer: "statfs" });
	},
	[PRESSURE_CASE]: (decide) => {
		expect(decide({ freeBytes: 5 * GIB, freePct: 50 }, null)).toEqual({ kind: "pressure", text: "disk low (statfs)", observer: "statfs" });
	},
	[FLOOR_CASE]: (decide) => {
		const floor = decide({ freeBytes: 100 * GIB, freePct: 30 }, 40);
		expect(floor.kind).toBe("pressure");
		if (floor.kind === "pressure") expect(floor.text).toContain("disk low (statfs)");
	},
	[FAILURE_CASE]: (decide) => {
		expect(decide(null, null)).toEqual({ kind: "unavailable", text: "no disk observer available", observer: "statfs" });
	},
};

// A kill is a case's own assertion failing (Bun reports it as an Error whose message starts "expect(").
// Anything else, such as a mutant that crashes or a case that cannot run, is a setup error: it must surface
// instead of being counted as a kill.
function failingCases(decide: Decide): string[] {
	return Object.entries(STATFS_CASES).flatMap(([name, check]) => {
		try {
			check(decide);
			return [];
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("expect(")) return [name];
			throw new Error(`setup error in statfs case "${name}": ${String(error)}`, { cause: error });
		}
	});
}

test("oq1h.1 unit: statfs decision matrix without environment", () => {
	for (const check of Object.values(STATFS_CASES)) check(decideDiskPressure);
});

test("oq1h.1 planted: each statfs mutant is killed by exactly the cases that guard it", () => {
	const healthy: DiskVerdict = { kind: "ok", observer: "statfs" };
	const mutants: Record<string, { decide: Decide; killedBy: string[] }> = {
		"always healthy (forced ok): the 5 GiB pressure case fails": {
			decide: () => healthy, killedBy: [PRESSURE_CASE, FLOOR_CASE, FAILURE_CASE] },
		"always pressure": {
			decide: () => ({ kind: "pressure", text: "disk low (statfs)", observer: "statfs" }), killedBy: [HEALTHY_CASE, FAILURE_CASE] },
		"floor ignored": {
			decide: (capacity) => decideDiskPressure(capacity, null), killedBy: [FLOOR_CASE] },
		"unreadable statfs treated as healthy": {
			decide: (capacity, floor) => capacity === null ? healthy : decideDiskPressure(capacity, floor), killedBy: [FAILURE_CASE] },
		"sbh-only (no statfs observer)": {
			decide: () => ({ kind: "unavailable", text: "no disk observer available", observer: "statfs" }), killedBy: [HEALTHY_CASE, PRESSURE_CASE, FLOOR_CASE] },
	};
	// Positive control: the real decider fails none of the cases, so a kill below is the mutant's doing.
	expect(failingCases(decideDiskPressure)).toEqual([]);
	// Setup errors are not kills: a decider that crashes surfaces as an error, never as a silently killed mutant.
	expect(() => failingCases(() => { throw new TypeError("decider crashed"); })).toThrow("setup error in statfs case");
	for (const [name, mutant] of Object.entries(mutants)) {
		expect({ mutant: name, killed: failingCases(mutant.decide).sort() }).toEqual({ mutant: name, killed: [...mutant.killedBy].sort() });
	}
});

test("oq1h.1: auto prefers a failing sbh over healthy statfs (sbh precedence)", async () => {
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

test("oq1h.1: auto with an erroring sbh fails fast with 69 naming the escape", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 20 });
	const bin = fakeSbh(root, 2);
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "sbh-err-auto", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	expect(result.code).toBe(HEAVY_PREREQ_MISSING);
	expect(result.stderr).toContain("disk_observer");
	expect(existsSync(marker)).toBe(false);
}, 40_000);

// ---- oq1h.1 native cases: the real statfs through the real CLI -----------------------------------------
// Native cases use a real small filesystem for pressure. The test-only preload
// is limited to queue baselines and the planted forced-healthy mutant below.
const NO_SBH_PATH = "/usr/bin:/bin";
const forgeHealthyStatfs = resolve(import.meta.dir, "fixtures", "forge-healthy-statfs.ts");

function measure(directory: string): { freeBytes: number; freePct: number } {
	const observed = statfsSync(directory);
	return { freeBytes: Number(observed.bavail) * Number(observed.bsize), freePct: Math.min(100, (Number(observed.bavail) / Number(observed.blocks)) * 100) };
}

// A real filesystem with less than the 10 GiB admission need, so pressure is observed, not injected.
// Linux: /dev/shm, a tmpfs sized from RAM (about 7.8 GiB on GitHub's 16 GB runners). Elsewhere set
// OMP_KIT_TEST_LOW_FS_DIR to a directory on a small mounted volume (macOS: hdiutil create -size 200m -fs APFS -attach).
function lowCapacityBase(): string | null {
	for (const candidate of [process.env.OMP_KIT_TEST_LOW_FS_DIR, process.platform === "linux" ? "/dev/shm" : undefined]) {
		if (!candidate) continue;
		try {
			if (measure(candidate).freeBytes < HEAVY_DISK_NEED_BYTES) return candidate;
		} catch { /* absent or unreadable: try the next candidate */ }
	}
	return null;
}

const LOW_BASE = lowCapacityBase();
// On GitHub's Linux runners the pressure cases are not optional: a runner whose /dev/shm outgrew the need must fail, not skip.
const LOW_FS_REQUIRED = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";

async function onLowFilesystem(body: (directory: string) => Promise<void>): Promise<void> {
	const directory = ownedTmp("omp-kit-heavy-test", { root: LOW_BASE as string }).path;
	writeFileSync(join(directory, ".owner"), `pid=${process.pid} label=heavy-test-lowfs created=${new Date().toISOString()}\n`, { mode: 0o600 });
	try {
		expect(measure(directory).freeBytes).toBeLessThan(HEAVY_DISK_NEED_BYTES);
		await body(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// One real `heavy --no-wait` of a marker-writing command with `cwd` as the measured directory.
async function nativeRun(input: { cwd: string; config?: Parameters<typeof configure>[1]; sbh?: 0 | 1; preload?: string }) {
	// Positive control for the planted state: this PATH must really lack sbh.
	expect(Bun.spawnSync(["/bin/sh", "-c", "command -v sbh"], { env: { PATH: NO_SBH_PATH } }).exitCode).not.toBe(0);
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, ...input.config });
	const path = input.sbh === undefined ? NO_SBH_PATH : `${fakeSbh(root, input.sbh, "native-bin")}:${NO_SBH_PATH}`;
	const marker = join(root, "native-marker");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "oq1h1-native", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: path }, { cwd: input.cwd, preload: input.preload ?? null });
	return { code: result.code, stderr: result.stderr, ran: existsSync(marker) };
}

test.skipIf(!LOW_FS_REQUIRED)("oq1h.1 native: GitHub's Linux runner offers a real filesystem below the 10 GiB need", () => {
	expect(LOW_BASE).not.toBeNull();
});

test.skipIf(LOW_BASE === null)("oq1h.1 native: statfs pressure on a real low-capacity filesystem defers 75 and never starts the command", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd });
		expect(result.code).toBe(75);
		expect(result.stderr).toContain("disk low (statfs)");
		expect(result.ran).toBe(false);
	});
});

test.skipIf(LOW_BASE === null)("oq1h.1 planted: a forged-healthy statfs reading starts the command on the same real low filesystem", async () => {
	await onLowFilesystem(async (cwd) => {
		const honest = await nativeRun({ cwd });
		expect(honest.code).toBe(75);
		expect(honest.ran).toBe(false);
		// The mutant: only the statfs reading is forced healthy. The 75 above is what the pressure case would then lose.
		const forced = await nativeRun({ cwd, preload: forgeHealthyStatfs });
		expect(forced.code).toBe(0);
		expect(forced.ran).toBe(true);
	});
});

test.skipIf(LOW_BASE === null)("SAVEFIRST1: explicit statfs returns typed floor refusal", async () => {
	await onLowFilesystem(async (cwd) => {
		const root = fixture();
		configure(root, { slots: 8, max_wait_s: 0 });
		const marker = join(root, "savefirst-floor-marker");
		const result = await invoke(root, ["heavy", "--disk-observer", "statfs", "--", "touch", marker], QUIET_LOAD, { cwd, preload: null });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G");
		expect(result.stderr).toContain("free at least 10 GiB");
		expect(existsSync(marker)).toBe(false);
	});
});

test.skipIf(LOW_BASE === null)("oq1h.1 native: auto lets a healthy sbh decide over real statfs pressure (sbh precedence)", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd, sbh: 0 });
		expect(result.code).toBe(0);
		expect(result.ran).toBe(true);
	});
});

test.skipIf(LOW_BASE === null)("oq1h.1 native: disk_observer statfs never consults sbh, so a healthy sbh cannot hide real pressure", async () => {
	await onLowFilesystem(async (cwd) => {
		const result = await nativeRun({ cwd, sbh: 0, config: { disk_observer: "statfs" } });
		expect(result.code).toBe(75);
		expect(result.stderr).toContain("disk low (statfs)");
		expect(result.ran).toBe(false);
	});
});

test("oq1h.1 native: with no sbh the statfs verdict on the fixture disk equals the independent measurement", async () => {
	const cwd = fixture();
	const pressured = measure(cwd).freeBytes < HEAVY_DISK_NEED_BYTES;
	const result = await nativeRun({ cwd });
	expect(result.code).toBe(pressured ? 75 : 0);
	expect(result.ran).toBe(!pressured);
	if (pressured) expect(result.stderr).toContain("disk low (statfs)");
});

test("oq1h.1 native: disk_floor_pct reaches the real CLI verdict", async () => {
	const cwd = fixture();
	const { freeBytes, freePct } = measure(cwd);
	const pressured = freeBytes < HEAVY_DISK_NEED_BYTES || freePct < 50;
	const result = await nativeRun({ cwd, config: { disk_floor_pct: 50 } });
	expect(result.code).toBe(pressured ? 75 : 0);
	expect(result.ran).toBe(!pressured);
});

test("oq1h.1 native: a floor above the measured percent defers through diskVerdict", async () => {
	const verdict = await diskVerdict({ config: { slots: 2, max_wait_s: 1, disk_observer: "statfs", disk_floor_pct: 100 }, cwd: fixture() });
	expect(verdict.kind).toBe("pressure");
	if (verdict.kind === "pressure") {
		expect(verdict.observer).toBe("statfs");
		expect(verdict.text).toContain("disk low (statfs)");
	}
});

test("SAVEFIRST1: explicit statfs saves bypass percent-stage refusal but auto and sbh retain it", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "auto", disk_floor_pct: 20 });
	const statfsFixture = join(root, "nine-percent-statfs.ts");
	writeFileSync(statfsFixture, `
import { mock } from "bun:test";
import * as realFs from "node:fs";
const snapshot = { ...realFs };
const realStatfs = realFs.statfsSync;
function ninePercentStatfs(path: realFs.PathLike, options?: never) {
	const observed = realStatfs(path, options);
	const blockSize = Number(observed.bsize);
	const bavail = Math.floor((12 * 1024 ** 3) / blockSize);
	return { ...observed, bavail, blocks: Math.ceil(bavail / 0.09) };
}
mock.module("node:fs", () => ({ ...snapshot, default: { ...snapshot, statfsSync: ninePercentStatfs }, statfsSync: ninePercentStatfs }));
`);
	const marker = join(root, "explicit-statfs-marker");
	const admittedByFlag = await invoke(root,
		["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "save-statfs-flag", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: NO_SBH_PATH }, { preload: statfsFixture });
	expect(admittedByFlag.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");

	const envMarker = join(root, "env-statfs-marker");
	const admittedByEnvironment = await invoke(root,
		["heavy", "--no-wait", "--label", "save-statfs-env", "--", "sh", "-c", `printf ran > '${envMarker}'`],
		{ OMP_KIT_DISK_OBSERVER: "statfs", PATH: NO_SBH_PATH }, { preload: statfsFixture });
	expect(admittedByEnvironment.code).toBe(0);
	expect(readFileSync(envMarker, "utf8")).toBe("ran");

	for (const observer of ["auto", "sbh"] as const) {
		configure(root, { slots: 8, max_wait_s: 1, disk_observer: observer });
		const generic = await invoke(root,
			["heavy", "--no-wait", "--label", `generic-${observer}`, "--", "sh", "-c", "exit 0"],
			{ PATH: NO_SBH_PATH }, { preload: statfsFixture });
		expect(generic.code).toBe(10);
		expect(generic.stdout).toContain("DISK_HEAVY_REFUSED");
	}
});

// ---- SAVEFIRST1 (ompkit-774u.16): --disk-observer lets a save path admit on physical bytes -------------
// The fixture disk must really hold the 10 GiB need for the "ample bytes" half; a runner without it
// skips by name rather than passing on a different state.
const FIXTURE_AMPLE = measure(process.cwd()).freeBytes >= HEAVY_DISK_NEED_BYTES;

test.skipIf(!FIXTURE_AMPLE)("SAVEFIRST1 planted: --disk-observer statfs admits under sbh pressure when the bytes physically fit (needs >= 10 GiB free)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const pressured = { PATH: `${fakeSbh(root, 1)}:${process.env.PATH ?? ""}:/usr/bin:/bin` };
	const control = join(root, "control-marker");
	// Positive control for the plant: without the flag this sbh really refuses.
	const refused = await invoke(root, ["heavy", "--no-wait", "--label", "sbh-veto", "--", "sh", "-c", `printf ran > '${control}'`], pressured);
	expect(refused.code).toBe(75);
	expect(refused.stderr).toContain("disk low: sbh check --need 10G reports pressure");
	// MACHINEMEASURES1 (ompkit-774u.9.22): the OS reading sits beside the sbh verdict so a wedge is visible.
	expect(refused.stderr).toMatch(/RESOURCE_DEFERRED: disk low: sbh check --need 10G reports pressure; statfs: \d+\.\d GB free \(\d+\.\d%\)/);
	expect(existsSync(control)).toBe(false);
	const marker = join(root, "saved-marker");
	const admitted = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "save-path", "--", "sh", "-c", `printf ran > '${marker}'`], pressured);
	expect(admitted.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
});

test("SAVEFIRST1: --disk-observer overrides load.json, so a missing sbh named there cannot block a statfs call", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1, disk_observer: "sbh" });
	const noSbh = { PATH: "/usr/bin:/bin" };
	const strict = await invoke(root, ["heavy", "--no-wait", "--label", "cfg-sbh", "--", "sh", "-c", "exit 0"], noSbh);
	expect(strict.code).toBe(HEAVY_PREREQ_MISSING);
	const marker = join(root, "override-marker");
	const overridden = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "cfg-override", "--", "sh", "-c", `printf ran > '${marker}'`], noSbh);
	const pressured = measure(root).freeBytes < HEAVY_DISK_NEED_BYTES;
	expect(overridden.code).toBe(pressured ? 75 : 0);
	expect(existsSync(marker)).toBe(!pressured);
	expect(overridden.stderr).not.toContain("sbh unavailable");
});

test("SAVEFIRST1: an unknown --disk-observer value runs nothing", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 1 });
	const marker = join(root, "bogus-marker");
	const result = await invoke(root, ["heavy", "--disk-observer", "bytes", "--", "sh", "-c", `printf ran > '${marker}'`]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain('--disk-observer must be "statfs", "sbh" or "auto", got "bytes"');
	expect(existsSync(marker)).toBe(false);
});

test.skipIf(LOW_BASE === null)("SAVEFIRST1 planted: --disk-observer statfs still refuses below the 10 GiB physical floor, whatever sbh says", async () => {
	await onLowFilesystem(async (cwd) => {
		const root = fixture();
		configure(root, { slots: 8, max_wait_s: 1 });
		const marker = join(root, "lowfs-marker");
		const result = await invoke(root, ["heavy", "--no-wait", "--disk-observer", "statfs", "--label", "lowfs-save", "--", "sh", "-c", `printf ran > '${marker}'`],
			{ PATH: `${fakeSbh(root, 0, "native-bin")}:${NO_SBH_PATH}` }, { cwd, preload: null });
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("heavy: REFUSED reason=DISK_BELOW_FLOOR need=10G");
		expect(result.stderr).toContain("free at least 10 GiB");
		expect(existsSync(marker)).toBe(false);
	});
});

test.skipIf(!FIXTURE_AMPLE)("SAVEFIRST1: a waiting job re-reads load.json each poll, so an observer change admits it before its deadline (needs >= 10 GiB free)", async () => {
	const root = fixture();
	configure(root, { slots: 8, max_wait_s: 8 });
	const marker = join(root, "refresh-marker");
	const started = Date.now();
	const run = invoke(root, ["heavy", "--label", "stale-config", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ PATH: `${fakeSbh(root, 1)}:${process.env.PATH ?? ""}:/usr/bin:/bin` });
	await waitForLedgerState(root, "queued", 15_000);
	configure(root, { slots: 8, max_wait_s: 8, disk_observer: "statfs" });
	const result = await run;
	expect(result.code).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("ran");
	expect(Date.now() - started).toBeLessThan(8_000);
}, 30_000);

afterAll(() => cleanupAllOwnedTmp());
