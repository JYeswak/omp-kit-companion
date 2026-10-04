import { expect, test } from "bun:test";
import { censusLoad, parsePsSnapshot, parseTmuxSnapshot } from "../../src/load-doctor.ts";

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

test("reports absent LOAD1 ledger explicitly", () => {
	const report = censusLoad({ processes: [], panes: [], jobs: [], machine: { load1: 0, load5: 0, load15: 0, ncpu: 4, cpu_idle_pct: 60 } });
	expect(report.text).toContain("heavy jobs: none registered (LOAD1 not installed)");
	expect(report.contention_streak).toBe(0);
});
