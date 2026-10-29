import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import {
  askClefNoul,
  makeBeforeAgentStartHandler,
  parseSystemMemories,
  pruneSystemPrompt,
  questionSha,
  type ClefCalibration,
  type ModelFingerprint,
} from "../../extensions/jev-memory-filter.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

 const QUESTION_TEXT = "Is this memory relevant to the current request?";

const FINGERPRINT: ModelFingerprint = {
  joint_head_sha256: "a".repeat(64),
  index_sha256: "b".repeat(64),
};

function calibrationFor(questionText: string): ClefCalibration {
  const question = { type: "noul", instructions: questionText };
  return {
    schema: "jev.clef-calibration.v1",
    task_id: "test-noul",
    version: 1,
    primitive: "noul",
    question_key: "value",
    question_sha256: questionSha(question, ["memory", "prompt"]),
    model: { id: "clef-flash", ...FINGERPRINT },
    map: { kind: "platt-logit", target: "noul", a: 1, b: 0, clip: 1e-6 },
    fit: {},
    receipt: { prereg_commit: "abc1234", result_commit: "def5678", verdict: "PASS" },
  };
}

const STATE = { prompt: "fix login bug", memory: "repair the login flow" };
const URL = "http://127.0.0.1:11434/";

test("uncalibrated without calibration fails closed and never touches transport", async () => {
  let calls = 0;
  const result = await askClefNoul({
    state: { ...STATE },
    questions: { rel: QUESTION_TEXT },
    clefUrl: URL,
    fetchImpl: async () => {
      calls += 1;
      return json({});
    },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("uncalibrated");
  expect(calls).toBe(0);
});

test("a non-loopback gateway is refused before any request", async () => {
  let calls = 0;
  const result = await askClefNoul({
    state: { ...STATE },
    questions: { rel: QUESTION_TEXT },
    clefUrl: "https://api.typesafe.ai/v1/systemone",
    clefCalibration: calibrationFor(QUESTION_TEXT),
    clefFingerprint: FINGERPRINT,
    fetchImpl: async () => {
      calls += 1;
      return json({});
    },
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("refused-unsafe");
  expect(calls).toBe(0);
});

test("the Clef wire shape maps scores.value to rel with the Platt map", async () => {
  let url = "";
  let wireBody: unknown = null;
  const result = await askClefNoul({
    state: { ...STATE },
    questions: { rel: QUESTION_TEXT },
    clefUrl: URL,
    clefCalibration: calibrationFor(QUESTION_TEXT),
    clefFingerprint: FINGERPRINT,
    fetchImpl: async (input: unknown, init?: RequestInit) => {
      url = String(input);
      wireBody = JSON.parse(String(init?.body));
      return json({ answers: { value: { noul: 0.2 } }, model: "clef-flash", usage: { input_tokens: 3, output_tokens: 1 } });
    },
  });
  expect(url).toBe(URL);
  expect(wireBody).toEqual({
    model: "clef-flash",
    state: STATE,
    questions: { value: { type: "noul", instructions: QUESTION_TEXT } },
  });
  expect(result.ok).toBe(true);
  if (result.ok) {
    // Identity Platt map (a=1, b=0): scores.rel tracks the raw noul.
    expect(result.scores.rel).toBeCloseTo(0.2, 12);
    expect(result.model).toBe("clef-flash+platt:test-noul.v1");
    expect(result.usage?.input_tokens).toBe(3);
  }
});

test("an out-of-range noul maps to no-answers, never a score", async () => {
  const result = await askClefNoul({
    state: { ...STATE },
    questions: { rel: QUESTION_TEXT },
    clefUrl: URL,
    clefCalibration: calibrationFor(QUESTION_TEXT),
    clefFingerprint: FINGERPRINT,
    fetchImpl: async () => json({ answers: { value: { noul: 9 } } }),
  });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toBe("no-answers");
    expect(result.error).toContain("Noul");
  }
});

test("handler keeps every memory when the enforce switch is absent", async () => {
  const rows: Array<{ file: string; row: unknown }> = [];
  const handler = makeBeforeAgentStartHandler({
    ask: async () => {
      throw new Error("must not score while the switch is off");
    },
    append: async (file, line) => {
      rows.push({ file, row: JSON.parse(line) });
    },
    path: "test-log",
    sidecarPath: "test-sidecar",
    switchPath: join(ownedTmp("jev-filter").path, "no-such-switch"),
    cap3SwitchPath: join(ownedTmp("jev-filter-cap3").path, "no-such-switch"),
    now: () => "2026-10-28T00:00:00.000Z",
  });
  const sys = "<memories>\nrepair the login flow\nbuy birthday candles\n</memories>";
  const out = await handler({ prompt: "fix login bug" }, { getSystemPrompt: () => sys, cwd: "/repo" });
  expect(out).toBeUndefined();
  expect(rows.length).toBe(2);
  expect(rows.every((r) => {
    const row = r.row;
    return (
      typeof row === "object" && row !== null && "status" in row && "decision" in row &&
      row.status === "scoring-off" && row.decision === "keep"
    );
  })).toBe(true);
});

test("handler prunes a low-relevance memory when enforced and in scope", async () => {
  const dir = ownedTmp("jev-filter-enforce").path;
  mkdirSync(dir, { recursive: true });
  const switchPath = join(dir, "enforce");
  writeFileSync(switchPath, "on");
  const rows: Array<unknown> = [];
  const handler = makeBeforeAgentStartHandler({
    ask: async (options) => ({
      ok: true as const,
      scores: { rel: String(options.state.memory).includes("login") ? 0.9 : 0.1 },
      latencyMs: 5,
      model: "test-model",
    }),
    append: async (_file, line) => {
      rows.push(JSON.parse(line));
    },
    path: "test-log",
    sidecarPath: "test-sidecar",
    switchPath,
    cap3SwitchPath: join(dir, "no-such-cap3"),
    now: () => "2026-10-28T00:00:00.000Z",
  });
  const sys = "header\n<memories>\nrepair the login flow\nbuy birthday candles\n</memories>\ntrailer";
  const out = await handler({ prompt: "fix login bug" }, { getSystemPrompt: () => sys, cwd: "/repo" });
  if (typeof out !== "object" || out === null || !("systemPrompt" in out)) {
    throw new Error("expected { systemPrompt } when enforced and in scope");
  }
  const promptValue: unknown = out.systemPrompt;
  if (typeof promptValue !== "string") {
    throw new Error("expected a string systemPrompt");
  }
  expect(promptValue).not.toContain("buy birthday candles");
  expect(promptValue).toContain("repair the login flow");
  expect(promptValue).toContain("header");
  expect(promptValue).toContain("trailer");
  const isRow = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  expect(rows.some((r) => isRow(r) && r.status === "scored" && r.decision === "drop")).toBe(true);
  expect(rows.some((r) => isRow(r) && r.status === "enforced")).toBe(true);
});

test("parse/prune round-trip removes exactly the recorded span", async () => {
  const sys = "tools line\n<memories>\nrepair the login flow\nbuy birthday candles\n</memories>\nend";
  const items = parseSystemMemories(sys);
  expect(items.map((i) => i.text)).toEqual(["repair the login flow", "buy birthday candles"]);
  const pruned: unknown = pruneSystemPrompt(sys, [items[1]!]);
  expect(pruned).toBe("tools line\n<memories>\nrepair the login flow\n</memories>\nend");
});

 // Module-global backend hold: this test must run last in the file.
 test("consecutive transport failures hold the backend without a third call", async () => {
   let calls = 0;
   const dead = async (): Promise<Response> => {
     calls += 1;
     throw new Error("connection refused");
   };
   const attempt = () => askClefNoul({
     state: { ...STATE },
     questions: { rel: QUESTION_TEXT },
     clefUrl: URL,
     clefCalibration: calibrationFor(QUESTION_TEXT),
     clefFingerprint: FINGERPRINT,
     fetchImpl: dead,
   });
   const first = await attempt();
   expect(first.ok).toBe(false);
   if (!first.ok) expect(first.reason).toBe("transport");
   const second = await attempt();
   expect(second.ok).toBe(false);
   if (!second.ok) expect(second.reason).toBe("transport");
   const held = await attempt();
   expect(held.ok).toBe(false);
   if (!held.ok) expect(held.reason).toBe("backend-hold");
   expect(calls).toBe(2);
 });
