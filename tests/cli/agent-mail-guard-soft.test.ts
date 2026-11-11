import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitAgentMailGuard, {
	AM_BODY_CAP,
	AM_INBOX_INTERVAL_MS,
	type AgentMailGuardApi,
	type AgentMailGuardDeps,
	type MailWakeHooks,
} from "../../extensions/kit-agent-mail-guard.ts";
import type { FlywheelContext, FlywheelExecOptions, FlywheelExecResult, FlywheelToolCallEvent, FlywheelToolCallResult } from "../../extensions/kit-flywheel-guard.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${freshSeq++}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

const base = ownedTmp("agent-mail-guard-soft").path;
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const MAIL = "xd://mcp__mcp_agent_mail_";
const BEAD = "ompkit-1ra0d";

interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;
type ToolHandler = (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown;
type ResultHandler = (event: { toolCallId?: unknown; content?: unknown; isError?: unknown }, ctx: FlywheelContext) => unknown;

interface GateNoticeRow { seat: string | null; act: string; target: string | null; gate: string; kind: string; repo?: string | null; detail?: string | null }

interface Host {
	call(event: FlywheelToolCallEvent, cwd: string, toolCallId?: string | null): Promise<FlywheelToolCallResult | undefined>;
	/** A `write` to xd://mcp__mcp_agent_mail_<tool>, the way OMP routes an MCP call. */
	mail(cwd: string, tool: string, args: unknown, toolCallId?: string | null): Promise<FlywheelToolCallResult | undefined>;
	execs: ExecCall[];
	notices: GateNoticeRow[];
}

type SubAgent = { kind: "sub"; id?: string; parentId?: string };

/** A wake that records every call and wakes nobody: the default, so guard tests never touch Tern. */
function recordingWake(block: string | null = null): MailWakeHooks & { before: unknown[][]; after: unknown[] } {
	const before: unknown[][] = [];
	const after: unknown[] = [];
	return {
		before, after,
		beforeSend: async (...args) => {
			before.push(args);
			return block === null ? undefined : { block: true, reason: block };
		},
		afterSend: async event => {
			after.push(event);
			return { content: [...(Array.isArray(event.content) ? event.content : []), { type: "text", text: `woke ${String(event.toolCallId)}` }] };
		},
	};
}

interface TestRosterRow { name: string; program: string; model: string; task_description: string; last_active_ts: string }

const mailRow = (name: string, over: Partial<TestRosterRow> = {}): TestRosterRow => ({
	name, program: "omp", model: "muse-spark", task_description: `${name} test assignment`,
	last_active_ts: "2026-10-19T08:00:00.000000Z", ...over,
});

const BACKEND = "/abs/path/backend";

const defaultRosters = (): Record<string, TestRosterRow[]> => ({
	[BACKEND]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")],
});

/**
 * Agent Mail answers for the guard's roster reads. Unknown project keys miss the way `am` does
 * (stderr, exit 1); the project list covers exactly the rostered keys. Anything else delegates to br.
 */
function fleetRespond(rosters: Record<string, TestRosterRow[]>, ...ids: string[]): Responder {
	const br = brKnows(...(ids.length > 0 ? ids : [BEAD]));
	const keys = Object.keys(rosters);
	return call => {
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "list") {
			const at = call.args.indexOf("-p");
			const key = at >= 0 ? (call.args[at + 1] ?? "") : "";
			const rows = rosters[key];
			if (rows === undefined) return { stdout: "", stderr: `Project '${key}' not found.`, code: 1 };
			return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
		}
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "show") {
			const at = call.args.indexOf("-p");
			const key = at >= 0 ? (call.args[at + 1] ?? "") : "";
			const name = at >= 0 ? (call.args[at + 2] ?? "") : "";
			const rows = rosters[key];
			if (rows === undefined) return { stdout: "", stderr: `Project '${key}' not found.`, code: 1 };
			const row = rows.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
			if (row) return { stdout: JSON.stringify({ ...row, id: 1, project_id: keys.indexOf(key) + 1 }), stderr: "", code: 0 };
			return { stdout: "", stderr: `error: whois via server failed: ${JSON.stringify({
				error: { type: "AGENT_NOT_FOUND", data: { agent_name: name, project: `project-${keys.indexOf(key) + 1}` } },
			})}`, code: 1 };
		}
		if (call.command === "am" && call.args[0] === "robot" && call.args[1] === "projects") {
			return {
				stdout: JSON.stringify({ projects: keys.map((key, index) => ({ slug: `project-${index + 1}`, path: key, agents: rosters[key]!.length })) }),
				stderr: "", code: 0,
			};
		}
		if (call.command === "am") return { stdout: "", stderr: "Unsupported Agent Mail fixture command", code: 1 };
		return br(call);
	};
}

