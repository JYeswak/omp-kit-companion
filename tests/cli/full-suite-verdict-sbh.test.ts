import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const fullSuiteVerdict = join(repoRoot, "scripts", "full-suite-verdict.sh");
const scratch = ownedTmp("savefirst-sibling", { root: process.env.TMPDIR });
afterAll(() => cleanupAllOwnedTmp());

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run(["git", ...args], { cwd, deadline_s: 30 });
	const stdout = new TextDecoder().decode(result.stdout);
	const stderr = new TextDecoder().decode(result.stderr);
	if (result.rc !== 0 || result.timed_out) throw new Error(`git ${args.join(" ")} failed: ${stdout}${stderr}`);
	return stdout.trim();
}

test("full-suite sibling inherits statfs while auto/sbh still refuses", async () => {
	const fixture = scratch.path;
	const suiteDir = join(fixture, "tests", "cli");
	const stateDir = join(fixture, "var", "agent-tmp");
	mkdirSync(suiteDir, { recursive: true });
	mkdirSync(join(fixture, "scripts"), { recursive: true });
	copyFileSync(join(repoRoot, "scripts", "kitlib-tmp.sh"), join(fixture, "scripts", "kitlib-tmp.sh"));
	mkdirSync(stateDir, { recursive: true });
	await git(fixture, "init", "-q");
	await git(fixture, "config", "user.name", "SAVEFIRST1 test");
	await git(fixture, "config", "user.email", "savefirst1@example.invalid");

	const suite = join(suiteDir, "savefirst-sibling-pressure.test.sh");
	writeFileSync(suite, String.raw`#!/bin/sh
set -eu
case_tmp="$TMPDIR/savefirst-sibling.$$"
mkdir -p "$case_tmp/bin" "$case_tmp/config/omp-kit" "$case_tmp/home" "$case_tmp/state" "$case_tmp/data" "$case_tmp/cache"
cat > "$case_tmp/bin/sbh" <<'SBH'
#!/bin/sh
if [ "$1 $2 $3" = "check --need 10G" ]; then
	printf '%s\n' '{"command":"check","exit_code":1,"free_pct":11.7}'
	exit 1
fi
exit 0
SBH
chmod +x "$case_tmp/bin/sbh"
# Keep only the auto/sbh negative bounded; the assertion requires the observed SBH pressure, not a generic timeout.
printf '%s\n' '{"slots":8,"max_wait_s":3,"disk_observer":"auto"}' > "$case_tmp/config/omp-kit/load.json"
run_heavy() {
	bun run --no-env-file --config=/dev/null "$KITROOT/src/cli.ts" heavy --label "$1" -- sh -c 'touch "$1"' sh "$2"
}
control_marker="$case_tmp/control-ran"
positive_marker="$case_tmp/positive-ran"
control_rc=0
(
	export OMP_KIT_DISK_OBSERVER='' HOME="$case_tmp/home" XDG_CONFIG_HOME="$case_tmp/config" XDG_STATE_HOME="$case_tmp/state"
	export XDG_DATA_HOME="$case_tmp/data" XDG_CACHE_HOME="$case_tmp/cache" OMP_KIT_HEAVY_FAKE_LOAD1=0.5 GITHUB_ACTIONS='' PATH="$case_tmp/bin:$PATH"
	run_heavy sibling-control "$control_marker"
) >"$case_tmp/control.log" 2>&1 || control_rc=$?
positive_rc=0
(
	export HOME="$case_tmp/home" XDG_CONFIG_HOME="$case_tmp/config" XDG_STATE_HOME="$case_tmp/state"
	export XDG_DATA_HOME="$case_tmp/data" XDG_CACHE_HOME="$case_tmp/cache" OMP_KIT_HEAVY_FAKE_LOAD1=0.5 GITHUB_ACTIONS='' PATH="$case_tmp/bin:$PATH"
	run_heavy sibling-save "$positive_marker"
) >"$case_tmp/positive.log" 2>&1 || positive_rc=$?
if [ "$control_rc" -eq 75 ] && grep -Fq 'disk low: sbh check --need 10G reports pressure' "$case_tmp/control.log" && [ ! -e "$control_marker" ] && [ "$positive_rc" -eq 0 ] && [ -e "$positive_marker" ]; then
	printf 'SAVEFIRST1 full-suite sibling pressure PASS\n'
else
	printf 'SAVEFIRST1 full-suite sibling pressure FAIL control_rc=%s positive_rc=%s\n' "$control_rc" "$positive_rc" >&2
	cat "$case_tmp/control.log" "$case_tmp/positive.log" >&2
	exit 1
fi
rm -rf "$case_tmp"
`, { mode: 0o755 });
	chmodSync(suite, 0o755);
	await git(fixture, "add", "--", "tests/cli/savefirst-sibling-pressure.test.sh", "scripts/kitlib-tmp.sh");
	await git(fixture, "commit", "-q", "-m", "[test] SAVEFIRST1 sibling fixture");

	const candidate = await git(fixture, "rev-parse", "HEAD");
	const cache = join(fixture, "cache");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env.KITROOT = repoRoot;
	env.OMP_KIT_OMP_SRC_FETCH = "0";
	const result = await run(["sh", fullSuiteVerdict, "--repo", fixture, "--commit", candidate, "--cache-dir", cache], {
		cwd: fixture, deadline_s: 120, env,
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const tree = await git(fixture, "rev-parse", "HEAD^{tree}");
	const log = readFileSync(join(cache, `${tree}.log`), "utf8");
	const evidence = `${output}\n${log}`;
	expect(result.rc, evidence).toBe(0);
	expect(result.timed_out, evidence).toBe(false);
	expect(output).toContain("FULL-SUITE: VERDICT PASS");
	expect(readdirSync(join(fixture, "var", "agent-tmp"))).toEqual([]);

	const verdictPath = join(cache, `${tree}.json`);
	const verdict = JSON.parse(readFileSync(verdictPath, "utf8")) as { verdict: string; evidence: { complete: boolean; shell_suites: number; shell_fail: number } };
	expect(verdict).toMatchObject({ verdict: "PASS", evidence: { complete: true, shell_suites: 1, shell_fail: 0 } });
	expect(readFileSync(join(cache, `${tree}.log`), "utf8")).toContain("SAVEFIRST1 full-suite sibling pressure PASS");
}, 30_000);
test("full-suite supplies Git and private temp context to archived shell suites", async () => {
	const fixture = join(scratch.path, "caller-context");
	const suiteDir = join(fixture, "tests", "cli");
	mkdirSync(suiteDir, { recursive: true });
	mkdirSync(join(fixture, "scripts"), { recursive: true });
	copyFileSync(join(repoRoot, "scripts", "kitlib-tmp.sh"), join(fixture, "scripts", "kitlib-tmp.sh"));
	mkdirSync(join(fixture, "var", "agent-tmp"), { recursive: true });
	await git(fixture, "init", "-q");
	await git(fixture, "config", "user.name", "SAVEFIRST1 context test");
	await git(fixture, "config", "user.email", "savefirst1-context@example.invalid");

	const suite = join(suiteDir, "savefirst-caller-context.test.sh");
	writeFileSync(suite, String.raw`#!/bin/sh
set -eu
: "$OMP_KIT_CASE_CWD"
git -C "$OMP_KIT_CASE_CWD" rev-parse --show-toplevel >/dev/null
: "$KITLIB_TMP_ROOT"
. "$KITROOT/scripts/kitlib-tmp.sh"
test -f "$TMPDIR/.owner"
kitlib_tmp work full-suite-context
test -d "$work"
printf 'FULL-SUITE-CONTEXT PASS\n'
`, { mode: 0o755 });
	chmodSync(suite, 0o755);
	await git(fixture, "add", "--", "tests/cli/savefirst-caller-context.test.sh", "scripts/kitlib-tmp.sh");
	await git(fixture, "commit", "-q", "-m", "[test] SAVEFIRST1 caller context");

	const candidate = await git(fixture, "rev-parse", "HEAD");
	const cache = join(fixture, "cache");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env.OMP_KIT_CASE_CWD = join(fixture, "stale-missing-caller-root");
	env.KITLIB_TMP_ROOT = join(fixture, "stale-missing-kitlib-root");
	// The outer caller's TMPDIR is a plain bucket, not an owned private root.
	env.TMPDIR = join(fixture, "stale-missing-tmpdir");
	mkdirSync(env.TMPDIR, { recursive: true });
	env.KITROOT = fixture;
	env.OMP_KIT_OMP_SRC_FETCH = "0";
	const result = await run(["sh", fullSuiteVerdict, "--repo", fixture, "--commit", candidate, "--cache-dir", cache], {
		cwd: fixture, deadline_s: 120, env,
	});
	const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
	const tree = await git(fixture, "rev-parse", "HEAD^{tree}");
	const log = readFileSync(join(cache, `${tree}.log`), "utf8");
	const evidence = `${output}\n${log}`;
	expect(result.rc, evidence).toBe(0);
	expect(result.timed_out, evidence).toBe(false);
	expect(output).toContain("FULL-SUITE: VERDICT PASS");
	expect(log).toContain("FULL-SUITE-CONTEXT PASS");
	expect(readdirSync(join(fixture, "var", "agent-tmp"))).toEqual([]);
}, 30_000);
