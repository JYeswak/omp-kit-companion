import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeBundledHarness } from "./release-manifest-fixture.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const root = resolve(import.meta.dir, "../..");
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
const NEED_BYTES = 10 * 1024 ** 3;
function freeBytes(directory: string): number {
	const observed = statfsSync(directory);
	return Number(observed.bavail) * Number(observed.bsize);
}
const AMPLE = freeBytes(root) >= NEED_BYTES;
function lowCapacityBase(): string | null {
	for (const candidate of [process.env.OMP_KIT_TEST_LOW_FS_DIR, process.platform === "linux" ? "/dev/shm" : undefined]) {
		if (!candidate) continue;
		try {
			if (freeBytes(candidate) < NEED_BYTES) return candidate;
		} catch { /* absent or unreadable: try the next candidate */ }
	}
	return null;
}
const LOW_BASE = lowCapacityBase();

function gateFunctions(source: string, names: readonly string[]): string {
	return names.map((name) => {
		const start = source.indexOf(`\n${name}() {`);
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n}\n", start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start + 1, end + 3);
	}).join("");
}

type SaveFixture = { dir: string; env: Record<string, string> };
function saveFixture(sbhCode: number, config: Record<string, number>): SaveFixture {
	const dir = ownedTmp("fresh-gate-save", { root: scratchRoot }).path;
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-save-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nif [ "$1 $2 $3" = "check --need 10G" ]; then printf '{"command":"check","exit_code":${sbhCode},"free_pct":11.694169037987928}\\n'; exit ${sbhCode}; fi\nexit 0\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	const fakeBun = join(bin, "bun");
	const statfsPreload = join(root, "tests/cli/fixtures/forge-healthy-statfs.ts");
	const runPrefix = `exec "${process.execPath}"`;
	const healthyRunPrefix = `${runPrefix} --preload "${statfsPreload}"`;
	writeFileSync(fakeBun, `#!/bin/sh
if [ "$1" = "run" ]; then
  shift
  if [ "$FRESH_GATE_TEST_REAL_STATFS" = "1" ]; then
    ${runPrefix} "$@"
  else
    ${healthyRunPrefix} "$@"
  fi
fi
exec "${process.execPath}" "$@"
`);
	chmodSync(fakeBun, 0o755);
	mkdirSync(join(dir, "config", "omp-kit"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "config", "omp-kit", "load.json"), JSON.stringify(config), { mode: 0o600 });
	mkdirSync(join(dir, "work"));
	const env = {
		PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"),
		TMUX_PANE: "", AGENT_NAME: "fresh-gate-save-test", GITHUB_ACTIONS: "", OMP_KIT_DISK_OBSERVER: "", OMP_KIT_CASE_CWD: "", OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", WORK: join(dir, "work"), COMMIT: "HEAD",
	};
	return { dir, env };
}

