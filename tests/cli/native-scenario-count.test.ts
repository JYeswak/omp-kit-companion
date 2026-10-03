import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const script = resolve(root, "scripts/native-candidate.py");
const python = `
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("native_candidate", sys.argv[2])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.live_scenario_ids(Path(sys.argv[1]))))
`;

function scenarioIds(rows: object[]): string[] {
	const scratch = mkdtempSync(join(resolve(root, "var/agent-tmp"), "native-scenario-count-"));
	try {
		const scenarios = join(scratch, "tests/live/scenarios.json");
		mkdirSync(resolve(scenarios, ".."), { recursive: true });
		writeFileSync(scenarios, JSON.stringify(rows));
		const result = Bun.spawnSync(["python3", "-c", python, scratch, script], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		return JSON.parse(result.stdout.toString()) as string[];
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("native live scenario expectations follow scenarios.json additions", () => {
	const base = [
		{ id: "baseline" },
		{ id: "planted-control", plant: true },
		{ id: "report-only-probe", kind: "probe" },
	];
	expect(scenarioIds(base)).toEqual(["baseline"]);
	expect(scenarioIds([...base, { id: "new-live-scenario" }])).toEqual(["baseline", "new-live-scenario"]);
});
const reportPython = `
import importlib.util
import json
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("native_candidate", sys.argv[3])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
test = json.loads(Path(sys.argv[1]).read_text())
expected_ids = json.loads(Path(sys.argv[2]).read_text())
print(json.dumps(module.full_live_condition_report(test, expected_ids, sys.argv[4])))
`;

function liveConditionReport(test: object, expectedIds: string[]): { failed: string[] } {
	const scratch = mkdtempSync(join(resolve(root, "var/agent-tmp"), "native-refusal-report-"));
	try {
		const ladder = join(scratch, "ladder.json");
		const ids = join(scratch, "ids.json");
		writeFileSync(ladder, JSON.stringify(test));
		writeFileSync(ids, JSON.stringify(expectedIds));
		const result = Bun.spawnSync(["python3", "-c", reportPython, ladder, ids, script, "18.5.0"], { stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		return JSON.parse(result.stdout.toString()) as { failed: string[] };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

test("native refusal reports the exact failed live condition", () => {
	const report = liveConditionReport({
		status: "PASS",
		proof_scope: "ISOLATED_FIXTURE_ONLY",
		omp_version: "18.5.0",
		proofs: { G4_live: { expected_scenarios: 2, observed_scenarios: 1, plant: "PASS" } },
		live_scenarios: { status: "PASS", expected_ids: ["baseline", "settings-no-checkout-remedy"], observed_ids: ["baseline", "settings-no-checkout-remedy"] },
		snapshots: { release: { complete: true, unchanged: true }, home: { complete: true, unchanged: true } },
	}, ["baseline", "settings-no-checkout-remedy"]);
	expect(report.failed).toEqual(["live_observed_scenarios"]);
});
