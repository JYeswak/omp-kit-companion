import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RELEASE_DATA } from "./release-assets.ts";
export type IntegrationCell =
	| "WIRED"
	| "CONFIGURED_NOT_FIRING"
	| "ABSENT"
	| "LOAD_ERROR";

export interface IntegrationsInput {
	/** Release root carrying tests/live/mock-model.mjs and the mock runner. */
	root: string;
	/** Absolute HOME holding the real profiles; read-only, never written. */
	home: string;
	/** Named profiles to prove, e.g. ["muse", "codex"]. */
	profiles: string[];
	/** Subset of integrations to prove; defaults to all declared integrations. */
	integrations?: string[];
	/** Scratch root for isolated HOMEs, repos and mock files. */
	workDir: string;
	/** Absolute omp launcher; defaults to PATH resolution. */
	ompPath?: string;
	/** Per-scenario OMP timeout in seconds. */
	timeoutSecs?: number;
	/** Optional absolute path receiving the JSON report; the only write outside workDir. */
	out?: string;
}

export interface QuietAssessment {
	outcome: "ALLOWED" | "BLOCKED";
	detail: string;
	evidence: string[];
}

export interface IntegrationVerdict {
	profile: string;
	integration: string;
	verdict: IntegrationCell;
	detail: string;
	evidence: string[];
	quiet?: QuietAssessment | null;
	source?: { path: string; sha256: string | null };
	markerPath?: string;
}

export interface IntegrationsReport {
	profiles: string[];
	ompVersion: string;
	realOmpIntegrity: {
		path: string;
		homeOmpPath: string;
		beforeSha256: string;
		afterSha256: string;
		complete: boolean;
		unchanged: boolean;
	};
	limitations: string[];
	matrix: IntegrationVerdict[];
}

export class IntegrationsInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "IntegrationsInputError";
	}
}

export const INTEGRATIONS = ["dcg", "slb", "rch", "mcp-agent-mail", "kit-guard", "fleet-guard"] as const;

const EXTENSION_FILE_BY_INTEGRATION: Record<string, string[]> = {
	dcg: ["dcg-tool-bridge.ts"],
	slb: ["slb-guard-fail-closed.ts"],
	rch: ["rch-mutator.ts"],
	"kit-guard": ["kit-guard-optin.ts"],
	"fleet-guard": ["fleet-guard.ts"],
};

interface ScenarioDef {
	integration: string;
	kind: "fire" | "quiet";
	setup: string[];
	turns: unknown[];
}

function loadScenarios(root: string): ScenarioDef[] {
	const parsed: unknown = JSON.parse(readFileSync(join(root, RELEASE_DATA.integrationScenarios), "utf8"));
	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { scenarios?: unknown }).scenarios)) {
		throw new IntegrationsInputError("INTEGRATIONS_UNAVAILABLE", "Integration scenarios file has the wrong shape");
	}
	return (parsed as { scenarios: ScenarioDef[] }).scenarios;
}

function expandVars(value: unknown, vars: Record<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => vars[name] ?? "");
	}
	if (Array.isArray(value)) return value.map(item => expandVars(item, vars));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandVars(item, vars)]));
	}
	return value;
}

/** Extension paths listed under the real config.yml `extensions` key. */
function listedExtensionPaths(configText: string): string[] {
	const paths: string[] = [];
	let inList = false;
	for (const line of configText.split("\n")) {
		if (/^extensions:\s*$/.test(line)) {
			inList = true;
			continue;
		}
		if (inList) {
			const match = /^  - (\S+)\s*$/.exec(line);
			if (match) {
				paths.push(match[1] ?? "");
				continue;
			}
			if (line.trim() !== "" && !line.startsWith(" ")) break;
		}
	}
	return paths.filter(path => path.length > 0);
}
function resolveExtensionPath(home: string, agentDir: string, path: string): string {
	const expanded = path.startsWith("~/") ? join(home, path.slice(2)) : path;
	return isAbsolute(expanded) ? expanded : resolve(agentDir, expanded);
}

function resolvedExtensionConfig(configText: string, home: string, profile: string): string {
	const agentDir = join(home, ".omp/profiles", profile, "agent");
	let inList = false;
	return configText.split("\n").map(line => {
		if (/^extensions:\s*$/.test(line)) {
			inList = true;
			return line;
		}
		if (inList) {
			const match = /^  - (\S+)\s*$/.exec(line);
			if (match) return `  - ${resolveExtensionPath(home, agentDir, match[1] ?? "")}`;
			if (line.trim() !== "" && !line.startsWith(" ")) inList = false;
		}
		return line;
	}).join("\n");
}


