import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOmpIdentity } from "./paths.ts";
import { run, runSync, type RunResult } from "./kitlib/run.ts";
import { isRecord } from "./type-guards.ts";

export const SPAWN_MODEL_REFUSED = "SPAWN_MODEL_REFUSED";
const DECISIONS = "J-2026-10-18-33, J-2026-11-05-15, J-2026-11-05-16";
const FIX = 'write cfg://task/agentModelOverrides/save {"task":"openai-codex/gpt-6.1-sol"}';
export type ModelPattern = string | string[];
export interface SpawnModelIdentity { provider: string; id: string }
export interface SpawnAgentDefinition { name: string; model?: ModelPattern }
interface ModelSelectionInput {
	requestModel?: ModelPattern;
	settingsOverride?: ModelPattern;
	agentModel?: ModelPattern;
	activeModelPattern?: string;
}

/** Read-only inputs to the pure resolver. The two functions are OMP's native
 * pattern selection and the calling session's read-only model query, not a
 * second implementation of role expansion, fuzzy matching or provider routing. */
export interface SpawnModelSettings {
	agentModelOverrides: Readonly<Record<string, unknown>>;
	selectPatterns(options: ModelSelectionInput): readonly string[];
	resolve(patterns: string): SpawnModelIdentity | undefined;
}
export type TaskModelResolution = {
	index: number;
	agent: string;
	patterns: readonly string[];
} & ({ model: string; reason?: never } | { model?: string; reason: string });

function modelPattern(value: unknown): ModelPattern | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
	return undefined;
}

/** J-2026-10-18-33 forbids Opus-class, including provider-routed Opus IDs.
 * The cited decisions do not classify Fable or Mythos as premium. */
export function isOpusClass(model: string): boolean {
	const value = model.toLowerCase();
	for (let at = value.indexOf("opus"); at !== -1; at = value.indexOf("opus", at + 4)) {
		if ((at === 0 || "/_-".includes(value[at - 1]!))
			&& (at + 4 === value.length || "/_:@-".includes(value[at + 4]!))) return true;
	}
	return false;
}

/** Also consumes core's before_subagent_spawn patterns, which already include
 * session-only settings and session-local agent definitions. */
export function resolveSpawnPatterns(index: number, agent: string, patterns: readonly string[], resolve: SpawnModelSettings["resolve"]): TaskModelResolution {
	if (patterns.length === 0) return { index, agent, patterns, reason: "MODEL_SELECTOR_UNRESOLVED" };
	try {
		const selected = resolve(patterns.join(","));
		const model = selected ? `${selected.provider}/${selected.id}` : undefined;
		if (patterns.some(isOpusClass)) return { index, agent, patterns, model, reason: "OPUS_CLASS_CANDIDATE" };
		if (!model) return { index, agent, patterns, reason: "MODEL_UNAVAILABLE" };
		if (isOpusClass(model)) return { index, agent, patterns, model, reason: "OPUS_CLASS_RESOLVED" };
		return { index, agent, patterns, model };
	} catch {
		return { index, agent, patterns, reason: "MODEL_RESOLUTION_FAILED" };
	}
}

/** Pure: no filesystem, environment, registry refresh, credentials or model calls.
 * OMP selects per-call > exact-name settings override > agent definition >
 * parent. Native selectPatterns preserves @task/@default's special semantics.
 * Every batch item is checked, even when an earlier item is inexpensive. */
