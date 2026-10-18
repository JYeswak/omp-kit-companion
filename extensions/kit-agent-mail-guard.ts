import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fleetPolicyState } from "./fleet-policy";
import {
	paneIdentities,
	readBeadState,
	type FlywheelContext,
	type FlywheelExec,
	type FlywheelToolCallEvent,
	type FlywheelToolCallResult,
	type TrackerRequest,
} from "./kit-flywheel-guard";

/**
 * kit-agent-mail-guard (AMGUARD1, ompkit-774u.13.2): a seat's Agent Mail calls are checked at the act.
 *
 * OMP routes an MCP call as a `write` to `xd://mcp__mcp_agent_mail_<tool>` whose `content` is the JSON
 * arguments. This guard reads that call before it runs and refuses:
 *   AM_IDENTITY_MISMATCH / AM_IDENTITY_UNKNOWN: send_message or reply_message whose sender_name is not the
 *     seat's own name (AGENT_NAME; with none, the Agent Mail pane identity of $TMUX_PANE).
 *   AM_SUBJECT_VOCAB: a send_message subject that does not start with the protocol vocabulary.
 *   AM_ACK_SUBJECT / AM_ACK_NO_BEAD / AM_ACK_BEAD_UNRESOLVED / AM_ACK_REPLY: ack_required true without a
 *     QUESTION, BLOCKED, APPROVAL, DECISION or HANDOFF subject that names a bead id `br show` resolves.
 *     reply_message carries no subject of its own (the server inherits the original's), so an explicit
 *     ack_required true on a reply cannot be verified and is refused.
 *   AM_BODY_TOO_LONG: a body over AM_BODY_CAP characters. Long evidence goes in a bead comment.
 *   AM_BODY_SECRET / AM_SCANNER_UNAVAILABLE: a body the kit secret scanner flags, or no scanner to ask.
 *   AM_BULK_READ: a bulk read tool, even if the server ever re-exposes one.
 *   AM_INBOX_RATE: a second fetch_inbox inside 60 s from the same seat (AMSTORM1).
 *   AM_ARGS_UNREADABLE: arguments of a guarded tool that do not parse; nothing is guessed.
 *
 * Inert unless the repo opted into the fleet (`.omp/fleet.json` {"enabled": true}, see fleet-policy.ts);
 * a stock session touches no br, tmux or Agent Mail. An opted-in repo whose marker is unreadable refuses
 * Agent Mail calls, as fleet-guard does.
 *
 * The secret scanner is the one behind the kit-no-plaintext-secret rule: its `condition` regexes are read
 * from `rules/kit-no-plaintext-secret.md` beside this extension and compiled as OMP does (plain RegExp),
 * so the rule and this guard cannot disagree. A missing or unparseable rule refuses (fail closed).
 *
 * Not done: injecting the seat's sender_token. A tool_call handler can replace the execution input
 * (ToolCallEventResult.input), so the mechanism exists, but no per-seat token store does: pane identity
 * files hold only the name, and AGENT_MAIL_TOKEN is the HTTP bearer, not a registration token.
 */

export const AM_BODY_CAP = 1800;
/** Minimum spacing between one seat's fetch_inbox calls. */
export const AM_INBOX_INTERVAL_MS = 60_000;
const MAX_BEAD_CANDIDATES = 5;
const MAIL_PREFIX = "mcp__mcp_agent_mail_";
const MAX_SUBJECT_SCAN = 300;
const SECRET_RULE_REL_PATH = "../rules/kit-no-plaintext-secret.md";

/** Subjects that may carry ack_required: a real ask. */
export const ACK_VOCABULARY: Record<string, true> = { QUESTION: true, BLOCKED: true, APPROVAL: true, DECISION: true, HANDOFF: true };
/** Every subject starts with one of these (the callback vocabulary, plus the ack asks). */
export const SUBJECT_VOCABULARY: Record<string, true> = {
	...ACK_VOCABULARY, DONE: true, CLOSED: true, REWORK: true, PROGRESS: true, "NO-WORK": true, REPORT: true,
};
/** Bulk read tools; the pattern below also catches a renamed one. */
const BULK_READ_TOOLS: Record<string, true> = { mark_all_read: true, fetch_inbox_product: true, fetch_topic: true };
const BULK_READ_PATTERN = /(?:^|_)(?:mark_all|all_read|read_all|fetch_all|bulk)(?:_|$)/;

