import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
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
import { createMailWake, type MailCaller, type MailToolResultEvent, type MailWake } from "./kit-mail-wake";
import { checkPublishedCommits, extractCitedCommitReferences, type PublishedCommitStatus } from "./kit-published-commit.ts";
import { recordGateEvent } from "./gate-events.ts";
import { seatIdentity } from "../src/fleet-guard/write-own.ts";
import { shellTokenSpans, shellTokens } from "../src/fleet-guard/scratch.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";

/**
 * kit-agent-mail-guard (AMGUARD1, ompkit-774u.13.2): a seat's Agent Mail calls are checked at the act.
 *
 * OMP routes an MCP call as a `write` to `xd://mcp__mcp_agent_mail_<tool>` whose `content` is the JSON
 * arguments. This guard checks that call before it runs. Hazardous acts are refused:
 *   AM_IDENTITY_MISMATCH / AM_IDENTITY_UNKNOWN: send_message or reply_message whose sender_name is not the
 *     seat's own name (AGENT_NAME; with none, the Agent Mail pane identity of $TMUX_PANE). A background
 *     child's native mail calls are not admitted: one AM_IDENTITY_MISMATCH refusal tells the child to
 *     report to the parent instead. Shell `am` calls are not judged here. The reservation
 *     tools (file_reservation_paths, renew_file_reservations,
 *     release_file_reservations) and the reservation macro (macro_file_reservation_cycle) carry
 *     the caller as agent_name and have no sender_name; a child's call is rewritten to its parent
 *     seat's name (WRITEOWNCHILD1 seatIdentity, no second resolution) and admitted with an
 *     AM_CHILD_RESERVATION_NOTICE. Another seat's name there is refused, and a missing agent_name
 *     is refused naming agent_name (AMRENEW1).
 *   AM_BODY_SECRET / AM_SCANNER_UNAVAILABLE: a body the kit secret scanner flags, or no scanner to ask.
 *   AM_BULK_READ: a bulk read tool, even if the server ever re-exposes one.
 *   AM_ARGS_UNREADABLE: arguments of a guarded tool that do not parse, or a registration whose project
 *     key is not absolute; nothing is guessed.
 *   AM_PHANTOM_REFUSED: a send_message whose recipient is not registered under project_key. The
 *     error names the projects where the name IS registered (a deadline-bounded roster scan), or
 *     says it is registered nowhere; nothing is sent and no recipient is created (AMPHANTOM1).
 *     The project key is the RECIPIENT's repo path.
 *   AM_SENDER_COLLISION: sender_name names a different runtime's registration in the target
 *     project (program differs from the seat's own registration): refused, naming both.
 *   AM_ROSTER_UNAVAILABLE: the target roster cannot be read; an unchecked send could create a
 *     phantom, so the send is refused instead of guessed.
 *   AM_PROJECT_AMBIGUOUS (warning, sent anyway): the recipient is registered in more than one
 *     project and the target is not the most recently active one; names each project's last
 *     activity.
 *   AM_DONE_NOT_PUBLISHED: a send_message whose subject starts with DONE must cite commit SHA(s)
 *     reachable from freshly fetched origin/main. Plain citations use project_key; explicit
 *     absolute-repository `path@SHA` citations are checked in that source repository.
 *   AM_BODY_OVERFLOW (AMGUARDSOFT1, ompkit-1ra0d.167): a body over the cap is completed, not
 *     refused. The full text is stored in an owned bounded overflow file (attached via
 *     attachment_paths) and the send carries the first cap characters plus a one-line pointer,
 *     with an AM_BODY_NOTICE. AM_BODY_TOO_LONG is retired: no body length refuses.
 * Reversible acts are admitted with a one-line AM_*_NOTICE and one gate-events row with kind notice,
 * never kind refuse (MAILGUARDSLIM1, AMGUARDSOFT1): a non-vocabulary subject (AM_SUBJECT_NOTICE),
 * an ack_required the subject cannot carry (dropped by rewriteArgs, AM_ACK_NOTICE), an ask whose bead
 * id does not resolve (sent with ack kept, AM_ACK_BEAD_NOTICE), a fetch_inbox inside the per-agent
 * per-project window (admitted with an AM_INBOX_NOTICE naming its age and the next allowed time;
 * a since_ts newer than the last fetch passes clean; AM_INBOX_RATE is retired), unknown registration
 * arguments (stripped by rewriteArgs, AM_REGISTRATION_NOTICE). A notice never
 * skips a later check (GATEDEMOTE1): the secret scan, roster, identity and DONE checks still run after
 * every notice, and a secret in a noticed body is still refused under AM_BODY_SECRET. An inner typed
 * refusal surfaces under its own code; only a genuine failure keeps AM_GUARD_FAILED.
 * Inert unless the repo opted into the fleet (`.omp/fleet.json` {"enabled": true}, see fleet-policy.ts);
 * a stock session touches no br, tmux or Agent Mail. An opted-in repo whose marker is unreadable refuses
 * Agent Mail calls, as fleet-guard does.
 *
 * The secret scanner is the one behind the kit-no-plaintext-secret rule: its `condition` regexes are read
 * from `rules-fleet/kit-no-plaintext-secret.md` beside this extension and compiled as OMP does (plain RegExp),
 * so the rule and this guard cannot disagree. A missing or unparseable rule refuses (fail closed).
 *
 * A send that passes every check runs with the seat's sender_token injected when one is
 * registered: AGENT_MAIL_SENDER_TOKEN (the token the seat's registration minted, the same
 * variable `am mail send` honors) fills a missing sender_token via ToolCallEventResult.input,
 * which OMP revalidates and executes. Only the seat's own sender_name is ever stamped, an
 * explicit token is never overridden, and the token never appears in a reason string.
 */

export const AM_BODY_CAP = 1800;
/** Longest body stored whole in one overflow file; a longer body is stored truncated with a marker. */
export const AM_BODY_STORE_MAX = 512 * 1024;
/** Overflow-file retention per guard instance: oldest files are evicted past either bound. */
export const AM_OVERFLOW_KEEP_FILES = 32;
export const AM_OVERFLOW_KEEP_BYTES = 4 * 1024 * 1024;
/** Minimum spacing between one seat's fetch_inbox calls, per agent and project. */
export const AM_INBOX_INTERVAL_MS = 60_000;
const MAX_BEAD_CANDIDATES = 5;
const MAIL_PREFIX = "mcp__mcp_agent_mail_";
const MAX_SUBJECT_SCAN = 300;
/** `am agents list` timeout per call: a roster that cannot be read fails the send closed. */
const AM_ROSTER_TIMEOUT_MS = 10_000;
/** Per-fetch timeout inside the cross-project scan. */
const AM_SCAN_FETCH_TIMEOUT_MS = 5_000;
/** Total budget for one cross-project recipient scan; coverage past the budget is reported, not guessed. */
const AM_SCAN_BUDGET_MS = 6_000;
/** Target-roster cache TTL per guard instance (a just-registered name is re-read on a miss). */
const AM_ROSTER_TTL_MS = 60_000;
/** Completed cross-project scan cache TTL per guard instance. */
const AM_SCAN_TTL_MS = 120_000;
const SECRET_RULE_REL_PATH = "../rules-fleet/kit-no-plaintext-secret.md";

// The native registration schemas: reject unknown keys before a server can silently discard them.
const REGISTRATION_KEYS: Record<string, Readonly<Record<string, true>>> = {
	register_agent: {
		project_key: true, program: true, model: true, name: true, task_description: true,
		registration_proof: true, pane_id: true, tmux_socket_path: true, attachments_policy: true, reaper_exempt: true,
	},
	macro_start_session: {
		human_key: true, program: true, model: true, agent_name: true, task_description: true,
		pane_id: true, registration_proof: true, tmux_socket_path: true, reaper_exempt: true,
		file_reservation_paths: true, file_reservation_ttl_seconds: true, file_reservation_reason: true, inbox_limit: true,
	},
};

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
	on(event: "tool_result", handler: (event: MailToolResultEvent, ctx: FlywheelContext) => unknown): void;
	exec: FlywheelExec;
}

/** The two kit-mail-wake entry points the guard drives around one send. */
export type MailWakeHooks = Pick<MailWake, "beforeSend" | "afterSend"> & Partial<Pick<MailWake, "caller">>;

export interface AgentMailGuardDeps {
	env?: Record<string, string | undefined>;
	home?: string;
	/** Clock in ms, injectable so the 60 s spacing is testable. */
	now?: () => number;
	/** Rule file holding the secret scanner's conditions; defaults to the one shipped beside this extension. */
	secretRulePath?: string;
	/** Agent Mail CLI binary; defaults to `am` on PATH. */
	amBin?: string;
	/** Cross-project scan budget in ms; defaults to AM_SCAN_BUDGET_MS. */
	scanBudgetMs?: number;
	/** The mail wake (MAILWAKE1); defaults to createMailWake over pi.exec. Injectable for tests. */
	mailWake?: MailWakeHooks;
	/** Overflow-file root; defaults to a per-instance ownedTmp dir (bounded, reaper-owned). Injectable so tests stay inside their tree. */
	overflowRoot?: string;
	/** Ledger writer for notice rows; defaults to the shared gate-events ledger. Injectable so tests never touch the live ledger. */
	recordEvent?: typeof recordGateEvent;
}

