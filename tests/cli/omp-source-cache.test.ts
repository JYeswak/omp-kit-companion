import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedOmpPackage, ensureOmpSource } from "../../src/omp-source-cache.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { resolveOmpSource } from "../../scripts/rule-class.ts";

// Real paths: macOS tmpdir() sits under the /var -> /private/var symlink.
const base = realpathSync(mkdtempSync(join(tmpdir(), "omp-source-cache-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(base, `cache-${++n}`);
const PKG = ["node_modules", "@oh-my-pi", "pi-coding-agent"];

/** What a successful `bun add` leaves behind; every field can be planted wrong. */
function fakeInstall(opts: { version?: string; integrity?: string | null; matcher?: boolean; status?: number } = {}) {
	const calls: string[] = [];
	const install = (cwd: string, spec: string) => {
		calls.push(spec);
		const requested = spec.slice(spec.lastIndexOf("@") + 1);
		const version = opts.version ?? requested;
		const pkg = join(cwd, ...PKG);
		mkdirSync(join(pkg, "src", "export"), { recursive: true });
		mkdirSync(join(pkg, "src", "capability"), { recursive: true });
		mkdirSync(join(pkg, "src", "discovery"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
		writeFileSync(join(cwd, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives", version }));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
		for (const file of opts.matcher === false ? ["export/ttsr.ts"] : ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
			writeFileSync(join(pkg, "src", file), "export {};\n");
		}
		const integrity = opts.integrity === undefined ? "sha512-R7BaZ9wxsrQhxfYxt8bXczwmfDctUPklqSLAeDulbl716WxnVCSBe6MYIscyJ+oRq7bqsq+s+tDNEf1HWG/R6A==" : opts.integrity;
		writeFileSync(join(cwd, "bun.lock"), `{\n  "packages": {\n    "@oh-my-pi/pi-coding-agent": ["@oh-my-pi/pi-coding-agent@${version}", "", {}${integrity ? `, "${integrity}"` : ""}],\n  }\n}\n`);
		return { status: opts.status ?? 0, output: "installed" };
	};
	return { install, calls };
}

test("installs exactly the requested version once, then serves it from the cache", () => {
	const env = { OMP_KIT_OMP_SRC_CACHE: fresh() };
	const fake = fakeInstall();
	const pkg = ensureOmpSource("9.9.9", env, { install: fake.install });
	expect(pkg).toBe(join(env.OMP_KIT_OMP_SRC_CACHE, "9.9.9", ...PKG));
	expect(existsSync(join(env.OMP_KIT_OMP_SRC_CACHE, "9.9.9", ".verified.json"))).toBe(true);
	expect(ensureOmpSource("9.9.9", env, { install: fake.install })).toBe(pkg);
	expect(fake.calls).toEqual(["@oh-my-pi/pi-coding-agent@9.9.9"]);
	expect(readdirSync(env.OMP_KIT_OMP_SRC_CACHE).filter(name => name.includes("staging"))).toEqual([]);
});

test("refuses an install that reports another version and caches nothing", () => {
	const env = { OMP_KIT_OMP_SRC_CACHE: fresh() };
	expect(() => ensureOmpSource("9.9.9", env, { install: fakeInstall({ version: "9.9.8" }).install }))
		.toThrow("reports version 9.9.8, not 9.9.9");
	expect(cachedOmpPackage("9.9.9", env)).toBeNull();
	expect(readdirSync(env.OMP_KIT_OMP_SRC_CACHE)).toEqual([]);
});

test("refuses an install with no sha512 integrity in the lockfile, or without matcher source", () => {
	const env = { OMP_KIT_OMP_SRC_CACHE: fresh() };
	expect(() => ensureOmpSource("9.9.9", env, { install: fakeInstall({ integrity: null }).install })).toThrow("no sha512 integrity");
	expect(() => ensureOmpSource("9.9.9", env, { install: fakeInstall({ matcher: false }).install })).toThrow("lacks matcher source");
	expect(() => ensureOmpSource("9.9.9", env, { install: fakeInstall({ status: 1 }).install })).toThrow("failed (exit 1)");
	expect(readdirSync(env.OMP_KIT_OMP_SRC_CACHE)).toEqual([]);
});

test("a cached directory whose manifest names another version is not served", () => {
	const env = { OMP_KIT_OMP_SRC_CACHE: fresh() };
	ensureOmpSource("9.9.9", env, { install: fakeInstall().install });
	writeFileSync(join(env.OMP_KIT_OMP_SRC_CACHE, "9.9.9", ...PKG, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "9.9.7" }));
	expect(cachedOmpPackage("9.9.9", env)).toBeNull();
	const fake = fakeInstall();
	ensureOmpSource("9.9.9", env, { install: fake.install });
	expect(fake.calls.length).toBe(1);
});

test("off switch, missing cache root and non-release versions refuse before any install", () => {
	const fake = fakeInstall();
	expect(() => ensureOmpSource("9.9.9", { OMP_KIT_OMP_SRC_CACHE: fresh(), OMP_KIT_OMP_SRC_FETCH: "0" }, { install: fake.install })).toThrow("OMP_KIT_OMP_SRC_FETCH=0");
	expect(() => ensureOmpSource("9.9.9", {}, { install: fake.install })).toThrow("no HOME or OMP_KIT_OMP_SRC_CACHE");
	expect(() => ensureOmpSource("9.9.9-rc.1", { OMP_KIT_OMP_SRC_CACHE: fresh() }, { install: fake.install })).toThrow("non-release version");
	expect(fake.calls).toEqual([]);
});

test("keeps the two newest versions", () => {
	const env = { OMP_KIT_OMP_SRC_CACHE: fresh() };
	for (const v of ["9.9.1", "9.10.0", "9.9.12"]) ensureOmpSource(v, env, { install: fakeInstall().install });
	expect(readdirSync(env.OMP_KIT_OMP_SRC_CACHE).filter(name => !name.startsWith(".")).sort()).toEqual(["9.10.0", "9.9.12"]);
});

/** A compiled launcher outside any package, like Tern's omp: it only answers --version. */
function compiledLauncher(version: string): string {
	const dir = join(base, `compiled-${++n}`);
	mkdirSync(dir, { recursive: true });
	const launcher = join(dir, "omp");
	writeFileSync(launcher, `#!/bin/sh\necho "omp/${version}"\n`);
	chmodSync(launcher, 0o755);
	return dir;
}

test("product resolver: a compiled launcher with no same-version package resolves to the cache", () => {
	const cache = fresh();
	ensureOmpSource("9.9.9", { OMP_KIT_OMP_SRC_CACHE: cache }, { install: fakeInstall().install });
	const identity = resolveOmpIdentity({ PATH: compiledLauncher("9.9.9"), BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" });
	expect(identity.source).toBe(realpathSync(join(cache, "9.9.9", ...PKG, "src")));
	expect(identity.nativeRoot).toBe(realpathSync(join(cache, "9.9.9", "node_modules", "@oh-my-pi", "pi-natives")));
});

test("product resolver: a cache of another version is never used", () => {
	const cache = fresh();
	ensureOmpSource("9.9.8", { OMP_KIT_OMP_SRC_CACHE: cache }, { install: fakeInstall().install });
	expect(() => resolveOmpIdentity({ PATH: compiledLauncher("9.9.9"), BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" }))
		.toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.9 for OMP launcher");
});

test("gate resolver: a compiled launcher alone takes the cache's src; without a cache it still refuses", () => {
	const PATH = compiledLauncher("9.9.9");
	const pkg = join(base, "gate-pkg");
	expect(resolveOmpSource({ env: { PATH, BUN_INSTALL: join(base, "no-bun") }, launcherVersion: () => "9.9.9", sourceCache: version => (version === "9.9.9" ? pkg : null) }))
		.toBe(join(pkg, "src"));
	expect(() => resolveOmpSource({ env: { PATH, BUN_INSTALL: join(base, "no-bun") }, launcherVersion: () => "9.9.9", sourceCache: () => null }))
		.toThrow("cannot locate the omp 9.9.9 package source");
});
