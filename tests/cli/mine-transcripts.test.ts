import { afterAll, beforeAll, expect, test } from "bun:test";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { createReadStream, mkdirSync, realpathSync, writeFileSync, utimesSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { mineTranscripts } from "../../src/mine-transcripts.ts";
import type { MineCoverage, MineSourceContext, MineSourceFinding } from "../../src/mine.ts";

let scratch = "", number = 0;
beforeAll(() => {
	// kitlib owns the temp dir and removes it on exit; no installed kit or native CLI needed (gate-hermetic).
	scratch = realpathSync(ownedTmp("mine-transcripts-tests").path);
});
afterAll(cleanupAllOwnedTmp);
function fixture() {
	const home = join(scratch, `fixture-${++number}`);
	const projects = ["jev", "localbench", "uds", "zestroku"].map(name => ({ name, path: join(home, "Developer", name) }));
	for (const project of projects) mkdirSync(project.path, { recursive: true });
	const findings: MineSourceFinding[] = [], coverage: MineCoverage[] = [], marks: { project: string; records: number }[] = [];
	const ctx: MineSourceContext = {
		home, projects, since_ms: Date.parse("2026-10-01"), until_ms: Date.parse("2026-11-01"),
		emit: f => findings.push(f), markSource: (project, _producer, records) => { marks.push({ project, records }); },
		coverage: (producer, location, detail = "") => { const row: MineCoverage = { producer, location, detail, status: "READ", rows: 0, first_timestamp: null, last_timestamp: null }; coverage.push(row); return row; },
		readLines: async (path, producer, consume) => {
			const cov = ctx.coverage(producer, path); let line = 0;
			for await (const raw of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
				line++;
				try { const row = JSON.parse(raw); consume(row, `${path}:${line}`); cov.rows++; }
				catch { cov.status = "PARTIAL"; cov.detail = "Malformed JSONL"; }
			}
			return cov;
		},
		command: async () => { throw new Error("transcript adapter must not execute producers"); }, expired: () => false,
		warn: message => { throw new Error(`unexpected warning: ${message}`); },
	};
	function put(project: string, name: string, rows: unknown[], profile = "default") {
		const path = join(home, ".omp", "profiles", profile, "agent", "sessions", `-Developer-${project}`, name);
		mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n"); return path;
	}
	return { ctx, projects, findings, coverage, marks, put };
}
function message(role: string, body: string, timestamp = "2026-10-02T00:00:00Z", extra: Record<string, unknown> = {}) {
	return { type: "message", timestamp, message: { role, content: [{ type: "text", text: body }], ...extra } };
}

test("pre-CC October native fire: real endpoints, refusals, correction, copy dedup and physical citations", async () => {
	const f = fixture(), project = f.projects[0]!;
	const rows = [
		{ type: "session", version: 3, id: "native-october", cwd: project.path },
		{ type: "tool_execution_start", timestamp: "2026-10-01T23:58:00Z", toolCallId: "bash-1", toolName: "bash" },
		message("toolResult", "Command timed out; token=super-private", undefined, { toolCallId: "bash-1", isError: true }),
		message("toolResult", "MEMBER_REFUSED: staged paths belong to another agent", undefined, { toolCallId: "commit-1", toolName: "bash", isError: true }),
		message("toolResult", "Patch did not match", undefined, { toolCallId: "edit-1", toolName: "edit", isError: true }),
		message("user", "No, use the configured repository."),
		{ type: "guard.refused", timestamp: "2026-10-02T00:00:00Z", message: "write outside reservation", code: "reservation" },
	];
	const path = f.put("jev", "advisor/subagent.jsonl", rows);
	utimesSync(path, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));
	f.put("jev", "copied.jsonl", rows, "other");
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id).sort()).toEqual(["commit-refusal:MEMBER_REFUSED", "guard-friction:reservation", "timeout:bash", "validation:edit-anchor-mismatch", "user-correction"].sort());
	expect(f.findings.find(row => row.class_id === "timeout:bash")?.measured_minutes).toBe(2);
	expect(f.findings.find(row => row.class_id === "validation:edit-anchor-mismatch")?.measured_minutes).toBeNull();
	expect(f.findings.every(row => row.citation.startsWith(path + ":"))).toBe(true);
	expect(f.findings.some(row => row.summary.includes("super-private"))).toBe(false);
	expect(f.findings.find(row => row.class_id === "user-correction")?.summary).toStartWith("Heuristic user correction:");
});

