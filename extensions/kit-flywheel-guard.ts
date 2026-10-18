import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { PullRefusal } from "../src/fleet-watch";

/**
 * kit-flywheel-guard: lifecycle invariants enforced at the act.
 *
 * COMPACTION_REREAD (Anti-Pattern "not re-reading AGENTS.md after compaction";
 * Kernel invariant 7). OMP emits `session_compact` once a compaction entry is
 * committed; the guard injects a context message naming the AGENTS.md nearest
 * the session cwd and telling the agent to `br show` its in-progress bead
 * before it continues, and arms a pending-reread flag. While the flag is set,
 * the `tool_call` handler blocks mutating calls (edit, write, br
 * update/close/comments, git commit/push, classified by the exported pure
 * function `isMutatingCall`). Only observed successful `tool_execution_end`
 * results clear the flag: a read of exactly the named AGENTS.md with
 * non-empty content, and a `br show` whose parsed output is in_progress (or
 * rework) and assigned to a session identity (or a `br list --assignee <a
 * session identity> --json` that returns no issues; a list without
 * `--assignee`, or for another name, never clears it). Call arguments,
 * echoes, failures, wrong paths and foreign/closed beads never clear it.
 * Nothing else in a turn makes it speak.
 *
 * Self-declared identity: a session with no host identity (no BR_ACTOR /
 * BR_AGENT_NAME / AGENT_NAME and no Agent Mail pane identity) pins one from
 * its first successful, untainted ownership observation: the assignee of an
 * owned in_progress/rework `br show --json` row, or X of an empty
 * `br list --assignee X --json`. The pin persists for the session, so later
 * compactions compare against it. It is self-declared: a guard against
 * forgetting the reread, not a security boundary.
 *
 * Only applicable rereads are mandatory: AGENTS discovery ends at the nearest
 * Git boundary; tracker rereads require executable br and a local/ancestor
 * .beads or explicit BEADS_DB/BEADS_DIR. Absent prerequisites do not lock a
 * stock session. Unexpected discovery errors leave the conservative gate armed.
 *
 * Fail-open stays only where it already is: the self-close check keeps its
 * fail-open behaviour, but the reread gate's own errors block — a crash in
 * the gate leaves the flag set, so a crash cannot silently bypass it.
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
	toolCallId?: unknown;
	toolName?: unknown;
	input?: unknown;
}

/** Result side of a tool call. Same shape omp exposes (cf. kit-save-guard's
 * SaveGuardToolExecutionEndEvent): `isError` marks failure, `result` carries
 * the tool-specific details envelope. */
export interface FlywheelToolExecutionEndEvent {
	type?: "tool_execution_end";
	toolCallId?: unknown;
	toolName?: unknown;
	result?: unknown;
	isError?: unknown;
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
	on(event: "tool_execution_end", handler: (event: FlywheelToolExecutionEndEvent, ctx: FlywheelContext) => unknown): void;
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

/** Only a verified absence is not applicable; discovery failures stay fail-closed. */
function rereadPathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return false;
		throw error;
	}
}

export function nearestAgentsMd(cwd: string): string | null {
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		const candidate = join(dir, "AGENTS.md");
		if (rereadPathExists(candidate)) return candidate;
		// A nested stock repository does not inherit the toolkit checkout's rules.
		if (rereadPathExists(join(dir, ".git")) || dirname(dir) === dir) return null;
	}
}

function trackerRereadApplies(cwd: string, env: Record<string, string | undefined>): boolean {
	let hasBr = false;
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		const candidate = resolve(cwd, directory || ".", "br");
		try {
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, constants.X_OK);
			hasBr = true;
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "ELOOP") continue;
			throw error;
		}
	}
	if (!hasBr) return false;
	// An explicitly selected tracker remains applicable even when it is broken.
	if (env.BEADS_DB?.trim() || env.BEADS_DIR?.trim()) return true;
	for (let dir = resolve(cwd); ; dir = dirname(dir)) {
		if (rereadPathExists(join(dir, ".beads"))) return true;
		if (dirname(dir) === dir) return false;
	}
}

