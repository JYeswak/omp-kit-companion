import { performance } from "node:perf_hooks";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { releaseRoot, resolveBundledScript, resolveOmpIdentity, type OmpIdentity } from "./paths.ts";
import { parseOwnerFile } from "./scratch.ts";
import { ompSourceCacheRoot } from "./omp-source-cache.ts";

export interface BundledRunResult {
	code: number;
	stdout: string;
	stderr: string;
	in_flight_stage?: { name: string; started_at: number; started_at_ms: number } | null;
}
export class BundledRunInterruptedError extends Error {
	constructor(readonly originalCause: unknown, readonly partialResult: BundledRunResult) {
		super(originalCause instanceof Error ? originalCause.message : String(originalCause));
		this.name = "BundledRunInterruptedError";
	}
}

const CHILD_ENV_KEYS = ["CI", "GITHUB_ACTIONS", "LANG", "LC_ALL", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "USER"] as const;
const PRIVATE_DIRS = ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install"] as const;

let cachedSystemTempRoots: readonly string[] | undefined;

function systemTempRoots(): readonly string[] {
	if (cachedSystemTempRoots) return cachedSystemTempRoots;
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin" },
		});
		if (result.exitCode !== 0) {
			throw new Error(`cannot locate macOS private temp root: ${result.stderr.toString().trim()}`);
		}
		const configuredRoot = result.stdout.toString().trim();
		if (!isAbsolute(configuredRoot)) throw new Error(`getconf returned a non-absolute temp root: ${configuredRoot}`);
		const roots = [realpathSync(configuredRoot)];
		try { roots.push(realpathSync("/private/tmp")); } catch {}
		cachedSystemTempRoots = roots;
		return roots;
	}
	if (process.platform === "linux") return cachedSystemTempRoots = [realpathSync("/tmp")];
	throw new Error(`unsupported platform for isolated runtime scratch: ${process.platform}`);
}


function callerScratchRoot(root: string, workspace: string): string {
	try {
		if (!isAbsolute(root)) throw new Error("absolute root required");
		const caller = realpathSync(resolve(workspace));
		const scratch = join(caller, "var", "agent-tmp");
		const rootInfo = lstatSync(root);
		const canonical = realpathSync(root);
		const inside = relative(scratch, canonical);
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.getuid?.()
			|| canonical !== resolve(root) || realpathSync(scratch) !== scratch
			|| inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("workspace containment required");
		const marker = join(canonical, ".owner");
		const ownerInfo = lstatSync(marker);
		if (!ownerInfo.isFile() || ownerInfo.isSymbolicLink() || ownerInfo.uid !== rootInfo.uid || ownerInfo.size > 4096) throw new Error("owner marker required");
		const owner = parseOwnerFile(readFileSync(marker, "utf8"));
		if (!owner || !isAbsolute(owner.repo) || realpathSync(owner.repo) !== caller) throw new Error("owner workspace mismatch");
		return canonical;
	} catch {
		throw new Error("Invalid caller-owned scratch root: require an owned var/agent-tmp directory with a matching .owner marker");
	}
}

export function runtimeTempRoot(): string {
	if (process.env.OMP_KIT_TEST_WORK_ROOT !== undefined) {
		return callerScratchRoot(process.env.OMP_KIT_TEST_WORK_ROOT, process.env.OMP_KIT_CASE_CWD || process.env.GITHUB_WORKSPACE || process.cwd());
	}
	const roots = systemTempRoots();
	try {
		const root = realpathSync(tmpdir());
		const rootWithinSystemTemp = roots.some(systemRoot => {
			const fromSystemRoot = relative(systemRoot, root);
			return fromSystemRoot === "" || (fromSystemRoot !== ".." && !fromSystemRoot.startsWith(`..${sep}`) && !isAbsolute(fromSystemRoot));
		});
		if (statSync(root).isDirectory() && rootWithinSystemTemp) {
			const home = process.env.HOME;
			if (!home || !isAbsolute(home)) return root;
			try {
				const fromHome = relative(realpathSync(home), root);
				if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) return root;
			} catch {
				return root;
			}
		}
	} catch {}
	return roots[0]!;
}

