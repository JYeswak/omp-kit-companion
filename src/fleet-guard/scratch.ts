import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandFromEvent, commandName, executedShellCommands, type ShellWord } from "./git";

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
	/** Actual calling session's local:// backing root; never inferred from cwd. */
	localRoot?: string;
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

const AGENTS_STORING = "This repository's enabled .omp/fleet.json policy keeps scratch in repo-local var/agent-tmp; system temp and home-root writes are refused.";
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

/** `agent` and `session` come together or not at all: the durable owner of the seat dir, so a respawn (new pid) keeps it. */
export interface ScratchOwner { pid: number; label: string; repo: string; created: string; agent?: string; session?: string;
	/** Where this dir goes when its work ends (ompkit-774u.15). A session's own dir is throwaway by definition; absent means unbinned. */
	bin?: "throwaway" }

// Same shape src/scratch.ts accepts for the owner's agent and session fields.
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

/** The host agent name (AGENT_NAME, else BR_ACTOR, else BR_AGENT_NAME), or undefined when none is set. */
export function hostAgentName(env: Record<string, string | undefined> = process.env): string | undefined {
	return [env.AGENT_NAME, env.BR_ACTOR, env.BR_AGENT_NAME].map((value) => value?.trim()).find((value) => value !== undefined && AGENT_NAME.test(value));
}

