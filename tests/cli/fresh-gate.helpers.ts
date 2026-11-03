// Coverage: scripts/fresh-gate.sh, scripts/build-manifest.sh, scripts/rule-class.ts,
// scripts/affected-tests.ts, scripts/test-budget.ts, scripts/gate-ci-only.ts, scripts/gate-disk-floor.ts,
// scripts/suite-metrics.py, scripts/full-suite-verdict.sh, scripts/full-suite-verdict-store.py,
// scripts/suite-hermetic-env.sh, scripts/kitlib_run.py, scripts/kitlib_tmp.py, scripts/pysafe.py,
// scripts/kitlib-tmp.sh, src/cli.ts, src/kitlib/run.ts, src/kitlib/tmp.ts.
import { expect } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run.ts";

export const root = resolve(import.meta.dir, "../..");
export const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
export const gate = join(root, "scripts/fresh-gate.sh");
export const NEED_BYTES = 10 * 1024 ** 3;
export function freeBytes(directory: string): number {
	const observed = statfsSync(directory);
	return Number(observed.bavail) * Number(observed.bsize);
}
export const AMPLE = freeBytes(root) >= NEED_BYTES;
function lowCapacityBase(): string | null {
	for (const candidate of [process.env.OMP_KIT_TEST_LOW_FS_DIR, process.platform === "linux" ? "/dev/shm" : undefined]) {
		if (!candidate) continue;
		try {
			if (freeBytes(candidate) < NEED_BYTES) return candidate;
		} catch { /* absent or unreadable: try the next candidate */ }
	}
	return null;
}
export const LOW_BASE = lowCapacityBase();

export function gateFunctions(source: string, names: readonly string[]): string {
	return names.map((name) => {
		const start = source.indexOf(`\n${name}() {`);
		expect(start).toBeGreaterThan(-1);
		const end = source.indexOf("\n}\n", start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start + 1, end + 3);
	}).join("");
}

