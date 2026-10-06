export interface FirstFireCase {
  rule: string;
  line: number;
  expect: "fire" | "quiet";
  g2: "fire" | "quiet";
  first_fire: number | null;
  wire_length: number;
}

export interface OmpCompatibilityRun {
  schema_version: 1;
  omp_version: string;
  default_policy_exit: number;
  default_policy_failures: string[];
  first_fires: FirstFireCase[];
}

interface CheckResult {
  status: "GREEN" | "RED";
  detail: string;
}

interface Evaluation {
  runs: OmpCompatibilityRun[];
  firstFires: CheckResult[];
  defaults: CheckResult[];
}

export interface CompatibilityRegression {
  version: string;
  checks: string[];
}

const stableVersion = /^\d+\.\d+\.\d+$/;

function validateRun(value: unknown, source: string): OmpCompatibilityRun {
  if (!value || typeof value !== "object") throw new Error(`${source}: report must be an object`);
  const run = value as Partial<OmpCompatibilityRun>;
  if (run.schema_version !== 1) throw new Error(`${source}: unsupported schema_version`);
  if (typeof run.omp_version !== "string" || !stableVersion.test(run.omp_version)) {
    throw new Error(`${source}: omp_version must be a stable x.y.z release`);
  }
  if (!Number.isInteger(run.default_policy_exit) || (run.default_policy_exit ?? -1) < 0) {
    throw new Error(`${source}: default_policy_exit must be a nonnegative integer`);
  }
  if (!Array.isArray(run.default_policy_failures) || run.default_policy_failures.some(failure => typeof failure !== "string")) {
    throw new Error(`${source}: default_policy_failures must be a string array`);
  }
  if (!Array.isArray(run.first_fires) || run.first_fires.length === 0) {
    throw new Error(`${source}: first_fires must be a nonempty array`);
  }
  const seen = new Set<string>();
  for (const entry of run.first_fires) {
    if (!entry || typeof entry.rule !== "string" || !Number.isInteger(entry.line) ||
        !["fire", "quiet"].includes(entry.expect) || !["fire", "quiet"].includes(entry.g2) ||
        !(entry.first_fire === null || Number.isInteger(entry.first_fire)) ||
        !Number.isInteger(entry.wire_length) || entry.wire_length < 0) {
      throw new Error(`${source}: malformed first-fire case`);
    }
    if (entry.first_fire !== null && (entry.first_fire < 1 || entry.first_fire > entry.wire_length)) {
      throw new Error(`${source}: first-fire index outside wire length for ${entry.rule}:${entry.line}`);
    }
    const key = `${entry.rule}:${entry.line}`;
    if (seen.has(key)) throw new Error(`${source}: duplicate first-fire case ${key}`);
    seen.add(key);
  }
  return run as OmpCompatibilityRun;
}

function caseMap(run: OmpCompatibilityRun): Map<string, FirstFireCase> {
  return new Map(run.first_fires.map(entry => [`${entry.rule}:${entry.line}`, entry]));
}

function firstFireResult(reference: OmpCompatibilityRun, candidate: OmpCompatibilityRun): CheckResult {
  const expected = caseMap(reference);
  const actual = caseMap(candidate);
  const differences: string[] = [];
  for (const key of [...new Set([...expected.keys(), ...actual.keys()])].sort()) {
    const before = expected.get(key);
    const after = actual.get(key);
    if (!before || !after) {
      differences.push(`${key} ${before ? "missing" : "added"}`);
      continue;
    }
    if (after.g2 !== after.expect) differences.push(`${key} expected ${after.expect} but G2 ${after.g2}`);
    if (after.expect === "fire" && after.first_fire === null) differences.push(`${key} expected fire but never fired`);
    if (after.expect === "quiet" && after.first_fire !== null) differences.push(`${key} expected quiet but fired at ${after.first_fire}`);
    if (before.first_fire !== after.first_fire || before.g2 !== after.g2 || before.expect !== after.expect) {
      differences.push(`${key} first_fire ${before.first_fire ?? "quiet"} -> ${after.first_fire ?? "quiet"}`);
    }
  }
  return differences.length === 0
    ? { status: "GREEN", detail: "matches earliest tested release" }
    : { status: "RED", detail: differences.join(", ") };
}

function defaultPolicyResult(reference: OmpCompatibilityRun, candidate: OmpCompatibilityRun): CheckResult {
  const sameFailures = JSON.stringify(reference.default_policy_failures) === JSON.stringify(candidate.default_policy_failures);
  if (reference.default_policy_exit === candidate.default_policy_exit && sameFailures) {
    return { status: "GREEN", detail: `matches baseline exit ${candidate.default_policy_exit}; ${candidate.default_policy_failures.length} failing scenario(s)` };
  }
  return {
    status: "RED",
    detail: `baseline exit ${reference.default_policy_exit} -> exit ${candidate.default_policy_exit}; scenario set changed`,
  };
}

function evaluate(values: unknown[]): Evaluation {
  if (values.length < 3) throw new Error("at least three stock OMP releases are required");
  const runs = values.map((value, i) => validateRun(value, `run ${i + 1}`));
  const versions = runs.map(run => run.omp_version);
  if (new Set(versions).size !== runs.length) throw new Error("OMP release versions must be distinct");
  if (versions.some((version, i) => i > 0 && compareVersions(versions[i - 1]!, version) >= 0)) {
    throw new Error("OMP releases must be in ascending semver order");
  }
  const reference = runs[0]!;
  return {
    runs,
    firstFires: runs.map(run => firstFireResult(reference, run)),
    defaults: runs.map(run => defaultPolicyResult(reference, run)),
  };
}

export function compatibilityRegressions(values: unknown[]): CompatibilityRegression[] {
  const result = evaluate(values);
  return result.runs.flatMap((run, index) => {
    const checks: string[] = [];
    if (result.firstFires[index]!.status === "RED") checks.push(`first-fire: ${result.firstFires[index]!.detail}`);
    if (result.defaults[index]!.status === "RED") checks.push(`default-policy: ${result.defaults[index]!.detail}`);
    return checks.length > 0 ? [{ version: run.omp_version, checks }] : [];
  });
}

export function renderCompatibilityTable(values: unknown[]): string {
  const { runs, firstFires, defaults } = evaluate(values);
  const versions = runs.map(run => run.omp_version);
  const headers = ["Check", ...versions].join(" | ");
  const separator = Array(versions.length + 1).fill("---").join(" | ");
  const row = (label: string, results: CheckResult[]) =>
    `| ${label} | ${results.map(result => `${result.status} — ${result.detail}`).join(" | ")} |`;
  const policyDetails = runs.map(run =>
    `- OMP ${run.omp_version} (exit ${run.default_policy_exit}): ${run.default_policy_failures.length > 0 ? run.default_policy_failures.join("; ") : "no failing scenarios"}`,
  );
  return [
    "<!-- generated by scripts/omp-compatibility.ts; do not hand-edit -->",
    "# OMP compatibility",
    "",
    "First-fire indexes and default-policy outcomes are compared with the earliest release in this run. Default-policy results are from `OMP_KIT_DEFAULT_TTSR=1 sh scripts/e2e-live.sh`; GREEN means the observed outcome matches the baseline, not that the policy passed. Any RED cell names the differing check.",
    "",
    `| ${headers} |`,
    `| ${separator} |`,
    row("First-fire differential", firstFires),
    row("Default-policy differential", defaults),
    "",
    "Default-policy scenarios:",
    ...policyDetails,
    "",
    "This matrix covers only the listed stock OMP releases and these checks; it does not certify other versions or OMP main.",
    "",
  ].join("\n");
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}
