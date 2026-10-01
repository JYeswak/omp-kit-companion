import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
	"scripts/role-check.ts": true,
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

function executableFromPath(name: string, pathValue: string | undefined): string | null {
	if (!pathValue) return null;
	for (const directory of pathValue.split(delimiter)) {
		const candidate = resolve(directory || ".", name);
		if (!existsSync(candidate)) continue;
		let real: string;
		try {
			real = realpathSync(candidate);
		} catch {
			continue;
		}
		if (executable(real)) return real;
	}
	return null;
}

function explicitLauncher(value: string, pathValue: string | undefined, key: string): string {
	const named = !value.includes("/") && !value.includes("\\");
	if (named) {
		const found = executableFromPath(value, pathValue);
		if (found) return found;
	}
	const absolute = resolve(value);
	const real = realpath(absolute, `${key} launcher`);
	if (!executable(real)) throw new Error(`${key} does not resolve to an executable file: ${value}`);
	return real;
}

function packageRootFor(launcher: string): string {
	for (let dir = dirname(launcher); ; dir = dirname(dir)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
				if (typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === PACKAGE_NAME) {
					return realpath(dir, "OMP package root");
				}
			} catch (error) {
				if (error instanceof SyntaxError) throw new Error(`invalid OMP package manifest: ${manifest}`, { cause: error });
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
	}
	throw new Error(`cannot locate ${PACKAGE_NAME} for OMP launcher ${launcher}`);
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

function identityFor(launcher: string): OmpIdentity {
	const packageRoot = packageRootFor(launcher);
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
	const pathLauncher = executableFromPath("omp", pathValue);
	if (!pathLauncher) throw new Error("omp executable not found on PATH");
	const identity = identityFor(pathLauncher);

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
