import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitAgentMailGuard, {
	ACK_VOCABULARY,
	AM_BODY_CAP,
	AM_INBOX_INTERVAL_MS,
	ruleConditions,
	SUBJECT_VOCABULARY,
	subjectLead,
	type AgentMailGuardApi,
	type AgentMailGuardDeps,
	type MailWakeHooks,
} from "./kit-agent-mail-guard";
import type { FlywheelContext, FlywheelExecOptions, FlywheelExecResult, FlywheelToolCallEvent, FlywheelToolCallResult } from "./kit-flywheel-guard";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { run } from "../src/kitlib/run.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = ownedTmp("kit-agent-mail-guard").path;
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const MAIL = "xd://mcp__mcp_agent_mail_";
const BEAD = "ompkit-1abc";

interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;
type ToolHandler = (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown;
type ResultHandler = (event: { toolCallId?: unknown; content?: unknown; isError?: unknown }, ctx: FlywheelContext) => unknown;

interface GateNoticeRow { seat: string | null; act: string; target: string | null; gate: string; kind: string; repo?: string | null; detail?: string | null }

interface Host {
	call(event: FlywheelToolCallEvent, cwd: string, toolCallId?: string | null): Promise<FlywheelToolCallResult | undefined>;
	/** A `write` to xd://mcp__mcp_agent_mail_<tool>, the way OMP routes an MCP call. */
	mail(cwd: string, tool: string, args: unknown, toolCallId?: string | null): Promise<FlywheelToolCallResult | undefined>;
	/** OMP's tool_result for one call, through every registered tool_result handler. */
	result(cwd: string, toolCallId: string, content: unknown[], isError?: boolean): Promise<unknown>;
	execs: ExecCall[];
	/** gate-events rows the guard wrote for admitted-with-notice acts (kind notice, never refuse). */
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

const PUBLISHED_TEST_SHA = "1234567";
/** Known beads answer `br show`; any other id misses the way br 0.7.4 does (JSON error on stdout, exit 3). */
function brKnows(...ids: string[]): Responder {
	return call => {
		// The guard also reads Agent Mail rosters; the stock backend roster answers those reads.
		if (call.command === "am") return fleetRespond(defaultRosters())(call);
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.command === "git") {
			const operation = call.args[call.args[0] === "-C" ? 2 : 0];
			if (operation === "fetch" || operation === "merge-base") return { stdout: "", stderr: "", code: 0 };
			if (operation === "rev-parse") return { stdout: `${PUBLISHED_TEST_SHA}\n`, stderr: "", code: 0 };
		}
		const id = call.args[1] ?? "";
		if (call.command === "br" && call.args[0] === "show" && ids.includes(id)) {
			return { stdout: JSON.stringify([{ id, title: "t", status: "open", assignee: null }]), stderr: "", code: 0 };
		}
		return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }), stderr: "", code: 3 };
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

async function createHost(deps: AgentMailGuardDeps & { sessionFile?: string; agent?: SubAgent } = {}, respond: Responder = brKnows(BEAD)): Promise<Host> {
	const handlers: ToolHandler[] = [];
	const resultHandlers: ResultHandler[] = [];
	const execs: ExecCall[] = [];
	const notices: GateNoticeRow[] = [];
	let dispatch = 0;
	const pi: AgentMailGuardApi = {
		on: ((event: string, handler: ToolHandler & ResultHandler) => {
			if (event === "tool_result") resultHandlers.push(handler);
			else handlers.push(handler);
		}) as AgentMailGuardApi["on"],
		exec: async (command, args, options) => {
			const call = { command, args, options };
			execs.push(call);
			return respond(call);
		},
	};
	const env: Record<string, string | undefined> = { TMUX_PANE: "%9", ...(deps.env ?? { AGENT_NAME: "PlumRaven" }) };
	const home = deps.home ?? freshDir(base, "bound-sender-");
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
	const result: Host["result"] = async (cwd, toolCallId, content, isError = false) => {
		const ctx: FlywheelContext = { cwd, isIdle: () => true };
		let patched: unknown;
		for (const handler of resultHandlers) patched = (await handler({ toolCallId, content, isError }, ctx)) ?? patched;
		return patched;
	};
	return { call, mail, result, execs, notices };
}
test("reads: outer write and mounted fetch share one accepted logical call ID", async () => {
	let clock = 1_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	const id = "omp-logical-fetch";
	expect(await h.mail(cwd, "fetch_inbox", fetch, id)).toBeUndefined();
	expect(await h.call({ toolName: "mcp__mcp_agent_mail_fetch_inbox", input: fetch }, cwd, id)).toBeUndefined();
	// MAILGUARDSLIM1: a second fetch inside the window is admitted with a notice, not refused.
	const noticed = await h.mail(cwd, "fetch_inbox", fetch, "distinct-fetch");
	expect(code(noticed)).toBeUndefined();
	expect(noticed?.additionalContext).toContain("AM_INBOX_NOTICE");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_INBOX_NOTICE", kind: "notice" });
	clock += AM_INBOX_INTERVAL_MS - 1;
	expect((await h.mail(cwd, "fetch_inbox", fetch, "distinct-fetch-2"))?.additionalContext).toContain("AM_INBOX_NOTICE");
	clock += AM_INBOX_INTERVAL_MS;
	expect(await h.mail(cwd, "fetch_inbox", fetch, "distinct-fetch-3")).toBeUndefined();
});
test("reads: delayed nested reentry does not restart the accepted logical call window", async () => {
	let clock = 1_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	expect(await h.mail(cwd, "fetch_inbox", fetch, "original")).toBeUndefined();
	clock += AM_INBOX_INTERVAL_MS;
	expect(await h.call({ toolName: "mcp__mcp_agent_mail_fetch_inbox", input: fetch }, cwd, "original")).toBeUndefined();
	expect(await h.mail(cwd, "fetch_inbox", fetch, "next")).toBeUndefined();
	expect((await h.mail(cwd, "fetch_inbox", fetch, "distinct"))?.additionalContext).toContain("AM_INBOX_NOTICE");
});
test("reads: missing and empty toolCallIds do not exempt distinct fetches", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	expect(await h.mail(cwd, "fetch_inbox", fetch, null)).toBeUndefined();
	expect((await h.mail(cwd, "fetch_inbox", fetch, ""))?.additionalContext).toContain("AM_INBOX_NOTICE");
	expect((await h.mail(cwd, "fetch_inbox", fetch, null))?.additionalContext).toContain("AM_INBOX_NOTICE");
});

