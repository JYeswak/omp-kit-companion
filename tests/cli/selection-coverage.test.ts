import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { planBudget, selectAffected } from "../../scripts/affected-tests.ts";
import { runSync, type RunResult } from "../../src/kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const root = resolve(import.meta.dir, "../..");
const checker = join(root, "scripts/selection-coverage.ts");
const gate = join(root, "scripts/fresh-gate.sh");
const stagedGate = join(root, "scripts/check-staged-sources.sh");
const runner = join(root, "src/kitlib/run.ts");
const policyPath = ".github/test-selection.json";
const decoder = new TextDecoder();
const owned: OwnedTmp[] = [];
afterEach(() => { for (const dir of owned.splice(0)) dir.cleanup(); });

type CommandResult = RunResult & { out: string; err: string };
type GateFixture = { dir: string; archive: string; env: Record<string, string> };
type StagedFixture = { dir: string; env: Record<string, string>; base: string };
type RequiredTests = Record<string, { tests: string[]; reason: string }>;

function temporary(label: string): string {
	const dir = ownedTmp(label);
	owned.push(dir);
	return dir.path;
}

function put(dir: string, path: string, body: string): void {
	mkdirSync(dirname(join(dir, path)), { recursive: true });
	writeFileSync(join(dir, path), body);
}

function tree(files: Record<string, string>): string {
	const dir = temporary("selection-coverage");
	for (const [path, body] of Object.entries(files)) put(dir, path, body);
	return dir;
}

function environment(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key === "BEADS_DB") continue;
		if (["GIT_", "FRESH_GATE_", "OMP_KIT_", "KITLIB_"].some(prefix => key.startsWith(prefix))) continue;
		env[key] = value;
	}
	for (const path of ["home", "config", "state", "cache"]) mkdirSync(join(home, path), { recursive: true });
	return {
		...env, HOME: join(home, "home"), XDG_CONFIG_HOME: join(home, "config"),
		XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: home,
		GIT_TERMINAL_PROMPT: "0", TMPDIR: home, KITLIB_TMP_ROOT: home,
	};
}

function command(argv: string[], cwd: string, env = environment(cwd), deadline_s = 30): CommandResult {
	const result = runSync(argv, { cwd, env, deadline_s });
	return { ...result, out: decoder.decode(result.stdout), err: decoder.decode(result.stderr) };
}

function git(dir: string, args: string[], env = environment(dir)): string {
	const result = command(["git", ...args], dir, env);
	if (result.rc !== 0 || result.timed_out) throw new Error(`git ${args.join(" ")}: ${result.out}${result.err}`);
	return result.out.trim();
}

function audit(dir: string, changed: string[], selected: string[]) {
	const list = join(temporary("selection-list"), "selected.txt");
	writeFileSync(list, selected.length ? `${selected.join("\n")}\n` : "");
	return command([process.execPath, "run", "--no-env-file", "--config=/dev/null", checker,
		"--root", dir, ...changed.flatMap(path => ["--changed-file", path]), "--selected-file", list], dir);
}

function auditAll(dir: string) {
	return command([process.execPath, "run", "--no-env-file", "--config=/dev/null", checker, "--root", dir, "--all"], dir);
}

function expectGap(result: CommandResult, file: string): void {
	expect(result.timed_out, result.out + result.err).toBe(false);
	expect(result.rc, result.out + result.err).toBe(1);
	expect(result.err).toContain(`SELECTION_GAP ${file}:`);
}

function policy(no_test: Record<string, string>, required_tests?: RequiredTests): string {
	return JSON.stringify({ version: 1, no_test, required_tests });
}

const imported = "tests/cli/leaf.test.ts";
const unrelated = "tests/cli/unrelated.test.ts";
const BASIC = {
	"src/leaf.ts": "export const answer = 42;\n",
	[imported]: 'import { expect, test } from "bun:test";\nimport { answer } from "../../src/leaf.ts";\ntest("real leaf value", () => expect(answer).toBe(42));\n',
	[unrelated]: 'import { expect, test } from "bun:test";\ntest("unrelated healthy control", () => expect(6 * 7).toBe(42));\n',
};

function executeTests(dir: string, tests: string[]) {
	return command([process.execPath, "test", "--no-env-file", "--config=/dev/null", ...tests.map(path => `./${path}`)], dir);
}

