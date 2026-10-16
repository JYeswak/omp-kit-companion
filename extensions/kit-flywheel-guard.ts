import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { PullRefusal } from "../src/fleet-watch";

/**
 * kit-flywheel-guard: lifecycle invariants enforced at the act.
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
 * $TMUX_PANE. Unknown caller identities and missing assignees allow the call
 * with a warning; failed or unparseable `br show` results block it.
 *
 * CLAIM_REFUSED: native claim/start prechecks name the current holder or
 * unreadable prerequisite. br --claim remains the atomic award; an actor
 * flag selects that native actor, never grants authority or transfers custody.
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
/** br 0.7.4 global/close/update options that consume a value. */
const BR_VALUE_FLAGS: Record<string, true> = {
	"--db": true, "--actor": true, "--lock-timeout": true, "-r": true, "--reason": true,
	"--transition-comment": true, "--session": true, "--agent-name": true, "--harness": true,
	"--model": true, "--bypass-reason": true, "--title": true, "-d": true, "--description": true,
	"--body": true, "--description-file": true, "--design": true, "--acceptance-criteria": true,
	"--acceptance": true, "--prerequisites": true, "--check-acceptance": true, "--uncheck-acceptance": true,
	"--add-acceptance": true, "--notes": true, "--append-notes": true, "-s": true, "--status": true,
	"-p": true, "--priority": true, "-t": true, "--type": true, "--assignee": true, "--owner": true,
	"--if-unchanged": true, "--due": true, "--defer": true, "--estimate": true, "--add-label": true,
	"--remove-label": true, "--set-labels": true, "--labels": true, "--parent": true,
	"--external-ref": true, "--source-repo": true, "--source-repo-path": true, "--agent-context": true,
};
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
		} else if ((ch === ">" || ch === "<" || (ch === "&" && command[index + 1] === ">")) && quote === null) {
			// ompkit-xa5s.8: source-aware redirections. Quoted operators never
			// reach here (quote branches above own them). A leading all-digit
			// word is the fd prefix; anything else ends first. N>&M / N>&-
			// dups are self-contained; other forms consume one target word
			// (quote-aware). >( and <( are process substitution, not
			// redirections; a lone & still separates commands.
			let fd = "";
			if (/^\d+$/.test(word)) { fd = word; word = ""; inWord = false; }
			else endWord();
			let op = ch;
			let cursor = index + 1;
			const peek = () => (cursor < command.length ? command[cursor]! : "");
			if ((ch === ">" || ch === "<") && peek() === ch && command[cursor + 1] !== "(") { op += peek(); cursor += 1; }
			if ((op === ">" || op === ">>" || op === "<" || op === "<<" || op === "&>") && peek() === "(") {
				word = fd + op; inWord = true; index = cursor - 1;
			} else {
				if ((op === ">" || op === ">>" || op === "<" || op === "<<") && peek() === "&") {
					op += "&";
					cursor += 1;
					if (/[0-9-]/.test(peek())) { while (/[0-9-]/.test(peek())) { op += peek(); cursor += 1; } }
				}
				const selfContained = /&[0-9-]+$/.test(op);
				index = cursor - 1;
				if (!selfContained) {
					let scan = cursor;
					while (scan < command.length && (command[scan] === " " || command[scan] === "\t" || command[scan] === "\r")) scan += 1;
					if (scan < command.length) {
						const t = command[scan]!;
						if (t === "'" || t === '"') {
							const q = t; scan += 1;
							while (scan < command.length && command[scan] !== q) {
								if (q === '"' && command[scan] === "\\" && scan + 1 < command.length) scan += 1;
								scan += 1;
							}
							if (scan < command.length) scan += 1;
						} else if (t === "\\" && scan + 1 < command.length) scan += 2;
						else if (!";|&()\n`#".includes(t) && t !== " " && t !== "\t" && t !== "\r") {
							while (scan < command.length && !";|&()\n `#\t\r".includes(command[scan]!)) {
								if (command[scan] === "\\" && scan + 1 < command.length) scan += 1;
								scan += 1;
							}
						}
						index = scan - 1;
					}
				}
			}		} else if (ch === ";" || ch === "&" || ch === "|" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
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

export interface TrackerRequest {
	bin: string;
	ids: string[];
	cwd: string;
	db?: string;
	/** Identities this command line itself claims (flags and inline env assignments). */
	identities: string[];
	operation: "close" | "claim" | "start";
	/** Effective command-line BR_ACTOR/--actor selection, not --agent-name attribution. */
	actor: string | null;
	assignee: string | null;
	force: boolean;
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

/** Supported close/claim/start mutations, with the cwd selected by leading cd commands. */
export function trackerRequests(command: string, cwd: string, home: string): TrackerRequest[] {
	const requests: TrackerRequest[] = [];
	let current = cwd;
	for (const raw of shellCommands(command)) {
		const identities: string[] = [];
		let inlineActor: string | null = null;
		let at = 0;
		while (at < raw.length) {
			const word = raw[at]!;
			if (isAssignment(word)) {
				const eq = word.indexOf("=");
				const name = word.slice(0, eq);
				if ((IDENTITY_ENV as readonly string[]).includes(name) && word.length > eq + 1) identities.push(word.slice(eq + 1));
				if (name === "BR_ACTOR") inlineActor = word.slice(eq + 1);
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
		let actor: string | null = null;
		let assignee: string | null = null;
		let status: string | null = null;
		let claim = false;
		let force = false;
		let readOnly = false;
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
				if (flag === "--help" || flag === "-h" || flag === "--version" || flag === "-V") { readOnly = true; continue; }
				if (flag === "--claim") { claim = true; continue; }
				if (flag === "--force" || flag === "-f") { force = true; continue; }
				const value = eq > 0 ? word.slice(eq + 1) : BR_VALUE_FLAGS[flag] === true ? argv[++index] : undefined;
				if (value === undefined) continue;
				if (flag === "--actor" || flag === "--agent-name") identities.push(value);
				if (flag === "--db") db = expandHome(value, home);
				if (flag === "--actor") actor = value;
				if (flag === "--assignee") assignee = value;
				if (flag === "--status" || flag === "-s") status = value;
				continue;
			}
			if (subcommand === undefined) subcommand = word;
			else ids.push(word);
		}
		if (readOnly) continue;
		const nativeStatus = status?.toLowerCase();
		const operation = subcommand === "close" ? "close"
			: subcommand === "update" && claim ? "claim"
				: subcommand === "update" && (nativeStatus === "in_progress" || nativeStatus === "inprogress") ? "start" : null;
		if (operation === null) continue;
		requests.push({ bin: argv[0]!, ids, cwd: current, db, identities, operation, actor: actor ?? inlineActor, assignee, force });
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

export type BeadState = { ok: true; id: string; status: string; assignee: string | null } | { ok: false; why: string };

export async function readBeadState(exec: FlywheelExec, request: TrackerRequest, id: string): Promise<BeadState> {
	const args = ["show", id, "--json", "--no-auto-import", "--no-auto-flush", ...(request.db ? ["--db", request.db] : [])];
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
		const row = rows.find(item => field(item, "id") === id) ?? (rows.length === 1 ? rows[0] : undefined);
		const canonical = field(row, "id");
		const status = field(row, "status");
		const assignee = field(row, "assignee");
		if (typeof canonical !== "string" || canonical === "" || typeof status !== "string"
			|| (assignee !== undefined && assignee !== null && typeof assignee !== "string")) {
			return { ok: false, why: `${id} returned no qualified native issue/owner record` };
		}
		const owner = typeof assignee === "string" ? assignee.trim() : "";
		return { ok: true, id: canonical, status, assignee: owner === "" ? null : owner };
	} catch {
		return { ok: false, why: `\`${request.bin} show ${id} --json\` returned unparseable output` };
	}
}

const FINITE_SERVICE_VERBS: Record<string, true> = {
	build: true, check: true, clippy: true, compile: true, lint: true,
	test: true, typecheck: true, validate: true, verify: true, vet: true,
};
const FINITE_SERVICE_RUNNERS: Record<string, true> = {
jest: true, mocha: true, pytest: true, ruff: true, shellcheck: true, tsc: true, vitest: true,
};

function serviceCommandIsFinite(command: string): boolean {
	for (const words of shellCommands(command)) {
		let executableIndex = 0;
		while (executableIndex < words.length && (isAssignment(words[executableIndex]!) || WRAPPERS[words[executableIndex]!.toLowerCase()])) executableIndex += 1;
		const executable = words[executableIndex];
		if (!executable) continue;
		const name = executable.slice(executable.lastIndexOf("/") + 1).toLowerCase();
		const args = words.slice(executableIndex + 1).map(word => word.toLowerCase());
		if (args.includes("--watch") || args.includes("--watchall") || args.includes("-w")) continue;
		if (FINITE_SERVICE_RUNNERS[name] === true) return true;
		if (name === "bun" && (args[0] === "test" || args[0] === "run" && FINITE_SERVICE_VERBS[args[1] ?? ""] === true)) return true;
		if ((name === "npm" || name === "pnpm" || name === "yarn") &&
			(args[0] === "test" || args[0] === "run" && FINITE_SERVICE_VERBS[args[1] ?? ""] === true)) return true;
		if ((name === "cargo" || name === "go" || name === "make") && FINITE_SERVICE_VERBS[args[0] ?? ""] === true) return true;
	}
	return false;
}

function hasServiceReadiness(ready: unknown): boolean {
	const log = field(ready, "log");
	const port = field(ready, "port");
	return typeof log === "string" && log.trim().length > 0
		|| typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535;
}

function bashAdmissionRefusal(code: string, command: string, detail: string, next: string): FlywheelToolCallResult {
	const executable = shellCommands(command)[0]?.[0]?.split("/").at(-1) ?? "unknown";
	const digest = createHash("sha256").update(command).digest("hex");
	return {
		block: true,
		reason: JSON.stringify({
			guard: "kit-flywheel-guard",
			code,
			command: { executable, sha256: digest },
			detail,
			next,
		}),
	};
}

/** Refuse finite Bash work that explicitly disables the OMP deadline. */
export function checkBashAdmission(event: FlywheelToolCallEvent): FlywheelToolCallResult | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = field(event.input, "command");
	if (typeof command !== "string" || command.trim().length === 0) return undefined;
	const name = field(event.input, "name");
	const service = typeof name === "string" && name.trim().length > 0;
	const async = field(event.input, "async") === true;
	const timeout = field(event.input, "timeout");
	if (service) {
		if (async || timeout !== undefined) return bashAdmissionRefusal(
			"SERVICE_MODE_CONFLICT", command, "named services use readiness and lifecycle, not finite async or timeout fields",
			"remove async and timeout, then provide a readiness condition for a long-lived service",
		);
		if (serviceCommandIsFinite(command)) return bashAdmissionRefusal(
			"FINITE_SUITE_AS_SERVICE", command, "a recognized finite build, test, or validation command cannot use unbounded service mode",
			"run finite work with its native positive deadline; reserve named services for long-lived commands",
		);
		if (!hasServiceReadiness(field(event.input, "ready"))) return bashAdmissionRefusal(
			"SERVICE_READINESS_REQUIRED", command, "a named service needs a log or port readiness condition and native lifecycle",
			"provide ready.log or a valid ready.port; finite work must use the finite-command path",
		);
		return undefined;
	}
	if (timeout === undefined) return undefined; // OMP 18.11.1 defaults finite Bash commands to 300 seconds.
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return bashAdmissionRefusal(
		"FINITE_JOB_DEADLINE_UNKNOWN", command, "the effective finite-command deadline cannot be determined",
		"pass a positive numeric timeout or omit it to use OMP's bounded default",
	);
	if (timeout === 0) return bashAdmissionRefusal(
		"FINITE_JOB_NO_DEADLINE", command, "timeout zero disables the finite-command deadline, including managed background execution",
		"pass a positive timeout in seconds or use named service mode with readiness and lifecycle",
	);
	return undefined;
}

export interface TrackerMutationDeps {
	exec: FlywheelExec;
	env: Record<string, string | undefined>;
	home: string;
	sessionCwd: string;
}

function refuseClaim(refusal: PullRefusal): FlywheelToolCallResult {
	return { block: true, reason: JSON.stringify({ guard: "kit-flywheel-guard", code: "CLAIM_REFUSED", refusal }) };
}

/** Native claim semantics are separate from non-author close identity policy. */
async function checkNativeClaim(request: TrackerRequest, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	const actor = (request.actor ?? deps.env.BR_ACTOR)?.trim() ?? null;
	if (actor === null || actor === "") return refuseClaim({
		class: "unsupported_native", bead: request.ids[0] ?? null, actor: "UNKNOWN native actor",
		next: "select the actual native --actor or BR_ACTOR before claiming; --agent-name is attribution only",
	});
	if (request.ids.length === 0) return refuseClaim({
		class: "unsupported_native", bead: null, actor,
		next: "name an explicit native issue id; a last-touched record is not a bound ownership claim",
	});
	if (request.force || request.assignee !== null) return refuseClaim({
		class: "unsupported_native", bead: request.ids[0] ?? null, actor: "UNKNOWN director",
		next: "use a normal atomic --claim, not a forced or manual assignment/start; route any qualified custody transfer through its owner",
	});
	for (const id of request.ids) {
		const found = await readBeadState(deps.exec, request, id);
		if (!found.ok) return refuseClaim({
			class: "tool_read_failure", bead: id, actor: "UNKNOWN native controller",
			next: `restore the native lookup for ${id} before claiming: ${found.why}`,
		});
		if (found.assignee !== null && found.assignee !== actor) return refuseClaim({
			class: "unsafe_custody", bead: found.id, actor: found.assignee,
			next: `${found.assignee} retains ${found.id}; read fresh native ready work instead of taking another holder's claim`,
		});
		if (found.status === "closed" || found.status === "tombstone") return refuseClaim({
			class: "unsafe_custody", bead: found.id, actor: "UNKNOWN director",
			next: `${found.id} is ${found.status}; consult the original disposition, do not reopen it to acquire work`,
		});
		if (request.operation === "start" && found.assignee === null) return refuseClaim({
			class: "unsupported_native", bead: found.id, actor,
			next: `use br update ${found.id} --claim --actor ${actor}; a status update alone does not atomically award ownership`,
		});
	}
	return undefined;
}

export async function checkTrackerMutations(event: FlywheelToolCallEvent, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	if (event.toolName !== "bash") return undefined;
	const command = field(event.input, "command");
	const cwd = field(event.input, "cwd");
	if (typeof command !== "string") return undefined;
	const callCwd = typeof cwd === "string" && cwd.trim()
		? resolve(deps.sessionCwd, expandHome(cwd.trim(), deps.home))
		: deps.sessionCwd;
	const requests = trackerRequests(command, callCwd, deps.home);
	if (requests.length === 0) return undefined;
	const hasClose = requests.some(request => request.operation === "close");
	const envIdentities = hasClose ? IDENTITY_ENV.map(name => deps.env[name]?.trim()).filter((value): value is string => Boolean(value)) : [];
	const pane = hasClose ? await paneIdentities(deps.exec, deps.env, deps.home, [deps.sessionCwd, callCwd, ...requests.map(r => r.cwd)]) : [];
	const warnings: string[] = [];
	for (const request of requests) {
		if (request.operation !== "close") {
			const refusal = await checkNativeClaim(request, deps);
			if (refusal !== undefined) return refusal;
			continue;
		}
		const identities = [...new Set([...request.identities, ...envIdentities, ...pane])];
		if (request.ids.length === 0) {
			warnings.push(`\`${request.bin} close\` without an id closes the last-touched bead; its assignee was not checked`);
			continue;
		}
		for (const id of request.ids) {
			const found = await readBeadState(deps.exec, request, id);
			if (!found.ok) {
				return {
					block: true,
					reason: `kit-flywheel-guard LOOKUP_REFUSED: cannot verify authorship of ${id}: ${found.why}. Resolve the native lookup; no close was executed.`,
				};
			}
			const assignee = found.assignee?.trim();
			if (!assignee) {
				warnings.push(`self-close check skipped: ${id} has no assignee`);
				continue;
			}
			if (identities.length === 0) {
				warnings.push(`self-close check skipped for ${id}: caller identity unknown (no --actor/--agent-name, BR_ACTOR, BR_AGENT_NAME, AGENT_NAME, or Agent Mail pane identity for TMUX_PANE)`);
				continue;
			}
			const self = identities.find(name => name.toLowerCase() === assignee.toLowerCase());
			if (self !== undefined) {
				return {
					block: true,
					reason: `kit-flywheel-guard ${SELF_CLOSE_REFUSED}: ${found.id} is assigned to ${assignee}, which is you. `
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
			const admission = checkBashAdmission(event);
			if (admission !== undefined) return admission;
			const result = await checkTrackerMutations(event, { exec: pi.exec, env, home, sessionCwd: ctx.cwd });
			if (result?.additionalContext) ctx.ui?.notify(result.additionalContext, "warning");
			return result;
		} catch (error) {
			const warning = `kit-flywheel-guard LOOKUP_REFUSED: lifecycle check failed (${error instanceof Error ? error.message : String(error)}); mutation blocked, nothing was executed.`;
			ctx.ui?.notify(warning, "warning");
			return { block: true, reason: warning };
		}
	});
}
