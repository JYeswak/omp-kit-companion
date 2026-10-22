import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FleetGuardEvent {
	toolName?: unknown;
	name?: unknown;
	command?: unknown;
	arguments?: unknown;
	input?: unknown;
	params?: unknown;
	cwd?: unknown;
}

export interface FleetGuardContext {
	cwd?: string;
	repoRoot?: string;
	projectRoot?: string;
}

export interface FleetGuardBlock {
	block: true;
	reason: string;
}

const MAIN_ONLY_REASON =
	"fleet-guard main-only: branch/worktree creation is blocked. Work on main and publish only through the private-index landing route (`omp-kit land --paths <reserved> --message <msg> --apply` with an active exclusive reservation); see AGENTS.md Working on main.";
const PUSH_REASON =
	"fleet-guard publication: raw `git push` is refused (BRANCHGUARD1: no new branches, no direct publication; see AGENTS.md Working on main). Publish only through the private-index landing route (`omp-kit land --paths <reserved> --message <msg> --apply` with an active exclusive reservation); naming a candidate ref or a prior feasibility proof is not a permit; no files were changed.";
const BRANCH_OPT_OUT = ".omp/fleet-guard.json";

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function commandFromEvent(event: FleetGuardEvent): string | undefined {
	const direct = [event.command, event.arguments && typeof event.arguments === "object" ? (event.arguments as Record<string, unknown>).command : undefined, event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>).command : undefined, event.params && typeof event.params === "object" ? (event.params as Record<string, unknown>).command : undefined];
	for (const value of direct) {
		const text = asString(value);
		if (text) return text;
	}
	for (const value of [event.arguments, event.input, event.params]) {
		if (Array.isArray(value)) {
			const words = value.filter((item): item is string => typeof item === "string");
			if (words.length) return words.join(" ");
		}
	}
	return undefined;
}

/**
 * One word of a simple command. `expanded` marks a word with an unquoted or double-quoted parameter/command
 * expansion, tilde or glob: its `text` is the source spelling, not the literal argument the program receives.
 */
export interface ShellWord { text: string; expanded: boolean }

/** A simple command the shell would run, after reserved words, NAME=value prefixes and exec wrappers. */
export interface ExecutedCommand {
	argv: readonly ShellWord[];
	/** `argv` texts. */
	words: readonly string[];
}

// `writes`: targets of output redirections (`>`, `>>`, `>|`, `&>`, `&>>`, `<>` and `>&` naming a file, not a descriptor).
interface LexedCommand { words: ShellWord[]; stdin: string[]; writes: ShellWord[] }
type Lexed = { commands: LexedCommand[]; substitutions: string[] } | { error: string };

// Longest operator first. `<(`/`>(` process substitutions are matched before these.
const REDIRECTIONS = ["<<<", "<<-", "&>>", "<<", ">>", ">&", ">|", "<&", "<>", "&>", ">", "<"] as const;
const FD_NUMBER = /^\d+$/;

function closingBacktick(text: string, open: number): number {
	for (let index = open + 1; index < text.length; index++) {
		if (text[index] === "\\") { index++; continue; }
		if (text[index] === "`") return index;
	}
	return -1;
}

