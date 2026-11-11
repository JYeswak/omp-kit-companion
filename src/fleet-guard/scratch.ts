import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync, type Stats } from "node:fs";
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

const AGENTS_STORING = "This repository's enabled .omp/fleet.json policy keeps scratch in repo-local var/agent-tmp (allocate it with `omp-kit scratch new --label <x> --json`); system temp and home-root writes are refused.";
const AGENTS_SHARED_TREE = "See AGENTS.md (shared tree: stage explicit paths, never git add -A / commit -a / add .).";
const SYSTEM_TEMP_REMEDY = "Never write to system temp: allocate owned scratch with `omp-kit scratch new --label <x> --json` (run inside your repository) and write there.";

/** System temp roots (TMPWRITE1): refused in every session, whatever the calling cwd's fleet policy. */
const SYSTEM_TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"] as const;

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

/** The exact owner-file bytes the kit writes: the one record writer adoption must use, never a hand-built record. */
export function renderScratchOwner(owner: ScratchOwner): string {
	const durable = owner.agent !== undefined && owner.session !== undefined && AGENT_NAME.test(owner.agent) && SESSION_ID.test(owner.session)
		? `agent=${owner.agent}\nsession=${owner.session}\n` : "";
	const binned = owner.bin === "throwaway" ? "bin=throwaway\n" : "";
	return `pid=${owner.pid}\nlabel=${owner.label}\nrepo=${owner.repo}\ncreated=${owner.created}\n${durable}${binned}`;
}
export function writeScratchOwner(dir: string, owner: ScratchOwner): void {
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	const temp = join(dir, `.owner.${process.pid}.tmp`);
	writeFileSync(temp, renderScratchOwner(owner), { mode: 0o644 });
	renameSync(temp, join(dir, ".owner"));
}
/** The nearest directory at or above `start` holding a `.git` entry, or undefined. */
export function repositoryRootOf(start: string): string | undefined {
	try {
		let current = resolve(start);
		for (;;) {
			if (existsSync(join(current, ".git"))) return current;
			const parent = dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	} catch { return undefined; }
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

// A leading $TMPDIR/$TMP/$TEMP names the process temp dir (the seat scratch when the policy is on, system temp
// otherwise); an unset variable falls back to /tmp, as mktemp and most tools do.
const TEMP_VAR = /^\$(?:\{(TMPDIR|TMP|TEMP)\}|(TMPDIR|TMP|TEMP))(?=\/|$)/;
const ANSI_SINGLE: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?", " ": " " };
const ANSI_HEX = /^[0-9A-Fa-f]{2}$/;
const ANSI_HEX4 = /^[0-9A-Fa-f]{4}$/;
const ANSI_HEX8 = /^[0-9A-Fa-f]{8}$/;
/** Decode one `$'...'` ANSI-C quoted span to the bytes the shell passes on, or undefined when malformed. */
function decodeAnsiSpan(body: string): string | undefined {
	let out = "";
	for (let index = 0; index < body.length; index++) {
		const char = body[index]!;
		if (char !== "\\") { out += char; continue; }
		const next = body[++index];
		if (next === undefined) return undefined;
		if (next in ANSI_SINGLE) { out += ANSI_SINGLE[next]!; continue; }
		if (next === "x") {
			const hex = body.slice(index + 1, index + 3);
			if (!ANSI_HEX.test(hex)) return undefined;
			out += String.fromCharCode(parseInt(hex, 16));
			index += 2;
			continue;
		}
		if (next === "u") {
			const hex = body.slice(index + 1, index + 5);
			if (!ANSI_HEX4.test(hex)) return undefined;
			out += String.fromCharCode(parseInt(hex, 16));
			index += 4;
			continue;
		}
		if (next === "U") {
			const hex = body.slice(index + 1, index + 9);
			if (!ANSI_HEX8.test(hex)) return undefined;
			out += String.fromCodePoint(parseInt(hex, 16));
			index += 8;
			continue;
		}
		if (next === "c") {
			const control = body[++index];
			if (control === undefined) return undefined;
			out += String.fromCharCode(control.toUpperCase().charCodeAt(0) & 31);
			continue;
		}
		if (next >= "0" && next <= "7") {
			let octal = next;
			while (octal.length < 3 && body[index + 1] !== undefined && body[index + 1]! >= "0" && body[index + 1]! <= "7") octal += body[++index];
			out += String.fromCharCode(parseInt(octal, 8));
			continue;
		}
		return undefined;
	}
	return out;
}
/**
 * Replace every `$'...'` ANSI-C span with its decoded bytes (H3): the shell decodes before it
 * opens the file, so the guard judges the decoded path. An unterminated span fails closed.
 */
function decodeAnsiC(candidate: string): string | undefined {
	let out = "";
	let rest = candidate;
	for (;;) {
		const open = rest.indexOf("$'");
		if (open < 0) return out + rest;
		out += rest.slice(0, open);
		const body = rest.slice(open + 2);
		let close = -1;
		for (let index = 0; index < body.length; index++) {
			if (body[index] === "\\") { index++; continue; }
			if (body[index] === "'") { close = index; break; }
		}
		if (close < 0) return undefined;
		const decoded = decodeAnsiSpan(body.slice(0, close));
		if (decoded === undefined) return undefined;
		out += decoded;
		rest = body.slice(close + 1);
	}
}

function resolveCandidate(cwd: string, candidate: string): string | null {
	try {
		if (candidate.includes("$'")) {
			const decoded = decodeAnsiC(candidate);
			if (decoded === undefined) return null;
			candidate = decoded;
		}
		const temp = TEMP_VAR.exec(candidate);
		if (temp) candidate = (process.env[temp[1] ?? temp[2]!] || "/tmp") + candidate.slice(temp[0].length);
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

/**
 * The system temp root a write lands under, or undefined. A repository that itself lives in system temp (the commit
 * gate exports trees under $TMPDIR) keeps its own var/agent-tmp writable: the target's var/agent-tmp must belong to
 * the calling cwd or an ancestor strictly below the temp root, so /tmp/var/agent-tmp is never admitted.
 */
function systemTempRoot(absPath: string, cwd: string): string | undefined {
	const root = SYSTEM_TEMP_ROOTS.find(temp => isUnder(absPath, temp));
	if (root === undefined) return undefined;
	for (let dir = cwd; dir !== root && isUnder(dir, root); dir = dirname(dir))
		if (isUnder(absPath, join(dir, "var", "agent-tmp"))) return undefined;
	return root;
}

function forbiddenTarget(absPath: string, home: string, cwd: string): string | null {
	const root = systemTempRoot(absPath, cwd);
	if (root !== undefined) return root;
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
		const root = forbiddenTarget(abs, home, cwd);
		if (root !== null) return blockScratch("scratch-write", candidate, root);
	}
	return undefined;
}

interface ShellToken { text: string; quoted: boolean }

/** Longest-first redirect operators; `&`/`|` alone stay single separators. */
const COMBINED_REDIRECT = ["<<<", "<<-", "&>>|", "&>|", "&>>", "&>", ">>|", ">|", ">>", ">&", "<<", "<>", "<&", ">", "<"] as const;
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
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) { text += char; escaped = false; continue; }
		// ANSI-C quoting (H3): keep the raw `$'...'` spelling in the word so resolution decodes
		// what the shell actually opens. The word counts as quoted.
		if (char === "$" && command[index + 1] === "'" && !single && !double) {
			let close = index + 2;
			while (close < command.length && command[close] !== "'") close += command[close] === "\\" ? 2 : 1;
			if (close < command.length) {
				text += command.slice(index, close + 1);
				partQuoted = true;
				index = close;
				continue;
			}
		}
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
			const combined = char === "&" && command[index + 1] === ">" ? COMBINED_REDIRECT.find((op) => command.startsWith(op, index)) : undefined;
			quoted = quoted || partQuoted;
			flush();
			if (combined !== undefined) { tokens.push({ text: combined, quoted: false }); index += combined.length - 1; }
			else tokens.push({ text: char, quoted: false });
			continue;
		}
		if (char === ">" || char === "<") {
			const combined = COMBINED_REDIRECT.find((op) => command.startsWith(op, index));
			quoted = quoted || partQuoted;
			flush();
			tokens.push({ text: combined ?? char, quoted: false });
			index += (combined ?? char).length - 1;
			continue;
		}
		text += char;
	}
	quoted = quoted || partQuoted;
	flush();
	return tokens.filter(token => token.text !== "" || token.quoted);
}

