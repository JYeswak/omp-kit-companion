/**
 * kit-save-guard: stop-hook save guard for files changed by this session.
 *
 * Only successful local write/edit/ast_edit result paths are attributed. At
 * turn end it blocks at most twice with the owned paths and save steps, then
 * emits one warning line. `session_shutdown` remains a non-blocking backstop.
 * The guard never commits, stashes, or pushes; every git command is read-only
 * and bounded.
 */
import * as path from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { trackerRequests, type TrackerRequest } from "./kit-flywheel-guard";

export interface SaveGuardExecResult {
	stdout: string;
	code: number;
}

export interface SaveGuardExecOptions {
	cwd?: string;
	timeout?: number;
}

export interface SaveGuardContext {
	cwd: string;
	sessionManager: { getSessionId(): string };
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}


export interface SaveGuardSessionStartEvent {
	type: "session_start";
}

export interface SaveGuardToolCallEvent {
	type?: "tool_call";
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface SaveGuardToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError: boolean;
}

export interface SaveGuardSessionStopEvent {
	type: "session_stop";
	session_id: string;
	stop_hook_active: boolean;
}

export interface SaveGuardSessionStopResult {
	decision: "block";
	reason: string;
}

/** The slice of omp's ExtensionAPI this guard touches. */
export interface SaveGuardApi {
	on(event: "session_start",
		handler: (event: SaveGuardSessionStartEvent, ctx: SaveGuardContext) => unknown): void;
	on(event: "tool_call",
		handler: (event: SaveGuardToolCallEvent, ctx: SaveGuardContext) => unknown): void;

	on(event: "tool_execution_end",
		handler: (event: SaveGuardToolExecutionEndEvent, ctx: SaveGuardContext) => unknown): void;
	on(event: "session_stop",
		handler: (event: SaveGuardSessionStopEvent, ctx: SaveGuardContext) =>
			SaveGuardSessionStopResult | void | Promise<SaveGuardSessionStopResult | void>): void;
	on(event: "session_shutdown",
		handler: (event: { type: "session_shutdown" }, ctx: SaveGuardContext) => unknown): void;
	exec(command: string, args: string[], options?: SaveGuardExecOptions): Promise<SaveGuardExecResult>;
}

/** Per-command ceiling; shutdown itself has a separate 2 s OMP handler budget. */
export const SAVE_GUARD_GIT_TIMEOUT_MS = 1000;

const MAX_REPROMPTS_PER_TURN = 2;

interface PatchDelta {
	added: string[];
	removed: string[];
	known: boolean;
}
interface NativeBead {
	id: string;
	actor: string;
	db: string;
	cwd: string;
}

interface FileSnapshot {
	known: boolean;
	contents: string | null;
	digest?: string;
	bead?: NativeBead;
}

interface SessionFileContents {
	baseline: string | null;
	current: string | null;
	known: boolean;
	digest?: string;
	bead?: NativeBead;
	beadConflict?: boolean;
}

interface OwnedRepository {
	root: string;
	paths: Set<string>;
	baselineHead: string | null;
	baselineDirtyPaths: Set<string>;
	baselineStatusKnown: boolean;
	sessionDeltas: Map<string, PatchDelta>;
	sessionFileContents: Map<string, SessionFileContents>;
}

interface SessionState {
	repositories: Map<string, OwnedRepository>;
	rootByDirectory: Map<string, string>;
	pendingToolPathWork: Promise<void>;
	pendingToolPathSnapshots: Map<string, Map<string, FileSnapshot>>;
	rePrompts: number;
	warningEmitted: boolean;
	lastOmissions: string;
	activeBead?: NativeBead;
	pendingClaims: Map<string, TrackerRequest[]>;
}

interface ToolPathChange {
	path: string;
}


export interface SaveGuardFinding {
	root: string;
	paths: string[];
	aheadCount: number | null;
	sharedPaths?: string[];
	retiredPaths?: string[];
	omittedPaths?: { path: string; reason: string }[];
	beadPaths?: { bead: string; paths: string[] }[];
	untrackedPaths?: string[];
	publication?: string;
}

function addLocalPath(paths: ToolPathChange[], value: unknown): void {
	if (typeof value === "string" && value.length > 0 && !value.includes("://")) paths.push({ path: value });
}

function pathsFromToolEvent(event: SaveGuardToolExecutionEndEvent, cwd: string): ToolPathChange[] {
	const result = event.result;
	if (typeof result !== "object" || result === null || !("details" in result)) return [];
	const details = result.details;
	if (typeof details !== "object" || details === null) return [];

	const paths: ToolPathChange[] = [];
	if (event.toolName === "write") {
		if (!event.isError && "resolvedPath" in details) addLocalPath(paths, details.resolvedPath);
		return paths;
	}
	if (event.toolName === "edit") {
		if ("perFileResults" in details && Array.isArray(details.perFileResults)) {
			for (const fileResult of details.perFileResults) {
				if (typeof fileResult !== "object" || fileResult === null) continue;
				if ("isError" in fileResult && fileResult.isError === true) continue;
				if ("path" in fileResult) addLocalPath(paths, fileResult.path);
				if ("sourcePath" in fileResult) addLocalPath(paths, fileResult.sourcePath);
				if ("move" in fileResult) addLocalPath(paths, fileResult.move);
			}
			return paths;
		}
		if (!event.isError) {
			if ("path" in details) addLocalPath(paths, details.path);
			if ("sourcePath" in details) addLocalPath(paths, details.sourcePath);
			if ("move" in details) addLocalPath(paths, details.move);
		}
		return paths;
	}
	if (event.toolName === "ast_edit" && !event.isError && "applied" in details &&
		details.applied === true && "fileReplacements" in details &&
		Array.isArray(details.fileReplacements)) {
		const base = "cwd" in details && typeof details.cwd === "string" ? details.cwd : cwd;
		for (const replacement of details.fileReplacements) {
			if (typeof replacement !== "object" || replacement === null || !("path" in replacement) ||
				typeof replacement.path !== "string" || replacement.path.includes("://")) continue;
			paths.push({
				path: path.isAbsolute(replacement.path)
					? path.resolve(replacement.path)
					: path.resolve(base, replacement.path),
			});
		}
	}
	return paths;
}

