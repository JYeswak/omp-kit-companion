import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const scriptPath = join(repoRoot, "scripts", "toolcall-corpus.ts");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratchTmp = ownedTmp("toolcall-corpus", { root: scratchRoot });
const scratch = scratchTmp.path;
afterAll(() => scratchTmp.cleanup());
let fixtureNumber = 0;

function field(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value)) {
			if (k === key) return v;
		}
	}
	throw new Error(`missing field ${key}`);
}

function runExtractor(sessionsRoot: string, out: string): { status: number; stdout: string; summary: unknown } {
	const run = spawnSync("bun", [scriptPath, "--sessions-root", sessionsRoot, "--out", out, "--json"], { encoding: "utf8", timeout: 60_000 });
	let summary: unknown = null;
	try {
		summary = JSON.parse(run.stdout);
	} catch {
		summary = null;
	}
	return { status: run.status ?? 1, stdout: run.stdout, summary };
}

function rowsOf(out: string): unknown[] {
	return readFileSync(out, "utf8").trim().split("\n").filter(line => line.length > 0).map(line => JSON.parse(line));
}

function writeSession(dir: string, name: string, lines: string[]): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_TS = "2026-10-01T00:00:00.000Z";
const SESSION_CWD = "/Users/josh/Developer/fixture-repo";
const AGENT = "muse-code/muse-spark-1.3-contributor";

function sessionRow(): string {
	return JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: SESSION_TS, cwd: SESSION_CWD });
}

function assistantRow(id: string, content: unknown[], provider = "muse-code", model = "muse-spark-1.3-contributor"): string {
	return JSON.stringify({
		type: "message", id, parentId: "parent", timestamp: 1000,
		message: { role: "assistant", content, provider, model },
	});
}

function callBlock(callId: string, name: string, args: unknown): unknown {
	return { type: "toolCall", id: callId, name, arguments: args };
}

function resultRow(callId: string, toolName: string, text: string): string {
	return JSON.stringify({
		type: "message", id: `result-${callId}`, parentId: "parent", timestamp: 1002,
		message: {
			role: "toolResult", toolCallId: callId, toolName, timestamp: 1002, isError: false,
			content: [{ type: "text", text }], details: {},
		},
	});
}

test("extracts bash, read, and MCP calls with paired results and full attribution", () => {
	const id = fixtureNumber++;
	const dir = join(scratch, `sessions-${id}`, "sess-1");
	const lines = [
		sessionRow(),
		assistantRow("m1", [callBlock("c-bash", "bash", { command: "git status" })]),
		JSON.stringify({
			type: "custom", customType: "tool_execution_start",
			data: { toolCallId: "c-bash", toolName: "bash", startedAt: "2026-10-01T00:00:01.000Z", args: { command: "git status" } },
			id: "start-c-bash", parentId: "parent", timestamp: 1001,
		}),
		resultRow("c-bash", "bash", "On branch main\nnothing to commit"),
		assistantRow("m2", [callBlock("c-read", "read", { i: "x", path: "src/a.ts" })]),
		resultRow("c-read", "read", "const a = 1;\n"),
		assistantRow("m3", [callBlock("c-rea", "mcp__rea_open_binary", { path: "app.bin" })]),
		resultRow("c-rea", "mcp__rea_open_binary", "binary overview ok"),
		assistantRow("m4", [callBlock("c-mail", "mcp__mcp_agent_mail_send_message", { to: ["BlueLake"], body_md: "hi" })]),
		resultRow("c-mail", "mcp__mcp_agent_mail_send_message", "delivered"),
		assistantRow("m5", [{ type: "text", text: "I could read the file or send_message someone, but first imply toolCall shapes" }]),
		assistantRow("m6", [callBlock("c-lonely", "bash", { command: "echo hi" })]),
	];
	writeSession(dir, "sess.jsonl", lines);
	const root = join(scratch, `sessions-${id}`);
	const out = join(scratch, `rows-${id}.jsonl`);
	const run = runExtractor(root, out);
	expect(run.status).toBe(0);
	expect(field(field(run.summary, "data"), "toolCalls")).toBe(5);
	expect(field(field(run.summary, "data"), "paired")).toBe(4);
	const rows = rowsOf(out);
	expect(rows.length).toBe(5);
	const byTool: Record<string, unknown[]> = {};
	for (const row of rows) {
		const tool = String(field(row, "tool"));
		if (byTool[tool] === undefined) byTool[tool] = [];
		(byTool[tool] as unknown[]).push(row);
	}
	expect(Object.keys(byTool).sort()).toEqual(["bash", "mcp__mcp_agent_mail_send_message", "mcp__rea_open_binary", "read"]);
	const bashRows = (byTool["bash"] ?? []).filter(row => field(row, "toolCallId") === "c-bash");
	expect(bashRows.length).toBe(1);
	const bash = bashRows[0];
	expect(field(field(bash, "args"), "command")).toBe("git status");
	expect(field(bash, "sessionId")).toBe(SESSION_ID);
	expect(field(bash, "repoCwd")).toBe(SESSION_CWD);
	expect(field(bash, "agent")).toBe(AGENT);
	expect(field(bash, "startedAt")).toBe("2026-10-01T00:00:01.000Z");
	const result = field(bash, "result");
	expect(field(result, "isError")).toBe(false);
	expect(field(result, "exit")).toBe(null);
	expect(field(result, "outputSha256")).toBe(createHash("sha256").update("On branch main\nnothing to commit", "utf8").digest("hex"));
	const readRows = byTool["read"] ?? [];
	expect(readRows.length).toBe(1);
	expect(field(field(readRows[0], "args"), "path")).toBe("src/a.ts");
	expect(field(readRows[0], "sessionTimestamp")).toBe(SESSION_TS);
	const mailRows = byTool["mcp__mcp_agent_mail_send_message"] ?? [];
	expect(mailRows.length).toBe(1);
	expect(field(field(mailRows[0], "args"), "to")).toEqual(["BlueLake"]);
	const lonely = rows.filter(row => field(row, "toolCallId") === "c-lonely");
	expect(lonely.length).toBe(1);
	expect(field(lonely[0], "resultMissing")).toBe(true);
	expect(field(lonely[0], "result")).toBe(null);
});