// Inside backquotes, \` \\ and \$ escape the nested command text.
function backtickBody(raw: string): string {
	return raw.replace(/\\([`\\$])/g, "$1");
}

// Index of the `)` closing the `(` at `open`; quote-, escape- and nesting-aware, iterative. -1 when unterminated.
function closingParen(text: string, open: number): number {
	const stack: ("(" | "\"")[] = ["("];
	for (let index = open + 1; index < text.length; index++) {
		const character = text[index]!;
		if (character === "\\") { index++; continue; }
		if (stack.at(-1) === "\"") {
			if (character === "\"") stack.pop();
			else if (character === "$" && text[index + 1] === "(") { stack.push("("); index++; }
			else if (character === "`" && (index = closingBacktick(text, index)) < 0) return -1;
			continue;
		}
		if (character === "'") {
			index = text.indexOf("'", index + 1);
			if (index < 0) return -1;
		} else if (character === "\"") stack.push("\"");
		else if (character === "`") {
			index = closingBacktick(text, index);
			if (index < 0) return -1;
		} else if (character === "(") stack.push("(");
		else if (character === ")") {
			stack.pop();
			if (stack.length === 0) return index;
		}
	}
	return -1;
}

// Command substitutions an unquoted-delimiter here-document body executes. Quotes are literal there.
function heredocSubstitutions(body: string, into: string[]): string | undefined {
	for (let index = 0; index < body.length; index++) {
		const character = body[index]!;
		if (character === "\\") { index++; continue; }
		if (character === "$" && body[index + 1] === "(") {
			const close = closingParen(body, index + 1);
			if (close < 0) return "unterminated $( in a here-document";
			into.push(body.slice(index + 2, close));
			index = close;
		} else if (character === "`") {
			const close = closingBacktick(body, index);
			if (close < 0) return "unterminated backquote in a here-document";
			into.push(backtickBody(body.slice(index + 1, close)));
			index = close;
		}
	}
	return undefined;
}

/**
 * One lexical pass over shell text, not a shell grammar: simple commands split at `;` `&` `|` `(` `)` and newlines,
 * comments and redirections (with their targets) removed, here-document bodies attached as the command's stdin,
 * and the bodies of executed `$(…)`, backquote and `<(…)`/`>(…)` substitutions returned for the caller to inspect.
 * Single-quoted, escaped, commented and quoted-delimiter here-document text is inert. Text this pass cannot
 * delimit (unterminated quotes or substitutions) is an error, never a guess.
 */
function lexShell(text: string): Lexed {
	const commands: LexedCommand[] = [];
	const substitutions: string[] = [];
	const heredocs: { into: string[]; delimiter: string; strip: boolean; expands: boolean }[] = [];
	let current: LexedCommand = { words: [], stdin: [], writes: [] };
	let word = "";
	let inWord = false;
	let expanded = false;
	let quoted = false;
	// The word is a `<(…)`/`>(…)` process substitution: a pipe to inspected command text, never a file.
	let piped = false;
	let redirect: "write" | "duplicate" | "read" | "herestring" | "heredoc" | "heredoc-strip" | undefined;
	let braces = 0;
	const endWord = (): void => {
		if (!inWord) return;
		if (redirect === undefined) current.words.push({ text: word, expanded });
		else if (!piped && (redirect === "write" || (redirect === "duplicate" && word !== "-" && !FD_NUMBER.test(word)))) current.writes.push({ text: word, expanded });
		else if (redirect === "herestring") current.stdin.push(word);
		else if (redirect === "heredoc" || redirect === "heredoc-strip") heredocs.push({ into: current.stdin, delimiter: word, strip: redirect === "heredoc-strip", expands: !quoted });
		redirect = undefined;
		word = "";
		inWord = false;
		expanded = false;
		quoted = false;
		piped = false;
	};
	const endCommand = (): void => {
		endWord();
		redirect = undefined;
		if (current.words.length || current.writes.length) commands.push(current);
		current = { words: [], stdin: [], writes: [] };
	};
	const substitution = (open: number): number | undefined => {
		const close = closingParen(text, open);
		if (close < 0) return undefined;
		substitutions.push(text.slice(open + 1, close));
		word += text.slice(open - 1, close + 1);
		inWord = true;
		expanded = true;
		return close + 1;
	};
	let index = 0;
	while (index < text.length) {
		const character = text[index]!;
		const next = text[index + 1];
		if (character === "\\") {
			if (next !== "\n") { word += next ?? "\\"; inWord = true; quoted = true; }
			index += 2;
			continue;
		}
		if (character === "'") {
			const close = text.indexOf("'", index + 1);
			if (close < 0) return { error: "unterminated single quote" };
			word += text.slice(index + 1, close);
			inWord = true;
			quoted = true;
			index = close + 1;
			continue;
		}
		if (character === "$" && next === "'") {
			let close = index + 2;
			while (close < text.length && text[close] !== "'") close += text[close] === "\\" ? 2 : 1;
			if (close >= text.length) return { error: "unterminated $'...' quote" };
			const raw = text.slice(index + 2, close);
			word += raw;
			inWord = true;
			quoted = true;
			if (raw.includes("\\")) expanded = true;
			index = close + 1;
			continue;
		}
		if (character === "\"") {
			let close = index + 1;
			for (; close < text.length && text[close] !== "\""; close++) {
				const inner = text[close]!;
				if (inner === "\\") {
					const escaped = text[close + 1];
					if (escaped === undefined) break;
					if ("$`\"\\\n".includes(escaped)) {
						if (escaped !== "\n") word += escaped;
						close++;
					} else word += "\\";
					continue;
				}
				if (inner === "$" && text[close + 1] === "(") {
					const end = closingParen(text, close + 1);
					if (end < 0) return { error: "unterminated $( substitution" };
					substitutions.push(text.slice(close + 2, end));
					word += text.slice(close, end + 1);
					expanded = true;
					close = end;
					continue;
				}
				if (inner === "`") {
					const end = closingBacktick(text, close);
					if (end < 0) return { error: "unterminated backquote" };
					substitutions.push(backtickBody(text.slice(close + 1, end)));
					word += text.slice(close, end + 1);
					expanded = true;
					close = end;
					continue;
				}
				if (inner === "$") expanded = true;
				word += inner;
			}
			if (close >= text.length) return { error: "unterminated double quote" };
			inWord = true;
			quoted = true;
			index = close + 1;
			continue;
		}
		if (character === "`") {
			const close = closingBacktick(text, index);
			if (close < 0) return { error: "unterminated backquote" };
			substitutions.push(backtickBody(text.slice(index + 1, close)));
			word += text.slice(index, close + 1);
			inWord = true;
			expanded = true;
			index = close + 1;
			continue;
		}
		if (character === "$" && next === "(") {
			const resumed = substitution(index + 1);
			if (resumed === undefined) return { error: "unterminated $( substitution" };
			index = resumed;
			continue;
		}
		if (character === "$") {
			word += "$";
			if (next === "{") { braces++; word += "{"; index++; }
			inWord = true;
			expanded = true;
			index++;
			continue;
		}
		// Inside ${...} only the quotes, escapes and substitutions above are special.
		if (braces > 0) {
			if (character === "}") braces--;
			word += character;
			index++;
			continue;
		}
		if (character === "\n") {
			endCommand();
			index++;
			for (const doc of heredocs.splice(0)) {
				const lines: string[] = [];
				while (index < text.length) {
					const end = text.indexOf("\n", index);
					const line = text.slice(index, end < 0 ? text.length : end);
					index = end < 0 ? text.length : end + 1;
					let start = 0;
					if (doc.strip) while (line[start] === "\t") start++;
					if (line.slice(start) === doc.delimiter) break;
					lines.push(line);
				}
				const body = lines.join("\n");
				if (doc.expands) {
					const error = heredocSubstitutions(body, substitutions);
					if (error) return { error };
				}
				doc.into.push(body);
			}
			continue;
		}
		if (character === " " || character === "\t" || character === "\r") { endWord(); index++; continue; }
		if (character === "#" && !inWord) {
			while (index < text.length && text[index] !== "\n") index++;
			continue;
		}
		if ((character === "<" || character === ">") && next === "(") {
			endWord();
			const resumed = substitution(index + 1);
			piped = true;
			if (resumed === undefined) return { error: "unterminated process substitution" };
			index = resumed;
			continue;
		}
		const operator = REDIRECTIONS.find((candidate) => text.startsWith(candidate, index));
		if (operator) {
			// A leading unquoted number is the redirected file descriptor (`2>f`), not a word; `x2>f` keeps `x2`.
			if (inWord && !quoted && !expanded && FD_NUMBER.test(word)) { word = ""; inWord = false; }
			else endWord();
			redirect = operator === "<<<" ? "herestring" : operator === "<<-" ? "heredoc-strip" : operator === "<<" ? "heredoc"
				: operator === ">&" ? "duplicate" : operator === "<" || operator === "<&" ? "read" : "write";
			index += operator.length;
			continue;
		}
		if (character === ";" || character === "&" || character === "|" || character === "(" || character === ")") {
			endCommand();
			index++;
			continue;
		}
		if ((character === "~" && !inWord) || character === "*" || character === "?" || character === "[") expanded = true;
		word += character;
		inWord = true;
		index++;
	}
	if (braces > 0) return { error: "unterminated ${ expansion" };
	endCommand();
	return { commands, substitutions };
}

/** Nearest directory at or above `start` holding a `.git` entry. */
export function repositoryRoot(start: string): string | undefined {
	for (let current = resolve(start); ; current = dirname(current)) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
	}
}