export function compactionRereadMessage(pending: PendingReread): string {
	const steps: string[] = [];
	if (!pending.agentsOk) steps.push(`reread ${pending.agentsPath} in full`);
	const assignee = pending.identities.length > 0 ? pending.identities[0] : "<your agent name>";
	if (!pending.beadOk) {
		steps.push(`run \`br list --status in_progress --assignee ${assignee} --json\` and \`br show <id> --json\` for your in-progress bead`);
	}
	return [
		"<system-reminder>",
		`kit-flywheel-guard ${COMPACTION_REREAD}: the context was just compacted and the summary does not carry the rules.`,
		`Before continuing: ${steps.join(", then ")}.`,
		"</system-reminder>",
	].join("\n");
}

const BR_REREAD_MUTATING_VERBS: Record<string, true> = { update: true, close: true, comments: true };
const GIT_DIR_FLAGS: Record<string, true> = { "-C": true, "--git-dir": true, "--work-tree": true };
const BEAD_OWNED_STATUSES: Record<string, true> = { in_progress: true, rework: true };
const READ_CONTENT_KEYS = ["content", "text", "output", "stdout"] as const;

/** First positional word, skipping flags and (for known flags) their values. */
function firstVerb(words: string[], valueFlags: Record<string, true>): string | null {
	for (let at = 0; at < words.length; at += 1) {
		const word = words[at]!;
		if (!word.startsWith("-") || word === "-") return word.toLowerCase();
		const name = word.split("=")[0]!;
		if (valueFlags[name] === true && !word.includes("=")) at += 1;
	}
	return null;
}

function simpleExecutable(words: string[]): { exe: string; rest: string[] } | null {
	let at = 0;
	while (at < words.length && (isAssignment(words[at]!) || WRAPPERS[words[at]!.toLowerCase()] === true)) at += 1;
	const first = words[at];
	if (first === undefined) return null;
	return { exe: first.slice(first.lastIndexOf("/") + 1).toLowerCase(), rest: words.slice(at + 1) };
}

/**
 * Pure classifier for the compaction reread gate: edit/write always mutate;
 * bash mutates when any simple command runs `br|bd update|close|comments`
 * or `git commit|push` (compound commands included; obfuscated invocations
 * can evade the regex, accepted: guard against forgetting, not a boundary).
 */
export function isMutatingCall(event: FlywheelToolCallEvent): boolean {
	const tool = typeof event.toolName === "string" ? event.toolName.toLowerCase() : "";
	if (tool === "edit" || tool === "write") return true;
	if (tool !== "bash") return false;
	const command = field(event.input, "command");
	if (typeof command !== "string" || command.trim() === "") return false;
	for (const words of shellCommands(command)) {
		const parsed = simpleExecutable(words);
		if (parsed === null) continue;
		if (parsed.exe === "br" || parsed.exe === "bd") {
			const verb = firstVerb(parsed.rest, BR_VALUE_FLAGS);
			if (verb !== null && BR_REREAD_MUTATING_VERBS[verb] === true) return true;
		} else if (parsed.exe === "git") {
			const sub = firstVerb(parsed.rest, GIT_DIR_FLAGS);
			if (sub === "commit" || sub === "push") return true;
		}
	}
	return false;
}

/** Pending reread state armed by `session_compact`; null when satisfied. */
export interface PendingReread {
	agentsPath: string | null;
	identities: string[];
	agentsOk: boolean;
	beadOk: boolean;
}

/** Missing-read fragment for the block reason, built at the gate. */
function rereadMissing(pending: PendingReread): string {
	const missing: string[] = [];
	if (!pending.agentsOk) missing.push(pending.agentsPath === null ? "AGENTS.md (none found)" : `read ${pending.agentsPath}`);
	if (!pending.beadOk) missing.push("`br show <id> --json` of your in_progress bead (or an empty `br list --status in_progress --assignee <you> --json`)");
	return missing.join(" and ");
}

/** Concatenated `type:"text"` blocks of a native content array; null when none. */
function contentBlocksText(blocks: unknown): string | null {
	if (!Array.isArray(blocks)) return null;
	const parts: string[] = [];
	for (const block of blocks) {
		if (field(block, "type") !== "text") continue;
		const text = field(block, "text");
		if (typeof text === "string") parts.push(text);
	}
	return parts.length > 0 ? parts.join("") : null;
}

/**
 * Result text: OMP's native `tool_execution_end` envelope carries
 * `{content: [{type:"text", text}], details}`; older string shapes at the top
 * level or under `details` are still accepted.
 */