/** Extension basenames the profile config lists, from real config.yml lines. */
export function listedExtensions(configText: string): string[] {
	return listedExtensionPaths(configText).map(path => basename(path)).filter(name => name.length > 0);
}

export interface ProfileWiring {
	profile: string;
	extensions: string[];
	extensionPaths: string[];
	hooks: string[];
	mcpServers: string[];
	mcpDisabled: string[];
	hasKitGuard: boolean;
}

/** Read-only static wiring of one real profile. */
export function readProfileWiring(home: string, profile: string): ProfileWiring {
	const agentDir = join(home, ".omp/profiles", profile, "agent");
	let configText = "";
	try {
		configText = readFileSync(join(agentDir, "config.yml"), "utf8");
	} catch {
		throw new IntegrationsInputError("UNKNOWN_PROFILE", `Profile ${profile} has no readable agent config`);
	}
	const extensionPaths = listedExtensionPaths(configText).map(path => resolveExtensionPath(home, agentDir, path));
	const extensions = listedExtensions(configText);
	const hooks: string[] = listHookFiles(join(agentDir, "hooks"));
	let mcpServers: string[] = [];
	let mcpDisabled: string[] = [];
	try {
		const mcp: unknown = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
		if (typeof mcp === "object" && mcp !== null) {
			const servers = (mcp as { mcpServers?: Record<string, unknown> }).mcpServers;
			if (servers && typeof servers === "object") mcpServers = Object.keys(servers);
			const disabled = (mcp as { disabledServers?: unknown }).disabledServers;
			if (Array.isArray(disabled)) mcpDisabled = disabled.filter((name): name is string => typeof name === "string");
		}
	} catch { /* no mcp.json: no MCP integrations */ }
	return { profile, extensions, extensionPaths, hooks, mcpServers, mcpDisabled,
		hasKitGuard: extensions.includes("kit-guard-optin.ts") };
}

function listHookFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string): void => {
		let entries: Dirent[] = [];
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(full);
		}
	};
	walk(dir);
	return found.sort();
}

/** Static verdict without running anything; null means run the live scenario. */
export function staticVerdict(wiring: ProfileWiring, integration: string): IntegrationVerdict | null {
	const base = { profile: wiring.profile, integration, evidence: [] as string[] };
	if (integration === "mcp-agent-mail") {
		if (!wiring.mcpServers.includes("mcp-agent-mail") || wiring.mcpDisabled.includes("mcp-agent-mail")) {
			return { ...base, verdict: "ABSENT", detail: "mcp-agent-mail is not an enabled MCP server", evidence: [] };
		}
		return null;
	}
	const files = EXTENSION_FILE_BY_INTEGRATION[integration] ?? [];
	if (files.length > 0 && !files.some(file => wiring.extensions.includes(file))) {
		return { ...base, verdict: "ABSENT", detail: `no ${files.join("/")} in the profile extensions`, evidence: [] };
	}
	return null;
}
function sourceForIntegration(wiring: ProfileWiring, integration: string): { path: string; sha256: string | null } | undefined {
	const names = EXTENSION_FILE_BY_INTEGRATION[integration] ?? [];
	const path = wiring.extensionPaths.find(candidate => names.includes(basename(candidate)));
	if (!path) return undefined;
	try {
		return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
	} catch {
		return { path, sha256: null };
	}
}