function optionValue(words: readonly string[], option: string): string | undefined {
	const index = words.indexOf(option);
	return index >= 0 ? words[index + 1] : undefined;
}

const AMEND_REASON =
	"fleet-guard history: unscoped git commit --amend rewrites shared history. Amend has no scoped form here; see AGENTS.md Working on main.";

// Shell NAME=value assignment (env wrapper), never a git flag or subcommand.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NICE_ADJUSTMENT = /^-n?-?\d+$/;
const SHORT_OPTIONS = /^[A-Za-z]+$/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// Words that open a compound command or a negated pipeline ahead of the command it runs.
const RESERVED_PREFIXES = new Set(["!", "{", "if", "then", "elif", "else", "do", "while", "until"]);

/** Basename of an executable word: `/usr/bin/git` runs git. */
export function commandName(executable: string): string {
	return executable.slice(executable.lastIndexOf("/") + 1);
}

// Index of the command a wrapper runs after its own options; null when the wrapper only looks a name up
// (`command -v`), undefined when words[index] is not a wrapper this guard knows.
function wrappedCommandStart(words: readonly ShellWord[], index: number): number | null | undefined {
	let cursor = index + 1;
	const option = (): string | undefined => {
		const word = words[cursor]?.text;
		return word !== undefined && word.startsWith("-") && word !== "-" ? word : undefined;
	};
	switch (words[index]!.text) {
		case "env":
			for (let word = words[cursor]?.text; word !== undefined; word = words[cursor]?.text) {
				if (word === "-i" || word === "--ignore-environment" || word === "-") cursor++;
				else if (word === "-u" || word === "--unset") cursor += 2;
				else if (ENV_ASSIGNMENT.test(word)) cursor++;
				else break;
			}
			return cursor;
		case "command":
			for (let word = option(); word !== undefined; word = option()) {
				cursor++;
				if (word === "--") break;
				if (word !== "-p") return null;
			}
			return cursor;
		case "exec":
			for (let word = option(); word !== undefined; word = option()) {
				cursor += word === "-a" ? 2 : 1;
				if (word === "--") break;
			}
			return cursor;
		case "time":
			while (words[cursor]?.text === "-p") cursor++;
			return cursor;
		case "nohup":
			return words[cursor]?.text === "--" ? cursor + 1 : cursor;
		case "nice": {
			const word = words[cursor]?.text;
			if (word === "-n") cursor += 2;
			else if (word !== undefined && (NICE_ADJUSTMENT.test(word) || word.startsWith("--adjustment="))) cursor++;
			return cursor;
		}
		case "timeout":
			for (let word = option(); word !== undefined; word = option()) {
				cursor += word === "-s" || word === "-k" || word === "--signal" || word === "--kill-after" ? 2 : 1;
				if (word === "--") break;
			}
			return cursor + 1;
		default:
			return undefined;
	}
}

