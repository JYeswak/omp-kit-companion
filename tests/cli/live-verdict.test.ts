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

afterAll(() => cleanupAllOwnedTmp());
