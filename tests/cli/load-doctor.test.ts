import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { censusLoad, parsePsSnapshot, parseTmuxSnapshot, writeCensus } from "../../src/load-doctor.ts";

test("maps process ancestry to pane and ledger job", () => {
	const processes = parsePsSnapshot(" 42 10 60.0 1000 bun worker\n 10 1 2.0 100 tmux\n 77 1 30.0 500 tsserver");
	const panes = parseTmuxSnapshot("omp-test|0.1|10\n");
	const report = censusLoad({ processes, panes, jobs: [{ id: "j1", pid: 42, label: "build", repo: "/repo", cwd: "/repo", agent: "worker", tmux_pane: "omp-test 0.1", state: "running" }], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60, memory_pressure: "normal", read_iops: 1, write_iops: 2 }, now: new Date("2026-10-03T00:00:00Z") });

	expect(report.verdict).toBe("OK");
	expect(report.consumers[0]).toMatchObject({ session: "omp-test", pane: "omp-test 0.1", agent: "worker", repo: "/repo", pids: [42, 10] });
	expect(report.lsp_counts).toEqual({ total: 1, by_session: { system: 1 } });
	expect(report.heavy_jobs[0]?.id).toBe("j1");
});

test("marks low idle and high load contended", () => {
	const processes = [{ pid: 1, ppid: 0, cpu_pct: 1, rss_bytes: 1, command: "WindowServer" }];

	expect(censusLoad({ processes, panes: [], jobs: [], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 5 } }).verdict).toBe("CONTENDED");
	expect(censusLoad({ processes, panes: [], jobs: [], machine: { load1: 12, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } }).verdict).toBe("CONTENDED");
});

test("keeps system groups separate", () => {
	const processes = parsePsSnapshot(" 42 10 60.0 1000 bun worker\n 10 1 2.0 100 tmux\n 99 1 80.0 200 WindowServer");
	const report = censusLoad({ processes, panes: parseTmuxSnapshot("omp-test|0.1|10\n"), jobs: [], machine: { load1: 1, load5: 1, load15: 1, ncpu: 4, cpu_idle_pct: 60 } });

	expect(report.system_groups[0]).toMatchObject({ group: "WindowServer", pids: [99] });
	expect(report.consumers[0]?.pids).toEqual([42, 10]);
});

test("reaps dead and process-reused ledger entries", () => {
	const stateRoot = join(process.cwd(), "var", "agent-tmp", "load2-fixture");
	const jobsRoot = join(stateRoot, "jobs");
	mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot, ".owner"), `pid=${process.pid} label=load2-fixture repo=${process.cwd()} created=${new Date().toISOString()}\n`);
	writeFileSync(join(jobsRoot, "dead.json"), JSON.stringify({ id: "dead", pid: 999999, process_start: "old", label: "dead", repo: "/repo", cwd: "/repo", agent: "a", tmux_pane: "x", state: "running" }));
	writeFileSync(join(jobsRoot, "reused.json"), JSON.stringify({ id: "reused", pid: process.pid, process_start: "old", label: "reused", repo: "/repo", cwd: "/repo", agent: "a", tmux_pane: "x", state: "queued" }));
	const report = censusLoad({ stateRoot, processes: [{ pid: process.pid, ppid: 1, cpu_pct: 0, rss_bytes: 1, command: "bun test", start_time: "new" }], panes: [], machine: { load1: 0, load5: 0, load15: 0, ncpu: 4, cpu_idle_pct: 60 } });

	expect(report.stale_jobs_reaped.sort()).toEqual(["dead", "reused"]);
	expect(report.heavy_jobs).toEqual([]);
	expect(existsSync(join(jobsRoot, "dead.json"))).toBe(false);
	expect(existsSync(join(jobsRoot, "reused.json"))).toBe(false);
});

test("reports absent LOAD1 ledger and counts three contended samples", () => {
	const stateRoot = join(process.cwd(), "var", "agent-tmp", "load2-fixture");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot, "contention.json"), JSON.stringify({ streak: 0 }));
	const idle = { processes: [], panes: [], jobs: [], machine: { load1: 12, load5: 0, load15: 0, ncpu: 4, cpu_idle_pct: 5 } } as const;
	const reports = [censusLoad(idle), censusLoad(idle), censusLoad(idle)];
	for (const report of reports) writeCensus(stateRoot, report);

	expect(reports[0]!.text).toContain("heavy jobs: none registered (LOAD1 not installed)");
	expect(JSON.parse(readFileSync(join(stateRoot, "census.json"), "utf8")).contention_streak).toBe(3);
});