const REDIRECT = /^(?:\d*)(?:>{1,2}\|?|<>)$/;
const FD_REDIRECT = /^(?:\d*)&>{1,2}\|?$/;
/** A token the tokenizer emitted as redirect syntax, never a path operand. */
function isRedirectToken(token: ShellToken): boolean {
	return !token.quoted && ((COMBINED_REDIRECT as readonly string[]).includes(token.text) || REDIRECT.test(token.text) || FD_REDIRECT.test(token.text));
}
/** A shellTokens token with its byte span, for surgical rewrites that preserve every other byte. */
export interface ShellTokenSpan { text: string; quoted: boolean; start: number; end: number }

/**
 * shellTokens with byte spans. The split mirrors shellTokens exactly (whitespace separates;
 * combined redirect operators and `$'...'` spans are single tokens; quotes and escapes join);
 * callers must verify the returned texts against shellTokens and abort the rewrite on any divergence.
 */
export function shellTokenSpans(command: string): ShellTokenSpan[] {
	const spans: ShellTokenSpan[] = [];
	let text = "", quoted = false, partQuoted = false, start = -1;
	let single = false, double = false, escaped = false;
	const open = (index: number): void => { if (start < 0) start = index; };
	const flush = (end: number): void => {
		if (text !== "" || quoted) spans.push({ text, quoted, start: start < 0 ? end : start, end });
		text = "";
		quoted = false;
		partQuoted = false;
		start = -1;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) { open(index - 1); text += char; escaped = false; continue; }
		// ANSI-C quoting: keep the raw `$'...'` spelling like shellTokens does.
		if (char === "$" && command[index + 1] === "'" && !single && !double) {
			let close = index + 2;
			while (close < command.length && command[close] !== "'") close += command[close] === "\\" ? 2 : 1;
			if (close < command.length) {
				open(index);
				text += command.slice(index, close + 1);
				partQuoted = true;
				index = close;
				continue;
			}
		}
		if (single) {
			if (char === "'") single = false;
			else text += char;
			continue;
		}
		if (double) {
			if (char === '"') double = false;
			else if (char === "\\") { open(index); escaped = true; }
			else text += char;
			continue;
		}
		if (char === "\\") { open(index); escaped = true; continue; }
		if (char === "'") { open(index); single = true; partQuoted = true; continue; }
		if (char === '"') { open(index); double = true; partQuoted = true; continue; }
		if (char === " " || char === "\t" || char === "\n") {
			quoted = quoted || partQuoted;
			flush(index);
			continue;
		}
		if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
			const combined = char === "&" && command[index + 1] === ">" ? COMBINED_REDIRECT.find((op) => command.startsWith(op, index)) : undefined;
			quoted = quoted || partQuoted;
			flush(index);
			const word = combined ?? char;
			spans.push({ text: word, quoted: false, start: index, end: index + word.length });
			index += word.length - 1;
			continue;
		}
		if (char === ">" || char === "<") {
			const combined = COMBINED_REDIRECT.find((op) => command.startsWith(op, index)) ?? char;
			quoted = quoted || partQuoted;
			flush(index);
			spans.push({ text: combined, quoted: false, start: index, end: index + combined.length });
			index += combined.length - 1;
			continue;
		}
		open(index);
		text += char;
	}
	quoted = quoted || partQuoted;
	flush(command.length);
	return spans.filter(span => span.text !== "" || span.quoted);
}

/** Write-target operands of one shell command: redirect targets, tee/cp/mv/mkdir destinations. */
export function shellWriteTargets(command: string): string[] {
	return collectShellWrites(command, null).map(({ target }) => target);
}

/** A shell write target with the directory the command had reached when the target opens. */
export interface ShellWriteAtBase { target: string; base: string }