const INPUT_PATH_KEYS: Readonly<Record<string, true>> = {
	path: true,
	filePath: true,
	file_path: true,
	sourcePath: true,
	source_path: true,
	move: true,
};

function inputPaths(value: unknown, output: string[] = [], depth = 0): string[] {
	if (output.length >= 16 || depth > 4) return output;
	if (Array.isArray(value)) {
		let count = 0;
		for (const item of value) {
			if (output.length >= 16 || count >= 16) break;
			count += 1;
			inputPaths(item, output, depth + 1);
		}
	} else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		let count = 0;
		for (const key in record) {
			if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
			if (output.length >= 16 || count >= 16) break;
			count += 1;
			const item = record[key];
			if (Object.prototype.hasOwnProperty.call(INPUT_PATH_KEYS, key)) {
				if (typeof item === "string" && item.length > 0 && !item.includes("://")) output.push(item);
			} else if (typeof item === "object" && item !== null) {
				inputPaths(item, output, depth + 1);
			}
		}
	}
	return output;
}

function pathsFromToolCall(event: SaveGuardToolCallEvent, cwd: string): Map<string, FileSnapshot> {
	if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "ast_edit") {
		return new Map();
	}
	const inputCwd = typeof event.input === "object" && event.input !== null &&
		"cwd" in event.input && typeof event.input.cwd === "string"
		? path.resolve(cwd, event.input.cwd)
		: cwd;
	const snapshots = new Map<string, FileSnapshot>();
	for (const value of inputPaths(event.input)) {
		const absolutePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(inputCwd, value);
		snapshots.set(absolutePath, snapshotFile(absolutePath));
	}
	return snapshots;
}


function isAgentTempPath(relativePath: string): boolean {
	const parts = relativePath.split("/");
	for (let index = 0; index + 1 < parts.length; index += 1) {
		if (parts[index] === "var" && parts[index + 1] === "agent-tmp") return true;
	}
	return false;
}

function gitLine(stdout: string): string {
	let line = stdout;
	if (line.endsWith("\n")) line = line.slice(0, -1);
	if (line.endsWith("\r")) line = line.slice(0, -1);
	return line;
}

async function runGit(
	exec: SaveGuardApi["exec"],
	cwd: string,
	args: string[],
): Promise<SaveGuardExecResult> {
	return exec("git", args, { cwd, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
}

function parsePatch(diff: string): PatchDelta {
	const added: string[] = [];
	const removed: string[] = [];
	for (let line of diff.split("\n")) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added.push(line.slice(1));
		else if (line.startsWith("-")) removed.push(line.slice(1));
	}
	return { added, removed, known: added.length + removed.length > 0 };
}

function snapshotFile(filePath: string): FileSnapshot {
	try {
		const stat = lstatSync(filePath);
		if (stat.isSymbolicLink()) {
			const contents = readlinkSync(filePath);
			return { known: true, contents, digest: `link:${contents}` };
		}
		if (!stat.isFile()) return { known: false, contents: null };
		const bytes = readFileSync(filePath);
		return { known: true, contents: bytes.toString("utf8"), digest: createHash("sha256").update(bytes).digest("hex") };
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return { known: true, contents: null };
		}
		return { known: false, contents: null };
	}
}

