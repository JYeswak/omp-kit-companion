import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { projectRoot } from "./kit-guard-optin";

export type FleetPolicyState =
	| { kind: "off"; root: string }
	| { kind: "on"; root: string }
	| { kind: "unavailable"; root: string; reason: string };

const POLICY_LIMIT = 16_384;
const runFile = promisify(execFile);

/** Repository-local opt-in only. Stock roots require no executable or filesystem mutation. */
export async function fleetPolicyState(cwd: string): Promise<FleetPolicyState> {
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
		reason = "explicit fleet opt-in cannot be verified against the nearest real Git repository";
		const env = { ...process.env };
		for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
		Object.assign(env, {
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
			GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
		});
		const { stdout } = await runFile("git", ["--no-pager", "-c", "core.fsmonitor=false",
			"-c", "core.hooksPath=/dev/null", "-C", physicalCwd, "rev-parse", "--show-toplevel"],
			{ env, timeout: 1000, maxBuffer: POLICY_LIMIT, encoding: "utf8" });
		const reported = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
		if (!isAbsolute(reported) || await realpath(reported) !== root) return { kind: "unavailable", root, reason };
		return { kind: "on", root };
	} catch {
		return { kind: "unavailable", root, reason };
	}
}