const CD_OPTION = /^(?:-[LPe@]+|--)$/;
const CD_DYNAMIC = /[$`\\*?[\]{}()|&;<>!]/;

/**
 * The directory a `cd` simple command moves to, resolved against the current base. Static
 * operands (absolute, `~`-home-relative, or plain relative literals) move the base; a dynamic
 * destination (`$dir`, `-`, `~user`, computed text) or an unknown home returns null and leaves
 * the base unchanged rather than guessed.
 */
function cdTargetDir(operands: ShellToken[], base: string, home: string): string | null {
	let at = 0;
	while (at < operands.length && !operands[at]!.quoted && CD_OPTION.test(operands[at]!.text)) at++;
	const operand = operands[at];
	if (operand === undefined) return home !== "" ? home : null;
	const text = operand.text;
	if (operand.quoted) {
		// A quoted `~` never expands, so it cannot name home; keep the pre-cd base.
		if (text === "" || text === "-" || text.startsWith("-") || text.startsWith("~") || CD_DYNAMIC.test(text)) return null;
		return resolve(base, text);
	}
	if (text === "~") return home !== "" ? home : null;
	if (text.startsWith("~/")) return CD_DYNAMIC.test(text) ? null : home !== "" ? home + text.slice(1) : null;
	if (text === "" || text === "-" || text.startsWith("-") || text.startsWith("~") || CD_DYNAMIC.test(text)) return null;
	return resolve(base, text);
}

/**
 * The single walk behind shellWriteTargets and shellWriteBases. A static `cd` into an existing
 * directory moves the physical base (realpath) for every later target, applied at the next
 * command separator, since a redirect in the `cd` command itself opens first; a `cd` inside
 * `(...)` or `$(...)` is scoped by the parentheses and never leaks out, and a lone `&` or `|`
 * drops the pending move (backgrounded/piped `cd` never moves the parent). Every other `cd`
 * keeps the pre-cd base, unchanged.
 */
function collectShellWrites(command: string, track: { cwd: string; home: string } | null): ShellWriteAtBase[] {
	const tokens = shellTokens(command);
	const targets: ShellWriteAtBase[] = [];
	const isSep = (token: ShellToken): boolean => !token.quoted && /^[;&|()]$/.test(token.text);
	let base = track?.cwd ?? "";
	const stack: string[] = [];
	let pending: string | null = null;
	const settle = (): void => { if (pending !== null) { base = pending; pending = null; } };
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i]!;
		if (!token.quoted && token.text === "(") { settle(); stack.push(base); i++; continue; }
		if (!token.quoted && token.text === ")") { if (stack.length > 0) base = stack.pop()!; pending = null; i++; continue; }
		if (isSep(token)) {
			// `&&` and `||` sequence one shell; a lone `&` backgrounds and a lone `|` pipes,
			// so the `cd` ran in a subshell and never moves the parent's base: drop it.
			const next = tokens[i + 1];
			if ((token.text === "&" || token.text === "|") && (next === undefined || next.text !== token.text || next.quoted)) pending = null;
			else settle();
			i++;
			continue;
		}
		if (!token.quoted && (REDIRECT.test(token.text) || FD_REDIRECT.test(token.text))) {
			const next = tokens[i + 1];
			if (next && next.text !== "" && !isSep(next)) targets.push({ target: next.text, base });
			i += 2;
			continue;
		}
		if (!token.quoted && (token.text === "tee" || token.text === "mkdir")) {
			i++;
			while (i < tokens.length && !isSep(tokens[i]!)) {
				const arg = tokens[i]!;
				// An input redirect is never a tee write target (M1): `tee /tmp/a < /tmp/b` reads b.
				if (isRedirectToken(arg)) break;
				if (arg.text === "-") { i++; continue; }
				if (!arg.quoted && arg.text.startsWith("-")) { i++; continue; }
				targets.push({ target: arg.text, base });
				i++;
			}
			continue;
		}
		if (!token.quoted && (token.text === "cp" || token.text === "mv" || token.text === "ln" || token.text === "install")) {
			i++;
			const operands: string[] = [];
			let dashT: string | null = null;
			let skip = false;
			while (i < tokens.length && !isSep(tokens[i]!)) {
				const arg = tokens[i]!;
				if (isRedirectToken(arg)) break;
				if (skip) { dashT = arg.text; skip = false; i++; continue; }
				if (!arg.quoted && arg.text.startsWith("-") && arg.text !== "-") {
					// F2: `--target-directory DIR` (attached or separate) names the destination like `-t`.
					if (arg.text === "-t" || arg.text === "--target-directory") skip = true;
					else if (arg.text.startsWith("--target-directory=")) dashT = arg.text.slice("--target-directory=".length);
					i++;
					continue;
				}
				operands.push(arg.text);
				i++;
			}
			const dest = dashT ?? operands.at(-1);
			if (dest !== undefined) targets.push({ target: dest, base });
			continue;
		}
		// F3: `dd of=<path>` writes that file; `if=` is a read and is never a write target.
		if (!token.quoted && token.text === "dd") {
			i++;
			while (i < tokens.length && !isSep(tokens[i]!)) {
				const arg = tokens[i]!;
				if (isRedirectToken(arg)) break;
				if (arg.text.startsWith("of=")) targets.push({ target: arg.text.slice("of=".length), base });
				i++;
			}
			continue;
		}
		const atCommand = i === 0 || isSep(tokens[i - 1]!);
		if (track !== null && atCommand && !token.quoted && commandName(token.text) === "cd") {
			const operands: ShellToken[] = [];
			for (let j = i + 1; j < tokens.length && !isSep(tokens[j]!); j++) operands.push(tokens[j]!);
			// Follow only a static `cd` into an existing directory (one bounded stat); in every
			// other case keep today's pre-cd resolution, unchanged. The base is the physical
			// directory (one bounded realpath of a proven-existing path), so a symlinked `cd`
			// target is judged where the write really lands.
			const dest = cdTargetDir(operands, base, track.home);
			if (dest !== null && existsSync(dest)) {
				try { pending = realpathSync(dest); }
				catch { /* raced away between stat and resolve: keep the pre-cd base */ }
			}
		}
		const name = token.quoted || !atCommand ? "" : commandName(token.text);
		if (name === "git" || name === "rsync" || name === "tar") {
			const args: ShellToken[] = [];
			for (i++; i < tokens.length && !isSep(tokens[i]!); i++) args.push(tokens[i]!);
			targets.push(...(name === "git" ? gitWriteTargets(args) : name === "rsync" ? rsyncWriteTargets(args) : tarWriteTargets(args)).map((target) => ({ target, base })));
			continue;
		}
		i++;
	}
	return targets.filter(({ target }) => target !== "");
}

/**
 * Write targets of one shell command with the directory each target opens under, so
 * `cd var/agent-tmp/w && echo hi > ../../out` resolves where the agent wrote (inside the
 * repository) instead of against the session root (which looks like a home-root write).
 * Only a static `cd` into an existing directory moves the base; every other shape resolves
 * exactly as shellWriteTargets does (APPLICSCRATCH1, ompkit-1ra0d.127).
 */
export function shellWriteBases(command: string, cwd: string, home: string): ShellWriteAtBase[] {
	return collectShellWrites(command, { cwd, home });
}

const isOption = (arg: ShellToken): boolean => !arg.quoted && arg.text.startsWith("-") && arg.text !== "-";

// git clone/worktree options that consume the next word (git-clone(1), git-worktree(1)).
const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GIT_CLONE_VALUE = new Set(["-b", "--branch", "-o", "--origin", "-u", "--upload-pack", "--depth", "--reference",
	"--reference-if-able", "-c", "--config", "--template", "--separate-git-dir", "--filter", "-j", "--jobs",
	"--shallow-since", "--shallow-exclude", "--server-option", "--bundle-uri", "--ref-format"]);
const GIT_WORKTREE_VALUE = new Set(["-b", "-B", "--reason"]);

/** git clone destination (explicit, else the repository basename in cwd), --separate-git-dir, and git worktree add PATH. */
function gitWriteTargets(args: readonly ShellToken[]): string[] {
	let i = 0;
	while (i < args.length && isOption(args[i]!)) i += GIT_GLOBAL_VALUE.has(args[i]!.text) ? 2 : 1;
	const sub = args[i++]?.text;
	const out: string[] = [];
	if (sub === "clone") {
		const operands: string[] = [];
		for (; i < args.length; i++) {
			const arg = args[i]!;
			if (!isOption(arg)) { operands.push(arg.text); continue; }
			const [option, attached] = arg.text.split("=", 2) as [string, string | undefined];
			const value = attached ?? (GIT_CLONE_VALUE.has(option) ? args[++i]?.text : undefined);
			if (option === "--separate-git-dir" && value) out.push(value);
		}
		if (operands.length >= 2) out.push(operands[1]!);
		else if (operands.length === 1) {
			let source = operands[0]!;
			while (source.endsWith("/")) source = source.slice(0, -1);
			if (source.endsWith(".git")) source = source.slice(0, -4);
			out.push(source.slice(Math.max(source.lastIndexOf("/"), source.lastIndexOf(":")) + 1));
		}
	} else if (sub === "worktree" && args[i]?.text === "add") {
		for (i++; i < args.length; i++) {
			const arg = args[i]!;
			if (!isOption(arg)) { out.push(arg.text); break; }
			if (GIT_WORKTREE_VALUE.has(arg.text)) i++;
		}
	}
	return out;
}

/** rsync's last operand is its destination; a remote (host:path) destination is not local. */
function rsyncWriteTargets(args: readonly ShellToken[]): string[] {
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (isOption(arg)) { if (arg.text === "-e" || arg.text === "-f" || arg.text === "-T") i++; continue; }
		operands.push(arg.text);
	}
	const dest = operands.length >= 2 ? operands.at(-1)! : undefined;
	return dest === undefined || /^[^/]*:/.test(dest) ? [] : [dest];
}

/** Extraction writes under -C/--directory; create/append/update writes only the -f archive (-C is then a source). */
function tarWriteTargets(args: readonly ShellToken[]): string[] {
	const out: string[] = [];
	let writes = false;
	let archive: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		const text = arg.text;
		if (arg.quoted) continue;
		if (text.startsWith("--")) {
			const [option, attached] = text.split("=", 2) as [string, string | undefined];
			if (option === "--directory" || option === "--file") {
				const value = attached ?? args[++i]?.text;
				if (value === undefined) continue;
				if (option === "--directory") out.push(value);
				else archive = value;
			} else if (option === "--create" || option === "--append" || option === "--update") writes = true;
			continue;
		}
		// Bundled flags: the first word may omit its dash (tar czf a.tgz); -C and -f take the next word or the rest.
		const flags = text.startsWith("-") ? text.slice(1) : i === 0 ? text : "";
		for (let at = 0; at < flags.length; at++) {
			const flag = flags[at]!;
			if (flag === "c" || flag === "r" || flag === "u") writes = true;
			if (flag === "C" || flag === "f") {
				const value = at + 1 < flags.length && text.startsWith("-") && flag === "C" ? flags.slice(at + 1) : args[++i]?.text;
				if (value !== undefined) {
					if (flag === "C") out.push(value);
					else archive = value;
				}
				if (flag === "C" && at + 1 < flags.length && text.startsWith("-")) break;
			}
		}
	}
	if (writes) return archive !== undefined && archive !== "-" ? [archive] : [];
	return out;
}

/** Directories an executed mktemp would allocate under: each literal template (beside -p DIR), else $TMPDIR (/tmp unset). */
function mktempWriteTargets(argv: readonly ShellWord[]): string[] {
	const name = commandName(argv[0]?.text ?? "");
	if (name !== "mktemp" && name !== "gmktemp") return [];
	const tempDir = process.env.TMPDIR || "/tmp";
	let dir: string | undefined;
	let prefix = false;
	const templates: string[] = [];
	for (let index = 1; index < argv.length; index++) {
		const text = argv[index]!.text;
		if (text === "--") { templates.push(...argv.slice(index + 1).map(word => word.text)); break; }
		if (text.startsWith("--tmpdir")) { dir = text.includes("=") ? text.slice(text.indexOf("=") + 1) : tempDir; continue; }
		if (text.startsWith("--")) continue;
		if (!text.startsWith("-") || text === "-") { templates.push(text); continue; }
		const p = text.indexOf("p"), t = text.indexOf("t");
		if (p > 0) { dir = text.slice(p + 1) || argv[++index]?.text; continue; }
		if (t > 0) { prefix = true; if (text.slice(t + 1) === "") index++; }
	}
	if (prefix || templates.length === 0) return [join(dir ?? tempDir, "mktemp")];
	return templates.map(template => dir !== undefined && !isAbsolute(template) ? join(dir, template) : template);
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
/**
 * An expanded word naming a /tmp path in a write position (F4): `${x:-/tmp/a}`, `$f`-style
 * computed names. Command substitutions (`$(...)`, backquotes) are skipped: their inner commands
 * are judged on their own (mktemp templates keep their scratch-alloc refusal). Returns the
 * offending word and the system-temp root it names, or undefined.
 */
export function expandedTmpWriteText(command: string, writeTexts: ReadonlySet<string>): { text: string; root: string } | undefined {
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return undefined;
	// A dd operand keeps its `of=` prefix in argv while shellWriteBases records the bare path.
	const candidates = inspection.writes.map(({ target }) => target).concat(
		inspection.commands.flatMap(({ argv }) => argv.filter((word) => writeTexts.has(word.text) || (word.text.startsWith("of=") && writeTexts.has(word.text.slice("of=".length))))));
	const hit = candidates.find((word) => word.expanded && !word.text.includes("$(") && !word.text.includes("`") && spanHasTmpText(word.text));
	if (!hit) return undefined;
	const root = [...SYSTEM_TEMP_ROOTS].sort((a, b) => b.length - a.length).find((root) => hit.text === root || hit.text.includes(`${root}/`));
	return root === undefined ? undefined : { text: hit.text, root };
}
function checkBashTargets(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
	if (tool !== "bash" || !command) return undefined;
	const cwd = eventCwd(event, context);
	const home = homeDir();
	const writes = shellWriteBases(command, cwd, home);
	for (const { target, base } of writes) {
		const abs = resolveCandidate(base, target);
		if (abs === null) continue;
		const root = forbiddenTarget(abs, home, base);
		if (root !== null) return blockScratch("scratch-write", target, root);
	}
	// F4: an expanded word naming a /tmp path in a write position is unresolvable by
	// construction; block it here, the same rule the rewrite applies before refusing.
	const expanded = expandedTmpWriteText(command, new Set(writes.map(({ target }) => target)));
	if (expanded !== undefined) return blockScratch("scratch-write", expanded.text, expanded.root);
	return undefined;
}