test("prose mentioning tools without a toolCall emits no rows, and empty queries need a passing control", () => {
	const id = fixtureNumber++;
	const dir = join(scratch, `sessions-${id}`, "sess-1");
	const lines = [
		sessionRow(),
		assistantRow("m1", [callBlock("c-mail", "mcp__mcp_agent_mail_send_message", { to: ["BlueLake"], body_md: "hi" })]),
		resultRow("c-mail", "mcp__mcp_agent_mail_send_message", "delivered"),
		assistantRow("m2", [{ type: "text", text: "discussing read and send_message and nm with no tool call at all" }]),
	];
	writeSession(dir, "sess.jsonl", lines);
	const root = join(scratch, `sessions-${id}`);
	const out = join(scratch, `rows-${id}.jsonl`);
	const run = runExtractor(root, out);
	expect(run.status).toBe(0);
	const rows = rowsOf(out);
	expect(rows.length).toBe(1);
	expect(field(rows[0], "tool")).toBe("mcp__mcp_agent_mail_send_message");
	expect(rows.filter(row => field(row, "tool") === "send_message")).toEqual([]);
	expect(rows.filter(row => field(row, "tool") === "mcp__rea_does_not_exist")).toEqual([]);
});

test("malformed events are counted as limitations, never coerced", () => {
	const id = fixtureNumber++;
	const dir = join(scratch, `sessions-${id}`, "sess-1");
	const lines = [
		sessionRow(),
		"{not valid json",
		assistantRow("m1", [{ type: "toolCall", name: "bash", arguments: { command: "x" } }]),
		assistantRow("m2", [{ type: "toolCall", id: "c-ok", name: "bash", arguments: { command: "y" } }]),
		resultRow("c-ok", "bash", "out"),
		JSON.stringify({ type: "message", id: "r-orphan", parentId: "p", timestamp: 3, message: { role: "toolResult", toolCallId: "c-ghost", toolName: "bash", content: [{ type: "text", text: "orphan" }], details: {} } }),
	];
	writeSession(dir, "sess.jsonl", lines);
	const root = join(scratch, `sessions-${id}`);
	const out = join(scratch, `rows-${id}.jsonl`);
	const run = runExtractor(root, out);
	expect(run.status).toBe(0);
	const data = field(run.summary, "data");
	expect(field(data, "parseErrors")).toBe(1);
	expect(field(data, "malformedEvents")).toBe(1);
	expect(field(data, "unmatchedResults")).toBe(1);
	const rows = rowsOf(out);
	expect(rows.length).toBe(1);
	expect(field(rows[0], "toolCallId")).toBe("c-ok");
});

test("unknown session schema versions refuse with no partial output", () => {
	const id = fixtureNumber++;
	const dir = join(scratch, `sessions-${id}`, "sess-1");
	writeSession(dir, "sess.jsonl", [
		JSON.stringify({ type: "session", version: 99, id: "s", timestamp: SESSION_TS, cwd: SESSION_CWD }),
	]);
	const root = join(scratch, `sessions-${id}`);
	const out = join(scratch, `rows-${id}.jsonl`);
	const run = runExtractor(root, out);
	expect(run.status).toBe(2);
	let exists = false;
	try {
		readFileSync(out);
		exists = true;
	} catch {
		exists = false;
	}
	expect(exists).toBe(false);
});

test("bash subset matches the producer baseline on identical roots", () => {
	const id = fixtureNumber++;
	const dir = join(scratch, `sessions-${id}`, "sess-1");
	const lines = [
		sessionRow(),
		assistantRow("m1", [callBlock("c-1", "bash", { command: "git status" })]),
		resultRow("c-1", "bash", "clean"),
		assistantRow("m2", [callBlock("c-2", "bash", { command: "nm libx.dylib" })]),
		resultRow("c-2", "bash", "symbols"),
		assistantRow("m3", [callBlock("c-3", "read", { i: "x", path: "src/a.ts" })]),
		resultRow("c-3", "read", "code"),
	];
	writeSession(dir, "sess.jsonl", lines);
	const root = join(scratch, `sessions-${id}`);
	const out = join(scratch, `rows-${id}.jsonl`);
	const run = runExtractor(root, out);
	expect(run.status).toBe(0);
	const mine = rowsOf(out).filter(row => field(row, "tool") === "bash").length;
	expect(mine).toBe(2);
	// Use the exact producer delegated to by the packaged CLI, not an ambient installed kit.
	const baseline = spawnSync(process.execPath, [
		join(repoRoot, "scripts", "ttsr-harness.ts"), "--corpus", "--sessions-root", root,
		"--out", join(scratch, `baseline-${id}.tsv`),
	], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
	expect(baseline.status, baseline.stderr || baseline.error?.message).toBe(0);
	const summary = baseline.stdout.split("\n").find(line => line.startsWith("corpus: files="));
	if (!summary) throw new Error(`Corpus producer printed no summary: ${baseline.stdout}`);
	const eventsJson = summary.split(" events=")[1]?.split(" secs=")[0];
	if (!eventsJson) throw new Error(`Corpus producer summary has no event counts: ${summary}`);
	const events: unknown = JSON.parse(eventsJson);
	expect(field(events, "bash")).toBe(mine);
});