export interface AgentMailGuardApi {
	on(event: "tool_call", handler: (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown): void;
	exec: FlywheelExec;
}

export interface AgentMailGuardDeps {
	env?: Record<string, string | undefined>;
	home?: string;
	/** Clock in ms, injectable so the 60 s spacing is testable. */
	now?: () => number;
	/** Rule file holding the secret scanner's conditions; defaults to the one shipped beside this extension. */
	secretRulePath?: string;
}

function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function refuse(code: string, text: string): FlywheelToolCallResult {
	return { block: true, reason: `kit-agent-mail-guard ${code}: ${text} Nothing was sent.` };
}

type MailCall = { tool: string; args: { ok: true; value: unknown } | { ok: false; why: string } };

/** The Agent Mail tool a call targets, with its arguments, or null for every other tool call. */
function mailCall(event: FlywheelToolCallEvent): MailCall | null {
	const name = typeof event.toolName === "string" ? event.toolName.trim().toLowerCase() : "";
	let rest: string;
	let args: MailCall["args"];
	if (name === "write") {
		const path = prop(event.input, "path");
		if (typeof path !== "string") return null;
		const target = path.trim().toLowerCase();
		if (!target.startsWith(`xd://${MAIL_PREFIX}`)) return null;
		rest = target.slice(`xd://${MAIL_PREFIX}`.length);
		const content = prop(event.input, "content");
		if (typeof content === "string") {
			try { args = { ok: true, value: JSON.parse(content) }; }
			catch { args = { ok: false, why: "the JSON arguments do not parse" }; }
		} else if (typeof content === "object" && content !== null) args = { ok: true, value: content };
		else args = { ok: false, why: "the write carries no JSON arguments" };
	} else {
		const direct = name.startsWith("xd://") ? name.slice("xd://".length) : name;
		if (!direct.startsWith(MAIL_PREFIX)) return null;
		rest = direct.slice(MAIL_PREFIX.length);
		args = { ok: true, value: event.input };
	}
	const cut = rest.search(/[?#]/);
	let tool = cut < 0 ? rest : rest.slice(0, cut);
	while (tool.endsWith("/")) tool = tool.slice(0, -1);
	return { tool, args };
}

/** The `condition` regex sources of a rule file: single-quoted YAML scalars, exactly as OMP reads them. */
export function ruleConditions(markdown: string): string[] {
	const lines = markdown.replace(/\r/g, "").split("\n");
	if (lines[0] !== "---") throw new Error("rule has no frontmatter");
	const end = lines.indexOf("---", 1);
	if (end < 0) throw new Error("rule frontmatter is not closed");
	const at = lines.slice(1, end).indexOf("condition:");
	if (at < 0) throw new Error("rule has no condition list");
	const out: string[] = [];
	for (const line of lines.slice(2 + at, end)) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		const entry = /^\s+- '(.*)'$/.exec(line);
		if (entry === null) {
			if (/^\s+-/.test(line)) throw new Error("rule condition is not a single-quoted scalar");
			break;
		}
		out.push(entry[1]!.split("''").join("'"));
	}
	if (out.length === 0) throw new Error("rule condition list is empty");
	return out;
}

function beadCandidates(subject: string): string[] {
	const found = subject.slice(0, MAX_SUBJECT_SCAN).match(/(?<![A-Za-z0-9_.-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\.[0-9]+)*/g) ?? [];
	return [...new Set(found)].slice(0, MAX_BEAD_CANDIDATES);
}

/** The vocabulary word a subject starts with, or null. */
export function subjectLead(subject: string): string | null {
	const lead = /^[A-Z]+(?:-[A-Z]+)*(?![A-Za-z0-9_-])/.exec(subject)?.[0];
	return lead !== undefined && SUBJECT_VOCABULARY[lead] === true ? lead : null;
}

export default async function kitAgentMailGuard(pi: AgentMailGuardApi, deps: AgentMailGuardDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const now = deps.now ?? Date.now;
	const rulePath = deps.secretRulePath ?? join(dirname(fileURLToPath(import.meta.url)), SECRET_RULE_REL_PATH);
	let scanner: RegExp[] | null = null;
	let lastInbox: number | null = null;

	function secretScanner(): RegExp[] {
		scanner ??= ruleConditions(readFileSync(rulePath, "utf8")).map(source => new RegExp(source));
		return scanner;
	}

	async function seatNames(ctx: FlywheelContext, projectKey: unknown): Promise<string[]> {
		const named = env.AGENT_NAME?.trim();
		if (named) return [named];
		const keys = [ctx.cwd, ...(typeof projectKey === "string" && projectKey !== "" ? [projectKey] : [])];
		return paneIdentities(pi.exec, env, home, keys);
	}

	async function resolvesBead(subject: string, cwd: string): Promise<FlywheelToolCallResult | undefined> {
		const candidates = beadCandidates(subject);
		if (candidates.length === 0) {
			return refuse("AM_ACK_NO_BEAD", `ack_required needs the bead id the ask is about in the subject ("${subject.slice(0, 80)}" names none). Put the id after the vocabulary word, e.g. "QUESTION <bead-id>: ...".`);
		}
		const request: TrackerRequest = { bin: "br", ids: candidates, cwd, identities: [], operation: "claim", addLabels: [], actor: null, assignee: null, force: false };
		let why = "";
		for (const id of candidates) {
			const found = await readBeadState(pi.exec, request, id);
			if (found.ok) return undefined;
			why = found.why;
		}
		return refuse("AM_ACK_BEAD_UNRESOLVED", `no bead id in the subject resolves in this repo's tracker (${candidates.join(", ")}; last: ${why}). ack_required is for a real ask about a bead that exists.`);
	}

	async function checkMessage(tool: "send_message" | "reply_message", value: unknown, ctx: FlywheelContext): Promise<FlywheelToolCallResult | undefined> {
		const sender = prop(value, "sender_name");
		const names = await seatNames(ctx, prop(value, "project_key"));
		if (names.length === 0) {
			return refuse("AM_IDENTITY_UNKNOWN", "this seat has no identity (AGENT_NAME is unset and no Agent Mail pane identity names this pane), so sender_name cannot be checked. Launch the seat with AGENT_NAME set.");
		}
		if (typeof sender !== "string" || !names.some(name => name.toLowerCase() === sender.trim().toLowerCase())) {
			return refuse("AM_IDENTITY_MISMATCH", `sender_name ${typeof sender === "string" ? `"${sender}"` : "is missing"} is not this seat (${names.join(", ")}). Send as yourself; never as another agent.`);
		}
		const ack = prop(value, "ack_required");
		const ackOn = ack === true || (typeof ack === "string" && ack.trim().toLowerCase() === "true");
		if (tool === "send_message") {
			const subject = prop(value, "subject");
			const lead = typeof subject === "string" ? subjectLead(subject) : null;
			if (typeof subject !== "string" || lead === null) {
				return refuse("AM_SUBJECT_VOCAB", `the subject must start with one of ${Object.keys(SUBJECT_VOCABULARY).join(", ")} and name the bead id, e.g. "DONE <bead-id>: ..." (got "${typeof subject === "string" ? subject.slice(0, 80) : ""}").`);
			}
			if (ackOn) {
				if (ACK_VOCABULARY[lead] !== true) {
					return refuse("AM_ACK_SUBJECT", `ack_required is only for a real ask: start the subject with ${Object.keys(ACK_VOCABULARY).join(", ")} (got ${lead}). Status and FYI mail never needs an ack.`);
				}
				const unresolved = await resolvesBead(subject, ctx.cwd);
				if (unresolved !== undefined) return unresolved;
			}
		} else if (ackOn) {
			return refuse("AM_ACK_REPLY", "a reply has no subject of its own to check, so ack_required true cannot be verified. Omit it (the reply inherits the original's flag) or send a typed send_message naming the bead.");
		}
		const body = prop(value, "body_md");
		if (typeof body !== "string") return refuse("AM_ARGS_UNREADABLE", "body_md is missing or not a string.");
		if (body.length > AM_BODY_CAP) {
			return refuse("AM_BODY_TOO_LONG", `the body is ${body.length} characters, over the ${AM_BODY_CAP} cap. Put the evidence in a bead comment (br comments add <bead-id> ...) and send a short pointer.`);
		}
		let patterns: RegExp[];
		try { patterns = secretScanner(); }
		catch (error) {
			return refuse("AM_SCANNER_UNAVAILABLE", `the secret scanner rule (${rulePath}) cannot be loaded (${error instanceof Error ? error.message : String(error)}); a body that cannot be scanned is not sent.`);
		}
		if (patterns.some(pattern => pattern.test(body))) {
			return refuse("AM_BODY_SECRET", "the body holds what the secret scanner flags as a literal credential. Never mail a secret: name where it lives (Infisical key name) instead.");
		}
		return undefined;
	}

	pi.on("tool_call", async (event, ctx) => {
		const call = mailCall(event);
		if (call === null) return undefined;
		const bulk = BULK_READ_TOOLS[call.tool] === true || BULK_READ_PATTERN.test(call.tool);
		const guarded = bulk || call.tool === "send_message" || call.tool === "reply_message" || call.tool === "fetch_inbox";
		if (!guarded) return undefined;
		try {
			const policy = await fleetPolicyState(ctx.cwd);
			if (policy.kind === "off") return undefined;
			if (policy.kind === "unavailable") return refuse("AM_FLEET_POLICY", `the repo's fleet opt-in is unreadable (${policy.reason}).`);
			if (bulk) {
				return refuse("AM_BULK_READ", `${call.tool} is a bulk read. Read one message at a time (fetch_inbox with a small limit, or fetch one id); read state is not obligation state.`);
			}
			if (call.tool === "fetch_inbox") {
				const at = now();
				if (lastInbox !== null && at - lastInbox < AM_INBOX_INTERVAL_MS) {
					return refuse("AM_INBOX_RATE", `fetch_inbox ran ${Math.round((at - lastInbox) / 1000)} s ago; one fetch per ${AM_INBOX_INTERVAL_MS / 1000} s per seat. Wake on events instead of polling.`);
				}
				lastInbox = at;
				return undefined;
			}
			if (!call.args.ok) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: ${call.args.why}.`);
			return await checkMessage(call.tool === "send_message" ? "send_message" : "reply_message", call.args.value, ctx);
		} catch (error) {
			return refuse("AM_GUARD_FAILED", `the check failed (${error instanceof Error ? error.message : String(error)}).`);
		}
	});
}
