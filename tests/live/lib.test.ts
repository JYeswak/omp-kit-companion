import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp, cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runFixture } from "../cli/fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const project = ownedTmp("synthetic-abort-verdict").path;
const scenarios = await Bun.file(join(import.meta.dir, "scenarios.json")).json();
const index = scenarios.findIndex((scenario: { id: string }) => scenario.id === "jsonl-aggregate-fire");
if (index < 0) throw new Error("missing jsonl interruption scenario");
const rule = scenarios[index].rule;
const tool = scenarios[index].turns.find((turn: { tool?: { name: string } }) => turn.tool?.name === "read").tool;
const call = { event: "call", id: "read_1", timestamp: 1, name: "read", args: tool.args };
const stop = { event: "stop", timestamp: 1, reason: "aborted", error: `TTSR matched rule: ${rule}` };
const result = {
	event: "result", id: call.id, isError: true,
	content: [{ type: "text", text: `Tool execution was aborted: TTSR matched rule: ${rule}` }],
	details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
};
function verdict(rows: unknown[], messages: unknown[] = []): string {
	mkdirSync(join(project, ".beads"), { recursive: true });
	writeFileSync(join(project, ".beads/issues.jsonl"), '{"id":"example","status":"open","labels":[]}\n');
	writeFileSync(join(project, ".omp-kit-tool-events.jsonl"), [...rows, { event: "end" }].map(row => JSON.stringify(row)).join("\n") + "\n");
	const log = join(project, "requests.jsonl");
	writeFileSync(log, [0, 1, 2].map(n => JSON.stringify({ main: true, body: { messages: n === 2 ? [{ role: "user", content: `rule="${rule}"` }, ...messages] : [{ role: "user", content: "go" }] } })).join("\n") + "\n");
	const run = runFixture([process.execPath, join(import.meta.dir, "lib.mjs"), "verdict", String(index), log, project, "0"], { cwd: root, label: "synthetic-abort-verdict" });
	if (run.rc !== 0) throw new Error(Buffer.from(run.stderr).toString());
	return Buffer.from(run.stdout).toString().trim();
}
test("coalesced SSE synthetic abort is not tool execution", () => {
	expect(verdict([call, stop, result])).toBe("ok");
	expect(verdict([call, stop, result], [{ ...result, role: "tool", tool_call_id: call.id }])).toBe("ok");
});
test("abort prose cannot disguise real or unclassified results", () => {
	for (const planted of [
		{ ...result, details: undefined },
		{ ...result, details: { ...result.details, executed: true } },
		{ ...result, details: { ...result.details, __synthetic: false } },
		{ ...result, details: { ...result.details, source: "other" } },
		{ ...result, isError: false },
		{ ...result, content: [{ type: "text", text: "Tool execution was aborted: TTSR matched rule: another-rule" }] },
		{ ...result, content: [...result.content, { type: "image", data: "unclassified" }] },
	]) expect(verdict([call, stop, planted])).toMatch(/^FAIL:.*interruption/);
	expect(verdict([call, stop, result, { event: "execution", id: call.id }])).toMatch(/^FAIL:.*interruption/);
	expect(verdict([call, stop, result], [{ role: "tool", tool_call_id: call.id, content: result.content }])).toMatch(/^FAIL:.*interruption/);
	expect(verdict([call, stop, { ...result, id: "other" }, { event: "result", id: call.id }])).toMatch(/^FAIL:.*interruption/);
});
afterAll(() => cleanupAllOwnedTmp());
