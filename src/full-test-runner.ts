import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { resolveOmpIdentity } from "./paths.ts";
import { runIsolatedShell, type BundledRunResult } from "./runtime.ts";
import { runFastTest, type FastTestInput, type FastTestReport, type FastTestStatus } from "./test-runner.ts";

const STAGES = ["manifest", "harness-gate", "harness-selftest", "claim-selftest", "cli-crosscheck", "readiness-selftest", "e2e-live", "e2e-plant"] as const;
export type FullStageName = typeof STAGES[number];
export type FullStage = { status: "PASS" | "FAIL" | "NOT_RUN"; producer_rc: number | null; reason?: string };
export type FullTestReport = {
 status: FastTestStatus; exitCode: 0 | 1 | 3; fast: FastTestReport;
 omp_version: string | null; stages: Record<FullStageName, FullStage>;
 proofs: { G4_live: { status: "PASS" | "FAIL" | "NOT_RUN"; expected_scenarios: number; observed_scenarios: number; plant: "PASS" | "FAIL" | "NOT_RUN" } };
 live_scenarios: { expected_ids: string[]; observed_ids: string[]; status: "PASS" | "FAIL" | "NOT_RUN" };
 snapshots: Record<"release" | "home" | "project", { unchanged: boolean | null; complete: boolean }>;
 producer: { producer_rc: number | null; stdout: string; stderr: string };
 failures: string[]; proof_scope: "ISOLATED_FIXTURE_ONLY";
};
export type FullTestInput = FastTestInput;

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

/** Parse exactly the ordered live rows shipped by the selected release; a passing shell rc alone is insufficient. */
export function classifyLadder(result: BundledRunResult, ids: readonly string[]): {
 stages: Record<FullStageName, FullStage>; live_scenarios: FullTestReport["live_scenarios"]; failures: string[];
} {
 const stages = Object.fromEntries(STAGES.map(name => [name, { status: "NOT_RUN", producer_rc: null }])) as Record<FullStageName, FullStage>;
 const failures: string[] = [];
 const lines = result.stdout.split(/\r?\n/);
 let next = 0;
 for (const line of lines) {
  const match = /^(GREEN|RED)\s+(\S+) producer_rc=(\d+)(?:\s|$)/.exec(line);
  if (!match) continue;
  const expected = STAGES[next];
  if (match[2] !== expected || (match[1] === "GREEN" && match[3] !== "0") || (match[1] === "RED" && match[3] === "0")) {
   failures.push("Ladder stage order, identity, or producer rc mismatch");
   break;
  }
  stages[expected] = { status: match[1] === "GREEN" ? "PASS" : "FAIL", producer_rc: Number(match[3]) };
  next++;
  if (match[1] === "RED") { failures.push(`Stage ${expected} returned producer_rc=${match[3]}`); break; }
 }
 const ordinary = lines.filter(line => line.startsWith("ok    ")).map(line => line.slice(6));
 const livePassed = stages["e2e-live"].status === "PASS" && ordinary.length === ids.length && ordinary.every((id, index) => id === ids[index]);
 if (stages["e2e-live"].status === "PASS" && !livePassed) failures.push("Live scenario rows did not match the exact shipped ordered scenario IDs");
 const plantPassed = stages["e2e-plant"].status === "PASS" && result.stdout.includes("plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close");
 if (stages["e2e-plant"].status === "PASS" && !plantPassed) failures.push("Planted negative control was not named RED");
 if (result.code === 0 && (next !== STAGES.length || !/^LADDER: GREEN$/m.test(result.stdout))) failures.push("Producer returned success without eight named GREEN stages and LADDER: GREEN");
 if (result.code !== 0 && !failures.length) failures.push(`Ladder exited ${result.code} before a named RED stage`);
 return { stages, live_scenarios: { expected_ids: [...ids], observed_ids: ordinary,
  status: stages["e2e-live"].status === "NOT_RUN" ? "NOT_RUN" : livePassed ? "PASS" : "FAIL" }, failures };
}