function gitInit(parent: string): string {
	const cwd = freshDir(parent, "repo-");
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
	return cwd;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
	const result = await run(["git", "-C", cwd, ...args], { cwd, deadline_s: 60, max_output_bytes: 16 * 1024 });
	const stdout = new TextDecoder().decode(result.stdout).trim();
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} -> ${result.rc}: ${new TextDecoder().decode(result.stderr)}`);
	return stdout;
}

/** A repo that opted into the fleet (.omp/fleet.json). */
function fleetRepo(enabled = true): string {
	const cwd = gitInit(base);
	mkdirSync(join(cwd, ".omp"));
	writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled }));
	return cwd;
}

const stockRepo = (): string => gitInit(base);

/** The real JSON arguments of a valid send_message (field set from the tool's own schema). */
function send(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		project_key: "/abs/path/backend", sender_name: "PlumRaven", to: ["BlueLake"], cc: ["RedCat"],
		subject: `DONE ${BEAD}: landed`, body_md: `commit ${PUBLISHED_TEST_SHA}; landed; evidence is in the bead comment.`,
		importance: "normal", ack_required: false, thread_id: "ompkit-1abc", topic: "ompkit-1abc",
		idempotency_key: "ompkit-1abc-done", ...over,
	};
}

function reply(over: Record<string, unknown> = {}): Record<string, unknown> {
	return { project_key: "/abs/path/backend", message_id: 1234, sender_name: "PlumRaven", body_md: "Done; see the bead.", to: ["BlueLake"], subject_prefix: "Re:", ...over };
}

function code(result: FlywheelToolCallResult | undefined): string | undefined {
	return result?.block === true ? /kit-agent-mail-guard (\w+):/.exec(result.reason ?? "")?.[1] : undefined;
}

// --- inert without the fleet opt-in ---------------------------------------------------------

test("opt-in: a stock repo is untouched, the same impersonating send in a fleet repo is refused", async () => {
	const h = await createHost();
	const impersonation = send({ sender_name: "BlueLake" });
	const stock = stockRepo();
	expect(await h.mail(stock, "send_message", impersonation)).toBeUndefined();
	expect(await h.mail(stock, "mark_all_read", { project_key: "p", agent_name: "PlumRaven" })).toBeUndefined();
	expect(await h.mail(stock, "fetch_inbox", { project_key: "p", agent_name: "PlumRaven" })).toBeUndefined();
	expect(h.execs).toEqual([]);
	expect(code(await h.mail(fleetRepo(), "send_message", impersonation))).toBe("AM_IDENTITY_MISMATCH");
});


// MAILWAKE1.2 (ompkit-uk9wn.2): the chief tab runs in a directory with no fleet opt-in, so its sends bypassed every
// check and the wake. A send is guarded by the RECIPIENT repo's policy (project_key) when the sender's cwd has none.
test("opt-in: a send from a non-fleet cwd addressed to a fleet repo is guarded; planted: a non-fleet project_key stays inert", async () => {
	const h = await createHost();
	const impersonation = send({ sender_name: "BlueLake", project_key: fleetRepo() });
	expect(code(await h.mail(stockRepo(), "send_message", impersonation))).toBe("AM_IDENTITY_MISMATCH");
	expect(await h.mail(stockRepo(), "send_message", send({ sender_name: "BlueLake", project_key: stockRepo() }))).toBeUndefined();
	// a bulk read from a non-fleet cwd is still inert: only sends and replies read the recipient's policy
	expect(await h.mail(stockRepo(), "mark_all_read", { project_key: fleetRepo(), agent_name: "PlumRaven" })).toBeUndefined();
});
test("opt-in: fleet.json enabled:false is inert; an unreadable marker refuses", async () => {
	const h = await createHost();
	const impersonation = send({ sender_name: "BlueLake" });
	expect(await h.mail(fleetRepo(false), "send_message", impersonation)).toBeUndefined();
	const broken = gitInit(base);
	mkdirSync(join(broken, ".omp"));
	writeFileSync(join(broken, ".omp", "fleet.json"), "{not json");
	expect(code(await h.mail(broken, "send_message", send()))).toBe("AM_FLEET_POLICY");
});

// --- identity --------------------------------------------------------------------------------

test("identity: sender_name must be the seat's AGENT_NAME", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send())).toBeUndefined();
	const refused = await h.mail(cwd, "send_message", send({ sender_name: "BlueLake" }));
	expect(code(refused)).toBe("AM_IDENTITY_MISMATCH");
	expect(refused?.reason).toContain("PlumRaven");
	expect(code(await h.mail(cwd, "send_message", send({ sender_name: undefined })))).toBe("AM_IDENTITY_MISMATCH");
	// The server resolves names case-insensitively; the same agent in another case is not an impersonation.
	expect(await h.mail(cwd, "send_message", send({ sender_name: "plumraven" }))).toBeUndefined();
});

test("identity: reply_message is held to the same name", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "reply_message", reply())).toBeUndefined();
	expect(code(await h.mail(cwd, "reply_message", reply({ sender_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
});

test("identity: with no AGENT_NAME the Agent Mail pane identity names the seat; with neither, sending is refused", async () => {
	const cwd = fleetRepo();
	const home = freshDir(base, "home-");
	const dir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "7"), JSON.stringify({ name: "RedCat" }));
	const paned = await createHost({ env: { TMUX_PANE: "%7" }, home });
	expect(await paned.mail(cwd, "send_message", send({ sender_name: "RedCat" }))).toBeUndefined();
	expect(code(await paned.mail(cwd, "send_message", send({ sender_name: "PlumRaven" })))).toBe("AM_IDENTITY_MISMATCH");
	const anonymous = await createHost({ env: {}, home });
	expect(code(await anonymous.mail(cwd, "send_message", send({ sender_name: "RedCat" })))).toBe("IDENTITY_UNBOUND");
});

// --- AMRENEW1 (ompkit-jyxx5) --------------------------------------------------------------------------
// The reservation tools and the reservation macro carry the caller as agent_name; their schemas have
// no sender_name, so judging them by sender_name refused a seat's own renew/reserve/release.

const reserveArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	project_key: "/abs/path/backend", agent_name: "PlumRaven", paths: [".beads/issues.jsonl"], exclusive: true, ttl_seconds: 1800, ...over,
});

const renewArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	project_key: "/abs/path/backend", agent_name: "PlumRaven", extend_seconds: 3600, file_reservation_ids: [171565], ...over,
});

const releaseArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	project_key: "/abs/path/backend", agent_name: "PlumRaven", file_reservation_ids: [171565], ...over,
});

const reservationCycleArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	project_key: "/abs/path/backend", agent_name: "PlumRaven", paths: [".beads/issues.jsonl"], exclusive: true, ttl_seconds: 1800, ...over,
});

test("AMRENEW1: a seat's own reserve, renew, release and reservation cycle pass", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "file_reservation_paths", reserveArgs())).toBeUndefined();
	expect(await h.mail(cwd, "renew_file_reservations", renewArgs())).toBeUndefined();
	expect(await h.mail(cwd, "release_file_reservations", releaseArgs())).toBeUndefined();
	expect(await h.mail(cwd, "macro_file_reservation_cycle", reservationCycleArgs())).toBeUndefined();
	// The direct mounted-tool form carries the same identity field.
	expect(await h.call({ toolName: "mcp__mcp_agent_mail_renew_file_reservations", input: renewArgs() }, cwd)).toBeUndefined();
	// Planted negative: the same calls under another seat's name are refused, so a mutant that
	// always passes cannot survive this file.
	expect(code(await h.mail(cwd, "file_reservation_paths", reserveArgs({ agent_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "renew_file_reservations", renewArgs({ agent_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "release_file_reservations", releaseArgs({ agent_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "macro_file_reservation_cycle", reservationCycleArgs({ agent_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
});

test("AMRENEW1: another seat's name in agent_name is refused AM_IDENTITY_MISMATCH", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const calls: Array<[string, Record<string, unknown>]> = [
		["file_reservation_paths", reserveArgs()],
		["renew_file_reservations", renewArgs()],
		["release_file_reservations", releaseArgs()],
		["macro_file_reservation_cycle", reservationCycleArgs()],
	];
	for (const [tool, args] of calls) {
		const refused = await h.mail(cwd, tool, { ...args, agent_name: "BlueLake" });
		expect(code(refused)).toBe("AM_IDENTITY_MISMATCH");
		expect(refused?.reason).toContain("agent_name");
		// Planted negative: the seat's own name passes, so a mutant that always refuses dies here.
		expect(await h.mail(cwd, tool, args)).toBeUndefined();
	}
});

test("AMRENEW1: a missing agent_name is refused naming agent_name, never as impersonation", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const calls: Array<[string, Record<string, unknown>]> = [
		["file_reservation_paths", reserveArgs()],
		["renew_file_reservations", renewArgs()],
		["release_file_reservations", releaseArgs()],
		["macro_file_reservation_cycle", reservationCycleArgs()],
	];
	for (const [tool, args] of calls) {
		const bare: Record<string, unknown> = { ...args };
		delete bare.agent_name;
		const refused = await h.mail(cwd, tool, bare);
		expect(refused?.block).toBe(true);
		const reason = refused?.reason ?? "";
		expect(reason).toContain("agent_name");
		// Planted negatives: the refusal names the field this tool really has (agent_name, which
		// the call omits too) and never reads as the impersonation charge the bug produced.
		expect(reason).not.toContain("sender_name");
		expect(reason).not.toMatch(/another agent|impersonat/i);
	}
});

// --- subject vocabulary ------------------------------------------------------------------------

test("subject: every vocabulary word passes; free text and near misses are admitted with a notice", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	for (const word of Object.keys(SUBJECT_VOCABULARY)) {
		expect(await h.mail(cwd, "send_message", send({ subject: `${word} ${BEAD}: x` }))).toBeUndefined();
		expect(subjectLead(`${word}: x`)).toBe(word);
	}
	for (const subject of ["Plan for /api/users", "", "done ompkit-1abc: x", "DONEZO ompkit-1abc", "DONE-ish ompkit-1abc", " DONE ompkit-1abc", "[DONE] ompkit-1abc"]) {
		// MAILGUARDSLIM1: a non-vocabulary subject is sent with a notice, never refused.
		const admitted = await h.mail(cwd, "send_message", send({ subject }));
		expect(code(admitted)).toBeUndefined();
		expect(admitted?.additionalContext).toContain("AM_SUBJECT_NOTICE");
	}
	expect((await h.mail(cwd, "send_message", send({ subject: undefined })))?.additionalContext).toContain("AM_SUBJECT_NOTICE");
	expect(h.notices.filter(row => row.gate === "AM_SUBJECT_NOTICE").every(row => row.kind === "notice")).toBe(true);
});

// --- obligations ---------------------------------------------------------------------------------

test("ack_required: a typed subject naming a resolvable bead passes; the bead is resolved natively in the repo", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	for (const word of Object.keys(ACK_VOCABULARY)) {
		expect(await h.mail(cwd, "send_message", send({ subject: `${word} ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
	}
	const show = h.execs.filter(call => call.command === "br");
	expect(show.length).toBe(Object.keys(ACK_VOCABULARY).length);
	expect(show[0]?.args.slice(0, 3)).toEqual(["show", BEAD, "--json"]);
	expect(show[0]?.options?.cwd).toBe(cwd);
});

test("ack_required: an in-vocabulary but non-ask subject is dropped with a notice, the same send without ack passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ subject: `DONE ${BEAD}: x`, ack_required: false }))).toBeUndefined();
	// MAILGUARDSLIM1: ack_required is dropped by rewriteArgs and the send proceeds with a notice.
	for (const subject of [`DONE ${BEAD}: x`, `PROGRESS ${BEAD}: x`]) {
		const admitted = await h.mail(cwd, "send_message", send({ subject, ack_required: true }));
		expect(code(admitted)).toBeUndefined();
		expect(admitted?.additionalContext).toContain("AM_ACK_NOTICE");
		expect(stampedArgs(admitted)).not.toHaveProperty("ack_required");
		expect(h.notices.at(-1)).toMatchObject({ gate: "AM_ACK_NOTICE", kind: "notice" });
	}
	const droppedString = await h.mail(cwd, "send_message", send({ subject: `PROGRESS ${BEAD}: x`, ack_required: "true" }));
	expect(stampedArgs(droppedString)).not.toHaveProperty("ack_required");
	expect(h.execs.filter(call => call.command === "br")).toEqual([]);
});

