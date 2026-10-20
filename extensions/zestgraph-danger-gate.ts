#!/usr/bin/env bun

type JsonRecord = Record<string, unknown>;

export type ToolCallEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
};

export type BridgeContext = { cwd?: unknown } | undefined;

export type DangerPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
};

export type DangerRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type DangerRunner = (payload: DangerPayload, cwd?: string) => Promise<DangerRunResult>;
export type BlockResult = { block: true; reason: string };

type SpawnedChild = {
  stdin: { write: (input: string) => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

type SpawnProcess = (argv: string[], options: {
  cwd?: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => SpawnedChild;

type OmpExtensionApi = {
  on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: BridgeContext) => unknown) => void;
};

const DANGER_PATH = "/Users/josh/.local/bin/zestgraph-danger-gate";
const DANGER_TIMEOUT_MS = 10_000;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function cwdOf(ctx: BridgeContext): string | undefined {
  return text(ctx?.cwd);
}

function commandOf(event: ToolCallEvent): string | undefined {
  const value = object(event.input)?.command;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function buildDangerPayload(command: string): DangerPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  };
}

function spawnNative(argv: string[], options: {
  cwd?: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}): SpawnedChild {
  return Bun.spawn(argv, options) as unknown as SpawnedChild;
}

export function makeDangerRunner(
  spawn: SpawnProcess = spawnNative,
  timeoutMs = DANGER_TIMEOUT_MS,
): DangerRunner {
  return async (payload, cwd) => {
    let child: SpawnedChild;
    try {
      child = spawn([DANGER_PATH], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
      return { exitCode: 1, stdout: "", stderr: "spawn failure", timedOut: false };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // The caller receives a fail-closed decision.
      }
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
    } catch {
      return { exitCode: 1, stdout: "", stderr: "child failure", timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function evaluateDangerResult(result: DangerRunResult):
  | { kind: "allow" }
  | { kind: "deny"; reason: string } {
  if (result.timedOut) return { kind: "deny", reason: "zestgraph danger gate timed out; refusing the Bash call" };
  if (result.exitCode !== 0) return { kind: "deny", reason: "zestgraph danger gate failed; refusing the Bash call" };
  if (result.stderr.trim() !== "") return { kind: "deny", reason: "zestgraph danger gate emitted stderr; refusing the Bash call" };

  const lines = result.stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return { kind: "deny", reason: "zestgraph danger gate returned no single decision; refusing the Bash call" };

  let parsed: JsonRecord;
  try {
    const value = JSON.parse(lines[0]);
    const record = object(value);
    if (!record) throw new Error("decision is not an object");
    parsed = record;
  } catch {
    return { kind: "deny", reason: "zestgraph danger gate returned malformed output; refusing the Bash call" };
  }

  const specific = object(parsed.hookSpecificOutput);
  if (specific?.hookEventName !== "PreToolUse") {
    return { kind: "deny", reason: "zestgraph danger gate returned an invalid hook position; refusing the Bash call" };
  }
  if (specific.permissionDecision === "allow") return { kind: "allow" };
  if (specific.permissionDecision === "deny") {
    return { kind: "deny", reason: text(specific.permissionDecisionReason) ?? "zestgraph danger gate denied the Bash call" };
  }
  return { kind: "deny", reason: "zestgraph danger gate returned an unknown decision; refusing the Bash call" };
}

export function createZestgraphDangerGate(runGate: DangerRunner = makeDangerRunner()) {
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<BlockResult | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;
      const command = commandOf(event);
      if (!command) return { block: true, reason: "OMP danger bridge: Bash call has no command; refusing" };

      let decision: { kind: "allow" } | { kind: "deny"; reason: string };
      try {
        decision = evaluateDangerResult(await runGate(buildDangerPayload(command), cwdOf(ctx)));
      } catch {
        decision = { kind: "deny", reason: "zestgraph danger gate failed; refusing the Bash call" };
      }
      if (decision.kind === "allow") return undefined;
      return { block: true, reason: decision.reason };
    },
  };
}

type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function allowResult(): DangerRunResult {
  return {
    exitCode: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\n',
    stderr: "",
    timedOut: false,
  };
}

function denyResult(): DangerRunResult {
  return {
    exitCode: 0,
    stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"fixture destructive command"}}\n',
    stderr: "",
    timedOut: false,
  };
}

async function selftest(): Promise<boolean> {
  const named: TestCase = {
    id: "omp-zestgraph-danger.deny",
    run: async () => {
      const bridge = createZestgraphDangerGate(async () => denyResult());
      const result = await bridge.handle({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "fixture",
        input: { command: "git reset --hard HEAD" },
      });
      assert(result?.block === true, "native deny did not block");
    },
  };
  const tests: TestCase[] = [
    named,
    {
      id: "omp-zestgraph-danger.allow",
      run: async () => {
        const bridge = createZestgraphDangerGate(async () => allowResult());
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "fixture", input: { command: "git status" } });
        assert(result === undefined, "native allow was blocked");
      },
    },
    {
      id: "omp-zestgraph-danger.malformed",
      run: async () => {
        const bridge = createZestgraphDangerGate(async () => ({ exitCode: 0, stdout: "not-json", stderr: "", timedOut: false }));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "fixture", input: { command: "git status" } });
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


export default function zestgraphDangerGate(pi: OmpExtensionApi): void {
  const bridge = createZestgraphDangerGate();
  pi.on("tool_call", async (event, ctx) => bridge.handle(event, ctx));
}