/** Known beads answer `br show`; any other id misses the way br 0.7.4 does (JSON error on stdout, exit 3). */
function brKnows(...ids: string[]): Responder {
	return call => {
		// The guard also reads Agent Mail rosters; the stock backend roster answers those reads.
		if (call.command === "am") return fleetRespond(defaultRosters())(call);
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		const id = call.args[1] ?? "";
		if (call.command === "br" && call.args[0] === "show" && ids.includes(id)) {
			return { stdout: JSON.stringify([{ id, title: "t", status: "open", assignee: null }]), stderr: "", code: 0 };
		}
		return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }), stderr: "", code: 3 };
	};
}

async function createHost(deps: AgentMailGuardDeps & { sessionFile?: string; agent?: SubAgent } = {}, respond: Responder = brKnows(BEAD)): Promise<Host> {
	const handlers: ToolHandler[] = [];
	const execs: ExecCall[] = [];
	const notices: GateNoticeRow[] = [];
	let dispatch = 0;
	const pi: AgentMailGuardApi = {
		on: ((event: string, handler: ToolHandler & ResultHandler) => {
			if (event !== "tool_result") handlers.push(handler);
		}) as AgentMailGuardApi["on"],
		exec: async (command, args, options) => {
			const call = { command, args, options };
			execs.push(call);
			return respond(call);
		},
	};
	const env: Record<string, string | undefined> = { TMUX_PANE: "%9", ...(deps.env ?? { AGENT_NAME: "PlumRaven" }) };
	const home = deps.home ?? freshDir(base, "soft-home-");
	await kitAgentMailGuard(pi, {
		mailWake: recordingWake(),
		...deps,
		env, home,
		recordEvent: async row => { notices.push(row as unknown as GateNoticeRow); return { ok: true as const, path: "test-ledger" }; },
	});
	const call: Host["call"] = async (event, cwd, toolCallId) => {
		if (deps.home === undefined && env.AGENT_NAME && env.TMUX_PANE) {
			const identity = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
			mkdirSync(identity, { recursive: true });
			writeFileSync(join(identity, env.TMUX_PANE.slice(1)), JSON.stringify({ name: env.AGENT_NAME }));
		}
		const id = toolCallId === null ? undefined : toolCallId ?? `dispatch-${++dispatch}`;
		const ctx = { cwd, isIdle: () => true, sessionManager: { getSessionFile: () => deps.sessionFile }, ...(deps.agent ? { agent: deps.agent } : {}) };
		let result: unknown;
		for (const handler of handlers) result = (await handler({ type: "tool_call", ...event, toolCallId: id }, ctx)) ?? result;
		return result as FlywheelToolCallResult | undefined;
	};
	const mail: Host["mail"] = (cwd, tool, args, toolCallId) =>
		call({ toolName: "write", input: { path: `${MAIL}${tool}`, content: JSON.stringify(args) } }, cwd, toolCallId);
	return { call, mail, execs, notices };
}