// The command a simple command actually runs: reserved words, NAME=value prefixes and known wrappers skipped.
// Every NAME a prefix or `env` operand assigns is appended to `assigned`, also for assignment-only commands.
function executedArgv(words: readonly ShellWord[], assigned: string[]): readonly ShellWord[] | undefined {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (RESERVED_PREFIXES.has(word.text)) { index++; continue; }
		if (ENV_ASSIGNMENT.test(word.text)) { assigned.push(word.text.slice(0, word.text.indexOf("="))); index++; continue; }
		if (word.expanded) return words.slice(index);
		const start = wrappedCommandStart(words, index);
		if (start === null) return undefined;
		if (start === undefined) return words.slice(index);
		if (word.text === "env") {
			for (const operand of words.slice(index + 1, start))
				if (ENV_ASSIGNMENT.test(operand.text)) assigned.push(operand.text.slice(0, operand.text.indexOf("=")));
		}
		index = start;
	}
	return undefined;
}

// Shell text a command executes in-process: `eval` operands, a shell's -c script and its stdin (here-documents,
// here-strings). A script-file operand is not read.
function nestedShellTexts(argv: readonly ShellWord[], stdin: readonly string[]): string[] {
	const name = commandName(argv[0]!.text);
	if (name === "eval") return [argv.slice(1).map((word) => word.text).join(" ")];
	if (!SHELLS.has(name)) return [];
	const texts = [...stdin];
	let script = false;
	for (let index = 1; index < argv.length; index++) {
		const text = argv[index]!.text;
		if (script) { texts.push(text); break; }
		if (text === "--" || (!text.startsWith("-") && !text.startsWith("+"))) break;
		if (text === "-o" || text === "+o" || text === "-O" || text === "+O") { index++; continue; }
		if (text[0] === "-" && SHORT_OPTIONS.test(text.slice(1)) && text.includes("c")) script = true;
	}
	return texts;
}

const SUBSTITUTION_BUDGET = 32;
const SUBSTITUTION_REASON =
	"fleet-guard refusal: nested shell substitution exceeds the bounded inspection budget; no files were changed.";

/** An output redirection's target, opened before `commands[at]` runs (`at === commands.length`: after the last one). */
export interface ShellWrite { target: ShellWord; at: number }

export interface ShellInspection {
	commands: ExecutedCommand[];
	/** Environment names assigned by NAME=value prefixes, assignment-only commands and `env` operands. */
	assignments: string[];
	writes: ShellWrite[];
}

/**
 * Every simple command a shell call would run: top-level commands, executed substitutions, `eval` and nested shell
 * text, each costing one unit of a budget shared across the whole call. Text the lexer cannot delimit, or more units
 * than the budget, is a refusal. The git, scratch and write-ownership guards share this traversal.
 */
