import { expect, test } from "bun:test";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMineResult } from "../src/mine-cause.ts";
import { run } from "../src/kitlib/run.ts";
import dcgToolBridge, {
  buildDcgPayload,
  createDcgToolBridge,
  createDcgUserBashBridge,
  evaluateDcgResult,
  makeDcgRunner,
  type DcgRunResult,
  type ToolCallEvent,
  type BridgeContext,
} from "./dcg-tool-bridge.ts";

const allow: DcgRunResult = {
  exitCode: 0,
  stdout: '{"index":0,"decision":"allow"}\n',
  stderr: "",
  timedOut: false,
};

test("DCGCWD1 a loaded bridge refuses bash when its DCG binary is absent", async () => {
  const saved = process.env.PATH;
  const empty = ownedTmp("dcg-absent");
  process.env.PATH = empty.path;
  try {
    type BashHandler = (event: ToolCallEvent, ctx: BridgeContext) => unknown;
    const registrations: string[] = [];
    const handlers: { bash?: BashHandler } = {};
    dcgToolBridge({ on: (event, handler) => {
      registrations.push(event);
      if (event === "tool_call") handlers.bash = handler as BashHandler;
    } });
    expect(registrations).toEqual(["tool_call", "user_bash"]);
    if (!handlers.bash) throw new Error("bash guard was not registered");
    expect(await handlers.bash({ type: "tool_call", toolName: "bash", input: { command: "git status" } }, { cwd: empty.path }))
      .toEqual({ block: true, reason: "dcg executable is unavailable; refusing the bash tool call" });
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
    empty.cleanup();
  }
});

test("maps an OMP bash call to dcg's JSONL hook contract", async () => {
  let received: unknown;
  const bridge = createDcgToolBridge(async (payload) => {
    received = payload;
    return allow;
  });

  await expect(
    bridge.handle(
      { type: "tool_call", toolName: "bash", toolCallId: "call-1", input: { command: "git status" } },
      { cwd: "/tmp" },
    ),
  ).resolves.toBeUndefined();
  expect(received).toEqual(buildDcgPayload("git status", realpathSync("/tmp")));
});

test("DCGCWD1 evaluates and explains in the Bash target directory, not the session directory", async () => {
  const scratch = ownedTmp("dcg-cwd-target");
  try {
    const protectedDir = join(scratch.path, "protected-project");
    const otherDir = join(scratch.path, "other-project");
    mkdirSync(protectedDir);
    mkdirSync(otherDir);
    symlinkSync(protectedDir, join(scratch.path, "protected-alias"), "dir");
    symlinkSync(otherDir, join(scratch.path, "other-alias"), "dir");
    const executable = join(scratch.path, "dcg-fixture");
    writeFileSync(executable, `#!${process.execPath}
const protectedProject = process.cwd().endsWith("/protected-project");
if (process.argv[2] === "explain") {
  console.log(JSON.stringify({ decision: protectedProject ? "deny" : "allow", match: { rule_id: "fixture:deploy", reason: "protected directory policy" } }));
  process.exit(0);
}
const request = JSON.parse(await Bun.stdin.text());
if (!process.cwd().endsWith("/" + request.cwd.split("/").at(-1))) process.exit(3);
console.log(JSON.stringify({ index: 0, decision: protectedProject ? "deny" : "allow", rule_id: "fixture:deploy" }));
process.exit(protectedProject ? 1 : 0);
`, { mode: 0o700 });
    const bridge = createDcgToolBridge(makeDcgRunner(executable));
    const invoke = (cwd: string, sessionCwd: string) => bridge.handle({
      type: "tool_call", toolName: "bash", input: { command: "fixture deploy", cwd },
    }, { cwd: sessionCwd });
    expect(await invoke("protected-project", scratch.path)).toMatchObject({ block: true, reason: expect.stringContaining("protected directory policy") });
    expect(await invoke(otherDir, protectedDir)).toBeUndefined();
    expect(await invoke("protected-alias", scratch.path)).toMatchObject({ block: true, reason: expect.stringContaining("protected directory policy") });
    expect(await invoke("other-alias", scratch.path)).toBeUndefined();
    expect(await invoke("/", protectedDir)).toMatchObject({ block: true, reason: expect.stringContaining("protected directory policy") });
    expect(await invoke("@protected-project", scratch.path)).toMatchObject({ block: true, reason: expect.stringContaining("unambiguous local bash cwd") });
    expect(await invoke("relative/" + "x".repeat(10000), otherDir)).toMatchObject({ block: true, reason: expect.stringContaining("unambiguous local bash cwd") });
    for (const unusable of [join(scratch.path, "missing"), executable]) {
      expect(await invoke(unusable, otherDir)).toMatchObject({ block: true, reason: expect.stringContaining("not an accessible local directory") });
    }
  } finally { scratch.cleanup(); }
});

