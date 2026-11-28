#!/usr/bin/env bun
import { realpathSync, statSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { run } from "../src/kitlib/run.ts";

type JsonRecord = Record<string, unknown>;

export type ToolCallEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
};

export type BridgeContext = { cwd?: unknown } | undefined;

export type DcgPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
  cwd?: string;
};

export type DcgRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type DcgRunner = (payload: DcgPayload) => Promise<DcgRunResult>;

export type BlockResult = { block: true; reason: string };

const DCG_TIMEOUT_MS = 10_000;
const DCG_MAX_OUTPUT_BYTES = 64 * 1024;
const DCG_UNAVAILABLE = "dcg executable is unavailable";
const decoder = new TextDecoder();

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function buildDcgPayload(command: string, cwd?: string): DcgPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(cwd ? { cwd } : {}),
  };
}

/** Guidance is data, not authority to grant an exception. Never expose human-only approval material. */
function safeGuidance(value: unknown): string {
  if (typeof value !== "string") return "";
  const plain: string = stripVTControlCharacters(value.slice(0, 8192));
  return plain
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .split(/\r?\n/u)
    .filter(line => !/allow[\s_-]*once|allow[\s_-]*list|\bbypass\b|DCG[_\s]*BYPASS/i.test(line))
    .map(line => line.replace(/\b[0-9]{6}\b/g, "[redacted]").replace(/\b[0-9a-f]{64}\b/gi, "[redacted]"))
    .join("\n").trim();
}

function denialReason(parsed: JsonRecord, includeGuidance: boolean): string {
  const reason = includeGuidance ? safeGuidance(parsed.reason) : "";
  const inferred = /^(?:Error: )?([A-Za-z0-9_.-]{1,95}:[A-Za-z0-9_.+-]{1,95}) \(fleet\):/m.exec(reason)?.[1];
  const candidate = text(parsed.rule_id) ?? inferred;
  const rule = candidate && /^[A-Za-z0-9_.:+-]{1,128}$/u.test(candidate)
    && !/allow[\s_-]*once|allow[\s_-]*list|bypass/i.test(candidate) ? candidate : undefined;
  const first = rule ? `dcg denied the bash tool call (${rule})` : "dcg denied the bash tool call";
  if (!includeGuidance) return first;
  const alternative = safeGuidance(parsed.safe_alternative);
  const explanation = safeGuidance(parsed.explanation);
  const full = [first, reason ? `Reason:\n${reason}` : "", alternative ? `Safe alternative: ${alternative}` : "",
    explanation ? `Explanation:\n${explanation}` : ""].filter(Boolean).join("\n");
  const marker = "\n[dcg guidance truncated]";
  return full.length <= 1200 ? full : full.slice(0, 1200 - marker.length) + marker;
}

export function evaluateDcgResult(result: DcgRunResult):
  | { kind: "allow" }
  | { kind: "block"; reason: string } {
  if (result.timedOut) {
    return { kind: "block", reason: "dcg bridge timed out; refusing the bash tool call" };
  }
  if (result.exitCode === 127 && result.stderr === DCG_UNAVAILABLE) {
    return { kind: "block", reason: `${DCG_UNAVAILABLE}; refusing the bash tool call` };
  }
  if (result.stderr.trim() !== "") {
    return { kind: "block", reason: "dcg bridge emitted stderr; refusing the bash tool call" };
  }

  const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    return { kind: "block", reason: "dcg bridge returned no single machine decision; refusing the bash tool call" };
  }

  let parsed: JsonRecord;
  try {
    const value: unknown = JSON.parse(lines[0]);
    const record = object(value);
    if (!record) throw new Error("not an object");
    parsed = record;
  } catch {
    return { kind: "block", reason: "dcg bridge returned malformed JSON; refusing the bash tool call" };
  }

  if (parsed.index !== 0 || parsed.decision !== "allow" || result.exitCode !== 0) {
    return {
      kind: "block",
      reason: denialReason(parsed, parsed.index === 0 && parsed.decision === "deny" && result.exitCode === 1),
    };
  }
  return { kind: "allow" };
}