function stringField(value: unknown, keys: readonly string[]): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (Array.isArray(record["content"])) return contentBlocksText(record["content"]);
	for (const key of keys) {
		const candidate = key in record ? record[key] : undefined;
		if (typeof candidate === "string") return candidate;
		const nested = field(record["details"], key);
		if (typeof nested === "string") return nested;
	}
	return null;
}


/** Failure/truncation/refusal markers anywhere in a result envelope. */
function resultTainted(result: unknown): boolean {
	const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : null;
	const details = record !== null && typeof record["details"] === "object" && record["details"] !== null
		? record["details"] as Record<string, unknown> : null;
	for (const source of [details, record]) {
		if (source === null) continue;
		for (const key of ["truncated", "isTruncated", "partial"]) {
			if (source[key] === true) return true;
		}
		for (const key of ["code", "exitCode"]) {
			const code = source[key];
			if (typeof code === "number" && code !== 0) return true;
		}
	}
	// Native read truncation arrives nested as `details.truncation.truncated`.
	if (details !== null && field(details["truncation"], "truncated") === true) return true;
	return false;
}

function parseBeadRow(stdout: string, id: string): { status: string; assignee: string | null } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
	const row = rows.find(item => field(item, "id") === id) ?? (rows.length === 1 ? rows[0] : undefined);
	const status = field(row, "status");
	if (typeof status !== "string") return null;
	const assignee = field(row, "assignee");
	const owner = typeof assignee === "string" ? assignee.trim() : "";
	return { status, assignee: owner === "" ? null : owner };
}

/** Ids named by `br|bd show` verbs in a bash command. */
function brShowIds(command: string): string[] {
	const ids: string[] = [];
	for (const words of shellCommands(command)) {
		const parsed = simpleExecutable(words);
		if (parsed === null || (parsed.exe !== "br" && parsed.exe !== "bd")) continue;
		let at = 0;
		const rest = parsed.rest;
		while (at < rest.length) {
			const word = rest[at]!;
			if (!word.startsWith("-") || word === "-") break;
			const name = word.split("=")[0]!;
			at += BR_VALUE_FLAGS[name] === true && !word.includes("=") ? 2 : 1;
		}
		if (rest[at]?.toLowerCase() !== "show") continue;
		at += 1;
		while (at < rest.length) {
			const word = rest[at]!;
			if (!word.startsWith("-") || word === "-") {
				if (word !== "-") ids.push(word);
				break;
			}
			const name = word.split("=")[0]!;
			at += BR_VALUE_FLAGS[name] === true && !word.includes("=") ? 2 : 1;
		}
	}
	return ids;
}

/** `--assignee` values named by `br|bd list` verbs in a bash command; a list without one contributes nothing. */
function brListAssignees(command: string): string[] {
	const assignees: string[] = [];
	for (const words of shellCommands(command)) {
		const parsed = simpleExecutable(words);
		if (parsed === null || (parsed.exe !== "br" && parsed.exe !== "bd")) continue;
		if (firstVerb(parsed.rest, BR_VALUE_FLAGS) !== "list") continue;
		for (let at = 0; at < parsed.rest.length; at += 1) {
			const word = parsed.rest[at]!;
			const value = word === "--assignee" ? parsed.rest[at + 1] : word.startsWith("--assignee=") ? word.slice("--assignee=".length) : undefined;
			if (value !== undefined && value.trim() !== "") assignees.push(value.trim());
		}
	}
	return assignees;
}

export interface RereadCall {
	toolName: string;
	input: unknown;
	cwd: string;
}

/**
 * Observe one successful tool result against the pending reread. Only
 * observed results count: call arguments, echoes, failures, wrong paths and
 * foreign/closed beads never set a flag. An identity-less pending pins the
 * first owned assignee it observes (see the header). Returns true when both
 * flags land.
 */