function runProbe(fx: SaveFixture, source: string, body: string, cwd = root) {
	const probe = join(fx.dir, `probe-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(probe, `set -eu\n${gateFunctions(source, ["fail", "heavy_step", "disk_pressure_flag", "judge_budget"])}cd '${cwd}'\n${body}\n`);
	const started = Date.now();
	const result = Bun.spawnSync(["sh", probe], { env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
	return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), seconds: (Date.now() - started) / 1000 };
}

test.skipIf(!AMPLE)("SAVEFIRST1 planted (a): sbh pressure with ample bytes admits the save step and prints one WARN (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(1, { slots: 8, max_wait_s: 1 });
	try {
		// Positive control for the plant: this sbh really vetoes heavy's default admission.
		const veto = Bun.spawnSync([process.execPath, "run", "--no-env-file", "--config=/dev/null", "src/cli.ts", "heavy", "--no-wait", "--", "true"], { cwd: root, env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
		expect(veto.exitCode).toBe(75);
		expect(veto.stderr.toString()).toContain("disk low: sbh check --need 10G reports pressure");
		const marker = join(fx.dir, "saved");
		const body = `disk_pressure_flag\nheavy_step cli-compile sh -c 'printf ran > "$1"' sh '${marker}'`;
		const saved = runProbe(fx, source, body);
		expect(saved.code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("ran");
		expect(saved.out.split("\n").filter((line) => line.startsWith("WARN disk-pressure:"))).toEqual([
			"WARN disk-pressure: sbh reports 11.7% free (below its floor); saving continues on the 10 GiB physical floor; run waste management (ompkit-774u.15)",
		]);
		expect(saved.out).not.toContain("RED");
		// Mutant: the step without its statfs override is vetoed by sbh again.
		const mutant = source.replace("heavy --label \"fresh-gate-$step\" --disk-observer statfs --", "heavy --label \"fresh-gate-$step\" --");
		expect(mutant).not.toBe(source);
		rmSync(marker, { force: true });
		const vetoed = runProbe(fx, mutant, body);
		expect(vetoed.code).toBe(75);
		expect(existsSync(marker)).toBe(false);
		expect(vetoed.out).toContain("FRESH-GATE: RED: heavy refused admission for cli-compile (exit 75)");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

test("SAVEFIRST1: no WARN when sbh is healthy or absent", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		expect(runProbe(fx, source, "disk_pressure_flag").out).not.toContain("WARN");
		fx.env.PATH = "/usr/bin:/bin";
		const absent = runProbe(fx, source, "disk_pressure_flag");
		expect(absent.code).toBe(0);
		expect(absent.out).not.toContain("WARN");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test.skipIf(LOW_BASE === null)("SAVEFIRST1 planted (b): below the 10 GiB physical floor the save step is still refused with a typed reason, even with sbh healthy", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	const low = ownedTmp("fresh-gate-lowfs", { root: LOW_BASE as string }).path;
	try {
		writeFileSync(join(low, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-lowfs\ncreated=${new Date().toISOString()}\n`);
		fx.env.FRESH_GATE_TEST_REAL_STATFS = "1";
		expect(freeBytes(low)).toBeLessThan(NEED_BYTES);
		// The step runs in the archive; here the archive's src is the checkout's, reached from the small filesystem.
		symlinkSync(join(root, "src"), join(low, "src"));
		const marker = join(fx.dir, "lowfs-ran");
		const refused = runProbe(fx, source, `heavy_step cli-compile sh -c 'printf ran > "$1"' sh '${marker}'`, low);
		expect(refused.code).toBe(75);
		expect(existsSync(marker)).toBe(false);
		expect(refused.out).toContain("waiting: disk low (statfs)");
		expect(refused.out).toContain("deferred: queue timeout");
		expect(refused.out).toContain("FRESH-GATE: RED: heavy refused admission for cli-compile (exit 75)");
	} finally {
		rmSync(low, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

test.skipIf(!AMPLE)("planted: a heavy step runs on the gate's own PATH, never bun run's ancestor node_modules/.bin (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		// The fixture's fake bun drops `run`, and `run` is the PATH injection under test: use the real bun.
		rmSync(join(fx.dir, "bin", "bun"));
		symlinkSync(process.execPath, join(fx.dir, "bin", "bun"));
		mkdirSync(join(fx.dir, "node_modules", ".bin"), { recursive: true });
		const archive = join(fx.dir, "archive");
		mkdirSync(archive);
		symlinkSync(join(root, "src"), join(archive, "src"));
		const marker = join(fx.dir, "step-path");
		const body = `heavy_step tests sh -c 'printf %s "$PATH" > "$1"' sh '${marker}'`;
		expect(runProbe(fx, source, body, archive).code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe(fx.env.PATH);
		// Plant: without the pin, the same step sees the archive's ancestor node_modules/.bin first.
		const mutant = source.replace(`env PATH="$PATH" sh -c 'date`, `sh -c 'date`);
		expect(mutant).not.toBe(source);
		expect(runProbe(fx, mutant, body, archive).code).toBe(0);
		expect(readFileSync(marker, "utf8").split(":")).toContain(join(fx.dir, "node_modules", ".bin"));
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 30_000);

// A peer's running heavy job: an orphaned sleep (re-parented, so its exit is reaped while this test
// blocks in spawnSync and heavy's liveness probe sees it end) recorded as the slot holder.
function holdSlot(fx: SaveFixture, seconds: number): void {
	const pid = Bun.spawnSync(["sh", "-c", `sleep ${seconds} >/dev/null 2>&1 & echo $!`], { stdout: "pipe" }).stdout.toString().trim();
	const lstart = Bun.spawnSync(["ps", "-p", pid, "-o", "lstart="], { stdout: "pipe" }).stdout.toString().trim();
	expect(lstart).not.toBe("");
	const jobs = join(fx.dir, "state", "omp-kit", "load", "jobs");
	mkdirSync(jobs, { recursive: true, mode: 0o700 });
	writeFileSync(join(jobs, "holder.json"), JSON.stringify({
		id: "holder", pid: Number(pid), process_start: lstart, label: "stuck-peer", repo: fx.dir, cwd: fx.dir, agent: "peer",
		tmux_pane: "", argv: ["sleep"], state: "running", queued_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
	}), { mode: 0o600 });
}

test("SAVEFIRST1 planted (c): heavy queue wait is recorded apart from the step's own work", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 1, max_wait_s: 20 });
	const marker = join(fx.dir, "worked");
	// 4 s of work against whole-second gate clocks: each recorded second may be off by up to 1 s.
	const body = `heavy_step harness sh -c 'sleep 4; printf ran > "$1"' sh '${marker}'`;
	const queued = (fixture: SaveFixture) => Number(readFileSync(join(fixture.env.WORK, "queued.secs"), "utf8").trim());
	try {
		holdSlot(fx, 3);
		const honest = runProbe(fx, source, body);
		expect(honest.code).toBe(0);
		expect(readFileSync(marker, "utf8")).toBe("ran");
		const wait = queued(fx);
		expect(wait).toBeGreaterThanOrEqual(2);
		expect(wait).toBeLessThanOrEqual(5);
		expect(honest.out).toContain(`heavy admission wait: ${wait}s (harness)`);
		// The 4 s of work is not wait: wall time exceeds the recorded wait by the work, less clock rounding.
		expect(honest.seconds - wait).toBeGreaterThanOrEqual(2.5);
		// Mutant: timing the whole step as wait swallows the work.
		const mutant = source.replace('wait_s=$(($(cat "$admitted") - queued_at))', "wait_s=$(($(date +%s) - queued_at))");
		expect(mutant).not.toBe(source);
		rmSync(join(fx.env.WORK, "queued.secs"));
		holdSlot(fx, 3);
		const swallowed = runProbe(fx, mutant, body);
		expect(swallowed.code).toBe(0);
		expect(swallowed.seconds - queued(fx)).toBeLessThan(2);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

test("SAVEFIRST1 planted (c): the 180 s budget subtracts queue wait but still judges slow gate work", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	try {
		const queuedLong = runProbe(fx, source, "judge_budget 200 0 30");
		expect(queuedLong.code).toBe(0);
		expect(queuedLong.out).toContain("FRESH-GATE: GREEN commit=HEAD elapsed=200s tests=0s queued=30s judged=170s");
		const slowWork = runProbe(fx, source, "judge_budget 200 0 15");
		expect(slowWork.code).toBe(1);
		expect(slowWork.out).toContain("FRESH-GATE: RED: elapsed=200s (affected tests 0s, heavy queue wait 15s, judged 185s) exceeds 180s");
		// CIGATE1: the affected tests' own run time is reported beside the machinery budget, not judged by it.
		const testsLong = runProbe(fx, source, "judge_budget 200 30 0");
		expect(testsLong.code).toBe(0);
		expect(testsLong.out).toContain("FRESH-GATE: GREEN commit=HEAD elapsed=200s tests=30s queued=0s judged=170s");
		// Mutant: queue wait judged as gate time fails the push queued behind a stuck job.
		const mutant = source.replace("judged=$(($1 - $2 - $3))", "judged=$(($1 - $2))");
		expect(mutant).not.toBe(source);
		expect(runProbe(fx, mutant, "judge_budget 200 0 30").code).toBe(1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ---- CIGATE1 (ompkit-v66l.27.1): the push runs the tests its diff affects, or refuses ---------------
// The real selector, disk floor, heavy and bun test run against a small exact-tree fixture; src is the
// checkout's (heavy runs from it), the code under test lives in lib/ so the fixture owns its edits.
const FOCUSED_FUNCTIONS = ["fail", "heavy_step", "print_budget_skip", "select_affected_tests", "test_workers", "run_affected_tests", "changed_code", "apply_ci_only", "record_run", "gate_focused"];
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
	writeFileSync(join(dir, "tests/cli/mod.test.ts"), `import { expect, test } from "bun:test";\nimport { join } from "node:path";\nimport { answer } from "../../lib/mod.ts";\ntest("answer and gate-owned TMPDIR", () => { expect(answer()).toBe(${expected}); expect(process.env.TMPDIR).toBe(join(import.meta.dir, "../../var/agent-tmp")); });\n`);
	writeFileSync(join(dir, "docs/notes.md"), "# notes\n");
	return dir;
}
function runFocused(fx: SaveFixture, source: string, archive: string, changed: string, scriptDir = join(root, "scripts")) {
	const probe = join(fx.dir, `focused-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(probe, `set -eu\n${gateFunctions(source, FOCUSED_FUNCTIONS)}rc=0\ngate_focused || rc=$?\nexit "$rc"\n`);
	const started = Date.now();
	const result = Bun.spawnSync(["sh", probe], {
		env: { ...process.env, ...fx.env, ROOT: root, TMPDIR: join(fx.dir, "caller-tmp"), ...SKIP_BUDGET, ARCHIVE_DIR: archive, SCRIPT_DIR: scriptDir, CHANGED: changed, FRESH_GATE_LEDGER: join(fx.dir, "runs.jsonl") },
		stdout: "pipe", stderr: "pipe",
	});
	return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), seconds: (Date.now() - started) / 1000 };
}
function ledger(fx: SaveFixture): Array<Record<string, unknown>> {
	const path = join(fx.dir, "runs.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
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
		return { path: row.path, started_ms: row.started_ms, finished_ms: row.finished_ms, elapsed_ms: row.elapsed_ms, rc: row.rc };
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

test.skipIf(!AMPLE)("SUITEBUDGET1 refuses a successful file over its measured policy cap", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const judge = join(fx.dir, "judge");
		const scripts = join(judge, "scripts");
		mkdirSync(scripts, { recursive: true });
		mkdirSync(join(judge, ".github"));
		for (const name of ["fresh-gate.sh", "gate-disk-floor.ts", "suite-metrics.py", "test-budget.ts", "affected-tests.ts", "gate-ci-only.tsv"]) {
			symlinkSync(join(root, "scripts", name), join(scripts, name));
		}
		const policy = join(judge, ".github/test-budget.json");
		const configure = (cycle: number) => writeFileSync(policy, JSON.stringify({
			version: 1, requirements: { push_p95_s: 600, full_cycle_s: cycle },
			initial_heuristic: { per_file_cap_s: cycle / 4, derivation: "full_cycle_s / 4",
				status: "INITIAL_HEURISTIC_NOT_DISTRIBUTION_DERIVED" },
		}));
		const archive = affectedArchive(fx, 42, 42);
		configure(900);
		const control = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(control.code, control.out).toBe(0);
		// A fixture-only tiny cap exercises the real measured refusal without a
		// five-minute sleeper or a forged timing row. Product policy is untouched.
		configure(0.004);
		const refused = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(refused.code, refused.out).not.toBe(0);
		expect(refused.out).toContain("OVER_BUDGET");
		expect(refused.out).toContain("tests/cli/mod.test.ts");
		const record = ledger(fx).at(-1)!;
		expect(record.rc).not.toBe(0);
		const files = measuredFiles(record);
		expect(files[0]!.rc).toBe(0);
		expect(files[0]!.elapsed_ms).toBeGreaterThan(1);
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
		expect(slow.code, slow.out).not.toBe(0);
		expect(slow.out).toContain("OVER_BUDGET");
		expect(slow.out).toContain("tests/cli/three-hundred.test.sh");
		expect(slow.out).toContain('"cap_s":225');
		const rows = measuredFiles(ledger(fx).at(-1)!);
		expect(rows[0]!.elapsed_ms).toBeGreaterThanOrEqual(300000);
		expect(rows[0]!.rc).toBe(0);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 360_000);

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
	for (const name of ["suite-metrics.py", "test-budget.ts", "fresh-gate.sh"]) symlinkSync(join(root, "scripts", name), join(dir, "scripts", name));
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
		expect(partial.out).toContain("focused: deferred tests/cli/mod.test.ts (over the 5 s wall budget); CI runs it");
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
