import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BundledRunInterruptedError } from "../../src/runtime.ts";
import { classifyLadder, currentStageReport, recoverInterruptedRun, redactFullTestCause, retainProducerOutput } from "../../src/full-test-runner.ts";

const names = ["manifest", "harness-gate", "harness-selftest", "flywheel-invariants", "regex-budget", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"];
const successful = names.map(name => `GREEN ${name} producer_rc=0 duration_ms=120`).join("\n");
const live = "ok    scenario-one\nok    scenario-two";
const planted = "plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close";

function sample(lines: string, code = 0) {
 return classifyLadder({ code, stdout: lines, stderr: "" }, ["scenario-one", "scenario-two"]);
}

test("full ladder requires every ordered stage, every shipped live row, and named plant", () => {
 const result = sample(`${live}\n${planted}\n${successful}\nLADDER: GREEN`);
 expect(Object.values(result.stages).every(stage => stage.status === "PASS")).toBe(true);
 expect(result.live_scenarios.status).toBe("PASS");
 expect(result.failures).toEqual([]);
 const absent = sample(`${planted}\n${successful}\nLADDER: GREEN`);
 expect(absent.live_scenarios.status).toBe("FAIL");
 expect(absent.failures).toContain("Live scenario rows did not match the exact shipped ordered scenario IDs");
 const missingPlant = sample(`${live}\n${successful}\nLADDER: GREEN`);
 expect(missingPlant.failures).toContain("Planted negative control was not named RED");
});

test("mid-ladder RED exposes its producer status and keeps later stages NOT_RUN", () => {
 const result = sample("GREEN manifest producer_rc=0\nRED   harness-gate producer_rc=7\n", 1);
 expect(result.stages.manifest).toEqual({ status: "PASS", producer_rc: 0, duration_ms: null });
 expect(result.stages["harness-gate"]).toEqual({ status: "FAIL", producer_rc: 7, duration_ms: null });
 expect(result.stages["e2e-live"].status).toBe("NOT_RUN");
 expect(Object.hasOwn(result.stages["e2e-live"], "duration_ms")).toBe(true);
 expect(result.stages["e2e-live"].duration_ms).toBe(null);
 expect(result.live_scenarios.status).toBe("NOT_RUN");
 expect(result.failures).toContain("Stage harness-gate returned producer_rc=7");
 expect(result.failures).not.toContain("Live scenario rows missing: scenario-one, scenario-two");
});

test("producer success without complete ordered proof is a failure, never implicit green", () => {
 const result = sample("GREEN manifest producer_rc=0\nLADDER: GREEN");
 expect(result.stages["e2e-plant"].status).toBe("NOT_RUN");
 expect(result.failures).toContain("Producer returned success without every named GREEN stage and LADDER: GREEN");
});

test("failed live stage reports missing scenario IDs", () => {
 const stages = names.slice(0, names.indexOf("e2e-live")).map(name => "GREEN " + name + " producer_rc=0").join("\n");
 const result = sample(stages + "\nok    scenario-one\nRED   e2e-live producer_rc=1", 1);
 expect(result.live_scenarios).toMatchObject({ status: "FAIL", observed_ids: ["scenario-one"] });
 expect(result.failures[0]).toBe("Live scenario rows missing: scenario-two");
});

test("a ladder that skips the flywheel-invariants stage is an order failure, not green", () => {
 const skipped = names.filter(name => name !== "flywheel-invariants").map(name => `GREEN ${name} producer_rc=0`).join("\n");
 const result = sample(`${live}\n${planted}\n${skipped}\nLADDER: GREEN`);
 expect(result.stages["flywheel-invariants"].status).toBe("NOT_RUN");
 expect(result.failures).toContain("Ladder stage order, identity, or producer rc mismatch");
});

test("a newer release's added stage is accepted when GREEN, and every known stage is still required", () => {
 const withAdded = [...names.slice(0, 4), "future-stage", ...names.slice(4)].map(name => `GREEN ${name} producer_rc=0`).join("\n");
 const result = sample(`${live}\n${planted}\n${withAdded}\nLADDER: GREEN`);
 expect(result.failures).toEqual([]);
 expect(Object.values(result.stages).every(stage => stage.status === "PASS")).toBe(true);
 const droppedKnown = [...names.slice(0, 4), "future-stage", ...names.slice(5)].map(name => `GREEN ${name} producer_rc=0`).join("\n");
 expect(sample(`${live}\n${planted}\n${droppedKnown}\nLADDER: GREEN`).failures).toContain("Ladder stage order, identity, or producer rc mismatch");
});

test("a newer release's added stage that is RED fails under its own name", () => {
 const redAdded = [...names.slice(0, 4).map(name => `GREEN ${name} producer_rc=0`), "RED   future-stage producer_rc=4"].join("\n");
 const result = sample(redAdded, 1);
 expect(result.failures).toContain("Stage future-stage returned producer_rc=4");
 expect(result.stages["regex-budget"].status).toBe("NOT_RUN");
});
test("every stage report carries a duration_ms field", () => {
 const result = sample(`${live}\n${planted}\n${successful}\nLADDER: GREEN`);
 expect(result.stages.manifest.duration_ms).toBe(120);
 expect(Object.values(result.stages).every(stage => Object.hasOwn(stage, "duration_ms"))).toBe(true);
});

test("a ladder stage retains its measured verdict after unterminated child output", () => {
 const temp = mkdtempSync(join(tmpdir(), "omp-kit-ladder-timing-"));
 try {
  const script = fileURLToPath(new URL("../../scripts/ladder.sh", import.meta.url));
  const child = Bun.spawnSync(["sh", script, "--selftest-timing", temp, "/bin/sh", "-c", "printf partial-report; sleep 0.12"], { stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(0);
  const report = classifyLadder({ code: 1, stdout: child.stdout.toString(), stderr: child.stderr.toString() }, []);
  expect(report.stages.manifest.duration_ms).toBeGreaterThanOrEqual(100);
 } finally {
  rmSync(temp, { recursive: true, force: true });
 }
});

test("a running ladder stage streams evidence before interruption and retains its real producer status", async () => {
 const temp = mkdtempSync(join(tmpdir(), "omp-kit-ladder-interruption-"));
 const script = fileURLToPath(new URL("../../scripts/ladder.sh", import.meta.url));
 const producer = [
  `trap 'printf "producer-terminated\\n"; exit 23' TERM`,
  `printf '%s\\n' "$$" > "$1/producer.pid"`,
  `printf 'current-stage-output\\n'`,
  `printf 'current-stage-diagnostic\\n' >&2`,
  `while :; do /bin/sleep 1; done`,
 ].join("\n");
 const child = Bun.spawn(["/bin/sh", script, "--selftest-timing", temp, "/bin/sh", "-c", producer, "stage", temp], {
  stdout: "pipe", stderr: "pipe", detached: true,
 });
 const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
 let observed = "";
 const stdout = (async () => {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  for (;;) {
   const { done, value } = await reader.read();
   if (done) break;
   observed += decoder.decode(value, { stream: true });
   if (observed.includes("current-stage-output\n") && observed.includes("current-stage-diagnostic\n")) markReady();
  }
  observed += decoder.decode();
  return observed;
 })();
 const stderr = new Response(child.stderr).text();
 // Watchdog only: this exercises real shell signals; stage readiness is output-driven.
 let timer: NodeJS.Timeout | undefined;
 const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("live stage evidence deadline")), 4000); });
 try {
  await Promise.race([ready, deadline, child.exited.then(() => { throw new Error("stage exited before live evidence"); })]);
  expect(child.exitCode).toBe(null);
  const pid = Number(readFileSync(join(temp, "producer.pid"), "utf8").trim());
  expect(pid).toBeGreaterThan(1);
  process.kill(pid, "SIGTERM");
  const [code, output, diagnostic] = await Promise.race([Promise.all([child.exited, stdout, stderr]), deadline]);
  expect(code, diagnostic).toBe(23);
  expect(output).toContain("RED   manifest producer_rc=23");
  expect(output.split("current-stage-output\n")).toHaveLength(2);
  expect(readFileSync(join(temp, "ladder-manifest.txt"), "utf8"))
   .toBe("current-stage-output\ncurrent-stage-diagnostic\nproducer-terminated\n");
  expect(classifyLadder({ code, stdout: output, stderr: diagnostic }, []).stages.manifest)
   .toMatchObject({ status: "FAIL", producer_rc: 23 });
 } finally {
  clearTimeout(timer);
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Only this test's detached group. */ }
  await Promise.allSettled([child.exited, stdout, stderr]);
  rmSync(temp, { recursive: true, force: true });
 }
}, 10_000);
test("current-stage failure record carries elapsed milliseconds", () => {
 const report = currentStageReport({ name: "e2e-live", started_at: 100, started_at_ms: 1_000 }, 150);
 expect(report).toEqual({ name: "e2e-live", elapsed_ms: 50 });
});

