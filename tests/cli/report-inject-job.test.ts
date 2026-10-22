import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPORT_INJECT_DEADLINE_MS, runReportInjectJob, type ReportInjectCommandResult } from "../../src/report-inject-job.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
const observedAt = "2026-10-13T20:00:00.000Z";

function fixture(label: string, stateGeneratedAt: string, pulse: Record<string, unknown> | Record<string, unknown>[] | null) {
	mkdirSync(scratchRoot, { recursive: true });
	const root = ownedTmp(`reportinject-${label}`, { root: scratchRoot }).path;
	const kitRoot = join(root, "kit");
	const home = join(root, "home");
	const configPath = join(home, ".config", "omp-kit", "fleet-watch.json");
	const statePath = join(kitRoot, "docs", "fleet-state", "latest.json");
	const pulsePath = join(kitRoot, "var", "sitrep", "pulse.jsonl");
	mkdirSync(join(kitRoot, "scripts"), { recursive: true });
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ sessions: [{ session: "w2" }] }));
	const run = (argv: readonly string[]): ReportInjectCommandResult => {
		if (argv[1]?.endsWith("fleet-state.py")) {
			mkdirSync(join(kitRoot, "docs", "fleet-state"), { recursive: true });
			const state = { generated_at: stateGeneratedAt, sessions: [{ session: "w2" }] };
			writeFileSync(statePath, JSON.stringify(state));
			return { code: 0, stdout: JSON.stringify(state), stderr: "" };
		}
		if (argv[1]?.endsWith("sitrep.sh")) {
			mkdirSync(join(kitRoot, "var", "sitrep"), { recursive: true });
			if (pulse !== null) writeFileSync(pulsePath, `${(Array.isArray(pulse) ? pulse : [pulse]).map(row => JSON.stringify(row)).join("\n")}\n`);
			return { code: 0, stdout: `SITREP ${observedAt}\n\n== Mission\nmission fixture\n== Closes per day\nflow fixture\n`, stderr: "" };
		}
		return { code: 2, stdout: "", stderr: "unexpected fixture command" };
	};
	return { root, kitRoot, home, configPath, statePath, pulsePath, run };
}

test("stale fleet state is replaced with an explicit UNKNOWN envelope while the report is still written", async () => {
	const f = fixture("stale-state", "2026-10-13T18:49:59.000Z", {
		repo: "w2", ts: observedAt, ready: 1, in_progress: 2, closed_24h: 3, blocked: 0, blocked_no_fix: 0,
	});
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: () => {},
	});
	const state = JSON.parse(readFileSync(f.statePath, "utf8")) as Record<string, unknown>;
	expect(result).toMatchObject({ status: "FAILED", exit: 1, error: "CHIEF_PANE_MISSING", sourceAges: { fleetState: "STALE" } });
	expect(state.status).toBe("UNKNOWN");
	expect(readFileSync(join(f.kitRoot, "docs", "fleet-state", "latest.md"), "utf8")).toContain("SITREP 2026-10-13T20:00:00.000Z");
	expect(result.projects).toEqual([{ name: "w2", status: "OK", detail: "ready=1 in_progress=2 closed_24h=3 blocked=0 blocked_no_fix=0" }]);
});

test("source ages use report completion time rather than the source timestamp", async () => {
	const f = fixture("completion-age", observedAt, {
		repo: "w2", ts: observedAt, ready: 1, in_progress: 2, closed_24h: 3, blocked: 0, blocked_no_fix: 0,
	});
	let clockCall = 0;
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(clockCall++ === 0 ? observedAt : "2026-10-13T20:00:02.000Z"),
		log: () => {},
	});
	expect(result.sourceAges).toMatchObject({ sitrep: "2s", fleetState: "2s", fleetPulse: "2s" });
});

