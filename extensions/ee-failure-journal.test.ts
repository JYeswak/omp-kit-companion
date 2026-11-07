import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp, type OwnedTmp } from "../src/kitlib/tmp.ts";
import {
  createBashFailureJournalAdapter,
  type SpawnProcess,
} from "./ee-failure-journal.ts";

let capture: OwnedTmp;
let savedPath: string | undefined;
beforeEach(() => {
  capture = ownedTmp("ee-capture-adapter");
  writeFileSync(join(capture.path, "zestgraph-ee-capture"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  savedPath = process.env.PATH;
  process.env.PATH = capture.path;
});
afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  capture.cleanup();
});

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

function recordingSpawn(exitCode: number, calls: string[][], payloads: string[] = []): SpawnProcess {
  return (argv) => {
    calls.push(argv);
    return {
      stdin: { write(text) { payloads.push(text); }, end() {} },
      stderr: new ReadableStream({ start(controller) { controller.close(); } }),
      exited: Promise.resolve(exitCode),
      kill() {},
    };
  };
}

test("non-zero Bash result invokes the capture adapter with command bytes only on stdin", async () => {
  const calls: string[][] = [];
  const payloads: string[] = [];
  const adapter = createBashFailureJournalAdapter({
    spawn: recordingSpawn(0, calls, payloads),
    seen: new Set(),
  });

  await adapter.handle(
    resultEvent({
      toolCallId: "call-nonzero",
      input: { command: "SECRET=do-not-copy; exit 7" },
    }),
  );

  assert.deepEqual(calls, [[join(capture.path, "zestgraph-ee-capture")]]);
  assert.equal(payloads.length, 1);
  assert.deepEqual(JSON.parse(payloads[0]).tool_input, { command: "SECRET=do-not-copy; exit 7" });
  assert.deepEqual(JSON.parse(payloads[0]).tool_response, { exit_code: 7, stderr_tail: "failure" });
  assert.equal(calls[0].includes("SECRET=do-not-copy; exit 7"), false);
});

test("the absent optional capture adapter stands down without invoking a process", async () => {
  process.env.PATH = join(capture.path, "missing");
  const calls: string[][] = [];
  const adapter = createBashFailureJournalAdapter({ spawn: recordingSpawn(0, calls), seen: new Set() });
  await adapter.handle(resultEvent({ toolCallId: "missing-capture" }));
  assert.deepEqual(calls, []);
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
