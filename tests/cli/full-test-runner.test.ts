import { expect, test } from "bun:test";
import { classifyLadder } from "../../src/full-test-runner.ts";

const names = ["manifest", "harness-gate", "harness-selftest", "flywheel-invariants", "regex-budget", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"];
const successful = names.map(name => `GREEN ${name} producer_rc=0`).join("\n");
const live = "ok    scenario-one\nok    scenario-two";
const planted = "plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close";

function sample(lines: string, code = 0) {
 return classifyLadder({ code, stdout: lines, stderr: "" }, ["scenario-one", "scenario-two"]);
}

test("full ladder requires every ordered stage, every shipped live row, and named plant", () => {
 const result = sample(`${live}\n${planted}\n${successful}\nLADDER: GREEN`);
 expect(Object.values(result.stages).every(stage => stage.status === "PASS")).toBe(true);
 expect(result.live_scenarios.status).toBe("PASS");
 expect(result.failures).toEqual([]);
 const absent = sample(`${planted}\n${successful}\nLADDER: GREEN`);
 expect(absent.live_scenarios.status).toBe("FAIL");
 expect(absent.failures).toContain("Live scenario rows did not match the exact shipped ordered scenario IDs");
 const missingPlant = sample(`${live}\n${successful}\nLADDER: GREEN`);
 expect(missingPlant.failures).toContain("Planted negative control was not named RED");
});

test("mid-ladder RED exposes its producer status and keeps later stages NOT_RUN", () => {
 const result = sample("GREEN manifest producer_rc=0\nRED   harness-gate producer_rc=7\n", 1);
 expect(result.stages.manifest).toEqual({ status: "PASS", producer_rc: 0 });
 expect(result.stages["harness-gate"]).toEqual({ status: "FAIL", producer_rc: 7 });
 expect(result.stages["e2e-live"].status).toBe("NOT_RUN");
 expect(result.live_scenarios.status).toBe("NOT_RUN");
 expect(result.failures).toContain("Stage harness-gate returned producer_rc=7");
 expect(result.failures).not.toContain("Live scenario rows missing: scenario-one, scenario-two");
});

test("producer success without complete ordered proof is a failure, never implicit green", () => {
 const result = sample("GREEN manifest producer_rc=0\nLADDER: GREEN");
 expect(result.stages["e2e-plant"].status).toBe("NOT_RUN");
 expect(result.failures).toContain("Producer returned success without every named GREEN stage and LADDER: GREEN");
});

test("failed live stage reports missing scenario IDs", () => {
 const stages = names.slice(0, names.indexOf("e2e-live")).map(name => "GREEN " + name + " producer_rc=0").join("\n");
 const result = sample(stages + "\nok    scenario-one\nRED   e2e-live producer_rc=1", 1);
 expect(result.live_scenarios).toMatchObject({ status: "FAIL", observed_ids: ["scenario-one"] });
 expect(result.failures[0]).toBe("Live scenario rows missing: scenario-two");
});

test("a ladder that skips the flywheel-invariants stage is an order failure, not green", () => {
 const skipped = names.filter(name => name !== "flywheel-invariants").map(name => `GREEN ${name} producer_rc=0`).join("\n");
 const result = sample(`${live}\n${planted}\n${skipped}\nLADDER: GREEN`);
 expect(result.stages["flywheel-invariants"].status).toBe("NOT_RUN");
 expect(result.failures).toContain("Ladder stage order, identity, or producer rc mismatch");
});
