import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "./kitlib/tmp.ts";
import { isOpusClass, loadSpawnModelRuntime, nativeSpawnModelSettings, readSpawnModelInputs, resolveTaskModels, taskModelRefusal, type SpawnAgentDefinition } from "./spawn-model.ts";

const runtime = await loadSpawnModelRuntime();
// Catalog location is selected by the installed OMP, not by this checkout.
const { getBundledModels } = await import(import.meta.resolve("@oh-my-pi/pi-catalog/models", join(runtime.source, "index.ts")));
const models = ["anthropic", "openai-codex", "muse-code"].flatMap(provider => getBundledModels(provider));
const SOL = "openai-codex/gpt-6.1-sol";
const OPUS = "anthropic/claude-opus-5-5";
const MUSE = "muse-code/muse-spark-1.3-contributor";
const agents: SpawnAgentDefinition[] = [{ name: "task" }, { name: "muse-worker", model: MUSE }];
const task = { context: "Read-only analysis", tasks: [{ task: "Analyze the input" }] };

function settings(overrides: Readonly<Record<string, unknown>> = {}) {
	const native = runtime.Settings.isolated(overrides);
	return nativeSpawnModelSettings(runtime, native, patterns => runtime.resolveModelRoleValue(patterns, models, { settings: native }).model);
}

function resolution(overrides: Readonly<Record<string, unknown>> = {}, input: unknown = task) {
	return resolveTaskModels(input, agents, settings(overrides), OPUS);
}

const base = ownedTmp("spawn-model-test").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("AGENTMODEL1 native task model resolution", () => {
	test("planted: missing override inherits Opus and refuses before spawn", () => {
		const resolved = resolution();
		expect(resolved[0]).toMatchObject({ agent: "task", model: OPUS, patterns: [OPUS], reason: "OPUS_CLASS_CANDIDATE" });
		const reason = taskModelRefusal(resolved);
		expect(reason).toContain("SPAWN_MODEL_REFUSED");
		for (const id of ["J-2026-10-18-33", "J-2026-11-05-15", "J-2026-11-05-16"]) expect(reason).toContain(id);
		expect(reason).toContain('write cfg://task/agentModelOverrides/save {"task":"openai-codex/gpt-6.1-sol"}');
	});

	test("planted: an explicit Opus settings override defeats a cheap agent definition and is refused", () => {
		const resolved = resolution({ "task.agentModelOverrides": { "muse-worker": OPUS } }, { tasks: [{ agent: "muse-worker", task: "Read" }] });
		expect(resolved[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
	});

	test("control: saved Sol override is admitted despite an Opus parent", () => {
		const resolved = resolution({ "task.agentModelOverrides": { task: SOL } });
		expect(resolved[0]?.model).toBe(SOL);
		expect(taskModelRefusal(resolved)).toBeUndefined();
	});

	test("control: an explicit per-agent Muse definition is admitted", () => {
		const resolved = resolution({}, { tasks: [{ agent: "muse-worker", task: "Read" }] });
		expect(resolved[0]?.model).toBe(MUSE);
		expect(taskModelRefusal(resolved)).toBeUndefined();
	});

	test("per-call model precedes settings override; flat input also resolves", () => {
		expect(resolution({ "task.agentModelOverrides": { task: OPUS } }, { task: "Read", model: SOL })[0]?.model).toBe(SOL);
		expect(resolution({ "task.agentModelOverrides": { task: SOL } }, { tasks: [{ task: "Read", model: OPUS }] })[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
	});

	test("batch top-level model is not a per-item override in OMP", () => {
		expect(resolution({}, { ...task, model: SOL })[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
	});

	test("native @task role selection and @default inheritance are preserved", () => {
		const native = settings({ modelRoles: { task: SOL, default: SOL } });
		expect(resolveTaskModels(task, [{ name: "task", model: "@task" }], native, OPUS)[0]?.model).toBe(SOL);
		expect(resolveTaskModels(task, [{ name: "task", model: "@default" }], native, OPUS)[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
	});

	test("every batch member and fallback candidate is checked", () => {
		const batch = resolution({}, { tasks: [{ agent: "muse-worker", task: "Read" }, { task: "Read" }] });
		expect(batch[0]?.model).toBe(MUSE);
		expect(batch[1]?.reason).toBe("OPUS_CLASS_CANDIDATE");
		expect(taskModelRefusal(batch)).toContain("task 2");
		expect(resolution({ "task.agentModelOverrides": { task: [SOL, OPUS] } })[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
	});

	test("unreachable provider, missing agent and malformed override fail closed by name", () => {
		expect(resolution({ "task.agentModelOverrides": { task: "unreachable-provider/no-model" } })[0]?.reason).toBe("MODEL_UNAVAILABLE");
		expect(resolution({}, { tasks: [{ agent: "missing", task: "Read" }] })[0]?.reason).toBe("AGENT_DEFINITION_UNOBSERVABLE");
		expect(resolution({ "task.agentModelOverrides": { task: 17 } })[0]?.reason).toBe("INVALID_MODEL_OVERRIDE");
		expect(resolveTaskModels(task, agents, settings())[0]?.reason).toBe("MODEL_SELECTOR_UNRESOLVED");
		expect(resolution({}, { tasks: [{ agent: "task", task: "Read", sourceSession: "prior-session" }] })[0]?.reason).toBe("HISTORICAL_MODEL_UNOBSERVABLE");
	});

	test("Opus family boundaries and long near-miss do not classify unrelated names", () => {
		for (const model of [OPUS, "anthropic/claude-opus-9-1", "openrouter/anthropic/claude-opus-5-5", "ANTHROPIC/CLAUDE-OPUS-5-5:max"]) expect(isOpusClass(model)).toBe(true);
		for (const model of [SOL, MUSE, "vendor/octopus", "vendor/opuslike", "anthropic/claude-fable-5-1", "anthropic/claude-mythos-5-1"]) expect(isOpusClass(model)).toBe(false);
		const started = performance.now();
		expect(isOpusClass("notopus".repeat(100_000))).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test("native read-only config loading uses project override over persisted global", async () => {
		const home = join(base, "home"), project = join(base, "project"), agentDir = join(home, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, ".omp"), { recursive: true });
		writeFileSync(join(agentDir, "config.yml"), `task:\n  agentModelOverrides:\n    task: ${SOL}\n`);
		writeFileSync(join(project, ".omp", "config.yml"), `task:\n  agentModelOverrides:\n    task: ${OPUS}\n`);
		const native = await runtime.Settings.loadReadOnly({ cwd: project, agentDir });
		const inputs = await readSpawnModelInputs(project, patterns => runtime.resolveModelRoleValue(patterns, models, { settings: native }).model, home);
		expect(resolveTaskModels(task, inputs.agents, inputs.settings, OPUS)[0]?.reason).toBe("OPUS_CLASS_CANDIDATE");
		expect(inputs.settings.agentModelOverrides).toMatchObject({ task: OPUS });
		// A real runtime override survives reload and beats both persisted layers.
		runtime.cfgTaskAgentModelOverrides.override(native, { task: SOL });
		const session = await readSpawnModelInputs(project, patterns => runtime.resolveModelRoleValue(patterns, models, { settings: native }).model, home);
		expect(session.scope).toBe("session");
		expect(resolveTaskModels(task, session.agents, session.settings, OPUS)[0]?.model).toBe(SOL);
		expect(readFileSync(join(project, ".omp", "config.yml"), "utf8")).toContain(OPUS);
	});
});
