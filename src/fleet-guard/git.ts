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

interface LexedCommand { words: ShellWord[]; stdin: string[] }
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
	let current: LexedCommand = { words: [], stdin: [] };
	let word = "";
	let inWord = false;
	let expanded = false;
	let quoted = false;
	let redirect: "file" | "herestring" | "heredoc" | "heredoc-strip" | undefined;
	let braces = 0;
	const endWord = (): void => {
		if (!inWord) return;
		if (redirect === undefined) current.words.push({ text: word, expanded });
		else if (redirect === "herestring") current.stdin.push(word);
		else if (redirect !== "file") heredocs.push({ into: current.stdin, delimiter: word, strip: redirect === "heredoc-strip", expands: !quoted });
		redirect = undefined;
		word = "";
		inWord = false;
		expanded = false;
		quoted = false;
	};
	const endCommand = (): void => {
		endWord();
		redirect = undefined;
		if (current.words.length) commands.push(current);
		current = { words: [], stdin: [] };
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
			if (resumed === undefined) return { error: "unterminated process substitution" };
			index = resumed;
			continue;
		}
		const operator = REDIRECTIONS.find((candidate) => text.startsWith(candidate, index));
		if (operator) {
			// A leading unquoted number is the redirected file descriptor (`2>f`), not a word; `x2>f` keeps `x2`.
			if (inWord && !quoted && !expanded && FD_NUMBER.test(word)) { word = ""; inWord = false; }
			else endWord();
			redirect = operator === "<<<" ? "herestring" : operator === "<<-" ? "heredoc-strip" : operator === "<<" ? "heredoc" : "file";
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

function repositoryRoot(start: string): string | undefined {
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
function executedArgv(words: readonly ShellWord[]): readonly ShellWord[] | undefined {
	let index = 0;
	while (index < words.length) {
		const word = words[index]!;
		if (RESERVED_PREFIXES.has(word.text) || ENV_ASSIGNMENT.test(word.text)) { index++; continue; }
		if (word.expanded) return words.slice(index);
		const start = wrappedCommandStart(words, index);
		if (start === null) return undefined;
		if (start === undefined) return words.slice(index);
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

/**
 * Every simple command a shell call would run: top-level commands, executed substitutions, `eval` and nested shell
 * text, each costing one unit of a budget shared across the whole call. Text the lexer cannot delimit, or more units
 * than the budget, is a refusal. The git and scratch guards share this traversal.
 */
export function executedShellCommands(command: string): { commands: ExecutedCommand[] } | { refusal: string } {
	const pending = [command];
	const commands: ExecutedCommand[] = [];
	for (let unit = 0; unit < pending.length; unit++) {
		if (unit >= SUBSTITUTION_BUDGET) return { refusal: SUBSTITUTION_REASON };
		const lexed = lexShell(pending[unit]!);
		if ("error" in lexed) return { refusal: `fleet-guard refusal: shell text could not be inspected (${lexed.error}); no files were changed.` };
		pending.push(...lexed.substitutions);
		for (const { words, stdin } of lexed.commands) {
			const argv = executedArgv(words);
			if (!argv) continue;
			commands.push({ argv, words: argv.map((word) => word.text) });
			pending.push(...nestedShellTexts(argv, stdin));
		}
	}
	return { commands };
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
const ONLY_UNAVAILABLE_REASON =
	"fleet-guard history: the reservation lookup for git commit --only failed; restore Agent Mail reservation reads before landing; no files were changed.";
const ONLY_FOREIGN_REASON =
	"fleet-guard history: git commit --only names a path outside the repository; no files were changed.";
const ONLY_UNCOVERED_REASON =
	"fleet-guard history: git commit --only names a path without an active exclusive reservation; reserve it first; no files were changed.";

interface ReservationHold {
	pattern: string;
}

function readReservationHolds(repoRoot: string, agent: string): ReservationHold[] | null {
	let output: string;
	try {
		const run = spawnSync("am", ["robot", "reservations", "--project", repoRoot, "--agent", agent, "--json"], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
		if (run.status !== 0) return null;
		output = String(run.stdout);
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	const attestation = record.reservation_read_attestation;
	if (!attestation || typeof attestation !== "object") return null;
	const attested = attestation as Record<string, unknown>;
	if (attested.state !== "current" || attested.database_matches_server !== true || attested.storage_root_matches_server !== true) return null;
	const rows = record.my_reservations;
	if (!Array.isArray(rows)) return null;
	const holds: ReservationHold[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") return null;
		const entry = row as Record<string, unknown>;
		if (entry.agent !== agent || entry.exclusive !== true || typeof entry.remaining_seconds !== "number" || entry.remaining_seconds <= 0 || typeof entry.path !== "string" || !entry.path) return null;
		holds.push({ pattern: entry.path });
	}
	return holds;
}

function holdCovers(pattern: string, path: string): boolean {
	if (pattern === path) return true;
	if (pattern.endsWith("/*") && pattern.length > 2) {
		const dir = pattern.slice(0, -2);
		if (path === dir || path.startsWith(dir + "/")) return true;
	}
	return false;
}

function relativeRepoPath(root: string, base: string, value: string): string | null {
	const pathFromRoot = relative(root, resolve(base, value));
	if (pathFromRoot === "" || pathFromRoot === "." || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return null;
	return pathFromRoot.split(sep).join("/");
}

function checkOnlyCoverage(paths: string[], root: string, base: string): FleetGuardBlock | undefined {
	if (paths.length === 0) return undefined;
	const agent = asString(process.env.AGENT_NAME);
	if (!agent) return { block: true, reason: ONLY_IDENTITY_REASON };
	const holds = readReservationHolds(root, agent);
	if (!holds) return { block: true, reason: ONLY_UNAVAILABLE_REASON };
	for (const value of paths) {
		const path = relativeRepoPath(root, base, value);
		if (!path) return { block: true, reason: ONLY_FOREIGN_REASON };
		if (!holds.some((hold) => holdCovers(hold.pattern, path))) return { block: true, reason: ONLY_UNCOVERED_REASON };
	}
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

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return { block: true, reason: inspection.refusal };
	for (const { words: effective } of inspection.commands) {
		if (commandName(effective[0]!) !== "git") continue;
		const commandCwd = optionValue(effective, "-C");
		const pathBase = commandCwd ? resolve(context.cwd ?? process.cwd(), commandCwd) : context.repoRoot ?? context.projectRoot ?? context.cwd ?? process.cwd();
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
