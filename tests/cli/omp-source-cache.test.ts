import { createHash } from "node:crypto";
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cachedOmpPackage, ensureOmpSource } from "../../src/omp-source-cache.ts";
import { resolveOmpIdentity, verifyTernOmpSource } from "../../src/paths.ts";
import { resolveOmpSource } from "../../scripts/rule-class.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

// Real paths: macOS tmpdir() sits under the /var -> /private/var symlink.
const base = realpathSync(ownedTmp("omp-source-cache").path);
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(base, `cache-${++n}`);
const PKG = ["node_modules", "@oh-my-pi", "pi-coding-agent"];
const OTEL_RUNTIME_ENTRY = "node_modules/@opentelemetry/api/dist/index.mjs";
function addOtelRuntime(versionDir: string): void {
	const entry = join(versionDir, OTEL_RUNTIME_ENTRY);
	mkdirSync(join(entry, ".."), { recursive: true });
	writeFileSync(entry, "export const context = {};\n");
}

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
		addOtelRuntime(cwd);
		for (const file of opts.matcher === false ? ["export/ttsr.ts"] : ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
			writeFileSync(join(pkg, "src", file), "export {};\n");
		}
		const integrity = opts.integrity === undefined ? "sha512-R7BaZ9wxsrQhxfYxt8bXczwmfDctUPklqSLAeDulbl716WxnVCSBe6MYIscyJ+oRq7bqsq+s+tDNEf1HWG/R6A==" : opts.integrity;
		writeFileSync(join(cwd, "bun.lock"), `{\n  "packages": {\n    "@oh-my-pi/pi-coding-agent": ["@oh-my-pi/pi-coding-agent@${version}", "", {}${integrity ? `, "${integrity}"` : ""}],\n  }\n}\n`);
		mkdirSync(join(cwd, ".bun-cache"), { recursive: true });
		writeFileSync(join(cwd, ".bun-cache", "registry-data"), "temporary");
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
	expect(existsSync(join(env.OMP_KIT_OMP_SRC_CACHE, "9.9.9", ".bun-cache"))).toBe(false);
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

test("cached source refuses a forged or mismatched registry receipt", () => {
	const cache = fresh();
	const env = { OMP_KIT_OMP_SRC_CACHE: cache };
	ensureOmpSource("9.9.9", env, { install: fakeInstall().install });
	const receipt = join(cache, "9.9.9", ".verified.json");
	const original = JSON.parse(readFileSync(receipt, "utf8"));
	for (const patch of [{ version: "9.9.8" }, { package: "another-package" }, { integrity: "sha512-forged" }]) {
		writeFileSync(receipt, JSON.stringify({ ...original, ...patch }));
		expect(cachedOmpPackage("9.9.9", env)).toBeNull();
	}
});
test("a cached package missing a declared runtime entrypoint is rejected and repaired", () => {
	const cache = fresh();
	const env = { OMP_KIT_OMP_SRC_CACHE: cache };
	const pkg = ensureOmpSource("9.9.9", env, { install: fakeInstall().install });
	const entry = join(cache, "9.9.9", OTEL_RUNTIME_ENTRY);
	rmSync(entry);
	expect(cachedOmpPackage("9.9.9", env)).toBeNull();
	const repair = fakeInstall();
	expect(ensureOmpSource("9.9.9", env, { install: repair.install })).toBe(pkg);
	expect(repair.calls).toEqual(["@oh-my-pi/pi-coding-agent@9.9.9"]);
	expect(existsSync(entry)).toBe(true);
});