export function observeRereadResult(call: RereadCall, result: unknown, pending: PendingReread, home: string): boolean {
	if (resultTainted(result)) return false;
	const tool = call.toolName.toLowerCase();
	if (tool === "read") {
		const raw = field(call.input, "path");
		if (typeof raw === "string" && pending.agentsPath !== null
			&& resolve(call.cwd, expandHome(raw.trim(), home)) === pending.agentsPath) {
			const content = stringField(result, READ_CONTENT_KEYS);
			if (content !== null && content.length > 0) pending.agentsOk = true;
		}
	} else if (tool === "bash") {
		const command = field(call.input, "command");
		const stdout = typeof command === "string" ? stringField(result, READ_CONTENT_KEYS) : null;
		if (stdout !== null && typeof command === "string") {
			const owns = (name: string): boolean => {
				if (pending.identities.length === 0) pending.identities = [name];
				return pending.identities.some(identity => identity.toLowerCase() === name.toLowerCase());
			};
			for (const id of brShowIds(command)) {
				const row = parseBeadRow(stdout, id);
				if (row !== null && BEAD_OWNED_STATUSES[row.status] === true && row.assignee !== null && owns(row.assignee)) {
					pending.beadOk = true;
				}
			}
			const listAssignees = pending.beadOk ? [] : brListAssignees(command);
			if (listAssignees.length > 0) {
				let issues: unknown = null;
				try {
					const parsed: unknown = JSON.parse(stdout);
					issues = Array.isArray(parsed) ? parsed : field(parsed, "issues");
				} catch {
					// Non-JSON list output proves nothing; the flag stays unset.
				}
				if (Array.isArray(issues) && issues.length === 0 && listAssignees.some(owns)) pending.beadOk = true;
			}
		}
	}
	return pending.agentsOk && pending.beadOk;
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
	operation: "close" | "claim" | "start" | "block" | "release";
	/** Labels this command adds or sets (comma-split). */
	addLabels: string[];
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

/** Shells whose `-c <script>` string is parsed too, so a wrapped `sh -c "br ..."` is not a bypass (ompkit-fp72.131 AC7). */
const SHELL_WRAPPERS: Record<string, true> = { sh: true, bash: true, zsh: true, dash: true };
const MAX_SHELL_DEPTH = 3;

/** Supported close/claim/start/block mutations, with the cwd selected by leading cd commands; `sh -c` strings are followed. */
export function trackerRequests(command: string, cwd: string, home: string, depth = 0): TrackerRequest[] {
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
		if (SHELL_WRAPPERS[name] === true && depth < MAX_SHELL_DEPTH) {
			const flag = argv.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c$/.test(word));
			const script = flag > 0 ? argv[flag + 1] : undefined;
			if (script !== undefined) {
				for (const nested of trackerRequests(script, current, home, depth + 1)) {
					requests.push({ ...nested, identities: [...identities, ...nested.identities], actor: nested.actor ?? inlineActor });
				}
			}
			continue;
		}
		if (name !== "br" && name !== "bd") continue;
		let db: string | undefined;
		let subcommand: string | undefined;
		let actor: string | null = null;
		let assignee: string | null = null;
		let status: string | null = null;
		const addLabels: string[] = [];
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
				if (flag === "--add-label" || flag === "--set-labels" || flag === "--labels") addLabels.push(...value.split(",").map(label => label.trim()).filter(label => label !== ""));
				continue;
			}
			if (subcommand === undefined) subcommand = word;
			else ids.push(word);
		}
		if (readOnly) continue;
		const nativeStatus = status?.toLowerCase();
		const operation = subcommand === "close" ? "close"
			: subcommand === "update" && nativeStatus === "blocked" ? "block"
				: subcommand === "update" && claim ? "claim"
					: subcommand === "update" && (nativeStatus === "in_progress" || nativeStatus === "inprogress") ? "start"
						: subcommand === "update" && nativeStatus === "open" ? "release" : null;
		if (operation === null) continue;
		requests.push({ bin: argv[0]!, ids, cwd: current, db, identities, operation, actor: actor ?? inlineActor, assignee, force, addLabels });
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

export const BLOCK_REFUSED = "BLOCK_REFUSED";
/** A human-gate comment must name the effect only Joshua can perform: `HUMAN-GATE: <effect>`, at least 16 characters. */
const HUMAN_GATE_COMMENT = /human-gate:\s*\S[\s\S]{14,}/i;

function refuseBlock(id: string, why: string, next: string): FlywheelToolCallResult {
	return { block: true, reason: `kit-flywheel-guard ${BLOCK_REFUSED}: ${id} ${why}. ${next} Nothing was changed.` };
}

