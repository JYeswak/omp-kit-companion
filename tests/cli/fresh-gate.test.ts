import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeBundledHarness } from "./release-manifest-fixture.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";

const root = resolve(import.meta.dir, "../..");
// The remaining scripts/ entries of suite-metrics.py JUDGING_FILES, which a fixture judge dir must also carry.
const JUDGE_SUPPORT = ["full-suite-verdict.sh", "suite-hermetic-env.sh", "kitlib_run.py", "kitlib_tmp.py", "pysafe.py", "kitlib-tmp.sh"];
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const gate = join(root, "scripts/fresh-gate.sh");

function fixture(): string {
	const dir = ownedTmp("fresh-gate-test", { root: scratchRoot }).path;
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	mkdirSync(join(dir, "rules"));
	mkdirSync(join(dir, "scripts"));
	for (const name of ["rules/bash-glob-silenced.md", "scripts/build-manifest.sh", "scripts/rule-class.ts"]) {
		cpSync(join(root, name), join(dir, name));
	}
	writeBundledHarness(dir);
	return dir;
}


// Manifest tests isolate manifest behavior from compile/harness work.
// The test-local Bun shim supplies fixture classifications, then stops at the
// first downstream Bun command; regex-budget.test.ts exercises RX1 by default.
// A healthy sbh stand-in keeps the host's disk pressure out of them: under real pressure the gate's
// pressure flag first du-scans the caller checkout's var/agent-tmp (2.8 s for its first 200 owners on
// 2026-10-30), which pushed a direct run past bun's 5 s default. SAVEFIRST1 below proves the flag
// itself with its own sbh stand-in.
const SKIP_BUDGET = { FRESH_GATE_SKIP_REGEX: "manifest fixture does not assess regex cost" };
function manifestTestEnv(dir: string): Record<string, string> {
	const fakeBin = join(dir, "bin");
	mkdirSync(fakeBin);
	const fakeBun = join(fakeBin, "bun");
	writeFileSync(fakeBun, `#!/bin/sh
case "$*" in
  *scripts/rule-class.ts*) printf 'bash-glob-silenced\\ttripwire\\n' ;;
  *)
    echo "fresh-gate.test: stopped after manifest verification" >&2
    exit 99
    ;;
esac
`);
	chmodSync(fakeBun, 0o755);
	writeFileSync(join(fakeBin, "sbh"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(fakeBin, "sbh"), 0o755);
	return { ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };
}



function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
	return Bun.spawnSync(["sh", script, ...args], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...extraEnv } });
}

