import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { censusLoad, loadAlert, measureCpuMs, parseDiskIops, parseMemoryPressure, parsePsSnapshot, parseTmuxSnapshot, writeCensus } from "../../src/load-doctor.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { configure, entry, fixture, forgeHealthyStatfs, heavyEnv } from "./heavy-fixtures.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);
// RELFLAKE1 (ompkit-1ra0d.109): both state-root tests shared one fixed var/agent-tmp/load2-fixture, so overlapping
// runs (the commit gate's affected tests beside a suite) clobbered each other's ledger and streak files.
const fixtureRoot = () => ownedTmp("load2-fixture", { root: join(process.cwd(), "var", "agent-tmp") }).path;

test("maps process ancestry to pane and ledger job", () => {
	const processes = parsePsSnapshot(" 42 10 60.0 1000 Sun Oct  4 00:00:00 2026 bun worker\n 10 1 2.0 100 Sun Oct  4 00:00:00 2026 tmux\n 77 1 30.0 500 Sun Oct  4 00:00:00 2026 tsserver");
	const panes = parseTmuxSnapshot("omp-test|0.1|10\n");
	const report = censusLoad({ processes, panes, jobs: [{ id: "j1", pid: 42, label: "build", repo: "/repo", cwd: "/repo", agent: "worker", tmux_pane: "omp-test 0.1", state: "running" }], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60, memory_pressure: { level: "normal", free_pct: 92 }, disk_iops: 1676 }, now: new Date("2026-10-03T00:00:00Z") });

	expect(processes[0]?.start_time).toBe("Sun Oct  4 00:00:00 2026");
	expect(report.verdict).toBe("OK");
	expect(report.consumers[0]).toMatchObject({ session: "omp-test", pane: "omp-test 0.1", agent: "worker", repo: "/repo", pids: [42, 10] });
	expect(report.lsp_counts).toEqual({ total: 1, by_session: { system: 1 } });
	expect(report.heavy_jobs[0]?.id).toBe("j1");
});

test("LOADSEAT1: attributes Tern descendants to the nearest verified AGENT_NAME, not shared cwd or a reused PID", () => {
	const start = "Sun Oct  4 00:00:00 2026";
	const processes = parsePsSnapshot(`10 1 0 10 ${start} /bin/omp\n20 10 10 100 ${start} /bin/omp\n21 20 75 100 ${start} bun worker\n30 1 60 100 ${start} /bin/omp\n99 1 30 100 ${start} another-worker`);
	const input = { processes: processes.map(row => ({ ...row, cwd: "/checkout" })), jobs: [], machine: {} };
	const report = censusLoad({ ...input, ternProbe: (argv) => {
		if (argv[1] === "inspect") return JSON.stringify({ panes: [10, 20, 30].map(pane => ({ pane, omp_session_file: `/sessions/${pane}.jsonl` })) });
		if (argv[1] === "process") return JSON.stringify({ pane: argv[2], foreground: { pid: Number(argv[2]), cwd: "/checkout", name: "omp", argv: ["/bin/omp"] } });
		const pid = argv[3];
		return `${pid === "30" ? start.replace("00:00:00", "00:00:01") : start} /bin/omp AGENT_NAME=${pid === "20" ? "NestedSeat" : "ParentSeat"}`;
	} });
	expect(report.consumers).toEqual([
		expect.objectContaining({ agent: "NestedSeat", pane: "tern:20", pids: [20, 21], cpu_pct: 85 }),
		expect.objectContaining({ agent: "ParentSeat", pane: "tern:10", pids: [10], cpu_pct: 0 }),
	]);
	expect(report.processes.find(row => row.pid === 21)?.owner).toBe("NestedSeat; pane=tern:20");
	expect(report.processes.find(row => row.pid === 30)?.owner).toBe("unattributed");
	expect(report.processes.find(row => row.pid === 99)?.owner).toBe("unattributed");
	// The same sample without Tern discovery has only the legacy tmux fallback.
	expect(censusLoad({ ...input, panes: [] }).consumers).toEqual([]);
});

