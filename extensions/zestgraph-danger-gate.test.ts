import { describe, expect, test } from "bun:test";
import {
  buildDangerPayload,
  createZestgraphDangerGate,
  evaluateDangerResult,
  makeDangerRunner,
  type DangerRunResult,
} from "./zestgraph-danger-gate";

const safeEvent = (command: string) => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "test-call",
  input: { command },
});

const allowOutput = (): DangerRunResult => ({
  exitCode: 0,
  stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
  stderr: "",
  timedOut: false,
});

const denyOutput = (): DangerRunResult => ({
  exitCode: 0,
  stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fixture refusal"}}\n',
  stderr: "",
  timedOut: false,
});

const childFor = (stdout: string, stderr = "", exitCode = 0) => {
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
};

describe("zestgraph danger OMP bridge", () => {
  test("builds the exact native PreToolUse payload", () => {
    expect(buildDangerPayload("printf 'safe\\n'")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "printf 'safe\\n'" },
    });
  });

  test("passes exact argv, payload, and cwd to the fixed native executable", async () => {
    const capture: { argv?: string[]; cwd?: string; input?: string } = {};
    const spawned = childFor(allowOutput().stdout);
    const runner = makeDangerRunner((argv, options) => {
      capture.argv = argv;
      capture.cwd = options.cwd;
      const child = spawned.child;
      return child;
    });

    const result = await runner(buildDangerPayload("git status"), "/tmp/omp-danger-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
    capture.input = spawned.input();

    expect(result).toEqual(allowOutput());
    expect(capture.argv).toEqual(["/Users/josh/.local/bin/zestgraph-danger-gate"]);
    expect(capture.cwd).toBe("/tmp/omp-danger-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
    expect(JSON.parse(capture.input!.trim())).toEqual(buildDangerPayload("git status"));
  });

  test("allows the native inverse decision", async () => {
    const bridge = createZestgraphDangerGate(async () => allowOutput());
    await expect(bridge.handle(safeEvent("git status"), { cwd: "/tmp/project" })).resolves.toBeUndefined(); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
  });

  test("blocks the native deny decision for a destructive fixture", async () => {
    const bridge = createZestgraphDangerGate(async () => denyOutput());
    const result = await bridge.handle(safeEvent("git reset --hard HEAD"), { cwd: "/tmp/project" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
    expect(result).toEqual({ block: true, reason: "fixture refusal" });
  });

  test("fails closed on malformed, foreign, and failed native results", async () => {
    for (const result of [
      { exitCode: 0, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}', stderr: "", timedOut: false },
      { exitCode: 1, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "native diagnostic", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: true },
    ]) {
      const bridge = createZestgraphDangerGate(async () => result);
      const blocked = await bridge.handle(safeEvent("git status"), { cwd: "/tmp/project" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
      expect(blocked?.block).toBe(true);
    }

    let invoked = false;
    const bridge = createZestgraphDangerGate(async () => {
      invoked = true;
      return allowOutput();
    });
    await expect(bridge.handle({ type: "tool_call", toolName: "read", input: { path: "x" } })).resolves.toBeUndefined();
    await expect(bridge.handle({ type: "tool_call", toolName: "bash", input: {} })).resolves.toMatchObject({ block: true });
    expect(invoked).toBe(false);
  });

  test("requires the native PreToolUse envelope", () => {
    expect(evaluateDangerResult({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"hookEventName":"Other","permissionDecision":"allow"}}',
      stderr: "",
      timedOut: false,
    }).kind).toBe("deny");
  });
});