export interface LiveAttempt {
	profile: string;
	integration: string;
	kind: "fire" | "quiet";
	rc: number;
	stdout: string;
	stderr: string;
	mockLog: string;
	workRepo: string;
	marker: string;
	timedOut: boolean;
	evidencePaths: string[];
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<{ done: boolean; value?: T }> {
	const { promise, resolve } = Promise.withResolvers<{ done: boolean; value?: T }>();
	const timer = setTimeout(() => resolve({ done: false }), ms);
	try {
		return await Promise.race([work.then(value => ({ done: true, value })), promise]);
	} finally {
		clearTimeout(timer);
	}
}

function containedOmpCommand(input: IntegrationsInput, ompPath: string, args: string[], integration: string): string[] {
	if (process.platform === "darwin") {
		const sandboxExec = "/usr/bin/sandbox-exec";
		if (!existsSync(sandboxExec)) {
			throw new IntegrationsInputError("CONTAINMENT_UNAVAILABLE", "macOS sandbox-exec is required for integration scenarios");
		}
		const policy = [
			"(version 1)",
			"(allow default)",
			`(deny file-write* (subpath ${JSON.stringify(join(input.home, ".omp"))}))`,
			'(deny file-write* (subpath "/tmp"))',
			'(deny file-write* (subpath "/private/tmp"))',
		].join("\n");
		return [sandboxExec, "-p", policy, ompPath, ...args];
	}
	if (process.platform === "linux") {
		const bubblewrap = Bun.which("bwrap");
		if (bubblewrap) {
			const workDir = resolveWritePath(input.workDir);
			const command = [bubblewrap, "--ro-bind", "/", "/"];
			if (!pathIsWithin("/tmp", workDir) && !pathIsWithin("/private/tmp", workDir)) {
				command.push("--tmpfs", "/tmp");
			}
			command.push("--bind", workDir, workDir, "--proc", "/proc", "--dev", "/dev",
				"--share-net", "--die-with-parent", "--", ompPath, ...args);
			return command;
		}
		if (integration === "fleet-guard") {
			throw new IntegrationsInputError("CONTAINMENT_UNAVAILABLE", "fleet-guard scenario requires bwrap on Linux");
		}
	}
	const realHome = process.env.HOME;
	if (integration === "fleet-guard" || (realHome !== undefined && resolve(input.home) === resolve(realHome))) {
		throw new IntegrationsInputError("CONTAINMENT_UNAVAILABLE", `No write containment is available on ${process.platform}`);
	}
	return [ompPath, ...args];
}

/** Run one scripted mock-model turn set against a profile in an isolated HOME. */
export async function runLiveScenario(input: IntegrationsInput & { profile: string; repo: string },
	scenario: ScenarioDef, vars: Record<string, string>): Promise<LiveAttempt> {
	const kind = scenario.kind;
	const integration = scenario.integration;
	const runRoot = join(input.workDir, `itg-${input.profile}-${integration}-${kind}`);
	const home = join(runRoot, "home");
	const repo = input.repo;
	const tempDir = join(runRoot, "tmp");
	const isolatedAgentDir = join(home, ".omp/profiles", input.profile, "agent");
	const configSource = join(input.home, ".omp/profiles", input.profile, "agent/config.yml");
	const configSnapshot = join(isolatedAgentDir, "config.yml");
	mkdirSync(isolatedAgentDir, { recursive: true });
	mkdirSync(repo, { recursive: true });
	mkdirSync(tempDir, { recursive: true });
	writeFileSync(configSnapshot, resolvedExtensionConfig(readFileSync(configSource, "utf8"), input.home, input.profile));
	const evidencePaths = [configSource, configSnapshot];
	for (const file of ["mcp.json"]) {
		const src = join(input.home, ".omp/profiles", input.profile, "agent", file);
		if (existsSync(src)) {
			const snapshot = join(isolatedAgentDir, file);
			copyFileSync(src, snapshot);
			evidencePaths.push(src, snapshot);
		}
	}
	const hooksSrc = join(input.home, ".omp/profiles", input.profile, "agent/hooks");
	if (existsSync(hooksSrc)) cpSync(hooksSrc, join(isolatedAgentDir, "hooks"), { recursive: true });
	const scenarioFile = join(runRoot, "scenario.json");
	writeFileSync(scenarioFile, JSON.stringify({ turns: expandVars(scenario.turns, vars), chunk: 6 }));
	evidencePaths.push(scenarioFile);
	const mockLog = join(runRoot, "mock.log");
	const portFile = join(runRoot, "port.txt");
	const ompPath = input.ompPath ?? "omp";
	const ompCommand = containedOmpCommand(input, ompPath, ["--profile", input.profile, "-p", "--no-session",
		"--model", "mock/mock", "--approval-mode", "yolo", "go"], integration);
	const mock = Bun.spawn([process.execPath, join(input.root, RELEASE_DATA.liveMockModel)], {
		cwd: input.root,
		env: { HOME: home, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
			SCEN: scenarioFile, LOG: mockLog, PORTFILE: portFile },
		stdout: "pipe",
		stderr: "pipe",
	});
	const mockReady = await waitForFile(portFile, 10000);
	if (!mockReady) {
		try {
			mock.kill(9);
		} catch { /* already gone */ }
		await mock.exited;
		throw new IntegrationsInputError("INTEGRATIONS_UNAVAILABLE", "Mock model server did not start");
	}
	const port = readFileSync(portFile, "utf8").trim();
	writeFileSync(join(isolatedAgentDir, "models.yml"), [
		"providers:",
		"  mock:",
		`    baseUrl: http://127.0.0.1:${port}/v1`,
		"    apiKey: sk-mock",
		"    api: openai-completions",
		"    models:",
		"      - id: mock",
		"        name: mock",
		"        supportsTools: true",
		"        contextWindow: 128000",
		"        maxTokens: 4096",
		"",
	].join("\n"));
	evidencePaths.push(join(isolatedAgentDir, "models.yml"));
	const timeoutMs = (input.timeoutSecs ?? 120) * 1000;
	const child = Bun.spawn(ompCommand, {
		cwd: repo,
		env: cleanEnv(home, tempDir),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const finished = await withTimeout(child.exited, timeoutMs);
	let timedOut = false;
	if (!finished.done) {
		timedOut = true;
		try {
			child.kill(15);
		} catch { /* already gone */ }
		const reaped = await withTimeout(child.exited, 5000);
		if (!reaped.done) {
			try {
				child.kill(9);
			} catch { /* already gone */ }
			await child.exited;
		}
	}
	const code = await child.exited;
	const stdout = await new Response(child.stdout).text();
	const stderr = await new Response(child.stderr).text();
	const stdoutPath = join(runRoot, "stdout.log");
	const stderrPath = join(runRoot, "stderr.log");
	writeFileSync(stdoutPath, stdout);
	writeFileSync(stderrPath, stderr);
	let mockText = "";
	try {
		mockText = readFileSync(mockLog, "utf8");
	} catch { /* no requests reached the mock */ }
	if (!existsSync(mockLog)) writeFileSync(mockLog, mockText);
	evidencePaths.push(mockLog, stdoutPath, stderrPath);
	try {
		mock.kill(9);
	} catch { /* already gone */ }
	await mock.exited;
	const marker = vars["MARKER"] ?? join(repo, "marker.txt");
	return { profile: input.profile, integration, kind, rc: code ?? 1, stdout, stderr,
		mockLog: mockText, workRepo: repo, marker, timedOut, evidencePaths };
}

async function waitForFile(path: string, ms: number): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < ms) {
		try {
			readFileSync(path);
			return true;
		} catch { /* not yet */ }
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return false;
}
/** Isolated environment for omp and git: no profile inheritance, no system git config. */
function cleanEnv(home: string, tempDir: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env["HOME"] = home;
	env["XDG_CONFIG_HOME"] = join(home, ".config");
	env["XDG_CACHE_HOME"] = join(home, ".cache");
	env["XDG_DATA_HOME"] = join(home, ".local/share");
	env["XDG_STATE_HOME"] = join(home, ".local/state");
	env["TMPDIR"] = tempDir;
	env["TMP"] = tempDir;
	env["TEMP"] = tempDir;
	env["GIT_CONFIG_NOSYSTEM"] = "1";
	delete env["OMP_PROFILE"];
	delete env["PI_PROFILE"];
	delete env["PI_CODING_AGENT_DIR"];
	delete env["OMPCODE"];
	delete env["KIT_GUARD_SRC"];
	return env;
}

function git(repo: string, args: string[]): { code: number; stdout: string } {
	const child = Bun.spawnSync(["git", "-c", "user.name=itg", "-c", "user.email=itg@itg", "-c", "init.defaultBranch=main", ...args],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" });
	return { code: child.exitCode ?? 127, stdout: child.stdout.toString() };
}

/** Scratch git repo with one commit; returns the repo root. */
export function setupGitRepo(dir: string): string {
	mkdirSync(dir, { recursive: true });
	git(dir, ["init"]);
	writeFileSync(join(dir, "base.txt"), "base\n");
	git(dir, ["add", "base.txt"]);
	git(dir, ["commit", "-m", "base [test]"]);
	return dir;
}

export function branchExists(repo: string, branch: string): boolean {
	return git(repo, ["show-ref", "--verify", `refs/heads/${branch}`]).code === 0;
}

export function headSha(repo: string): string {
	return git(repo, ["rev-parse", "HEAD"]).stdout.trim();
}

export function isTreeDirty(repo: string): boolean {
	return git(repo, ["status", "--porcelain"]).stdout.trim().length > 0;
}

export interface JudgeInput {
	fire: LiveAttempt;
	quiet: LiveAttempt | null;
	repo: string;
	vars: Record<string, string>;
}

function loadErrorOf(stderr: string, integration: string): string | null {
	const files: Record<string, string[]> = {
		dcg: ["dcg-tool-bridge", "dcg-guard"],
		slb: ["slb-guard", "slb"],
		rch: ["rch-mutator", "rch-lane", "rch"],
		"mcp-agent-mail": ["mcp-agent-mail", "mcp"],
		"kit-guard": ["kit-guard"],
		"fleet-guard": ["fleet-guard"],
	};
	for (const line of stderr.split("\n")) {
		if (!/failed to load/i.test(line)) continue;
		const needles = files[integration] ?? [integration];
		if (needles.some(needle => line.toLowerCase().includes(needle))) return line.trim().slice(0, 300);
	}
	return null;
}

function judgeDcg(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "dcg", evidence: [] as string[] };
	const load = loadErrorOf(input.fire.stderr, "dcg");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	if (!branchExists(input.repo, input.vars["BRANCH"] ?? "")) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: "branch force-delete executed; the guard did not stop it", evidence: [] };
	}
	const source = blockSourceOf(firstToolResultText(input.fire.mockLog));
	if (source !== null && source !== "dcg") {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: `branch kept but the refusal came from ${source}; dcg itself did not fire`, evidence: [] };
	}
	return { ...base, verdict: "WIRED", detail: `branch ${input.vars["BRANCH"] ?? ""} still exists after force-delete`, evidence: [] };
}

