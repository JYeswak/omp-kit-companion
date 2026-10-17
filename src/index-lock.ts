import { closeSync, openSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ScratchRunner } from "./scratch.ts";

/**
 * Guarded stale index.lock dry-run reporter (ompkit-rz5.101).
 *
 * Predicate (all three, in order): the lock is EMPTY (a non-empty lock is
 * never touched — e.g. localbench's 71 KB interrupted write is a director
 * one-off, not kit-mover work); older than the configured age; lsof shows
 * no holder. A dry-run returns a receipt and never renames the lock.
 *
 * Age threshold: read from configuration, never pinned. The reporter reads
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
	| "APPLY_REFUSED"
	| "HELD"
	| "WOULD_MOVE"
	| "CHANGED"
	| "BUSY";
export interface LockMoveReceipt {
	lock: string;
	movedTo: string;
	guardPath: string;
	dev: number;
	ino: number;
	sizeBytes: number;
	mtimeMs: number;
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

/**
 * Stale Git index-lock handling is dry-run-only. The final-stat-to-rename
 * syscall window is nonzero; a link-back cannot restore writer exclusion if
 * another process takes the lock name, so no apply path exists.
 */
export function maybeMoveStaleIndexLock(
	gitDir: string,
	deps: MoveDeps,
): { verdict: LockVerdict; receipt?: LockMoveReceipt } {
	if (deps.dryRun !== true) return { verdict: "APPLY_REFUSED" };
	let repoGitDir: string;
	try {
		repoGitDir = realpathSync(gitDir);
	} catch {
		return { verdict: "UNKNOWN" };
	}
	const lock = join(repoGitDir, "index.lock");
	const guardPath = join(repoGitDir, ".omp-kit-index-lock-mover");
	let guardFd: number;
	try {
		guardFd = openSync(guardPath, "wx", 0o600);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
			return { verdict: "BUSY" };
		}
		return { verdict: "UNKNOWN" };
	}

	let result: { verdict: LockVerdict; receipt?: LockMoveReceipt };
	try {
		result = (() => {
			let stat;
			try {
				stat = statSync(lock);
			} catch {
				return { verdict: "NOT_FOUND" as const };
			}
			if (!stat.isFile() || stat.size !== 0) return { verdict: "NON_EMPTY" as const };
			const now = deps.nowMs ? deps.nowMs() : Date.now();
			const staleAfter = deps.staleAfterMs ?? DEFAULT_INDEX_LOCK_STALE_MS;
			if (now - stat.mtimeMs < staleAfter) return { verdict: "TOO_YOUNG" as const };
			const clear = lsofFileClear(lock, deps.run, deps.lsofTimeoutMs ?? 15000);
			if (clear === null) return { verdict: "UNKNOWN" as const };
			if (!clear) return { verdict: "HELD" as const };
			let current;
			try {
				current = statSync(lock);
			} catch {
				return { verdict: "CHANGED" as const };
			}
			if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino
				|| current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) return { verdict: "CHANGED" as const };
			const movedTo = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
			const observation: LockMoveReceipt = {
				lock, movedTo, guardPath, dev: stat.dev, ino: stat.ino, sizeBytes: stat.size,
				mtimeMs: stat.mtimeMs, ageMs: now - stat.mtimeMs, staleAfterMs: staleAfter,
				atMs: new Date(now).toISOString(),
			};
			return { verdict: "WOULD_MOVE" as const, receipt: observation };
		})();
	} catch {
		result = { verdict: "UNKNOWN" };
	}

	let cleanupFailed = false;
	try {
		closeSync(guardFd);
	} catch {
		cleanupFailed = true;
	}
	try {
		unlinkSync(guardPath);
	} catch {
		cleanupFailed = true;
	}
	if (cleanupFailed) return result.receipt ? { verdict: "UNKNOWN", receipt: result.receipt } : { verdict: "UNKNOWN" };
	return result;
}
