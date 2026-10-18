import { appendFileSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LADDER_CASE_SCOPES = ["harness-gate", "harness-selftest", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"] as const;
export const LADDER_NONCASE_SCOPES = ["manifest", "flywheel-invariants", "regex-budget"] as const;
export interface TestCaseReporter {
 record(name: string, outcome: "PASS" | "FAIL" | "SKIP"): void;
 finish(): void;
}
export type TestCaseReportCapture = {
 expected_scopes: string[];
 reports: { scope: string; body: string }[];
 errors: string[];
};
export type NativeTestCaseCounts = {
 protocol: "OMP_KIT_CASES"; unit: "TEST_CASE_EXECUTION"; scope: "LADDER_DECLARED_CASE_PRODUCERS";
 pass: number; fail: number; skip: number; total: number;
};
export type TestCaseReportSummary = { counts: NativeTestCaseCounts | null; failing_names: string[] | null; error: string | null };

/** Source-owned outcomes, never stdout inference. The native runner supplies an owned per-stage file. */
export function createTestCaseReporter(): TestCaseReporter | null {
 const path = process.env.OMP_KIT_TEST_CASE_REPORT;
 const scope = process.env.OMP_KIT_TEST_CASE_SCOPE;
 if (path === undefined && scope === undefined) return null;
 if (!path || !isAbsolute(path) || !scope || !LADDER_CASE_SCOPES.some(candidate => candidate === scope))
  throw new Error("INVALID_TEST_CASE_REPORT_REQUEST");
 writeFileSync(path, JSON.stringify({ schema_version: 1, scope, event: "begin" }) + "\n", { flag: "wx", mode: 0o600 });
 let count = 0, finished = false;
 return {
  record(name, outcome) {
   if (finished || !name || (outcome !== "PASS" && outcome !== "FAIL" && outcome !== "SKIP")) throw new Error("INVALID_TEST_CASE_OUTCOME");
   appendFileSync(path, JSON.stringify({ schema_version: 1, scope, event: "case", name, outcome }) + "\n");
   count++;
  },
  finish() {
   if (finished) throw new Error("TEST_CASE_REPORT_ALREADY_FINISHED");
   appendFileSync(path, JSON.stringify({ schema_version: 1, scope, event: "end", cases: count }) + "\n");
   finished = true;
  },
 };
}

/** Capture only owned regular files before private-runtime cleanup, including available incomplete reports. */
export function readTestCaseReports(directory: string, startedScopes: readonly string[]): TestCaseReportCapture {
 const expected_scopes: string[] = [], errors: string[] = [], reports: TestCaseReportCapture["reports"] = [];
 const seen = new Set<string>();
 for (const scope of startedScopes) {
  if (seen.has(scope)) { errors.push(`Duplicate stage scope: ${scope}`); continue; }
  seen.add(scope);
  if (LADDER_NONCASE_SCOPES.some(candidate => candidate === scope)) continue;
  if (!LADDER_CASE_SCOPES.some(candidate => candidate === scope)) { errors.push(`Unknown stage case domain: ${scope}`); continue; }
  expected_scopes.push(scope);
  try {
   const path = join(directory, `${scope}.jsonl`), info = lstatSync(path);
   if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("UNSAFE_OR_OVERSIZED_CASE_REPORT");
   reports.push({ scope, body: readFileSync(path, "utf8") });
  } catch { errors.push(`Missing or unreadable case report: ${scope}`); }
 }
 return { expected_scopes, reports, errors };
}

function caseReportRecord(value: unknown): value is Record<string, unknown> {
 return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Count actual emitted case executions. NOT_RUN scopes and measurement/gate verdicts are never test skips. */
export function summarizeTestCaseReports(capture: TestCaseReportCapture): TestCaseReportSummary {
 const invalid = (error: string): TestCaseReportSummary => ({ counts: null, failing_names: null, error });
 if (capture.errors.length || !capture.expected_scopes.length) return invalid(capture.errors.join("; ") || "No declared case producer executed");
 if (new Set(capture.expected_scopes).size !== capture.expected_scopes.length || capture.reports.length !== capture.expected_scopes.length)
  return invalid("Case producer scopes are incomplete or duplicated");
 let pass = 0, fail = 0, skip = 0;
 const failing_names: string[] = [];
 for (const scope of capture.expected_scopes) {
  if (!LADDER_CASE_SCOPES.some(candidate => candidate === scope)) return invalid("Unsupported case producer scope");
  let report: { scope: string; body: string } | undefined;
  for (const candidate of capture.reports) if (candidate.scope === scope) {
   if (report) return invalid(`Duplicate case producer: ${scope}`);
   report = candidate;
  }
  if (!report) return invalid(`Missing case producer: ${scope}`);
  const body = report.body;
  if (!body.endsWith("\n")) return invalid(`Unterminated case capture: ${scope}`);
  const lines = body.split("\n"); lines.pop();
  if (lines.length < 2) return invalid(`Missing case report boundaries: ${scope}`);
  const names = new Set<string>();
  for (const [index, line] of lines.entries()) {
   let row: unknown;
   try {
    row = JSON.parse(line);
    // Compact round-trip equality rejects duplicate keys and lossy numbers.
    if (JSON.stringify(row) !== line) return invalid(`Noncanonical case record: ${scope}`);
   } catch { return invalid(`Malformed case record: ${scope}`); }
   if (!caseReportRecord(row) || row.schema_version !== 1 || row.scope !== scope)
    return invalid(`Invalid case record identity: ${scope}`);
   const keys = Object.keys(row).sort().join(",");
   if (index === 0) {
    if (keys !== "event,schema_version,scope" || row.event !== "begin") return invalid(`Missing case begin: ${scope}`);
   } else if (index === lines.length - 1) {
    if (keys !== "cases,event,schema_version,scope" || row.event !== "end" || !Number.isSafeInteger(row.cases) || row.cases !== names.size)
     return invalid(`Incomplete case producer: ${scope}`);
   } else {
    if (keys !== "event,name,outcome,schema_version,scope" || row.event !== "case" || typeof row.name !== "string" || !row.name || names.has(row.name))
     return invalid(`Missing or duplicate case identity: ${scope}`);
    names.add(row.name);
    if (row.outcome === "PASS") pass++;
    else if (row.outcome === "FAIL") { fail++; failing_names.push(`${scope}: ${row.name}`); }
    else if (row.outcome === "SKIP") skip++;
    else return invalid(`Unknown case outcome: ${scope}`);
   }
  }
 }
 const total = pass + fail + skip;
 if (!Number.isSafeInteger(total)) return invalid("Case count exceeds safe integer domain");
 return { counts: { protocol: "OMP_KIT_CASES", unit: "TEST_CASE_EXECUTION", scope: "LADDER_DECLARED_CASE_PRODUCERS", pass, fail, skip, total }, failing_names, error: null };
}