function judgeSlb(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "slb", evidence: [] as string[] };
	const load = loadErrorOf(input.fire.stderr, "slb");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	if (!isTreeDirty(input.repo) || headSha(input.repo) !== (input.vars["HEAD"] ?? "")) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: "reset --hard executed; the guard did not stop it", evidence: [] };
	}
	const source = blockSourceOf(firstToolResultText(input.fire.mockLog));
	if (source !== null && source !== "slb") {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: `tree kept but the refusal came from ${source}; slb itself did not fire`, evidence: [] };
	}
	return { ...base, verdict: "WIRED", detail: "working tree still dirty and HEAD unchanged after reset --hard", evidence: [] };
}

function judgeRch(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "rch", evidence: [] as string[] };
	const load = loadErrorOf(input.fire.stderr, "rch");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	if (/rch exec --/.test(input.fire.mockLog)) {
		return { ...base, verdict: "WIRED", detail: "executed input shows rch exec -- rewrite in the tool result", evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING",
		detail: input.fire.timedOut ? "no rewrite observed before the timeout" : "cargo check executed without an rch rewrite", evidence: [] };
}

function judgeMcp(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "mcp-agent-mail", evidence: [] as string[] };
	const blob = `${input.fire.stdout}\n${input.fire.mockLog}`;
	if (/unknown tool|not found|no such tool/i.test(blob)) {
		return { ...base, verdict: "ABSENT", detail: "health_check tool not offered to the model", evidence: [] };
	}
	// OMP 18.6.1 echoes the MCP tool with one underscore (mcp__mcp_agent_mail_health_check);
	// older turns use two. The tool fired and answered if either spelling met an ok answer.
	if (/mcp__mcp_agent_mail__?health_check/i.test(blob) && /"ok"|healthy|uptime|version/i.test(blob)) {
		return { ...base, verdict: "WIRED", detail: "health_check answered through the profile MCP server", evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING",
		detail: input.fire.timedOut ? "no health answer before the timeout" : "health_check did not answer", evidence: [] };
}