export function executedShellCommands(command: string): ShellInspection | { refusal: string } {
	const pending = [command];
	const commands: ExecutedCommand[] = [];
	const assignments: string[] = [];
	const writes: ShellWrite[] = [];
	for (let unit = 0; unit < pending.length; unit++) {
		if (unit >= SUBSTITUTION_BUDGET) return { refusal: SUBSTITUTION_REASON };
		const lexed = lexShell(pending[unit]!);
		if ("error" in lexed) return { refusal: `fleet-guard refusal: shell text could not be inspected (${lexed.error}); no files were changed.` };
		pending.push(...lexed.substitutions);
		for (const { words, stdin, writes: targets } of lexed.commands) {
			for (const target of targets) writes.push({ target, at: commands.length });
			const argv = executedArgv(words, assignments);
			if (!argv) continue;
			commands.push({ argv, words: argv.map((word) => word.text) });
			pending.push(...nestedShellTexts(argv, stdin));
		}
	}
	return { commands, assignments, writes };
}

const BYPASS_VARIABLES = new Set(["AGENT_MAIL_BYPASS", "AGENT_MAIL_GUARD_MODE"]);
const DECLARATION_BUILTINS = new Set(["export", "declare", "typeset", "readonly", "local"]);

// BYPASSENV1 (ompkit-0daxx): the Agent Mail commit guard turns itself off when either variable is set, and its own
// refusal text says so. An agent tool call that assigns or exports one (prefix, assignment-only, `env` operand,
// declaration builtin, in any nested shell or substitution) is refused; unsetting and mentioning stay quiet.
function bypassVariable(inspection: ShellInspection): string | undefined {
	const assigned = inspection.assignments.find((name) => BYPASS_VARIABLES.has(name));
	if (assigned) return assigned;
	for (const { words } of inspection.commands) {
		if (!DECLARATION_BUILTINS.has(words[0]!)) continue;
		for (const word of words.slice(1)) {
			const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
			if (BYPASS_VARIABLES.has(name)) return name;
		}
	}
	return undefined;
}

function bypassReason(name: string): string {
	return `fleet-guard BYPASS_ENV: this call sets ${name}, which switches the Agent Mail reservation guard off; agent tool calls may not set AGENT_MAIL_BYPASS or AGENT_MAIL_GUARD_MODE. Reserve the paths you commit instead (am file_reservations reserve <project> <agent> <path> --exclusive) and land with git commit --only -- <reserved paths>; no files were changed.`;
}

/** BYPASSENV1 alone, as the conformance corpus dispatches it; `check` applies the same predicate first in its chain. */
export function checkBypassEnvironment(event: FleetGuardEvent): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return { block: true, reason: inspection.refusal };
	const name = bypassVariable(inspection);
	return name ? { block: true, reason: bypassReason(name) } : undefined;
}

interface CommitScope {
	amend: boolean;
	only: boolean;
	paths: string[];
}

const COMMIT_VALUE_OPTIONS = ["-m", "--message", "-F", "--file", "--author", "--date", "--reuse-message", "--reedit-message"];

function analyzeCommit(words: readonly string[]): CommitScope | null {
	let index = 1;
	while (index < words.length) {
		const word = words[index]!;
		if (word === "--") { index++; break; }
		if (!word.startsWith("-") || word === "-") break;
		if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree") { index += 2; continue; }
		if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=")) { index++; continue; }
		index++;
	}
	if (index >= words.length || words[index] !== "commit") return null;
	index++;
	let amend = false;
	let only = false;
	const paths: string[] = [];
	for (; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--") {
			for (index++; index < words.length; index++) paths.push(words[index]!);
			break;
		}
		if (word === "--amend") { amend = true; continue; }
		if (word === "--only") { only = true; continue; }
		if (COMMIT_VALUE_OPTIONS.includes(word)) { index++; continue; }
		if (isMessageBundle(word)) { index++; continue; }
		if (!word.startsWith("-") || word === "-") paths.push(word);
	}
	return { amend, only, paths };
}

const ONLY_IDENTITY_REASON =
	"fleet-guard history: git commit --only needs an identified caller with exclusive reservations; set AGENT_NAME and reserve every named path first; no files were changed.";
function onlyUnavailableReason(why: string): string {
	return `fleet-guard history: the reservation lookup for git commit --only failed: ${why}; restore Agent Mail reservation reads before landing; no files were changed.`;
}
const ONLY_FOREIGN_REASON =
	"fleet-guard history: git commit --only names a path outside the repository; no files were changed.";
const ONLY_UNCOVERED_REASON =
	"fleet-guard history: git commit --only names a path without an active exclusive reservation; reserve it first; no files were changed.";