export function writeScratchOwner(dir: string, owner: ScratchOwner): void {
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const temp = join(dir, `.owner.${process.pid}.tmp`);
	const durable = owner.agent !== undefined && owner.session !== undefined && AGENT_NAME.test(owner.agent) && SESSION_ID.test(owner.session)
		? `agent=${owner.agent}\nsession=${owner.session}\n` : "";
	const binned = owner.bin === "throwaway" ? "bin=throwaway\n" : "";
	writeFileSync(temp, `pid=${owner.pid}\nlabel=${owner.label}\nrepo=${owner.repo}\ncreated=${owner.created}\n${durable}${binned}`, { mode: 0o644 });
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

/** Only handler-owned routes bypass filesystem classification, not the later guards. */
const LOGICAL_WRITE_ROUTE = /^(?:proc|agent|xd):\/\//i;

// Packaged guards have no resolvable SDK runtime dependency. This lexical projection
// follows OMP's raw-path decoding/containment; native handlers still own authority
// and symlink validation. localRoot comes only from the calling extension context.
function resolveWriteCandidate(cwd: string, candidate: string, context: FleetGuardContext): string {
	if (candidate.length > 65_536) throw new Error("filesystem write path exceeds guard limit");
	// local:// alone has native single-slash and path-prefixed aliases.
	let target = candidate.replace(/^local:\/(?!\/)/i, "local://");
	if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
		const alias = /[\\/]local:\/\/(?=[^/]|$)/i.exec(target);
		if (alias) target = target.slice(alias.index + 1);
	}
	const uri = /^(file|local|ssh):\/\/([^/?#]*)(\/[^?#]*)?([?#].*)?$/i.exec(target);
	if (uri) {
		const scheme = uri[1]!.toLowerCase();
		if (uri[4]) throw new Error("filesystem URI queries/fragments are not write paths");
		if (scheme === "file") target = fileURLToPath(target);
		else if (scheme === "ssh") {
			const url = new URL(target);
			decodeURIComponent(uri[2]!); // Reject malformed authority escapes too.
			if (!url.hostname || url.password || url.port === "0") throw new Error("invalid SSH authority");
			target = decodeURIComponent(uri[3] ?? "");
			if (!isAbsolute(target)) throw new Error("SSH path must be absolute");
		} else {
			// Native local:// uses the raw authority as the first relative segment,
			// decodes once, and forbids traversal before resolving under its root.
			const path = uri[3] ?? "";
			const rawRelative = uri[2] ? `${uri[2]}${path === "/" ? "" : path}` : path.slice(1);
			const relative = decodeURIComponent(rawRelative.replaceAll("\\", "/"));
			const normalized = normalize(relative);
			if (isAbsolute(relative) || relative.split(/[\\/]/).includes("..") || normalized.startsWith("..") || normalized.includes("/.."))
				throw new Error("local URI path escapes its root");
			if (!context.localRoot || !isAbsolute(context.localRoot)) throw new Error("local URI backing root is unavailable");
			target = resolve(context.localRoot, relative);
		}
	}
	const absolute = resolveCandidate(cwd, expandToolHome(target));
	if (absolute === null) throw new Error("invalid filesystem path");
	return absolute;
}

/** omp's file tools expand a leading `~` or `~/` to $HOME (they display paths that way), so the guard judges the
 * same file: without this, `~/Developer/omp-kit-companion/x.ts` from a seat in omp-kit resolved to
 * `omp-kit/~/Developer/...` and was refused against the wrong repo, and from a seat outside any repo it found no Git
 * root and skipped the ownership check (TILDEPATH1, 2026-10-22). `~user` forms are not tool syntax and stay literal. */
function expandToolHome(target: string): string {
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) return target;
	return target === "~" ? home : target.startsWith("~/") ? home + target.slice(1) : target;
}

/** Shared URI projection for lexical checks and local repository-fact admission. */
export function resolveFilesystemWriteTarget(cwd: string, candidate: string, context: FleetGuardContext): string | undefined {
	return LOGICAL_WRITE_ROUTE.test(candidate) ? undefined : resolveWriteCandidate(cwd, candidate, context);
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
		let abs: string;
		try {
			const resolved = resolveFilesystemWriteTarget(cwd, candidate, context);
			if (resolved === undefined) continue;
			abs = resolved;
		} catch (error) {
			return { block: true, reason: `fleet-guard scratch-write: cannot resolve ${candidate}: ${String(error)}. ${AGENTS_STORING}` };
		}
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
export function gitBlanketArgs(argv: readonly string[]): boolean {
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
	const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
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

// TMPALLOC1: mktemp option grammar is pinned per dialect, never inferred from argument shape. Darwin's BSD mktemp
// (mktemp(1), macOS 26) takes -d -q -u -p DIR -t PREFIX and their long forms; anywhere else, and for GNU gmktemp,
// only the options both share (-d -q -u) are admitted, so a dialect-specific destination option is refused.
const HOST_MKTEMP: "darwin" | "portable" = process.platform === "darwin" ? "darwin" : "portable";

/** Under the var/agent-tmp of cwd or one of its ancestors (never the filesystem root's), and not a forbidden root. */
function repoLocalScratch(target: string, cwd: string, home: string): boolean {
	if (forbiddenTarget(target, home) !== null) return false;
	for (let dir = cwd; dirname(dir) !== dir; dir = dirname(dir)) {
		if (target.startsWith(`${join(dir, "var", "agent-tmp")}/`)) return true;
	}
	return false;
}

// Every path an executed mktemp creates (or, with -u, names) must be proven repo-local from literal operands:
// the default and -t destinations, TMPDIR, computed operands and unknown options are refusals, not guesses.
function checkTempAllocation(argv: readonly ShellWord[], cwd: string, home: string): FleetGuardBlock | undefined {
	const name = commandName(argv[0]!.text);
	if (name !== "mktemp" && name !== "gmktemp") return undefined;
	const dialect = name === "mktemp" ? HOST_MKTEMP : "portable";
	const refuse = (detail: string): FleetGuardBlock => ({ block: true,
		reason: `fleet-guard scratch-alloc: '${argv.map((word) => word.text).join(" ").slice(0, 240)}' ${detail}. Pass a literal template under repo-local var/agent-tmp, e.g. mktemp -d var/agent-tmp/<label>.XXXXXX. ${AGENTS_STORING}` });
	// undefined: no -p/--tmpdir; null: --tmpdir without a directory (TMPDIR decides).
	let tmpdir: ShellWord | null | undefined;
	let prefix = false;
	let options = true;
	const templates: ShellWord[] = [];
	for (let index = 1; index < argv.length; index++) {
		const word = argv[index]!;
		if (!options || word.text === "-" || !word.text.startsWith("-")) { templates.push(word); continue; }
		if (word.expanded) return refuse(`passes the computed option ${word.text}`);
		if (word.text === "--") { options = false; continue; }
		if (word.text.startsWith("--")) {
			const equals = word.text.indexOf("=");
			const option = equals < 0 ? word.text : word.text.slice(0, equals);
			if (equals < 0 && (option === "--directory" || option === "--quiet" || option === "--dry-run")) continue;
			if (dialect === "darwin" && option === "--tmpdir") {
				tmpdir = equals < 0 ? null : { text: word.text.slice(equals + 1), expanded: false };
				continue;
			}
			return refuse(`uses ${option}, which the guard does not admit for the pinned ${dialect} mktemp dialect`);
		}
		for (let at = 1; at < word.text.length; at++) {
			const flag = word.text[at]!;
			if (flag === "d" || flag === "q" || flag === "u") continue;
			if (dialect !== "darwin" || (flag !== "p" && flag !== "t")) return refuse(`uses -${flag}, which the guard does not admit for the pinned ${dialect} mktemp dialect`);
			const attached = word.text.slice(at + 1);
			const value = attached !== "" ? { text: attached, expanded: false } : argv[++index];
			if (value === undefined) return refuse(`gives -${flag} no operand`);
			if (flag === "p") tmpdir = value;
			else prefix = true;
			break;
		}
	}
	if (prefix) return refuse("uses -t, which allocates under the per-user system temp directory");
	if (templates.length === 0) return refuse("names no template, so it allocates under the system temp directory");
	if (tmpdir === null || tmpdir?.text === "") return refuse("takes its directory from TMPDIR, which the guard does not resolve");
	if (tmpdir?.expanded) return refuse(`takes its directory from the computed value ${tmpdir.text}`);
	const base = tmpdir ? resolve(cwd, tmpdir.text) : cwd;
	for (const template of templates) {
		if (template.expanded) return refuse(`allocates from the computed template ${template.text}`);
		if (tmpdir && isAbsolute(template.text)) return refuse(`combines -p with the absolute template ${template.text}`);
		if (!repoLocalScratch(resolve(base, template.text), cwd, home)) return refuse(`targets ${template.text} outside repo-local var/agent-tmp`);
	}
	return undefined;
}

// Every simple command the call would run (substitutions, eval and nested shells included), through the lexical
// traversal git.ts shares: temp allocations and blanket staging. Uninspectable text is refused, never allowed.
function checkShellCommands(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
	if (tool !== "bash" || !command) return undefined;
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return { block: true, reason: inspection.refusal };
	const cwd = resolve(eventCwd(event, context));
	const home = homeDir();
	for (const { argv, words } of inspection.commands) {
		const allocation = checkTempAllocation(argv, cwd, home);
		if (allocation) return allocation;
		if (gitBlanketArgs(words)) return { block: true,
			reason: `fleet-guard blanket-git: '${words.slice(0, 4).join(" ")}' stages the shared tree. ${AGENTS_SHARED_TREE}` };
	}
	return undefined;
}

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	return checkWritePaths(event, context) ?? checkBashTargets(event, context) ?? checkShellCommands(event, context);
}

export default check;