function contentLines(contents: string | null): string[] {
	if (contents === null || contents.length === 0) return [];
	const lines = contents.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function diffContents(before: string | null, after: string | null): PatchDelta {
	const remaining = new Map<string, number>();
	for (const line of contentLines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
	const added: string[] = [];
	for (const line of contentLines(after)) {
		const count = remaining.get(line) ?? 0;
		if (count === 0) added.push(line);
		else if (count === 1) remaining.delete(line);
		else remaining.set(line, count - 1);
	}
	const removed: string[] = [];
	for (const [line, count] of remaining) {
		for (let index = 0; index < count; index += 1) removed.push(line);
	}
	return { added, removed, known: added.length + removed.length > 0 };
}

function recordSessionDelta(
	repository: OwnedRepository,
	repoPath: string,
	before: FileSnapshot | undefined,
	after: FileSnapshot,
): void {
	if (!before?.known || !after.known) {
		const existing = repository.sessionFileContents.get(repoPath);
		if (existing) existing.known = false;
		else repository.sessionFileContents.set(repoPath, { baseline: null, current: null, known: false });
		repository.sessionDeltas.set(repoPath, { added: [], removed: [], known: false });
		return;
	}
	let contents = repository.sessionFileContents.get(repoPath);
	if (!contents) {
		contents = { baseline: before.contents, current: after.contents, digest: after.digest, known: true, bead: before.bead };
		repository.sessionFileContents.set(repoPath, contents);
	} else {
		if (!contents.known || contents.current !== before.contents || contents.digest !== before.digest) {
			contents.known = false;
			repository.sessionDeltas.set(repoPath, { added: [], removed: [], known: false });
			return;
		}
		contents.current = after.contents;
		contents.digest = after.digest;
		if (contents.bead?.id !== before.bead?.id || contents.bead?.db !== before.bead?.db ||
			contents.bead?.actor !== before.bead?.actor) contents.beadConflict = true;
	}
	repository.sessionDeltas.set(repoPath, diffContents(contents.baseline, contents.current));
}

function newOwnedRepository(
	root: string,
	baselineHead: string | null,
	baselineDirtyPaths = new Set<string>(),
	baselineStatusKnown = false,
): OwnedRepository {
	return {
		root,
		paths: new Set(),
		baselineHead,
		baselineDirtyPaths,
		baselineStatusKnown,
		sessionDeltas: new Map(),
		sessionFileContents: new Map(),
	};
}

function sessionStateFor(states: Map<string, SessionState>, sessionId: string): SessionState {
	let state = states.get(sessionId);
	if (!state) {
		state = {
			repositories: new Map(),
			rootByDirectory: new Map(),
			pendingToolPathWork: Promise.resolve(),
			pendingToolPathSnapshots: new Map(),
			rePrompts: 0,
			warningEmitted: false,
			lastOmissions: "",
			pendingClaims: new Map(),
		};
		states.set(sessionId, state);
	}
	return state;
}


async function waitForToolPathWork(state: SessionState): Promise<void> {
	while (true) {
		const pending = state.pendingToolPathWork;
		await pending;
		if (pending === state.pendingToolPathWork) return;
	}
}

function isWithinDirectory(directory: string, target: string): boolean {
	const relative = path.relative(directory, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
		!relative.startsWith(`..${path.sep}`));
}

async function recordSessionStart(
	exec: SaveGuardApi["exec"],
	state: SessionState,
	cwd: string,
): Promise<void> {
	const directory = path.resolve(cwd);
	const top = await runGit(exec, directory, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) return;
	const root = path.resolve(gitLine(top.stdout));
	if (root.length === 0) return;
	state.rootByDirectory.set(directory, root);
	if (state.repositories.has(root)) return;
	const head = await runGit(exec, root, ["rev-parse", "--verify", "HEAD"]);
	const status = await runGit(exec, root, [
		"--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all",
	]);
	const statusKnown = status.code === 0;
	state.repositories.set(root, newOwnedRepository(
		root,
		head.code === 0 ? gitLine(head.stdout) : null,
		statusKnown ? new Set(statusEntries(status.stdout).keys()) : new Set(),
		statusKnown,
	));
}

async function recordToolPaths(
	exec: SaveGuardApi["exec"],
	state: SessionState,
	cwd: string,
	toolPaths: ToolPathChange[],
	snapshots: Map<string, FileSnapshot> | undefined,
	completedSnapshots: Map<string, FileSnapshot>,
): Promise<void> {
	for (const change of toolPaths) {
		const absolutePath = path.isAbsolute(change.path) ? path.resolve(change.path) : path.resolve(cwd, change.path);
		const lookupDirectory = isWithinDirectory(cwd, absolutePath) ? cwd : path.dirname(absolutePath);
		let root = state.rootByDirectory.get(lookupDirectory);
		if (root === undefined) {
			const top = await runGit(exec, lookupDirectory, ["rev-parse", "--show-toplevel"]);
			if (top.code !== 0) continue;
			const discoveredRoot: string = String(path.resolve(gitLine(top.stdout)));
			if (discoveredRoot.length === 0) continue;
			root = discoveredRoot;
			state.rootByDirectory.set(lookupDirectory, discoveredRoot);
		}

		if (root === undefined) continue;

		const relative = path.relative(root, absolutePath);
		if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." ||
			relative.startsWith(`..${path.sep}`)) continue;
		const repoPath = relative.split(path.sep).join("/");
		if (isAgentTempPath(repoPath)) continue;

		let repository = state.repositories.get(root);
		if (!repository) {
			const head = await runGit(exec, root, ["rev-parse", "--verify", "HEAD"]);
			repository = newOwnedRepository(
				root,
				head.code === 0 ? gitLine(head.stdout) : null,
				new Set(),
				false,
			);
			state.repositories.set(root, repository);
		}
		const before = snapshots?.get(absolutePath);
		const after = completedSnapshots.get(absolutePath) ?? { known: false, contents: null };
		// A successful tool result is not evidence of a write without a before/after byte change.
		if (before?.known && after.known && before.contents === after.contents && before.digest === after.digest) continue;
		repository.paths.add(repoPath);
		recordSessionDelta(repository, repoPath, before, after);
	}
}

function statusEntries(stdout: string): Map<string, string> {
	const entries = stdout.split("\0");
	const statuses = new Map<string, string>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		statuses.set(entry.slice(3), status);
		if (status.includes("R") || status.includes("C")) {
			const sourcePath = entries[index + 1];
			if (sourcePath) statuses.set(sourcePath, status);
			index += 1;
		}
	}
	return statuses;
}


function sameLines(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = left.slice().sort();
	const sortedRight = right.slice().sort();
	return sortedLeft.every((line, index) => line === sortedRight[index]);
}

function samePatch(left: PatchDelta, right: PatchDelta): boolean {
	return left.known && right.known &&
		sameLines(left.added, right.added) && sameLines(left.removed, right.removed);
}

