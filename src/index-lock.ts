import { renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ScratchRunner } from "./scratch.ts";

/**
 * Guarded stale index.lock mover (ompkit-rz5.101).
 *
 * Predicate (all three, in order): the lock is EMPTY (a non-empty lock is
 * never touched — e.g. localbench's 71 KB interrupted write is a director
 * one-off, not kit-mover work); older than the configured age; lsof shows
 * no holder. Each move writes one receipt (returned; callers log it).
 *
 * Age threshold: read from configuration, never pinned. The mover reads
 * OMP_KIT_INDEX_LOCK_STALE_MS (positive integer milliseconds); the default
 * is 600000 (10 min). Derivation: legitimate index writes take seconds, so
 * 10 min sits orders above any single write; a queued commit hook can hold
 * longer (SUITE_VERDICT_WAIT default 7200 s), but a queued holder keeps the
 * lock visibly held, so the lsof gate — not the age — carries that safety.
 * Age exists to avoid racing a just-created lock against lsof TOCTOU.
 */
export const DEFAULT_INDEX_LOCK_STALE_MS = 600_000;

export function indexLockStaleAfterMs(env: Record<string, string | undefined> = process.env): number {
	const raw = env.OMP_KIT_INDEX_LOCK_STALE_MS;
	if (raw === undefined || raw.trim() === "") return DEFAULT_INDEX_LOCK_STALE_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_INDEX_LOCK_STALE_MS;
	return parsed;
}
export type LockVerdict =
	| "NOT_FOUND"
	| "NON_EMPTY"
	| "TOO_YOUNG"
	| "UNKNOWN"
	| "HELD"
	| "WOULD_MOVE"
	| "MOVED";
export interface LockMoveReceipt {
	lock: string;
	movedTo: string;
	sizeBytes: number;
	ageMs: number;
	staleAfterMs: number;
	atMs: string;
}

export interface LsofFileResult {
	/** true = rc 1 with empty output (clear); false = holders listed; null = unknown. */
	clear: boolean | null;
}

/**
 * Tri-state lsof for one file. ONLY rc 1 with empty stdout counts as clear.
 * rc 0 means matches were listed (held). Anything else — rc 2, signal or
 * timeout (code null), spawn failure, unparseable output, lsof errors — is
 * UNKNOWN and the lock stays untouched.
 */
export function lsofFileClear(path: string, run: ScratchRunner, timeoutMs = 15000): boolean | null {
	let out;
	try {
		out = run(["lsof", path], { timeoutMs });
	} catch {
		return null;
	}
	if (out.code === null) return null;
	const text = `${out.stdout}\n${out.stderr}`;
	if (/command not found/i.test(text) || /lsof:.*(not found|No such file)/i.test(text)) return null;
	if (/^lsof:/m.test(text)) return null;
	if (out.code === 1 && out.stdout.trim() === "") return true;
	if (out.code === 0) return false;
	return null;
}

export interface MoveDeps {
	run: ScratchRunner;
	nowMs?: () => number;
	lsofTimeoutMs?: number;
	dryRun?: boolean;
}

/** Move a stale holder-less empty index.lock aside; never touches anything else. */
export function maybeMoveStaleIndexLock(
	gitDir: string,
	deps: MoveDeps,
): { verdict: LockVerdict; receipt?: LockMoveReceipt } {
	const lock = join(gitDir, "index.lock");
	let stat;
	try {
		stat = statSync(lock);
	} catch {
		return { verdict: "NOT_FOUND" };
	}
	if (!stat.isFile() || stat.size !== 0) return { verdict: "NON_EMPTY" };
	const now = deps.nowMs ? deps.nowMs() : Date.now();
	const staleAfter = deps.staleAfterMs ?? DEFAULT_INDEX_LOCK_STALE_MS;
	if (now - stat.mtimeMs < staleAfter) return { verdict: "TOO_YOUNG" };
	const clear = lsofFileClear(lock, deps.run, deps.lsofTimeoutMs ?? 15000);
	if (clear === null) return { verdict: "UNKNOWN" };
	if (!clear) return { verdict: "HELD" };
	const movedTo = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
	if (deps.dryRun === true) return { verdict: "WOULD_MOVE", receipt: { lock, movedTo, sizeBytes: 0,
		ageMs: now - stat.mtimeMs, staleAfterMs: staleAfter, atMs: new Date(now).toISOString() } };
	renameSync(lock, movedTo);
	return {
		verdict: "MOVED",
		receipt: {
			lock,
			movedTo,
			sizeBytes: 0,
			ageMs: now - stat.mtimeMs,
			staleAfterMs: staleAfter,
			atMs: new Date(now).toISOString(),
		},
	};
}