interface ReservationHold {
	pattern: string;
}

export interface AttestedReservation {
	agent: unknown;
	path: string;
	exclusive: boolean;
	remaining_seconds: number;
}

/**
 * The one parser of `am robot reservations --json`, for fleet-guard admissions and `omp-kit land`. Only an
 * attested-current read yields rows. am omits `my_reservations` when the agent holds nothing in that project
 * (am 0.3.36, measured 2026-10-22), so a current read without the key is zero holds, never a failed read: that
 * case used to refuse as "lookup unavailable" and sent workers to repair a healthy Agent Mail (ompkit-rz5.158).
 * Every failure names its cause.
 */
export function parseReservationRead(stdout: string): { rows: AttestedReservation[]; active: AttestedReservation[] } | { why: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { why: "am output is not JSON" };
	}
	if (!parsed || typeof parsed !== "object") return { why: "am output is not a JSON object" };
	const record = parsed as Record<string, unknown>;
	const attestation = record.reservation_read_attestation;
	if (!attestation || typeof attestation !== "object") return { why: "am output has no reservation_read_attestation" };
	const attested = attestation as Record<string, unknown>;
	if (attested.state !== "current" || attested.database_matches_server !== true || attested.storage_root_matches_server !== true) {
		return { why: `the read is not attested current (state=${String(attested.state)}, database_matches_server=${String(attested.database_matches_server)}, storage_root_matches_server=${String(attested.storage_root_matches_server)})` };
	}
	// Everyone's live holds, only to name who blocks a path (rz5.158 AC2); never used to admit, so a malformed row is skipped.
	const active: AttestedReservation[] = [];
	for (const row of Array.isArray(record.all_active) ? record.all_active : []) {
		if (!row || typeof row !== "object") continue;
		const entry = row as Record<string, unknown>;
		if (typeof entry.path === "string" && entry.path && typeof entry.exclusive === "boolean" && typeof entry.remaining_seconds === "number")
			active.push({ agent: entry.agent, path: entry.path, exclusive: entry.exclusive, remaining_seconds: entry.remaining_seconds });
	}
	if (!("my_reservations" in record)) return { rows: [], active };
	const rows = record.my_reservations;
	if (!Array.isArray(rows)) return { why: "my_reservations is not a list" };
	const out: AttestedReservation[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") return { why: "a my_reservations row is not an object" };
		const entry = row as Record<string, unknown>;
		if (!("agent" in entry) || typeof entry.path !== "string" || !entry.path || typeof entry.exclusive !== "boolean" || typeof entry.remaining_seconds !== "number") {
			return { why: "a my_reservations row lacks agent, path, exclusive or remaining_seconds" };
		}
		out.push({ agent: entry.agent, path: entry.path, exclusive: entry.exclusive, remaining_seconds: entry.remaining_seconds });
	}
	return { rows: out, active };
}

function firstLine(text: unknown): string {
	const line = String(text ?? "").trim().split("\n")[0]?.trim() ?? "";
	return line ? `: ${line.slice(0, 200)}` : "";
}

interface ForeignHold {
	pattern: string;
	holder: string;
}

/** The caller's live exclusive holds, and every other agent's live exclusive hold (to name a blocker); a row that is
 * shared or expired covers nothing. */