test("interrupted runner preserves original error, partial streams, and current-stage elapsed time", () => {
 const partial = { code: 3, stdout: "stage output", stderr: "stage diagnostic",
  in_flight_stage: { name: "e2e-live", started_at: 100, started_at_ms: 1_000 } };
 const recovered = recoverInterruptedRun(new BundledRunInterruptedError(new Error("boom lower"), partial));
 expect(recovered.cause).toMatchObject({ cause_code: "Error", cause_message: "boom lower" });
 expect(recovered.result).toMatchObject({ stdout: "stage output", stderr: "stage diagnostic" });
 expect(currentStageReport(recovered.result.in_flight_stage ?? null, 150)).toEqual({ name: "e2e-live", elapsed_ms: 50 });
});

test("cause privacy applies to every field before truncation and retains ordinary diagnostics", () => {
 const root = "/operator/" + "private release ".repeat(30);
 const token = ["ghp_", "SyntheticLettersAndDigits123456789"].join("");
 const sanitized = redactFullTestCause({
  cause_code: `EPIPE ${token}`,
  cause_name: `ReaderFailure ${root}`,
  cause_message: `read failed at ${root}/stage.ts; retry disabled`,
  cause_stack_head: `ReaderFailure: Bearer synthetic-bearer-value\n    at ${encodeURI(root)}/stage.ts:12:3\nnot retained`,
 }, [root]);
 expect(sanitized.cause_code).toBe("EPIPE <redacted>");
 expect(sanitized.cause_name).toBe("ReaderFailure <private-path>");
 expect(sanitized.cause_message).toBe("read failed at <private-path>/stage.ts; retry disabled");
 expect(sanitized.cause_stack_head).toBe("ReaderFailure: Bearer <redacted>\n    at <private-path>/stage.ts:12:3");
 const original = { cause_code: "EPIPE", cause_name: "ReaderFailure",
  cause_message: "stream closed; TOKEN_COUNT=2; https://example.invalid/stage", cause_stack_head: null };
 expect(redactFullTestCause(original, [])).toEqual(original);
 expect(original.cause_message).toContain("TOKEN_COUNT=2");
});

