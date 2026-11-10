import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { AMPLE, MANIFEST_HEADER, affectedArchive, gate, gateTree, runFocused, runProbe, saveFixture } from "./fresh-gate.helpers.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// CIGATE1 (ompkit-v66l.27.1): the selector the pre-push gate uses to pick the tests a diff affects.
const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const selector = join(root, "scripts/affected-tests.ts");
const decoder = new TextDecoder();

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
	const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", script, "--root", dir, "--explain", ...changed.flatMap((path) => ["--changed-file", path])], { deadline_s: 120 });
	return { code: result.rc ?? -1, tests: decoder.decode(result.stdout).split("\n").filter(Boolean), err: decoder.decode(result.stderr) };
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

// FRESHGATEFIXTURE1 (ompkit-fp72.120.16.87): on 2026-11-02 a fixture read by joined path segments and a script module
// imported by a Python test both selected nothing at the push gate, and each failed a release full suite instead.
const MISSED: Record<string, string> = {
	"tests/fixtures/legacy.patch": "diff\n",
	"tests/fixtures/unread.patch": "diff\n",
	"tests/cli/land.test.ts": 'const patch = readFileSync(join(repoRoot, "tests", "fixtures", "legacy.patch"));\n',
	"scripts/bead_lint.py": "def lint(): pass\n",
	"scripts/other_tool.py": "def other(): pass\n",
	"tests/scripts/bead_lint_goal_path_test.py": "import sys\nsys.path.insert(0, str(SCRIPTS))\nimport bead_lint  # noqa: E402\nfrom pysafe import run_bounded\n",
	"tests/scripts/unrelated_test.py": "import json, os.path as p\n",
};