/** One registered agent row, as `am agents list -p <key> --json` returns it. */
interface MailRosterRow {
	name: string;
	program: string;
	model: string;
	task: string;
	lastActive: string;
}

/** One cross-project sighting of a name: the project key plus its roster row there. */
interface MailSight {
	project: string;
	program: string;
	model: string;
	task: string;
	lastActive: string;
}

function parseRosterRow(entry: unknown): MailRosterRow | null {
	const name = prop(entry, "name");
	if (typeof name !== "string" || name.trim() === "") return null;
	const program = prop(entry, "program");
	const model = prop(entry, "model");
	const task = prop(entry, "task_description") ?? prop(entry, "task");
	const lastActive = prop(entry, "last_active_ts") ?? prop(entry, "last_active");
	return {
		name: name.trim(),
		program: typeof program === "string" ? program : "",
		model: typeof model === "string" ? model : "",
		task: typeof task === "string" ? task : "",
		lastActive: typeof lastActive === "string" ? lastActive : "",
	};
}

/** Parse an `am agents list --json` payload (a bare array) into roster rows; null when not that shape. */
function parseRoster(payload: unknown): MailRosterRow[] | null {
	const list = Array.isArray(payload) ? payload : prop(payload, "agents");
	if (!Array.isArray(list)) return null;
	const rows: MailRosterRow[] = [];
	for (const entry of list) {
		const row = parseRosterRow(entry);
		if (row === null) return null;
		rows.push(row);
	}
	return rows;
}

function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function refuse(code: string, text: string): FlywheelToolCallResult {
	return { block: true, reason: `kit-agent-mail-guard ${code}: ${text} Nothing was sent.` };
}

/**
 * MAILGUARDSLIM1: a reversible act is admitted with a one-line notice. The act proceeds; the text
 * names the convention and the notice never skips a later check (GATEDEMOTE1).
 */
function notice(code: string, text: string): FlywheelToolCallResult {
	return { additionalContext: `kit-agent-mail-guard ${code}: ${text}` };
}

/** Verbs whose shell form carries the agent as a positional (PROJECT AGENT ...). */
const CHILD_RESERVATION_VERBS: Record<string, true> = { reserve: true, renew: true, release: true };