// TMPALLOC1: mktemp option grammar is pinned per dialect, never inferred from argument shape. Darwin's BSD mktemp
// (mktemp(1), macOS 26) takes -d -q -u -p DIR -t PREFIX and their long forms; anywhere else, and for GNU gmktemp,
// only the options both share (-d -q -u) are admitted, so a dialect-specific destination option is refused.
const HOST_MKTEMP: "darwin" | "portable" = process.platform === "darwin" ? "darwin" : "portable";

/** Under the var/agent-tmp of cwd or one of its ancestors (never the filesystem root's), and not a forbidden root. */
function repoLocalScratch(target: string, cwd: string, home: string): boolean {
	if (forbiddenTarget(target, home, cwd) !== null) return false;
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

/**
 * TMPWRITE1 (ompkit-fp72.120.16.158): system-temp writes are refused in every session, seat or subagent, whatever
 * the calling cwd's fleet policy; the policy-gated check above adds repo scratch and home-root rules on top.
 * Write/edit paths, shell write operands (redirects, tee/mkdir/cp/mv, git clone/worktree, rsync, tar) and the
 * directories an executed mktemp allocates under. Reads of system temp stay allowed.
 */
// TMPREWRITE1 (ompkit-1ra0d.144): a literal simple file directly under /tmp, /private/tmp or
// /var/tmp lands in the seat's session scratch instead of refused. Conservative by construction:
// every condition below must hold, otherwise the caller keeps today's refusal, never an unguarded
// write. Tokenizer word spans (not string replace) drive the bash substitution.
/** System-temp roots whose literal simple children the guard may complete into session scratch. */
export const REWRITABLE_TMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp"] as const;
/** A rewritable basename: no glob, no variable, no directory, at most 64 chars. Exclusive classes. */
export const REWRITABLE_BASENAME = /^[A-Za-z0-9._-]{1,64}$/;
/** One AUTO_COMPLETED notice line per completed literal. */
export function autoCompletedLine(from: string, to: string): string {
	return `AUTO_COMPLETED: ${from} -> ${to}`;
}
/** The literal system-temp file a candidate names, or undefined when it is not a bare `<root>/<base>`. */
export function parseSessionTmpLiteral(candidate: string): { root: string; base: string } | undefined {
	for (const root of REWRITABLE_TMP_ROOTS) {
		if (candidate.length <= root.length + 1 || !candidate.startsWith(`${root}/`)) continue;
		const base = candidate.slice(root.length + 1);
		if (REWRITABLE_BASENAME.test(base)) return { root, base };
		return undefined;
	}
	return undefined;
}
/** One shell word with its exact byte span in the command, quote and expansion marks. */
export interface ShellWordSpan { text: string; start: number; end: number; quoted: boolean; expanded: boolean }
/**
 * Quote-aware words with exact byte spans. Mirrors shellTokens word boundaries (whitespace and
 * `;&|()<>"` separators, single/double quotes, backslash escapes) and additionally records where
 * each word sits, so a substitution can splice whole words only. A span is `expanded` when any part
 * of it was quoted-incompatible with a literal path: `$`, backtick, brace/bracket/glob characters,
 * a leading `~`, or an escape; `quoted` when any part was quoted.
 */
export type ShellWordSpans = { spans: ShellWordSpan[] } | { error: string };
export function shellWordSpans(command: string): ShellWordSpans {
	const spans: ShellWordSpan[] = [];
	let text = "", start = -1, quoted = false, partQuoted = false, expanded = false;
	let single = false, double = false, escaped = false;
	const flush = (end: number): void => {
		if (start >= 0 && (text !== "" || quoted)) spans.push({ text, start, end, quoted, expanded });
		text = "";
		start = -1;
		quoted = false;
		partQuoted = false;
		expanded = false;
	};
	const begin = (index: number): void => {
		if (start < 0) start = index;
	};
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (escaped) { begin(index - 1); text += char; expanded = true; escaped = false; continue; }
		// ANSI-C quoting (H3): keep the raw `$'...'` spelling like shellTokens does; the `$`
		// already marks the span expanded, so the rewrite never splices it.
		if (char === "$" && command[index + 1] === "'" && !single && !double) {
			let close = index + 2;
			while (close < command.length && command[close] !== "'") close += command[close] === "\\" ? 2 : 1;
			if (close < command.length) {
				begin(index);
				text += command.slice(index, close + 1);
				partQuoted = true;
				expanded = true;
				index = close;
				continue;
			}
		}
		if (single) {
			if (char === "'") single = false;
			else text += char;
			continue;
		}
		if (double) {
			if (char === '"') double = false;
			else if (char === "\\") escaped = true;
			else if (char === "$" || char === "`") { text += char; expanded = true; }
			else text += char;
			continue;
		}
		if (char === "\\") { begin(index); escaped = true; continue; }
		if (char === "'") { begin(index); single = true; partQuoted = true; continue; }
		if (char === '"') { begin(index); double = true; partQuoted = true; continue; }
		if (char === " " || char === "\t" || char === "\n" || char === "\r") { quoted = quoted || partQuoted; flush(index); continue; }
		// A `#` that starts a word is a comment to end of line, exactly as lexShell treats it (M4):
		// the comment body is inert text, never a whole word to substitute.
		if (char === "#" && start < 0) {
			while (index < command.length && command[index] !== "\n") index++;
			continue;
		}
		if (char === ";" || char === "&" || char === "|" || char === "(" || char === ")") {
			const combined = char === "&" && command[index + 1] === ">" ? COMBINED_REDIRECT.find((op) => command.startsWith(op, index)) : undefined;
			quoted = quoted || partQuoted; flush(index);
			index += (combined ?? char).length - 1;
			continue;
		}
		if (char === ">" || char === "<") {
			const combined = COMBINED_REDIRECT.find((op) => command.startsWith(op, index)) ?? char;
			quoted = quoted || partQuoted; flush(index);
			index += combined.length - 1;
			continue;
		}
		begin(index);
		if (char === "$" || char === "`" || char === "*" || char === "?" || char === "[" || char === "]" || char === "{" || char === "}" || char === "!" || char === "#") expanded = true;
		if (char === "~" && text === "") expanded = true;
		text += char;
	}
	if (single) return { error: "unterminated single quote" };
	if (double) return { error: "unterminated double quote" };
	if (escaped) return { error: "trailing escape" };
	quoted = quoted || partQuoted;
	flush(command.length);
	return { spans };
}
/** Commands whose presence anywhere in the call forbids a rewrite (another machine or interpreter). */
const REWRITE_REMOTE_COMMANDS: Record<string, true> = { ssh: true, scp: true, rsync: true, docker: true, podman: true, kubectl: true, "omp-kit": true, vmpal: true };
/** Wrappers whose later operands may name a remote program (sudo/ssh) or runner (xargs/find -exec). */
const REWRITE_WRAPPER_COMMANDS: Record<string, true> = { sudo: true, xargs: true };
/** Tools that allocate or create directories: a rewrite must never silently redirect them. */
const REWRITE_ALLOC_COMMANDS: Record<string, true> = { mkdir: true, mktemp: true, gmktemp: true };
/** File-operation destinations are never spliced: clone/extract/copy targets create directories or trees,
 * so a literal there does not name the file the tool will open. Redirects and tee stay rewritable. */
