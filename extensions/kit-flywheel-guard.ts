import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * kit-flywheel-guard: two Agent Flywheel Guide invariants enforced at the act.
 *
 * COMPACTION_REREAD (Anti-Pattern "not re-reading AGENTS.md after compaction";
 * Kernel invariant 7). OMP emits `session_compact` once a compaction entry is
 * committed; the guard injects a context message naming the AGENTS.md nearest
 * the session cwd and telling the agent to `br show` its in-progress bead
 * before it continues. Nothing else in a turn makes it speak.
 *
 * SELF_CLOSE_REFUSED (Kernel invariant 9, no self-certification). A bash call
 * that runs `br close <id>` or `bd close <id>` is blocked when the bead's
 * assignee (read-only `br show <id> --json` in the call's cwd) is one of the
 * caller's identities: `--actor`/`--agent-name` on the command, BR_ACTOR /
 * BR_AGENT_NAME / AGENT_NAME, or the Agent Mail pane identity file for
 * $TMUX_PANE. Missing data never blocks: an unknown identity, an empty
 * assignee or a failed `br show` allows the call with a warning.
 */

export interface FlywheelExecResult {
	stdout: string;
	stderr?: string;
	code: number;
	killed?: boolean;
}

export interface FlywheelExecOptions {
	cwd?: string;
	timeout?: number;
}

export type FlywheelExec = (command: string, args: string[], options?: FlywheelExecOptions) => Promise<FlywheelExecResult>;

export interface FlywheelContext {
	cwd: string;
	isIdle?(): boolean;
	ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export interface FlywheelToolCallEvent {
	type?: "tool_call";
	toolName?: unknown;
	input?: unknown;
}

export interface FlywheelToolCallResult {
	block?: boolean;
	reason?: string;
	additionalContext?: string;
}

export interface FlywheelMessage {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}

/** The slice of omp's ExtensionAPI this guard touches. */
export interface FlywheelGuardApi {
	on(event: "session_compact", handler: (event: { type: "session_compact" }, ctx: FlywheelContext) => unknown): void;
	on(event: "tool_call", handler: (event: FlywheelToolCallEvent, ctx: FlywheelContext) => unknown): void;
	sendMessage(message: FlywheelMessage, options?: { triggerTurn?: boolean; deliverAs?: "nextTurn" | "aside" }): void;
	exec: FlywheelExec;
}

export interface FlywheelGuardDeps {
	env?: Record<string, string | undefined>;
	home?: string;
}

/** Per-command ceiling for `br show` and the tmux pane-key lookup. */
export const FLYWHEEL_EXEC_TIMEOUT_MS = 3000;
export const COMPACTION_REREAD = "COMPACTION_REREAD";
export const SELF_CLOSE_REFUSED = "SELF_CLOSE_REFUSED";

const IDENTITY_ENV = ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"] as const;
/** br options (global and `close`) that consume the next word. */
const BR_VALUE_FLAGS: Record<string, true> = { "--db": true, "--actor": true, "--lock-timeout": true, "-r": true,
	"--reason": true, "--transition-comment": true, "--session": true, "--agent-name": true, "--harness": true,
	"--model": true, "--bypass-reason": true };
const WRAPPERS: Record<string, true> = { env: true, command: true, exec: true, nohup: true, time: true, builtin: true };

export function nearestAgentsMd(cwd: string): string | null {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const candidate = join(dir, "AGENTS.md");
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) return null;
	}
}

export function compactionRereadMessage(cwd: string, identities: readonly string[]): string {
	const agents = nearestAgentsMd(cwd);
	const reread = agents
		? `reread ${agents} in full`
		: `reread the repository's AGENTS.md in full (none found from ${cwd} upward)`;
	const assignee = identities.length > 0 ? identities[0] : "<your agent name>";
	return [
		"<system-reminder>",
		`kit-flywheel-guard ${COMPACTION_REREAD}: the context was just compacted and the summary does not carry the rules.`,
		`Before continuing: ${reread}, then run \`br list --status in_progress --assignee ${assignee}\` and \`br show <id>\` for your in-progress bead.`,
		"</system-reminder>",
	].join("\n");
}