test("Tern observe identity binds launcher bytes and exact-version cached source", () => {
	const cache = fresh();
	const env = { OMP_KIT_OMP_SRC_CACHE: cache };
	const pkg = ensureOmpSource("9.9.9", env, { install: fakeInstall().install });
	const manager = join(base, `tern-proof-${++n}`);
	mkdirSync(join(manager, "versions"), { recursive: true });
	const launcher = join(manager, "versions", "9.9.9");
	const bytes = '#!/bin/sh\necho "9.9.9"\n';
	writeFileSync(launcher, bytes);
	const state = { managed: true, installed: { version: "9.9.9", sha256: createHash("sha256").update(bytes).digest("hex") } };
	writeFileSync(join(manager, "state.json"), JSON.stringify(state));
	expect(verifyTernOmpSource(launcher, join(pkg, "src"))).toBe(true);
	writeFileSync(launcher, '#!/bin/sh\necho "9.9.9"\n# foreign same-version bytes\n');
	expect(verifyTernOmpSource(launcher, join(pkg, "src"))).toBe(false);
	writeFileSync(launcher, bytes);
	writeFileSync(join(cache, "9.9.9", ".verified.json"), "{}");
	expect(verifyTernOmpSource(launcher, join(pkg, "src"))).toBe(false);
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

/** A Tern-managed omp: versions/9.9.9 binary beside state.json, plus an unverified omp-src package. */
function ternManaged(stated: string | null, pkgVersion: string | null, matcher = true): { path: string; cache: string } {
	const app = join(base, `tern-${++n}`);
	mkdirSync(join(app, "bin"), { recursive: true });
	mkdirSync(join(app, "versions"), { recursive: true });
	writeFileSync(join(app, "versions", "9.9.9"), `#!/bin/sh\necho "omp/9.9.9"\n`);
	chmodSync(join(app, "versions", "9.9.9"), 0o755);
	symlinkSync("../versions/9.9.9", join(app, "bin", "omp"));
	if (stated !== null) writeFileSync(join(app, "state.json"), JSON.stringify({ installed: { version: stated } }));
	const cache = join(base, `tern-cache-${n}`);
	if (pkgVersion !== null) {
		const pkg = join(cache, "9.9.9", ...PKG);
		for (const dir of ["export", "capability", "discovery"]) mkdirSync(join(pkg, "src", dir), { recursive: true });
		mkdirSync(join(cache, "9.9.9", "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
		writeFileSync(join(cache, "9.9.9", "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives", version: pkgVersion }));
		writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: pkgVersion }));
		addOtelRuntime(join(cache, "9.9.9"));
		for (const file of matcher ? ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"] : ["export/ttsr.ts", "capability/rule.ts"]) {
			writeFileSync(join(pkg, "src", file), "export {};\n");
		}
	}
	return { path: join(app, "bin"), cache };
}

test("product resolver: a Tern-managed launcher resolves its corroborated package without the npm receipt", () => {
	const { path, cache } = ternManaged("9.9.9", "9.9.9");
	const identity = resolveOmpIdentity({ PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" });
	expect(identity.source).toBe(realpathSync(join(cache, "9.9.9", ...PKG, "src")));
});
test("Tern-managed source refuses a package missing a required runtime dependency", () => {
	const { path, cache } = ternManaged("9.9.9", "9.9.9");
	rmSync(join(cache, "9.9.9", OTEL_RUNTIME_ENTRY));
	expect(() => resolveOmpIdentity({
		PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0",
	})).toThrow("OMP_KIT_OMP_SRC_FETCH=0");
});

test("planted: a Tern state.json naming another version still refuses", () => {
	const { path, cache } = ternManaged("9.9.8", "9.9.9");
	expect(() => resolveOmpIdentity({ PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" }))
		.toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.9 for OMP launcher");
});

test("planted: a Tern package manifest naming another version still refuses", () => {
	const { path, cache } = ternManaged("9.9.9", "9.9.8");
	expect(() => resolveOmpIdentity({ PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" }))
		.toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.9 for OMP launcher");
});

test("planted: a Tern layout without state.json still refuses instead of trusting the binary name", () => {
	const { path, cache } = ternManaged(null, "9.9.9");
	expect(() => resolveOmpIdentity({ PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" }))
		.toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.9 for OMP launcher");
});

test("planted: a Tern package missing matcher source still refuses", () => {
	const { path, cache } = ternManaged("9.9.9", "9.9.9", false);
	expect(() => resolveOmpIdentity({ PATH: path, BUN_INSTALL: join(base, "no-bun"), OMP_KIT_OMP_SRC_CACHE: cache, OMP_KIT_OMP_SRC_FETCH: "0" }))
		.toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.9 for OMP launcher");
});