test("missing fleet-pulse producer fields classify the project UNKNOWN rather than zero", async () => {
	const f = fixture("missing-pulse-field", observedAt, {
		repo: "w2", ts: observedAt, ready: 1, in_progress: 2, closed_24h: 3, blocked: 0,
	});
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: () => {},
	});
	const digest = readFileSync(join(f.kitRoot, "docs", "fleet-state", "latest.md"), "utf8");
	expect(result).toMatchObject({ status: "FAILED", exit: 1, error: "CHIEF_PANE_MISSING" });
	expect(result.projects).toEqual([{ name: "w2", status: "UNKNOWN", detail: "blocked_no_fix unavailable" }]);
	expect(digest).toContain("SITREP 2026-10-13T20:00:00.000Z");
});
test("fleet-pulse age follows the latest row for a project", async () => {
	const f = fixture("pulse-latest", observedAt, [
		{ repo: "w2", ts: "2026-10-13T18:49:59.000Z", ready: 1, in_progress: 2, closed_24h: 3, blocked: 0, blocked_no_fix: 0 },
		{ repo: "w2", ts: observedAt, ready: 4, in_progress: 5, closed_24h: 6, blocked: 7, blocked_no_fix: 8 },
	]);
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: () => {},
	});
	expect(result.sourceAges.fleetPulse).toBe("0s");
	expect(result.projects).toEqual([{ name: "w2", status: "OK", detail: "ready=4 in_progress=5 closed_24h=6 blocked=7 blocked_no_fix=8" }]);
});
test("a failed fleet-pulse producer with no project row yields UNKNOWN, not zero", async () => {
	const f = fixture("pulse-missing", observedAt, null);
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: () => {},
	});
	expect(result.projects).toEqual([{ name: "w2", status: "UNKNOWN", detail: "fleet-pulse row unavailable" }]);
});
test("sender wait windows fit within the report job's remaining budget", async () => {
	const f = fixture("send-budget", observedAt, {
		repo: "w2", ts: observedAt, ready: 1, in_progress: 2, closed_24h: 3, blocked: 0, blocked_no_fix: 0,
	});
	writeFileSync(f.configPath, JSON.stringify({ chief: { session: "w2", pane: "%1" }, sessions: [{ session: "w2" }] }));
	const budgets: { deadlineMs: number; untilDeliveredMs: number }[] = [];
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: () => {},
		send: async input => {
			budgets.push({ deadlineMs: input.deadlineMs ?? 0, untilDeliveredMs: input.untilDeliveredMs ?? 0 });
			return { status: "NOT_DELIVERED", marker: "fixture", sends: 0, drop_path: null, detail: "fixture refusal", bead_ids: [], no_bead_reason: null, tmux_socket: null };
		},
	});
	expect(result.error).toBe("SEND_NOT_DELIVERED");
	expect(budgets).toHaveLength(1);
	expect(budgets[0]!.deadlineMs).toBe(budgets[0]!.untilDeliveredMs);
	expect(3 * budgets[0]!.untilDeliveredMs + 2 * budgets[0]!.deadlineMs).toBeLessThanOrEqual(REPORT_INJECT_DEADLINE_MS);
});

test("deferred sender delivery logs deferred before delivered without relying on detail text", async () => {
	const f = fixture("deferred-delivered", observedAt, {
		repo: "w2", ts: observedAt, ready: 1, in_progress: 2, closed_24h: 3, blocked: 0, blocked_no_fix: 0,
	});
	writeFileSync(f.configPath, JSON.stringify({ chief: { session: "w2", pane: "%1" }, sessions: [{ session: "w2" }] }));
	const logs: string[] = [];
	const result = await runReportInjectJob({ reportRoot: f.kitRoot, home: f.home, dropDir: join(f.root, "drop"), fleetConfigPath: f.configPath }, {
		run: f.run,
		now: () => new Date(observedAt),
		log: line => logs.push(line),
		send: async () => ({
			status: "DELIVERED",
			marker: "kit-send-0123456789ab",
			sends: 1,
			drop_path: null,
			detail: "sender confirmed receiver consumption",
			bead_ids: [],
			no_bead_reason: null,
			tmux_socket: null,
		}),
	});
	expect(result.status).toBe("DELIVERED");
	expect(logs).toHaveLength(2);
	expect(logs[0]).toContain("DEFERRED marker=kit-send-0123456789ab");
	expect(logs[1]).toContain("DELIVERED marker=kit-send-0123456789ab pane=w2:%1");
});