export function resolveTaskModels(input: unknown, definitions: readonly SpawnAgentDefinition[], settings: SpawnModelSettings, parentModel?: string): TaskModelResolution[] {
	if (!isRecord(input)) return [{ index: 0, agent: "task", patterns: [], reason: "INVALID_TASK_INPUT" }];
	const items = Array.isArray(input.tasks) ? input.tasks : [input];
	if (items.length === 0) return [{ index: 0, agent: "task", patterns: [], reason: "EMPTY_TASK_BATCH" }];
	return items.map((item, index): TaskModelResolution => {
		const agent = isRecord(item) && typeof item.agent === "string" && item.agent.trim() ? item.agent.trim() : "task";
		const failure = (reason: string, patterns: readonly string[] = []): TaskModelResolution => ({ index, agent, patterns, reason });
		if (!isRecord(item)) return failure("INVALID_TASK_ITEM");
		const definition = definitions.find(candidate => candidate.name === agent);
		if (!definition) return failure("AGENT_DEFINITION_UNOBSERVABLE");
		if (item.sourceSession !== undefined && item.model === undefined) return failure("HISTORICAL_MODEL_UNOBSERVABLE");
		const requestModel = modelPattern(item.model);
		if (item.model !== undefined && requestModel === undefined) return failure("INVALID_REQUEST_MODEL");
		const override = settings.agentModelOverrides[agent];
		const settingsOverride = modelPattern(override);
		if (override !== undefined && settingsOverride === undefined) return failure("INVALID_MODEL_OVERRIDE");
		try {
			const patterns = settings.selectPatterns({ requestModel, settingsOverride, agentModel: definition.model, activeModelPattern: parentModel });
			return resolveSpawnPatterns(index, agent, patterns, settings.resolve);
		} catch {
			return failure("MODEL_RESOLUTION_FAILED");
		}
	});
}

export function taskModelRefusal(resolutions: readonly TaskModelResolution[]): string | undefined {
	const failed = resolutions.find(result => result.reason !== undefined);
	if (!failed) return undefined;
	return `${SPAWN_MODEL_REFUSED}: task ${failed.index + 1} (${failed.agent}) ${failed.reason}; model=${failed.model ?? (failed.patterns.join(",") || "UNKNOWN")}. `
		+ `Chief/director background agents must not run Opus-class (${DECISIONS}). This child was refused before it started. `
		+ `Save the restart-safe override with \`${FIX}\`, or save an override for the named agent (for example a Muse model); then retry. An unresolvable selector must be repaired, never silently inherited.`;
}

/** Narrow view of native Settings; importing the selected OMP installation is
 * deliberate: a stale Bun global package can differ from the running Tern OMP. */
export interface NativeSpawnSettings {
	reloadFromDisk(): Promise<void>;
	getCwd(): string;
	getAgentDir(): string;
	getModelRoles(): Readonly<Record<string, string>>;
}
export interface SpawnModelRuntime {
	Settings: {
		loadReadOnly(options: { cwd: string; agentDir?: string }): Promise<NativeSpawnSettings>;
		isolated(overrides?: Readonly<Record<string, unknown>>): NativeSpawnSettings;
	};
	findScopedSettings(cwd?: string, agentDir?: string): NativeSpawnSettings | undefined;
	cfgTaskAgentModelOverrides: {
		get(settings: NativeSpawnSettings): Readonly<Record<string, unknown>>;
		override(settings: NativeSpawnSettings, value: Record<string, ModelPattern>): void;
	};
	resolveAgentModelSelection(options: ModelSelectionInput & { settings: NativeSpawnSettings }): { patterns: string[] };
	resolveModelRoleValue(patterns: string, availableModels: readonly SpawnModelIdentity[], options: { settings: NativeSpawnSettings }): { model?: SpawnModelIdentity };
	discoverAgents(cwd: string, home?: string): Promise<{ agents: SpawnAgentDefinition[] }>;
	source: string;
}
let nativeRuntime: Promise<SpawnModelRuntime> | undefined;

export function loadSpawnModelRuntime(): Promise<SpawnModelRuntime> {
	return nativeRuntime ??= (async () => {
		const { source } = resolveOmpIdentity();
		const [settings, resolver, taskSettings, discovery] = await Promise.all([
			import(pathToFileURL(join(source, "config/settings.ts")).href),
			import(pathToFileURL(join(source, "config/model-resolver.ts")).href),
			import(pathToFileURL(join(source, "task/settings.ts")).href),
			import(pathToFileURL(join(source, "task/discovery.ts")).href),
		]);
		return { Settings: settings.Settings, findScopedSettings: settings.findScopedSettings,
			cfgTaskAgentModelOverrides: taskSettings.cfgTaskAgentModelOverrides,
			resolveAgentModelSelection: resolver.resolveAgentModelSelection,
			resolveModelRoleValue: resolver.resolveModelRoleValue,
			discoverAgents: discovery.discoverAgents, source };
	})();
}

export function nativeSpawnModelSettings(runtime: SpawnModelRuntime, settings: NativeSpawnSettings, resolve: SpawnModelSettings["resolve"]): SpawnModelSettings {
	return {
		agentModelOverrides: runtime.cfgTaskAgentModelOverrides.get(settings),
		selectPatterns: options => runtime.resolveAgentModelSelection({ ...options, settings }).patterns,
		resolve,
	};
}

