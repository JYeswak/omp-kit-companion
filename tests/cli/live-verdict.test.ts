import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const scenarios = await Bun.file(join(root, "tests/live/scenarios.json")).json();
const index = scenarios.findIndex((s: { id: string }) => s.id === "settings-no-checkout-remedy");
if (index < 0) throw new Error("continuation scenario is missing");
const fixture = mkdtempSync(join(tmpdir(), "kit-continuation-verdict-"));
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
