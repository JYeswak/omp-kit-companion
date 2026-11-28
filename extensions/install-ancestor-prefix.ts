import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { commandFromEvent, commandName, eventWorkingDirectory, executedShellCommands, type FleetGuardBlock, type FleetGuardEvent, type ShellInspection, type ShellWord } from "../src/fleet-guard/git.ts";
import { hostAgentName } from "../src/fleet-guard/scratch.ts";
import { parseOwnerFile } from "../src/scratch.ts";

const RULE = "install-ancestor-prefix";
const PKG_COMMAND = /\b(?:npm|pnpm|pn|yarn|bun)\b/;
const INSTALLS: Readonly<Record<string, readonly string[]>> = {
	npm: ["install", "i", "in", "ins", "inst", "insta", "instal", "add", "ci", "clean-install"],
	pnpm: ["install", "i", "add"],
	yarn: ["install", "add"],
	bun: ["install", "i", "add", "ci"],
};
const DIRECTORY_FLAGS: Readonly<Record<string, readonly string[]>> = {
	npm: ["--prefix"], pnpm: ["--dir", "-C"], yarn: ["--cwd"], bun: ["--cwd"],
};
const NON_DIRECTORY_VALUES = ["--cache", "--config", "--env-file", "--global-folder", "--registry", "--userconfig"];
const CHDIR = ["cd", "pushd", "popd"];

interface Install { manager: string; prefix: ShellWord | null; invalidPrefix: boolean }

function installOf(argv: readonly ShellWord[]): Install | null {
	const name = commandName(argv[0]!.text);
	const manager = name === "pn" ? "pnpm" : name;
	if (!Object.hasOwn(INSTALLS, manager)) return null;
	const aliases = INSTALLS[manager]!;
	const directoryFlags = DIRECTORY_FLAGS[manager]!;
	let action: string | undefined;
	let prefix: ShellWord | null = null;
	let invalidPrefix = false;
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg.text === "--") break;
		if (["-g", "--global", "--global=true", "--location=global", "-h", "--help", "-v", "--version"].includes(arg.text)) return null;
		if (!arg.text.startsWith("-")) {
			if (action === undefined) {
				action = arg.text;
				if (!aliases.includes(action)) return null;
			}
			continue;
		}
		const equal = arg.text.indexOf("=");
		const flag = equal < 0 ? arg.text : arg.text.slice(0, equal);
		if (directoryFlags.includes(flag)) {
			const value = equal < 0 ? argv[++i] : { text: arg.text.slice(equal + 1), expanded: arg.expanded };
			invalidPrefix ||= prefix !== null || !value?.text || value.expanded || value.text.startsWith("-");
			prefix = value ?? null;
		} else if (equal < 0 && NON_DIRECTORY_VALUES.includes(flag)) i++;
	}
	return action !== undefined || manager === "yarn" ? { manager, prefix, invalidPrefix } : null;
}

function present(path: string, kind: "file" | "directory"): boolean {
	try {
		const st = statSync(path);
		return kind === "file" ? st.isFile() : st.isDirectory();
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

function projectBase(dir: string, npm: boolean): string | null {
	for (let current = dir; ; current = dirname(current)) {
		if (present(join(current, "package.json"), "file") || (npm && present(join(current, "node_modules"), "directory"))) return current;
		if (current === dirname(current)) return null;
	}
}

/** Trust a scratch owner only at the real repo-local scratch top, in this live seat/session. */
function ownsScratch(path: string, agent: string | undefined, session: string | undefined): boolean {
	if (!agent || !session) return false;
	for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) {
		const scratchRoot = dirname(dir);
		if (basename(scratchRoot) !== "agent-tmp" || basename(dirname(scratchRoot)) !== "var") continue;
		const ownerPath = join(dir, ".owner");
		try {
			const st = lstatSync(ownerPath);
			if (!st.isFile() || st.size > 4096) return false;
			const owner = parseOwnerFile(readFileSync(ownerPath, "utf8"));
			return owner?.agent === agent && owner.session === session && realpathSync(owner.repo) === dirname(dirname(scratchRoot));
		} catch { return false; }
	}
	return false;
}

/** Carry a single literal `cd PATH && install`, never assume cwd across branching or nested shells. */
function commandBase(command: string, base: string, inspected: ShellInspection): string | undefined {
	if (!inspected.commands.some(({ words }) => CHDIR.includes(commandName(words[0]!)))) return base;
	const separator = command.indexOf("&&");
	if (separator < 0 || inspected.commands.length !== 2) return undefined;
	const cd = executedShellCommands(command.slice(0, separator));
	const next = executedShellCommands(command.slice(separator + 2));
	if ("refusal" in cd || "refusal" in next || cd.commands.length !== 1 || next.commands.length !== 1) return undefined;
	const args = cd.commands[0]!.argv;
	const target = args[1]?.text === "--" ? args[2] : args[1];
	if (args[0]?.text !== "cd" || args.length !== (args[1]?.text === "--" ? 3 : 2) || !target || target.expanded || target.text.startsWith("-")) return undefined;
	return resolve(base, target.text);
}

function refusal(why: string, manager: string): FleetGuardBlock {
	const remedy = manager === "npm" ? "npm install --prefix <owned-scratch> <package>" : `${manager} install from an owned directory containing package.json`;
	return { block: true, reason: `${RULE}: ${why}. Use ${remedy}, or set the bash call's cwd to the intended project root; no files were changed.` };
}

interface ToolContext { cwd?: string; sessionManager?: { getSessionId?(): string } }
interface ExtensionApi {
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: FleetGuardEvent, context?: ToolContext) => FleetGuardBlock | undefined): void;
}

export default function installAncestorPrefix(api: ExtensionApi): void {
	api.setLabel(RULE);
	api.on("tool_call", (event, context) => {
		if (event.toolName !== "bash") return undefined;
		const command = commandFromEvent(event);
		if (!command || !PKG_COMMAND.test(command)) return undefined;
		const inspected = executedShellCommands(command);
		if ("refusal" in inspected) return { block: true, reason: `${RULE}: ${inspected.refusal}` };
		const cwd = resolve(context?.cwd ?? process.cwd(), eventWorkingDirectory(event) ?? ".");
		const base = commandBase(command, cwd, inspected);
		for (const { argv } of inspected.commands) {
			const install = installOf(argv);
			if (!install) continue;
			const { manager, prefix } = install;
			if (install.invalidPrefix || (!base && !(prefix && isAbsolute(prefix.text)))) {
				return refusal("the install directory could not be resolved", manager);
			}
			try {
				const physicalBase = base ? realpathSync(base) : undefined;
				const target = prefix ? realpathSync(resolve(physicalBase ?? "/", prefix.text)) : physicalBase!;
				if (!present(target, "directory")) return refusal(`the install target ${target} is not a directory`, manager);
				if (prefix && !ownsScratch(target, hostAgentName(), context?.sessionManager?.getSessionId?.())) {
					if (physicalBase !== target || !present(join(target, "package.json"), "file")) {
						return refusal(`the explicit install target ${target} is not scratch owned by this session or its current project`, manager);
					}
				}
				if (prefix && manager === "npm") continue;
				const ancestor = projectBase(target, manager === "npm");
				if (ancestor && ancestor !== target) return refusal(`install from ${target} would write in the ancestor ${ancestor}`, manager);
			} catch { return refusal("the install directory could not be verified", manager); }
		}
		return undefined;
	});
}
