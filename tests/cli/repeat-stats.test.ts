import { expect, test } from "bun:test";
import { readLiveVerdictIds } from "../../src/full-test-runner.ts";
import { resolve } from "node:path";
import { repeatTestCommand } from "../../src/cli.ts";
import { findCommand } from "../../src/commands.ts";
import { clopperPearson, cohensH, fisherExact, repeatScenarioResult, repeatVerdict, sampleSize } from "../../src/repeat-stats.ts";

test("Clopper-Pearson matches SciPy beta.ppf to 1e-9", () => {
	const cases: [number, number, number, number][] = [
		[0, 20, 0, 0.168433470983],
		[1, 20, 0.001265089498, 0.248732762772],
		[2, 20, 0.01234852717, 0.316982714019],
		[10, 20, 0.271957849561, 0.728042150439],
		[20, 20, 0.831566529017, 1],
		[2, 100, 0.002431336824, 0.070383932471],
	];
	for (const [failures, runs, lower, upper] of cases) {
		const interval = clopperPearson(failures, runs);
		expect(interval.lower).toBeCloseTo(lower, 9);
		expect(interval.upper).toBeCloseTo(upper, 9);
	}
	expect(() => clopperPearson(21, 20)).toThrow(/INVALID_REPEAT_COUNTS/);
	expect(() => clopperPearson(1, 0)).toThrow(/INVALID_REPEAT_COUNTS/);
});

test("Fisher separates signal from noise on small counts", () => {
	expect(fisherExact(2, 20, 1, 20)).toBeGreaterThan(0.5);
	expect(fisherExact(1, 20, 10, 20)).toBeLessThan(0.01);
	expect(fisherExact(0, 20, 0, 20)).toBe(1);
	expect(() => fisherExact(3, 2, 1, 20)).toThrow(/INVALID_REPEAT_COUNTS/);
});

test("sample size matches the two-proportion anchor", () => {
	const n = sampleSize(0.5, 0.4);
	expect(Math.abs(n! - 387)).toBeLessThan(10);
	expect(sampleSize(0.1, 0.1)).toBeNull();
	expect(() => sampleSize(-0.1, 0.5)).toThrow(/INVALID_POWER_INPUTS/);
	expect(Math.abs(cohensH(0.1, 0.05) - 0.19)).toBeLessThan(0.02);
});

test("zero failures in twenty runs does not prove a five percent target", () => {
	const thin = repeatVerdict({ version: 1, runs: 20, failures: 0 }, { target: 0.05 });
	expect(thin.kind).toBe("above-target");
	expect(thin.failure_rate).toBe(0);
	const thick = repeatVerdict({ version: 1, runs: 300, failures: 0 }, { target: 0.05 });
	expect(thick.kind).toBe("below-target");
	expect(thick.n_needed_post_hoc).toBe(152);
});

test("baseline verdicts follow Fisher, not raw counts", () => {
	const noise = repeatVerdict({ version: 1, runs: 20, failures: 1 }, { baseline: { version: 1, runs: 20, failures: 2 } });
	expect(noise.kind).toBe("not-distinguishable");
	expect(noise.p_value!).toBeGreaterThan(0.05);
	const bad = JSON.parse(JSON.stringify({ version: 2, runs: 20, failures: 2 }));
	expect(() => repeatVerdict({ version: 1, runs: 20, failures: 1 }, { baseline: bad })).toThrow(/INVALID_REPEAT_RECEIPT/);
	const fixed = repeatVerdict({ version: 1, runs: 20, failures: 0 }, { baseline: { version: 1, runs: 20, failures: 8 } });
	expect(fixed.kind).toBe("improved");
	expect(fixed.p_value!).toBeLessThan(0.05);
	expect(fixed.effect_size_h!).toBeLessThan(0);
	const worse = repeatVerdict({ version: 1, runs: 20, failures: 8 }, { baseline: { version: 1, runs: 20, failures: 0 } });
	expect(worse.kind).toBe("regressed");
	const plain = repeatVerdict({ version: 1, runs: 20, failures: 2 });
	expect(plain.kind).toBe("unjudged");
	expect(plain.p_value).toBeNull();
});

