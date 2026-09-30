import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LspReadinessReport, LspServerReadiness } from "./lsp-readiness.ts";
import { isRecord } from "./type-guards.ts";

export type LspProbeState = "PASS" | "MISSING" | "IMMEDIATE_EXIT" | "WRONG_MARKER" | "INCOMPLETE" | "TIMEOUT" | "UNVERIFIED";
type ProbeTreeSnapshot = Record<string, [number, number, number, string | null]>;

export interface LspProbeInput {
	readiness: LspReadinessReport;
	home: string;
	ompPath: string;
	pathEnv?: string;
	timeoutMs?: number;
}

export interface LspProbeClassification {
	timed_out: boolean;
	server_missing: boolean;
	wrong_marker: boolean;
	immediate_exit: boolean;
	checks_passed: boolean;
}

interface LspTimeoutObservation { source: "OMP_PROCESS_DEADLINE" | "LSP_TOOL_RESULT"; elapsed_scope: "whole_probe" | "lsp_tool_call"; elapsed_ms: number; deadline_ms: number; tool_result: string | null }
export interface LspProbeReport {
	status: LspProbeState;
	scope: "OMP_LSP_TOOL_ROUTE";
	requested_project: string;
	requested_file: string | null;

	selected_server: string | null;
	selected_command: string | null;
	reason: string;
	checks: Record<string, boolean>;
	calls: Array<{ action: string; file?: string; line?: number; symbol?: string; query?: string; elapsed_ms?: number; result: string; result_truncated?: boolean }>;
	omp_rc: number | null;
	timed_out: boolean;
	timeout_observation: LspTimeoutObservation | null;
	fixture_git_init_rc: number | null;
	protected_input_snapshots: { before: Record<string, unknown>; after: Record<string, unknown>; unchanged: boolean } | null;
	profile_template_unchanged: boolean | null;
	profile_template_snapshots: { before: ProbeTreeSnapshot; after: ProbeTreeSnapshot; unchanged: boolean } | null;
	fixture_project_unchanged: boolean | null;
	fixture_project_snapshots: { before: ProbeTreeSnapshot; after: ProbeTreeSnapshot; unchanged: boolean } | null;
	runtime_home_omp_inventory: string[];
	runtime_state_outputs: string[];
	mux_stop_rc: number | null;
	temporary_workspace_removed: boolean;
}

interface LoopbackModelServer { port: number; stop(closeActiveConnections?: boolean): void }
interface OmpProbeProcess {
	pid: number;
	exitCode: number | null;
	exited: Promise<number>;
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
}

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_MODEL_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_LOG_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_TOOL_RESULT_BYTES = 64 * 1024;
const ACTIONS = ["status", "capabilities", "references", "symbols", "status"] as const;

function classifyLspProbeOutcome(input: LspProbeClassification): LspProbeState {
	if (input.timed_out) return "TIMEOUT";
	if (input.server_missing) return "MISSING";
	if (input.wrong_marker) return "WRONG_MARKER";
	if (input.immediate_exit) return "IMMEDIATE_EXIT";
	return input.checks_passed ? "PASS" : "INCOMPLETE";
}


function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function privateTempRoot(): string {
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" }, timeout: 5_000, killSignal: "SIGKILL" });
		if (result.exitCode !== 0) throw new Error(`cannot locate macOS private temp root: ${result.stderr.toString().trim()}`);
		const root = result.stdout.toString().trim();
		if (!isAbsolute(root)) throw new Error("macOS returned a non-absolute private temp root");
		return realpathSync(root);
	}
	if (process.platform === "linux") return realpathSync("/tmp");
	throw new Error(`unsupported platform for private LSP probe scratch: ${process.platform}`);
}
type ProtectedSnapshot = Record<string,
	{ kind: "absent" } |
	{ kind: "directory"; mode: number; mtime_ms: number } |
	{ kind: "file"; mode: number; size: number; mtime_ms: number; sha256: string }>;
