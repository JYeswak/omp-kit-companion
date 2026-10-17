import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireRunLock, bunCapExec, claimIncarnation, gateRunLoad, LOAD_GATE_FACTOR, OVERLAP_EXIT, readJobOff, readRunClaim, runWithCap, RUN_TIME_CAPS_MS, SKIPPED_LOAD_EXIT, type CapExec } from "../../src/service-run.ts";

mkdirSync(join(resolve(import.meta.dir, "../.."), "var", "agent-tmp"), { recursive: true });
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jobsDir(): string {
	const dir = mkdtempSync(join(scratchRoot, "service-run-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=service-run-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	roots.push(dir);
	return dir;
}

function writeClaimFixture(dir: string, pid: number, startedAt: number): void {
	const lock = join(dir, "load-watch.lock");
	mkdirSync(lock, { mode: 0o700 });
	writeFileSync(join(lock, "pid"), JSON.stringify({ pid, startedAt, token: "fixture-claim" }), { mode: 0o600 });
}

test("SVC1: an unreadable liveness probe cannot authorize stealing a claim", () => {
	const dir = jobsDir();
	writeClaimFixture(dir, process.pid, 1_000_000);
	const before = readFileSync(join(dir, "load-watch.lock", "pid"), "utf8");
	const probe = spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("permission denied"), { code: "EPERM" });
	});
	try {
		expect(acquireRunLock(dir, "load-watch", 1_001_000).status).toBe("OVERLAP");
		expect(readFileSync(join(dir, "load-watch.lock", "pid"), "utf8")).toBe(before);
	} finally {
		probe.mockRestore();
	}
});

test("SVC1: read contention leaves no unreported claim and permits the next run", () => {
	const dir = jobsDir();
	const gate = join(dir, "load-watch.gate.sqlite");
	writeFileSync(gate, "", { mode: 0o600, flag: "wx" });
	const reader = new Database(gate);
	reader.exec("PRAGMA user_version = 1");
	reader.exec("BEGIN");
	reader.query("SELECT name FROM sqlite_master").all();
	try {
		expect(acquireRunLock(dir, "load-watch").status).toBe("OVERLAP");
		expect(readRunClaim(dir, "load-watch")).toBeNull();
	} finally {
		reader.exec("ROLLBACK");
		reader.close();
	}
	const next = acquireRunLock(dir, "load-watch");
	if (next.status !== "ACQUIRED") throw new Error("expected acquisition after the reader released");
	try {
		expect(readRunClaim(dir, "load-watch")?.pid).toBe(process.pid);
	} finally {
		next.lock.release();
	}
	expect(readRunClaim(dir, "load-watch")).toBeNull();
});

