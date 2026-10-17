import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareWatched, operatorWatchedPaths, snapshotWatched, type WatchedComparison } from "./operator-snapshot.ts";
import { resolveOmpIdentity } from "./paths.ts";
import { BundledRunInterruptedError, runIsolatedShell, type BundledRunResult } from "./runtime.ts";
import { runFastTest, type FastTestExpectations, type FastTestInput, type FastTestReport, type FastTestStatus } from "./test-runner.ts";
import { RELEASE_DATA } from "./release-assets.ts";

const STAGES = ["manifest", "harness-gate", "harness-selftest", "flywheel-invariants", "regex-budget", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"] as const;
export type FullStageName = typeof STAGES[number];
export type FullStage = { status: "PASS" | "FAIL" | "NOT_RUN"; producer_rc: number | null; duration_ms: number | null; reason?: string };
export type FullTestProducerArtifacts = { directory: string; stdout_path: string; stderr_path: string };
export type FullTestProducer = { producer_rc: number | null; stdout: string; stderr: string; artifacts: FullTestProducerArtifacts | null; artifact_error: string | null };
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
export type FullTestInput = FastTestInput & { stateRoot?: string };
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
export function classifyLadder(result: BundledRunResult, ids: readonly string[]): {
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
 const watchedPaths = operatorWatchedPaths(input.home, input.stateRoot ?? join(process.env.XDG_STATE_HOME ?? join(input.home, ".local", "state"), "omp-kit"));
 // Only project paths a kit run could write; the rest of a real repository changes under concurrent work.
 const projectPaths = input.project ? [".omp", ".agents", ".claude"].map(name => join(input.project!, name)) : [];
 const before = { release: snapshot(input.root, true), home: snapshotWatched(watchedPaths), project: snapshotWatched(projectPaths) };
	const fastStarted = performance.now();
	const fast = expectedCounts ? await runFastTest(input, expectedCounts) : await runFastTest(input);
	const fast_duration_ms = Math.round(performance.now() - fastStarted);
 const defaults = Object.fromEntries(STAGES.map(name => [name, { status: "NOT_RUN", producer_rc: null, duration_ms: null }])) as Record<FullStageName, FullStage>;
 const empty: FullTestProducer = { producer_rc: null, stdout: "", stderr: "", artifacts: null, artifact_error: null };
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
 const classified = classifyLadder(result, ids);
 const currentStage = currentStageReport(result.in_flight_stage ?? null);
 const failures = [...classified.failures];
 if (!snapshots.release.unchanged) failures.push("Release snapshot changed during isolated test");
 if (!snapshots.release.complete) failures.push("Release snapshot was incomplete");
 for (const path of [...snapshots.home.changed_paths, ...snapshots.project.changed_paths]) failures.push(`Operator file changed during isolated test: ${path}`);
 for (const path of [...snapshots.home.incomplete_paths, ...snapshots.project.incomplete_paths]) failures.push(`Operator file could not be read completely: ${path}`);
 const incomplete = !snapshots.release.complete || !snapshots.project.complete || !snapshots.home.complete;
 const passed = result.code === 0 && !failures.length && classified.live_scenarios.status === "PASS" && classified.stages["e2e-plant"].status === "PASS";
 const redact = (text: string) => redactFullTestText(text, privateRoots);
 const plant = classified.stages["e2e-plant"].status === "NOT_RUN" ? "NOT_RUN"
  : classified.stages["e2e-plant"].status === "PASS" && !failures.includes("Planted negative control was not named RED") ? "PASS" : "FAIL";
 const guardBlocked = classified.stages["cli-crosscheck"].reason?.startsWith("omp-trust-guard FAIL-CLOSED") === true;
 const blocked = result.code === 3 || guardBlocked || (incomplete && failures.length === 1 && result.code === 0);
 const stdout = redact(result.stdout);
 const stderr = redact(result.stderr);
 const artifactRepo = process.env.OMP_KIT_CASE_CWD ?? process.env.GITHUB_WORKSPACE;
 let artifacts: FullTestProducerArtifacts | null = null;
 let artifactError: string | null = null;
 if (artifactRepo) {
  try { artifacts = retainProducerOutput(artifactRepo, { stdout, stderr }); }
  catch (error) { artifactError = redact(error instanceof Error ? error.message : String(error)).slice(0, 200); }
 }
 return { status: passed ? "PASS" : blocked ? "BLOCKED" : "FAIL", exitCode: passed ? 0 : blocked ? 3 : 1,
  fast, fast_duration_ms, omp_version: ompVersion, stages: classified.stages,
  current_stage: currentStage, cause, live_scenarios: classified.live_scenarios,
  proofs: { G4_live: { status: classified.live_scenarios.status === "NOT_RUN" ? "NOT_RUN" : classified.live_scenarios.status === "PASS" && plant === "PASS" ? "PASS" : "FAIL",
   expected_scenarios: ids.length, observed_scenarios: classified.live_scenarios.observed_ids.length, plant } },
  snapshots, producer: { producer_rc: result.code, stdout, stderr, artifacts, artifact_error: artifactError },
  failures: failures.map(redact), proof_scope: "ISOLATED_FIXTURE_ONLY" };
}
