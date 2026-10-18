import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
} from "./kit-agent-mail-guard";
import type { FlywheelContext, FlywheelExecOptions, FlywheelExecResult, FlywheelToolCallEvent, FlywheelToolCallResult } from "./kit-flywheel-guard";

const base = mkdtempSync(join(tmpdir(), "kit-agent-mail-guard-"));
afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

const MAIL = "xd://mcp__mcp_agent_mail_";
const BEAD = "ompkit-1abc";

interface ExecCall { command: string; args: string[]; options?: FlywheelExecOptions }
type Responder = (call: ExecCall) => FlywheelExecResult | Promise<FlywheelExecResult>;
type ToolHandler = (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown;

interface Host {
	call(event: FlywheelToolCallEvent, cwd: string): Promise<FlywheelToolCallResult | undefined>;
	/** A `write` to xd://mcp__mcp_agent_mail_<tool>, the way OMP routes an MCP call. */
	mail(cwd: string, tool: string, args: unknown): Promise<FlywheelToolCallResult | undefined>;
	execs: ExecCall[];
}

/** Known beads answer `br show`; any other id misses the way br 0.7.4 does (JSON error on stdout, exit 3). */
function brKnows(...ids: string[]): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		const id = call.args[1] ?? "";
		if (call.command === "br" && call.args[0] === "show" && ids.includes(id)) {
			return { stdout: JSON.stringify([{ id, title: "t", status: "open", assignee: null }]), stderr: "", code: 0 };
		}
		return { stdout: JSON.stringify({ error: { code: "ISSUE_NOT_FOUND", message: `Issue not found: ${id}` } }), stderr: "", code: 3 };
	};
}

async function createHost(deps: AgentMailGuardDeps = {}, respond: Responder = brKnows(BEAD)): Promise<Host> {
	const handlers: ToolHandler[] = [];
	const execs: ExecCall[] = [];
	const pi: AgentMailGuardApi = {
		on: (_event, handler) => void handlers.push(handler),
		exec: async (command, args, options) => {
			const call = { command, args, options };
			execs.push(call);
			return respond(call);
		},
	};
	await kitAgentMailGuard(pi, { env: { AGENT_NAME: "PlumRaven" }, home: join(base, "no-home"), ...deps });
	const call: Host["call"] = async (event, cwd) => {
		const ctx: FlywheelContext = { cwd, isIdle: () => true };
		let result: unknown;
		for (const handler of handlers) result = (await handler({ type: "tool_call", toolCallId: "c1", ...event }, ctx)) ?? result;
		return result as FlywheelToolCallResult | undefined;
	};
	const mail: Host["mail"] = (cwd, tool, args) =>
		call({ toolName: "write", input: { path: `${MAIL}${tool}`, content: JSON.stringify(args) } }, cwd);
	return { call, mail, execs };
}

function gitInit(parent: string): string {
	const cwd = mkdtempSync(join(parent, "repo-"));
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
	return cwd;
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
		subject: `DONE ${BEAD}: landed`, body_md: "Landed; evidence is in the bead comment.",
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
	const home = mkdtempSync(join(base, "home-"));
	const dir = join(home, ".config", "agent-mail", "identity", createHash("sha1").update(cwd).digest("hex").slice(0, 12));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "7"), JSON.stringify({ name: "RedCat" }));
	const paned = await createHost({ env: { TMUX_PANE: "%7" }, home });
	expect(await paned.mail(cwd, "send_message", send({ sender_name: "RedCat" }))).toBeUndefined();
	expect(code(await paned.mail(cwd, "send_message", send({ sender_name: "PlumRaven" })))).toBe("AM_IDENTITY_MISMATCH");
	const anonymous = await createHost({ env: {}, home });
	expect(code(await anonymous.mail(cwd, "send_message", send({ sender_name: "RedCat" })))).toBe("AM_IDENTITY_UNKNOWN");
	// An AGENT_NAME wins over a pane identity: the explicit launch name is the seat.
	const both = await createHost({ env: { AGENT_NAME: "BlueLake", TMUX_PANE: "%7" }, home });
	expect(code(await both.mail(cwd, "send_message", send({ sender_name: "RedCat" })))).toBe("AM_IDENTITY_MISMATCH");
});

// --- subject vocabulary ------------------------------------------------------------------------

test("subject: every vocabulary word passes, free text and near misses are refused", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	for (const word of Object.keys(SUBJECT_VOCABULARY)) {
		expect(await h.mail(cwd, "send_message", send({ subject: `${word} ${BEAD}: x` }))).toBeUndefined();
		expect(subjectLead(`${word}: x`)).toBe(word);
	}
	for (const subject of ["Plan for /api/users", "", "done ompkit-1abc: x", "DONEZO ompkit-1abc", "DONE-ish ompkit-1abc", " DONE ompkit-1abc", "[DONE] ompkit-1abc"]) {
		const refused = await h.mail(cwd, "send_message", send({ subject }));
		expect(code(refused)).toBe("AM_SUBJECT_VOCAB");
	}
	expect(code(await h.mail(cwd, "send_message", send({ subject: undefined })))).toBe("AM_SUBJECT_VOCAB");
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

test("ack_required: an in-vocabulary but non-ask subject is refused, the same send without ack passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ subject: `DONE ${BEAD}: x`, ack_required: false }))).toBeUndefined();
	expect(code(await h.mail(cwd, "send_message", send({ subject: `DONE ${BEAD}: x`, ack_required: true })))).toBe("AM_ACK_SUBJECT");
	expect(code(await h.mail(cwd, "send_message", send({ subject: `PROGRESS ${BEAD}: x`, ack_required: "true" })))).toBe("AM_ACK_SUBJECT");
	expect(h.execs.filter(call => call.command === "br")).toEqual([]);
});

