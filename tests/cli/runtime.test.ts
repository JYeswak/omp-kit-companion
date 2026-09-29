import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { releaseRoot, resolveBundledScript, resolveOmpIdentity } from "../../src/paths.ts";

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
	for (const relative of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		writeFileSync(join(source, relative), "export {};\n");
	}
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

	test("runs a relocated allowlisted resource through the versioned release behind the stable link", () => {
		const base = fixtureRoot();
		const prefix = join(base, "kit");
		const versioned = join(prefix, "releases", "v1.2.3");
		const executable = join(versioned, "bin", "omp-kit");
		const stable = join(prefix, "bin", "omp-kit");
		const fakeOmp = createOmp(join(base, "fake-omp"), "v18.4.2");
		mkdirSync(join(versioned, "scripts"), { recursive: true });
		mkdirSync(join(versioned, "bin"), { recursive: true });
		const roleCheck = join(REPO_ROOT, "scripts", "role-check.ts");
		writeFileSync(join(versioned, "scripts", "role-check.ts"), readFileSync(roleCheck));
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
				OMP_KIT_FIXTURE_ARGS: JSON.stringify(resource === "scripts/role-check.ts" ? ["--selftest"] : []),
			},
			stdout: "pipe", stderr: "pipe",
		});

		const allowed = run("scripts/role-check.ts");
		expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
		expect(allowed.stdout.toString()).toContain("role-check selftest: 6/6 ok");

		const rejected = run("scripts/not-allowlisted.ts");
		expect(rejected.exitCode).not.toBe(0);
		expect(rejected.stdout.toString()).not.toContain("UNALLOWLISTED_RESOURCE_EXECUTED");
		expect(rejected.stderr.toString()).toContain("not an allowlisted packaged path");
		expect(snapshotTree(prefix)).toBe(releaseBefore);
		expect(snapshotTree(canaries)).toBe(canariesBefore);
	});
});

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
