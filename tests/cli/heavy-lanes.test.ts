import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { run, type RunTimings } from "../../src/kitlib/run";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { configure, entry, fixture, forgeHealthyStatfs, heavyEnv, invoke, seedJob } from "./heavy-fixtures.ts";

type Job = { id: string; pid: number; state: string; label: string; lane?: string };
type LaneRun = { done: Promise<{ code: number | null; stderr: string }>; stop(): void; stderr(): string; exited(): boolean };
function jobs(root: string): Job[] {
	const directory = join(root, "state", "omp-kit", "load", "jobs");
	if (!existsSync(directory)) return [];
	return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => JSON.parse(readFileSync(join(directory, name), "utf8")));
}

// A newly created PID file can still be empty: Number("") is 0, and kill(0)
// signals the caller's entire process group instead of the intended fixture.
function publishedPid(path: string): number | undefined {
	if (!existsSync(path)) return undefined;
	const text = readFileSync(path, "utf8").trim();
	const pid = Number(text);
	return text !== "" && Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

test("SLOTLEASE1 PID handoffs reject empty, zero and invalid values before signaling", () => {
	const root = fixture();
	const path = join(root, "pid");
	expect(publishedPid(path)).toBeUndefined();
	for (const text of ["", "0", "-1", "1", "NaN", "123.5"]) {
		writeFileSync(path, text);
		expect(publishedPid(path)).toBeUndefined();
	}
	writeFileSync(path, String(process.pid));
	expect(publishedPid(path)).toBe(process.pid);
});

// Real children use a file barrier, not a sleep measured against CLI startup time.
async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + fixtureDeadlineS(20) * 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("heavy lane fixture barrier timed out");
		await Bun.sleep(25);
	}
}

function start(root: string, label: string, lane?: string, command?: string[]): LaneRun {
	const code = `
		const fs = require("node:fs");
		const root = process.argv[1], label = process.argv[2];
		fs.writeFileSync(root + "/" + label + ".start", String(Date.now()));
		fs.writeFileSync(root + "/" + label + ".wrapper-pid.tmp", String(process.ppid));
		fs.renameSync(root + "/" + label + ".wrapper-pid.tmp", root + "/" + label + ".wrapper-pid");
		const watchdog = setTimeout(() => process.exit(9), ${fixtureDeadlineS(30) * 1000});
		const poll = setInterval(() => {
			if (!fs.existsSync(root + "/release")) return;
			fs.writeFileSync(root + "/" + label + ".end", String(Date.now()));
			clearInterval(poll); clearTimeout(watchdog);
		}, 10);
	`;
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(heavyEnv(root, { AGENT_NAME: `agent-${label}`, OMP_KIT_HEAVY_MAX_WAIT_S: "" })))
		if (value !== undefined) env[name] = value;
	const controller = new AbortController();
	const timings: RunTimings = { spawn_started_ms: 0, started_ms: null, exited_ms: null };
	let stderr = "";
	const done = run([process.execPath, "--preload", forgeHealthyStatfs, entry, "heavy", "--label", label,
		...(lane === undefined ? [] : ["--lane", lane]), "--", ...(command ?? [process.execPath, "-e", code, root, label])], {
		cwd: root, env, deadline_s: fixtureDeadlineS(40), grace_s: fixtureDeadlineS(20), signal: controller.signal, timings,
		on_output: (stream, chunk) => { if (stream === "stderr") stderr += new TextDecoder().decode(chunk); },
	}).then(result => ({ code: result.rc, stderr: new TextDecoder().decode(result.stderr) }));
	return { done, stop: () => controller.abort(new Error("lane fixture stopped")), stderr: () => stderr, exited: () => timings.exited_ms !== null };
}

async function finish(root: string, runs: LaneRun[]) {
	writeFileSync(join(root, "release"), "go");
	return Promise.all(runs.map(run => run.done));
}