const REWRITE_FILEOP_COMMANDS: Record<string, true> = { cp: true, mv: true, git: true, rsync: true, tar: true, install: true, ln: true, cpio: true, unzip: true };
function spanHasTmpText(text: string): boolean {
	return text.includes("/tmp/") || text === "/tmp" || text.includes("/private/tmp/") || text.includes("/var/tmp/");
}
export interface RewriteMapping { from: string; to: string; note?: string }
export type OriginalExists = (literal: string) => boolean;
/** A rewrite destination the guard can prove safe, or the reason it cannot (H1). */
export function rewriteDestinationProblem(path: string): string | undefined {
	let stat;
	try { stat = lstatSync(path); }
	catch { return undefined; }
	if (stat.isSymbolicLink()) return "rewrite destination is a symlink";
	if (!stat.isFile()) return "rewrite destination is not a regular file";
	if (stat.nlink !== 1) return "rewrite destination has multiple hard links";
	return undefined;
}
/** A real file at the original literal path, independently of the session copy (M2). */
export function originalFileExists(literal: string): boolean {
	try { lstatSync(literal); return true; }
	catch { return false; }
}
export interface ShellRewriteOpts { cwd: string; home: string; sessionDir: string; aliases: Map<string, string>; originalExists?: OriginalExists }
export type ShellRewrite = { command: string; mapped: Array<RewriteMapping> } | { refuse: string } | undefined;
/**
 * Rewrite every whole-word occurrence of a literal simple system-temp file in a bash command to the
 * session scratch, or refuse (keep today's refusal), or undefined when the command involves no
 * system-temp path at all. Reads of an already-mapped literal follow the mapping; anything else
 * (variable-built, glob, quoted, heredoc/herestring body, remote or nested execution context,
 * allocation tools, a tmp substring that is not a whole word) refuses.
 */
