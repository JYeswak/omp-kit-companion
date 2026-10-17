#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if REPO_ROOT="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null)"; then :; else REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"; fi
mkdir -p "${REPO_ROOT}/var/agent-tmp"
RUN_LABEL="lessons-supersede-$(date -u +%Y%m%dT%H%M%S)"
RUN_DIR="${REPO_ROOT}/var/agent-tmp/${RUN_LABEL}.$$"
mkdir "${RUN_DIR}"
printf 'pid=%s\nlabel=%s\nrepo=%s\ncreated=%s\n' "$$" "${RUN_LABEL}" "${REPO_ROOT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"${RUN_DIR}/.owner"
export TMPDIR="${RUN_DIR}" SUPERSESSION_REPO_ROOT="${REPO_ROOT}" SUPERSESSION_RUN_DIR="${RUN_DIR}" SUPERSESSION_HARNESS="${SCRIPT_DIR}/lessons-supersede.e2e.sh"
# Owned scratch is retained for the fleet reaper, never deleted by a test trap.
report_artifacts() {
  local exit_code=$?
  printf 'supersession artifacts: %s\n' "${RUN_DIR}" >&2
  exit "${exit_code}"
}
trap report_artifacts EXIT
bun --no-env-file --config=/dev/null /dev/stdin "$@" <<'JS'
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const root = process.env.SUPERSESSION_REPO_ROOT;
const run = process.env.SUPERSESSION_RUN_DIR;
const started = new Date();
const phases = [];
let passed = 0, failed = 0, exitCode = 0;
let filter = null, verbose = false, slowThreshold = null, artifacts = join(run, "captures"), mutants = false;
const hash = text => createHash("sha256").update(text).digest("hex");
// Encode fixture references, not disposition expectations. This string/null tuple is the documented v1 record-id protocol.
const id = row => {
  const fields = ["omp-kit.lesson/v1", row.ts, row.repo, row.agent, row.pane, row.model, row.kind, row.class, row.what, row.evidence, row.applies_to ?? null, row.proposed_fix, row.bead];
  if (row.kind === "CORRECTION") fields.push(row.corrects ?? null);
  return "lesson_" + hash(JSON.stringify(fields));
};
const lesson = (repo, what, extra = {}) => ({ ts: "2026-10-05T12:00:00.000Z", repo, agent: "FixtureKeeper", pane: null, model: null, kind: "LESSON", class: "STALE_TEXT", what, evidence: "isolated supersession fixture", cost_minutes: null, applies_to: "fleet", proposed_fix: null, bead: null, ...extra });
const prefix = process.env.OMP_KIT_CLI ? [process.execPath, "--no-env-file", "--config=/dev/null", resolve(process.env.OMP_KIT_CLI)] : [process.env.OMP_KIT_BINARY || "omp-kit"];
function command(argv) {
  return spawnSync(argv[0], argv.slice(1), { cwd: root, env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
}
function check(condition, message, errors) {
  if (condition) passed++; else { failed++; errors.push(message); }
}
function phase(name, act) {
  const begin = Date.now();
  if (exitCode || (filter && !name.includes(filter))) {
    phases.push({ name, status: "skip", duration_ms: 0, skipped_reason: exitCode ? "prior_phase_failed" : "filter_mismatch" });
    return;
  }
  if (verbose) console.error("supersession: " + name);
  const errors = [];
  try { act(errors); } catch (error) { check(false, String(error), errors); }
  const duration = Date.now() - begin;
  phases.push({ name, status: errors.length ? "fail" : "pass", duration_ms: duration, skipped_reason: null, slow: slowThreshold !== null && duration > slowThreshold });
  if (errors.length) exitCode = 1;
}
try {
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === "--verbose") verbose = true;
    else if (flag === "--mutants") mutants = true;
    else if (flag === "--help" || flag === "-h") {
      console.log("lessons-supersede.e2e.sh [--verbose] [--filter SUBSTRING] [--artifacts-dir RELATIVE_DIR] [--slow-threshold-ms N] [--mutants]\nOMP_KIT_BINARY selects a real CLI binary; OMP_KIT_CLI selects its source entrypoint. --mutants needs load-admitted heavy execution. Artifacts remain in owned repo scratch.");
      process.exit(0);
    } else if (["--filter", "--artifacts-dir", "--slow-threshold-ms"].includes(flag)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error("missing value for " + flag);
      if (flag === "--filter") filter = value;
      else if (flag === "--artifacts-dir") {
        artifacts = resolve(run, value);
        const local = relative(run, artifacts);
        if (local === ".." || local.startsWith(".." + sep) || isAbsolute(local)) throw new Error("artifacts must stay under this run's owned scratch");
      } else {
        slowThreshold = Number(value);
        if (!Number.isSafeInteger(slowThreshold) || slowThreshold < 0) throw new Error("slow threshold must be a nonnegative integer");
      }
    } else throw new Error("unknown flag: " + flag);
  }
  mkdirSync(artifacts, { recursive: true });
  const a = lesson("one", "A: current replacement");
  const b = lesson("one", "B: retired advice", { superseded_by: id(a) });
  const c = lesson("one", "C: unrelated useful advice");
  const cycleA = lesson("unresolved", "Cycle A"), cycleB = lesson("unresolved", "Cycle B");
  cycleA.superseded_by = id(cycleB); cycleB.superseded_by = id(cycleA);
  const noScope = lesson("unresolved", "Missing scope"); delete noScope.applies_to;
  const old = lesson("correction", "Original immutable advice"), replacement = lesson("correction", "Current corrected advice");
  const fixtures = [
    { name: "healthy", repos: [[a, b, c], [lesson("two", a.what), lesson("two", c.what)]], expected: { [a.what]: "active", [b.what]: "history", [c.what]: "active" }, counts: [5, 4, 1, 0], groups: [a.what, c.what], intake: [a.what, c.what], preserved: b },
    { name: "unresolved", repos: [[cycleA, cycleB, noScope, lesson("unresolved", "Dangling id", { superseded_by: "lesson_absent" }), lesson("unresolved", "Missing doc", { superseded_by: "absent.md#policy" }), lesson("unresolved", "Healthy unrelated advice")]], expected: { "Cycle A": "unresolved", "Cycle B": "unresolved", "Missing scope": "unresolved", "Dangling id": "unresolved", "Missing doc": "unresolved", "Healthy unrelated advice": "active" }, counts: [6, 1, 0, 5], groups: ["Healthy unrelated advice"], intake: [] },
    { name: "document", repos: [[lesson("document", "Retired by document", { superseded_by: "replacement.md:999" }), lesson("document", "Unrelated active document advice")]], expected: { "Retired by document": "history", "Unrelated active document advice": "active" }, counts: [2, 1, 1, 0], groups: ["Unrelated active document advice"], intake: [], document: true },
    { name: "correction", repos: [[old, replacement]], expected: { [old.what]: "history", [replacement.what]: "active", "Retire original through the public append path": "history" }, counts: [3, 1, 2, 0], groups: [replacement.what], intake: [], correction: { corrects: id(old), replacement: id(replacement) }, preserved: old },
  ];
  for (const fixture of fixtures) phase(fixture.name, errors => {
    const paths = fixture.repos.map((entries, index) => {
      const path = join(run, fixture.name, "repo-" + index); mkdirSync(join(path, ".omp"), { recursive: true });
      writeFileSync(join(path, ".omp/lessons.jsonl"), entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
      if (fixture.document) writeFileSync(join(path, "replacement.md"), "# A different heading; line 999 is not certified.\n");
      return path;
    });
    const original = paths.map(path => readFileSync(join(path, ".omp/lessons.jsonl"), "utf8"));
    const fixtureHash = hash(JSON.stringify(original));
    let appendArgv = null;
    if (fixture.correction) {
      appendArgv = [...prefix, "lessons", "add", "--project", paths[0], "--kind", "CORRECTION", "--class", "STALE_TEXT", "--what", "Retire original through the public append path", "--evidence", "isolated append-only correction", "--applies-to", "fleet", "--corrects", fixture.correction.corrects, "--superseded-by", fixture.correction.replacement, "--json"];
      const append = command(appendArgv);
      writeFileSync(join(artifacts, fixture.name + ".append.stdout"), append.stdout ?? "");
      writeFileSync(join(artifacts, fixture.name + ".append.stderr"), append.stderr ?? "");
      check(append.status === 0, "public correction append exit=" + append.status, errors);
      check(readFileSync(join(paths[0], ".omp/lessons.jsonl"), "utf8").startsWith(original[0]), "correction rewrote prior bytes", errors);
    }
    const argv = [...prefix, "fleet-lessons", ...paths.flatMap(path => ["--project", path]), "--json"];
    const result = command(argv);
    writeFileSync(join(artifacts, fixture.name + ".stdout"), result.stdout ?? ""); writeFileSync(join(artifacts, fixture.name + ".stderr"), result.stderr ?? "");
    let report = null;
    try { report = JSON.parse(result.stdout).data.report; } catch { /* The nonzero command and absent report are explicit failures below. */ }
    check(result.status === 0, "public report exit=" + result.status, errors);
    check(report !== null && typeof report === "object", "public report missing", errors);
    const observed = {};
    if (report) {
      for (const repo of report.repos) for (const disposition of ["active", "history", "unresolved"]) for (const row of repo[disposition]) (observed[row.entry.what] ??= []).push(disposition);
      for (const [what, expected] of Object.entries(fixture.expected)) check(JSON.stringify([...new Set(observed[what] ?? [])]) === JSON.stringify([expected]), what + ": expected " + expected + ", observed " + JSON.stringify(observed[what] ?? []), errors);
      const counts = [report.entries_total, report.repos.reduce((sum, repo) => sum + repo.active.length, 0), report.history_count, report.unresolved.length];
      check(JSON.stringify(counts) === JSON.stringify(fixture.counts), "counts expected=" + JSON.stringify(fixture.counts) + " observed=" + JSON.stringify(counts), errors);
      check(JSON.stringify(report.rule_groups.map(group => group.what).sort()) === JSON.stringify([...fixture.groups].sort()), "current advice groups differ", errors);
      check(JSON.stringify(report.intake_plan.map(item => item.what).sort()) === JSON.stringify([...fixture.intake].sort()), "current intake differs", errors);
      if (fixture.preserved) check(report.repos.some(repo => repo.history.some(row => isDeepStrictEqual(row.entry, fixture.preserved))), "original full history row missing or changed", errors);
      if (fixture.document) check(report.repos.some(repo => repo.anchor_notes.some(note => note.verification === "FILE_EXISTS_ONLY")), "document existence overstated as anchor content verification", errors);
    }
    console.log(JSON.stringify({ fixture_id: fixture.name, fixture_sha256: fixtureHash, argv, append_argv: appendArgv, exit_code: result.status, expected: fixture.expected, observed, errors, passed, failed }));
  });
  if (!phases.some(item => item.status !== "skip")) { failed++; exitCode = 2; }
  if (mutants && !exitCode) {
    const entrypoint = join(root, "src/cli.ts"), modulePath = join(root, "src/lessons.ts");
    const source = readFileSync(modulePath, "utf8");
    const boundary = "\treturn result;\n}\n\nfunction lessonEntry";
    const variants = [
      ["compiled_control", null, null],
      ["all_active", "{ ...result, active: entries.filter(entry => entry.kind !== 'CHECKIN').map(entry => ({ id: lessonRecordId(entry), entry })), history: [], unresolved: [] }", "healthy"],
      ["unresolved_active", "{ ...result, active: [...result.active, ...result.unresolved.map(({ id, entry }) => ({ id, entry }))] }", "unresolved"],
      ["history_dropped", "{ ...result, history: [] }", "healthy"],
    ];
    for (const [name, expression, selected] of variants) {
      if (exitCode) break;
      const begin = Date.now(), errors = [], binary = join(run, "omp-kit-" + name);
      const changed = expression === null ? source : source.replace(boundary, "\treturn " + expression + ";\n}\n\nfunction lessonEntry");
      if (expression !== null && changed === source) throw new Error("mutation boundary unavailable: " + name);
      const build = await Bun.build({ entrypoints: [entrypoint], target: "bun", compile: { outfile: binary }, plugins: [{ name: "currency-" + name, setup(builder) {
        builder.onLoad({ filter: /lessons[.]ts$/ }, args => resolve(args.path) === modulePath ? { contents: changed, loader: "ts" } : undefined);
      } }] });
      if (!build.success) throw new Error("mutant build failed: " + name + " " + build.logs.join("\n"));
      const argv = ["bash", process.env.SUPERSESSION_HARNESS, ...(selected ? ["--filter", selected] : [])];
      const child = spawnSync(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, OMP_KIT_CLI: "", OMP_KIT_BINARY: binary, OMP_KIT_CASE_CWD: process.env.OMP_KIT_CASE_CWD || root }, encoding: "utf8", timeout: 120000, maxBuffer: 5 * 1024 * 1024 });
      writeFileSync(join(artifacts, name + ".stdout"), child.stdout ?? ""); writeFileSync(join(artifacts, name + ".stderr"), child.stderr ?? "");
      const records = (child.stdout ?? "").trim().split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const semanticFailure = records.some(row => row.fixture_id === selected && row.exit_code === 0 && row.errors.length > 0);
      check(expression === null ? child.status === 0 : child.status === 1 && semanticFailure, expression === null ? "compiled positive control failed" : "mutant survived or failed before reaching the semantic oracle", errors);
      const duration = Date.now() - begin;
      phases.push({ name, status: errors.length ? "fail" : "pass", duration_ms: duration, skipped_reason: null, slow: slowThreshold !== null && duration > slowThreshold });
      if (errors.length) exitCode = 1;
      console.log(JSON.stringify({ mutant: name, source_sha256: hash(source), mutated_source_sha256: hash(changed), argv, exit_code: child.status, semantic_failure: semanticFailure, errors, passed, failed }));
    }
  }
} catch (error) { console.error(String(error)); failed++; exitCode = 2; }
const summary = { schema_version: "e2e_harness_summary.v1", harness: "lessons-supersede.e2e.sh", started_at: started.toISOString(), finished_at: new Date().toISOString(), duration_ms: Date.now() - started.getTime(), exit_code: exitCode, phases_total: phases.length, phases_passed: phases.filter(item => item.status === "pass").length, phases_failed: phases.filter(item => item.status === "fail").length, phases_skipped: phases.filter(item => item.status === "skip").length, filter, artifacts_dir: artifacts, slow_threshold_ms: slowThreshold, phases, slow_steps: phases.filter(item => item.slow).map(({ name, duration_ms }) => ({ name, duration_ms })), assertions_passed: passed, assertions_failed: failed };
console.log(JSON.stringify(summary));
process.exitCode = exitCode;
JS