test("cause redaction covers credential-shaped values and runtime root aliases without leaking their contents", () => {
 const samples: readonly (readonly [string, string])[] = [
  ["authorization: Bearer synthetic-bearer-value", "synthetic-bearer-value"],
  ['{"api_key": "synthetic spaced value"}', "synthetic spaced value"],
  ['password="synthetic \\"quoted\\" value"; EPIPE', "quoted"],
  ["password='synthetic unterminated value", "unterminated"],
  ["https://synthetic-user:synthetic-password@example.invalid/stage", "synthetic-password"],
  [["sk-ant-", "SyntheticProviderValue123456789"].join(""), "SyntheticProviderValue123456789"],
  [["AKIA", "SYNTHETICKEY1234"].join(""), "SYNTHETICKEY1234"],
  [["eyJ", "SyntheticHeader.SyntheticPayload.SyntheticSignature"].join(""), "SyntheticPayload"],
  ["-----BEGIN PRIVATE KEY-----\nsynthetic-private-material\n-----END PRIVATE KEY-----", "synthetic-private-material"],
  ["/private/var/folders/ab/owned/T/omp-kit-runtime-synthetic/home", "omp-kit-runtime-synthetic"],
  ["/var/folders/ab/owned/T/omp-kit-runtime-synthetic/home", "omp-kit-runtime-synthetic"],
 ];
 for (const [text, secret] of samples) {
  const sanitized = redactFullTestCause({ cause_code: text, cause_name: text, cause_message: text, cause_stack_head: text }, []);
  for (const value of Object.values(sanitized)) {
   expect(value).not.toContain(secret);
   expect(value).toContain("<");
  }
 }
 const recovered = recoverInterruptedRun(Object.assign(new Error("read failed /private/tmp/owned-scratch/file"), {
  code: "STREAM_FAILED", name: "StreamFailure",
 }), ["/tmp/owned-scratch"]);
 expect(recovered.cause).toMatchObject({ cause_code: "STREAM_FAILED", cause_name: "StreamFailure",
  cause_message: "read failed <private-path>/file" });
});

