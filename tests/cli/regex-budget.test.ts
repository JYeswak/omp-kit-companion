import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRuleFile } from "../../scripts/rule-class.ts";
import { failsNearMissBudget, failsStreamBudget, lintCondition, literalProbe, measureCondition, regexLoadBlockReason, runGate } from "../../scripts/regex-budget.ts";

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
			resolve(root, "scripts/regex-budget.ts"), "--rules", fixture.dir, "--stream", streamFile, "--judge-regardless-of-load",
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
