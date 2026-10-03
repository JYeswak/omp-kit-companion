import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { releaseRoot, resolveBundledScript, resolveOmpIdentity } from "../../src/paths.ts";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { once } from "node:events";

const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-runtime-"));
	fixtures.push(root);
	return root;
}

function createOmp(prefix: string, version: string): { launcher: string; source: string } {
	const packageRoot = join(prefix, "releases", version);
	const source = join(packageRoot, "src");
	const launcher = join(prefix, "bin", "omp");
	mkdirSync(join(source, "export"), { recursive: true });
	mkdirSync(join(source, "capability"), { recursive: true });
	mkdirSync(join(source, "discovery"), { recursive: true });
	mkdirSync(join(packageRoot, "dist"), { recursive: true });
	mkdirSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
	writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
	writeFileSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	const piUtils = join(packageRoot, "node_modules", "@oh-my-pi", "pi-utils");
	mkdirSync(piUtils, { recursive: true });
	writeFileSync(join(piUtils, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", exports: "./index.js" }));
	writeFileSync(join(piUtils, "index.js"), "export function parseFrontmatter(content) { return { frontmatter: {}, body: content }; }\n");
	for (const relative of ["export/ttsr.ts", "capability/rule.ts"]) writeFileSync(join(source, relative), "export {};\n");
	writeFileSync(join(source, "discovery", "helpers.ts"), "export const buildRuleFromMarkdown = () => ({});\nexport const createSourceMeta = () => ({});\n");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	symlinkSync(join(packageRoot, "dist", "cli.js"), launcher);
	return { launcher, source };
}

function snapshotTree(root: string): string {
	const entries: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			const name = relative(root, path);
			entries.push(`${name}\t${stat.mode & 0o777}\t${stat.size}\t${stat.mtimeMs}`);
			if (stat.isFile() && (entry.name.endsWith(".ts") || entry.name === "operator-marker" || entry.name === "TMPDIR-marker")) {
				entries.push(readFileSync(path, "utf8"));
			}
			if (entry.isDirectory()) visit(path);
			else if (entry.isSymbolicLink()) entries.push(`${name}\t->${readlinkSync(path)}`);
		}
	};
	visit(root);
	return entries.join("\n");
}

const REPO_ROOT = resolve(import.meta.dir, "../..");