test("fresh gate refuses an edited rule with a stale manifest", () => {
	const dir = fixture();
	try {
		const rule = join(dir, "rules/bash-glob-silenced.md");
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
		writeFileSync(rule, readFileSync(rule, "utf8") + "\nStale manifest plant.\n");
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"], manifestTestEnv(dir));
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("build-manifest --check: FAIL");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("fresh gate validates the package-time manifest for rule-only edits", () => {
	const dir = fixture();
	try {
		const rule = join(dir, "rules/bash-glob-silenced.md");
		const editedRule = readFileSync(rule, "utf8") + "\nPackage-time manifest plant.\n";
		writeFileSync(rule, editedRule);
		const result = run(gate, ["--archive-dir", dir, "--changed-file", "rules/bash-glob-silenced.md"], manifestTestEnv(dir));
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("GREEN manifest");
		expect(output).toContain("fresh-gate.test: stopped after manifest verification");
		const expectedHash = createHash("sha256").update(editedRule).digest("hex");
		expect(readFileSync(join(dir, "MANIFEST.tsv"), "utf8")).toContain(`bash-glob-silenced\t${expectedHash}\ttripwire\t`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scratch skip prints NOT JUDGED while other skips keep SKIPPED", () => {
	const script = readFileSync(gate, "utf8");
	const start = script.indexOf("print_budget_skip() {");
	expect(start).toBeGreaterThan(-1);
	const end = script.indexOf("\n}\n", start);
	expect(end).toBeGreaterThan(start);
	const fn = script.slice(start, end + 3);
	const probe = join(scratchRoot, `skip-probe-${process.pid}.sh`);
	writeFileSync(probe, fn + "\nprint_budget_skip\n");
	try {
		const scratch = Bun.spawnSync(["sh", probe], { env: { ...process.env, FRESH_GATE_SKIP_REGEX: "scratch measurement ref; main pushes still judged" }, stdout: "pipe", stderr: "pipe" });
		expect(scratch.exitCode).toBe(0);
		expect(scratch.stdout.toString()).toContain("regex-budget: NOT JUDGED (scratch measurement ref; main pushes still judged)");
		const other = Bun.spawnSync(["sh", probe], { env: { ...process.env, FRESH_GATE_SKIP_REGEX: "manifest fixture does not assess regex cost" }, stdout: "pipe", stderr: "pipe" });
		expect(other.stdout.toString()).toContain("focused regex-budget: SKIPPED");
		expect(other.stdout.toString()).not.toContain("NOT JUDGED");
	} finally {
		rmSync(probe, { force: true });
	}
});

test("focused selection skips suites and shell files the range deleted, and still runs modified ones", () => {
	const script = readFileSync(gate, "utf8");
	const dir = fixture();
	try {
		mkdirSync(join(dir, "tests/cli"), { recursive: true });
		writeFileSync(join(dir, "tests/cli/kept.test.ts"), "");
		writeFileSync(join(dir, "scripts/kept.sh"), "#!/bin/sh\n");
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
	const fakeBin = join(dir, "bin");
	mkdirSync(fakeBin);
	writeFileSync(join(fakeBin, "shellcheck"), "#!/bin/sh\n[ -e \"$1\" ] || { echo \"shellcheck: missing $1\" >&2; exit 2; }\necho \"SHELLCHECK $1\"\n");
	chmodSync(join(fakeBin, "shellcheck"), 0o755);
	writeFileSync(join(fakeBin, "docker"), "#!/bin/sh\n# fake docker: emulate the pinned shellcheck image by delegating to the fake shellcheck.\nif [ \"$1\" = \"image\" ]; then echo \"fake image present\"; exit 0; fi\nif [ \"$1\" = \"pull\" ]; then echo \"fake pull ok\"; exit 0; fi\nif [ \"$1\" = \"run\" ]; then\n  file=\"\"\n  for arg in \"$@\"; do case \"$arg\" in /archive/*) file=\"$arg\" ;; esac; done\n  echo \"DOCKER-SHELLCHECK $file\"\n  exit 0\nfi\necho \"fake docker: unexpected $*\" >&2; exit 2\n");
	chmodSync(join(fakeBin, "docker"), 0o755);
		const probe = join(dir, "focused-probe.sh");
		// The real selector and gate_focused; only the bun test run is a stand-in that checks its argv exists.
		writeFileSync(probe, `run_affected_tests() { for f in "$@"; do [ -e "$ARCHIVE_DIR/$f" ] || { echo "bun test: missing $f" >&2; return 1; }; echo "RAN $f"; done; }\n${gateFunctions(script, ["select_affected_tests", "test_workers", "changed_code", "apply_ci_only", "record_run", "gate_focused"])}gate_focused\n`);
		const focused = (changed: string) => Bun.spawnSync(["sh", probe], {
			env: { ...process.env, ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ARCHIVE_DIR: dir, SCRIPT_DIR: join(root, "scripts"), CHANGED: changed, FRESH_GATE_LEDGER: "", WORK: dir },
			stdout: "pipe", stderr: "pipe",
		});
		const deleted = focused("tests/cli/gone.test.ts\nscripts/gone.sh");
		const deletedOut = deleted.stdout.toString() + deleted.stderr.toString();
		expect(deleted.exitCode).toBe(0);
		expect(deletedOut).not.toContain("missing");
		expect(deletedOut).toContain("focused: tests/cli/gone.test.ts deleted in range; not run");
		expect(deletedOut).toContain("focused suites: none selected for changed paths");
		const mixed = focused("tests/cli/gone.test.ts\ntests/cli/kept.test.ts\nscripts/gone.sh\nscripts/kept.sh");
		const mixedOut = mixed.stdout.toString() + mixed.stderr.toString();
		expect(mixed.exitCode).toBe(0);
		expect(mixedOut).toContain("RAN tests/cli/kept.test.ts");
	expect(mixedOut).toContain("DOCKER-SHELLCHECK /archive/scripts/kept.sh");
		expect(mixedOut).not.toContain("RAN tests/cli/gone.test.ts");
		expect(mixedOut).not.toContain("missing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("focused shellcheck refuses an A && B || C guard through the pinned runner", () => {
	const script = readFileSync(gate, "utf8");
	const dir = fixture();
	try {
		writeFileSync(join(dir, "scripts/bad.sh"), "#!/bin/sh\nset -u\nx=\"${1:-}\"\ny=\"${2:-}\"\n[ -n \"$x\" ] && [ -n \"$y\" ] || { echo \"need x and y\" >&2; exit 2; }\n");
		writeFileSync(join(dir, "scripts/good.sh"), "#!/bin/sh\nexit 0\n");
		// good.sh is product code: a suite that names it keeps the push from NO_AFFECTED_TESTS.
		mkdirSync(join(dir, "tests/cli"), { recursive: true });
		writeFileSync(join(dir, "tests/cli/good.test.sh"), "#!/bin/sh\nsh \"$ROOT/scripts/good.sh\"\n");
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
		const fakeBin = join(dir, "bin");
		mkdirSync(fakeBin);
		writeFileSync(join(fakeBin, "shellcheck"), "#!/bin/sh\necho \"SHELLCHECK $1\"\n");
		chmodSync(join(fakeBin, "shellcheck"), 0o755);
		writeFileSync(join(fakeBin, "docker"), "#!/bin/sh\n# fake docker: emulate pinned v0.9.0, which refuses A && B || C (SC2015) where newer builds stay silent.\nif [ \"$1\" = \"image\" ]; then echo \"fake image present\"; exit 0; fi\nif [ \"$1\" = \"pull\" ]; then echo \"fake pull ok\"; exit 0; fi\nif [ \"$1\" = \"run\" ]; then\n  file=\"\"\n  for arg in \"$@\"; do case \"$arg\" in /archive/*) file=\"$arg\" ;; esac; done\n  real=\"$FAKE_ARCHIVE${file#/archive}\"\n  if grep -q '|| {' \"$real\" 2>/dev/null; then echo \"DOCKER-SHELLCHECK $file: SC2015 (info): A && B || C is not if-then-else\" >&2; exit 1; fi\n  echo \"DOCKER-SHELLCHECK $file: clean\"\n  exit 0\nfi\necho \"fake docker: unexpected $*\" >&2; exit 2\n");
		chmodSync(join(fakeBin, "docker"), 0o755);
		const probe = join(dir, "focused-probe.sh");
		writeFileSync(probe, `set -e\nprint_budget_skip() { echo "BUDGET-SKIP"; }\nrun_affected_tests() { for f in "$@"; do [ -e "$ARCHIVE_DIR/$f" ] || { echo "bun test: missing $f" >&2; return 1; }; echo "RAN $f"; done; }\n${gateFunctions(script, ["select_affected_tests", "test_workers", "changed_code", "apply_ci_only", "record_run", "gate_focused"])}gate_focused\n`);
		const focused = (changed: string) => Bun.spawnSync(["sh", probe], {
			env: { ...process.env, ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ARCHIVE_DIR: dir, FAKE_ARCHIVE: dir, SCRIPT_DIR: join(root, "scripts"), CHANGED: changed, FRESH_GATE_LEDGER: "", WORK: dir },
			stdout: "pipe", stderr: "pipe",
		});
		const bad = focused("scripts/bad.sh");
		const badOut = bad.stdout.toString() + bad.stderr.toString();
		expect(bad.exitCode).not.toBe(0);
		expect(badOut).toContain("SC2015");
		const good = focused("scripts/good.sh");
		expect(good.exitCode).toBe(0);
		expect(good.stdout.toString()).toContain("DOCKER-SHELLCHECK /archive/scripts/good.sh: clean");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});


test("fresh gate selftest refuses a deleted CLI boot check", () => {
	const dir = fixture();
	try {
		const mutant = join(dir, "scripts/fresh-gate-mutant.sh");
		const source = readFileSync(gate, "utf8");
		const deleted = source.replace(/\ngate_cli_boot\(\) \{[\s\S]*?\n\}\n/, "\n");
		expect(deleted).not.toBe(source);
		writeFileSync(mutant, deleted);
		chmodSync(mutant, 0o755);
		const result = run(mutant, ["--selftest"]);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("gate_cli_boot");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fresh gate selftest refuses a deleted gate function", () => {
	const dir = fixture();
	try {
		const mutant = join(dir, "scripts/fresh-gate-mutant.sh");
		const source = readFileSync(gate, "utf8");
		const deleted = source.replace(/\ngate_harness\(\) \{[\s\S]*?\n\}\n/, "\n");
		expect(deleted).not.toBe(source);
		writeFileSync(mutant, deleted);
		chmodSync(mutant, 0o755);
		const result = run(mutant, ["--selftest"]);
		const output = result.stdout.toString() + result.stderr.toString();
		expect(result.exitCode).not.toBe(0);
		expect(output).toContain("gate_harness");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- SAVEFIRST1 (ompkit-774u.16): sbh pressure flags a save, physical bytes decide it ----------------
// The gate's real functions run against the real `omp-kit heavy` with private config/state; only sbh
// is a stand-in, and pressure below the physical floor comes from a real small filesystem.
import { AMPLE, LOW_BASE, NEED_BYTES, freeBytes, gateFunctions, saveFixture, type SaveFixture } from "./fresh-gate.helpers.ts";

// ---- CIGATE1 (ompkit-v66l.27.1): the push runs the tests its diff affects, or refuses ---------------
// The real selector, disk floor, heavy and bun test run against a small exact-tree fixture; src is the
// checkout's (heavy runs from it), the code under test lives in lib/ so the fixture owns its edits.
const FOCUSED_FUNCTIONS = ["fail", "run_step", "heavy_step", "print_budget_skip", "select_affected_tests", "test_workers", "run_affected_tests", "changed_code", "apply_ci_only", "record_run", "gate_focused"];
function affectedArchive(fx: SaveFixture, answer: number, expected: number, base = fx.dir): string {
	const dir = ownedTmp("archive", { root: base }).path;
	symlinkSync(join(root, "src"), join(dir, "src"));
	mkdirSync(join(dir, "lib"));
	mkdirSync(join(dir, "tests/cli"), { recursive: true });
	mkdirSync(join(dir, "docs"));
	writeFileSync(join(dir, "bunfig.toml"), "[test]\ntimeout = 120000\n");
	writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
	// A docs path in source text is a help pointer, not a dependency.
	writeFileSync(join(dir, "lib/mod.ts"), `// see docs/notes.md\nexport const answer = (): number => ${answer};\n`);
	writeFileSync(join(dir, "tests/cli/mod.test.ts"), `import { expect, test } from "bun:test";\nimport { existsSync } from "node:fs";\nimport { join, relative } from "node:path";\nimport { answer } from "../../lib/mod.ts";\ntest("answer and suite-owned TMPDIR", () => { expect(answer()).toBe(${expected}); const tmp = process.env.TMPDIR ?? ""; expect(tmp).not.toBe(""); expect(relative(join(import.meta.dir, "../../var/agent-tmp"), tmp).startsWith("suite-hermetic.")).toBe(true); expect(existsSync(join(tmp, ".owner"))).toBe(true); });\n`);
	writeFileSync(join(dir, "docs/notes.md"), "# notes\n");
	return dir;
}
// The focused gate names its candidate as "$COMMIT^{tree}" in the repository at $ROOT (the pushing
// checkout), and resolves the shared timing store from that repository root. The fixture owns that
// repository instead of borrowing the checkout this test runs in: the gate's exact-commit export
// is an unborn `git init`, so HEAD there names no tree.
function candidateRepo(fx: SaveFixture): string {
	const repo = join(fx.dir, "candidate-repo");
	if (existsSync(join(repo, ".git"))) return repo;
	mkdirSync(repo);
	const identity = ["-c", "user.name=fresh-gate test", "-c", "user.email=fresh-gate@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
	for (const args of [["init", "-q"], [...identity, "commit", "-q", "--allow-empty", "-m", "[test] focused gate candidate"]]) {
		const result = runSync(["git", "-C", repo, ...args], { env: { ...process.env, ...fx.env } as Record<string, string>, deadline_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr)}`);
	}
	return repo;
}
function runFocused(fx: SaveFixture, source: string, archive: string, changed: string, scriptDir = join(root, "scripts")) {
	const probe = join(fx.dir, `focused-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(probe, `set -eu\ngate_defer_record=1\n${gateFunctions(source, FOCUSED_FUNCTIONS)}rc=0\nrun_step focused gate_focused || rc=$?\ngate_defer_record=0\nrecord_run "$last_record_tests" "$last_record_files" "$rc"\nexit "$rc"\n`);
	const repo = candidateRepo(fx);
	const started = Date.now();
	const result = Bun.spawnSync(["sh", probe], {
		env: { ...process.env, ...fx.env, ROOT: repo, TMPDIR: join(fx.dir, "caller-tmp"), WORK: fx.dir, ...SKIP_BUDGET, ARCHIVE_DIR: archive, SCRIPT_DIR: scriptDir, CHANGED: changed, FRESH_GATE_LEDGER: join(fx.dir, "runs.jsonl") },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), seconds: (Date.now() - started) / 1000 };
}
function ledger(fx: SaveFixture): Array<Record<string, unknown>> {
	const path = join(fx.dir, "runs.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function assertPhases(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object") throw new Error("missing measured phase spans");
	const phases = value as Record<string, unknown>;
	for (const name of ["wait_ms", "setup_ms", "run_ms"]) {
		if (typeof phases[name] !== "number" || !Number.isFinite(phases[name]) || phases[name] < 0) {
			throw new Error("invalid measured phase " + name);
		}
	}
}
function measuredFiles(record: Record<string, unknown>) {
	const evidence = record.evidence;
	if (!evidence || typeof evidence !== "object" || !("files" in evidence) || !Array.isArray(evidence.files)) {
		throw new Error("missing measured file evidence");
	}
	return evidence.files.map((row: unknown) => {
		if (!row || typeof row !== "object" || !("path" in row) || typeof row.path !== "string"
			|| !("started_ms" in row) || typeof row.started_ms !== "number"
			|| !("finished_ms" in row) || typeof row.finished_ms !== "number"
			|| !("elapsed_ms" in row) || typeof row.elapsed_ms !== "number"
			|| !("rc" in row) || typeof row.rc !== "number") throw new Error("invalid measured file");
		assertPhases(row);
		return {
			path: row.path, started_ms: row.started_ms, finished_ms: row.finished_ms,
			elapsed_ms: row.elapsed_ms, rc: row.rc,
			wait_ms: row.wait_ms as number, setup_ms: row.setup_ms as number, run_ms: row.run_ms as number,
		};
	});
}

test.skipIf(!AMPLE)("CIGATE1 planted: a src change runs the tests importing it; breaking it refuses the push (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const green = runFocused(fx, source, affectedArchive(fx, 42, 42), "lib/mod.ts");
		expect(green.code, green.out).toBe(0);
		expect(green.out).toContain("affected: tests/cli/mod.test.ts <- lib/mod.ts");
		expect(green.out).toContain("disk-floor: OK");
		expect(green.out).toContain("affected tests: files=1 ran=1 fail=0 rc=0");
		const broken = affectedArchive(fx, 41, 42);
		const red = runFocused(fx, source, broken, "lib/mod.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("affected tests: files=1 ran=1 fail=1 rc=1");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass (exit 1); the push is refused");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[1, 1, 0], [1, 1, 1]]);
		// Mutant: a gate that ignores the suite's status passes the broken push.
		const ignoresFailure = source.replace('\t\treturn "$tests_rc"\n', "\t\treturn 0\n");
		expect(ignoresFailure).not.toBe(source);
		expect(runFocused(fx, ignoresFailure, broken, "lib/mod.ts").code).toBe(0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("GATEFLAKE1 retains a real fixture timeout without misclassifying an assertion failure", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const timeoutArchive = affectedArchive(fx, 42, 42);
		// Real process expiry is the behavior under test; fake timers cannot expire kitlib's OS deadline.
		writeFileSync(join(timeoutArchive, "tests/cli/mod.test.ts"), `
import { test } from "bun:test";
import { runFixture } from ${JSON.stringify(join(root, "tests/cli/fixture-process.ts"))};
test("real fixture expiry", () => runFixture([process.execPath, "-e", "setTimeout(() => {}, 5000)"], {
	cwd: import.meta.dir, floor_s: 0.05, label: "gate-timeout",
}));
`);
		const timeout = runFocused(fx, source, timeoutArchive, "tests/cli/mod.test.ts");
		expect(timeout.code, timeout.out).toBe(1);
		expect(timeout.out).toContain('FRESH-GATE: RED: TIMEOUT_UNDER_LOAD label="gate-timeout"');
		expect(timeout.out).toContain("loadavg=");
		expect(timeout.out).toContain("workers=");

		const assertionArchive = affectedArchive(fx, 41, 42);
		writeFileSync(join(assertionArchive, "tests/cli/mod.test.ts"), `
import { expect, test } from "bun:test";
test("ordinary assertion failure", () => {
	// TIMEOUT_UNDER_LOAD loadavg=2 workers=1 is only a source excerpt.
	expect(41).toBe(42);
});
`);
		const assertion = runFocused(fx, source, assertionArchive, "tests/cli/mod.test.ts");
		expect(assertion.code, assertion.out).toBe(1);
		expect(assertion.out).toContain("TIMEOUT_UNDER_LOAD");
		expect(assertion.out).not.toContain("FRESH-GATE: RED: TIMEOUT_UNDER_LOAD");
		expect(assertion.out).toContain("FRESH-GATE: RED: affected tests did not pass (exit 1)");
		expect(ledger(fx).map(row => [row.selected_files, row.tests_ran, row.rc])).toEqual([[1, 1, 1], [1, 1, 1]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("SUITEBUDGET1 reports, without refusing, a successful file over the heuristic per-file cap", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const judge = join(fx.dir, "judge");
		const scripts = join(judge, "scripts");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(judge, ".github"));
		// Every file suite-metrics.py JUDGING_FILES hashes: a gate that exports FRESH_GATE_PASSED_OUT makes the judge read them all.
		for (const name of ["fresh-gate.sh", "gate-disk-floor.ts", "suite-metrics.py", "full-suite-verdict-store.py", "test-budget.ts", "affected-tests.ts", "gate-ci-only.tsv", ...JUDGE_SUPPORT]) {
			symlinkSync(join(root, "scripts", name), join(scripts, name));
		}
		const policy = join(judge, ".github/test-budget.json");
		const configure = (cycle: number) => writeFileSync(policy, JSON.stringify({
			version: 1, requirements: { push_p95_s: 600, full_cycle_s: cycle },
			initial_heuristic: { per_file_cap_s: cycle / 4, derivation: "full_cycle_s / 4",
				status: "INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED", mode: "report" },
			changed_file_budget: { cap_s: 90, grandfathered: {} },
		}));
		const archive = affectedArchive(fx, 42, 42);
		configure(900);
		const control = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(control.code, control.out).toBe(0);
		// A fixture-only tiny cap exercises the real measured refusal without a
		// five-minute sleeper or a forged timing row. Product policy is untouched.
		configure(0.004);
		const reported = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(reported.code, reported.out).toBe(0);
		expect(reported.out).toContain("OVER_BUDGET");
		expect(reported.out).toContain("tests/cli/mod.test.ts");
		const record = ledger(fx).at(-1)!;
		expect(record.rc).toBe(0);
		const timing = record.timing as Record<string, unknown>;
		const stages = timing.stages as Record<string, unknown>;
		expect(Object.keys(stages)).toContain("focused");
		expect(Object.keys(stages)).toContain("tests-admission");
		assertPhases(stages.focused);
		assertPhases(stages["tests-admission"]);
		const files = measuredFiles(record);
		expect(files[0]!.rc).toBe(0);
		expect(files[0]!.elapsed_ms).toBeGreaterThan(1);
		assertPhases(stages.bun);
		for (const name of ["sh", "python3"]) {
			expect(stages[name]).toMatchObject({
				file_count: 0, phase_basis: "per-file-sum", wait_ms: 0, setup_ms: 0, run_ms: 0,
			});
		}
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE || process.env.OMP_KIT_LITERAL_SUITE_BUDGET !== "1")("SUITEBUDGET1 literal 10-second control and 300-second file", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "tests/cli/ten.test.sh"), '#!/bin/sh\nsleep 10\nprintf "ten-second control passed\\n"\n');
		writeFileSync(join(archive, "tests/cli/three-hundred.test.sh"), '#!/bin/sh\nsleep 300\nprintf "three-hundred-second file passed\\n"\n');
		const control = runFocused(fx, source, archive, "tests/cli/ten.test.sh");
		expect(control.code, control.out).toBe(0);
		const slow = runFocused(fx, source, archive, "tests/cli/three-hundred.test.sh");
		console.log(slow.out);
		const assertBudgetRefusal = (code: number, out: string) => {
			expect(code, out).not.toBe(0);
			expect(out).toContain("OVER_BUDGET");
			expect(out).toContain("tests/cli/three-hundred.test.sh");
			expect(out).toContain('"cap_s":90');
		};
		assertBudgetRefusal(slow.code, slow.out);
		const rows = measuredFiles(ledger(fx).at(-1)!);
		expect(rows[0]!.elapsed_ms).toBeGreaterThanOrEqual(300000);
		expect(rows[0]!.rc).toBe(0);

		// Remove only the fixture gate's budget enforcement, not the measured run.
		const enforcement = '\t\tbun run --no-env-file --config=/dev/null "$SCRIPT_DIR/test-budget.ts" \\\n\t\t\t--repo "$SCRIPT_DIR/.." --enforce "$metric_rows" --changed-files "$WORK/budget-changed-files" --json || tests_rc=$?\n';
		const withoutEnforcement = source.replace(enforcement, "\t\t:\n");
		expect(withoutEnforcement).not.toBe(source);
		const unchecked = runFocused(fx, withoutEnforcement, archive, "tests/cli/three-hundred.test.sh");
		console.log("SUITEBUDGET1 literal enforcement removed", unchecked.out);
		expect(unchecked.code, unchecked.out).toBe(0);
		const uncheckedRows = measuredFiles(ledger(fx).at(-1)!);
		expect(uncheckedRows[0]!.elapsed_ms).toBeGreaterThanOrEqual(300000);
		expect(uncheckedRows[0]!.rc).toBe(0);
		expect(() => assertBudgetRefusal(unchecked.code, unchecked.out)).toThrow();
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 720_000);

test.skipIf(!AMPLE)("FILEBUDGET1 own timed run admits a normal changed file and refuses a planted over-budget file", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const scripts = gateTree(fx, MANIFEST_HEADER);
		const policyPath = join(scripts, "../.github/test-budget.json");
		const policy = JSON.parse(readFileSync(policyPath, "utf8"));
		const archive = affectedArchive(fx, 42, 42);
		const fast = runFocused(fx, source, archive, "tests/cli/mod.test.ts", scripts);
		expect(fast.code, fast.out).toBe(0);
		expect(fast.out).toContain("VERDICT TESTED");
		// A fixture-only tight policy proves the real measured boundary without
		// a 90-second sleeper, forged measurement, or an extra production run.
		policy.changed_file_budget = { cap_s: 0.001, grandfathered: {} };
		writeFileSync(policyPath, JSON.stringify(policy));
		const slow = runFocused(fx, source, archive, "tests/cli/mod.test.ts", scripts);
		expect(slow.code, slow.out).toBe(1);
		expect(slow.out).toContain("FILE_OVER_BUDGET");
		expect(slow.out).toContain("private-index-land-2/-3 and kit-update-*");
		expect(slow.out).toContain('"cap_s":0.001');
		const row = measuredFiles(ledger(fx).at(-1)!)[0]!;
		expect(row.rc).toBe(0);
		expect(row.elapsed_ms).toBeGreaterThan(1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("FILEBUDGET1 policy ratchet uses Git predecessor bytes even for a docs-only change", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const repo = candidateRepo(fx);
		mkdirSync(join(repo, ".github"));
		const policy = JSON.parse(readFileSync(join(root, ".github/test-budget.json"), "utf8"));
		const policyPath = join(repo, ".github/test-budget.json");
		writeFileSync(policyPath, JSON.stringify(policy));
		const identity = ["-c", "user.name=fresh-gate test", "-c", "user.email=fresh-gate@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
		for (const args of [["add", ".github/test-budget.json"], [...identity, "commit", "-q", "-m", "[test] file budget baseline"]]) {
			const result = runSync(["git", "-C", repo, ...args], { deadline_s: 10 });
			expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
		}
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, ".github"));
		const candidate = join(archive, ".github/test-budget.json");
		writeFileSync(candidate, JSON.stringify(policy));
		const probe = join(fx.dir, "file-policy.sh");
		writeFileSync(probe, `set -eu\n${gateFunctions(source, ["fail", "gate_file_budget_policy"])}gate_file_budget_policy\n`);
		const check = (base = "HEAD") => {
			const result = runSync(["sh", probe], { deadline_s: 15, env: {
				...process.env, ...fx.env, ROOT: repo, FRESH_GATE_REPO: repo, BASE: base, COMMIT: "HEAD",
				ARCHIVE_DIR: archive, SCRIPT_DIR: join(root, "scripts"), CHANGED: "docs/notes.md",
			} });
			return { rc: result.rc, out: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr) };
		};
		expect(check().rc).toBe(0);
		// Pre-push exports FRESH_GATE_REPO. Bind it to the owned fixture rather
		// than silently checking the outer checkout's pre-adoption policy.
		const missing = check("refs/heads/filebudget-missing-baseline");
		expect(missing.rc, missing.out).toBe(1);
		expect(missing.out).toContain("cannot read predecessor test-budget policy at refs/heads/filebudget-missing-baseline");
		expect(missing.out).not.toContain("FILE_BUDGET_POLICY OK");
		policy.changed_file_budget.grandfathered["new.test.ts"] = { measured_s: 131, evidence: "planted increase" };
		writeFileSync(candidate, JSON.stringify(policy));
		const refused = check();
		expect(refused.rc).toBe(1);
		expect(refused.out).toContain("FILE_BUDGET_RATCHET new.test.ts");
		expect(refused.out).not.toContain("affected tests:");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test.skipIf(!AMPLE)("CIGATE1 shards: the selection runs in K parallel bun workers, and a failure in any shard refuses (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		for (const n of [2, 3]) writeFileSync(join(archive, `tests/cli/mod${n}.test.ts`), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("answer ${n}", () => { expect(answer() + ${n}).toBe(${42 + n}); });\n`);
		fx.env.FRESH_GATE_TEST_WORKERS = "2";
		const green = runFocused(fx, source, archive, "lib/mod.ts");
		expect(green.code).toBe(0);
		expect(green.out).toContain("affected bun tests: files=3 workers=2");
		const measured = measuredFiles(ledger(fx).at(-1)!).sort((a, b) => a.started_ms - b.started_ms);
		expect(measured.map(row => row.path).sort()).toEqual(["tests/cli/mod.test.ts", "tests/cli/mod2.test.ts", "tests/cli/mod3.test.ts"]);
		expect(measured.every(row => row.rc === 0)).toBe(true);
		expect(measured[1]!.started_ms).toBeLessThan(measured[0]!.finished_ms);
		expect(green.out).toContain("FRESH-GATE: VERDICT TESTED files=3 ran=3");
		writeFileSync(join(archive, "tests/cli/mod3.test.ts"), `import { expect, test } from "bun:test";\ntest("broken shard", () => { expect(1).toBe(2); });\n`);
		const red = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
		// Paired serial control must not overlap file-process lifetimes.
		fx.env.FRESH_GATE_TEST_WORKERS = "1";
		writeFileSync(join(archive, "tests/cli/mod3.test.ts"), `import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n`);
		expect(runFocused(fx, source, archive, "lib/mod.ts").code).toBe(0);
		const serial = measuredFiles(ledger(fx).at(-1)!).sort((a, b) => a.started_ms - b.started_ms);
		expect(serial[1]!.started_ms).toBeGreaterThanOrEqual(serial[0]!.finished_ms);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("CIGATE1 shards: K is a quarter of the cores, 2..4, or an explicit positive override", () => {
	const source = readFileSync(gate, "utf8");
	const dir = ownedTmp("fresh-gate-workers", { root: scratchRoot }).path;
	try {
		const probe = join(dir, "probe.sh");
		writeFileSync(probe, `${gateFunctions(source, ["test_workers"])}test_workers\n`);
		const k = (override: string) => Bun.spawnSync(["sh", probe], { env: { ...process.env, FRESH_GATE_TEST_WORKERS: override }, stdout: "pipe" }).stdout.toString().trim();
		const cores = Number(Bun.spawnSync(["getconf", "_NPROCESSORS_ONLN"], { stdout: "pipe" }).stdout.toString().trim());
		expect(k("")).toBe(String(Math.min(4, Math.max(2, Math.floor(cores / 4)))));
		expect(k("0")).toBe(k(""));
		expect(k("x3")).toBe(k(""));
		expect(k("5")).toBe("5");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test.skipIf(!AMPLE)("CIGATE1 planted: a commit breaking the test it touches is refused (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const red = runFocused(fx, source, affectedArchive(fx, 42, 43), "tests/cli/mod.test.ts");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("affected: tests/cli/mod.test.ts <- tests/cli/mod.test.ts");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("CIGATE1 planted: a docs-only commit runs no suites and passes fast", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const docs = runFocused(fx, source, affectedArchive(fx, 41, 42), "docs/notes.md");
		expect(docs.code).toBe(0);
		expect(docs.out).toContain("focused suites: none selected for changed paths");
		expect(docs.out).toContain("FRESH-GATE: VERDICT DOCS_ONLY: no product code changed");
		expect(docs.out).not.toContain("affected tests:");
		expect(docs.seconds).toBeLessThan(15);
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 0]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

test("CIGATE1 planted: a product-code change that no test reaches is refused, never a bare pass", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "lib/orphan.ts"), "export const orphan = 1;\n");
		const refused = runFocused(fx, source, archive, "lib/orphan.ts\ndocs/notes.md");
		expect(refused.code).toBe(1);
		expect(refused.out).toContain("FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=lib/orphan.ts:");
		expect(refused.out).not.toContain("VERDICT");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 1]]);
		// Mutant: a gate that cannot tell code from docs passes the untested change as DOCS_ONLY.
		const blind = source.replace(`\t\t\t\t[ -e "$ARCHIVE_DIR/$file" ] && printf '%s\\n' "$file" ;;`, "\t\t\t\t: ;;");
		expect(blind).not.toBe(source);
		const passed = runFocused(fx, blind, archive, "lib/orphan.ts");
		expect(passed.code).toBe(0);
		expect(passed.out).toContain("VERDICT DOCS_ONLY");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

test.skipIf(!AMPLE)("CIGATE1 planted: a shell suite naming a changed script runs, and its failure refuses the push (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, "scripts"));
		writeFileSync(join(archive, "scripts/tool.sh"), "#!/bin/sh\necho tool-ok\n");
		writeFileSync(join(archive, "tests/cli/tool.test.sh"), '#!/bin/sh\nROOT=$(pwd)\nout=$(sh "$ROOT/scripts/tool.sh")\n[ "$out" = tool-ok ] || { echo "tool said $out" >&2; exit 1; }\necho "tool: 1 pass 0 fail"\n');
		const green = runFocused(fx, source, archive, "scripts/tool.sh");
		expect(green.code).toBe(0);
		expect(green.out).toContain("affected: tests/cli/tool.test.sh <- scripts/tool.sh");
		expect(green.out).toContain("GREEN script-suite tests/cli/tool.test.sh");
		expect(green.out).toContain("FRESH-GATE: VERDICT TESTED files=1 ran=1");
		writeFileSync(join(archive, "scripts/tool.sh"), "#!/bin/sh\necho tool-broken\n");
		const red = runFocused(fx, source, archive, "scripts/tool.sh");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("RED script-suite tests/cli/tool.test.sh");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("CIGATE1 planted: sbh pressure with ample bytes runs the affected tests; the old admission refuses, never passes silently (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(1, { slots: 8, max_wait_s: 1 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		const ran = runFocused(fx, source, archive, "lib/mod.ts");
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("affected tests: files=1 ran=1 fail=0 rc=0");
		// Mutant: 2026-10-19's admission (heavy's default observer, which takes sbh's verdict). The plant
		// now refuses with heavy's reason where the old gate printed "deferred to CI" and went GREEN.
		const sbhVeto = source.replace('heavy --label "fresh-gate-$step" --disk-observer statfs --', 'heavy --label "fresh-gate-$step" --no-wait --');
		expect(sbhVeto).not.toBe(source);
		const refused = runFocused(fx, sbhVeto, archive, "lib/mod.ts");
		expect(refused.code).toBe(75);
		expect(refused.out).toContain("disk low: sbh check --need 10G reports pressure");
		expect(refused.out).toContain("FRESH-GATE: RED: heavy refused admission for tests (exit 75)");
		expect(refused.out).not.toContain("deferred to CI");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("CIGATE1: the disk floor reads statfs and refuses unreadable space with a typed reason", () => {
	const floor = (dir: string) => Bun.spawnSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", join(root, "scripts/gate-disk-floor.ts"), dir], { stdout: "pipe", stderr: "pipe" });
	const missing = floor(join(scratchRoot, `no-such-dir-${process.pid}`));
	expect(missing.exitCode).toBe(69);
	expect(missing.stderr.toString()).toContain("FRESH-GATE: REFUSED reason=DISK_OBSERVER_UNAVAILABLE observer=statfs");
	const here = floor(root);
	if (AMPLE) {
		expect(here.exitCode).toBe(0);
		expect(here.stdout.toString()).toContain("disk-floor: OK free_bytes=");
	} else {
		expect(here.exitCode).toBe(1);
		expect(here.stderr.toString()).toContain("reason=DISK_BELOW_FLOOR need=10G");
	}
});

test.skipIf(LOW_BASE === null)("CIGATE1 planted: below the 10 GiB physical floor the gate refuses naming the space needed, and no test runs", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	fx.env.FRESH_GATE_TEST_REAL_STATFS = "1";
	const low = ownedTmp("fresh-gate-lowfs", { root: LOW_BASE as string }).path;
	try {
		writeFileSync(join(low, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-lowfs\ncreated=${new Date().toISOString()}\n`);
		expect(freeBytes(low)).toBeLessThan(NEED_BYTES);
		const refused = runFocused(fx, source, affectedArchive(fx, 42, 42, low), "lib/mod.ts");
		expect(refused.code).toBe(1);
		expect(refused.out).toMatch(/FRESH-GATE: REFUSED reason=DISK_BELOW_FLOOR need=10G need_bytes=10737418240 free_bytes=[0-9]+ observer=statfs/);
		expect(refused.out).not.toContain("affected tests:");
		expect(refused.out).not.toContain("GREEN");
	} finally {
		rmSync(low, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

// ---- CIGATE1 CI-only manifest: explicit, printed exclusions that turn the verdict PARTIAL ----------
function gateTree(fx: SaveFixture, manifest: string): string {
	const dir = ownedTmp("gate", { root: fx.dir }).path;
	mkdirSync(join(dir, "scripts"));
	symlinkSync(join(root, "src"), join(dir, "src"));
	for (const name of ["affected-tests.ts", "gate-disk-floor.ts"]) cpSync(join(root, "scripts", name), join(dir, "scripts", name));
	for (const name of ["suite-metrics.py", "full-suite-verdict-store.py", "test-budget.ts", "fresh-gate.sh", ...JUDGE_SUPPORT]) symlinkSync(join(root, "scripts", name), join(dir, "scripts", name));
	mkdirSync(join(dir, ".github"));
	cpSync(join(root, ".github/test-budget.json"), join(dir, ".github/test-budget.json"));
	writeFileSync(join(dir, "scripts/gate-ci-only.tsv"), manifest);
	return join(dir, "scripts");
}
const MANIFEST_HEADER = "path\tkind\tbead\texpires\treason\n";
function isoDay(offsetDays: number): string {
	return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test.skipIf(!AMPLE)("CIGATE1 manifest: a CI-only test is excluded and printed, and the verdict is PARTIAL naming it (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "tests/cli/live.test.ts"), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("needs a live service", () => { expect(answer()).toBe(0); });\n`);
		const scripts = gateTree(fx, `${MANIFEST_HEADER}tests/cli/live.test.ts\tci-only\tompkit-test.1\t-\tneeds a live service\n`);
		const partial = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(partial.code).toBe(0);
		expect(partial.out).toContain("focused: excluded tests/cli/live.test.ts (ci-only ompkit-test.1: needs a live service); CI runs it");
		expect(partial.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1 deferred=tests/cli/live.test.ts: CI runs the deferred files");
		expect(partial.out).not.toContain("VERDICT TESTED");
		// Mutant: no manifest filter runs the CI-only test here, and its live dependency refuses the push.
		const unfiltered = source.replace("\tfocus_tests=$(apply_ci_only $focus_tests) || return $?\n", "");
		expect(unfiltered).not.toBe(source);
		expect(runFocused(fx, unfiltered, archive, "lib/mod.ts", scripts).code).not.toBe(0);
		// Every test reaching changed code CI-only: refused, never a pass that ran nothing.
		const onlyLive = runFocused(fx, source, archive, "lib/mod.ts", gateTree(fx, `${MANIFEST_HEADER}tests/cli/live.test.ts\tci-only\tompkit-test.1\t-\tlive\ntests/cli/mod.test.ts\tci-only\tompkit-test.2\t-\tlive\n`));
		expect(onlyLive.code).toBe(1);
		expect(onlyLive.out).toContain("FRESH-GATE: REFUSED reason=NO_LOCAL_TESTS code=lib/mod.ts ci_only=tests/cli/live.test.ts,tests/cli/mod.test.ts");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("CIGATE1 manifest: hermeticity rows expire within 14 days; an expired row runs; malformed rows refuse", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const probe = join(fx.dir, "manifest-probe.sh");
		writeFileSync(probe, `${gateFunctions(source, ["apply_ci_only"])}apply_ci_only tests/cli/a.test.ts tests/cli/b.test.ts\n`);
		const filter = (manifest: string) => {
			const scripts = gateTree(fx, manifest);
			const result = Bun.spawnSync(["sh", probe], { env: { ...process.env, SCRIPT_DIR: scripts, WORK: fx.env.WORK }, stdout: "pipe", stderr: "pipe" });
			return { code: result.exitCode, kept: result.stdout.toString().split("\n").filter(Boolean), err: result.stderr.toString() };
		};
		const live = filter(`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(13)}\tHOME race\n`);
		expect(live.code).toBe(0);
		expect(live.kept).toEqual(["tests/cli/b.test.ts"]);
		const expired = filter(`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(-1)}\tHOME race\n`);
		expect(expired.kept).toEqual(["tests/cli/a.test.ts", "tests/cli/b.test.ts"]);
		expect(expired.err).toContain(`ci-only manifest row for tests/cli/a.test.ts (ompkit-test.3) EXPIRED ${isoDay(-1)}; it runs`);
		for (const [manifest, why] of [
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(30)}\tHOME race\n`, "a hermeticity row expires by"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t-\tHOME race\n`, "a hermeticity row expires by"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\tci-only\t\t-\tno bead\n`, "needs 5 non-empty tab-separated fields"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\tskip\tompkit-test.3\t-\twhy\n`, "kind is ci-only or hermeticity"],
			["tests/cli/a.test.ts\tci-only\tompkit-test.3\t-\tno header\n", "line 1 is not the header"],
		] as const) {
			const bad = filter(manifest);
			expect(bad.code).toBe(3);
			expect(bad.kept).toEqual([]);
			expect(bad.err).toContain("FRESH-GATE: REFUSED reason=CI_ONLY_MANIFEST_INVALID");
			expect(bad.err).toContain(why);
		}
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("CIGATE1 manifest: the checked-in manifest is valid and names only existing tests", () => {
	const manifest = readFileSync(join(root, "scripts/gate-ci-only.tsv"), "utf8").trim().split("\n");
	expect(manifest[0]).toBe("path\tkind\tbead\texpires\treason");
	for (const row of manifest.slice(1)) {
		const [path, kind, bead, expires, reason] = row.split("\t");
		expect(existsSync(join(root, path as string))).toBe(true);
		expect(["ci-only", "hermeticity"]).toContain(kind as string);
		expect(bead).toStartWith("ompkit-");
		expect(reason?.length ?? 0).toBeGreaterThan(10);
		if (kind === "ci-only") expect(expires).toBe("-");
	}
	const liveReservation = manifest.slice(1).map((row) => row.split("\t"))
		.find(([path]) => path === "tests/fleet-guard/reservations.live.test.ts");
	expect(liveReservation?.[1]).toBe("ci-only");
	expect(liveReservation?.[3]).toBe("-");
	expect(liveReservation?.[4]).toContain("owner=SilverCondor");
	expect(liveReservation?.[4]).toContain("Agent Mail");
});

test.skipIf(!AMPLE)("CIGATE1 wall budget: past the budget the nearest tests run and the rest are deferred by name in a PARTIAL verdict (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		for (const n of [2, 3]) writeFileSync(join(archive, `tests/cli/mod${n}.test.ts`), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("answer ${n}", () => { expect(answer()).toBe(42); });\n`);
		// Untimed files plan at 10 s each; a 5 s budget keeps only the changed test (nearest first).
		fx.env.FRESH_GATE_TEST_BUDGET_SECS = "5";
		const partial = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod3.test.ts");
		expect(partial.code).toBe(0);
		expect(partial.out).toContain("affected-tests plan: run 1, defer 2");
		expect(partial.out).toContain("focused: deferred tests/cli/mod.test.ts (over the 5 s wall budget); the release's full suite runs it");
		expect(partial.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1 deferred=tests/cli/mod.test.ts,tests/cli/mod2.test.ts: CI runs the deferred files");
		delete fx.env.FRESH_GATE_TEST_BUDGET_SECS;
		const full = runFocused(fx, source, archive, "lib/mod.ts");
		expect(full.out).toContain("FRESH-GATE: VERDICT TESTED files=3 ran=3");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("hecp: fresh-gate preserves an explicit case root and forces no location default", () => {
	const script = readFileSync(gate, "utf8");
	const start = script.indexOf("setup_case_env() {");
	expect(start).toBeGreaterThan(-1);
	const end = script.indexOf("\n}\n", start);
	expect(end).toBeGreaterThan(start);
	const fn = script.slice(start, end + 3);
	mkdirSync(scratchRoot, { recursive: true });
	const probe = join(scratchRoot, `hecp-case-env-${process.pid}.sh`);
	writeFileSync(probe, fn + "\nsetup_case_env\n" + "if [ -n \"${OMP_KIT_CASE_CWD+set}\" ]; then printf \"CASE_CWD=%s\\n\" \"$OMP_KIT_CASE_CWD\"; else printf \"CASE_CWD_UNSET\\n\"; fi\n");
	try {
		// An explicit caller override (e.g. pre-push-gate) passes through untouched.
		const explicit = Bun.spawnSync(["sh", probe], { env: { ...process.env, OMP_KIT_CASE_CWD: "/caller/repo" }, stdout: "pipe", stderr: "pipe" });
		expect(explicit.exitCode).toBe(0);
		expect(explicit.stdout.toString()).toContain("CASE_CWD=/caller/repo");
		// Without an override no location-dependent default is forced: the harness
		// hermetic root applies, so the verdict cannot depend on where the archive
		// was extracted.
		const cleanEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined && key !== "OMP_KIT_CASE_CWD") cleanEnv[key] = value;
		}
		const implicit = Bun.spawnSync(["sh", probe], { cwd: scratchRoot, env: cleanEnv, stdout: "pipe", stderr: "pipe" });
		expect(implicit.exitCode).toBe(0);
		expect(implicit.stdout.toString()).toContain("CASE_CWD_UNSET");
	} finally {
		rmSync(probe, { force: true });
	}
});

afterAll(() => cleanupAllOwnedTmp());
