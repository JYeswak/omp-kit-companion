import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareWatched, operatorWatchedPaths, snapshotWatched, type WatchedComparison } from "./operator-snapshot.ts";
import { resolveOmpIdentity } from "./paths.ts";
import { BundledRunInterruptedError, runIsolatedShell, type BundledRunResult } from "./runtime.ts";
import { runFastTest, type FastTestExpectations, type FastTestInput, type FastTestReport, type FastTestStatus } from "./test-runner.ts";
import { RELEASE_DATA } from "./release-assets.ts";
import { RELEASE_MANIFEST_NAME, validateReleaseManifest } from "./kit-release.ts";
import { summarizeTestCaseReports, type NativeTestCaseCounts } from "./test-case-report.ts";

const STAGES = ["manifest", "harness-gate", "harness-selftest", "flywheel-invariants", "regex-budget", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"] as const;
export type FullStageName = typeof STAGES[number];
export type FullStage = {
 status: "PASS" | "FAIL" | "NOT_RUN"; producer_rc: number | null; duration_ms: number | null; reason?: string;
 output?: { stdout_chars: number; stdout_head?: string; stdout_tail: string; stderr_tail: string };
};
export type FullTestProducerArtifacts = { directory: string; stdout_path: string; stderr_path: string };
export type FullTestProducer = { producer_rc: number | null; stdout: string; stderr: string; artifacts: FullTestProducerArtifacts | null; artifact_error: string | null; result_ref: FullTestResultReference };
export type FullTestCounts = NativeTestCaseCounts | { protocol: "BUN_TEST"; unit: "TEST_CASE"; pass: number; fail: number; skip: number; total: number };
export type FullTestCitation =
 | { kind: "git"; stream: "stdout" | "stderr"; repository: string; commit: string; path: string; bytes: number; sha256: string; bead?: string }
 | { kind: "agent-mail"; stream: "stdout" | "stderr"; project_key: string; message_id: number; attachment: string; bytes: number; sha256: string };
export type FullTestStreamReference = {
 representation: "REDACTED_DECODED_UTF8"; bytes: number; sha256: string; path: string | null;
 capture: { bytes: number; sha256: string } | null; capture_complete: boolean; identity_matches: boolean | null;
};
export type FullTestResultReference = {
 schema_version: 1; source_revision: string | null; source_revision_authority: "BUILD_METADATA_NOT_EXTERNAL_QUALIFICATION";
 argv: string[] | null; argv_sha256: string | null; argv_sha256_representation: "CANONICAL_JSON_ORIGINAL_ARGV"; argv_representation: "PRIVACY_REDACTED"; cwd: string | null;
 execution: "NOT_OBSERVED" | "EXIT_NOT_OBSERVED" | "EXITED" | "INTERRUPTED"; producer_exit: number | null; runner_exit: number | null; signal: string | null;
 counts: FullTestCounts | null; failing_names: string[] | null;
 case_report_error: string | null;
 /** Runner diagnostic kept apart from producer pipe bytes; never part of stdout/stderr identities. */
 supervisor_note: string | null;
 stdout: FullTestStreamReference | null; stderr: FullTestStreamReference | null;
 /** Structural execution capture only; never suite completion or authenticated retention. */
 execution_capture_complete: boolean; missing_fields: string[];
 retention: { status: "UNRETAINED" | "CITED_UNVERIFIED"; durable: false; citations: FullTestCitation[]; errors: string[] };
};
export type FullTestCause = { cause_code: string; cause_name: string; cause_message: string; cause_stack_head: string | null };
export type FullTestReport = {
 status: FastTestStatus; exitCode: 0 | 1 | 3; fast: FastTestReport; fast_duration_ms: number;
 omp_version: string | null; stages: Record<FullStageName, FullStage>;
 current_stage: { name: string; elapsed_ms: number } | null; cause: FullTestCause | null;
 proofs: { G4_live: { status: "PASS" | "FAIL" | "NOT_RUN"; expected_scenarios: number; observed_scenarios: number; plant: "PASS" | "FAIL" | "NOT_RUN" } };
 live_scenarios: { expected_ids: string[]; observed_ids: string[]; status: "PASS" | "FAIL" | "NOT_RUN" };
 snapshots: { release: { unchanged: boolean | null; complete: boolean }; home: WatchedComparison; project: WatchedComparison };
 producer: FullTestProducer;
 failures: string[]; proof_scope: "ISOLATED_FIXTURE_ONLY";
};
function redactFullTestText(text: string, roots: readonly string[]): string {
 const paths = new Set<string>();
 for (const root of roots) {
  if (!root) continue;
  paths.add(root);
  if (root.startsWith("/private/")) paths.add(root.slice("/private".length));
  else if (root.startsWith("/tmp/") || root.startsWith("/var/")) paths.add(`/private${root}`);
 }
 for (const path of [...paths]) paths.add(encodeURI(path));
 let value = text;
 for (const path of [...paths].sort((a, b) => b.length - a.length))
  value = value.split(path).join("<private-path>");
 return value
  .replace(/(?:\/private)?\/tmp\/omp-kit-(?:work|runtime)-[^\s'"<>]*|(?:\/private)?\/var\/folders\/[^/\s]+\/[^/\s]+\/T\/omp-kit-(?:work|runtime)-[^\s'"<>]*/g, "<private-runtime-temp>")
  .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, "<redacted-private-key>")
  .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^/\s"'<>@]+@/gi, "$1<redacted>@")
  .replace(/\b(Bearer|Basic)\s+[^\s,"'<>]+/gi, "$1 <redacted>")
  .replace(/(\b(?:authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|passwd|secret)\b["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\[\s\S])*(?:"|\\?$)|'(?:[^'\\]|\\[\s\S])*(?:'|\\?$)|[^\s,;"'<>]+)/gi, "$1<redacted>")
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:ant-|proj-)?[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9-]+|glpat-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, "<redacted>")
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>");
}

