import { spawnSync } from "node:child_process";
import { ensureOmpSource, ompSourceCacheRoot } from "./omp-source-cache.ts";
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
const NATIVE_PACKAGE = "@oh-my-pi/pi-natives";
const BUNDLED_SCRIPTS: Record<string, true> = {
	"scripts/apply-policy.sh": true,
	"scripts/build-manifest.sh": true,
	"scripts/context-inventory.ts": true,
	"scripts/doctor.sh": true,
	"scripts/e2e-live.sh": true,
	"scripts/external-live.mjs": true,
	"scripts/install-extensions.sh": true,
	"scripts/ladder.sh": true,
	"scripts/rule-class.ts": true,
	"scripts/ttsr-harness.ts": true,
};

export interface OmpIdentity {
	/** Absolute real launcher path; never a PATH alias or a different OMP install. */
	launcher: string;
	/** Real root of the installed @oh-my-pi/pi-coding-agent package. */
	packageRoot: string;
	/** Real source directory used by the kit matcher. */
	source: string;
	/** Real installed native dependency root used by OMP's source modules. */
	nativeRoot: string;
}
export type OmpManagerSource = "tern" | "bun" | "unknown";
export type OmpManagerVersionStatus = "PRESENT" | "UNAVAILABLE" | "UNVERIFIED";
export interface OmpManagerVersionObservation {
	status: OmpManagerVersionStatus;
	version: string | null;
	provenance: "TERN_STATE" | "BUN_PACKAGE_METADATA";
	reason?: string;
}
export interface OmpManagerObservation {
	launcher: string | null;
	source: OmpManagerSource;
	sourceProvenance: "TERN_PATH_LAYOUT" | "BUN_GLOBAL_PACKAGE_PATH" | "UNKNOWN";
	versions: { tern: OmpManagerVersionObservation; bun: OmpManagerVersionObservation };
}

