import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OMP_SRC, loadRuleFile } from "../../scripts/rule-class.ts";
import { DEFAULT_ENCODINGS, DEFAULT_SHAPES, DEFAULT_SIZES, DEFAULT_WRITE_EDIT_STREAM_FILE, WRITE_EDIT_STREAM_BUDGET_MS, appliesToWriteEditStream, buildWriteEditWire, failsNearMissBudget, failsSingleCheckCeiling, failsStreamBudget, failsWriteEditStreamBudget, lintCondition, literalProbe, medianMs, measureCondition, runGate } from "../../scripts/regex-budget.ts";

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

/** Copy a real repo rule into an owned temp dir so the test replays its own fixture, never the live rules tree. */
function fixtureRuleCopy(fileName: string, source: string): { dir: string; name: string; pattern: string; scope: readonly string[] } {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "regex-budget-test-"));
	writeFileSync(join(dir, ".owner"), "pid=" + process.pid + "\nlabel=regex-budget-test\nrepo=" + root + "\ncreated=" + new Date().toISOString() + "\n");
	copyFileSync(join(root, source), join(dir, fileName + ".md"));
	const loaded = loadRuleFile(join(dir, fileName + ".md"));
	return { dir, name: loaded.name, pattern: loaded.rule.condition?.[0] ?? "", scope: loaded.rule.scope ?? [] };
}

const cleanup = (dir: string) => { if (dir) rmSync(dir, { recursive: true, force: true }); };

test("near-miss threshold requires both super-quadratic growth and absolute cost", () => {
	expect(failsNearMissBudget([1, 2, 4])).toBe(false);
	expect(failsNearMissBudget([1, 10, 26])).toBe(false);
	expect(failsNearMissBudget([1, 1.9, 5])).toBe(false);
	expect(failsNearMissBudget([1, 1.9, 5.1])).toBe(true);
});