/** Allowlisted child environment for isolated runs. Exported for contract tests. */
export function sanitizedEnv(
	identity: OmpIdentity,
	inherited: Record<string, string | undefined>,
	privateRoot: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = inherited[key];
		if (value !== undefined) env[key] = value;
	}
	if (inherited.OMP_KIT_NATIVE_STAGE_PROGRESS === "1") env.OMP_KIT_NATIVE_STAGE_PROGRESS = "1";
	const sourceCache = ompSourceCacheRoot(inherited);
	if (sourceCache) env.OMP_KIT_OMP_SRC_CACHE = resolve(sourceCache);
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
	// The harness runs from the packaged release; path scopes need the caller's workspace root.
	const caseCwd = inherited.OMP_KIT_CASE_CWD || inherited.GITHUB_WORKSPACE || process.cwd();
	env.OMP_KIT_CASE_CWD = isAbsolute(caseCwd) ? caseCwd : resolve(caseCwd);
	if (inherited.OMP_KIT_TEST_WORK_ROOT !== undefined) env.OMP_KIT_TEST_WORK_ROOT = callerScratchRoot(inherited.OMP_KIT_TEST_WORK_ROOT, caseCwd);
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
	let cleanupPrivateRoot = true;
	try {
		for (const directory of PRIVATE_DIRS) mkdirSync(join(privateRoot, directory), { mode: 0o700 });
		const ownsGroup = process.platform === "darwin" || process.platform === "linux";
		const child = Bun.spawn(shell ? ["/bin/sh", absoluteScript, ...args] : [realExecutable, absoluteScript, ...args], {
			cwd: realRoot,
			env: { ...sanitizedEnv(identity, process.env, privateRoot), ...(shell ? {} : { BUN_BE_BUN: "1" }) },
			stdout: "pipe",
			stderr: "pipe",
			detached: ownsGroup,
		});
		let inFlight: BundledRunResult["in_flight_stage"] = null;
		let partialStdout = "";
		let partialStderr = "";
		const streams: Readable[] = [];
		const readText = async (input: ReadableStream<Uint8Array>, onChunk: (chunk: string) => void, onLine?: (line: string) => void): Promise<void> => {
			const stream = Readable.fromWeb(input);
			streams.push(stream);
			const drained = finished(stream);
			let pending = "";
			stream.setEncoding("utf8").on("data", (chunk: string) => {
				onChunk(chunk);
				if (!onLine) return;
				pending += chunk;
				for (;;) {
					const newline = pending.indexOf("\n");
					if (newline < 0) break;
					const line = pending.slice(0, newline);
					pending = pending.slice(newline + 1);
					try { onLine(line.endsWith("\r") ? line.slice(0, -1) : line); }
					catch (error) { stream.destroy(error instanceof Error ? error : new Error(String(error))); return; }
				}
			});
			await drained;
			if (pending) onLine?.(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
		};
		const stdout = readText(child.stdout, chunk => { partialStdout += chunk; }, line => {
			const prefix = "OMP_KIT_STAGE_START name=";
			if (line.startsWith(prefix)) {
				const name = line.slice(prefix.length);
				if (!name || name.includes(" ")) return;
				inFlight = { name, started_at: performance.now(), started_at_ms: Date.now() };
				if (process.env.OMP_KIT_NATIVE_STAGE_PROGRESS === "1") {
					process.stderr.write(`OMP_KIT_STAGE_START name=${name} started_at_ms=${inFlight.started_at_ms}\n`);
				}
				return;
			}
			const completed = line.startsWith("GREEN ") ? line.slice(6)
				: line.startsWith("RED   ") ? line.slice(6).trimStart() : "";
			const name = completed.split(" ")[0];
			if (inFlight?.name === name) inFlight = null;
		});
		const stderr = readText(child.stderr, chunk => { partialStderr += chunk; });
		const drained = Promise.all([stdout, stderr]);
		let childExited = false;
		const exited = child.exited.then(code => { childExited = true; return code; });
		let cleanup: Promise<void> | undefined;
		const signal = (name: "SIGTERM" | "SIGKILL") => {
			// The detached group is created above, never discovered from other processes.
			try { process.kill(ownsGroup ? -child.pid : child.pid, name); } catch { /* already exited */ }
		};
		const stop = (): Promise<void> => cleanup ??= (async () => {
			// Match bunCapExec's existing TERM/escalation/drain bounds; no stage deadline is extended.
			signal("SIGTERM");
			await Bun.sleep(100);
			// A reaped leader can leave TERM-ignoring descendants holding the pipes.
			signal("SIGKILL");
			let timer: NodeJS.Timeout | undefined;
			try {
				await Promise.race([
					Promise.allSettled([exited, stdout, stderr]),
					new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
				]);
			} finally {
				clearTimeout(timer);
				for (const stream of streams) stream.destroy();
				// Never remove scratch beneath a child whose exit has not been observed.
				cleanupPrivateRoot = childExited;
			}
		})();
		const { promise: interrupted, reject: rejectInterrupted } = Promise.withResolvers<never>();
		const onTerm = () => rejectInterrupted(Object.assign(new Error("Isolated run interrupted by SIGTERM"), { code: "SIGTERM" }));
		const onInt = () => rejectInterrupted(Object.assign(new Error("Isolated run interrupted by SIGINT"), { code: "SIGINT" }));
		process.once("SIGTERM", onTerm);
		process.once("SIGINT", onInt);
		try {
			const code = await Promise.race([exited, drained.then(() => exited), interrupted]);
			if (ownsGroup) {
				let groupAlive = true;
				try { process.kill(-child.pid, 0); }
				catch (error) { groupAlive = !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
				if (groupAlive) await stop();
			}
			await Promise.race([drained, interrupted]);
			return { code, stdout: partialStdout, stderr: partialStderr, in_flight_stage: inFlight };
		} catch (error) {
			await stop();
			if (!cleanupPrivateRoot) partialStderr += "\nIsolated child exit unconfirmed; private runtime scratch retained.\n";
			throw new BundledRunInterruptedError(error, {
				code: 3, stdout: partialStdout, stderr: partialStderr, in_flight_stage: inFlight,
			});
		} finally {
			process.off("SIGTERM", onTerm);
			process.off("SIGINT", onInt);
		}
	} finally {
		if (cleanupPrivateRoot) rmSync(privateRoot, { recursive: true, force: true });
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