// Intentional module-loading boundary: keep API-only imports inside their cases so the
// gate admission regressions remain runnable on the baseline without the new module.
// Their causal proof must fail on admitted wrong mappings, not a top-level import error.
test("missing selection is a file-naming gap; the actual selected consumer is healthy", async () => {
	const dir = tree(BASIC);
	const { auditSelection } = await import("../../scripts/selection-coverage.ts");
	const gaps = auditSelection(dir, ["src/leaf.ts"], []);
	expect(gaps).toContainEqual({ file: "src/leaf.ts", reason: expect.any(String) });
	expect(gaps.every(gap => gap.reason.trim().length > 0)).toBe(true);
	expectGap(audit(dir, ["src/leaf.ts"], []), "src/leaf.ts");
	expect(auditSelection(dir, ["src/leaf.ts"], [imported])).toEqual([]);
	const healthy = audit(dir, ["src/leaf.ts"], [imported]);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	const executed = executeTests(dir, [imported]);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test("a wrong nonempty selection cannot borrow an unrelated passing test", () => {
	const dir = tree(BASIC);
	const control = executeTests(dir, [unrelated]);
	expect(control.rc, control.out + control.err).toBe(0);
	expectGap(audit(dir, ["src/leaf.ts"], [unrelated]), "src/leaf.ts");
	expect(audit(dir, ["src/leaf.ts"], [unrelated, imported]).rc).toBe(0);
}, 30_000);

test("every real consumer is required through imports and a transitive subprocess CLI", async () => {
	const processTest = "tests/cli/process.test.ts";
	const dir = tree({
		...BASIC,
		"src/cli.ts": 'import { answer } from "./leaf.js";\nconsole.log(answer);\n',
		"scripts/bridge.ts": `import { resolve } from "node:path";\nimport { runSync } from ${JSON.stringify(runner)};\nexport function invoke() { return runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", "src/cli.ts"], { cwd: resolve(import.meta.dir, ".."), deadline_s: 10 }); }\n`,
		[processTest]: 'import { expect, test } from "bun:test";\nimport { invoke } from "../../scripts/bridge.ts";\ntest("actual subprocess consumer", () => { const result = invoke(); expect(result.rc).toBe(0); expect(new TextDecoder().decode(result.stdout).trim()).toBe("42"); });\n',
	});
	const { auditSelection } = await import("../../scripts/selection-coverage.ts");
	const selection = selectAffected(dir, ["src/leaf.ts"]);
	expect(selection.tests).toEqual([imported, processTest]);
	expect(selection.reasons.get(processTest)).toBe("src/leaf.ts");
	expect(selection.distance.get(processTest)).toBeGreaterThan(selection.distance.get(imported) ?? 0);
	expectGap(audit(dir, ["src/leaf.ts"], [imported]), "src/leaf.ts");
	expectGap(audit(dir, ["src/leaf.ts"], [processTest]), "src/leaf.ts");
	expect(auditSelection(dir, ["src/leaf.ts"], selection.tests)).toEqual([]);
	const executed = executeTests(dir, selection.tests);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test.each([
	["escaped code path", '"src/\\u0063li.ts"'],
	["rooted template path", "`${repo}/src/cli.ts`"],
])("literal subprocess reachability preserves %s and escaped quotes", (_label: string, pathExpression: string) => {
	const consumer = "tests/cli/process.test.ts";
	const dir = tree({
		...BASIC,
		"src/cli.ts": 'import { answer } from "./leaf.ts";\nconsole.log(answer);\n',
		"scripts/bridge.ts": `import { resolve } from "node:path";\nimport { runSync } from ${JSON.stringify(runner)};\nconst repo = resolve(import.meta.dir, "..");\nconst quoted = ${JSON.stringify('say "hello"')};\nexport function invoke() { void quoted; return runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", ${pathExpression}], { cwd: repo, deadline_s: 10 }); }\n`,
		[consumer]: 'import { expect, test } from "bun:test";\nimport { invoke } from "../../scripts/bridge.ts";\ntest("literal-path subprocess", () => { const result = invoke(); expect(result.rc).toBe(0); expect(new TextDecoder().decode(result.stdout).trim()).toBe("42"); });\n',
	});
	expect(selectAffected(dir, ["src/leaf.ts"]).tests).toEqual([imported, consumer]);
	expectGap(audit(dir, ["src/leaf.ts"], [imported]), "src/leaf.ts");
	const healthy = audit(dir, ["src/leaf.ts"], [imported, consumer]);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	const executed = executeTests(dir, [consumer]);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test.each(["join", "resolve"])("split Node %s arguments retain the actual subprocess consumer", (pathFunction: string) => {
	const consumer = "tests/cli/split.test.ts";
	const dir = tree({
		...BASIC,
		"scripts/tool.ts": 'import { answer } from "../src/leaf.ts";\nconsole.log(answer);\n',
		[consumer]: `import { expect, test } from "bun:test";\nimport { join, resolve } from "node:path";\nimport { runSync } from ${JSON.stringify(runner)};\nconst repo = resolve(import.meta.dir, "../..");\nconst entry = ${pathFunction}(repo, "scripts", "tool.ts");\ntest("split-path subprocess", () => { const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", entry], { cwd: repo, deadline_s: 10 }); expect(result.rc).toBe(0); expect(new TextDecoder().decode(result.stdout).trim()).toBe("42"); });\n`,
	});
	expect(selectAffected(dir, ["src/leaf.ts"]).tests).toEqual([imported, consumer]);
	expectGap(audit(dir, ["src/leaf.ts"], [imported]), "src/leaf.ts");
	const healthy = auditAll(dir);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	const executed = executeTests(dir, [consumer]);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test("dirname/cd/pwd shell construction reaches the actual fixture script", () => {
	const file = "scripts/tool.sh";
	const consumer = "tests/cli/tool.test.sh";
	const dir = tree({
		[file]: "#!/bin/sh\nprintf '42\\n'\n",
		[consumer]: `#!/bin/sh\nset -eu\nCHECK=$(CDPATH='' cd -- "$(dirname -- "$0")/../../scripts" && pwd)/tool.sh\nactual=$(sh "$CHECK")\n[ "$actual" = 42 ] || { printf "unexpected tool result: %s\\n" "$actual" >&2; exit 1; }\n`,
	});
	expect(selectAffected(dir, [file]).tests).toEqual([consumer]);
	expectGap(audit(dir, [file], []), file);
	const healthy = auditAll(dir);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	const executed = command(["sh", consumer], dir);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test("comments, documentation and fixture data are not production code dependencies", () => {
	const dir = tree({
		"src/pointer.ts": '// scripts/orphan.ts is an example, not an invocation.\nexport const guide = "docs/guide.md";\nexport const data = "tests/fixtures/data.json";\n',
		"scripts/orphan.ts": "export const untested = 1;\n",
		"docs/guide.md": "# Guide\n",
		"tests/fixtures/data.json": '{"value":42}\n',
		"tests/fixtures/fake.test.ts": 'import "../../scripts/orphan.ts";\n',
		// This consumer checks exported metadata, not document/data bytes. Assert exact
		// segments without naming a complete file path in the test's own code.
		"tests/cli/pointer.test.ts": 'import { expect, test } from "bun:test";\nimport { guide, data } from "../../src/pointer.ts";\ntest("exported pointer metadata", () => { expect(guide.split("/")).toEqual(["docs", "guide.md"]); expect(data.split("/")).toEqual(["tests", "fixtures", "data.json"]); });\n',
		"tests/cli/doc.test.ts": 'import { expect, test } from "bun:test";\nimport { readFileSync } from "node:fs";\ntest("document", () => expect(readFileSync("docs/guide.md", "utf8")).toContain("Guide"));\n',
	});
	expect(selectAffected(dir, ["docs/guide.md"]).tests).toEqual(["tests/cli/doc.test.ts"]);
	expect(selectAffected(dir, ["tests/fixtures/data.json"]).tests).toEqual([]);
	expect(selectAffected(dir, ["scripts/orphan.ts"]).tests).toEqual([]);
	expectGap(audit(dir, ["docs/guide.md"], []), "docs/guide.md");
	expect(audit(dir, ["docs/guide.md"], ["tests/cli/doc.test.ts"]).rc).toBe(0);
	expect(audit(dir, ["tests/fixtures/data.json"], []).rc).toBe(0);
	expectGap(audit(dir, ["scripts/orphan.ts"], ["tests/cli/pointer.test.ts"]), "scripts/orphan.ts");
	expect(audit(dir, ["src/pointer.ts"], ["tests/cli/pointer.test.ts"]).rc).toBe(0);
	const healthy = executeTests(dir, ["tests/cli/pointer.test.ts", "tests/cli/doc.test.ts"]);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
}, 30_000);

test("only an exact nonempty explicit reason covers a genuinely untested file", async () => {
	const file = "scripts/manual.sh";
	const dir = tree({
		[file]: "#!/bin/sh\nprintf 'manual inspection required\\n'\n",
		[policyPath]: policy({ [file]: "Operator-invoked display for a manual inspection; no automated assertion." }),
	});
	const { auditCoverage, auditSelection } = await import("../../scripts/selection-coverage.ts");
	expect(auditSelection(dir, [file], [])).toEqual([]);
	expect(auditCoverage(dir)).toEqual([]);
	expect(audit(dir, [file], []).rc).toBe(0);
	put(dir, "scripts/other/manual.sh", "#!/bin/sh\nexit 0\n");
	expectGap(audit(dir, ["scripts/other/manual.sh"], []), "scripts/other/manual.sh");
});

test("an explicit reason never excuses omitting an actual consumer", () => {
	const dir = tree({ ...BASIC, [policyPath]: policy({ "src/leaf.ts": "Previously thought to require manual inspection." }) });
	expectGap(audit(dir, ["src/leaf.ts"], []), "src/leaf.ts");
	expect(audit(dir, ["src/leaf.ts"], [imported]).rc).toBe(0);
});

test("a normative required_tests obligation covers a real dynamically addressed consumer without becoming a no-test waiver", () => {
	const file = "src/opaque.ts";
	const consumer = "tests/cli/dynamic.test.ts";
	const dir = tree({
		[file]: "console.log(42);\n",
		[unrelated]: BASIC[unrelated],
		[consumer]: `import { expect, test } from "bun:test";\nimport { resolve } from "node:path";\nimport { runSync } from ${JSON.stringify(runner)};\ntest("dynamic subprocess target", () => { const target = process.env.SELECTION_TARGET; if (!target) throw new Error("SELECTION_TARGET is required"); const result = runSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", target], { cwd: resolve(import.meta.dir, "../.."), deadline_s: 10 }); expect(result.rc).toBe(0); expect(new TextDecoder().decode(result.stdout).trim()).toBe("42"); });\n`,
		[policyPath]: policy({}),
	});
	// The consumer's environment-provided target is genuinely outside static path inference.
	expect(selectAffected(dir, [file]).tests).toEqual([]);
	expectGap(auditAll(dir), file);
	const required = { [file]: { tests: [consumer], reason: "tests/cli/dynamic.test.ts runs the SELECTION_TARGET environment path in its bounded subprocess." } };
	put(dir, policyPath, policy({}, required));
	expect(selectAffected(dir, [file]).tests).toEqual([consumer]);
	expectGap(audit(dir, [file], []), file);
	expectGap(audit(dir, [file], [unrelated]), file);
	const healthy = audit(dir, [file], [consumer]);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	expect(auditAll(dir).rc).toBe(0);
	const executed = command([process.execPath, "test", "--no-env-file", "--config=/dev/null", `./${consumer}`], dir, {
		...environment(dir), SELECTION_TARGET: file,
	});
	expect(executed.rc, executed.out + executed.err).toBe(0);
	put(dir, policyPath, policy({ [file]: "Historically treated as manual-only." }, required));
	expectGap(audit(dir, [file], []), file);
	expect(audit(dir, [file], [consumer]).rc).toBe(0);
}, 60_000);

test.each([
	["nonobject table", []],
	["empty tests", { "src/leaf.ts": { tests: [], reason: "Required behavior." } }],
	["missing tests", { "src/leaf.ts": { reason: "Required behavior." } }],
	["blank reason", { "src/leaf.ts": { tests: [imported], reason: " \t" } }],
	["missing consumer", { "src/leaf.ts": { tests: ["tests/cli/absent.test.ts"], reason: "Required behavior." } }],
	["helper instead of suite", { "src/leaf.ts": { tests: ["tests/cli/helper.ts"], reason: "Required behavior." } }],
	["fixture instead of suite", { "src/leaf.ts": { tests: ["tests/fixtures/fake.test.ts"], reason: "Required behavior." } }],
	["missing source", { "src/absent.ts": { tests: [imported], reason: "Required behavior." } }],
	["glob source", { "src/*": { tests: [imported], reason: "Required behavior." } }],
	["unknown obligation field", { "src/leaf.ts": { tests: [imported], reason: "Required behavior.", waived: true } }],
])("required_tests fails closed for %s", (_label: string, required_tests: unknown) => {
	const dir = tree({
		...BASIC,
		"tests/cli/helper.ts": "export const helper = true;\n",
		"tests/fixtures/fake.test.ts": "export const fixture = true;\n",
		[policyPath]: JSON.stringify({ version: 1, no_test: {}, required_tests }),
	});
	expectGap(audit(dir, ["src/leaf.ts"], [imported]), policyPath);
	expectGap(auditAll(dir), policyPath);
});

test.each([
	["malformed JSON", "{"],
	["unsupported version", JSON.stringify({ version: 2, no_test: { "scripts/manual.sh": "Manual inspection." } })],
	["missing reason table", JSON.stringify({ version: 1 })],
	["missing version", JSON.stringify({ no_test: { "scripts/manual.sh": "Manual inspection." } })],
	["nonobject reason table", JSON.stringify({ version: 1, no_test: [] })],
	["nonstring reason", JSON.stringify({ version: 1, no_test: { "scripts/manual.sh": 42 } })],
	["empty reason", policy({ "scripts/manual.sh": "" })],
	["whitespace reason", policy({ "scripts/manual.sh": " \n\t" })],
	["glob reason", policy({ "scripts/*": "Manual inspection." })],
	["stale missing path", policy({ "scripts/deleted.sh": "Manual inspection." })],
])("declared coverage fails closed for %s", (_label: string, declaration: string) => {
	const dir = tree({ "scripts/manual.sh": "#!/bin/sh\nexit 0\n", [policyPath]: declaration });
	expectGap(audit(dir, ["scripts/manual.sh"], []), policyPath);
	expectGap(auditAll(dir), policyPath);
});

test("a missing declaration or a reason for a different file leaves the file uncovered", () => {
	const file = "src/orphan.ts";
	const dir = tree({ [file]: "export const orphan = 1;\n" });
	expectGap(audit(dir, [file], []), file);
	put(dir, "src/different.ts", "export const different = 1;\n");
	put(dir, policyPath, policy({ "src/different.ts": "Manually inspected sample module." }));
	expectGap(audit(dir, [file], []), file);
});

test.each(["ts", "js"])("a real hashbang .%s entrypoint remains covered without a policy exemption", (extension: string) => {
	const file = `scripts/entry.${extension}`;
	const consumer = "tests/cli/entry.test.ts";
	const dir = tree({
		...BASIC,
		[file]: '#!/usr/bin/env bun\nexport { answer } from "../src/leaf.ts";\n',
		[consumer]: `import { expect, test } from "bun:test";\nimport { answer } from "../../${file}";\ntest("hashbang entrypoint", () => expect(answer).toBe(42));\n`,
	});
	expect(selectAffected(dir, ["src/leaf.ts"]).tests).toEqual([consumer, imported]);
	expectGap(audit(dir, [file], []), file);
	const healthy = auditAll(dir);
	expect(healthy.rc, healthy.out + healthy.err).toBe(0);
	const executed = executeTests(dir, [consumer]);
	expect(executed.rc, executed.out + executed.err).toBe(0);
}, 30_000);

test.each(["", "#!/usr/bin/env bun\n"])("an unparsable source cannot be certified by a no-test reason, including prefix %j", (prefix: string) => {
	const file = "src/broken.ts";
	const dir = tree({
		[file]: `${prefix}export const = ;\n`,
		[policyPath]: policy({ [file]: "Manually inspected demonstration." }),
	});
	expectGap(audit(dir, [file], []), file);
	expectGap(auditAll(dir), file);
});

test("--all covers every regular src and scripts file and rejects a new unmapped file", async () => {
	const dir = tree({
		...BASIC,
		"scripts/manual.sh": "#!/bin/sh\nexit 0\n",
		"scripts/catalog.json": '{"kind":"static catalogue"}\n',
		[policyPath]: policy({ "scripts/manual.sh": "Manual operator display.", "scripts/catalog.json": "Static catalogue reviewed by its operator; not executable." }),
	});
	const { auditCoverage } = await import("../../scripts/selection-coverage.ts");
	expect(auditCoverage(dir)).toEqual([]);
	expect(auditAll(dir).rc).toBe(0);
	put(dir, "src/new-unmapped.ts", "export const newUnmapped = true;\n");
	put(dir, "scripts/new-unmapped.json", "{}\n");
	const gaps = auditCoverage(dir);
	expect(gaps.map(gap => gap.file)).toEqual(expect.arrayContaining(["src/new-unmapped.ts", "scripts/new-unmapped.json"]));
	expectGap(auditAll(dir), "src/new-unmapped.ts");
	expectGap(auditAll(dir), "scripts/new-unmapped.json");
});

test("deleted changed paths are allowed, but malformed paths and unknown selected tests fail closed", () => {
	const dir = tree(BASIC);
	const deleted = audit(dir, ["src/deleted.ts"], []);
	expect(deleted.rc, deleted.out + deleted.err).toBe(0);
	expectGap(audit(dir, ["../outside.ts"], []), "../outside.ts");
	const wrong = audit(dir, ["src/leaf.ts"], ["tests/cli/absent.test.ts"]);
	expectGap(wrong, "tests/cli/absent.test.ts");
});

test("invalid CLI input is distinct from a selection gap", () => {
	const dir = tree(BASIC);
	for (const args of [
		["--root", join(dir, "absent"), "--all"],
		["--root", dir, "--changed-file", "src/leaf.ts", "--selected-file", join(dir, "absent-list")],
		["--root", dir, "--changed-file"],
	]) {
		const result = command([process.execPath, "run", "--no-env-file", "--config=/dev/null", checker, ...args], dir);
		expect(result.rc, result.out + result.err).toBe(2);
	}
});

// Same real shell-function fixture convention as fresh-gate.test.ts. Keep the production
// focused path intact; only the selector's input is fault-injected. In particular, no shell
// stand-in prints a gate verdict, a test result, or a SELECTION_GAP diagnostic.
function gateDefinitions(): string {
	const source = readFileSync(gate, "utf8");
	const main = source.indexOf("# Read-only query for sibling runners;");
	if (main < 0) throw new Error("fresh-gate function fixture boundary is unavailable");
	return source.slice(0, main);
}

function gateFixture(answer = 42): GateFixture {
	const dir = temporary("selection-fresh-gate");
	const archive = join(dir, "archive");
	mkdirSync(archive);
	const env = environment(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	// The host's disk/load state is not the subject of this fixture. Reuse the existing
	// test-only statfs preload; actual heavy admission, metrics and Bun suites still run.
	put(bin, "bun", `#!/bin/sh\nif [ "$1" = run ]; then shift; exec ${JSON.stringify(process.execPath)} --preload ${JSON.stringify(join(root, "tests/cli/fixtures/forge-healthy-statfs.ts"))} "$@"; fi\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
	chmodSync(join(bin, "bun"), 0o755);
	mkdirSync(join(dir, "config/omp-kit"), { recursive: true, mode: 0o700 });
	put(dir, "config/omp-kit/load.json", JSON.stringify({ slots: 4, max_wait_s: 5, disk_observer: "statfs" }));
	chmodSync(join(dir, "config/omp-kit/load.json"), 0o600);
	symlinkSync(join(root, "src"), join(archive, "src"));
	put(archive, "lib/leaf.ts", `export const answer = ${answer};\n`);
	put(archive, "lib/other.ts", "export const answer = 7;\n");
	for (const [name, expected] of [["leaf", 42], ["other", 7]] as const) {
		put(archive, `tests/cli/${name}.test.ts`, `import { expect, test } from "bun:test";\nimport { mkdirSync, writeFileSync } from "node:fs";\nimport { resolve } from "node:path";\nimport { answer } from "../../lib/${name}.ts";\ntest("real ${name} selection fixture", () => { expect(answer).toBe(${expected}); mkdirSync(resolve(import.meta.dir, "../../var"), { recursive: true }); writeFileSync(resolve(import.meta.dir, "../../var/${name}-ran"), "ran"); });\n`);
	}
	put(archive, "MANIFEST.tsv", "name\tsha256\tclass\tpack\n");
	put(archive, "bunfig.toml", "[test]\ntimeout = 30000\n");
	const fixtureEnv = {
		...env, PATH: `${bin}:${env.PATH ?? "/usr/bin:/bin"}`, TMUX_PANE: "", AGENT_NAME: "selection-coverage-test",
		OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", OMP_KIT_SUITE_HERMETIC_ENABLE: "0", FRESH_GATE_TEST_WORKERS: "1",
		FRESH_GATE_LEDGER: "", FRESH_GATE_REPO: archive,
	};
	git(archive, ["init", "-q", "--template="], fixtureEnv);
	git(archive, ["-c", "user.name=selection test", "-c", "user.email=selection@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "add", "--", "src", "lib", "tests", "MANIFEST.tsv", "bunfig.toml"], fixtureEnv);
	git(archive, ["-c", "user.name=selection test", "-c", "user.email=selection@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "[test] selection candidate"], fixtureEnv);
	return { dir, archive, env: fixtureEnv };
}

function focused(fixture: GateFixture, changed: string[], options: { selectorChanged?: string; removeChecker?: boolean; budgetSecs?: string } = {}) {
	const work = temporary("selection-gate-work");
	const probe = join(work, "focused.sh");
	const faultySelector = options.selectorChanged === undefined ? "" : `select_affected_tests() {\n bun run --no-env-file --config=/dev/null "$SCRIPT_DIR/affected-tests.ts" --root "$ARCHIVE_DIR" --changed-file "$SELECTION_SELECTOR_CHANGED"\n}\n`;
	const removeChecker = options.removeChecker ? "audit_test_selection() { return 0; }\n" : "";
	writeFileSync(probe, `${gateDefinitions()}\nSCRIPT_DIR=$SELECTION_SCRIPT_DIR\nROOT=$SELECTION_ARCHIVE\nARCHIVE_DIR=$SELECTION_ARCHIVE\nWORK=$SELECTION_WORK\nCHANGED=$SELECTION_CHANGED\n${faultySelector}${removeChecker}rc=0\ngate_focused || rc=$?\nexit "$rc"\n`);
	return command(["sh", probe], fixture.dir, {
		...fixture.env, SELECTION_SCRIPT_DIR: join(root, "scripts"), SELECTION_ARCHIVE: fixture.archive,
		SELECTION_WORK: work, SELECTION_CHANGED: changed.join("\n"), SELECTION_SELECTOR_CHANGED: options.selectorChanged ?? "",
		FRESH_GATE_TEST_BUDGET_SECS: options.budgetSecs ?? "120",
	}, 90);
}

test.each([
	["omits one changed file while another change selects a passing consumer", ["lib/leaf.ts", "lib/other.ts"], "lib/other.ts"],
	["maps the changed file to a wrong nonempty selection", ["lib/leaf.ts"], "tests/cli/other.test.ts"],
])("fresh-gate refuses when the selector %s; removing only the checker admits the regression", (_label: string, changed: string[], selectorChanged: string) => {
	const healthy = gateFixture();
	const accepted = focused(healthy, ["lib/leaf.ts"]);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
	expect(existsSync(join(healthy.archive, "var/leaf-ran"))).toBe(true);

	const broken = gateFixture(41);
	const refused = focused(broken, changed, { selectorChanged });
	expectGap(refused, "lib/leaf.ts");
	expect(existsSync(join(broken.archive, "var/leaf-ran"))).toBe(false);
	expect(existsSync(join(broken.archive, "var/other-ran"))).toBe(false);

	// This is an executable baseline/causal control, not an import-of-a-new-module failure:
	// the same bad selector and real passing unrelated suite are admitted without the audit.
	const unchecked = focused(broken, changed, { selectorChanged, removeChecker: true });
	expect(unchecked.rc, unchecked.out + unchecked.err).toBe(0);
	expect(existsSync(join(broken.archive, "var/other-ran"))).toBe(true);
	expect(existsSync(join(broken.archive, "var/leaf-ran"))).toBe(false);
	const regression = executeTests(broken.archive, ["tests/cli/leaf.test.ts"]);
	expect(regression.rc, regression.out + regression.err).toBe(1);
}, 120_000);

test("fresh-gate admits a genuinely untested file with its exact explicit reason", () => {
	const fixture = gateFixture();
	const file = "lib/manual.ts";
	put(fixture.archive, file, "export const operatorExample = 42;\n");
	put(fixture.archive, policyPath, policy({ [file]: "Manually inspected operator example, not an automated entrypoint." }));
	const accepted = focused(fixture, [file]);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
	expect(accepted.out + accepted.err).not.toContain("SELECTION_GAP");
	expect(existsSync(join(fixture.archive, "var/leaf-ran"))).toBe(false);
	expect(existsSync(join(fixture.archive, "var/other-ran"))).toBe(false);
}, 60_000);

test("fresh-gate audits the complete selection before ordinary wall-budget deferral", () => {
	const fixture = gateFixture();
	put(fixture.archive, ".github/core-test-timings.json", JSON.stringify({ version: 1, files: {
		"tests/cli/leaf.test.ts": 10_000, "tests/cli/other.test.ts": 10_000,
	} }));
	const changed = ["lib/leaf.ts", "lib/other.ts"];
	const selection = selectAffected(fixture.archive, changed);
	expect(selection.tests).toEqual(["tests/cli/leaf.test.ts", "tests/cli/other.test.ts"]);
	const plan = planBudget(selection.tests, new Set(changed), { "tests/cli/leaf.test.ts": 10_000, "tests/cli/other.test.ts": 10_000 }, 1, 1);
	expect(plan.deferred).toEqual(["tests/cli/other.test.ts"]);
	const result = focused(fixture, changed, { budgetSecs: "0.001" });
	expect(result.rc, result.out + result.err).toBe(0);
	expect(result.out + result.err).not.toContain("SELECTION_GAP");
	expect(existsSync(join(fixture.archive, "var/leaf-ran"))).toBe(true);
	expect(existsSync(join(fixture.archive, "var/other-ran"))).toBe(false);
	expect(result.out).toContain("VERDICT PARTIAL");
}, 120_000);

function stagedFixture(options: { commitHook?: boolean } = {}): StagedFixture {
	const dir = tree({ ...BASIC, [policyPath]: policy({}) });
	const env = environment(dir);
	git(dir, ["init", "-q", "--template="], env);
	git(dir, ["config", "user.name", "selection test"], env);
	git(dir, ["config", "user.email", "selection@example.invalid"], env);
	git(dir, ["config", "commit.gpgsign", "false"], env);
	git(dir, ["config", "core.hooksPath", join(dir, ".git/hooks")], env);
	git(dir, ["add", "--", ...Object.keys(BASIC), policyPath], env);
	git(dir, ["commit", "-q", "-m", "[test] covered base"], env);
	if (options.commitHook !== false) {
		// Isolate the real commit route from unrelated hook-chain obligations. Distribution
		// is exercised separately below through the actual installer and installed member.
		put(dir, ".git/hooks/pre-commit", `#!/bin/sh\nexec sh ${JSON.stringify(stagedGate)}\n`);
		chmodSync(join(dir, ".git/hooks/pre-commit"), 0o755);
	}
	return { dir, env, base: git(dir, ["rev-parse", "HEAD"], env) };
}

function commit(fixture: StagedFixture, only: string[] = []) {
	return command(["git", "commit", "-q", "-m", "[test] staged selection candidate", ...(only.length ? ["--only", "--", ...only] : [])], fixture.dir, fixture.env, 60);
}

test("commit refuses a new unmapped staged source despite a real worktree-only consumer", () => {
	const fixture = stagedFixture();
	const file = "src/new-unmapped.ts";
	const consumer = "tests/cli/new-unmapped.test.ts";
	put(fixture.dir, file, "export const added = 42;\n");
	git(fixture.dir, ["add", "--", file], fixture.env);
	put(fixture.dir, consumer, 'import { expect, test } from "bun:test";\nimport { added } from "../../src/new-unmapped.ts";\ntest("new consumer", () => expect(added).toBe(42));\n');
	expect(auditAll(fixture.dir).rc).toBe(0);
	const refused = commit(fixture);
	expectGap(refused, file);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).toBe(fixture.base);
	git(fixture.dir, ["add", "--", consumer], fixture.env);
	const accepted = commit(fixture);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).not.toBe(fixture.base);
}, 60_000);

test("commit judges the staged reason, not an unstaged repaired coverage policy", () => {
	const fixture = stagedFixture();
	const file = "scripts/manual.sh";
	put(fixture.dir, file, "#!/bin/sh\nprintf 'operator display\\n'\n");
	git(fixture.dir, ["add", "--", file], fixture.env);
	put(fixture.dir, policyPath, policy({ [file]: "Operator-invoked display checked by manual inspection." }));
	expect(auditAll(fixture.dir).rc).toBe(0);
	const refused = commit(fixture);
	expectGap(refused, file);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).toBe(fixture.base);
	git(fixture.dir, ["add", "--", policyPath], fixture.env);
	const accepted = commit(fixture);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
}, 60_000);

test.each([
	["empty reason", policy({ "src/manual.ts": "" })],
	["malformed declaration", "{"],
	["stale reason", policy({ "src/deleted.ts": "Manually inspected example." })],
])("commit refuses a staged %s despite a healthy worktree repair", (_label: string, declaration: string) => {
	const fixture = stagedFixture();
	const file = "src/manual.ts";
	put(fixture.dir, file, "export const operatorExample = 42;\n");
	put(fixture.dir, policyPath, declaration);
	git(fixture.dir, ["add", "--", file, policyPath], fixture.env);
	put(fixture.dir, policyPath, policy({ [file]: "Manually inspected operator example." }));
	expect(auditAll(fixture.dir).rc).toBe(0);
	expectGap(commit(fixture), policyPath);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).toBe(fixture.base);
	git(fixture.dir, ["add", "--", policyPath], fixture.env);
	const accepted = commit(fixture);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
}, 60_000);

test("deleting an opted-in staged coverage declaration is refused even while its worktree copy remains", () => {
	const fixture = stagedFixture();
	git(fixture.dir, ["update-index", "--force-remove", "--", policyPath], fixture.env);
	expect(auditAll(fixture.dir).rc).toBe(0);
	expectGap(commit(fixture), policyPath);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).toBe(fixture.base);
}, 60_000);

test("git commit --only cannot borrow a consumer staged outside its temporary candidate index", () => {
	const fixture = stagedFixture();
	const file = "src/only.ts";
	const consumer = "tests/cli/only.test.ts";
	put(fixture.dir, file, "export const only = 42;\n");
	put(fixture.dir, consumer, 'import { expect, test } from "bun:test";\nimport { only } from "../../src/only.ts";\ntest("only consumer", () => expect(only).toBe(42));\n');
	git(fixture.dir, ["add", "--", file, consumer], fixture.env);
	const refused = commit(fixture, [file]);
	expectGap(refused, file);
	expect(git(fixture.dir, ["rev-parse", "HEAD"], fixture.env)).toBe(fixture.base);
	const accepted = commit(fixture, [file, consumer]);
	expect(accepted.rc, accepted.out + accepted.err).toBe(0);
}, 60_000);

test.each(["staged-selection.py", "selection-coverage.ts", "affected-tests.ts"])("the real installed staged-sources member refuses uncovered code and fails closed without %s", (sidecar: string) => {
	const fixture = stagedFixture({ commitHook: false });
	// Match the existing check-staged-imports install fixture: actual installer, explicit
	// owned repository argument, native Git index, no fabricated helper or member copies.
	const installed = command(["sh", join(root, "scripts/install-commit-msg-bead.sh"), fixture.dir], fixture.dir, fixture.env, 60);
	expect(installed.rc, installed.out + installed.err).toBe(0);
	const hookDir = join(fixture.dir, ".git/hooks/hooks.d/pre-commit");
	const member = join(hookDir, "52-omp-kit-staged-sources");

	put(fixture.dir, "src/leaf.ts", "export const answer = 42;\n// Covered staged edit.\n");
	git(fixture.dir, ["add", "--", "src/leaf.ts"], fixture.env);
	const covered = command(["sh", member], fixture.dir, fixture.env);
	expect(covered.rc, covered.out + covered.err).toBe(0);

	const file = "src/installed-new.ts";
	const consumer = "tests/cli/installed-new.test.ts";
	put(fixture.dir, file, "export const installedAnswer = 42;\n");
	git(fixture.dir, ["add", "--", file], fixture.env);
	expectGap(command(["sh", member], fixture.dir, fixture.env), file);
	put(fixture.dir, consumer, 'import { expect, test } from "bun:test";\nimport { installedAnswer } from "../../src/installed-new.ts";\ntest("installed member consumer", () => expect(installedAnswer).toBe(42));\n');
	git(fixture.dir, ["add", "--", consumer], fixture.env);
	const repaired = command(["sh", member], fixture.dir, fixture.env);
	expect(repaired.rc, repaired.out + repaired.err).toBe(0);
	const executed = executeTests(fixture.dir, [imported, consumer]);
	expect(executed.rc, executed.out + executed.err).toBe(0);

	// Change only installed runtime availability after the healthy control. Moving the
	// helper out preserves its bytes while removing it from the member's real closure.
	renameSync(join(hookDir, sidecar), join(fixture.dir, `${sidecar}.removed`));
	const missingHelper = command(["sh", member], fixture.dir, fixture.env);
	expect(missingHelper.timed_out, missingHelper.out + missingHelper.err).toBe(false);
	expect(missingHelper.rc, missingHelper.out + missingHelper.err).toBe(1);
	expect(missingHelper.err).toContain("staged-sources: REFUSED");
}, 120_000);
