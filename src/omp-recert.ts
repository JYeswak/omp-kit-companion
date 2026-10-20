import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./type-guards.ts";

export const OMP_TEST_RECORD_SCHEMA = 1;
export const OMP_TEST_RECORD_FILE = "omp-test-record.json";
export type OmpTestScope = "fast" | "full";
export type OmpTestVerdict = "PASS" | "FAIL";
export interface OmpTestRecord { schema_version: 1; omp_version: string; scope: OmpTestScope; verdict: OmpTestVerdict; recorded_at: string; }
export type OmpDriftStatus = "OK" | "STALE-OMP" | "NOT_RUN";
export interface OmpDriftDecision { status: OmpDriftStatus; trigger_recert: boolean; live_omp_version: string | null; recorded_omp_version: string | null; reason: string; recommended_action: string; log_line: string; }
function parseRecord(value: unknown): OmpTestRecord | null {
 if (!isRecord(value)) return null;
 const { schema_version, omp_version, scope, verdict, recorded_at } = value;
 if (schema_version !== OMP_TEST_RECORD_SCHEMA || typeof omp_version !== "string" || !omp_version || (scope !== "fast" && scope !== "full") || (verdict !== "PASS" && verdict !== "FAIL") || typeof recorded_at !== "string" || !recorded_at) return null;
 return { schema_version: 1, omp_version, scope, verdict, recorded_at };
}
export function readOmpTestRecord(stateRoot: string): OmpTestRecord | null { try { return parseRecord(JSON.parse(readFileSync(join(stateRoot, OMP_TEST_RECORD_FILE), "utf8"))); } catch { return null; } }
export function writeOmpTestRecord(stateRoot: string, record: Omit<OmpTestRecord, "schema_version">): OmpTestRecord { const full = { schema_version: 1 as const, ...record }; mkdirSync(stateRoot, { recursive: true }); const target = join(stateRoot, OMP_TEST_RECORD_FILE); const staging = `${target}.staging-${process.pid}`; writeFileSync(staging, `${JSON.stringify(full, null, 2)}\n`, "utf8"); renameSync(staging, target); return full; }
export function checkOmpDrift(live: string | null, record: OmpTestRecord | null): OmpDriftDecision {
 if (!live) return { status: "NOT_RUN", trigger_recert: false, live_omp_version: null, recorded_omp_version: record?.omp_version ?? null, reason: "OMP is not resolvable, so drift since the last test cannot be checked", recommended_action: "Install OMP, then run omp-kit test --record.", log_line: "omp-recert: live OMP unresolvable; recert decision deferred (NOT_RUN)" };
 if (!record) return { status: "NOT_RUN", trigger_recert: true, live_omp_version: live, recorded_omp_version: null, reason: "No kit test has been recorded against this OMP yet", recommended_action: "Run omp-kit test --record (add --full for live scenarios).", log_line: `omp-recert: no recorded test for live OMP ${live}; recert triggered (NOT_RUN)` };
 if (record.verdict !== "PASS") return { status: "STALE-OMP", trigger_recert: true, live_omp_version: live, recorded_omp_version: record.omp_version, reason: `Last recorded kit test against OMP ${record.omp_version} did not pass (${record.verdict}); no current PASS exists`, recommended_action: "Run omp-kit test --record until it passes; the stale verdict is never presented as current.", log_line: `omp-recert: recorded verdict ${record.verdict} is not a PASS; recert triggered (STALE-OMP live=${live} recorded=${record.omp_version})` };
 if (record.omp_version === live) return { status: "OK", trigger_recert: false, live_omp_version: live, recorded_omp_version: record.omp_version, reason: `Last kit test passed against this OMP (${live}, ${record.scope})`, recommended_action: "No action required.", log_line: `omp-recert: OMP version unchanged (${live}); recert short-circuit, no re-test` };
 return { status: "STALE-OMP", trigger_recert: true, live_omp_version: live, recorded_omp_version: record.omp_version, reason: `OMP moved ${record.omp_version} -> ${live} since the last recorded kit test PASS; recorded evidence is stale`, recommended_action: "Run omp-kit test --record (fast scope minimum) and present STALE-OMP until it passes.", log_line: `omp-recert: OMP drift ${record.omp_version} -> ${live}; recert triggered (STALE-OMP)` };
}
