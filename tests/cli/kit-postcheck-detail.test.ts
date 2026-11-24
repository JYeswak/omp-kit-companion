// Coverage: src/kit-update.ts (kitPostcheckDetail, failedStageOutput), src/full-test-runner.ts (redactFullTestText).
import { expect, test } from "bun:test";
import { kitPostcheckDetail, type KitPostcheck } from "../../src/kit-update.ts";

// POSTCHECKLOAD2 (ompkit-oks5j): the 0.2.149 install ended PARTIAL on `Stage regex-budget returned producer_rc=1` and the retained
// detail named no failing check, because the stage's own output was dropped. A failed stage now keeps the redacted end of its output.
const HOME = "/Users/someone/fixture-home";

interface FixtureStage { status: "PASS" | "FAIL" | "DEFERRED"; producer_rc: number; duration_ms: number; output?: { stdout_chars: number; stdout_tail: string; stderr_tail: string } }

function stage(status: FixtureStage["status"], output?: FixtureStage["output"]): FixtureStage {
	return { status, producer_rc: status === "PASS" ? 0 : 1, duration_ms: 10, ...(output ? { output } : {}) };
}

function postcheck(stages: Record<string, FixtureStage>): KitPostcheck {
	const report = {
		status: "FAIL", exitCode: 1, omp_version: "19.1.1", fast: { status: "PASS" }, stages, current_stage: null, cause: null,
		proofs: { G4_live: { status: "PASS", expected_scenarios: 1, observed_scenarios: 1, plant: "PASS" } },
		snapshots: { home: { changed_paths: [], live_state_paths: [] }, project: { changed_paths: [], live_state_paths: [] } },
		failures: ["Stage regex-budget returned producer_rc=1"],
	};
	return { status: "FAIL", matcher: "PASS", live: "PASS", report } as unknown as KitPostcheck;
}

test("POSTCHECKLOAD2: a failed stage keeps the redacted tail of its output; a passing stage's output is not kept", () => {
	const noisy = `${"x".repeat(4000)}\nmeasurement timeouts:\nkit-foo#0 | TIMEOUT | GATE_TIMEOUT\nlog ${HOME}/state/a.json Bearer abc123token\n`;
	const detail = kitPostcheckDetail(postcheck({
		manifest: stage("PASS", { stdout_chars: 12, stdout_tail: "manifest ok", stderr_tail: "" }),
		"regex-budget": stage("FAIL", { stdout_chars: noisy.length, stdout_tail: noisy, stderr_tail: `boom at ${HOME}/x` }),
	}), [HOME]);
	if (detail === null || !("failed_stage_output" in detail) || detail.failed_stage_output === undefined) throw new Error("the failed stage's output was not kept: " + JSON.stringify(detail));
	const kept = detail.failed_stage_output;
	expect(Object.keys(kept)).toEqual(["regex-budget"]);
	const budget = kept["regex-budget"];
	if (budget === undefined) throw new Error("regex-budget output missing");
	expect(budget.stdout_tail.length).toBeLessThanOrEqual(1500);
	expect(budget.stdout_tail).toContain("kit-foo#0 | TIMEOUT | GATE_TIMEOUT");
	expect(budget.stdout_tail).not.toContain(HOME);
	expect(budget.stdout_tail).not.toContain("abc123token");
	expect(budget.stderr_tail).not.toContain(HOME);
	expect(budget.stdout_chars).toBe(noisy.length);
});

test("POSTCHECKLOAD2: no failed stage, or a failed stage with no output, adds no failed_stage_output key", () => {
	const none = kitPostcheckDetail(postcheck({ manifest: stage("PASS", { stdout_chars: 1, stdout_tail: "ok", stderr_tail: "" }) }), [HOME]);
	expect(none !== null && "failed_stage_output" in none).toBe(false);
	const bare = kitPostcheckDetail(postcheck({ "regex-budget": stage("FAIL") }), [HOME]);
	expect(bare !== null && "failed_stage_output" in bare).toBe(false);
});
