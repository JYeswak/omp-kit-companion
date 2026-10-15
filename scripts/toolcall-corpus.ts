#!/usr/bin/env bun
/**
 * toolcall-corpus: local-only joined tool-call extractor over OMP session transcripts.
 *
 * Reads assistant toolCall blocks (bash, read, MCP, every other tool name) and joins
 * each call with its toolResult row by toolCallId. Emits one JSONL row per call with
 * tool name, args, timestamps, session/repo/agent attribution, and paired-result
 * provenance (is_error flag, output byte length and sha256; the session schema
 * records no numeric exit code, so exit is null rather than guessed).
 *
 * Privacy: raw result/output text and full args stay in the local JSONL output only.
 * Committed fixtures and bead evidence carry synthetic data, counts, and hashes;
 * never raw transcripts, mail bodies, credentials, or private path samples.
 *
 * Usage:
 *   bun scripts/toolcall-corpus.ts --sessions-root ABS_DIR --out ABS_FILE [--limit-files N] [--json]
 *
 * Exit codes: 0 ok; 1 usage or IO failure; 2 unknown session schema versions
 * (refuses with no partial output, matching the corpus harness contract).
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

type JsonValue = unknown;

interface PendingCall {
	toolCallId: string;
	tool: string;
	args: JsonValue;
	callTimestamp: string;
	startedAt: string | null;
	messageId: string;
}

interface OutputRow {
	sessionFile: string;
	sessionId: string;
	sessionTimestamp: string;
	repoCwd: string;
	agent: string;
	tool: string;
	toolCallId: string;
	callTimestamp: string;
	startedAt: string | null;
	args: JsonValue;
	result: {
		timestamp: string;
		isError: boolean;
		exit: null;
		outputBytes: number;
		outputSha256: string;
	} | null;
	resultMissing: boolean;
}

function flagValue(name: string): string | null {
	const index = process.argv.indexOf(name);
	if (index < 0 || index + 1 >= process.argv.length) return null;
	return process.argv[index + 1] ?? null;
}

function asRecord(value: JsonValue): Record<string, unknown> | null {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function asTimestamp(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function walkJsonl(root: string): string[] {
	const found: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let names: string[] = [];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = join(dir, name);
			try {
				const st = statSync(full);
				if (st.isDirectory()) stack.push(full);
				else if (st.isFile() && name.endsWith(".jsonl")) found.push(full);
			} catch {
				continue;
			}
		}
	}
	return found;
}

async function main(): Promise<void> {
	const sessionsRoot = flagValue("--sessions-root");
	const outFile = flagValue("--out");
	const limitRaw = flagValue("--limit-files");
	const wantJson = process.argv.includes("--json");
	if (!sessionsRoot || !isAbsolute(sessionsRoot)) {
		console.error("toolcall-corpus: --sessions-root ABS_DIR is required");
		process.exit(1);
		throw new Error("unreachable");
	}
	if (!outFile || !isAbsolute(outFile)) {
		console.error("toolcall-corpus: --out ABS_FILE is required");
		process.exit(1);
		throw new Error("unreachable");
	}
	const sessionsRootDir: string = sessionsRoot;
	const outPath: string = outFile;
	const limit = limitRaw === null ? 0 : Number(limitRaw);
	if (!Number.isSafeInteger(limit) || limit < 0) {
		console.error("toolcall-corpus: --limit-files must be a non-negative integer");
		process.exit(1);
		throw new Error("unreachable");
	}
	const rows: OutputRow[] = [];
	const perTool: Record<string, number> = {};
	const agents = new Set<string>();
	const sessionIds = new Set<string>();
	let files = 0;
	let calls = 0;
	let paired = 0;
	let parseErrors = 0;
	let malformed = 0;
	let unmatchedResults = 0;
	const unknownVersions = new Set<string>();

	const allFiles = walkJsonl(sessionsRootDir);
	const scanFiles = limit > 0 ? allFiles.slice(0, limit) : allFiles;
	for (const file of scanFiles) {
		files++;
		let sessionId: string | null = null;
		let sessionTimestamp: string | null = null;
		let repoCwd: string | null = null;
		let agent: string | null = null;
		const pending = new Map<string, PendingCall>();
		const fileRows: OutputRow[] = [];
		let streamOk = true;
		try {
			const stream = createReadStream(file, { encoding: "utf8" });
			const lines = createInterface({ input: stream, crlfDelay: Infinity });
			for await (const line of lines) {
				if (line.length === 0) continue;
				let entry: Record<string, unknown> | null = null;
				try {
					entry = asRecord(JSON.parse(line));
					if (entry === null) {
						parseErrors++;
						continue;
					}
				} catch {
					parseErrors++;
					continue;
				}
				if (typeof entry.version === "number") {
					if (entry.version !== 3) unknownVersions.add(`version:${entry.version}`);
					if (entry.type === "session") {
						if (typeof entry.id === "string" && entry.id.length > 0) sessionId = entry.id;
						const ts = asTimestamp(entry.timestamp);
						if (ts !== null) sessionTimestamp = ts;
						if (typeof entry.cwd === "string" && entry.cwd.length > 0) repoCwd = entry.cwd;
					}
					continue;
				}
				if (typeof entry.v === "number") {
					if (entry.v !== 1) unknownVersions.add(`v:${entry.v}`);
					continue;
				}
				if (entry.type === "custom" && entry.customType === "tool_execution_start") {
					const data = asRecord(entry.data);
					const callId = data !== null && typeof data.toolCallId === "string" ? data.toolCallId : null;
					const started = data !== null ? asTimestamp(data.startedAt) : null;
					if (callId !== null && started !== null) {
						const known = pending.get(callId);
						if (known !== undefined) known.startedAt = started;
					}
					continue;
				}
				const message = asRecord(entry.message);
				if (entry.type !== "message" || message === null) continue;
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const msgTs = asTimestamp(entry.timestamp) ?? asTimestamp(message.timestamp) ?? "unknown";
					const provider = typeof message.provider === "string" ? message.provider : null;
					const model = typeof message.model === "string" ? message.model : null;
					if (provider !== null || model !== null) {
						agent = `${provider ?? "unknown"}/${model ?? "unknown"}`;
					}
					for (const block of message.content) {
						const record = asRecord(block);
						if (record === null || record.type !== "toolCall") continue;
						const callId = typeof record.id === "string" ? record.id : null;
						const name = typeof record.name === "string" ? record.name : null;
						if (callId === null || name === null || callId.length === 0 || name.length === 0 || pending.has(callId)) {
							malformed++;
							continue;
						}
						pending.set(callId, {
							toolCallId: callId,
							tool: name,
							args: record.arguments ?? null,
							callTimestamp: msgTs,
							startedAt: null,
							messageId: typeof entry.id === "string" ? entry.id : "unknown",
						});
					}
					continue;
				}
				if (message.role === "toolResult") {
					const callId = typeof message.toolCallId === "string" ? message.toolCallId : null;
					const call = callId === null ? undefined : pending.get(callId);
					if (call === undefined) {
						unmatchedResults++;
						continue;
					}
					pending.delete(call.toolCallId);
					let output = "";
					if (Array.isArray(message.content)) {
						const parts: string[] = [];
						for (const block of message.content) {
							const record = asRecord(block);
							if (record !== null && record.type === "text" && typeof record.text === "string") {
								parts.push(record.text);
							}
						}
						output = parts.join("\n");
					}
					fileRows.push({
						sessionFile: file,
						sessionId: sessionId ?? "unknown",
						sessionTimestamp: sessionTimestamp ?? "unknown",
						repoCwd: repoCwd ?? "unknown",
						agent: agent ?? "unknown",
						tool: call.tool,
						toolCallId: call.toolCallId,
						callTimestamp: call.callTimestamp,
						startedAt: call.startedAt,
						args: call.args,
						result: {
							timestamp: asTimestamp(entry.timestamp) ?? asTimestamp(message.timestamp) ?? "unknown",
							isError: message.isError === true,
							exit: null,
							outputBytes: Buffer.byteLength(output, "utf8"),
							outputSha256: createHash("sha256").update(output, "utf8").digest("hex"),
						},
						resultMissing: false,
					});
					calls++;
					paired++;
					perTool[call.tool] = (perTool[call.tool] ?? 0) + 1;
				}
			}
		} catch {
			streamOk = false;
		}
		if (!streamOk) {
			parseErrors++;
			continue;
		}
		for (const call of pending.values()) {
			fileRows.push({
				sessionFile: file,
				sessionId: sessionId ?? "unknown",
				sessionTimestamp: sessionTimestamp ?? "unknown",
				repoCwd: repoCwd ?? "unknown",
				agent: agent ?? "unknown",
				tool: call.tool,
				toolCallId: call.toolCallId,
				callTimestamp: call.callTimestamp,
				startedAt: call.startedAt,
				args: call.args,
				result: null,
				resultMissing: true,
			});
			calls++;
			perTool[call.tool] = (perTool[call.tool] ?? 0) + 1;
		}
		for (const row of fileRows) {
			row.sessionId = sessionId ?? row.sessionId;
			row.sessionTimestamp = sessionTimestamp ?? row.sessionTimestamp;
			row.repoCwd = repoCwd ?? row.repoCwd;
			row.agent = agent ?? row.agent;
			rows.push(row);
			if (row.agent !== "unknown") agents.add(row.agent);
			if (row.sessionId !== "unknown") sessionIds.add(row.sessionId);
		}
	}

	if (unknownVersions.size > 0) {
		console.error(
			`toolcall-corpus: unknown session schema versions: ${[...unknownVersions].sort().join(", ")}; refusing with no partial output`,
		);
		process.exit(2);
	}

	mkdirSync(join(outPath, ".."), { recursive: true });
	writeFileSync(outPath, rows.map(row => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""), "utf8");

	if (wantJson) {
		console.log(JSON.stringify({
			ok: true,
			toolVersion: "0.2.38",
			data: {
				files,
				sessions: sessionIds.size,
				toolCalls: calls,
				paired,
				unpaired: calls - paired,
				perTool,
				distinctAgents: agents.size,
				parseErrors,
				malformedEvents: malformed,
				unmatchedResults,
			},
		}));
	}
}

await main();
