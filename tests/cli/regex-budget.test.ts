import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OMP_SRC, loadRuleFile } from "../../scripts/rule-class.ts";
import { DEFAULT_ENCODINGS, DEFAULT_REFERENCE_FILE, DEFAULT_SHAPES, DEFAULT_SIZES, DEFAULT_WRITE_EDIT_STREAM_FILE, INCONCLUSIVE_EXIT_CODE, REFERENCE_RATIO_CLAMP, STREAM_BUDGET_MS, TRACKING_BAND, WRITE_EDIT_STREAM_BUDGET_MS, appliesToWriteEditStream, buildWriteEditWire, failsNearMissBudget, failsSingleCheckCeiling, failsStreamBudget, failsWriteEditStreamBudget, gateExitCode, judgeReference, judgeTracking, lintCondition, literalProbe, loadReference, medianMs, measureCondition, runGate, verdictLine } from "../../scripts/regex-budget.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");

function fixtureRule(name: string, condition: string): { dir: string; name: string; pattern: string } {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = ownedTmp("regex-budget-test", { root: scratchRoot }).path;
	const file = join(dir, name + ".md");
	writeFileSync(file, "---\ncondition: " + JSON.stringify(condition) + "\nscope: tool:bash\ninterruptMode: never\n---\nfixture rule\n");
	const loaded = loadRuleFile(file);
	return { dir, name: loaded.name, pattern: loaded.rule.condition?.[0] ?? "" };
}

