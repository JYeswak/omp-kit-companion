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
import { createMailWake, type MailToolResultEvent, type MailWake } from "./kit-mail-wake";

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
 *
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
/** Minimum spacing between one seat's fetch_inbox calls. */
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
export type MailWakeHooks = Pick<MailWake, "beforeSend" | "afterSend">;

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
	let lastInboxToolCallId: string | null = null;
	const wake: MailWakeHooks = deps.mailWake ?? createMailWake({ exec: pi.exec, env, home });

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
		const request: TrackerRequest = {
			bin: "br", ids: candidates, cwd, identities: [], operation: "claim", addLabels: [],
			actor: null, assignee: null, ifUnchanged: null, transitionComment: null,
			status: null, reason: null, argv: [], force: false,
		};
		let why = "";
		for (const id of candidates) {
			const found = await readBeadState(pi.exec, request, id);
			if (found.ok) return undefined;
			why = found.why;
		}
		return refuse("AM_ACK_BEAD_UNRESOLVED", `no bead id in the subject resolves in this repo's tracker (${candidates.join(", ")}; last: ${why}). ack_required is for a real ask about a bead that exists.`);
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

	async function checkMessage(tool: "send_message" | "reply_message", value: unknown, ctx: FlywheelContext, names: string[]): Promise<FlywheelToolCallResult | undefined> {
		const sender = prop(value, "sender_name");
		if (names.length === 0) {
			return refuse("AM_IDENTITY_UNKNOWN", "this seat has no identity (AGENT_NAME is unset and no Agent Mail pane identity names this pane), so sender_name cannot be checked. Launch the seat with AGENT_NAME set.");
		}
		if (typeof sender !== "string" || !names.some(name => name.toLowerCase() === sender.trim().toLowerCase())) {
			return refuse("AM_IDENTITY_MISMATCH", `sender_name ${typeof sender === "string" ? `"${sender}"` : "is missing"} is not this seat (${names.join(", ")}). Send as yourself; never as another agent.`);
		}
		let notice: FlywheelToolCallResult | undefined;
		if (tool === "send_message") {
			notice = await checkRecipients(sender, value, ctx);
			if (notice?.block === true) return notice;
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
		return notice;
	}
	/**
	 * The seat's sender_token, injected into a send the seat already passed every check on.
	 * Source: AGENT_MAIL_SENDER_TOKEN (the token the seat's registration minted, exported at
	 * launch; same variable `am mail send` honors). Only when sender_name is the seat (never
	 * another agent's), only when the call carries no non-empty sender_token of its own, and
	 * only the raw execution input is revised — the token never appears in a reason string.
	 * Returns undefined when there is nothing to inject: the send runs as written.
	 */
	function injectSenderToken(call: MailCall, event: FlywheelToolCallEvent, names: string[]): { input: Record<string, unknown> } | undefined {
		const token = env.AGENT_MAIL_SENDER_TOKEN?.trim();
		if (!token || !call.args.ok) return undefined;
		const value = call.args.value;
		if (typeof value !== "object" || value === null) return undefined;
		const sender = prop(value, "sender_name");
		if (typeof sender !== "string" || !names.some(name => name.toLowerCase() === sender.trim().toLowerCase())) return undefined;
		const existing = prop(value, "sender_token");
		if (typeof existing === "string" && existing.trim() !== "") return undefined;
		const raw = event.input;
		if (typeof raw !== "object" || raw === null) return undefined;
		if (typeof event.toolName === "string" && event.toolName.trim().toLowerCase() === "write") {
			const content = prop(raw, "content");
			if (typeof content === "string") {
				let parsed: unknown;
				try { parsed = JSON.parse(content); } catch { return undefined; }
				if (typeof parsed !== "object" || parsed === null) return undefined;
				return { input: { ...raw, content: JSON.stringify({ ...parsed, sender_token: token }) } };
			}
			if (typeof content === "object" && content !== null) {
				return { input: { ...raw, content: { ...content, sender_token: token } } };
			}
			return undefined;
		}
		return { input: { ...raw, sender_token: token } };
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
				const id = event.toolCallId;
				const sameLogicalCall = typeof id === "string" && id !== "" && id === lastInboxToolCallId;
				if (sameLogicalCall) return undefined;
				if (lastInbox !== null && at - lastInbox < AM_INBOX_INTERVAL_MS) {
					return refuse("AM_INBOX_RATE", `fetch_inbox ran ${Math.round((at - lastInbox) / 1000)} s ago; one fetch per ${AM_INBOX_INTERVAL_MS / 1000} s per seat. Wake on events instead of polling.`);
				}
				lastInbox = at;
				lastInboxToolCallId = typeof id === "string" && id !== "" ? id : null;
				return undefined;
			}
			if (!call.args.ok) return refuse("AM_ARGS_UNREADABLE", `${call.tool}: ${call.args.why}.`);
			const names = await seatNames(ctx, prop(call.args.value, "project_key"));
			const tool = call.tool === "send_message" ? "send_message" : "reply_message";
			const verdict = await checkMessage(tool, call.args.value, ctx, names);
			if (verdict?.block === true) return verdict;
			// MAILWAKE1 (ompkit-uk9wn): plan the recipients' wake only once every check passed; an ask with no
			// wake path is refused here (NO_WAKE_PATH) before anything is sent.
			const projectKey = prop(call.args.value, "project_key");
			const wakeVerdict = await wake.beforeSend(event.toolCallId, tool, call.args.value,
				typeof projectKey === "string" && projectKey !== "" ? projectKey : ctx.cwd);
			if (wakeVerdict !== undefined) return wakeVerdict;
			const tokenPatch = injectSenderToken(call, event, names);
			return tokenPatch === undefined ? verdict : { ...verdict, ...tokenPatch };
		} catch (error) {
			return refuse("AM_GUARD_FAILED", `the check failed (${error instanceof Error ? error.message : String(error)}).`);
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