test("LOADSEAT1: a settled detached verdict is listed while it runs and releases its heavy row after exit", async () => {
	const root = fixture();
	const marker = join(root, "verdict.pid");
	const log = join(root, "release-verdict.log");
	configure(root, { slots: 1, max_wait_s: fixtureDeadlineS(30) });
	mkdirSync(join(root, "scripts"));
	mkdirSync(join(root, "src"));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "omp-kit"), '#!/bin/sh\nexec "$LOAD_FIXTURE_BUN" --preload "$LOAD_FIXTURE_PRELOAD" "$LOAD_FIXTURE_ENTRY" "$@"\n', { mode: 0o700 });
	writeFileSync(join(root, "scripts", "release-verdict.sh"),
		`printf '%s\\n' "$$" >> verdict.pid\nfor i in $(seq 1 ${fixtureDeadlineS(30) * 10}); do [ ! -f release ] || exit 0; sleep 0.1; done\nexit 1\n`);
	writeFileSync(join(root, "src", "release-ready.ts"), 'console.log("release-ready-observed");\n');
	const fixtureEnv = heavyEnv(root, { AGENT_NAME: "FixtureSeat", LOAD_FIXTURE_ENTRY: entry, LOAD_FIXTURE_PRELOAD: forgeHealthyStatfs,
		LOAD_FIXTURE_BUN: process.execPath, OMP_KIT_RELEASE_VERDICT_QUIET_S: "0", OMP_KIT_HEAVY_MAX_WAIT_S: "" });
	const env: Record<string, string> = Object.fromEntries(Object.entries(fixtureEnv)
		.filter((pair): pair is [string, string] => pair[1] !== undefined));
	env.PATH = `${join(root, "bin")}:${env.PATH}`;
	const git = (...args: string[]) => {
		const result = runSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
			"-c", "commit.gpgsign=false", ...args], { cwd: root, env, deadline_s: fixtureDeadlineS(15) });
		expect(result.rc).toBe(0);
		return Buffer.from(result.stdout).toString().trim();
	};
	git("init", "-q", "-b", "main");
	git("commit", "-q", "--allow-empty", "-m", "fixture head");
	git("remote", "add", "origin", ".");
	const sha = git("rev-parse", "HEAD");
	const launcher = resolve(import.meta.dir, "../../scripts/release-verdict-start.py");
	const start = (overrides: Record<string, string> = {}) => {
		const result = runSync(["sh", "-c", '"$1" "$2" "$3" </dev/null >"$4" 2>&1', "sh", launcher, root, sha, log],
			{ env: { ...env, ...overrides }, cwd: root, deadline_s: fixtureDeadlineS(15) });
		expect(result.rc).toBe(0);
	};
	start();
	const stateRoot = join(root, "state", "omp-kit", "load");
	const observe = () => censusLoad({ stateRoot, panes: [], machine: {} });
	// Completion and the PID are emitted by real detached processes; fake timers cannot drive them.
	const waitFor = async (predicate: () => boolean) => {
		const end = Date.now() + fixtureDeadlineS(20) * 1_000;
		while (Date.now() < end) {
			if (predicate()) return;
			await Bun.sleep(50);
		}
		throw new Error(`release fixture did not reach the expected state: ${readFileSync(log, "utf8")}`);
	};
	try {
		await waitFor(() => existsSync(marker) && readFileSync(marker, "utf8").trim() !== "");
		const pid = Number(readFileSync(marker, "utf8").trim());
		const job = join(stateRoot, "jobs");
		await waitFor(() => existsSync(job) && readdirSync(job).filter(name => name.endsWith(".json")).some(name => {
			try { return JSON.parse(readFileSync(join(job, name), "utf8")).pid === pid; }
			catch { return false; }
		}));
		const report = observe();
		expect(report.heavy_jobs).toEqual([expect.objectContaining({ pid, label: "release-verdict", agent: "FixtureSeat", state: "running" })]);
		expect(report.processes.find(row => row.pid === pid)?.job_id).toBe(report.heavy_jobs[0]?.id);
	} finally {
		writeFileSync(join(root, "release"), "");
		await waitFor(() => readFileSync(log, "utf8").includes(`qualification finished for ${sha} rc=0`));
	}
	expect(observe().heavy_jobs).toEqual([]);
	expect(readFileSync(log, "utf8")).toContain("release-ready-observed");

	// Plant high load in the native admission path, not in an alternate launcher.
	const ran = readFileSync(marker, "utf8");
	start({ OMP_KIT_HEAVY_MAX_WAIT_S: "1", OMP_KIT_HEAVY_FAKE_LOAD1: "1000000" });
	await waitFor(() => readFileSync(log, "utf8").includes(`qualification did not complete for ${sha} rc=75`));
	const refused = readFileSync(log, "utf8");
	expect(refused).toContain("RESOURCE_DEFERRED");
	expect(refused).not.toContain("qualification finished");
	expect(refused).not.toContain("release-ready-observed");
	expect(readFileSync(marker, "utf8")).toBe(ran);
}, fixtureDeadlineS(60) * 1_000);

