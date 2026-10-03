import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRuleFile } from "../../scripts/rule-class.ts";
import { failsNearMissBudget, failsStreamBudget, lintCondition, literalProbe, measureCondition } from "../../scripts/regex-budget.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");

function fixtureRule(name: string, condition: string): { dir: string; name: string; pattern: string } {
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

test("fixture rule with (a+)+b is bounded and reported as a near-miss failure", async () => {
	const fixture = fixtureRule("fixture-quadratic", "(a+)+b");
	try {
		const result = await measureCondition({
			rule: fixture.name, conditionIndex: 0, pattern: fixture.pattern,
			sizes: [4096, 8192, 16384], shapes: ["literal"], encodings: ["raw"], workerTimeoutMs: 2_000,
		});
		expect(result.rule).toBe("fixture-quadratic");
		expect(result.failures.map(f => f.code)).toContain("NEAR_MISS_TIMEOUT");
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
