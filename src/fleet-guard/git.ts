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
	"fleet-guard main-only: branch/worktree creation is blocked. Work on main; see AGENTS.md Working on main.";
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

// Decode words within an execution segment, not a complete shell grammar.
// Keep group punctuation out of words; nested interpreters/substitutions are handled by check().
export function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: "'" | "\"" | undefined;
	let escaped = false;
	for (const character of segment) {
		if (escaped) {
			word += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			continue;
		}
		if (/\s/.test(character) || character === "(" || character === ")") {
			if (word) words.push(word);
			word = "";
			continue;
		}
		word += character;
	}
	if (escaped) word += "\\";
	if (word) words.push(word);
	return words;
}

// The `&` of a redirection (`2>&1`, `>&f`, `<&0`, `&>f`) is part of that redirection, never a command separator.
function redirectionAmpersand(command: string, index: number): boolean {
	const before = command[index - 1];
	return before === ">" || before === "<" || command[index + 1] === ">";
}

export function commandSegments(command: string): string[] {
	const segments: string[] = [];
	let segment = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (quote) {
			segment += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === "\"") {
			quote = character;
			segment += character;
			continue;
		}
		if (character === "&" && redirectionAmpersand(command, index)) {
			segment += character;
			continue;
		}
		if (character === ";" || character === "&" || character === "|") {
			if (segment.trim()) segments.push(segment);
			segment = "";
			continue;
		}
		segment += character;
	}
	if (segment.trim()) segments.push(segment);
	return segments;
}

const REDIRECTION_OPERATORS = ["<<<", "<<-", ">>", ">&", ">|", "<<", "<&", ">", "<"];

// Length of the redirection operator that begins at `index` (optional leading file descriptor digits included),
// or undefined. Digits only count at the start of a word: `x2>f` redirects to f and keeps the word `x2`.
function redirectionOperatorLength(text: string, index: number): number | undefined {
	let cursor = index;
	if (index === 0 || /\s/.test(text[index - 1]!)) {
		while (cursor < text.length && text[cursor]! >= "0" && text[cursor]! <= "9") cursor++;
	}
	for (const operator of ["&>>", "&>"]) {
		if (cursor === index && text.startsWith(operator, cursor)) return operator.length;
	}
	for (const operator of REDIRECTION_OPERATORS) {
		if (text.startsWith(operator, cursor)) return cursor - index + operator.length;
	}
	return undefined;
}

// End of the single word that follows a redirection operator (quote- and escape-aware).
function redirectionTargetEnd(text: string, from: number): number {
	let index = from;
	let quote: "'" | "\"" | undefined;
	while (index < text.length) {
		const character = text[index]!;
		if (quote) {
			if (character === quote) quote = undefined;
			index++;
			continue;
		}
		if (character === "\\") { index += 2; continue; }
		if (character === "'" || character === "\"") { quote = character; index++; continue; }
		if (/\s/.test(character) || ";|&()<>".includes(character)) break;
		index++;
	}
	return Math.min(index, text.length);
}

// A redirection is not a pathspec or an argument: drop each `[N]>`, `>>`, `>&`, `&>`, `<`, `<<`, `<&` operator and
// its one target word before words are decoded. Quoted text is untouched. `<(`/`>(` process substitutions are left
// for substitutionBodies().
export function stripRedirections(segment: string): string {
	let out = "";
	let quote: "'" | "\"" | undefined;
	let index = 0;
	while (index < segment.length) {
		const character = segment[index]!;
		if (quote) {
			out += character;
			if (character === quote) quote = undefined;
			index++;
			continue;
		}
		if (character === "\\") { out += segment.slice(index, index + 2); index += 2; continue; }
		if (character === "'" || character === "\"") { quote = character; out += character; index++; continue; }
		const length = redirectionOperatorLength(segment, index);
		if (length === undefined) { out += character; index++; continue; }
		let target = index + length;
		while (target < segment.length && /\s/.test(segment[target]!)) target++;
		if (segment[target] === "(") { out += segment.slice(index, index + length); index += length; continue; }
		out += " ";
		index = redirectionTargetEnd(segment, target);
	}
	return out;
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

export function stripEnvWrappers(words: readonly string[]): readonly string[] | undefined {
	let index = 0;
	if (words[index] === "env") {
		index++;
		while (index < words.length) {
			const word = words[index]!;
			if (word === "-i" || word === "--ignore-environment") { index++; continue; }
			if (word === "-u" || word === "--unset") { index += 2; continue; }
			if (ENV_ASSIGNMENT.test(word)) { index++; continue; }
			break;
		}
	} else {
		while (index < words.length && ENV_ASSIGNMENT.test(words[index]!)) index++;
	}
	if (index >= words.length) return undefined;
	return words.slice(index);
}

const SUBSTITUTION_BUDGET = 32;

function substitutionAt(text: string, index: number): { inner: string; next: number } | null {
	const character = text[index]!;
	if (character === "`") {
		let end = index + 1;
		while (end < text.length && !(text[end] === "`" && text[end - 1] !== "\\")) end++;
		const close = end < text.length ? end : text.length;
		return { inner: text.slice(index + 1, close), next: close + 1 };
	}
	if (character === "$" && text[index + 1] === "(") {
		let depth = 0;
		let end = index + 1;
		let quote: "'" | "\"" | undefined;
		while (end < text.length) {
			const current = text[end]!;
			if (quote) {
				if (current === "\\" && quote === "\"") { end += 2; continue; }
				if (current === quote) quote = undefined;
				end++;
				continue;
			}
			if (current === "'" || current === "\"") { quote = current; end++; continue; }
			if (current === "(") depth++;
			else if (current === ")") {
				depth--;
				if (depth === 0) break;
			}
			end++;
		}
		const close = end < text.length ? end : text.length;
		return { inner: text.slice(index + 2, close), next: close + 1 };
	}
	return null;
}

function substitutionBodies(text: string): string[] {
	const bodies: string[] = [];
	const emit = (inner: string): void => {
		bodies.push(inner);
		for (const nested of substitutionBodies(inner)) bodies.push(nested);
	};
	let index = 0;
	let quote: "'" | "\"" | undefined;
	while (index < text.length) {
		const character = text[index]!;
		if (quote === "'") {
			if (character === "'") quote = undefined;
			index++;
			continue;
		}
		if (quote === "\"") {
			if (character === "\"") { quote = undefined; index++; continue; }
			if (character === "\\") { index += 2; continue; }
			const found = substitutionAt(text, index);
			if (found) { emit(found.inner); index = found.next; continue; }
			index++;
			continue;
		}
		if (character === "'" || character === "\"") { quote = character; index++; continue; }
		const found = substitutionAt(text, index);
		if (found) { emit(found.inner); index = found.next; continue; }
		index++;
	}
	return bodies;
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

function branchesOptedOut(root: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, BRANCH_OPT_OUT), "utf8"));
		return Boolean(parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).branches === true);
	} catch {
		return false;
	}
}

