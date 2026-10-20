#!/usr/bin/env bun

type JsonRecord = Record<string, unknown>;

export type ToolCallEvent = {
  type?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  input?: unknown;
};

export type UserBashEvent = {
  type?: unknown;
  command?: unknown;
  excludeFromContext?: unknown;
  cwd?: unknown;
};

export type SpawnCapPayload = {
  tool_name: "Bash";
  tool_input: { command: string };
};

export type SpawnCapRunResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type SpawnCapRunner = (payload: SpawnCapPayload) => Promise<SpawnCapRunResult>;
export type BlockResult = { block: true; reason: string };

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

type SpawnedChild = {
  stdin: { write: (input: string) => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

type SpawnProcess = (argv: string[], options: {
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => SpawnedChild;

type OmpExtensionApi = {
  on: {
    (event: "tool_call", handler: (event: ToolCallEvent) => unknown): void;
    (event: "user_bash", handler: (event: UserBashEvent) => unknown): void;
  };
};

const SPAWN_CAP_PATH = "/Users/josh/Developer/control-plane/bin/zeststream-cast-spawn-cap.sh";
const SPAWN_CAP_TIMEOUT_MS = 10_000;

function object(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function commandFromToolCall(event: ToolCallEvent): string | undefined {
  return text(object(event.input)?.command);
}

export function buildSpawnCapPayload(command: string): SpawnCapPayload {
  return {
    tool_name: "Bash",
    tool_input: { command },
  };
}

function spawnCapProcess(argv: string[], options: Parameters<typeof Bun.spawn>[1]): SpawnedChild {
  return Bun.spawn(argv, options) as unknown as SpawnedChild;
}

export function makeSpawnCapRunner(
  spawn: SpawnProcess = spawnCapProcess,
  timeoutMs = SPAWN_CAP_TIMEOUT_MS,
): SpawnCapRunner {
  return async (payload) => {
    let child: SpawnedChild;
    try {
      child = spawn([SPAWN_CAP_PATH], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    } catch {
      return { exitCode: 1, stdout: "", stderr: "spawn-cap process failure", timedOut: false };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // A failed kill still resolves to the fail-closed result below.
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
      return { exitCode: 1, stdout: "", stderr: "spawn-cap process failure", timedOut };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function evaluateSpawnCapResult(result: SpawnCapRunResult):
  | { kind: "allow" }
  | { kind: "deny"; reason: string } {
  if (result.timedOut) {
    return { kind: "deny", reason: "zeststream-cast spawn cap timed out; refusing the Bash call" };
  }
  if (result.exitCode !== 0) {
    return { kind: "deny", reason: "zeststream-cast spawn cap failed; refusing the Bash call" };
  }
  if (result.stderr.trim() !== "") {
    return { kind: "deny", reason: "zeststream-cast spawn cap emitted stderr; refusing the Bash call" };
  }
  if (result.stdout.trim() === "") return { kind: "allow" };

  let parsed: JsonRecord;
  try {
    const value = JSON.parse(result.stdout.trim());
    const record = object(value);
    if (!record) throw new Error("decision is not an object");
    parsed = record;
  } catch {
    return { kind: "deny", reason: "zeststream-cast spawn cap returned malformed output; refusing the Bash call" };
  }

  const specific = object(parsed.hookSpecificOutput);
  if (specific?.permissionDecision !== "deny") {
    return { kind: "deny", reason: "zeststream-cast spawn cap returned an unknown decision; refusing the Bash call" };
  }
  return {
    kind: "deny",
    reason: text(specific.permissionDecisionReason) ?? "zeststream-cast spawn cap denied the Bash call",
  };
}

export function createSpawnCapToolBridge(runGate: SpawnCapRunner = makeSpawnCapRunner()) {
  return {
    async handle(event: ToolCallEvent): Promise<BlockResult | undefined> {
      if (event.type !== "tool_call" || event.toolName !== "bash") return undefined;
      const command = commandFromToolCall(event);
      if (!command) return { block: true, reason: "OMP spawn-cap bridge: Bash call has no command; refusing" };

      let decision: { kind: "allow" } | { kind: "deny"; reason: string };
      try {
        decision = evaluateSpawnCapResult(await runGate(buildSpawnCapPayload(command)));
      } catch {
        decision = { kind: "deny", reason: "zeststream-cast spawn cap failed; refusing the Bash call" };
      }
      if (decision.kind === "allow") return undefined;
      return { block: true, reason: decision.reason };
    },
  };
}

function deniedUserBashResult(reason: string, cwd?: string): UserBashResult {
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

export function createSpawnCapUserBashBridge(runGate: SpawnCapRunner = makeSpawnCapRunner()) {
  return {
    async handle(event: UserBashEvent): Promise<UserBashResult | undefined> {
      if (event.type !== "user_bash") return undefined;
      const command = text(event.command);
      const cwd = text(event.cwd);
      if (!command) return deniedUserBashResult("OMP spawn-cap bridge: user_bash has no command; refusing", cwd);

      let decision: { kind: "allow" } | { kind: "deny"; reason: string };
      try {
        decision = evaluateSpawnCapResult(await runGate(buildSpawnCapPayload(command)));
      } catch {
        decision = { kind: "deny", reason: "zeststream-cast spawn cap failed; refusing the Bash call" };
      }
      if (decision.kind === "allow") return undefined;
      return deniedUserBashResult(decision.reason, cwd);
    },
  };
}

type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function allowResult(): SpawnCapRunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}

function denyResult(): SpawnCapRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "fixture cap reached",
      },
    }),
    stderr: "",
    timedOut: false,
  };
}

async function selftest(): Promise<boolean> {
  const named: TestCase = {
    id: "omp-spawn-cap.denied",
    run: async () => {
      const bridge = createSpawnCapUserBashBridge(async () => denyResult());
      const result = await bridge.handle({
        type: "user_bash",
        command: "ntm add zeststream-cast --cod=1",
        excludeFromContext: false,
        cwd: "/tmp",
      });
      assert(result?.result.exitCode === 126, "denied user_bash did not return exit 126");
      assert(result.result.cancelled === false, "denied user_bash was marked cancelled");
    },
  };
  const tests: TestCase[] = [
    named,
    {
      id: "omp-spawn-cap.allow",
      run: async () => {
        const bridge = createSpawnCapUserBashBridge(async () => allowResult());
        const result = await bridge.handle({
          type: "user_bash",
          command: "printf safe",
          excludeFromContext: false,
          cwd: "/tmp",
        });
        assert(result === undefined, "healthy user_bash was blocked");
      },
    },
    {
      id: "omp-spawn-cap.malformed",
      run: async () => {
        const bridge = createSpawnCapUserBashBridge(async () => ({
          exitCode: 0,
          stdout: "not-json",
          stderr: "",
          timedOut: false,
        }));
        const result = await bridge.handle({
          type: "user_bash",
          command: "printf safe",
          excludeFromContext: false,
          cwd: "/tmp",
        });
        assert(result?.result.exitCode === 126, "malformed output was not refused");
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
    (event: "tool_call", handler: (event: ToolCallEvent) => unknown): void;
    (event: "user_bash", handler: (event: UserBashEvent) => unknown): void;
  };
};

export default function zeststreamCastSpawnCap(pi: OmpExtensionApi): void {
  const runGate = makeSpawnCapRunner();
  const toolBridge = createSpawnCapToolBridge(runGate);
  const userBashBridge = createSpawnCapUserBashBridge(runGate);
  pi.on("tool_call", async event => toolBridge.handle(event));
  pi.on("user_bash", async event => userBashBridge.handle(event));
}
