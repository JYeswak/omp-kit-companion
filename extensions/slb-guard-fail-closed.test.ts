import { describe, expect, test } from "bun:test";
import {
  buildSlbPayload,
  createSlbGuard,
  evaluateSlbResult,
  type SlbRunResult,
} from "./slb-guard-fail-closed";

const context = {
  cwd: "/tmp/omp-slb-test", // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
  sessionManager: { getSessionId: () => "omp-session-test" },
};

const bashEvent = (command: string) => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "slb-test-call",
  input: { command },
});

const allowOutput = (): SlbRunResult => ({
  exitCode: 0,
  stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
  stderr: "",
  timedOut: false,
});

const denyOutput = (): SlbRunResult => ({
  exitCode: 0,
  stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SLB planted known-bad fixture"}}\n',
  stderr: "",
  timedOut: false,
});


describe("SLB fail-closed OMP bridge", () => {
  test("builds the exact native Bash payload", () => {
    expect(buildSlbPayload("  printf 'safe\\n'  ", "omp-session-test")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "  printf 'safe\\n'  " },
      session_id: "omp-session-test",
    });
  });


  test("allows the native benign inverse", async () => {
    const bridge = createSlbGuard(async () => allowOutput());
    await expect(bridge.handle(bashEvent("printf safe"), context)).resolves.toBeUndefined();
  });

  test("blocks a planted native known-bad refusal", async () => {
    const bridge = createSlbGuard(async () => denyOutput());
    const result = await bridge.handle(bashEvent("git reset --hard HEAD"), context);
    expect(result).toEqual({ block: true, reason: "SLB planted known-bad fixture" });
  });

  test("fails closed on malformed and native failures", async () => {
    for (const result of [
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}', stderr: "", timedOut: false },
      { exitCode: 1, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "native diagnostic", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: true },
    ]) {
      const bridge = createSlbGuard(async () => result);
      const blocked = await bridge.handle(bashEvent("printf safe"), context);
      expect(blocked?.block).toBe(true);
    }
  });

  test("keeps foreign events silent and refuses malformed Bash events", async () => {
    let invoked = false;
    const bridge = createSlbGuard(async () => {
      invoked = true;
      return allowOutput();
    });
    await expect(bridge.handle({ type: "tool_call", toolName: "read", input: { path: "x" } }, context)).resolves.toBeUndefined();
    await expect(bridge.handle({ type: "tool_call", toolName: "bash", input: {} }, context)).resolves.toMatchObject({ block: true });
    expect(invoked).toBe(false);
  });

  test("maps ask to a fail-closed OMP block", () => {
    expect(evaluateSlbResult({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"review"}}',
      stderr: "",
      timedOut: false,
    })).toEqual({ kind: "deny", reason: "review" });
  });

  test("delivers the reviewed command to the consumer without mutating the original call", async () => {
    const reviewed = "exec slb execute --expected-command-hash abc -- request-123";
    const original = { ...bashEvent("printf unreviewed"), input: { command: "printf unreviewed", timeout: 7 } };
    const bridge = createSlbGuard(async () => ({
      ...allowOutput(),
      stdout: JSON.stringify({ hookSpecificOutput: {
        hookEventName: "PreToolUse", permissionDecision: "allow",
        updatedInput: { command: reviewed },
      } }),
    }));
    const result = await bridge.handle(original, context);
    expect(result).toEqual({ input: { command: reviewed, timeout: 7 } });
    expect(original.input).toEqual({ command: "printf unreviewed", timeout: 7 });
  });

  test("refuses malformed or unsupported execution revisions rather than running the original", async () => {
    for (const updatedInput of [null, [], "printf other", {}, { command: "" },
      { command: "   " }, { command: 17 }, { command: "printf safe", cwd: "/elsewhere" }]) {
      const bridge = createSlbGuard(async () => ({
        ...allowOutput(),
        stdout: JSON.stringify({ hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput,
        } }),
      }));
      await expect(bridge.handle(bashEvent("printf original"), context)).resolves.toMatchObject({ block: true });
    }
  });

  test("never promotes an ask or deny carrying a replacement into execution", async () => {
    for (const permissionDecision of ["ask", "deny"]) {
      const bridge = createSlbGuard(async () => ({
        ...allowOutput(),
        stdout: JSON.stringify({ hookSpecificOutput: {
          hookEventName: "PreToolUse", permissionDecision,
          permissionDecisionReason: "approval required",
          updatedInput: { command: "printf not-approved" },
        } }),
      }));
      await expect(bridge.handle(bashEvent("printf original"), context)).resolves.toEqual({
        block: true, reason: "approval required",
      });
    }
  });

  test("never accepts a truncated allow decision", async () => {
    const bridge = createSlbGuard(async () => ({ ...allowOutput(), incomplete: true }));
    await expect(bridge.handle(bashEvent("printf safe"), context)).resolves.toMatchObject({ block: true });
  });
});
