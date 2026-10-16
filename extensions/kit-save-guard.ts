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
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

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
interface FileSnapshot {
	known: boolean;
	contents: string | null;
}

interface SessionFileContents {
	baseline: string | null;
	current: string | null;
	known: boolean;
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
}

interface ToolPathChange {
	path: string;
}


export interface SaveGuardFinding {
	root: string;
	paths: string[];
	aheadCount: number | null;
	sharedPaths?: string[];

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
		if (stat.isSymbolicLink()) return { known: true, contents: readlinkSync(filePath) };
		if (!stat.isFile()) return { known: false, contents: null };
		return { known: true, contents: readFileSync(filePath, "utf8") };
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
		contents = { baseline: before.contents, current: after.contents, known: true };
		repository.sessionFileContents.set(repoPath, contents);
	} else {
		if (!contents.known || contents.current !== before.contents) {
			contents.known = false;
			repository.sessionDeltas.set(repoPath, { added: [], removed: [], known: false });
			return;
		}
		contents.current = after.contents;
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
		repository.paths.add(repoPath);
		recordSessionDelta(repository, repoPath, snapshots?.get(absolutePath), snapshotFile(absolutePath));
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
	if (!contents?.known || !now.known || now.contents !== contents.current) return false;
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

export async function checkSaveState(
	exec: SaveGuardApi["exec"],
	repository: OwnedRepository,
): Promise<SaveGuardFinding | null> {
	const ownedPaths = Array.from(repository.paths).filter(path => !isAgentTempPath(path)).sort();
	if (ownedPaths.length === 0) return null;

	const status = await runGit(exec, repository.root, [
		"--literal-pathspecs", "status", "--porcelain=v1", "-z", "--untracked-files=all",
		"--", ...ownedPaths,
	]);
	if (status.code !== 0) return null;

	const statuses = statusEntries(status.stdout);
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
	const savedPaths = new Set<string>();
	for (const repoPath of dirtyPaths) {
		// Published means the current content is byte-identical to the upstream copy, or the upstream
		// already carries this session's patch while the shared worktree still holds a peer's hunks.
		const current = await workingBlob(exec, repository.root, repoPath);
		if (await revisionHoldsContent(exec, repository.root, upstreamHead, repoPath, current)) {
			savedPaths.add(repoPath);
			continue;
		}
		const actual = await diffFromBaseline(exec, repository, repoPath);
		const expected = repository.sessionDeltas.get(repoPath);
		const untracked = statuses.get(repoPath) === "??" && !repository.baselineDirtyPaths.has(repoPath);
		const mixed = repository.baselineDirtyPaths.has(repoPath) ||
			(!repository.baselineStatusKnown && !untracked) ||
			(!untracked && (!actual || !expected?.known || !samePatch(actual, expected)));
		if (await upstreamHoldsSessionDelta(exec, repository, upstreamHead, repoPath)) {
			savedPaths.add(repoPath);
			continue;
		}
		pendingPaths.add(repoPath);
		if (mixed) sharedPaths.add(repoPath);
	}
	if (aheadCount !== null && aheadCount > 0) {
		for (const repoPath of ownedPaths) {
			if (savedPaths.has(repoPath)) continue;
			// Current content already on the upstream (for example a local commit that landed there under
			// a different sha) is published, not unsaved.
			const current = await workingBlob(exec, repository.root, repoPath);
			if (await revisionHoldsContent(exec, repository.root, upstreamHead, repoPath, current)) {
				savedPaths.add(repoPath);
				continue;
			}
			const actual = await diffFromBaseline(exec, repository, repoPath);
			const expected = repository.sessionDeltas.get(repoPath);
			const mixed = repository.baselineDirtyPaths.has(repoPath) ||
				(!repository.baselineStatusKnown && actual !== null) ||
				(actual !== null && (!expected?.known || !samePatch(actual, expected)));
			if (await upstreamHoldsSessionDelta(exec, repository, upstreamHead, repoPath)) {
				savedPaths.add(repoPath);
				continue;
			}
			pendingPaths.add(repoPath);
			if (mixed) sharedPaths.add(repoPath);
		}
	}
	if (pendingPaths.size === 0) return null;
	return {
		root: repository.root,
		paths: Array.from(pendingPaths).sort(),
		aheadCount,
		sharedPaths: Array.from(sharedPaths).sort(),
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
	return `repo ${JSON.stringify(finding.root)} paths [${paths}] ahead=${ahead}${saveMode}`;
}

function formatSavePrompt(findings: SaveGuardFinding[]): string {
	const details = findings.map(formatFinding).join("; ");
	const steps: string[] = [];
	for (const finding of findings) {
		const sharedPaths = new Set(finding.sharedPaths ?? []);
		const plainPaths = finding.paths.filter(path => !sharedPaths.has(path));
		if (plainPaths.length > 0) {
			const paths = plainPaths.map(path => JSON.stringify(path)).join(", ");
			const commandPaths = plainPaths.map(shellQuote).join(" ");
			steps.push(`repo ${JSON.stringify(finding.root)}: reserve ${paths}; run git commit --only -m "<msg> [level]" -- ${commandPaths}; git push origin main (if origin moved: python3 ~/Developer/omp-kit/scripts/git_converge.py --repo ${shellQuote(finding.root)} --push); release the reservation`);
		}
		if (sharedPaths.size > 0) {
			const paths = Array.from(sharedPaths).map(path => JSON.stringify(path)).join(", ");
			steps.push(`repo ${JSON.stringify(finding.root)}: ${paths} also hold another session's uncommitted hunks: message each path's holder (Agent Mail) to commit the whole file on main or hand it back; never build or push a private-index candidate (one history per repo)`);
		}
	}
	return `Unsaved session-owned work remains (${details}). Save before ending: ${steps.join("; ")}.`;
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
			.catch(() => undefined);
		await state.pendingToolPathWork;
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolCallId.length === 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId.length === 0) return;
		const snapshots = pathsFromToolCall(event, ctx.cwd);
		if (snapshots.size === 0) return;
		const state = sessionStateFor(sessions, sessionId);
		state.pendingToolPathSnapshots.set(event.toolCallId, snapshots);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		const state = sessionId.length > 0 ? sessions.get(sessionId) : undefined;
		const pathSnapshots = state?.pendingToolPathSnapshots.get(event.toolCallId);
		if (state) state.pendingToolPathSnapshots.delete(event.toolCallId);
		if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "ast_edit") return;
		const paths = pathsFromToolEvent(event, ctx.cwd);
		if (paths.length === 0 || sessionId.length === 0) return;
		const currentState = state ?? sessionStateFor(sessions, sessionId);
		currentState.pendingToolPathWork = currentState.pendingToolPathWork
			.then(() => recordToolPaths(pi.exec.bind(pi), currentState, ctx.cwd, paths, pathSnapshots))
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
