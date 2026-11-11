import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createScratch, defaultBudgetLedgerPath, defaultLiveness, defaultRunner, parseOwnerFile, releaseScratch, type InspectDeps, type ScratchReleaseResult } from "../scratch.ts";

/**
 * The end of a session's own scratch dir (ompkit-774u.15). A seat dir is `bin=throwaway`, and its owner disposes
 * it at the act: when the session that recorded it ends, the dir is released into the throwaway bin (the reaper
 * deletes released dirs; the kit never deletes in-process). A respawn is not an end: respawn_seat writes a
 * pid-keyed respawn-intent marker before it signals the old omp, and the successor inherits the dir, so a marker
 * that matches this very process skips the release.
 */

/** Same file the chief skill's respawn_seat.py writes (INTENT_TTL_S there is 900; the row's own ttl_s is what counts). */
export function respawnIntentPath(pid: number, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
	const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
	return join(state, "omp-kit-orchestration", `respawn-intent.${pid}.json`);
}

const INTENT_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/**
 * True only when this pid's marker exists, names this pid AND this process start (pid reuse cannot borrow it),
 * is of kind respawn, and is younger than its ttl_s. Unreadable, malformed or future-dated is false.
 */
export function respawnIntentActive(pid: number, start: string | null, path: string, nowMs: number = Date.now()): boolean {
	if (start === null || start === "") return false;
	let row: unknown;
	try {
		row = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
	if (typeof row !== "object" || row === null) return false;
	const { pid: rowPid, start: rowStart, at, ttl_s: ttl, kind } = row as Record<string, unknown>;
	if (kind !== "respawn" || rowPid !== pid || rowStart !== start) return false;
	if (typeof at !== "string" || typeof ttl !== "number") return false;
	const parts = INTENT_TIME.exec(at);
	if (parts === null) return false;
	const atMs = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
	const ageMs = nowMs - atMs;
	return ageMs >= 0 && ageMs < ttl * 1000;
}

export interface SeatEndDeps {
	/** Start string of a pid as `ps -o lstart=` prints it; null when unreadable. */
	startOf(pid: number): string | null;
	release(dir: string, agent: string, session: string): ScratchReleaseResult;
	env?: Record<string, string | undefined>;
	home?: string;
	now?: number;
}

export interface SeatEndSeat { dir: string; agent: string | undefined; session: string | undefined }

export type SeatEndOutcome = "released" | "skipped-respawn" | "skipped-not-recorded" | "skipped-other-session" | `refused-${string}`;

/**
 * Dispose a session's own dir when that session ends. Only the session that recorded the seat (agent and session id)
 * ends it: a subagent's or an unrecorded session's end never touches the dir.
 */
export function endSeat(seat: SeatEndSeat, pid: number, endingSession: string | undefined, deps: SeatEndDeps): SeatEndOutcome {
	if (seat.agent === undefined || seat.session === undefined) return "skipped-not-recorded";
	if (endingSession !== seat.session) return "skipped-other-session";
	const path = respawnIntentPath(pid, deps.env, deps.home);
	if (respawnIntentActive(pid, deps.startOf(pid), path, deps.now)) return "skipped-respawn";
	const released = deps.release(seat.dir, seat.agent, seat.session);
	return released.ok ? "released" : `refused-${released.reason}`;
}

/** Real dependencies: ps for the start string, and the kit's own release with the seat identity the extension already knows. */
export function liveSeatEndDeps(home: string = homedir()): SeatEndDeps {
	const liveness = defaultLiveness();
	return {
		startOf: pid => liveness.processStart(pid),
		release: (dir, agent, session) => releaseScratch(dir, home, { liveness, run: defaultRunner,
			callerSeat: () => ({ agent, sessions: [session], main: session }) }, { bin: "throwaway" }),
		home,
	};
}

/** The seat dir label: `<repo>/var/agent-tmp/omp.<pid>`, the same spelling the guard always used. */
export const SEAT_SCRATCH_LABEL = "omp";

/** Test seam for the seat-dir creation; everything live unless a test plants a ledger or clock. */
export interface SeatScratchOpts { ledgerPath?: string; now?: number }

/** Either the owned seat dir, or the refusal reason that keeps today's blocks byte-identical. */
export type SeatScratchResult = { dir: string } | { refuse: string };

/**
+ * TMPREDIRECT1 (ompkit-1ra0d.178): the seat's session scratch comes from the kit's scratch
+ * ownership API (the same `createScratch` `omp-kit scratch new` uses), never an invented raw
+ * directory, so the reaper, the budget ledger and root registration all know about it. The owner
+ * starts pid-only (no seat identity until the first tool call names the agent and its omp session),
+ * exactly the lifecycle the hand-rolled writer had. A refusal fails closed: the caller keeps
+ * today's refusals with no session hint and no rewrite.
+ */
export function createSeatScratch(repo: string, opts: SeatScratchOpts = {}): SeatScratchResult {
	const liveness = defaultLiveness();
	const deps: InspectDeps = { liveness, run: defaultRunner,
		callerSeat: () => ({ agent: null, sessions: [], main: null }),
		...(opts.now !== undefined ? { now: opts.now } : {}) };
	const created = createScratch(SEAT_SCRATCH_LABEL, repo, deps, { bin: "throwaway" }, false,
		opts.ledgerPath ?? defaultBudgetLedgerPath());
	if (created.ok) return { dir: created.dir };
	if (created.reason !== "directory-create-failed") return { refuse: created.reason };
	// Same-process re-init: the dir is already ours when its owner names this incarnation.
	const dir = join(resolve(repo), "var", "agent-tmp", `${SEAT_SCRATCH_LABEL}.${process.pid}`);
	let text: string;
	try { text = readFileSync(join(dir, ".owner"), "utf8"); }
	catch { return { refuse: created.reason }; }
	const owner = parseOwnerFile(text);
	const start = liveness.processStart(process.pid);
	if (owner === null || owner.pid !== process.pid || owner.processStart === null || start === null || owner.processStart !== start)
		return { refuse: created.reason };
	return { dir };
}

/**
+ * Record the seat on its own dir at the first tool call (agent and omp session together, once):
+ * appends to the creation-time owner, preserving its capability, budget and process identity, and
+ * refuses (leaving the pid-only owner valid) when the seat is already recorded or the pair is not
+ * a well-formed owner. Never replaces a recorded seat: a later subagent session keeps the first.
+ */
export function recordSeatOwner(dir: string, agent: string, session: string): boolean {
	let text: string;
	try { text = readFileSync(join(dir, ".owner"), "utf8"); }
	catch { return false; }
	const owner = parseOwnerFile(text);
	if (owner === null || owner.agent !== null || owner.session !== null) return false;
	const next = `${text.endsWith("\n") ? text : `${text}\n`}agent=${agent}\nsession=${session}\n`;
	if (parseOwnerFile(next) === null) return false;
	const tmp = join(dir, `.owner.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, next, { mode: 0o600 });
		renameSync(tmp, join(dir, ".owner"));
	} catch {
		try { rmSync(tmp, { force: true }); } catch { /* the pid-only owner stays valid */ }
		return false;
	}
	return true;
}