test("FRESHGATEFIXTURE1 a fixture read by joined segments and a script a Python test imports select that test", () => {
	const dir = tree(MISSED);
	try {
		expect(select(dir, ["tests/fixtures/legacy.patch"]).tests).toEqual(["tests/cli/land.test.ts"]);
		expect(select(dir, ["scripts/bead_lint.py"]).tests).toEqual(["tests/scripts/bead_lint_goal_path_test.py"]);
		// Planted negatives: a fixture no test reads and a script no test imports still select nothing.
		expect(select(dir, ["tests/fixtures/unread.patch"]).tests).toEqual([]);
		expect(select(dir, ["scripts/other_tool.py"]).tests).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FRESHGATEFIXTURE1 mutants: without the fixture or Python-import edges the missed suites select 0 files", () => {
	const dir = tree(MISSED);
	try {
		const source = readFileSync(selector, "utf8");
		// EMBEDDEP1's joined-segment edge also reads join(root, "tests", "fixtures", "legacy.patch"): each
		// edge alone still selects land.test.ts, and only removing both misses it.
		const fixtureEdge = "for (const fixture of fixtures) edge(namers, rel, fixture);";
		const joinedEdge = "if (files.has(joined)) { found.push(joined); break; }";
		const noFixture = source.replace(fixtureEdge, "void fixtures;");
		const noJoined = source.replace(joinedEdge, "void joined;");
		const noBoth = noFixture.replace(joinedEdge, "void joined;");
		const noPython = source.replace("if (files.has(target)) edge(importers, rel, target);", "void target;");
		for (const mutant of [noFixture, noJoined, noPython]) expect(mutant).not.toBe(source);
		expect(noBoth).not.toBe(noFixture);
		for (const [name, text] of [["no-fixture", noFixture], ["no-joined", noJoined], ["no-both", noBoth], ["no-python", noPython]]) writeFileSync(join(dir, `${name}.ts`), text as string);
		expect(select(dir, ["tests/fixtures/legacy.patch"], join(dir, "no-fixture.ts")).tests).toEqual(["tests/cli/land.test.ts"]);
		expect(select(dir, ["tests/fixtures/legacy.patch"], join(dir, "no-joined.ts")).tests).toEqual(["tests/cli/land.test.ts"]);
		expect(select(dir, ["tests/fixtures/legacy.patch"], join(dir, "no-both.ts")).tests).toEqual([]);
		expect(select(dir, ["scripts/bead_lint.py"], join(dir, "no-python.ts")).tests).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("wall-budget plan keeps changed tests and the nearest importers, and defers the rest by name", () => {
	const dir = tree({ "timings.json": JSON.stringify({ version: 1, files: { "tests/a.test.ts": 50_000, "tests/b.test.ts": 50_000, "tests/c.test.ts": 50_000, "tests/big.test.ts": 400_000 } }) });
	try {
		const plan = (budget: number, tests: string[], changed: string[] = [], script = selector) => {
			const deferred = join(dir, `deferred-${Math.random().toString(36).slice(2)}`);
			const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", script, "--plan", "--budget-secs", String(budget), "--workers", "2", "--timings", join(dir, "timings.json"), "--deferred-out", deferred, ...changed.flatMap((path) => ["--changed-file", path]), "--", ...tests], { deadline_s: 120 });
			return { code: result.rc ?? -1, run: decoder.decode(result.stdout).split("\n").filter(Boolean), deferred: existsSync(deferred) ? readFileSync(deferred, "utf8").split("\n").filter(Boolean) : [], err: decoder.decode(result.stderr) };
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
		const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", selector, "--root", dir, "--order", "distance", "--changed-file", "src/leaf.ts", "--changed-file", "tests/cli/via-cli.test.ts"], { deadline_s: 120 });
		expect(result.rc).toBe(0);
		expect(decoder.decode(result.stdout).split("\n").filter(Boolean)).toEqual(["tests/cli/via-cli.test.ts", "tests/cli/leaf.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// EMBEDDEP1 (ompkit-fp72.120.16.197): four escapes through this selector on 2026-11-04. GROUPREAP1
// changed scripts/pysafe.py and src/kitlib/run.ts; the push ran 4 files and deferred the rest to a
// paused CI, so installer-bootstrap, scratch-orphan-reap and private-index-land-3c broke main. G5
// narrowed rules-fleet/kit-no-force-push.md and broke rx2-rules, which loads rules by id.
function selectWithStatus(dir: string, changed: string[]): { code: number; tests: string[]; err: string; status: string } {
	// The status file lives in its own owned dir, never in DIR: DIR may be the live checkout.
	const holder = ownedTmp("affected-status", { root: scratchRoot });
	try {
		const status = join(holder.path, "status");
		const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", selector, "--root", dir, "--explain", "--status-out", status,
			...changed.flatMap((path) => ["--changed-file", path])], { deadline_s: fixtureDeadlineS(120) });
		return { code: result.rc ?? -1, tests: decoder.decode(result.stdout).split("\n").filter(Boolean), err: decoder.decode(result.stderr),
			status: existsSync(status) ? readFileSync(status, "utf8") : "" };
	} finally { holder.cleanup(); }
}
const ALL_FILES_TESTS = ["tests/cli/docs.test.ts", "tests/cli/leaf.test.ts", "tests/cli/runner.test.ts", "tests/cli/spawn-cli.test.ts",
	"tests/cli/tool.test.sh", "tests/cli/uses-helper.test.ts", "tests/cli/via-cli.test.ts", "tests/scripts/runner_test.py"];

test("EMBEDDEP1 a planted shared-runtime change (scripts/pysafe.py) is a FULL plan: every test file, status FULL", () => {
	const dir = tree({ ...FILES, "scripts/pysafe.py": "def run():\n    return 0\n" });
	try {
		const full = selectWithStatus(dir, ["scripts/pysafe.py"]);
		expect(full.code, full.err).toBe(0);
		// No fixture test reaches pysafe.py: a path walk alone selects nothing here.
		expect(full.tests).toEqual(ALL_FILES_TESTS);
		expect(full.status).toBe("FULL scripts/pysafe.py\n");
		expect(full.err).toContain("affected-tests: FULL plan: scripts/pysafe.py is a shared runtime, so all 8 test files are affected");
		expect(selectWithStatus(dir, ["src/leaf.ts"]).status).toBe("SELECTED\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// The live tree: each declared shared runtime is FULL.
	for (const trigger of ["scripts/pysafe.py", "scripts/kitlib_run.py", "src/kitlib/run.ts"]) {
		expect(selectWithStatus(root, [trigger]).status).toBe(`FULL ${trigger}\n`);
	}
});

test("EMBEDDEP1 a planted embed-input change selects installer-bootstrap through the producer's declared EMBEDS", () => {
	const producer = "#!/usr/bin/env python3\nEMBEDS = {\n    \"installer/install.py\": [\"scripts/payload.py\"]\n}\n";
	const dir = tree({
		...FILES,
		"installer/embed-bootstrap.py": producer,
		"installer/install.py": "# generated from scripts/payload\n",
		"scripts/payload.py": "PAYLOAD = 1\n",
		"tests/cli/installer-bootstrap.test.ts": 'const installer = "installer/install.py";\n',
	});
	try {
		const input = selectWithStatus(dir, ["scripts/payload.py"]);
		expect(input.code, input.err).toBe(0);
		expect(input.tests).toEqual(["tests/cli/installer-bootstrap.test.ts"]);
		expect(input.err).toContain("affected: tests/cli/installer-bootstrap.test.ts <- scripts/payload.py (2 hops)");
		expect(input.status).toBe("SELECTED\n");
		// A malformed declaration fails the plan; it never selects silently from a partial map.
		writeFileSync(join(dir, "installer/embed-bootstrap.py"), "#!/usr/bin/env python3\nEMBEDS = {\n    \"installer/install.py\": \"scripts/payload.py\"\n}\n");
		const malformed = selectWithStatus(dir, ["scripts/payload.py"]);
		expect(malformed.code).toBe(2);
		expect(malformed.err).toContain("EMBEDS in installer/embed-bootstrap.py: installer/install.py must map to a non-empty list of input paths");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// The live producer's EMBEDS is the map the selector reads, and the one the producer lists.
	const listed = runSync(["python3", "-I", "installer/embed-bootstrap.py", "--list"], { cwd: root, deadline_s: fixtureDeadlineS(30) });
	expect(listed.rc, decoder.decode(listed.stderr)).toBe(0);
	expect(decoder.decode(listed.stdout).split("\n").filter(Boolean)).toEqual(["installer/install.py", "scripts/pysafe.py", "scripts/kitlib_run.py", "src/kitlib/pysafe-source.ts"]);
	expect(selectWithStatus(root, ["installer/embed-bootstrap.py"]).tests).toContain("tests/cli/installer-bootstrap.test.ts");
});

test("EMBEDDEP1 a planted rules-fleet change selects the suite loading that rule by id; a rules/ change selects the pack harness suite", () => {
	const dir = tree({
		...FILES,
		"scripts/rule-class.ts": "export function loadRuleFile(file: string): string { return file; }\nexport function loadRules(dir: string): string[] { return [dir]; }\n",
		"scripts/harness.ts": 'import { join } from "node:path";\nimport { loadRules } from "./rule-class.ts";\nloadRules(join(process.cwd(), "rules"));\n',
		"rules/kit-y.md": "---\ncondition: y\n---\n",
		"rules-fleet/kit-x.md": "---\ncondition: x\n---\n",
		"rules-fleet/kit-z.md": "---\ncondition: z\n---\n",
		"tests/cli/rx2.test.ts": 'import { loadRuleFile } from "../../scripts/rule-class.ts";\nfor (const name of ["kit-x"]) loadRuleFile(`rules-fleet/${name}.md`);\n',
		"tests/cli/harness.test.ts": 'import { join } from "node:path";\nconst harness = join(import.meta.dir, "../..", "scripts", "harness.ts");\n',
		"tests/cli/unrelated-rule.test.ts": 'import { loadRuleFile } from "../../scripts/rule-class.ts";\nloadRuleFile(process.argv[2] ?? "");\n',
	});
	try {
		const byId = selectWithStatus(dir, ["rules-fleet/kit-x.md"]);
		expect(byId.code, byId.err).toBe(0);
		expect(byId.tests).toEqual(["tests/cli/rx2.test.ts"]);
		expect(selectWithStatus(dir, ["rules-fleet/kit-z.md"]).tests).toEqual([]);
		expect(selectWithStatus(dir, ["rules/kit-y.md"]).tests).toEqual(["tests/cli/harness.test.ts"]);
		// A join("scripts", "harness.ts") segment run names the harness, as a literal path would.
		expect(selectWithStatus(dir, ["scripts/harness.ts"]).tests).toEqual(["tests/cli/harness.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// The live tree: the G5 escape, and the echo-literal and harness suites for a rules/ rule.
	expect(selectWithStatus(root, ["rules-fleet/kit-no-pattern-kill.md"]).tests).toContain("tests/cli/rx2-rules.test.ts");
	const shipped = selectWithStatus(root, ["rules/kit-rea-runtime-shipped.md"]).tests;
	expect(shipped).toContain("tests/cli/echo-literal-rules.test.ts");
	expect(shipped).toContain("tests/cli/ttsr-harness.test.ts");
});

test("EMBEDDEP1 control: a README-only change selects only the tests that read README, status SELECTED", () => {
	const dir = tree({ ...FILES, "README.md": "# readme\n", "tests/cli/readme.test.ts": "readFileSync(`${ROOT}/README.md`);\n", "scripts/pysafe.py": "X = 1\n" });
	try {
		const readme = selectWithStatus(dir, ["README.md"]);
		expect(readme.code, readme.err).toBe(0);
		expect(readme.tests).toEqual(["tests/cli/readme.test.ts"]);
		expect(readme.status).toBe("SELECTED\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(!AMPLE)("EMBEDDEP1 fresh-gate reports a FULL plan as FULL, never as over budget; an exact-tree main-role PASS admits it (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, "scripts"));
		writeFileSync(join(archive, "scripts/pysafe.py"), "def run():\n    return 0\n");
		// A 5 s budget would defer an ordinary selection; a FULL plan is never budgeted.
		fx.env.FRESH_GATE_TEST_BUDGET_SECS = "5";
		const scripts = gateTree(fx, MANIFEST_HEADER);
		const refused = runFocused(fx, source, archive, "scripts/pysafe.py", scripts);
		expect(refused.code, refused.out).toBe(1);
		expect(refused.out).toContain("FRESH-GATE: PLAN FULL trigger=scripts/pysafe.py files=1: a shared runtime changed");
		expect(refused.out).toContain("FRESH-GATE: REFUSED reason=FULL_SUITE_REQUIRED trigger=scripts/pysafe.py files=1 verdict=");
		expect(refused.out).toContain("scripts/full-suite-verdict.sh");
		expect(refused.out).toContain("--judge-role main");
		expect(refused.out).not.toContain("affected-tests plan:");
		expect(refused.out).not.toContain("wall budget");
		expect(refused.out).not.toContain("VERDICT PARTIAL");
		// The exact tree's PASS readback (a stub store standing in for a recorded verdict) admits it.
		const store = join(scripts, "full-suite-verdict-store.py");
		rmSync(store);
		writeFileSync(store, "import sys\nprint('PASS')\nsys.exit(0)\n");
		const reused = runFocused(fx, source, archive, "scripts/pysafe.py", scripts);
		expect(reused.code, reused.out).toBe(0);
		expect(reused.out).toContain("FRESH-GATE: VERDICT FULL_SUITE_REUSED tree=");
		expect(reused.out).not.toContain("affected-tests plan:");
		// FULLHANDOFF1: the br handoff shim admits a DONE claim only from a row whose evidence is complete.
		// The row a reused PASS writes must be complete and name its tree; the refused run's row must not be.
		const row = (out: string) => {
			const line = out.split("\n").findLast((text) => text.startsWith("FRESH-GATE: measured-verdict "));
			expect(line, out).toBeDefined();
			return JSON.parse((line as string).slice("FRESH-GATE: measured-verdict ".length));
		};
		const reusedTree = /FULL_SUITE_REUSED tree=([0-9a-f]{40}) /.exec(reused.out)?.[1];
		expect(row(reused.out).evidence).toEqual({ complete: true, full_suite: { tree: reusedTree, role: "main" }, declared_files: [], files: [] });
		expect(row(refused.out).evidence.complete).toBe(false);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("EMBEDDEP1 a deferral while ci.yml is paused prints DEFERRED_TO_PAUSED_CI on the verdict and GREEN lines; control: with CI enabled, no such line (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		// The gate reads ci.yml's state through gh; this fixture gh answers from FAKE_CI_STATE.
		const gh = join(fx.dir, "bin", "gh");
		writeFileSync(gh, '#!/bin/sh\n[ "$1 $2" = "api repos/{owner}/{repo}/actions/workflows/ci.yml" ] || exit 9\nprintf \'%s\\n\' "$FAKE_CI_STATE"\n');
		chmodSync(gh, 0o755);
		const archive = affectedArchive(fx, 42, 42);
		for (const n of [2, 3]) writeFileSync(join(archive, `tests/cli/mod${n}.test.ts`), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("answer ${n}", () => { expect(answer()).toBe(42); });\n`);
		fx.env.FRESH_GATE_TEST_BUDGET_SECS = "5";
		const marker = "FRESH-GATE: DEFERRED_TO_PAUSED_CI: 2 files (ci.yml state=disabled_manually): CI is not running, so these were not tested";
		fx.env.FAKE_CI_STATE = "disabled_manually";
		const paused = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(paused.code, paused.out).toBe(0);
		expect(paused.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1 deferred=tests/cli/mod.test.ts,tests/cli/mod2.test.ts: CI runs the deferred files");
		expect(paused.out).toContain(marker);
		fx.env.FAKE_CI_STATE = "active";
		const enabled = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(enabled.code, enabled.out).toBe(0);
		expect(enabled.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1");
		expect(enabled.out).not.toContain("DEFERRED_TO_PAUSED_CI");
		// The GREEN line carries the deferral and its list; with CI enabled it does not.
		const green = (state: string) => runProbe(fx, source,
			`mkdir -p "$WORK"\nprintf 'tests/cli/mod.test.ts\\ntests/cli/mod2.test.ts\\n' >"$WORK/excluded"\nprintf '${state}\\n' >"$WORK/ci-state"\nCOMMIT=abc\njudge_budget 10 2 0`);
		const pausedGreen = green("disabled_manually");
		expect(pausedGreen.code, pausedGreen.out).toBe(0);
		expect(pausedGreen.out).toContain("FRESH-GATE: GREEN commit=abc elapsed=10s tests=2s queued=0s judged=8s DEFERRED_TO_PAUSED_CI: 2 files (ci.yml state=disabled_manually): tests/cli/mod.test.ts,tests/cli/mod2.test.ts\n");
		const enabledGreen = green("active");
		expect(enabledGreen.out).toContain("FRESH-GATE: GREEN commit=abc elapsed=10s tests=2s queued=0s judged=8s\n");
		expect(enabledGreen.out).not.toContain("DEFERRED_TO_PAUSED_CI");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 240_000);

test("EXTLOADGATE1 a staged extensions/*.ts or package.json change selects the package load gate suite", () => {
	const dir = tree({
		...FILES,
		"extensions/kit-mail-wake.ts": 'import { woken } from "../src/plane-tern.ts";\nexport const woken = 1;\n',
		"src/plane-tern.ts": "export const woken = 1;\n",
		"src/only.ts": "export const only = 1;\n",
		"tests/cli/only.test.ts": 'import { only } from "../../src/only.ts";\nonly;\n',
		"tests/cli/package-release.test.ts": 'import { expect, test } from "bun:test";\ntest("loads", () => { expect(1).toBe(1); });\n',
		"package.json": '{ "name": "fixture" }\n',
	});
	try {
		// Planted: the shipped extension is imported by no test, yet the load gate suite is selected.
		expect(select(dir, ["extensions/kit-mail-wake.ts"]).tests).toEqual(["tests/cli/package-release.test.ts"]);
		expect(select(dir, ["package.json"]).tests).toEqual(["tests/cli/package-release.test.ts"]);
		// Control: a src-only change no extension imports selects only its own suite.
		expect(select(dir, ["src/only.ts"]).tests).toEqual(["tests/cli/only.test.ts"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