const SUBSTITUTION_REASON =
	"fleet-guard refusal: nested shell substitution exceeds the bounded inspection budget; no files were changed.";

function heredocStart(line: string): { dash: boolean; delimiter: string; at: number } | { herestring: true; at: number } | null {
	let quote: "'" | "\"" | undefined;
	for (let i = 0; i < line.length; i++) {
		const c = line[i]!;
		if (quote) {
			if (c === "\\" && quote === "\"") { i++; continue; }
			if (c === quote) quote = undefined;
			continue;
		}
		if (c === "'" || c === "\"") { quote = c; continue; }
		if (c !== "<" || line[i + 1] !== "<") continue;
		if (line[i + 2] === "<") return { herestring: true, at: i };
		let j = i + 2;
		let dash = false;
		if (line[j] === "-") { dash = true; j++; }
		while (line[j] === " " || line[j] === "\t") j++;
		let delimiter: string;
		if (line[j] === "'" || line[j] === "\"") {
			const q = line[j]!;
			const end = line.indexOf(q, j + 1);
			if (end < 0) return null;
			delimiter = line.slice(j + 1, end);
		} else {
			let end = j;
			while (end < line.length && line[end] !== " " && line[end] !== "\t") end++;
			delimiter = line.slice(j, end);
		}
		if (!delimiter) return null;
		return { dash, delimiter, at: i };
	}
	return null;
}

function shellNestedTexts(words: readonly string[], segment: string): string[] {
	const first = words[0] ?? "";
	const base = first.slice(first.lastIndexOf("/") + 1);
	if (base !== "sh" && base !== "bash" && base !== "zsh" && base !== "dash" && base !== "ksh") return [];
	const texts: string[] = [];
	for (let index = 1; index < words.length; index++) {
		if (words[index] === "-c" && index + 1 < words.length) texts.push(words[index + 1]!);
	}
	const lines = segment.split("\n");
	for (let n = 0; n < lines.length; n++) {
		const found = heredocStart(lines[n]!);
		if (!found) continue;
		if ("herestring" in found) {
			const rest = lines[n]!.slice(found.at + 3).trim();
			const first = rest[0];
			if ((first === "\"" || first === "'") && rest.length > 1 && rest.endsWith(first)) texts.push(rest.slice(1, -1));
			else texts.push(rest);
			continue;
		}
		const body: string[] = [];
		n++;
		while (n < lines.length) {
			let line = lines[n]!;
			if (found.dash) {
				let k = 0;
				while (line[k] === "\t") k++;
				line = line.slice(k);
			}
			if (line === found.delimiter) break;
			body.push(lines[n]!);
			n++;
		}
		if (body.length) texts.push(body.join("\n"));
	}
	return texts;
}

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	const pending: string[] = [command];
	let units = 0;
	while (pending.length) {
		if (++units > SUBSTITUTION_BUDGET) return { block: true, reason: SUBSTITUTION_REASON };
		const text = pending.pop()!;
		for (const segment of commandSegments(text)) {
			const words = shellWords(stripRedirections(segment));
			for (const body of substitutionBodies(segment)) pending.push(body);
			const effective = stripEnvWrappers(words);
			if (!effective) continue;
			const executable = effective[0]!;
			const base = executable.slice(executable.lastIndexOf("/") + 1);
			if (base !== "git") {
				if (base === "sh" || base === "bash" || base === "zsh" || base === "dash" || base === "ksh") {
					for (const nested of shellNestedTexts(effective, segment)) pending.push(nested);
				}
				continue;
			}
			const commandCwd = optionValue(effective, "-C");
			const pathBase = commandCwd ? resolve(context.cwd ?? process.cwd(), commandCwd) : context.repoRoot ?? context.projectRoot ?? context.cwd ?? process.cwd();
			const root = repositoryRoot(pathBase);
			if (!root) continue;
			if (branchCreation(effective) && !branchesOptedOut(root)) return { block: true, reason: MAIN_ONLY_REASON };
			const scope = analyzeCommit(effective);
			if (scope && scope.amend) return { block: true, reason: AMEND_REASON };
			if (scope && scope.only) {
				const verdict = checkOnlyCoverage(scope.paths, root, pathBase);
				if (verdict) return verdict;
			}
		}
	}
	return undefined;
}

export default check;
