import { strict as assert } from "node:assert";
import { test } from "bun:test";
import {
  createBashFailureJournalAdapter,
  type SpawnProcess,
} from "./ee-failure-journal.ts";

function resultEvent(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "call-default",
    input: { command: "opaque command text" },
    details: { exitCode: 7 },
    isError: true,
    content: [{ type: "text", text: "failure" }],
    ...overrides,
  };
}

function recordingSpawn(exitCode: number, calls: string[][]): SpawnProcess {
  return (argv) => {
    calls.push(argv);
    return { exited: Promise.resolve(exitCode), kill() {} };
  };
}

test("non-zero Bash result invokes ee with minimal argv", async () => {
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls),
    seen: new Set(),
  });

  await adapter.handle(
    resultEvent({
      toolCallId: "call-nonzero",
      input: { command: "SECRET=do-not-copy; exit 7" },
    }),
  );

  assert.deepEqual(calls, [[
    "/Users/josh/.local/bin/ee",
    "journal",
    "append",
    "OMP observed a non-zero Bash result.",
    "--source",
    "hook",
    "--kind",
    "command_failure",
    "--exit-code",
    "7",
    "--json",
  ]]);
  assert.equal(calls[0].includes("SECRET=do-not-copy; exit 7"), false);
});

test("zero, missing, and unparseable exit codes are silent", async () => {
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls),
    seen: new Set(),
  });

  await adapter.handle(resultEvent({ toolCallId: "call-zero", details: { exitCode: 0 } }));
  await adapter.handle(resultEvent({ toolCallId: "call-missing", details: {} }));
  await adapter.handle(resultEvent({ toolCallId: "call-string", details: { exitCode: "7" } }));

  assert.equal(calls.length, 0);
});

test("non-Bash result is silent", async () => {
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls),
    seen: new Set(),
  });

  await adapter.handle(resultEvent({ toolName: "read", toolCallId: "call-read" }));

  assert.equal(calls.length, 0);
});

test("ee failure remains non-blocking", async () => {
  let calls = 0;
  const adapter = createBashFailureJournalAdapter({
    spawn: () => {
      calls += 1;
      throw new Error("synthetic ee failure");
    },
    seen: new Set(),
  });

  await assert.doesNotReject(() =>
    adapter.handle(resultEvent({ toolCallId: "call-ee-failure" })),
  );
  assert.equal(calls, 1);
});

test("anti-vacuity: non-zero result must invoke the journal", async () => {
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls),
    seen: new Set(),
  });

  await adapter.handle(resultEvent({ toolCallId: "call-anti-vacuity" }));

  assert.equal(calls.length, 1);
});

test("duplicate tool-result delivery is harmless", async () => {
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls),
    seen: new Set(),
  });
  const event = resultEvent({ toolCallId: "call-duplicate" });

  await adapter.handle(event);
  await adapter.handle(event);

  assert.equal(calls.length, 1);
});

test("separate extension instances share duplicate suppression", async () => {
  const calls: string[][] = [];
  const first = createBashFailureJournalAdapter({ spawn: recordingSpawn(0, calls) });
  const second = createBashFailureJournalAdapter({ spawn: recordingSpawn(0, calls) });
  const event = resultEvent({ toolCallId: "call-multi-load" });

  await first.handle(event);
  await second.handle(event);

  assert.equal(calls.length, 1);
});