test("SLOTLEASE1 simultaneous same-lane runs serialize and report the holder and lease age", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: fixtureDeadlineS(30), disk_observer: "statfs" });
	const runs = [start(root, "first", "lead-measure"), start(root, "second", "lead-measure")];
	try {
		await until(() => jobs(root).length === 2 && jobs(root).some(job => job.state === "running"));
		const rows = jobs(root);
		expect(rows.filter(job => job.state === "running")).toHaveLength(1);
		expect(rows.filter(job => job.state === "queued")).toHaveLength(1);
		const holder = rows.find(job => job.state === "running")!;
		const waiter = runs[holder.label === "first" ? 1 : 0]!;
		await until(() => waiter.stderr().includes("held="));
		expect(waiter.stderr()).toContain("lane lead-measure: all 1 slot is occupied");
		expect(waiter.stderr()).toContain(`agent-${holder.label}`);
		expect(waiter.stderr()).toContain(`pid=${holder.pid}`);
		const results = await finish(root, runs);
		expect(results.map(result => result.code)).toEqual([0, 0]);
		const intervals = ["first", "second"].map(label => ({
			start: Number(readFileSync(join(root, `${label}.start`), "utf8")),
			end: Number(readFileSync(join(root, `${label}.end`), "utf8")),
		})).sort((a, b) => a.start - b.start);
		expect(intervals[1]!.start).toBeGreaterThanOrEqual(intervals[0]!.end);
		expect(jobs(root)).toEqual([]);
	} finally { await finish(root, runs); }
}, fixtureDeadlineS(45) * 1000);

for (const scenario of ["unlaned", "configured", "different"] as const) {
	test(`SLOTLEASE1 quiet control: ${scenario} jobs can overlap in the two global slots`, async () => {
		const root = fixture();
		configure(root, { slots: 2, max_wait_s: fixtureDeadlineS(30), disk_observer: "statfs",
			...(scenario === "configured" ? { lane_slots: { "lead-measure": 2 } } : {}) });
		const firstLane = scenario === "unlaned" ? undefined : "lead-measure";
		const secondLane = scenario === "different" ? "other-measure" : firstLane;
		const runs = [start(root, "first", firstLane), start(root, "second", secondLane)];
		try {
			await until(() => existsSync(join(root, "first.start")) && existsSync(join(root, "second.start")));
			expect(jobs(root).filter(job => job.state === "running")).toHaveLength(2);
			expect(existsSync(join(root, "first.end"))).toBe(false);
			expect(existsSync(join(root, "second.end"))).toBe(false);
			const results = await finish(root, runs);
			expect(results.map(result => result.code)).toEqual([0, 0]);
			expect(results.map(result => result.stderr)).toEqual(["", ""]);
		} finally { await finish(root, runs); }
	}, fixtureDeadlineS(45) * 1000);
}

test("SLOTLEASE1 killed wrapper retains its live child's lease; killed child is reclaimed by the queued run", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: fixtureDeadlineS(30), disk_observer: "statfs" });
	const holder = start(root, "holder", "lead-measure");
	const runs = [holder];
	let holderPid: number | undefined;
	let wrapperPid: number | undefined;
	try {
		await until(() => {
			wrapperPid = publishedPid(join(root, "holder.wrapper-pid"));
			return wrapperPid !== undefined && jobs(root).some(job => job.pid !== wrapperPid);
		});
		holderPid = jobs(root).find(job => job.label === "holder")!.pid;
		const waiter = start(root, "waiter", "lead-measure");
		runs.push(waiter);
		await until(() => waiter.stderr().includes("lane lead-measure"));
		if (wrapperPid === undefined) throw new Error("holder wrapper PID was not published");
		process.kill(wrapperPid, "SIGKILL");
		await until(() => holder.exited());
		// A third contender probes admission after the wrapper died. The child still owns it.
		const held = await invoke(root, ["heavy", "--lane", "lead-measure", "--no-wait", "--", "true"]);
		expect(held.code, held.stderr).toBe(75);
		expect(held.stderr).toContain(`pid=${holderPid}`);
		expect(existsSync(join(root, "waiter.start"))).toBe(false);
		process.kill(holderPid, "SIGKILL");
		holderPid = undefined;
		await until(() => existsSync(join(root, "waiter.start")));
		expect(jobs(root).some(job => job.label === "holder")).toBe(false);
		const results = await finish(root, runs);
		expect(results[1]!.code).toBe(0);
		expect(jobs(root)).toEqual([]);
	} finally {
		if (holderPid !== undefined) { try { process.kill(holderPid, "SIGKILL"); } catch {} }
		await finish(root, runs);
	}
}, fixtureDeadlineS(45) * 1000);

