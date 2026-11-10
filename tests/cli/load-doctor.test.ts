import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { censusLoad, loadAlert, measureCpuMs, parseDiskIops, parseMemoryPressure, parsePsSnapshot, parseTmuxSnapshot, writeCensus } from "../../src/load-doctor.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

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