export function rewriteShellCommand(command: string, opts: ShellRewriteOpts): ShellRewrite {
	const lexed = shellWordSpans(command);
	if ("error" in lexed) return { refuse: `uninspectable shell text (${lexed.error})` };
	const spans = lexed.spans;
	const unquoted = command.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
	if (unquoted.includes("<<")) return { refuse: "here-document or here-string body" };
	// A noclobber-forcing redirect is refused, never rewritten (H2): `>|` opens the real /tmp file.
	for (const token of shellTokens(command)) {
		if (!token.quoted && (token.text === ">|" || token.text === ">>|" || token.text === "&>|" || token.text === "&>>|")) return { refuse: "noclobber redirect (>|)" };
	}
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return { refuse: inspection.refusal };
	for (const { argv } of inspection.commands) {
		const name = commandName(argv[0]?.text ?? "");
		if (REWRITE_REMOTE_COMMANDS[name] === true) return { refuse: `remote or nested execution context (${name})` };
		if (REWRITE_ALLOC_COMMANDS[name] === true) return { refuse: `directory or temp allocation (${name})` };
		if (REWRITE_FILEOP_COMMANDS[name] === true) return { refuse: `file-operation destination (${name})` };
		// L2: remote operands after sudo/xargs/find -exec are detected explicitly, not via the
		// quoted-span fallback: a later unquoted remote word means another machine reads the path.
		const wrapped = REWRITE_WRAPPER_COMMANDS[name] === true ? argv.slice(1)
			: name === "find" ? argv.slice(argv.findIndex((word) => word.text === "-exec" || word.text === "-execdir") + 1) : [];
		for (const word of wrapped) {
			if (word.text === "-exec" || word.text === "-execdir" || word.text === "{}" || word.text === "+" || word.text === ";") continue;
			if (spans.some((span) => span.text === word.text && !span.quoted && !span.expanded)) {
				if (REWRITE_REMOTE_COMMANDS[commandName(word.text)] === true) return { refuse: `remote operand after ${name} (${word.text.slice(0, 32)})` };
				// F1: a file operation after a wrapper (xargs/find/sudo cp, ...) names a
				// directory or tree at the destination, never a plain file to splice.
				if (REWRITE_FILEOP_COMMANDS[commandName(word.text)] === true) return { refuse: `file-operation destination after ${name} (${word.text.slice(0, 32)})` };
			}
		}
		for (const word of argv) {
			if (word.expanded && spanHasTmpText(word.text)) return { refuse: `computed temp path (${word.text.slice(0, 48)})` };
		}
	}
	const writes = shellWriteBases(command, opts.cwd, opts.home);
	// F3: the bare path of a `dd of=<path>` operand. Only a dd operand's `of=` names a file;
	// elsewhere `of=` is literal text and keeps today's refusal.
	const ddOfWords = new Set<string>();
	for (const { argv } of inspection.commands) {
		if (commandName(argv[0]?.text ?? "") !== "dd") continue;
		for (const word of argv) if (word.text.startsWith("of=")) ddOfWords.add(word.text);
	}
	const bareOf = (text: string): string | undefined => text.startsWith("of=") && ddOfWords.has(text) ? text.slice("of=".length) : undefined;
	const literals = new Map<string, string>();
	const mapped = (literal: string): string => {
		const known = opts.aliases.get(literal);
		if (known) return known;
		const parsed = parseSessionTmpLiteral(literal);
		const to = join(opts.sessionDir, parsed?.base ?? literal.slice(literal.lastIndexOf("/") + 1));
		opts.aliases.set(literal, to);
		return to;
	};
	for (const { target, base } of writes) {
		const abs = resolveCandidate(base, target);
		if (abs === null) return { refuse: `unresolvable write target (${target.slice(0, 48)})` };
		if (systemTempRoot(abs, opts.cwd) === undefined) continue;
		const parsed = !target.startsWith("/") ? undefined : parseSessionTmpLiteral(target);
		if (!parsed) return { refuse: `non-literal system-temp write target (${target.slice(0, 48)})` };
		// H1: the session destination must be absent or a plain single-link file; a planted
		// symlink, directory or hard link keeps today's refusal instead of being followed.
		const problem = rewriteDestinationProblem(join(opts.sessionDir, parsed.base));
		if (problem !== undefined) return { refuse: `${problem} (${target.slice(0, 48)})` };
		literals.set(target, mapped(target));
	}
	const reads = new Map<string, string>();
	const readNotes = new Map<string, string>();
	const originalExists = opts.originalExists ?? originalFileExists;
	for (const span of spans) {
		if (!spanHasTmpText(span.text)) continue;
		if (span.quoted || span.expanded) return { refuse: `quoted or computed temp path (${span.text.slice(0, 48)})` };
		// F3: a dd operand splices as `of=<session file>`; the bare path below is what is judged.
		const bare = bareOf(span.text) ?? span.text;
		if (literals.has(bare)) continue;
		const known = opts.aliases.get(bare);
		if (known !== undefined) {
			// M2: the session wrote this literal; when a different real file also sits at the
			// original path, the notice says the read serves the session copy.
			if (originalExists(bare)) readNotes.set(bare, `a different file exists at ${bare}; reading the session copy`);
			reads.set(bare, known);
			continue;
		}
		if (parseSessionTmpLiteral(bare) === undefined) return { refuse: `non-literal system-temp path (${span.text.slice(0, 48)})` };
		const abs = resolveCandidate(opts.cwd, bare);
		if (abs === null || systemTempRoot(abs, opts.cwd) === undefined) continue;
		return { refuse: `system-temp path outside a write (${span.text.slice(0, 48)})` };
	}
	if (literals.size === 0 && reads.size === 0) return undefined;
	const all = new Map([...literals, ...reads]);
	const found: Array<RewriteMapping> = [];
	let out = command;
	const keyOf = (text: string): string => bareOf(text) ?? text;
	const ordered = spans.filter((span) => all.has(keyOf(span.text))).sort((a, b) => b.start - a.start);
	for (const span of ordered) {
		const key = keyOf(span.text);
		const to = all.get(key)!;
		const replacement = key === span.text ? to : `of=${to}`;
		out = `${out.slice(0, span.start)}${replacement}${out.slice(span.end)}`;
		if (!found.some((entry) => entry.from === span.text)) {
			const note = readNotes.get(key);
			found.push(note === undefined ? { from: span.text, to: replacement } : { from: span.text, to: replacement, note });
		}
	}
	return { command: out, mapped: found.sort((a, b) => (a.from < b.from ? -1 : 1)) };
}
export interface ToolRewriteOpts { cwd: string; context: FleetGuardContext; sessionDir: string; aliases: Map<string, string>; originalExists?: OriginalExists }
export type ToolRewrite = { input: Record<string, unknown>; mapped: Array<RewriteMapping> } | { refuse: string } | undefined;
function mapLiteral(literal: string, opts: ToolRewriteOpts): string {
	const known = opts.aliases.get(literal);
	if (known) return known;
	const to = join(opts.sessionDir, parseSessionTmpLiteral(literal)!.base);
	opts.aliases.set(literal, to);
	return to;
}
const HASHLINE_HEADER = /^\[([^[\]]+)#([0-9A-Fa-f]{4})\]$/;
function rewriteHashlinePatch(patch: string, opts: ToolRewriteOpts): { patch: string; mapped: Array<{ from: string; to: string }> } | { refuse: string } | undefined {
	if (!patch.startsWith("*** Begin Patch")) return undefined;
	const mapped = new Map<string, string>();
	let touched = false;
	const lines = patch.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const header = HASHLINE_HEADER.exec(lines[index]!);
		if (!header) continue;
		const raw = header[1]!;
		if (mapped.has(raw)) { lines[index] = `[${mapped.get(raw)}#${header[2]}]`; touched = true; continue; }
		const parsed = parseSessionTmpLiteral(raw);
		if (parsed !== undefined) {
			// H1: refuse when the session destination is a planted symlink, directory or hard link.
			const problem = rewriteDestinationProblem(join(opts.sessionDir, parsed.base));
			if (problem !== undefined) return { refuse: `${problem} (${raw.slice(0, 48)})` };
			const to = mapLiteral(raw, opts);
			mapped.set(raw, to);
			lines[index] = `[${to}#${header[2]}]`;
			touched = true;
			continue;
		}
		let abs: string | undefined;
		try { abs = resolveFilesystemWriteTarget(opts.cwd, raw, opts.context); } catch { abs = null as unknown as undefined; }
		if (abs !== undefined && systemTempRoot(abs, opts.cwd) !== undefined) return { refuse: `non-literal system-temp edit target (${raw.slice(0, 48)})` };
	}
	if (!touched) return undefined;
	return { patch: lines.join("\n"), mapped: [...mapped].map(([from, to]) => ({ from, to })) };
}
/**
 * Rewrite write/edit/read tool input so literal simple /tmp files land in the session scratch.
 * Returns undefined when no system-temp path is involved (run as-is); {refuse} keeps today's
 * refusal. Reads follow an existing mapping only; a first-time read of system temp stays allowed
 * and unmapped, exactly as today.
 */
