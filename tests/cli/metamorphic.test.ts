import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let pack = "";
let environment: Record<string, string>;

const PLANTED_RULE = `---
condition:
  - 'secret-token-xyz'
scope: tool:bash
interruptMode: never
---
Planted rule that fires even inside quotes.
`;

const CASES_HEADER = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n";

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	mkdirSync(join(import.meta.dir, "../../var/agent-tmp"), { recursive: true });
	base = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "omp-kit-metamorphic-"));
	const release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	pack = join(base, "pack");
	for (const directory of [join(release, "bin"), join(release, "scripts"), join(pack, "rules"),
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeFileSync(join(pack, "rules", "plant-quoted.md"), PLANTED_RULE);
	writeFileSync(join(pack, "cases.tsv"), CASES_HEADER +
		"plant-quoted\tfire\ttool\tbash\t-\trun secret-token-xyz now\tfires unquoted\n" +
		"plant-quoted\tquiet\ttool\tbash\t-\trun everything else now\tunrelated command\n");
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	environment = {
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

type MetamorphicEnvelope = {
	data?: {
		overall?: string;
		metamorphic?: { status?: string; counts?: { cases?: number; variants?: number; breaks?: number; skipped?: number; fresh?: number; stale?: number };
			breaks?: { rule?: string; line?: number; relation?: string; variant?: string; expected?: string; observed?: string }[];
			new_breaks?: { rule?: string; line?: number; relation?: string; variant?: string }[] };
	};
	errors?: { code?: string }[];
};

function runCli(args: string[]): { exitCode: number; envelope: MetamorphicEnvelope } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as MetamorphicEnvelope };
}

function metamorphic(args: string[]) {
	const { exitCode, envelope } = runCli(["test", "--metamorphic",
		"--rules", join(pack, "rules"), "--cases", join(pack, "cases.tsv"), "--json", ...args]);
	return { exitCode, report: envelope.data?.metamorphic };
}

test("a rule that fires inside quotes reports the exact quoting breaks and exits 1", () => {
	const { exitCode, report } = metamorphic([]);
	expect(exitCode).toBe(1);
	expect(report?.status).toBe("FAIL");
	const breaks = report?.breaks ?? [];
	expect(breaks.length).toBeGreaterThan(0);
	expect(breaks.every(entry => entry.rule === "plant-quoted")).toBe(true);
	expect(breaks.every(entry => entry.relation === "quoting")).toBe(true);
	expect(breaks.every(entry => entry.expected === "quiet" && entry.observed === "fire")).toBe(true);
	expect(breaks.map(entry => entry.variant).sort()).toEqual([
		`echo "run secret-token-xyz now"`,
		`printf '%s\\n' "run secret-token-xyz now"`,
	]);
	expect(report?.counts).toMatchObject({ cases: 2 });
}, 120_000);

test("test --metamorphic refuses incompatible flags without measuring", () => {
	for (const flag of ["--full", "--record"]) {
		const { exitCode, envelope } = runCli(["test", "--metamorphic", flag, "--json"]);
		expect(exitCode).toBe(2);
		expect(envelope.errors?.[0]?.code).toBe("INVALID_FLAG");
	}
	const { exitCode, envelope } = runCli(["test", "--metamorphic", "--project", "/absent", "--json"]);
	expect(exitCode).toBe(2);
	expect(envelope.errors?.[0]?.code).toBe("INVALID_FLAG");
}, 120_000);

test("strict zero-break gate fails on a planted fresh break", () => {
	const planted = join(pack, "rules", "plant-fresh.md");
	writeFileSync(planted, `---\ncondition:\n  - 'fresh-ratchet-token'\nscope: tool:bash\ninterruptMode: never\n---\nPlanted fresh break.\n`);
	writeFileSync(join(pack, "cases.tsv"), CASES_HEADER + "plant-fresh\tquiet\ttool\tbash\t-\techo fresh-ratchet-token\tplanted quiet case\n");
	const { exitCode, report } = metamorphic([]);
	expect(exitCode).toBe(1);
	expect(report?.status).toBe("FAIL");
	expect(report?.breaks.length).toBeGreaterThan(0);
}, 120_000);

test("text-scope cases have no shell relations: prose in quotes still fires, nothing counted", () => {
	const textPack = join(base, "textpack");
	mkdirSync(join(textPack, "rules"), { recursive: true });
	writeFileSync(join(textPack, "rules", "plant-prose.md"), `---\ncondition:\n  - 'sign-off token'\nscope: text\ninterruptMode: never\n---\nPlanted prose rule.\n`);
	writeFileSync(join(textPack, "cases.tsv"), CASES_HEADER +
		"plant-prose\tfire\ttext\t-\t-\tWe have sign-off token now\tprose claim\n");
	const { exitCode, envelope } = runCli(["test", "--metamorphic",
		"--rules", join(textPack, "rules"), "--cases", join(textPack, "cases.tsv"), "--json"]);
	expect(exitCode).toBe(0);
	expect(envelope.data?.metamorphic?.status).toBe("PASS");
	expect(envelope.data?.metamorphic?.counts).toMatchObject({ cases: 0, breaks: 0 });
	expect(envelope.data?.metamorphic?.counts?.skipped).toBeGreaterThanOrEqual(5);
}, 120_000);
