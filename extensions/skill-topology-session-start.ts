#!/usr/bin/env bun

type JsonRecord = Record<string, unknown>;

export type SessionStartEvent = {
  type?: unknown;
};

export type SessionStartContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify: (message: string, level: "info" | "warning" | "error") => void;
  };
  sessionManager: {
    getSessionId: () => string;
  };
};

export type SessionStartPayload = {
  hook_event_name: "SessionStart";
  session_id: string;
  cwd: string;
};

export type TopologyCommand = "zestgraph-skill-topology-gate" | "skill-topology-hook";

export type TopologyRunResult = {
  command: TopologyCommand;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type TopologyHookRunner = (payload: SessionStartPayload, cwd: string) => Promise<TopologyRunResult[]>;
export type AdvisorySink = (message: string) => void | Promise<void>;

export type SpawnedChild = {
  stdin: { write: (input: string) => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

export type SpawnProcess = (argv: string[], options: {
  cwd: string;
  stdin: "pipe";
  stdout: "pipe";
  stderr: "pipe";
}) => SpawnedChild;

type OmpExtensionApi = {
  on: (event: "session_start", handler: (event: SessionStartEvent, ctx: SessionStartContext) => unknown) => void;
  sendMessage: (message: string, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }) => void;
};

const GATE_PATH = "/Users/josh/.local/bin/zestgraph-skill-topology-gate";
const HOOK_PATH = "/Users/josh/.local/bin/skill-topology-hook";
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_FAILURE_MESSAGE = "skill-topology SessionStart command failed; inspect native hook health.";

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

function spawnNative(argv: string[], options: Parameters<typeof Bun.spawn>[1]): SpawnedChild {
  return Bun.spawn(argv, options) as unknown as SpawnedChild;
}

async function runOne(
  command: TopologyCommand,
  path: string,
  payload: SessionStartPayload,
  cwd: string,
  spawn: SpawnProcess,
  timeoutMs: number,
): Promise<TopologyRunResult> {
  let child: SpawnedChild;
  try {
    child = spawn([path, "--hook"], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch {
    return { command, exitCode: 1, stdout: "", stderr: "", timedOut: false };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // Failure is reported as an advisory notice below.
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
    return { command, exitCode, stdout, stderr, timedOut };
  } catch {
    return { command, exitCode: 1, stdout: "", stderr: "", timedOut };
  } finally {
    clearTimeout(timer);
  }
}

export function makeTopologyHookRunner(
  spawn: SpawnProcess = spawnNative,
  timeoutMs = COMMAND_TIMEOUT_MS,
): TopologyHookRunner {
  return async (payload, cwd) => Promise.all([
    runOne("zestgraph-skill-topology-gate", GATE_PATH, payload, cwd, spawn, timeoutMs),
    runOne("skill-topology-hook", HOOK_PATH, payload, cwd, spawn, timeoutMs),
  ]);
}

export function buildSessionStartPayload(sessionId: string, cwd: string): SessionStartPayload {
  return { hook_event_name: "SessionStart", session_id: sessionId, cwd };
}

export function createSkillTopologySessionStartAdapter(
  runHooks: TopologyHookRunner,
  notify: AdvisorySink,
) {
  return {
    async handle(event: SessionStartEvent, ctx: SessionStartContext): Promise<void> {
      if (event?.type !== "session_start") return;
      const sessionId = nonEmptyText(ctx?.sessionManager?.getSessionId()) ?? "unknown";
      const cwd = nonEmptyText(ctx?.cwd) ?? ".";
      let results: TopologyRunResult[];
      try {
        results = await runHooks(buildSessionStartPayload(sessionId, cwd), cwd);
      } catch {
        await notify(COMMAND_FAILURE_MESSAGE);
        return;
      }

      for (const result of results) {
        if (result.stdout.trim() !== "") await notify(result.stdout);
        if (result.timedOut || result.exitCode !== 0) await notify(COMMAND_FAILURE_MESSAGE);
      }
    },
  };
}

type TestCase = { id: string; run: () => Promise<void> | void };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function selftest(): Promise<boolean> {
  const named: TestCase = {
    id: "omp-skill-topology.drift",
    run: async () => {
      const messages: string[] = [];
      const adapter = createSkillTopologySessionStartAdapter(
        async () => [resultFixture("zestgraph-skill-topology-gate", "TOPOLOGY DRIFT")],
        message => messages.push(message),
      );
      await adapter.handle({ type: "session_start" }, sessionFixture());
      assert(messages.length === 1 && messages[0] === "TOPOLOGY DRIFT", "drift advisory was not delivered");
    },
  };
  const tests: TestCase[] = [
    named,
    {
      id: "omp-skill-topology.healthy",
      run: async () => {
        const messages: string[] = [];
        const adapter = createSkillTopologySessionStartAdapter(
          async () => [resultFixture("zestgraph-skill-topology-gate", "")],
          message => messages.push(message),
        );
        await adapter.handle({ type: "session_start" }, sessionFixture());
        assert(messages.length === 0, "healthy topology emitted an advisory");
      },
    },
    {
      id: "omp-skill-topology.foreign",
      run: async () => {
        let called = false;
        const adapter = createSkillTopologySessionStartAdapter(
          async () => {
            called = true;
            return [];
          },
          () => {},
        );
        await adapter.handle({ type: "session_shutdown" }, sessionFixture());
        assert(!called, "foreign lifecycle event invoked topology commands");
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
    await Bun.write(proof, ["schema=zs.mutation-proof.v1", "nonce=" + nonce, "test=" + named.id, "result=" + namedResult, ""].join("\n"));
  }
  return failures === 0;
}

function resultFixture(command: TopologyCommand, stdout: string): TopologyRunResult {
  return { command, exitCode: 0, stdout, stderr: "", timedOut: false };
}

function sessionFixture(): SessionStartContext {
  return { cwd: "/tmp", hasUI: false, ui: { notify() {} }, sessionManager: { getSessionId: () => "selftest" } };
}

if (import.meta.main && process.argv[2] === "--selftest") {
  process.exit((await selftest()) ? 0 : 1);
}

export default function skillTopologySessionStart(pi: OmpExtensionApi): void {
  const adapter = createSkillTopologySessionStartAdapter(
    makeTopologyHookRunner(),
    message => pi.sendMessage(message, { deliverAs: "nextTurn" }),
  );
  pi.on("session_start", async (event, ctx) => adapter.handle(event, ctx));
}