describe("release paths", () => {
	test("follows the stable launcher to the moved versioned release", () => {
		const prefix = join(fixtureRoot(), "kit");
		const versioned = join(prefix, "releases", "v4");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		mkdirSync(join(versioned, "bin"), { recursive: true });
		writeFileSync(join(versioned, "bin", "omp-kit"), "compiled executable");
		chmodSync(join(versioned, "bin", "omp-kit"), 0o755);
		const stable = join(prefix, "bin", "omp-kit");
		symlinkSync(join(versioned, "bin", "omp-kit"), stable);

		expect(releaseRoot(stable)).toBe(realpathSync(versioned));
	});

	test("refuses dangling and prefix-escaping stable launcher symlinks", () => {
		const base = fixtureRoot();
		const prefix = join(base, "kit");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		const dangling = join(prefix, "bin", "omp-kit");
		symlinkSync(join(prefix, "releases", "missing", "bin", "omp-kit"), dangling);
		expect(() => releaseRoot(dangling)).toThrow(/symlink|realpath|resolve/i);

		const outside = join(base, "outside", "omp-kit");
		mkdirSync(join(base, "outside"), { recursive: true });
		writeFileSync(outside, "compiled executable");
		chmodSync(outside, 0o755);
		const escaping = join(prefix, "bin", "escaping");
		symlinkSync(outside, escaping);
		expect(() => releaseRoot(escaping)).toThrow(/escap|outside|prefix/i);
	});

	test("accepts only a packaged harness script and rejects traversal", () => {
		const root = join(fixtureRoot(), "release");
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "ttsr-harness.ts"), "console.log('harness');\n");
		expect(resolveBundledScript("scripts/ttsr-harness.ts", root)).toBe(realpathSync(join(root, "scripts", "ttsr-harness.ts")));
		expect(() => resolveBundledScript("../../outside.ts", root)).toThrow(/allow|packag|path/i);
		expect(() => resolveBundledScript("scripts/unknown.ts", root)).toThrow(/allow|packag|path/i);
	});

	test("runs the packaged rule classifier and refuses the retired local-model checker", () => {
		const base = fixtureRoot();
		const prefix = join(base, "kit");
		const versioned = join(prefix, "releases", "v1.2.3");
		const executable = join(versioned, "bin", "omp-kit");
		const stable = join(prefix, "bin", "omp-kit");
		const fakeOmp = createOmp(join(base, "fake-omp"), "v18.4.2");
		mkdirSync(join(versioned, "scripts"), { recursive: true });
		mkdirSync(join(versioned, "bin"), { recursive: true });
		const ruleClass = join(REPO_ROOT, "scripts", "rule-class.ts");
		writeFileSync(join(versioned, "scripts", "rule-class.ts"), readFileSync(ruleClass));
		mkdirSync(join(versioned, "rules"), { recursive: true });
		const ruleFile = join(versioned, "rules", "zz-canary-scope-probe.md");
		writeFileSync(ruleFile, "---\ninterruptMode: never\n---\nfixture\n");
		writeFileSync(join(versioned, "scripts", "role-check.ts"), "console.log('REMOVED_ROLE_CHECK_EXECUTED');\n");
		writeFileSync(join(versioned, "scripts", "not-allowlisted.ts"), "console.log('UNALLOWLISTED_RESOURCE_EXECUTED');\n");
		mkdirSync(join(prefix, "bin"), { recursive: true });

		const buildRoot = join(base, "build-environment");
		const buildEnv = {
			HOME: join(buildRoot, "home"), TMPDIR: join(buildRoot, "tmp"),
			XDG_CONFIG_HOME: join(buildRoot, "xdg-config"), XDG_CACHE_HOME: join(buildRoot, "xdg-cache"),
			XDG_DATA_HOME: join(buildRoot, "xdg-data"), XDG_STATE_HOME: join(buildRoot, "xdg-state"),
			BUN_INSTALL: join(buildRoot, "bun-install"), PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"] as const) {
			mkdirSync(buildEnv[key], { recursive: true });
		}
		const compile = Bun.spawnSync([
			process.execPath, "build", join(REPO_ROOT, "tests", "cli", "runtime-release-runner.ts"),
			"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
			`--outfile=${executable}`,
		], { cwd: REPO_ROOT, env: { ...buildEnv, TMP: buildEnv.TMPDIR, TEMP: buildEnv.TMPDIR }, stdout: "pipe", stderr: "pipe" });
		expect(compile.exitCode, `${compile.stdout.toString()}\n${compile.stderr.toString()}`).toBe(0);
		chmodSync(executable, 0o755);
		symlinkSync(executable, stable);

		const canaries = join(base, "operator-canaries");
		mkdirSync(canaries, { recursive: true });
		const hostile: Record<string, string> = {};
		for (const [key, name] of [
			["HOME", "home"],
			["XDG_CONFIG_HOME", "xdg-config"],
			["XDG_CACHE_HOME", "xdg-cache"],
			["XDG_DATA_HOME", "xdg-data"],
			["XDG_STATE_HOME", "xdg-state"],
			["BUN_INSTALL", "bun-install"],
		] as const) {
			const directory = join(canaries, name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "operator-marker"), `${key}:unchanged\n`);
			hostile[key] = directory;
		}
		const hostileTmp = join(canaries, "TMPDIR-marker");
		writeFileSync(hostileTmp, "TMPDIR:regular-file\n");
		const env = {
			...hostile, PATH: [dirname(fakeOmp.launcher), "/usr/bin", "/bin"].join(delimiter),
			TMPDIR: hostileTmp, TMP: hostileTmp, TEMP: hostileTmp,
			OMP: fakeOmp.launcher, OMP_BIN: fakeOmp.launcher, OMP_PATH: fakeOmp.launcher, OMP_SRC: fakeOmp.source,
		};
		const releaseBefore = snapshotTree(prefix);
		const canariesBefore = snapshotTree(canaries);
		const run = (resource: string) => Bun.spawnSync([stable], {
			cwd: base,
			env: {
				...env,
				OMP_KIT_FIXTURE_ROOT: versioned,
				OMP_KIT_FIXTURE_EXECUTABLE: stable,
				OMP_KIT_FIXTURE_SCRIPT: resource,
				OMP_KIT_FIXTURE_ARGS: JSON.stringify(resource === "scripts/rule-class.ts" ? [ruleFile] : []),
			},
			stdout: "pipe", stderr: "pipe",
		});

		const allowed = run("scripts/rule-class.ts");
		expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
		expect(allowed.stdout.toString()).toBe("zz-canary-scope-probe\tcanary\n");

		const retired = run("scripts/role-check.ts");
		expect(retired.exitCode).not.toBe(0);
		expect(retired.stdout.toString()).not.toContain("REMOVED_ROLE_CHECK_EXECUTED");
		expect(retired.stderr.toString()).toContain("not an allowlisted packaged path");

		const rejected = run("scripts/not-allowlisted.ts");
		expect(rejected.exitCode).not.toBe(0);
		expect(rejected.stdout.toString()).not.toContain("UNALLOWLISTED_RESOURCE_EXECUTED");
		expect(rejected.stderr.toString()).toContain("not an allowlisted packaged path");
		expect(snapshotTree(prefix)).toBe(releaseBefore);
		expect(snapshotTree(canaries)).toBe(canariesBefore);
	});
});

