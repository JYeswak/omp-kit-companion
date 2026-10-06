import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintCondition } from "../../scripts/regex-budget.ts";
import { loadRuleFile } from "../../scripts/rule-class.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");
const ruleNames = [
	"bash-pipe-exit",
	"kit-close-reason-no-evidence",
	"kit-no-force-push",
	"kit-no-pattern-kill",
	"kit-no-verify",
	"kit-scratch-tmp",
	"kit-settings-mutation",
];

const cases: [string, "fire" | "quiet", string, string][] = [
	["kit-scratch-tmp", "fire", "tool", "pwd\\n\\tcat >/tmp/rx2-scratch"],
	["kit-scratch-tmp", "quiet", "tool", "printf '%s' '>/tmp/rx2-scratch'"],
	["kit-no-verify", "fire", "tool", "pwd\\n\\tgit commit --no-verify"],
	["kit-no-verify", "quiet", "tool", "printf '%s' 'git commit --no-verify'"],
	["bash-pipe-exit", "fire", "tool", "pwd\\n\\tfalse | head -1; echo $?"],
	["bash-pipe-exit", "quiet", "tool", "printf '%s' 'false | head -1; echo $?'"],
	["kit-settings-mutation", "fire", "tool", "pwd\\n\\tomp config set ttsr.enabled false"],
	["kit-settings-mutation", "quiet", "tool", "printf '%s' 'omp config set ttsr.enabled false'"],
	["kit-close-reason-no-evidence", "fire", "tool", "pwd\\n\\tbr close issue-123 --reason done"],
	["kit-close-reason-no-evidence", "quiet", "tool", "br close issue-123 --reason 'bun test tests/cli/ttsr-harness.test.ts -> 23 passed'"],
	["kit-no-pattern-kill", "fire", "tool", "pwd\\n\\tpkill node"],
	["kit-no-pattern-kill", "quiet", "tool", "echo 'never pkill node'"],
	["kit-no-force-push", "fire", "tool", "pwd\\n\\tgit push --force origin main"],
	["kit-no-force-push", "quiet", "tool", "pwd\\n\\tgit push --force-with-lease origin main"],
];

function makeFixture(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "rx2-rules-test-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=rx2-rules-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const rulesDir = join(dir, "rules");
	mkdirSync(rulesDir);
	for (const name of ruleNames) copyFileSync(join(root, "rules", `${name}.md`), join(rulesDir, `${name}.md`));
	const rows = ["rule\texpect\tsource\ttool\tpath\tsnippet\tnote"];
	for (const [rule, expected, source, snippet] of cases) {
		rows.push([rule, expected, source, "bash", "-", snippet, "RX2 escaped boundary"].join("\t"));
	}
	writeFileSync(join(dir, "cases.tsv"), `${rows.join("\n")}\n`);
	return dir;
}

const cleanup = (dir: string) => { if (dir) rmSync(dir, { recursive: true, force: true }); };

test("RX2 bash conditions are literal-first without unsafe leading assertions", () => {
	const violations = ruleNames.flatMap(name => {
		const loaded = loadRuleFile(join(root, "rules", `${name}.md`));
		return (loaded.rule.condition ?? []).flatMap((pattern, conditionIndex) =>
			lintCondition(pattern).map(code => `${name}#${conditionIndex}: ${code}`),
		);
	});
	expect(violations).toEqual([]);
});

test("RX2 rules preserve fire and quiet behavior on JSON-escaped newline and tab boundaries", () => {
	const fixture = makeFixture();
	try {
		const run = Bun.spawnSync(
			[process.execPath, join(root, "scripts/ttsr-harness.ts"), "--gate-json", "--rules", join(fixture, "rules"), "--cases", join(fixture, "cases.tsv")],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = new TextDecoder().decode(run.stdout);
		const stderr = new TextDecoder().decode(run.stderr);
		let report: { status?: string; failures?: string[]; checks?: { payload?: { passed?: number }; prefix?: { passed?: number } } };
		try { report = JSON.parse(stdout); } catch { throw new Error(`TTSR gate did not emit JSON (exit ${run.exitCode}):\n${stdout}\n${stderr}`); }
		expect(report.status, `${stdout}\n${stderr}`).toBe("PASS");
		expect(report.failures).toEqual([]);
		expect(report.checks?.payload?.passed).toBe(cases.length);
		expect(report.checks?.prefix?.passed).toBe(cases.length);
	} finally { cleanup(fixture); }
});