function isWithin(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realpath(target: string, description: string): string {
	try {
		return realpathSync(target);
	} catch (error) {
		throw new Error(`${description} cannot be resolved: ${target}`, { cause: error });
	}
}

function executable(target: string): boolean {
	try {
		if (!statSync(target).isFile()) return false;
		accessSync(target, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function executablesFromPath(name: string, pathValue: string | undefined): string[] {
	if (!pathValue) return [];
	const found: string[] = [];
	for (const directory of pathValue.split(delimiter)) {
		const candidate = resolve(directory || ".", name);
		if (!existsSync(candidate)) continue;
		let real: string;
		try {
			real = realpathSync(candidate);
		} catch {
			continue;
		}
		if (executable(real)) found.push(real);
	}
	return found;
}

function explicitLauncher(value: string, pathValue: string | undefined, key: string): string {
	const named = !value.includes("/") && !value.includes("\\");
	if (named) {
		const found = executablesFromPath(value, pathValue)[0];
		if (found) return found;
	}
	const absolute = resolve(value);
	const real = realpath(absolute, `${key} launcher`);
	if (!executable(real)) throw new Error(`${key} does not resolve to an executable file: ${value}`);
	return real;
}

/** The @oh-my-pi/pi-coding-agent package containing `start`, or null when `start` is outside any. */
function enclosingPackage(start: string): { root: string; version: unknown } | null {
	for (let dir = dirname(start); ; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
				if (typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === PACKAGE_NAME) {
					return { root: realpath(dir, "OMP package root"), version: "version" in parsed ? parsed.version : undefined };
				}
			} catch (error) {
				if (error instanceof SyntaxError) throw new Error(`invalid OMP package manifest: ${manifest}`, { cause: error });
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
	}
}

export function observeOmpLauncherVersion(launcher: string, env: Record<string, string | undefined>): string | null {
	// From the launcher's own directory: a trust-gated launcher refuses to run inside an untrusted
	// project, which is exactly where the kit is often invoked.
	const run = spawnSync(launcher, ["--version"], {
		cwd: dirname(launcher), encoding: "utf8", timeout: 15_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" },
	});
	if (run.status !== 0) return null;
	return /(\d+\.\d+\.\d+)/.exec(run.stdout)?.[1] ?? null;
}
export function resolveOmpLauncher(env: Record<string, string | undefined> = process.env): string | null {
	return executablesFromPath("omp", env.PATH)[0] ?? null;
}
interface TernManagerState {
	pathVersion: string;
	version: string | null;
	status: OmpManagerVersionStatus;
	reason?: string;
}
function ternManagerState(launcher: string): TernManagerState | null {
	let real: string;
	try {
		real = realpathSync(launcher);
	} catch {
		return null;
	}
	if (basename(dirname(real)) !== "versions") return null;
	const pathVersion = basename(real);
	const statePath = join(dirname(dirname(real)), "state.json");
	try {
		const info = lstatSync(statePath);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { pathVersion, version: null, status: "UNVERIFIED", reason: "Tern state.json is not a regular file" };
		}
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("installed" in parsed)) {
			return { pathVersion, version: null, status: "UNVERIFIED", reason: "Tern state.json has no installed record" };
		}
		const installed = parsed.installed;
		if (typeof installed !== "object" || installed === null || !("version" in installed) ||
			typeof installed.version !== "string" || !installed.version.trim()) {
			return { pathVersion, version: null, status: "UNVERIFIED", reason: "Tern state.json has no installed version" };
		}
		const version = installed.version;
		return version === pathVersion
			? { pathVersion, version, status: "PRESENT" }
			: { pathVersion, version, status: "UNVERIFIED", reason: "Tern state version disagrees with its PATH launcher" };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
		return {
			pathVersion,
			version: null,
			status: "UNVERIFIED",
			reason: code === "ENOENT" ? "Tern state.json is missing" : "Tern state.json is unreadable",
		};
	}
}
interface BunManagerPackage {
	root: string | null;
	packageRoot: string | null;
	observation: OmpManagerVersionObservation;
}
function bunManagerPackage(env: Record<string, string | undefined>): BunManagerPackage {
	const configuredRoot = env.BUN_INSTALL ?? (env.HOME ? join(env.HOME, ".bun") : null);
	if (!configuredRoot) {
		return { root: null, packageRoot: null, observation: { status: "UNAVAILABLE", version: null, provenance: "BUN_PACKAGE_METADATA", reason: "BUN_INSTALL and HOME are unavailable" } };
	}
	let root: string;
	try {
		root = realpathSync(configuredRoot);
		if (!statSync(root).isDirectory()) throw new Error("BUN_INSTALL is not a directory");
	} catch {
		return { root: null, packageRoot: null, observation: { status: "UNAVAILABLE", version: null, provenance: "BUN_PACKAGE_METADATA", reason: "Bun install root is unavailable" } };
	}
	const expectedPackageRoot = join(root, "install", "global", "node_modules", ...PACKAGE_NAME.split("/"));
	try {
		const packageRoot = realpathSync(expectedPackageRoot);
		if (!isWithin(root, packageRoot)) {
			return { root, packageRoot: null, observation: { status: "UNVERIFIED", version: null, provenance: "BUN_PACKAGE_METADATA", reason: "Bun OMP package escapes BUN_INSTALL" } };
		}
		const manifest = join(packageRoot, "package.json");
		const info = lstatSync(manifest);
		if (info.isSymbolicLink() || !info.isFile()) {
			return { root, packageRoot: null, observation: { status: "UNVERIFIED", version: null, provenance: "BUN_PACKAGE_METADATA", reason: "Bun OMP package metadata is not a regular file" } };
		}
		const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed) || parsed.name !== PACKAGE_NAME ||
			!("version" in parsed) || typeof parsed.version !== "string" || !parsed.version.trim()) {
			return { root, packageRoot, observation: { status: "UNVERIFIED", version: null, provenance: "BUN_PACKAGE_METADATA", reason: "Bun OMP package metadata has no verifiable version" } };
		}
		return { root, packageRoot, observation: { status: "PRESENT", version: parsed.version, provenance: "BUN_PACKAGE_METADATA" } };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
		return {
			root,
			packageRoot: null,
			observation: {
				status: code === "ENOENT" ? "UNAVAILABLE" : "UNVERIFIED",
				version: null,
				provenance: "BUN_PACKAGE_METADATA",
				reason: code === "ENOENT" ? "Bun OMP package is not installed" : "Bun OMP package metadata is unreadable",
			},
		};
	}
}
export function observeOmpManagers(env: Record<string, string | undefined> = process.env): OmpManagerObservation {
	const launchers = executablesFromPath("omp", env.PATH);
	const launcher = launchers[0] ?? null;
	let tern: OmpManagerVersionObservation = {
		status: "UNAVAILABLE", version: null, provenance: "TERN_STATE", reason: "No Tern-managed OMP launcher is on PATH",
	};
	let firstTern: TernManagerState | null = null;
	for (const candidate of launchers) {
		const state = ternManagerState(candidate);
		if (!state) continue;
		if (!firstTern) firstTern = state;
		else if (firstTern.version !== state.version || firstTern.status !== state.status) {
			tern = { status: "UNVERIFIED", version: null, provenance: "TERN_STATE", reason: "Multiple Tern-managed OMP versions are on PATH" };
			firstTern = null;
			break;
		}
	}
	if (firstTern) {
		tern = { status: firstTern.status, version: firstTern.version, provenance: "TERN_STATE", ...(firstTern.reason ? { reason: firstTern.reason } : {}) };
	}
	const bun = bunManagerPackage(env);
	let source: OmpManagerSource = "unknown";
	let sourceProvenance: OmpManagerObservation["sourceProvenance"] = "UNKNOWN";
	if (launcher && ternManagerState(launcher)) {
		source = "tern";
		sourceProvenance = "TERN_PATH_LAYOUT";
	} else if (launcher && bun.root && bun.packageRoot && isWithin(bun.packageRoot, launcher)) {
		source = "bun";
		sourceProvenance = "BUN_GLOBAL_PACKAGE_PATH";
	}
	return { launcher, source, sourceProvenance, versions: { tern, bun: bun.observation } };
}

