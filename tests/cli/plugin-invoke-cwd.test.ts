import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// PLUGINCWD1 (ompkit-hc7gs): kit-update runs under launchd with cwd = $HOME. omp started in $HOME moves to /tmp,
// and omp-trust-guard refuses there when /tmp holds an untrusted project file, so `plugin list` failed and every
// unattended relink was REFUSED PLUGIN_LIST_UNAVAILABLE. The fake omp below refuses exactly when started in $HOME.
const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const FAKE_OMP = `#!/bin/sh
if [ "$(pwd -P)" = "$(cd "$HOME" && pwd -P)" ]; then
  echo "omp-trust-guard: REFUSED to start omp: /private/tmp has project files that run code" >&2
  exit 1
fi
if [ -n "$FAKE_OMP_FAIL" ]; then echo "plugin list failed" >&2; exit 2; fi
echo '{"npm":[],"marketplace":[]}'
`;
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fixture(): { home: string; omp: string } {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "plugin-invoke-home-")));
	roots.push(home);
	const omp = join(home, "fake-omp");
	writeFileSync(omp, FAKE_OMP);
	chmodSync(omp, 0o755);
	return { home, omp };
}

// Runs the real nativePluginInvoke in a child whose cwd is the fixture $HOME, as the launchd job's is.
function invokeFromHome(home: string, omp: string, extraEnv: Record<string, string> = {}) {
	const script = `import { nativePluginInvoke } from ${JSON.stringify(CLI)};
console.log(JSON.stringify(nativePluginInvoke(${JSON.stringify(omp)}, ${JSON.stringify(home)}, "default", ["plugin", "list", "--json"])));`;
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		cwd: home, env: { ...process.env, ...extraEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const lines = child.stdout.toString().trim().split("\n");
	return JSON.parse(lines[lines.length - 1] ?? "null") as { code: number; stdout: string; stderr: string };
}

test("planted: started from $HOME, plugin list still runs from a kit-owned directory and succeeds", () => {
	const { home, omp } = fixture();
	const result = invokeFromHome(home, omp);
	expect(result.stderr).toBe("");
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ npm: [], marketplace: [] });
});

test("control: a plugin list that really fails is still reported as a failure", () => {
	const { home, omp } = fixture();
	const result = invokeFromHome(home, omp, { FAKE_OMP_FAIL: "1" });
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("plugin list failed");
});
