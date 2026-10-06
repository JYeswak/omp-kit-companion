import { describe, expect, test } from "bun:test";
import { compatibilityRegressions, renderCompatibilityTable, type OmpCompatibilityRun } from "../../scripts/omp-compatibility";

const stable = (omp_version: string): OmpCompatibilityRun => ({
  schema_version: 1,
  omp_version,
  default_policy_exit: 0,
  default_policy_failures: [],
  first_fires: [
    { rule: "verification", line: 10, expect: "fire", g2: "fire", first_fire: 4, wire_length: 8 },
    { rule: "verification", line: 11, expect: "quiet", g2: "quiet", first_fire: null, wire_length: 7 },
  ],
});

const matrix = () => [stable("18.5.1"), stable("18.6.0"), stable("18.6.1")];

describe("OMP compatibility matrix", () => {
  test("requires three distinct stable releases in ascending order", () => {
    expect(() => renderCompatibilityTable(matrix().slice(0, 2))).toThrow("at least three");
    expect(() => renderCompatibilityTable([stable("18.5.1"), stable("18.5.1"), stable("18.6.1")])).toThrow("distinct");
    expect(() => renderCompatibilityTable([stable("18.6.0"), stable("18.5.1"), stable("18.6.1")])).toThrow("ascending");
  });

  test("shows green when first-fire and default-policy outcomes agree across releases", () => {
    const report = renderCompatibilityTable(matrix());
    expect(report).toContain("| First-fire differential | GREEN");
    expect(report).toContain("| Default-policy differential | GREEN — matches baseline exit 0; 0 failing scenario(s)");
  });

  test("marks a newer release RED with the changed case when its first-fire index regresses", () => {
    const runs = matrix();
    runs[1]!.first_fires[0]!.first_fire = 2;
    expect(renderCompatibilityTable(runs)).toContain("RED — verification:10 first_fire 4 -> 2");
    expect(compatibilityRegressions(runs)).toEqual([{
      version: "18.6.0",
      checks: ["first-fire: verification:10 first_fire 4 -> 2"],
    }]);
  });

  test("marks default-policy outcome drift RED when the exit or scenario set changes", () => {
    const runs = matrix();
    for (const run of runs.slice(0, 2)) {
      run.default_policy_exit = 1;
      run.default_policy_failures = ["close-help-near: unexpected rule named"];
    }
    runs[2]!.default_policy_exit = 7;
    runs[2]!.default_policy_failures = ["different-case: unexpected rule"];
    expect(renderCompatibilityTable(runs)).toContain("RED — baseline exit 1 -> exit 7; scenario set changed");
    expect(compatibilityRegressions(runs)[0]!.version).toBe("18.6.1");
  });

  test("records a shared failing default-policy outcome without calling it passing", () => {
    const runs = matrix();
    for (const run of runs) {
      run.default_policy_exit = 1;
      run.default_policy_failures = ["close-help-near: unexpected rule named"];
    }
    const report = renderCompatibilityTable(runs);
    expect(report).toContain("GREEN — matches baseline exit 1; 1 failing scenario(s)");
    expect(report).toContain("GREEN means the observed outcome matches the baseline, not that the policy passed");
    expect(report).toContain("OMP 18.5.1 (exit 1): close-help-near: unexpected rule named");
  });

  test("the planted known-break fixture turns its release column RED; removing it restores GREEN", async () => {
    const fixture = JSON.parse(await Bun.file("tests/fixtures/omp-compat/known-break.json").text()) as OmpCompatibilityRun;
    const runs = matrix();
    const withBreak = [...runs.slice(0, 1), fixture, ...runs.slice(1)];
    const report = renderCompatibilityTable(withBreak);
    expect(report).toContain("| First-fire differential | GREEN");
    expect(report).toContain("RED — verification:10 first_fire 4 -> 2");
    expect(renderCompatibilityTable(runs)).not.toContain("RED —");
  });

  test("fails closed when an expected fire is absent from every release", () => {
    const runs = matrix();
    for (const run of runs) run.first_fires[0]!.first_fire = null;
    expect(renderCompatibilityTable(runs)).toContain("RED — verification:10 expected fire but never fired");
  });
});