test("ack_required: a typed subject with no bead id, or an id the tracker does not resolve, is sent with ack kept and a notice", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ subject: `QUESTION ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
	// MAILGUARDSLIM1: sent with ack kept; the notice asks for the bead id next time.
	const missing = await h.mail(cwd, "send_message", send({ subject: "QUESTION which database?", ack_required: true }));
	expect(code(missing)).toBeUndefined();
	expect(missing?.additionalContext).toContain("AM_ACK_BEAD_NOTICE");
	const unresolved = await h.mail(cwd, "send_message", send({ subject: "QUESTION ompkit-zzzz: which?", ack_required: true }));
	expect(code(unresolved)).toBeUndefined();
	expect(unresolved?.additionalContext).toContain("AM_ACK_BEAD_NOTICE");
	expect(unresolved?.additionalContext).toContain("Issue not found");
	expect(unresolved).not.toHaveProperty("input");
	// A word that merely looks like an id does not stop a real id later in the subject from resolving.
	expect(await h.mail(cwd, "send_message", send({ subject: `QUESTION re-run ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
});
test("ack_required: the bead resolves in the project_key repo's tracker, not the sender's cwd (AMACKPROJECT1)", async () => {
	const cwd = fleetRepo(), recipient = fleetRepo();
	mkdirSync(join(recipient, ".beads"));
	const h = await createHost({}, fleetRespond({ ...defaultRosters(), [recipient]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")] }));
	expect(await h.mail(cwd, "send_message", send({ project_key: recipient, subject: `QUESTION ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
	expect(h.execs.filter(call => call.command === "br").at(-1)?.options?.cwd).toBe(recipient);
	const unknown = await h.mail(cwd, "send_message", send({ project_key: recipient, subject: "QUESTION ompkit-zzzz: which?", ack_required: true }));
	expect(code(unknown)).toBeUndefined();
	expect(unknown?.additionalContext).toContain("AM_ACK_BEAD_NOTICE");
	expect(unknown?.additionalContext).toContain(`tracker at ${recipient}`);
	// A project_key with no tracker on this host keeps the cwd fallback.
	expect(await h.mail(cwd, "send_message", send({ subject: `QUESTION ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
	expect(h.execs.filter(call => call.command === "br").at(-1)?.options?.cwd).toBe(cwd);
});

test("ack_required: an unreadable tracker is sent with a notice, not failed closed", async () => {
	const cwd = fleetRepo();
	const subject = `BLOCKED ${BEAD}: need a decision`;
	const down: Responder[] = [
		() => ({ stdout: "", stderr: "br: command not found", code: 127 }),
		() => { throw new Error("spawn br ENOENT"); },
		() => ({ stdout: "not json", stderr: "", code: 0 }),
	];
	// A `br` outage only: the roster reads stay up, so status mail still flows and asks are sent
	// with ack kept and a notice asking for the bead id next time.
	const mailUp = fleetRespond(defaultRosters());
	for (const respond of down) {
		const brOutage: Responder = call => call.command === "am" ? mailUp(call) : call.command === "git" ? brKnows()(call) : respond(call);
		const h = await createHost({}, brOutage);
		const admitted = await h.mail(cwd, "send_message", send({ subject, ack_required: true }));
		expect(code(admitted)).toBeUndefined();
		expect(admitted?.additionalContext).toContain("AM_ACK_BEAD_NOTICE");
		// Without ack_required the tracker is never asked, so an outage does not stop status mail.
		expect(await h.mail(cwd, "send_message", send({ subject: `DONE ${BEAD}: x` }))).toBeUndefined();
	}
});

test("ack_required: a reply drops it with a notice (no subject to check); omitted or false passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "reply_message", reply())).toBeUndefined();
	expect(await h.mail(cwd, "reply_message", reply({ ack_required: false }))).toBeUndefined();
	// MAILGUARDSLIM1: ack_required is dropped by rewriteArgs and the reply proceeds with a notice.
	const admitted = await h.mail(cwd, "reply_message", reply({ ack_required: true }));
	expect(code(admitted)).toBeUndefined();
	expect(admitted?.additionalContext).toContain("AM_ACK_NOTICE");
	expect(stampedArgs(admitted)).not.toHaveProperty("ack_required");
});

// --- shape ---------------------------------------------------------------------------------------

test("body: the cap is inclusive; any over-cap body completes with its full text stored, never refuses", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(AM_BODY_CAP).toBe(1800);
	// A PROGRESS subject isolates the body finding: DONE would add its citation check after the notice.
	const progress = (body_md: string) => send({ subject: `PROGRESS ${BEAD}: x`, body_md });
	expect(await h.mail(cwd, "send_message", progress("x".repeat(AM_BODY_CAP)))).toBeUndefined();
	// AMGUARDSOFT1 (ompkit-1ra0d.167): over the cap is completed with an overflow file, not
	// refused; the secret scan still runs on the full body after it. AM_BODY_TOO_LONG is retired.
	const noticed = await h.mail(cwd, "send_message", progress("x".repeat(AM_BODY_CAP + 1)));
	expect(code(noticed)).toBeUndefined();
	expect(noticed?.additionalContext).toContain("AM_BODY_NOTICE");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_BODY_NOTICE", kind: "notice" });
	for (const size of [AM_BODY_CAP * 4, AM_BODY_CAP * 4 + 1, AM_BODY_CAP * 8]) {
		const completed = await h.mail(cwd, "send_message", progress("x".repeat(size)));
		expect(code(completed)).toBeUndefined();
		expect(completed?.additionalContext).toContain("AM_BODY_NOTICE");
	}
	// A DONE mail with a cited over-cap body is sent with the same notice.
	const done = await h.mail(cwd, "send_message", send({ body_md: `commit ${PUBLISHED_TEST_SHA}\n` + "x".repeat(AM_BODY_CAP) }));
	expect(code(done)).toBeUndefined();
	expect(done?.additionalContext).toContain("AM_BODY_NOTICE");
	expect(await h.mail(cwd, "reply_message", reply({ body_md: "x".repeat(AM_BODY_CAP) }))).toBeUndefined();
	expect((await h.mail(cwd, "reply_message", reply({ body_md: "x".repeat(AM_BODY_CAP + 1) })))?.additionalContext).toContain("AM_BODY_NOTICE");
	expect(code(await h.mail(cwd, "send_message", send({ body_md: undefined })))).toBe("AM_ARGS_UNREADABLE");
});

// Built at run time so this file never holds a literal credential.
const secretName = ["GITHUB", "PAT"].join("_");
const secretValue = ["ghp1fake2abc", "3def4ghi5jkl6"].join("");

test("body: the kit secret scanner refuses a literal credential; a placeholder passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ body_md: `commit ${PUBLISHED_TEST_SHA}\nSet ${secretName}=$${secretName} from Infisical.` }))).toBeUndefined();
	const refused = await h.mail(cwd, "send_message", send({ body_md: `run: export ${secretName}=${secretValue}` }));
	expect(code(refused)).toBe("AM_BODY_SECRET");
	expect(refused?.reason).not.toContain(secretValue);
	expect(code(await h.mail(cwd, "reply_message", reply({ body_md: `${secretName}=${secretValue}` })))).toBe("AM_BODY_SECRET");
	expect(await h.mail(cwd, "send_message", send({ body_md: `commit ${PUBLISHED_TEST_SHA}\nAuthorization: Bearer \${FOO_TOKEN}` }))).toBeUndefined();
	expect(code(await h.mail(cwd, "send_message", send({ body_md: `Authorization: Bearer ${secretValue}` })))).toBe("AM_BODY_SECRET");
});

test("body: a scanner that cannot be loaded refuses instead of letting the body through", async () => {
	const cwd = fleetRepo();
	const missing = await createHost({ secretRulePath: join(base, "no-such-rule.md") });
	expect(code(await missing.mail(cwd, "send_message", send()))).toBe("AM_SCANNER_UNAVAILABLE");
	const empty = join(base, "empty-rule.md");
	writeFileSync(empty, "---\ndescription: none\n---\nbody\n");
	expect(code(await (await createHost({ secretRulePath: empty })).mail(cwd, "send_message", send()))).toBe("AM_SCANNER_UNAVAILABLE");
	expect(await (await createHost()).mail(cwd, "send_message", send())).toBeUndefined();
});

test("ruleConditions reads single-quoted YAML scalars as OMP does and refuses other forms", () => {
	const rule = ["---", "description: d", "condition:", "  # note", "  - 'a''b\\d+'", "  - 'c'", "scope: tool:bash", "---", "body"].join("\n");
	expect(ruleConditions(rule)).toEqual(["a'b\\d+", "c"]);
	expect(() => ruleConditions(rule.replace("  - 'c'", '  - "c"'))).toThrow("single-quoted");
	expect(() => ruleConditions("no frontmatter")).toThrow("frontmatter");
});

// --- reads ---------------------------------------------------------------------------------------

test("reads: bulk read tools are refused; targeted reads and acknowledgements pass", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	for (const tool of ["mark_all_read", "fetch_inbox_product", "fetch_topic", "bulk_mark_read", "read_all_messages"]) {
		expect(code(await h.mail(cwd, tool, { project_key: "p", agent_name: "PlumRaven" }))).toBe("AM_BULK_READ");
	}
	for (const tool of ["mark_message_read", "acknowledge_message", "search_messages", "summarize_thread", "whois"]) {
		expect(await h.mail(cwd, tool, { project_key: "p", message_id: 1 })).toBeUndefined();
	}
});

test("reads: one fetch_inbox per 60 s per seat; over-frequent fetches are admitted with a notice", async () => {
	let clock = 1_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	expect(await h.mail(cwd, "fetch_inbox", fetch)).toBeUndefined();
	// MAILGUARDSLIM1: admitted with a notice that wakes deliver mail; the window slides on every
	// admitted fetch, noticed or not.
	clock += AM_INBOX_INTERVAL_MS / 2;
	const first = await h.mail(cwd, "fetch_inbox", fetch);
	expect(code(first)).toBeUndefined();
	expect(first?.additionalContext).toContain("AM_INBOX_NOTICE");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_INBOX_NOTICE", kind: "notice", act: "fetch_inbox" });
	clock += AM_INBOX_INTERVAL_MS / 2;
	expect((await h.mail(cwd, "fetch_inbox", fetch))?.additionalContext).toContain("AM_INBOX_NOTICE");
	clock += AM_INBOX_INTERVAL_MS;
	expect(await h.mail(cwd, "fetch_inbox", fetch)).toBeUndefined();
	// Another seat (another extension instance) has its own window.
	expect(await (await createHost({ now: () => clock })).mail(cwd, "fetch_inbox", fetch)).toBeUndefined();
});

// --- call shapes ---------------------------------------------------------------------------------

test("shapes: only a write that executes an Agent Mail tool is judged", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const impersonation = send({ sender_name: "BlueLake" });
	const path = `${MAIL}send_message`;
	// Reading the tool's docs, other tools, other xd tools and unrelated writes are not mail.
	expect(await h.call({ toolName: "read", input: { path } }, cwd)).toBeUndefined();
	expect(await h.call({ toolName: "bash", input: { command: "echo hi" } }, cwd)).toBeUndefined();
	expect(await h.call({ toolName: "write", input: { path: "xd://mcp__rea_open_binary", content: "{}" } }, cwd)).toBeUndefined();
	expect(await h.call({ toolName: "write", input: { path: "notes.md", content: JSON.stringify(impersonation) } }, cwd)).toBeUndefined();
	// The executing shapes are judged: content as a JSON string, content as an object, a direct tool name.
	expect(code(await h.call({ toolName: "write", input: { path, content: JSON.stringify(impersonation) } }, cwd))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.call({ toolName: "write", input: { path, content: impersonation } }, cwd))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.call({ toolName: path, input: impersonation }, cwd))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.call({ toolName: "mcp__mcp_agent_mail_send_message", input: impersonation }, cwd))).toBe("AM_IDENTITY_MISMATCH");
	expect(await h.call({ toolName: path, input: send() }, cwd)).toBeUndefined();
});

test("shapes: arguments that do not parse are refused, never guessed", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const path = `${MAIL}send_message`;
	expect(code(await h.call({ toolName: "write", input: { path, content: "{not json" } }, cwd))).toBe("AM_ARGS_UNREADABLE");
	expect(code(await h.call({ toolName: "write", input: { path } }, cwd))).toBe("AM_ARGS_UNREADABLE");
	expect(await h.call({ toolName: "write", input: { path, content: JSON.stringify(send()) } }, cwd)).toBeUndefined();
	// An unguarded mail tool never needs its arguments.
	expect(await h.call({ toolName: "write", input: { path: `${MAIL}acknowledge_message`, content: "{not json" } }, cwd)).toBeUndefined();
});

// --- real-argument smoke ---------------------------------------------------------------------------

test("smoke: the documented send_message, reply_message and bulk-read JSON shapes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const docSend = {
		project_key: "/abs/path/backend", sender_name: "PlumRaven", to: ["BlueLake"], subject: `QUESTION ${BEAD}: Plan for /api/users`,
		body_md: "See below.", ack_required: true, importance: "high", thread_id: null, convert_images: null, attachment_paths: null,
		broadcast: null, topic: null, sender_token: null, idempotency_key: null, auto_contact_if_blocked: null, bcc: null, cc: null,
	};
	expect(await h.mail(cwd, "send_message", docSend)).toBeUndefined();
	expect(code(await h.mail(cwd, "send_message", { ...docSend, sender_name: "GreenCastle" }))).toBe("AM_IDENTITY_MISMATCH");
	const docReply = { project_key: "/abs/path/backend", message_id: 1234, sender_name: "PlumRaven", body_md: "Looping ops.", to: ["GreenCastle"], cc: ["RedCat"], subject_prefix: "RE:" };
	expect(await h.mail(cwd, "reply_message", docReply)).toBeUndefined();
	expect(code(await h.mail(cwd, "reply_message", { ...docReply, sender_name: "GreenCastle" }))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "mark_all_read", { project_key: "/abs/path/backend", agent_name: "PlumRaven" }))).toBe("AM_BULK_READ");
});

// --- resource bounds -------------------------------------------------------------------------------

test("bounds: adversarial long subjects and bodies are judged in bounded time", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const started = performance.now();
	for (const subject of ["A".repeat(200_000), `QUESTION ${"a".repeat(200_000)}`, `QUESTION ${"a-".repeat(100_000)}`, `QUESTION ${"a".repeat(100_000)}-${"1.".repeat(50_000)}`]) {
		await h.mail(cwd, "send_message", send({ subject, ack_required: true }));
	}
	await h.mail(cwd, "send_message", send({ body_md: `${secretName.slice(0, 3)}=${"a1".repeat(AM_BODY_CAP / 2 - 3)}` }));
	await h.mail(cwd, "send_message", send({ body_md: `Bearer ${"a".repeat(AM_BODY_CAP - 7)}` }));
	expect(performance.now() - started).toBeLessThan(2000);
});
// --- phantom recipients (AMPHANTOM1, ompkit-xa5s.16) --------------------------------------------------

