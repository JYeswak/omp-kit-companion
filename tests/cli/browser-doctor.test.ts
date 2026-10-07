import { expect, test } from "bun:test";
import { applyBrowserReap, collectBrowserProcesses, inspectBrowserProcesses, parseBrowserCommand, planBrowserReap } from "../../src/browser-doctor.ts";

test("orphan headless Chrome is found through the OMP broker and reaped by recorded PID", () => {
	const chrome = parseBrowserCommand(20, 10, "/Applications/Google Chrome --headless --user-data-dir=/tmp/chrome /tmp/code_sign_clone/a", Date.now() - 86_400_000);
	const broker = { pid: 10, ppid: 1, command: "__omp_worker_daemon_broker", startedAt: Date.now() - 90_000, userDataDir: null, codeSignClones: [] };
	const report = inspectBrowserProcesses([broker, chrome], [{ pid: 10, alive: false }], Date.now(), ["/tmp/code_sign_clone/a"]);
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

test("orphan browser sharing a live Chrome clone is killed without quarantining the clone", () => {
	const clone = "/tmp/code_sign_clone/shared";
	const orphanBroker = { pid: 10, ppid: 1, command: "__omp_worker_daemon_broker", startedAt: 0, userDataDir: null, codeSignClones: [] };
	const liveBroker = { pid: 30, ppid: 1, command: "__omp_worker_daemon_broker", startedAt: 0, userDataDir: null, codeSignClones: [] };
	const orphan = parseBrowserCommand(20, 10, `/Applications/Google Chrome --headless --user-data-dir=/tmp/orphan ${clone}`, 0);
	const live = parseBrowserCommand(40, 30, `/Applications/Google Chrome --headless --user-data-dir=/tmp/live ${clone}`, 0);
	const report = inspectBrowserProcesses([orphanBroker, orphan, liveBroker, live], [{ pid: 10, alive: false }, { pid: 30, alive: true }], 1_000);
	expect(report.browsers.map(browser => [browser.pid, browser.status])).toEqual([[20, "ORPHAN"], [40, "LIVE"]]);
	const plan = planBrowserReap(report);
	expect(plan).toEqual([{ pid: 20, clones: [] }]);
	const applied = applyBrowserReap(plan, { kill: pid => pid === 20, quarantine: path => path === clone });
	expect(applied).toEqual({ killed: [20], quarantined: [] });
});

test("reparented headless Chrome with no OMP marker is UNATTRIBUTED and never killed", () => {
	const stranger = parseBrowserCommand(50, 1, "/Applications/Google Chrome --headless --user-data-dir=/tmp/mine", 0);
	const report = inspectBrowserProcesses([stranger], [], Date.now());
	expect(report.browsers.map(browser => [browser.pid, browser.status])).toEqual([[50, "UNATTRIBUTED"]]);
	expect(report.orphaned).toEqual([]);
	expect(planBrowserReap(report)).toEqual([]);
	const applied = applyBrowserReap(planBrowserReap(report), { kill: () => true, quarantine: () => true });
	expect(applied).toEqual({ killed: [], quarantined: [] });
});

test("reparented headless Chrome with an OMP profile path stays ORPHAN and kill-eligible", () => {
	const orphan = parseBrowserCommand(51, 1, "/Applications/Google Chrome --headless --user-data-dir=/fixture/user-home/.omp/profiles/claude/run/daemons/x/omp.browser-1", 0);
	const report = inspectBrowserProcesses([orphan], [{ pid: 99, alive: false }], Date.now());
	expect(report.browsers.map(browser => [browser.pid, browser.status])).toEqual([[51, "ORPHAN"]]);
	expect(planBrowserReap(report)).toEqual([{ pid: 51, clones: [] }]);
});
