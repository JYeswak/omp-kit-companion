import { expect, test } from "bun:test";
import { applyBrowserReap, collectBrowserProcesses, inspectBrowserProcesses, parseBrowserCommand, planBrowserReap } from "../../src/browser-doctor.ts";

test("orphan headless Chrome is found through the OMP broker and reaped by recorded PID", () => {
	const chrome = parseBrowserCommand(20, 10, "/Applications/Google Chrome --headless --user-data-dir=/tmp/chrome /tmp/code_sign_clone/a", Date.now() - 86_400_000);
	const broker = { pid: 10, ppid: 1, command: "__omp_worker_daemon_broker", startedAt: Date.now() - 90_000, userDataDir: null, codeSignClones: [] };
	const report = inspectBrowserProcesses([broker, chrome], [{ pid: 10, alive: false }]);
	expect(report.orphaned.map(browser => browser.pid)).toEqual([20]);
	const plan = planBrowserReap(report);
	const applied = applyBrowserReap(plan, { kill: pid => pid === 20, quarantine: path => path === "/tmp/code_sign_clone/a" });
	expect(applied).toEqual({ killed: [20], quarantined: ["/tmp/code_sign_clone/a"] });
});

test("a Chrome whose owning OMP session is live is not flagged", () => {
	const chrome = parseBrowserCommand(21, 10, "/Applications/Google Chrome --headless --user-data-dir=/tmp/live", Date.now() - 86_400_000);
	const broker = { pid: 10, ppid: 1, command: "__omp_worker_daemon_broker", startedAt: Date.now() - 90_000, userDataDir: null, codeSignClones: [] };
	const report = inspectBrowserProcesses([broker, chrome], [{ pid: 10, alive: true }]);
	expect(report.orphaned).toEqual([]);
	expect(report.browsers[0]?.status).toBe("LIVE");
});


test("process-table collector follows broker parent chain and records age", () => {
	const table = "  10 1 3600 __omp_worker_daemon_broker --session-id=s1\n  20 10 1800 /Applications/Google Chrome --headless --user-data-dir=/tmp/u\n";
	const collected = collectBrowserProcesses(() => ({ exitCode: 0, stdout: table }));
	expect(collected.processes).toHaveLength(2);
	expect(collected.sessions).toEqual([{ pid: 10, alive: true }]);
	const report = inspectBrowserProcesses(collected.processes, collected.sessions);
	expect(report.orphaned).toEqual([]);
	expect(report.browsers[0]?.ageMs).toBeGreaterThanOrEqual(1_800_000);
});