const OMPKIT = "/Users/josh/Developer/omp-kit";
const JEV = "/Users/josh/Developer/jev";
const SKILL_LIB = "/Users/josh/Developer/skill-library-growth";
const LOCALBENCH = "/Users/josh/Developer/localbench";

/** Guard execs may read rosters, tracker state, or refresh origin/main; they never mutate Agent Mail registrations. */
function execsAvoidMailMutation(execs: ExecCall[]): boolean {
	return execs.every(call => {
		if ((call.command === "am" && (call.args[1] === "list" || call.args[1] === "projects" || call.args[1] === "show"))
			|| call.command === "br" || call.command === "tmux") return true;
		if (call.command !== "git") return false;
		const operation = call.args[call.args[0] === "-C" ? 2 : 0];
		return operation === "fetch" || operation === "rev-parse" || operation === "merge-base";
	});
}
test("phantom capped roster: exact project-scoped lookup admits a valid older recipient", async () => {
	const rows = Array.from({ length: 250 }, (_, index) => mailRow(`Recent${index}`));
	rows[0] = mailRow("PlumRaven");
	const complete = fleetRespond({ [OMPKIT]: [...rows, mailRow("OldRecipient")] });
	const respond: Responder = call => {
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "list") return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
		return complete(call);
	};
	const host = await createHost({}, respond);
	expect(await host.mail(fleetRepo(), "send_message", send({ project_key: OMPKIT, to: ["oldrecipient"], cc: [] }))).toBeUndefined();
	expect(execsAvoidMailMutation(host.execs)).toBe(true);
});

test("phantom capped roster: exact membership retains cross-project ambiguity warnings", async () => {
	const recent = Array.from({ length: 250 }, (_, index) => mailRow(`Recent${index}`));
	recent[0] = mailRow("PlumRaven");
	const complete = fleetRespond({
		[OMPKIT]: [...recent, mailRow("IcyBarn", { last_active_ts: "2026-10-06T22:07:55.466462Z" })],
		[LOCALBENCH]: [mailRow("PlumRaven"), mailRow("IcyBarn", { last_active_ts: "2026-10-19T09:00:00.000000Z" })],
	});
	const respond: Responder = call => {
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "list"
			&& call.args[call.args.indexOf("-p") + 1] === OMPKIT) {
			return { stdout: JSON.stringify(recent), stderr: "", code: 0 };
		}
		return complete(call);
	};
	const host = await createHost({}, respond);
	const verdict = await host.mail(fleetRepo(), "send_message", send({ project_key: OMPKIT, to: ["IcyBarn"], cc: [] }));
	expect(verdict?.block).not.toBe(true);
	expect(verdict?.additionalContext).toContain("AM_PROJECT_AMBIGUOUS");
	expect(verdict?.additionalContext).toContain(LOCALBENCH);
});

test("warnings: project ambiguity cannot bypass security, authentication or wake admission", async () => {
	const respond = fleetRespond({
		[OMPKIT]: [mailRow("PlumRaven"), mailRow("IcyBarn", { last_active_ts: "2026-10-06T22:07:55.466462Z" })],
		[LOCALBENCH]: [mailRow("PlumRaven"), mailRow("IcyBarn", { last_active_ts: "2026-10-19T09:00:00.000000Z" })],
	});
	const env = { AGENT_NAME: "PlumRaven", AGENT_MAIL_SENDER_TOKEN: SEAT_TOKEN };
	const host = await createHost({ env }, respond);
	const cwd = fleetRepo();
	const target = { project_key: OMPKIT, to: ["IcyBarn"], cc: [] };
	// MAILGUARDSLIM1: the untyped subject is sent with a notice; the ambiguity warning still rides along.
	const untyped = await host.mail(cwd, "send_message", send({ ...target, subject: "untyped update" }));
	expect(code(untyped)).toBeUndefined();
	expect(untyped?.additionalContext).toContain("AM_SUBJECT_NOTICE");
	expect(untyped?.additionalContext).toContain("AM_PROJECT_AMBIGUOUS");
	const secret = await host.mail(cwd, "send_message", send({ ...target, body_md: `run: export ${secretName}=${secretValue}` }));
	expect(code(secret)).toBe("AM_BODY_SECRET");
	expect(JSON.stringify(secret)).not.toContain(secretValue);
	const admitted = await host.mail(cwd, "send_message", send(target));
	expect(admitted?.block).not.toBe(true);
	expect(admitted?.additionalContext).toContain("AM_PROJECT_AMBIGUOUS");
	expect(stampedArgs(admitted)?.sender_token).toBe(SEAT_TOKEN);
	const noWake = await createHost({ env, mailWake: recordingWake("NO_WAKE_PATH: required recipient is unavailable") }, respond);
	const denied = await noWake.mail(cwd, "send_message", send(target));
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toStartWith("NO_WAKE_PATH");
});

test("phantom capped roster: authoritative absence refuses; malformed, unavailable and wrong-name exact results remain unknown", async () => {
	const rows = Array.from({ length: 250 }, (_, index) => mailRow(`Recent${index}`));
	rows[0] = mailRow("PlumRaven");
	const respondWith = (exact: FlywheelExecResult): Responder => call => {
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "list") return { stdout: JSON.stringify(rows), stderr: "", code: 0 };
		if (call.command === "am" && call.args[0] === "agents" && call.args[1] === "show") return exact;
		if (call.command === "am" && call.args[0] === "robot") return { stdout: JSON.stringify({ projects: [{ path: OMPKIT, slug: "native-project", agents: 250 }] }), stderr: "", code: 0 };
		return brKnows(BEAD)(call);
	};
	const absent = await createHost({}, respondWith({ stdout: "", stderr: `error: whois via server failed: ${JSON.stringify({ error: { type: "AGENT_NOT_FOUND", data: { agent_name: "Missing", project: "native-project" } } })}`, code: 1 }));
	expect(code(await absent.mail(fleetRepo(), "send_message", send({ project_key: OMPKIT, to: ["Missing"], cc: [] })))).toBe("AM_PHANTOM_REFUSED");
	for (const result of [
		{ stdout: "not json", stderr: "", code: 0 },
		{ stdout: "", stderr: "temporary server failure", code: 1 },
		{ stdout: JSON.stringify({ id: 2, name: "Different", project_id: 233 }), stderr: "", code: 0 },
		{ stdout: "", stderr: JSON.stringify({ error: { type: "AGENT_NOT_FOUND", data: { agent_name: "Missing", project: "different-project" } } }), code: 1 },
		{ stdout: JSON.stringify({ id: 2, name: "Missing", project_id: 233 }), stderr: "", code: 0, killed: true },
	]) {
		const host = await createHost({}, respondWith(result));
		expect(code(await host.mail(fleetRepo(), "send_message", send({ project_key: OMPKIT, to: ["Missing"], cc: [] })))).toBe("AM_ROSTER_UNAVAILABLE");
	}
});


test("phantom (a): a send to a name registered only elsewhere is refused naming that project; no registration happens", async () => {
	const h = await createHost({}, fleetRespond({
		[OMPKIT]: [mailRow("PlumRaven"), mailRow("RedMaple"), mailRow("BlueLake")],
		[JEV]: [mailRow("PlumRaven"), mailRow("VioletLake"), mailRow("RedMaple")],
	}));
	const cwd = fleetRepo();
	const refused = await h.mail(cwd, "send_message", send({ project_key: OMPKIT, to: ["VioletLake"], cc: [] }));
	expect(code(refused)).toBe("AM_PHANTOM_REFUSED");
	expect(refused?.reason).toContain(JEV);
	expect(refused?.reason).toContain("RECIPIENT's repo path");
	// The refusal is decided from roster reads alone: a mutant that skips the check is the only way
	// this send passes, and a server that auto-registers never sees the call. Nothing was sent.
	expect(refused?.reason).toContain("Nothing was sent");
	expect(execsAvoidMailMutation(h.execs)).toBe(true);
});

test("phantom (b): the same send under the recipient's own key is delivered", async () => {
	const h = await createHost({}, fleetRespond({
		[OMPKIT]: [mailRow("PlumRaven"), mailRow("RedMaple")],
		[JEV]: [mailRow("PlumRaven"), mailRow("VioletLake")],
	}));
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ project_key: JEV, to: ["VioletLake"], cc: [] }))).toBeUndefined();
});

test("phantom (c): a name registered nowhere is refused as registered nowhere", async () => {
	const h = await createHost({}, fleetRespond({
		[OMPKIT]: [mailRow("PlumRaven"), mailRow("BlueLake")],
		[JEV]: [mailRow("PlumRaven"), mailRow("VioletLake")],
	}));
	const cwd = fleetRepo();
	const refused = await h.mail(cwd, "send_message", send({ project_key: OMPKIT, to: ["ZzPlantedNobody"], cc: [] }));
	expect(code(refused)).toBe("AM_PHANTOM_REFUSED");
	expect(refused?.reason).toContain("not registered in any other project");
	expect(execsAvoidMailMutation(h.execs)).toBe(true);
});

test("phantom (d): a name in two projects warns naming each project's last activity unless the target is the most active", async () => {
	const rosters = {
		[OMPKIT]: [mailRow("PlumRaven"), mailRow("IcyBarn", { last_active_ts: "2026-10-06T22:07:55.466462Z" })],
		[LOCALBENCH]: [mailRow("PlumRaven"), mailRow("IcyBarn", { last_active_ts: "2026-10-19T09:00:00.000000Z" })],
	};
	const cwd = fleetRepo();
	const warned = await (await createHost({}, fleetRespond(rosters))).mail(cwd, "send_message", send({ project_key: OMPKIT, to: ["IcyBarn"], cc: [] }));
	expect(warned?.block).not.toBe(true);
	expect(warned?.additionalContext).toContain("AM_PROJECT_AMBIGUOUS");
	expect(warned?.additionalContext).toContain(LOCALBENCH);
	expect(warned?.additionalContext).toContain("Most recently active");
	// The most-recently-active project sends quietly.
	const quiet = await (await createHost({}, fleetRespond(rosters))).mail(cwd, "send_message", send({ project_key: LOCALBENCH, to: ["IcyBarn"], cc: [] }));
	expect(quiet).toBeUndefined();
});

test("phantom (e): a sender_name naming another runtime's registration is refused naming both", async () => {
	const cwd = fleetRepo();
	const rosters = {
		[SKILL_LIB]: [
			mailRow("RedMaple", { program: "openai-codex", task_description: "Repair assigned skill-library-growth DAG edges" }),
			mailRow("BlueLake"),
		],
		[cwd]: [mailRow("RedMaple", { program: "omp", task_description: "director mission alignment" })],
	};
	const h = await createHost({ env: { AGENT_NAME: "RedMaple" } }, fleetRespond(rosters));
	const refused = await h.mail(cwd, "send_message", send({ project_key: SKILL_LIB, sender_name: "RedMaple", cc: [] }));
	expect(code(refused)).toBe("AM_SENDER_COLLISION");
	expect(refused?.reason).toContain("openai-codex");
	expect(refused?.reason).toContain("omp");
	// The same runtime on both sides sends quietly.
	const same: Record<string, TestRosterRow[]> = {
		[SKILL_LIB]: [mailRow("RedMaple", { program: "omp" }), mailRow("BlueLake")],
		[cwd]: [mailRow("RedMaple", { program: "omp" })],
	};
	const h2 = await createHost({ env: { AGENT_NAME: "RedMaple" } }, fleetRespond(same));
	expect(await h2.mail(cwd, "send_message", send({ project_key: SKILL_LIB, sender_name: "RedMaple", cc: [] }))).toBeUndefined();
});

