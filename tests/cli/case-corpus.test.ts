import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { join } from "node:path";
import { CASE_HEADER, parseCaseCorpus, type CorpusCase } from "../../src/case-corpus.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { loadRules } from "../../scripts/rule-class.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const ROOT = join(import.meta.dir, "../..");

test("native harness rejects malformed corpus shape without discarding shifted facts", () => {
	const omp = resolveOmpIdentity(process.env);
	const owned = ownedTmp("case-corpus", { root: join(ROOT, "var/agent-tmp") });
	const root = owned.path;
	try {
		const rules = join(root, "rules");
		const cases = join(root, "cases.tsv");
		mkdirSync(rules);
		writeFileSync(join(rules, "schema-control.md"), "---\ncondition:\n  - 'SCHEMA_CONTROL_TOKEN'\nscope: text\ninterruptMode: never\n---\nIndependent SDK schema control.\n");
		writeFileSync(join(rules, "read-control.md"), "---\ncondition:\n  - '\"path\":\"control\\.jsonl\\?q=group_by'\nscope: tool:read\ninterruptMode: always\n---\nGroup complete records only after slurping.\n");
		const fire = "schema-control\tfire\ttext\t-\t-\tSCHEMA_CONTROL_TOKEN\tpositive\t";
		const quiet = "schema-control\tquiet\ttext\t-\t-\tunrelated prose\tnegative\t";
		const readFire = "read-control\tfire\ttool\tread\tcontrol.jsonl\tcontrol.jsonl?q=group_by(.status)\tread path serialized as JSON\t";
		const readQuiet = "read-control\tquiet\ttool\tread\tcontrol.jsonl\tcontrol.jsonl?q=.status\tper-record projection\t";
		const controls = `${fire}\n${quiet}\n${readFire}\n${readQuiet}\n`;
		const run = (corpus: string) => {
			writeFileSync(cases, corpus);
			const child = Bun.spawnSync([process.execPath, join(ROOT, "scripts/ttsr-harness.ts"), "--gate-json", "--rules", rules, "--cases", cases], {
				cwd: ROOT, env: { ...process.env, OMP_SRC: omp.source, OMP_BIN: omp.launcher }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
			});
			return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
		};
		const valid = run(`${CASE_HEADER}\n${controls}`);
		expect(valid.code).toBe(0);
		const malformedHeader = run(`wrong${CASE_HEADER}\n${fire}\n${quiet}\n`);
		expect(malformedHeader.code).not.toBe(0);
		expect(malformedHeader.output).toContain("cases header");
		const shifted = run(`${CASE_HEADER}\n${fire}\t${JSON.stringify({ tracked: { "scripts/source.ts": "source" } })}\n${quiet}\n`);
		expect(shifted.code).not.toBe(0);
		expect(shifted.output).toContain("9 columns, need exactly 8");
		const unknown = run(`${CASE_HEADER}\n${controls}schema-control\tquiet\ttool\tunknown-tool\t-\tx\tnegative\t\n`);
		expect(unknown.code).not.toBe(0);
		expect(unknown.output).toContain("tool=unknown-tool");
	} finally {
		owned.cleanup();
	}
}, 120_000);

test("eval is a supported corpus tool without opening the tool enum", () => {
	const row = (tool: string) => `${CASE_HEADER}\ncontrol\tquiet\ttool\t${tool}\t-\tprint(out[:800])\teval carrier\t\n`;
	const admitted = parseCaseCorpus(row("eval"));
	expect(admitted.errors).toEqual([]);
	expect(admitted.cases[0]?.tool).toBe("eval");
	const unknown = parseCaseCorpus(row("unknown-tool"));
	expect(unknown.errors).toEqual(["cases line 2: tool=unknown-tool"]);
});

test("read is a supported corpus tool while unknown tools remain rejected", () => {
	const row = (tool: string) => `${CASE_HEADER}\ncontrol\tquiet\ttool\t${tool}\tissues.jsonl\tissues.jsonl?q=.status\tread carrier\t\n`;
	const admitted = parseCaseCorpus(row("read"));
	expect(admitted.errors).toEqual([]);
	expect(admitted.cases[0]?.tool).toBe("read");
	const unknown = parseCaseCorpus(row("unknown-tool"));
	expect(unknown.errors).toEqual(["cases line 2: tool=unknown-tool"]);
});

for (const tool of ["grep", "todo"]) {
	test(`${tool} is a supported raw-argument corpus tool while unknown tools remain rejected`, () => {
		const row = (name: string) => `${CASE_HEADER}\ncontrol\tquiet\ttool\t${name}\t-\t{}\traw argument carrier\t\n`;
		const admitted = parseCaseCorpus(row(tool));
		expect(admitted.errors).toEqual([]);
		expect(admitted.cases[0]?.tool).toBe(tool);
		expect(parseCaseCorpus(row("unknown-tool")).errors).toEqual(["cases line 2: tool=unknown-tool"]);
	});
}

type Observation = { status: string; case_line: number; whole?: string; prefix?: unknown; reason?: string };