function readReservationHolds(repoRoot: string, agent: string): { holds: ReservationHold[]; foreign: ForeignHold[] } | { why: string } {
	const run = spawnSync("am", ["robot", "reservations", "--project", repoRoot, "--agent", agent, "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
	if (run.error) {
		const code = (run.error as NodeJS.ErrnoException).code;
		return { why: code === "ETIMEDOUT" ? "am did not answer within 10 s" : code === "ENOENT" ? "am is not on PATH" : `am could not run (${code ?? run.error.message})` };
	}
	if (run.status !== 0) return { why: `am exited ${run.status === null ? `on signal ${run.signal}` : run.status}${firstLine(run.stderr)}` };
	const read = parseReservationRead(String(run.stdout));
	if ("why" in read) return read;
	return {
		holds: read.rows.filter((row) => row.agent === agent && row.exclusive && row.remaining_seconds > 0).map((row) => ({ pattern: row.path })),
		foreign: read.active.filter((row) => typeof row.agent === "string" && row.agent !== agent && row.exclusive && row.remaining_seconds > 0)
			.map((row) => ({ pattern: row.path, holder: row.agent as string })),
	};
}

// Index just past the `]` closing a fnmatch class opened at `open`; -1 when `[` is a literal (no closing `]`).
function classEnd(pattern: string, open: number): number {
	let index = open + 1;
	if (pattern[index] === "!") index++;
	if (pattern[index] === "]") index++;
	while (index < pattern.length && pattern[index] !== "]") index++;
	return index < pattern.length ? index + 1 : -1;
}

function classMatches(pattern: string, open: number, end: number, character: string): boolean {
	let index = open + 1;
	const negate = pattern[index] === "!";
	if (negate) index++;
	let hit = false;
	while (index < end - 1) {
		if (pattern[index + 1] === "-" && index + 2 < end - 1) {
			if (pattern[index]! <= character && character <= pattern[index + 2]!) hit = true;
			index += 3;
		} else {
			if (pattern[index] === character) hit = true;
			index++;
		}
	}
	return hit !== negate;
}

// Agent Mail matches holds with Python fnmatchcase: `*` spans any characters including `/`, `?` one character,
// `[...]`/`[!...]` a class. Iterative match with single-star backtracking, O(pattern × path); no regex.
function fnmatch(pattern: string, path: string): boolean {
	let p = 0;
	let s = 0;
	let star = -1;
	let resume = 0;
	while (s < path.length) {
		if (p < pattern.length) {
			const token = pattern[p]!;
			if (token === "*") { star = p++; resume = s; continue; }
			const end = token === "[" ? classEnd(pattern, p) : -1;
			if (end > 0) {
				if (classMatches(pattern, p, end, path[s]!)) { p = end; s++; continue; }
			} else if (token === "?" || token === path[s]) { p++; s++; continue; }
		}
		if (star < 0) return false;
		p = star + 1;
		s = ++resume;
	}
	while (pattern[p] === "*") p++;
	return p === pattern.length;
}

/** Whether a held reservation pattern covers a repo-relative path: exact, `dir/*` (the dir and everything under it), or fnmatch. */
export function holdCovers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (pattern.endsWith("/*") && pattern.length > 2) {
		const dir = pattern.slice(0, -2);
		if (path === dir || path.startsWith(dir + "/")) return true;
	}
	return fnmatch(pattern, path);
}

export type ReservationGaps =
	| { kind: "identity" }
	| { kind: "unavailable"; agent: string; why: string }
	| { kind: "checked"; agent: string; uncovered: string[]; foreign: { path: string; holder: string }[] };

/**
 * The one reservation lookup for fleet-guard admissions (`git commit --only`, write ownership): the caller's
 * AGENT_NAME and its live exclusive holds from an attested-current `am robot reservations` read. A failed or
 * unattested read is `unavailable` with its named cause, never an empty hold list.
 */
export function reservationGaps(root: string, paths: readonly string[], agent = asString(process.env.AGENT_NAME)): ReservationGaps {
	if (!agent) return { kind: "identity" };
	const read = readReservationHolds(root, agent);
	if ("why" in read) return { kind: "unavailable", agent, why: read.why };
	const uncovered = paths.filter((path) => !read.holds.some((hold) => holdCovers(hold.pattern, path)));
	const foreign = uncovered.flatMap((path) => {
		const hold = read.foreign.find((candidate) => holdCovers(candidate.pattern, path));
		return hold ? [{ path, holder: hold.holder }] : [];
	});
	return { kind: "checked", agent, uncovered, foreign };
}

function relativeRepoPath(root: string, base: string, value: string): string | null {
	const pathFromRoot = relative(root, resolve(base, value));
	if (pathFromRoot === "" || pathFromRoot === "." || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return null;
	return pathFromRoot.split(sep).join("/");
}

function checkOnlyCoverage(paths: string[], root: string, base: string): FleetGuardBlock | undefined {
	if (paths.length === 0) return undefined;
	const relativePaths = paths.map((value) => relativeRepoPath(root, base, value));
	const gaps = reservationGaps(root, relativePaths.filter((path): path is string => path !== null));
	if (gaps.kind === "identity") return { block: true, reason: ONLY_IDENTITY_REASON };
	if (gaps.kind === "unavailable") return { block: true, reason: onlyUnavailableReason(gaps.why) };
	if (relativePaths.includes(null)) return { block: true, reason: ONLY_FOREIGN_REASON };
	// rz5.158 AC2: a path another agent holds exclusively names that holder and the path, so the caller knows whom to ask.
	const held = gaps.foreign[0];
	if (held) return { block: true, reason: `fleet-guard history: git commit --only names ${held.path}, which ${held.holder} holds exclusively; ask ${held.holder} to release or hand it over; no files were changed.` };
	if (gaps.uncovered.length > 0) return { block: true, reason: ONLY_UNCOVERED_REASON };
	return undefined;
}

function isMessageBundle(word: string): boolean {
	if (!word.startsWith("-") || word.startsWith("--") || word.length < 3 || !word.endsWith("m")) return false;
	for (const character of word.slice(1, -1)) {
		if (character < "A" || (character > "Z" && character < "a") || character > "z") return false;
	}
	return true;
}

function branchCreation(words: readonly string[]): boolean {
	const subcommand = words[1];
	if (subcommand === "worktree") return words.slice(2).includes("add");
	if (subcommand === "checkout") return words.includes("-b") || words.includes("-B") || words.includes("--orphan");
	if (subcommand === "switch") return words.includes("-c") || words.includes("-C") || words.includes("--create") || words.includes("--orphan");
	if (subcommand !== "branch") return false;
	for (const word of words.slice(2)) {
		if (!word.startsWith("-")) return true;
		if (["-d", "-D", "-m", "-M", "--delete", "--move", "--rename", "--list", "-l", "-a", "-r", "--all", "--remotes", "--contains", "--no-contains", "--merged", "--no-merged", "--show-current", "--verbose"].includes(word)) return false;
	}
	return false;
}

// BRANCHGUARD1 (ompkit-xa5s.11): every raw `git push` from a tool call is a
// publication attempt and is refused before effect, whatever the ref spelling
// (new branch, HEAD:refs/heads/*, SHA:refs/agent-candidates/*, refs/heads/main,
// deletion refspecs, --tags/--all/--mirror). Publication passes only through
// the native owner-bound landing route (`omp-kit land --apply`), which never
// traverses this tool-call gate, so the gate carries no permit: declaring a
// candidate or a prior proof admits nothing. Dry runs and help output publish
// nothing and stay quiet; `git stash push` is a stash subcommand, not a push.
function rawPush(words: readonly string[]): boolean {
	let index = 1;
	while (index < words.length) {
		const word = words[index]!;
		if (word === "--") { index++; break; }
		if (!word.startsWith("-") || word === "-") break;
		if (word === "-C" || word === "-c" || word === "--git-dir" || word === "--work-tree" || word === "--namespace") { index += 2; continue; }
		if (word.startsWith("--git-dir=") || word.startsWith("--work-tree=") || word.startsWith("--namespace=")) { index++; continue; }
		index++;
	}
	if (index >= words.length || words[index] !== "push") return false;
	for (const word of words.slice(index + 1)) {
		if (word === "-n" || word === "--dry-run" || word === "--help" || word === "-h") return false;
	}
	return true;
}

function branchesOptedOut(root: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, BRANCH_OPT_OUT), "utf8"));
		return Boolean(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).branches === true);
	} catch {
		return false;
	}
}