test("SVC1: simultaneous stale-claim contenders admit only one owned process", async () => {
	const dir = jobsDir();
	writeClaimFixture(dir, 2147483647, 1_000_000);
	// Pipe barriers keep the winner alive until every contender has reported.
	const workers = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", `
		import { acquireRunLock } from ${JSON.stringify(join(repoRoot, "src", "service-run.ts"))};
		const reader = Bun.stdin.stream().getReader();
		if ((await reader.read()).done) process.exit(2);
		const claim = acquireRunLock(${JSON.stringify(dir)}, "load-watch");
		console.log(JSON.stringify({ status: claim.status, pid: process.pid }));
		if (claim.status === "ACQUIRED") {
			await reader.read();
			claim.lock.release();
		}
	`], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
	let reported = false;
	try {
		for (const worker of workers) {
			worker.stdin.write("go\n");
			await worker.stdin.flush();
		}
		const results = await Promise.all(workers.map(async (worker) => {
			const reader = worker.stdout.getReader();
			const decoder = new TextDecoder();
			let text = "";
			try {
				while (!text.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error(`worker ${worker.pid} exited without a claim report: ${text}`);
					text += decoder.decode(chunk.value, { stream: true });
				}
				return JSON.parse(text.slice(0, text.indexOf("\n")));
			} finally {
				reader.releaseLock();
			}
		}));
		expect(results.filter((result) => result.status === "ACQUIRED")).toHaveLength(1);
		expect(results.filter((result) => result.status === "OVERLAP")).toHaveLength(3);
		reported = true;
	} finally {
		for (const worker of workers) {
			try { worker.stdin.end(); } catch { /* The owned contender may already have exited. */ }
			if (!reported && worker.exitCode === null) worker.kill("SIGKILL");
		}
		await Promise.all(workers.map((worker) => worker.exited));
	}
	expect(workers.every((worker) => worker.exitCode === 0)).toBe(true);
	expect(readRunClaim(dir, "load-watch")).toBeNull();
}, 10000);

test("SVC1 planted: two overlapping runs, the second exits SKIPPED-OVERLAP", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	expect(first.status).toBe("ACQUIRED");
	const second = acquireRunLock(dir, "load-watch", 1_001_000);
	expect(second.status).toBe("OVERLAP");
	if (second.status !== "OVERLAP") throw new Error("expected OVERLAP");
	expect(second.holderPid).toBe(process.pid);
	expect(OVERLAP_EXIT).toBe(4);
	if (first.status === "ACQUIRED") first.lock.release();
});

test("SVC1: release frees the job for the next run", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	if (first.status !== "ACQUIRED") throw new Error("expected ACQUIRED");
	first.lock.release();
	first.lock.release();
	const second = acquireRunLock(dir, "load-watch", 1_002_000);
	expect(second.status).toBe("ACQUIRED");
	if (second.status === "ACQUIRED") second.lock.release();
});

test("SVC1: a stale lock from a dead PID is broken", () => {
	const dir = jobsDir();
	writeClaimFixture(dir, 2147483647, 1_000_000);
	const next = acquireRunLock(dir, "load-watch", 1_001_000);
	expect(next.status).toBe("ACQUIRED");
	if (next.status === "ACQUIRED") next.lock.release();
});


test("SVC1: a live holder is never broken", () => {
	const dir = jobsDir();
	writeClaimFixture(dir, process.pid, Date.now());
	const next = acquireRunLock(dir, "load-watch", Date.now() + 1000);
	expect(next.status).toBe("OVERLAP");
	if (next.status !== "OVERLAP") throw new Error("expected OVERLAP");
	expect(next.holderPid).toBe(process.pid);
});


test("SVC1: a fresh empty lock dir stays overlapped", () => {
	const dir = jobsDir();
	mkdirSync(join(dir, "load-watch.lock"), { recursive: true, mode: 0o700 });
	const next = acquireRunLock(dir, "load-watch", Date.now());
	expect(next.status).toBe("OVERLAP");
});

test("SVC1: an aged live keeper still excludes a second execution", () => {
	const dir = jobsDir();
	const start = 1_000_000;
	const first = acquireRunLock(dir, "load-watch", start);
	if (first.status !== "ACQUIRED") throw new Error("expected first keeper");
	try {
		const next = acquireRunLock(dir, "load-watch", start + 3 * 60 * 60 * 1000);
		try {
			expect(next.status).toBe("OVERLAP");
			expect(readRunClaim(dir, "load-watch")?.startedAt).toBe(start);
		} finally {
			if (next.status === "ACQUIRED") next.lock.release();
		}
	} finally {
		first.lock.release();
	}
});

test("SVC1: releasing an old handle preserves a replacement claim", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	if (first.status !== "ACQUIRED") throw new Error("expected first keeper");
	renameSync(join(dir, "load-watch.lock"), join(dir, "retired-claim"));
	const replacement = join(dir, "load-watch.lock");
	mkdirSync(replacement, { mode: 0o700 });
	const claim = { pid: process.pid, startedAt: 1_001_000, token: "replacement-claim" };
	writeFileSync(join(replacement, "pid"), JSON.stringify(claim), { mode: 0o600 });
	first.lock.release();
	expect(JSON.parse(readFileSync(join(replacement, "pid"), "utf8"))).toEqual(claim);
});

test("SVC1: reacquisition in the same clock tick has a new incarnation", () => {
	const dir = jobsDir();
	const first = acquireRunLock(dir, "load-watch", 1_000_000);
	if (first.status !== "ACQUIRED") throw new Error("expected first keeper");
	const before = readRunClaim(dir, "load-watch");
	first.lock.release();
	const second = acquireRunLock(dir, "load-watch", 1_000_000);
	if (second.status !== "ACQUIRED") throw new Error("expected next keeper");
	try {
		const after = readRunClaim(dir, "load-watch");
		if (before === null || after === null) throw new Error("missing claim");
		expect(claimIncarnation(before)).not.toBe(claimIncarnation(after));
	} finally {
		second.lock.release();
	}
});

test("SVC1: age does not authorize claiming an unverifiable empty keeper", () => {
	const dir = jobsDir();
	const lock = join(dir, "load-watch.lock");
	mkdirSync(lock, { mode: 0o700 });
	utimesSync(lock, new Date(1_000_000), new Date(1_000_000));
	expect(acquireRunLock(dir, "load-watch", 1_000_000 + 3 * 60 * 60 * 1000).status).toBe("OVERLAP");
	expect(existsSync(lock)).toBe(true);
});


test("SVC1: interval caps sit below cadence", () => {
	expect(RUN_TIME_CAPS_MS["load-watch"]).toBeLessThan(60_000);
	expect(RUN_TIME_CAPS_MS["fleet-watch"]).toBeLessThan(120_000);
	for (const cap of Object.values(RUN_TIME_CAPS_MS)) expect(cap).toBeGreaterThan(0);
});


test("SVC1 planted: a run under high load writes SKIPPED-LOAD and does no work", () => {
	expect(LOAD_GATE_FACTOR).toBe(2.5);
	const verdict = gateRunLoad(87, 32);
	expect(verdict.proceed).toBe(false);
	if (verdict.proceed) throw new Error("expected skip");
	expect(verdict.status).toBe("SKIPPED-LOAD");
	expect(verdict.exit).toBe(SKIPPED_LOAD_EXIT);
	expect(verdict.detail).toContain("No work was done");
});

test("SVC1: a run under normal load proceeds", () => {
	expect(gateRunLoad(10, 32)).toEqual({ proceed: true });
	expect(gateRunLoad(80, 32).proceed).toBe(true);
});


test("SVC1: a fast run returns OK with elapsed time and output", async () => {
	const seen: string[][] = [];
	const exec: CapExec = {
		spawn: (argv) => {
			seen.push([...argv]);
			return { pid: 4242, wait: () => Promise.resolve({ code: 0, out: "ok\n" }), kill: () => {} };
		},
		sleep: () => new Promise<void>(() => {}),
		now: () => 0,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(seen).toEqual([["bun", "test"]]);
	expect(result.status).toBe("OK");
	if (result.status !== "OK") throw new Error("expected OK");
	expect(result.exit).toBe(0);
	expect(result.out).toBe("ok\n");
});

test("SVC1 planted: a slow run is killed at the cap and recorded TIMEOUT", async () => {
	let t = 0;
	let killed = false;
	let waited = false;
	const exec: CapExec = {
		spawn: () => ({
			pid: 4243,
			wait: () => {
				if (!killed) return new Promise<{ code: number | null; out: string }>(() => {});
				waited = true;
				return Promise.resolve({ code: null, out: "partial\n" });
			},
			kill: () => {
				killed = true;
			},
		}),
		sleep: (ms) => {
			t += ms;
			return Promise.resolve();
		},
		now: () => t,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(killed).toBe(true);
	expect(waited).toBe(true);
	expect(result.status).toBe("TIMEOUT");
	if (result.status !== "TIMEOUT") throw new Error("expected TIMEOUT");
	expect(result.exit).toBeNull();
	expect(result.elapsedMs).toBe(60000);
	expect(result.out).toBe("partial\n");
});

test("SVC1: a failing run reports FAILED with its exit", async () => {
	const exec: CapExec = {
		spawn: () => ({ pid: 4244, wait: () => Promise.resolve({ code: 3, out: "boom\n" }), kill: () => {} }),
		sleep: () => new Promise<void>(() => {}),
		now: () => 0,
	};
	const result = await runWithCap({ argv: ["bun", "test"], cwd: "/repo", env: {}, capMs: 60000, exec });
	expect(result.status).toBe("FAILED");
	if (result.status !== "FAILED") throw new Error("expected FAILED");
	expect(result.exit).toBe(3);
});


test("SVC1 planted: a disabled job produces no run", () => {
	const dir = jobsDir();
	writeFileSync(join(dir, "load-watch.off"), "paused for the incident\n");
	const off = readJobOff(join(dir, "load-watch.off"));
	expect(off).toEqual({ disabled: true, reason: "paused for the incident" });
});

test("SVC1: an absent off marker leaves the job enabled", () => {
	const dir = jobsDir();
	expect(readJobOff(join(dir, "load-watch.off"))).toEqual({ disabled: false });
});

test("SVC1: an unreadable or odd off entry still disables", () => {
	const dir = jobsDir();
	mkdirSync(join(dir, "load-watch.off"), { recursive: true });
	expect(readJobOff(join(dir, "load-watch.off"))).toEqual({ disabled: true, reason: null });
});

const treeFixture = join(repoRoot, "tests", "fixtures", "capped-process-tree.ts");
const fixtureEnv = () => ({ ...process.env } as Record<string, string>);

function recordedPids(root: string): number[] {
	return ["child.pid", "grandchild.pid"].filter(name => existsSync(join(root, name))).map(name => {
		const pid = Number(readFileSync(join(root, name), "utf8"));
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid owned fixture PID ${pid}`);
		return pid;
	});
}

