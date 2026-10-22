import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  buildEeAmbientArgv,
  createEeAmbientSessionStartAdapter,
  resolveAmbientSettings,
  type AmbientSettings,
  type EeRunResult,
  type SessionStartContext,
  type StateStore,
} from "./ee-ambient-session-start.ts";

const context: SessionStartContext = {
  cwd: "/tmp/ee-ambient-test", // tempsafe: fake cwd and state path for the in-memory store, never touched on disk
  sessionManager: { getSessionId: () => "session-1" },
};

function healthy(output: string): EeRunResult {
  return { exitCode: 0, stdout: output, stderr: "", timedOut: false };
}

function settings(overrides: Partial<AmbientSettings> = {}): AmbientSettings {
  return { enabled: true, verbosity: "standard", budget: 12_000, ...overrides };
}

function memoryStore(initial: Record<string, string> = {}): StateStore & { writes: Array<{ path: string; content: string }> } {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ path: string; content: string }> = [];
  return {
    writes,
    async read(path) {
      return values.get(path);
    },
    async write(path, content) {
      values.set(path, content);
      writes.push({ path, content });
    },
  };
}

test("delivers normal advisory output and invokes exact ee argv", async () => {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const messages: string[] = [];
  const store = memoryStore();
  const adapter = createEeAmbientSessionStartAdapter({
    env: {},
    runEe: async (argv, cwd) => {
      calls.push({ argv, cwd });
      return healthy('{"orient":"ok"}');
    },
    sink: message => messages.push(message),
    stateStore: store,
  });

  await adapter.handle({ type: "session_start" }, context);

  assert.deepEqual(calls, [{
    argv: buildEeAmbientArgv(settings()),
    cwd: "/tmp/ee-ambient-test", // tempsafe: fake cwd and state path for the in-memory store, never touched on disk
  }]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], "<!-- ee ambient_context schema=ee.ambient_context.v1 surface=session_start_orient budgetTokens=12000 verbosity=standard provenance=ee:ee.ambient_context.v1 -->\n{\"orient\":\"ok\"}");
  assert.equal(store.writes.length, 1);
});

test("healthy empty output is silent", async () => {
  let calls = 0;
  const messages: string[] = [];
  const adapter = createEeAmbientSessionStartAdapter({
    env: {},
    runEe: async () => {
      calls += 1;
      return healthy("");
    },
    sink: message => messages.push(message),
    stateStore: memoryStore(),
  });

  await adapter.handle({ type: "session_start" }, context);

  assert.equal(calls, 1);
  assert.deepEqual(messages, []);
});

test("disabled and quiet settings suppress ee and delivery", async () => {
  for (const env of [
    { EE_AMBIENT_CONTEXT: "off" },
    { EE_AMBIENT_CONTEXT: "0" },
    { EE_AMBIENT_CONTEXT_VERBOSITY: "quiet" },
  ]) {
    let calls = 0;
    const messages: string[] = [];
    const adapter = createEeAmbientSessionStartAdapter({
      env,
      runEe: async () => {
        calls += 1;
        return healthy('{"orient":"unexpected"}');
      },
      sink: message => messages.push(message),
      stateStore: memoryStore(),
    });
    await adapter.handle({ type: "session_start" }, context);
    assert.equal(calls, 0);
    assert.deepEqual(messages, []);
  }
  assert.deepEqual(resolveAmbientSettings({ EE_AMBIENT_CONTEXT_VERBOSITY: "verbose" }), {
    enabled: true,
    verbosity: "verbose",
    budget: 16_000,
  });
});

test("duplicate session-start output is suppressed by content digest", async () => {
  let calls = 0;
  const messages: string[] = [];
  const store = memoryStore();
  const adapter = createEeAmbientSessionStartAdapter({
    env: { EE_AMBIENT_CONTEXT_STATE_DIR: "/tmp/ee-ambient-state" }, // tempsafe: fake cwd and state path for the in-memory store, never touched on disk
    runEe: async () => {
      calls += 1;
      return healthy('{"orient":"same"}');
    },
    sink: message => messages.push(message),
    stateStore: store,
  });

  await adapter.handle({ type: "session_start" }, context);
  await adapter.handle({ type: "session_start" }, context);

  assert.equal(calls, 2, "native ee remains authoritative on each event");
  assert.equal(messages.length, 1);
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0]?.path, "/tmp/ee-ambient-state/ambient_context_seen.json"); // tempsafe: fake cwd and state path for the in-memory store, never touched on disk
});

test("foreign or malformed events are silent", async () => {
  let calls = 0;
  const messages: string[] = [];
  const adapter = createEeAmbientSessionStartAdapter({
    env: {},
    runEe: async () => {
      calls += 1;
      return healthy('{"orient":"unexpected"}');
    },
    sink: message => messages.push(message),
    stateStore: memoryStore(),
  });

  await adapter.handle({ type: "session_shutdown" }, context);
  await adapter.handle({}, context);

  assert.equal(calls, 0);
  assert.deepEqual(messages, []);
});

test("malformed, nonzero, and timeout ee results inject nothing", async () => {
  for (const failure of [
    { exitCode: 1, stdout: "{\"orient\":\"error\"}", stderr: "", timedOut: false },
    { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false },
    { exitCode: 0, stdout: "{\"orient\":\"late\"}", stderr: "", timedOut: true },
  ]) {
    const messages: string[] = [];
    const adapter = createEeAmbientSessionStartAdapter({
      env: {},
      runEe: async () => failure,
      sink: message => messages.push(message),
      stateStore: memoryStore(),
    });
    await adapter.handle({ type: "session_start" }, context);
    assert.deepEqual(messages, []);
  }
});

test("anti-vacuity: normal session start must invoke the ee runner", async () => {
  let calls = 0;
  const adapter = createEeAmbientSessionStartAdapter({
    env: {},
    runEe: async argv => {
      calls += 1;
      assert.equal(argv[0], "/Users/josh/.local/bin/ee");
      return healthy("{\"orient\":\"ok\"}");
    },
    sink: () => {},
    stateStore: memoryStore(),
  });

  await adapter.handle({ type: "session_start" }, context);

  assert.equal(calls, 1);
});
