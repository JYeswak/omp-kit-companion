import { expect, test } from "bun:test";
import { classifyMineResult } from "../../src/mine-cause.ts";

test("cause classifier respects authoritative success and false timeout metadata", () => {
	for (const exit of [0, "0"]) expect(classifyMineResult({ tool: "bash", result: { isError: true, details: { rc: exit, timed_out: false }, content: "REFUSED: old output; timeout" } })).toBeNull();
	expect(classifyMineResult({ tool: "todo", result: { isError: true, timed_out: false, content: "Errors: Missing phase name for append operation\nremaining: timeout" } })?.class_id).toBe("validation:phase-name-required");
	expect(classifyMineResult({ tool: "bash", result: { isError: true, timed_out: false, content: "Command timed out" } })?.class_id).toBe("tool-error:unclassified");
	expect(classifyMineResult({ tool: "bash", result: { kind: "refuse", detail: "findings=0 rc=0" }, text: "findings=0 rc=0", is_error: true, outcome: "refuse" })).toBeNull();
	expect(classifyMineResult({ tool: "bash", result: { code: 0 }, text: "REFUSED: historical output; timeout", is_error: true })).toBeNull();
});

test("explicit false timeout metadata overrides contradictory timeout exit and outcome", () => {
	for (const exit of [124, 142]) {
		expect(classifyMineResult({ tool: "bash", result: { isError: true, timed_out: false, exit_code: exit }, text: "Command timed out", outcome: "timeout" })?.class_id).toBe("tool-error:unclassified");
		expect(classifyMineResult({ tool: "bash", result: {}, timed_out: false, exit_code: exit, outcome: "timeout" })?.class_id).toBe("tool-error:unclassified");
	}
	expect(classifyMineResult({ tool: "write", result: { isError: true, timed_out: false }, text: "MCP failure server: mcp-agent-mail tool: file_reservation_paths transport: http stage: send failure: timeout retryable: no" })?.class_id).toBe("mcp-transport:mcp__mcp_agent_mail_file_reservation_paths");
});

test("cause classifier confines status discovery to actual native envelopes", () => {
	expect(classifyMineResult({ tool: "eval", result: { isError: true, content: "AssertionError: expected active project to equal requested project", details: { command: { rc: 0, timed_out: false } } } })?.class_id).toBe("assertion:expected-active-project-to-equal-requested-project");
	expect(classifyMineResult({ tool: "grep", result: { isError: false, content: "AssertionError: quoted assertion\nMCP failure server: mcp-agent-mail tool: file_reservation_paths transport: http stage: send failure: timeout retryable: no" } })).toBeNull();
	expect(classifyMineResult({ tool: "read", result: { content: [{ type: "text", text: JSON.stringify({ data: { isError: true, timed_out: true, message: "AssertionError: quoted" } }) }] } })).toBeNull();
	for (const tool of ["grep", "read"]) {
		const quoted = JSON.stringify({ isError: true, timed_out: true, message: "AssertionError: quoted" });
		expect(classifyMineResult({ tool, result: { isError: false, content: quoted }, text: quoted, is_error: false })).toBeNull();
	}
	expect(classifyMineResult({ tool: "bash", result: { isError: true, content: "the prose mentions timeout and REFUSED but has no diagnostic prefix" } })?.class_id).toBe("tool-error:unclassified");
});

test("cause classifier resolves nested native MCP statuses and guard codes", () => {
	expect(classifyMineResult({ tool: "write", result: { isError: true, result: { tool: "mcp__mcp_agent_mail_file_reservation_paths", details: { timed_out: true }, content: "MCP error -32001: Request timed out" } } })?.class_id).toBe("mcp-transport:mcp__mcp_agent_mail_file_reservation_paths");
	expect(classifyMineResult({ tool: "write", result: { isError: true, content: "fleet-guard write-ownership (WRITE_OWN_LOOKUP_UNAVAILABLE): reservation lookup failed" } })?.class_id).toBe("guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE");
	expect(classifyMineResult({ tool: "commit", result: {}, outcome: "refused", code: "RESERVATION_REQUIRED" })?.class_id).toBe("commit-refusal:RESERVATION_REQUIRED");
	expect(classifyMineResult({ tool: "bash", result: {}, exit_code: 124 })?.class_id).toBe("timeout:bash");
});

test("cause diagnostics and derived class ids never retain raw credentials", () => {
	const result = classifyMineResult({ tool: "eval", result: { isError: true, content: "AssertionError: api_key=fixture-private-credential" } });
	expect(result?.class_id).toStartWith("assertion:");
	expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
});

test("untrusted tool names and guard codes cannot place credentials in class ids", () => {
	const credential = "ghp_" + "a".repeat(40);
	for (const name of [credential, "api_key=fixture-private-credential"]) {
		const timeout = classifyMineResult({ tool: name, result: { isError: true, timed_out: true } });
		const guard = classifyMineResult({ tool: "write", result: { isError: true }, outcome: "refused", code: name });
		expect(timeout?.class_id).toStartWith("timeout:");
		expect(guard?.class_id).toStartWith("guard-friction:");
		expect(JSON.stringify([timeout, guard])).not.toContain(credential);
		expect(JSON.stringify([timeout, guard])).not.toContain("fixture-private-credential");
	}
});

test("diagnostic prefixes reject bounded long near misses without keyword fallthrough", () => {
	for (const prefix of ["This edit anchors to lines ", "MCP failure server: ", "fleet-guard "]) {
		expect(classifyMineResult({ tool: "write", result: { isError: true, content: prefix + "x".repeat(65_536) + " timeout" } })?.class_id).toBe("tool-error:unclassified");
	}
});
