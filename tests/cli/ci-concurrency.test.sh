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
const { runFixture } = await import(join(process.argv[2], "tests/cli/fixture-process.ts"));
const [root, tmp] = process.argv.slice(2);
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
const release = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
// Execute the existing suite producer: do not silently assume one suite or copy its list.
const planner = ci.jobs["resolve-omp-versions"].steps.find(step => step.id === "suites");
const output = join(tmp, "suites.out");
const planned = Bun.spawnSync(["bash", "-eu", "-c", planner.run], {
  env: { ...process.env, SHARDED: "false", SHARD_UBUNTU: "false", GITHUB_OUTPUT: output },
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
  // exclude and include may be expressions over the planner's outputs; GitHub's order is axes, exclude, include.
  const excludes = typeof matrix.exclude === "string" ? evaluate(matrix.exclude, context) : matrix.exclude ?? [];
  const includes = typeof matrix.include === "string" ? evaluate(matrix.include, context) : matrix.include ?? [];
  assert.ok(Array.isArray(excludes) && Array.isArray(includes), `unsupported exclude/include in matrix`);
  for (const excluded of excludes)
    rows = rows.filter(row => !Object.entries(excluded).every(([key, value]) => row[key] === value));
  const axes = Object.keys(matrix).filter(key => key !== "include" && key !== "exclude");
  if (axes.length === 0) return includes;
  // An include row augments every original combination it does not contradict on an original axis, and
  // only when no original axis value would be overwritten; a row that contradicts all of them is a new leg.
  const original = rows;
  for (const extra of includes) {
    const fits = original.filter(row => axes.every(axis => !(axis in extra) || row[axis] === extra[axis]));
    if (fits.length > 0) for (const row of fits) Object.assign(row, extra);
    else rows = [...rows, { ...extra }];
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
// CORESHARD1: the unsharded Ubuntu core leg outgrew its 40 min cap (every scheduled run 2026-11-08..11-20 was
// cancelled there), so scheduled and certification runs shard Ubuntu core only. Run the real planner for that
// event and expand the real matrix: macOS keeps its single core leg and gains no shard leg.
function plannedOutputs(env) {
  const out = join(tmp, `suites-${Object.values(env).join("-")}.out`);
  const run = Bun.spawnSync(["bash", "-eu", "-c", planner.run], {
    env: { ...process.env, SHARDED: "false", SHARD_UBUNTU: "false", ...env, GITHUB_OUTPUT: out }, stdout: "pipe", stderr: "pipe" });
  assert.equal(run.exitCode, 0, Buffer.from(run.stderr).toString());
  return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}
function suiteLegs(planned, event, inputs = { version: "", reuse_fast_ci: false }) {
  const needs = new Proxy({}, { get: () => ({ result: "success", outputs: planned }) });
  const context = { inputs, needs, github: { event_name: event, event: { repository: { private: false } } },
    fromJSON: JSON.parse, always: () => true, cancelled: () => false, failure: () => false };
  const legs = {};
  for (const row of matrixRows(ci.jobs["cli-contracts-suites"], context)) (legs[row.os] ??= []).push(row.suite);
  for (const os of Object.keys(legs)) legs[os].sort();
  return legs;
}
check("scheduled runs shard Ubuntu core only and leave macOS demand unchanged", () => {
  const unchanged = suiteLegs(outputs, "schedule");
  const planned = plannedOutputs({ SHARD_UBUNTU: "true" });
  assert.equal(planned.core_shards, "4");
  const legs = suiteLegs(planned, "schedule");
  assert.deepEqual(legs["ubuntu-24.04"], ["core-1", "core-2", "core-3", "core-4", "kit-update", "package-release"]);
  assert.deepEqual(legs["macos-15"], ["core", "kit-update", "package-release"]);
  assert.deepEqual(legs["macos-15"], unchanged["macos-15"]);
  console.log(`SCHEDULED_LEGS ubuntu=${legs["ubuntu-24.04"].length} macos=${legs["macos-15"].length}`);
});
check("push keeps its four Ubuntu shards and the unsharded planner keeps one core leg per OS", () => {
  const push = suiteLegs(plannedOutputs({ SHARDED: "true" }), "push");
  assert.deepEqual(push, { "ubuntu-24.04": ["core-1", "core-2", "core-3", "core-4", "kit-update", "package-release"] });
  assert.deepEqual(suiteLegs(outputs, "schedule"), {
    "ubuntu-24.04": ["core", "kit-update", "package-release"], "macos-15": ["core", "kit-update", "package-release"] });
});
check("planted: dropping the Ubuntu core exclusion or sharding macOS is rejected", () => {
  const planned = plannedOutputs({ SHARD_UBUNTU: "true" });
  const noExclude = suiteLegs({ ...planned, suite_excludes: "[]" }, "schedule");
  assert.ok(noExclude["ubuntu-24.04"].includes("core") && noExclude["ubuntu-24.04"].includes("core-1"),
    "an unexcluded Ubuntu core leg must remain visible next to its shards");
  const macShards = suiteLegs({ ...planned, suite_includes: JSON.stringify([1, 2, 3, 4].map(n => ({ os: "macos-15", suite: `core-${n}` }))) }, "schedule");
  assert.ok(macShards["macos-15"].length > 3, "macOS shard legs must raise the macOS leg count");
});
check("the real Git contracts run once per OS without adding load to the scheduled macOS core leg", () => {
  const step = ci.jobs["cli-contracts-suites"].steps.find(step => step.name === "Exercise real Git import and hook installer contracts");
  assert.ok(step?.run, "lost the real Git contract producer");
  const routes = (planned, event, inputs) => Object.fromEntries(
    Object.entries(suiteLegs(planned, event, inputs)).map(([os, suites]) => [
      os,
      suites.filter(suite => evaluate(step.if, {
        matrix: { os, suite },
        runner: { os: os.startsWith("macos-") ? "macOS" : "Linux" },
        needs: { "resolve-omp-versions": { outputs: planned } },
      })),
    ]),
  );
  assert.deepEqual(routes(plannedOutputs({ SHARDED: "true" }), "push"), { "ubuntu-24.04": ["kit-update"] });
  assert.deepEqual(routes(plannedOutputs({ SHARD_UBUNTU: "true" }), "schedule"),
    { "ubuntu-24.04": ["kit-update"], "macos-15": ["kit-update"] });
  assert.deepEqual(routes(outputs, "workflow_dispatch", { version: "1.2.3", reuse_fast_ci: false }),
    { "ubuntu-24.04": ["core"], "macos-15": ["kit-update"] });
  assert.deepEqual(routes(outputs, "workflow_dispatch", { version: "1.2.3", reuse_fast_ci: true }),
    { "macos-15": ["kit-update"] });
});

function assertHostedLadderPool(workflow) {
  const ladder = workflow.jobs.ladder;
  const step = ladder.steps.find(step => step.run?.trim() === "sh scripts/ladder.sh");
  assert.ok(step, "lost the full ladder producer");
  const raw = step.env?.OMP_KIT_E2E_JOBS ?? ladder.env?.OMP_KIT_E2E_JOBS ?? workflow.env?.OMP_KIT_E2E_JOBS;
  for (const event_name of ["push", "schedule"]) {
    const context = { inputs: { version: "", reuse_fast_ci: false }, github: { event_name },
      needs: { "resolve-omp-versions": { outputs } }, fromJSON: JSON.parse };
    const lanes = matrixRows(ladder, context);
    const expectedTracks = ["certified", "minimum"];
    assert.deepEqual(lanes.filter(row => row.os.startsWith("ubuntu-")).map(row => row.omp.track).sort(), expectedTracks);
    assert.deepEqual(lanes.filter(row => row.os.startsWith("macos-")).map(row => row.omp.track).sort(),
      event_name === "schedule" ? expectedTracks : []);
    for (const matrix of lanes) {
      const linux = matrix.os.startsWith("ubuntu-");
      const runner = { os: linux ? "Linux" : "macOS" };
      const width = typeof raw === "string" && raw.startsWith("${{")
        ? evaluate(raw, { ...context, matrix, runner }) : raw ?? "";
      assert.equal(String(width), linux ? "2" : "",
        `G4 pool width ${event_name}/${matrix.os}/${matrix.omp.track}`);
    }
  }
}
check("CILADDERPOOL1 both stock Ubuntu tracks use two G4 workers, macOS keeps the default", () => {
  assertHostedLadderPool(ci);
});
check("CILADDERPOOL1 planted missing or disabled pool override is rejected", () => {
  for (const disabled of [undefined, "1"]) {
    const mutant = structuredClone(ci);
    const step = mutant.jobs.ladder.steps.find(step => step.run?.trim() === "sh scripts/ladder.sh");
    if (disabled === undefined) delete step.env;
    else step.env.OMP_KIT_E2E_JOBS = disabled;
    assert.throws(() => assertHostedLadderPool(mutant), /G4 pool width push\/ubuntu-.*\/minimum/);
  }
});
check("signing and local-attest do not overlap qualification", () => {
  assert.ok(ceiling(ci, release, { ...qualification, signing: true }).total <= 5);
  assert.equal(ceiling(ci, release, { ...qualification, mode: "local-attest" }).total, 0);
});
const journey = ci.jobs["real-home-journey"];
const pair = journey.steps.find(step => step.id === "published-pair");
check("published pair retains authentication permissions and job-wide updater token", () => {
  assert.equal(journey.permissions.attestations, "read");
  assert.equal(journey.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(release.jobs["native-candidate"].permissions.attestations, "read");
  const certify = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/omp-certify.yml"), "utf8"));
  assert.equal(certify.jobs.suites.permissions.attestations, "read");
  assert.ok(!pair.run.includes("package-release.sh"));
});
const releaseRow = (tag_name, extra = {}) => ({ tag_name, draft: false, prerelease: false, ...extra });
const fixtureShell = `
gh() {
  printf '%s\\n' "$*" >> "$CALLS"
  if [ "$1" = api ]; then
    case "$2" in
      */releases/latest) printf '%s\\n' "$LATEST";;
      --paginate) printf '%s\\n' "$RELEASES";;
      */commits/*) printf '%s\\n' 0123456789012345678901234567890123456789;;
      *) return 91;;
    esac
  elif [ "$1" = attestation ]; then
    [ "$FAILURE" != provenance ] || return 92
    [[ "$*" == *"--cert-oidc-issuer https://token.actions.githubusercontent.com"* ]] || return 93
    [[ "$*" == *"--signer-workflow JYeswak/omp-kit-companion/.github/workflows/release.yml"* ]] || return 94
    [[ "$*" == *"--source-digest 0123456789012345678901234567890123456789"* ]] || return 95
    [[ "$*" == *"--predicate-type https://slsa.dev/provenance/v1"* ]] || return 96
  elif [ "$1" = release ]; then
    local pattern="" dir=""
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in --pattern) pattern=$2;; --dir) dir=$2;; esac
      shift
    done
    printf '{}\\n' > "$dir/$pattern"
  else return 97
  fi
}
python3() {
  printf '%s\\n' "$*" >> "$CALLS"
  if [ "$2" = inspect ]; then
    [ "$FAILURE" != platform ] || return 98
    printf 'omp-kit-%s-%s.tar.gz\\n' "$4" "$5"
  elif [ "$2" = bundle ]; then
    [ "$FAILURE" != bundle ] || return 99
    printf '{}\\n' > "$3.sigstore.json"
  else return 100
  fi
}
`;
function runPair(name, rows, failure = "", latest = releaseRow("v1.10.0")) {
  const base = join(tmp, name);
  const result = runFixture(["bash", "-eu", "-c", fixtureShell + pair.run], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: base, GITHUB_OUTPUT: `${base}.out`,
      CALLS: `${base}.calls`, TARGET: "linux-x64-gnu", FAILURE: failure,
      LATEST: JSON.stringify(latest), RELEASES: JSON.stringify([rows]) },
  });
  return { result, calls: readFileSync(`${base}.calls`, "utf8"), base };
}
check("latest candidate and greatest numeric stable predecessor exclude drafts and prereleases", () => {
  const { result, calls, base } = runPair("selection", [
    releaseRow("v1.9.0"), releaseRow("v1.2.0"), releaseRow("v1.11.0"),
    releaseRow("v1.10.0"), releaseRow("v1.9.9", { draft: true }),
    releaseRow("v1.9.8", { prerelease: true }), releaseRow("v1.9.7-rc.1"),
  ]);
  assert.equal(result.rc, 0, new TextDecoder().decode(result.stderr));
  assert.match(calls, /release download v1\.9\.0 /);
  assert.match(calls, /release download v1\.10\.0 /);
  assert.equal((calls.match(/attestation verify/g) ?? []).length, 2);
  assert.equal((calls.match(/installer\/install.py bundle/g) ?? []).length, 2);
  assert.match(readFileSync(`${base}.out`, "utf8"), /candidate_archive=omp-kit-1.10.0-linux-x64-gnu.tar.gz/);
});
for (const [name, rows, failure, latest] of [
  ["no-predecessor", [releaseRow("v1.10.0")], ""],
  ["missing-platform", [releaseRow("v1.9.0")], "platform"],
  ["missing-provenance", [releaseRow("v1.9.0")], "provenance"],
  ["missing-bundle", [releaseRow("v1.9.0")], "bundle"],
  ["draft-latest", [releaseRow("v1.9.0")], "", releaseRow("v1.10.0", { draft: true })],
  ["prerelease-latest", [releaseRow("v1.9.0")], "", releaseRow("v1.10.0", { prerelease: true })],
]) check(`${name} fails the input step before journey execution`, () => {
  const { result, calls } = runPair(name, rows, failure, latest);
  assert.notEqual(result.rc, 0);
  assert.ok(!calls.includes("real-home-journey.sh"));
  if (failure === "provenance") assert.ok(!calls.includes("installer/install.py inspect"));
});
console.log(`${pass} tests passed, 0 failed`);
JS
