import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BundledRunInterruptedError } from "../../src/runtime.ts";
import { classifyLadder, currentStageReport, describeFullTestProducer, recoverInterruptedRun, redactFullTestCause, retainProducerOutput } from "../../src/full-test-runner.ts";
import { readTestCaseReports, summarizeTestCaseReports } from "../../src/test-case-report.ts";

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
 expect(result.stages["harness-gate"]).toMatchObject({ status: "FAIL", producer_rc: 7, duration_ms: null });
 expect(result.stages["e2e-live"].status).toBe("NOT_RUN");
 expect(Object.hasOwn(result.stages["e2e-live"], "duration_ms")).toBe(true);
 expect(result.stages["e2e-live"].duration_ms).toBe(null);
 expect(result.live_scenarios.status).toBe("NOT_RUN");
 expect(result.failures).toContain("Stage harness-gate returned producer_rc=7");
 expect(result.failures).not.toContain("Live scenario rows missing: scenario-one, scenario-two");
});

test("failed-stage JSON retains bounded verdict and tail without adjacent stage output", () => {
 const prefix = "OMP_KIT_STAGE_START name=manifest\n" + "earlier stage\n".repeat(2000)
  + "GREEN manifest producer_rc=0 duration_ms=12\n";
 const failed = "OMP_KIT_STAGE_START name=harness-gate\nactual failure verdict\n" + "x".repeat(12_000)
  + "\nactual failure tail\nRED   harness-gate producer_rc=7 duration_ms=1234\n";
 const later = "OMP_KIT_STAGE_START name=harness-selftest\nlater stage must not replace failure\n";
 const diagnostic = "d".repeat(2000) + "\nactual producer diagnostic";
 const report = classifyLadder({ code: 1, stdout: prefix + failed + later, stderr: diagnostic }, []);
 const stage = report.stages["harness-gate"];
 expect(stage).toMatchObject({ status: "FAIL", producer_rc: 7, duration_ms: 1234 });
 expect(stage.output?.stdout_head).toContain("actual failure verdict");
 expect(stage.output?.stdout_tail).toBe(failed.slice(-2500));
 expect(stage.output?.stderr_tail).toBe(diagnostic.slice(-1000));
 expect(stage.output?.stdout_chars).toBe(failed.length);
 expect(stage.output?.stdout_head?.length).toBeLessThanOrEqual(2500);
 expect(stage.output?.stdout_tail.length).toBeLessThanOrEqual(2500);
 expect(stage.output?.stderr_tail.length).toBeLessThanOrEqual(1000);
 expect(stage.output?.stdout_head).not.toContain("earlier stage");
 expect(stage.output?.stdout_tail).not.toContain("later stage");
 expect(report.stages.manifest.output).toBeUndefined();
});