test("phantom: an unreadable roster fails closed instead of sending unchecked", async () => {
	const cwd = fleetRepo();
	const rosterDown: Responder[] = [
		fleetRespond({}),
		() => { throw new Error("spawn am ENOENT"); },
		() => ({ stdout: "not json", stderr: "", code: 0 }),
	];
	for (const respond of rosterDown) {
		const h = await createHost({}, respond);
		expect(code(await h.mail(cwd, "send_message", send()))).toBe("AM_ROSTER_UNAVAILABLE");
	}
});

// --- sender_token injection ----------------------------------------------------------------------

const SEAT_TOKEN = "seat-token-minted-for-tests";

/** The mail arguments a passing send runs with after the guard's input revision. */
function stampedArgs(result: FlywheelToolCallResult | undefined): Record<string, unknown> | undefined {
	if (typeof result !== "object" || result === null || !("input" in result)) return undefined;
	const input: unknown = result.input;
	const content: unknown = typeof input === "object" && input !== null && "content" in input ? input.content : input;
	if (typeof content === "string") {
		let parsed: unknown;
		try { parsed = JSON.parse(content); } catch { return undefined; }
		// typeof-object is the boundary invariant for the args bag.
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
	}
	// typeof-object is the boundary invariant for the args bag.
	return typeof content === "object" && content !== null ? (content as Record<string, unknown>) : undefined;
}

test("token: a passing send runs stamped with the seat token; explicit tokens and other senders untouched", async () => {
	const h = await createHost({ env: { AGENT_NAME: "PlumRaven", AGENT_MAIL_SENDER_TOKEN: SEAT_TOKEN } });
	const cwd = fleetRepo();
	const stamped = await h.mail(cwd, "send_message", send());
	const body = stampedArgs(stamped);
	expect(body?.sender_token).toBe(SEAT_TOKEN);
	expect(body?.subject).toBe(`DONE ${BEAD}: landed`);
	expect(body?.to).toEqual(["BlueLake"]);
	expect(stamped !== undefined && "reason" in stamped).toBe(false);
	// An explicit token is never overridden: the send runs as written.
	expect(await h.mail(cwd, "send_message", send({ sender_token: "explicit-token" }))).toBeUndefined();
	// Another sender is still refused, and the seat token goes nowhere near the refusal.
	const refused = await h.mail(cwd, "send_message", send({ sender_name: "BlueLake" }));
	expect(code(refused)).toBe("AM_IDENTITY_MISMATCH");
	expect(JSON.stringify(refused)).not.toContain(SEAT_TOKEN);
	// No token registered: the send runs as written.
	const bare = await createHost();
	expect(await bare.mail(fleetRepo(), "send_message", send())).toBeUndefined();
});

test("token: direct MCP-call form, object content, and empty-string token are stamped", async () => {
	const h = await createHost({ env: { AGENT_NAME: "PlumRaven", AGENT_MAIL_SENDER_TOKEN: SEAT_TOKEN } });
	const cwd = fleetRepo();
	const direct = await h.call({ toolName: "mcp__mcp_agent_mail_send_message", input: send() }, cwd);
	const dinput = stampedArgs(direct);
	expect(dinput?.sender_token).toBe(SEAT_TOKEN);
	expect(dinput?.subject).toBe(`DONE ${BEAD}: landed`);
	const objectForm = await h.call({ toolName: "write", input: { path: `${MAIL}send_message`, content: send() } }, cwd);
	expect(stampedArgs(objectForm)?.sender_token).toBe(SEAT_TOKEN);
	const emptyToken = await h.call(
		{ toolName: "write", input: { path: `${MAIL}send_message`, content: JSON.stringify(send({ sender_token: "" })) } }, cwd);
	expect(stampedArgs(emptyToken)?.sender_token).toBe(SEAT_TOKEN);
	const replyCall = await h.call({ toolName: "mcp__mcp_agent_mail_reply_message", input: reply() }, cwd);
	const rinput = stampedArgs(replyCall);
	expect(rinput?.sender_token).toBe(SEAT_TOKEN);
});

// MAILWAKE1 (ompkit-uk9wn): kit-mail-wake shipped as a library but no guard ever called it, so no send woke anyone
// (2026-10-22: no mail-wake.jsonl ledger existed on the fleet host). These pin the wiring.
test("wake: a send that passes every check plans its wake, and its result carries the wake outcome", async () => {
	const wake = recordingWake();
	const h = await createHost({ mailWake: wake });
	const cwd = fleetRepo();
	expect(code(await h.mail(cwd, "send_message", send(), "send-1"))).toBeUndefined();
	expect(wake.before).toHaveLength(1);
	expect(wake.before[0]!.slice(0, 2)).toEqual(["send-1", "send_message"]);
	expect((wake.before[0]![2] as Record<string, unknown>).to).toEqual(["BlueLake"]);
	expect(wake.before[0]![3]).toBe(BACKEND);
	const patched = await h.result(cwd, "send-1", [{ type: "text", text: "{\"deliveries\":[]}" }]);
	expect(JSON.stringify(patched)).toContain("woke send-1");
	expect(wake.after).toHaveLength(1);
});

test("wake: planted, an ask with no wake path is refused before anything is sent", async () => {
	const h = await createHost({ mailWake: recordingWake("NO_WAKE_PATH: BlueLake has no live seat") });
	const verdict = await h.mail(fleetRepo(), "send_message", send(), "send-2");
	expect(verdict?.block).toBe(true);
	expect(verdict?.reason).toStartWith("NO_WAKE_PATH");
});

test("wake: a send the guard refuses never reaches the wake", async () => {
	const wake = recordingWake();
	const h = await createHost({ mailWake: wake });
	expect(code(await h.mail(fleetRepo(), "send_message", send({ sender_name: "BlueLake" }), "send-3"))).toBe("AM_IDENTITY_MISMATCH");
	expect(wake.before).toHaveLength(0);
});

test("wake: control, a repo that did not opt into the fleet plans no wake", async () => {
	const wake = recordingWake();
	const h = await createHost({ mailWake: wake });
	expect(await h.mail(fleetRepo(false), "send_message", send(), "send-4")).toBeUndefined();
	expect(wake.before).toHaveLength(0);
});

test.each(["register_agent", "macro_start_session"])("MAILWAKE1.2 strips unknown %s arguments with a notice and registers without them", async tool => {
	const h = await createHost();
	const cwd = fleetRepo();
	const args = tool === "register_agent"
		? { project_key: BACKEND, program: "omp", model: "test", name: "PlumRaven", unexpected_registration_key: true }
		: { human_key: BACKEND, program: "omp", model: "test", agent_name: "PlumRaven", unexpected_registration_key: true };
	// MAILGUARDSLIM1: unknown arguments are stripped by rewriteArgs and the call proceeds with a notice.
	const admitted = await h.mail(cwd, tool, args);
	expect(code(admitted)).toBeUndefined();
	expect(admitted?.additionalContext).toContain("AM_REGISTRATION_NOTICE");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_REGISTRATION_NOTICE", kind: "notice" });
	const content = stampedArgs(admitted);
	expect(content).not.toHaveProperty("unexpected_registration_key");
	expect(content).toMatchObject({ pane_id: "%9" });
	expect(h.execs).toEqual([]);
});

test("MAILWAKE1.2 an environment name cannot replace a missing sender pane identity", async () => {
	const home = freshDir(base, "unbound-sender-");
	const h = await createHost({ home, env: { AGENT_NAME: "PlumRaven", TMUX_PANE: "%9" } });
	const verdict = await h.mail(fleetRepo(), "send_message", send());
	expect(code(verdict)).toBe("IDENTITY_UNBOUND");
	expect(verdict?.reason).toContain("register_agent");
});

test("MAILWAKE1.2 macro registration binds the actual Tern session rather than another block", async () => {
	const cwd = fleetRepo();
	const home = freshDir(base, "macro-caller-");
	const sessionFile = join(home, "current-session.jsonl");
	const h = await createHost({
		home, env: { AGENT_NAME: "PlumRaven" }, sessionFile, mailWake: undefined,
	}, call => call.command === "tern"
		? { code: 0, stdout: JSON.stringify({
			sessions: [{ tabs: [{ name: "fixture", blocks: [{ id: 91, cwd, live: true }, { id: 92, cwd, live: true }] }] }],
			panes: [{ pane: 91, cwd, omp_session_file: sessionFile }, { pane: 92, cwd, omp_session_file: join(home, "other.jsonl") }],
		}) }
		: { code: 127, stdout: "", stderr: "unexpected process" });
	const args = { human_key: cwd, program: "omp", model: "test", agent_name: "PlumRaven" };
	const patch = await h.mail(cwd, "macro_start_session", args);
	const input = patch && "input" in patch ? patch.input : undefined;
	const content = input && typeof input === "object" && "content" in input ? input.content : undefined;
	const rewritten = JSON.parse(String(content));
	expect(rewritten.pane_id).toBe("tern:91");
	expect(rewritten.agent_name).toBe("PlumRaven");
	const wrong = await h.mail(cwd, "macro_start_session", { ...args, pane_id: "tern:92" });
	expect(code(wrong)).toBe("IDENTITY_UNBOUND");
	const borrowed = await h.mail(cwd, "macro_start_session", { ...args, agent_name: "BlueLake" });
	expect(code(borrowed)).toBe("AM_IDENTITY_MISMATCH");
});

