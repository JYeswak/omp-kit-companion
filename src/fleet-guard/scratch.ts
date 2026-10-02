import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Fleet guard behaviours 1 (session scratch), 2 (block writes outside scratch)
 * and 5 (no blanket git staging). LspLuna owns git.ts (3) and reservations.ts (4);
 * extensions/fleet-guard.ts calls the three check()s in order.
 *
 * Budget: check() is pure CPU (no I/O, no spawns). Forbidden roots are module
 * constants; candidate paths resolve lexically against the call cwd. A symlinked
 * candidate that lexically evades the roots is a documented non-goal: creating it
 * is already outside every stated procedure.
 */
export interface FleetGuardEvent {
	toolName?: unknown;
	input?: unknown;
	command?: unknown;
	cwd?: unknown;
}

export interface FleetGuardContext {
	cwd?: string;
	agentName?: string;
	isTrackedPath?: (absolutePath: string, repoRoot: string) => Promise<boolean> | boolean;
	lookupReservations?: (input: { projectKey: string; agentName: string; path: string }) => Promise<{ covered: boolean; conflicts: readonly unknown[] }>;
	warn?: (message: string) => void;
}

export interface FleetGuardBlock {
	block: true;
	reason: string;
}

export type ScratchCheck = (event: FleetGuardEvent, context: FleetGuardContext) => FleetGuardBlock | undefined;

const AGENTS_STORING = "See ~/.agents/AGENTS.md Storing (scratch goes in the repo's var/agent-tmp, never /tmp or ~).";
const AGENTS_SHARED_TREE = "See AGENTS.md (shared tree: stage explicit paths, never git add -A / commit -a / add .).";

/** Lexical roots no write may land under. Pre-resolved literals; no per-call I/O. */
const FORBIDDEN_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/folders"] as const;

function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Session scratch dir for a cwd: <git root of cwd, else cwd>/var/agent-tmp/omp.<pid>/ */
export function scratchDirFor(cwd: string, pid: number = process.pid): string {
	let base = cwd;
	for (let dir = cwd; ; dir = dirname(dir)) {
		try {
			if (existsSync(join(dir, ".git"))) { base = dir; break; }
		} catch {
			break;
		}
		if (dirname(dir) === dir) break;
	}
	return join(base, "var", "agent-tmp", `omp.${pid}`);
}

export interface ScratchOwner { pid: number; label: string; repo: string; created: string }

export function writeScratchOwner(dir: string, owner: ScratchOwner): void {
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const temp = join(dir, `.owner.${process.pid}.tmp`);
	writeFileSync(temp, `pid=${owner.pid}\nlabel=${owner.label}\nrepo=${owner.repo}\ncreated=${owner.created}\n`, { mode: 0o644 });
	renameSync(temp, join(dir, ".owner"));
}

/** Point this process (and every child tool) at the session scratch dir. */
export function applyScratchEnv(dir: string): void {
	process.env.TMPDIR = dir;
	process.env.TMP = dir;
	process.env.TEMP = dir;
}

function eventCwd(event: FleetGuardEvent, context: FleetGuardContext): string {
	const raw = typeof event.cwd === "string" && event.cwd ? event.cwd : context.cwd;
	if (typeof raw === "string" && raw) return raw;
	return process.cwd();
}

function homeDir(): string {
	return process.env.HOME ?? "";
}

function resolveCandidate(cwd: string, candidate: string): string | null {
	try {
		const abs = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate);
		if (!isAbsolute(abs) || abs.includes("\0")) return null;
		return abs;
	} catch {
		return null;
	}
}

/** Direct child of $HOME (writing to the HOME root itself is the $HOME-root case). */
function isHomeDirectChild(absPath: string, home: string): boolean {
	return home !== "" && dirname(absPath) === home;
}

function forbiddenTarget(absPath: string, home: string): string | null {
	for (const root of FORBIDDEN_ROOTS) {
		if (isUnder(absPath, root)) return root;
	}
	if (isHomeDirectChild(absPath, home)) return "$HOME";
	return null;
}

function blockScratch(rule: string, path: string, root: string): FleetGuardBlock {
	return { block: true,
		reason: `fleet-guard ${rule}: writes to ${path} are blocked (under ${root}). ${AGENTS_STORING}` };
}

function candidatePaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.trim() !== "") out.push(value);
	};
	push(record.path);
	push(record.file);
	const paths = record.paths;
	if (Array.isArray(paths)) for (const entry of paths) push(entry);
	return out;
}

function checkWritePaths(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	if (tool !== "write" && tool !== "edit") return undefined;
	const cwd = eventCwd(event, context);
	const home = homeDir();
	for (const candidate of candidatePaths(event.input)) {
		const abs = resolveCandidate(cwd, candidate);
		if (abs === null) continue;
		const root = forbiddenTarget(abs, home);
		if (root !== null) return blockScratch("scratch-write", candidate, root);
	}
	return undefined;
}

interface ShellToken { text: string; quoted: boolean }

