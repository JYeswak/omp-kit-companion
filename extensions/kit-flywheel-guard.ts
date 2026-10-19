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
 * non-empty content, and a `br show --json` of a bead that is in_progress (or
 * rework) and assigned to a session identity (or a `br list --assignee <a
 * session identity> --json` that returns no issues; a list without
 * `--assignee`, or for another name, never clears it). Call arguments,
 * echoes, failures, wrong paths and foreign/closed beads never clear it.
 * Nothing else in a turn makes it speak.
 *
 * Ownership does not depend on presentation: when a successful
 * `br show <id> --json` result cannot be parsed as shown (OMP cuts long lines
 * to 768 bytes, so a bead with a long description arrives as broken JSON),
 * the guard confirms it with its own bounded `br show <id> --json` in the
 * call's cwd and clears only for an owned bead in an owned status. That
 * confirmation failing, timing out or returning unparseable output keeps the
 * gate blocked. Plain-text `br show` never triggers it and never clears.
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
 * with a warning; failed or unparseable `br show` results refuse the close
 * under SELF_CLOSE_REFUSED (fail-closed self-certification, ompkit-xa5s.13).
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
export const GOAL_END_REFUSED = "GOAL_END_REFUSED";
export const GOAL_SEND_REFUSED = "GOAL_SEND_REFUSED";
export const NO_WAIT_REFUSED = "NO_WAIT_REFUSED";

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