test.skipIf(Bun.which("dcg") === null)("runs the installed dcg binary for a safe bash call", async () => {
  const bridge = createDcgToolBridge(makeDcgRunner());
  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-real", input: { command: "git status" } }),
  ).resolves.toBeUndefined();
});

test("blocks a denied dcg decision", async () => {
  const bridge = createDcgToolBridge(async () => ({
    exitCode: 1,
    stdout: '{"index":0,"decision":"deny","rule_id":"fixture"}\n',
    stderr: "",
    timedOut: false,
  }));

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-2", input: { command: "git status" } }),
  ).resolves.toEqual({ block: true, reason: "dcg denied the bash tool call (fixture)" });
});

test("blocks malformed, empty, or timed-out gate output", () => {
  for (const result of [
    { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    { exitCode: 0, stdout: "not-json\n", stderr: "", timedOut: false },
    { exitCode: 1, stdout: "", stderr: "", timedOut: true },
  ]) {
    expect(evaluateDcgResult(result)).toMatchObject({ kind: "block" });
  }
});

test("blocks a bash call without a command", async () => {
  const bridge = createDcgToolBridge(async () => allow);
  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", toolCallId: "call-3", input: {} }),
  ).resolves.toEqual({ block: true, reason: "OMP dcg bridge: bash call has no command; refusing" });
});

test("does not apply a bash guard to other tools", async () => {
  let called = false;
  const bridge = createDcgToolBridge(async () => {
    called = true;
    return allow;
  });
  await expect(
    bridge.handle({ type: "tool_call", toolName: "read", toolCallId: "call-4", input: { path: "README.md" } }),
  ).resolves.toBeUndefined();
  expect(called).toBeFalse();
});

test("allows safe user_bash when dcg allows", async () => {
  let received: unknown;
  const bridge = createDcgUserBashBridge(async (payload) => {
    received = payload;
    return allow;
  });

  await expect(
    bridge.handle({
      type: "user_bash",
      command: "git status",
      excludeFromContext: false,
      cwd: "/tmp",
    }),
  ).resolves.toBeUndefined();
  expect(received).toEqual(buildDcgPayload("git status", "/tmp"));
});

test("returns a failed BashResult and prevents execution on deny", async () => {
  let executed = false;
  const bridge = createDcgUserBashBridge(async () => ({
    exitCode: 1,
    stdout: '{"index":0,"decision":"deny","rule_id":"fixture"}\n',
    stderr: "",
    timedOut: false,
  }));

  const result = await bridge.handle({
    type: "user_bash",
    command: "git status",
    excludeFromContext: false,
    cwd: "/tmp",
  });
  if (result === undefined) executed = true;

  expect(result).toEqual({
    result: expect.objectContaining({
      output: "dcg denied the bash tool call (fixture)",
      exitCode: 126,
      cancelled: false,
      timedOut: false,
      truncated: false,
      workingDir: "/tmp",
    }),
  });
  expect(executed).toBeFalse();
});

test("fails closed for malformed or unknown user_bash decisions and ignores foreign events", async () => {
  let calls = 0;
  const bridge = createDcgUserBashBridge(async () => {
    calls += 1;
    return { exitCode: 0, stdout: '{"index":0,"decision":"maybe"}\n', stderr: "", timedOut: false };
  });

  await expect(
    bridge.handle({ type: "tool_call", toolName: "bash", input: { command: "git status" } }),
  ).resolves.toBeUndefined();
  const malformed = await bridge.handle({ type: "user_bash", command: "", cwd: "/tmp" });
  expect(malformed?.result.exitCode).toBe(126);
  const unknown = await bridge.handle({ type: "user_bash", command: "git status", cwd: "/tmp" });
  expect(unknown?.result.output).toBe("dcg denied the bash tool call");
  expect(calls).toBe(1);
});

