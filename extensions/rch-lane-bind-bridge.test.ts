import { describe, expect, test } from "bun:test";
import {
  buildLaneBindPayload,
  createRchLaneBindBridge,
  evaluateLaneBindResult,
  makeLaneBindRunner,
  type LaneBindRunResult,
  type SpawnProcess,
} from "./rch-lane-bind-bridge";

const context = {
  cwd: "/Users/josh/Developer/control-plane",
  sessionManager: { getSessionId: () => "omp-lane-session" },
};

const bashEvent = (command: string) => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "lane-test-call",
  input: { command, timeout: 30, shell: "bash" },
});

const silence = (): LaneBindRunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

const denial = (reason: string): LaneBindRunResult => ({
  exitCode: 0, // the binder exits 0 on deny too; the verdict is on stdout
  stdout: `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`,
  stderr: "",
  timedOut: false,
});

describe("RCH lane-bind OMP bridge", () => {
  test("sends the native payload and preserves the command bytes exactly", () => {
    // cp-ou105 depends on this: `rch exec` and bare `cargo` must reach the binder unaltered.
    const raw = "  RCH_WORKER=contabo-4   rch exec --  cargo build -p foo  ";
    const payload = buildLaneBindPayload(raw, "/repo", "sess");
    expect(payload.tool_input.command).toBe(raw);
    expect(payload.hook_event_name).toBe("PreToolUse");
    expect(payload.tool_name).toBe("Bash");
    expect(payload.cwd).toBe("/repo");
    expect(payload.session_id).toBe("sess");
    // transcript_path is deliberately absent: the binder does not require it and inventing
    // one would fabricate a path to a transcript that does not exist.
    expect("transcript_path" in payload).toBe(false);
  });

  test("omits cwd and session_id rather than sending empty strings", () => {
    const payload = buildLaneBindPayload("cargo build");
    expect("cwd" in payload).toBe(false);
    expect("session_id" in payload).toBe(false);
  });

  test("spawns the binder WITH cwd, because the repo is derived from process cwd", async () => {
    // main.rs:526 falls back to basename(current_dir()); payload cwd is ignored. A runner that
    // dropped cwd would make every repo resolve to omp's own directory.
    const seen: { argv?: string[]; cwd?: string; stdin?: string } = {};
    const spawn: SpawnProcess = (argv, options) => {
      seen.argv = argv;
      seen.cwd = options.cwd;
      return {
        stdin: { write: (chunk: string) => { seen.stdin = chunk; }, end: () => {} },
        stdout: new Response("").body as ReadableStream<Uint8Array>,
        stderr: new Response("").body as ReadableStream<Uint8Array>,
        exited: Promise.resolve(0),
        kill: () => {},
      };
    };
    const run = makeLaneBindRunner("/bin/lane-bind", 1_000, spawn);
    const result = await run(buildLaneBindPayload("cargo build", "/repo/uds"), "/repo/uds");
    expect(seen.argv).toEqual(["/bin/lane-bind"]);
    expect(seen.cwd).toBe("/repo/uds");
    expect(JSON.parse((seen.stdin ?? "").trim()).tool_input.command).toBe("cargo build");
    expect(result.exitCode).toBe(0);
  });

  test("silence with exit 0 is the ALLOW", () => {
    expect(evaluateLaneBindResult(silence())).toEqual({ kind: "allow" });
  });

  test("an explicit deny blocks and forwards the binder's own reason", () => {
    const reason = "rch-lane-bind DENY: control-plane requested lane 'contabo-4' but its assigned lane is 'contabo-2'";
    const decision = evaluateLaneBindResult(denial(reason));
    expect(decision).toEqual({ kind: "block", reason });
  });

  test("an explicit allow decision is honoured", () => {
    const stdout = `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    })}\n`;
    expect(evaluateLaneBindResult({ exitCode: 0, stdout, stderr: "", timedOut: false }))
      .toEqual({ kind: "allow" });
  });

  test("fail-closed: timeout, stderr, malformed JSON, missing and unknown decisions all block", () => {
    const cases: LaneBindRunResult[] = [
      { exitCode: 0, stdout: "", stderr: "", timedOut: true },
      { exitCode: 0, stdout: "", stderr: "boom", timedOut: false },
      { exitCode: 0, stdout: "not json\n", stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"hookSpecificOutput":{}}\n', stderr: "", timedOut: false },
      { exitCode: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"maybe"}}\n', stderr: "", timedOut: false },
      { exitCode: 3, stdout: "", stderr: "", timedOut: false },
    ];
    for (const result of cases) {
      expect(evaluateLaneBindResult(result).kind).toBe("block");
    }
  });

  test("a deny reaches the agent as a block carrying the binder's reason", async () => {
    const reason = "rch-lane-bind DENY: control-plane requested lane 'contabo-4'";
    const bridge = createRchLaneBindBridge(async () => denial(reason));
    const blocked = await bridge.handle(bashEvent("RCH_WORKER=contabo-4 rch exec -- cargo build"), context);
    expect(blocked).toEqual({ block: true, reason });
  });

  test("the assigned lane is allowed — no false refusals", async () => {
    const bridge = createRchLaneBindBridge(async () => silence());
    const allowed = await bridge.handle(bashEvent("RCH_WORKER=contabo-2 rch exec -- cargo build"), context);
    expect(allowed).toBeUndefined();
  });

  test("the bridge passes cwd and session id from the omp context", async () => {
    let captured: { cwd?: string; session?: string } = {};
    const bridge = createRchLaneBindBridge(async (payload, cwd) => {
      captured = { cwd, session: payload.session_id };
      return silence();
    });
    await bridge.handle(bashEvent("cargo build"), context);
    expect(captured.cwd).toBe("/Users/josh/Developer/control-plane");
    expect(captured.session).toBe("omp-lane-session");
  });

  test("a runner that throws refuses the call rather than waving it through", async () => {
    const bridge = createRchLaneBindBridge(async () => { throw new Error("spawn failed"); });
    const blocked = await bridge.handle(bashEvent("cargo build"), context);
    expect(blocked?.block).toBe(true);
  });

  test("a bash call with no command refuses", async () => {
    const bridge = createRchLaneBindBridge(async () => silence());
    const blocked = await bridge.handle({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "x",
      input: {},
    }, context);
    expect(blocked?.block).toBe(true);
  });

  test("foreign events stay silent", async () => {
    const bridge = createRchLaneBindBridge(async () => denial("should never run"));
    expect(await bridge.handle({ type: "tool_call", toolName: "read", input: { command: "x" } }, context)).toBeUndefined();
    expect(await bridge.handle({ type: "tool_result", toolName: "bash", input: { command: "x" } }, context)).toBeUndefined();
  });

  test("a missing omp context does not crash the guard", async () => {
    const bridge = createRchLaneBindBridge(async () => silence());
    expect(await bridge.handle(bashEvent("cargo build"), undefined)).toBeUndefined();
  });

  test("a throwing getSessionId is tolerated", async () => {
    const bridge = createRchLaneBindBridge(async () => silence());
    const hostile = { cwd: "/repo", sessionManager: { getSessionId: () => { throw new Error("no session"); } } };
    expect(await bridge.handle(bashEvent("cargo build"), hostile)).toBeUndefined();
  });
});