function simpleExecutable(words: string[]): { exe: string; raw: string; rest: string[] } | null {
	let at = 0;
	while (at < words.length && (isAssignment(words[at]!) || WRAPPERS[words[at]!.toLowerCase()] === true)) at += 1;
	const first = words[at];
	if (first === undefined) return null;
	return { exe: first.slice(first.lastIndexOf("/") + 1).toLowerCase(), raw: first, rest: words.slice(at + 1) };
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
	/** Which observation and tracker cleared the bead flag. */
	satisfiedBy?: string;
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


/** A non-zero exit code anywhere in a result envelope: the command itself failed. */
function resultFailed(result: unknown): boolean {
	const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : null;
	for (const source of [field(record, "details"), record]) {
		for (const key of ["code", "exitCode"]) {
			const code = field(source, key);
			if (typeof code === "number" && code !== 0) return true;
		}
	}
	return false;
}

/** Failure/truncation/refusal markers anywhere in a result envelope. */
function resultTainted(result: unknown): boolean {
	if (resultFailed(result)) return true;
	const record = typeof result === "object" && result !== null ? result as Record<string, unknown> : null;
	const details = record !== null && typeof record["details"] === "object" && record["details"] !== null
		? record["details"] as Record<string, unknown> : null;
	for (const source of [details, record]) {
		if (source === null) continue;
		for (const key of ["truncated", "isTruncated", "partial"]) {
			if (source[key] === true) return true;
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

/** One `br|bd` invocation in a bash command, with the directory it runs in (null: a `cd` the guard cannot resolve). */
interface BrInvocation {
	bin: string;
	rest: string[];
	cwd: string | null;
	db?: string;
}

/**
 * `br|bd` invocations in a bash command. Each runs in `cwd` (the tool's
 * effective cwd) as moved by any earlier `cd DIR` in the same command; a
 * `cd` the guard cannot resolve literally (expansions, flags, no argument)
 * leaves later invocations with a null cwd, which never confirms or clears.
 */
function brInvocations(command: string, cwd: string, home: string): BrInvocation[] {
	const found: BrInvocation[] = [];
	let at: string | null = cwd;
	for (const words of shellCommands(command)) {
		if (words[0] === "cd") {
			const dir = words[1];
			at = words.length === 2 && at !== null && dir !== undefined && dir !== "" && !dir.startsWith("-")
				&& !dir.includes("$") && !dir.includes("`") ? resolve(at, expandHome(dir, home)) : null;
			continue;
		}
		const parsed = simpleExecutable(words);
		if (parsed === null || (parsed.exe !== "br" && parsed.exe !== "bd")) continue;
		let db: string | undefined;
		for (let i = 0; i < parsed.rest.length; i += 1) {
			const word = parsed.rest[i]!;
			if (word === "--db") db = parsed.rest[i + 1];
			else if (word.startsWith("--db=")) db = word.slice("--db=".length);
		}
		found.push({ bin: parsed.raw, rest: parsed.rest, cwd: at, ...(db ? { db } : {}) });
	}
	return found;
}

/** A tracker an invocation reaches: its key (the `--db` file or the nearest `.beads` root) and how to read it. */
export interface TrackerRef {
	key: string;
	bin: string;
	cwd: string;
	db?: string;
}

function trackerOf(call: BrInvocation, env: Record<string, string | undefined>): TrackerRef | null {
	if (call.cwd === null) return null;
	const ref = { bin: call.bin, cwd: call.cwd, ...(call.db ? { db: call.db } : {}) };
	if (call.db) return { key: `db:${resolve(call.cwd, call.db)}`, ...ref };
	const explicit = env.BEADS_DB?.trim() || env.BEADS_DIR?.trim();
	if (explicit) return { key: `env:${resolve(call.cwd, explicit)}`, ...ref };
	for (let dir = resolve(call.cwd); ; dir = dirname(dir)) {
		if (rereadPathExists(join(dir, ".beads"))) return { key: `root:${dir}`, ...ref };
		if (dirname(dir) === dir) return null;
	}
}

/** Trackers reached by a command's br invocations (deduplicated by key). */
export function commandTrackers(command: string, cwd: string, home: string, env: Record<string, string | undefined>): TrackerRef[] {
	const refs = new Map<string, TrackerRef>();
	for (const call of brInvocations(command, cwd, home)) {
		const ref = trackerOf(call, env);
		if (ref !== null && !refs.has(ref.key)) refs.set(ref.key, ref);
	}
	return [...refs.values()];
}

/** One `br|bd show <id>`: the invocation and whether it asked for `--json`. */
interface BrShowTarget extends BrInvocation {
	id: string;
	json: boolean;
}

function brShowTargets(calls: BrInvocation[]): BrShowTarget[] {
	const targets: BrShowTarget[] = [];
	for (const call of calls) {
		const rest = call.rest;
		let json = false;
		let id: string | null = null;
		let verb: string | null = null;
		for (let at = 0; at < rest.length; at += 1) {
			const word = rest[at]!;
			if (word === "--json") json = true;
			if (word.startsWith("-") && word !== "-") {
				const name = word.split("=")[0]!;
				if (BR_VALUE_FLAGS[name] === true && !word.includes("=")) at += 1;
				continue;
			}
			if (verb === null) verb = word.toLowerCase();
			else if (id === null && verb === "show" && word !== "-") id = word;
		}
		if (verb === "show" && id !== null) targets.push({ ...call, id, json });
	}
	return targets;
}

/** `--assignee` values of a `br|bd list` invocation; a list without one contributes nothing. */
function listAssignees(call: BrInvocation): string[] {
	if (firstVerb(call.rest, BR_VALUE_FLAGS) !== "list") return [];
	const assignees: string[] = [];
	for (let at = 0; at < call.rest.length; at += 1) {
		const word = call.rest[at]!;
		const value = word === "--assignee" ? call.rest[at + 1] : word.startsWith("--assignee=") ? word.slice("--assignee=".length) : undefined;
		if (value !== undefined && value.trim() !== "") assignees.push(value.trim());
	}
	return assignees;
}

/** Owned (in_progress/rework) bead ids assigned to `name` in one tracker, by the guard's own bounded read; null when the read fails. */
export async function ownedBeadIds(exec: FlywheelExec, tracker: TrackerRef, name: string): Promise<string[] | null> {
	const args = ["list", ...Object.keys(BEAD_OWNED_STATUSES).flatMap(status => ["--status", status]), "--assignee", name,
		"--limit", "0", "--json", "--no-auto-import", "--no-auto-flush", ...(tracker.db ? ["--db", tracker.db] : [])];
	let result: FlywheelExecResult;
	try {
		result = await exec(tracker.bin, args, { cwd: tracker.cwd, timeout: FLYWHEEL_EXEC_TIMEOUT_MS });
	} catch {
		return null;
	}
	if (result.code !== 0 || result.killed) return null;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		const issues = Array.isArray(parsed) ? parsed : field(parsed, "issues");
		if (!Array.isArray(issues)) return null;
		const held: string[] = [];
		for (const row of issues) {
			const status = field(row, "status");
			const assignee = field(row, "assignee");
			const id = field(row, "id");
			if (typeof status === "string" && BEAD_OWNED_STATUSES[status] === true && typeof assignee === "string"
				&& assignee.trim().toLowerCase() === name.trim().toLowerCase()
				&& typeof id === "string" && id !== "") held.push(id);
		}
		return held;
	} catch {
		return null;
	}
}

 /** Owned (in_progress/rework) beads assigned to `name` in one tracker, by the guard's own bounded read; null when the read fails. */
 async function ownedBeadsIn(exec: FlywheelExec, tracker: TrackerRef, name: string, owns: (assignee: string) => boolean): Promise<number | null> {
	const args = ["list", ...Object.keys(BEAD_OWNED_STATUSES).flatMap(status => ["--status", status]), "--assignee", name,
		"--limit", "0", "--json", "--no-auto-import", "--no-auto-flush", ...(tracker.db ? ["--db", tracker.db] : [])];
	let result: FlywheelExecResult;
	try {
		result = await exec(tracker.bin, args, { cwd: tracker.cwd, timeout: FLYWHEEL_EXEC_TIMEOUT_MS });
	} catch {
		return null;
	}
	if (result.code !== 0 || result.killed) return null;
	try {
		const parsed: unknown = JSON.parse(result.stdout);
		const issues = Array.isArray(parsed) ? parsed : field(parsed, "issues");
		if (!Array.isArray(issues)) return null;
		return issues.filter(row => {
			const status = field(row, "status");
			const assignee = field(row, "assignee");
			return typeof status === "string" && BEAD_OWNED_STATUSES[status] === true && typeof assignee === "string" && owns(assignee.trim());
		}).length;
	} catch {
		return null;
	}
}

export interface RereadCall {
	toolName: string;
	input: unknown;
	cwd: string;
}

/**
 * Observe one successful tool result against the pending reread. Only
 * observed results count: call arguments, echoes, failures, wrong paths and
 * foreign/closed beads never set a flag. A successful `br show <id> --json`
 * whose shown text does not parse (display truncation) is confirmed with the
 * guard's own bounded `br show <id> --json`; that read failing keeps the flag
 * unset. An identity-less pending pins the first owned assignee it observes
 * (see the header). Resolves true when both flags land.
 */
export async function observeRereadResult(call: RereadCall, result: unknown, pending: PendingReread, home: string,
	exec: FlywheelExec, sessionTrackers: ReadonlyMap<string, TrackerRef> = new Map(), env: Record<string, string | undefined> = {}): Promise<boolean> {
	const tool = call.toolName.toLowerCase();
	if (tool === "read") {
		if (resultTainted(result)) return false;
		const raw = field(call.input, "path");
		if (typeof raw === "string" && pending.agentsPath !== null
			&& resolve(call.cwd, expandHome(raw.trim(), home)) === pending.agentsPath) {
			const content = stringField(result, READ_CONTENT_KEYS);
			if (content !== null && content.length > 0) pending.agentsOk = true;
		}
	} else if (tool === "bash") {
		const command = field(call.input, "command");
		if (typeof command !== "string" || resultFailed(result)) return pending.agentsOk && pending.beadOk;
		// Presentation-truncated text is never parsed; a --json show is confirmed by the guard's own read instead.
		const stdout = resultTainted(result) ? null : stringField(result, READ_CONTENT_KEYS);
		const owns = (name: string): boolean => {
			if (pending.identities.length === 0) pending.identities = [name];
			return pending.identities.some(identity => identity.toLowerCase() === name.toLowerCase());
		};
		const calls = brInvocations(command, call.cwd, home);
		for (const target of brShowTargets(calls)) {
			if (pending.beadOk) break;
			const shown = stdout === null ? null : parseBeadRow(stdout, target.id);
			if (shown !== null) {
				if (BEAD_OWNED_STATUSES[shown.status] === true && shown.assignee !== null && owns(shown.assignee)) {
					pending.beadOk = true;
					pending.satisfiedBy = `show ${target.id} @ ${trackerOf(target, env)?.key ?? target.cwd ?? "?"}`;
				}
				continue;
			}
			if (!target.json || target.cwd === null) continue;
			const confirmed = await readBeadState(exec, { bin: target.bin, cwd: target.cwd, db: target.db }, target.id);
			if (confirmed.ok && BEAD_OWNED_STATUSES[confirmed.status] === true && confirmed.assignee !== null && owns(confirmed.assignee)) {
				pending.beadOk = true;
				pending.satisfiedBy = `show ${target.id} @ ${trackerOf(target, env)?.key ?? target.cwd}`;
			}
		}
		// One list per command: with several, the shown stdout cannot be attributed to one tracker.
		const lists = pending.beadOk ? [] : calls.filter(item => listAssignees(item).length > 0);
		if (stdout !== null && lists.length === 1) {
			const list = lists[0]!;
			const tracker = trackerOf(list, env);
			let issues: unknown = null;
			try {
				const parsed: unknown = JSON.parse(stdout);
				issues = Array.isArray(parsed) ? parsed : field(parsed, "issues");
			} catch {
				// Non-JSON list output proves nothing; the flag stays unset.
			}
			const name = listAssignees(list).find(owns);
			if (tracker !== null && Array.isArray(issues) && issues.length === 0 && name !== undefined) {
				// An empty list proves nothing about the other trackers this session used: each is read, failing closed.
				let clear = true;
				for (const other of sessionTrackers.values()) {
					if (other.key === tracker.key) continue;
					const held = await ownedBeadsIn(exec, other, name, owns);
					if (held === null || held > 0) {
						clear = false;
						break;
					}
				}
				if (clear) {
					pending.beadOk = true;
					pending.satisfiedBy = `empty list @ ${tracker.key}`;
				}
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
	operation: "close" | "claim" | "start" | "block" | "release" | "review" | "custody";
	/** Labels this command adds or sets (comma-split). */
	addLabels: string[];
	/** Effective command-line BR_ACTOR/--actor selection, not --agent-name attribution. */
	actor: string | null;
	/** `--assignee` value: null when omitted, "" when explicitly cleared. */
	assignee: string | null;
	/** `--if-unchanged` expected revision: null when the write is unguarded. */
	ifUnchanged: string | null;
	/** Requested `--status` value, lowercased; null when no status flag. */
	status: string | null;
	/** Raw argv words after wrapper/inline-env stripping, for the refusal ledger. */
	argv: string[];
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

/** The script string of a `sh -c <script>` (or `-lc`, `-ec`, ...) argv, or undefined. */
function shellScript(argv: string[]): string | undefined {
	const flag = argv.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c$/.test(word));
	return flag > 0 ? argv[flag + 1] : undefined;
}

/** Supported close/claim/start/block/release/review mutations, plus bare custody writes (`update --assignee` without a classified status), with the cwd selected by leading cd commands; `sh -c` strings are followed. */
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
			const script = shellScript(argv);
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
		let ifUnchanged: string | null = null;
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
				if (flag === "--if-unchanged") ifUnchanged = value;
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
						: subcommand === "update" && (nativeStatus === "in_review" || nativeStatus === "inreview") ? "review"
							: subcommand === "update" && nativeStatus === "open" ? "release"
								: subcommand === "update" && assignee !== null ? "custody" : null;
		if (operation === null) continue;
		requests.push({ bin: argv[0]!, ids, cwd: current, db, identities, operation, actor: actor ?? inlineActor, assignee, ifUnchanged, status: nativeStatus ?? null, argv, force, addLabels });
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

export type BeadState = { ok: true; id: string; status: string; assignee: string | null; updatedAt: string | null } | { ok: false; why: string };

export async function readBeadState(exec: FlywheelExec, request: Pick<TrackerRequest, "bin" | "cwd" | "db">, id: string): Promise<BeadState> {
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
		const revised = field(row, "updated_at");
		return { ok: true, id: canonical, status, assignee: owner === "" ? null : owner, updatedAt: typeof revised === "string" ? revised : null };
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

/** Server-side attribution for a refused Bash admission. `job` is the native
tool-call id; `owner` is the session env identity (BR_ACTOR/BR_AGENT_NAME/
AGENT_NAME), never a tool-input claim, so another agent cannot spoof it. */
export interface BashAdmissionAttribution {
	job: string | null;
	owner: string | null;
}

/** Owning-session cancellation route named in every deadline refusal. The
guard itself issues no kill: only the owning OMP session may end its job
through native async-job control (observed asyncState cancelled); a peer
session must never kill or spoof it. */
const ADMISSION_CANCEL_ROUTE =
	"cancel only from the owning OMP session through its native async-job control; the guard performs no kill and no other session may end this job";

function bashAdmissionRefusal(code: string, command: string, detail: string, next: string, attribution: BashAdmissionAttribution, deadline: number | "unknown" | null): FlywheelToolCallResult {
	const executable = shellCommands(command)[0]?.[0]?.split("/").at(-1) ?? "unknown";
	const digest = createHash("sha256").update(command).digest("hex");
	return {
		block: true,
		reason: JSON.stringify({
			guard: "kit-flywheel-guard",
			code,
			job: attribution.job,
			owner: attribution.owner,
			command: { executable, sha256: digest },
			deadline,
			detail,
			next,
			cancel: ADMISSION_CANCEL_ROUTE,
		}),
	};
}

/** Session owner for deadline diagnostics: first present server-side env
identity; tool input never names the owner. */
export function admissionOwner(env: Record<string, string | undefined>): string | null {
	for (const name of IDENTITY_ENV) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return null;
}

/** GOAL_END_REFUSED (J-2026-10-18-44): a fleet seat never ends its own goal. In a session with a fleet identity
(admissionOwner), the goal tool's `drop` and `complete` ops are refused; `create`, `get` and `resume` pass. A chief or
director changes a seat's goal with omp's `/goal set` slash command (arm_seat.py --set), which never reaches the tool
hook, and a person can still type `/goal drop`. Sessions without a fleet identity pass untouched. */
export function checkGoalEnd(event: FlywheelToolCallEvent, owner: string | null): FlywheelToolCallResult | undefined {
	if (owner === null || event.toolName !== "goal") return undefined;
	const op = field(event.input, "op");
	if (op !== "drop" && op !== "complete") return undefined;
	return {
		block: true,
		reason: `kit-flywheel-guard ${GOAL_END_REFUSED}: ${owner} may not ${op} its own goal (J-2026-10-18-44). `
			+ "Only your director or a chief changes your goal, with /goal set. Keep working your goal: if nothing is claimable, "
			+ "take the next downtime item. Nothing was changed.",
	};
}

const SENDERS: Record<string, true> = { tern: true, "omp-kit": true, ntm: true };

/** True when a command types a `/goal` line into any pane: `tern send`, `omp-kit send` or `ntm send` with an argument
that starts with `/goal` (after whitespace), through env assignments, wrappers and nested `sh -c` (depth 3). */
export function sendsGoalLine(command: string, depth = 0): boolean {
	for (const raw of shellCommands(command)) {
		let at = 0;
		while (at < raw.length && (isAssignment(raw[at]!) || WRAPPERS[raw[at]!] === true)) at += 1;
		const argv = raw.slice(at);
		if (argv.length === 0) continue;
		const name = basename(argv[0]!);
		if (SHELL_WRAPPERS[name] === true && depth < MAX_SHELL_DEPTH) {
			const script = shellScript(argv);
			if (script !== undefined && sendsGoalLine(script, depth + 1)) return true;
			continue;
		}
		if (SENDERS[name] !== true || argv[1] !== "send") continue;
		if (argv.slice(2).some(word => word.trimStart().toLowerCase().startsWith("/goal"))) return true;
	}
	return false;
}

/** GOAL_SEND_REFUSED (J-2026-10-18-45): in a fleet seat, a raw `/goal` line typed into any pane is refused, so the
only goal path is arm_seat.py (--set), which sets only a stamped, approved store prompt proven by an exact round trip,
and logs it. Its own `tern send` runs in a child process the hook never sees. Sessions without a fleet identity pass. */
export function checkGoalSend(event: FlywheelToolCallEvent, owner: string | null): FlywheelToolCallResult | undefined {
	if (owner === null || event.toolName !== "bash") return undefined;
	const command = field(event.input, "command");
	if (typeof command !== "string" || !sendsGoalLine(command)) return undefined;
	return {
		block: true,
		reason: `kit-flywheel-guard ${GOAL_SEND_REFUSED}: ${owner} may not type a /goal line into a pane (J-2026-10-18-45). `
			+ "Goals change only through python3 ~/.claude/skills/omp-kit-orchestration/scripts/arm_seat.py --set "
			+ "(stamped prompts only). Nothing was sent.",
	};
}

/** Downtime work named in every timed-wait refusal (J-2026-10-18-43). */
const NO_WAIT_NEXT =
	"Instead take the next downtime item: your held beads, other seats' in_review beads ready for grading, "
	+ "bead DAG repair, /skill:reality-check-for-project, then /skill:profiling-software-performance followed by "
	+ "/skill:extreme-software-optimization. Nothing was executed.";

/** `sleep` duration suffixes in seconds. String parsing only; no regex. */
const SLEEP_UNIT_SECONDS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

/** A `sleep` duration operand in seconds, or null for flags and non-duration words. */
function sleepOperandSeconds(word: string): number | null {
	if (word.length === 0 || word[0] === "-") return null;
	let num = word;
	let unit = "";
	const last = word[word.length - 1]!;
	if ((last >= "a" && last <= "z") || (last >= "A" && last <= "Z")) {
		num = word.slice(0, -1);
		unit = last.toLowerCase();
	}
	if (!(unit in SLEEP_UNIT_SECONDS) || num.length === 0) return null;
	let dots = 0;
	for (const ch of num) {
		if (ch === ".") dots += 1;
		else if (ch < "0" || ch > "9") return null;
	}
	if (dots > 1) return null;
	const value = Number(num);
	if (!Number.isFinite(value)) return null;
	return value * SLEEP_UNIT_SECONDS[unit]!;
}

/** Interpreter basenames whose operand may be an `idle_wait.py` script path (`python3.13` matches by prefix). */
const WAIT_SCRIPT_RUNNERS: Record<string, true> = { python: true, node: true, bun: true, deno: true };

/** Effective argv lists: assignments and wrappers stripped, `sh -c` scripts followed (depth 3). */
function noWaitArgvs(command: string, depth = 0): string[][] {
	const found: string[][] = [];
	for (const raw of shellCommands(command)) {
		let at = 0;
		while (at < raw.length && (isAssignment(raw[at]!) || WRAPPERS[raw[at]!] === true)) at += 1;
		const argv = raw.slice(at);
		if (argv.length === 0) continue;
		const name = basename(argv[0]!);
		if (SHELL_WRAPPERS[name] === true && depth < MAX_SHELL_DEPTH) {
			const script = shellScript(argv);
			if (script !== undefined) found.push(...noWaitArgvs(script, depth + 1));
			continue;
		}
		found.push(argv);
	}
	return found;
}

/** NO_WAIT_REFUSED (J-2026-10-18-43): a fleet seat never idles on a timer. In a session with a fleet identity
(admissionOwner), a bash call that runs idle_wait.py (directly or as an interpreter operand) or `sleep` for
30 s or more in total (bare, chained, wrapped, or in sh -c) is refused. `sleep` under 30 s and sessions
without a fleet identity pass untouched. */
export function checkNoWait(event: FlywheelToolCallEvent, owner: string | null): FlywheelToolCallResult | undefined {
	if (owner === null || event.toolName !== "bash") return undefined;
	if (field(event.input, "async") === true) return undefined;
	const command = field(event.input, "command");
	if (typeof command !== "string" || command.trim().length === 0) return undefined;
	for (const argv of noWaitArgvs(command)) {
		const name = basename(argv[0]!);
		if (name === "idle_wait.py"
			|| ((WAIT_SCRIPT_RUNNERS[name] === true || name.startsWith("python3")) && argv.slice(1).some(word => basename(word) === "idle_wait.py"))) {
			return {
				block: true,
				reason: `kit-flywheel-guard ${NO_WAIT_REFUSED}: ${owner} may not idle-wait in a fleet seat (J-2026-10-18-43): `
					+ "this call runs idle_wait.py. " + NO_WAIT_NEXT,
			};
		}
		if (name === "sleep") {
			let total = 0;
			let seen = false;
			for (const word of argv.slice(1)) {
				const seconds = sleepOperandSeconds(word);
				if (seconds === null) continue;
				seen = true;
				total += seconds;
			}
			if (seen && total >= 30) {
				return {
					block: true,
					reason: `kit-flywheel-guard ${NO_WAIT_REFUSED}: ${owner} may not idle-wait in a fleet seat (J-2026-10-18-43): `
						+ `this call runs \`sleep\` for about ${total} s (>= 30 s). ` + NO_WAIT_NEXT,
				};
			}
		}
	}
	return undefined;
}
export const WAIT_REFUSED = "WAIT_REFUSED";

/** Next action named in every BGWAIT1 refusal (ompkit-fp72.19.1.24): a seat never parks its turn on its own background work. */
const BG_WAIT_NEXT =
	"Take the next item now: your held beads, other seats' in_review beads ready for grading, bead DAG repair, "
	+ "/skill:reality-check-for-project, then /skill:profiling-software-performance followed by "
	+ "/skill:extreme-software-optimization. A pending job result arrives at a later tool boundary; never block your turn on it. Nothing was executed.";

/** Shell loop openers: a `sleep` inside one parks the turn, however short the single sleep. */
const BG_LOOP_OPENERS: Record<string, true> = { for: true, while: true, until: true, do: true };
/** Shell list keywords joining commands without a `;`/`&` separator the splitter sees: `do sleep 5`
arrives as one word list, so the tail is evaluated as a nested command too. */
const BG_KEYWORD_OPENERS: Record<string, true> = { do: true, then: true, else: true };

/** `time.sleep(<seconds>)` durations in a code fragment, parsed without evaluation. */
function timeSleepSeconds(fragment: string): number[] {
	const found: number[] = [];
	const pattern = /time\s*\.\s*sleep\s*\(\s*(\d+(?:\.\d+)?)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(fragment)) !== null) found.push(Number(match[1]));
	return found;
}

/** Whole-word loop keywords in a code fragment (shell loops and `while True:` / `for …:` python loops). */
function hasLoopWord(fragment: string): boolean {
	for (const word of fragment.split(/[^A-Za-z]+/)) {
		if (word === "for" || word === "while" || word === "until") return true;
	}
	return false;
}

function bgWaitRefusal(owner: string, detail: string): FlywheelToolCallResult {
	return {
		block: true,
		reason: `kit-flywheel-guard ${WAIT_REFUSED}: ${owner} may not block its turn on its own background work (BGWAIT1): ${detail} ${BG_WAIT_NEXT}`,
	};
}

/** BGWAIT1 (ompkit-fp72.19.1.24): a fleet seat never blocks its turn on its own background work. In a session
with a fleet identity (admissionOwner), the `wait` tool is refused, as is any blocking poll: a non-async bash
loop (for/while/until) containing `sleep`, `sleep` totalling >= 30 s across the call, and eval/python
`time.sleep` in a loop or totalling >= 20 s. The refusal names the next action. Async bash jobs and short
single sleeps pass untouched, as do sessions without a fleet identity. */
export function checkBgWait(event: FlywheelToolCallEvent, owner: string | null): FlywheelToolCallResult | undefined {
	if (owner === null) return undefined;
	const tool = typeof event.toolName === "string" ? event.toolName.toLowerCase() : "";
	if (tool === "wait") {
		return bgWaitRefusal(owner, "this call uses the `wait` tool.");
	}
	if (tool === "bash") {
		if (field(event.input, "async") === true) return undefined;
		const command = field(event.input, "command");
		if (typeof command !== "string" || command.trim().length === 0) return undefined;
		const argvs = noWaitArgvs(command);
		let sleepTotal = 0;
		let sleepSeen = false;
		let loop = false;
		for (const argv of argvs) {
			if (BG_LOOP_OPENERS[argv[0]!] === true) loop = true;
			const starts = argv.length > 1 && BG_KEYWORD_OPENERS[argv[0]!] === true ? [argv, argv.slice(1)] : [argv];
			for (const words of starts) {
				if (basename(words[0]!) !== "sleep") continue;
				for (const word of words.slice(1)) {
					const seconds = sleepOperandSeconds(word);
					if (seconds === null) continue;
					sleepSeen = true;
					sleepTotal += seconds;
				}
			}
		}
		if (loop && sleepSeen) {
			return bgWaitRefusal(owner, "this call parks the turn in a sleep-poll loop.");
		}
		if (sleepSeen && sleepTotal >= 30) {
			return bgWaitRefusal(owner, `this call runs \`sleep\` for about ${sleepTotal} s in total (>= 30 s).`);
		}
		const naps = timeSleepSeconds(command);
		if (naps.length > 0) {
			const total = naps.reduce((a, b) => a + b, 0);
			const looped = loop || hasLoopWord(command);
			if (looped || total >= 20) {
				return bgWaitRefusal(owner, `this call idles in time.sleep for about ${total} s${looped ? " in a loop" : ""} (>= 20 s or looped).`);
			}
		}
		return undefined;
	}
	if (tool === "eval") {
		const code = field(event.input, "code");
		if (typeof code !== "string") return undefined;
		const naps = timeSleepSeconds(code);
		if (naps.length === 0) return undefined;
		const total = naps.reduce((a, b) => a + b, 0);
		if (hasLoopWord(code) || total >= 20) {
			return bgWaitRefusal(owner, `this eval idles in time.sleep for about ${total} s (>= 20 s or looped).`);
		}
		return undefined;
	}
	return undefined;
}

/** Refuse finite Bash work that explicitly disables the OMP deadline. `owner`
is the server-side session identity; the native tool-call id attributes the
job. Tool input never supplies either, so a peer cannot spoof ownership. */
export function checkBashAdmission(event: FlywheelToolCallEvent, owner: string | null = null): FlywheelToolCallResult | undefined {
	if (event.toolName !== "bash") return undefined;
	const command = field(event.input, "command");
	if (typeof command !== "string" || command.trim().length === 0) return undefined;
	const attribution: BashAdmissionAttribution = {
		job: typeof event.toolCallId === "string" ? event.toolCallId : null,
		owner,
	};
	const name = field(event.input, "name");
	const service = typeof name === "string" && name.trim().length > 0;
	const async = field(event.input, "async") === true;
	const timeout = field(event.input, "timeout");
	const givenDeadline = typeof timeout === "number" ? timeout : timeout === undefined ? null : "unknown" as const;
	if (service) {
		if (async || timeout !== undefined) return bashAdmissionRefusal(
			"SERVICE_MODE_CONFLICT", command, "named services use readiness and lifecycle, not finite async or timeout fields",
			"remove async and timeout, then provide a readiness condition for a long-lived service",
			attribution, givenDeadline,
		);
		if (serviceCommandIsFinite(command)) return bashAdmissionRefusal(
			"FINITE_SUITE_AS_SERVICE", command, "a recognized finite build, test, or validation command cannot use unbounded service mode",
			"run finite work with its native positive deadline; reserve named services for long-lived commands",
			attribution, null,
		);
		if (!hasServiceReadiness(field(event.input, "ready"))) return bashAdmissionRefusal(
			"SERVICE_READINESS_REQUIRED", command, "a named service needs a log or port readiness condition and native lifecycle",
			"provide ready.log or a valid ready.port; finite work must use the finite-command path",
			attribution, null,
		);
		return undefined;
	}
	if (timeout === undefined) return undefined; // OMP 18.11.1 defaults finite Bash commands to 300 seconds.
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return bashAdmissionRefusal(
		"FINITE_JOB_DEADLINE_UNKNOWN", command, "the effective finite-command deadline cannot be determined",
		"pass a positive numeric timeout or omit it to use OMP's bounded default",
		attribution, "unknown",
	);
	if (timeout === 0) return bashAdmissionRefusal(
		"FINITE_JOB_NO_DEADLINE", command, "timeout zero disables the finite-command deadline, including managed background execution",
		"pass a positive timeout in seconds or use named service mode with readiness and lifecycle",
		attribution, 0,
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
	if (request.operation === "claim") {
		const held = await ownedBeadIds(deps.exec, request, actor);
		if (held === null) return refuseClaim({
			class: "tool_read_failure", bead: request.ids[0] ?? null, actor,
			next: `the guard could not list active claims for ${actor}; restore the native lookup before claiming a second bead`,
		});
		const other = held.find(id => !request.ids.some(wanted => wanted.toLowerCase() === id.toLowerCase()));
		if (other !== undefined) return refuseClaim({
			class: "unsafe_custody", bead: request.ids[0] ?? null, actor,
			next: `${actor} already holds active ${other}; release it (br update ${other} --status open --assignee "" --if-unchanged <updated_at>) or land it before claiming another implementation`,
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

const SCRATCH_MINE_TIMEOUT_MS = 20_000;
const MAX_OWED_LISTED = 5;

/**
 * SCRATCHBIN1 flag (ompkit-774u.15): at the caller's `in_review` or `close`, tell it which scratch dirs it still owns
 * unreleased. `omp-kit scratch mine --at <point>` lists only the caller's own dirs (owner agent and held session, or its
 * pid), excludes the live session dir, and logs one flag row for the 7-day false-flag audit. This is advice only: it
 * never blocks, and a missing or failing omp-kit yields no note. Promotion to a refusal needs that audit to be clean.
 */
export async function scratchOwedNote(exec: FlywheelExec, cwd: string, point: "review" | "close"): Promise<string | null> {
	let result: FlywheelExecResult;
	try {
		result = await exec("omp-kit", ["scratch", "mine", "--at", point, "--json"], { cwd, timeout: SCRATCH_MINE_TIMEOUT_MS });
	} catch {
		return null;
	}
	if (result.code !== 0 || result.killed) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return null;
	}
	const dirs = field(field(parsed, "data"), "dirs");
	if (!Array.isArray(dirs)) return null;
	const owed = dirs.filter(row => !(field(row, "label") === "omp" && field(row, "bin") === "throwaway")
		&& (field(row, "state") === "unreleased" || field(row, "state") === "hold-expired") && typeof field(row, "dir") === "string");
	if (owed.length === 0) return null;
	const listed = owed.slice(0, MAX_OWED_LISTED).map(row => `${String(field(row, "dir"))} (${String(field(row, "state"))}, bin ${String(field(row, "bin"))})`);
	const more = owed.length > listed.length ? ` and ${owed.length - listed.length} more` : "";
	return `kit-flywheel-guard SCRATCH_OWED: you still own ${owed.length} scratch dir(s) you have not binned: ${listed.join("; ")}${more}. `
		+ "Release each with `omp-kit scratch release DIR --bin throwaway|evidence|promote [--ref file:PATH|bead:ID]` before you hand the work off. Warning only; nothing was blocked.";
}

export const PARTIAL_RELEASE_REFUSED = "PARTIAL_RELEASE_REFUSED";

function refuseRelease(request: TrackerRequest, detail: string): FlywheelToolCallResult {
	return {
		block: true,
		reason: `kit-flywheel-guard ${PARTIAL_RELEASE_REFUSED}: ${detail} argv \`${request.argv.join(" ")}\`. Nothing was changed.`,
	};
}

/**
 * DRAIN1 (ompkit-kdbz.1.1) atomic parking: releasing a live held claim
 * (in_progress/rework with an assignee) must write OPEN plus a cleared
 * assignee under the seen revision in one call, by the holder. A bare
 * `--status open` that preserves a stale assignee, or omits the revision the
 * writer saw, is refused before mutation so status/assignee cannot split.
 * Repairs of ownerless or already-open beads pass untouched.
 */
async function checkRelease(request: TrackerRequest, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	if (request.ids.length === 0) return refuseRelease(request, "name an explicit bead id; a last-touched release cannot be verified as atomic.");
	const actor = (request.actor ?? deps.env.BR_ACTOR)?.trim() || null;
	for (const id of request.ids) {
		const found = await readBeadState(deps.exec, request, id);
		if (!found.ok) return refuseRelease(request, `cannot verify ${id} before parking: ${found.why}.`);
		const live = (found.status === "in_progress" || found.status === "rework") && found.assignee !== null;
		if (!live) continue;
		const before = `${found.id} is ${found.status}/${found.assignee} at revision ${found.updatedAt ?? "unknown"}`;
		if (actor === null || actor.toLowerCase() !== found.assignee.toLowerCase()) {
			return refuseRelease(request, `${before}: only the holder parks a live claim; a third-party half-park is refused, route the transfer through ${found.assignee}.`);
		}
		if (request.assignee !== "") {
			return refuseRelease(request, `${before}: parking must clear the assignee atomically (--assignee ""); omitting it preserves a stale owner on an open bead.`);
		}
		if (request.ifUnchanged === null) {
			return refuseRelease(request, `${before}: parking must name the seen revision (--if-unchanged ${found.updatedAt ?? "<updated_at>"}); an unguarded write can discard the other writer's revision.`);
		}
	}
	return undefined;
}

/**
 * DRAIN1 follow-up (ompkit-kdbz.1.1 AC2): a bare custody write (`br update
 * <id> --assignee ...` with no classified status) on a live held claim is
 * refused before mutation. Clearing the assignee without parking the status
 * leaves an ownerless in_progress bead -- the genuine BuildNext3
 * ompkit-fp72.95 shape (assignee_changed BuildNext3 -> None, status
 * untouched) -- and reassigning outside claim/park splits custody from the
 * one-active check. Repairs of ownerless or already-open beads pass.
 */
async function checkCustody(request: TrackerRequest, deps: TrackerMutationDeps): Promise<FlywheelToolCallResult | undefined> {
	if (request.ids.length === 0) return refuseRelease(request, "name an explicit bead id; an id-less custody write cannot be verified as atomic.");
	const actor = (request.actor ?? deps.env.BR_ACTOR)?.trim() || null;
	for (const id of request.ids) {
		const found = await readBeadState(deps.exec, request, id);
		if (!found.ok) return refuseRelease(request, `cannot verify ${id} before the custody write: ${found.why}.`);
		const live = (found.status === "in_progress" || found.status === "rework") && found.assignee !== null;
		if (!live) continue;
		const before = `${found.id} is ${found.status}/${found.assignee} at revision ${found.updatedAt ?? "unknown"}`;
		if (actor === null || actor.toLowerCase() !== found.assignee.toLowerCase()) {
			return refuseRelease(request, `${before}: only the holder changes custody of a live claim; a third-party custody write is refused, route the transfer through ${found.assignee}.`);
		}
		if (request.assignee === "") {
			return refuseRelease(request, `${before}: clearing the assignee without parking the status leaves an ownerless ${found.status} bead; park atomically (br update ${found.id} --status open --assignee "" --if-unchanged ${found.updatedAt ?? "<updated_at>"}) instead.`);
		}
		return refuseRelease(request, `${before}: reassigning a live claim outside claim/park splits custody from the one-active check; the holder parks atomically (br update ${found.id} --status open --assignee "" --if-unchanged ${found.updatedAt ?? "<updated_at>"}) and the next worker claims with --claim instead.`);
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
	const released = new Set(requests.filter(request => request.operation === "release").flatMap(request => request.ids));
	for (const request of requests) {
		if (request.operation === "release") {
			const refusal = await checkRelease(request, deps);
			if (refusal !== undefined) return refusal;
			continue;
		}
		if (request.operation === "custody") {
			const refusal = await checkCustody(request, deps);
			if (refusal !== undefined) return refusal;
			continue;
		}
		if (request.operation === "block") {
			const refusal = await checkBlockedHasFix(request, deps);
			if (refusal !== undefined) return refusal;
			continue;
		}
		if (request.operation === "review") continue;
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
				// ompkit-xa5s.13: a probe that errors (garbled args, exit != 0,
				// unparseable output) fails closed as a self-certification
				// failure, never as a skip. LOOKUP_REFUSED stays for the outer
				// lifecycle catch below; the close path refuses invariant 9.
				return {
					block: true,
					reason: `kit-flywheel-guard ${SELF_CLOSE_REFUSED}: cannot verify authorship of ${id}: ${found.why}. `
						+ "No self-certification on an unverified close (Flywheel Kernel invariant 9): resolve the native lookup "
						+ "and let an independent verifier run the close; no close was executed.",
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
	const parts: string[] = [];
	if (warnings.length > 0) parts.push(`kit-flywheel-guard: ${warnings.join("; ")}. The close was allowed; do not close a bead you implemented.`);
	if (requests.some(request => request.operation === "review" || request.operation === "close")) {
		const owed = await scratchOwedNote(deps.exec, deps.sessionCwd, hasClose ? "close" : "review");
		if (owed !== null) parts.push(owed);
	}
	return parts.length === 0 ? undefined : { additionalContext: parts.join(" ") };
}

export default async function kitFlywheelGuard(pi: FlywheelGuardApi, deps: FlywheelGuardDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	let pendingReread: PendingReread | null = null;
	/** Identity pinned by an identity-less session's first owned observation (self-declared; see header). */
	let selfDeclared: string | null = null;
	const pendingCalls = new Map<string, RereadCall>();
	/** Every tracker a successful br call reached this session, by key: an empty list in one never vouches for the others. */
	const sessionTrackers = new Map<string, TrackerRef>();
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
				// The bash tool's own `cwd` input is where the command runs, not the session cwd.
				const toolCwd = event.toolName.toLowerCase() === "bash" ? field(event.input, "cwd") : undefined;
				const cwd = typeof toolCwd === "string" && toolCwd.trim() !== "" ? resolve(ctx.cwd, expandHome(toolCwd.trim(), home)) : ctx.cwd;
				pendingCalls.set(event.toolCallId, { toolName: event.toolName, input: event.input, cwd });
			}
			if (pendingReread !== null && isMutatingCall(event)) {
				const tool = typeof event.toolName === "string" ? event.toolName : "this call";
				return {
					block: true,
					reason: `kit-flywheel-guard ${COMPACTION_REREAD}: ${tool} blocked until ${rereadMissing(pendingReread)} return successful results. Reading is always allowed.`,
				};
			}
			const goalEnd = checkGoalEnd(event, admissionOwner(env)) ?? checkGoalSend(event, admissionOwner(env));
			if (goalEnd !== undefined) return goalEnd;
			const noWait = checkNoWait(event, admissionOwner(env));
			if (noWait !== undefined) return noWait;
			const bgWait = checkBgWait(event, admissionOwner(env));
			if (bgWait !== undefined) return bgWait;
			const admission = checkBashAdmission(event, admissionOwner(env));
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
	pi.on("tool_execution_end", async (_event, ctx) => {
		try {
			if (typeof _event.toolCallId !== "string") return;
			const call = pendingCalls.get(_event.toolCallId);
			if (call === undefined) return;
			pendingCalls.delete(_event.toolCallId);
			if (_event.isError === true || resultFailed(_event.result)) return;
			const command = field(call.input, "command");
			if (call.toolName.toLowerCase() === "bash" && typeof command === "string") {
				for (const ref of commandTrackers(command, call.cwd, home, env)) if (!sessionTrackers.has(ref.key)) sessionTrackers.set(ref.key, ref);
			}
			const pending = pendingReread;
			if (pending === null) return;
			const identityLess = pending.identities.length === 0;
			const done = await observeRereadResult(call, _event.result, pending, home, pi.exec, sessionTrackers, env);
			// A compaction during the guard's own read re-armed a fresh pending; this observation predates it.
			if (pendingReread !== pending) return;
			if (identityLess && pending.identities.length > 0) selfDeclared = pending.identities[0]!;
			if (done && pending.agentsOk && pending.beadOk) pendingReread = null;
		} catch (error) {
			// Fail closed: the flags stay unset, so the gate keeps blocking.
			ctx.ui?.notify(`kit-flywheel-guard ${COMPACTION_REREAD}: reread observation failed (${error instanceof Error ? error.message : String(error)}); still blocked.`, "warning");
		}
	});
}
