import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRuleFile } from "../../scripts/rule-class.ts";
import { failsNearMissBudget, failsStreamBudget, lintCondition, literalProbe, measureCondition, medianTotalMs, regexLoadBlockReason, runGate } from "../../scripts/regex-budget.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");

function fixtureRule(name: string, condition: string): { dir: string; name: string; pattern: string } {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "regex-budget-test-"));
	writeFileSync(join(dir, ".owner"), "pid=" + process.pid + "\nlabel=regex-budget-test\nrepo=" + root + "\ncreated=" + new Date().toISOString() + "\n");
	const file = join(dir, name + ".md");
	writeFileSync(file, "---\ncondition: " + JSON.stringify(condition) + "\nscope: tool:bash\ninterruptMode: never\n---\nfixture rule\n");
	const loaded = loadRuleFile(file);
	return { dir, name: loaded.name, pattern: loaded.rule.condition?.[0] ?? "" };
}

const cleanup = (dir: string) => { if (dir) rmSync(dir, { recursive: true, force: true }); };

test("near-miss threshold requires both super-quadratic growth and absolute cost", () => {
	expect(failsNearMissBudget([1, 2, 4])).toBe(false);
	expect(failsNearMissBudget([1, 10, 26])).toBe(false);
	expect(failsNearMissBudget([1, 1.9, 5])).toBe(false);
	expect(failsNearMissBudget([1, 1.9, 5.1])).toBe(true);
});

test("live stream threshold accepts 500ms and rejects a larger cost", () => {
	expect(failsStreamBudget(500)).toBe(false);
	expect(failsStreamBudget(500.1)).toBe(true);
});

test("Bash condition lint catches leading assertions and wildcards", () => {
	expect(lintCondition("(?<!x)needle")).toContain("LEADING_LOOKAROUND");
	expect(lintCondition(".*needle")).toContain("LEADING_UNBOUNDED_WILDCARD");
	expect(lintCondition("needle(?<!x)\\s+end")).toEqual([]);
	expect(lintCondition("(?<!x+)needle")).toContain("UNBOUNDED_LOOKBEHIND_WITHOUT_LITERAL");
});

test("literal probe skips exclusion lookbehind and finds the trigger", () => {
	expect(literalProbe("(?<!echo)\\b(?:br|bd)\\s+close\\b")).toBe("close");
});

test("overlapping-alternative fixture fails the measured doubling ratio", async () => {
	const fixture = fixtureRule("fixture-quadratic", "a(a|aa)+b");
	try {
		const result = await measureCondition({
			rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern,
			sizes: [8, 16, 32], shapes: ["literal"], encodings: ["raw"], workerTimeoutMs: 20_000,
		});
		expect(result.rule).toBe("fixture-quadratic");
		expect(result.status).toBe("MEASURED");
		expect(result.samples.length).toBe(1);
		const sample = result.samples[0];
		if (!sample) throw new Error("literal near-miss sample missing");
		expect(sample.ms[2] / Math.max(sample.ms[1], 0.01)).toBeGreaterThan(2.6);
		expect(result.failures.map(f => f.code)).toContain("NEAR_MISS_SUPERQUADRATIC");
	} finally { cleanup(fixture.dir); }
});

test("literal-first fixture control compiles and stays below the budget", async () => {
	const fixture = fixtureRule("fixture-linear", "^a+b$");
	try {
		const result = await measureCondition({
			rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern,
			sizes: [4096, 8192, 16384], shapes: ["literal"], encodings: ["raw"], streamWire: "x".repeat(33), workerTimeoutMs: 2_000,
		});
		expect(result.failures).toEqual([]);
		expect(result.stream_deltas).toBe(3);
		expect(typeof result.stream_ms).toBe("number");
	} finally { cleanup(fixture.dir); }
});

