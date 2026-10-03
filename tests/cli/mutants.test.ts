import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let release = "";
let pack = "";
let environment: Record<string, string>;

const RULE = `---
condition:
  - 'alpha|beta'
scope: tool:bash
interruptMode: never
---
Fixture rule with a branch no case covers.
`;

const CASES_HEADER = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n";

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	base = mkdtempSync(join(tmpdir(), "omp-kit-mutants-"));
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	pack = join(base, "pack");
	mkdirSync(join(pack, "rules"), { recursive: true });
	for (const directory of [join(release, "bin"), join(release, "scripts"),
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeFileSync(join(pack, "rules", "mut-test.md"), RULE);
	writeFileSync(join(pack, "cases.tsv"), CASES_HEADER +
		"mut-test\tfire\ttool\tbash\t-\trun alpha now\tcovers branch one\n" +
		"mut-test\tquiet\ttool\tbash\t-\trun gamma now\tunrelated command\n");
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(binary, 0o755);
	environment = {
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin", OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

function runCli(args: string[]): { exitCode: number; envelope: Record<string, unknown> } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Record<string, unknown> };
}

type MutantReport = { rules?: { rule?: string; cases?: number; mutants?: number; killed?: number;
	score?: number | null; skipped_compile?: number; baseline_failures?: number;
	survivors?: { kind?: string; edit?: string }[] }[];
	totals?: { mutants?: number; killed?: number; score?: number | null };
	truncated?: boolean; budget_secs?: number };

function mutantsOf(envelope: Record<string, unknown>): MutantReport {
	return (envelope.data as { mutants?: MutantReport }).mutants ?? {};
}

function ruleReport(report: MutantReport, name: string): NonNullable<MutantReport["rules"]>[number] {
	const row = report.rules?.find(entry => entry.rule === name);
	if (!row) throw new Error(`missing mutants row ${name}`);
	return row;
}

test("mutants report the known survivor of an uncovered branch", () => {
	const { exitCode, envelope } = runCli(["test", "--mutants",
		"--rules", join(pack, "rules"), "--cases", join(pack, "cases.tsv"), "--json"]);
	expect(exitCode).toBe(0);
	expect((envelope.data as { overall?: string }).overall).toBe("OK");
	const report = mutantsOf(envelope);
	expect(report.truncated).toBe(false);
	const row = ruleReport(report, "mut-test");
	expect(row.cases).toBe(2);
	expect(row.baseline_failures).toBe(0);
	expect(row.mutants).toBeGreaterThan(0);
	expect(row.survivors?.map(s => s.edit)).toContain("drop alternation branch 2/2");
	expect(row.score).toBeLessThan(1);
}, 300_000);

test("adding the missing near-miss case kills the known survivor", () => {
	const casesB = join(pack, "cases-b.tsv");
	writeFileSync(casesB, readFileSync(join(pack, "cases.tsv"), "utf8") +
		"mut-test\tfire\ttool\tbash\t-\trun beta now\tcovers branch two\n");
	const { exitCode, envelope } = runCli(["test", "--mutants",
		"--rules", join(pack, "rules"), "--cases", casesB, "--json"]);
	expect(exitCode).toBe(0);
	const row = ruleReport(mutantsOf(envelope), "mut-test");
	expect(row.cases).toBe(3);
	expect(row.survivors?.map(s => s.edit)).not.toContain("drop alternation branch 2/2");
	expect(row.survivors?.map(s => s.edit)).not.toContain("drop alternation branch 1/2");
}, 300_000);

test("uncompilable mutants are skipped and counted", () => {
	const dir = join(pack, "group-rules");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "mut-group.md"), `---\ncondition:\n  - '(?<t>ab)+'\nscope: tool:bash\ninterruptMode: never\n---\nNamed group fixture: deleting the one-char group name is uncompilable.\n`);
	writeFileSync(join(pack, "cases-group.tsv"), CASES_HEADER +
		"mut-group\tfire\ttool\tbash\t-\trun abab now\tcovers the group\n");
	const { exitCode, envelope } = runCli(["test", "--mutants",
		"--rules", dir, "--cases", join(pack, "cases-group.tsv"), "--json"]);
	expect(exitCode).toBe(0);
	const row = ruleReport(mutantsOf(envelope), "mut-group");
	expect(row.skipped_compile).toBeGreaterThan(0);
}, 300_000);

test("the budget flag bounds the run and reports truncation", () => {
	const dir = join(pack, "heavy-rules");
	mkdirSync(dir, { recursive: true });
	const branches = Array.from({ length: 20_000 }, (_, i) => `b${i}zz`);
	writeFileSync(join(dir, "mut-heavy.md"),
		`---\ncondition:\n  - '${branches.join("|")}'\nscope: tool:bash\ninterruptMode: never\n---\nHeavy budget fixture.\n`);
	writeFileSync(join(pack, "cases-heavy.tsv"), CASES_HEADER +
		"mut-heavy\tfire\ttool\tbash\t-\trun b0zz now\tcovers branch one\n");
	const bounded = runCli(["test", "--mutants", "--mutant-budget-secs", "1",
		"--rules", dir, "--cases", join(pack, "cases-heavy.tsv"), "--json"]);
	expect(bounded.exitCode).toBe(0);
	expect(mutantsOf(bounded.envelope).truncated).toBe(true);
}, 300_000);