type SpawnModelScopeRuntime = Pick<SpawnModelRuntime, "findScopedSettings" | "cfgTaskAgentModelOverrides">;
export interface SpawnModelSessionSnapshot {
	agentModelOverrides: Readonly<Record<string, unknown>>;
	modelRoles: Readonly<Record<string, string>>;
}
interface SpawnModelInputOptions {
	loadRuntime?: () => Promise<SpawnModelRuntime>;
	loadScope?: () => Promise<SpawnModelScopeRuntime>;
	/** Called inside the live extension handler's native settings scope. */
	observeSession?: () => Promise<SpawnModelSessionSnapshot | undefined>;
	source?: string;
}

/** Only standalone Bun may infer scope from source modules. A compiled host
 * must supply its live scope from the extension entrypoint: OMP rewrites host
 * imports there, not in arbitrary absolute-imported helper modules. */
async function loadSpawnModelScope(source: string): Promise<SpawnModelScopeRuntime> {
	const bun = Bun.which("bun");
	if (!bun || realpathSync(bun) !== realpathSync(process.execPath)) {
		throw new Error("compiled host must supply observable session settings from its extension API");
	}
	const [settings, taskSettings] = await Promise.all([
		import(pathToFileURL(join(source, "config/settings.ts")).href),
		import(pathToFileURL(join(source, "task/settings.ts")).href),
	]);
	return { findScopedSettings: settings.findScopedSettings, cfgTaskAgentModelOverrides: taskSettings.cfgTaskAgentModelOverrides };
}

/** Capture effective live values, including overlays/runtime, not disk-only data.
 * Never substitute the global singleton: concurrent sessions may share a cwd. */
export async function readSpawnModelSession(cwd: string, home = homedir(), loadScope?: () => Promise<SpawnModelScopeRuntime>): Promise<SpawnModelSessionSnapshot | undefined> {
	try {
		const scope = await (loadScope?.() ?? loadSpawnModelScope(resolveOmpIdentity().source));
		const scoped = scope.findScopedSettings(cwd, home === homedir() ? undefined : join(home, ".omp", "agent"));
		if (!scoped) {
			if (loadScope) throw new Error("host exposes no active session settings");
			return undefined;
		}
		await scoped.reloadFromDisk();
		return { agentModelOverrides: scope.cfgTaskAgentModelOverrides.get(scoped), modelRoles: scoped.getModelRoles() };
	} catch (error) {
		throw new Error(`SESSION_SCOPE_UNOBSERVABLE: host exposes no readable session settings: ${String(error)}`, { cause: error });
	}
}

// The read uses native discovery/config loading; selection is a short leaf
// command over an isolated snapshot (no disk discovery or descendant processes).
// Only patterns cross this boundary. Credential/model resolution stays in the host.
const SPAWN_MODEL_READ_SCRIPT = `
const request = JSON.parse(process.argv.at(-1));
const moduleUrl = path => new URL(path + ".ts", request.sourceUrl).href;
const { Settings } = await import(moduleUrl("config/settings"));
const { cfgTaskAgentModelOverrides } = await import(moduleUrl("task/settings"));
const settings = request.snapshot ? Settings.isolated(request.snapshot)
	: await Settings.loadReadOnly({ cwd: request.cwd, ...(request.agentDir ? { agentDir: request.agentDir } : {}) });
if (request.selection) {
	const { resolveAgentModelSelection } = await import(moduleUrl("config/model-resolver"));
	console.log(JSON.stringify({ patterns: resolveAgentModelSelection({ ...request.selection, settings }).patterns }));
} else {
	const { discoverAgents } = await import(moduleUrl("task/discovery"));
	const { agents } = await discoverAgents(request.cwd, request.home);
	console.log(JSON.stringify({ agents, agentModelOverrides: cfgTaskAgentModelOverrides.get(settings), modelRoles: settings.getModelRoles() }));
}
`;
const SPAWN_MODEL_READ_BOUNDS = { deadline_s: 10, max_output_bytes: 1024 * 1024 };

