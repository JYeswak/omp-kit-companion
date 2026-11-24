// Synchronous Board reservation access for the sync land/fleet-guard paths (bead ompkit-tnqyr.3).
// The Board adapter is async (fetch) and these callers are not, so each call runs the kit's own `reservations`,
// `reserve` or `release` verb as a bounded child. The same argv works from source (`bun src/cli.ts`) and from the
// compiled binary, which is its own entrypoint.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../kitlib/run.ts";
import type { Hold } from "./board-reservations.ts";

export type BoardHoldsRead =
	| { ok: true; holds: Hold[] }
	| { ok: false; code: "BOARD_UNREACHABLE" | "BOARD_TIMEOUT"; why: string; snapshot_age_s: number | null };

/** The command that starts this kit: `bun <cli.ts>` from source, the binary itself once compiled. */
function kitArgv(): string[] {
	const here = fileURLToPath(import.meta.url);
	return here.endsWith(".ts") && !here.includes("$bunfs") ? [process.execPath, resolve(dirname(here), "..", "cli.ts")] : [process.execPath];
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	return { ...env, ...extra };
}

type Envelope = { data?: Record<string, unknown>; errors?: { code?: string; message?: string }[] };

function runVerb(args: string[], repo: string, deadlineS: number, extra: Record<string, string> = {}): { timedOut: boolean; envelope: Envelope | null } {
	const run = runSync([...kitArgv(), ...args, "--project", repo, "--json"], { cwd: repo, env: childEnv(extra), deadline_s: deadlineS, max_output_bytes: 2 * 1024 * 1024 });
	if (run.timed_out || run.killed) return { timedOut: true, envelope: null };
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(run.stdout));
		return { timedOut: false, envelope: parsed !== null && typeof parsed === "object" ? parsed : null };
	} catch {
		return { timedOut: false, envelope: null };
	}
}

/** Attested read of the project's open holds. Never admits from a snapshot; reports its age on failure. */
export function readBoardHoldsSync(repo: string, deadlineS = 30): BoardHoldsRead {
	const { timedOut, envelope } = runVerb(["reservations"], repo, deadlineS);
	if (timedOut) return { ok: false, code: "BOARD_TIMEOUT", why: `the Board did not answer within ${deadlineS} s`, snapshot_age_s: null };
	const holds = envelope?.data?.holds;
	if (Array.isArray(holds) && !envelope?.errors?.length) return { ok: true, holds: holds as Hold[] };
	const age = envelope?.data?.snapshot_age_s;
	return { ok: false, code: "BOARD_UNREACHABLE", why: envelope?.errors?.[0]?.message ?? "the kit reservations verb produced no answer", snapshot_age_s: typeof age === "number" ? age : null };
}

/** Reserve (exclusive, one hour) paths as `seat`; `conflicts` names holds that refused it. */
export function reserveBoardSync(repo: string, seat: string, paths: readonly string[], reason: string, deadlineS = 30): { ok: boolean; why: string; conflicts: Hold[] } {
	if (paths.some((path) => /\s/.test(path))) return { ok: false, why: "a path contains whitespace, which the reserve verb cannot carry", conflicts: [] };
	const { timedOut, envelope } = runVerb(["reserve", ...paths, "--reason", reason], repo, deadlineS, { AGENT_NAME: seat });
	if (timedOut) return { ok: false, why: `the Board did not answer within ${deadlineS} s`, conflicts: [] };
	const conflicts = envelope?.data?.conflicts;
	const failure = envelope?.errors?.[0];
	return { ok: envelope !== null && failure === undefined, why: failure?.message ?? (envelope === null ? "the kit reserve verb produced no answer" : ""), conflicts: Array.isArray(conflicts) ? conflicts as Hold[] : [] };
}

export function releaseBoardSync(repo: string, seat: string, paths: readonly string[], deadlineS = 30): void {
	runVerb(["release", ...(paths.length ? paths : ["--all"])], repo, deadlineS, { AGENT_NAME: seat });
}
