import { expect, test } from "bun:test";
import {
  buildSpawnCapPayload,
  createSpawnCapToolBridge,
  createSpawnCapUserBashBridge,
  evaluateSpawnCapResult,
  type SpawnCapPayload,
  type SpawnCapRunResult,
} from "./zeststream-cast-spawn-cap.ts";

const targetCommand = "ntm add zeststream-cast --cod=1";
const safeCommand = "git status";

function allowResult(): SpawnCapRunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}

function denyResult(): SpawnCapRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "fixture cap reached",
      },
    }),
    stderr: "",
    timedOut: false,
  };
}

test("allows a target command below the native cap", async () => {
  let received: SpawnCapPayload | undefined;
  const bridge = createSpawnCapToolBridge(async (payload) => {
    received = payload;
    return allowResult();
  });

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "under-cap", input: { command: targetCommand } }),
  ).resolves.toBeUndefined();
  expect(received).toEqual(buildSpawnCapPayload(targetCommand));
});

test("allows non-target Bash through the native cap script", async () => {
  let invoked = false;
  const bridge = createSpawnCapToolBridge(async () => {
    invoked = true;
    return allowResult();
  });

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "non-target", input: { command: safeCommand } }),
  ).resolves.toBeUndefined();
  expect(invoked).toBeTrue();
});

test("denies a target at cap through tool_call", async () => {
  const bridge = createSpawnCapToolBridge(async () => denyResult());

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "at-cap", input: { command: targetCommand } }),
  ).resolves.toEqual({ block: true, reason: "fixture cap reached" });
});

test("returns a failed BashResult for a denied user_bash without execution", async () => {
  let executed = false;
  const bridge = createSpawnCapUserBashBridge(async () => denyResult());

  const result = await bridge.handle({
    type: "user_bash",
    command: targetCommand,
    excludeFromContext: false,
    cwd: "/tmp",
  });
  if (result === undefined) executed = true;

  expect(result?.result).toMatchObject({
    output: "fixture cap reached",
    exitCode: 126,
    cancelled: false,
    timedOut: false,
    truncated: false,
    workingDir: "/tmp",
  });
  expect(executed).toBeFalse();
});

test("allows a safe user_bash by returning undefined", async () => {
  const bridge = createSpawnCapUserBashBridge(async () => allowResult());

  await expect(
    bridge.handle({ type: "user_bash", command: safeCommand, excludeFromContext: false, cwd: "/tmp" }),
  ).resolves.toBeUndefined();
});

test("fails closed for malformed native output, timeout, spawn failure, and foreign events", async () => {
  const malformed = createSpawnCapToolBridge(async () => ({
    exitCode: 0,
    stdout: "not-json",
    stderr: "",
    timedOut: false,
  }));
  await expect(
    malformed.handle({ type: "tool_call", toolName: "bash", toolCallId: "malformed", input: { command: targetCommand } }),
  ).resolves.toEqual({ block: true, reason: "zeststream-cast spawn cap returned malformed output; refusing the Bash call" });

  const timeout = createSpawnCapToolBridge(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true }));
  await expect(
    timeout.handle({ type: "tool_call", toolName: "bash", toolCallId: "timeout", input: { command: targetCommand } }),
  ).resolves.toEqual({ block: true, reason: "zeststream-cast spawn cap timed out; refusing the Bash call" });

  const spawnFailure = createSpawnCapToolBridge(async () => {
    throw new Error("synthetic spawn failure");
  });
  await expect(
    spawnFailure.handle({ type: "tool_call", toolName: "bash", toolCallId: "spawn-failure", input: { command: targetCommand } }),
  ).resolves.toEqual({ block: true, reason: "zeststream-cast spawn cap failed; refusing the Bash call" });

  const foreign = createSpawnCapUserBashBridge(async () => denyResult());
  await expect(foreign.handle({ type: "tool_call", toolName: "bash", input: { command: targetCommand } })).resolves.toBeUndefined();
});

test("rejects unknown native decisions", () => {
  expect(evaluateSpawnCapResult({
    exitCode: 0,
    stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}',
    stderr: "",
    timedOut: false,
  })).toEqual({ kind: "deny", reason: "zeststream-cast spawn cap returned an unknown decision; refusing the Bash call" });
});

test("anti-vacuity: target decisions invoke the native runner with exact payload", async () => {
  const received: SpawnCapPayload[] = [];
  const bridge = createSpawnCapToolBridge(async (payload) => {
    received.push(payload);
    return denyResult();
  });

  await bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "anti-vacuity", input: { command: targetCommand } });

  expect(received).toEqual([buildSpawnCapPayload(targetCommand)]);
});