export function rewriteToolInput(tool: string, input: unknown, opts: ToolRewriteOpts): ToolRewrite {
	if (!input || typeof input !== "object") return undefined;
	const record = input as Record<string, unknown>;
	const mapped = new Map<string, string>();
	const notes = new Map<string, string>();
	const originalExists = opts.originalExists ?? originalFileExists;
	const patchKeys = ["patch", "input", "_input"] as const;
	const hasPathField = typeof record.path === "string" || typeof record.file === "string" || Array.isArray(record.paths);
	if (!hasPathField) {
		for (const key of patchKeys) {
			const patch = record[key];
			if (typeof patch !== "string") continue;
			const rewritten = rewriteHashlinePatch(patch, opts);
			if (rewritten === undefined) return undefined;
			if ("refuse" in rewritten) return rewritten;
			for (const entry of rewritten.mapped) mapped.set(entry.from, entry.to);
			return { input: { ...record, [key]: rewritten.patch }, mapped: [...mapped].map(([from, to]) => ({ from, to })) };
		}
		return undefined;
	}
	const rewriteValue = (value: string): string | { refuse: string } => {
		const known = opts.aliases.get(value);
		if (known !== undefined) {
			mapped.set(value, known);
			// M2: a read that follows the session mapping says so when a different real file
			// also sits at the original literal path.
			if (tool === "read" && originalExists(value)) notes.set(value, `a different file exists at ${value}; reading the session copy`);
			return known;
		}
		// Reads follow an existing mapping only; a first-time read of system temp stays allowed
		// and unmapped, exactly as today.
		if (tool === "read") return value;
		const parsed = parseSessionTmpLiteral(value);
		if (parsed !== undefined) {
			// H1: refuse when the session destination is a planted symlink, directory or hard link.
			const problem = rewriteDestinationProblem(join(opts.sessionDir, parsed.base));
			if (problem !== undefined) return { refuse: `${problem} (${value.slice(0, 48)})` };
			const to = mapLiteral(value, opts);
			mapped.set(value, to);
			return to;
		}
		let abs: string | undefined;
		try { abs = resolveFilesystemWriteTarget(opts.cwd, value, opts.context); } catch { return { refuse: `unresolvable path (${value.slice(0, 48)})` }; }
		if (abs === undefined || systemTempRoot(abs, opts.cwd) === undefined) return value;
		return { refuse: `non-literal system-temp path (${value.slice(0, 48)})` };
	};
	const withNotes = (): Array<RewriteMapping> => [...mapped].map(([from, to]) => {
		const note = notes.get(from);
		return note === undefined ? { from, to } : { from, to, note };
	});
	const next: Record<string, unknown> = { ...record };
	for (const key of ["path", "file"] as const) {
		const value = record[key];
		if (typeof value !== "string" || value.trim() === "") continue;
		const rewritten = rewriteValue(value);
		if (typeof rewritten !== "string") return rewritten;
		next[key] = rewritten;
	}
	if (Array.isArray(record.paths)) {
		const paths: unknown[] = [];
		for (const entry of record.paths) {
			if (typeof entry !== "string" || entry.trim() === "") { paths.push(entry); continue; }
			const rewritten = rewriteValue(entry);
			if (typeof rewritten !== "string") return rewritten;
			paths.push(rewritten);
		}
		next.paths = paths;
	}
	if (mapped.size === 0) return undefined;
	return { input: next, mapped: withNotes() };
}
/** A hand-made scratch dir adopted for the calling seat, or a refusal reason keeping today's block. */
export type AdoptResult = { dir: string; name: string } | { refuse: string };
export interface AdoptOpts { cwd: string; agent?: string; session?: string; now?: string; createdDirs?: ReadonlySet<string> }
/**
 * Adopt a hand-made directory with no `.owner` record under the calling repository's scratch root,
 * but ONLY when this session itself created it (M3): the caller passes the session guard state's
 * `createdDirs`, and anything else keeps today's refusal with the remedy text. The owner record is
 * written with an exclusive create (fail if one appeared meanwhile), through the kit's own owner
 * writer bytes (never a hand-built record), naming the calling seat with bin throwaway so the dir
 * is visible to `omp-kit scratch mine` and released at session end like the seat's other dirs.
 */
