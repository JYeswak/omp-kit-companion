import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

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

function commandFromEvent(event: FleetGuardEvent): string | undefined {
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

function shellWords(segment: string): string[] {
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
		if (/\s/.test(character)) {
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

function commandSegments(command: string): string[] {
	const segments: string[] = [];
	let segment = "";
	let quote: "'" | "\"" | undefined;
	for (const character of command) {
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

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const command = commandFromEvent(event);
	if (!command) return undefined;
	for (const segment of commandSegments(command)) {
		const words = shellWords(segment);
		if (words[0] !== "git") continue;
		const commandCwd = optionValue(words, "-C");
		const root = repositoryRoot(commandCwd ? resolve(context.cwd ?? process.cwd(), commandCwd) : context.repoRoot ?? context.projectRoot ?? context.cwd ?? process.cwd());
		if (!root || !branchCreation(words) || branchesOptedOut(root)) continue;
		return { block: true, reason: MAIN_ONLY_REASON };
	}
	return undefined;
}

export default check;
