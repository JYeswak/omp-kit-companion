import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { censusLoad, parsePsSnapshot } from "../../src/load-doctor.ts";
import { fixture, configure, invoke, forgeHealthyStatfs, seedJob } from "./heavy-fixtures.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { incarnationSync } from "../../src/kitlib/proc.ts";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
afterAll(cleanupAllOwnedTmp);

test("census names leftover owners, zombie parents and aged per-session MCP candidates", () => {
	const old = "Thu Nov  5 00:00:00 2026";
	const now = new Date("2026-11-06T12:00:00Z");
	const processes = parsePsSnapshot([
		`10 1 1 100 ${old} S omp --profile codex`,
		`20 10 80 100 ${old} S mathlas-mcp`,
		`30 1 50 100 ${old} S python3 loop_sentinel.py --apply`,
		`31 30 0 0 ${old} Z <defunct>`,
		`42 1 90 100 ${old} T bun test grader`,
		`50 1 5 100 ${old} S foreign-service`,
		`60 1 1 100 ${old} S omp-kit service run load-watch`,
		`70 1 1 100 ${old} S omp --resume /fixture/old-session.jsonl --profile codex`,
		`71 70 2 100 ${old} S sympy-mcp`,
	].join("\n"), true);
	const report = censusLoad({ processes, panes: [{ session: "old-seat", pane: "old-seat 0.1", pid: 10 }], jobs: [], now, machine: { load1: 20, ncpu: 4 } });
	expect(report.processes.find(p => p.pid === 20)).toMatchObject({ owner: "old-seat 0.1", cause_class: "aged-session-mcp", elapsed_s: expect.any(Number) });
	expect(report.processes.find(p => p.pid === 30)).toMatchObject({ owner: "com.omp-kit.loop-sentinel", cause_class: "unreaped-children", zombie_children: 1 });
	expect(report.processes.find(p => p.pid === 42)).toMatchObject({ cause_class: "suspended-work", command: "bun test grader" });
	expect(report.processes.find(p => p.pid === 50)).toMatchObject({ owner: "unattributed", cause_class: "active" });
	expect(report.processes.find(p => p.pid === 60)).toMatchObject({ owner: "com.omp-kit.load-watch", cause_class: "over-budget" });
	expect(report.processes.find(p => p.pid === 71)).toMatchObject({ owner: "session=/fixture/old-session.jsonl", cause_class: "aged-session-mcp" });
	expect(report.cause_classes).toContain("leftover-process");
});

test("measurement above threshold diagnoses before deferring; admitted control executes", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 5 });
	const marker = join(root, "measured");
	const args = ["heavy", "--no-wait", "--label", "measurement", "--", process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'measured')`];
	const refused = await invoke(root, args, { OMP_KIT_HEAVY_FAKE_LOAD1: "100000" });
	expect(refused.code, refused.stderr).toBe(75);
	expect(refused.stderr).toContain("LOAD_DIAGNOSIS");
	expect(refused.stderr).toContain('"pid":');
	expect(refused.stderr).toContain('"command":');
	expect(refused.stderr).toContain('"owner":');
	expect(existsSync(marker)).toBe(false);
	expect(refused.stderr.indexOf("LOAD_DIAGNOSIS")).toBeLessThan(refused.stderr.indexOf("RESOURCE_DEFERRED"));
	const census = JSON.parse(readFileSync(join(root, "state/omp-kit/load/census.json"), "utf8"));
	expect(census.machine.load1).toBe(100000);
	const admitted = await invoke(root, args);
	expect(admitted.code, admitted.stderr).toBe(0);
	expect(readFileSync(marker, "utf8")).toBe("measured");
}, fixtureDeadlineS(60) * 1000);

test("high load stops only an expired incarnation-bound kit job, never an unregistered or reused pid", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 5 });
	const launch = async () => {
		const ready = Promise.withResolvers<number>();
		const controller = new AbortController();
		// Integration child needs an idle event-loop handle until the real SIGTERM; this timer never synchronizes the test.
		const exited = run([process.execPath, "-e", "console.log(process.pid);setInterval(() => {}, 1000)"], {
			deadline_s: fixtureDeadlineS(60), signal: controller.signal,
			on_output: (stream, bytes) => { if (stream === "stdout") ready.resolve(Number(new TextDecoder().decode(bytes).trim())); },
		});
		const pid = await Promise.race([ready.promise, exited.then(() => { throw new Error("child exited before pid"); })]);
		return { pid, exited, controller };
	};
	const expired = await launch();
	const foreign = await launch();
	try {
		const start = incarnationSync(expired.pid)!.start;
		const dir = await seedJob(root, { id: "expired", pid: expired.pid, process_start: start });
		const path = join(dir, "expired.json");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), max_runtime_s: 1 }));
		await seedJob(root, { id: "reused", pid: foreign.pid, process_start: "Thu Jan 1 00:00:00 1970" });
		const result = await invoke(root, ["heavy", "--no-wait", "--", "true"], { OMP_KIT_HEAVY_FAKE_LOAD1: "100000" });
		expect(result.code, result.stderr).toBe(75);
		expect(result.stderr).toContain(`LOAD_ACTION stopped-expired-kit-job pid=${expired.pid}`);
		expect((await expired.exited).rc).toBe(-15);
		expect(incarnationSync(foreign.pid)).not.toBeNull();
	} finally {
		expired.controller.abort();
		foreign.controller.abort();
		await Promise.allSettled([expired.exited, foreign.exited]);
	}
}, fixtureDeadlineS(60) * 1000);

test("one queued measurement diagnoses high load then executes only after load recovers", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 20 });
	const preload = join(root, "load-transition.ts");
	writeFileSync(preload, `import ${JSON.stringify(forgeHealthyStatfs)};
import { mock } from 'bun:test';
import * as os from 'node:os';
const real = { ...os };
let reads = 0;
mock.module('node:os', () => ({ ...real, loadavg: () => [++reads === 1 ? 100000 : 0, 0, 0] }));
`);
	const result = await invoke(root, ["heavy", "--label", "measurement", "--", "echo", "MEASUREMENT_RAN"], { OMP_KIT_HEAVY_FAKE_LOAD1: "" }, { preload });
	expect(result.code, result.stderr).toBe(0);
	expect(result.stderr).toContain("LOAD_DIAGNOSIS load1=100000");
	expect(result.stdout).toBe("MEASUREMENT_RAN\n");
	const report = JSON.parse(readFileSync(join(root, "state/omp-kit/load/census.json"), "utf8"));
	expect(report.machine.load1).toBe(100000);
}, fixtureDeadlineS(60) * 1000);
