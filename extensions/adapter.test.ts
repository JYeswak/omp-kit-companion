import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { test } from "bun:test";
import { createObservationalAdapter } from "./adapter.ts";

function event(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "tool_result",
    toolCallId: "call-1",
    input: {},
    content: [{ type: "text", text: "ok" }],
    ...overrides,
  };
}

test("captures targeted write/edit success once and ignores duplicates/non-targets", async () => {
  const captures: unknown[] = [];
  const adapter = createObservationalAdapter({ capture: (value) => captures.push(value) });

  assert.equal(
    await adapter.handle(event({ toolName: "write", toolCallId: "write-1", input: { path: "src/a.ts", content: "x" } })),
    "captured",
  );
  assert.equal(
    await adapter.handle(event({ toolName: "edit", toolCallId: "edit-1", input: { path: "src/b.ts", input: "ignored" } })),
    "captured",
  );
  assert.equal(
    await adapter.handle(event({ toolName: "write", toolCallId: "write-1", input: { path: "src/a.ts", content: "x" } })),
    "ignored",
  );
  assert.equal(await adapter.handle(event({ toolName: "read", toolCallId: "read-1", input: { path: "src/c.ts" } })), "ignored");

  assert.deepEqual(captures, [
    { kind: "successful_tool_result", toolName: "write", toolCallId: "write-1", paths: ["src/a.ts"] },
    { kind: "successful_tool_result", toolName: "edit", toolCallId: "edit-1", paths: ["src/b.ts"] },
  ]);
});

test("captures an OMP hashline edit target when normalized path is absent", async () => {
  const captures: unknown[] = [];
  const adapter = createObservationalAdapter({ capture: (value) => captures.push(value) });

  assert.equal(
    await adapter.handle(
      event({ toolName: "edit", toolCallId: "edit-hashline", input: { input: "¶src/c.ts#ABCD\n+changed" } }),
    ),
    "captured",
  );
  assert.deepEqual(captures, [
    { kind: "successful_tool_result", toolName: "edit", toolCallId: "edit-hashline", paths: ["src/c.ts"] },
  ]);
});

test("journals one non-zero Bash result and deduplicates it", async () => {
  const failures: unknown[] = [];
  const adapter = createObservationalAdapter({ failure: (value) => failures.push(value) });
  const failed = event({
    toolName: "bash",
    toolCallId: "bash-1",
    input: { command: "printf 'failure'; exit 7" },
    details: { exitCode: 7 },
    isError: true,
  });

  assert.equal(await adapter.handle(failed), "journaled");
  assert.equal(await adapter.handle(failed), "ignored");
  assert.deepEqual(failures, [
    {
      kind: "bash_failure",
      toolName: "bash",
      toolCallId: "bash-1",
      exitCode: 7,
      command: "printf 'failure'; exit 7",
    },
  ]);
});

test("silences zero, missing, unparseable, and non-Bash results", async () => {
  const failures: unknown[] = [];
  const adapter = createObservationalAdapter({ failure: (value) => failures.push(value) });

  for (const [name, details] of [
    ["zero", { exitCode: 0 }],
    ["missing", {}],
    ["unparseable", { exitCode: "not-a-number" }],
  ] as const) {
    assert.equal(
      await adapter.handle(event({ toolName: "bash", toolCallId: `bash-${name}`, input: { command: "ignored" }, details })),
      "ignored",
    );
  }
  assert.equal(
    await adapter.handle(event({ toolName: "grep", toolCallId: "grep-1", input: {}, details: { exitCode: 9 }, isError: true })),
    "ignored",
  );
  assert.equal(
    await adapter.handle(event({ toolName: "write", toolCallId: "write-error", input: { path: "src/bad.ts" }, isError: true })),
    "ignored",
  );
  assert.equal(failures.length, 0);
});

test("malformed/untrusted input is data only and cannot execute shell text", async () => {
  const failures: unknown[] = [];
  const adapter = createObservationalAdapter({ failure: (value) => failures.push(value) });
  const marker = `/tmp/omp-observational-must-not-execute-${crypto.randomUUID()}`; // tempsafe: marker path the test asserts is never created
  const untrusted = `printf '$(touch ${marker})'; exit 9`;

  assert.equal(
    await adapter.handle(
      event({ toolName: "bash", toolCallId: "bash-untrusted", input: { command: untrusted }, details: { exitCode: 9 } }),
    ),
    "journaled",
  );
  assert.equal(existsSync(marker), false);
  assert.equal(await adapter.handle({ type: "tool_result", toolName: "bash", toolCallId: "bad-1", input: "not-an-object" }), "ignored");
  assert.equal(await adapter.handle({ type: "tool_result", toolName: "bash", toolCallId: "bad-2", input: {}, details: { exitCode: {} } }), "ignored");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], {
    kind: "bash_failure",
    toolName: "bash",
    toolCallId: "bash-untrusted",
    exitCode: 9,
    command: untrusted,
  });
});

test("rejects successful edit without path or hashline target", async () => {
  const captures: unknown[] = [];
  const adapter = createObservationalAdapter({ capture: (value) => captures.push(value) });
  assert.equal(
    await adapter.handle({
      type: "tool_result",
      toolName: "edit",
      toolCallId: "scope-edit",
      input: { input: "replace text only; no path or hashline target" },
      content: [{ type: "text", text: "ok" }],
    }),
    "ignored",
  );
  assert.equal(captures.length, 0);
});