// This is also the planted timeout's consumer: an unavailable evaluator must not
// pass just because a separate literal matcher agrees with the authored rows.
async function nativeCorpusRows(rules: string, cases: string, rows: CorpusCase[], timeoutMs = 30_000, clockBoundControl?: string): Promise<void> { // product-deadline: exercise the observer's unchanged 30 s native-evaluator limit.
	const omp = resolveOmpIdentity(process.env);
	const child = await runFixtureAsync([
		process.execPath, join(ROOT, "scripts/ttsr-harness.ts"), "--observe",
		"--rules", rules, "--cases", cases, "--rule", rows[0]!.rule,
		"--lines", rows.map(row => row.line).join(","), "--timeout-ms", String(timeoutMs),
	], {
		cwd: ROOT, env: { ...process.env, OMP_SRC: omp.source, OMP_BIN: omp.launcher, TTSR_TEST_CLOCK_BOUND_CONTROL: clockBoundControl },
		floor_s: 40, label: `native corpus ${rows[0]!.rule}`,
	});
	const stdout = new TextDecoder().decode(child.stdout);
	const stderr = new TextDecoder().decode(child.stderr);
	if (child.rc !== 0 || child.truncated) throw new Error(`native corpus rc=${child.rc}: ${stdout}${stderr}`);
	const observations = JSON.parse(stdout) as Observation[];
	expect(observations.length, stdout).toBe(rows.length);
	for (const [index, row] of rows.entries()) {
		const observation = observations[index]!;
		expect(observation.status, stdout).toBe("OK");
		expect(observation.case_line, stdout).toBe(row.line);
		expect(observation.whole, `${row.rule}:${row.line} ${stdout}`).toBe(row.expect);
		if (row.expect === "quiet") expect(observation.prefix, stdout).toBeNull();
	}
}

const authoredCasesFile = join(ROOT, "cases/cases.tsv");
const authored = parseCaseCorpus(readFileSync(authoredCasesFile, "utf8"));
test("native corpus never discards malformed authored rows", () => {
	expect(authored.errors).toEqual([]);
});
for (const rule of loadRules(join(ROOT, "rules")).filter(rule => rule.cls !== "always")) {
	test(`native corpus observes every authored row for ${rule.name}`, async () => {
		const rows = authored.cases.filter(row => row.rule === rule.name);
		expect(rows.some(row => row.expect === "fire")).toBe(true);
		expect(rows.some(row => row.expect === "quiet")).toBe(true);
		await nativeCorpusRows(join(ROOT, "rules"), authoredCasesFile, rows);
	}, fixtureDeadlineS(45) * 1000);
}

test("native observer resolves standalone source before entering its private HOME", async () => {
	const omp = resolveOmpIdentity(process.env);
	const row = authored.cases.find(row => row.rule === "kit-jsonl-aggregate" && row.expect === "fire")!;
	const child = await runFixtureAsync([
		process.execPath, join(ROOT, "scripts/ttsr-harness.ts"), "--observe",
		"--rule", row.rule, "--line", String(row.line),
	], { cwd: ROOT, env: { ...process.env, OMP_SRC: undefined }, floor_s: 40 });
	const output = new TextDecoder().decode(child.stdout);
	expect(child.rc, output + new TextDecoder().decode(child.stderr)).toBe(0);
	expect(JSON.parse(output)).toMatchObject({
		status: "OK", whole: "fire", bindings: { omp_source: omp.source },
	});
}, fixtureDeadlineS(45) * 1000);

test("native corpus rejects a native timeout and accepts the same rule's quiet control", async () => {
	const owned = ownedTmp("native-corpus-timeout", { root: join(ROOT, "var/agent-tmp") });
	try {
		const rules = join(owned.path, "rules");
		const cases = join(owned.path, "cases.tsv");
		mkdirSync(rules);
		writeFileSync(join(rules, "timeout-plant.md"), "---\ncondition:\n  - 'NATIVE_TIMEOUT_TOKEN'\nscope: tool:bash\ninterruptMode: never\n---\nNative evaluator deadline plant.\n");
		writeFileSync(cases, `${CASE_HEADER}\ntimeout-plant\tfire\ttool\tbash\t-\t${"a".repeat(8 * 1024)} NATIVE_TIMEOUT_TOKEN\tlong native fire\t\n`
			+ "timeout-plant\tquiet\ttool\tbash\t-\techo b\tquick native rejection\t\n");
		const parsed = parseCaseCorpus(readFileSync(cases, "utf8"));
		expect(parsed.errors).toEqual([]);
		// Existing CPU-bound injection runs inside the isolated native evaluator.
		// JavaScriptCore bounds some catastrophic regexes itself, so those are not
		// a portable timeout plant. The healthy run proves this rule really fires.
		await nativeCorpusRows(rules, cases, parsed.cases);
		await expect(nativeCorpusRows(rules, cases, [parsed.cases[0]!], 1_500, "slow-fire")).rejects.toThrow("EVALUATOR_TIMEOUT");
		await nativeCorpusRows(rules, cases, [parsed.cases[1]!]);
	} finally {
		owned.cleanup();
	}
}, fixtureDeadlineS(90) * 1000);
