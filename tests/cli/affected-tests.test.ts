import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";

// CIGATE1 (ompkit-v66l.27.1): the selector the pre-push gate uses to pick the tests a diff affects.
const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const selector = join(root, "scripts/affected-tests.ts");

const owned: OwnedTmp[] = [];
afterAll(() => {
	for (const t of owned) t.cleanup();
});

function tree(files: Record<string, string>): string {
	const t = ownedTmp("affected-tests", { root: scratchRoot });
	owned.push(t);
	const dir = t.path;
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), body);
	}
	return dir;
}

function select(dir: string, changed: string[], script = selector): { code: number; tests: string[]; err: string } {
	const result = Bun.spawnSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", script, "--root", dir, "--explain", ...changed.flatMap((path) => ["--changed-file", path])], { stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, tests: result.stdout.toString().split("\n").filter(Boolean), err: result.stderr.toString() };
}

const FILES: Record<string, string> = {
	"src/leaf.ts": "export const leaf = 1;\n",
	"src/mid.ts": 'import { leaf } from "./leaf.js";\nexport const mid = leaf + 1; // see docs/guide.md\n',
	"src/cli.ts": 'import { mid } from "./mid.ts";\nconsole.log(mid);\n',
	"src/runner.ts": 'export const script = "scripts/tool.sh";\n',
	"scripts/tool.sh": "#!/bin/sh\necho tool\n",
	"docs/guide.md": "# guide\n",
	"tests/cli/leaf.test.ts": 'import { leaf } from "../../src/leaf.ts";\nleaf;\n',
	"tests/cli/via-cli.test.ts": 'import "../../src/cli.ts";\n',
	"tests/cli/spawn-cli.test.ts": 'const cli = resolve(import.meta.dir, "../../src/cli.ts");\n',
	"tests/cli/runner.test.ts": 'import { script } from "../../src/runner.ts";\nscript;\n',
	"tests/cli/docs.test.ts": 'readFileSync("docs/guide.md");\n',
	"tests/cli/helper.ts": 'export const help = 1;\n',
	"tests/cli/uses-helper.test.ts": 'import { help } from "./helper.ts";\nhelp;\n',
	"tests/fixtures/sample.test.ts": "fixture input, never a suite\n",
	"tests/cli/tool.test.sh": '#!/bin/sh\nsh "$ROOT/scripts/tool.sh"\n',
	"tests/scripts/runner_test.py": 'open("src/runner.ts")\n',
};