function activePid(pid: number): boolean {
	const state = Bun.spawnSync(["ps", "-p", String(pid), "-o", "stat="]);
	return state.exitCode === 0 && !state.stdout.toString().trim().startsWith("Z");
}

// These integration specimens exercise OS signal delivery and inherited pipe
// descriptors in separate real processes; fake timers cannot drive that clock.
async function until(predicate: () => boolean, milliseconds = 3000): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("owned fixture condition exceeded deadline");
		await Bun.sleep(10);
	}
}

function cleanFixture(root: string): void {
	for (const pid of recordedPids(root)) {
		if (activePid(pid)) {
			try { process.kill(pid, "SIGKILL"); } catch { /* only fixture-recorded descendants */ }
		}
	}
}

test("CANCELP0: default timeout kills TERM-ignoring descendants and closes inherited output", async () => {
	const root = jobsDir();
	const control = Bun.spawn(["/bin/sleep", "30"]);
	try {
		// Explicit executor exercises the default group contract too.
		const run = runWithCap({ argv: [process.execPath, treeFixture, "tree", root],
			cwd: root, env: fixtureEnv(), capMs: 500, exec: bunCapExec() });
		await until(() => recordedPids(root).length === 2);
		const pids = recordedPids(root);
		let timer: NodeJS.Timeout | undefined;
		const result = await Promise.race([run, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`capped runner held output FDs; active PIDs: ${pids.filter(activePid)}`)), 3000);
		})]).finally(() => clearTimeout(timer));
		expect(result.status).toBe("TIMEOUT");
		await until(() => pids.every(pid => !activePid(pid)));
		expect(result.out).toContain("grandchild-ready");
		expect(result.out).toContain("grandchild-stderr");
		expect(activePid(control.pid)).toBe(true);
	} finally {
		cleanFixture(root);
		control.kill("SIGKILL");
		await control.exited;
	}
}, 10000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	test(`CANCELP0: parent ${signal} cleans only its owned tree`, async () => {
		const root = jobsDir();
		const control = Bun.spawn(["/bin/sleep", "30"]);
		const parent = Bun.spawn([process.execPath, treeFixture, "runner", root], { stdout: "pipe", stderr: "pipe" });
		const stdout = new Response(parent.stdout).text();
		const stderr = new Response(parent.stderr).text();
		try {
			await until(() => recordedPids(root).length === 2);
			parent.kill(signal);
			await until(() => parent.exitCode !== null && recordedPids(root).every(pid => !activePid(pid)));
			expect(await parent.exited).not.toBe(0);
			expect(await stdout).toContain("grandchild-ready");
			expect(await stderr).toBe("");
			expect(activePid(control.pid)).toBe(true);
		} finally {
			cleanFixture(root);
			parent.kill("SIGKILL");
			control.kill("SIGKILL");
			await Promise.all([parent.exited, control.exited, stdout, stderr]);
		}
	}, 10000);
}