function containsPatch(candidate: PatchDelta, expected: PatchDelta): boolean {
	if (!candidate.known || !expected.known) return false;
	const candidateAdded = candidate.added.slice();
	const candidateRemoved = candidate.removed.slice();
	for (const line of expected.added) {
		const index = candidateAdded.indexOf(line);
		if (index < 0) return false;
		candidateAdded.splice(index, 1);
	}
	for (const line of expected.removed) {
		const index = candidateRemoved.indexOf(line);
		if (index < 0) return false;
		candidateRemoved.splice(index, 1);
	}
	return true;
}


async function diffFromBaseline(
	exec: SaveGuardApi["exec"],
	repository: OwnedRepository,
	repoPath: string,
): Promise<PatchDelta | null> {
	if (!repository.baselineHead) return null;
	const diff = await runGit(exec, repository.root, [
		"--literal-pathspecs", "diff", "--no-ext-diff", "--unified=0",
		repository.baselineHead, "--", repoPath,
	]);
	return diff.code === 0 ? parsePatch(diff.stdout) : null;
}

/** Blob id of the path's current working-tree content; null when the path is absent, undefined when unreadable. */
async function workingBlob(
	exec: SaveGuardApi["exec"],
	root: string,
	repoPath: string,
): Promise<string | null | undefined> {
	try {
		lstatSync(path.join(root, repoPath));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		return undefined;
	}
	const local = await runGit(exec, root, ["--literal-pathspecs", "hash-object", "--", repoPath]);
	return local.code === 0 ? gitLine(local.stdout) : undefined;
}

/** True when `revision` holds exactly the current content of `repoPath` (both absent counts as equal). */
async function revisionHoldsContent(
	exec: SaveGuardApi["exec"],
	root: string,
	revision: string,
	repoPath: string,
	current: string | null | undefined,
): Promise<boolean> {
	if (revision.length === 0 || current === undefined) return false;
	const blob = await runGit(exec, root, ["rev-parse", "--verify", "--quiet", `${revision}:${repoPath}`]);
	if (blob.code !== 0) return current === null;
	return current !== null && gitLine(blob.stdout) === current;
}

/**
 * True when the published diff `baselineHead..upstreamHead -- <path>` already carries this session's patch
 * and the path still holds exactly what this session's last edit left; any later write is unattributed.
 */
async function upstreamHoldsSessionDelta(
	exec: SaveGuardApi["exec"],
	repository: OwnedRepository,
	upstreamHead: string,
	repoPath: string,
): Promise<boolean> {
	const expected = repository.sessionDeltas.get(repoPath);
	if (!expected?.known || !repository.baselineHead || upstreamHead.length === 0) return false;
	const contents = repository.sessionFileContents.get(repoPath);
	const now = snapshotFile(path.join(repository.root, repoPath));
	if (!contents?.known || !now.known || now.contents !== contents.current || now.digest !== contents.digest) return false;
	const diff = await runGit(exec, repository.root, [
		"--literal-pathspecs", "diff", "--no-ext-diff", "--unified=0",
		repository.baselineHead, upstreamHead, "--", repoPath,
	]);
	return diff.code === 0 && containsPatch(parsePatch(diff.stdout), expected);
}

/**
 * The published branch: the configured upstream, else origin/HEAD, else origin/<current branch>.
 * A shared checkout often has no upstream configured while its work lands on origin directly.
 */