test("anti-vacuity: denied user_bash invokes dcg with exact command and cwd", async () => {
  let calls = 0;
  let received: unknown;
  const bridge = createDcgUserBashBridge(async (payload) => {
    calls += 1;
    received = payload;
    return { exitCode: 1, stdout: "not-json\n", stderr: "", timedOut: false };
  });

  const result = await bridge.handle({
    type: "user_bash",
    command: "git status",
    excludeFromContext: false,
    cwd: "/tmp",
  });

  expect(calls).toBe(1);
  expect(received).toEqual(buildDcgPayload("git status", "/tmp"));
  expect(result?.result.exitCode).toBe(126);
});

test.skipIf(Bun.which("dcg") === null)("ERGO2 installed dcg denial forwards its current reason and preserves mined grouping", async () => {
  const dcg = Bun.which("dcg");
  if (!dcg) throw new Error("ERGO2 live bridge regression requires installed dcg");
  const oracle = await run([dcg, "explain", "--format", "json", "--robot", "--dialect", "posix", "--", "git reset --hard HEAD"],
    { deadline_s: 10, max_output_bytes: 65536 });
  expect(oracle.timed_out || oracle.truncated).toBe(false);
  expect(oracle.rc).toBe(0);
  expect(new TextDecoder().decode(oracle.stderr)).toBe("");
  const expectedReason: unknown = JSON.parse(new TextDecoder().decode(oracle.stdout)).match?.reason;
  if (typeof expectedReason !== "string" || !expectedReason) throw new Error("installed dcg denied without a reason");
  let frame: DcgRunResult | undefined;
  const runner = makeDcgRunner(dcg);
  const bridge = createDcgToolBridge(async payload => { frame = await runner(payload); return frame; });
  const denied = await bridge.handle({
    type: "tool_call", toolName: "bash", input: { command: "git reset --hard HEAD" },
  }, { cwd: process.cwd() });
  expect(denied?.block).toBe(true);
  expect(denied?.reason.split("\n")[0]).toBe("dcg denied the bash tool call (core.git:reset-hard)");
  expect(denied?.reason).toContain("Reason:");
  expect(denied?.reason).toContain(expectedReason.slice(0, 600));
  const machineDecision = JSON.parse(frame!.stdout);
  if (machineDecision.rule_id === undefined) expect(expectedReason).toMatch(/^core\.git:reset-hard \(fleet\):/);
  expect(classifyMineResult({ tool: "bash", result: { isError: true, content: denied?.reason } })?.class_id).toBe("guard-friction:core.git-reset-hard");
  expect(denied?.reason).toContain("Explanation:");
  expect(denied?.reason.length).toBeLessThanOrEqual(1200);
  expect(denied?.reason).not.toMatch(/allow.once|allowlist add|DCG_BYPASS/i);
});

test("ERGO2 denial guidance excludes human-only approvals and is bounded with a marker", () => {
  const result = evaluateDcgResult({
    exitCode: 1, stderr: "", timedOut: false,
    stdout: JSON.stringify({
      index: 0, decision: "deny", rule_id: "fixture",
      reason: "A real policy reason\nRun dcg allow-once 654321\nApproval code: 654321",
      safe_alternative: "omp-kit scratch new --label refusal-output --json",
      explanation: "Use a fresh owned output path.\nDCG_BYPASS=1\nRun dcg allowlist add unsafe\n" + "bounded explanation ".repeat(200),
      allowOnceCommand: "dcg allow-once 654321",
      allowOnceFullHash: "a".repeat(64),
    }) + "\n",
  });
  expect(result.kind).toBe("block");
  if (result.kind !== "block") throw new Error("denial was allowed");
  expect(result.reason.split("\n")[0]).toBe("dcg denied the bash tool call (fixture)");
  expect(result.reason).toContain("A real policy reason");
  expect(result.reason).toContain("omp-kit scratch new --label refusal-output --json");
  expect(result.reason).toContain("[dcg guidance truncated]");
  expect(result.reason.length).toBeLessThanOrEqual(1200);
  expect(result.reason).not.toMatch(/allow.once|allowlist|DCG_BYPASS|654321|a{64}/i);
});