test("parses memory pressure level/free percentage and disk transfers per second", () => {
	expect(parseMemoryPressure("System-wide memory free percentage: 92%\n")).toEqual({ level: "normal", free_pct: 92 });
	expect(parseMemoryPressure("System-wide memory free percentage: 8%\n")).toEqual({ level: "critical", free_pct: 8 });
	expect(parseDiskIops("disk0 disk1\nKB/t tps MB/s KB/t tps MB/s\n17.94 1231 21.57 14.56 2 0.02\n")).toBe(1233);
});

test("resolves pane agent profile and repository cwd without unknown placeholders", () => {
	const processes = [{ pid: 10, ppid: 1, cpu_pct: 1, rss_bytes: 1, command: "tmux" }, { pid: 20, ppid: 10, cpu_pct: 3, rss_bytes: 2, command: "bun /fixture/user-home/.bun/bin/omp --profile codex" }];
	const report = censusLoad({ processes, panes: [{ session: "omp-test", pane: "omp-test 0.1", pid: 10, cwd: "/fixture/repo" }], jobs: [], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } });

	expect(report.consumers[0]).toMatchObject({ agent: "codex", repo: "/fixture/repo" });
	expect(JSON.stringify(report.consumers)).not.toContain("unknown");
	expect(report.sample_cost_ms).toBeGreaterThanOrEqual(0);
	expect(report.sample_cost_ms).toBeLessThan(600);
});


test("census contention follows only the machine load rule", () => {
	const processes = [{ pid: 1, ppid: 0, cpu_pct: 1, rss_bytes: 1, command: "WindowServer" }];

	expect(censusLoad({ processes, panes: [], jobs: [], machine: { load1: 1.6, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 5 } }).verdict).toBe("OK");
	expect(censusLoad({ processes, panes: [], jobs: [], machine: { load1: 1.6, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } }).verdict).toBe("OK");
	expect(censusLoad({ processes, panes: [], jobs: [], machine: { load1: 10.01, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } }).verdict).toBe("CONTENDED");
});

