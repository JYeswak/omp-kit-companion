import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  buildSessionStartPayload,
  createSkillTopologySessionStartAdapter,
  makeTopologyHookRunner,
  type SpawnProcess,
  type SpawnedChild,
  type TopologyRunResult,
} from "./skill-topology-session-start.ts";

const context = {
  cwd: "/tmp/topology-proof",
  hasUI: false,
  ui: { notify() {} },
  sessionManager: { getSessionId: () => "session-proof" },
};

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

function child(stdout: string, stderr: string, exitCode: number): SpawnedChild {
  return {
    stdin: { write() {}, end() {} },
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

function result(command: TopologyRunResult["command"], overrides: Partial<TopologyRunResult> = {}): TopologyRunResult {
  return { command, exitCode: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

test("positive topology output is delivered as additive advisory messages", async () => {
  const messages: string[] = [];
  let receivedPayload: unknown;
  const adapter = createSkillTopologySessionStartAdapter(
    async (payload) => {
      receivedPayload = payload;
      return [
        result("zestgraph-skill-topology-gate", { stdout: "TOPOLOGY DRIFT" }),
        result("skill-topology-hook", { stdout: "SHADOW NOTE" }),
      ];
    },
    message => messages.push(message),
  );

  await adapter.handle({ type: "session_start" }, context);

  assert.deepEqual(receivedPayload, buildSessionStartPayload("session-proof", "/tmp/topology-proof"));
  assert.deepEqual(messages, ["TOPOLOGY DRIFT", "SHADOW NOTE"]);
});

test("healthy empty native output is silent", async () => {
  const messages: string[] = [];
  const adapter = createSkillTopologySessionStartAdapter(
    async () => [
      result("zestgraph-skill-topology-gate"),
      result("skill-topology-hook"),
    ],
    message => messages.push(message),
  );

  await adapter.handle({ type: "session_start" }, context);

  assert.deepEqual(messages, []);
});

test("foreign or malformed lifecycle events are ignored", async () => {
  let calls = 0;
  const adapter = createSkillTopologySessionStartAdapter(
    async () => {
      calls += 1;
      return [result("zestgraph-skill-topology-gate", { stdout: "should not appear" })];
    },
    () => assert.fail("foreign event emitted an advisory"),
  );

  await adapter.handle({ type: "session_shutdown" }, context);
  await adapter.handle({}, context);

  assert.equal(calls, 0);
});

test("nonzero, timeout, and runner failure produce fixed advisory diagnostics", async () => {
  const messages: string[] = [];
  const adapter = createSkillTopologySessionStartAdapter(
    async () => [
      result("zestgraph-skill-topology-gate", { exitCode: 1, stdout: "native drift text" }),
      result("skill-topology-hook", { timedOut: true }),
    ],
    message => messages.push(message),
  );
  await adapter.handle({ type: "session_start" }, context);
  assert.deepEqual(messages, [
    "native drift text",
    "skill-topology SessionStart command failed; inspect native hook health.",
    "skill-topology SessionStart command failed; inspect native hook health.",
  ]);

  const failed: string[] = [];
  const failedAdapter = createSkillTopologySessionStartAdapter(
    async () => { throw new Error("synthetic failure"); },
    message => failed.push(message),
  );
  await failedAdapter.handle({ type: "session_start" }, context);
  assert.deepEqual(failed, ["skill-topology SessionStart command failed; inspect native hook health."]);
});

test("native runner uses fixed argv, passes the session payload, and drains both streams", async () => {
  const calls: { argv: string[]; options: unknown }[] = [];
  const writes: string[] = [];
  const outputs = [
    child("gate advisory", "gate stderr", 0),
    child("", "", 0),
  ];
  const spawn: SpawnProcess = (argv, options) => {
    calls.push({ argv, options });
    const next = outputs.shift()!;
    next.stdin = {
      write(input) { writes.push(input); },
      end() {},
    };
    return next;
  };
  const runner = makeTopologyHookRunner(spawn, 50);
  const payload = buildSessionStartPayload("session-proof", "/tmp/topology-proof");
  const results = await runner(payload, "/tmp/topology-proof");

  assert.deepEqual(calls.map(call => call.argv), [
    ["/Users/josh/.local/bin/zestgraph-skill-topology-gate", "--hook"],
    ["/Users/josh/.local/bin/skill-topology-hook", "--hook"],
  ]);
  assert.deepEqual(JSON.parse(writes[0]), payload);
  assert.deepEqual(JSON.parse(writes[1]), payload);
  assert.equal(results[0]?.stderr, "gate stderr");
});

test("anti-vacuity: session_start must invoke both native commands", async () => {
  const commands: string[] = [];
  const adapter = createSkillTopologySessionStartAdapter(
    async () => {
      commands.push("runner-called");
      return [result("zestgraph-skill-topology-gate")];
    },
    () => {},
  );

  await adapter.handle({ type: "session_start" }, context);

  assert.deepEqual(commands, ["runner-called"]);
});