/** The effective send arguments after the guard's input revision (write-form content), if any. */
function sentArgs(result: FlywheelToolCallResult | undefined): Record<string, unknown> | undefined {
	if (typeof result !== "object" || result === null || !("input" in result)) return undefined;
	const input = result.input;
	if (typeof input !== "object" || input === null || !("content" in input)) return undefined;
	const content = input.content;
	if (typeof content !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const record: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(parsed)) record[key] = value;
		return record;
	} catch {
		return undefined;
	}
}
function gitInit(parent: string): string {
	const cwd = freshDir(parent, "repo-");
	const git = runSync(["git", "init", "--quiet", cwd], { cwd: parent, deadline_s: fixtureDeadlineS(), max_output_bytes: 4096 });
	if (git.rc !== 0) throw new Error(new TextDecoder().decode(git.stderr));
	return cwd;
}

/** A repo that opted into the fleet (.omp/fleet.json). */
function fleetRepo(enabled = true): string {
	const cwd = gitInit(base);
	mkdirSync(join(cwd, ".omp"));
	writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled }));
	return cwd;
}

function overflowRoot(): string {
	const dir = freshDir(base, "overflow-");
	chmodSync(dir, 0o700);
	return dir;
}

/** The real JSON arguments of a valid send_message (field set from the tool's own schema). */
function send(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		project_key: "/abs/path/backend", sender_name: "PlumRaven", to: ["BlueLake"], cc: [],
		subject: `PROGRESS ${BEAD}: x`, body_md: "short body",
		importance: "normal", ack_required: false, thread_id: "ompkit-1ra0d", topic: "ompkit-1ra0d",
		idempotency_key: "ompkit-1ra0d-soft", ...over,
	};
}

function code(result: FlywheelToolCallResult | undefined): string | undefined {
	return result?.block === true ? /kit-agent-mail-guard (\w+):/.exec(result.reason ?? "")?.[1] : undefined;
}

const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };

// Built at run time so this file never holds a literal credential.
const secretName = ["GITHUB", "PAT"].join("_");
const secretValue = ["ghp1fake2abc", "3def4ghi5jkl6"].join("");

test("AMGUARDSOFT1 inbox: a fetch inside the window is admitted with its age and next allowed time", async () => {
	let clock = 1_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "fetch_inbox", fetch, "first")).toBeUndefined();
	clock += 30_000;
	const second = await h.mail(cwd, "fetch_inbox", fetch, "second");
	expect(code(second)).toBeUndefined();
	expect(second?.additionalContext).toContain("AM_INBOX_NOTICE");
	expect(second?.additionalContext).toContain("30 s ago");
	expect(second?.additionalContext).toContain("next fetch allowed in 30 s");
	expect(second?.additionalContext).toContain(new Date(1_000_000 + AM_INBOX_INTERVAL_MS).toISOString());
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_INBOX_NOTICE", kind: "notice", act: "fetch_inbox" });
	// Another agent (and another project) holds its own window: no nag for a first fetch.
	expect(await h.mail(cwd, "fetch_inbox", { ...fetch, agent_name: "BlueLake" }, "other-agent")).toBeUndefined();
	expect(await h.mail(cwd, "fetch_inbox", { ...fetch, project_key: "/abs/path/other" }, "other-project")).toBeUndefined();
	clock += AM_INBOX_INTERVAL_MS;
	expect(await h.mail(cwd, "fetch_inbox", fetch, "third")).toBeUndefined();
});

test("AMGUARDSOFT1 inbox: a since_ts newer than the last fetch passes without the nag", async () => {
	let clock = 2_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "fetch_inbox", fetch, "first")).toBeUndefined();
	clock += 10_000;
	// A bound past the last fetch is a genuinely new query, not a duplicate poll.
	expect(await h.mail(cwd, "fetch_inbox", { ...fetch, since_ts: 2_005_000 }, "bounded")).toBeUndefined();
	clock += 10_000;
	// An older bound is still a duplicate poll: admitted with the note.
	const noted = await h.mail(cwd, "fetch_inbox", { ...fetch, since_ts: 1_000_000 }, "stale-bound");
	expect(code(noted)).toBeUndefined();
	expect(noted?.additionalContext).toContain("AM_INBOX_NOTICE");
});

