#!/usr/bin/env bun

import { run } from "../src/kitlib/run";
import {
  admitDeleteEffect,
  deleteEffectsOf,
  type DeleteApproval,
  type DeleteEffect,
} from "./delete-effect-admission";

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

export type SlbPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
  session_id?: string;
};

export type SlbRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  incomplete?: boolean;
};

export type SlbRunner = (payload: SlbPayload, cwd: string) => Promise<SlbRunResult>;
export type BlockResult = { block: true; reason: string };
type InputRevision = { input: JsonRecord; block?: never; reason?: never };
type SlbDecision =
  | { kind: "allow"; updatedInput?: { command: string } }
  | { kind: "deny"; reason: string };


type OmpExtensionApi = {
  on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: BridgeContext) => unknown) => void;
};

const SLB_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const SLB_TIMEOUT_MS = 10_000;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function commandOf(event: ToolCallEvent): string | undefined {
  const command = object(event.input)?.command;
  return typeof command === "string" ? command : undefined;
}

function cwdOf(ctx: BridgeContext): string | undefined {
  return nonEmptyText(ctx?.cwd);
}

function sessionIdOf(ctx: BridgeContext): string | undefined {
  try {
    return nonEmptyText(ctx?.sessionManager?.getSessionId?.());
  } catch {
    return undefined;
  }
}

export function buildSlbPayload(command: string, sessionId?: string): SlbPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}


export function makeSlbRunner(
  execute: typeof run = run,
  timeoutMs = SLB_TIMEOUT_MS,
): SlbRunner {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return async (payload, cwd) => {
    try {
      const executable = Bun.which("slb");
      if (!executable) {
        return { exitCode: 1, stdout: "", stderr: "native SLB executable not found", timedOut: false };
      }
      const result = await execute([executable, "hook", "guard"], {
        cwd,
        stdin: `${JSON.stringify(payload)}\n`,
        deadline_s: timeoutMs / 1000,
        max_output_bytes: SLB_OUTPUT_LIMIT_BYTES,
        max_total_bytes: SLB_OUTPUT_LIMIT_BYTES * 2,
      });
      return {
        exitCode: result.rc ?? 1,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
        timedOut: result.timed_out,
        incomplete: result.truncated || result.total_truncated || result.killed,
      };
    } catch {
      return { exitCode: 1, stdout: "", stderr: "native SLB process failure", timedOut: false };
    }
  };
}

export function evaluateSlbResult(result: SlbRunResult): SlbDecision {
  if (result.timedOut) return { kind: "deny", reason: "SLB guard timed out; refusing the Bash call" };
  if (result.incomplete) return { kind: "deny", reason: "SLB guard output was incomplete; refusing the Bash call" };
  if (result.exitCode !== 0) return { kind: "deny", reason: "SLB guard failed; refusing the Bash call" };
  if (result.stderr.trim() !== "") return { kind: "deny", reason: "SLB guard emitted stderr; refusing the Bash call" };

  const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return { kind: "deny", reason: "SLB guard returned no single decision; refusing the Bash call" };

  let parsed: JsonRecord;
  try {
    const value = JSON.parse(lines[0]);
    const record = object(value);
    if (!record) throw new Error("decision is not an object");
    parsed = record;
  } catch {
    return { kind: "deny", reason: "SLB guard returned malformed output; refusing the Bash call" };
  }

  const specific = object(parsed.hookSpecificOutput);
  if (specific?.hookEventName !== "PreToolUse") {
    return { kind: "deny", reason: "SLB guard returned an invalid hook position; refusing the Bash call" };
  }
  if (specific.permissionDecision === "allow") {
    if (!Object.hasOwn(specific, "updatedInput")) return { kind: "allow" };
    const updatedInput = object(specific.updatedInput);
    if (!updatedInput || Object.keys(updatedInput).length !== 1 ||
      typeof updatedInput.command !== "string" || updatedInput.command.trim() === "" ||
      updatedInput.command.includes("\0")) {
      return { kind: "deny", reason: "SLB guard returned an unsupported execution revision; refusing the Bash call" };
    }
    return { kind: "allow", updatedInput: { command: updatedInput.command } };
  }
  if (specific.permissionDecision === "deny" || specific.permissionDecision === "ask") {
    return {
      kind: "deny",
      reason: nonEmptyText(specific.permissionDecisionReason) ?? "SLB guard did not allow the Bash call",
    };
  }
  return { kind: "deny", reason: "SLB guard returned an unknown decision; refusing the Bash call" };
}

/**
 * Cross-adapter protected DELETE admission (bead ompkit-xa5s.23). When
 * configured, shell-rm AND edit-rem DELETE effects on protected paths require
 * the SAME valid approval from `approvalOf` (the shared SLB approval state),
 * in addition to the native SLB verdict for Bash. Unconfigured, behavior is
 * exactly the prior Bash-only bridge: edit calls pass through untouched.
 */