async function execJson(exec: FlywheelExec, request: TrackerRequest, args: string[]): Promise<{ ok: true; value: unknown } | { ok: false; why: string }> {
	let result: FlywheelExecResult;
	try {
		result = await exec(request.bin, [...args, "--no-auto-import", "--no-auto-flush", ...(request.db ? ["--db", request.db] : [])], { cwd: request.cwd, timeout: FLYWHEEL_EXEC_TIMEOUT_MS });
	} catch (error) {
		return { ok: false, why: `\`${request.bin} ${args.join(" ")}\` could not run (${error instanceof Error ? error.message : String(error)})` };
	}
	if (result.code !== 0 || result.killed) return { ok: false, why: `\`${request.bin} ${args.join(" ")}\` exited ${result.killed ? "after timeout" : result.code}` };
	try {
		return { ok: true, value: JSON.parse(result.stdout) };
	} catch {
		return { ok: false, why: `\`${request.bin} ${args.join(" ")}\` returned unparseable output` };
	}
}

/**
 * BLOCKEDADMIT1: status=blocked needs an open blocks edge to a bead that is not closed, or the human-gate
 * label backed by a comment that names the effect only Joshua can perform. A wait on a role's decision is an
 * assigned bead, not a blocked one. Reads are native `show`/`dep list`; an unreadable bead is refused.
 */
async function checkBlockedHasFix(request: TrackerRequest, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	for (const id of request.ids) {
		const shown = await execJson(deps.exec, request, ["show", id, "--json"]);
		const edges = await execJson(deps.exec, request, ["dep", "list", id, "--json"]);
		if (!shown.ok) return refuseBlock(id, `cannot be checked for a blocking fix (${shown.why})`, "Restore the native lookup, then retry.");
		if (!edges.ok) return refuseBlock(id, `cannot be checked for a blocking fix (${edges.why})`, "Restore the native lookup, then retry.");
		const rows: unknown[] = Array.isArray(edges.value) ? edges.value : [];
		const open = rows.some(row => field(row, "type") === "blocks" && typeof field(row, "status") === "string"
			&& field(row, "status") !== "closed" && field(row, "status") !== "tombstone");
		if (open) continue;
		const bead = Array.isArray(shown.value) ? shown.value[0] : shown.value;
		const labels = field(bead, "labels");
		const labelled = request.addLabels.includes("human-gate") || (Array.isArray(labels) && labels.includes("human-gate"));
		const comments = field(bead, "comments");
		const named = Array.isArray(comments) && comments.some(comment => {
			const text = field(comment, "text");
			return typeof text === "string" && HUMAN_GATE_COMMENT.test(text);
		});
		if (labelled && named) continue;
		if (labelled) {
			return refuseBlock(id, "carries human-gate but no comment names the effect only Joshua can perform",
				"Add a comment `HUMAN-GATE: <the credential, account, payment or legal act only Joshua can do>` first.");
		}
		return refuseBlock(id, "has no open blocks edge to a fix",
			`Run \`br dep add ${id} <fix bead>\` (an open bead, never an epic you are under) first, or, if only Joshua can perform the effect, add a \`HUMAN-GATE: <effect>\` comment and the human-gate label. A decision owed by a director, chief or owner is an assigned bead with the decision as its next action, not a blocked one.`);
	}
	return undefined;
}

export const BLOCK_RELEASE_REQUIRED = "BLOCK_RELEASE_REQUIRED";
const MAX_DEPENDENTS_CHECKED = 20;

/**
 * BLOCKEDADMIT1 AC4: closing a bead must not strand a blocked bead whose only open blocker it was. The same command
 * must release that bead (`br update <id> --status open`) or the bead must keep another open blocks edge. Unreadable
 * dependents are skipped (the close itself was already checked); at most MAX_DEPENDENTS_CHECKED are read.
 */