/** First tool-result text in a mock log, if the model got that far. */
export function firstToolResultText(mockLog: string): string | null {
	for (const line of mockLog.split("\n")) {
		if (!line.includes('"tool')) continue;
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof row !== "object" || row === null || !("body" in row)) continue;
		const body = row.body;
		if (typeof body !== "object" || body === null || !("messages" in body)) continue;
		const messages = body.messages;
		if (!Array.isArray(messages)) continue;
		for (const message of messages) {
			if (typeof message !== "object" || message === null) continue;
			if (!("role" in message) || !("content" in message)) continue;
			const role = message.role;
			if (role !== "tool" && role !== "toolResult" && role !== "tool_result") continue;
			if (typeof message.content === "string" && message.content.length > 0) return message.content;
		}
	}
	return null;
}

/** Which guard refused the tool call, from the result text; null when the call executed. */
function blockSourceOf(result: string | null): string | null {
	if (result === null) return null;
	if (/kit-guard|KIT_GUARD_SRC/.test(result)) return "kit-guard";
	if (/\bdcg\b/i.test(result)) return "dcg";
	if (/\bslb\b/i.test(result)) return "slb";
	if (/fleet-guard|scratch-write/.test(result)) return "fleet-guard";
	if (/\brch\b/i.test(result)) return "rch";
	if (/refus|denied|block/i.test(result)) return "unknown-guard";
	return null;
}

function judgeKitGuard(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "kit-guard", evidence: [] as string[] };
	const load = loadErrorOf(input.fire.stderr, "kit-guard");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	const result = firstToolResultText(input.fire.mockLog);
	const source = blockSourceOf(result);
	if (source === "kit-guard") {
		return { ...base, verdict: "WIRED", detail: "opted-in repo: tool call refused", evidence: [] };
	}
	if (source !== null) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: `opted-in repo: refusal came from ${source}; kit-guard itself did not fire`, evidence: [] };
	}
	if (result !== null && /(^|\n)hi(\n|$)/.test(result)) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING", detail: "opted-in repo: tool call executed", evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING", detail: "opted-in repo: no tool result observed", evidence: [] };
}