export function adoptOwnerlessDir(target: string, opts: AdoptOpts): AdoptResult {
	const repo = repositoryRootOf(opts.cwd);
	if (!repo) return { refuse: "no repository root above the calling directory" };
	let abs: string;
	try {
		abs = isAbsolute(target) ? normalize(target) : resolve(opts.cwd, target);
		if (abs.includes("\0")) return { refuse: "invalid path" };
	} catch { return { refuse: "unresolvable path" }; }
	const root = join(repo, "var", "agent-tmp");
	if (abs !== root && !abs.startsWith(`${root}/`)) return { refuse: "outside the calling repository scratch root" };
	if (abs === root) return { refuse: "the scratch root itself is not adoptable" };
	const name = abs.slice(root.length + 1).split("/")[0]!;
	const dir = join(root, name);
	let stat: Stats | undefined;
	try { stat = statSync(dir); } catch { return { refuse: "scratch directory does not exist" }; }
	if (!stat.isDirectory()) return { refuse: "scratch name is not a directory" };
	try {
		if (lstatSync(dir).isSymbolicLink()) return { refuse: "scratch name is a symlink" };
	} catch { return { refuse: "scratch directory unavailable" }; }
	if (opts.createdDirs === undefined || !opts.createdDirs.has(dir)) return { refuse: "scratch directory was not created by this session" };
	if (!opts.agent || !opts.session) return { refuse: "calling seat identity unavailable" };
	try {
		writeFileSync(join(dir, ".owner"), renderScratchOwner({ pid: process.pid, label: name, repo, created: opts.now ?? new Date().toISOString(), agent: opts.agent, session: opts.session, bin: "throwaway" }), { flag: "wx", mode: 0o600 });
	} catch {
		return { refuse: "scratch directory already has an owner" };
	}
	return { dir, name };
}
/** Every path-like target a write/edit tool call names (path/file/paths fields). */
export function toolTargetPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const record = input as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ["path", "file"] as const) if (typeof record[key] === "string") out.push(record[key] as string);
	if (Array.isArray(record.paths)) for (const entry of record.paths) if (typeof entry === "string") out.push(entry);
	return out;
}
/** mkdir options that consume the next word (mode/context); attached `--opt=value` never does. */
const MKDIR_VALUE_OPTIONS: Record<string, true> = { "-m": true, "--mode": true, "-Z": true, "--context": true };
/** Literal mkdir destinations of a bash command, through the same executed-command traversal the guards share. */
export function mkdirScratchDests(command: string): string[] {
	const inspection = executedShellCommands(command);
	if ("refusal" in inspection) return [];
	const out: string[] = [];
	for (const { argv } of inspection.commands) {
		// A bare `sudo mkdir ...` runs mkdir; anything fancier (options before mkdir) stays missed, fail closed.
		const start = commandName(argv[0]?.text ?? "") === "sudo" ? 1 : 0;
		if (commandName(argv[start]?.text ?? "") !== "mkdir") continue;
		let options = true;
		for (let index = start + 1; index < argv.length; index++) {
			const word = argv[index]!;
			if (word.expanded) { options = false; continue; }
			if (options && word.text === "--") { options = false; continue; }
			if (options && word.text.startsWith("-") && word.text !== "-") {
				if (!word.text.includes("=") && MKDIR_VALUE_OPTIONS[word.text] === true) index++;
				continue;
			}
			options = false;
			out.push(word.text);
		}
	}
	return out;
}
/**
 * Scratch-root top dirs an admitted call creates (M3): literal mkdir destinations of an admitted
 * bash call, and write/edit targets whose top-level dir does not exist yet. The caller records
 * them only when the verdict admits, so adoption later proves this session made the dir.
 */
export function createdScratchTops(tool: string, command: string | undefined, paths: string[], cwd: string): string[] {
	const repo = repositoryRootOf(cwd);
	if (!repo) return [];
	const root = join(repo, "var", "agent-tmp");
	const tops: string[] = [];
	const consider = (candidate: string): void => {
		let abs: string;
		try { abs = isAbsolute(candidate) ? normalize(candidate) : resolve(cwd, candidate); }
		catch { return; }
		if (abs === root || !abs.startsWith(`${root}/`)) return;
		const top = join(root, abs.slice(root.length + 1).split("/")[0]!);
		try { if (existsSync(top)) return; }
		catch { return; }
		if (!tops.includes(top)) tops.push(top);
	};
	if (tool === "bash" && command !== undefined) for (const dest of mkdirScratchDests(command)) consider(dest);
	if (tool === "write" || tool === "edit") for (const path of paths) consider(path);
	return tops;
}

export function checkSystemTemp(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	const tool = typeof event.toolName === "string" ? event.toolName : "";
	const cwd = resolve(eventCwd(event, context));
	const refuse = (candidate: string, abs: string | null): FleetGuardBlock | undefined => {
		const root = abs === null ? undefined : systemTempRoot(abs, cwd);
		return root === undefined ? undefined : { block: true,
			reason: `fleet-guard system-temp: writes to ${candidate} are blocked (under ${root}). ${SYSTEM_TEMP_REMEDY}` };
	};
	if (tool === "write" || tool === "edit") {
		for (const candidate of candidatePaths(event.input)) {
			let abs: string | undefined;
			try { abs = resolveFilesystemWriteTarget(cwd, candidate, context); } catch { continue; }
			const block = abs === undefined ? undefined : refuse(candidate, abs);
			if (block) return block;
		}
		return undefined;
	}
	const command = commandFromEvent(event) ?? (typeof event.input === "string" ? event.input : undefined);
	if (tool !== "bash" || !command) return undefined;
	const inspection = executedShellCommands(command);
	// Uninspectable text still has its literal simple commands judged; this check never refuses on parse alone.
	const segments: ShellWord[][] = [[]];
	if ("refusal" in inspection)
		for (const token of shellTokens(command)) {
			if (!token.quoted && ";&|()".includes(token.text) && token.text.length === 1) segments.push([]);
			else segments.at(-1)!.push({ text: token.text, expanded: false });
		}
	const argvs = "refusal" in inspection ? segments.filter(argv => argv.length > 0) : inspection.commands.map(({ argv }) => argv);
	const allocations = argvs.flatMap(argv => mktempWriteTargets(argv));
	const writes = shellWriteBases(command, cwd, homeDir());
	for (const { target, base } of writes) {
		const block = refuse(target, resolveCandidate(base, target));
		if (block) return block;
	}
	// F4: an expanded word naming a /tmp path in a write position is unresolvable by
	// construction; block it here, the same rule the rewrite applies before refusing.
	const expanded = expandedTmpWriteText(command, new Set(writes.map(({ target }) => target)));
	if (expanded !== undefined) return { block: true, reason: `fleet-guard system-temp: writes to ${expanded.text} are blocked (under ${expanded.root}). ${SYSTEM_TEMP_REMEDY}` };
	for (const target of allocations) {
		const block = refuse(target, resolveCandidate(cwd, target));
		if (block) return block;
	}
	return undefined;
}

export function check(event: FleetGuardEvent, context: FleetGuardContext): FleetGuardBlock | undefined {
	return checkWritePaths(event, context) ?? checkBashTargets(event, context) ?? checkShellCommands(event, context);
}

export default check;