test("repeat handler refuses bad counts, clashing flags, and bad selections before any run", async () => {
	const command = findCommand("test");
	if (!command) throw new Error("test command missing");
	const call = (flags: [string, string | true][]) => repeatTestCommand({ command, flags: new Map(flags), json: true, robot: false });
	for (const bad of ["0", "abc", "1001", ""]) {
		const result = await call([["--repeat", bad]]);
		expect(result.errors?.[0]?.code).toBe("INVALID_REPEAT");
	}
	expect((await call([["--repeat", "5"], ["--full", true]])).errors?.[0]?.code).toBe("INVALID_FLAG");
	expect((await call([["--repeat", "5"], ["--scenario", ""]])).errors?.[0]?.code).toBe("INVALID_SCENARIO");
	expect((await call([["--repeat", "5"], ["--baseline", "relative/path.json"]])).errors?.[0]?.code).toBe("INVALID_BASELINE");
});

test("receipt results must agree with the summary counts and the scenario", () => {
	const mismatch = { version: 1, runs: 20, failures: 0, results: Array(20).fill("fail") };
	expect(() => repeatVerdict({ version: 1, runs: 20, failures: 0 }, { baseline: JSON.parse(JSON.stringify(mismatch)) })).toThrow(/INVALID_REPEAT_RECEIPT/);
	expect(() => repeatVerdict({ version: 1, scenario: "canary-near", runs: 20, failures: 1 }, { baseline: { version: 1, scenario: "unsafe-router-fire", runs: 20, failures: 8 } })).toThrow(/SCENARIO_MISMATCH/);
});

test("REPEAT1 counts a real scenario verdict but never a launcher failure or incomplete cohort", () => {
	const expected = new Set(["target"]);
	const healthy = "ok    target\ne2e-live (full): 1 passed, 0 failed\n";
	const failed = "FAIL  target :: bad transcript (omp exit 1)\ne2e-live (full): 0 passed, 1 failed\n";
	expect(repeatScenarioResult({ code: 0, stdout: healthy }, expected)).toBe("pass");
	expect(repeatScenarioResult({ code: 1, stdout: failed }, expected)).toBe("fail");
	expect(repeatScenarioResult({ code: 2, stdout: "runtime-adapter: OMP launcher identity is missing or inconsistent\n" }, expected)).toBeNull();
	expect(repeatScenarioResult({ code: 0, stdout: "e2e-live (full): 0 passed, 0 failed\n" }, expected)).toBeNull();
	expect(repeatScenarioResult({ code: 0, stdout: healthy }, new Set(["target", "missing"]))).toBeNull();
	expect(repeatScenarioResult({ code: 0, stdout: healthy.replace("target", "unrelated") }, expected)).toBeNull();
	expect(repeatScenarioResult({ code: 0, stdout: "ok    target\n" + healthy }, expected)).toBeNull();
	expect(repeatScenarioResult({ code: 1, stdout: healthy.replace("0 failed", "1 failed") }, expected)).toBeNull();
});

test("REPEAT1 full-cohort matcher accepts verdict rows without report-only and plant scenarios", () => {
	const ids = readLiveVerdictIds(resolve(import.meta.dir, "../.."));
	expect(ids).toContain("settings-no-checkout-remedy");
	expect(ids).not.toContain("omp-late-interrupt-probe");
	const selected = new Set(ids);
	const report = `${ids.map(id => `ok    ${id}`).join("\n")}\nPROBE omp-late-interrupt: continued\n` +
		`e2e-live (full): ${ids.length} passed, 0 failed\n`;
	expect(repeatScenarioResult({ code: 0, stdout: report }, selected)).toBe("pass");
	expect(repeatScenarioResult({ code: 0, stdout: report.replace("ok    settings-no-checkout-remedy\n", "") }, selected)).toBeNull();
});
