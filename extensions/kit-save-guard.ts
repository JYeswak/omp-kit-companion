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

interface OwnedRepository {
	root: string;
	paths: Set<string>;
	baselineHead: string | null;
}

interface SessionState {
	repositories: Map<string, OwnedRepository>;
	rootByDirectory: Map<string, string>;
	pendingToolPathWork: Promise<void>;
	rePrompts: number;
	warningEmitted: boolean;
}

export interface SaveGuardFinding {
	root: string;
	paths: string[];
	aheadCount: number | null;
}

function addLocalPath(paths: string[], value: unknown): void {
	if (typeof value === "string" && value.length > 0 && !value.includes("://")) paths.push(value);
}

function pathsFromToolEvent(event: SaveGuardToolExecutionEndEvent, cwd: string): string[] {
	const result = event.result;
	if (typeof result !== "object" || result === null || !("details" in result)) return [];
	const details = result.details;
	if (typeof details !== "object" || details === null) return [];

	const paths: string[] = [];
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
			paths.push(path.isAbsolute(replacement.path)
				? path.resolve(replacement.path)
				: path.resolve(base, replacement.path));
		}
	}
	return paths;
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

function sessionStateFor(states: Map<string, SessionState>, sessionId: string): SessionState {
	let state = states.get(sessionId);
	if (!state) {
		state = {
			repositories: new Map(),
			rootByDirectory: new Map(),
			pendingToolPathWork: Promise.resolve(),
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

async function recordToolPaths(
	exec: SaveGuardApi["exec"],
	state: SessionState,
	cwd: string,
	toolPaths: string[],
): Promise<void> {
	for (const rawPath of toolPaths) {
		const absolutePath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
		const lookupDirectory = isWithinDirectory(cwd, absolutePath) ? cwd : path.dirname(absolutePath);
		let root = state.rootByDirectory.get(lookupDirectory);
		if (root === undefined) {
			const top = await runGit(exec, lookupDirectory, ["rev-parse", "--show-toplevel"]);
			if (top.code !== 0) continue;
			root = path.resolve(gitLine(top.stdout));
			if (root.length === 0) continue;
			state.rootByDirectory.set(lookupDirectory, root);
		}

		const relative = path.relative(root, absolutePath);
		if (relative.length === 0 || path.isAbsolute(relative) || relative === ".." ||
			relative.startsWith(`..${path.sep}`)) continue;
		const repoPath = relative.split(path.sep).join("/");
		if (isAgentTempPath(repoPath)) continue;

		let repository = state.repositories.get(root);
		if (!repository) {
			const head = await runGit(exec, root, ["rev-parse", "--verify", "HEAD"]);
			repository = {
				root,
				paths: new Set(),
				baselineHead: head.code === 0 ? gitLine(head.stdout) : null,
			};
			state.repositories.set(root, repository);
		}
		repository.paths.add(repoPath);
	}
}

function statusPaths(stdout: string): Set<string> {
	const entries = stdout.split("\0");
	const paths = new Set<string>();
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.length < 4) continue;
		paths.add(entry.slice(3));
		if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
			const sourcePath = entries[index + 1];
			if (sourcePath) paths.add(sourcePath);
			index += 1;
		}
	}
	return paths;
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

	const ownedPathSet = new Set(ownedPaths);
	const dirtyPaths = Array.from(statusPaths(status.stdout))
		.filter(path => ownedPathSet.has(path))
		.sort();
	const upstream = await runGit(exec, repository.root, ["rev-parse", "--verify", "@{u}"]);
	const exclusions: string[] = [];
	if (repository.baselineHead) exclusions.push(repository.baselineHead);
	if (upstream.code === 0) {
		const upstreamHead = gitLine(upstream.stdout);
		if (upstreamHead.length > 0) exclusions.push(upstreamHead);
	}
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
	if (dirtyPaths.length === 0 && (aheadCount === null || aheadCount === 0)) return null;

	const pendingPaths = new Set(dirtyPaths);
	if (aheadCount !== null && aheadCount > 0) {
		for (const ownedPath of ownedPaths) pendingPaths.add(ownedPath);
	}
	return { root: repository.root, paths: Array.from(pendingPaths).sort(), aheadCount };
}

function shellQuote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

function formatFinding(finding: SaveGuardFinding): string {
	const paths = finding.paths.map(path => JSON.stringify(path)).join(", ");
	const ahead = finding.aheadCount === null ? "unknown" : String(finding.aheadCount);
	return `repo ${JSON.stringify(finding.root)} paths [${paths}] ahead=${ahead}`;
}

function formatSavePrompt(findings: SaveGuardFinding[]): string {
	const details = findings.map(formatFinding).join("; ");
	const steps = findings.map(finding => {
		const paths = finding.paths.map(path => JSON.stringify(path)).join(", ");
		const commandPaths = finding.paths.map(shellQuote).join(" ");
		return `repo ${JSON.stringify(finding.root)}: reserve ${paths}; run git commit --only -m "<msg> [level]" -- ${commandPaths}; git push (set upstream if needed); release the reservation`;
	}).join("; ");
	return `Unsaved session-owned work remains (${details}). Save before ending: ${steps}.`;
}

function formatWarning(findings: SaveGuardFinding[]): string {
	return `kit-save-guard: turn-end save retry limit reached; ${findings.map(formatFinding).join("; ")}`;
}

export default async function kitSaveGuard(pi: SaveGuardApi): Promise<void> {
	const sessions = new Map<string, SessionState>();
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "ast_edit") return;
		const paths = pathsFromToolEvent(event, ctx.cwd);
		if (paths.length === 0) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId.length === 0) return;
		const state = sessionStateFor(sessions, sessionId);
		state.pendingToolPathWork = state.pendingToolPathWork
			.then(() => recordToolPaths(pi.exec.bind(pi), state, ctx.cwd, paths))
			.catch(() => undefined);
		await state.pendingToolPathWork;
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