/**
 * A launcher inside its package owns that package. A compiled standalone launcher (for example
 * Tern's omp, or ~/.local/bin/omp) has no package around it, so the package of exactly the version
 * it reports is taken from a later `omp` on PATH, from bun's global install, or else from the kit's
 * own exact-version source cache (installed from npm on first use). Any other version is refused:
 * matching rules with a different OMP's source is the drift the identity check exists to stop.
 */
/** A manager-laid-out omp: `<app>/versions/<V>` binary beside a state.json naming it. */
function ternManagedPackage(launcher: string, version: string | null, env: Record<string, string | undefined>): string | null {
	const state = ternManagerState(launcher);
	if (version === null || !state || state.status !== "PRESENT" || state.version !== version) return null;
	const root = ompSourceCacheRoot(env);
	if (!root) return null;
	const pkg = join(root, version, "node_modules", ...PACKAGE_NAME.split("/"));
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("name" in parsed) || parsed.name !== PACKAGE_NAME ||
			!("version" in parsed) || parsed.version !== version) return null;
	} catch {
		return null;
	}
	for (const file of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		if (!existsSync(join(pkg, "src", file))) return null;
	}
	return realpath(pkg, "OMP Tern-managed package");
}
function packageRootFor(launcher: string, env: Record<string, string | undefined>): string {
	const own = enclosingPackage(launcher);
	if (own) return own.root;
	const version = observeOmpLauncherVersion(launcher, env);
	const bunRoot = env.BUN_INSTALL ?? (env.HOME ? join(env.HOME, ".bun") : null);
	const candidates = executablesFromPath("omp", env.PATH).filter(other => other !== launcher);
	if (bunRoot) candidates.push(join(bunRoot, "install", "global", "node_modules", ...PACKAGE_NAME.split("/"), "package.json"));
	for (const candidate of candidates) {
		const found = enclosingPackage(candidate);
		if (found && version !== null && found.version === version) return found.root;
	}
	const managed = ternManagedPackage(launcher, version, env);
	if (managed) return managed;
	const refusal = `cannot locate ${PACKAGE_NAME} ${version ?? "(unknown version)"} for OMP launcher ${launcher}`;
	if (version === null || !ompSourceCacheRoot(env)) throw new Error(refusal);
	try {
		return realpath(ensureOmpSource(version, env), "OMP source cache package");
	} catch (error) {
		throw new Error(`${refusal}; source cache: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

function nativePackageRoot(source: string): string {
	for (let dir = source; ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", ...NATIVE_PACKAGE.split("/"));
		const manifest = join(candidate, "package.json");
		if (existsSync(manifest)) {
			const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			if (typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === NATIVE_PACKAGE) {
				return realpath(candidate, "OMP native dependency");
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
	}
	throw new Error(`OMP native dependency ${NATIVE_PACKAGE} is missing for source ${source}`);
}

function identityFor(launcher: string, env: Record<string, string | undefined>): OmpIdentity {
	const packageRoot = packageRootFor(launcher, env);
	const sourcePath = join(packageRoot, "src");
	if (!existsSync(sourcePath)) {
		throw new Error(`OMP source is missing at ${sourcePath}; binary-only OMP cannot run the kit matcher`);
	}
	const source = realpath(sourcePath, "OMP source");
	for (const relativeFile of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		if (!existsSync(join(source, relativeFile))) {
			throw new Error(`OMP matcher source is incomplete: ${join(source, relativeFile)} is missing`);
		}
	}
	return { launcher, packageRoot, source, nativeRoot: nativePackageRoot(source) };
}

/**
 * Resolve the stable installed launcher to its real executable and package root.
 * The stable entry is expected at <prefix>/bin/<name>; its target must remain inside
 * that prefix so an escaping or dangling symlink cannot silently select another install.
 */
export function releaseRoot(executablePath: string): string {
	if (!isAbsolute(executablePath)) throw new Error(`compiled executable path must be absolute: ${executablePath}`);
	const stablePath = resolve(executablePath);
	const realExecutable = realpath(stablePath, "compiled executable symlink");
	if (!executable(realExecutable)) throw new Error(`compiled executable is not executable: ${realExecutable}`);
	const prefix = realpath(dirname(dirname(stablePath)), "compiled executable install prefix");
	if (!isWithin(prefix, realExecutable)) {
		throw new Error(`compiled executable symlink escapes install prefix ${prefix}: ${realExecutable}`);
	}
	const binaryDirectory = dirname(realExecutable);
	if (basename(realExecutable) !== "omp-kit" || basename(binaryDirectory) !== "bin") {
		throw new Error(`compiled executable must be a release bin/omp-kit: ${realExecutable}`);
	}
	return dirname(binaryDirectory);
}

/** Resolve a packaged script by its named allowlist entry and real path. */
export function resolveBundledScript(script: string, root: string): string {
	if (!Object.prototype.hasOwnProperty.call(BUNDLED_SCRIPTS, script)) throw new Error(`script is not an allowlisted packaged path: ${script}`);
	const realRoot = realpath(resolve(root), "omp-kit release root");
	const candidate = join(realRoot, script);
	const realScript = realpath(candidate, "packaged script");
	if (!isWithin(realRoot, realScript)) throw new Error(`packaged script escapes release root: ${script}`);
	if (!statSync(realScript).isFile()) throw new Error(`packaged script is not a file: ${script}`);
	return realScript;
}

/** Resolve the PATH-selected OMP package and reject every inherited identity override that disagrees. */
export function resolveOmpIdentity(env: Record<string, string | undefined> = process.env): OmpIdentity {
	const pathValue = env.PATH;
	const pathLauncher = resolveOmpLauncher(env);
	if (!pathLauncher) throw new Error("omp executable not found on PATH");
	const identity = identityFor(pathLauncher, env);

	for (const key of ["OMP_PATH", "OMP_BIN", "OMP"] as const) {
		const value = env[key];
		if (!value) continue;
		const override = explicitLauncher(value, pathValue, key);
		if (override !== identity.launcher) {
			throw new Error(`${key} conflicts with the PATH-selected OMP launcher; refusing mixed OMP identities`);
		}
	}
	const sourceOverride = env.OMP_SRC;
	if (sourceOverride) {
		const source = realpath(resolve(sourceOverride), "OMP_SRC");
		if (source !== identity.source) {
			throw new Error("OMP_SRC conflicts with the PATH-selected OMP source; refusing mixed OMP identities");
		}
	}
	return identity;
}