/** Copy a real repo rule into an owned temp dir so the test replays its own fixture, never the live rules tree. */
function fixtureRuleCopy(fileName: string, source: string): { dir: string; name: string; pattern: string; scope: readonly string[] } {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = ownedTmp("regex-budget-test", { root: scratchRoot }).path;
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
			sizes: [4096, 8192, 16384], shapes: ["literal"], encodings: ["raw"], streamWire: "x".repeat(33), workerTimeoutMs: Math.round(fixtureDeadlineS(2) * 1000),
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

// REGEXREF1 (ompkit-fp72.120.16.186): the stream budget follows a same-moment frozen reference. Live host slowdown
// depends on host load, so the gated tests drive the judge through the timing seams; the taskpolicy -c background
// runs live in scripts/regex-budget-slowhost-evidence.sh, outside the suite.
const REGEX_BUDGET_SCRIPT = resolve(root, "scripts/regex-budget.ts");

type GateCliRun = { rc: number | null; verdict: string; liveLine: string; liveStatus: string; totalMs: number; budgetMs: number; ratio: number | null; text: string };

async function runGateCli(args: readonly string[], label: string): Promise<GateCliRun> {
	const result = await runFixtureAsync([process.execPath, "run", "--no-env-file", "--config=/dev/null", REGEX_BUDGET_SCRIPT, ...args], { cwd: root, floor_s: 120, label, env: { ...process.env, OMP_SRC } });
	const text = new TextDecoder().decode(result.stdout);
	const lines = text.split("\n");
	const liveLine = lines.find(line => line.startsWith("live stream: ")) ?? "";
	const totals = /median=([\d.]+)ms \/ ([\d.]+)ms/.exec(liveLine);
	if (!totals) throw new Error("REGEXREF1_LIVE_LINE_MISSING label=" + label + " rc=" + result.rc + " stderr=" + new TextDecoder().decode(result.stderr));
	const ratio = /\bratio=([\d.]+)/.exec(liveLine);
	console.log("REGEXREF1 " + label + " rc=" + result.rc + "\n" + lines[0] + "\n" + liveLine);
	return { rc: result.rc, verdict: lines[0] ?? "", liveLine, liveStatus: liveLine.split(" ")[2] ?? "", totalMs: Number(totals[1]), budgetMs: Number(totals[2]), ratio: ratio ? Number(ratio[1]) : null, text };
}

/** Heavy plant: copies until the quiet total is at least 2x the base budget. kit-no-gh-poll#1's calibration-run median
 * (rule_baseline.live in the reference fixture) is 111.548 ms: ceil(2 x 500 / 111.548) = 9 copies gives about 1004 ms,
 * on the boundary, so one more: 10 copies, about 1115 ms (2.23x). Past the 1.6x divergence bound, it FAILs on any host. */
const HEAVY_SLOW_RULE_COPIES = 10;
/** Near-budget plant: 5 copies, about 560-570 ms, 1.14x over budget: inside the measured reference/rule divergence. */
const NEAR_BUDGET_SLOW_RULE_COPIES = 5;

/** Rules that each carry the frozen kit-no-gh-poll#1 condition: a real slow stream rule set. */
function plantedSlowRules(copies: number): string {
	const fixture = JSON.parse(readFileSync(DEFAULT_REFERENCE_FILE, "utf8")) as { conditions: Array<{ rule: string; condition_index: number; pattern: string }> };
	const pattern = fixture.conditions.find(condition => condition.rule === "kit-no-gh-poll" && condition.condition_index === 1)?.pattern;
	if (!pattern) throw new Error("REGEXREF1 reference fixture lacks kit-no-gh-poll#1");
	mkdirSync(scratchRoot, { recursive: true });
	const dir = ownedTmp("regexref-slow-rule", { root: scratchRoot }).path;
	for (let copy = 1; copy <= copies; copy++) {
		const file = join(dir, "fixture-slow-gh-poll-" + copy + ".md");
		writeFileSync(file, "---\ncondition: " + JSON.stringify(pattern) + "\nscope: tool:bash\ninterruptMode: never\n---\nplanted slow rule copy " + copy + "\n");
		expect(loadRuleFile(file).rule.condition?.[0]).toBe(pattern);
	}
	return dir;
}

/** The planted set fails on the stream budget alone, and its reference-normalized cost exceeds the base budget. */
function expectSlowRuleFails(run: GateCliRun): void {
	expect(run.rc).toBe(1);
	expect(run.verdict).toBe("REGEX-BUDGET: FAIL");
	expect(run.liveStatus).toBe("FAIL");
	expect(run.ratio).not.toBeNull();
	expect(run.ratio!).toBeLessThanOrEqual(REFERENCE_RATIO_CLAMP);
	expect(Math.abs(run.budgetMs - STREAM_BUDGET_MS * Math.max(1, run.ratio!))).toBeLessThan(5);
	expect(run.totalMs).toBeGreaterThan(run.budgetMs);
	expect(run.totalMs / Math.max(1, run.ratio!)).toBeGreaterThan(STREAM_BUDGET_MS);
	const reportLine = run.text.split("\n").find(line => line.startsWith("JSON_REPORT="));
	if (!reportLine) throw new Error("REGEXREF1 JSON_REPORT missing");
	const report = JSON.parse(reportLine.slice("JSON_REPORT=".length)) as { reference: { status: string }; lint_violations: unknown[]; measurements: Array<{ status: string; failures: unknown[] }> };
	expect(report.reference.status).toBe("OK");
	expect(report.lint_violations).toEqual([]);
	for (const measurement of report.measurements) {
		expect(measurement.status).toBe("MEASURED");
		expect(measurement.failures).toEqual([]);
	}
}

test("REGEXREF1 planted slow rule: ten copies of kit-no-gh-poll#1 (2x over budget) FAIL on a quiet host by more than the divergence bound", async () => {
	const slowRuleQuietMs = loadReference().baseline?.live.find(row => row.rule === "kit-no-gh-poll" && row.condition_index === 1)?.ms;
	expect(slowRuleQuietMs).toBe(111.548);
	expect(Math.ceil(2 * STREAM_BUDGET_MS / slowRuleQuietMs!)).toBe(HEAVY_SLOW_RULE_COPIES - 1);
	const dir = plantedSlowRules(HEAVY_SLOW_RULE_COPIES);
	try {
		const run = await runGateCli(["--rules", dir], "heavy-slow-rule-quiet");
		expectSlowRuleFails(run);
		expect(run.totalMs / run.budgetMs).toBeGreaterThan(TRACKING_BAND);
	} finally { cleanup(dir); }
}, fixtureDeadlineS(120) * 1000);

// A 1.14x-over plant sits inside the measured reference/rule divergence (up to 1.385x): at reference ratio 1 (a quiet
// host) it must FAIL; on a slower host the scaled budget can cover it and the tracking guard reads INCONCLUSIVE. It must
// never PASS on any host. The suite runs on loaded hosts too (6d7575c212's verdict ran at ratio 2.69 and the gate
// correctly said INCONCLUSIVE rc 75), so the FAIL is required only when the run's own reference ratio is 1.
test("REGEXREF1 planted slow rule: five copies of kit-no-gh-poll#1 (1.14x over budget) FAIL on a quiet host and never PASS on a loaded one", async () => {
	const dir = plantedSlowRules(NEAR_BUDGET_SLOW_RULE_COPIES);
	try {
		const run = await runGateCli(["--rules", dir], "near-budget-slow-rule-quiet");
		expect(run.ratio).not.toBeNull();
		if (run.ratio! <= 1) {
			expectSlowRuleFails(run);
		} else {
			expect([1, INCONCLUSIVE_EXIT_CODE]).toContain(run.rc);
			expect(run.verdict.startsWith("REGEX-BUDGET: FAIL") || run.verdict.startsWith("REGEX-BUDGET: INCONCLUSIVE")).toBe(true);
			expect(run.liveStatus).not.toBe("PASS");
		}
	} finally { cleanup(dir); }
}, fixtureDeadlineS(120) * 1000);

/** Seam fixture calibration: a tiny reference (the frozen conditions over a one-line wire) calibrated at 100 ms, and an
 * unchanged rule whose calibration-run baseline is 400 ms. The seams then inject ref_now and per-rule stream times. */
const SEAM_CALIBRATED_MS = 100;
const SEAM_UNCHANGED_BASELINE_MS = 400;

/** One unchanged rule (in the tiny reference's baseline) plus `planted` new rules (not in it), a tiny stream and reference. */
function seamFixture(planted: number): { dir: string; streamFile: string; referenceFile: string } {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = ownedTmp("regexref-seam", { root: scratchRoot }).path;
	const ruleFile = (name: string) => {
		const file = join(dir, name + ".md");
		writeFileSync(file, "---\ncondition: " + JSON.stringify("^a+b$") + "\nscope: tool:bash\ninterruptMode: never\n---\nseam fixture rule\n");
		return loadRuleFile(file);
	};
	const unchanged = ruleFile("fixture-unchanged");
	for (let copy = 1; copy <= planted; copy++) ruleFile("fixture-planted-" + copy);
	const committed = JSON.parse(readFileSync(DEFAULT_REFERENCE_FILE, "utf8")) as { conditions: unknown[] };
	writeFileSync(join(dir, "ref-wire.txt"), "echo a\n");
	const referenceFile = join(dir, "reference.json");
	writeFileSync(referenceFile, JSON.stringify({
		conditions: committed.conditions,
		wire_file: "ref-wire.txt",
		ref_calibrated_ms: SEAM_CALIBRATED_MS,
		rule_baseline: {
			live: [{ rule: unchanged.name, condition_index: 0, pattern_sha256: createHash("sha256").update(unchanged.rule.condition?.[0] ?? "").digest("hex"), ms: SEAM_UNCHANGED_BASELINE_MS }],
			write_edit: [],
		},
	}));
	const streamFile = join(dir, "stream.sh");
	writeFileSync(streamFile, "echo a\n");
	return { dir, streamFile, referenceFile };
}

/** Judge the seam fixture on a host whose reference ran `refRatio` x slower, the unchanged rule `ruleSlowdown` x slower,
 * and each planted rule at `plantedQuietMs` quiet cost times `ruleSlowdown`. */
async function seamGate(fixture: { dir: string; streamFile: string; referenceFile: string }, refRatio: number, ruleSlowdown: number, plantedQuietMs = 0) {
	return runGate(fixture.dir, fixture.streamFile, undefined, {
		referenceFile: fixture.referenceFile,
		referenceSampleSeam: () => SEAM_CALIBRATED_MS * refRatio,
		streamTimingSeam: (_sample, rule) => (rule === "fixture-unchanged" ? SEAM_UNCHANGED_BASELINE_MS : plantedQuietMs) * ruleSlowdown,
	});
}

test("REGEXREF1 seam: the heavy plant on a host with a slowed reference FAILs by more than the divergence bound", async () => {
	// Ten copies of kit-no-gh-poll#1 at 111.548 ms quiet, carried by two planted rules (557.74 ms each).
	const fixture = seamFixture(2);
	try {
		// Rules as slow as the reference (5x), and rules slowed only 5/1.6x: the most the reference may outrun them.
		for (const ruleSlowdown of [5, 5 / TRACKING_BAND]) {
			const report = await seamGate(fixture, 5, ruleSlowdown, HEAVY_SLOW_RULE_COPIES * 111.548 / 2);
			expect(report.reference).toMatchObject({ status: "OK", ratio: 5, scale: 5 });
			expect(report.stream.budget_ms).toBe(5 * STREAM_BUDGET_MS);
			expect(report.status).toBe("FAIL");
			expect(gateExitCode(report)).toBe(1);
			expect(report.stream.total_ms / report.stream.budget_ms).toBeGreaterThan(TRACKING_BAND);
		}
	} finally { cleanup(fixture.dir); }
}, fixtureDeadlineS(60) * 1000);

test("REGEXREF1 seam: unchanged rules at reference ratio 5 PASS the scaled budget with tracking OK where the absolute judge refuses", async () => {
	const fixture = seamFixture(0);
	try {
		const report = await seamGate(fixture, 5, 4.5);
		expect(report.stream.total_ms).toBe(SEAM_UNCHANGED_BASELINE_MS * 4.5);
		// The absolute judge (fixed 500 ms) refuses this total; the scaled budget admits it.
		expect(failsStreamBudget(report.stream.total_ms)).toBe(true);
		expect(report.stream.budget_ms).toBe(5 * STREAM_BUDGET_MS);
		expect(report.stream.tracking).toMatchObject({ status: "OK", mix_ratio: 4.5, matched_conditions: 1 });
		expect(report.status).toBe("PASS");
		expect(gateExitCode(report)).toBe(0);
	} finally { cleanup(fixture.dir); }
}, fixtureDeadlineS(60) * 1000);

test("REGEXREF1 seam: a reference slowed 2.0x past the unchanged rules reads INCONCLUSIVE, never PASS", async () => {
	const fixture = seamFixture(0);
	try {
		const report = await seamGate(fixture, 5, 2.5);
		expect(report.stream.total_ms).toBeGreaterThan(STREAM_BUDGET_MS);
		expect(report.stream.total_ms).toBeLessThanOrEqual(report.stream.budget_ms);
		expect(report.stream.tracking).toMatchObject({ status: "DIVERGED", reason: "REFERENCE_TRACKING_DIVERGED", mix_ratio: 2.5 });
		expect(report.reference.ratio! / report.stream.tracking.mix_ratio!).toBe(2);
		expect(report.status).toBe("INCONCLUSIVE");
		expect(gateExitCode(report)).toBe(INCONCLUSIVE_EXIT_CODE);
		expect(verdictLine(report).startsWith("REGEX-BUDGET: INCONCLUSIVE REFERENCE_TRACKING_DIVERGED")).toBe(true);
	} finally { cleanup(fixture.dir); }
}, fixtureDeadlineS(60) * 1000);

test("REGEXREF1 reference judge: missing, NaN or 0 FAIL closed, a ratio past the clamp is INCONCLUSIVE, below 1 clamps to 1", () => {
	const committed = loadReference();
	expect(committed.loadError).toBeUndefined();
	expect(committed.reference?.patterns).toHaveLength(2);
	expect(committed.calibratedMs).toBeGreaterThan(0);
	// Committed fixture JSON, checked field by field below.
	const fixture = JSON.parse(readFileSync(DEFAULT_REFERENCE_FILE, "utf8")) as { calibration: Array<{ ref_ms: number; load1: number }> };
	const calibration = fixture.calibration;
	expect(calibration).toHaveLength(5);
	expect(medianMs(calibration.map(run => run.ref_ms))).toBe(committed.calibratedMs!);
	expect(calibration.every(run => Number.isFinite(run.load1))).toBe(true);
	expect(committed.baseline?.live.length).toBeGreaterThan(0);
	expect(committed.baseline?.write_edit.length).toBeGreaterThan(0);

	expect(judgeReference([], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_MISSING", scale: 1 });
	expect(judgeReference([100, 100, undefined, 100, 100], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_MISSING", scale: 1 });
	expect(judgeReference([100, 100, null, 100, 100], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_MISSING", scale: 1 });
	expect(judgeReference([100, Number.NaN, 100, 100, 100], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_NAN", scale: 1 });
	expect(judgeReference([100, Number.POSITIVE_INFINITY, 100, 100, 100], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_NAN", scale: 1 });
	expect(judgeReference([100, 0, 100, 100, 100], 100)).toMatchObject({ status: "FAIL", reason: "REFERENCE_ZERO", scale: 1 });
	expect(judgeReference([100], 0)).toMatchObject({ status: "FAIL", reason: "REFERENCE_CALIBRATION_INVALID", scale: 1 });
	expect(judgeReference([100], undefined)).toMatchObject({ status: "FAIL", reason: "REFERENCE_CALIBRATION_INVALID", scale: 1 });
	expect(REFERENCE_RATIO_CLAMP).toBe(8);
	expect(judgeReference([801, 801, 801, 801, 801], 100)).toMatchObject({ status: "INCONCLUSIVE", reason: "REFERENCE_RATIO_ABOVE_CLAMP", scale: 1 });
	expect(judgeReference([800, 800, 800, 800, 800], 100)).toMatchObject({ status: "OK", scale: 8 });
	// The median, not the max: one slow sample cannot buy a looser budget.
	expect(judgeReference([100, 100, 100, 100, 390], 100)).toMatchObject({ status: "OK", ref_now_ms: 100, scale: 1 });
	// A fast host keeps exactly the base budget, never a tighter or looser one.
	expect(judgeReference([50, 50, 50, 50, 50], 100)).toMatchObject({ status: "OK", ratio: 0.5, scale: 1 });
	expect(judgeReference([250, 250, 250, 250, 250], 100).scale).toBe(2.5);
	expect(failsStreamBudget(1250, STREAM_BUDGET_MS * 2.5)).toBe(false);
	expect(failsStreamBudget(1250.1, STREAM_BUDGET_MS * 2.5)).toBe(true);
	expect(failsStreamBudget(10, Number.NaN)).toBe(true);
	expect(failsWriteEditStreamBudget(10, Number.NaN)).toBe(true);
});

test("REGEXREF1 tracking guard: a reference that stops tracking the unchanged rules cannot buy budget", () => {
	const baseline = [
		{ rule: "a", condition_index: 0, pattern_sha256: "aa", ms: 100 },
		{ rule: "b", condition_index: 0, pattern_sha256: "bb", ms: 60 },
	];
	const tracked = [{ ...baseline[0]!, ms: 400 }, { ...baseline[1]!, ms: 240 }];
	expect(TRACKING_BAND).toBe(1.6);
	// The reference bought nothing (pass at the base budget, or a fail anyway): no check needed.
	expect(judgeTracking(tracked, baseline, 4, false)).toMatchObject({ status: "NOT_NEEDED", mix_ratio: 4 });
	expect(judgeTracking(tracked, baseline, 4, true)).toMatchObject({ status: "OK", mix_ratio: 4, matched_conditions: 2, matched_baseline_ms: 160 });
	expect(judgeTracking(tracked, baseline, 4 * 1.59, true).status).toBe("OK");
	expect(judgeTracking(tracked, baseline, 4 * 1.61, true)).toMatchObject({ status: "DIVERGED", reason: "REFERENCE_TRACKING_DIVERGED" });
	expect(judgeTracking(tracked, baseline, 4 / 1.61, true)).toMatchObject({ status: "DIVERGED", reason: "REFERENCE_TRACKING_DIVERGED" });
	expect(judgeTracking(tracked, baseline, 4 * 2, true).status).toBe("DIVERGED");
	// New or edited rules never count as host slowdown: a planted slow rule or a changed pattern stays unmatched.
	const planted = [...tracked, { rule: "slow", condition_index: 0, pattern_sha256: "ss", ms: 5000 }, { rule: "b", condition_index: 0, pattern_sha256: "edited", ms: 5000 }];
	expect(judgeTracking(planted, baseline, 4, true)).toMatchObject({ status: "OK", mix_ratio: 4, matched_conditions: 2 });
	expect(judgeTracking(tracked, undefined, 4, true)).toMatchObject({ status: "UNVERIFIED", reason: "REFERENCE_TRACKING_UNVERIFIED" });
	expect(judgeTracking([{ ...baseline[1]!, ms: 240 }], baseline, 4, true)).toMatchObject({ status: "UNVERIFIED", matched_baseline_ms: 60 });
	expect(judgeTracking(tracked, baseline, null, true).status).toBe("UNVERIFIED");
});

test("REGEXREF1 gate seam: an injected missing, NaN or 0 reference FAILs with its name and ratio > 8 is INCONCLUSIVE with exit 75", async () => {
	const fixture = seamFixture(0);
	const { dir, streamFile, referenceFile } = fixture;
	try {
		// Paired control: the same rule with an injected reference equal to calibration passes at the base budget.
		const control = await runGate(dir, streamFile, undefined, { referenceFile, referenceSampleSeam: () => SEAM_CALIBRATED_MS });
		expect(control.status).toBe("PASS");
		expect(control.reference).toMatchObject({ status: "OK", ratio: 1, scale: 1 });
		expect(control.stream.budget_ms).toBe(STREAM_BUDGET_MS);
		expect(gateExitCode(control)).toBe(0);
		for (const [injected, reason] of [[undefined, "REFERENCE_MISSING"], [Number.NaN, "REFERENCE_NAN"], [0, "REFERENCE_ZERO"]] as const) {
			const report = await runGate(dir, streamFile, undefined, { referenceFile, referenceSampleSeam: sample => sample === 2 ? injected : SEAM_CALIBRATED_MS });
			expect(report.status).toBe("FAIL");
			expect(report.reference.reason).toBe(reason);
			expect(report.stream.budget_ms).toBe(STREAM_BUDGET_MS);
			expect(gateExitCode(report)).toBe(1);
			expect(verdictLine(report).startsWith("REGEX-BUDGET: FAIL " + reason)).toBe(true);
		}
		const tooSlow = await seamGate(fixture, REFERENCE_RATIO_CLAMP + 1, REFERENCE_RATIO_CLAMP + 1);
		expect(tooSlow.status).toBe("INCONCLUSIVE");
		expect(tooSlow.reference.reason).toBe("REFERENCE_RATIO_ABOVE_CLAMP");
		expect(gateExitCode(tooSlow)).toBe(INCONCLUSIVE_EXIT_CODE);
		expect(verdictLine(tooSlow).startsWith("REGEX-BUDGET: INCONCLUSIVE REFERENCE_RATIO_ABOVE_CLAMP")).toBe(true);
		const noFixture = await runGate(dir, streamFile, undefined, { referenceFile: join(dir, "missing-reference.json") });
		expect(noFixture.status).toBe("FAIL");
		expect(noFixture.reference.reason).toBe("REFERENCE_MISSING");
		expect(noFixture.reference.load_error).toBeDefined();
	} finally { cleanup(dir); }
}, fixtureDeadlineS(60) * 1000);
