// Coverage: scripts/fresh-gate.sh, scripts/build-manifest.sh, scripts/rule-class.ts,
// scripts/affected-tests.ts, scripts/test-budget.ts, scripts/gate-ci-only.ts, scripts/gate-disk-floor.ts,
// scripts/suite-metrics.py, scripts/full-suite-verdict.sh, scripts/full-suite-verdict-store.py,
// scripts/suite-hermetic-env.sh, scripts/kitlib_run.py, scripts/kitlib_tmp.py, scripts/pysafe.py,
// scripts/kitlib-tmp.sh, src/cli.ts, src/kitlib/run.ts, src/kitlib/tmp.ts.
import { expect } from "bun:test";
import { chmodSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run.ts";

export const root = resolve(import.meta.dir, "../..");
const scratchRoot = root.includes("/fresh-gate.") ? resolve(root, "..") : resolve(root, "var/agent-tmp");
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
