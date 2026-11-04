import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { join } from "node:path";
import { CASE_HEADER, parseCaseCorpus } from "../../src/case-corpus.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

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