test("SLOTLEASE1 documented boundary: a detached grandchild outlives the foreground child's lease", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: fixtureDeadlineS(30), disk_observer: "statfs" });
	const program = `
import os, sys, time
root = sys.argv[1]
with open(root + "/foreground.pid.tmp", "w") as f:
    f.write(str(os.getpid()))
os.replace(root + "/foreground.pid.tmp", root + "/foreground.pid")
pid = os.fork()
if pid == 0:
    os.setsid()
    for fd in range(3):
        os.close(fd)
    with open(root + "/grandchild.pid.tmp", "w") as f:
        f.write(str(os.getpid()))
    os.replace(root + "/grandchild.pid.tmp", root + "/grandchild.pid")
    time.sleep(${fixtureDeadlineS(30)})
    os._exit(0)
while not os.path.exists(root + "/parent-exit"):
    time.sleep(0.01)
`;
	const holder = start(root, "forking", "lead-measure", ["python3", "-c", program, root]);
	let grandchildPid: number | undefined;
	try {
		await until(() => {
			grandchildPid = publishedPid(join(root, "grandchild.pid"));
			const foregroundPid = publishedPid(join(root, "foreground.pid"));
			return grandchildPid !== undefined && foregroundPid !== undefined &&
				jobs(root).some(job => job.state === "running" && job.pid === foregroundPid);
		});
		if (grandchildPid === undefined) throw new Error("grandchild PID was not published");
		expect(() => process.kill(grandchildPid!, 0)).not.toThrow();
		writeFileSync(join(root, "parent-exit"), "go");
		expect((await holder.done).code).toBe(0);
		const next = await invoke(root, ["heavy", "--lane", "lead-measure", "--no-wait", "--", "sh", "-c", "printf foreground-lease-released"]);
		expect(next).toEqual({ code: 0, stdout: "foreground-lease-released", stderr: "" });
		expect(() => process.kill(grandchildPid!, 0)).not.toThrow();
	} finally {
		writeFileSync(join(root, "parent-exit"), "go");
		if (grandchildPid !== undefined) { try { process.kill(grandchildPid, "SIGKILL"); } catch {} }
		await holder.done;
	}
}, fixtureDeadlineS(45) * 1000);

test("SLOTLEASE1 a full lane's queued head does not block an unrelated job", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: fixtureDeadlineS(30), disk_observer: "statfs" });
	const directory = await seedJob(root, { id: "holder" });
	const holderPath = join(directory, "holder.json");
	writeFileSync(holderPath, JSON.stringify({ ...JSON.parse(readFileSync(holderPath, "utf8")), lane: "lead-measure" }));
	const waiter = start(root, "waiter", "lead-measure");
	try {
		await until(() => waiter.stderr().includes("lane lead-measure"));
		const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "printf independent; exit 23"]);
		expect(result).toEqual({ code: 23, stdout: "independent", stderr: "" });
		expect(existsSync(join(root, "waiter.start"))).toBe(false);
	} finally {
		waiter.stop();
		await waiter.done.catch(() => { /* kitlib owns cancellation and kills the queued process group. */ });
	}
}, fixtureDeadlineS(45) * 1000);

test("SLOTLEASE1 invalid lane names and capacities refuse before starting a command", async () => {
	const root = fixture();
	const marker = join(root, "invalid-ran");
	const command = ["--", "sh", "-c", `touch '${marker}'`];
	for (const lane of ["", "bad/name", "name\n", "a".repeat(65)]) {
		const result = await invoke(root, ["heavy", "--lane", lane, ...command]);
		expect(result.code, result.stderr).toBe(2);
		expect(result.stderr).toContain("--lane");
	}
	for (const capacity of [0, 65, 1.5]) {
		configure(root, { lane_slots: { "lead-measure": capacity } });
		const result = await invoke(root, ["heavy", "--lane", "lead-measure", ...command]);
		expect(result.code, result.stderr).toBe(2);
		expect(result.stderr).toContain("lane_slots");
	}
	expect(existsSync(marker)).toBe(false);
}, fixtureDeadlineS(45) * 1000);

afterAll(() => cleanupAllOwnedTmp());