/** Actual OMP live calls run in a private HOME; never claim the operator's effective profile was certified. */
export async function runFullTest(input: FullTestInput): Promise<FullTestReport> {
 if (![input.root, input.executablePath, input.home, ...(input.project ? [input.project] : [])].every(isAbsolute))
  throw new Error("full-test release, executable, HOME, and project paths must be absolute");
 const before = { release: snapshot(input.root, true), home: snapshot(input.home, false), project: snapshot(input.project, false) };
 const fast = await runFastTest(input);
 const defaults = Object.fromEntries(STAGES.map(name => [name, { status: "NOT_RUN", producer_rc: null }])) as Record<FullStageName, FullStage>;
 const empty = { producer_rc: null, stdout: "", stderr: "" };
 if (fast.status !== "PASS") {
  const after = { release: snapshot(input.root, true), home: snapshot(input.home, false), project: snapshot(input.project, false) };
  const snapshots = { release: { unchanged: before.release.digest === after.release.digest, complete: before.release.complete && after.release.complete },
   home: { unchanged: before.home.digest === after.home.digest, complete: before.home.complete && after.home.complete },
   project: { unchanged: before.project.digest === after.project.digest, complete: before.project.complete && after.project.complete } };
  const failures = [...fast.failures];
  if (!snapshots.release.unchanged || !snapshots.home.unchanged || !snapshots.project.unchanged) failures.push("Release, HOME, or project snapshot changed during failed fast stage");
  const status = failures.length > fast.failures.length ? "FAIL" : fast.status;
  return { status, exitCode: status === "FAIL" ? 1 : 3, fast, omp_version: null,
   stages: defaults, proofs: { G4_live: { status: "NOT_RUN", expected_scenarios: 0, observed_scenarios: 0, plant: "NOT_RUN" } },
   live_scenarios: { expected_ids: [], observed_ids: [], status: "NOT_RUN" }, snapshots,
   producer: empty, failures, proof_scope: "ISOLATED_FIXTURE_ONLY" };
 }
 const parsed: unknown = JSON.parse(readFileSync(join(input.root, "tests/live/scenarios.json"), "utf8"));
 if (!Array.isArray(parsed) || !parsed.length || !parsed.every(row =>
  row && typeof row === "object" && typeof row.id === "string" && (row.plant === undefined || typeof row.plant === "boolean")))
  throw new Error("INVALID_LIVE_SCENARIOS");
 const ids: string[] = parsed.filter(row => row.plant !== true).map(row => row.id);
 const identity = resolveOmpIdentity(process.env);
 const ompPackage: unknown = JSON.parse(readFileSync(join(identity.packageRoot, "package.json"), "utf8"));
 const ompVersion = ompPackage && typeof ompPackage === "object" && "version" in ompPackage && typeof ompPackage.version === "string"
  ? ompPackage.version : null;
 // The same pre-fast snapshot also detects writes during the matcher stage.
 let result: BundledRunResult;
 try { result = await runIsolatedShell("scripts/ladder.sh", [], input.root, input.executablePath); }
 catch (error) { result = { code: 3, stdout: "", stderr: error instanceof Error ? error.message : String(error) }; }
 const after = { release: snapshot(input.root, true), home: snapshot(input.home, false), project: snapshot(input.project, false) };
 const snapshots = { release: { unchanged: before.release.digest === after.release.digest, complete: before.release.complete && after.release.complete },
  home: { unchanged: before.home.digest === after.home.digest, complete: before.home.complete && after.home.complete },
  project: { unchanged: before.project.digest === after.project.digest, complete: before.project.complete && after.project.complete } };
 const classified = classifyLadder(result, ids);
 const failures = [...classified.failures];
 if (!snapshots.release.unchanged || !snapshots.home.unchanged || !snapshots.project.unchanged) failures.push("Release, HOME, or project snapshot changed during isolated test");
 const incomplete = Object.values(snapshots).some(part => !part.complete);
 if (incomplete) failures.push("Release, HOME, or project snapshot was incomplete");
 const passed = result.code === 0 && !failures.length && classified.live_scenarios.status === "PASS" && classified.stages["e2e-plant"].status === "PASS";
 const redact = (text: string) => {
  let value = text;
  for (const path of [input.root, input.home, input.project, identity.packageRoot, identity.launcher])
   if (path) value = value.split(path).join("<private-path>");
  return value.replace(/(?:\/private)?\/tmp\/omp-kit-(?:work|runtime)-[^\s'"<>]*|\/var\/folders\/[^/\s]+\/[^/\s]+\/T\/omp-kit-(?:work|runtime)-[^\s'"<>]*/g, "<private-runtime-temp>");
 };
 const plant = classified.stages["e2e-plant"].status === "NOT_RUN" ? "NOT_RUN"
  : classified.stages["e2e-plant"].status === "PASS" && !failures.includes("Planted negative control was not named RED") ? "PASS" : "FAIL";
 const blocked = result.code === 3 || (incomplete && failures.length === 1 && result.code === 0);
 return { status: passed ? "PASS" : blocked ? "BLOCKED" : "FAIL", exitCode: passed ? 0 : blocked ? 3 : 1,
  fast, omp_version: ompVersion, stages: classified.stages, live_scenarios: classified.live_scenarios,
  proofs: { G4_live: { status: classified.live_scenarios.status === "NOT_RUN" ? "NOT_RUN" : classified.live_scenarios.status === "PASS" && plant === "PASS" ? "PASS" : "FAIL",
   expected_scenarios: ids.length, observed_scenarios: classified.live_scenarios.observed_ids.length, plant } },
  snapshots, producer: { producer_rc: result.code, stdout: redact(result.stdout), stderr: redact(result.stderr) },
  failures: failures.map(redact), proof_scope: "ISOLATED_FIXTURE_ONLY" };
}
