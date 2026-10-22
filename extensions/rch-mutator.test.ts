import { describe, expect, test } from "bun:test";
import {
  buildRchPayload,
  createRchMutator,
  evaluateRchResult,
  makeRchRunner,
  type RchRunResult,
} from "./rch-mutator";

const context = {
  cwd: "/tmp/omp-rch-test", // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
  sessionManager: { getSessionId: () => "omp-rch-session" },
};

const bashEvent = (command: string) => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "rch-test-call",
  input: { command, timeout: 30, shell: "bash" },
});

const rewriteOutput = (): RchRunResult => ({
  exitCode: 0,
  stdout: [
    "2026-08-29T00:00:00Z INFO rch::hook: Compilation detected",
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rch exec -- cargo check --workspace"}}}',
    "",
  ].join("\n"),
  stderr: "",
  timedOut: false,
});

describe("RCH OMP mutator", () => {
  test("builds the exact native payload and preserves command bytes", () => {
    expect(buildRchPayload("  cargo check --workspace  ", "omp-rch-session")).toEqual({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "  cargo check --workspace  " },
      session_id: "omp-rch-session",
    });
  });

  test("passes fixed argv, exact payload, and cwd to native rch", async () => {
    let input = "";
    let argv: string[] | undefined;
    let cwd: string | undefined;
    const runner = makeRchRunner((childArgv, options) => {
      argv = childArgv;
      cwd = options.cwd;
      return {
        stdin: {
          write(value: string) {
            input += value;
          },
          end() {},
        },
        stdout: new Response(rewriteOutput().stdout).body!,
        stderr: new Response("").body!,
        exited: Promise.resolve(0),
        kill() {},
      };
    });

    const result = await runner(buildRchPayload("cargo check --workspace", "omp-rch-session"), "/tmp/omp-rch-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk

    expect(result).toEqual(rewriteOutput());
    expect(argv).toEqual(["/Users/josh/.local/bin/rch"]);
    expect(cwd).toBe("/tmp/omp-rch-test"); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
    expect(JSON.parse(input.trim())).toEqual(buildRchPayload("cargo check --workspace", "omp-rch-session"));
  });

  test("forwards only the native updatedInput command and preserves other Bash fields", async () => {
    const bridge = createRchMutator(async () => rewriteOutput());
    await expect(bridge.handle(bashEvent("cargo check --workspace"), context)).resolves.toEqual({
      input: {
        command: "rch exec -- env RCH_CARGO_WRAPPER_BYPASS=1 cargo check --workspace",
        timeout: 30,
        shell: "bash",
      },
    });
  });

  test("keeps non-cargo native silence unchanged", async () => {
    const bridge = createRchMutator(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    await expect(bridge.handle(bashEvent("git status"), context)).resolves.toBeUndefined();
  });

  test("keeps malformed, timeout, nonzero, and unknown native results unchanged", async () => {
    for (const result of [
      { exitCode: 0, stdout: "not-json", stderr: "", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "native diagnostic", timedOut: false },
      { exitCode: 0, stdout: "", stderr: "", timedOut: true },
      { exitCode: 1, stdout: "", stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}', stderr: "", timedOut: false },
    ]) {
      const bridge = createRchMutator(async () => result);
      await expect(bridge.handle(bashEvent("cargo check"), context)).resolves.toBeUndefined();
    }

    expect(evaluateRchResult({
      exitCode: 0,
      stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}',
      stderr: "",
      timedOut: false,
    })).toEqual({ kind: "silent" });
  });

  test("keeps foreign events silent and malformed OMP events unchanged", async () => {
    let invoked = false;
    const bridge = createRchMutator(async () => {
      invoked = true;
      return rewriteOutput();
    });
    await expect(bridge.handle({ type: "tool_call", toolName: "read", input: { path: "x" } }, context)).resolves.toBeUndefined();
    await expect(bridge.handle({ type: "tool_call", toolName: "bash", input: {} }, context)).resolves.toBeUndefined();
    expect(invoked).toBe(false);
  });
});