test("cause fields remain bounded on a long credential near-miss", () => {
 const text = "x-".repeat(32_000) + "no-url-or-secret";
 const started = performance.now();
 const cause = redactFullTestCause({ cause_code: text, cause_name: text, cause_message: text, cause_stack_head: text }, []);
 expect(performance.now() - started).toBeLessThan(1000);
 expect(cause.cause_code).toHaveLength(100);
 expect(cause.cause_name).toHaveLength(100);
 expect(cause.cause_message).toHaveLength(200);
 expect(cause.cause_stack_head).toHaveLength(400);
});


test("producer streams are retained in owned scratch and their paths are reported", () => {
 const repo = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-full-test-output-")));
 try {
  const output = { stdout: "full stage stdout\n", stderr: "full stage stderr\n" };
  const artifacts = retainProducerOutput(repo, output);
  expect(artifacts.directory.startsWith(join(repo, "var", "agent-tmp") + sep)).toBe(true);
  expect(readFileSync(artifacts.stdout_path, "utf8")).toBe(output.stdout);
  expect(readFileSync(artifacts.stderr_path, "utf8")).toBe(output.stderr);
  expect(readFileSync(join(artifacts.directory, ".owner"), "utf8")).toContain(`repo=${repo}`);
 } finally {
  rmSync(repo, { recursive: true, force: true });
 }
});
test("fail-closed trust guard marks cli-crosscheck NOT_RUN instead of a matcher failure", () => {
 const earlier = names.slice(0, names.indexOf("cli-crosscheck"))
  .map(name => `GREEN ${name} producer_rc=0`).join("\n");
 const refusal = [
  "OMP_TRUST_GUARD_FAIL_CLOSED: omp-trust-guard: FAIL-CLOSED: config: real omp is unavailable in isolated HOME",
  "RED   cli-crosscheck producer_rc=3",
 ].join("\n");
 const result = sample(`${earlier}\n${refusal}`, 1);
 expect(result.stages["cli-crosscheck"]).toMatchObject({
  status: "NOT_RUN",
  producer_rc: 3,
  reason: expect.stringContaining("omp-trust-guard FAIL-CLOSED"),
 });
 expect(result.stages["metamorphic-ratchet"].status).toBe("NOT_RUN");
 expect(result.live_scenarios.status).toBe("NOT_RUN");
 expect(result.failures).toEqual([]);
 const ordinaryExit = sample(`${earlier}\nRED   cli-crosscheck producer_rc=3`, 1);
 expect(ordinaryExit.stages["cli-crosscheck"].status).toBe("FAIL");
 expect(ordinaryExit.failures).toContain("Stage cli-crosscheck returned producer_rc=3");
});