test("MAILWAKE1.2 a persisted Tern send records its row, and removing its identity refuses the next send", async () => {
	const cwd = fleetRepo();
	const home = freshDir(base, "tern-sender-");
	const sessionFile = join(home, "sender-session.jsonl");
	const identityDir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
	mkdirSync(identityDir, { recursive: true });
	const identityFile = join(identityDir, "tern-91");
	writeFileSync(identityFile, JSON.stringify({ name: "PlumRaven" }));
	const respond = fleetRespond(defaultRosters());
	const h = await createHost({ home, env: { AGENT_NAME: "PlumRaven" }, sessionFile, mailWake: undefined },
		call => call.command === "tern" ? { code: 0, stdout: JSON.stringify({
			sessions: [{ tabs: [{ name: "fixture", blocks: [{ id: 91, cwd, live: true }] }] }],
			panes: [{ pane: 91, cwd, omp_session_file: sessionFile }],
		}) } : respond(call));
	expect(await h.mail(cwd, "send_message", send({ to: ["BlueLake"], cc: [] }), "tern-send")).toBeUndefined();
	await h.result(cwd, "tern-send", [{ type: "text", text: JSON.stringify({
		deliveries: [{ project: BACKEND, payload: { id: 8126, to: ["BlueLake"] } }],
	}) }]);
	const rows = readFileSync(join(home, ".local", "state", "omp-kit", "mail-wake.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	expect(rows).toContainEqual(expect.objectContaining({ message_id: 8126, recipient: "BlueLake", status: "UNSIGNALED" }));
	rmSync(identityFile);
	expect(code(await h.mail(cwd, "send_message", send(), "unbound-after-delete"))).toBe("IDENTITY_UNBOUND");
});

test("MAILWAKE1.2 an uncorrelatable send is refused before persistence", async () => {
	const h = await createHost();
	expect(code(await h.mail(fleetRepo(), "send_message", send(), null))).toBe("AM_CALL_ID_REQUIRED");
});

test("MAILWAKE1.2 a real tmux identity remains valid with an OMP session outside Tern", async () => {
	const cwd = fleetRepo();
	const home = freshDir(base, "tmux-caller-");
	const dir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "7"), JSON.stringify({ name: "RedCat" }));
	const h = await createHost({ env: { TMUX_PANE: "%7" }, home, sessionFile: join(home, "tmux-session.jsonl") });
	expect(await h.mail(cwd, "send_message", send({ sender_name: "RedCat" }))).toBeUndefined();
});
test("DONE mail: refuses unpublished or unreadable citations and admits only freshly published commits", async () => {
	const repo = gitInit(base);
	const origin = freshDir(base, "mail-publish-origin-");
	await gitOutput(base, ["init", "--bare", "--quiet", origin]);
	await gitOutput(repo, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--no-verify", "--allow-empty", "-m", "published fixture [test]"]);
	const published = await gitOutput(repo, ["rev-parse", "HEAD"]);
	await gitOutput(repo, ["remote", "add", "origin", origin]);
	await gitOutput(repo, ["push", "-q", "origin", `${published}:refs/heads/main`]);
	await gitOutput(repo, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--no-verify", "--allow-empty", "-m", "unpublished fixture [test]"]);
	const unpublished = await gitOutput(repo, ["rev-parse", "HEAD"]);

	const roster = fleetRespond({ [repo]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")] }, BEAD);
	const respond: Responder = async call => {
		if (call.command === "git") {
			const result = await run(["git", ...call.args], { cwd: repo, deadline_s: 60, max_output_bytes: 16 * 1024 });
			return { stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), code: result.rc ?? 1 };
		}
		return roster(call);
	};
	const h = await createHost({}, respond);
	const cwd = fleetRepo();
	const done = (body_md: string) => send({ project_key: repo, body_md });
	const refused = await h.mail(cwd, "send_message", done(`commit ${unpublished}`));
	expect(code(refused)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(refused?.reason).toContain("NOT_PUBLISHED");
	const mixed = await h.mail(cwd, "send_message", done(`commit ${published}\ncommit ${unpublished}`));
	expect(code(mixed)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(mixed?.reason).toContain(unpublished);

	await gitOutput(repo, ["push", "-q", "origin", `${unpublished}:refs/heads/main`]);
	expect(await h.mail(cwd, "send_message", done(`commit ${unpublished}`))).toBeUndefined();
	expect(code(await h.mail(cwd, "send_message", done("Done; no commit cited")))).toBe("AM_DONE_NOT_PUBLISHED");
	expect(code(await h.mail(cwd, "send_message", done("commit deadbeef")))).toBe("AM_DONE_NOT_PUBLISHED");

	await gitOutput(repo, ["remote", "set-url", "origin", join(base, "missing-origin.git")]);
	const offline = await h.mail(cwd, "send_message", done(`commit ${published}`));
	expect(code(offline)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(offline?.reason).toContain("UNKNOWN");
});

test("DONE mail: checks repo-qualified commit citations in their code-source repository", async () => {
	const recipientRepo = gitInit(base);
	const sourceRepo = gitInit(base);
	const recipientOrigin = freshDir(base, "mail-recipient-origin-");
	await gitOutput(base, ["init", "--bare", "--quiet", recipientOrigin]);
	await gitOutput(recipientRepo, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--no-verify", "--allow-empty", "-m", "published recipient fixture [test]"]);
	const recipientPublished = await gitOutput(recipientRepo, ["rev-parse", "HEAD"]);
	await gitOutput(recipientRepo, ["remote", "add", "origin", recipientOrigin]);
	await gitOutput(recipientRepo, ["push", "-q", "origin", `${recipientPublished}:refs/heads/main`]);
	const origin = freshDir(base, "mail-code-origin-");
	await gitOutput(base, ["init", "--bare", "--quiet", origin]);
	await gitOutput(sourceRepo, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--no-verify", "--allow-empty", "-m", "published code fixture [test]"]);
	const published = await gitOutput(sourceRepo, ["rev-parse", "HEAD"]);
	await gitOutput(sourceRepo, ["remote", "add", "origin", origin]);
	await gitOutput(sourceRepo, ["push", "-q", "origin", `${published}:refs/heads/main`]);
	await gitOutput(sourceRepo, ["-c", "user.name=t", "-c", "user.email=t@x", "commit", "--no-verify", "--allow-empty", "-m", "unpublished code fixture [test]"]);
	const unpublished = await gitOutput(sourceRepo, ["rev-parse", "HEAD"]);

	const roster = fleetRespond({ [recipientRepo]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")] }, BEAD);
	const respond: Responder = async call => {
		if (call.command === "git") {
			const repo = call.args[1]!;
			const result = await run(["git", ...call.args], { cwd: repo, deadline_s: 60, max_output_bytes: 16 * 1024 });
			return { stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), code: result.rc ?? 1 };
		}
		return roster(call);
	};
	const h = await createHost({}, respond);
	const cwd = fleetRepo();
	const done = (sha: string) => send({ project_key: recipientRepo, body_md: `DONE ${sourceRepo}@${sha}: evidence is in the bead.` });

	expect(await h.mail(cwd, "send_message", done(published))).toBeUndefined();
	const unpublishedResult = await h.mail(cwd, "send_message", done(unpublished));
	expect(code(unpublishedResult)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(unpublishedResult?.reason).toContain(unpublished);
	expect(h.execs.filter(call => call.command === "git").every(call => call.args[1] === sourceRepo)).toBe(true);

	const mixedStart = h.execs.length;
	const mixed = await h.mail(cwd, "send_message", send({
		project_key: recipientRepo,
		body_md: `DONE ${sourceRepo}@${published}: evidence is in the bead; recipient commit ${recipientPublished}.`,
	}));
	expect(mixed).toBeUndefined();
	const mixedGitRepos = new Set(h.execs.slice(mixedStart).filter(call => call.command === "git").map(call => call.args[1]!));
	expect([...mixedGitRepos].sort()).toEqual([recipientRepo, sourceRepo].sort());

	const unknown = await h.mail(cwd, "send_message", done("deadbeef"));
	expect(code(unknown)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(unknown?.reason).toContain("UNKNOWN");
	const recipientUnknown = await h.mail(cwd, "send_message", send({
		project_key: recipientRepo,
		body_md: "recipient commit deadbeef",
	}));
	expect(code(recipientUnknown)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(recipientUnknown?.reason).toContain(`in ${recipientRepo}:`);
	// The plain citation is judged in the recipient's repo, so the refusal names the cross-repo form.
	expect(recipientUnknown?.reason).toContain("cite it as <absolute-repo-path>@deadbeef");
	const malformed = await h.mail(cwd, "send_message", send({
		project_key: recipientRepo,
		body_md: `Code source ${sourceRepo}@@${published}; evidence is in the bead.`,
	}));
	expect(code(malformed)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(malformed?.reason).toContain("the body must cite at least one commit SHA");
	const unsupported = await h.mail(cwd, "send_message", send({
		project_key: recipientRepo,
		body_md: `Code source alias@${published}; evidence is in the bead.`,
	}));
	expect(code(unsupported)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(unsupported?.reason).toContain("unsupported repository qualifier");
	const missingRepo = await h.mail(cwd, "send_message", send({
		project_key: recipientRepo,
		body_md: `Code source ${join(base, "missing-code-repo")}@${published}; evidence is in the bead.`,
	}));
	expect(code(missingRepo)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(missingRepo?.reason).toContain("UNKNOWN");
	await gitOutput(sourceRepo, ["remote", "set-url", "origin", join(base, "missing-code-origin.git")]);
	const offline = await h.mail(cwd, "send_message", done(published));
	expect(code(offline)).toBe("AM_DONE_NOT_PUBLISHED");
	expect(offline?.reason).toContain("UNKNOWN");
});

/**
 * MAILXREPO1 (ompkit-fp72.120.16.171): a lead whose Tern block runs in a directory outside the opted-in
 * recipient repo (~/Developer) holds its identity only in the recipient project's pane identity file,
 * `<sha1(recipient)[:12]>/tern-<block>`, the file resolve_pane_identity reads. Block 91 is the caller's own
 * live session; block 92 is another live seat in the recipient repo.
 */
function crossRepoSeat(bindings: Record<string, string>, sessionLive = true) {
	const recipient = fleetRepo();
	const home = freshDir(base, "xrepo-sender-");
	const sessionCwd = freshDir(base, "lead-cwd-");
	const sessionFile = join(home, "lead-session.jsonl");
	const identityDir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(recipient).digest("hex").slice(0, 12));
	mkdirSync(identityDir, { recursive: true });
	for (const [block, name] of Object.entries(bindings)) writeFileSync(join(identityDir, `tern-${block}`), JSON.stringify({ name }));
	const respond = fleetRespond({ [recipient]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")] });
	const tern = JSON.stringify({
		sessions: [{ tabs: [{ name: "fixture", blocks: [{ id: 91, cwd: sessionCwd, live: true }, { id: 92, cwd: recipient, live: true }] }] }],
		panes: [
			{ pane: 91, cwd: sessionCwd, omp_session_file: sessionLive ? sessionFile : join(home, "ended.jsonl") },
			{ pane: 92, cwd: recipient, omp_session_file: join(home, "other.jsonl") },
		],
	});
	const host = (agentName: string) => createHost({ home, env: { AGENT_NAME: agentName }, sessionFile, mailWake: undefined },
		call => call.command === "tern" ? { code: 0, stdout: tern } : respond(call));
	return { recipient, sessionCwd, host };
}

test("MAILXREPO1 [a] planted: a Tern seat outside the recipient repo sends under its key from that project's pane identity file", async () => {
	const seat = crossRepoSeat({ 91: "PlumRaven" });
	const h = await seat.host("PlumRaven");
	expect(await h.mail(seat.sessionCwd, "send_message", send({ project_key: seat.recipient, to: ["BlueLake"], cc: [] }), "xrepo-send")).toBeUndefined();
	// The bound name governs: the seat still cannot send as another agent under that key.
	expect(code(await h.mail(seat.sessionCwd, "send_message", send({ project_key: seat.recipient, sender_name: "RedCat", to: ["BlueLake"], cc: [] }), "xrepo-borrow")))
		.toBe("AM_IDENTITY_MISMATCH");
});

test("MAILXREPO1 [b] control: an unbound or spoofed pane is still refused IDENTITY_UNBOUND", async () => {
	const unbound = "kit-agent-mail-guard IDENTITY_UNBOUND: No identity file binds this sender's actual pane. Run register_agent or macro_start_session for this pane before sending. Nothing was sent.";
	// Another live block's binding for the recipient project never binds this caller, whatever name it claims.
	const spoof = crossRepoSeat({ 92: "RedCat" });
	const spoofed = await (await spoof.host("RedCat")).mail(spoof.sessionCwd, "send_message",
		send({ project_key: spoof.recipient, sender_name: "RedCat", to: ["BlueLake"], cc: [] }), "xrepo-spoof");
	expect(code(spoofed)).toBe("IDENTITY_UNBOUND");
	expect(spoofed?.reason).toBe(unbound);
	// A bound block whose session is not this caller's live session does not bind it either.
	const ended = crossRepoSeat({ 91: "PlumRaven" }, false);
	const stale = await (await ended.host("PlumRaven")).mail(ended.sessionCwd, "send_message",
		send({ project_key: ended.recipient, to: ["BlueLake"], cc: [] }), "xrepo-ended");
	expect(code(stale)).toBe("IDENTITY_UNBOUND");
	expect(stale?.reason).toBe(unbound);
});

/**
 * MAILBIND1 (ompkit-8bybq): the lead (PeachLeopard, Tern block 91, session cwd outside every fleet repo) holds a
 * pane identity file only for its home project. register_agent without a pane_id writes no file for project B,
 * so B has none; Agent Mail still lists PeachLeopard in B. That registration plus the block's own identity
 * binds the send under B; a project where the name is not registered stays refused with the remedy named.
 */
function registeredElsewhereSeat() {
	const home = freshDir(base, "mailbind-lead-");
	const sessionCwd = freshDir(base, "mailbind-cwd-");
	const sessionFile = join(home, "lead-session.jsonl");
	const homeProject = freshDir(base, "mailbind-home-project-");
	const identityDir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(homeProject).digest("hex").slice(0, 12));
	mkdirSync(identityDir, { recursive: true });
	writeFileSync(join(identityDir, "tern-91"), JSON.stringify({ name: "PeachLeopard" }));
	const registered = fleetRepo();
	const unregistered = fleetRepo();
	const respond = fleetRespond({
		[homeProject]: [mailRow("PeachLeopard")],
		[registered]: [mailRow("PeachLeopard"), mailRow("SilverCondor"), mailRow("RedCat")],
		[unregistered]: [mailRow("SilverCondor")],
	});
	const tern = JSON.stringify({
		sessions: [{ tabs: [{ name: "fixture", blocks: [{ id: 91, cwd: sessionCwd, live: true }] }] }],
		panes: [{ pane: 91, cwd: sessionCwd, omp_session_file: sessionFile }],
	});
	const host = () => createHost({ home, env: {}, sessionFile, mailWake: undefined },
		call => call.command === "tern" ? { code: 0, stdout: tern } : respond(call));
	return { registered, unregistered, sessionCwd, host };
}

test("MAILBIND1 a pane named PeachLeopard and registered in project B sends under B without B's identity file", async () => {
	const seat = registeredElsewhereSeat();
	const h = await seat.host();
	expect(await h.mail(seat.sessionCwd, "send_message",
		send({ project_key: seat.registered, sender_name: "PeachLeopard", to: ["SilverCondor"], cc: [] }), "mailbind-send")).toBeUndefined();
});

test("MAILBIND1 the same pane cannot send under B as a name its identity file does not give it", async () => {
	const seat = registeredElsewhereSeat();
	const h = await seat.host();
	expect(code(await h.mail(seat.sessionCwd, "send_message",
		send({ project_key: seat.registered, sender_name: "RedCat", to: ["SilverCondor"], cc: [] }), "mailbind-borrow"))).toBe("AM_IDENTITY_MISMATCH");
});

test("MAILBIND1 a project where the pane's name is not registered stays IDENTITY_UNBOUND and names the remedy", async () => {
	const seat = registeredElsewhereSeat();
	const h = await seat.host();
	const refused = await h.mail(seat.sessionCwd, "send_message",
		send({ project_key: seat.unregistered, sender_name: "PeachLeopard", to: ["SilverCondor"], cc: [] }), "mailbind-unregistered");
	expect(code(refused)).toBe("IDENTITY_UNBOUND");
	expect(refused?.reason).toContain(`its pane identity names PeachLeopard, who is not registered in that project`);
	expect(refused?.reason).toContain(`Run register_agent (project_key ${seat.unregistered}, name PeachLeopard, pane_id tern:91)`);
});

// --- MAILGUARDSLIM1 (ompkit-1ra0d.143): keep the hazard refusals, demote or complete the rest ------------

const childAgent = { kind: "sub", id: "child-99", parentId: "parent-1" } as const;

/** The rewritten bash command from a guard verdict, or "" when the guard returned no input patch. */
function commandOf(result: FlywheelToolCallResult | undefined): string {
	if (typeof result !== "object" || result === null || !("input" in result)) return "";
	const input: unknown = result.input;
	if (typeof input !== "object" || input === null || !("command" in input)) return "";
	const command: unknown = input.command;
	return typeof command === "string" ? command : "";
}

test("MAILGUARDSLIM1 [a] a child's reservation is admitted under its parent seat's name with one notice", async () => {
	const h = await createHost({ agent: { ...childAgent } });
	const cwd = fleetRepo();
	// Planted negative: the old guard refused this call and advised register_agent (a second
	// refusal); the new guard admits it under the seat's name with exactly one notice.
	for (const [tool, args] of [
		["file_reservation_paths", reserveArgs({ agent_name: "child-99" })],
		["renew_file_reservations", renewArgs({ agent_name: "child-99" })],
		["release_file_reservations", releaseArgs({ agent_name: "child-99" })],
		["macro_file_reservation_cycle", reservationCycleArgs({ agent_name: "child-99" })],
	] as const) {
		const admitted = await h.mail(cwd, tool, args);
		expect(code(admitted)).toBeUndefined();
		expect(admitted?.additionalContext).toContain("AM_CHILD_RESERVATION_NOTICE");
		expect(admitted?.additionalContext).not.toContain("register_agent");
		expect(stampedArgs(admitted)).toMatchObject({ agent_name: "PlumRaven" });
		expect(h.notices.at(-1)).toMatchObject({ gate: "AM_CHILD_RESERVATION_NOTICE", kind: "notice", act: tool });
	}
	// A child that already names the seat is admitted silently: nothing to rewrite.
	expect(await h.mail(cwd, "file_reservation_paths", reserveArgs())).toBeUndefined();
});

test("MAILGUARDSLIM1 [a] a child's shell reservation is rewritten to the seat and admitted", async () => {
	const h = await createHost({ agent: { ...childAgent } });
	const cwd = fleetRepo();
	const admitted = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} child-99 .beads/issues.jsonl --exclusive` } }, cwd);
	expect(admitted?.block).not.toBe(true);
	expect(commandOf(admitted)).toContain("PlumRaven");
	expect(commandOf(admitted)).not.toContain("child-99");
	expect(admitted?.additionalContext).toContain("AM_CHILD_RESERVATION_NOTICE");
	// Quoted paths, chained calls and the other verbs rewrite byte-identically except the agent token.
	const chained = await h.call({ toolName: "bash", input: { command: `am file_reservations renew ${cwd} child-99 --extend-seconds 60 && am file_reservations release ${cwd} child-99 --ids 7` } }, cwd);
	expect(commandOf(chained)).toBe(`am file_reservations renew ${cwd} PlumRaven --extend-seconds 60 && am file_reservations release ${cwd} PlumRaven --ids 7`);
	const quoted = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} child-99 "my dir/file.ts" --reason 'a quoted reason'` } }, cwd);
	expect(commandOf(quoted)).toBe(`am file_reservations reserve ${cwd} PlumRaven "my dir/file.ts" --reason 'a quoted reason'`);
	// Already under the seat, and pure reads, pass through untouched.
	expect(await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} PlumRaven paths --exclusive` } }, cwd)).toBeUndefined();
	expect(await h.call({ toolName: "bash", input: { command: "am agents list -p /abs/path/backend --json" } }, cwd)).toBeUndefined();
});

test("MAILGUARDSLIM1 [a] an unrecognised shell flag is never guessed: the call is left unchanged with a notice", async () => {
	const h = await createHost({ agent: { ...childAgent } });
	const cwd = fleetRepo();
	// Reviewer case: `--agent-name Foo` may carry a value, so PROJ is not provably the project and
	// AGENTX is not provably the agent. The command runs unchanged with a notice saying which call.
	const raw = `am file_reservations reserve --agent-name Foo PROJ AGENTX --exclusive`;
	const left = await h.call({ toolName: "bash", input: { command: raw } }, cwd);
	expect(left?.block).not.toBe(true);
	expect(commandOf(left)).toBe("");
	expect(left?.additionalContext).toContain("AM_CHILD_RESERVATION_NOTICE");
	expect(left?.additionalContext).toContain("reserve");
	expect(left?.additionalContext).toContain("left unchanged");
	expect(left?.additionalContext).toContain("reserve under the parent seat's name PlumRaven instead");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_CHILD_RESERVATION_NOTICE", kind: "notice", act: "bash" });
	// A bare `--` ends flag parsing: everything after is positional, so the rewrite applies.
	const ended = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve -- ${cwd} child-99 paths` } }, cwd);
	expect(commandOf(ended)).toBe(`am file_reservations reserve -- ${cwd} PlumRaven paths`);
	expect(ended?.additionalContext).toContain("admitted under the parent seat's name PlumRaven");
	// A mixed chain names which call was rewritten and which was left unchanged.
	const mixed = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} child-99 x && am file_reservations release --agent-name Foo P A` } }, cwd);
	expect(commandOf(mixed)).toBe(`am file_reservations reserve ${cwd} PlumRaven x && am file_reservations release --agent-name Foo P A`);
	expect(mixed?.additionalContext).toContain("reserve");
	expect(mixed?.additionalContext).toContain("release");
	expect(mixed?.additionalContext).toContain("left unchanged");
});

test("MAILGUARDSLIM1 [a] redirects, newlines and non-head am are handled without guessing", async () => {
	const h = await createHost({ agent: { ...childAgent } });
	const cwd = fleetRepo();
	// Planted negative vs the pre-fix walker: a redirect target counted as a positional, a `\n`
	// call was folded into the previous one, and `echo am ...` was rewritten.
	const redirected = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve > /tmp/out ${cwd} child-99` } }, cwd);
	expect(redirected?.block).not.toBe(true);
	expect(commandOf(redirected)).toBe("");
	expect(redirected?.additionalContext).toContain("AM_CHILD_RESERVATION_NOTICE");
	expect(redirected?.additionalContext).toContain("reserve");
	expect(redirected?.additionalContext).toContain("left unchanged");
	const fdDup = await h.call({ toolName: "bash", input: { command: `am file_reservations release ${cwd} child-99 --ids 3 2>/tmp/err` } }, cwd);
	expect(commandOf(fdDup)).toBe(`am file_reservations release ${cwd} PlumRaven --ids 3 2>/tmp/err`);
	// A redirect after the agent is identified does not disturb the rewrite.
	const trailing = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} child-99 x > /tmp/out` } }, cwd);
	expect(commandOf(trailing)).toBe(`am file_reservations reserve ${cwd} PlumRaven x > /tmp/out`);
	// Newline-separated calls are judged as two calls: both rewritten, both named.
	const twoLines = await h.call({ toolName: "bash", input: { command: `am file_reservations reserve ${cwd} child-99 x\nam file_reservations release ${cwd} child-99 --ids 3` } }, cwd);
	expect(commandOf(twoLines)).toBe(`am file_reservations reserve ${cwd} PlumRaven x\nam file_reservations release ${cwd} PlumRaven --ids 3`);
	expect(twoLines?.additionalContext).toContain("reserve");
	expect(twoLines?.additionalContext).toContain("release");
	// `am` as an argument is never a command head; VAR=, sudo and env prefixes still are.
	expect(await h.call({ toolName: "bash", input: { command: "echo am file_reservations reserve /proj child-99" } }, cwd)).toBeUndefined();
	const sudoed = await h.call({ toolName: "bash", input: { command: `sudo am file_reservations reserve ${cwd} child-99 x` } }, cwd);
	expect(commandOf(sudoed)).toContain("PlumRaven");
	const enved = await h.call({ toolName: "bash", input: { command: `FOO=1 env BAR=2 am file_reservations reserve ${cwd} child-99 x` } }, cwd);
	expect(commandOf(enved)).toContain("PlumRaven");
});

test("MAILGUARDSLIM1 [a] a child's register and send calls are refused once with no further command to run", async () => {
	const h = await createHost({ agent: { ...childAgent } });
	const cwd = fleetRepo();
	for (const [tool, args] of [
		["register_agent", { project_key: BACKEND, program: "omp", model: "test", name: "PlumRaven" }],
		["macro_start_session", { human_key: BACKEND, program: "omp", model: "test", agent_name: "PlumRaven" }],
		["send_message", send()],
		["reply_message", reply()],
	] as const) {
		const refused = await h.mail(cwd, tool, args);
		expect(code(refused)).toBe("AM_IDENTITY_MISMATCH");
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("native register and mail calls are not admitted");
		expect(refused?.reason).toContain("Report to the parent instead");
		// No register/send advice that leads to a second refusal.
		expect(refused?.reason).not.toMatch(/run register_agent|run `|send mail from|macro_start_session for/);
	}
});

test("MAILGUARDSLIM1-notice [b] a notice never skips the secret scan", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	const leak = (body_md: string) => body_md.replace("CREDENTIAL", `${secretName}=${secretValue}`);
	// Planted negative: a demoted finding that returned early would let the secret through.
	const shapes: Array<[string, Record<string, unknown>]> = [
		["free-text subject", send({ subject: "a status update", body_md: leak("note CREDENTIAL here") })],
		["over-cap body", send({ subject: `PROGRESS ${BEAD}: x`, body_md: `commit ${PUBLISHED_TEST_SHA}\n` + leak("x".repeat(AM_BODY_CAP) + " CREDENTIAL") })],
		["ack on status", send({ subject: `DONE ${BEAD}: x`, ack_required: true, body_md: leak("done CREDENTIAL") })],
		["ack on reply", reply({ ack_required: true, body_md: leak("looping CREDENTIAL") })],
		["unresolvable ask", send({ subject: "QUESTION ompkit-zzzz: which?", ack_required: true, body_md: leak("ask CREDENTIAL") })],
	];
	for (const [shape, args] of shapes) {
		const tool = shape === "ack on reply" ? "reply_message" : "send_message";
		const refused = await h.mail(cwd, tool, args);
		expect(code(refused)).toBe("AM_BODY_SECRET");
		expect(JSON.stringify(refused)).not.toContain(secretValue);
	}
});

