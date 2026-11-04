import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { inspectPushLatency } from "../../src/push-latency.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { COMMANDS } from "../../src/commands.ts";
import { validateJsonSchema } from "../../src/mcp-apply.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const fixtures: OwnedTmp[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
function fixture() {
	const scratch = ownedTmp("push-latency"); fixtures.push(scratch);
	const home = join(scratch.path, "home"), state = join(scratch.path, "state");
	const path = join(state, "omp-kit", "gate-events.jsonl");
	mkdirSync(home, { recursive: true }); mkdirSync(dirname(path), { recursive: true });
	return { home, state, path, env: { ...process.env, HOME: home, XDG_STATE_HOME: state } };
}
function row(repo: string, attempt: string, member: string, start: number, duration: number) {
	return { ts: "2026-11-03T12:00:00Z", seat: "Fixture", act: "publish", target: "main", gate: member, kind: "pass", repo, attempt, member,
		hook: "pre-push", started_at: new Date(Date.UTC(2026, 10, 3, 12) + start * 1000).toISOString(), duration_s: duration };
}
function put(path: string, rows: unknown[]) { writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); }

test("push latency groups member intervals per repo/attempt, including gaps and even medians", () => {
	const f = fixture();
	put(f.path + ".1", [row("/alpha", "one", "10-quick", 0, 2), row("/alpha", "one", "40-full", 3, 7)]);
	put(f.path, [row("/alpha", "two", "10-quick", 60, 5), row("/alpha", "two", "40-full", 66, 24), row("/beta", "one", "20-check", 0, 4),
		{ ...row("/alpha", "commit", "10-commit", 0, 999), act: "commit", hook: "commit-msg" },
		{ act: "publish", repo: "/alpha", gate: "legacy", attempt: "old" },
		{ ...row("/alpha", "bad", "bad", 0, 1), duration_s: -1 },
		{ ...row("/alpha", "unbound", "bad", 0, 1), repo: null }]);
	const before = readFileSync(f.path, "utf8");
	const report = inspectPushLatency({ env: f.env, home: f.home });
	expect(report.overall).toBe("OK");
	expect(report.repos[0]).toMatchObject({ repo: "/alpha", samples: 2, median_s: 20, max_s: 30 });
	expect(report.repos[0]!.slowest_members).toEqual([
		{ member: "40-full", samples: 2, median_s: 15.5, max_s: 24 },
		{ member: "10-quick", samples: 2, median_s: 3.5, max_s: 5 },
	]);
	expect(report.repos[1]).toMatchObject({ repo: "/beta", samples: 1, median_s: 4, max_s: 4 });
	expect(report.untimed_rows).toBe(3);
	expect(report.timed_rows).toBe(5);
	expect(report.text).toContain("median=20.000s max=30.000s");
	expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("quiet empty ledger is unverified and malformed/torn input is visibly partial", () => {
	const f = fixture();
	expect(inspectPushLatency({ env: f.env }).overall).toBe("UNVERIFIED");
	writeFileSync(f.path, "bad json\n{\"act\":");
	const report = inspectPushLatency({ env: f.env });
	expect(report.overall).toBe("PARTIAL");
	expect(report.repos).toEqual([]);
	expect(report.issues[0]).toContain("1 invalid rows");
});

test("doctor push-latency renders the measured report through the real CLI", () => {
	const f = fixture(); put(f.path, [row("/alpha", "one", "40-full", 0, 12)]);
	const result = runFixture([process.execPath, "run", "--no-env-file", "--config=/dev/null", resolve(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "push-latency", "--json"], { cwd: f.home, env: f.env });
	expect(result.rc).toBe(0);
	const report = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(report.ok).toBe(true);
	expect(report.data).toMatchObject({ scope: "push-latency", overall: "OK", repos: [{ repo: "/alpha", median_s: 12, max_s: 12 }] });
	const schema = COMMANDS.find(command => command.name === "doctor")!.dataSchema;
	expect(validateJsonSchema(report.data, schema)).toEqual([]);
	expect(validateJsonSchema({ ...report.data, scope: "other" }, schema).length).toBeGreaterThan(0);
}, fixtureDeadlineS() * 1000);
