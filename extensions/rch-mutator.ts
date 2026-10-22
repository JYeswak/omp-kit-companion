#!/usr/bin/env bun

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

export type RchPayload = {
  hook_event_name: "PreToolUse";
  tool_name: "Bash";
  tool_input: { command: string };
  session_id?: string;
};

export type RchRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type RchRunner = (payload: RchPayload, cwd: string) => Promise<RchRunResult>;
export type RewriteResult = { kind: "rewrite"; command: string } | { kind: "silent" };

 type SpawnedChild = {
  stdin: { write: (input: string) => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

type SpawnProcess = (argv: string[], options: {
  cwd: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => SpawnedChild;

type OmpExtensionApi = {
  on: (event: "tool_call", handler: (event: ToolCallEvent, ctx: BridgeContext) => unknown) => void;
};

const RCH_PATH = "/Users/josh/.local/bin/rch";
const RCH_TIMEOUT_MS = 10_000;

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

const NATIVE_RCH_PREFIX = "rch exec -- ";
const RCH_CARGO_WRAPPER_BYPASS = "RCH_CARGO_WRAPPER_BYPASS=1";
const UNSAFE_SHELL_SYNTAX = /[;&|<>`$()\r\n]/u;

function addCargoWrapperBypass(command: string): string {
  if (UNSAFE_SHELL_SYNTAX.test(command)) return command;

  const nativeCargo = `${NATIVE_RCH_PREFIX}cargo`;
  if (!command.startsWith(nativeCargo)) return command;
  const suffix = command.slice(nativeCargo.length);
  if (suffix !== "" && !/^[ \t]/u.test(suffix)) return command;

  return `${NATIVE_RCH_PREFIX}env ${RCH_CARGO_WRAPPER_BYPASS} cargo${suffix}`;
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

export function buildRchPayload(command: string, sessionId?: string): RchPayload {
  return {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function spawnNative(argv: string[], options: {
  cwd: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}): SpawnedChild {
  return Bun.spawn(argv, options) as unknown as SpawnedChild;
}

export function makeRchRunner(
  spawn: SpawnProcess = spawnNative,
  timeoutMs = RCH_TIMEOUT_MS,
): RchRunner {
  return async (payload, cwd) => {
    let child: SpawnedChild;
    try {
      child = spawn([RCH_PATH], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
      return { exitCode: 1, stdout: "", stderr: "spawn failure", timedOut: false };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Mutator failure is deliberately fail-open.
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

export function evaluateRchResult(result: RchRunResult): RewriteResult {
  if (result.timedOut || result.exitCode !== 0) return { kind: "silent" };

  // rch may emit informational logs on stdout before its one machine decision.
  // Only a valid native hook envelope can authorize a rewrite; all other output
  // remains the mutator's correct no-op.
  const decisions: JsonRecord[] = [];
  for (const line of result.stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
    try {
      const record = object(JSON.parse(line));
      if (object(record?.hookSpecificOutput)) decisions.push(record!);
    } catch {
      // Native diagnostics are not a rewrite decision.
    }
  }
  if (decisions.length !== 1) return { kind: "silent" };

  const specific = object(decisions[0].hookSpecificOutput);
  if (specific?.hookEventName !== "PreToolUse" || specific.permissionDecision !== "allow") {
    return { kind: "silent" };
  }
  const updated = object(specific.updatedInput);
  const command = updated?.command;
  return typeof command === "string" && command.length > 0
    ? { kind: "rewrite", command: addCargoWrapperBypass(command) }
    : { kind: "silent" };
}

export function createRchMutator(runGate: RchRunner = makeRchRunner()) {
  return {
    async handle(event: ToolCallEvent, ctx?: BridgeContext): Promise<{ input: Record<string, unknown> } | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;
      const input = object(event.input);
      const command = commandOf(event);
      const cwd = cwdOf(ctx);
      if (!input || command === undefined || cwd === undefined) return undefined;

      let decision: RewriteResult;
      try {
        decision = evaluateRchResult(await runGate(buildRchPayload(command, sessionIdOf(ctx)), cwd));
      } catch {
        return undefined;
      }
      if (decision.kind === "silent") return undefined;
      return { input: { ...input, command: decision.command } };
    },
  };
}

type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rewriteResult(command = "rch exec -- cargo check --workspace"): RchRunResult {
  return {
    exitCode: 0,
    stdout: [
      "2026-08-29T00:00:00Z INFO rch::hook: Compilation detected",
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command },
        },
      }),
      "",
    ].join("\n"),
    stderr: "",
    timedOut: false,
  };
}

async function selftest(): Promise<boolean> {
  const named: TestCase = {
    id: "omp-rch-mutator.rewrites",
    run: async () => {
      const bridge = createRchMutator(async () => rewriteResult());
      const result = await bridge.handle({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "fixture",
        input: { command: "cargo check --workspace" },
      }, { cwd: "/tmp/omp-rch-selftest", sessionManager: { getSessionId: () => "fixture-session" } }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
      assert(result?.input.command === "rch exec -- env RCH_CARGO_WRAPPER_BYPASS=1 cargo check --workspace", "native cargo rewrite lacks loop-break");
    },
  };
  const tests: TestCase[] = [
    named,
    {
      id: "omp-rch-mutator.non-cargo-unchanged",
      run: async () => {
        const bridge = createRchMutator(async () => rewriteResult("rch exec -- git status"));
        const result = await bridge.handle({
          type: "tool_call",
          toolName: "bash",
          input: { command: "git status" },
        }, { cwd: "/tmp/omp-rch-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result?.input.command === "rch exec -- git status", "non-cargo native rewrite changed");
      },
    },
    {
      id: "omp-rch-mutator.already-bypassed-unchanged",
      run: async () => {
        const command = "rch exec -- env RCH_CARGO_WRAPPER_BYPASS=1 cargo check --workspace";
        const bridge = createRchMutator(async () => rewriteResult(command));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "cargo check" } }, { cwd: "/tmp/omp-rch-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result?.input.command === command, "already-bypassed cargo rewrite changed");
      },
    },
    {
      id: "omp-rch-mutator.compound-unchanged",
      run: async () => {
        const command = "rch exec -- cargo check --workspace && echo done";
        const bridge = createRchMutator(async () => rewriteResult(command));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "cargo check" } }, { cwd: "/tmp/omp-rch-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result?.input.command === command, "compound native rewrite changed");
      },
    },
    {
      id: "omp-rch-mutator.silent-inverse",
      run: async () => {
        const bridge = createRchMutator(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "git status" } }, { cwd: "/tmp/omp-rch-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result === undefined, "native silence changed the Bash input");
      },
    },
    {
      id: "omp-rch-mutator.malformed-fail-open",
      run: async () => {
        const bridge = createRchMutator(async () => ({ exitCode: 0, stdout: "not-json", stderr: "", timedOut: false }));
        const result = await bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "cargo check" } }, { cwd: "/tmp/omp-rch-selftest" }); // tempsafe: fake cwd passed to a stubbed runner, never touched on disk
        assert(result === undefined, "malformed native output was not a no-op");
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

export default function rchMutator(pi: OmpExtensionApi): void {
  const bridge = createRchMutator();
  pi.on("tool_call", async (event, ctx) => bridge.handle(event, ctx));
}