test("quiet projects, assistant quotations, search output and exact window boundaries", async () => {
	const f = fixture();
	for (const p of f.projects) f.put(p.name, "quiet.jsonl", [
		{ type: "session", version: 3, id: p.name, cwd: p.path },
		message("assistant", "REFUSED timeout; user said stop; that's wrong"),
		message("toolResult", "REFUSED: search result quotation; Command timed out; MEMBER_REFUSED" + " ".repeat(65_536), undefined, { toolName: "grep", isError: false }),
		message("user", "Please write a test saying 'No, stop'."),
		message("toolResult", "Failure", "2026-09-30T23:59:59Z", { isError: true }),
		message("toolResult", "Failure", "2026-11-01T00:00:00Z", { isError: true }),
	]);
	f.put("jev", "artifacts.log/ignored.jsonl", [message("user", "Stop artifact ingestion")]);
	f.put("jev", "local/regression-corpus.jsonl", [message("user", "Stop: this captured fixture is not a native session")]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(0);
	for (const p of f.projects) expect(f.marks.some(mark => mark.project === p.path && mark.records === 3)).toBe(true);
	expect(f.coverage.filter(c => c.location.endsWith("quiet.jsonl")).every(c => c.status === "READ" && c.rows === 3)).toBe(true);
	const g = fixture();
	g.put("jev", "boundary.jsonl", [{ type: "session", id: "boundary", cwd: g.projects[0]!.path }, { type: "message", message: { role: "user", timestamp: "2026-10-01T00:00:00Z", content: [{ type: "text", text: "Stop at inclusive start" }] } }]);
	await mineTranscripts(g.ctx);
	expect(g.findings).toHaveLength(1);
});

test("header cwd wins over seat, unmapped fixtures and malformed/timestamp gaps stay explicit", async () => {
	const f = fixture();
	f.put("jev", "wrong-seat.jsonl", [{ type: "session", id: "mapped", cwd: f.projects[2]!.path }, message("user", "Why did you change that?")]);
	f.put("jev", "scratch.jsonl", [{ type: "session", id: "scratch", cwd: join(f.ctx.home, "unconfigured-scratch") }, message("user", "Stop now")]);
	f.put("localbench", "gaps.jsonl", [{ type: "session", id: "gaps", cwd: f.projects[1]!.path }, "{malformed", { type: "message", message: { role: "user", content: "Stop" } }]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(1);
	expect(f.findings[0]?.project).toBe(f.projects[2]!.path);
	expect(f.coverage.find(c => c.location.endsWith("scratch.jsonl"))?.detail).toContain("unmapped window records=1");
	expect(f.coverage.find(c => c.location.endsWith("gaps.jsonl"))?.status).toBe("PARTIAL");
	expect(f.coverage.find(c => c.location.endsWith("gaps.jsonl"))?.detail).toContain("timestamp gaps=1");
});

test("missing optional profile roots report missing coverage without executing a producer", async () => {
	const f = fixture(); await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(0);
	expect(f.coverage.every(c => c.status === "MISSING")).toBe(true);
	for (const p of f.projects) expect(f.coverage.some(c => c.location === p.path)).toBe(true);
});

test("false timeout metadata and retained rc zero do not invent failures", async () => {
	const f = fixture();
	f.put("jev", "success-metadata.jsonl", [
		{ type: "session", id: "success-metadata", cwd: f.projects[0]!.path },
		message("toolResult", '{"timed_out":false,"exit_code":1,"message":"ValidationError: phase name is required"}', undefined, { toolCallId: "todo-invalid", toolName: "todo", isError: true }),
		message("toolResult", "REFUSED: quoted prior refusal", undefined, { toolCallId: "retained-success", toolName: "bash", isError: true, details: { exit_code: 0, timed_out: false } }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(["validation:phase-name-required"]);
	expect(f.findings[0]?.summary).toContain("phase name is required");
});

test("native nested MCP timeout uses inner transport identity rather than local write", async () => {
	const f = fixture();
	f.put("jev", "mcp-transport.jsonl", [
		{ type: "session", id: "mcp-transport", cwd: f.projects[0]!.path },
		message("toolResult", "", undefined, { toolCallId: "reservation-timeout", toolName: "write", isError: true,
			result: { tool: "mcp__mcp_agent_mail_file_reservation_paths", isError: true, details: { timed_out: true }, content: [{ type: "text", text: "MCP error -32001: Request timed out" }] } }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(["mcp-transport:mcp__mcp_agent_mail_file_reservation_paths"]);
	expect(f.findings[0]?.summary).toContain("Request timed out");
});

test("named validation assertion and identity causes survive nested successful command output", async () => {
	const f = fixture();
	f.put("jev", "named-causes.jsonl", [
		{ type: "session", id: "named-causes", cwd: f.projects[0]!.path },
		message("toolResult", "ValidationError: phase name is required", undefined, { toolCallId: "phase", toolName: "todo", isError: true, details: { timed_out: false } }),
		message("toolResult", "AssertionError: expected active project to equal requested project", undefined, { toolCallId: "assertion", toolName: "bash", isError: true, details: { command: { exit_code: 0, output: "identity lookup succeeded" } } }),
		message("toolResult", "IdentityError: agent identity is not registered", undefined, { toolCallId: "identity", toolName: "write", isError: true }),
		message("toolResult", "Unexpected opaque failure", undefined, { toolCallId: "opaque", toolName: "bash", isError: true }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(["validation:phase-name-required", "assertion:expected-active-project-to-equal-requested-project", "identity:agent-identity-is-not-registered", "tool-error:unclassified"]);
	expect(f.findings[1]?.summary).toContain("AssertionError");
	expect(f.findings[3]?.summary).toContain("Unexpected opaque failure");
});

test("assistant arguments and execution start input join raw event ids across day boundary with private replay", async () => {
	const f = fixture();
	f.ctx.since_ms = Date.parse("2026-10-02");
	f.put("jev", "replay-inputs.jsonl", [
		{ type: "session", id: "replay-inputs", cwd: f.projects[0]!.path },
		{ type: "message", timestamp: "2026-10-01T23:59:00Z", message: { role: "assistant", content: [
			{ type: "toolCall", id: "raw-call-id", name: "bash", arguments: { command: "printf replay-context", api_key: "fixture-private-credential" } },
		] } },
		{ type: "tool_execution_start", timestamp: "2026-10-01T23:59:30Z", toolCallId: "start-only", toolName: "todo", input: { phase: "" } },
		message("toolResult", "AssertionError: replay context missing", undefined, { toolCallId: "raw-call-id", toolName: "bash", isError: true }),
		{ type: "tool_execution_end", timestamp: "2026-10-02T00:00:30Z", toolCallId: "start-only", toolName: "todo", result: { isError: true, content: [{ type: "text", text: "ValidationError: phase name is required" }] } },
	]);
	await mineTranscripts(f.ctx);
	const retained = f.findings as (MineSourceFinding & { event_id?: string; replay?: { tool: string; arguments: unknown; cwd: string; message: string | null; redacted: boolean } })[];
	expect(retained).toHaveLength(2);
	expect(retained[0]?.event_id).toBe("raw-call-id");
	expect(retained[0]?.replay?.tool).toBe("bash");
	expect(retained[0]?.replay?.arguments).toMatchObject({ command: "printf replay-context" });
	expect(retained[0]?.replay?.cwd).toBe(f.projects[0]!.path);
	expect(retained[0]?.replay?.message).toBeNull();
	expect(retained[0]?.summary).toContain("AssertionError: replay context missing");
	expect(retained[0]?.replay?.redacted).toBe(true);
	expect(JSON.stringify(retained)).not.toContain("fixture-private-credential");
	expect(retained[1]?.event_id).toBe("start-only");
	expect(retained[1]?.replay?.arguments).toEqual({ phase: "" });
	expect(retained[1]?.measured_minutes).toBe(1);
});

test("guard result codes match gate classes without classifying successful search quotations", async () => {
	const f = fixture();
	f.put("jev", "guard-codes.jsonl", [
		{ type: "session", id: "guard-codes", cwd: f.projects[0]!.path },
		message("toolResult", "Refused: reservation required", undefined, { toolCallId: "guard", toolName: "write", isError: true, details: { outcome: "refused", code: "RESERVATION_REQUIRED" } }),
		message("toolResult", "MEMBER_REFUSED: staged paths belong to another agent", undefined, { toolCallId: "commit", toolName: "commit", isError: true, details: { outcome: "refused", code: "MEMBER_REFUSED" } }),
		message("toolResult", "ValidationError: phase name is required\nMCP error -32001: Request timed out", undefined, { toolCallId: "search", toolName: "grep", isError: false, details: { exit_code: 0 } }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(["guard-friction:RESERVATION_REQUIRED", "commit-refusal:MEMBER_REFUSED"]);
});

test("audit native diagnostics classify named causes without prose timeout contamination", async () => {
	const f = fixture();
	const witnesses = [
		["todo", "Errors: Missing phase name for append operation\nRemaining items: inspect timeout handling", "validation:phase-name-required"],
		["write", "MCP failure server: mcp-agent-mail tool: file_reservation_paths transport: http stage: send failure: timeout retryable: no message: Request timeout after 30000ms next: Check server health or increase the MCP timeout; the request outcome is unknown.", "mcp-transport:mcp__mcp_agent_mail_file_reservation_paths"],
		["eval", "Process director verification decision: Error: Wiring disposition not persisted at <anonymous> ...", "assertion:wiring-disposition-not-persisted"],
		["task", "Per-call model is disabled for task calls (task.perCallModel: off). Omit model to use the agent's configured model.", "validation:task-per-call-model-disabled"],
		["write", "content is required for local://deployed-form-http-check.json.", "validation:content-required"],
		["read", "Failed to execute JSON query: Error: cannot use {...} as array", "validation:json-query"],
		["edit", "This edit anchors to lines 186, 198 of cli/src/core/result-contract.ts that [cli/src/core/result-contract.ts#1757] never displayed ...", "validation:edit-undisplayed-anchor"],
		["write", "fleet-guard write-ownership (WRITE_OWN_LOOKUP_UNAVAILABLE): the reservation lookup failed: am exited 1: error: invalid argument: agent not found: grader-fp72_120_16_87", "guard-friction:WRITE_OWN_LOOKUP_UNAVAILABLE"],
	];
	f.put("jev", "audit-diagnostics.jsonl", [
		{ type: "session", id: "audit-diagnostics", cwd: f.projects[0]!.path },
		...witnesses.map(([tool, body], index) => message("toolResult", body!, undefined, {
			toolCallId: `audit-${index}`, toolName: tool, isError: true, details: { timed_out: false },
		})),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(witnesses.map(row => row[2]));
});

test("native kit guard prefixes retain their exact gate code", async () => {
	const f = fixture();
	f.put("jev", "kit-guard-prefixes.jsonl", [
		{ type: "session", id: "kit-guard-prefixes", cwd: f.projects[0]!.path },
		message("toolResult", "kit-flywheel-guard WAIT_REFUSED: use the available work", undefined, { toolCallId: "wait", toolName: "wait", isError: true }),
		message("toolResult", "kit-flywheel-guard ASKDEFAULT1: use the default answer", undefined, { toolCallId: "ask", toolName: "ask", isError: true }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings.map(row => row.class_id)).toEqual(["guard-friction:WAIT_REFUSED", "guard-friction:ASKDEFAULT1"]);
});

test("bounded retained call context preserves loss flags across duplicate native completions", async () => {
	const f = fixture();
	const input = { command: "x".repeat(20_000), api_key: "fixture-private-credential" };
	f.put("jev", "bounded-context.jsonl", [
		{ type: "session", id: "bounded-context", cwd: f.projects[0]!.path },
		{ type: "message", timestamp: "2026-09-30T23:59:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "bounded-call", name: "eval", arguments: input }] } },
		{ type: "tool_execution_end", timestamp: "2026-10-02T00:00:00Z", toolCallId: "bounded-call", toolName: "eval", result: { isError: true, content: [{ type: "text", text: "AssertionError: retained input" }] } },
		message("toolResult", "AssertionError: retained input", undefined, { toolCallId: "bounded-call", toolName: "eval", isError: true }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(1);
	const replay = (f.findings[0] as MineSourceFinding & { replay: { arguments: { command: string }; truncated: boolean; redacted: boolean } }).replay;
	expect(replay.arguments.command.length).toBeLessThan(input.command.length);
	expect(replay.truncated).toBe(true);
	expect(replay.redacted).toBe(true);
	expect(JSON.stringify(f.findings)).not.toContain("fixture-private-credential");
});

test("retiring more than 256 completed call contexts preserves complete source coverage", async () => {
	const f = fixture();
	const rows: unknown[] = [{ type: "session", id: "completed-cache", cwd: f.projects[0]!.path }];
	for (let index = 0; index < 300; index++) {
		rows.push({ type: "message", timestamp: "2026-10-02T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: `completed-${index}`, name: "bash", arguments: { command: "true" } }] } });
		rows.push(message("toolResult", "ok", undefined, { toolCallId: `completed-${index}`, toolName: "bash", isError: false, details: { rc: 0 } }));
	}
	const path = f.put("jev", "completed-cache.jsonl", rows);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(0);
	const coverage = f.coverage.find(row => row.location === path);
	expect(coverage?.rows).toBe(600);
	expect(coverage?.status).toBe("READ");
	expect(coverage?.detail).not.toContain("evictions");
});

test("native guard event codes cannot retain credential values", async () => {
	const f = fixture();
	const credential = "ghp_" + "a".repeat(40);
	f.put("jev", "guard-code-privacy.jsonl", [
		{ type: "session", id: "guard-code-privacy", cwd: f.projects[0]!.path },
		{ type: "guard.refused", id: "private-code-1", timestamp: "2026-10-02T00:00:00Z", message: "private guard code", code: credential },
		{ type: "guard.refused", id: "private-code-2", timestamp: "2026-10-02T00:00:00Z", message: "private guard code", code: "api_key=fixture-private-credential" },
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(2);
	expect(f.findings[0]?.class_id).toStartWith("guard-friction:");
	expect(JSON.stringify(f.findings)).not.toContain(credential);
	expect(JSON.stringify(f.findings)).not.toContain("fixture-private-credential");
});

test("native diagnostic status does not masquerade as custody or a commit message", async () => {
	const f = fixture();
	f.put("jev", "replay-semantics-missing.jsonl", [
		{ type: "session", id: "replay-semantics-missing", cwd: f.projects[0]!.path },
		message("toolResult", "AssertionError: failure diagnostic is not a commit message", undefined, { toolCallId: "no-receipt", toolName: "bash", isError: true, details: { rc: 1, timed_out: false } }),
	]);
	await mineTranscripts(f.ctx);
	const replay = f.findings[0]?.replay;
	expect(replay?.custody).toBeNull();
	expect(replay?.message).toBeNull();
	expect(replay?.missing).toContain("custody");
	expect(replay?.missing).toContain("message");
	expect(f.findings[0]?.summary).toContain("failure diagnostic is not a commit message");
});

test("native replay retains only explicit custody receipts and actual input messages", async () => {
	const f = fixture();
	const receipt = { reservation_id: "owned-reservation", owner: "fixture-owner" };
	f.put("jev", "replay-semantics-explicit.jsonl", [
		{ type: "session", id: "replay-semantics-explicit", cwd: f.projects[0]!.path },
		{ type: "message", timestamp: "2026-10-02T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "root-receipt", name: "commit", arguments: { message: "fix: preserve real commit intent" } }] } },
		message("toolResult", "REFUSED: missing prerequisite", undefined, { toolCallId: "root-receipt", toolName: "commit", isError: true, custody: receipt }),
		{ type: "tool_execution_start", timestamp: "2026-10-02T00:00:00Z", toolCallId: "details-receipt", toolName: "commit", input: { message: "fix: preserve execution input intent" } },
		message("toolResult", "REFUSED: missing prerequisite", undefined, { toolCallId: "details-receipt", toolName: "commit", isError: true, details: { custody: receipt, rc: 1 } }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(2);
	expect(f.findings[0]?.replay?.message).toBe("fix: preserve real commit intent");
	expect(f.findings[1]?.replay?.message).toBe("fix: preserve execution input intent");
	for (const finding of f.findings) {
		expect(finding.replay?.custody).toEqual(receipt);
		expect(finding.replay?.missing).not.toContain("custody");
		expect(finding.replay?.missing).not.toContain("message");
	}
});

test("successful native grep and read keep root-shaped JSON failure quotations quiet", async () => {
	const f = fixture();
	const quoted = JSON.stringify({ isError: true, timed_out: true, message: "AssertionError: quoted" });
	const path = f.put("jev", "root-shaped-quotes.jsonl", [
		{ type: "session", id: "root-shaped-quotes", cwd: f.projects[0]!.path },
		message("toolResult", quoted, undefined, { toolCallId: "quote-grep", toolName: "grep", isError: false }),
		message("toolResult", quoted, undefined, { toolCallId: "quote-read", toolName: "read", isError: false }),
	]);
	await mineTranscripts(f.ctx);
	expect(f.findings).toHaveLength(0);
	expect(f.coverage.find(row => row.location === path)?.status).toBe("READ");
	expect(f.coverage.find(row => row.location === path)?.rows).toBe(2);
});
