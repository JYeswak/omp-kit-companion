import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const lib = resolve(import.meta.dir, "../live/lib.mjs");
const scenarios = JSON.parse(readFileSync(resolve(import.meta.dir, "../live/scenarios.json"), "utf8"));
const probeIndex = scenarios.findIndex((s: { id: string }) => s.id === "omp-late-interrupt-probe");
if (probeIndex < 0) throw new Error("probe scenario missing from scenarios.json");

let scratch = "";
function logFile(name: string, lines: unknown[]): string {
  if (!scratch) {
    scratch = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "probe-"));
    mkdirSync(scratch, { recursive: true });
  }
  const file = join(scratch, name);
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

function probe(log: string) {
  const child = Bun.spawnSync([process.execPath, lib, "probe", String(probeIndex), log], {
    stdout: "pipe", stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

const req = (messages: unknown[]) => ({ n: 0, main: true, body: { model: "mock", messages } });

test("a fake 1-request transcript with no named rule reports aborted and exits 0", () => {
  const log = logFile("abort.jsonl", [req([{ role: "user", content: "go" }])]);
  const result = probe(log);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("PROBE omp-late-interrupt: aborted");
  expect(result.stderr).toBe("");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

test("a transcript naming the rule in the last request reports continued and exits 0", () => {
  const log = logFile("continued.jsonl", [
    req([{ role: "user", content: "go" }]),
    req([
      { role: "assistant", content: "" },
      { role: "user", content: '<system-interrupt reason="rule_violation" rule="kit-test-skip" path="x">' },
    ]),
  ]);
  const result = probe(log);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("PROBE omp-late-interrupt: continued");
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

test("a missing transcript still reports aborted and exits 0", () => {
  const result = probe(join(import.meta.dir, "does-not-exist.jsonl"));
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe("PROBE omp-late-interrupt: aborted");
});
