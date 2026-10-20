#!/usr/bin/env bun
//
// rch-lane-bind-bridge — the omp bridge for the fleet's only lane ENFORCER.
//
// WHY THIS FILE EXISTS (cp-dmlz7, measured 2026-09-06): `rch-lane-bind` is registered in
// ~/.claude/settings.json as PreToolUse hook #2, and omp does not dispatch that file. Proof it
// was never reached: the binary writes a trace row on EVERY invocation including allow, yet a
// live omp session with ~40 Bash calls had no trace file, while `dcg` — hook #1 in the same
// array — emits ZERO bytes on a benign command and therefore cannot have short-circuited it.
// Every other settings.json guard already has an omp bridge; this one was missed.
//
// ⛔ THE COMMAND IS PASSED THROUGH VERBATIM. cp-ou105 records that the binder parses
// `rch exec -- cargo ...` differently from a bare `cargo ...`. A bridge that normalised or
// rewrote the command would mask that defect and make cp-ou105 unreproducible. This bridge
// never touches the bytes; contrast rch-mutator, whose whole job IS to rewrite.
//
// ⛔ THE BINDER DERIVES THE REPO FROM ITS OWN PROCESS CWD, NOT FROM PAYLOAD `cwd`.
// Measured: main.rs:526 falls back to `basename(std::env::current_dir())` when
// RCH_LANE_BIND_REPO is unset, and a payload declaring cwd=omp-orchestrator while the process
// sat in control-plane produced `DENY: control-plane requested lane 'contabo-3'` — the payload
// field was ignored. So the runner MUST spawn with the agent's cwd, exactly as rch-mutator
// does. `cwd` is still sent in the payload for protocol fidelity with a real PreToolUse send,
// so this bridge keeps working if the binder later starts honouring it.
//
// ⛔ EXIT CODE IS NOT THE DECISION. The binder exits 0 on BOTH allow and deny; the verdict is
// on stdout. dcg-tool-bridge keys its decision on exitCode, and copying that here would have
// made every deny read as an allow. Silence + exit 0 is the only allow.
//
// transcript_path is deliberately NOT sent. A real Claude payload carries one, and the binder
// does not require it (verified: a payload without it still denies the wrong lane). Inventing
// a path to a transcript that does not exist would be fabricated evidence.

type JsonRecord = Record<string, unknown>;

export type ToolCallEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
};

export type BridgeContext = {
  cwd?: unknown;
  sessionManager?: { getSessionId?: () => unknown };
} | undefined;

export type LaneBindPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
  cwd?: string;
  session_id?: string;
};

export type LaneBindRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type LaneBindRunner = (
  payload: LaneBindPayload,
  cwd?: string,
) => Promise<LaneBindRunResult>;

export type BlockResult = { block: true; reason: string };

export const LANE_BIND_PATH = "/Users/josh/.local/bin/rch-lane-bind";
export const LANE_BIND_TIMEOUT_MS = 10_000;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function sessionIdOf(ctx: BridgeContext): string | undefined {
  try {
    return text(ctx?.sessionManager?.getSessionId?.());
  } catch {
    return undefined;
  }
}


export function buildLaneBindPayload(
  command: string,
  cwd?: string,
  sessionId?: string,
): LaneBindPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(cwd ? { cwd } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

export function evaluateLaneBindResult(result: LaneBindRunResult):
  | { kind: "allow" }
  | { kind: "block"; reason: string } {
  if (result.timedOut) {
    return { kind: "block", reason: "rch-lane-bind bridge timed out; refusing the bash tool call" };
  }
  if (result.stderr.trim() !== "") {
    return { kind: "block", reason: "rch-lane-bind bridge emitted stderr; refusing the bash tool call" };
  }

  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);

  // Silence is the ALLOW. The binder prints nothing when the lane is permitted, and prints
  // nothing when the command is not an rch invocation at all.
  if (lines.length === 0) {
    if (result.exitCode !== 0) {
      return {
        kind: "block",
        reason: `rch-lane-bind bridge exited ${result.exitCode} with no decision; refusing the bash tool call`,
      };
    }
    return { kind: "allow" };
  }

  let parsed: JsonRecord;
  try {
    const value: unknown = JSON.parse(lines[lines.length - 1]);
    const record = object(value);
    if (!record) throw new Error("not an object");
    parsed = record;
  } catch {
    return { kind: "block", reason: "rch-lane-bind bridge returned malformed JSON; refusing the bash tool call" };
  }

  const specific = object(parsed.hookSpecificOutput);
  const decision = text(specific?.permissionDecision);
  if (!decision) {
    return { kind: "block", reason: "rch-lane-bind bridge returned no permissionDecision; refusing the bash tool call" };
  }
  if (decision === "allow") return { kind: "allow" };
  if (decision === "deny") {
    const reason = text(specific?.permissionDecisionReason);
    return { kind: "block", reason: reason ?? "rch-lane-bind denied the bash tool call" };
  }
  return {
    kind: "block",
    reason: `rch-lane-bind bridge returned unknown permissionDecision '${decision}'; refusing the bash tool call`,
  };
}