function snapshotFiles(paths: string[], optional: ReadonlySet<string>): ProtectedSnapshot {
	const output: ProtectedSnapshot = {};
	let totalBytes = 0;
	for (const path of [...new Set(paths)].sort()) {
		try {
			const info = lstatSync(path);
			if (info.isDirectory() && optional.has(path)) {
				output[path] = { kind: "directory", mode: info.mode & 0o777, mtime_ms: info.mtimeMs };
				continue;
			}
			if (!info.isFile() || info.isSymbolicLink()) throw new Error(`protected input is not a regular file: ${path}`);
			if (info.size > MAX_INPUT_BYTES || (totalBytes += info.size) > MAX_TOTAL_INPUT_BYTES) throw new Error("protected LSP inputs exceed the snapshot size limit");
			output[path] = { kind: "file", mode: info.mode & 0o777, size: info.size, mtime_ms: info.mtimeMs,
				sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
		} catch (error) {
			if (optional.has(path) && isRecord(error) && error.code === "ENOENT") output[path] = { kind: "absent" };
			else throw error;
		}
	}
	return output;
}
function snapshotTree(root: string): ProbeTreeSnapshot {
	const output: ProbeTreeSnapshot = {};
	const pending = [root];
	let totalBytes = 0;
	while (pending.length) {
		const path = pending.pop()!;
		const info = lstatSync(path);
		if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error(`probe input contains a non-regular entry: ${path}`);
		const relativePath = path === root ? "." : path.slice(root.length + 1);
		if (info.isFile()) {
			totalBytes += info.size;
			if (totalBytes > MAX_TOTAL_INPUT_BYTES) throw new Error("synthetic probe inputs exceed the snapshot size limit");
		}
		output[relativePath] = [info.mode & 0o777, info.size, info.mtimeMs, info.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null];
		if (info.isDirectory()) for (const name of readdirSync(path).sort()) pending.push(join(path, name));
	}
	return output;
}
function runtimeInventory(root: string): string[] {
	if (!existsSync(root)) return [];
	const output: string[] = [];
	const pending = [root];
	while (pending.length) {
		const path = pending.pop()!;
		const info = lstatSync(path);
		const relativePath = path === root ? "." : path.slice(root.length + 1);
		const kind = info.isDirectory() ? "dir" : info.isSocket() ? "socket" : info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "other";
		output.push(`${relativePath}:${kind}`);
		if (info.isDirectory()) for (const name of readdirSync(path).sort()) pending.push(join(path, name));
	}
	return output.sort();
}
interface PrivateRuntimeInventory { homeOmp: string[]; stateOutputs: string[]; muxRemains: boolean }
function inspectPrivateRuntime(roots: readonly { name: string; path: string }[]): PrivateRuntimeInventory {
	const inventories = roots.map(root => ({ name: root.name, entries: runtimeInventory(root.path) }));
	return {
		homeOmp: inventories.find(item => item.name === "home/.omp")?.entries ?? [],
		stateOutputs: inventories.flatMap(item => item.entries
			.filter(path => /(?:\.db|\.sqlite3?)(?:-(?:wal|shm))?:(?:file|other)$|(?:\.wal|\.shm):(?:file|other)$|\.sock:socket$/i.test(path))
			.map(path => item.name + "/" + path)),
		muxRemains: inventories.some(item => item.entries.some(path => path.endsWith("lsp-mux.sock:socket"))),
	};
}
function capabilityObject(text: string, serverName: string): Record<string, unknown> | null {
	const heading = text.indexOf(`${serverName}:`);
	const label = heading < 0 ? -1 : text.indexOf("capabilities:", heading);
	const first = label < 0 ? -1 : text.indexOf("{", label);
	if (first < 0) return null;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = first; index < text.length; index++) {
		const character = text[index];
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === "{") depth++;
		else if (character === "}" && --depth === 0) {
			try { const parsed: unknown = JSON.parse(text.slice(first, index + 1)); return isRecord(parsed) ? parsed : null; }
			catch { return null; }
		}
	}
	return null;
}
function isWorkspaceExecutablePath(path: string): boolean {
	const normalized = resolve(path);
	if (normalized.includes(`${sep}node_modules${sep}.bin${sep}`)) return true;
	for (let directory = dirname(normalized);;) {
		// Homebrew keeps its installation prefix in Git; installed tools are not checkout commands.
		if (directory === "/opt/homebrew" || directory === "/usr/local") return false;
		if (existsSync(join(directory, ".git"))) return true;
		const parent = dirname(directory);
		if (parent === directory) return false;
		directory = parent;
	}
}
function safePath(command: string, pathEnv: string, project: string): string | null {
	for (const directory of pathEnv.split(delimiter)) {
		if (!isAbsolute(directory)) continue;
		try {
			const realDirectory = realpathSync(directory);
			if ((inside(project, realDirectory) || isWorkspaceExecutablePath(join(directory, command)))) continue;
			const resolved = realpathSync(join(realDirectory, command));
			const info = statSync(resolved);
			if (info.isFile() && (info.mode & 0o111) !== 0 && (!inside(project, resolved) && !isWorkspaceExecutablePath(resolved))) return resolved;
		} catch { /* Continue through PATH without invoking candidates. */ }
	}
	return null;
}
function result(state: LspProbeState, reason: string, readiness: LspReadinessReport, server: LspServerReadiness | undefined): LspProbeReport {
	return { status: state, scope: "OMP_LSP_TOOL_ROUTE", requested_project: readiness.cwd, requested_file: readiness.file, selected_server: server?.name ?? null,
		selected_command: server?.resolved_command ?? null, reason, checks: {}, calls: [], omp_rc: null, timed_out: false,
		timeout_observation: null, fixture_git_init_rc: null, protected_input_snapshots: null,
		profile_template_unchanged: null, profile_template_snapshots: null,
		fixture_project_unchanged: null, fixture_project_snapshots: null,
		runtime_home_omp_inventory: [], runtime_state_outputs: [], mux_stop_rc: null, temporary_workspace_removed: true };
}
function fixtureMarkerName(marker: string): string | null | undefined {
	if (marker === ".") return null;
	if (marker.length === 0 || marker.includes("*") || !/^[\w.*-]+$/.test(marker) || marker === "..") return undefined;
	return marker;
}
function sseEvent(delta: Record<string, unknown>, finish: string | null = null): string {
	return `data: ${JSON.stringify({ id: "omp-kit-lsp-probe", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let truncated = false;
	const cancel = () => { truncated = true; void reader.cancel().catch(() => { /* Output is already marked incomplete. */ }); };
	signal.addEventListener("abort", cancel, { once: true });
	try {
		if (signal.aborted) cancel();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes <= limit) text += decoder.decode(value, { stream: true });
			else {
				truncated = true;
				const remaining = limit - (bytes - value.byteLength);
				if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
			}
		}
	} catch { truncated = true; }
	finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
	text += decoder.decode();
	return { text, truncated };
}
function signalGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
	try { process.kill(-pid, signal); } catch { /* The process group already exited. */ }
}
async function beforeDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), milliseconds); })]);
	} finally { if (timer) clearTimeout(timer); }
}
function stopPrivateMux(omp: string, project: string, env: Record<string, string>): { code: number; acknowledged: boolean } {
	const stopped = Bun.spawnSync([omp, "ps", "stop", "omp.lsp.mux", "--dir", project, "--timeout", "5", "--json"], {
		cwd: project, env, stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL",
	});
	let acknowledged = false;
	try {
		const report: unknown = JSON.parse(stopped.stdout.toString());
		acknowledged = stopped.exitCode === 0 && isRecord(report) && report.name === "omp.lsp.mux" && report.state === "exited" && typeof report.exitCode === "number";
	} catch { /* Missing or malformed shutdown acknowledgement cannot prove cleanup. */ }
	return { code: stopped.exitCode, acknowledged };
}
function toolCalls(requests: unknown[], requestTimes: number[], toolCallIssuedAt: ReadonlyMap<string, number>): LspProbeReport["calls"] {
	type CallArguments = { action: string; file?: string; line?: number; symbol?: string; query?: string };
	const calls = new Map<string, { args: CallArguments; startedAt: number | null }>();
	const results = new Map<string, { text: string; completedAt: number | null }>();
	for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
		const request = requests[requestIndex];
		const observedAt = requestTimes[requestIndex] ?? null;
		if (!isRecord(request) || !Array.isArray(request.messages)) continue;
		for (const message of request.messages) {
			if (!isRecord(message)) continue;
			if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
				for (const raw of message.tool_calls) {
					if (!isRecord(raw) || typeof raw.id !== "string" || !isRecord(raw.function) || raw.function.name !== "lsp" || typeof raw.function.arguments !== "string") continue;
					try {
						const args: unknown = JSON.parse(raw.function.arguments);
						if (!isRecord(args) || typeof args.action !== "string") continue;
						const call: CallArguments = { action: args.action };
						if (typeof args.file === "string") call.file = args.file;
						if (typeof args.line === "number") call.line = args.line;
						if (typeof args.symbol === "string") call.symbol = args.symbol;
						if (typeof args.query === "string") call.query = args.query;
						if (!calls.has(raw.id)) calls.set(raw.id, { args: call, startedAt: toolCallIssuedAt.get(raw.id) ?? observedAt });
					} catch { /* Malformed tool arguments fail the route assertion. */ }
				}
			}
			if (message.role === "tool" && typeof message.tool_call_id === "string" && !results.has(message.tool_call_id)) {
				results.set(message.tool_call_id, { text: typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "") ?? "", completedAt: observedAt });
			}
		}
	}
	return [...calls.entries()].map(([id, call]) => {
		const result = results.get(id);
		const elapsed = result && call.startedAt !== null && result.completedAt !== null ? Math.max(0, result.completedAt - call.startedAt) : undefined;
		const resultText = result?.text ?? "";
		const resultTruncated = resultText.length > MAX_TOOL_RESULT_BYTES;
		return { ...call.args, ...(elapsed === undefined ? {} : { elapsed_ms: elapsed }), result: resultText.slice(0, MAX_TOOL_RESULT_BYTES), ...(resultTruncated ? { result_truncated: true } : {}) };
	});
}
function lspToolTimeoutEvidence(text: string): { deadline_ms: number; matched_text: string } | null {
	const actionTimeout = /LSP (?:status|capabilities|references|symbols) timed out after ([0-9]+(?:\.[0-9]+)?)s on typescript-language-server\./i.exec(text);
	if (actionTimeout) {
		const deadlineMs = Math.round(Number(actionTimeout[1]) * 1000);
		return Number.isFinite(deadlineMs) && deadlineMs > 0 ? { deadline_ms: deadlineMs, matched_text: actionTimeout[0] } : null;
	}
	const requestTimeout = /LSP error: LSP request [A-Za-z0-9_.$/:+-]+ timed out after ([0-9]+(?:\.[0-9]+)?)ms/i.exec(text);
	if (!requestTimeout) return null;
	const deadlineMs = Math.round(Number(requestTimeout[1]));
	return Number.isFinite(deadlineMs) && deadlineMs > 0 ? { deadline_ms: deadlineMs, matched_text: requestTimeout[0] } : null;
}

export async function probeLspReadiness(input: LspProbeInput): Promise<LspProbeReport> {
	const readiness = input.readiness;
	const requestedFile = readiness.file;
	const server = readiness.servers.find(candidate => candidate.name === "typescript-language-server");
	if (!requestedFile || readiness.file_outside_cwd || extname(requestedFile).toLowerCase() !== ".ts") return result("UNVERIFIED", "Deep probe requires an in-project TypeScript file; no workspace command was run.", readiness, server);
	if (readiness.opaque_layers.length) return result("UNVERIFIED", "Unreadable or unsupported LSP configuration prevents proving the selected server; no probe was run.", readiness, server);
	if (!server) return result("MISSING", "OMP has no typescript-language-server candidate for the selected file.", readiness, server);
	const selectedCommand = server.resolved_command;
	if (!server.executable_found || !selectedCommand) return result("MISSING", "The selected typescript-language-server executable is absent; no probe was run.", readiness, server);
	if (server.reason.startsWith("No root marker")) return result("WRONG_MARKER", server.reason, readiness, server);
	if (!server.eligible || server.disabled) return result("UNVERIFIED", "The selected server is disabled or ineligible for the requested project and file; no probe was run.", readiness, server);
	if (!isAbsolute(input.home) || !isAbsolute(input.ompPath)) return result("UNVERIFIED", "Absolute HOME and validated OMP launcher paths are required; no probe was run.", readiness, server);

	let project: string;
	let file: string;
	try {
		project = realpathSync(readiness.cwd);
		file = realpathSync(requestedFile);
	} catch { return result("UNVERIFIED", "The selected project or file is no longer accessible; no probe was run.", readiness, server); }
	try {
		if (!inside(project, file) || !lstatSync(file).isFile()) return result("UNVERIFIED", "The selected file must resolve to a regular file inside the selected project; no probe was run.", readiness, server);
	} catch { return result("UNVERIFIED", "The selected file is not a readable regular file; no probe was run.", readiness, server); }
	const pathEnv = input.pathEnv ?? process.env.PATH ?? "";
	const localServerCandidates = ["node_modules/.bin", ".venv/bin", ".venv/Scripts", "venv/bin", "venv/Scripts", ".env/bin", ".env/Scripts", "vendor/bundle/bin", "bin"]
		.map(directory => join(project, directory, "typescript-language-server"));
	if (localServerCandidates.some(path => existsSync(path))) return result("UNVERIFIED", "Workspace-local LSP executables are not run by deep doctor.", readiness, server);
	const pathServer = safePath("typescript-language-server", pathEnv, project);
	if (!pathServer) return result("UNVERIFIED", "No installed non-workspace TypeScript server could be selected from PATH; no command was run.", readiness, server);
	let tsls: string;
	try { tsls = realpathSync(selectedCommand); }
	catch { return result("MISSING", "The selected language-server executable disappeared before probing.", readiness, server); }
	if (inside(project, tsls) || tsls !== pathServer) return result("UNVERIFIED", "The selected server does not resolve to the non-project PATH executable; no workspace command was run.", readiness, server);
	const node = safePath("node", pathEnv, project);
	if (!node) return result("MISSING", "Node.js required by typescript-language-server is absent from the non-project PATH.", readiness, server);
	const bun = safePath("bun", pathEnv, project);
	if (!bun) return result("MISSING", "Bun required by the installed OMP launcher is absent from the non-project PATH.", readiness, server);

	let omp: string;
	let defaultsPath: string;
	let defaults: Record<string, unknown>;
	try {
		omp = realpathSync(input.ompPath);
		if ((inside(project, omp) || isWorkspaceExecutablePath(omp))) return result("UNVERIFIED", "Workspace-local OMP launchers are not run by deep doctor.", readiness, server);
		const packageRoot = dirname(dirname(omp));
		const metadata: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		if (!isRecord(metadata) || metadata.name !== "@oh-my-pi/pi-coding-agent") throw new Error("OMP launcher package identity mismatch");
		defaultsPath = join(packageRoot, "src", "lsp", "defaults.json");
		const parsed: unknown = JSON.parse(readFileSync(defaultsPath, "utf8"));
		if (!isRecord(parsed) || !isRecord(parsed["typescript-language-server"])) throw new Error("OMP TypeScript LSP defaults are unavailable");
		defaults = parsed;
		const defaultServer = parsed["typescript-language-server"];
		if (!isRecord(defaultServer) || defaultServer.command !== "typescript-language-server" || server.config_source !== defaultsPath) {
			return result("UNVERIFIED", "Deep probing only accepts OMP's unmodified built-in TypeScript LSP command; custom LSP commands are never executed.", readiness, server);
		}
	} catch (error) {
		return result("UNVERIFIED", `Cannot verify OMP's built-in TypeScript server source: ${error instanceof Error ? error.message : String(error)}`, readiness, server);
	}
	const markers = server.root_markers.map(fixtureMarkerName);
	if (markers.some(marker => marker === undefined) || !markers.length) return result("UNVERIFIED", "The selected root markers cannot be reproduced safely in a private fixture; no probe was run.", readiness, server);
	const gitBin = safePath("git", pathEnv, project);
	if (!gitBin) return result("UNVERIFIED", "Trusted Git is unavailable for initializing the private fixture; no probe was run.", readiness, server);

	let protectedBefore: ProtectedSnapshot;
	const projectMarkerPaths = server.root_markers.filter(marker => marker !== ".").map(marker => join(project, marker));
	const requiredPaths = [requestedFile, ...readiness.config_layers, defaultsPath];
	const optionalMarkers = new Set(projectMarkerPaths.filter(path => !requiredPaths.includes(path)));
	const protectedPaths = [...requiredPaths, ...projectMarkerPaths];
	try { protectedBefore = snapshotFiles(protectedPaths, optionalMarkers); }
	catch (error) { return result("UNVERIFIED", `Cannot snapshot selected LSP inputs safely: ${error instanceof Error ? error.message : String(error)}`, readiness, server); }

	let probeRoot: string | undefined;
	let mockServer: LoopbackModelServer | undefined;
	let ompProcess: OmpProbeProcess | undefined;
	let timedOut = false;
	let timeoutObservation: LspTimeoutObservation | null = null;
	let processStartedAt = 0;
	let fixtureGitRc: number | null = null;
	let ompCode: number | null = null;
	let muxStopRc: number | null = null;
	let muxStopAcknowledged = false;
	const captureAbort = new AbortController();
	let stdout = "";
	let stderr = "";
	let outputTruncated = false;
	let modelRequests: unknown[] = [];
	let modelRequestTimes: number[] = [];
	let modelBytes = 0;
	let modelErrors: string[] = [];
	let profileBefore: ProbeTreeSnapshot | null = null;
	let fixtureBefore: ProbeTreeSnapshot | null = null;
	let profileUnchanged: boolean | null = null;
	let fixtureUnchanged: boolean | null = null;
	let profileAfter: ProbeTreeSnapshot | null = null;
	let fixtureAfter: ProbeTreeSnapshot | null = null;
	let protectedAfter: ProtectedSnapshot | null = null;
	let protectedUnchanged: boolean | null = null;
	let runtimeEntries: string[] = [];
	let runtimeStateOutputs: string[] = [];
	let runtimeRoots: Array<{ name: string; path: string }> = [];

	let calls: LspProbeReport["calls"] = [];
	let checks: Record<string, boolean> = {};
	let state: LspProbeState = "UNVERIFIED";
	let reason = "The OMP-mediated LSP probe did not complete.";
	let tempRemoved = true;
	let tempParent: string | undefined;
	let cleanupProject: string | undefined;
	let cleanupEnv: Record<string, string> | undefined;
	let ompLaunched = false;
	let remainingMux = false;
	try {
		const scratchRoot = privateTempRoot();
		tempParent = scratchRoot;
		probeRoot = mkdtempSync(join(scratchRoot, "omp-kit-lsp-readiness-"));
		tempRemoved = false;
		chmodSync(probeRoot, 0o700);
		const home = join(probeRoot, "home");
		const projectRoot = join(probeRoot, "project");
		const temp = join(probeRoot, "tmp");
		const profileTemplateRoot = join(probeRoot, "profile-template");
		const template = join(profileTemplateRoot, ".omp", "agent");
		const runtimeProfile = join(home, ".omp", "agent");
		const projectConfig = join(projectRoot, ".omp");
		const source = join(projectRoot, "src");
		const logs = join(probeRoot, "logs");
		const gitTemplate = join(probeRoot, "empty-git-template");
		const xdg = { config: join(probeRoot, "xdg-config"), cache: join(probeRoot, "xdg-cache"), data: join(probeRoot, "xdg-data"), state: join(probeRoot, "xdg-state"), bun: join(probeRoot, "bun-install") };
		runtimeRoots = [
			{ name: "home/.omp", path: join(home, ".omp") }, { name: "tmp", path: temp },
			{ name: "xdg-config", path: xdg.config }, { name: "xdg-cache", path: xdg.cache },
			{ name: "xdg-data", path: xdg.data }, { name: "xdg-state", path: xdg.state }, { name: "bun-install", path: xdg.bun },
		];
		for (const path of [home, projectRoot, temp, gitTemplate, profileTemplateRoot, template, runtimeProfile, projectConfig, source, logs, ...Object.values(xdg)]) {
			mkdirSync(path, { mode: 0o700, recursive: true });
			chmodSync(path, 0o700);
		}
		writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ name: "omp-kit-lsp-probe", private: true }) + "\n", { mode: 0o600 });
		writeFileSync(join(projectRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" }, include: ["src/**/*.ts"] }) + "\n", { mode: 0o600 });
		writeFileSync(join(source, "api.ts"), "export function lspProbeKnownSymbol(): string { return \"known\"; }\n", { mode: 0o600 });
		writeFileSync(join(source, "uses.ts"), "import { lspProbeKnownSymbol } from \"./api\";\nexport const lspProbeUse = lspProbeKnownSymbol();\n", { mode: 0o600 });
		const fixtureServers: Record<string, unknown> = {};
		for (const name of Object.keys(defaults)) fixtureServers[name] = { disabled: name !== "typescript-language-server" };
		fixtureServers["typescript-native"] = { disabled: true };
		fixtureServers["typescript-language-server"] = { command: tsls, args: ["--stdio"], fileTypes: [".ts"], rootMarkers: server.root_markers, disabled: false };
		writeFileSync(join(projectConfig, "lsp.json"), JSON.stringify({ servers: fixtureServers }, null, 2) + "\n", { mode: 0o600 });
		for (const marker of markers) {
			if (marker === undefined) throw new Error("root marker cannot be represented safely");
			if (marker === null) continue;
			const path = join(projectRoot, marker);
			if (!inside(projectRoot, path)) throw new Error("root marker escaped the synthetic project");
			if (!existsSync(path)) {
				if ([".git", ".hg", ".svn", "node_modules"].includes(marker)) mkdirSync(path, { mode: 0o700 });
				else writeFileSync(path, "probe-root-marker\n", { mode: 0o600 });
			}
		}
		writeFileSync(join(template, "config.yml"), "memory:\n  backend: off\n", { mode: 0o600 });
		const absentSymbol = `LspProbeAbsentSymbol_${randomUUID().replaceAll("-", "")}`;
		const turns = [
			{ tool: { name: "lsp", args: { action: "status" } } },
			{ tool: { name: "lsp", args: { action: "capabilities", file: "src/api.ts", timeout: 60 } } },
			{ tool: { name: "lsp", args: { action: "references", file: "src/api.ts", line: 1, symbol: "lspProbeKnownSymbol", timeout: 60 } } },
			{ tool: { name: "lsp", args: { action: "symbols", file: "*", query: absentSymbol, timeout: 60 } } },
			{ tool: { name: "lsp", args: { action: "status" } } },
			{ text: "LSP route probe complete." },
		];
		const toolCallIssuedAt = new Map<string, number>();
		let turnIndex = 0;
		mockServer = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			async fetch(request) {
				if (!request.url.includes("chat/completions")) return new Response("not found", { status: 404 });
				const bodyText = await request.text();
				if (bodyText.length > MAX_MODEL_REQUEST_BYTES || modelBytes + bodyText.length > MAX_MODEL_LOG_BYTES) {
					modelErrors.push("mock model request log exceeded its size limit");
					return new Response("request too large", { status: 413 });
				}
				modelBytes += bodyText.length;
				let body: unknown;
				try { body = JSON.parse(bodyText); } catch { modelErrors.push("OMP sent malformed model JSON"); return new Response("invalid JSON", { status: 400 }); }
				modelRequests.push(body);
				modelRequestTimes.push(performance.now());
				const main = isRecord(body) && Array.isArray(body.tools) && body.tools.length > 0;
				const turn = main ? turns[turnIndex++] ?? { text: "LSP route probe complete." } : { text: "ok" };
				let stream = sseEvent({ role: "assistant" });
				if ("tool" in turn && turn.tool) {
					const callId = "call_" + turnIndex;
					toolCallIssuedAt.set(callId, performance.now());
					stream += sseEvent({ tool_calls: [{ index: 0, id: callId, type: "function", function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] });
					stream += sseEvent({}, "tool_calls");
				} else {
					stream += sseEvent({ content: "text" in turn && turn.text ? turn.text : "ok" });
					stream += sseEvent({}, "stop");
				}
				stream += `data: ${JSON.stringify({ id: "omp-kit-lsp-probe", object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`;
				stream += "data: [DONE]\n\n";
				return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
			},
		});
		if (!Number.isInteger(mockServer.port) || mockServer.port < 1) throw new Error("mock provider did not bind an ephemeral loopback port");
		writeFileSync(join(template, "models.yml"), [
			"providers:", "  mock:", `    baseUrl: http://127.0.0.1:${mockServer.port}/v1`, "    apiKey: sk-omp-kit-lsp-probe", "    api: openai-completions",
			"    models:", "      - id: mock", "        name: mock", "        supportsTools: true", "        contextWindow: 128000", "        maxTokens: 4096", "",
		].join("\n"), { mode: 0o600 });
		for (const name of ["config.yml", "models.yml"]) {
			copyFileSync(join(template, name), join(runtimeProfile, name));
			chmodSync(join(runtimeProfile, name), 0o600);
		}

		const pathParts = [dirname(node), dirname(bun), dirname(tsls), dirname(gitBin), dirname(omp), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
		const safePathParts = [...new Set(pathParts.filter(directory => isAbsolute(directory) && !inside(project, resolve(directory)) && !isWorkspaceExecutablePath(join(directory, ".omp-path-check"))))];
		const privateEnv: Record<string, string> = {
			HOME: home, PATH: safePathParts.join(delimiter), TMPDIR: temp, TMP: temp, TEMP: temp,
			XDG_CONFIG_HOME: xdg.config, XDG_CACHE_HOME: xdg.cache, XDG_DATA_HOME: xdg.data,
			XDG_STATE_HOME: xdg.state, BUN_INSTALL: xdg.bun, CI: "true", NO_COLOR: "1",
			LANG: process.env.LANG ?? "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_TEMPLATE_DIR: gitTemplate,
		};
		writeFileSync(join(home, ".gitconfig"), "", { mode: 0o600 });
		const gitInit = Bun.spawnSync([gitBin, "init", "--quiet"], { cwd: projectRoot, env: privateEnv, stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
		fixtureGitRc = gitInit.exitCode;
		if (fixtureGitRc !== 0) throw new Error("trusted Git could not initialize the private fixture: " + gitInit.stderr.toString().trim());
		profileBefore = snapshotTree(profileTemplateRoot);
		fixtureBefore = snapshotTree(projectRoot);
		cleanupProject = projectRoot;
		cleanupEnv = privateEnv;
		processStartedAt = performance.now();
		const processHandle = Bun.spawn([omp, "-p", "--no-session", "--model", "mock/mock", "--approval-mode", "yolo", "--tools", "lsp",
			"Use only the LSP tool for the requested read-only operations. Do not call any other tool."], {
			cwd: projectRoot, env: privateEnv, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true,
		});
		ompProcess = processHandle;
		ompLaunched = true;
		const stdoutPromise = readLimited(processHandle.stdout, MAX_PROCESS_OUTPUT_BYTES, captureAbort.signal);
		const stderrPromise = readLimited(processHandle.stderr, MAX_PROCESS_OUTPUT_BYTES, captureAbort.signal);
		const limit = Math.min(180_000, Math.max(1_000, input.timeoutMs ?? 180_000));
		let timeoutTimer: NodeJS.Timeout | undefined;
		const timeoutPromise = new Promise<{ kind: "timeout" }>(resolve => {
			timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), limit);
		});
		const waitResult = await Promise.race([
			processHandle.exited.then(code => ({ kind: "exit" as const, code })),
			timeoutPromise,
		]);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (waitResult.kind === "timeout") {
			timedOut = true;
			timeoutObservation = { source: "OMP_PROCESS_DEADLINE", elapsed_scope: "whole_probe", elapsed_ms: performance.now() - processStartedAt, deadline_ms: limit, tool_result: null };
			signalGroup(processHandle.pid, "SIGTERM");
			await beforeDeadline(Promise.all([processHandle.exited, stdoutPromise, stderrPromise]), 5_000);
			signalGroup(processHandle.pid, "SIGKILL");
			ompCode = await beforeDeadline(processHandle.exited, 1_000);
		} else ompCode = waitResult.code;
		const captured = await beforeDeadline(Promise.all([stdoutPromise, stderrPromise]), 5_000);
		if (!captured) {
			signalGroup(processHandle.pid, "SIGKILL");
			captureAbort.abort();
			throw new Error("OMP_OUTPUT_DRAIN_TIMEOUT: inherited output pipes did not close");
		}
		const [out, err] = captured;
		stdout = out.text;
		stderr = err.text;
		outputTruncated = out.truncated || err.truncated;
		ompProcess = undefined;
		const rawCalls = toolCalls(modelRequests, modelRequestTimes, toolCallIssuedAt);
		calls = rawCalls.map(call => ({ ...call, result: call.result.slice(0, MAX_TOOL_RESULT_BYTES) }));
		const callTimeout = calls.map(call => ({ call, evidence: lspToolTimeoutEvidence(call.result) })).find(item => item.evidence !== null);
		if (callTimeout?.evidence && timeoutObservation === null) {
			timeoutObservation = { source: "LSP_TOOL_RESULT", elapsed_scope: callTimeout.call.elapsed_ms === undefined ? "whole_probe" : "lsp_tool_call",
				elapsed_ms: callTimeout.call.elapsed_ms ?? performance.now() - processStartedAt, deadline_ms: callTimeout.evidence.deadline_ms, tool_result: callTimeout.call.result };
		}
		if (timeoutObservation === null) {
			const outputTimeout = lspToolTimeoutEvidence(stdout + "\n" + stderr);
			if (outputTimeout) timeoutObservation = { source: "LSP_TOOL_RESULT", elapsed_scope: "whole_probe", elapsed_ms: performance.now() - processStartedAt,
				deadline_ms: outputTimeout.deadline_ms, tool_result: outputTimeout.matched_text };
		}
		writeFileSync(join(logs, "tool-results-before-snapshot.json"), JSON.stringify({ omp_rc: ompCode, timed_out: timedOut || timeoutObservation !== null, timeout_observation: timeoutObservation, fixture_git_init_rc: fixtureGitRc, calls }, null, 2) + "\n", { mode: 0o600 });
		const stopped = stopPrivateMux(omp, projectRoot, privateEnv);
		muxStopRc = stopped.code;
		muxStopAcknowledged = stopped.acknowledged;
		const runtime = inspectPrivateRuntime(runtimeRoots);
		runtimeEntries = runtime.homeOmp;
		runtimeStateOutputs = runtime.stateOutputs;
		remainingMux = runtime.muxRemains;
		fixtureAfter = snapshotTree(projectRoot);
		profileAfter = snapshotTree(profileTemplateRoot);
		fixtureUnchanged = fixtureBefore !== null && fixtureAfter !== null && JSON.stringify(fixtureBefore) === JSON.stringify(fixtureAfter);
		profileUnchanged = profileBefore !== null && profileAfter !== null && JSON.stringify(profileBefore) === JSON.stringify(profileAfter);
		try {
			protectedAfter = snapshotFiles(protectedPaths, optionalMarkers);
			protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
		} catch { protectedUnchanged = false; }
		const statusBefore = calls.filter(call => call.action === "status")[0]?.result ?? "";
		const capabilities = calls.find(call => call.action === "capabilities")?.result ?? "";
		const references = calls.find(call => call.action === "references")?.result ?? "";
		const absent = calls.find(call => call.action === "symbols")?.result ?? "";
		const statusAfter = calls.filter(call => call.action === "status")[1]?.result ?? "";
		const capability = capabilityObject(capabilities, "typescript-language-server");
		const expected: Array<{ action: string; file?: string; line?: number; symbol?: string; query?: string }> = [
			{ action: "status" },
			{ action: "capabilities", file: "src/api.ts" },
			{ action: "references", file: "src/api.ts", line: 1, symbol: "lspProbeKnownSymbol" },
			{ action: "symbols", file: "*", query: absentSymbol },
			{ action: "status" },
		];
		const actionArgumentsMatch = calls.length === ACTIONS.length && calls.every((call, index) => {
			const wanted = expected[index]!;
			return call.action === ACTIONS[index] && call.action === wanted.action && call.file === wanted.file &&
				call.line === wanted.line && call.symbol === wanted.symbol && call.query === wanted.query;
		});
		const resultsPresent = calls.length === ACTIONS.length && calls.every(call => call.result.length > 0 && !call.result_truncated);
		checks = {
			lsp_tool_advertised: modelRequests.some(request => isRecord(request) && Array.isArray(request.tools) && request.tools.some(tool => isRecord(tool) && isRecord(tool.function) && tool.function.name === "lsp")),
			only_lsp_tool_enabled: modelRequests.some(request => isRecord(request) && Array.isArray(request.tools) && request.tools.length > 0) && modelRequests.every(request => !isRecord(request) || !Array.isArray(request.tools) || request.tools.length === 1 && isRecord(request.tools[0]) && isRecord(request.tools[0].function) && request.tools[0].function.name === "lsp"),
			private_git_initialized: fixtureGitRc === 0,
			read_only_action_arguments: actionArgumentsMatch,
			all_tool_results_present: resultsPresent,
			selected_server_configured: statusBefore.includes("Language servers: typescript-language-server (configured, not started)"),
			initialized_capabilities: capabilities.includes("typescript-language-server:") && capability?.referencesProvider === true && capability.workspaceSymbolProvider === true && !/failed to start|Server failures:/i.test(capabilities),
			known_positive_reference: /Found\s+[1-9]\d* reference\(s\)/.test(references) && references.includes("src/uses.ts") && !/Server failures:/i.test(references),
			absent_symbol_control: absent.includes(`No symbols matching \"${absentSymbol}\"`) && !/Server failures:/i.test(absent),
			server_ready_after_request: statusAfter.includes("Language servers: typescript-language-server (ready)") && !/Server failures:/i.test(statusAfter),
			profile_template_unchanged: profileUnchanged === true,
			fixture_project_unchanged: fixtureUnchanged === true,
			protected_inputs_unchanged: protectedUnchanged === true,
			lsp_mux_stopped: muxStopAcknowledged && muxStopRc === 0 && !remainingMux,
			mock_model_clean: modelErrors.length === 0,
			process_output_complete: !outputTruncated,
		};
		const combined = `${stdout}\n${stderr}\n${calls.map(call => call.result).join("\n")}`;
		const serverMissing = /(?:typescript-language-server[^\n]{0,160}(?:not found|missing|ENOENT)|(?:not found|missing|ENOENT)[^\n]{0,160}typescript-language-server)/i.test(combined);
		const wrongMarker = /(?:no root marker|root marker .*not found|no eligible language server)/i.test(combined);
		const immediateExit = /(?:failed to start|server exited|process exited|exited (?:with )?(?:code|status)|spawn(?:ing)? .*failed)/i.test(combined);
		const checksPassed = Object.values(checks).every(Boolean) && ompCode === 0 && !timedOut && timeoutObservation === null;
		state = classifyLspProbeOutcome({ timed_out: timedOut || timeoutObservation !== null, server_missing: serverMissing, wrong_marker: wrongMarker, immediate_exit: immediateExit, checks_passed: checksPassed });
		reason = state === "PASS" ? "The OMP LSP tool initialized the selected real server, returned a known positive reference, and completed the absent-symbol control in the private fixture."
			: state === "MISSING" ? "The selected language server executable or runtime is missing."
				: state === "WRONG_MARKER" ? "OMP did not select the server because its configured root marker was not present."
					: state === "IMMEDIATE_EXIT" ? "The selected language server exited during OMP-mediated startup or initialization."
						: state === "TIMEOUT" ? "The OMP-mediated LSP request exceeded its bounded timeout."
							: "The OMP-mediated LSP route was incomplete; inspect the bounded checks and raw tool results.";
	} catch (error) {
		reason = `Deep LSP probe failed closed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		captureAbort.abort();
		if (ompProcess) {
			signalGroup(ompProcess.pid, "SIGTERM");
			await beforeDeadline(ompProcess.exited, 5_000);
			// The parent may have exited while descendants retained its process group or pipes.
			signalGroup(ompProcess.pid, "SIGKILL");
			ompCode ??= await beforeDeadline(ompProcess.exited, 1_000);
		}
		if (ompLaunched && muxStopRc === null && cleanupProject && cleanupEnv) {
			try {
				const stopped = stopPrivateMux(omp, cleanupProject, cleanupEnv);
				muxStopRc = stopped.code; muxStopAcknowledged = stopped.acknowledged;
			} catch { muxStopAcknowledged = false; }
		}
		if (runtimeRoots.length) {
			try {
				const runtime = inspectPrivateRuntime(runtimeRoots);
				runtimeEntries = runtime.homeOmp;
				runtimeStateOutputs = runtime.stateOutputs;
				remainingMux = runtime.muxRemains;
			} catch { runtimeEntries = []; runtimeStateOutputs = []; remainingMux = true; }
		}
		if (protectedAfter === null) {
			try { protectedAfter = snapshotFiles(protectedPaths, optionalMarkers); protectedUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter); }
			catch { protectedUnchanged = false; }
		}
		if (profileBefore && profileUnchanged === null && probeRoot) {
			try { profileAfter = snapshotTree(join(probeRoot, "profile-template")); profileUnchanged = JSON.stringify(profileBefore) === JSON.stringify(profileAfter); } catch { profileUnchanged = false; }
		}
		if (fixtureBefore && fixtureUnchanged === null && cleanupProject) {
			try { fixtureAfter = snapshotTree(cleanupProject); fixtureUnchanged = JSON.stringify(fixtureBefore) === JSON.stringify(fixtureAfter); } catch { fixtureUnchanged = false; }
		}
		try { mockServer?.stop(true); } catch { /* The loopback model may already be closed. */ }
		if (probeRoot) {
			try {
				if (ompLaunched && (!muxStopAcknowledged || remainingMux)) throw new Error("private mux shutdown is unverified; retaining its recovery metadata");
				const root = realpathSync(probeRoot);
				if (tempParent && root.startsWith(`${tempParent}${sep}`) && lstatSync(root).isDirectory()) rmSync(root, { recursive: true, force: false });
				tempRemoved = !existsSync(probeRoot);
			} catch { tempRemoved = false; }
		}
	}
	checks = { ...checks, lsp_mux_stopped: ompLaunched && muxStopAcknowledged && muxStopRc === 0 && !remainingMux, temporary_workspace_removed: tempRemoved };
	if (state === "PASS" && Object.values(checks).some(value => !value)) { state = "INCOMPLETE"; reason = "The route responded, but complete output or scoped cleanup could not be proved."; }
	const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
	if ((timedOut || timeoutObservation !== null) && state !== "TIMEOUT") {
		state = "TIMEOUT";
		reason = timeoutObservation ? timeoutObservation.source + " reached a " + timeoutObservation.deadline_ms + "ms deadline after " + timeoutObservation.elapsed_ms + "ms (" + timeoutObservation.elapsed_scope + ")." : "OMP subprocess exceeded its bounded deadline.";
	}
	if (state === "UNVERIFIED" && failedChecks.length) state = "INCOMPLETE";
	return { status: state, scope: "OMP_LSP_TOOL_ROUTE", requested_project: readiness.cwd, requested_file: readiness.file, selected_server: server.name, selected_command: tsls, reason,
		checks: { ...checks, has_failed_checks: failedChecks.length > 0 }, calls, omp_rc: ompCode, timed_out: timedOut || timeoutObservation !== null,
		timeout_observation: timeoutObservation, fixture_git_init_rc: fixtureGitRc,
		protected_input_snapshots: protectedBefore ? { before: protectedBefore, after: protectedAfter ?? {}, unchanged: protectedUnchanged === true } : null,
		profile_template_unchanged: profileUnchanged,
		profile_template_snapshots: profileBefore && profileAfter ? { before: profileBefore, after: profileAfter, unchanged: profileUnchanged === true } : null,
		fixture_project_unchanged: fixtureUnchanged,
		fixture_project_snapshots: fixtureBefore && fixtureAfter ? { before: fixtureBefore, after: fixtureAfter, unchanged: fixtureUnchanged === true } : null,
		runtime_home_omp_inventory: runtimeEntries, runtime_state_outputs: runtimeStateOutputs, mux_stop_rc: muxStopRc,
		temporary_workspace_removed: tempRemoved };
}
