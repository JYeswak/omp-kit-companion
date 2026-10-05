import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SVC1 single-flight: one running job per name. The second overlapping run
 * exits SKIPPED-OVERLAP (exit code below) instead of doubling the work.
 * Wiring (service run) maps OVERLAP to that verdict; this module owns the
 * lock mechanics only.
 */

export const OVERLAP_EXIT = 4;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export interface RunLock {
	release(): void;
}

export type AcquireResult =
	| { status: "ACQUIRED"; lock: RunLock }
	| { status: "OVERLAP"; holderPid: number | null; holderAgeMs: number | null };

interface LockClaim {
	pid: number;
	startedAt: number;
}

const EMPTY_DIR_GRACE_MS = 60 * 1000;

/** A lock dir with no readable claim is dead only once it is older than the grace window. */
function emptyDirIsStale(dir: string, nowMs: number): boolean {
	try {
		const age = nowMs - statSync(dir).mtimeMs;
		return age > EMPTY_DIR_GRACE_MS;
	} catch {
		return false;
	}
}
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readClaim(dir: string, nowMs: number): (LockClaim & { stale: boolean }) | null {
	let raw: string;
	try {
		raw = readFileSync(join(dir, "pid"), "utf8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (typeof record["pid"] !== "number" || typeof record["startedAt"] !== "number") return null;
	const claim: LockClaim = { pid: record["pid"] as number, startedAt: record["startedAt"] as number };
	const stale = !pidAlive(claim.pid) || nowMs - claim.startedAt > LOCK_STALE_MS;
	return { ...claim, stale };
}

function removeLock(dir: string): void {
	try {
		unlinkSync(join(dir, "pid"));
	} catch { /* already gone is fine */ }
	try {
		rmdirSync(dir);
	} catch { /* left for the reaper; never throw on release paths */ }
}

/**
 * Claim the single-flight lock for a job. Pure filesystem + PID liveness:
 * no daemons, no ports. Stale (dead PID or older than the backstop) locks
 * are broken; anything unverifiable stays OVERLAP (fail closed).
 */
export function acquireRunLock(jobsDir: string, job: string, nowMs: number = Date.now()): AcquireResult {
	const dir = join(jobsDir, `${job}.lock`);
	let claimed = false;
	for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
		try {
			mkdirSync(dir, { recursive: false, mode: 0o700 });
			claimed = true;
		} catch {
			const claim = readClaim(dir, nowMs);
			if (claim !== null && !claim.stale) {
				return { status: "OVERLAP", holderPid: claim.pid, holderAgeMs: nowMs - claim.startedAt };
			}
			if (claim === null && !emptyDirIsStale(dir, nowMs)) {
				return { status: "OVERLAP", holderPid: null, holderAgeMs: null };
			}
			removeLock(dir);
		}
	}
	if (!claimed) return { status: "OVERLAP", holderPid: null, holderAgeMs: null };
	try {
		writeFileSync(join(dir, "pid"), JSON.stringify({ pid: process.pid, startedAt: nowMs }), { mode: 0o600 });
	} catch {
		removeLock(dir);
		return { status: "OVERLAP", holderPid: null, holderAgeMs: null };
	}
	let released = false;
	return { status: "ACQUIRED", lock: { release: () => {
		if (released) return;
		released = true;
		removeLock(dir);
	} } };
}

/** Stable lock for tests and scripts that manage the lifecycle by hand. */
export function forgeLockForTest(jobsDir: string, job: string, pid: number, startedAt: number): void {
	const dir = join(jobsDir, `${job}.lock`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, "pid"), JSON.stringify({ pid, startedAt }), { mode: 0o600 });
}
