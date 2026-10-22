#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCaseCorpus } from "../src/case-corpus.ts";
import { referenceAdmission, referenceBypassEnvironment, referencePlutilInPlace } from "./admission-reference.ts";
const repo = join(import.meta.dir, "..");
const caseFile = process.argv[2] ?? join(repo, "cases", "cases.tsv");
const { cases: rows, errors: caseErrors } = parseCaseCorpus(readFileSync(caseFile, "utf8"));
if (caseErrors.length > 0) {
	console.log(JSON.stringify({ schema_version: 1, rows: rows.length, case_errors: caseErrors, status: "FAIL" }));
	process.exit(1);
}

// Tool admissions are not TTSR oracles. Each independent reference consumes declared fixture inputs, while the
// kit lane evaluates the production admission (Git-backed scratch admission; fleet-guard BYPASSENV1, PLUTILINPLACE1).
const admissionReferences: Record<string, typeof referenceAdmission> = {
	"scratch-is-not-a-home": referenceAdmission,
	"fleet-guard-bypass-env": referenceBypassEnvironment,
	"fleet-guard-plutil-in-place": referencePlutilInPlace,
};
const ttsrRows = rows.filter(row => !Object.hasOwn(admissionReferences, row.rule));
const worker = Bun.spawn([process.execPath, join(repo, "scripts", "native-ttsr-worker.ts")], {
	cwd: repo, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
const nativeOutput = new Response(worker.stdout).text();
const nativeStderr = new Response(worker.stderr).text();
for (const row of ttsrRows) worker.stdin.write(JSON.stringify({ rulePath: join(repo, "rules", `${row.rule}.md`), ...row }) + "\n");
await worker.stdin.end();
const [output, stderr, nativeExit] = await Promise.all([nativeOutput, nativeStderr, worker.exited]);
if (stderr) process.stderr.write(stderr);
const native = output.trim().split("\n").filter(Boolean).map((line): { fired?: boolean; error?: string } => {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) return { error: "NATIVE_ORACLE_OUTPUT_INVALID" };
		if ("error" in parsed) return { error: "NATIVE_ORACLE_REQUEST_FAILED" };
		if ("fired" in parsed && typeof parsed.fired === "boolean") return { fired: parsed.fired };
	} catch {
		return { error: "NATIVE_ORACLE_OUTPUT_INVALID" };
	}
	return { error: "NATIVE_ORACLE_OUTPUT_INVALID" };
});
const kitProc = Bun.spawnSync([process.execPath, join(repo, "scripts", "ttsr-harness.ts"), "--gate-json", "--rules", join(repo, "rules"), "--cases", caseFile], {
	cwd: repo, stdout: "pipe", stderr: "pipe",
});
if (kitProc.stderr.length > 0) process.stderr.write(kitProc.stderr);
type KitCase = { rule: string; line: number; g2: "fire" | "quiet" };
let kitCases: KitCase[] = [];
const processErrors: string[] = [];
try {
	const parsed: unknown = JSON.parse(kitProc.stdout.toString());
	if (typeof parsed !== "object" || parsed === null || !("cases" in parsed) || !Array.isArray(parsed.cases)) {
		processErrors.push("KIT_ORACLE_CASES_INVALID");
	} else {
		kitCases = parsed.cases;
	}
} catch {
	processErrors.push("KIT_ORACLE_OUTPUT_INVALID");
}
if (nativeExit !== 0) processErrors.push("NATIVE_ORACLE_EXIT");
if (native.length !== ttsrRows.length) processErrors.push("NATIVE_ORACLE_CASE_COUNT");
if (kitCases.length !== rows.length) processErrors.push("KIT_ORACLE_CASE_COUNT");

type Mismatch = {
	index: number; line: number; rule: string; source: string; tool: string; path: string; snippet: string;
	expected: "fire" | "quiet"; oracle: "NATIVE_TTSR" | "ADMISSION_CONTRACT";
	reference: "fire" | "quiet" | "UNAVAILABLE"; kit: "fire" | "quiet" | "UNAVAILABLE";
};
const allMismatches: Mismatch[] = [];
let nativeIndex = 0;
let admissionChecked = 0;
let referenceErrors = 0;
for (const [index, row] of rows.entries()) {
	const admission = Object.hasOwn(admissionReferences, row.rule);
	let fired: boolean | undefined;
	if (admission) {
		admissionChecked += 1;
		try {
			fired = admissionReferences[row.rule]!(row);
		} catch {
			referenceErrors += 1;
		}
	} else {
		const result = native[nativeIndex++];
		if (result && !result.error && typeof result.fired === "boolean") fired = result.fired;
	}
	const reference = fired === undefined ? "UNAVAILABLE" : fired ? "fire" : "quiet";
	const observed = kitCases[index];
	const kit = observed?.rule === row.rule && observed.line === row.line && (observed.g2 === "fire" || observed.g2 === "quiet")
		? observed.g2 : "UNAVAILABLE";
	if (reference !== row.expect || kit !== reference) {
		allMismatches.push({
			index, line: row.line, rule: row.rule, source: row.source, tool: row.tool, path: row.path, snippet: row.snippet,
			expected: row.expect, oracle: admission ? "ADMISSION_CONTRACT" : "NATIVE_TTSR", reference, kit,
		});
	}
}
// Named exceptions only for open, tracked live-vs-kit gaps; PI3 was fixed live in e1fe957.
const known = new Map<number, { bead: string; reason: string }>();
const knownMismatches = allMismatches.flatMap(mismatch => known.has(mismatch.index) ? [{ ...mismatch, ...known.get(mismatch.index)! }] : []);
const unexpectedMismatches = allMismatches.filter(mismatch => !known.has(mismatch.index));
const workerErrors = native.filter(row => row.error || typeof row.fired !== "boolean").length;
const kitExit = kitProc.exitCode ?? 1;
const pass = workerErrors === 0 && referenceErrors === 0 && processErrors.length === 0 && kitExit === 0 && unexpectedMismatches.length === 0;
console.log(JSON.stringify({
	schema_version: 1, rows: rows.length, native_checked: native.length, admission_reference_checked: admissionChecked,
	checked: rows.length, worker_errors: workerErrors, reference_errors: referenceErrors, process_errors: processErrors,
	native_exit: nativeExit, kit_exit: kitExit, known_mismatches: knownMismatches, unexpected_mismatches: unexpectedMismatches,
	status: pass ? "PASS" : "FAIL",
}));
process.exit(pass ? 0 : 1);