/** Split a shell command into simple-command word lists. Quotes are honoured; expansions are not evaluated. */
export function shellCommands(command: string): string[][] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | "\"" | null = null;
	const endWord = (): void => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = (): void => {
		endWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};
	for (let index = 0; index < command.length; index += 1) {
		const ch = command[index]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word += ch;
			continue;
		}
		if (quote === "\"") {
			if (ch === "\"") quote = null;
			else if (ch === "\\" && index + 1 < command.length) word += command[++index]!;
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === "\"") {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && index + 1 < command.length) {
			const next = command[++index]!;
			if (next !== "\n") {
				word += next;
				inWord = true;
			}
		} else if (ch === "#" && !inWord) {
			while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
		} else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
			endCommand();
		} else if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
		} else {
			word += ch;
			inWord = true;
		}
	}
	endCommand();
	return commands;
}

export interface CloseRequest {
	bin: string;
	ids: string[];
	cwd: string;
	db?: string;
	/** Identities this command line itself claims (flags and inline env assignments). */
	identities: string[];
}

function expandHome(path: string, home: string): string {
	if (path === "~" || path === "$HOME" || path === "${HOME}") return home;
	for (const prefix of ["~/", "$HOME/", "${HOME}/"]) if (path.startsWith(prefix)) return join(home, path.slice(prefix.length));
	return path;
}

function isAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	if (eq <= 0) return false;
	for (let index = 0; index < eq; index += 1) {
		const code = word.charCodeAt(index);
		const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
		if (!alpha && !(index > 0 && code >= 48 && code <= 57)) return false;
	}
	return true;
}

/** Every `br close`/`bd close` in a bash command, with the cwd it runs in after leading `cd`s. */
export function closeRequests(command: string, cwd: string, home: string): CloseRequest[] {
	if (!command.includes("close")) return [];
	const requests: CloseRequest[] = [];
	let current = cwd;
	for (const raw of shellCommands(command)) {
		const identities: string[] = [];
		let at = 0;
		while (at < raw.length) {
			const word = raw[at]!;
			if (isAssignment(word)) {
				const eq = word.indexOf("=");
				const name = word.slice(0, eq);
				if ((IDENTITY_ENV as readonly string[]).includes(name) && word.length > eq + 1) identities.push(word.slice(eq + 1));
				at += 1;
			} else if (WRAPPERS[word] === true) at += 1;
			else break;
		}
		const argv = raw.slice(at);
		if (argv.length === 0) continue;
		if (argv[0] === "cd") {
			const target = argv[1];
			if (target === undefined) current = home;
			else if (target !== "-") current = resolve(current, expandHome(target, home));
			continue;
		}
		const name = basename(argv[0]!);
		if (name !== "br" && name !== "bd") continue;
		let db: string | undefined;
		let subcommand: string | undefined;
		const ids: string[] = [];
		let optionsDone = false;
		for (let index = 1; index < argv.length; index += 1) {
			const word = argv[index]!;
			if (!optionsDone && word === "--") {
				optionsDone = true;
				continue;
			}
			if (!optionsDone && word.startsWith("-") && word.length > 1) {
				const eq = word.indexOf("=");
				const flag = eq > 0 ? word.slice(0, eq) : word;
				const value = eq > 0 ? word.slice(eq + 1) : BR_VALUE_FLAGS[flag] === true ? argv[++index] : undefined;
				if (value === undefined) continue;
				if (flag === "--actor" || flag === "--agent-name") identities.push(value);
				if (flag === "--db") db = value;
				continue;
			}
			if (subcommand === undefined) subcommand = word;
			else ids.push(word);
		}
		if (subcommand !== "close") continue;
		requests.push({ bin: argv[0]!, ids, cwd: current, db, identities });
	}
	return requests;
}