export function makeDcgRunner(
  path = Bun.which("dcg", { PATH: process.env.PATH ?? "" }) ?? "",
  timeoutMs = DCG_TIMEOUT_MS,
): DcgRunner {
  return async (payload) => {
    if (!path) return { exitCode: 127, stdout: "", stderr: DCG_UNAVAILABLE, timedOut: false };
    const cwd = payload.cwd;
    if (cwd !== undefined && !isAbsolute(cwd)) {
      return { exitCode: 1, stdout: "", stderr: "dcg bridge command cwd must be absolute", timedOut: false };
    }
    const deadline = performance.now() + timeoutMs;
    const invoke = async (args: string[], input?: string): Promise<DcgRunResult> => {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
      try {
        const result = await run([path, ...args], {
          cwd, deadline_s: remainingMs / 1000, grace_s: 0.1, max_output_bytes: DCG_MAX_OUTPUT_BYTES,
          ...(input === undefined ? {} : { stdin: input }),
        });
        if (result.truncated || result.total_truncated || result.killed || result.rc === null) {
          return { exitCode: 1, stdout: "", stderr: "dcg bridge did not capture a complete result", timedOut: result.timed_out };
        }
        return { exitCode: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr), timedOut: result.timed_out };
      } catch {
        return { exitCode: 1, stdout: "", stderr: "dcg bridge process failure", timedOut: false };
      }
    };
    // Run exactly one DCG hook invocation on the allow path; only a confirmed deny gets an explanation.
    const result = await invoke(["hook", "--batch", "--robot"], `${JSON.stringify(payload)}\n`);
    if (result.exitCode !== 1 || result.timedOut || result.stderr.trim() || deadline <= performance.now()) return result;
    try {
      const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
      if (lines.length !== 1) return result;
      const decision = object(JSON.parse(lines[0]!));
      if (decision?.index !== 0 || decision.decision !== "deny") return result;
      // An explanation can enrich a deny, never authorize anything or replace a failed gate.
      const explained = await invoke(["explain", "--format", "json", "--robot", "--dialect", "posix", "--", payload.tool_input.command]);
      if (explained.exitCode !== 0 || explained.timedOut || explained.stderr.trim()) return result;
      const details = object(JSON.parse(explained.stdout));
      const match = object(details?.match);
      if (details?.decision !== "deny" || !match || (text(match.rule_id) ?? null) !== (text(decision.rule_id) ?? null)) return result;
      return { ...result, stdout: JSON.stringify({ ...decision, reason: match.reason, explanation: match.explanation }) + "\n" };
    } catch { return result; }
  };
}

export function createDcgToolBridge(
  runGate: DcgRunner = makeDcgRunner(),
) {
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<BlockResult | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;

      const input = object(event.input);
      const command = text(input?.command);
      if (!command) {
        return { block: true, reason: "OMP dcg bridge: bash call has no command; refusing" };
      }

      const requestedCwd = input?.cwd;
      const sessionCwd = text(ctx?.cwd);
      let cwd = sessionCwd;
      if (requestedCwd != null) {
        // OMP treats a bare slash as the workspace root. Delegate no ambiguous aliases:
        // OMP expands them itself and a guessed local path could select a different policy.
        if (typeof requestedCwd !== "string" || requestedCwd.length === 0 || requestedCwd.length > 4096
          || /^(?:[@~:]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(requestedCwd)
          || /[\u00a0\u2000-\u200b\u202f\u205f\u3000]/.test(requestedCwd)
          || (sessionCwd === undefined && (!isAbsolute(requestedCwd) || /^\/+$/.test(requestedCwd)))) {
          return { block: true, reason: "OMP dcg bridge: use an unambiguous local bash cwd; refusing" };
        }
        if (!/^\/+$/.test(requestedCwd)) cwd = isAbsolute(requestedCwd) ? requestedCwd : resolve(sessionCwd ?? process.cwd(), requestedCwd);
      }
      if (cwd !== undefined) {
        try {
          if (!isAbsolute(cwd)) throw new Error("cwd is not absolute");
          cwd = realpathSync(cwd);
          if (!statSync(cwd).isDirectory()) throw new Error("cwd is not a directory");
        } catch {
          return { block: true, reason: "OMP dcg bridge: bash cwd is not an accessible local directory; refusing" };
        }
      }

      let result: DcgRunResult;
      try {
        result = await runGate(buildDcgPayload(command, cwd));
      } catch {
        return { block: true, reason: "OMP dcg bridge failed to run dcg; refusing" };
      }
      const decision = evaluateDcgResult(result);
      if (decision.kind === "allow") return undefined;
      return { block: true, reason: decision.reason };
    },
  };
}
export type UserBashEvent = {
  type?: unknown;
  command?: unknown;
  excludeFromContext?: unknown;
  cwd?: unknown;
};