/** Emit an agent name into shell source: safe tokens bare, anything else single-quoted. */
function shellAgentWord(seat: string): string {
	return /^[A-Za-z0-9._-]+$/.test(seat) ? seat : `'${seat.split("'").join(`'\\''`)}'`;
}

/**
 * MAILGUARDSLIM1: agent-token indexes of the `am file_reservations <verb>` calls in a bash command.
 * Mirrors the positional grammars of bashReservationCalls/bashReleaseScope (PROJECT AGENT ... with
 * --ttl/--extend-seconds/--reason/--paths/--ids consuming the next word). Only unquoted heads count,
 * so echoed text never triggers. A call with ambiguous flags reports its verb with agent -1: the
 * caller admits it with a notice naming the seat instead of guessing a rewrite.
 */
interface ChildShellToken { text: string; quoted: boolean; span: { start: number; end: number } | null }

/**
 * shellTokens plus one `\n` marker per newline-bearing gap, for the guard's own
 * newline-separated-call handling. shellTokens itself is untouched: every other caller keeps its
 * whitespace folding. Null when the span map diverges from the token split.
 */
function childShellTokens(command: string): ChildShellToken[] | null {
	const tokens = shellTokens(command);
	const spans = shellTokenSpans(command);
	if (spans.length !== tokens.length || spans.some((span, index) => span.text !== tokens[index]!.text || span.quoted !== tokens[index]!.quoted)) return null;
	const out: ChildShellToken[] = [];
	let prevEnd = 0;
	for (let index = 0; index < tokens.length; index++) {
		const span = spans[index]!;
		if (command.slice(prevEnd, span.start).includes("\n")) out.push({ text: "\n", quoted: false, span: null });
		out.push({ text: tokens[index]!.text, quoted: tokens[index]!.quoted, span });
		prevEnd = span.end;
	}
	return out;
}

/** Separators after which a new command may start (single-char tokens, as shellTokens splits them). */
const CHILD_COMMAND_SEPARATORS: Record<string, true> = { ";": true, "&": true, "|": true, "(": true, "{": true, "\n": true };

/**
 * True when tokens[i] is the executed `am` command rather than an argument: at command start, or
 * after a separator, or after a chain of VAR= assignments and bare sudo/env prefixes. `echo am ...`
 * is never a head; an unrecognised sudo/env shape stops the prefix walk and the call is unjudged.
 */
function childCommandHeadAt(tokens: ChildShellToken[], i: number): boolean {
	const head = tokens[i]!;
	if (head.quoted || (head.text !== "am" && !head.text.endsWith("/am"))) return false;
	let j = i - 1;
	while (j >= 0) {
		const prev = tokens[j]!;
		if (!prev.quoted && (prev.text === "sudo" || prev.text === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prev.text))) { j--; continue; }
		break;
	}
	if (j < 0) return true;
	const before = tokens[j]!;
	return !before.quoted && CHILD_COMMAND_SEPARATORS[before.text] === true;
}

function childShellReservationAgents(command: string): { verb: string; agent: number }[] {
	const tokens = childShellTokens(command);
	return tokens === null ? [] : findReservationCalls(tokens);
}

function findReservationCalls(tokens: ChildShellToken[]): { verb: string; agent: number }[] {
	const found: { verb: string; agent: number }[] = [];
	for (let i = 0; i + 2 < tokens.length; i++) {
		if (!childCommandHeadAt(tokens, i)) continue;
		const scope = tokens[i + 1]!;
		if (scope.quoted || (scope.text !== "file_reservations" && scope.text !== "file-reservations")) continue;
		const verb = tokens[i + 2]!;
		if (verb.quoted || CHILD_RESERVATION_VERBS[verb.text] !== true) continue;
		const positionals: number[] = [];
		let ambiguous = false;
		let noMoreFlags = false;
		let j = i + 3;
		for (; j < tokens.length; j++) {
			const word = tokens[j]!;
			if (!word.quoted && /^(?:;|&&|\|\||\||&|\n)$/.test(word.text)) break;
			if (!word.quoted && (word.text === ">" || word.text === "<"
				|| (/^\d+$/.test(word.text) && j + 1 < tokens.length && !tokens[j + 1]!.quoted && (tokens[j + 1]!.text === ">" || tokens[j + 1]!.text === "<")))) {
				// A redirect target is never a positional (e.g. `> /tmp/out`, `2>&1`). The op
				// chars (`>&2`: ">", "&", "2") are consumed with it. Any redirect before the
				// agent is resolved makes the call ambiguous instead of a guessed rewrite.
				if (positionals.length < 2) ambiguous = true;
				let k = j + (/^\d+$/.test(word.text) ? 2 : 1);
				while (k < tokens.length && !tokens[k]!.quoted && (/^[><&|]$/.test(tokens[k]!.text) || /^\d+$/.test(tokens[k]!.text))) k++;
				j = k;
				if (j >= tokens.length || (!tokens[j]!.quoted && /^(?:;|&&|\|\||\||&|\n)$/.test(tokens[j]!.text))) j--;
				continue;
			}
			// A bare `--` ends flag parsing: everything after is positional. Any other
			// unrecognised dash flag may carry a space-separated value that would shift the
			// positionals (e.g. `--agent-name Foo PROJ AGENT`), so the call is ambiguous and
			// is never rewritten — a guessed positional could reserve under the wrong name.
			// Only the CLI's own documented flags are trusted: value flags consume the next
			// word, --shared/--exclusive/--help/-h take none.
			if (!word.quoted && !noMoreFlags && word.text === "--") { noMoreFlags = true; continue; }
			if (!word.quoted && !noMoreFlags && ["--ttl", "--extend-seconds", "--reason", "--paths", "--ids"].includes(word.text)) { j++; continue; }
			if (!word.quoted && !noMoreFlags && (word.text === "--shared" || word.text === "--exclusive" || word.text === "--help" || word.text === "-h")) continue;
			if (!word.quoted && !noMoreFlags && word.text.startsWith("-")) {
				if (!word.text.includes("=")) ambiguous = true;
				continue;
			}
			positionals.push(j);
		}
		i = j - 1;
		found.push({ verb: verb.text, agent: ambiguous || positionals.length < 2 ? -1 : positionals[1]! });
	}
	return found;
}

/**
 * MAILGUARDSLIM1: splice the seat name over each reservation call's agent token, preserving every
 * other byte. The span map is checked against the native shellTokens split (text and quoting of
 * every token); any divergence leaves that call unrewritten, never a guessed edit. Each call reports
 * its own outcome so the notice can say which call was rewritten and which was left unchanged.
 */
export type ChildShellCallOutcome = "rewrote" | "already-seat" | "ambiguous" | "span-mismatch";
export interface ChildShellCall { verb: string; agentText: string | null; outcome: ChildShellCallOutcome }
function rewriteChildShellAgents(command: string, seat: string): { command: string; calls: ChildShellCall[] } {
	const tokens = childShellTokens(command);
	if (tokens === null) return { command, calls: [] };
	const found = findReservationCalls(tokens);
	if (found.length === 0) return { command, calls: [] };
	const replacement = shellAgentWord(seat);
	let next = command;
	const calls: ChildShellCall[] = [];
	const edits: { start: number; end: number }[] = [];
	for (const call of found) {
		if (call.agent < 0) { calls.push({ verb: call.verb, agentText: null, outcome: "ambiguous" }); continue; }
		const token = tokens[call.agent]!;
		const span = token.span;
		if (span === null) { calls.push({ verb: call.verb, agentText: token.text, outcome: "span-mismatch" }); continue; }
		if (token.text === seat) { calls.push({ verb: call.verb, agentText: token.text, outcome: "already-seat" }); continue; }
		const inner = token.quoted ? sliceQuoted(next, span) : next.slice(span.start, span.end);
		if (inner === null || inner !== token.text) { calls.push({ verb: call.verb, agentText: token.text, outcome: "span-mismatch" }); continue; }
		edits.push(token.quoted
			? { start: span.start + 1, end: span.end - 1 }
			: { start: span.start, end: span.end });
		calls.push({ verb: call.verb, agentText: token.text, outcome: "rewrote" });
	}
	edits.sort((a, b) => b.start - a.start);
	for (const edit of edits) next = `${next.slice(0, edit.start)}${replacement}${next.slice(edit.end)}`;
	return { command: next, calls };
}

/**
 * The literal inside a quoted span: the quote characters themselves are the span edges, so the
 * inner slice must reproduce the token text exactly or the rewrite is aborted for that call.
 */
function sliceQuoted(source: string, span: { start: number; end: number }): string | null {
	if (span.end - span.start < 2) return null;
	const open = source[span.start];
	const close = source[span.end - 1];
	if ((open !== "'" && open !== '"') || open !== close) return null;
	return source.slice(span.start + 1, span.end - 1);
}

/** A proven caller plus `paneName`, the one name its block's pane identity files give it (MAILBIND1). */
type BoundCaller = MailCaller & { paneName: string | null };

/** Pane identity file body: `{"name":"X"}` (current Agent Mail writer) or one bare name (legacy). */
function identityFileName(path: string): string | null {
	try {
		if (!lstatSync(path).isFile()) return null;
		const text = readFileSync(path, "utf8").trim();
		if (text.startsWith("{")) {
			const name = prop(JSON.parse(text), "name");
			return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
		}
		const first = text.split("\n")[0]?.trim() ?? "";
		return first !== "" ? first : null;
	} catch {
		return null;
	}
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
	/**
	 * AMGUARDSOFT1: the last fetch_inbox per seat, keyed by agent+project (owner-only: a
	 * seat's window never covers another agent's fetches). The tool_call hook can block or
	 * rewrite input but cannot return a substitute result, so an in-window fetch is admitted
	 * (never refused) with a one-line note naming its age and the next allowed time.
	 */
	const lastInbox = new Map<string, { at: number; toolCallId: string | null }>();
	/**
	 * AMGUARDSOFT1: overflow-file retention per guard instance. The full body of one
	 * over-cap send lands in an owned (mode 0700 dir, 0600 file) bounded location: past
	 * AM_OVERFLOW_KEEP_FILES files or AM_OVERFLOW_KEEP_BYTES bytes the oldest are evicted.
	 * The dir is an ownedTmp root (autoCleanup false), so a live seat keeps its pointers
	 * valid and the scratch reaper reclaims a dead seat's dir via its .owner record.
	 */
	let overflowRoot: string | null = deps.overflowRoot ?? null;
	let overflowSeq = 0;
	const overflowKept: { path: string; bytes: number }[] = [];
	const wake: MailWakeHooks = deps.mailWake ?? createMailWake({ exec: pi.exec, env, home });
	const record = deps.recordEvent ?? recordGateEvent;
	/**
	 * MAILGUARDSLIM1: every notice is one line in the tool result and one gate-events row with kind
	 * notice, never kind refuse (only refuse rows count toward mail-guard refusals). Best effort:
	 * a ledger failure is notified, never a refusal.
	 */
	async function ledgerNotice(ctx: FlywheelContext, gate: string, line: string, seat: string | null, act: string, repo: string | null, attempt: unknown): Promise<void> {
		const row = await record({
			seat, act, target: null, gate, kind: "notice",
			...(repo === null ? {} : { repo }),
			...(typeof attempt === "string" && attempt !== "" ? { attempt, event_id: attempt } : {}),
			detail: line.slice(0, 400),
		}, { env, home });
		if (!row.ok) ctx.ui?.notify(`kit-agent-mail-guard GATE_LEDGER_UNWRITTEN: ${row.why}; the verdict stands.`, "warning");
	}
	let callerResolver = wake.caller;

	function sessionFile(ctx: FlywheelContext): string | null {
		const manager = prop(ctx, "sessionManager");
		const getter = prop(manager, "getSessionFile");
		const file = typeof getter === "function" ? getter.call(manager) : undefined;
		return typeof file === "string" && file !== "" ? file : null;
	}

	/** MAILBIND1 (ompkit-8bybq): every distinct name a pane identity file gives this exact Tern block, in any
	 * project directory under ~/.config/agent-mail/identity (the files register_agent/macro_start_session write). */
	function blockIdentityNames(block: string): string[] {
		const root = join(home, ".config", "agent-mail", "identity");
		let dirs: string[];
		try { dirs = readdirSync(root); } catch { return []; }
		const names = new Map<string, string>();
		for (const dir of dirs) {
			const name = identityFileName(join(root, dir, `tern-${block}`));
			if (name) names.set(name.toLowerCase(), name);
		}
		return [...names.values()];
	}

	async function caller(ctx: FlywheelContext, project: string): Promise<BoundCaller | null> {
		const file = sessionFile(ctx);
		if (!file) return null;
		callerResolver ??= createMailWake({ exec: pi.exec, env, home }).caller;
		const seat = await callerResolver(file, project);
		if (!seat) return null;
		if (seat.repo === ctx.cwd && seat.name) return { ...seat, paneName: seat.name };
		// MAILXREPO1: the requested project's pane identity file at this caller's own proven block binds it
		// whatever ctx.cwd is (a lead in ~/Developer mailing an opted-in repo); another block's file never does.
		if (seat.projectName) return { ...seat, name: seat.projectName, paneName: seat.projectName };
		// MAILBIND1: register_agent writes no file for the project when it gets no pane_id, so a lead registered
		// in project P can still lack P's file. This caller's own block, named X by its pane identity files
		// (exactly one name), is bound under P only when the exact Agent Mail lookup proves X is registered in P.
		const names = blockIdentityNames(seat.block);
		const paneName = names.length === 1 ? names[0]! : null;
		if (paneName !== null) {
			const exact = await exactAgent(project, paneName);
			if (exact.ok && exact.row !== null) return { ...seat, name: paneName, paneName };
			return { ...seat, name: null, paneName };
		}
		return seat.repo === ctx.cwd ? { ...seat, paneName: null } : null;
	}

	function secretScanner(): RegExp[] {
		scanner ??= ruleConditions(readFileSync(rulePath, "utf8")).map(source => new RegExp(source));
		return scanner;
	}
	/**
	 * AMGUARDSOFT1: the owner-only inbox window key: the fetching agent plus the project it
	 * fetches. A seat's window never covers another agent's fetches or another project's inbox.
	 */
	function inboxKey(value: unknown, ctx: FlywheelContext): string {
		const claimed = prop(value, "agent_name");
		const project = prop(value, "project_key");
		const agent = typeof claimed === "string" && claimed.trim() !== "" ? claimed.trim().toLowerCase() : "";
		const key = typeof project === "string" && project !== "" ? project : ctx.cwd;
		return `${agent}\n${key}`;
	}
	/**
	 * AMGUARDSOFT1: an explicit lower bound the fetch carries (since_ts, since, after_ts), as ms
	 * since epoch when it parses. A bound newer than the last fetch is a genuinely new query,
	 * not a duplicate poll, so it passes without the nag notice.
	 */
	function fetchSince(value: unknown): number | null {
		for (const field of ["since_ts", "since", "after_ts"]) {
			const raw = prop(value, field);
			if (typeof raw === "number" && Number.isFinite(raw)) return raw;
			if (typeof raw === "string" && raw.trim() !== "") {
				const asNum = Number(raw.trim());
				if (Number.isFinite(asNum)) return asNum;
				const asDate = Date.parse(raw.trim());
				if (!Number.isNaN(asDate)) return asDate;
			}
		}
		return null;
	}
	function overflowDir(): string {
		overflowRoot ??= ownedTmp("agent-mail-overflow", { autoCleanup: false }).path;
		return overflowRoot;
	}
	function evictOverflow(dir: string): void {
		while ((overflowKept.length > AM_OVERFLOW_KEEP_FILES
			|| overflowKept.reduce((sum, kept) => sum + kept.bytes, 0) > AM_OVERFLOW_KEEP_BYTES)
			&& overflowKept.length > 1) {
			const oldest = overflowKept.shift();
			if (oldest === undefined) return;
			try { unlinkSync(oldest.path); } catch { /* Best effort: a kept file that is already gone stays gone. */ }
		}
	}
	/**
	 * AMGUARDSOFT1: complete an over-cap body. The full text lands in an owned (0600) file under
	 * the bounded overflow root; the filename is a content hash plus a per-instance counter, so no
	 * caller text ever reaches the filesystem. Returns the file path, or null when the store
	 * itself fails (the caller then fails closed under AM_GUARD_FAILED: the completion genuinely
	 * cannot complete).
	 */
	function storeOverflow(body: string): { path: string; truncated: boolean } | null {
		try {
			const dir = overflowDir();
			overflowSeq += 1;
			const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
			const name = `overflow-${digest}-${overflowSeq}.md`;
			const path = join(dir, name);
			const truncated = body.length > AM_BODY_STORE_MAX;
			const stored = truncated
				? body.slice(0, AM_BODY_STORE_MAX) + `\n[kit-agent-mail-guard AM_BODY_OVERFLOW: stored ${AM_BODY_STORE_MAX} of ${body.length} characters]`
				: body;
			writeFileSync(path, stored, { mode: 0o600 });
			const bytes = Buffer.byteLength(stored);
			overflowKept.push({ path, bytes });
			evictOverflow(dir);
			return { path, truncated };
		} catch {
			return null;
		}
	}

	async function seatNames(ctx: FlywheelContext, projectKey: unknown): Promise<{ names: string[]; project: string; unbound: BoundCaller | null }> {
		const project = typeof projectKey === "string" && projectKey !== "" ? projectKey : ctx.cwd;
		if (sessionFile(ctx)) {
			const seat = await caller(ctx, project);
			if (seat) return { names: seat.name ? [seat.name] : [], project, unbound: seat.name ? null : seat };
		}
		const keys = [ctx.cwd, project];
		const names = await paneIdentities(pi.exec, env, home, keys);
		const named = env.AGENT_NAME?.trim();
		return { names: named ? names.filter(name => name.toLowerCase() === named.toLowerCase()) : names, project, unbound: null };
	}

	/**
	 * MAILGUARDSLIM1: the ask's bead id, checked natively in the repo. Null when a candidate resolves
	 * (the ack stands); otherwise notice text asking for the bead id next time. The send is admitted
	 * with ack kept either way: the ack is a reversible nudge, not a hazard.
	 */
	async function beadNotice(subject: string, cwd: string): Promise<string | null> {
		const candidates = beadCandidates(subject);
		if (candidates.length === 0) {
			return `ack_required names no bead id in the subject ("${subject.slice(0, 80)}" names none); sent with ack kept. Put the id after the vocabulary word next time, e.g. "QUESTION <bead-id>: ...".`;
		}
		const request: TrackerRequest = {
			bin: "br", ids: candidates, cwd, identities: [], operation: "claim", addLabels: [],
			actor: null, assignee: null, ifUnchanged: null, transitionComment: null,
			status: null, reason: null, argv: [], force: false,
		};
		let why = "";
		for (const id of candidates) {
			const found = await readBeadState(pi.exec, request, id);
			if (found.ok) return null;
			why = found.why;
		}
		return `no bead id in the subject resolves in the tracker at ${cwd} (${candidates.join(", ")}; last: ${why}); sent with ack kept. Name a bead id the tracker resolves next time.`;
	}
	const amBin = deps.amBin ?? "am";
	const scanBudgetMs = deps.scanBudgetMs ?? AM_SCAN_BUDGET_MS;
	const rosterCache = new Map<string, { at: number; rows: MailRosterRow[] }>();
	const scanCache = new Map<string, { at: number; found: MailSight[]; checked: number; total: number }>();
	let projectKeysCache: { at: number; keys: string[]; scopes: Map<string, string> } | null = null;

	async function fetchRoster(projectKey: string, timeoutMs: number): Promise<{ ok: true; rows: MailRosterRow[] } | { ok: false; why: string }> {
		let result;
		try {
			result = await pi.exec(amBin, ["agents", "list", "-p", projectKey, "--json"], { timeout: timeoutMs });
		} catch (error) {
			return { ok: false, why: `\`${amBin} agents list\` could not run (${error instanceof Error ? error.message : String(error)})` };
		}
		if (result.code !== 0 || result.killed) return { ok: false, why: `\`${amBin} agents list\` exited ${result.killed ? "after timeout" : result.code}` };
		let payload: unknown;
		try {
			payload = JSON.parse(result.stdout);
		} catch {
			return { ok: false, why: `\`${amBin} agents list\` returned unparseable output` };
		}
		const rows = parseRoster(payload);
		if (rows === null) return { ok: false, why: `\`${amBin} agents list\` returned an unexpected shape` };
		return { ok: true, rows };
	}
	async function exactAgent(projectKey: string, name: string, timeoutMs = AM_ROSTER_TIMEOUT_MS): Promise<{ ok: true; row: MailRosterRow | null } | { ok: false; why: string }> {
		const started = now();
		let result;
		try {
			result = await pi.exec(amBin, ["agents", "show", "-p", projectKey, name, "--json"], { timeout: timeoutMs });
		} catch (error) {
			return { ok: false, why: error instanceof Error ? error.message : String(error) };
		}
		if (result.killed) return { ok: false, why: "exact lookup timed out" };
		if (result.code !== 0) {
			const jsonStart = result.stderr.indexOf("{");
			if (jsonStart >= 0) {
				try {
					const error = JSON.parse(result.stderr.slice(jsonStart));
					const detail = prop(prop(error, "error"), "data");
					if (prop(prop(error, "error"), "type") === "AGENT_NOT_FOUND"
						&& prop(detail, "agent_name") === name) {
						const remainingMs = timeoutMs - (now() - started);
						if (remainingMs > 0 && await projectKeys(remainingMs) !== null
							&& projectKeysCache?.scopes.get(projectKey) === prop(detail, "project")) {
							return { ok: true, row: null };
						}
					}
				} catch { /* An unrecognized failure is not proof of absence. */ }
			}
			return { ok: false, why: "exact lookup failed without authoritative AGENT_NOT_FOUND" };
		}
		let payload: unknown;
		try { payload = JSON.parse(result.stdout); }
		catch { return { ok: false, why: "exact lookup returned unparseable output" }; }
		const row = parseRosterRow(payload);
		const projectId = prop(payload, "project_id");
		if (row === null || row.name.toLowerCase() !== name.toLowerCase()
			|| typeof projectId !== "number" || !Number.isSafeInteger(projectId) || projectId <= 0) {
			return { ok: false, why: "exact lookup returned a mismatched name or invalid project identity" };
		}
		return { ok: true, row };
	}

	async function cachedRoster(projectKey: string, fresh = false): Promise<{ ok: true; rows: MailRosterRow[] } | { ok: false; why: string }> {
		const hit = rosterCache.get(projectKey);
		if (!fresh && hit !== undefined && now() - hit.at < AM_ROSTER_TTL_MS) return { ok: true, rows: hit.rows };
		const fetched = await fetchRoster(projectKey, AM_ROSTER_TIMEOUT_MS);
		if (fetched.ok) rosterCache.set(projectKey, { at: now(), rows: fetched.rows });
		return fetched;
	}

	/** Project keys holding at least one agent, from `am robot projects --json` (cached). */
	async function projectKeys(timeoutMs = AM_ROSTER_TIMEOUT_MS): Promise<string[] | null> {
		if (projectKeysCache !== null && now() - projectKeysCache.at < AM_SCAN_TTL_MS) return projectKeysCache.keys;
		let result;
		try {
			result = await pi.exec(amBin, ["robot", "projects", "--json"], { timeout: timeoutMs });
		} catch {
			return null;
		}
		if (result.code !== 0 || result.killed) return null;
		let payload: unknown;
		try {
			payload = JSON.parse(result.stdout);
		} catch {
			return null;
		}
		const list = prop(payload, "projects");
		if (!Array.isArray(list)) return null;
		const keys: string[] = [];
		const scopes = new Map<string, string>();
		for (const entry of list) {
			const path = prop(entry, "path");
			const slug = prop(entry, "slug");
			const key = typeof path === "string" && path !== "" ? path : (typeof slug === "string" ? slug : "");
			if (key !== "" && typeof slug === "string" && slug !== "") {
				scopes.set(key, slug);
				scopes.set(slug, slug);
			}
			const agents = prop(entry, "agents");
			if (typeof agents === "number" && agents > 0 && key !== "") keys.push(key);
		}
		projectKeysCache = { at: now(), keys, scopes };
		return keys;
	}

	/**
	 * Every project besides `excludeKey` where `lower` is registered. Deadline-bounded: past the
	 * budget the scan stops and reports its coverage instead of guessing. Completed scans are cached.
	 */
	async function locateAgent(lower: string, excludeKey: string, orderHint: string): Promise<{ found: MailSight[]; checked: number; total: number; complete: boolean }> {
		const cached = scanCache.get(lower);
		if (cached !== undefined && now() - cached.at < AM_SCAN_TTL_MS) {
			return { found: cached.found.filter(sight => sight.project !== excludeKey), checked: cached.checked, total: cached.total, complete: true };
		}
		const keys = await projectKeys();
		if (keys === null) return { found: [], checked: 0, total: 0, complete: false };
		const ordered = keys.filter(key => key !== excludeKey);
		ordered.sort((a, b) => (a === orderHint ? -1 : 0) - (b === orderHint ? -1 : 0));
		const found: MailSight[] = [];
		let checked = 0;
		const deadline = now() + scanBudgetMs;
		for (const key of ordered) {
			if (now() > deadline) return { found, checked, total: ordered.length, complete: false };
			const roster = await cachedRoster(key);
			if (!roster.ok) continue;
			checked += 1;
			for (const row of roster.rows) {
				if (row.name.toLowerCase() === lower) {
					found.push({ project: key, program: row.program, model: row.model, task: row.task, lastActive: row.lastActive });
				}
			}
		}
		scanCache.set(lower, { at: now(), found, checked, total: ordered.length });
		return { found, checked, total: ordered.length, complete: true };
	}

	function describeSight(sight: MailSight): string {
		const runtime = sight.program !== "" ? sight.program : "unknown";
		const activity = sight.lastActive !== "" ? `last active ${sight.lastActive}` : "no recorded activity";
		const assignment = sight.task !== "" ? `, task "${sight.task.slice(0, 80)}"` : "";
		return `${sight.project} (program ${runtime}, ${activity}${assignment})`;
	}

	/**
	 * AMPHANTOM1: every send_message recipient must already be registered under project_key, or the
	 * send is refused before the server can auto-register a phantom. A refusal names the projects
	 * where the name IS registered (deadline-bounded scan), most-recently-active first. A recipient
	 * registered in several projects warns (sent anyway) unless the target is the most active one.
	 * A sender_name whose target-project registration names a different program than the seat's own
	 * registration is refused: the mail would read as from that other runtime. Task text alone never
	 * refuses: tasks churn while the program names the runtime.
	 */
	async function checkRecipients(sender: string, value: unknown, ctx: FlywheelContext): Promise<FlywheelToolCallResult | undefined> {
		const projectKey = prop(value, "project_key");
		if (typeof projectKey !== "string" || projectKey.trim() === "") {
			return refuse("AM_ARGS_UNREADABLE", "project_key is missing or not a string. The project key is the RECIPIENT's repo path.");
		}
		const key = projectKey.trim();
		const recipients: string[] = [];
		for (const fieldName of ["to", "cc"]) {
			const fieldValue = prop(value, fieldName);
			const list = typeof fieldValue === "string" ? [fieldValue] : (Array.isArray(fieldValue) ? fieldValue : []);
			for (const entry of list) {
				if (typeof entry === "string" && entry.trim() !== "") recipients.push(entry.trim());
			}
		}
		if (recipients.length === 0) return refuse("AM_ARGS_UNREADABLE", "send_message names no recipient in `to` or `cc`.");
		const roster = await cachedRoster(key);
		if (!roster.ok) {
			return refuse("AM_ROSTER_UNAVAILABLE", `the ${key} roster cannot be read (${roster.why}). An unchecked send could create a phantom recipient, so the send is refused instead of guessed. Restore \`${amBin} agents list\`, then retry.`);
		}
		const senderLower = sender.trim().toLowerCase();
		const senderRow = roster.rows.find(row => row.name.toLowerCase() === senderLower);
		if (senderRow !== undefined && ctx.cwd !== key) {
			const home = await cachedRoster(ctx.cwd);
			if (home.ok) {
				const own = home.rows.find(row => row.name.toLowerCase() === senderLower);
				if (own !== undefined && own.program.trim().toLowerCase() !== senderRow.program.trim().toLowerCase()) {
					const targetSight: MailSight = { project: key, program: senderRow.program, model: senderRow.model, task: senderRow.task, lastActive: senderRow.lastActive };
					const ownSight: MailSight = { project: ctx.cwd, program: own.program, model: own.model, task: own.task, lastActive: own.lastActive };
					return refuse("AM_SENDER_COLLISION", `"${senderRow.name}" is registered in ${key} as ${describeSight(targetSight)}, but your own registration is ${describeSight(ownSight)}. The mail would read as from that other runtime. Send under your own project's key, or as a name registered to your runtime in ${key}.`);
				}
			}
		}
		let rows = roster.rows;
		const missing = recipients.filter(name => !rows.some(row => row.name.toLowerCase() === name.toLowerCase()));
		let exactRows: MailRosterRow[] | undefined;
		if (missing.length > 0) {
			const refreshed = await cachedRoster(key, true);
			if (refreshed.ok) rows = refreshed.rows;
			const stillMissing = recipients.filter(name => !rows.some(row => row.name.toLowerCase() === name.toLowerCase()));
			if (stillMissing.length > 5) return refuse("AM_ROSTER_UNAVAILABLE", "too many recipients are absent from the capped roster for bounded exact checks.");
			const deadline = now() + scanBudgetMs;
			for (const name of stillMissing) {
				const remainingMs = deadline - now();
				if (remainingMs <= 0) return refuse("AM_ROSTER_UNAVAILABLE", "the bounded exact-recipient lookup budget expired.");
				const exact = await exactAgent(key, name, Math.min(AM_ROSTER_TIMEOUT_MS, remainingMs));
				if (!exact.ok) return refuse("AM_ROSTER_UNAVAILABLE", `the exact lookup for "${name}" in ${key} was unavailable or malformed; registration is unknown, so the send is refused.`);
				if (exact.row === null) return phantomRefusal(key, name, ctx.cwd);
				if (exactRows === undefined) exactRows = [];
				exactRows.push(exact.row);
			}
		}
		for (const name of recipients) {
			const row = rows.find(candidate => candidate.name.toLowerCase() === name.toLowerCase())
				?? exactRows?.find(candidate => candidate.name.toLowerCase() === name.toLowerCase());
			if (row === undefined) return refuse("AM_ROSTER_UNAVAILABLE", "recipient registration could not be retained for the project check.");
			const scan = await locateAgent(name.toLowerCase(), key, ctx.cwd);
			if (!scan.complete || scan.found.length === 0) continue;
			const newer = scan.found.filter(sight => sight.lastActive !== "" && row.lastActive !== "" && sight.lastActive > row.lastActive);
			if (newer.length === 0) continue;
			const ranked = [...scan.found].sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
			return {
				additionalContext: `kit-agent-mail-guard AM_PROJECT_AMBIGUOUS (warning; the send was allowed): "${row.name}" is registered in ${scan.found.length + 1} projects: ${key} (${row.lastActive !== "" ? `last active ${row.lastActive}` : "no recorded activity"}) and ${ranked.map(describeSight).join("; ")}. Most recently active in ${ranked[0]!.project}. The project key is the RECIPIENT's repo path: re-send under ${ranked[0]!.project} if the mail was meant for that seat.`,
			};
		}
		return undefined;
	}

	async function phantomRefusal(key: string, name: string, orderHint: string): Promise<FlywheelToolCallResult> {
		const scan = await locateAgent(name.toLowerCase(), key, orderHint);
		const coverage = `checked ${scan.checked}/${scan.total} project rosters`;
		if (scan.found.length > 0) {
			const ranked = [...scan.found].sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
			return refuse("AM_PHANTOM_REFUSED", `"${name}" is not registered under project_key ${key}, so the send is refused before a phantom recipient is created${scan.complete ? "" : ` (${coverage})`}. It IS registered in: ${ranked.map(describeSight).join("; ")}. The project key is the RECIPIENT's repo path: re-send under ${ranked[0]!.project}.`);
		}
		if (scan.complete) {
			return refuse("AM_PHANTOM_REFUSED", `"${name}" is not registered under project_key ${key} and is not registered in any other project (${coverage}). Register the recipient first (\`am agents register -p ${key} ...\`) or fix the spelling.`);
		}
		return refuse("AM_PHANTOM_REFUSED", `"${name}" is not registered under project_key ${key}, so the send is refused before a phantom recipient is created. The wider lookup is incomplete (${coverage}): confirm with \`${amBin} agents list -p <suspected-key> --json\`, or register the recipient first.`);
	}

	/**
	 * MAILGUARDSLIM1: reversible acts are admitted with a notice, never refused, and a notice never
	 * skips a later check (GATEDEMOTE1). Returns the verdict (a block for a kept refusal, else the
	 * accumulated notices and the pre-existing ambiguity warning) plus the effective arguments
	 * (ack_required dropped when the subject cannot carry it). The secret scan, roster, identity and
	 * DONE checks still run after every notice.
	 */
	async function checkMessage(tool: "send_message" | "reply_message", value: unknown, ctx: FlywheelContext, names: string[], event: FlywheelToolCallEvent): Promise<{ verdict: FlywheelToolCallResult | undefined; value: unknown }> {
		const sender = prop(value, "sender_name");
		if (names.length === 0) {
			return { verdict: refuse("AM_IDENTITY_UNKNOWN", "this seat has no identity (AGENT_NAME is unset and no Agent Mail pane identity names this pane), so sender_name cannot be checked. Launch the seat with AGENT_NAME set."), value };
		}
		if (typeof sender !== "string" || !names.some(name => name.toLowerCase() === sender.trim().toLowerCase())) {
			return { verdict: refuse("AM_IDENTITY_MISMATCH", `sender_name ${typeof sender === "string" ? `"${sender}"` : "is missing"} is not this seat (${names.join(", ")}). Send as yourself; never as another agent.`), value };
		}
		const seat = names[0] ?? null;
		const attempt = prop(event, "toolCallId");
		const projectOf = (args: unknown): string | null => {
			const key = prop(args, "project_key");
			return typeof key === "string" && isAbsolute(key) ? key : null;
		};
		const notices: string[] = [];
		const queueNotice = async (gate: string, text: string): Promise<void> => {
			const line = `kit-agent-mail-guard ${gate}: ${text}`;
			notices.push(line);
			const row = await (deps.recordEvent ?? recordGateEvent)({
				seat, act: tool, target: null, gate, kind: "notice",
				...(projectOf(value) === null ? {} : { repo: projectOf(value) }),
				...(typeof attempt === "string" && attempt !== "" ? { attempt, event_id: attempt } : {}),
				detail: line.slice(0, 400),
			}, { env, home });
			if (!row.ok) ctx.ui?.notify(`kit-agent-mail-guard GATE_LEDGER_UNWRITTEN: ${row.why}; the verdict stands.`, "warning");
		};
		let current = value;
		let warning: FlywheelToolCallResult | undefined;
		if (tool === "send_message") {
			warning = await checkRecipients(sender, value, ctx);
			if (warning?.block === true) return { verdict: warning, value: current };
		}
		const ack = prop(value, "ack_required");
		const ackOn = ack === true || (typeof ack === "string" && ack.trim().toLowerCase() === "true");
		const dropAck = async (why: string): Promise<void> => {
			if (typeof current === "object" && current !== null && !Array.isArray(current)) {
				const next = { ...(current as Record<string, unknown>) };
				delete next.ack_required;
				current = next;
			}
			await queueNotice("AM_ACK_NOTICE", `ack_required was dropped: ${why} The send proceeds without an ack.`);
		};
		let doneCallback = false;
		if (tool === "send_message") {
			const subject = prop(value, "subject");
			const lead = typeof subject === "string" ? subjectLead(subject) : null;
			if (typeof subject !== "string" || lead === null) {
				await queueNotice("AM_SUBJECT_NOTICE", `the subject does not start with one of ${Object.keys(SUBJECT_VOCABULARY).join(", ")} (got "${typeof subject === "string" ? subject.slice(0, 80) : ""}"); sent anyway. Start with the vocabulary word and name the bead id next time.`);
				if (ackOn) await dropAck("without a vocabulary subject the ask cannot be checked.");
			} else {
				doneCallback = lead === "DONE";
				if (ackOn) {
					if (ACK_VOCABULARY[lead] !== true) {
						await dropAck(`${lead} is status or FYI mail, not a real ask (${Object.keys(ACK_VOCABULARY).join(", ")} carry acks).`);
					} else {
						// AMACKPROJECT1 (rz5.163): project_key is the recipient's repo, so the ask's bead lives in its
						// tracker. The session cwd is only the fallback when project_key names no tracker on this host.
						const key = prop(value, "project_key");
						const tracker = typeof key === "string" && isAbsolute(key) && existsSync(join(key, ".beads")) ? key : ctx.cwd;
						const missing = await beadNotice(subject, tracker);
						if (missing !== null) await queueNotice("AM_ACK_BEAD_NOTICE", missing);
					}
				}
			}
		} else if (ackOn) {
			await dropAck("a reply has no subject of its own to check (the reply inherits the original's flag).");
		}
		const body = prop(current, "body_md");
		if (typeof body !== "string") return { verdict: refuse("AM_ARGS_UNREADABLE", "body_md is missing or not a string."), value: current };
		const fullBody = body;
		let patterns: RegExp[];
		try { patterns = secretScanner(); }
		catch (error) {
			return { verdict: refuse("AM_SCANNER_UNAVAILABLE", `the secret scanner rule (${rulePath}) cannot be loaded (${error instanceof Error ? error.message : String(error)}); a body that cannot be scanned is not sent.`), value: current };
		}
		if (patterns.some(pattern => pattern.test(fullBody))) {
			return { verdict: refuse("AM_BODY_SECRET", "the body holds what the secret scanner flags as a literal credential. Never mail a secret: name where it lives (Infisical key name) instead."), value: current };
		}
		// AMGUARDSOFT1: an over-cap body completes instead of refusing (AM_BODY_TOO_LONG is
		// retired). The hook can rewrite arguments but cannot fetch the file back later, so the
		// full text is stored now in an owned bounded overflow file, attached via
		// attachment_paths, and the send carries the first cap characters plus a pointer line.
		if (fullBody.length > AM_BODY_CAP) {
			const stored = storeOverflow(fullBody);
			if (stored === null) {
				return { verdict: refuse("AM_GUARD_FAILED", "the over-cap body cannot be stored for completion (the overflow file failed); nothing was sent."), value: current };
			}
			const pointer = `Full body is ${fullBody.length} characters, over the ${AM_BODY_CAP} cap: the complete text is stored at ${stored.path}${stored.truncated ? ` (stored truncated at ${AM_BODY_STORE_MAX} characters)` : ""} and attached.`;
			const record = current as Record<string, unknown>;
			const kept = prop(record, "attachment_paths");
			const attachments = Array.isArray(kept) ? [...kept, stored.path] : [stored.path];
			current = {
				...record,
				body_md: `${fullBody.slice(0, AM_BODY_CAP)}\n\n[kit-agent-mail-guard AM_BODY_OVERFLOW: ${pointer}]`,
				attachment_paths: attachments,
			};
			await queueNotice("AM_BODY_NOTICE", `the body is ${fullBody.length} characters, over the ${AM_BODY_CAP} cap; the full text is stored at ${stored.path} and attached, and the send carries the first ${AM_BODY_CAP} characters plus a pointer.`);
		}
		if (doneCallback) {
			const project = prop(current, "project_key");
			const citations = extractCitedCommitReferences(fullBody);
			if (citations.length === 0) {
				return { verdict: refuse("AM_DONE_NOT_PUBLISHED", "DONE is not sendable: NOT_PUBLISHED UNKNOWN; the body must cite at least one commit SHA. Save and publish on origin/main with git_converge.py --push."), value: current };
			}
			if (typeof project !== "string" || !isAbsolute(project)) {
				return { verdict: refuse("AM_DONE_NOT_PUBLISHED", "DONE is not sendable: NOT_PUBLISHED UNKNOWN; project_key must identify the local repository to verify. Save and publish on origin/main with git_converge.py --push."), value: current };
			}
			const invalid = citations.find(citation => citation.invalidQualifier !== undefined);
			if (invalid !== undefined) {
				return { verdict: refuse("AM_DONE_NOT_PUBLISHED", `DONE is not sendable: UNKNOWN ${invalid.sha}: unsupported repository qualifier "${invalid.invalidQualifier}". Use an absolute repository path followed by @SHA.`), value: current };
			}
			const citationsByRepo = new Map<string, string[]>();
			for (const citation of citations) {
				const repo = citation.repo ?? project;
				const shas = citationsByRepo.get(repo) ?? [];
				shas.push(citation.sha);
				citationsByRepo.set(repo, shas);
			}
			const checks: { repo: string; status: PublishedCommitStatus; sha: string; detail: string }[] = [];
			for (const [repo, shas] of citationsByRepo) {
				const repoChecks = await checkPublishedCommits(repo, shas, async (gitRepo, args) => {
					try {
						const result = await pi.exec("git", ["-C", gitRepo, ...args], { cwd: gitRepo, timeout: AM_ROSTER_TIMEOUT_MS });
						return {
							rc: result.killed ? null : result.code,
							out: result.stdout.trim(),
							failed: result.killed === true,
						};
					} catch {
						return { rc: null, out: "", failed: true };
					}
				});
				checks.push(...repoChecks.map(check => ({ ...check, repo })));
			}
			const failed = checks.find(check => check.status !== "PUBLISHED");
			if (failed !== undefined) {
				return { verdict: refuse("AM_DONE_NOT_PUBLISHED", `DONE is not sendable: ${failed.status} ${failed.sha || "(no SHA)"} in ${failed.repo}: ${failed.detail}. Save and publish on origin/main with git_converge.py --push.`), value: current };
			}
		}
		const parts = [...notices, ...(warning?.additionalContext !== undefined ? [warning.additionalContext] : [])];
		if (current !== value) {
			const patch = rewriteArgs(event, current as Record<string, unknown>);
			if (parts.length === 0) return { verdict: patch, value: current };
			return { verdict: { ...patch, additionalContext: parts.join(" ") }, value: current };
		}
		if (parts.length === 0) return { verdict: undefined, value: current };
		return { verdict: { additionalContext: parts.join(" ") }, value: current };
	}
	function rewriteArgs(event: FlywheelToolCallEvent, value: Record<string, unknown>): { input: Record<string, unknown> } | undefined {
		const raw = event.input;
		if (typeof raw !== "object" || raw === null) return undefined;
		if (typeof event.toolName === "string" && event.toolName.trim().toLowerCase() === "write") {
			const content = prop(raw, "content");
			if (typeof content !== "string" && (typeof content !== "object" || content === null)) return undefined;
			return { input: { ...raw, content: typeof content === "string" ? JSON.stringify(value) : value } };
		}
		return { input: value };
	}

	/**
	 * The seat's sender_token, injected into a send the seat already passed every check on.
	 * Source: AGENT_MAIL_SENDER_TOKEN (the token the seat's registration minted, exported at
	 * launch; same variable `am mail send` honors). Only when sender_name is the seat (never
	 * another agent's), only when the call carries no non-empty sender_token of its own, and
	 * only the raw execution input is revised — the token never appears in a reason string.
	 * Returns undefined when there is nothing to inject: the send runs as written.
	 */
	function injectSenderToken(value: unknown, event: FlywheelToolCallEvent, names: string[]): { input: Record<string, unknown> } | undefined {
		const token = env.AGENT_MAIL_SENDER_TOKEN?.trim();
		if (!token) return undefined;
		if (typeof value !== "object" || value === null) return undefined;
		const sender = prop(value, "sender_name");
		if (typeof sender !== "string" || !names.some(name => name.toLowerCase() === sender.trim().toLowerCase())) return undefined;
		const existing = prop(value, "sender_token");
		if (typeof existing === "string" && existing.trim() !== "") return undefined;
		return rewriteArgs(event, { ...value, sender_token: token });
	}

	pi.on("tool_call", async (event, ctx) => {
		// MAILGUARDSLIM1 (1): a background child's `am` shell reservation is rewritten to its parent
		// seat's name (WRITEOWNCHILD1 seatIdentity, no second resolution) and admitted with a notice
		// per call. A call that cannot be rewritten safely is left unchanged and admitted with a
		// notice saying which call and why, so the server's answer is explained. Reads and
		// non-reservation shell pass through untouched. AM_NATIVE_TOOL_REQUIRED is deleted: it has
		// no other caller.
		if (ctx.agent?.kind === "sub" && event.toolName === "bash") {
			const command = prop(event.input, "command");
			if (typeof command === "string" && childShellReservationAgents(command).length > 0) {
				const seat = seatIdentity({ agentName: env.AGENT_NAME, childAgentName: typeof ctx.agent?.id === "string" ? ctx.agent.id : undefined }, env);
				if (seat === undefined) {
					return refuse("AM_IDENTITY_MISMATCH", "a background child reserves under its parent seat's name, which does not resolve here (AGENT_NAME is unset). Report to the parent instead.");
				}
				const rewritten = rewriteChildShellAgents(command, seat);
				const lines: string[] = [];
				for (const call of rewritten.calls) {
					if (call.outcome === "already-seat") continue;
					if (call.outcome === "rewrote") {
						lines.push(`kit-agent-mail-guard AM_CHILD_RESERVATION_NOTICE: background child ${call.verb} admitted under the parent seat's name ${seat}; a child does not reserve for itself.`);
					} else {
						const why = call.outcome === "ambiguous"
							? "unrecognised flags may carry a value that shifts the positionals, so no token was rewritten"
							: "the agent token could not be located without guessing, so nothing was rewritten";
						lines.push(`kit-agent-mail-guard AM_CHILD_RESERVATION_NOTICE: background child ${call.verb} left unchanged (${why}); reserve under the parent seat's name ${seat} instead, or report to the parent.`);
					}
				}
				if (lines.length === 0) return undefined;
				for (const line of lines) await ledgerNotice(ctx, "AM_CHILD_RESERVATION_NOTICE", line, seat, "bash", ctx.cwd, event.toolCallId);
				const additionalContext = lines.join(" ");
				const raw = event.input;
				if (typeof raw !== "object" || raw === null) return { additionalContext };
				return rewritten.command === command
					? { additionalContext }
					: { input: { ...raw, command: rewritten.command }, additionalContext };
			}
		}
		const call = mailCall(event);
		if (call === null) return undefined;
		const bulk = BULK_READ_TOOLS[call.tool] === true || BULK_READ_PATTERN.test(call.tool);
		const registration = Object.prototype.hasOwnProperty.call(REGISTRATION_KEYS, call.tool);
		const reservation = call.tool === "file_reservation_paths" || call.tool === "release_file_reservations" || call.tool === "renew_file_reservations";
		/** AMRENEW1: the reservation macro reserves like the direct tools; its schema names the caller agent_name. */
		const reservationMacro = call.tool === "macro_file_reservation_cycle";
		const guarded = reservation || reservationMacro || bulk || registration || call.tool === "send_message" || call.tool === "reply_message" || call.tool === "fetch_inbox";
		if (!guarded) return undefined;
		try {
			// MAILGUARDSLIM1 (1): a background child neither registers nor reserves for itself. A child's
			// reservation call is rewritten to its parent seat's name (WRITEOWNCHILD1 seatIdentity, no
			// second resolution) and admitted with a one-line notice; a child's register/send call gets
			// one refusal naming no further command.
			if (ctx.agent?.kind === "sub" && (reservation || reservationMacro || registration || call.tool === "send_message" || call.tool === "reply_message")) {
				const seat = seatIdentity({ agentName: env.AGENT_NAME, childAgentName: typeof ctx.agent?.id === "string" ? ctx.agent.id : undefined }, env);
				if (registration || call.tool === "send_message" || call.tool === "reply_message") {
					return refuse("AM_IDENTITY_MISMATCH", seat === undefined
						? "a background child's native register and mail calls are not admitted, and no parent seat name resolves here (AGENT_NAME is unset). Report to the parent instead."
						: `a background child's native register and mail calls are not admitted; the parent seat ${seat} holds the registration and mailbox. Report to the parent instead.`);
				}
				if (!call.args.ok) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: ${call.args.why}.`);
				if (seat === undefined) {
					return refuse("AM_IDENTITY_MISMATCH", "a background child reserves under its parent seat's name, which does not resolve here (AGENT_NAME is unset). Report to the parent instead.");
				}
				if (typeof call.args.value !== "object" || call.args.value === null || Array.isArray(call.args.value)) {
					return refuse("AM_ARGS_UNREADABLE", `${call.tool}: arguments do not parse as an object.`);
				}
				const claimed = prop(call.args.value, "agent_name");
				if (typeof claimed === "string" && claimed.toLowerCase() === seat.toLowerCase()) return undefined;
				const line = `kit-agent-mail-guard AM_CHILD_RESERVATION_NOTICE: background child reservation admitted under the parent seat's name ${seat}; a child does not reserve for itself.`;
				const project = prop(call.args.value, "project_key");
				await ledgerNotice(ctx, "AM_CHILD_RESERVATION_NOTICE", line, seat, call.tool,
					typeof project === "string" && isAbsolute(project) ? project : null, event.toolCallId);
				const rewritten = rewriteArgs(event, { ...(call.args.value as Record<string, unknown>), agent_name: seat });
				return rewritten === undefined ? { additionalContext: line } : { ...rewritten, additionalContext: line };
			}
			// MAILWAKE1.2 (ompkit-uk9wn.2): a send names the RECIPIENT's repo in project_key. A seat whose own cwd
			// carries no fleet opt-in (the chief tab runs in ~/Developer, 2026-10-25: every chief-tab send bypassed the
			// wake and signaled nobody) is still a fleet sender when it addresses a fleet repo: read the policy there.
			let policy = await fleetPolicyState(ctx.cwd);
			if (policy.kind === "off" && (registration || call.tool === "send_message" || call.tool === "reply_message")) {
				const projectKey = prop(call.args.ok ? call.args.value : undefined, call.tool === "macro_start_session" ? "human_key" : "project_key");
				if (typeof projectKey === "string" && isAbsolute(projectKey)) {
					const recipient = await fleetPolicyState(projectKey);
					if (recipient.kind === "on") policy = recipient; // only a readable opt-in promotes; an absent or unreadable recipient repo keeps the sender's own policy
				}
			}
			if (policy.kind === "off") return undefined;
			if (policy.kind === "unavailable") return refuse("AM_FLEET_POLICY", `the repo's fleet opt-in is unreadable (${policy.reason}).`);
			// AMRENEW1 (ompkit-jyxx5): the reservation tools and the reservation macro carry the
			// caller as agent_name; their schemas have no sender_name. Judge each call by the
			// identity field its own schema really has: the seat's own name passes, another
			// seat's name is refused, and a missing agent_name is refused naming agent_name
			// (never as impersonation). Background children are rewritten to the seat above.
			if (reservation || reservationMacro) {
				if (!call.args.ok) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: ${call.args.why}.`);
				const { names: reservationNames, project: reservationProject, unbound: reservationUnbound } = await seatNames(ctx, prop(call.args.value, "project_key"));
				if (reservationNames.length === 0) {
					return refuse("IDENTITY_UNBOUND", reservationUnbound?.paneName
						? `No identity file binds this seat's actual pane under ${reservationProject}: its pane identity names ${reservationUnbound.paneName}, who is not registered there. Run register_agent or macro_start_session for that project before reserving.`
						: "No identity file binds this seat's actual pane. Run register_agent or macro_start_session for this pane before reserving.");
				}
				const claimed = prop(call.args.value, "agent_name");
				if (typeof claimed !== "string" || claimed.trim() === "") {
					return refuse("AM_IDENTITY_MISMATCH", `${call.tool}: agent_name is missing (this seat is ${reservationNames.join(", ")}). Pass your own seat name in agent_name.`);
				}
				if (!reservationNames.some(name => name.toLowerCase() === claimed.trim().toLowerCase())) {
					return refuse("AM_IDENTITY_MISMATCH", `${call.tool}: agent_name "${claimed}" is not this seat (${reservationNames.join(", ")}). Reserve, renew and release as yourself; never as another agent.`);
				}
				return undefined;
			}
			if (registration) {
				if (!call.args.ok || typeof call.args.value !== "object" || call.args.value === null || Array.isArray(call.args.value)) {
					return refuse("AM_ARGS_UNREADABLE", `${call.tool}: registration arguments do not parse as an object.`);
				}
				// MAILGUARDSLIM1 (3): unknown arguments are stripped by rewriteArgs and admitted
				// with a notice, so a server can never silently discard them; a missing absolute
				// project key reports under AM_ARGS_UNREADABLE.
				const allowed = REGISTRATION_KEYS[call.tool]!;
				const stripped: Record<string, unknown> = { ...(call.args.value as Record<string, unknown>) };
				const dropped: string[] = [];
				for (const key of Object.keys(stripped)) {
					if (!Object.prototype.hasOwnProperty.call(allowed, key)) { dropped.push(key); delete stripped[key]; }
				}
				const value = stripped;
				const project = prop(value, call.tool === "macro_start_session" ? "human_key" : "project_key");
				if (typeof project !== "string" || !isAbsolute(project)) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: a registration needs an absolute project key (project_key, or human_key for macro_start_session).`);
				const seat = await caller(ctx, project);
				const nameKey = call.tool === "macro_start_session" ? "agent_name" : "name";
				const claimedName = prop(value, nameKey);
				// MAILBIND1: an unregistered project still registers the name this block's pane identity files give it.
				const ownName = seat?.name ?? seat?.paneName ?? env.AGENT_NAME?.trim();
				if (ownName && typeof claimedName === "string" && claimedName.toLowerCase() !== ownName.toLowerCase()) {
					return refuse("AM_IDENTITY_MISMATCH", `${call.tool}: registration must keep the current caller's identity, not another agent's name.`);
				}
				const pane = seat ? `tern:${seat.block}` : env.TMUX_PANE?.trim();
				const requested = prop(value, "pane_id");
				if (!pane || (requested !== undefined && requested !== null && requested !== pane)) {
					return refuse("IDENTITY_UNBOUND", `${call.tool}: current caller pane is unproven or pane_id differs from the actual caller. Register only your own Tern session or TMUX_PANE.`);
				}
				const patched = rewriteArgs(event, { ...value, ...(ownName ? { [nameKey]: ownName } : {}), pane_id: pane });
				if (dropped.length === 0) return patched;
				const line = `kit-agent-mail-guard AM_REGISTRATION_NOTICE: unknown argument(s) ${dropped.join(", ")} stripped (schema keys: ${Object.keys(allowed).join(", ")}); the registration proceeded without them.`;
				await ledgerNotice(ctx, "AM_REGISTRATION_NOTICE", line, typeof ownName === "string" ? ownName : null, call.tool, project, event.toolCallId);
				return patched === undefined ? { additionalContext: line } : { ...patched, additionalContext: line };
			}
			if (bulk) {
				return refuse("AM_BULK_READ", `${call.tool} is a bulk read. Read one message at a time (fetch_inbox with a small limit, or fetch one id); read state is not obligation state.`);
			}
			if (call.tool === "fetch_inbox") {
				const at = now();
				const id = event.toolCallId;
				const value = call.args.ok ? call.args.value : undefined;
				const key = inboxKey(value, ctx);
				const prior = lastInbox.get(key);
				const sameLogicalCall = typeof id === "string" && id !== "" && prior !== undefined && id === prior.toolCallId;
				if (sameLogicalCall) return undefined;
				const fresh = prior === undefined || at - prior.at >= AM_INBOX_INTERVAL_MS;
				const since = fetchSince(value);
				// AMGUARDSOFT1: admit when the window lapsed or the caller bounds the query past
				// the last fetch (a genuinely new query, not a duplicate poll). Otherwise admit
				// with a one-line note naming the fetch's age and the next allowed time; the
				// tool_call hook can block or rewrite input but cannot return a substitute
				// result, so there is no cached-result short-circuit, only this note. No refusal:
				// AM_INBOX_RATE is retired. Every admitted fetch advances the window, noticed or not.
				if (!fresh && !(since !== null && prior !== undefined && since > prior.at)) {
					const ageS = Math.max(0, Math.round((at - prior!.at) / 1000));
					const waitS = Math.max(1, Math.ceil((AM_INBOX_INTERVAL_MS - (at - prior!.at)) / 1000));
					const nextAt = new Date(prior!.at + AM_INBOX_INTERVAL_MS).toISOString();
					const line = `kit-agent-mail-guard AM_INBOX_NOTICE: fetch_inbox ran ${ageS} s ago; admitted anyway — next fetch allowed in ${waitS} s (${nextAt}); inbox wakes deliver new mail, polling every ${AM_INBOX_INTERVAL_MS / 1000} s is unnecessary.`;
					lastInbox.set(key, { at, toolCallId: typeof id === "string" && id !== "" ? id : null });
					const claimed = prop(value, "agent_name");
					await ledgerNotice(ctx, "AM_INBOX_NOTICE", line, typeof claimed === "string" ? claimed : null, call.tool, null, id);
					return { additionalContext: line };
				}
				lastInbox.set(key, { at, toolCallId: typeof id === "string" && id !== "" ? id : null });
				return undefined;
			}
			if (!call.args.ok) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: ${call.args.why}.`);
			if (typeof event.toolCallId !== "string" || event.toolCallId.trim() === "") {
				return refuse("AM_CALL_ID_REQUIRED", "A send/reply needs its native tool-call ID so the persisted message can be joined to its wake row. Retry through the native mounted tool.");
			}
			const { names, project: sendProject, unbound } = await seatNames(ctx, prop(call.args.value, "project_key"));
			if (names.length === 0) {
				return refuse("IDENTITY_UNBOUND", unbound?.paneName
					? `No identity file binds this sender's actual pane under ${sendProject}: its pane identity names ${unbound.paneName}, who is not registered in that project. Run register_agent (project_key ${sendProject}, name ${unbound.paneName}, pane_id tern:${unbound.block}) or macro_start_session for that project before sending.`
					: "No identity file binds this sender's actual pane. Run register_agent or macro_start_session for this pane before sending.");
			}
			const tool = call.tool === "send_message" ? "send_message" : "reply_message";
			const checked = await checkMessage(tool, call.args.value, ctx, names, event);
			if (checked.verdict?.block === true) return checked.verdict;
			// MAILWAKE1 (ompkit-uk9wn): plan the recipients' wake only once every check passed; an ask with no
			// wake path is refused here (NO_WAKE_PATH) before anything is sent. The wake and the token
			// stamp run on the effective arguments, so a dropped ack_required stays dropped.
			const projectKey = prop(checked.value, "project_key");
			const wakeVerdict = await wake.beforeSend(event.toolCallId, tool, checked.value,
				typeof projectKey === "string" && projectKey !== "" ? projectKey : ctx.cwd);
			if (wakeVerdict !== undefined) return wakeVerdict;
			const tokenPatch = injectSenderToken(checked.value, event, names);
			const extra = checked.verdict?.additionalContext;
			// AMGUARDSOFT1: the guard's own input revision (a dropped ack_required, a completed
			// over-cap body) rides on every verdict, not only on the token stamp.
			const revised = checked.verdict !== undefined && typeof checked.verdict === "object" && "input" in checked.verdict
				? { input: checked.verdict.input }
				: undefined;
			if (tokenPatch === undefined) {
				if (revised === undefined) return extra === undefined ? undefined : { additionalContext: extra };
				return extra === undefined ? revised : { ...revised, additionalContext: extra };
			}
			return extra === undefined ? tokenPatch : { ...tokenPatch, additionalContext: extra };
		} catch (error) {
			// MAILGUARDSLIM1 (2): AM_GUARD_FAILED never wraps a typed refusal. An inner AM_* (or
			// IDENTITY_UNBOUND) failure surfaces under its own code; only a genuine failure keeps
			// AM_GUARD_FAILED.
			const message = error instanceof Error ? error.message : String(error);
			const inner = /^(AM_[A-Z0-9_]+|IDENTITY_UNBOUND):\s*([\s\S]*)$/.exec(message);
			if (inner) return refuse(inner[1]!, inner[2]!.trim() === "" ? message : inner[2]!);
			return refuse("AM_GUARD_FAILED", `the check failed (${message}).`);
		}
	});

	// MAILWAKE1: the planned wake fires on the send's result. afterSend acts only on a toolCallId beforeSend
	// planned above, so every other tool result passes through untouched.
	pi.on("tool_result", async event => {
		try {
			return await wake.afterSend(event);
		} catch (error) {
			const content = Array.isArray(event.content) ? event.content : [];
			const why = error instanceof Error ? error.message : String(error);
			return { content: [...content, { type: "text", text: `[kit-mail-wake] UNSIGNALED: the wake failed (${why}); the mail is persisted but wakes nobody.` }] };
		}
	});
}