function sanitizePane(pane: string): string {
	const stripped = pane.startsWith("%") ? pane.slice(1) : pane;
	let out = "";
	for (const ch of stripped) out += /[A-Za-z0-9_-]/.test(ch) ? ch : ch === ":" ? "-" : "_";
	return out.length > 0 ? out : "unknown";
}

/** Read one property of an untrusted JSON/event value; undefined unless it is an object carrying `key`. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

function readIdentityFile(path: string): string | null {
	try {
		if (!lstatSync(path).isFile()) return null;
		const text = readFileSync(path, "utf8").trim();
		if (text.startsWith("{")) {
			const name = field(JSON.parse(text), "name");
			return typeof name === "string" && name.trim() ? name.trim() : null;
		}
		const first = text.split("\n")[0]?.trim() ?? "";
		return first.length > 0 ? first : null;
	} catch {
		return null;
	}
}

/**
 * Agent Mail pane identity, same file contract as mcp_agent_mail_rust
 * pane_identity.rs: ~/.config/agent-mail/identity/<sha1(project)[:12]>/<pane key>,
 * composite `session:window:pane` key first, then the bare $TMUX_PANE.
 */
export async function paneIdentities(exec: FlywheelExec, env: Record<string, string | undefined>, home: string,
	projectKeys: readonly string[]): Promise<string[]> {
	const pane = env.TMUX_PANE?.trim();
	if (!pane) return [];
	const keys: string[] = [];
	try {
		const composite = await exec("tmux", ["display-message", "-p", "-t", pane, "#{session_name}:#{window_index}:#{pane_index}"],
			{ timeout: FLYWHEEL_EXEC_TIMEOUT_MS });
		const value = composite.stdout.trim();
		if (composite.code === 0 && value.includes(":")) keys.push(sanitizePane(value));
	} catch { /* no tmux: bare key only */ }
	keys.push(sanitizePane(pane));
	const names: string[] = [];
	for (const project of new Set(projectKeys)) {
		const hash = createHash("sha1").update(project).digest("hex").slice(0, 12);
		for (const key of keys) {
			const name = readIdentityFile(join(home, ".config", "agent-mail", "identity", hash, key));
			if (name && !names.includes(name)) names.push(name);
		}
	}
	return names;
}

export type BeadAssignee = { ok: true; assignee: string } | { ok: false; why: string };

export async function beadAssignee(exec: FlywheelExec, request: CloseRequest, id: string): Promise<BeadAssignee> {
	const args = ["show", id, "--json", ...(request.db ? ["--db", request.db] : [])];
	let result: FlywheelExecResult;
	try {
		result = await exec(request.bin, args, { cwd: request.cwd, timeout: FLYWHEEL_EXEC_TIMEOUT_MS });
	} catch (error) {
		return { ok: false, why: `\`${request.bin} show ${id}\` could not run (${error instanceof Error ? error.message : String(error)})` };
	}
	if (result.code !== 0 || result.killed) {
		// br --json reports errors as {"error":{"message":...}} on stdout; stderr carries tracing logs.
		let detail = "";
		try {
			const message = field(field(JSON.parse(result.stdout), "error"), "message");
			if (typeof message === "string") detail = message.slice(0, 200);
		} catch { /* not br's error envelope */ }
		if (!detail) detail = (result.stderr ?? "").trim().split("\n").at(-1)?.slice(0, 200) ?? "";
		return { ok: false, why: `\`${request.bin} show ${id}\` exited ${result.killed ? "after timeout" : result.code}${detail ? `: ${detail}` : ""}` };
	}
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
		const assignee = field(rows.find(item => field(item, "id") === id) ?? rows[0], "assignee");
		if (typeof assignee !== "string" || assignee.trim().length === 0) return { ok: false, why: `${id} has no assignee` };
		return { ok: true, assignee: assignee.trim() };
	} catch {
		return { ok: false, why: `\`${request.bin} show ${id} --json\` returned unparseable output` };
	}
}

