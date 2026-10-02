import { expect, test } from "bun:test";
import { classifyLadder } from "../../src/full-test-runner.ts";

const names = ["manifest", "harness-gate", "harness-selftest", "claim-selftest", "cli-crosscheck", "metamorphic-ratchet", "readiness-selftest", "e2e-live", "e2e-plant"];
const successful = names.map(name => `GREEN ${name} producer_rc=0`).join("\n");
const live = "ok    scenario-one\nok    scenario-two";
const planted = "plant RED as required: baseline kit-close-needs-evidence fires on the streamed prefix of an evidenced close";

function sample(lines: string, code = 0) {
 return classifyLadder({ code, stdout: lines, stderr: "" }, ["scenario-one", "scenario-two"]);
}

test("full ladder requires all nine ordered stages, every shipped live row, and named plant", () => {
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
});

test("producer success without complete ordered proof is a failure, never implicit green", () => {
 const result = sample("GREEN manifest producer_rc=0\nLADDER: GREEN");
 expect(result.stages["e2e-plant"].status).toBe("NOT_RUN");
 expect(result.failures).toContain("Producer returned success without nine named GREEN stages and LADDER: GREEN");
});