export type BashResult = {
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  timedOut?: boolean;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  artifactId?: string;
  workingDir?: string;
};

export type UserBashResult = { result: BashResult };

export function deniedUserBashResult(reason: string, cwd?: string): UserBashResult {
  const outputBytes = new TextEncoder().encode(reason).byteLength;
  return {
    result: {
      output: reason,
      exitCode: 126,
      cancelled: false,
      timedOut: false,
      truncated: false,
      totalLines: 1,
      totalBytes: outputBytes,
      outputLines: 1,
      outputBytes,
      ...(cwd ? { workingDir: cwd } : {}),
    },
  };
}

export function createDcgUserBashBridge(
  runGate: DcgRunner = makeDcgRunner(),
) {
  return {
    async handle(event: UserBashEvent): Promise<UserBashResult | undefined> {
      if (event.type !== "user_bash") return undefined;

      const command = text(event.command);
      const cwd = text(event.cwd);
      if (!command) {
        return deniedUserBashResult("OMP dcg bridge: user_bash has no command; refusing", cwd);
      }

      let result: DcgRunResult;
      try {
        result = await runGate(buildDcgPayload(command, cwd));
      } catch {
        return deniedUserBashResult("OMP dcg bridge failed to run dcg; refusing", cwd);
      }
      const decision = evaluateDcgResult(result);
      if (decision.kind === "allow") return undefined;
      return deniedUserBashResult(decision.reason, cwd);
    },
  };
}


type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function allowResult(): DcgRunResult {
  return { exitCode: 0, stdout: '{"index":0,"decision":"allow"}\n', stderr: "", timedOut: false };
}

function denyResult(): DcgRunResult {
  return { exitCode: 1, stdout: '{"index":0,"decision":"deny","rule_id":"fixture"}\n', stderr: "", timedOut: false };
}

