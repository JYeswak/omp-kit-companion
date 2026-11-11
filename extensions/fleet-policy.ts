import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { projectRoot } from "./kit-guard-optin";

export type FleetPolicyState =
	| { kind: "off"; root: string }
	| { kind: "on"; root: string; notice?: string }
	| { kind: "unavailable"; root: string; reason: string };

const POLICY_LIMIT = 16_384;
const runFile = promisify(execFile);
function isUnder(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Last verified `on` state per repository root; a failed re-verification inside the TTL
 * enforces the cached policy instead of refusing (the safe direction). */
const verifiedCache = new Map<string, { state: Extract<FleetPolicyState, { kind: "on" }>; at: number }>();
const VERIFIED_TTL_MS = 600_000;
/** Roots already warned while serving the cached policy; cleared on fresh verification. */
const staleWarned = new Set<string>();
/** Bounded delay before the single verification retry. */
const VERIFY_RETRY_DELAY_MS = 100;

/**
 * Why a git probe failed, for the `unavailable` reason only: the numeric exit status, the
 * errno name (e.g. ENOENT when git is missing), `killed` for a timeout, or `unknown`.
 * No paths, no output bytes.
 */
function probeCause(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		if (typeof error.code === "number") return `exit ${error.code}`;
		if (typeof error.code === "string") return error.code;
	}
	if (typeof error === "object" && error !== null && "killed" in error && error.killed === true) return "killed";
	return "unknown";
}

/** Repository-local opt-in only. Stock roots require no executable or filesystem mutation. */
export async function fleetPolicyState(cwd: string, seen: readonly string[] = []): Promise<FleetPolicyState> {
	let root = resolve(cwd);
	let reason = "repository path is unavailable";
	try {
		const physicalCwd = await realpath(root);
		root = projectRoot(physicalCwd);
		const directory = join(root, ".omp");
		const marker = join(directory, "fleet.json");
		reason = ".omp/fleet.json cannot be read safely";
		let directoryStat: Stats;
		try { directoryStat = await lstat(directory); }
		catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { kind: "off", root };
			throw error;
		}
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
			return { kind: "unavailable", root, reason: ".omp must be a real directory, not a symlink" };
		}
		let markerStat: Stats;
		try { markerStat = await lstat(marker); }
		catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { kind: "off", root };
			throw error;
		}
		if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > POLICY_LIMIT) {
			return { kind: "unavailable", root, reason: ".omp/fleet.json must be a regular, non-symlink file of at most 16384 bytes" };
		}
		const file = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		let contents: string;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > POLICY_LIMIT || stat.dev !== markerStat.dev || stat.ino !== markerStat.ino) {
				throw new Error("policy file changed");
			}
			const bytes = Buffer.alloc(stat.size + 1);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			if (bytesRead !== stat.size) throw new Error("policy file changed");
			contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
		} finally { await file.close(); }
		const currentDirectory = await lstat(directory);
		const currentMarker = await lstat(marker);
		if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino ||
			currentDirectory.isSymbolicLink() || currentMarker.isSymbolicLink() ||
			currentMarker.dev !== markerStat.dev || currentMarker.ino !== markerStat.ino) {
			throw new Error("policy path changed");
		}
		reason = '.omp/fleet.json must contain only an explicit boolean "enabled" field';
		const policy: unknown = JSON.parse(contents);
		if (typeof policy !== "object" || policy === null || Array.isArray(policy) ||
			!("enabled" in policy) || typeof policy.enabled !== "boolean" || Object.keys(policy).length !== 1) {
			return { kind: "unavailable", root, reason };
		}
		if (!policy.enabled) return { kind: "off", root };

		// Probe Git only after explicit opt-in. Inherited Git routing/config cannot select another root.
		// Git is the authority on repository boundaries: it understands `.git` files (ovnfs checkouts,
		// linked worktrees), symlinked gitdirs, and nested repositories, while the existsSync walk above
		// can stop at a boundary git does not honor (an empty `.git` directory). A call in such a
		// directory is judged under the nearest real repository's policy (APPLICSCRATCH1). A git
		// verification failure stays `unavailable`, except: one retry after a short bounded delay, and
		// the last verified policy inside its TTL (enforcing the last verified policy is the safe
		// direction). A boundary git rejects, or a git that cannot run at all with nothing verified,
		// keeps the refusal (a real hazard: the opt-in may be spoofed and nothing disproves it).
		reason = "explicit fleet opt-in cannot be verified against the nearest real Git repository";
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		Object.assign(env, {
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
			GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
		});
		let lastCause = "unknown";
		const probe = async (): Promise<string | null> => {
			try {
				const { stdout } = await runFile("git", ["--no-pager", "-c", "core.fsmonitor=false",
					"-c", "core.hooksPath=/dev/null", "-C", physicalCwd, "rev-parse", "--show-toplevel"],
					{ env, timeout: 1000, maxBuffer: POLICY_LIMIT, encoding: "utf8" });
				const reported = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
				if (!isAbsolute(reported)) { lastCause = "non-absolute top level"; return null; }
				try { return await realpath(reported); }
				catch { lastCause = "unreadable top level"; return null; }
			} catch (error) {
				lastCause = probeCause(error);
				return null;
			}
		};
		let real = await probe();
		if (real === null) {
			const { promise, resolve: wake } = Promise.withResolvers<void>();
			setTimeout(wake, VERIFY_RETRY_DELAY_MS);
			await promise;
			real = await probe();
		}
		if (real === null) {
			const cached = verifiedCache.get(root);
			if (cached !== undefined && Date.now() - cached.at <= VERIFIED_TTL_MS) {
				if (!staleWarned.has(root)) {
					staleWarned.add(root);
					console.warn(`fleet-guard: git verification failed at ${root}; enforcing last verified policy.`);
				}
				return { ...cached.state, notice: `fleet-guard: git verification failed; enforcing last verified policy for ${root}.` };
			}
			return { kind: "unavailable", root, reason: `${reason} (probe ${lastCause})` };
		}
		if (real === root) {
			const state = { kind: "on", root } as const;
			verifiedCache.set(root, { state, at: Date.now() });
			staleWarned.delete(root);
			return state;
		}
		if (!seen.includes(real) && (real === physicalCwd || isUnder(physicalCwd, real))) return fleetPolicyState(real, [...seen, root]);
		return { kind: "unavailable", root, reason };
	} catch {
		return { kind: "unavailable", root, reason };
	}
}