test("imports are followed transitively; a test that names a file runs only when that file changes", () => {
	const dir = tree(FILES);
	try {
		// leaf <- mid (via ./leaf.js meaning leaf.ts) <- cli <- via-cli; spawn-cli names cli.ts, so it is not pulled by leaf.
		const leaf = select(dir, ["src/leaf.ts"]);
		expect(leaf.code).toBe(0);
		expect(leaf.tests).toEqual(["tests/cli/leaf.test.ts", "tests/cli/via-cli.test.ts"]);
		expect(leaf.err).toContain("affected: tests/cli/via-cli.test.ts <- src/leaf.ts");
		expect(select(dir, ["src/cli.ts"]).tests).toEqual(["tests/cli/spawn-cli.test.ts", "tests/cli/via-cli.test.ts"]);
		// A script a source names is a dependency of that source and of the tests importing it; a shell
		// suite naming "$ROOT/scripts/tool.sh" runs too.
		expect(select(dir, ["scripts/tool.sh"]).tests).toEqual(["tests/cli/runner.test.ts", "tests/cli/tool.test.sh"]);
		expect(select(dir, ["src/runner.ts"]).tests).toEqual(["tests/cli/runner.test.ts", "tests/scripts/runner_test.py"]);
		expect(select(dir, ["tests/cli/helper.ts"]).tests).toEqual(["tests/cli/uses-helper.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a docs path in source is a pointer, not a dependency; a test reading the doc still runs", () => {
	const dir = tree(FILES);
	try {
		expect(select(dir, ["docs/guide.md"]).tests).toEqual(["tests/cli/docs.test.ts"]);
		expect(select(dir, ["CHANGELOG.md", "changelog.d/x.md"]).tests).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("changed tests run themselves; deleted paths and fixture trees select nothing", () => {
	const dir = tree(FILES);
	try {
		expect(select(dir, ["tests/cli/leaf.test.ts"]).tests).toEqual(["tests/cli/leaf.test.ts"]);
		expect(select(dir, ["tests/cli/gone.test.ts", "src/gone.ts"]).tests).toEqual([]);
		expect(select(dir, ["tests/fixtures/sample.test.ts"]).tests).toEqual([]);
		const bad = select(join(dir, "missing"), ["src/leaf.ts"]);
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("--root is not a directory");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mutant: without transitive import edges, a src change misses the test that reaches it through cli.ts", () => {
	const dir = tree(FILES);
	try {
		const source = readFileSync(selector, "utf8");
		const oneHop = source.replace("for (const next of importers.get(node) ?? []) {", "for (const next of node === start ? importers.get(node) ?? [] : []) {");
		expect(oneHop).not.toBe(source);
		const mutant = join(dir, "mutant-selector.ts");
		writeFileSync(mutant, oneHop);
		expect(select(dir, ["src/leaf.ts"], mutant).tests).toEqual(["tests/cli/leaf.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wall-budget plan keeps changed tests and the nearest importers, and defers the rest by name", () => {
	const dir = tree({ "timings.json": JSON.stringify({ version: 1, files: { "tests/a.test.ts": 50_000, "tests/b.test.ts": 50_000, "tests/c.test.ts": 50_000, "tests/big.test.ts": 400_000 } }) });
	try {
		const plan = (budget: number, tests: string[], changed: string[] = [], script = selector) => {
			const deferred = join(dir, `deferred-${Math.random().toString(36).slice(2)}`);
			const result = Bun.spawnSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", script, "--plan", "--budget-secs", String(budget), "--workers", "2", "--timings", join(dir, "timings.json"), "--deferred-out", deferred, ...changed.flatMap((path) => ["--changed-file", path]), "--", ...tests], { stdout: "pipe", stderr: "pipe" });
			return { code: result.exitCode, run: result.stdout.toString().split("\n").filter(Boolean), deferred: existsSync(deferred) ? readFileSync(deferred, "utf8").split("\n").filter(Boolean) : [], err: result.stderr.toString() };
		};
		// 2 workers, 60 s: a + b predict 50 s; adding c predicts 75 s, so c is deferred.
		const fits = plan(60, ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
		expect(fits.code).toBe(0);
		expect(fits.run).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
		expect(fits.deferred).toEqual(["tests/c.test.ts"]);
		expect(fits.err).toContain("focused: deferred tests/c.test.ts (over the 60 s wall budget); the release's full suite runs it");
		// A changed test always runs, even past the budget; the first test always runs.
		expect(plan(60, ["tests/big.test.ts", "tests/a.test.ts"], ["tests/a.test.ts"]).run).toEqual(["tests/big.test.ts", "tests/a.test.ts"]);
		expect(plan(360, ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]).deferred).toEqual([]);
		expect(plan(0, ["tests/a.test.ts"]).code).toBe(2);
		// Mutant: a plan that ignores the changed set defers the changed test once the budget is spent.
		const source = readFileSync(selector, "utf8");
		const blind = source.replace("if (changed.has(test) || run.length === 0 || predicted <= budgetMs) {", "if (run.length === 0 || predicted <= budgetMs) {");
		expect(blind).not.toBe(source);
		const mutant = join(dir, "mutant-plan.ts");
		writeFileSync(mutant, blind);
		expect(plan(60, ["tests/big.test.ts", "tests/a.test.ts"], ["tests/a.test.ts"], mutant).deferred).toEqual(["tests/a.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a later timing table overrides an earlier one, so an untimed shell suite is planned at its measured time", () => {
	const dir = tree({
		"ci.json": JSON.stringify({ version: 1, files: { "tests/a.test.ts": 10_000 } }),
		"measured.json": JSON.stringify({ version: 1, files: { "tests/slow.test.sh": 300_000 } }),
	});
	try {
		const plan = (...tables: string[]) => {
			const args = tables.flatMap((table) => ["--timings", join(dir, table)]);
			const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", selector, "--plan", "--budget-secs", "120", "--workers", "4", ...args, "--", "tests/a.test.ts", "tests/slow.test.sh"], { deadline_s: 30 });
			expect(result.rc).toBe(0);
			return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean);
		};
		// Only the CI table: the shell suite is planned at the 10 s default and runs past the budget.
		expect(plan("ci.json")).toEqual(["tests/a.test.ts", "tests/slow.test.sh"]);
		// With the measured table after it, the 300 s suite is known and deferred.
		expect(plan("ci.json", "measured.json")).toEqual(["tests/a.test.ts"]);
		// A missing table is skipped, not fatal.
		expect(plan("ci.json", "absent.json", "measured.json")).toEqual(["tests/a.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--order distance puts changed tests first, then the nearest importers", () => {
	const dir = tree(FILES);
	try {
		const result = Bun.spawnSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", selector, "--root", dir, "--order", "distance", "--changed-file", "src/leaf.ts", "--changed-file", "tests/cli/via-cli.test.ts"], { stdout: "pipe" });
		expect(result.stdout.toString().split("\n").filter(Boolean)).toEqual(["tests/cli/via-cli.test.ts", "tests/cli/leaf.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