export function judgeFleet(input: JudgeInput): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "fleet-guard", evidence: [] as string[],
		markerPath: input.fire.marker };
	const load = loadErrorOf(input.fire.stderr, "fleet-guard");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	if (existsSync(input.fire.marker)) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: `marker was written at ${input.fire.marker}; fleet-guard did not stop it`, evidence: [] };
	}
	const source = blockSourceOf(firstToolResultText(input.fire.mockLog));
	if (source === "fleet-guard") {
		return { ...base, verdict: "WIRED", detail: `write refused; marker absent at ${input.fire.marker}`, evidence: [] };
	}
	if (source !== null) {
		return { ...base, verdict: "CONFIGURED_NOT_FIRING",
			detail: `refusal came from ${source}; fleet-guard itself did not fire`, evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING", detail: "no tool result observed", evidence: [] };
}

const JUDGES: Record<string, (input: JudgeInput) => IntegrationVerdict> = {
	dcg: judgeDcg,
	slb: judgeSlb,
	rch: judgeRch,
	"mcp-agent-mail": judgeMcp,
	"fleet-guard": judgeFleet,
};

function metadataDigest(root: string): { sha256: string; complete: boolean } {
	const digest = createHash("sha256");
	let complete = true;
	const visit = (directory: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
		} catch {
			complete = false;
			digest.update(`unreadable:${directory}\n`);
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			try {
				const stat = lstatSync(path, { bigint: true });
				digest.update(`${path}\0${stat.mode}\0${stat.size}\0${stat.mtimeNs}\0${stat.ctimeNs}\n`);
				if (stat.isDirectory()) visit(path);
			} catch {
				complete = false;
				digest.update(`unreadable:${path}\n`);
			}
		}
	};
	try {
		const linkStat = lstatSync(root, { bigint: true });
		digest.update(`${root}\0${linkStat.mode}\0${linkStat.size}\0${linkStat.mtimeNs}\0${linkStat.ctimeNs}\n`);
		const stat = linkStat.isSymbolicLink() ? statSync(root, { bigint: true }) : linkStat;
		if (stat.isDirectory()) visit(root);
		else complete = false;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") digest.update(`missing:${root}\n`);
		else {
			complete = false;
			digest.update(`unreadable:${root}\n`);
		}
	}
	return { sha256: digest.digest("hex"), complete };
}

function assessQuiet(attempt: LiveAttempt | null): QuietAssessment | null {
	if (!attempt) return null;
	const result = firstToolResultText(attempt.mockLog);
	const blockedBy = blockSourceOf(result);
	const loadError = loadErrorOf(attempt.stderr, attempt.integration);
	const failedResult = result !== null && /unknown tool|no such tool|command not found|permission denied|operation not permitted|tool call failed/i.test(result);
	let detail = "quiet scenario returned a tool result without refusal";
	if (attempt.timedOut) detail = "quiet scenario timed out";
	else if (attempt.rc !== 0) detail = `quiet OMP process exited ${attempt.rc}`;
	else if (loadError) detail = `quiet scenario extension load failed: ${loadError}`;
	else if (blockedBy) detail = `quiet tool call was refused by ${blockedBy}`;
	else if (failedResult) detail = `quiet tool call returned an error: ${result}`;
	else if (result === null) detail = "quiet scenario produced no tool result";
	return {
		outcome: attempt.timedOut || attempt.rc !== 0 || loadError !== null || blockedBy !== null || failedResult || result === null
			? "BLOCKED" : "ALLOWED",
		detail,
		evidence: attempt.evidencePaths,
	};
}

function captureOmpVersion(ompPath: string, home: string, tempDir: string): string {
	try {
		const result = Bun.spawnSync([ompPath, "--version"], {
			cwd: home, env: cleanEnv(home, tempDir), stdout: "pipe", stderr: "pipe",
		});
		const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim();
		if (result.exitCode !== 0 || output.length === 0) {
			throw new Error(`version command exited ${result.exitCode}: ${output}`);
		}
		return output;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new IntegrationsInputError("OMP_UNAVAILABLE", `Could not capture OMP version: ${detail}`);
	}
}

function pathIsWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, resolve(candidate));
	return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