export type SaveFixture = { dir: string; env: Record<string, string> };
export function saveFixture(sbhCode: number, config: Record<string, number>): SaveFixture {
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

export function runProbe(fx: SaveFixture, source: string, body: string, cwd = root) {
	const probe = join(fx.dir, `probe-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(probe, `set -eu\n${gateFunctions(source, ["fail", "heavy_step", "disk_pressure_flag", "judge_budget"])}cd '${cwd}'\n${body}\n`);
	const started = Date.now();
	const result = runSync(["sh", probe], { env: { ...process.env, ...fx.env }, deadline_s: 120 });
	return { code: result.rc, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(), seconds: (Date.now() - started) / 1000 };
}
export function copyJudgingFiles(destination: string, exclude: string[] = []): void {
	const result = runSync(["python3", "-m", "suite-metrics", "judging-files"], { env: { ...process.env, PYTHONPATH: join(root, "scripts") }, deadline_s: 10 });
	if (result.rc !== 0) throw new Error(Buffer.from(result.stderr).toString());
	for (const path of Buffer.from(result.stdout).toString().trim().split("\n")) {
		if (exclude.includes(path)) continue;
		mkdirSync(resolve(destination, path, ".."), { recursive: true });
		// Preserve script-relative imports through the source checkout, as the original fixture did.
		if (path.startsWith("scripts/")) symlinkSync(join(root, path), join(destination, path));
		else cpSync(join(root, path), join(destination, path));
	}
}
export const SKIP_BUDGET = { FRESH_GATE_SKIP_REGEX: "manifest fixture does not assess regex cost" };
const FOCUSED_FUNCTIONS = ["fail", "run_step", "heavy_step", "print_budget_skip", "select_affected_tests", "test_workers", "run_affected_tests", "changed_code", "apply_ci_only", "record_run", "gate_focused"];
export function affectedArchive(fx: SaveFixture, answer: number, expected: number, base = fx.dir): string {
	const dir = ownedTmp("archive", { root: base }).path;
	symlinkSync(join(root, "src"), join(dir, "src"));
	mkdirSync(join(dir, "lib"));
	mkdirSync(join(dir, "tests/cli"), { recursive: true });
	mkdirSync(join(dir, "docs"));
	writeFileSync(join(dir, "bunfig.toml"), "[test]\ntimeout = 120000\n");
	writeFileSync(join(dir, "MANIFEST.tsv"), "name\tsha256\tclass\tpack\n");
	// A docs path in source text is a help pointer, not a dependency.
	writeFileSync(join(dir, "lib/mod.ts"), `// see docs/notes.md\nexport const answer = (): number => ${answer};\n`);
	writeFileSync(join(dir, "tests/cli/mod.test.ts"), `
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { answer } from "../../lib/mod.ts";
test("answer and suite-owned TMPDIR", () => {
  expect(answer()).toBe(${expected});
  const tmp = process.env.TMPDIR ?? "";
  expect(tmp).not.toBe("");
  const beneath = relative(join(import.meta.dir, "../../var/agent-tmp"), tmp);
  expect(isAbsolute(beneath)).toBe(false);
  expect(beneath.split(sep)).not.toContain("..");
  expect(basename(tmp).startsWith("suite-hermetic.")).toBe(true);
  expect(existsSync(join(tmp, ".owner"))).toBe(true);
  const owner = readFileSync(join(tmp, ".owner"), "utf8").split("\\n");
  expect(owner).toContain("label=suite-hermetic");
  expect(owner).toContain("pid=" + basename(tmp).split(".")[1]);
});
`);
	writeFileSync(join(dir, "docs/notes.md"), "# notes\n");
	return dir;
}
// The focused gate names its candidate as "$COMMIT^{tree}" in the repository at $ROOT (the pushing
// checkout), and resolves the shared timing store from that repository root. The fixture owns that
// repository instead of borrowing the checkout this test runs in: the gate's exact-commit export
// is an unborn `git init`, so HEAD there names no tree.
export function candidateRepo(fx: SaveFixture): string {
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
export function runFocused(fx: SaveFixture, source: string, archive: string, changed: string, scriptDir = gateTree(fx, MANIFEST_HEADER)) {
	const probe = join(fx.dir, `focused-${Math.random().toString(36).slice(2)}.sh`);
	writeFileSync(probe, `set -eu\ngate_defer_record=1\n${gateFunctions(source, FOCUSED_FUNCTIONS)}rc=0\nrun_step focused gate_focused || rc=$?\ngate_defer_record=0\nrecord_run "$last_record_tests" "$last_record_files" "$rc"\nexit "$rc"\n`);
	const repo = candidateRepo(fx);
	const started = Date.now();
	const result = runSync(["sh", probe], {
		env: { ...process.env, ...fx.env, ROOT: repo, TMPDIR: join(fx.dir, "caller-tmp"), WORK: fx.dir, ...SKIP_BUDGET, ARCHIVE_DIR: archive, SCRIPT_DIR: scriptDir, CHANGED: changed, FRESH_GATE_LEDGER: join(fx.dir, "runs.jsonl") },
		deadline_s: 720, // The opt-in literal budget case runs a 300-second suite; normal cases retain their native deadlines.
	});
	return { code: result.rc ?? 1, out: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString(), seconds: (Date.now() - started) / 1000 };
}
export function ledger(fx: SaveFixture): Array<Record<string, unknown>> {
	const path = join(fx.dir, "runs.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

export function assertPhases(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object") throw new Error("missing measured phase spans");
	const phases = value as Record<string, unknown>;
	for (const name of ["wait_ms", "setup_ms", "run_ms"]) {
		if (typeof phases[name] !== "number" || !Number.isFinite(phases[name]) || phases[name] < 0) {
			throw new Error("invalid measured phase " + name);
		}
	}
}
export function measuredFiles(record: Record<string, unknown>) {
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
// Native fixture work is real; only the host-load observation is synthetic.
// Generate from the current producer and fail loudly if its sampler changes.
export function fixtureMetrics(source: string, load = 0): string {
	const anchor = "def sample_load() -> float:\n    return os.getloadavg()[0]\n";
	const parts = source.split(anchor);
	if (parts.length !== 2) throw new Error("fixture metrics load sampler anchor must occur exactly once");
	return parts[0] + `def sample_load() -> float:\n    return ${load}\n` + parts[1];
}
// ---- CIGATE1 CI-only manifest: explicit, printed exclusions that turn the verdict PARTIAL ----------
export function gateTree(fx: SaveFixture, manifest: string): string {
	const dir = ownedTmp("gate", { root: fx.dir }).path;
	mkdirSync(join(dir, "scripts"));
	symlinkSync(join(root, "src"), join(dir, "src"));
	for (const name of ["affected-tests.ts", "gate-disk-floor.ts"]) cpSync(join(root, "scripts", name), join(dir, "scripts", name));
	copyJudgingFiles(dir, ["scripts/suite-metrics.py"]);
	writeFileSync(join(dir, "scripts/suite-metrics.py"), fixtureMetrics(readFileSync(join(root, "scripts/suite-metrics.py"), "utf8")));
	writeFileSync(join(dir, "scripts/gate-ci-only.tsv"), manifest);
	return join(dir, "scripts");
}
export const MANIFEST_HEADER = "path\tkind\tbead\texpires\treason\n";
export function isoDay(offsetDays: number): string {
	return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
