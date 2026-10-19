/** CC15 custody verb (bead ompkit-fp72.120.16.2.1): `omp-kit custody check` as an optional
 * fleet adapter over the omp-kit checkout's scripts/cc/custody.py.
 *
 * The verb never reimplements custody logic: it resolves the fleet checkout (env
 * OMP_KIT_FLEET_ROOT, else the omp-kit checkout path recorded in fleet-watch.json),
 * requires scripts/cc/custody.py to be a regular file owned by the caller, and runs
 * `python3 custody.py ...` with argv passed as an array (no shell) under a 30 s
 * timeout. Custody's exit code (0/10/11/2/3) is preserved exactly into CliResult.code
 * (renderOutput passes it through unchanged), and stdout JSON becomes the result data.
 *
 * One PATH per call: the kit grammar allows a command at most one positional
 * (send excepted, hardcoded in cli.ts parse). The moot-share denominator counts
 * calls, so multi-path checks are separate calls. A multi-path grammar would need a
 * cli.ts parse special-case owned by the cli.ts holder.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";

export const CUSTODY_SCHEMA = "omp-kit.custody.v1";
export const CUSTODY_PROBE_TIMEOUT_MS = 30_000;
const CUSTODY_SCRIPT_SUFFIX = ["scripts", "cc", "custody.py"] as const;

/** Test seam: OMP_KIT_CUSTODY_TIMEOUT_MS overrides the 30 s probe timeout (positive int, ms). */
export function custodyProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.OMP_KIT_CUSTODY_TIMEOUT_MS;
	if (raw === undefined || raw === "") return CUSTODY_PROBE_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) return CUSTODY_PROBE_TIMEOUT_MS;
	return parsed;
}

function homeDir(env: NodeJS.ProcessEnv): string | null {
	const home = env.HOME;
	return typeof home === "string" && home ? home : null;
}

/** Candidate omp-kit checkout roots: OMP_KIT_FLEET_ROOT first, then session repos in fleet-watch.json. */
export function custodyCandidateRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	const roots: string[] = [];
	const fleetRoot = env.OMP_KIT_FLEET_ROOT;
	if (typeof fleetRoot === "string" && fleetRoot) roots.push(fleetRoot);
	const home = homeDir(env);
	const configPath = typeof env.OMP_KIT_FLEET_WATCH_CONFIG === "string" && env.OMP_KIT_FLEET_WATCH_CONFIG
		? env.OMP_KIT_FLEET_WATCH_CONFIG
		: home ? join(home, ".config", "omp-kit", "fleet-watch.json") : null;
	if (configPath) {
		try {
			const doc: unknown = JSON.parse(readFileSync(configPath, "utf8"));
			const sessions = typeof doc === "object" && doc !== null && "sessions" in doc
				? (doc as { sessions: unknown }).sessions : undefined;
			if (Array.isArray(sessions)) {
				for (const session of sessions) {
					if (typeof session === "object" && session !== null && "repo" in session
						&& typeof (session as { repo: unknown }).repo === "string") {
						roots.push((session as { repo: string }).repo);
					}
				}
			}
		} catch {
			/* absent or unreadable config: adapter stays absent, never a crash */
		}
	}
	return roots;
}

/** The adapter script, or null when absent: no candidate root holds a user-owned regular custody.py. */
export function resolveCustodyScript(env: NodeJS.ProcessEnv = process.env): string | null {
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	for (const root of custodyCandidateRoots(env)) {
		const script = join(root, ...CUSTODY_SCRIPT_SUFFIX);
		try {
			const stat = lstatSync(script);
			if (!stat.isFile()) continue;
			if (uid !== null && stat.uid !== uid) continue;
			return script;
		} catch {
			continue;
		}
	}
	return null;
}

export type CustodySpawn = { exitCode: number | null; stdout: string; stderr: string };

function defaultSpawn(script: string, argv: readonly string[], timeoutMs: number): CustodySpawn {
	// env is explicit: Bun.spawnSync does not pick up runtime process.env
	// mutations (AGENT_NAME fallback, test seams) through implicit inheritance.
	const child = Bun.spawnSync(["python3", script, ...argv],
		{ stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: { ...process.env } });
	return {
		exitCode: child.exitCode,
		stdout: child.stdout.toString(),
		stderr: child.stderr.toString(),
	};
}

function usageRefusal(message: string): CliResult {
	return { code: 2, data: { overall: "NOT_RUN", code: "USAGE" },
		errors: [{ code: "CUSTODY_USAGE", message, remediation: "Run omp-kit custody check --repo PATH [--agent NAME] [--reserve [--ttl SECONDS] [--reason TEXT]] PATH." }],
		verification: "NOT_RUN" };
}