// 2026-11-10: 96 launchd-adopted `python3 -c while 1: pass` loops (~40% each) drove load to 385 on 32 cores; the
// census `top=` listed aged Tern seats first and nobody was told.
test("LOADWATCH1: a sustained overload alerts once at the second sample and names the adopted loop group first", () => {
	const loops = Array.from({ length: 96 }, (_, i) => ({ pid: 1000 + i, ppid: 1, cpu_pct: 40, rss_bytes: 1, command: "/usr/bin/python3 -c while 1: pass",
		owner: "unattributed", elapsed_s: 7000, cause_class: "active" as const, zombie_children: 0 }));
	const seat = { pid: 3443, ppid: 900, cpu_pct: 18, rss_bytes: 1, command: "/Tern/omp/versions/18.18.6 --restore /s.jsonl",
		owner: "unattributed", elapsed_s: 31663, cause_class: "unreaped-children" as const, zombie_children: 2 };
	const machine = { load1: 385, load5: 1, load15: 1, ncpu: 32, cpu_user_pct: null, cpu_sys_pct: null, cpu_idle_pct: null, memory_pressure: { level: "normal" as const, free_pct: 90 }, disk_iops: null };
	const processes = [seat, ...loops];
	expect(loadAlert({ verdict: "CONTENDED", contention_streak: 1, processes, machine })).toBeNull();
	const alert = loadAlert({ verdict: "CONTENDED", contention_streak: 2, processes, machine });
	expect(alert).toStartWith("Load 385 on 32 cores for 2 min. Top CPU: 3840% x96 (96 adopted by launchd): /usr/bin/python3 -c while 1: pass");
	expect(alert).toContain("18% x1: /Tern/omp/versions/18.18.6");
	expect(loadAlert({ verdict: "CONTENDED", contention_streak: 3, processes, machine })).toBeNull();
	expect(loadAlert({ verdict: "CONTENDED", contention_streak: 12, processes, machine })).not.toBeNull();
	expect(loadAlert({ verdict: "OK", contention_streak: 0, processes, machine })).toBeNull();
});
test("keeps system groups separate", () => {
	const processes = parsePsSnapshot(" 42 10 60.0 1000 bun worker\n 10 1 2.0 100 tmux\n 99 1 80.0 200 WindowServer");
	const report = censusLoad({ processes, panes: parseTmuxSnapshot("omp-test|0.1|10\n"), jobs: [], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } });

	expect(report.system_groups[0]).toMatchObject({ group: "WindowServer", pids: [99] });
	expect(report.consumers[0]?.pids).toEqual([42, 10]);
});

test("reaps dead and process-reused ledger entries", () => {
	const stateRoot = fixtureRoot();
	const jobsRoot = join(stateRoot, "jobs");
	mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(jobsRoot, "dead.json"), JSON.stringify({ id: "dead", pid: 999999, process_start: "old", label: "dead", repo: "/repo", cwd: "/repo", agent: "a", tmux_pane: "x", state: "running" }));
	writeFileSync(join(jobsRoot, "reused.json"), JSON.stringify({ id: "reused", pid: process.pid, process_start: "old", label: "reused", repo: "/repo", cwd: "/repo", agent: "a", tmux_pane: "x", state: "queued" }));
	const processes = parsePsSnapshot(` ${process.pid} 1 0.0 1 Sun Oct  4 00:00:00 2026 bun test`);
	expect(processes[0]?.start_time).toBe("Sun Oct  4 00:00:00 2026");
	const report = censusLoad({ stateRoot, processes, panes: [], machine: { load1: 0, load5: 0, load15: 0, ncpu: 4, cpu_idle_pct: 60 } });

	expect(report.stale_jobs_reaped.sort()).toEqual(["dead", "reused"]);
	expect(report.heavy_jobs).toEqual([]);
	expect(existsSync(join(jobsRoot, "dead.json"))).toBe(false);
	expect(existsSync(join(jobsRoot, "reused.json"))).toBe(false);
});

test("reports absent LOAD1 ledger and counts three contended samples", () => {
	const stateRoot = fixtureRoot();
	writeFileSync(join(stateRoot, "contention.json"), JSON.stringify({ streak: 0 }));
	const idle = { processes: [], panes: [], jobs: [], machine: { load1: 12, load5: 0, load15: 0, ncpu: 4, cpu_idle_pct: 5 } } as const;
	const reports = [censusLoad(idle), censusLoad(idle), censusLoad(idle)];
	for (const report of reports) writeCensus(stateRoot, report);

	expect(reports[0]!.text).toContain("heavy jobs: none registered (LOAD1 not installed)");
	expect(JSON.parse(readFileSync(join(stateRoot, "census.json"), "utf8")).contention_streak).toBe(3);
});
test("CPU cost excludes sleeping wall time", () => {
	const wallStart = performance.now();
	const cpuMs = measureCpuMs(() => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
	});
	const wallMs = performance.now() - wallStart;

	expect(wallMs).toBeGreaterThanOrEqual(30);
	expect(cpuMs).toBeLessThan(10);
});