/** Resolve existing symlink ancestors while allowing a not-yet-created leaf. */
function resolveWritePath(path: string): string {
	let current = resolve(path);
	const suffix: string[] = [];
	while (true) {
		try {
			return resolve(realpathSync(current), ...suffix);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
				throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", `Cannot resolve write path ${path}`);
			}
			try {
				if (lstatSync(current).isSymbolicLink()) {
					throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", `Cannot resolve dangling symlink in ${path}`);
				}
			} catch (statError) {
				if (!(typeof statError === "object" && statError !== null && "code" in statError && statError.code === "ENOENT")) {
					throw statError;
				}
			}
			const parent = dirname(current);
			if (parent === current) {
				throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", `Cannot resolve write path ${path}`);
			}
			suffix.unshift(basename(current));
			current = parent;
		}
	}
}


/** Full per-profile matrix: static ABSENT short-circuits, otherwise live fire+quiet. */
export async function runIntegrations(input: IntegrationsInput): Promise<IntegrationsReport> {
	if (![input.root, input.home, input.workDir].every(value => typeof value === "string" && isAbsolute(value))) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Release root, HOME and work dir must be absolute paths");
	}
	if (input.profiles.length === 0) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Name at least one profile");
	}
	const realOmpRoot = resolve(input.home, ".omp");
	const canonicalOmpRoot = resolveWritePath(realOmpRoot);
	const canonicalWorkDir = resolveWritePath(input.workDir);
	if (pathIsWithin(realOmpRoot, input.workDir) || pathIsWithin(canonicalOmpRoot, canonicalWorkDir)) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Integration work dir must not be inside ~/.omp");
	}
	if (process.platform === "darwin" && (
		pathIsWithin("/tmp", input.workDir) || pathIsWithin("/private/tmp", input.workDir) ||
		pathIsWithin("/tmp", canonicalWorkDir) || pathIsWithin("/private/tmp", canonicalWorkDir)
	)) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION",
			"Integration work dir must be outside /tmp and /private/tmp on macOS");
	}
	if (input.out !== undefined) {
		if (!isAbsolute(input.out)) {
			throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Report output path must be absolute");
		}
		const canonicalOutput = resolveWritePath(input.out);
		if (pathIsWithin(realOmpRoot, input.out) || pathIsWithin(canonicalOmpRoot, canonicalOutput)) {
			throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Report output must not write inside ~/.omp");
		}
	}
	const scenarios = loadScenarios(input.root);
	const ompPath = input.ompPath ?? "omp";
	mkdirSync(input.workDir, { recursive: true });
	const versionHome = join(input.workDir, "version-home");
	const versionTmp = join(input.workDir, "version-tmp");
	mkdirSync(versionHome, { recursive: true });
	mkdirSync(versionTmp, { recursive: true });
	const ompVersion = captureOmpVersion(ompPath, versionHome, versionTmp);
	const ompVersionPath = join(input.workDir, "omp-version.txt");
	writeFileSync(ompVersionPath, `${ompVersion}\n`);
	const beforeSnapshot = metadataDigest(realOmpRoot);
	const matrix: IntegrationVerdict[] = [];
	const runId = `${process.pid}-${Date.now()}`;
	for (const profile of input.profiles) {
		const wiring = readProfileWiring(input.home, profile);
		for (const integration of INTEGRATIONS) {
			if (input.integrations !== undefined && !input.integrations.includes(integration)) continue;
			const profileConfig = join(input.home, ".omp/profiles", profile, "agent/config.yml");
			const profileEvidence = [profileConfig];
			const mcpConfig = join(input.home, ".omp/profiles", profile, "agent/mcp.json");
			if (existsSync(mcpConfig)) profileEvidence.push(mcpConfig);
			const source = sourceForIntegration(wiring, integration);
			const still = staticVerdict(wiring, integration);
			if (still) {
				if (source) still.source = source;
				still.evidence = [...profileEvidence, ...(source ? [source.path] : [])];
				matrix.push(still);
				continue;
			}
			const fire = scenarios.find(s => s.integration === integration && s.kind === "fire");
			const quiet = scenarios.find(s => s.integration === integration && s.kind === "quiet") ?? null;
			if (!fire) {
				matrix.push({ profile, integration, verdict: "ABSENT", detail: "no fire scenario defined",
					evidence: [...profileEvidence, ...(source ? [source.path] : [])] });
				continue;
			}
			const stamp = `${profile}-${integration}-${runId}`;
			const repo = join(input.workDir, `repo-${stamp}`);
			// Branch names must not embed the integration: shell errors echo the
			// path, and judge regexes would self-match their own evidence.
			const branch = `itg-${profile}-${runId}`;
			const marker = integration === "fleet-guard" ? join("/tmp", `${branch}.txt`) : join(repo, "marker.txt");
			const vars: Record<string, string> = { BRANCH: branch, MARKER: marker };
			setupScenarioRepo(repo, fire.setup, vars);
			const fireAttempt = await runLiveScenario({ ...input, profile, repo }, fire, vars);
			let quietAttempt: LiveAttempt | null = null;
			if (quiet) {
				const quietRepo = `${repo}-quiet`;
				const quietMarker = integration === "fleet-guard"
					? join("/tmp", `${branch}-quiet.txt`) : join(quietRepo, "marker.txt");
				const quietVars = { ...vars, MARKER: quietMarker };
				setupScenarioRepo(quietRepo, quiet.setup, quietVars);
				quietAttempt = await runLiveScenario({ ...input, profile, repo: quietRepo }, quiet, quietVars);
			}
			const judgeInput: JudgeInput = { fire: fireAttempt, quiet: quietAttempt, repo, vars };
			const judge = integration === "kit-guard" ? judgeKitGuard : JUDGES[integration];
			if (!judge) {
				matrix.push({ profile, integration, verdict: "ABSENT", detail: "no judge implemented", evidence: profileEvidence });
				continue;
			}
			const verdict = judge(judgeInput);
			const quietResult = assessQuiet(quietAttempt);
			if (quietResult?.outcome === "BLOCKED" && verdict.verdict === "WIRED") {
				verdict.verdict = "CONFIGURED_NOT_FIRING";
				verdict.detail += `; quiet scenario failed: ${quietResult.detail}`;
			}
			verdict.quiet = quietResult;
			if (source) verdict.source = source;
			verdict.evidence = [...new Set([
				...profileEvidence,
				...fireAttempt.evidencePaths,
				...(quietAttempt?.evidencePaths ?? []),
				...(source ? [source.path] : []),
			])];
			matrix.push(verdict);
		}
	}
	const afterSnapshot = metadataDigest(realOmpRoot);
	const realOmpIntegrityPath = join(input.workDir, "real-omp-integrity.json");
	const complete = beforeSnapshot.complete && afterSnapshot.complete;
	const realOmpIntegrity = {
		path: realOmpIntegrityPath,
		homeOmpPath: realOmpRoot,
		beforeSha256: beforeSnapshot.sha256,
		afterSha256: afterSnapshot.sha256,
		complete,
		unchanged: complete && beforeSnapshot.sha256 === afterSnapshot.sha256,
	};
	if (!realOmpIntegrity.unchanged) {
		for (const verdict of matrix) {
			if (verdict.verdict !== "WIRED") continue;
			verdict.verdict = "CONFIGURED_NOT_FIRING";
			verdict.detail += "; ~/.omp integrity snapshot was incomplete or changed";
		}
	}
	writeFileSync(realOmpIntegrityPath, `${JSON.stringify(realOmpIntegrity, null, 2)}\n`);
	for (const verdict of matrix) verdict.evidence = [...new Set([...verdict.evidence, ompVersionPath, realOmpIntegrityPath])];
	const report: IntegrationsReport = {
		profiles: [...input.profiles],
		ompVersion,
		realOmpIntegrity,
		limitations: [
			"Mock-model results prove only the named profile configurations and reported OMP version.",
			"They do not prove real-model tool choice, other profiles, or global safety.",
			"~/.omp unchanged compares metadata-tree fingerprints, not full file-content hashes.",
		],
		matrix,
	};
	if (input.out !== undefined) {
		writeFileSync(input.out, `${JSON.stringify({ overall: "OK", integrations: report }, null, 2)}\n`);
	}
	return report;
}

/** Scratch repo contents each scenario kind needs. */
export function setupScenarioRepo(repo: string, setup: string[], vars: Record<string, string>): void {
	setupGitRepo(repo);
	if (setup.includes("git-branch")) {
		git(repo, ["checkout", "-b", vars["BRANCH"] ?? "itg-branch"]);
		writeFileSync(join(repo, "branch.txt"), "branch\n");
		git(repo, ["add", "branch.txt"]);
		git(repo, ["commit", "-m", "branch [test]"]);
		git(repo, ["checkout", "main"]);
	}
	if (setup.includes("git-dirty")) {
		writeFileSync(join(repo, "dirty.txt"), "dirty\n");
		vars["HEAD"] = headSha(repo);
	}
	if (setup.includes("kit-guard-optin")) {
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp/kit-guard.json"), "{}\n");
	}
	if (setup.includes("cargo-crate")) {
		writeFileSync(join(repo, "Cargo.toml"), '[package]\nname = "itg-crate"\nversion = "0.0.0"\nedition = "2021"\n');
		mkdirSync(join(repo, "src"), { recursive: true });
		writeFileSync(join(repo, "src/main.rs"), 'fn main() {}\n');
	}
}