test("terminating the packaged adapter closes its mock server and output streams", async () => {
	const base = mkdtempSync(join(runtimeTempRoot(), "omp-kit-runtime-"));
	fixtures.push(base);
	const release = join(base, "release");
	const workspace = join(base, "work");
	for (const directory of ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install", "work", "release/bin", "release/scripts", "release/tests/live"]) {
		mkdirSync(join(base, directory), { recursive: true, mode: 0o700 });
	}
	const executable = join(release, "bin", "omp-kit");
	const built = Bun.spawnSync([process.execPath, "build", join(REPO_ROOT, "tests/cli/runtime-release-runner.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		"--outfile=" + executable], { cwd: base, stdout: "pipe", stderr: "pipe",
		env: { HOME: join(base, "home"), TMPDIR: join(base, "tmp"), BUN_INSTALL: join(base, "bun-install"),
			XDG_CONFIG_HOME: join(base, "xdg-config"), XDG_CACHE_HOME: join(base, "xdg-cache"),
			XDG_DATA_HOME: join(base, "xdg-data"), XDG_STATE_HOME: join(base, "xdg-state"),
			PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	expect(built.exitCode, built.stderr.toString()).toBe(0);
	const adapter = join(release, "scripts/runtime-adapter.sh");
	writeFileSync(adapter, readFileSync(join(REPO_ROOT, "scripts/runtime-adapter.sh")), { mode: 0o755 });
	const mock = join(release, "tests/live/mock-model.mjs");
	writeFileSync(mock, readFileSync(join(REPO_ROOT, "tests/live/mock-model.mjs")));
	const scenario = join(workspace, "scenario.json"), portFile = join(workspace, "port");
	writeFileSync(scenario, JSON.stringify({ turns: [{ text: "Done." }] }));
	const omp = resolveOmpIdentity();
	const env = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(base, "home"), TMPDIR: join(base, "tmp"),
		XDG_CONFIG_HOME: join(base, "xdg-config"), XDG_CACHE_HOME: join(base, "xdg-cache"),
		XDG_DATA_HOME: join(base, "xdg-data"), XDG_STATE_HOME: join(base, "xdg-state"),
		BUN_INSTALL: join(base, "bun-install"), OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
	const watcher = watch(workspace);
	let changed = once(watcher, "change");
	const server = Bun.spawn([adapter, "--work-dir", workspace, "--scenario", scenario,
		"--log", join(workspace, "requests.jsonl"), "--port-file", portFile, mock], {
		cwd: release, env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
	});
	const stdout = new Response(server.stdout).text(), stderr = new Response(server.stderr).text();
	let descendants: number[] = [];
	try {
		while (!existsSync(portFile) || !readFileSync(portFile, "utf8").trim()) {
			await Promise.race([changed, server.exited.then(code => { throw new Error("mock exited before readiness: " + code); })]);
			changed = once(watcher, "change");
		}
		watcher.close();
		const url = "http://127.0.0.1:" + readFileSync(portFile, "utf8").trim() + "/v1/chat/completions";
		const request = { method: "POST", body: JSON.stringify({ messages: [], stream: true }) };
		const ready = await fetch(url, request);
		expect(ready.status).toBe(200);
		expect(await ready.text()).toContain("[DONE]");
		const processes = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
		expect(processes.exitCode, processes.stderr.toString()).toBe(0);
		descendants = processes.stdout.toString().trim().split("\n").map(row => row.trim().split(/\s+/).map(Number))
			.filter(([, parent]) => parent === server.pid).map(([pid]) => pid!);
		server.kill("SIGTERM");
		await server.exited;
		let stillListening = false;
		try {
			const response = await fetch(url, request);
			stillListening = true;
			await response.text();
		} catch { /* Connection refusal is the required shutdown effect. */ }
		expect(stillListening).toBe(false);
	} finally {
		watcher.close();
		if (server.exitCode === null) server.kill("SIGTERM");
		for (const pid of descendants) { try { process.kill(pid, "SIGTERM"); } catch {} }
		await server.exited;
		await Promise.all([stdout, stderr]);
	}
}, 15_000);

describe("OMP installation identity", () => {
	test("resolves launcher, source and native package from the same PATH install", () => {
		const first = createOmp(join(fixtureRoot(), "omp-one"), "v1");
		const resolved = resolveOmpIdentity({ PATH: dirname(first.launcher) });
		const packageRoot = realpathSync(join(first.source, ".."));

		expect(resolved.launcher).toBe(realpathSync(first.launcher));
		expect(resolved.source).toBe(realpathSync(first.source));
		expect(resolved.packageRoot).toBe(packageRoot);
		expect(resolved.nativeRoot).toBe(realpathSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives")));
	});

	test("refuses conflicting launcher and source overrides instead of mixing installs", () => {
		const root = fixtureRoot();
		const first = createOmp(join(root, "omp-one"), "v1");
		const second = createOmp(join(root, "omp-two"), "v2");
		const pathEnv = { PATH: dirname(first.launcher) };

		for (const key of ["OMP_BIN", "OMP", "OMP_PATH"] as const) {
			expect(() => resolveOmpIdentity({ ...pathEnv, [key]: second.launcher })).toThrow(/conflict|different|identity/i);
		}
		expect(() => resolveOmpIdentity({ ...pathEnv, OMP_SRC: second.source })).toThrow(/conflict|different|identity/i);
		expect(() => resolveOmpIdentity({ PATH: `${dirname(second.launcher)}:${dirname(first.launcher)}`, OMP_BIN: first.launcher })).toThrow(/conflict|different|identity/i);
	});

	test("rejects an OMP package without matcher source even when its launcher exists", () => {
		const root = fixtureRoot();
		const packageRoot = join(root, "release");
		const launcher = join(root, "bin", "omp");
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
		writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
		symlinkSync(join(packageRoot, "dist", "cli.js"), launcher);

		expect(() => resolveOmpIdentity({ PATH: dirname(launcher) })).toThrow(/source|matcher/i);
	});
});

test("--workdir falls back to /tmp when TMPDIR is inside the release tree", () => {
	const adapter = join(REPO_ROOT, "scripts", "runtime-adapter.sh");
	const nested = join(REPO_ROOT, "var", "agent-tmp");
	mkdirSync(nested, { recursive: true });
	const planted = Bun.spawnSync(["/bin/sh", adapter, "--workdir"], {
		stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: nested },
	});
	expect(planted.exitCode).toBe(0);
	const fallback = planted.stdout.toString().trim();
	expect(realpathSync(fallback)).toBe(fallback);
	expect(fallback.startsWith(nested)).toBe(false);
	expect(planted.stderr.toString()).toContain("falling back to /tmp");
	rmSync(fallback, { recursive: true, force: true });
	const normalBase = mkdtempSync(join(tmpdir(), "omp-kit-workdir-"));
	fixtures.push(normalBase);
	const normal = Bun.spawnSync(["/bin/sh", adapter, "--workdir"], {
		stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: normalBase },
	});
	expect(normal.exitCode).toBe(0);
	const normalDir = normal.stdout.toString().trim();
	expect(normalDir.startsWith(realpathSync(normalBase))).toBe(true);
	expect(realpathSync(normalDir)).toBe(normalDir);
});
test("runtime temp root follows TMPDIR and returns its canonical path", () => {
	const base = fixtureRoot();
	const target = join(base, "tmp-target");
	const alias = join(base, "tmp-alias");
	const home = join(base, "home");
	mkdirSync(target);
	mkdirSync(home);
	symlinkSync(target, alias);
	const previousHome = process.env.HOME;
	const previousTmpdir = process.env.TMPDIR;
	process.env.HOME = home;
	process.env.TMPDIR = alias;
	try {
		expect(runtimeTempRoot()).toBe(realpathSync(target));
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});

test("runtime temp root falls back when TMPDIR is not a directory", () => {
	const base = fixtureRoot();
	const marker = join(base, "TMPDIR-marker");
	writeFileSync(marker, "not a directory\n");
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = marker;
	try {
		const root = runtimeTempRoot();
		expect(root).not.toBe(realpathSync(marker));
		expect(realpathSync(root)).toBe(root);
		expect(lstatSync(root).isDirectory()).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
});

test("runtime temp root avoids caller HOME when TMPDIR is nested there", () => {
	const base = fixtureRoot();
	const home = join(base, "home");
	const nested = join(home, "tmp");
	mkdirSync(nested, { recursive: true });
	const previousHome = process.env.HOME;
	const previousTmpdir = process.env.TMPDIR;
	process.env.HOME = home;
	process.env.TMPDIR = nested;
	try {
		const root = runtimeTempRoot();
		expect(root).not.toBe(realpathSync(nested));
		expect(realpathSync(root)).toBe(root);
		expect(lstatSync(root).isDirectory()).toBe(true);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});