/** Apply the producer privacy policy before bounding each primitive cause field. */
export function redactFullTestCause(cause: FullTestCause, roots: readonly string[]): FullTestCause {
 return {
  cause_code: redactFullTestText(cause.cause_code, roots).slice(0, 100),
  cause_name: redactFullTestText(cause.cause_name, roots).slice(0, 100),
  cause_message: redactFullTestText(cause.cause_message, roots).slice(0, 200),
  cause_stack_head: cause.cause_stack_head === null ? null
   : redactFullTestText(cause.cause_stack_head, roots).split("\n", 2).join("\n").slice(0, 400),
 };
}

function describeCause(error: unknown, roots: readonly string[]): FullTestCause {
 const isError = error instanceof Error;
 const record = error !== null && typeof error === "object" ? error as { code?: unknown } : null;
 return redactFullTestCause({
  cause_code: typeof record?.code === "string" ? record.code : isError ? error.name : "UNKNOWN_ERROR",
  cause_name: isError ? error.name : typeof error,
  cause_message: isError ? error.message : String(error),
  cause_stack_head: isError && error.stack ? error.stack : null,
 }, roots);
}

export function recoverInterruptedRun(error: unknown, roots: readonly string[] = []): { cause: FullTestCause; result: BundledRunResult } {
 if (error instanceof BundledRunInterruptedError)
  return { cause: describeCause(error.originalCause, roots), result: error.partialResult };
 return { cause: describeCause(error, roots), result: { code: 3, stdout: "", stderr: "", in_flight_stage: null } };
}
/** `stateRoot` defaults to $XDG_STATE_HOME/omp-kit (or ~/.local/state/omp-kit) and is part of the watched operator set. */
export type FullTestInput = FastTestInput & { stateRoot?: string; references?: unknown };
export function currentStageReport(
 progress: NonNullable<BundledRunResult["in_flight_stage"]> | null,
 endedAt = performance.now(),
): { name: string; elapsed_ms: number } | null {
 return progress ? { name: progress.name, elapsed_ms: Math.max(0, Math.round(endedAt - progress.started_at)) } : null;
}

