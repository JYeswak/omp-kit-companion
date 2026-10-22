import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { join } from "node:path";
import { CASE_HEADER } from "../../src/case-corpus.ts";
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
		const fire = "schema-control\tfire\ttext\t-\t-\tSCHEMA_CONTROL_TOKEN\tpositive\t";
		const quiet = "schema-control\tquiet\ttext\t-\t-\tunrelated prose\tnegative\t";
		const run = (corpus: string) => {
			writeFileSync(cases, corpus);
			const child = Bun.spawnSync([process.execPath, join(ROOT, "scripts/ttsr-harness.ts"), "--gate-json", "--rules", rules, "--cases", cases], {
				cwd: ROOT, env: { ...process.env, OMP_SRC: omp.source, OMP_BIN: omp.launcher }, stdout: "pipe", stderr: "pipe", timeout: 30_000,
			});
			return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
		};
		const valid = run(`${CASE_HEADER}\r\n${fire}\r\n${quiet}\r\n`);
		expect(valid.code).toBe(0);
		const malformedHeader = run(`wrong${CASE_HEADER}\n${fire}\n${quiet}\n`);
		expect(malformedHeader.code).not.toBe(0);
		expect(malformedHeader.output).toContain("cases header");
		const shifted = run(`${CASE_HEADER}\n${fire}\t${JSON.stringify({ tracked: { "scripts/source.ts": "source" } })}\n${quiet}\n`);
		expect(shifted.code).not.toBe(0);
		expect(shifted.output).toContain("9 columns, need exactly 8");
	} finally {
		owned.cleanup();
	}
}, 120_000);
