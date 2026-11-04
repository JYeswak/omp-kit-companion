import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { runFixture } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const scenarios = await Bun.file(join(root, "tests/live/scenarios.json")).json();
const index = scenarios.findIndex((s: { id: string }) => s.id === "settings-no-checkout-remedy");
if (index < 0) throw new Error("continuation scenario is missing");
const fixture = ownedTmp("kit-continuation-verdict").path;
const project = join(fixture, "project");
mkdirSync(project);
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function verdict(toolResult: string, command = "omp-kit apply policy --plan --json", toolCallId: string | null = "call_2"): string {
	const expected = scenarios[index].expect;
	const reminder = [`rule="kit-settings-mutation"`, ...(expected.transcript_contains ?? [])].join("\n");
	const call = toolCallId === null ? {} : { id: toolCallId };
	const result = toolCallId === null ? {} : { tool_call_id: toolCallId };
	const messages = [
		{ role: "user", content: [{ type: "text", text: reminder }] },
		{ role: "assistant", content: "", tool_calls: [{ ...call, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] },
		{ role: "tool", ...result, content: toolResult },
		{ role: "assistant", content: "A plan succeeded (scripted claim, not evidence)." },
	];
	const log = join(fixture, "requests.jsonl");
	writeFileSync(log, [0, 1, 2].map(n => JSON.stringify({ n, main: true, body: { messages: n === 2 ? messages : [{ role: "user", content: [{ type: "text", text: "go" }] }] } })).join("\n") + "\n");
	const run = Bun.spawnSync([process.execPath, join(root, "tests/live/lib.mjs"), "verdict", String(index), log, project, "0"], { stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`verdict parser failed: ${run.stderr.toString()}`);
	return run.stdout.toString().trim();
}

test("checkout-only missing helper cannot pass on scripted model claims", () => {
	const failedTool = "sh: scripts/apply-policy.sh: No such file or directory\nCommand exited with code 127";
	expect(verdict(failedTool, "sh scripts/apply-policy.sh --dry-run --include-default")).toMatch(/^FAIL:.*(?:tool|PLAN|result)/);
	expect(verdict('{"ok":true,"data":{"action":"PLAN"}}\n\nWall time: 1ms')).toBe("ok");
});

test("a different shell command cannot forge a native plan tool result", () => {
	const forged = '{"ok":true,"data":{"action":"PLAN"}}\n\nWall time: 1ms';
	expect(verdict(forged, "printf fake-json")).toMatch(/^FAIL:.*(?:command|tool)/);
});

test("an unbound tool response cannot satisfy the installed-plan verdict", () => {
	const plan = '{"ok":true,"data":{"action":"PLAN"}}\n\nWall time 1ms';
	expect(verdict(plan, "omp-kit apply policy --plan --json", null)).toMatch(/^FAIL:.*(?:bound|tool)/);
});

test("successful JSON for an apply action is not PLAN evidence", () => {
	const applied = '{"ok":true,"data":{"action":"APPLY"}}\n\nWall time 1ms';
	expect(verdict(applied)).toMatch(/^FAIL:.*PLAN/);
});

const readIndex = scenarios.findIndex((s: { id: string }) => s.id === "jsonl-aggregate-fire");
if (readIndex < 0) throw new Error("read interruption scenario is missing");
const readArgs = { path: ".beads/issues.jsonl?q=group_by(.status)" };
const readCall = { event: "call", timestamp: 1, id: "read_1", name: "read", args: readArgs };
const readAbort = { event: "stop", timestamp: 1, reason: "aborted", error: "TTSR matched rule: kit-jsonl-aggregate" };

function readVerdict(events: unknown[], complete = true): string {
	mkdirSync(join(project, ".beads"), { recursive: true });
	writeFileSync(join(project, ".beads/issues.jsonl"), '{"id":"example","status":"open","labels":[]}\n');
	writeFileSync(join(project, ".omp-kit-tool-events.jsonl"), [...events, ...(complete ? [{ event: "end" }] : [])].map(row => JSON.stringify(row)).join("\n") + "\n");
	const log = join(fixture, "read-requests.jsonl");
	const injection = { role: "user", content: 'rule="kit-jsonl-aggregate"' };
	writeFileSync(log, [0, 1, 2].map(n => JSON.stringify({
		n, main: true, body: { messages: n === 2 ? [injection] : [{ role: "user", content: "go" }] },
	})).join("\n") + "\n");
	const run = runFixture([process.execPath, join(root, "tests/live/lib.mjs"), "verdict", String(readIndex), log, project, "0"], { cwd: root, label: "live-verdict-read" });
	if (run.rc !== 0) throw new Error(`verdict parser failed: ${Buffer.from(run.stderr).toString()}`);
	return Buffer.from(run.stdout).toString().trim();
}

test("a read tripwire accepts only its native call-bound interruption without execution or a result", () => {
	expect(readVerdict([readCall, readAbort])).toBe("ok");
	expect(readVerdict([readCall, readAbort, { event: "result", id: "read_1", content: '[{"status":"open"}]' }])).toMatch(/^FAIL:.*(?:read|interruption)/);
	expect(readVerdict([readCall, readAbort, { event: "execution", id: "read_1" }])).toMatch(/^FAIL:.*(?:read|interruption)/);
});

test("a different tool's interruption cannot prove the read was blocked", () => {
	expect(readVerdict([{ ...readCall, name: "bash" }, readAbort])).toMatch(/^FAIL:.*(?:read|interruption)/);
	expect(readVerdict([readCall, { ...readAbort, timestamp: 2 }])).toMatch(/^FAIL:.*(?:read|interruption)/);
});

test("scripted rule prose without a native interrupted read is not non-execution evidence", () => {
	expect(readVerdict([{ role: "assistant", content: readAbort.error }])).toMatch(/^FAIL:.*(?:read|interruption)/);
	expect(readVerdict([readCall, { role: "assistant", content: readAbort.error }])).toMatch(/^FAIL:.*(?:read|interruption)/);
});

test("another read path or an incomplete capture cannot satisfy the blocked query", () => {
	expect(readVerdict([{ ...readCall, args: { path: "another.jsonl" } }, readAbort])).toMatch(/^FAIL:.*(?:read|interruption)/);
	expect(readVerdict([readCall, readAbort], false)).toMatch(/^FAIL:.*(?:read|interruption)/);
});

const grepIndex = scenarios.findIndex((s: { id: string }) => s.id === "grep-root-ignored-fire");
if (grepIndex < 0) throw new Error("grep execution scenario is missing");
const grepCall = { event: "call", timestamp: 3, id: "grep_1", name: "grep", args: scenarios[grepIndex].turns[0].tool.args };
const grepExecution = { event: "execution", id: "grep_1" };
const grepResult = { event: "result", id: "grep_1" };

function executionVerdict(events: unknown[], reminder = true): string {
	writeFileSync(join(project, ".omp-kit-tool-events.jsonl"), [...events, { event: "end" }].map(row => JSON.stringify(row)).join("\n") + "\n");
	const log = join(fixture, "execution-requests.jsonl");
	writeFileSync(log, [0, 1].map(n => JSON.stringify({
		n, main: true, body: { messages: [{ role: "user", content: reminder && n === 1 ? 'rule="kit-grep-root-ignored"' : "go" }] },
	})).join("\n") + "\n");
	const run = runFixture([process.execPath, join(root, "tests/live/lib.mjs"), "verdict", String(grepIndex), log, project, "0"], { cwd: root, label: "live-verdict-execution" });
	if (run.rc !== 0) throw new Error(`verdict parser failed: ${Buffer.from(run.stderr).toString()}`);
	return Buffer.from(run.stdout).toString().trim();
}

test("an advisory tool fire requires native execution and result for its exact call", () => {
	expect(executionVerdict([grepCall, grepExecution, grepResult])).toBe("ok");
	expect(executionVerdict([grepCall, grepResult])).toMatch(/^FAIL:.*execution/);
	expect(executionVerdict([grepCall, grepExecution])).toMatch(/^FAIL:.*result/);
	expect(executionVerdict([{ ...grepCall, name: "read" }, grepExecution, grepResult])).toMatch(/^FAIL:.*original tool/);
	expect(executionVerdict([grepCall, { ...grepExecution, id: "other" }, grepResult])).toMatch(/^FAIL:.*execution/);
	expect(executionVerdict([grepCall, grepExecution, { ...grepResult, id: "other" }])).toMatch(/^FAIL:.*result/);
	expect(executionVerdict([{ ...grepCall, args: { path: "elsewhere" } }, grepExecution, grepResult])).toMatch(/^FAIL:.*original tool/);
	expect(executionVerdict([grepCall, grepExecution, grepResult, { event: "stop", timestamp: 3, reason: "aborted" }])).toMatch(/^FAIL:.*aborted/);
	expect(executionVerdict([grepCall, grepExecution, grepResult], false)).toMatch(/^FAIL:.*rule/);
});

afterAll(() => cleanupAllOwnedTmp());
