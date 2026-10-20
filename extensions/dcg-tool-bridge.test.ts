import { expect, test } from "bun:test";
import {
  buildDcgPayload,
  createDcgToolBridge,
  createDcgUserBashBridge,
  evaluateDcgResult,
  makeDcgRunner,
  type DcgRunResult,
} from "./dcg-tool-bridge.ts";

const allow: DcgRunResult = {
  exitCode: 0,
  stdout: '{"index":0,"decision":"allow"}\n',
  stderr: "",
  timedOut: false,
};

test("maps an OMP bash call to dcg's JSONL hook contract", async () => {
  let received: unknown;
  const bridge = createDcgToolBridge(async (payload) => {
    received = payload;
    return allow;
  });

  await expect(
    bridge.handle(
      { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command: "git status" } },
      { cwd: "/tmp" },
    ),
  ).resolves.toBeUndefined();
  expect(received).toEqual(buildDcgPayload("git status", "/tmp"));
});

test("runs the installed dcg binary for a safe bash call", async () => {
  const bridge = createDcgToolBridge(makeDcgRunner());
  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-real", input: { command: "git status" } }),
  ).resolves.toBeUndefined();
});

test("blocks a denied dcg decision", async () => {
  const bridge = createDcgToolBridge(async () => ({
    exitCode: 1,
    stdout: '{"index":0,"decision":"deny","rule_id":"fixture"}\n',
    stderr: "",
    timedOut: false,
  }));

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-2", input: { command: "git status" } }),
  ).resolves.toEqual({ block: true, reason: "dcg denied the bash tool call (fixture)" });
});

test("blocks malformed, empty, or timed-out gate output", () => {
  for (const result of [
    { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    { exitCode: 0, stdout: "not-json\n", stderr: "", timedOut: false },
    { exitCode: 1, stdout: "", stderr: "", timedOut: true },
  ]) {
    expect(evaluateDcgResult(result)).toMatchObject({ kind: "block" });
  }
});

test("blocks a bash call without a command", async () => {
  const bridge = createDcgToolBridge(async () => allow);
  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-3", input: {} }),
  ).resolves.toEqual({ block: true, reason: "OMP dcg bridge: bash call has no command; refusing" });
});

test("does not apply a bash guard to other tools", async () => {
  let called = false;
  const bridge = createDcgToolBridge(async () => {
    called = true;
    return allow;
  });
  await expect(
    bridge.handle({ type: "tool_call", toolName: "read", toolCallId: "call-4", input: { path: "README.md" } }),
  ).resolves.toBeUndefined();
  expect(called).toBeFalse();
});

test("allows safe user_bash when dcg allows", async () => {
  let received: unknown;
  const bridge = createDcgUserBashBridge(async (payload) => {
    received = payload;
    return allow;
  });

  await expect(
    bridge.handle({
      type: "user_bash",
      command: "git status",
      excludeFromContext: false,
      cwd: "/tmp",
    }),
  ).resolves.toBeUndefined();
  expect(received).toEqual(buildDcgPayload("git status", "/tmp"));
});

test("returns a failed BashResult and prevents execution on deny", async () => {
  let executed = false;
  const bridge = createDcgUserBashBridge(async () => ({
    exitCode: 1,
    stdout: '{"index":0,"decision":"deny","rule_id":"fixture"}\n',
    stderr: "",
    timedOut: false,
  }));

  const result = await bridge.handle({
    type: "user_bash",
    command: "git status",
    excludeFromContext: false,
    cwd: "/tmp",
  });
  if (result === undefined) executed = true;

  expect(result).toEqual({
    result: expect.objectContaining({
      output: "dcg denied the bash tool call (fixture)",
      exitCode: 126,
      cancelled: false,
      timedOut: false,
      truncated: false,
      workingDir: "/tmp",
    }),
  });
  expect(executed).toBeFalse();
});

test("fails closed for malformed or unknown user_bash decisions and ignores foreign events", async () => {
  let calls = 0;
  const bridge = createDcgUserBashBridge(async () => {
    calls += 1;
    return { exitCode: 0, stdout: '{"index":0,"decision":"maybe"}\n', stderr: "", timedOut: false };
  });

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "git status" } }),
  ).resolves.toBeUndefined();
  const malformed = await bridge.handle({ type: "user_bash", command: "", cwd: "/tmp" });
  expect(malformed?.result.exitCode).toBe(126);
  const unknown = await bridge.handle({ type: "user_bash", command: "git status", cwd: "/tmp" });
  expect(unknown?.result.output).toBe("dcg denied the bash tool call");
  expect(calls).toBe(1);
});

test("anti-vacuity: denied user_bash invokes dcg with exact command and cwd", async () => {
  let calls = 0;
  let received: unknown;
  const bridge = createDcgUserBashBridge(async (payload) => {
    calls += 1;
    received = payload;
    return { exitCode: 1, stdout: "not-json\n", stderr: "", timedOut: false };
  });

  const result = await bridge.handle({
    type: "user_bash",
    command: "git status",
    excludeFromContext: false,
    cwd: "/tmp",
  });

  expect(calls).toBe(1);
  expect(received).toEqual(buildDcgPayload("git status", "/tmp"));
  expect(result?.result.exitCode).toBe(126);
});
