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
	];
	expect(scenarioIds(base)).toEqual(["baseline"]);
	expect(scenarioIds([...base, { id: "new-live-scenario" }])).toEqual(["baseline", "new-live-scenario"]);
});