export type DeleteAdmission = {
  protectedRoots: readonly string[];
  approvalOf: (effect: DeleteEffect) => DeleteApproval | undefined;
  nowMs?: () => number;
};

export function createSlbGuard(runGate: SlbRunner = makeSlbRunner(), deleteAdmission?: DeleteAdmission) {
  const admitEffects = (
    effects: DeleteEffect[],
    toolCallId: string,
    admission: DeleteAdmission,
  ): BlockResult | undefined => {
    const nowMs = admission.nowMs?.() ?? Date.now();
    for (const effect of effects) {
      const verdict = admitDeleteEffect({
        effect,
        approval: admission.approvalOf(effect),
        protectedRoots: admission.protectedRoots,
        requestId: toolCallId,
        nowMs,
      });
      if (verdict.verdict === "deny") return { block: true, reason: verdict.reason };
    }
    return undefined;
  };
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<BlockResult | InputRevision | undefined> {
      if (event.type !== "tool_call") return undefined;
      const toolCallId =
        typeof event.toolCallId === "string" && event.toolCallId.trim() !== ""
          ? event.toolCallId
          : "unknown";
      if (event.toolName === "edit") {
        if (deleteAdmission === undefined) return undefined;
        return admitEffects(deleteEffectsOf("edit", event.input), toolCallId, deleteAdmission);
      }
      if (event.toolName !== "bash") return undefined;
      const command = commandOf(event);
      const cwd = cwdOf(ctx);
      if (command === undefined || cwd === undefined) {
        return { block: true, reason: "OMP SLB bridge: malformed Bash call; refusing" };
      }

      let decision: SlbDecision;
      try {
        decision = evaluateSlbResult(await runGate(buildSlbPayload(command, sessionIdOf(ctx)), cwd));
      } catch {
        decision = { kind: "deny", reason: "SLB guard failed; refusing the Bash call" };
      }
      if (decision.kind === "deny") return { block: true, reason: decision.reason };
      if (deleteAdmission !== undefined) {
        const blocked = admitEffects(deleteEffectsOf("bash", event.input), toolCallId, deleteAdmission);
        if (blocked) return blocked;
      }
      if (decision.updatedInput) {
        return { input: { ...object(event.input), command: decision.updatedInput.command } };
      }
      return undefined;
    },
  };
}

type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function allowResult(): SlbRunResult {
  return {
    exitCode: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
    stderr: "",
    timedOut: false,
  };
}

function denyResult(): SlbRunResult {
  return {
    exitCode: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SLB planted known-bad fixture"}}\n',
    stderr: "",
    timedOut: false,
  };
}

async function selftest(): Promise<boolean> {
  const named: TestCase = {
    id: "omp-slb-guard.deny",
    run: async () => {
      const bridge = createSlbGuard(async () => denyResult());
      const result = await bridge.handle({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "fixture",
        input: { command: "git reset --hard HEAD" },
      }, { cwd: "/tmp/omp-slb-selftest", sessionManager: { getSessionId: () => "fixture-session" } }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
      assert(result?.block === true, "native deny did not block");
    },
  };
  const tests: TestCase[] = [
    named,
    {
      id: "omp-slb-guard.allow",
      run: async () => {
        const bridge = createSlbGuard(async () => allowResult());
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "printf safe" } }, { cwd: "/tmp/omp-slb-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result === undefined, "native allow was blocked");
      },
    },
    {
      id: "omp-slb-guard.malformed",
      run: async () => {
        const bridge = createSlbGuard(async () => ({ exitCode: 0, stdout: "not-json", stderr: "", timedOut: false }));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "printf safe" } }, { cwd: "/tmp/omp-slb-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result?.block === true, "malformed native output was not refused");
      },
    },
  ];
  const expected = process.env.MUTATION_VERIFY_EXPECTED_TEST;
  const proof = process.env.MUTATION_VERIFY_PROOF_FILE;
  const nonce = process.env.MUTATION_VERIFY_NONCE;
  let failures = 0;
  let namedResult: "pass" | "expected-failure" = "pass";
  for (const test of tests) {
    try {
      await test.run();
      console.log("PASS " + test.id);
    } catch (error) {
      failures += 1;
      if (test.id === named.id) namedResult = "expected-failure";
      console.error("FAIL " + test.id + ": " + (error instanceof Error ? error.message : "unknown error"));
    }
  }
  if (expected === named.id && proof && nonce) {
    await Bun.write(proof, [
      "schema=zs.mutation-proof.v1",
      "nonce=" + nonce,
      "test=" + named.id,
      "result=" + namedResult,
      "",
    ].join("\n"));
  }
  return failures === 0;
}

if (import.meta.main && process.argv[2] === "--selftest") {
  process.exit((await selftest()) ? 0 : 1);
}

export default function slbGuardFailClosed(pi: OmpExtensionApi): void {
  const bridge = createSlbGuard();
  pi.on("tool_call", async (event, ctx) => bridge.handle(event, ctx));
}