/** Quote-aware split; a token is quoted if any part of it was quoted. */
export function shellTokens(command: string): ShellToken[] {
	const tokens: ShellToken[] = [];
	let text = "", quoted = false, partQuoted = false;
	let single = false, double = false, escaped = false;
	const flush = (): void => {
		if (text !== "" || quoted) tokens.push({ text, quoted });
		text = "";
		quoted = false;
		partQuoted = false;
	};
	for (const char of command) {
		if (escaped) { text += char; escaped = false; continue; }
		if (single) {
			if (char === "'") single = false;
			else text += char;
			continue;
		}
		if (double) {
			if (char === '"') double = false;
			else if (char === "\\") escaped = true;
			else text += char;
			continue;
		}
		if (char === "\\") { escaped = true; continue; }
		if (char === "'") { single = true; partQuoted = true; continue; }
		if (char === '"') { double = true; partQuoted = true; continue; }
		if (char === " " || char === "\t" || char === "\n") {
			quoted = quoted || partQuoted;
			flush();
			continue;
		}
		if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
			quoted = quoted || partQuoted;
			flush();
			tokens.push({ text: char, quoted: false });
			continue;
		}
		if (char === ">" || char === "<") {
			quoted = quoted || partQuoted;
			flush();
			tokens.push({ text: char, quoted: false });
			continue;
		}
		text += char;
	}
	quoted = quoted || partQuoted;
	flush();
	return tokens.filter(token => token.text !== "" || token.quoted);
}

const REDIRECT = /^(?:\d*)>{1,2}\|?$/;
const FD_REDIRECT = /^(?:\d*)&>{1,2}$/;

/** Write-target operands of one shell command: redirect targets, tee/cp/mv/mkdir destinations. */
export function shellWriteTargets(command: string): string[] {
	const tokens = shellTokens(command);
	const targets: string[] = [];
 const isSep = (token: ShellToken): boolean => !token.quoted && /^[;&|()]$/.test(token.text);
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (!token.quoted && (REDIRECT.test(token.text) || FD_REDIRECT.test(token.text))) {
			const next = tokens[i + 1];
			if (next && next.text !== "" && !isSep(next)) targets.push(next.text);
			i += 2;
			continue;
		}
		if (!token.quoted && (token.text === "tee" || token.text === "mkdir")) {
			i++;
			while (i < tokens.length && !isSep(tokens[i]!)) {
				const arg = tokens[i]!;
				if (arg.text === "-") { i++; continue; }
				if (!arg.quoted && arg.text.startsWith("-")) { i++; continue; }
				targets.push(arg.text);
				i++;
			}
			continue;
		}
		if (!token.quoted && (token.text === "cp" || token.text === "mv")) {
			i++;
			const operands: string[] = [];
			let dashT: string | null = null;
			let skip = false;
			while (i < tokens.length && !isSep(tokens[i]!)) {
				const arg = tokens[i]!;
				if (skip) { dashT = arg.text; skip = false; i++; continue; }
				if (!arg.quoted && arg.text.startsWith("-") && arg.text !== "-") {
					if (arg.text === "-t") skip = true;
					i++;
					continue;
				}
				operands.push(arg.text);
				i++;
			}
			const dest = dashT ?? operands.at(-1);
			if (dest !== undefined) targets.push(dest);
			continue;
		}
		i++;
	}
	return targets.filter(target => target !== "");
}

/** git add -A/--all/./. and git commit -a/--all (blanket staging), argv machine. */
export function gitBlanketArgs(argv: string[]): boolean {
	let i = 0;
	if (argv[i] !== "git") return false;
	i++;
	while (i < argv.length && /^(-C|--git-dir|--work-tree|-c)$/.test(argv[i]!)) i += 2;
	if (argv[i] === "-c") i += 1;
	const sub = argv[i++];
	if (sub !== "add" && sub !== "commit") return false;
	for (; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--") return sub === "add" && argv.slice(i + 1).some(a => a === "." || a === "-A" || a === "--all");
		if (sub === "add" && (arg === "-A" || arg === "--all" || arg === ".")) return true;
		if (sub === "commit" && (arg === "-a" || arg === "--all")) return true;
	}
	return false;
}

function checkBashTargets(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const command = typeof event.command === "string" ? event.command
		: typeof event.input === "string" ? event.input : undefined;
	if (tool !== "bash" || !command) return undefined;
	const cwd = eventCwd(event, context);
	const home = homeDir();
	for (const target of shellWriteTargets(command)) {
		const abs = resolveCandidate(cwd, target);
		if (abs === null) continue;
		const root = forbiddenTarget(abs, home);
		if (root !== null) return blockScratch("scratch-write", target, root);
	}
	return undefined;
}

function checkBlanketGit(event: FleetGuardEvent): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const command = typeof event.command === "string" ? event.command
		: typeof event.input === "string" ? event.input : undefined;
	if (tool !== "bash" || !command) return undefined;
	const argv = shellTokens(command).filter(token => !/^[;&|()]$/.test(token.text)).map(token => token.text);
	if (!gitBlanketArgs(argv)) return undefined;
	return { block: true,
		reason: `fleet-guard blanket-git: '${argv.slice(0, 4).join(" ")}' stages the shared tree. ${AGENTS_SHARED_TREE}` };
}

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	return checkWritePaths(event, context) ?? checkBashTargets(event, context) ?? checkBlanketGit(event);
}

export default check;
