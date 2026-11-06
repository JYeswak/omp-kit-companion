#!/bin/sh
# RELFAST2 (ompkit-fp72.5): bound macOS demand across the release/called-CI DAG.
# Different needs-depths can overlap. Count the maximum weighted antichain,
# expanding actual matrices and honoring each matrix's max-parallel ceiling.
set -eu
HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$HERE/../.." && pwd)
# shellcheck source=scripts/kitlib-tmp.sh
. "$ROOT/scripts/kitlib-tmp.sh"
kitlib_tmp TMP ci-concurrency-test || exit 1
bun --no-env-file --config=/dev/null run - "$ROOT" "$TMP" <<'JS'
import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
const [root, tmp] = process.argv.slice(2);
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const release = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
// Execute the existing suite producer: do not silently assume one suite or copy its list.
const planner = ci.jobs["resolve-omp-versions"].steps.find(step => step.id === "suites");
const output = join(tmp, "suites.out");
const planned = Bun.spawnSync(["bash", "-eu", "-c", planner.run], {
  env: { ...process.env, SHARDED: "false", GITHUB_OUTPUT: output },
  stdout: "pipe", stderr: "pipe",
});
assert.equal(planned.exitCode, 0, Buffer.from(planned.stderr).toString());
const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map(line => {
  const equal = line.indexOf("=");
  assert.ok(equal > 0, `invalid planner output: ${line}`);
  return [line.slice(0, equal), line.slice(equal + 1)];
}));
const versions = JSON.parse(readFileSync(join(root, "scripts/omp-compat.json"), "utf8"));
outputs.matrix = JSON.stringify(["minimum", "certified"].map(track => ({ track, version: versions[track] })));
const parents = job => typeof job.needs === "string" ? [job.needs] : job.needs ?? [];
function evaluate(value, context) {
  if (typeof value !== "string") return value;
  let text = value.trim();
  if (text.startsWith("${{")) text = text.slice(3, -2).trim();
  // GitHub permits dashed job IDs after needs.; JS requires bracket notation.
  text = text.replace(/\bneeds\.([A-Za-z0-9_-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`);
  return Function(...Object.keys(context), `return (${text});`)(...Object.values(context));
}
function matrixRows(job, context) {
  const matrix = job.strategy?.matrix;
  if (!matrix) return [{}];
  let rows = [{}];
  for (const [key, raw] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    const values = Array.isArray(raw) ? raw : evaluate(raw, context);
    assert.ok(Array.isArray(values), `unsupported matrix axis: ${key}`);
    rows = rows.flatMap(row => values.map(value => ({ ...row, [key]: value })));
  }
  for (const excluded of matrix.exclude ?? [])
    rows = rows.filter(row => !Object.entries(excluded).every(([key, value]) => row[key] === value));
  // These workflows use standalone include rows, not partial matrix augmentation.
  if (matrix.include) {
    assert.equal(Object.keys(matrix).filter(key => key !== "include").length, 0,
      "mixed include matrices need explicit expansion support");
    rows = matrix.include;
  }
  return rows;
}
function ceiling(workflow, caller, scenario) {
  const inputs = { mode: scenario.mode, version: "1.2.3", reuse_fast_ci: scenario.reuse,
    defer_signed_consumers: caller.jobs["native-candidate"].with.defer_signed_consumers,
    certified_run_id: scenario.signing ? "123" : "", rehearsal: false };
  const identity = { artifact_run_id: scenario.signing ? "123" : "", developer_id: scenario.signing ? "true" : "false" };
  const needs = new Proxy({}, { get: (_, name) => ({ result: "success",
    outputs: name === "validate-tag" ? identity : outputs }) });
  const context = { inputs, needs, github: { event_name: "workflow_dispatch", event: { repository: { private: false } } },
    fromJSON: JSON.parse, always: () => true, cancelled: () => false, failure: () => false };
  const nodes = new Map();
  function add(name, job, dependencies, enabled = true) {
    const active = enabled && (job.if === undefined || Boolean(evaluate(job.if, context)));
    let weight = 0;
    if (active && job["runs-on"] && (job["runs-on"].includes("${{") || job["runs-on"].startsWith("macos-"))) {
      weight = matrixRows(job, context).filter(matrix => {
        const runner = job["runs-on"].includes("${{") ? evaluate(job["runs-on"], { ...context, matrix }) : job["runs-on"];
        assert.equal(typeof runner, "string", `unsupported runner in ${name}`);
        return runner.startsWith("macos-");
      }).length;
      const limit = job.strategy?.["max-parallel"];
      if (limit !== undefined) {
        const bound = evaluate(limit, context);
        assert.ok(Number.isInteger(bound) && bound > 0, `invalid max-parallel in ${name}`);
        weight = Math.min(weight, bound);
      }
    }
    nodes.set(name, { weight, dependencies });
  }
  const native = caller.jobs["native-candidate"];
  assert.equal(native.uses, "./.github/workflows/ci.yml");
  const nativeActive = Boolean(evaluate(native.if, context));
  for (const [name, job] of Object.entries(caller.jobs)) {
    if (job.uses) assert.equal(name, "native-candidate", "new reusable workflow needs expansion");
    add(`release:${name}`, job, parents(job).map(parent => `release:${parent}`));
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const dependencies = parents(job).map(parent => `ci:${parent}`);
    if (!dependencies.length) dependencies.push(...parents(native).map(parent => `release:${parent}`));
    add(`ci:${name}`, job, dependencies, nativeActive);
  }
  // A reusable workflow's completion is a barrier after every child, not one needs-depth.
  nodes.get("release:native-candidate").dependencies.push(...Object.keys(workflow.jobs).map(name => `ci:${name}`));
  const memo = new Map();
  function ancestors(name, stack = new Set()) {
    if (memo.has(name)) return memo.get(name);
    assert.ok(!stack.has(name), `cycle: ${name}`);
    const node = nodes.get(name);
    assert.ok(node, `unknown dependency: ${name}`);
    const result = new Set();
    const next = new Set([...stack, name]);
    for (const parent of node.dependencies) {
      result.add(parent);
      for (const ancestor of ancestors(parent, next)) result.add(ancestor);
    }
    memo.set(name, result);
    return result;
  }
  for (const name of nodes.keys()) ancestors(name);
  const mac = [...nodes].filter(([, node]) => node.weight > 0);
  // Exact subset search is tiny for this DAG; fail rather than explode on a future large graph.
  assert.ok(mac.length <= 20, "macOS DAG exceeds the bounded structure check");
  let best = { total: 0, jobs: [] };
  function visit(index, selected, total) {
    if (index === mac.length) {
      if (total > best.total) best = { total, jobs: selected };
      return;
    }
    visit(index + 1, selected, total);
    const [name, node] = mac[index];
    if (selected.every(other => !ancestors(name).has(other) && !ancestors(other).has(name)))
      visit(index + 1, [...selected, name], total + node.weight);
  }
  visit(0, [], 0);
  return best;
}
let pass = 0;
function check(name, run) { run(); console.log(`ok ${++pass} - ${name}`); }
const qualification = { mode: "ci-pipeline", reuse: true, signing: false };
check("release qualification fits five slots with and without reused fast CI", () => {
  for (const reuse of [true, false]) {
    const bound = ceiling(ci, release, { ...qualification, reuse });
    console.log(`MAX_MACOS_CONCURRENT=${bound.total} reuse_fast_ci=${reuse} jobs=${bound.jobs.join(",")}`);
    assert.ok(bound.total <= 5, `release oversubscribes macOS: ${bound.total}`);
  }
});
check("planted sixth job across needs-depths is rejected", () => {
  const mutant = structuredClone(ci);
  mutant.jobs["planted-sixth"] = { "runs-on": "macos-15", needs: "build-candidates" };
  const bound = ceiling(mutant, release, qualification);
  assert.ok(bound.total > 5, `sixth job escaped: ${bound.total}`);
  console.log(`PLANTED_SIXTH_REJECTED=${bound.total}`);
});
check("removing release matrix limits is rejected", () => {
  const mutant = structuredClone(ci);
  delete mutant.jobs["cli-contracts-suites"].strategy["max-parallel"];
  delete mutant.jobs.ladder.strategy["max-parallel"];
  const bound = ceiling(mutant, release, qualification);
  assert.ok(bound.total > 5, `unbounded matrices escaped: ${bound.total}`);
  console.log(`UNBOUNDED_REJECTED=${bound.total}`);
});
check("serial jobs do not inflate the concurrent ceiling", () => {
  const serial = { jobs: { first: { "runs-on": "macos-15", strategy: { matrix: { leg: [1, 2, 3] } } },
    second: { "runs-on": "macos-15", needs: "first", strategy: { matrix: { leg: [1, 2, 3] } } } } };
  assert.equal(ceiling(serial, release, qualification).total, 3);
});
check("signing and local-attest do not overlap qualification", () => {
  assert.ok(ceiling(ci, release, { ...qualification, signing: true }).total <= 5);
  assert.equal(ceiling(ci, release, { ...qualification, mode: "local-attest" }).total, 0);
});
console.log(`${pass} tests passed, 0 failed`);
JS
