#!/usr/bin/env bun

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

const DCG_PATH = "/Users/josh/.local/bin/dcg";
const DCG_TIMEOUT_MS = 10_000;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function cwdOf(ctx: BridgeContext): string | undefined {
  return text(ctx?.cwd);
}

function commandOf(event: ToolCallEvent): string | undefined {
  const input = object(event.input);
  return text(input?.command);
}

export function buildDcgPayload(command: string, cwd?: string): DcgPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(cwd ? { cwd } : {}),
  };
}

export function evaluateDcgResult(result: DcgRunResult):
  | { kind: "allow" }
  | { kind: "block"; reason: string } {
  if (result.timedOut) {
    return { kind: "block", reason: "dcg bridge timed out; refusing the bash tool call" };
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
    const rule = text(parsed.rule_id);
    return {
      kind: "block",
      reason: rule ? `dcg denied the bash tool call (${rule})` : "dcg denied the bash tool call",
    };
  }
  return { kind: "allow" };
}

export function makeDcgRunner(
  path = DCG_PATH,
  timeoutMs = DCG_TIMEOUT_MS,
): DcgRunner {
  return async (payload) => {
    let timedOut = false;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      child = Bun.spawn([path, "hook", "--batch", "--robot"], {
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
        stderr: "dcg bridge process failure",
        timedOut,
      };
    }
  };
}

export function createDcgToolBridge(
  runGate: DcgRunner = makeDcgRunner(),
) {
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<BlockResult | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;

      const command = commandOf(event);
      if (!command) {
        return { block: true, reason: "OMP dcg bridge: bash call has no command; refusing" };
      }

      let result: DcgRunResult;
      try {
        result = await runGate(buildDcgPayload(command, cwdOf(ctx)));
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
        assert(payload?.cwd === "/tmp", "payload cwd drifted");
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