async function upstreamRevision(exec: SaveGuardApi["exec"], root: string): Promise<string> {
	const candidates = ["@{u}", "refs/remotes/origin/HEAD"];
	const branch = await runGit(exec, root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (branch.code === 0 && gitLine(branch.stdout).length > 0) {
		candidates.push(`refs/remotes/origin/${gitLine(branch.stdout)}`);
	}
	for (const candidate of candidates) {
		const resolved = await runGit(exec, root, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`]);
		if (resolved.code === 0 && gitLine(resolved.stdout).length > 0) return gitLine(resolved.stdout);
	}
	return "";
}
/** An absent upstream path is retired only if upstream history actually deleted it. */
async function retiredUpstream(
	exec: SaveGuardApi["exec"],
	repository: OwnedRepository,
	upstreamHead: string,
	repoPath: string,
): Promise<boolean> {
	if (!upstreamHead) return false;
	const tree = await runGit(exec, repository.root, ["--literal-pathspecs", "ls-tree", "-z", upstreamHead, "--", repoPath]);
	if (tree.code !== 0 || tree.stdout.length > 0) return false;
	const deletion = await runGit(exec, repository.root, [
		"--literal-pathspecs", "log", "-1", "--format=%H", "--diff-filter=D",
		upstreamHead, "--", repoPath,
	]);
	return deletion.code === 0 && gitLine(deletion.stdout).length > 0;
}

function nativeTrackerDb(cwd: string, explicit?: string): string | undefined {
	const localDb = path.join(cwd, ".beads", "beads.db");
	let db = explicit;
	if (!db) {
		try { if (lstatSync(localDb).isFile()) db = localDb; } catch { /* use native BEADS_DB below */ }
		db ??= process.env.BEADS_DB;
	}
	return db ? path.resolve(cwd, db) : undefined;
}

function nativeClaim(request: TrackerRequest): NativeBead | undefined {
	const actor = request.actor ?? process.env.BR_ACTOR;
	if (path.basename(request.bin) !== "br" || request.operation !== "claim" || request.ids.length !== 1 ||
		!actor?.trim() || request.force || request.assignee !== null) return;
	const db = nativeTrackerDb(request.cwd, request.db);
	if (!db) return;
	return { id: request.ids[0]!, actor: actor.trim(), db, cwd: request.cwd };
}

async function beadProblem(exec: SaveGuardApi["exec"], bead: NativeBead): Promise<string | undefined> {
	try {
		const result = await exec("br", ["--db", bead.db, "--no-auto-import", "--no-auto-flush",
			"--lock-timeout", "100", "show", bead.id, "--json"], { cwd: bead.cwd, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
		if (result.code !== 0 || result.stdout.length > 1024 * 1024) return `native bead ${bead.id} could not be read`;
		const parsed: unknown = JSON.parse(result.stdout);
		const row: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
		if (typeof row !== "object" || row === null || !("id" in row) || row.id !== bead.id ||
			!("status" in row) || typeof row.status !== "string" || !("assignee" in row)) return `native bead ${bead.id} response is incomplete`;
		if (row.assignee !== bead.actor) return `native bead ${bead.id} is no longer assigned to ${bead.actor}`;
		if (row.status !== "open" && row.status !== "in_progress" && row.status !== "blocked") return `native bead ${bead.id} is ${row.status}, not open`;
	} catch { return `native bead ${bead.id} lookup is unavailable`; }
}

/** A resumed session may bind only the native actor's single active bead, never a guessed last-touched issue. */
async function restoreNativeBead(exec: SaveGuardApi["exec"], cwd: string): Promise<NativeBead | undefined> {
	const actor = process.env.BR_ACTOR?.trim();
	const db = nativeTrackerDb(cwd);
	if (!actor || !db) return;
	try {
		const result = await exec("br", ["--db", db, "--no-auto-import", "--no-auto-flush", "--lock-timeout", "100",
			"list", "--status", "in_progress", "--assignee", actor, "--limit", "2", "--json"],
			{ cwd, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
		if (result.code !== 0 || result.stdout.length > 1024 * 1024) return;
		const parsed: unknown = JSON.parse(result.stdout);
		let rows: unknown;
		// Older native builds return an array; current br returns an explicitly bounded page.
		if (Array.isArray(parsed)) rows = parsed;
		else if (typeof parsed === "object" && parsed !== null && "issues" in parsed && Array.isArray(parsed.issues) &&
			"has_more" in parsed && parsed.has_more === false && "offset" in parsed && parsed.offset === 0 &&
			(!("total" in parsed) || parsed.total === parsed.issues.length)) rows = parsed.issues;
		else return;
		if (!Array.isArray(rows) || rows.length !== 1) return;
		const row: unknown = rows[0];
		if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string") return;
		const bead = { id: row.id, actor, db, cwd };
		if (!await beadProblem(exec, bead)) return bead;
	} catch { /* ambiguous or unreadable native state is not an ownership claim */ }
}

/** Read the same current, server-matching native reservation view used by land. */
async function foreignReservations(exec: SaveGuardApi["exec"], root: string, actor?: string): Promise<Map<string, string>> {
	const foreign = new Map<string, string>();
	try {
		const result = await exec("am", ["robot", "reservations", "--all", "--project", root, "--json"],
			{ cwd: root, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
		if (result.code !== 0) return foreign;
		const parsed: unknown = JSON.parse(result.stdout);
		if (typeof parsed !== "object" || parsed === null || !("reservation_read_attestation" in parsed) ||
			!("all_active" in parsed) || !Array.isArray(parsed.all_active)) return foreign;
		const attestation = parsed.reservation_read_attestation;
		if (typeof attestation !== "object" || attestation === null ||
			!("state" in attestation) || attestation.state !== "current" ||
			!("database_matches_server" in attestation) || attestation.database_matches_server !== true ||
			!("storage_root_matches_server" in attestation) || attestation.storage_root_matches_server !== true) return foreign;
		for (const row of parsed.all_active) {
			if (typeof row !== "object" || row === null || !("exclusive" in row) || row.exclusive !== true ||
				!("remaining_seconds" in row) || typeof row.remaining_seconds !== "number" || row.remaining_seconds <= 0 ||
				!("agent" in row) || typeof row.agent !== "string" || !("path" in row) ||
				typeof row.path !== "string" || row.agent === actor) continue;
			if (path.isAbsolute(row.path) || row.path.split("/").includes("..")) continue;
			foreign.set(row.path, row.agent);
		}
	} catch { /* unavailable native authority never becomes publication permission */ }
	return foreign;
}



/** Consult the existing cache-only native CI consumer; a CI row alone never authorizes publication. */
async function publicationStatus(exec: SaveGuardApi["exec"], root: string): Promise<string> {
	const unknown = "CI UNKNOWN; publication evidence unqualified";
	try {
		const remote = await runGit(exec, root, ["remote", "get-url", "origin"]);
		if (remote.code !== 0) return unknown;
		const url = gitLine(remote.stdout);
		let slug: string;
		if (url.startsWith("git@github.com:")) slug = url.slice("git@github.com:".length);
		else {
			const parsedUrl = new URL(url);
			if (parsedUrl.hostname !== "github.com") return unknown;
			slug = parsedUrl.pathname.slice(1);
		}
		if (slug.endsWith(".git")) slug = slug.slice(0, -4);
		if (slug.split("/").length !== 2) return unknown;
		const head = await runGit(exec, root, ["rev-parse", "--verify", "HEAD"]);
		if (head.code !== 0) return unknown;
		const status = await exec("omp-kit", ["ci", "status", "--json"], { cwd: root, timeout: SAVE_GUARD_GIT_TIMEOUT_MS });
		if (status.code !== 0 || status.stdout.length > 1024 * 1024) return unknown;
		const envelope: unknown = JSON.parse(status.stdout);
		if (typeof envelope !== "object" || envelope === null || !("ok" in envelope) || envelope.ok !== true ||
			!("data" in envelope) || typeof envelope.data !== "object" || envelope.data === null ||
			!("repos" in envelope.data) || typeof envelope.data.repos !== "object" || envelope.data.repos === null) return unknown;
		const cache: unknown = (envelope.data.repos as Record<string, unknown>)[slug];
		if (typeof cache !== "object" || cache === null || !("runs" in cache) || !Array.isArray(cache.runs)) return unknown;
		let latest: Record<string, unknown> | undefined;
		for (const value of cache.runs) {
			if (typeof value !== "object" || value === null) continue;
			const row = value as Record<string, unknown>;
			if (row.sha !== gitLine(head.stdout) || typeof row.id !== "number" || !Number.isSafeInteger(row.id)) continue;
			if (!latest || row.id > Number(latest.id)) latest = row;
		}
		if (!latest) return unknown;
		const run = `run ${latest.id}`;
		if (latest.stale !== false || ("stale" in cache && cache.stale === true) ||
			("status" in cache && cache.status === "UNAVAILABLE")) return `CI UNKNOWN/stale ${run}; publication evidence unqualified`;
		if (latest.status === "completed" && latest.conclusion !== "success") return `CI RED ${run}; no push authorized`;
		return `CI ${latest.status === "completed" ? "observed success" : "UNKNOWN/pending"} ${run}; publication evidence unqualified`;
	} catch { return unknown; }
}

export async function checkSaveState(
	exec: SaveGuardApi["exec"],
	repository: OwnedRepository,
): Promise<SaveGuardFinding | null> {
	const actors = new Set(Array.from(repository.sessionFileContents.values()).flatMap(contents => contents.bead ? [contents.bead.actor] : []));
	const actor = actors.size === 1 ? actors.values().next().value : process.env.BR_ACTOR?.trim();
	const reservations = await foreignReservations(exec, repository.root, actor);
	const ownedPaths = Array.from(repository.paths).filter(path => !isAgentTempPath(path)).sort();
	if (ownedPaths.length === 0 && reservations.size === 0) return null;

	const status = await runGit(exec, repository.root, [
		"--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all",
	]);
	if (status.code !== 0) return null;

	const statuses = statusEntries(status.stdout);
	const foreign = new Map<string, string>();
	const relevantPaths = new Set([...statuses.keys(), ...ownedPaths]);
	for (const [pattern, holder] of reservations) {
		for (const repoPath of relevantPaths) {
			if (repoPath === pattern || repoPath.startsWith(`${pattern}/`) || path.matchesGlob(repoPath, pattern)) foreign.set(repoPath, holder);
		}
	}
	const ownedPathSet = new Set(ownedPaths);
	const dirtyPaths = Array.from(statuses.keys()).filter(path => ownedPathSet.has(path)).sort();
	const upstreamHead = await upstreamRevision(exec, repository.root);
	const exclusions: string[] = [];
	if (repository.baselineHead) exclusions.push(repository.baselineHead);
	if (upstreamHead.length > 0) exclusions.push(upstreamHead);
	const aheadArgs = ["--literal-pathspecs", "rev-list", "--count", "HEAD"];
	if (exclusions.length > 0) aheadArgs.push("--not", ...exclusions);
	aheadArgs.push("--", ...ownedPaths);
	const aheadResult = await runGit(exec, repository.root, aheadArgs);
	let aheadCount: number | null = null;
	if (aheadResult.code === 0) {
		const count = Number(gitLine(aheadResult.stdout));
		if (!Number.isSafeInteger(count) || count < 0) return null;
		aheadCount = count;
	}

	const pendingPaths = new Set<string>();
	const sharedPaths = new Set<string>();
	const retiredPaths: string[] = [];
	const omittedPaths: { path: string; reason: string }[] = [];
	const beadPaths = new Map<string, { bead: string; paths: string[] }>();
	const untrackedPaths: string[] = [];
	const beadProblems = new Map<string, string | undefined>();
	// Peer-accounted dirty paths never become save demands, even without local write events.
	for (const [repoPath, holder] of foreign) {
		if (statuses.has(repoPath)) omittedPaths.push({ path: repoPath, reason: `held by ${holder}; no save demand for this session` });
	}
	for (const repoPath of ownedPaths) {
		if (foreign.has(repoPath)) continue;
		const contents = repository.sessionFileContents.get(repoPath);
		const now = snapshotFile(path.join(repository.root, repoPath));
		if (await retiredUpstream(exec, repository, upstreamHead, repoPath)) {
			retiredPaths.push(repoPath);
			continue;
		}
		if (!dirtyPaths.includes(repoPath) && aheadCount === 0) continue;
		if (!contents?.known || !now.known) {
			omittedPaths.push({ path: repoPath, reason: "write attribution unavailable: missing or unreadable before/after bytes" });
			continue;
		}
		if (now.contents !== contents.current || now.digest !== contents.digest) {
			omittedPaths.push({ path: repoPath, reason: "current bytes differ from this session's last write; later writer or unknown custody" });
			continue;
		}
		const current = await workingBlob(exec, repository.root, repoPath);
		if (await revisionHoldsContent(exec, repository.root, upstreamHead, repoPath, current) ||
			await upstreamHoldsSessionDelta(exec, repository, upstreamHead, repoPath)) continue;
		if (!contents.bead || contents.beadConflict) {
			omittedPaths.push({ path: repoPath, reason: contents.beadConflict
				? "writes span native beads; whole-file owner handoff required, never split hunks"
				: "no native open-bead association was observed for this write; route to the owner" });
			continue;
		}
		const beadKey = `${contents.bead.db}\0${contents.bead.id}`;
		if (!beadProblems.has(beadKey)) beadProblems.set(beadKey, await beadProblem(exec, contents.bead));
		const problem = beadProblems.get(beadKey);
		if (problem) {
			omittedPaths.push({ path: repoPath, reason: problem });
			continue;
		}
		const actual = await diffFromBaseline(exec, repository, repoPath);
		const expected = repository.sessionDeltas.get(repoPath);
		const dirty = dirtyPaths.includes(repoPath);
		// A repository-wide ahead count cannot attribute a peer's commit to every old path.
		if (!dirty && !(aheadCount !== null && aheadCount > 0 && actual?.known)) continue;
		const untracked = statuses.get(repoPath) === "??" && !repository.baselineDirtyPaths.has(repoPath);
		const mixed = repository.baselineDirtyPaths.has(repoPath) ||
			(!repository.baselineStatusKnown && !untracked) ||
			(!untracked && (!actual || !expected?.known || !samePatch(actual, expected)));
		pendingPaths.add(repoPath);
		if (!mixed) {
			let group = beadPaths.get(beadKey);
			if (!group) {
				group = { bead: contents.bead.id, paths: [] };
				beadPaths.set(beadKey, group);
			}
			group.paths.push(repoPath);
			if (untracked) untrackedPaths.push(repoPath);
		}
		if (mixed) sharedPaths.add(repoPath);
	}
	if (pendingPaths.size === 0 && retiredPaths.length === 0 && omittedPaths.length === 0) return null;
	return {
		root: repository.root,
		paths: Array.from(pendingPaths).sort(),
		aheadCount,
		sharedPaths: Array.from(sharedPaths).sort(),
		retiredPaths,
		omittedPaths,
		beadPaths: Array.from(beadPaths.values()),
		untrackedPaths,
		publication: pendingPaths.size > 0 ? await publicationStatus(exec, repository.root) : undefined,
	};
}

function shellQuote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

function formatFinding(finding: SaveGuardFinding): string {
	const paths = finding.paths.map(path => JSON.stringify(path)).join(", ");
	const ahead = finding.aheadCount === null ? "unknown" : String(finding.aheadCount);
	const sharedPaths = finding.sharedPaths ?? [];
	const saveMode = sharedPaths.length > 0
		? ` shared-with-peers=[${sharedPaths.map(path => JSON.stringify(path)).join(", ")}]`
		: "";
	const retired = (finding.retiredPaths ?? []).map(path => `${JSON.stringify(path)}: retired upstream: archive (refs/preserve) or drop; never commit`).join(", ");
	const omitted = (finding.omittedPaths ?? []).map(item => `${JSON.stringify(item.path)}: ${item.reason}`).join(", ");
	return `repo ${JSON.stringify(finding.root)} paths [${paths}] ahead=${ahead}${saveMode}${retired ? ` retired=[${retired}]` : ""}${omitted ? ` omitted=[${omitted}]` : ""}${finding.publication ? ` ${finding.publication}` : ""}`;
}

function formatSavePrompt(findings: SaveGuardFinding[]): string {
	const details = findings.map(formatFinding).join("; ");
	const steps: string[] = [];
	for (const finding of findings) {
		const sharedPaths = new Set(finding.sharedPaths ?? []);
		const untrackedPaths = new Set(finding.untrackedPaths ?? []);
		for (const group of finding.beadPaths ?? []) {
			const paths = group.paths.map(path => JSON.stringify(path)).join(", ");
			const addPaths = group.paths.filter(path => untrackedPaths.has(path));
			const addStep = addPaths.length > 0 ? `git --literal-pathspecs add -- ${addPaths.map(shellQuote).join(" ")}; ` : "";
			steps.push(`repo ${JSON.stringify(finding.root)}, native bead ${JSON.stringify(group.bead)}: confirm native lease custody and a coherent whole-file source/test unit for ${paths}; reserve ${paths}; ${addStep}git --literal-pathspecs commit --only -m "<msg> [level]" -- ${group.paths.map(shellQuote).join(" ")}; release the reservation; keep publication with its qualified owner`);
		}
		if (sharedPaths.size > 0) {
			const paths = Array.from(sharedPaths).map(path => JSON.stringify(path)).join(", ");
			steps.push(`repo ${JSON.stringify(finding.root)}: ${paths} also hold another session's uncommitted hunks: message each path's holder (Agent Mail) to commit the whole file on main or hand it back; never build or push a private-index candidate (one history per repo)`);
		}
	}
	return `Unsaved byte-attributed work remains (${details}). Save before ending: ${steps.join("; ")}. Attribution is not lease, open-bead, or publication authorization. Do not combine beads. Publication qualification is UNKNOWN here: no push is authorized; source/test completeness and qualifying evidence must be checked by the native publication owner.`;
}

function formatWarning(findings: SaveGuardFinding[]): string {
	return `kit-save-guard: turn-end save retry limit reached; ${findings.map(formatFinding).join("; ")}`;
}

export default async function kitSaveGuard(pi: SaveGuardApi): Promise<void> {
	const sessions = new Map<string, SessionState>();
	pi.on("session_start", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId.length === 0) return;
		const state = sessionStateFor(sessions, sessionId);
		state.pendingToolPathWork = state.pendingToolPathWork
			.then(() => recordSessionStart(pi.exec.bind(pi), state, ctx.cwd))
			.then(async () => { state.activeBead ??= await restoreNativeBead(pi.exec.bind(pi), ctx.cwd); })
			.catch(() => undefined);
		await state.pendingToolPathWork;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolCallId.length === 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId.length === 0) return;
		const state = sessionStateFor(sessions, sessionId);
		if (event.toolName === "bash" && typeof event.input === "object" && event.input !== null &&
			"command" in event.input && typeof event.input.command === "string") {
			const cwd = "cwd" in event.input && typeof event.input.cwd === "string" ? path.resolve(ctx.cwd, event.input.cwd) : ctx.cwd;
			state.pendingClaims.set(event.toolCallId, trackerRequests(event.input.command, cwd, process.env.HOME ?? ctx.cwd));
		}
		const snapshots = pathsFromToolCall(event, ctx.cwd);
		if (snapshots.size === 0) return;
		for (const snapshot of snapshots.values()) snapshot.bead = state.activeBead;
		state.pendingToolPathSnapshots.set(event.toolCallId, snapshots);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessionId.length > 0 ? sessions.get(sessionId) : undefined;
		const pathSnapshots = state?.pendingToolPathSnapshots.get(event.toolCallId);
		if (state) state.pendingToolPathSnapshots.delete(event.toolCallId);
		const claims = state?.pendingClaims.get(event.toolCallId);
		state?.pendingClaims.delete(event.toolCallId);
		if (state && claims?.length) state.activeBead = undefined;
		let claimSucceeded = !event.isError;
		const envelope = event.result;
		const details = typeof envelope === "object" && envelope !== null && "details" in envelope ? envelope.details : undefined;
		for (const result of [envelope, details]) {
			if (typeof result !== "object" || result === null) continue;
			if (("exitCode" in result && typeof result.exitCode === "number" && result.exitCode !== 0) ||
				("code" in result && typeof result.code === "number" && result.code !== 0) ||
				("truncated" in result && result.truncated === true) || ("partial" in result && result.partial === true)) claimSucceeded = false;
		}
		if (state && claims && claimSucceeded) {
			for (const request of claims) {
				const bead = nativeClaim(request);
				if (bead && !await beadProblem(pi.exec.bind(pi), bead)) state.activeBead = bead;
			}
		}
		if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "ast_edit") return;
		const paths = pathsFromToolEvent(event, ctx.cwd);
		if (paths.length === 0 || sessionId.length === 0) return;
		const currentState = state ?? sessionStateFor(sessions, sessionId);
		// Freeze the result bytes before asynchronous repository discovery can observe a peer's next write.
		const completedSnapshots = new Map<string, FileSnapshot>();
		for (const change of paths) {
			const absolutePath = path.resolve(ctx.cwd, change.path);
			completedSnapshots.set(absolutePath, snapshotFile(absolutePath));
		}
		currentState.pendingToolPathWork = currentState.pendingToolPathWork
			.then(() => recordToolPaths(pi.exec.bind(pi), currentState, ctx.cwd, paths, pathSnapshots, completedSnapshots))
			.catch(() => undefined);
		await currentState.pendingToolPathWork;
	});

	pi.on("session_stop", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.session_id !== sessionId) return;
		const state = sessions.get(sessionId);
		if (!state) return;
		await waitForToolPathWork(state);
		if (!event.stop_hook_active) {
			state.rePrompts = 0;
			state.warningEmitted = false;
		}

		const findings: SaveGuardFinding[] = [];
		for (const repository of state.repositories.values()) {
			const finding = await checkSaveState(pi.exec.bind(pi), repository);
			if (finding) findings.push(finding);
		}
		if (findings.length === 0) return;
		if (findings.every(finding => finding.paths.length === 0)) {
			const omissions = findings.map(formatFinding).join("; ");
			if (omissions !== state.lastOmissions) {
				state.lastOmissions = omissions;
				ctx.ui.notify(`kit-save-guard: no save demand; ${omissions}`, "info");
			}
			return;
		}
		if (state.rePrompts < MAX_REPROMPTS_PER_TURN) {
			state.rePrompts += 1;
			return { decision: "block", reason: formatSavePrompt(findings) };
		}
		if (!state.warningEmitted) {
			state.warningEmitted = true;
			ctx.ui.notify(formatWarning(findings), "warning");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessions.get(sessionId);
		if (!state) return;
		try {
			await waitForToolPathWork(state);
			if (!state.warningEmitted) {
				const findings: SaveGuardFinding[] = [];
				for (const repository of state.repositories.values()) {
					const finding = await checkSaveState(pi.exec.bind(pi), repository);
					if (finding) findings.push(finding);
				}
				if (findings.length > 0) {
					state.warningEmitted = true;
					ctx.ui.notify(formatWarning(findings), "warning");
				}
			}
		} catch { /* never block shutdown on guard errors */ }
		finally {
			sessions.delete(sessionId);
		}
	});
}
