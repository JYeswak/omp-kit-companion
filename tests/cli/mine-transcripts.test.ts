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
	expect(f.findings.map(row => row.class_id).sort()).toEqual(["commit-refusal:MEMBER_REFUSED", "guard-refusal:reservation", "timeout:bash", "tool-error:edit", "user-correction"].sort());
	expect(f.findings.find(row => row.class_id === "timeout:bash")?.measured_minutes).toBe(2);
	expect(f.findings.find(row => row.class_id === "tool-error:edit")?.measured_minutes).toBeNull();
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