export interface SelfCloseDeps {
	exec: FlywheelExec;
	env: Record<string, string | undefined>;
	home: string;
	sessionCwd: string;
}

export async function checkSelfClose(event: FlywheelToolCallEvent, deps: SelfCloseDeps): Promise<FlywheelToolCallResult | undefined> {
	if (event.toolName !== "bash") return undefined;
	const command = field(event.input, "command");
	const cwd = field(event.input, "cwd");
	if (typeof command !== "string") return undefined;
	const callCwd = typeof cwd === "string" && cwd.trim()
		? resolve(deps.sessionCwd, expandHome(cwd.trim(), deps.home))
		: deps.sessionCwd;
	const requests = closeRequests(command, callCwd, deps.home);
	if (requests.length === 0) return undefined;
	const envIdentities = IDENTITY_ENV.map(name => deps.env[name]?.trim()).filter((value): value is string => Boolean(value));
	const pane = await paneIdentities(deps.exec, deps.env, deps.home, [deps.sessionCwd, callCwd, ...requests.map(r => r.cwd)]);
	const warnings: string[] = [];
	for (const request of requests) {
		const identities = [...new Set([...request.identities, ...envIdentities, ...pane])];
		if (request.ids.length === 0) {
			warnings.push(`\`${request.bin} close\` without an id closes the last-touched bead; its assignee was not checked`);
			continue;
		}
		for (const id of request.ids) {
			const found = await beadAssignee(deps.exec, request, id);
			if (!found.ok) {
				warnings.push(`self-close check skipped: ${found.why}`);
				continue;
			}
			if (identities.length === 0) {
				warnings.push(`self-close check skipped for ${id}: caller identity unknown (no --actor/--agent-name, BR_ACTOR, BR_AGENT_NAME, AGENT_NAME, or Agent Mail pane identity for TMUX_PANE)`);
				continue;
			}
			const self = identities.find(name => name.toLowerCase() === found.assignee.toLowerCase());
			if (self !== undefined) {
				return {
					block: true,
					reason: `kit-flywheel-guard ${SELF_CLOSE_REFUSED}: ${id} is assigned to ${found.assignee}, which is you. `
						+ "No self-certification (Flywheel Kernel invariant 9): report DONE with evidence (commit sha, exact commands, exit codes) "
						+ "and let the director or an independent verifier run the close.",
				};
			}
		}
	}
	if (warnings.length === 0) return undefined;
	return { additionalContext: `kit-flywheel-guard: ${warnings.join("; ")}. The close was allowed; do not close a bead you implemented.` };
}

export default async function kitFlywheelGuard(pi: FlywheelGuardApi, deps: FlywheelGuardDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	pi.on("session_compact", async (_event, ctx) => {
		const envIdentities = IDENTITY_ENV.map(name => env[name]?.trim()).filter((value): value is string => Boolean(value));
		let identities = envIdentities;
		try {
			identities = [...new Set([...envIdentities, ...await paneIdentities(pi.exec, env, home, [ctx.cwd])])];
		} catch { /* the reminder still goes out without a name */ }
		pi.sendMessage(
			{ customType: "kit-flywheel-guard", content: compactionRereadMessage(ctx.cwd, identities), display: true,
				details: { behavior: COMPACTION_REREAD } },
			// Idle: append to context now. Streaming (auto-compaction mid-run): inject at the next step boundary.
			{ deliverAs: ctx.isIdle?.() === false ? "aside" : "nextTurn" },
		);
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			const result = await checkSelfClose(event, { exec: pi.exec, env, home, sessionCwd: ctx.cwd });
			if (result?.additionalContext) ctx.ui?.notify(result.additionalContext, "warning");
			return result;
		} catch (error) {
			const warning = `kit-flywheel-guard: self-close check failed (${error instanceof Error ? error.message : String(error)}); the call was allowed.`;
			ctx.ui?.notify(warning, "warning");
			return { additionalContext: warning };
		}
	});
}