function subprocessData(result: RunResult): Record<string, unknown> {
	const stderr = new TextDecoder().decode(result.stderr).trim();
	if (result.rc !== 0 || result.timed_out || result.killed || result.truncated || result.total_truncated) {
		throw new Error(`standalone Bun spawn-model read failed (exit=${result.rc}, timeout=${result.timed_out}, truncated=${result.truncated}): ${stderr}`);
	}
	try {
		const data: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
		if (isRecord(data)) return data;
	} catch (error) {
		throw new Error(`invalid standalone Bun spawn-model output: ${String(error)}; stderr: ${stderr}`, { cause: error });
	}
	throw new Error(`invalid standalone Bun spawn-model output; stderr: ${stderr}`);
}

async function readSpawnModelSubprocess(cwd: string, resolve: SpawnModelSettings["resolve"], home: string, agentDir: string | undefined, options: SpawnModelInputOptions) {
	const { source } = resolveOmpIdentity();
	const observed = options.observeSession
		? await options.observeSession()
		: await readSpawnModelSession(cwd, home, options.loadScope);
	const snapshot = observed ? {
		"task.agentModelOverrides": observed.agentModelOverrides,
		modelRoles: observed.modelRoles,
	} : undefined;
	const request = { sourceUrl: pathToFileURL(`${options.source ?? source}/`).href, cwd, home, agentDir, snapshot };
	const argv = (data: object) => ["bun", "--eval", SPAWN_MODEL_READ_SCRIPT, JSON.stringify(data)];
	const data = subprocessData(await run(argv(request), { ...SPAWN_MODEL_READ_BOUNDS, cwd }));
	if (!Array.isArray(data.agents) || !data.agents.every(agent => isRecord(agent) && typeof agent.name === "string" && (agent.model === undefined || modelPattern(agent.model) !== undefined))
		|| !isRecord(data.agentModelOverrides) || !isRecord(data.modelRoles)) throw new Error("invalid standalone Bun spawn-model inputs");
	const agents: SpawnAgentDefinition[] = data.agents.map(agent => ({ name: agent.name, model: modelPattern(agent.model) }));
	const selectionSnapshot = { "task.agentModelOverrides": data.agentModelOverrides, modelRoles: data.modelRoles };
	return {
		agents,
		settings: {
			agentModelOverrides: data.agentModelOverrides,
			selectPatterns: (selection: ModelSelectionInput): readonly string[] => {
				const selected = subprocessData(runSync(argv({ ...request, snapshot: selectionSnapshot, selection }), SPAWN_MODEL_READ_BOUNDS));
				if (!Array.isArray(selected.patterns) || !selected.patterns.every(pattern => typeof pattern === "string")) throw new Error("invalid standalone Bun spawn-model patterns");
				return selected.patterns;
			},
			resolve,
		},
		scope: "subprocess" as const,
	};
}

/** Native loading supplies global config -> project -> overlays/runtime. A
 * standalone-Bun fallback explicitly carries observable session overrides and
 * roles, or refuses when the host scope cannot be observed. It never claims
 * session equivalence, opens agent.db, or writes operator settings. */
export async function readSpawnModelInputs(cwd: string, resolve: SpawnModelSettings["resolve"], home = homedir(), options: SpawnModelInputOptions = {}): Promise<{ agents: SpawnAgentDefinition[]; settings: SpawnModelSettings; scope: "session" | "disk" | "subprocess" }> {
	const agentDir = home === homedir() ? undefined : join(home, ".omp", "agent");
	let runtime: SpawnModelRuntime;
	try {
		runtime = await (options.loadRuntime ?? loadSpawnModelRuntime)();
	} catch (error) {
		try {
			return await readSpawnModelSubprocess(cwd, resolve, home, agentDir, options);
		} catch (fallbackError) {
			throw new Error(`spawn-model host import failed: ${String(error)}; fallback failed: ${String(fallbackError)}`, { cause: fallbackError });
		}
	}
	const scoped = runtime.findScopedSettings(cwd, agentDir);
	const settings = scoped ?? await runtime.Settings.loadReadOnly({ cwd, ...(agentDir ? { agentDir } : {}) });
	if (scoped) await settings.reloadFromDisk();
	const { agents } = await runtime.discoverAgents(cwd, home);
	return { agents, settings: nativeSpawnModelSettings(runtime, settings, resolve), scope: scoped ? "session" : "disk" };
}
