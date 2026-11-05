import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOmpIdentity } from "./paths.ts";
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

/** Native loading supplies global config -> project -> overlays/runtime. The
 * scoped instance, when observable in extension execution, retains session-only
 * overrides. The read-only fallback uses OMP's own config filenames/discovery,
 * never opens agent.db, and never writes migrations or operator settings. */
export async function readSpawnModelInputs(cwd: string, resolve: SpawnModelSettings["resolve"], home = homedir()): Promise<{ agents: SpawnAgentDefinition[]; settings: SpawnModelSettings; scope: "session" | "disk" }> {
	const runtime = await loadSpawnModelRuntime();
	const agentDir = home === homedir() ? undefined : join(home, ".omp", "agent");
	const scoped = runtime.findScopedSettings(cwd, agentDir);
	const settings = scoped ?? await runtime.Settings.loadReadOnly({ cwd, ...(agentDir ? { agentDir } : {}) });
	if (scoped) await settings.reloadFromDisk();
	const { agents } = await runtime.discoverAgents(cwd, home);
	return { agents, settings: nativeSpawnModelSettings(runtime, settings, resolve), scope: scoped ? "session" : "disk" };
}
