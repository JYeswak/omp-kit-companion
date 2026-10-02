import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

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
	/** Subset of integrations to prove; defaults to all five. */
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

export interface IntegrationVerdict {
	profile: string;
	integration: string;
	verdict: IntegrationCell;
	detail: string;
	evidence: string[];
}

export interface IntegrationsReport {
	profiles: string[];
	matrix: IntegrationVerdict[];
}

export class IntegrationsInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "IntegrationsInputError";
	}
}

export const INTEGRATIONS = ["dcg", "slb", "rch", "mcp-agent-mail", "kit-guard"] as const;

const EXTENSION_FILE_BY_INTEGRATION: Record<string, string[]> = {
	dcg: ["dcg-tool-bridge.ts"],
	slb: ["slb-guard-fail-closed.ts"],
	rch: ["rch-mutator.ts"],
	"kit-guard": ["kit-guard-optin.ts"],
};

interface ScenarioDef {
	integration: string;
	kind: "fire" | "quiet";
	setup: string[];
	turns: unknown[];
}

function loadScenarios(root: string): ScenarioDef[] {
	const parsed: unknown = JSON.parse(readFileSync(join(root, "tests/live/integrations.json"), "utf8"));
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

/** Extension basenames the profile config lists, from real config.yml lines. */
export function listedExtensions(configText: string): string[] {
	const names: string[] = [];
	let inList = false;
	for (const line of configText.split("\n")) {
		if (/^extensions:\s*$/.test(line)) {
			inList = true;
			continue;
		}
		if (inList) {
			const match = /^  - (\S+)\s*$/.exec(line);
			if (match) {
				names.push((match[1] ?? "").split("/").pop() ?? "");
				continue;
			}
			if (line.trim() !== "" && !line.startsWith(" ")) break;
		}
	}
	return names.filter(name => name.length > 0);
}

export interface ProfileWiring {
	profile: string;
	extensions: string[];
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
	return { profile, extensions, hooks, mcpServers, mcpDisabled,
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

/** Run one scripted mock-model turn set against a profile in an isolated HOME. */
export async function runLiveScenario(input: IntegrationsInput & { profile: string },
	scenario: ScenarioDef, vars: Record<string, string>): Promise<LiveAttempt> {
	const kind = scenario.kind;
	const integration = scenario.integration;
	const runRoot = join(input.workDir, `itg-${input.profile}-${integration}-${kind}`);
	const home = join(runRoot, "home");
	const repo = join(runRoot, "repo");
	mkdirSync(home, { recursive: true });
	mkdirSync(repo, { recursive: true });
	const agentDir = join(input.home, ".omp/profiles", input.profile, "agent");
	cpSync(join(agentDir, "config.yml"), join(home, "config.yml.tmp"));
	mkdirSync(join(home, ".omp/profiles", input.profile, "agent"), { recursive: true });
	copyFileSync(join(agentDir, "config.yml"), join(home, ".omp/profiles", input.profile, "agent/config.yml"));
	for (const file of ["mcp.json"]) {
		const src = join(agentDir, file);
		if (existsSync(src)) copyFileSync(src, join(home, ".omp/profiles", input.profile, `agent/${file}`));
	}
	const hooksSrc = join(agentDir, "hooks");
	if (existsSync(hooksSrc)) cpSync(hooksSrc, join(home, ".omp/profiles", input.profile, "agent/hooks"), { recursive: true });
	const scenarioFile = join(runRoot, "scenario.json");
	writeFileSync(scenarioFile, JSON.stringify({ turns: expandVars(scenario.turns, vars), chunk: 6 }));
	const mockLog = join(runRoot, "mock.log");
	const portFile = join(runRoot, "port.txt");
	const mock = Bun.spawn(["bun", join(input.root, "tests/live/mock-model.mjs")], {
		cwd: input.root,
		env: { ...process.env, SCEN: scenarioFile, LOG: mockLog, PORTFILE: portFile },
		stdout: "pipe",
		stderr: "pipe",
	});
	const mockReady = await waitForFile(portFile, 10000);
	if (!mockReady) {
		try {
			mock.kill(9);
		} catch { /* already gone */ }
		throw new IntegrationsInputError("INTEGRATIONS_UNAVAILABLE", "Mock model server did not start");
	}
	const port = readFileSync(portFile, "utf8").trim();
	writeFileSync(join(home, ".omp/profiles", input.profile, "agent/models.yml"), [
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
	const ompPath = input.ompPath ?? "omp";
	const timeoutMs = (input.timeoutSecs ?? 120) * 1000;
	const child = Bun.spawn([ompPath, "--profile", input.profile, "-p", "--no-session",
		"--model", "mock/mock", "--approval-mode", "yolo", "go"], {
		cwd: repo,
		env: cleanEnv(home),
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
	let mockText = "";
	try {
		mockText = readFileSync(mockLog, "utf8");
	} catch { /* no requests reached the mock */ }
	try {
		mock.kill(9);
	} catch { /* already gone */ }
	await mock.exited;
	const marker = vars["MARKER"] ?? join(repo, "marker.txt");
	return { profile: input.profile, integration, kind, rc: code ?? 1, stdout, stderr,
		mockLog: mockText, workRepo: repo, marker, timedOut };
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
function cleanEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env["HOME"] = home;
	env["XDG_CONFIG_HOME"] = join(home, ".config");
	env["XDG_CACHE_HOME"] = join(home, ".cache");
	env["XDG_DATA_HOME"] = join(home, ".local/share");
	env["XDG_STATE_HOME"] = join(home, ".local/state");
	env["GIT_CONFIG_NOSYSTEM"] = "1";
	delete env["OMP_PROFILE"];
	delete env["PI_PROFILE"];
	delete env["PI_CODING_AGENT_DIR"];
	delete env["OMPCODE"];
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
	if (/mcp__mcp_agent_mail__health_check/i.test(blob) && /"ok"|healthy|uptime|version/i.test(blob)) {
		return { ...base, verdict: "WIRED", detail: "health_check answered through the profile MCP server", evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING",
		detail: input.fire.timedOut ? "no health answer before the timeout" : "health_check did not answer", evidence: [] };
}

function judgeKitGuard(input: JudgeInput, markerPresent: boolean): IntegrationVerdict {
	const base = { profile: input.fire.profile, integration: "kit-guard", evidence: [] as string[] };
	const load = loadErrorOf(input.fire.stderr, "kit-guard");
	if (load) return { ...base, verdict: "LOAD_ERROR", detail: `extension failed to load: ${load}`, evidence: [] };
	if (!markerPresent) {
		return { ...base, verdict: "WIRED", detail: "opted-in repo: tool call refused, marker absent", evidence: [] };
	}
	return { ...base, verdict: "CONFIGURED_NOT_FIRING", detail: "opted-in repo: tool call executed", evidence: [] };
}

const JUDGES: Record<string, (input: JudgeInput) => IntegrationVerdict> = {
	dcg: judgeDcg,
	slb: judgeSlb,
	rch: judgeRch,
	"mcp-agent-mail": judgeMcp,
};

/** Full per-profile matrix: static ABSENT short-circuits, otherwise live fire+quiet. */
export async function runIntegrations(input: IntegrationsInput): Promise<IntegrationsReport> {
	if (![input.root, input.home, input.workDir].every(value => typeof value === "string" && isAbsolute(value))) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Release root, HOME and work dir must be absolute paths");
	}
	if (input.profiles.length === 0) {
		throw new IntegrationsInputError("INVALID_INTEGRATIONS_SELECTION", "Name at least one profile");
	}
	const scenarios = loadScenarios(input.root);
	const ompPath = input.ompPath ?? "omp";
	const matrix: IntegrationVerdict[] = [];
	for (const profile of input.profiles) {
		const wiring = readProfileWiring(input.home, profile);
		for (const integration of INTEGRATIONS) {
			if (input.integrations !== undefined && !input.integrations.includes(integration)) continue;
			const still = staticVerdict(wiring, integration);
			if (still) {
				matrix.push(still);
				continue;
			}
			const fire = scenarios.find(s => s.integration === integration && s.kind === "fire");
			const quiet = scenarios.find(s => s.integration === integration && s.kind === "quiet") ?? null;
			if (!fire) {
				matrix.push({ profile, integration, verdict: "ABSENT", detail: "no fire scenario defined", evidence: [] });
				continue;
			}
			const stamp = `${profile}-${integration}`;
			const repo = join(input.workDir, `repo-${stamp}`);
			const vars: Record<string, string> = {
				BRANCH: `itg-${stamp}`,
				MARKER: join(repo, "marker.txt"),
			};
			setupScenarioRepo(repo, fire.setup, vars);
			const fireAttempt = await runLiveScenario({ ...input, profile }, fire, vars);
			let quietAttempt: LiveAttempt | null = null;
			if (quiet) {
				const quietRepo = `${repo}-quiet`;
				const quietVars = { ...vars, MARKER: join(quietRepo, "marker.txt") };
				setupScenarioRepo(quietRepo, quiet.setup, quietVars);
				quietAttempt = await runLiveScenario({ ...input, profile }, quiet, quietVars);
			}
			const judgeInput: JudgeInput = { fire: fireAttempt, quiet: quietAttempt, repo, vars };
			if (integration === "kit-guard") {
				matrix.push(judgeKitGuard(judgeInput, existsSync(vars["MARKER"] ?? "")));
				continue;
			}
			const judge = JUDGES[integration];
			if (!judge) {
				matrix.push({ profile, integration, verdict: "ABSENT", detail: "no judge implemented", evidence: [] });
				continue;
			}
			matrix.push(judge(judgeInput));
		}
	}
	const report: IntegrationsReport = { profiles: [...input.profiles], matrix };
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