async function checkCloseOrphansDependents(request: TrackerRequest, id: string, released: ReadonlySet<string>, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	const shown = await execJson(deps.exec, request, ["show", id, "--json"]);
	if (!shown.ok) return undefined;
	const bead = Array.isArray(shown.value) ? shown.value[0] : shown.value;
	const dependents = field(bead, "dependents");
	if (!Array.isArray(dependents)) return undefined;
	const waiting = dependents
		.filter(row => field(row, "dependency_type") === "blocks" && field(row, "status") === "blocked")
		.map(row => field(row, "id"))
		.filter((dependent): dependent is string => typeof dependent === "string" && !released.has(dependent))
		.slice(0, MAX_DEPENDENTS_CHECKED);
	const orphaned: string[] = [];
	for (const dependent of waiting) {
		const edges = await execJson(deps.exec, request, ["dep", "list", dependent, "--json"]);
		if (!edges.ok || !Array.isArray(edges.value)) continue;
		const stillBlocked = edges.value.some(row => field(row, "type") === "blocks" && field(row, "depends_on_id") !== id
			&& typeof field(row, "status") === "string" && field(row, "status") !== "closed" && field(row, "status") !== "tombstone");
		if (!stillBlocked) orphaned.push(dependent);
	}
	if (orphaned.length === 0) return undefined;
	return {
		block: true,
		reason: `kit-flywheel-guard ${BLOCK_RELEASE_REQUIRED}: closing ${id} would leave blocked ${orphaned.join(", ")} with no open blocker. `
			+ `Release them in the same command first (${orphaned.map(bead => `br update ${bead} --status open`).join(" && ")} && br close ${id} ...) or add another open blocks edge. Nothing was closed.`,
	};
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
	const released = new Set(requests.filter(request => request.operation === "release").flatMap(request => request.ids));
	for (const request of requests) {
		if (request.operation === "release") continue;
		if (request.operation === "block") {
			const refusal = await checkBlockedHasFix(request, deps);
			if (refusal !== undefined) return refusal;
			continue;
		}
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
			const orphaned = await checkCloseOrphansDependents(request, id, released, deps);
			if (orphaned !== undefined) return orphaned;
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
	let pendingReread: PendingReread | null = null;
	/** Identity pinned by an identity-less session's first owned observation (self-declared; see header). */
	let selfDeclared: string | null = null;
	const pendingCalls = new Map<string, RereadCall>();
	pi.on("session_compact", async (_event, ctx) => {
		// Arm conservatively before discovery: an I/O failure cannot bypass the gate.
		pendingCalls.clear();
		const envIdentities = IDENTITY_ENV.map(name => env[name]?.trim()).filter((value): value is string => Boolean(value));
		pendingReread = { agentsPath: null, identities: envIdentities, agentsOk: false, beadOk: false };
		try {
			pendingReread.identities = [...new Set([...envIdentities, ...await paneIdentities(pi.exec, env, home, [ctx.cwd])])];
		} catch { /* the reminder still goes out without a name */ }
		if (pendingReread.identities.length === 0 && selfDeclared !== null) pendingReread.identities = [selfDeclared];
		pendingReread.agentsPath = nearestAgentsMd(ctx.cwd);
		pendingReread.beadOk = !trackerRereadApplies(ctx.cwd, env);
		pendingReread.agentsOk = pendingReread.agentsPath === null;
		if (pendingReread.agentsOk && pendingReread.beadOk) {
			pendingReread = null;
			return;
		}
		pi.sendMessage(
			{ customType: "kit-flywheel-guard", content: compactionRereadMessage(pendingReread), display: true,
				details: { behavior: COMPACTION_REREAD } },
			// Idle: append to context now. Streaming (auto-compaction mid-run): inject at the next step boundary.
			{ deliverAs: ctx.isIdle?.() === false ? "aside" : "nextTurn" },
		);
	});
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
				pendingCalls.set(event.toolCallId, { toolName: event.toolName, input: event.input, cwd: ctx.cwd });
			}
			if (pendingReread !== null && isMutatingCall(event)) {
				const tool = typeof event.toolName === "string" ? event.toolName : "this call";
				return {
					block: true,
					reason: `kit-flywheel-guard ${COMPACTION_REREAD}: ${tool} blocked until ${rereadMissing(pendingReread)} return successful results. Reading is always allowed.`,
				};
			}
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
	pi.on("tool_execution_end", (_event, ctx) => {
		try {
			if (pendingReread === null) return;
			if (typeof _event.toolCallId !== "string" || _event.isError === true) return;
			const call = pendingCalls.get(_event.toolCallId);
			if (call === undefined) return;
			pendingCalls.delete(_event.toolCallId);
			const identityLess = pendingReread.identities.length === 0;
			const done = observeRereadResult(call, _event.result, pendingReread, home);
			if (identityLess && pendingReread.identities.length > 0) selfDeclared = pendingReread.identities[0]!;
			if (done && pendingReread.agentsOk && pendingReread.beadOk) pendingReread = null;
		} catch (error) {
			// Fail closed: the flags stay unset, so the gate keeps blocking.
			ctx.ui?.notify(`kit-flywheel-guard ${COMPACTION_REREAD}: reread observation failed (${error instanceof Error ? error.message : String(error)}); still blocked.`, "warning");
		}
	});
}
