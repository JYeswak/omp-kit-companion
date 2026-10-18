import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
const MATCHER_FILES = ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"];
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// One bun.lock package line: `"<name>": ["<name>@<version>", "", {...}, "sha512-…"]`.
const INTEGRITY_RE = /"(sha512-[A-Za-z0-9+/]+={0,2})"/;
const KEEP_VERSIONS = 2;

export interface SourceCacheDeps {
	/** Runs `bun add`; injectable so tests never touch the network. */
	install?: (cwd: string, spec: string, env: Record<string, string | undefined>) => { status: number | null; output: string };
	now?: () => Date;
}

/**
 * Tern (and any compiled OMP) ships one binary with no TypeScript beside it, but the kit matcher runs
 * OMP's own source. This cache holds `@oh-my-pi/pi-coding-agent` of exactly one version per directory,
 * installed from the npm registry by bun (which checks each tarball's sha512) with lifecycle scripts
 * off. A directory is used only if its manifest names the requested version and its receipt exists.
 * Off when OMP_KIT_OMP_SRC_FETCH=0 or when no HOME/OMP_KIT_OMP_SRC_CACHE is set.
 */
export function ompSourceCacheRoot(env: Record<string, string | undefined>): string | null {
	if (env.OMP_KIT_OMP_SRC_CACHE) return env.OMP_KIT_OMP_SRC_CACHE;
	return env.HOME ? join(env.HOME, ".local", "opt", "omp-kit", "omp-src") : null;
}

function packageDir(versionDir: string): string {
	return join(versionDir, "node_modules", ...PACKAGE_NAME.split("/"));
}

function manifestVersion(pkgDir: string): unknown {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		if (typeof parsed === "object" && parsed !== null && "name" in parsed && parsed.name === PACKAGE_NAME && "version" in parsed) return parsed.version;
	} catch {}
	return undefined;
}

/** The cached package root for exactly `version`, or null. Never returns another version. */
export function cachedOmpPackage(version: string, env: Record<string, string | undefined>): string | null {
	const root = ompSourceCacheRoot(env);
	if (!root || !VERSION_RE.test(version)) return null;
	const versionDir = join(root, version);
	const pkg = packageDir(versionDir);
	if (!existsSync(join(versionDir, ".verified.json"))) return null;
	if (manifestVersion(pkg) !== version) return null;
	try {
		const receipt: unknown = JSON.parse(readFileSync(join(versionDir, ".verified.json"), "utf8"));
		const integrity = lockIntegrity(versionDir, version);
		if (typeof receipt !== "object" || receipt === null ||
			!("package" in receipt) || receipt.package !== PACKAGE_NAME ||
			!("version" in receipt) || receipt.version !== version ||
			!("integrity" in receipt) || integrity === null || receipt.integrity !== integrity) return null;
	} catch {
		return null;
	}
	if (!MATCHER_FILES.every(file => existsSync(join(pkg, "src", file)))) return null;
	return pkg;
}

function defaultInstall(cwd: string, spec: string, env: Record<string, string | undefined>) {
	const run = spawnSync("bun", ["add", spec, "--exact", "--ignore-scripts"], {
		cwd, encoding: "utf8", timeout: 600_000, env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "", TMPDIR: env.TMPDIR ?? "" },
	});
	return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

function lockIntegrity(versionDir: string, version: string): string | null {
	let text: string;
	try {
		text = readFileSync(join(versionDir, "bun.lock"), "utf8");
	} catch {
		return null;
	}
	const token = `"${PACKAGE_NAME}@${version}"`;
	for (const line of text.split("\n")) {
		if (!line.includes(token)) continue;
		const m = INTEGRITY_RE.exec(line.slice(0, 4000));
		if (m) return m[1];
	}
	return null;
}

function prune(root: string, keep: string): void {
	const versions = readdirSync(root).filter(name => VERSION_RE.test(name));
	const byNewest = versions.sort((a, b) => {
		const [x, y] = [a, b].map(v => v.split(".").map(Number));
		return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
	});
	for (const old of byNewest.slice(KEEP_VERSIONS)) {
		if (old !== keep) rmSync(join(root, old), { recursive: true, force: true });
	}
}

/**
 * Return the package root for exactly `version`, installing it into the cache when absent.
 * OMP_KIT_OMP_SRC_FETCH=0 stops installs only; an already verified entry is still served.
 * Throws with the reason when no cache root exists, the install fails, or the result is not that version.
 */
export function ensureOmpSource(version: string, env: Record<string, string | undefined>, deps: SourceCacheDeps = {}): string {
	if (!VERSION_RE.test(version)) throw new Error(`refusing to fetch OMP source for a non-release version: ${version}`);
	const root = ompSourceCacheRoot(env);
	if (!root) throw new Error("no HOME or OMP_KIT_OMP_SRC_CACHE for the OMP source cache");
	const hit = cachedOmpPackage(version, env);
	if (hit) return hit;
	if (env.OMP_KIT_OMP_SRC_FETCH === "0") throw new Error("OMP source fetch is off (OMP_KIT_OMP_SRC_FETCH=0)");
	mkdirSync(root, { recursive: true });
	const staging = join(root, `.${version}.staging-${process.pid}`);
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(staging, { recursive: true });
	try {
		writeFileSync(join(staging, "package.json"), `${JSON.stringify({ name: "omp-kit-omp-src", private: true })}\n`);
		const spec = `${PACKAGE_NAME}@${version}`;
		const result = (deps.install ?? defaultInstall)(staging, spec, env);
		if (result.status !== 0) throw new Error(`bun add ${spec} failed (exit ${result.status}): ${result.output.trim().slice(-400)}`);
		const got = manifestVersion(packageDir(staging));
		if (got !== version) throw new Error(`installed ${PACKAGE_NAME} reports version ${String(got)}, not ${version}`);
		const missing = MATCHER_FILES.filter(file => !existsSync(join(packageDir(staging), "src", file)));
		if (missing.length) throw new Error(`installed ${spec} lacks matcher source: ${missing.join(", ")}`);
		const integrity = lockIntegrity(staging, version);
		if (!integrity) throw new Error(`bun.lock has no sha512 integrity for ${spec}`);
		const receipt = { package: PACKAGE_NAME, version, integrity, installed_at: (deps.now ?? (() => new Date()))().toISOString(), installer: "bun add --exact --ignore-scripts" };
		writeFileSync(join(staging, ".verified.json"), `${JSON.stringify(receipt, null, 1)}\n`);
		const final = join(root, version);
		rmSync(final, { recursive: true, force: true });
		renameSync(staging, final);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	prune(root, version);
	const pkg = cachedOmpPackage(version, env);
	if (!pkg) throw new Error(`OMP source cache for ${version} failed its own check after install`);
	return pkg;
}