function absentRefusal(): CliResult {
	return { code: 3, data: { overall: "UNAVAILABLE", code: "PROBE_FAILED" },
		errors: [{ code: "CUSTODY_ADAPTER_ABSENT",
			message: "No fleet checkout holds a user-owned scripts/cc/custody.py; no custody answer exists.",
			remediation: "Run on the fleet host with the omp-kit checkout present (OMP_KIT_FLEET_ROOT or fleet-watch.json); the shipped companion stays inert without it. Never treated as GRANTED." }],
		verification: "UNVERIFIED" };
}

const EXIT_CODE: Record<number, string> = {
	0: "GRANTED",
	10: "HELD",
	11: "DIRTY_UNOWNED",
	2: "USAGE",
	3: "PROBE_FAILED",
};

/** Run the adapter and map its answer to a CliResult; spawn is injectable in tests via options. */
export function runCustodyCheck(
	script: string,
	argv: readonly string[],
	options?: { spawn?: (script: string, argv: readonly string[], timeoutMs: number) => CustodySpawn; timeoutMs?: number },
): CliResult {
	const timeoutMs = options?.timeoutMs ?? custodyProbeTimeoutMs();
	let spawn: CustodySpawn;
	try {
		spawn = (options?.spawn ?? defaultSpawn)(script, argv, timeoutMs);
	} catch {
		return { code: 3, data: { overall: "UNAVAILABLE", code: "PROBE_FAILED" },
			errors: [{ code: "CUSTODY_SPAWN_FAILED", message: "The custody probe could not start; no answer was given.",
				remediation: "Ensure python3 runs on this host; nothing was permitted or reserved." }],
			verification: "UNVERIFIED" };
	}
	if (spawn.exitCode === null) {
		return { code: 3, data: { overall: "UNAVAILABLE", code: "PROBE_TIMEOUT" },
			errors: [{ code: "PROBE_TIMEOUT", message: `The custody probe exceeded ${timeoutMs} ms; no answer was given.`,
				remediation: "Retry the check; nothing was permitted or reserved." }],
			verification: "UNVERIFIED" };
	}
	const exit = spawn.exitCode;
	let doc: unknown = null;
	try {
		doc = JSON.parse(spawn.stdout);
	} catch {
		doc = null;
	}
	const known = exit === 0 || exit === 10 || exit === 11 || exit === 2 || exit === 3;
	if (!known || typeof doc !== "object" || doc === null) {
		return { code: 3, data: { overall: "UNAVAILABLE", code: "PROBE_FAILED", probe_exit: exit } ,
			errors: [{ code: "CUSTODY_PROBE_UNRECOGNIZED",
				message: `The custody probe answered exit ${exit} with ${doc === null ? "unparseable" : "unrecognized"} output; no answer was given.`,
				remediation: "Inspect the fleet checkout's custody.py; nothing was permitted or reserved." }],
			verification: "UNVERIFIED" };
	}
	const outcomeCode = EXIT_CODE[exit] ?? "PROBE_FAILED";
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(doc)) record[key] = value;
	const verification = exit === 0 || exit === 10 || exit === 11 ? "PERFORMED" as const : "UNVERIFIED" as const;
	if (exit === 2 || exit === 3) {
		const refusalCode = exit === 2 ? "CUSTODY_USAGE" : "CUSTODY_PROBE_FAILED";
		const detail = "detail" in record && typeof record.detail === "string" ? record.detail
			: "error" in record && typeof record.error === "string" ? record.error : null;
		return { code: exit, data: { ...record, code: outcomeCode },
			errors: [{ code: refusalCode,
				message: detail ?? `Custody refused the question (exit ${exit}); no path was permitted.`,
				remediation: "Fix the usage or the probe, then ask again; nothing was permitted or reserved." }],
			verification };
	}
	return { code: exit, data: { ...record, code: outcomeCode }, verification };
}

function flagValue(flags: ReadonlyMap<string, string | true>, name: string): string | null {
	const value = flags.get(name);
	return typeof value === "string" && value ? value : null;
}

/** `custody check --repo PATH [--agent NAME] [--reserve [--ttl SECONDS] [--reason TEXT]] PATH`. */
export function custodyCheckCommand(request: ParsedCommand): CliResult {
	const { flags } = request;
	const repo = flagValue(flags, "--repo");
	const target = request.argument?.trim() ?? "";
	if (!repo || !target) return usageRefusal(!repo ? "--repo PATH is required." : "One PATH positional is required.");
	const ttl = flagValue(flags, "--ttl");
	if (ttl !== null && !(ttl.length > 0 && [...ttl].every((char) => char >= "0" && char <= "9"))) return usageRefusal("--ttl needs a non-negative integer number of seconds.");
	const agent = flagValue(flags, "--agent");
	const reason = flagValue(flags, "--reason");
	const script = resolveCustodyScript();
	if (!script) return absentRefusal();
	const argv: string[] = ["--repo", repo];
	if (agent !== null) argv.push("--agent", agent);
	if (flags.has("--reserve")) argv.push("--reserve");
	if (ttl !== null) argv.push("--ttl", ttl);
	if (reason !== null) argv.push("--reason", reason);
	argv.push(target);
	return runCustodyCheck(script, argv);
}