async function selftest(): Promise<boolean> {
  let payload: DcgPayload | undefined;
  const bridge = createDcgToolBridge(async (candidate) => {
    payload = candidate;
    return allowResult();
  });
  const named: TestCase = {
    id: "dcg-user-bash.deny",
    run: async () => {
      const user = createDcgUserBashBridge(async () => denyResult());
      const result = await user.handle({
        type: "user_bash",
        command: "git status",
        excludeFromContext: false,
        cwd: "/tmp",
      });
      assert(result?.result.exitCode === 126, "user_bash deny did not return a failed BashResult");
    },
  };
  const tests: TestCase[] = [
    {
      id: "dcg-bridge.denied",
      run: async () => {
        const denied = createDcgToolBridge(async () => denyResult());
        const result = await denied.handle(
          { type: "tool_call", toolName: "bash", toolCallId: "fixture", input: { command: "git status" } },
          { cwd: "/tmp" },
        );
        assert(result?.block === true, "denied dcg decision was not blocked");
      },
    },
    {
      id: "dcg-bridge.guidance",
      run: () => {
        const result = evaluateDcgResult({
          ...denyResult(),
          stdout: JSON.stringify({ index: 0, decision: "deny", rule_id: "fixture",
            reason: "Preserve existing work", safe_alternative: "omp-kit land --help",
            explanation: "Do not overwrite peer changes.\ndcg allow-once 654321\nDCG_BYPASS=1" }) + "\n",
        });
        assert(result.kind === "block", "guidance changed the deny decision");
        assert(result.reason.startsWith("dcg denied the bash tool call (fixture)\n"), "grouping line changed");
        assert(result.reason.includes("Preserve existing work") && result.reason.includes("omp-kit land --help"), "upstream recovery guidance missing");
        assert(!/allow.once|654321|DCG_BYPASS/i.test(result.reason), "human-only approval escaped");
      },
    },
    named,

    {
      id: "dcg-bridge.allow",
      run: async () => {
        const result = await bridge.handle(
          { type: "tool_call", toolName: "bash", toolCallId: "fixture", input: { command: "git status" } },
          { cwd: "/tmp" },
        );
        assert(result === undefined, "allow decision was blocked");
        assert(payload?.tool_name === "Bash", "payload tool name drifted");
        assert(payload?.tool_input.command === "git status", "payload command drifted");
        assert(payload?.cwd === realpathSync("/tmp"), "physical payload cwd drifted");
      },
    },
    {
      id: "dcg-bridge.fail-closed",
      run: async () => {
        const malformed = createDcgToolBridge(async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        }));
        const result = await malformed.handle({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "fixture",
          input: { command: "git status" },
        });
        assert(result?.block === true, "malformed dcg result was not blocked");
      },
    },
    {
      id: "dcg-bridge.anti-vacuity",
      run: async () => {
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "fixture", input: {} });
        assert(result?.block === true, "missing bash command was not blocked");
      },
    },
    {
      id: "dcg-user-bash.allow",
      run: async () => {
        let candidate: DcgPayload | undefined;
        const user = createDcgUserBashBridge(async payload => {
          candidate = payload;
          return allowResult();
        });
        const result = await user.handle({
          type: "user_bash",
          command: "git status",
          excludeFromContext: false,
          cwd: "/tmp",
        });
        assert(result === undefined, "user_bash allow decision was blocked");
        assert(candidate?.tool_input.command === "git status", "user_bash command drifted");
        assert(candidate?.cwd === "/tmp", "user_bash cwd drifted");
      },
    },
    {
      id: "dcg-user-bash.fail-closed",
      run: async () => {
        const user = createDcgUserBashBridge(async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        }));
        const result = await user.handle({
          type: "user_bash",
          command: "git status",
          excludeFromContext: false,
          cwd: "/tmp",
        });
        assert(result?.result.exitCode === 126, "malformed user_bash decision was not refused");
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
      console.log(`PASS ${test.id}`);
    } catch (error) {
      failures += 1;
      if (test.id === named.id) namedResult = "expected-failure";
      console.error(`FAIL ${test.id}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  if (expected === named.id && proof && nonce) {
    await Bun.write(proof, `schema=zs.mutation-proof.v1\nnonce=${nonce}\ntest=${named.id}\nresult=${namedResult}\n`);
  }
  return failures === 0;
}

if (import.meta.main && process.argv[2] === "--selftest") {
  process.exit((await selftest()) ? 0 : 1);
}

type OmpExtensionApi = {
  on: {
    (event: "tool_call", handler: (event: ToolCallEvent, ctx: BridgeContext) => unknown): void;
    (event: "user_bash", handler: (event: UserBashEvent) => unknown): void;
  };
  appendEntry?: (customType: string, data: JsonRecord) => void | Promise<void>;
};

export default function dcgToolBridge(pi: OmpExtensionApi): void {
  const runGate = makeDcgRunner();
  const bridge = createDcgToolBridge(runGate);
  const userBash = createDcgUserBashBridge(runGate);
  pi.on("tool_call", async (event, ctx) => {
    const result = await bridge.handle(event, ctx);
    const isBashCall = event.type === "tool_call" && event.toolName === "bash";
    if (!pi.appendEntry || !isBashCall) return result;
    try {
      await pi.appendEntry("com.zeststream.omp-dcg-bridge.decision.v1", {
        kind: result ? "dcg_block" : "dcg_allow",
        toolCallId: text(event.toolCallId) ?? "unknown",
        ...(result ? { reason: result.reason } : {}),
      });
    } catch {
      // Audit persistence must not change the safety decision.
    }
    return result;
  });
  pi.on("user_bash", async (event) => userBash.handle(event));
}
