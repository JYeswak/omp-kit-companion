import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { releaseRoot, resolveBundledScript, resolveOmpIdentity, type OmpIdentity } from "./paths.ts";

export interface BundledRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

const CHILD_ENV_KEYS = ["CI", "LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "USER"] as const;
const PRIVATE_DIRS = ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install"] as const;

export function runtimeTempRoot(): string {
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin" },
		});
		if (result.exitCode !== 0) {
			throw new Error(`cannot locate macOS private temp root: ${result.stderr.toString().trim()}`);
		}
		const root = result.stdout.toString().trim();
		if (!isAbsolute(root)) throw new Error(`getconf returned a non-absolute temp root: ${root}`);
		return realpathSync(root);
	}
	if (process.platform === "linux") return realpathSync("/tmp");
	throw new Error(`unsupported platform for isolated runtime scratch: ${process.platform}`);
}

function sanitizedEnv(
	identity: OmpIdentity,
	inherited: Record<string, string | undefined>,
	privateRoot: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = inherited[key];
		if (value !== undefined) env[key] = value;
	}
	env.HOME = join(privateRoot, "home");
	env.TMPDIR = join(privateRoot, "tmp");
	env.TMP = env.TMPDIR;
	env.TEMP = env.TMPDIR;
	env.XDG_CONFIG_HOME = join(privateRoot, "xdg-config");
	env.XDG_CACHE_HOME = join(privateRoot, "xdg-cache");
	env.XDG_DATA_HOME = join(privateRoot, "xdg-data");
	env.XDG_STATE_HOME = join(privateRoot, "xdg-state");
	env.BUN_INSTALL = join(privateRoot, "bun-install");
	env.OMP = identity.launcher;
	env.OMP_BIN = identity.launcher;
	env.OMP_PATH = identity.launcher;
	env.OMP_SRC = identity.source;
	return env;
}

/** Run allowlisted packaged scripts under one private HOME/XDG/Bun/OMP environment. */
async function runIsolated(
	script: string,
	args: readonly string[],
	root: string,
	executablePath: string,
	shell: boolean,
): Promise<BundledRunResult> {
	if (!isAbsolute(executablePath)) throw new Error(`compiled executable path must be absolute: ${executablePath}`);
	const realExecutable = realpathSync(executablePath);
	const realRoot = realpathSync(resolve(root));
	if (releaseRoot(executablePath) !== realRoot) {
		throw new Error(`release root does not match compiled executable: ${realRoot}`);
	}
	const absoluteScript = resolveBundledScript(script, realRoot);
	const identity = resolveOmpIdentity(process.env);
	const privateRoot = mkdtempSync(join(runtimeTempRoot(), "omp-kit-runtime-"));
	try {
		for (const directory of PRIVATE_DIRS) mkdirSync(join(privateRoot, directory));
		const child = Bun.spawn(shell ? ["/bin/sh", absoluteScript, ...args] : [realExecutable, absoluteScript, ...args], {
			cwd: realRoot,
			env: { ...sanitizedEnv(identity, process.env, privateRoot), ...(shell ? {} : { BUN_BE_BUN: "1" }) },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		return { code, stdout, stderr };
	} finally {
		rmSync(privateRoot, { recursive: true, force: true });
	}
}

/** Harness scripts use the packaged executable's embedded Bun, never host Bun. */
export function runBundled(script: string, args: readonly string[], root: string, executablePath: string): Promise<BundledRunResult> {
	return runIsolated(script, args, root, executablePath, false);
}

/** Shell stages receive the same isolated identity; their Bun calls go through runtime-adapter.sh. */
export function runIsolatedShell(script: string, args: readonly string[], root: string, executablePath: string): Promise<BundledRunResult> {
	return runIsolated(script, args, root, executablePath, true);
}