test("five-sample medians ignore one timing spike and reject max/single-sample mutants", () => {
	const bySize = [
		[1, 1, 1, 1, 1],
		[2, 2, 2, 2, 2],
		[100, 4, 4, 4, 4],
	];
	const medians = bySize.map(medianMs);
	expect(medians).toEqual([1, 2, 4]);
	expect(failsNearMissBudget(medians)).toBe(false);
	expect(failsSingleCheckCeiling(medians)).toBe(false);
	expect(failsNearMissBudget(bySize.map(samples => Math.max(...samples)))).toBe(true);
	expect(failsNearMissBudget(bySize.map(samples => samples[0]!))).toBe(true);
	expect(medianMs([1, 2, 3, 4])).toBe(Number.POSITIVE_INFINITY);
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

test("match-any condition is accepted only with discriminating temp write/edit scopes", async () => {
	const scratchScopes = [
		"tool:write(**/var/agent-tmp/**/*{PROMPT,Prompt,prompt}*)",
		"tool:edit(**/var/agent-tmp/**/{PACKET,Packet,packet}*)",
		"tool:write(**/var/agent-tmp/**/rules/*.md)",
		"tool:edit(**/var/agent-tmp/**/skills/**)",
		"tool:write(**/var/agent-tmp/**/{src,tests,scripts}/**)",
	] as const;
	const measure = (pattern: string, scope: readonly string[]) => {
		const input = {
			rule: "scratch-is-not-a-home", conditionIndex: 0, pattern, scope,
			sizes: [32, 64, 128], shapes: ["literal"], encodings: ["raw"], workerTimeoutMs: 2_000,
			streamWire: "x".repeat(33),
		} as const;
		return measureCondition(input);
	};

	const scoped = await measure("[\\s\\S]", scratchScopes);
	expect(scoped.status).toBe("MEASURED");
	expect(scoped.failures.map(failure => failure.code)).not.toContain("NO_REQUIRED_LITERAL_PROBE");
	expect(scoped.stream_ms).toBeUndefined();

	const broadScope = await measure("[\\s\\S]", ["tool:write(**/var/agent-tmp/**)"]);
	expect(broadScope.failures.map(failure => failure.code)).toContain("NO_REQUIRED_LITERAL_PROBE");

	const nonAtomicWildcard = await measure("(?:x|[\\s\\S])", scratchScopes);
	expect(nonAtomicWildcard.failures.map(failure => failure.code)).toContain("NO_REQUIRED_LITERAL_PROBE");
});

test("vacuous (?s).+ is accepted only with tool write/edit scopes, never unscoped", async () => {
	const skillScopes = [
		"tool:edit(~/.claude/skills/**)",
		"tool:write(~/.claude/skills/**)",
		"tool:edit(~/.agents/skills/**)",
		"tool:write(~/.agents/skills/**)",
		"tool:edit(/Users/*/.claude/skills/**)",
		"tool:write(/Users/*/.claude/skills/**)",
		"tool:edit(/Users/*/.agents/skills/**)",
		"tool:write(/Users/*/.agents/skills/**)",
	] as const;
	const measure = (pattern: string, scope: readonly string[]) => {
		const input = {
			rule: "kit-teach-shared-skills", conditionIndex: 0, pattern, scope,
			sizes: [32, 64, 128], shapes: ["literal"], encodings: ["raw"], workerTimeoutMs: 2_000,
			streamWire: "x".repeat(33),
		} as const;
		return measureCondition(input);
	};

	const scoped = await measure("(?s).+", skillScopes);
	expect(scoped.status).toBe("MEASURED");
	expect(scoped.failures.map(failure => failure.code)).not.toContain("NO_REQUIRED_LITERAL_PROBE");
	expect(scoped.stream_ms).toBeUndefined();

	const unscoped = await measure("(?s).+", []);
	expect(unscoped.failures.map(failure => failure.code)).toContain("NO_REQUIRED_LITERAL_PROBE");

	const bareTool = await measure("(?s).+", ["tool:bash"]);
	expect(bareTool.failures.map(failure => failure.code)).toContain("NO_REQUIRED_LITERAL_PROBE");

	const nonAtomic = await measure("(?:x|(?s).+)", skillScopes);
	expect(nonAtomic.failures.map(failure => failure.code)).toContain("NO_REQUIRED_LITERAL_PROBE");
});

test("scope-aware CLI excludes file-only rules from the Bash stream budget", () => {
	const fixture = fixtureRule("fixture-scoped-match-any", "[\\s\\S]");
	const streamFile = join(fixture.dir, "stream.sh");
	const scope = [
		"tool:write(**/var/agent-tmp/**/fixture-scoped-match-any.md)",
		"tool:edit(**/var/agent-tmp/**/fixture-scoped-match-any.md)",
	];
	const ruleFile = join(fixture.dir, fixture.name + ".md");
	writeFileSync(ruleFile, [
		"---",
		"condition: " + JSON.stringify(fixture.pattern),
		"scope: " + JSON.stringify(scope),
		"interruptMode: never",
		"---",
		"fixture rule",
		"",
	].join("\n"));
	writeFileSync(streamFile, "printf '%s\\n' ok\n");
	try {
		const result = Bun.spawnSync([
			process.execPath, "run", "--no-env-file", "--config=/dev/null",
			resolve(root, "scripts/regex-budget.ts"), "--rules", fixture.dir, "--stream", streamFile,
		], { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const reportLine = result.stdout.toString().split("\n").find(line => line.startsWith("JSON_REPORT="));
		if (!reportLine) throw new Error("REGEX_BUDGET_JSON_REPORT_MISSING: " + result.stderr.toString());
		const report = JSON.parse(reportLine.slice("JSON_REPORT=".length));
		expect(result.exitCode).toBe(0);
		expect(report.status).toBe("PASS");
		expect(report.stream.complete).toBe(true);
		expect(report.stream.total_ms).toBe(0);
		expect(report.measurements[0]?.stream_ms).toBeUndefined();
		expect(report.measurements[0]?.failures).toEqual([]);
	} finally { cleanup(fixture.dir); }
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

test("runner load is recorded and never gates regex measurements", async () => {
	const fixture = fixtureRule("fixture-under-load", "^a+b$");
	const streamFile = join(fixture.dir, "stream.sh");
	writeFileSync(streamFile, "echo a\n");
	const savedLoad = process.env.RX1_FAKE_LOAD1;
	process.env.RX1_FAKE_LOAD1 = "9999";
	try {
		const report = await runGate(fixture.dir, streamFile);
		expect(report.status).toBe("PASS");
		expect(report.conditions_measured).toBe(1);
		const sample = report.measurements[0]?.samples[0];
		if (!sample) throw new Error("runner-load timing sample missing");
		expect(sample.sample_ms).toHaveLength(5);
		expect(sample.sample_load1).toHaveLength(5);
		expect(sample.sample_ms.every(run => run.length === 3)).toBe(true);
		expect(sample.sample_load1.every(run => run.length === 3 && run.every(Number.isFinite))).toBe(true);
		expect(report.stream.sample_total_ms).toHaveLength(5);
		expect(report.stream.sample_load1).toHaveLength(5);
	} finally {
		if (savedLoad === undefined) delete process.env.RX1_FAKE_LOAD1;
		else process.env.RX1_FAKE_LOAD1 = savedLoad;
		cleanup(fixture.dir);
	}
});

test("single-check ceiling catches flat catastrophics the ratio misses", () => {
	expect(failsSingleCheckCeiling([0.1, 0.2, 0.3])).toBe(false);
	expect(failsSingleCheckCeiling([60, 61, 62])).toBe(true);
	expect(failsSingleCheckCeiling([0.1, 0.2, 50])).toBe(false);
	expect(failsSingleCheckCeiling([0.1, 0.2, 50.1])).toBe(true);
	expect(failsSingleCheckCeiling([0.1, 0.2, Number.POSITIVE_INFINITY])).toBe(true);
});

test("median of five (a+)+b timings still fails the single-check ceiling widely", async () => {
	const fixture = fixtureRule("fixture-flat-catastrophic", "(a+)+b");
	try {
		const repeatedMs: number[][] = [];
		for (let run = 0; run < 5; run++) {
			const measurement = await measureCondition({ rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern, scope: ["tool:bash"], sizes: [16, 20, 26], shapes: ["literal"], encodings: ["raw"], workerTimeoutMs: 10_000, streamWire: "x".repeat(33) } as const);
			expect(measurement.status).toBe("MEASURED");
			const sample = measurement.samples[0];
			if (!sample) throw new Error("catastrophic timing sample missing");
			repeatedMs.push(sample.ms);
		}
		const medians = [0, 1, 2].map(size => medianMs(repeatedMs.map(sample => sample[size] ?? Number.POSITIVE_INFINITY)));
		expect(failsSingleCheckCeiling(medians)).toBe(true);
		expect(medians[2]).toBeGreaterThan(100);
	} finally { cleanup(fixture.dir); }
});

test("write/edit budget names the same 500ms ceiling as the bash stream", () => {
	expect(WRITE_EDIT_STREAM_BUDGET_MS).toBe(500);
	expect(failsWriteEditStreamBudget(500)).toBe(false);
	expect(failsWriteEditStreamBudget(500.1)).toBe(true);
	expect(failsWriteEditStreamBudget(Number.POSITIVE_INFINITY)).toBe(true);
});

test("write/edit stream gives a path-scoped rule a nonzero measured budget with the bash checklist", async () => {
	const fixture = fixtureRuleCopy("fixture-rx-write-edit", "rules/kit-regex-engineering.md");
	const fixtureText = readFileSync(DEFAULT_WRITE_EDIT_STREAM_FILE, "utf8");
	try {
		expect(fixture.scope.some(token => token.startsWith("tool:write(") || token.startsWith("tool:edit("))).toBe(true);
		expect(appliesToWriteEditStream(fixture.scope)).toBe(true);
		// OMP_SRC resolves from the installed build at runtime, so no static import can name it.
		const ruleModule = await import(join(OMP_SRC, "capability/rule.ts"));
		const compileRuleCondition = ruleModule.compileRuleCondition as (pattern: string) => RegExp;
		const re = compileRuleCondition(fixture.pattern);
		const lines = fixtureText.split("\n");
		const matches = lines.filter(line => line.startsWith("RX-MATCH:"));
		const rejects = lines.filter(line => line.startsWith("RX-NOMATCH:"));
		const nearMiss = lines.filter(line => line.startsWith("RX-NEARMISS:"));
		expect(matches.length).toBeGreaterThan(0);
		expect(rejects.length).toBeGreaterThan(0);
		expect(nearMiss.length).toBeGreaterThan(0);
		for (const line of matches) expect(re.test(line)).toBe(true);
		for (const line of rejects) expect(re.test(line)).toBe(false);
		for (const line of nearMiss) {
			const start = performance.now();
			expect(re.test(line)).toBe(false);
			expect(failsSingleCheckCeiling([0, 0, performance.now() - start])).toBe(false);
		}
		const result = await measureCondition({
			rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern, scope: fixture.scope,
			writeEditWire: buildWriteEditWire(fixtureText), workerTimeoutMs: 20_000,
		});
		expect(result.status).toBe("MEASURED");
		expect(result.failures).toEqual([]);
		expect(typeof result.write_edit_ms).toBe("number");
		expect(result.write_edit_ms!).toBeGreaterThan(0);
		expect(result.write_edit_deltas).toBeGreaterThan(0);
		expect(result.stream_ms).toBeUndefined();
		expect(result.samples.length).toBe(DEFAULT_SHAPES.length * DEFAULT_ENCODINGS.length);
		for (const sample of result.samples) expect(sample.ms).toHaveLength(DEFAULT_SIZES.length);
	} finally { cleanup(fixture.dir); }
});

test("paired control: bash-stream wiring is unchanged by the write/edit stream", async () => {
	const fixture = fixtureRule("fixture-paired-bash", "^a+b$");
	const streamFile = join(fixture.dir, "stream.sh");
	writeFileSync(streamFile, "echo a\n");
	try {
		const bashOnly = await measureCondition({ rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern, scope: ["tool:bash"], streamWire: "x".repeat(33), workerTimeoutMs: 10_000 });
		expect(typeof bashOnly.stream_ms).toBe("number");
		expect(bashOnly.write_edit_ms).toBeUndefined();
		const withBothWires = await measureCondition({ rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern, scope: ["tool:bash"], streamWire: "x".repeat(33), writeEditWire: buildWriteEditWire("calm prose"), workerTimeoutMs: 10_000 });
		expect(typeof withBothWires.stream_ms).toBe("number");
		expect(withBothWires.write_edit_ms).toBeUndefined();
		expect(withBothWires.stream_deltas).toBe(bashOnly.stream_deltas);
		const report = await runGate(fixture.dir, streamFile);
		expect(report.status).toBe("PASS");
		expect(report.stream.complete).toBe(true);
		expect(report.stream.by_rule).toHaveLength(1);
		expect(report.write_edit.complete).toBe(true);
		expect(report.write_edit.total_ms).toBe(0);
		expect(report.write_edit.by_rule).toEqual([]);
	} finally { cleanup(fixture.dir); }
});

test("mutant without the write/edit wiring measures a vacuous zero budget", async () => {
	const fixture = fixtureRuleCopy("fixture-rx-nowire", "rules/kit-regex-engineering.md");
	try {
		const result = await measureCondition({ rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern, scope: fixture.scope, streamWire: "x".repeat(33), workerTimeoutMs: 20_000 });
		expect(result.status).toBe("MEASURED");
		expect(result.stream_ms).toBeUndefined();
		expect(result.write_edit_ms).toBeUndefined();
	} finally { cleanup(fixture.dir); }
});

test("mutant with a deleted write/edit fixture fails closed instead of passing vacuously", async () => {
	const fixture = fixtureRule("fixture-rx-missing", "^a+b$");
	const streamFile = join(fixture.dir, "stream.sh");
	writeFileSync(streamFile, "echo a\n");
	try {
		await expect(runGate(fixture.dir, streamFile, join(fixture.dir, "missing-write-edit.md"))).rejects.toThrow();
	} finally { cleanup(fixture.dir); }
});