/** The bash call's own working directory (the `cwd` beside `command`), when it names one. */
function eventWorkingDirectory(event: FleetGuardEvent): string | undefined {
	for (const holder of [event.arguments, event.input, event.params]) {
		if (!holder || typeof holder !== "object") continue;
		const value = asString((holder as Record<string, unknown>).cwd);
		if (value) return value;
	}
	return undefined;
}

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return { block: true, reason: inspection.refusal };
	const bypass = bypassVariable(inspection);
	if (bypass) return { block: true, reason: bypassReason(bypass) };
	const session = context.cwd ?? process.cwd();
	// ompkit-rz5.158: a call that names its own cwd runs there, so its commit is judged in that repository, never
	// the session's. 2026-10-22 05:51-12:40Z: CopperTrout's commits in mcp_agent_mail_rust were judged against
	// omp-kit's reservations (refused 15 times); the same mix-up could admit a commit covered only in the other repo.
	const callCwd = eventWorkingDirectory(event);
	const callBase = callCwd ? resolve(session, callCwd) : undefined;
	for (const { words: effective } of inspection.commands) {
		if (commandName(effective[0]!) !== "git") continue;
		const commandCwd = optionValue(effective, "-C");
		const pathBase = commandCwd ? resolve(callBase ?? session, commandCwd) : callBase ?? context.repoRoot ?? context.projectRoot ?? session;
		const root = repositoryRoot(pathBase);
		if (!root) continue;
		if (branchCreation(effective) && !branchesOptedOut(root)) return { block: true, reason: MAIN_ONLY_REASON };
		if (rawPush(effective)) return { block: true, reason: PUSH_REASON };
		const scope = analyzeCommit(effective);
		if (scope && scope.amend) return { block: true, reason: AMEND_REASON };
		if (scope && scope.only) {
			const verdict = checkOnlyCoverage(scope.paths, root, pathBase);
			if (verdict) return verdict;
		}
	}
	return undefined;
}

export default check;
