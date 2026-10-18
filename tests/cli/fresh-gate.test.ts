import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeBundledHarness } from "./release-manifest-fixture.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
const gate = join(root, "scripts/fresh-gate.sh");

function fixture(): string {
	const dir = mkdtempSync(join(scratchRoot, "fresh-gate-test-"));
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
	const start = script.indexOf("gate_focused() {");
	expect(start).toBeGreaterThan(-1);
	const end = script.indexOf("\n}\n", start);
	expect(end).toBeGreaterThan(start);
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
		writeFileSync(probe, `run_bun_suite() { [ -e "$ARCHIVE_DIR/$1" ] || { echo "bun test: missing $1" >&2; return 1; }; echo "RAN $1"; }\n${script.slice(start, end + 3)}\ngate_focused\n`);
		const focused = (changed: string) => Bun.spawnSync(["sh", probe], {
			env: { ...process.env, ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ARCHIVE_DIR: dir, CHANGED: changed },
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
	const start = script.indexOf("gate_focused() {");
	expect(start).toBeGreaterThan(-1);
	const end = script.indexOf("\n}\n", start);
	expect(end).toBeGreaterThan(start);
	const dir = fixture();
	try {
		writeFileSync(join(dir, "scripts/bad.sh"), "#!/bin/sh\nset -u\nx=\"${1:-}\"\ny=\"${2:-}\"\n[ -n \"$x\" ] && [ -n \"$y\" ] || { echo \"need x and y\" >&2; exit 2; }\n");
		writeFileSync(join(dir, "scripts/good.sh"), "#!/bin/sh\nexit 0\n");
		writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
		const fakeBin = join(dir, "bin");
		mkdirSync(fakeBin);
		writeFileSync(join(fakeBin, "shellcheck"), "#!/bin/sh\necho \"SHELLCHECK $1\"\n");
		chmodSync(join(fakeBin, "shellcheck"), 0o755);
		writeFileSync(join(fakeBin, "docker"), "#!/bin/sh\n# fake docker: emulate pinned v0.9.0, which refuses A && B || C (SC2015) where newer builds stay silent.\nif [ \"$1\" = \"image\" ]; then echo \"fake image present\"; exit 0; fi\nif [ \"$1\" = \"pull\" ]; then echo \"fake pull ok\"; exit 0; fi\nif [ \"$1\" = \"run\" ]; then\n  file=\"\"\n  for arg in \"$@\"; do case \"$arg\" in /archive/*) file=\"$arg\" ;; esac; done\n  real=\"$FAKE_ARCHIVE${file#/archive}\"\n  if grep -q '|| {' \"$real\" 2>/dev/null; then echo \"DOCKER-SHELLCHECK $file: SC2015 (info): A && B || C is not if-then-else\" >&2; exit 1; fi\n  echo \"DOCKER-SHELLCHECK $file: clean\"\n  exit 0\nfi\necho \"fake docker: unexpected $*\" >&2; exit 2\n");
		chmodSync(join(fakeBin, "docker"), 0o755);
		const probe = join(dir, "focused-probe.sh");
		writeFileSync(probe, `set -e\nprint_budget_skip() { echo "BUDGET-SKIP"; }\nrun_bun_suite() { [ -e "$ARCHIVE_DIR/$1" ] || { echo "bun test: missing $1" >&2; return 1; }; echo "RAN $1"; }\n${script.slice(start, end + 3)}\ngate_focused\n`);
		const focused = (changed: string) => Bun.spawnSync(["sh", probe], {
			env: { ...process.env, ...SKIP_BUDGET, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, ARCHIVE_DIR: dir, FAKE_ARCHIVE: dir, CHANGED: changed },
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
	const dir = mkdtempSync(join(scratchRoot, "fresh-gate-save-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-save-test\nrepo=${root}\ncreated=${new Date().toISOString()}\n`);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "sbh"), `#!/bin/sh\nif [ "$1 $2 $3" = "check --need 10G" ]; then printf '{"command":"check","exit_code":${sbhCode},"free_pct":11.694169037987928}\\n'; exit ${sbhCode}; fi\nexit 0\n`);
	chmodSync(join(bin, "sbh"), 0o755);
	mkdirSync(join(dir, "config", "omp-kit"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "config", "omp-kit", "load.json"), JSON.stringify(config), { mode: 0o600 });
	mkdirSync(join(dir, "work"));
	const env = {
		PATH: `${bin}:${process.env.PATH ?? ""}:/usr/bin:/bin`, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"),
		TMUX_PANE: "", AGENT_NAME: "fresh-gate-save-test", GITHUB_ACTIONS: "", OMP_KIT_HEAVY_FAKE_LOAD1: "0.5", WORK: join(dir, "work"), COMMIT: "HEAD",
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
		expect(saved.out).toMatch(/^heavy admission wait: [01]s \(cli-compile\)$/m);
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
	const low = mkdtempSync(join(LOW_BASE as string, "fresh-gate-lowfs."));
	try {
		writeFileSync(join(low, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-lowfs\ncreated=${new Date().toISOString()}\n`);
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
		expect(queuedLong.out).toContain("FRESH-GATE: GREEN commit=HEAD elapsed=200s deferred=0s queued=30s judged=170s");
		const slowWork = runProbe(fx, source, "judge_budget 200 0 15");
		expect(slowWork.code).toBe(1);
		expect(slowWork.out).toContain("FRESH-GATE: RED: elapsed=200s (deferred to CI 0s, heavy queue wait 15s, judged 185s) exceeds 180s");
		expect(runProbe(fx, source, "judge_budget 200 30 0").code).toBe(0);
		// Mutant: queue wait judged as gate time fails the push queued behind a stuck job.
		const mutant = source.replace("judged=$(($1 - $2 - $3))", "judged=$(($1 - $2))");
		expect(mutant).not.toBe(source);
		expect(runProbe(fx, mutant, "judge_budget 200 0 30").code).toBe(1);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});