type SpawnedChild = {
  stdin: { write: (chunk: string) => void; end: () => void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

export type SpawnProcess = (argv: string[], options: {
  cwd?: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => SpawnedChild;

export function makeLaneBindRunner(
  path = LANE_BIND_PATH,
  timeoutMs = LANE_BIND_TIMEOUT_MS,
  spawn: SpawnProcess = ((argv, options) => Bun.spawn(argv, options)) as SpawnProcess,
): LaneBindRunner {
  return async (payload, cwd) => {
    let timedOut = false;
    let child: SpawnedChild | undefined;
    try {
      // The binder reads no arguments in hook mode: payload on stdin, verdict on stdout.
      // cwd is the load-bearing argument here, not a convenience — see the header note.
      child = spawn([path], {
        ...(cwd ? { cwd } : {}),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child?.kill();
      }, timeoutMs);
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
        child.stdin.end();
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { exitCode, stdout, stderr, timedOut };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "rch-lane-bind bridge process failure",
        timedOut,
      };
    }
  };
}

export function createRchLaneBindBridge(
  runGate: LaneBindRunner = makeLaneBindRunner(),
) {
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<BlockResult | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;

      // Taken RAW — not trimmed, not normalised. cp-ou105: the binder parses
      // `rch exec -- cargo ...` differently from a bare `cargo ...`, so rewriting the bytes
      // here would mask that defect and make it unreproducible.
      const rawCommand = object(event.input)?.command;
      const command = typeof rawCommand === "string" && rawCommand.trim() !== "" ? rawCommand : undefined;
      if (!command) {
        return { block: true, reason: "OMP rch-lane-bind bridge: bash call has no command; refusing" };
      }

      const cwd = text(ctx?.cwd);
      let result: LaneBindRunResult;
      try {
        result = await runGate(buildLaneBindPayload(command, cwd, sessionIdOf(ctx)), cwd);
      } catch {
        return { block: true, reason: "OMP rch-lane-bind bridge failed to run rch-lane-bind; refusing" };
      }
      const decision = evaluateLaneBindResult(result);
      if (decision.kind === "allow") return undefined;
      return { block: true, reason: decision.reason };
    },
  };
}

type OmpExtensionApi = {
  on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: BridgeContext) => unknown) => void;
  appendEntry?: (customType: string, data: JsonRecord) => void | Promise<void>;
};

// Registered on `tool_call` only, following rch-mutator (the rch-family precedent) rather than
// dcg-tool-bridge's additional `user_bash` handler: lane ownership is about agent-dispatched
// builds, and silently refusing Joshua's own typed command is a larger surface than this bead
// authorises.
export default function rchLaneBindBridge(pi: OmpExtensionApi): void {
  const bridge = createRchLaneBindBridge(makeLaneBindRunner());
  pi.on("tool_call", async (event, ctx) => {
    const result = await bridge.handle(event, ctx);
    const isBashCall = event.type === "tool_call" && event.toolName === "bash";
    if (!pi.appendEntry || !isBashCall) return result;
    try {
      await pi.appendEntry("com.zeststream.omp-rch-lane-bind-bridge.decision.v1", {
        kind: result ? "lane_block" : "lane_allow",
        toolCallId: text(event.toolCallId) ?? "unknown",
        ...(result ? { reason: result.reason } : {}),
      });
    } catch {
      // Audit persistence must not change the safety decision.
    }
    return result;
  });
}
