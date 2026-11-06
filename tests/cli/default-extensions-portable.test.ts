import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { applyExtensions, planExtensions } from "../../src/apply-extensions.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { writeProfileConfig } from "./profile-fixture.ts";
import { runFixture } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");

// Run the installed bytes, not checkout imports. No inherited HOME, PATH, Clef,
// guard source or fleet environment can make a private integration appear portable.
const probe = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { pathToFileURL } from "node:url";
const attempts = [];
const denied = (...args) => { attempts.push(String(args[0])); throw new Error("external dependency attempted"); };
Bun.spawn = denied;
Bun.spawnSync = denied;
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = denied;
globalThis.fetch = denied;
const handlers = new Map();
const entries = [];
const pi = {
  on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
  appendEntry(customType, data) { entries.push({ customType, data }); },
  setLabel() {},
  sendMessage() {},
};
// Policy chooses the installed plugin path at runtime; static imports load checkout bytes.
const extension = await import(pathToFileURL(process.argv[1]).href);
await extension.default(pi);
const context = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "portable-session" },
  ui: { notify() {} }, getSystemPrompt: () => "" };
const emit = async (name, event) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context); };
await emit("session_start", {});
await emit("before_agent_start", { prompt: "inspect project", systemPrompt: "" });
await emit("tool_call", { toolName: "bash", toolCallId: "call", input: { command: "printf portable" } });
await emit("tool_result", { toolName: "write", toolCallId: "write", input: { path: "result.txt" }, content: [], isError: false });
await emit("tool_result", { toolName: "bash", toolCallId: "failure", input: { command: "false" }, content: [], details: { exitCode: 1 } });
assert.deepEqual(attempts, [], "default extension needs an external process or service");
assert.deepEqual(entries, [
  { customType: "com.zeststream.omp-observational-hook.capture.v1", data: { kind: "successful_tool_result", toolName: "write", toolCallId: "write", paths: ["result.txt"], cwd: process.cwd() } },
  { customType: "com.zeststream.omp-observational-hook.failure.v1", data: { kind: "bash_failure", toolName: "bash", toolCallId: "failure", exitCode: 1, command: "false", cwd: process.cwd() } },
], "default observer must do useful work without fleet tools");
console.log("PORTABLE " + process.argv[1]);
`;

function fixture(run: (home: string, stateRoot: string) => void): void {
	const owned = ownedTmp("default-extensions-portable", { root: join(root, "var/agent-tmp") });
	const home = join(owned.path, "home");
	mkdirSync(home);
	writeProfileConfig(home, "default", "model: test\nextensions: []\n", 0o600);
	try { run(home, join(owned.path, "state")); } finally { owned.cleanup(); }
}

function runProbe(path: string, home: string) {
	const result = runFixture([process.execPath, "--eval", probe, path], {
		cwd: home, env: { HOME: home, PATH: "", TMPDIR: process.env.TMPDIR },
	});
	return { exitCode: result.rc, stderr: new TextDecoder().decode(result.stderr) };
}

test("each installed default loads and records useful results on a stock HOME without fleet tools", () => fixture((home, stateRoot) => {
	applyExtensions(planExtensions({ root, home, stateRoot, includeDefault: true }));
	const config = YAML.parse(readFileSync(join(home, ".omp/agent/config.yml"), "utf8"));
	for (const path of config.extensions) {
		const result = runProbe(path, home);
		expect({ path, code: result.exitCode, stderr: result.stderr.toString() }).toEqual({ path, code: 0, stderr: "" });
	}
}));

test("a planted fleet-only extension fails the same stock-HOME load and event check", () => fixture((home, stateRoot) => {
	applyExtensions(planExtensions({ root, home, stateRoot, includeDefault: true, fleet: true }));
	const result = runProbe(join(home, ".omp/omp-extensions/dcg-tool-bridge.ts"), home);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr.toString()).toContain("default extension needs an external process or service");
}));

test("fleet selection is explicit, applies only its pack and leaves default observers installed", () => fixture((home, stateRoot) => {
	const input = { root, home, stateRoot, includeDefault: true };
	applyExtensions(planExtensions(input));
	const configPath = join(home, ".omp/agent/config.yml");
	const defaults = YAML.parse(readFileSync(configPath, "utf8")).extensions;
	const fleetPolicy = JSON.parse(readFileSync(join(root, "policy/extensions-fleet.json"), "utf8"));
	const fleetPlan = planExtensions({ ...input, fleet: true });
	expect(fleetPlan.steps.filter(step => step.kind === "extension").map(step => step.path))
		.toEqual(fleetPolicy.extensions.map((name: string) => join(home, ".omp/omp-extensions", name)));
	applyExtensions(fleetPlan);
	expect(YAML.parse(readFileSync(configPath, "utf8")).extensions)
		.toEqual([...defaults, ...fleetPolicy.extensions.map((name: string) => join(home, ".omp/omp-extensions", name))]);
	expect(planExtensions({ ...input, fleet: true }).steps).toEqual([]);
}));