test("AMGUARDSOFT1 body: an over-cap send carries a truncated body plus a pointer while the full text stays reachable", async () => {
	const root = overflowRoot();
	const h = await createHost({ overflowRoot: root });
	const cwd = fleetRepo();
	const full = "n".repeat(AM_BODY_CAP * 4 + 100);
	const completed = await h.mail(cwd, "send_message", send({ body_md: full }), "over-cap");
	expect(code(completed)).toBeUndefined();
	expect(completed?.additionalContext).toContain("AM_BODY_NOTICE");
	const args = sentArgs(completed);
	if (args === undefined) throw new Error("expected an input revision carrying the truncated body");
	const body = args.body_md;
	if (typeof body !== "string") throw new Error("expected the revision to carry a truncated string body");
	expect(body.startsWith(full.slice(0, AM_BODY_CAP))).toBe(true);
	expect(body.length).toBeLessThan(full.length);
	const attachments = args.attachment_paths;
	if (!Array.isArray(attachments)) throw new Error("expected the revision to attach the overflow file");
	const path = attachments[0];
	if (typeof path !== "string") throw new Error("expected the attachment to name the overflow file");
	expect(path.startsWith(root)).toBe(true);
	expect(body).toContain(path);
	expect(readFileSync(path, "utf8")).toBe(full);
	expect(lstatSync(path).mode & 0o777).toBe(0o600);
	expect(lstatSync(root).mode & 0o777).toBe(0o700);
	// A reply completes the same way.
	const replied = await h.mail(cwd, "reply_message", {
		project_key: "/abs/path/backend", message_id: 7, sender_name: "PlumRaven", to: ["BlueLake"], body_md: "r".repeat(AM_BODY_CAP * 8),
	}, "over-cap-reply");
	expect(code(replied)).toBeUndefined();
	expect(replied?.additionalContext).toContain("AM_BODY_NOTICE");
	const replyAttachments = sentArgs(replied)?.attachment_paths;
	if (!Array.isArray(replyAttachments) || typeof replyAttachments[0] !== "string") throw new Error("expected the reply to attach the overflow file");
	expect(readFileSync(replyAttachments[0], "utf8")).toBe("r".repeat(AM_BODY_CAP * 8));
});

test("AMGUARDSOFT1 body: an over-cap body carrying a credential still refuses and stores nothing", async () => {
	const root = overflowRoot();
	const h = await createHost({ overflowRoot: root });
	const cwd = fleetRepo();
	const evil = `run: export ${secretName}=${secretValue}\n` + "x".repeat(AM_BODY_CAP * 4);
	const refused = await h.mail(cwd, "send_message", send({ body_md: evil }), "evil-over-cap");
	expect(code(refused)).toBe("AM_BODY_SECRET");
	expect(refused?.reason).not.toContain(secretValue);
	expect(readdirSync(root)).toEqual([]);
});

test("AMGUARDSOFT1 planted negative: the 0.2.118 refusal logic refuses the same calls", () => {
	// 0.2.118: AM_INBOX_RATE refused a fetch inside the 60 s window; AM_BODY_TOO_LONG refused a
	// body over four times the cap. The tests above prove the same calls now complete, so a
	// regression to this logic fails them.
	const oldRefusesFetch = (last: number, at: number): boolean => at - last < AM_INBOX_INTERVAL_MS;
	const oldRefusesBody = (length: number): boolean => length > AM_BODY_CAP * 4;
	expect(oldRefusesFetch(1_000_000, 1_030_000)).toBe(true);
	expect(oldRefusesBody(AM_BODY_CAP * 4 + 100)).toBe(true);
});