test("ack_required: a typed subject with no bead id, or an id the tracker does not resolve, is refused", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ subject: `QUESTION ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
	expect(code(await h.mail(cwd, "send_message", send({ subject: "QUESTION which database?", ack_required: true })))).toBe("AM_ACK_NO_BEAD");
	const unresolved = await h.mail(cwd, "send_message", send({ subject: "QUESTION ompkit-zzzz: which?", ack_required: true }));
	expect(code(unresolved)).toBe("AM_ACK_BEAD_UNRESOLVED");
	expect(unresolved?.reason).toContain("Issue not found");
	// A word that merely looks like an id does not stop a real id later in the subject from resolving.
	expect(await h.mail(cwd, "send_message", send({ subject: `QUESTION re-run ${BEAD}: which?`, ack_required: true }))).toBeUndefined();
});

test("ack_required: an unreadable tracker fails closed (br missing, br throwing, br garbage)", async () => {
	const cwd = fleetRepo();
	const subject = `BLOCKED ${BEAD}: need a decision`;
	const down: Responder[] = [
		() => ({ stdout: "", stderr: "br: command not found", code: 127 }),
		() => { throw new Error("spawn br ENOENT"); },
		() => ({ stdout: "not json", stderr: "", code: 0 }),
	];
	for (const respond of down) {
		const h = await createHost({}, respond);
		expect(code(await h.mail(cwd, "send_message", send({ subject, ack_required: true })))).toBe("AM_ACK_BEAD_UNRESOLVED");
		// Without ack_required the tracker is never asked, so an outage does not stop status mail.
		expect(await h.mail(cwd, "send_message", send({ subject: `DONE ${BEAD}: x` }))).toBeUndefined();
	}
});

test("ack_required: a reply cannot assert it (no subject to check); omitted or false passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "reply_message", reply())).toBeUndefined();
	expect(await h.mail(cwd, "reply_message", reply({ ack_required: false }))).toBeUndefined();
	expect(code(await h.mail(cwd, "reply_message", reply({ ack_required: true })))).toBe("AM_ACK_REPLY");
});

// --- shape ---------------------------------------------------------------------------------------

test("body: the cap is inclusive; one character over is refused and points at a bead comment", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(AM_BODY_CAP).toBe(1800);
	expect(await h.mail(cwd, "send_message", send({ body_md: "x".repeat(AM_BODY_CAP) }))).toBeUndefined();
	const refused = await h.mail(cwd, "send_message", send({ body_md: "x".repeat(AM_BODY_CAP + 1) }));
	expect(code(refused)).toBe("AM_BODY_TOO_LONG");
	expect(refused?.reason).toContain("bead comment");
	expect(await h.mail(cwd, "reply_message", reply({ body_md: "x".repeat(AM_BODY_CAP) }))).toBeUndefined();
	expect(code(await h.mail(cwd, "reply_message", reply({ body_md: "x".repeat(AM_BODY_CAP + 1) })))).toBe("AM_BODY_TOO_LONG");
	expect(code(await h.mail(cwd, "send_message", send({ body_md: undefined })))).toBe("AM_ARGS_UNREADABLE");
});

// Built at run time so this file never holds a literal credential.
const secretName = ["GITHUB", "PAT"].join("_");
const secretValue = ["ghp1fake2abc", "3def4ghi5jkl6"].join("");

test("body: the kit secret scanner refuses a literal credential; a placeholder passes", async () => {
	const h = await createHost();
	const cwd = fleetRepo();
	expect(await h.mail(cwd, "send_message", send({ body_md: `Set ${secretName}=$${secretName} from Infisical.` }))).toBeUndefined();
	const refused = await h.mail(cwd, "send_message", send({ body_md: `run: export ${secretName}=${secretValue}` }));
	expect(code(refused)).toBe("AM_BODY_SECRET");
	expect(refused?.reason).not.toContain(secretValue);
	expect(code(await h.mail(cwd, "reply_message", reply({ body_md: `${secretName}=${secretValue}` })))).toBe("AM_BODY_SECRET");
	expect(await h.mail(cwd, "send_message", send({ body_md: "Authorization: Bearer ${FOO_TOKEN}" }))).toBeUndefined();
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

test("reads: one fetch_inbox per 60 s per seat; a refused call does not restart the window", async () => {
	let clock = 1_000_000;
	const h = await createHost({ now: () => clock });
	const cwd = fleetRepo();
	const fetch = { project_key: "/abs/path/backend", agent_name: "PlumRaven", limit: 1, include_bodies: true, mark_read: false };
	expect(await h.mail(cwd, "fetch_inbox", fetch)).toBeUndefined();
	clock += AM_INBOX_INTERVAL_MS / 2;
	expect(code(await h.mail(cwd, "fetch_inbox", fetch))).toBe("AM_INBOX_RATE");
	clock += AM_INBOX_INTERVAL_MS / 2 - 1;
	expect(code(await h.mail(cwd, "fetch_inbox", fetch))).toBe("AM_INBOX_RATE");
	clock += 1;
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