for (const code of [0, 7]) {
	test(`CANCELP0: clean exit ${code} retains actual output and status`, async () => {
		const root = jobsDir();
		const result = await runWithCap({ argv: [process.execPath, treeFixture, "exit", root, String(code)],
			cwd: root, env: fixtureEnv(), capMs: 3000 });
		expect(result.status).toBe(code === 0 ? "OK" : "FAILED");
		expect(result.exit).toBe(code);
		expect(result.out).toBe("actual stdout\n\nactual stderr\n");
	});
}

test("CANCELP0: stdout and stderr drain concurrently under pipe pressure", async () => {
	const root = jobsDir();
	const result = await runWithCap({ argv: [process.execPath, treeFixture, "pressure", root],
		cwd: root, env: fixtureEnv(), capMs: 3000 });
	expect(result.status).toBe("OK");
	expect(result.out).toBe(`${"o".repeat(256 * 1024)}\n${"e".repeat(256 * 1024)}`);
});

test("CANCELP0: actual source service runner cleans a non-fleet-lessons timeout", async () => {
	const root = jobsDir();
	const bin = join(root, ".local", "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "omp-kit"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(treeFixture)} tree ${JSON.stringify(root)}\n`, { mode: 0o755 });
	const parent = Bun.spawn([process.execPath, join(repoRoot, "src", "cli.ts"), "service", "run", "omp-watch", "--json"], {
		// OMP version discovery has its own 15s native deadline and is not
		// under test here. Omit OMP from this isolated PATH (truthful null),
		// rather than supplying an echo-version stub or timing that probe.
		cwd: root, env: { ...fixtureEnv(), HOME: root, TMPDIR: root, PATH: `${bin}:/usr/bin:/bin`, XDG_STATE_HOME: join(root, ".local", "state"),
			OMP_KIT_LOAD_OVERRIDE: "0/1", OMP_KIT_RUN_CAP_MS: "1000", AGENT_NAME: "CancelP0Fixture" },
		stdout: "pipe", stderr: "pipe",
	});
	const stdout = new Response(parent.stdout).text();
	const stderr = new Response(parent.stderr).text();
	try {
		await until(() => recordedPids(root).length === 2);
		const pids = recordedPids(root);
		await until(() => parent.exitCode !== null, 5000);
		const result = { exit: await parent.exited, stdout: await stdout, stderr: await stderr };
		console.log("CANCELP0 actual source runner smoke", JSON.stringify({ platform: process.platform, arch: process.arch, pids, ...result }));
		expect(result.exit).toBe(1);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout).data.status).toBe("TIMEOUT");
		const receipt = JSON.parse(readFileSync(join(root, ".local", "state", "omp-kit", "jobs", "omp-watch.json"), "utf8"));
		expect(receipt.status).toBe("TIMEOUT");
		await until(() => pids.every(pid => !activePid(pid)));
		expect(existsSync(join(root, ".local", "state", "omp-kit", "jobs", "omp-watch.lock"))).toBe(false);
	} finally {
		cleanFixture(root);
		parent.kill("SIGKILL");
		await Promise.all([parent.exited, stdout, stderr]);
	}
}, 10000);

test("CANCELP0: leader exit cannot leave a grandchild holding its pipes", async () => {
	const root = jobsDir();
	try {
		const result = await runWithCap({ argv: [process.execPath, treeFixture, "orphan", root],
			cwd: root, env: fixtureEnv(), capMs: 3000 });
		expect(result.status).toBe("OK");
		expect(result.exit).toBe(0);
		expect(recordedPids(root)).toHaveLength(2);
		await until(() => recordedPids(root).every(pid => !activePid(pid)));
	} finally {
		cleanFixture(root);
	}
}, 10000);