test("a missing failed-stage marker never labels earlier ladder output as its verdict", () => {
 const report = sample("OMP_KIT_STAGE_START name=manifest\nearlier stage verdict\n"
  + "GREEN manifest producer_rc=0 duration_ms=12\nRED   harness-gate producer_rc=7 duration_ms=1234\n", 1);
 expect(report.stages["harness-gate"].status).toBe("FAIL");
 expect(report.stages["harness-gate"].output).toBeUndefined();
 expect(report.stages["harness-gate"].reason).toContain("start marker");
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

async function referenceProducerFixture() {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-result-reference-")));
 const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
 for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM" && key !== "GIT_CONFIG_GLOBAL") delete env[key];
 const git = (...args: string[]): string => {
  const child = Bun.spawnSync(["git", "-C", root, "-c", "core.hooksPath=/dev/null", ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
 };
 await Bun.write(join(root, ".owner"), `pid=${process.pid}\nlabel=result-reference\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
 await Bun.write(join(root, ".gitignore"), "/.owner\n/*.txt\n/var/\n");
 const file = join(root, "cases.test.ts");
 await Bun.write(file, [
  'import { expect, test } from "bun:test";',
  'import { readFileSync, writeFileSync } from "node:fs";',
  'test("real producer writes π", () => {',
  ' const path = new URL("./pass.txt", import.meta.url);',
  ' writeFileSync(path, "π".repeat(5000));',
  ' const actual = readFileSync(path, "utf8");',
  ' expect(actual).toHaveLength(5000); console.log(actual);',
  '});',
  'test("real producer detects wrong bytes", () => {',
  ' const path = new URL("./fail.txt", import.meta.url);',
  ' writeFileSync(path, "observed");',
  ' expect(readFileSync(path, "utf8")).toBe("required");',
  '});',
 ].join("\n"));
 git("init", "--quiet", "--initial-branch=main");
 git("add", "--", ".gitignore", "cases.test.ts");
 git("-c", "user.name=ResultFixture", "-c", "user.email=result@example.invalid", "commit", "--only", "-qm", "producer source", "--", ".gitignore", "cases.test.ts");
 const source = git("rev-parse", "HEAD");
 const argv = [process.execPath, "--no-env-file", "test", "--config", "/dev/null", file];
 const child = Bun.spawnSync(argv, { cwd: root, env, stdout: "pipe", stderr: "pipe" });
 const stdout = child.stdout.toString(), stderr = child.stderr.toString();
 const identity = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") });
 const result = { code: child.exitCode, stdout, stderr, execution: {
  argv, cwd: root, launched: true, exit_code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null,
  interrupted: false, stdout_complete: true, stderr_complete: true,
  stdout_capture: identity(stdout), stderr_capture: identity(stderr),
 } };
 return { root, git, source, result };
}

test("real failed producer reference binds full Unicode streams, actual counts and names without durable scratch credit", async () => {
 const fixture = await referenceProducerFixture();
 try {
  expect(fixture.result.code).toBe(1);
  const producer = describeFullTestProducer(fixture.result, { source_revision: fixture.source, roots: [fixture.root], artifact_root: fixture.root });
  const reference = producer.result_ref;
  expect(reference.missing_fields).toEqual([]);
  expect(reference.capture_complete).toBe(true);
  expect(reference.source_revision).toBe(fixture.source);
  expect(reference.producer_exit).toBe(1);
  expect(reference.counts).toEqual({ protocol: "BUN_TEST", unit: "TEST_CASE", pass: 1, fail: 1, skip: 0, total: 2 });
  expect(reference.failing_names).toEqual(["real producer detects wrong bytes"]);
  expect(reference.argv_sha256).toBe(new Bun.CryptoHasher("sha256").update(JSON.stringify(fixture.result.execution.argv)).digest("hex"));
  expect(reference.retention).toMatchObject({ status: "UNRETAINED", durable: false, citations: [] });
  for (const name of ["stdout", "stderr"] as const) {
   const stream = reference[name]!;
   const stored = readFileSync(stream.path!);
   expect(stored.toString()).toBe(producer[name]);
   expect(stream.bytes).toBe(stored.byteLength);
   expect(stream.sha256).toBe(new Bun.CryptoHasher("sha256").update(stored).digest("hex"));
   expect(stream.identity_matches).toBe(true);
   expect(stream.capture_complete).toBe(true);
  }
  expect(reference.stdout!.bytes).toBeGreaterThan(10_000);
  expect(reference.stdout!.bytes).toBeGreaterThan(producer.stdout.length);
 } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("missing producer facts and truncated available text cannot become a complete capture", async () => {
 const fixture = await referenceProducerFixture();
 try {
  const options = { source_revision: fixture.source, artifact_root: fixture.root };
  for (const [field, missing] of [["argv", "argv"], ["exit_code", "producer_exit"], ["cwd", "cwd"]] as const) {
   const execution = { ...fixture.result.execution };
   Reflect.deleteProperty(execution, field);
   const reference = describeFullTestProducer({ ...fixture.result, execution }, options).result_ref;
   expect(reference.capture_complete).toBe(false);
   expect(reference.missing_fields).toContain(missing);
  }
  const variants = [
   { name: "source_revision", result: fixture.result, options: { ...options, source_revision: null } },
   { name: "argv", result: { ...fixture.result, execution: { ...fixture.result.execution, argv: [] } }, options },
   { name: "producer_exit", result: { ...fixture.result, execution: { ...fixture.result.execution, exit_code: null } }, options },
   { name: "counts", result: { ...fixture.result, stderr: fixture.result.stderr.slice(0, fixture.result.stderr.lastIndexOf("Ran ")) }, options },
   { name: "failing_names", result: { ...fixture.result, stderr: fixture.result.stderr.split("\n").filter(line => !line.trim().startsWith("(fail) ")).join("\n") }, options },
   { name: "stdout.identity", result: { ...fixture.result, stdout: fixture.result.stdout.slice(-2500) }, options },
   { name: "stderr.eof", result: { ...fixture.result, execution: { ...fixture.result.execution, stderr_complete: false } }, options },
   { name: "execution.interrupted", result: { ...fixture.result, execution: { ...fixture.result.execution, interrupted: true } }, options },
  ];
  for (const variant of variants) {
   const reference = describeFullTestProducer(variant.result, variant.options).result_ref;
   expect(reference.capture_complete).toBe(false);
   expect(reference.missing_fields).toContain(variant.name);
   expect(reference.retention.durable).toBe(false);
  }
  const unknown = describeFullTestProducer({ code: 3, stdout: "", stderr: "" }, options).result_ref;
  expect(unknown.execution).toBe("NOT_OBSERVED");
  expect(unknown.producer_exit).toBe(null);
  expect(unknown.stdout).toBe(null);
  expect(unknown.stderr).toBe(null);
  expect(unknown.capture_complete).toBe(false);
 } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("concrete existing git citations preserve logs while bare, invented and mismatched references never authorize retention", async () => {
 const fixture = await referenceProducerFixture();
 try {
  const options = { source_revision: fixture.source, artifact_root: fixture.root };
  const original = describeFullTestProducer(fixture.result, options);
  await Bun.write(join(fixture.root, "retained.stdout"), original.stdout);
  fixture.git("add", "--", "retained.stdout");
  fixture.git("-c", "user.name=ResultFixture", "-c", "user.email=result@example.invalid", "commit", "--only", "-qm", "existing stream", "--", "retained.stdout");
  const commit = fixture.git("rev-parse", "HEAD");
  const stream = original.result_ref.stdout!;
  const citation = { kind: "git", stream: "stdout", repository: fixture.root, commit, path: "retained.stdout", bytes: stream.bytes, sha256: stream.sha256 };
  const cited = describeFullTestProducer(fixture.result, { ...options, references: [citation] });
  expect(cited.result_ref.retention).toEqual({ status: "CITED_UNVERIFIED", durable: false, citations: [citation], errors: [] });
  expect(readFileSync(join(fixture.root, "retained.stdout"), "utf8")).toBe(original.stdout);
  expect(cited.stdout).toBe(original.stdout);
  const absentCommit = describeFullTestProducer(fixture.result, { ...options, references: [{ ...citation, commit: "f".repeat(40), path: "absent.stdout" }] });
  expect(absentCommit.result_ref.retention.status).toBe("CITED_UNVERIFIED");
  expect(absentCommit.result_ref.retention.durable).toBe(false);
  const inventedMessage = describeFullTestProducer(fixture.result, { ...options, references: [{
   kind: "agent-mail", stream: "stdout", project_key: fixture.root, message_id: Number.MAX_SAFE_INTEGER,
   attachment: "unretrieved.stdout", bytes: stream.bytes, sha256: stream.sha256,
  }] });
  expect(inventedMessage.result_ref.retention.status).toBe("CITED_UNVERIFIED");
  expect(inventedMessage.result_ref.retention.durable).toBe(false);
  for (const references of [[{ kind: "agent-mail", message_id: Number.MAX_SAFE_INTEGER }], [{ ...citation, bytes: stream.bytes - 1 }], [{ ...citation, commit: "not-a-revision" }]]) {
   const reference = describeFullTestProducer(fixture.result, { ...options, references }).result_ref;
   expect(reference.capture_complete).toBe(false);
   expect(reference.missing_fields).toContain("citations");
   expect(reference.retention.status).toBe("UNRETAINED");
   expect(reference.retention.durable).toBe(false);
  }
 } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("contradictory counters and a nested Bun report cannot become whole-producer test totals", async () => {
 const fixture = await referenceProducerFixture();
 try {
  const options = { source_revision: fixture.source, artifact_root: fixture.root };
  const footer = fixture.result.stderr.lastIndexOf("Ran ");
  const poisoned = fixture.result.stderr.slice(0, footer) + "0 pass\n0 fail\nRan 0 tests across 1 file. [1.00ms]\n";
  const duplicate = fixture.result.stderr.replace(" 1 pass\n", " 1 pass\n 1 pass\n");
  const contradiction = fixture.result.stderr.replace(" 1 fail\n", " 0 fail\n").replace("Ran 2 tests", "Ran 1 test");
  for (const stderr of [poisoned, duplicate, contradiction]) {
   const result = { ...fixture.result, stderr, execution: { ...fixture.result.execution,
    stderr_capture: { bytes: Buffer.byteLength(stderr), sha256: new Bun.CryptoHasher("sha256").update(stderr).digest("hex") },
   } };
   const reference = describeFullTestProducer(result, options).result_ref;
   expect(reference.capture_complete).toBe(false);
   expect(reference.missing_fields).toContain("counts");
   expect(reference.counts).toBe(null);
  }
  const nested = describeFullTestProducer({ ...fixture.result, execution: { ...fixture.result.execution,
   argv: ["/bin/sh", join(fixture.root, "ladder.sh")],
  } }, options).result_ref;
  expect(nested.capture_complete).toBe(false);
  expect(nested.counts).toBe(null);
  expect(nested.missing_fields).toContain("counts");
 } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("a real Bun cwd operand cannot relabel nested test output as immediate producer counts", async () => {
 const fixture = await referenceProducerFixture();
 try {
  mkdirSync(join(fixture.root, "test"));
  const nested = [process.execPath, "--no-env-file", "test", "--config", "/dev/null", join(fixture.root, "cases.test.ts")];
  await Bun.write(join(fixture.root, "test", "report.ts"), [
   `const child = Bun.spawnSync(${JSON.stringify(nested)}, { stdout: "pipe", stderr: "pipe" });`,
   "process.stdout.write(child.stdout);",
   "process.stderr.write(child.stderr);",
   "process.exit(child.exitCode);",
  ].join("\n"));
  fixture.git("add", "--", "test/report.ts");
  fixture.git("-c", "user.name=ResultFixture", "-c", "user.email=result@example.invalid", "commit", "--only", "-qm", "actual nested producer", "--", "test/report.ts");
  const argv = [process.execPath, "--cwd", "test", "run", "./report.ts"];
  const child = Bun.spawnSync(argv, { cwd: fixture.root, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode).toBe(1);
  const stdout = child.stdout.toString(), stderr = child.stderr.toString();
  const result = { code: child.exitCode, stdout, stderr, execution: {
   argv, cwd: fixture.root, launched: true, exit_code: child.signalCode ? null : child.exitCode, signal: child.signalCode ?? null,
   interrupted: false, stdout_complete: true, stderr_complete: true,
   stdout_capture: { bytes: Buffer.byteLength(stdout), sha256: new Bun.CryptoHasher("sha256").update(stdout).digest("hex") },
   stderr_capture: { bytes: Buffer.byteLength(stderr), sha256: new Bun.CryptoHasher("sha256").update(stderr).digest("hex") },
  } };
  const reference = describeFullTestProducer(result, { source_revision: fixture.git("rev-parse", "HEAD"), artifact_root: fixture.root }).result_ref;
  expect(reference.counts).toBe(null);
  expect(reference.missing_fields).toContain("counts");
  expect(reference.capture_complete).toBe(false);
 } finally { rmSync(fixture.root, { recursive: true, force: true }); }
});

test("real checker case records reject missing, duplicated, corrupt and unfinished execution evidence", () => {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-source-cases-")));
 try {
  const path = join(root, "claim-selftest.jsonl");
  const child = Bun.spawnSync(["/bin/sh", fileURLToPath(new URL("../../checkers/check-claim-discipline.sh", import.meta.url)), "--selftest"], {
   env: { ...process.env, OMP_KIT_TEST_CASE_REPORT: path, OMP_KIT_TEST_CASE_SCOPE: "claim-selftest" }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
  const capture = readTestCaseReports(root, ["claim-selftest"]);
  const baseline = summarizeTestCaseReports(capture);
  expect(baseline.error).toBe(null);
  expect(baseline.counts).toMatchObject({ protocol: "OMP_KIT_CASES", unit: "TEST_CASE_EXECUTION", fail: 0, skip: 0 });
  expect(baseline.failing_names).toEqual([]);
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const first = JSON.parse(lines[1]!);
  const failed = { ...first, outcome: "FAIL" };
  const failedBody = [lines[0], JSON.stringify(failed), ...lines.slice(2)].join("\n") + "\n";
  const namedFailure = summarizeTestCaseReports({ ...capture, reports: [{ scope: "claim-selftest", body: failedBody }] });
  expect(namedFailure.counts?.fail).toBe(1);
  expect(namedFailure.failing_names).toEqual([`claim-selftest: ${first.name}`]);
  const withoutName = { ...first };
  Reflect.deleteProperty(withoutName, "name");
  const end = JSON.parse(lines.at(-1)!);
  const variants = [
   lines.slice(0, -1).join("\n") + "\n",
   [lines[0], ...lines.slice(2)].join("\n") + "\n",
   [lines[0], lines[1], ...lines.slice(1)].join("\n") + "\n",
   [lines[0], JSON.stringify(withoutName), ...lines.slice(2)].join("\n") + "\n",
   [lines[0], JSON.stringify({ ...first, outcome: "NOT_RUN" }), ...lines.slice(2)].join("\n") + "\n",
   [...lines.slice(0, -1), JSON.stringify({ ...end, cases: end.cases + 1 })].join("\n") + "\n",
   readFileSync(path, "utf8").slice(0, -1),
   [lines[0], lines[1]!.replace('\"event\":\"case\"', '\"event\":\"begin\",\"event\":\"case\"'), ...lines.slice(2)].join("\n") + "\n",
  ];
  for (const body of variants) {
   const result = summarizeTestCaseReports({ ...capture, reports: [{ scope: "claim-selftest", body }] });
   expect(result.counts).toBe(null);
   expect(result.failing_names).toBe(null);
  }
  expect(summarizeTestCaseReports({ ...capture, expected_scopes: ["claim-selftest", "readiness-selftest"] }).counts).toBe(null);
  expect(summarizeTestCaseReports({ ...capture, errors: ["interrupted case file"] }).counts).toBe(null);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deeply nested unexpected case payload remains incomplete rather than escaping the evidence path", () => {
 const scope = "claim-selftest";
 const begin = JSON.stringify({ schema_version: 1, scope, event: "begin" });
 const deep = "[".repeat(20_000) + "0" + "]".repeat(20_000);
 const body = begin + "\n" + '{"schema_version":1,"scope":"claim-selftest","event":"case","name":"declared","outcome":"PASS","unexpected":' + deep + "}\n"
  + JSON.stringify({ schema_version: 1, scope, event: "end", cases: 1 }) + "\n";
 const result = summarizeTestCaseReports({ expected_scopes: [scope], reports: [{ scope, body }], errors: [] });
 expect(result.counts).toBe(null);
 expect(result.failing_names).toBe(null);
});

test("a lost shell outcome write cannot shrink into a completed execution window", () => {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-kit-case-write-loss-")));
 try {
  const path = join(root, "claim-selftest.jsonl");
  const script = [
   '. "$1"',
   'loss_marker=$3',
   'awk() { if [ ! -f "$loss_marker" ]; then : > "$loss_marker"; return 1; fi; command awk "$@"; }',
   'start_case_report',
   'report_test_case "first observed case" PASS',
   'report_test_case "second observed case" PASS',
   'finish_case_report',
  ].join("\n");
  const child = Bun.spawnSync(["/bin/sh", "-c", script, "sh", fileURLToPath(new URL("../../scripts/test-case-report.sh", import.meta.url)), path, join(root, "loss")], {
   env: { ...process.env, OMP_KIT_TEST_CASE_REPORT: path, OMP_KIT_TEST_CASE_SCOPE: "claim-selftest" }, stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = summarizeTestCaseReports(readTestCaseReports(root, ["claim-selftest"]));
  expect(result.counts).toBe(null);
  expect(result.failing_names).toBe(null);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