test("MAILGUARDSLIM1-notice [b] over-frequent fetch and stripped registration admit with kind-notice rows", async () => {
	let clock = 2_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	expect(await h.mail(cwd, "fetch_inbox", fetch)).toBeUndefined();
	clock += 1;
	const noticed = await h.mail(cwd, "fetch_inbox", fetch);
	expect(code(noticed)).toBeUndefined();
	expect(noticed?.additionalContext).toContain("AM_INBOX_NOTICE");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_INBOX_NOTICE", kind: "notice" });
	const registered = await h.mail(cwd, "register_agent",
		{ project_key: BACKEND, program: "omp", model: "test", name: "PlumRaven", unexpected_registration_key: true });
	expect(code(registered)).toBeUndefined();
	expect(registered?.additionalContext).toContain("AM_REGISTRATION_NOTICE");
	expect(stampedArgs(registered)).not.toHaveProperty("unexpected_registration_key");
	expect(h.notices.at(-1)).toMatchObject({ gate: "AM_REGISTRATION_NOTICE", kind: "notice" });
	expect(h.notices.every(row => row.kind === "notice")).toBe(true);
});

test("MAILGUARDSLIM1-kept [c] sending, reserving or registering as another seat still refuses", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	// Planted negative: sending as another seat would pass if the identity check were demoted.
	expect(code(await h.mail(cwd, "send_message", send({ sender_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "reply_message", reply({ sender_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "file_reservation_paths", reserveArgs({ agent_name: "BlueLake" })))).toBe("AM_IDENTITY_MISMATCH");
	expect(code(await h.mail(cwd, "register_agent", { project_key: BACKEND, program: "omp", model: "test", name: "BlueLake" }))).toBe("AM_IDENTITY_MISMATCH");
});

test("MAILGUARDSLIM1-kept [c] a typed inner refusal surfaces under its own code, never AM_GUARD_FAILED", async () => {
	const cwd = fleetRepo();
	// An inner AM_* failure (here from the wake) surfaces under its own code.
	const typed = await createHost({ mailWake: { beforeSend: async () => { throw new Error("AM_ROSTER_UNAVAILABLE: wake ledger down"); }, afterSend: async e => e } });
	expect(code(await typed.mail(cwd, "send_message", send()))).toBe("AM_ROSTER_UNAVAILABLE");
	// Only a genuine failure keeps AM_GUARD_FAILED.
	const genuine = await createHost({ mailWake: { beforeSend: async () => { throw new Error("wake exploded"); }, afterSend: async e => e } });
	const failed = await genuine.mail(cwd, "send_message", send());
	expect(code(failed)).toBe("AM_GUARD_FAILED");
	expect(failed?.reason).toContain("wake exploded");
});

test("MAILGUARDSLIM1-kept [c] every kept hazard refusal still refuses under its own code", async () => {
	const cwd = fleetRepo();
	const h = await createHost();
	expect(code(await h.mail(cwd, "mark_all_read", { project_key: BACKEND, agent_name: "PlumRaven" }))).toBe("AM_BULK_READ");
	expect(code(await h.mail(cwd, "send_message", send({ to: ["NobodyHere"], cc: [] })))).toBe("AM_PHANTOM_REFUSED");
	expect(code(await h.mail(cwd, "send_message", send({ body_md: "Done; no commit cited." })))).toBe("AM_DONE_NOT_PUBLISHED");
	expect(code(await h.mail(cwd, "send_message", send({ project_key: "/abs/path/missing", to: ["BlueLake"], cc: [] })))).toBe("AM_ROSTER_UNAVAILABLE");
	expect(code(await h.call({ toolName: "write", input: { path: `${MAIL}send_message`, content: "{not json" } }, cwd))).toBe("AM_ARGS_UNREADABLE");
	expect(code(await h.mail(cwd, "send_message", send(), null))).toBe("AM_CALL_ID_REQUIRED");
	expect(code(await (await createHost({ secretRulePath: join(base, "no-such-rule.md") })).mail(cwd, "send_message", send()))).toBe("AM_SCANNER_UNAVAILABLE");
	const anonymous = await createHost({ env: {}, home: freshDir(base, "mailguard-anon-") });
	expect(code(await anonymous.mail(cwd, "send_message", send({ sender_name: "RedCat" })))).toBe("IDENTITY_UNBOUND");
	expect(code(await h.mail(fleetRepo(), "send_message", send({ sender_name: undefined })))).toBe("AM_IDENTITY_MISMATCH");
});

/**
 * SESSIONREBIND1 (ompkit-1ra0d.156): after an in-pane session change Tern still reports the old
 * omp_session_file for the lead's pane, so exact-match binding misses the caller's own live pane
 * and every send and register_agent is refused IDENTITY_UNBOUND. The caller rebinds to its own
 * pane only: TERN_PANE names the live block and that block's recorded file sits in the same profile
 * directory as the process's session file. Another pane claiming the new session stays refused.
 */
function rebindSeat(ternPane: string | null) {
	const recipient = fleetRepo();
	const home = freshDir(base, "rebind-");
	const sessionCwd = freshDir(base, "rebind-cwd-");
	const profileDir = join(home, "sessions", "-Developer");
	mkdirSync(profileDir, { recursive: true });
	const oldFile = join(profileDir, "2026-10-30T12-31-48-640Z_01a18ccb-7da0-7214-b51b-de1a4b4bf039.jsonl");
	const newFile = join(profileDir, "2026-11-11T13-20-39-903Z_01a1cac4-87df-71e9-b05a-92d9582e1fb2.jsonl");
	writeFileSync(oldFile, "");
	writeFileSync(newFile, "");
	const identityDir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(recipient).digest("hex").slice(0, 12));
	mkdirSync(identityDir, { recursive: true });
	writeFileSync(join(identityDir, "tern-91"), JSON.stringify({ name: "PlumRaven" }));
	// Block 92 is a live seat in the recipient repo bound to PlumRaven too, so test [b] pins the
	// profile-directory check: without it, pane 92 claiming the new session would rebind and send.
	writeFileSync(join(identityDir, "tern-92"), JSON.stringify({ name: "PlumRaven" }));
	const otherDir = freshDir(base, "rebind-other-");
	const otherFile = join(otherDir, "other.jsonl");
	writeFileSync(otherFile, "");
	const respond = fleetRespond({ [recipient]: [mailRow("PlumRaven"), mailRow("BlueLake"), mailRow("RedCat")] });
	const tern = JSON.stringify({
		sessions: [{ tabs: [{ name: "fixture", blocks: [{ id: 91, cwd: sessionCwd, live: true }, { id: 92, cwd: recipient, live: true }] }] }],
		panes: [
			{ pane: 91, cwd: sessionCwd, omp_session_file: oldFile },
			{ pane: 92, cwd: recipient, omp_session_file: otherFile },
		],
	});
	const env: Record<string, string | undefined> = ternPane === null
		? { AGENT_NAME: "PlumRaven" }
		: { AGENT_NAME: "PlumRaven", TERN_PANE: ternPane };
	const host = () => createHost({ home, env, sessionFile: newFile, mailWake: undefined },
		call => call.command === "tern" ? { code: 0, stdout: tern, stderr: "" } : respond(call));
	return { recipient, sessionCwd, host };
}

test("SESSIONREBIND1 [a] a caller whose pane record names the previous session file still sends and registers", async () => {
	const seat = rebindSeat("91");
	const h = await seat.host();
	expect(await h.mail(seat.sessionCwd, "send_message", send({ project_key: seat.recipient, to: ["BlueLake"], cc: [] }), "rebind-send")).toBeUndefined();
	const registered = await h.mail(seat.sessionCwd, "register_agent",
		{ project_key: seat.recipient, program: "omp", model: "test", name: "PlumRaven", task_description: "rebind", pane_id: "tern:91" });
	expect(code(registered)).toBeUndefined();
});

test("SESSIONREBIND1 [b] a different pane claiming the new session stays IDENTITY_UNBOUND", async () => {
	const seat = rebindSeat("92");
	const h = await seat.host();
	const refused = await h.mail(seat.sessionCwd, "send_message",
		send({ project_key: seat.recipient, sender_name: "PlumRaven", to: ["BlueLake"], cc: [] }), "rebind-spoof");
	expect(code(refused)).toBe("IDENTITY_UNBOUND");
});

test("SESSIONREBIND1 planted: exact-match-only binding refuses the rebound caller", async () => {
	const seat = rebindSeat(null);
	const h = await seat.host();
	expect(code(await h.mail(seat.sessionCwd, "send_message",
		send({ project_key: seat.recipient, to: ["BlueLake"], cc: [] }), "rebind-planted"))).toBe("IDENTITY_UNBOUND");
});
