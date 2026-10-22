import { describe, expect, test } from "bun:test";
import {
  buildSlbPayload,
  createSlbGuard,
  evaluateSlbResult,
  makeSlbRunner,
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

function childFor(stdout: string, stderr = "", exitCode = 0) {
  let input = "";
  let killed = false;
  return {
    child: {
      stdin: {
        write(value: string) {
          input += value;
        },
        end() {},
      },
      stdout: new Response(stdout).body!,
      stderr: new Response(stderr).body!,
      exited: Promise.resolve(exitCode),
      kill() {
        killed = true;
      },
    },
    input: () => input,
    killed: () => killed,
  };
}

describe("SLB fail-closed OMP bridge", () => {
  test("builds the exact native Bash payload", () => {
    expect(buildSlbPayload("  printf 'safe\\n'  ", "omp-session-test")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "  printf 'safe\\n'  " },
      session_id: "omp-session-test",
    });
  });

  test("passes fixed argv, exact payload, and cwd to the native executable", async () => {
    const spawned = childFor(allowOutput().stdout);
    const capture: { argv?: string[]; cwd?: string } = {};
    const runner = makeSlbRunner((argv, options) => {
      capture.argv = argv;
      capture.cwd = options.cwd;
      return spawned.child;
    });

    const result = await runner(buildSlbPayload("printf safe", "omp-session-test"), "/tmp/omp-slb-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk

    expect(result).toEqual(allowOutput());
    expect(capture.argv).toEqual(["/Users/josh/.local/bin/slb-guard-fail-closed"]);
    expect(capture.cwd).toBe("/tmp/omp-slb-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
    expect(JSON.parse(spawned.input().trim())).toEqual(buildSlbPayload("printf safe", "omp-session-test"));
    expect(spawned.killed()).toBe(false);
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
});