test("ERGO2 guidance never changes fail-closed stderr, timeout, malformed or multi-frame decisions", () => {
  const frame = JSON.stringify({ index: 0, decision: "allow", reason: "not authoritative" });
  for (const [result, reason] of [
    [{ exitCode: 0, stdout: frame, stderr: "diagnostic", timedOut: false }, "dcg bridge emitted stderr; refusing the bash tool call"],
    [{ exitCode: 0, stdout: frame, stderr: "", timedOut: true }, "dcg bridge timed out; refusing the bash tool call"],
    [{ exitCode: 0, stdout: "not-json", stderr: "", timedOut: false }, "dcg bridge returned malformed JSON; refusing the bash tool call"],
    [{ exitCode: 0, stdout: frame + "\n" + frame, stderr: "", timedOut: false }, "dcg bridge returned no single machine decision; refusing the bash tool call"],
    [{ exitCode: 0, stdout: "", stderr: "", timedOut: false }, "dcg bridge returned no single machine decision; refusing the bash tool call"],
  ] as const) expect(evaluateDcgResult(result)).toEqual({ kind: "block", reason });
});

test("ERGO2 missing rule ids are recovered from the upstream fleet reason prefix", () => {
  for (const prefix of ["core.git:reset-hard (fleet): ", "Error: core.git:reset-hard (fleet): "]) {
    const result = evaluateDcgResult({
      exitCode: 1, stderr: "", timedOut: false,
      stdout: JSON.stringify({ index: 0, decision: "deny", reason: prefix + "Use an isolated checkout to preserve shared work." }) + "\n",
    });
    expect(result.kind).toBe("block");
    if (result.kind !== "block") throw new Error("override denial was allowed");
    expect(result.reason.split("\n")[0]).toBe("dcg denied the bash tool call (core.git:reset-hard)");
    expect(result.reason).toContain("Use an isolated checkout");
  }
});

test("ERGO2 runner invokes the hook once and explains only an authoritative denial", async () => {
  const scratch = ownedTmp("ergo2-dcg-runner");
  try {
    const executable = join(scratch.path, "dcg-fixture");
    const calls = join(scratch.path, "calls.jsonl");
    writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "hook") {
  const payload = JSON.parse(await Bun.stdin.text());
  const command = payload.tool_input.command;
  if (command === "stderr") process.stderr.write("unexpected diagnostic");
  if (command === "malformed") { console.log("not-json"); process.exit(1); }
  const allow = command === "allow" || command === "incomplete-allow";
  const frame = JSON.stringify({ index: 0, decision: allow ? "allow" : "deny", rule_id: "fixture" });
  console.log(frame);
  if (command === "multi") console.log(frame);
  if (command === "incomplete-allow") await Bun.write(Bun.stdout, " ".repeat(96 * 1024));
  process.exit(allow ? 0 : 1);
}
console.log(JSON.stringify({ decision: "deny", match: { rule_id: "fixture", reason: "Upstream fixture reason", explanation: "Inspect the safe alternative." } }));
`);
    chmodSync(executable, 0o700);
    const runner = makeDcgRunner(executable);
    for (const command of ["allow", "deny", "stderr", "malformed", "multi", "incomplete-allow"]) {
      writeFileSync(calls, "");
      const decision = evaluateDcgResult(await runner(buildDcgPayload(command, scratch.path)));
      const captured: string = readFileSync(calls, "utf8");
      const argv = captured.trim().split("\n").map(line => JSON.parse(line));
      expect(argv).toHaveLength(command === "deny" ? 2 : 1);
      expect(argv[0]).toEqual(["hook", "--batch", "--robot"]);
      if (command === "allow") expect(decision).toEqual({ kind: "allow" });
      else expect(decision.kind).toBe("block");
      if (command === "deny") {
        expect(argv[1]).toEqual(["explain", "--format", "json", "--robot", "--dialect", "posix", "--", "deny"]);
        if (decision.kind !== "block") throw new Error("denial was allowed");
        expect(decision.reason).toContain("Upstream fixture reason");
      }
    }
  } finally { scratch.cleanup(); }
});

test("ERGO2 guidance rejects overlong rule-id prefixes and bounds long regex near misses", () => {
  const started = performance.now();
  const result = evaluateDcgResult({
    exitCode: 1, stderr: "", timedOut: false,
    stdout: JSON.stringify({ index: 0, decision: "deny", reason: "core.git:" + "x".repeat(100000) + " (fleet): near miss" }) + "\n",
  });
  expect(result.kind).toBe("block");
  if (result.kind !== "block") throw new Error("long denial was allowed");
  expect(result.reason.split("\n")[0]).toBe("dcg denied the bash tool call");
  expect(result.reason.length).toBeLessThanOrEqual(1200);
  expect(result.reason).toContain("[dcg guidance truncated]");
  expect(performance.now() - started).toBeLessThan(1000);
});
