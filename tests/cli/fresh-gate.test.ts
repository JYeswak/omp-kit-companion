import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeBundledHarness } from "./release-manifest-fixture.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";

import { AMPLE, SKIP_BUDGET, candidateRepo, gate, gateFunctions, root, scratchRoot } from "./fresh-gate.helpers.ts";

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
function manifestTestEnv(dir: string): Record<string, string> {
	// Full-suite exports have no predecessor history. Give this manifest-only
	// fixture its own real baseline so the next gate phase reaches the Bun
	// stop marker without weakening production's missing-baseline refusal.
	const repo = candidateRepo({ dir, env: {} });
	mkdirSync(join(repo, ".github"));
	cpSync(join(root, ".github/test-budget.json"), join(repo, ".github/test-budget.json"));
	const identity = ["-c", "user.name=fresh-gate test", "-c", "user.email=fresh-gate@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false"];
	for (const args of [["add", ".github/test-budget.json"], [...identity, "commit", "-q", "-m", "[test] manifest budget baseline"], [...identity, "commit", "-q", "--allow-empty", "-m", "[test] manifest candidate"]]) {
		const result = runSync(["git", "-C", repo, ...args], { deadline_s: 10 });
		if (result.rc !== 0) throw new Error(`manifest budget baseline: ${new TextDecoder().decode(result.stderr)}`);
	}
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
	return { ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, FRESH_GATE_REPO: repo };
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

// ---- CIGATE1 (ompkit-v66l.27.1): the push runs the tests its diff affects, or refuses ---------------
// The real selector, disk floor, heavy and bun test run against a small exact-tree fixture; src is the
// checkout's (heavy runs from it), the code under test lives in lib/ so the fixture owns its edits.


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