/** Preserve full ladder streams outside an exact-commit archive when its caller supplies the host repo root. */
export function retainProducerOutput(repoRoot: string, output: Pick<BundledRunResult, "stdout" | "stderr">): FullTestProducerArtifacts {
 if (!isAbsolute(repoRoot) || !existsSync(repoRoot)) throw new Error("FULL_TEST_ARTIFACT_ROOT_INVALID");
 const canonicalRepo = realpathSync(repoRoot);
 const scratchRoot = join(canonicalRepo, "var", "agent-tmp");
 mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
 const canonicalScratch = realpathSync(scratchRoot);
 const relativeScratch = relative(canonicalRepo, canonicalScratch);
 if (relativeScratch === ".." || relativeScratch.startsWith(`..${sep}`) || isAbsolute(relativeScratch))
  throw new Error("FULL_TEST_ARTIFACT_ROOT_ESCAPES_REPO");
 const directory = mkdtempSync(join(canonicalScratch, `full-test.${process.pid}.`));
 const stdout_path = join(directory, "producer.stdout");
 const stderr_path = join(directory, "producer.stderr");
 writeFileSync(join(directory, ".owner"),
  `pid=${process.pid}\nlabel=full-test\nrepo=${canonicalRepo}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
 writeFileSync(stdout_path, output.stdout, { mode: 0o600 });
 writeFileSync(stderr_path, output.stderr, { mode: 0o600 });
 return { directory, stdout_path, stderr_path };
}

function referenceInteger(value: string): number | null {
 if (!value.length) return null;
 for (let index = 0; index < value.length; index++) {
  const code = value.charCodeAt(index);
  if (code < 48 || code > 57) return null;
 }
 const count = Number(value);
 return Number.isSafeInteger(count) ? count : null;
}

function referenceRevision(value: unknown): value is string {
 if (typeof value !== "string" || (value.length !== 40 && value.length !== 64)) return false;
 for (let index = 0; index < value.length; index++) {
  const code = value.charCodeAt(index);
  if (!(code >= 48 && code <= 57) && !(code >= 97 && code <= 102)) return false;
 }
 return true;
}

/** Recognize one complete Bun test report; unrelated stage/proof/scenario totals are never substituted. */
function fullTestCounts(stdout: string, stderr: string, argv: readonly string[] | null): { counts: FullTestCounts | null; failing_names: string[] | null } {
 const executable = argv?.[0];
 const name = executable?.slice(executable.lastIndexOf("/") + 1);
 let command = 1;
 // Only a known operand-free prefix is supported; an unknown option's value may itself be "test".
 while (argv?.[command] === "--no-env-file") command++;
 if ((name !== "bun" && name !== "bun.exe") || argv?.[command] !== "test") return { counts: null, failing_names: null };
 if (!stdout.includes("bun test v") && !stderr.includes("bun test v")) return { counts: null, failing_names: null };
 let pass: number | null = null, fail: number | null = null, skip: number | null = null, total: number | null = null;
 let summaries = 0, namedFailures: number | null = null;
 let ambiguous = false;
 const names: string[] = [];
 const inspect = (text: string): void => {
  for (let begin = 0; begin < text.length;) {
   const end = text.indexOf("\n", begin);
   const line = text.slice(begin, end < 0 ? text.length : end).trim();
   begin = end < 0 ? text.length : end + 1;
   const space = line.indexOf(" ");
   const number = space < 0 ? null : referenceInteger(line.slice(0, space));
   const label = space < 0 ? "" : line.slice(space + 1);
   if (number !== null) {
    if (label === "pass") { if (pass !== null) ambiguous = true; else pass = number; }
    else if (label === "fail") { if (fail !== null) ambiguous = true; else fail = number; }
    else if (label === "skip") { if (skip !== null) ambiguous = true; else skip = number; }
    else if (label === "tests failed:" || label === "test failed:") {
     namedFailures = number; names.length = 0;
    }
   }
   if (line.startsWith("(fail) ")) {
    let name = line.slice(7);
    const bracket = name.lastIndexOf(" [");
    if (bracket >= 0 && name.endsWith("]")) {
     const duration = name.slice(bracket + 2, -1);
     const suffix = duration.endsWith("ms") ? 2 : duration.endsWith("s") ? 1 : 0;
     const value = suffix ? duration.slice(0, -suffix) : "";
     if (value.length && Number.isFinite(Number(value))) name = name.slice(0, bracket);
    }
    names.push(name);
   }
   if (line.startsWith("Ran ")) {
    const tests = line.indexOf(" test", 4);
    const count = tests < 0 ? null : referenceInteger(line.slice(4, tests));
    const rest = tests < 0 ? "" : line.slice(tests);
    const across = rest.startsWith(" tests across ") ? 14 : rest.startsWith(" test across ") ? 13 : 0;
    const file = across ? rest.indexOf(" file", across) : -1;
    const files = file < 0 ? null : referenceInteger(rest.slice(across, file));
    const ending = file < 0 ? "" : rest.slice(file);
    if (count !== null && files !== null && files > 0 && (ending.startsWith(" files.") || ending.startsWith(" file."))) {
     total = count; summaries++;
    }
   }
  }
 };
 inspect(stdout); inspect(stderr);
 if (ambiguous || summaries !== 1 || pass === null || fail === null || total === null) return { counts: null, failing_names: null };
 // Bun omits the zero-skip row. Infer zero only from its reported total, never from silence alone.
 if (skip === null && total === pass + fail) skip = 0;
 if (skip === null || total !== pass + fail + skip) return { counts: null, failing_names: null };
 if ((fail === 0 && names.length > 0) || (namedFailures !== null && namedFailures !== fail)) return { counts: null, failing_names: null };
 return {
  counts: { protocol: "BUN_TEST", unit: "TEST_CASE", pass, fail, skip, total },
  failing_names: fail === 0 ? [] : (namedFailures === null || namedFailures === fail) && names.length === fail ? names : null,
 };
}

function fullTextIdentity(text: string): { bytes: number; sha256: string } {
 return { bytes: Buffer.byteLength(text, "utf8"), sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

function referenceRecord(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fullTestCitations(input: unknown, streams: { stdout: FullTestStreamReference | null; stderr: FullTestStreamReference | null }, redact: (text: string) => string): FullTestResultReference["retention"] {
 const citations: FullTestCitation[] = [], errors: string[] = [];
 let value = input;
 if (typeof value === "string") {
  try { value = JSON.parse(value); } catch { errors.push("Reference input is not JSON"); }
 }
 if (value !== undefined && value !== null && !Array.isArray(value)) errors.push("References must be an array of concrete stream citations");
 if (Array.isArray(value)) for (const [index, row] of value.entries()) {
  const invalid = (): void => { errors.push(`Reference ${index} is incomplete, unsupported, or differs from the captured stream identity`); };
  if (!referenceRecord(row) || (row.stream !== "stdout" && row.stream !== "stderr")) { invalid(); continue; }
  const stream = streams[row.stream];
  if (!stream || row.bytes !== stream.bytes || row.sha256 !== stream.sha256) { invalid(); continue; }
  if (row.kind === "git" && typeof row.repository === "string" && row.repository.length > 0
   && referenceRevision(row.commit) && typeof row.path === "string" && row.path.length > 0
   && !isAbsolute(row.path) && !row.path.split("/").includes("..") && !row.path.includes("\\")
   && (row.bead === undefined || typeof row.bead === "string")) {
   citations.push({ kind: "git", stream: row.stream, repository: redact(row.repository), commit: row.commit,
    path: redact(row.path), bytes: stream.bytes, sha256: stream.sha256,
    ...(typeof row.bead === "string" ? { bead: redact(row.bead) } : {}) });
  } else if (row.kind === "agent-mail" && typeof row.project_key === "string" && row.project_key.length > 0
   && typeof row.message_id === "number" && Number.isSafeInteger(row.message_id) && row.message_id > 0
   && typeof row.attachment === "string" && row.attachment.length > 0) {
   citations.push({ kind: "agent-mail", stream: row.stream, project_key: redact(row.project_key),
    message_id: row.message_id, attachment: redact(row.attachment), bytes: stream.bytes, sha256: stream.sha256 });
  } else invalid();
 }
 // A locator is a citation, not proof that its commit, message or attachment exists or was retrieved.
 return { status: citations.length ? "CITED_UNVERIFIED" : "UNRETAINED", durable: false, citations, errors };
}

/**
 * Full decoded-stream identities and actual execution facts, independent of bounded public previews.
 * Scratch files and supplied external locators never become durable or authenticated evidence here.
 */
export function describeFullTestProducer(result: BundledRunResult | null, options: {
 source_revision: string | null; roots?: readonly string[]; artifact_root?: string; references?: unknown;
}): FullTestProducer {
 const redact = (text: string): string => redactFullTestText(text, options.roots ?? []);
 const stdout = result ? redact(result.stdout) : "", stderr = result ? redact(result.stderr) : "";
 const execution = result?.execution;
 const argv = execution?.launched && Array.isArray(execution.argv) && execution.argv.length > 0
  && execution.argv.every((argument: unknown) => typeof argument === "string") ? execution.argv : null;
 const cwd = execution?.launched && typeof execution.cwd === "string" && execution.cwd.length > 0 ? execution.cwd : null;
 const signal = typeof execution?.signal === "string" ? execution.signal : null;
 const producerExit = execution?.launched && typeof execution.exit_code === "number" && Number.isSafeInteger(execution.exit_code)
  && execution.exit_code >= 0 && signal === null ? execution.exit_code : null;
 let artifacts: FullTestProducerArtifacts | null = null, artifactError: string | null = null;
 if (options.artifact_root !== undefined && result && (execution?.launched || result.stdout.length || result.stderr.length)) {
  try { artifacts = retainProducerOutput(options.artifact_root, { stdout, stderr }); }
  catch (error) { artifactError = redact(error instanceof Error ? error.message : String(error)).slice(0, 200); }
 }
 const stream = (name: "stdout" | "stderr", raw: string, text: string): FullTestStreamReference | null => {
  if (!result || (!execution?.launched && !raw.length)) return null;
  const identity = fullTextIdentity(raw);
  const capture = execution?.[name === "stdout" ? "stdout_capture" : "stderr_capture"] ?? null;
  return {
   representation: "REDACTED_DECODED_UTF8", ...(raw === text ? identity : fullTextIdentity(text)),
   path: artifacts?.[name === "stdout" ? "stdout_path" : "stderr_path"] ?? null, capture,
   capture_complete: execution?.[name === "stdout" ? "stdout_complete" : "stderr_complete"] === true,
   identity_matches: capture ? capture.bytes === identity.bytes && capture.sha256 === identity.sha256 : null,
  };
 };
 const streams = { stdout: stream("stdout", result?.stdout ?? "", stdout), stderr: stream("stderr", result?.stderr ?? "", stderr) };
 const nativeSummary = result?.case_reports
  ? argv?.[0] === "/bin/sh" && argv[1]?.endsWith("/scripts/ladder.sh")
   ? summarizeTestCaseReports(result.case_reports)
   : { counts: null, failing_names: null, error: "Case producer invocation was not observed" }
  : null;
 const summary = nativeSummary ?? (result ? fullTestCounts(result.stdout, result.stderr, argv) : { counts: null, failing_names: null });
 const retention = fullTestCitations(options.references, streams, redact);
 const missing: string[] = [];
 const source = referenceRevision(options.source_revision) ? options.source_revision : null;
 if (!source) missing.push("source_revision");
 if (!argv) missing.push("argv");
 if (!cwd) missing.push("cwd");
 if (producerExit === null) missing.push("producer_exit");
 if (execution?.interrupted) missing.push("execution.interrupted");
 if (!summary.counts) missing.push("counts");
 if (summary.failing_names === null) missing.push("failing_names");
 for (const name of ["stdout", "stderr"] as const) {
  const captured = streams[name];
  if (!captured?.capture) missing.push(`${name}.capture`);
  if (captured?.identity_matches !== true) missing.push(`${name}.identity`);
  if (!captured?.capture_complete) missing.push(`${name}.eof`);
  if (!captured?.path) missing.push(`${name}.storage`);
 }
 if (retention.errors.length) missing.push("citations");
 return {
  producer_rc: result?.code ?? null, stdout, stderr, artifacts, artifact_error: artifactError,
  result_ref: {
   schema_version: 1, source_revision: source, source_revision_authority: "BUILD_METADATA_NOT_EXTERNAL_QUALIFICATION",
   argv: argv?.map(redact) ?? null,
   argv_sha256: argv ? createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex") : null,
   argv_sha256_representation: "CANONICAL_JSON_ORIGINAL_ARGV", argv_representation: "PRIVACY_REDACTED", cwd: cwd ? redact(cwd) : null,
   execution: !execution?.launched ? "NOT_OBSERVED" : execution.interrupted ? "INTERRUPTED"
    : producerExit !== null || signal !== null ? "EXITED" : "EXIT_NOT_OBSERVED",
   producer_exit: producerExit, runner_exit: result?.code ?? null, signal,
   counts: summary.counts, failing_names: summary.failing_names?.map(redact) ?? null, ...streams,
   case_report_error: nativeSummary?.error ? redact(nativeSummary.error) : null,
   supervisor_note: typeof result?.supervisor_note === "string" ? redact(result.supervisor_note) : null,
   execution_capture_complete: missing.length === 0, missing_fields: missing, retention,
  },
 };
}

function fullTestSourceRevision(root: string): string | null {
 try {
  const manifest = validateReleaseManifest(JSON.parse(readFileSync(join(root, RELEASE_MANIFEST_NAME), "utf8")));
  const entry = manifest.files.find(file => file.path === "package.json");
  if (!entry) return null;
  const path = join(root, "package.json"), info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return null;
  const metadata: unknown = JSON.parse(bytes.toString("utf8"));
  return referenceRecord(metadata) && referenceRevision(metadata.source_revision) ? metadata.source_revision : null;
 } catch { return null; }
}

type Snapshot = { digest: string | null; complete: boolean };
function snapshot(root: string | undefined, release: boolean): Snapshot {
 if (!root) return { digest: null, complete: true };
 const hash = createHash("sha256");
 const block = Buffer.allocUnsafe(64 * 1024);
 const maxBytes = release ? Number.MAX_SAFE_INTEGER : 256 * 1024 * 1024;
 let count = 0, bytes = 0, complete = true;
 const visit = (path: string, depth: number): void => {
  if (!existsSync(path)) {
   hash.update(`missing:${relative(root, path)}\n`);
   complete = false;
   return;
  }
  const stat = lstatSync(path);
  const name = relative(root, path) || ".";
  hash.update(`${name}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.isSymbolicLink()}\n`);
  if (++count > 5000) { complete = false; return; }
  if (stat.isSymbolicLink()) {
   const target = readlinkSync(path);
   hash.update(target);
   const resolved = resolve(dirname(path), target);
   const withinRoot = relative(root, resolved);
   if (release || !existsSync(resolved) || withinRoot === ".." || withinRoot.startsWith("../") || isAbsolute(withinRoot))
    complete = false;
   return;
  }
  if (stat.isFile()) {
   if (stat.size > maxBytes - bytes) { complete = false; return; }
   const fd = openSync(path, "r");
   let size = 0;
   try {
    for (let read = readSync(fd, block, 0, block.length, null); read > 0; read = readSync(fd, block, 0, block.length, null)) {
     hash.update(block.subarray(0, read));
     size += read;
    }
   } finally { closeSync(fd); }
   bytes += size;
   if (size !== stat.size) complete = false;
  } else if (stat.isDirectory()) {
   const children = readdirSync(path).sort();
   if (depth === 0 && children.length) complete = false;
   else for (const child of children) {
    if (count >= 5000) { complete = false; break; }
    visit(join(path, child), depth - 1);
   }
  } else complete = false;
 };
 try { visit(root, 16); } catch { complete = false; }
 return { digest: hash.digest("hex"), complete };
}

/**
 * Parse exactly the ordered live rows shipped by the selected release; a passing shell rc alone is insufficient.
 * The installed kit validates the TARGET release's ladder during an update, so a stage name this version does not
 * know is a newer release's stage: it must be GREEN and is accepted. Every stage this version knows must still
 * appear, GREEN, in this order; a known stage that is skipped or reordered is a failure.
 */
export function classifyLadder(result: BundledRunResult, ids: readonly string[], output: Pick<BundledRunResult, "stdout" | "stderr"> = result): {
 stages: Record<FullStageName, FullStage>; live_scenarios: FullTestReport["live_scenarios"]; failures: string[];
} {
 const stages = Object.fromEntries(STAGES.map(name => [name, { status: "NOT_RUN", producer_rc: null, duration_ms: null }])) as Record<FullStageName, FullStage>;
 const isKnown = (name: string): name is FullStageName => (STAGES as readonly string[]).includes(name);
 const failures: string[] = [];
 const lines = result.stdout.split(/\r?\n/);
 const guardFailure = lines.find(line => line.startsWith("OMP_TRUST_GUARD_FAIL_CLOSED:"));
 const trustGuardRefusal = guardFailure?.toLowerCase().includes("omp-trust-guard: fail-closed:") === true;
 let next = 0;
 let trustGuardNotRun = false;
 for (const line of lines) {
  const match = /^(GREEN|RED)\s+(\S+) producer_rc=(\d+)(?: duration_ms=(\d+))?(?:\s|$)/.exec(line);
  if (!match) continue;
  const name = match[2]!;
  const rcMismatch = (match[1] === "GREEN" && match[3] !== "0") || (match[1] === "RED" && match[3] === "0");
  if (rcMismatch || (isKnown(name) && name !== STAGES[next])) {
   failures.push("Ladder stage order, identity, or producer rc mismatch");
   break;
  }
  if (isKnown(name)) {
   if (name === "cli-crosscheck" && match[1] === "RED" && match[3] === "3" && trustGuardRefusal) {
    stages[name] = {
     ...stages[name],
     status: "NOT_RUN",
     producer_rc: 3,
     reason: "omp-trust-guard FAIL-CLOSED before cases; provide its guard-approved real OMP via OMP_BIN or restore the wrapper's configured path. Trust policy was not changed.",
    };
    next++;
    trustGuardNotRun = true;
    break;
   }
   stages[name] = { status: match[1] === "GREEN" ? "PASS" : "FAIL", producer_rc: Number(match[3]),
    duration_ms: match[4] === undefined ? null : Number(match[4]) };
   if (match[1] === "RED") {
    const marker = `OMP_KIT_STAGE_START name=${name}\n`;
    const start = output.stdout.startsWith(marker) ? 0 : output.stdout.indexOf("\n" + marker);
    if (start < 0) {
     stages[name].reason = "Failed-stage output unavailable: start marker not observed";
    } else {
     const begin = output.stdout.startsWith(marker) ? 0 : start + 1;
     const end = output.stdout.indexOf("\nOMP_KIT_STAGE_START name=", begin + marker.length);
     const until = end < 0 ? output.stdout.length : end + 1;
     const length = until - begin;
     stages[name].output = {
      stdout_chars: length,
      ...(length > 2500 ? { stdout_head: output.stdout.slice(begin, begin + 2500) } : {}),
      stdout_tail: output.stdout.slice(Math.max(begin, until - 2500), until),
      stderr_tail: output.stderr.slice(-1000),
     };
    }
   }
   next++;
  }
  if (match[1] === "RED") { failures.push(`Stage ${name} returned producer_rc=${match[3]}`); break; }
 }
 const ordinary = lines.filter(line => line.startsWith("ok    ")).map(line => line.slice(6));
 const observed = new Set(ordinary);
 const missing = ids.filter(id => !observed.has(id));
 if (stages["e2e-live"].status !== "NOT_RUN" && missing.length) failures.unshift("Live scenario rows missing: " + missing.join(", "));
 const livePassed = stages["e2e-live"].status === "PASS" && ordinary.length === ids.length && ordinary.every((id, index) => id === ids[index]);
 if (stages["e2e-live"].status === "PASS" && !livePassed) failures.push("Live scenario rows did not match the exact shipped ordered scenario IDs");
 const plantPassed = stages["e2e-plant"].status === "PASS" && result.stdout.includes("plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close");
 if (stages["e2e-plant"].status === "PASS" && !plantPassed) failures.push("Planted negative control was not named RED");
 if (result.code === 0 && (next !== STAGES.length || !/^LADDER: GREEN$/m.test(result.stdout))) failures.push("Producer returned success without every named GREEN stage and LADDER: GREEN");
 if (result.code !== 0 && !failures.length && !trustGuardNotRun) failures.push(`Ladder exited ${result.code} before a named RED stage`);
 return { stages, live_scenarios: { expected_ids: [...ids], observed_ids: ordinary,
  status: stages["e2e-live"].status === "NOT_RUN" ? "NOT_RUN" : livePassed ? "PASS" : "FAIL" }, failures };
}

/** Actual OMP live calls run in a private HOME; never claim the operator's effective profile was certified. */
export async function runFullTest(input: FullTestInput, expectedCounts?: FastTestExpectations): Promise<FullTestReport> {
 if (![input.root, input.executablePath, input.home, ...(input.project ? [input.project] : [])].every(isAbsolute))
  throw new Error("full-test release, executable, HOME, and project paths must be absolute");
 const sourceRevision = fullTestSourceRevision(input.root);
 const references = input.references ?? process.env.OMP_KIT_FULL_TEST_REFERENCES;
 const artifactRepo = process.env.OMP_KIT_CASE_CWD ?? process.env.GITHUB_WORKSPACE;
 const watchedPaths = operatorWatchedPaths(input.home, input.stateRoot ?? join(process.env.XDG_STATE_HOME ?? join(input.home, ".local", "state"), "omp-kit"));
 // Only project paths a kit run could write; the rest of a real repository changes under concurrent work.
 const projectPaths = input.project ? [".omp", ".agents", ".claude"].map(name => join(input.project!, name)) : [];
 const before = { release: snapshot(input.root, true), home: snapshotWatched(watchedPaths), project: snapshotWatched(projectPaths) };
	const fastStarted = performance.now();
	const fast = expectedCounts ? await runFastTest(input, expectedCounts) : await runFastTest(input);
	const fast_duration_ms = Math.round(performance.now() - fastStarted);
 const defaults = Object.fromEntries(STAGES.map(name => [name, { status: "NOT_RUN", producer_rc: null, duration_ms: null }])) as Record<FullStageName, FullStage>;
 const empty = describeFullTestProducer(null, { source_revision: sourceRevision, references, roots: [input.root, input.home] });
 if (fast.status !== "PASS") {
  const after = { release: snapshot(input.root, true), home: snapshotWatched(watchedPaths), project: snapshotWatched(projectPaths) };
  const snapshots = { release: { unchanged: before.release.digest === after.release.digest, complete: before.release.complete && after.release.complete },
   home: compareWatched(before.home, after.home, input.home), project: compareWatched(before.project, after.project, input.home) };
  const failures = [...fast.failures];
  if (!snapshots.release.unchanged) failures.push("Release snapshot changed during failed fast stage");
  for (const path of [...snapshots.home.changed_paths, ...snapshots.project.changed_paths]) failures.push(`Operator file changed during failed fast stage: ${path}`);
  const status = failures.length > fast.failures.length ? "FAIL" : fast.status;
  return { status, exitCode: status === "FAIL" ? 1 : 3, fast, fast_duration_ms, omp_version: null,
   stages: defaults, current_stage: null, cause: null,
   proofs: { G4_live: { status: "NOT_RUN", expected_scenarios: 0, observed_scenarios: 0, plant: "NOT_RUN" } },
   live_scenarios: { expected_ids: [], observed_ids: [], status: "NOT_RUN" }, snapshots,
   producer: empty, failures, proof_scope: "ISOLATED_FIXTURE_ONLY" };
 }
 const parsed: unknown = JSON.parse(readFileSync(join(input.root, RELEASE_DATA.liveScenarios), "utf8"));
 if (!Array.isArray(parsed) || !parsed.length || !parsed.every(row =>
  row && typeof row === "object" && typeof row.id === "string" && (row.plant === undefined || typeof row.plant === "boolean")))
  throw new Error("INVALID_LIVE_SCENARIOS");
const ids: string[] = parsed.filter(row => row.plant !== true && row.kind !== "probe").map(row => row.id);
 const identity = resolveOmpIdentity(process.env);
 const ompPackage: unknown = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
 const ompVersion = ompPackage && typeof ompPackage === "object" && "version" in ompPackage && typeof ompPackage.version === "string"
  ? ompPackage.version : null;
 let result: BundledRunResult;
 const privateRoots = [input.root, input.home, input.project, input.stateRoot, process.env.HOME,
  identity.packageRoot, identity.launcher, identity.source, identity.nativeRoot].filter((path): path is string => Boolean(path));
 let cause: FullTestCause | null = null;
 // The native certification workflow sets this only for the Intel macOS row.
 const regexBudgetRuns = process.env.OMP_KIT_NATIVE_REGEX_BUDGET_RUNS;
 if (regexBudgetRuns !== undefined && regexBudgetRuns !== "1" && regexBudgetRuns !== "5")
  throw new Error("INVALID_NATIVE_REGEX_BUDGET_RUNS");
 const ladderArgs = regexBudgetRuns === "5" ? ["--regex-budget-runs", "5"] : [];
 try { result = await runIsolatedShell("scripts/ladder.sh", ladderArgs, input.root, input.executablePath); }
 catch (error) {
  const interrupted = recoverInterruptedRun(error, privateRoots);
  cause = interrupted.cause;
  result = interrupted.result;
 }
 const after = { release: snapshot(input.root, true), home: snapshotWatched(watchedPaths), project: snapshotWatched(projectPaths) };
 const snapshots = { release: { unchanged: before.release.digest === after.release.digest, complete: before.release.complete && after.release.complete },
  home: compareWatched(before.home, after.home, input.home), project: compareWatched(before.project, after.project, input.home) };
 const redact = (text: string) => redactFullTestText(text, privateRoots);
 const producer = describeFullTestProducer(result, { source_revision: sourceRevision, references, roots: privateRoots,
  ...(artifactRepo === undefined ? {} : { artifact_root: artifactRepo }) });
 const { stdout, stderr } = producer;
 const classified = classifyLadder(result, ids, { stdout, stderr });
 const currentStage = currentStageReport(result.in_flight_stage ?? null);
 const failures = [...classified.failures];
 if (!snapshots.release.unchanged) failures.push("Release snapshot changed during isolated test");
 if (!snapshots.release.complete) failures.push("Release snapshot was incomplete");
 for (const path of [...snapshots.home.changed_paths, ...snapshots.project.changed_paths]) failures.push(`Operator file changed during isolated test: ${path}`);
 for (const path of [...snapshots.home.incomplete_paths, ...snapshots.project.incomplete_paths]) failures.push(`Operator file could not be read completely: ${path}`);
 const incomplete = !snapshots.release.complete || !snapshots.project.complete || !snapshots.home.complete;
 const passed = result.code === 0 && !failures.length && classified.live_scenarios.status === "PASS" && classified.stages["e2e-plant"].status === "PASS";
 const plant = classified.stages["e2e-plant"].status === "NOT_RUN" ? "NOT_RUN"
  : classified.stages["e2e-plant"].status === "PASS" && !failures.includes("Planted negative control was not named RED") ? "PASS" : "FAIL";
 const guardBlocked = classified.stages["cli-crosscheck"].reason?.startsWith("omp-trust-guard FAIL-CLOSED") === true;
 const blocked = result.code === 3 || guardBlocked || (incomplete && failures.length === 1 && result.code === 0);
 return { status: passed ? "PASS" : blocked ? "BLOCKED" : "FAIL", exitCode: passed ? 0 : blocked ? 3 : 1,
  fast, fast_duration_ms, omp_version: ompVersion, stages: classified.stages,
  current_stage: currentStage, cause, live_scenarios: classified.live_scenarios,
  proofs: { G4_live: { status: classified.live_scenarios.status === "NOT_RUN" ? "NOT_RUN" : classified.live_scenarios.status === "PASS" && plant === "PASS" ? "PASS" : "FAIL",
   expected_scenarios: ids.length, observed_scenarios: classified.live_scenarios.observed_ids.length, plant } },
  snapshots, producer: { ...producer, stdout: passed ? stdout : stdout.slice(-2500),
   stderr: passed ? stderr : stderr.slice(-1000) },
  failures: failures.map(redact), proof_scope: "ISOLATED_FIXTURE_ONLY" };
}
