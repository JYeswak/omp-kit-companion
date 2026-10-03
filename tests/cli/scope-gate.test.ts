import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("scope gate keeps text rules out of tool streams", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "scope-gate-"));
	try {
		const rules = join(root, "rules");
		mkdirSync(rules, { recursive: true });
		writeFileSync(join(rules, "plant-text.md"), "---\ncondition:\n  - 'fresh-scope-token'\nscope: text\ninterruptMode: never\n---\nPlanted out-of-scope rule.\n");
		const cases = join(root, "cases.tsv");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\nplant-text\tfire\ttext\t-\t-\tfresh-scope-token\ttext control\nplant-text\tquiet\ttool\tbash\t-\techo fresh-scope-token\ttool must stay quiet\n");
		const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../../scripts/ttsr-harness.ts"), "--gate-json", "--rules", rules, "--cases", cases], { cwd: join(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
		const report = JSON.parse(result.stdout.toString()) as { status?: string; counts?: { cases?: number; quiet_prefix_fires?: number }; failures?: string[] };
		expect(report.status).toBe("PASS");
		expect(report.counts).toMatchObject({ cases: 2, quiet_prefix_fires: 0 });
		expect(report.failures).toEqual([]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