test("load gate blocks only above 1.5 times the core count", () => {
	expect(regexLoadBlockReason(48.01, 32)).toContain("RX1");
	expect(regexLoadBlockReason(48.0, 32)).toBeNull();
	expect(regexLoadBlockReason(Number.NaN, 32)).toContain("unavailable");
});

test("planted contention reports INCONCLUSIVE without measuring", async () => {
	process.env.RX1_FAKE_LOAD1 = "9999";
	try {
		const report = await runGate(join(root, "rules"), join(root, "scripts/e2e-live.sh"));
		expect(report.status).toBe("INCONCLUSIVE");
		expect(report.conditions_measured).toBe(0);
		expect(report.note ?? "").toContain("RX1");
	} finally { delete process.env.RX1_FAKE_LOAD1; }
});

test("five-run stream budget judges the median of total_ms samples", () => {
	const passing = [480, 490, 495, 900, 950];
	expect(medianTotalMs(passing)).toBe(495);
	expect(failsStreamBudget(medianTotalMs(passing))).toBe(false);

	const failing = [480, 510, 520, 530, 900];
	expect(medianTotalMs(failing)).toBe(520);
	expect(failsStreamBudget(medianTotalMs(failing))).toBe(true);
});

test("single-run stream budget keeps the 500ms boundary", () => {
	expect(medianTotalMs([500])).toBe(500);
	expect(failsStreamBudget(medianTotalMs([500]))).toBe(false);
	expect(failsStreamBudget(medianTotalMs([500.1]))).toBe(true);
	expect(failsStreamBudget(500)).toBe(false);
	expect(failsStreamBudget(500.1)).toBe(true);
});

test("five-run CLI reports five stream totals and their median", () => {
	const fixture = fixtureRule("fixture-linear", "^a+b$");
	const streamFile = join(fixture.dir, "stream.sh");
	writeFileSync(streamFile, "printf '%s\\n' ok\n");
	try {
		const result = Bun.spawnSync([
			process.execPath, "run", "--no-env-file", "--config=/dev/null",
			resolve(root, "scripts/regex-budget.ts"), "--rules", fixture.dir, "--stream", streamFile, "--runs", "5",
		], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const reportLine = result.stdout.toString().split("\n").find(line => line.startsWith("JSON_REPORT="));
		if (!reportLine) throw new Error("REGEX_BUDGET_JSON_REPORT_MISSING: " + result.stderr.toString());
		const report: { stream: { total_ms: number; median_total_ms: number; sample_total_ms: number[] } } =
			JSON.parse(reportLine.slice("JSON_REPORT=".length));
		expect(report.stream.sample_total_ms).toHaveLength(5);
		expect(report.stream.total_ms).toBe(report.stream.median_total_ms);
		expect(typeof report.stream.median_total_ms).toBe("number");
	} finally { cleanup(fixture.dir); }
});

test("default CLI preserves the single-run report shape", () => {
	const fixture = fixtureRule("fixture-linear", "^a+b$");
	const streamFile = join(fixture.dir, "stream.sh");
	writeFileSync(streamFile, "printf '%s\\n' ok\n");
	try {
		const result = Bun.spawnSync([
			process.execPath, "run", "--no-env-file", "--config=/dev/null",
			resolve(root, "scripts/regex-budget.ts"), "--rules", fixture.dir, "--stream", streamFile,
		], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const reportLine = result.stdout.toString().split("\n").find(line => line.startsWith("JSON_REPORT="));
		if (!reportLine) throw new Error("REGEX_BUDGET_JSON_REPORT_MISSING: " + result.stderr.toString());
		const report: { stream: { total_ms: number; sample_total_ms?: number[]; median_total_ms?: number } } =
			JSON.parse(reportLine.slice("JSON_REPORT=".length));
		expect(typeof report.stream.total_ms).toBe("number");
		expect(report.stream.sample_total_ms).toBeUndefined();
		expect(report.stream.median_total_ms).toBeUndefined();
	} finally { cleanup(fixture.dir); }
});
