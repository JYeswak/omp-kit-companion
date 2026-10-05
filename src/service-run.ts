import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGate } from "./infra.ts";

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

export const LOAD_GATE_FACTOR = 2.5;
export const SKIPPED_LOAD_EXIT = 4;

export type RunLoadGate =
	| { proceed: true }
	| { proceed: false; status: "SKIPPED-LOAD"; exit: number; detail: string };

/**
 * SVC1 load gate: a service run starts only when the 1-minute load is at or
 * under 2.5x cores. Binds the contract's threshold (distinct from TOOL1's
 * 1.5x ladder gate) and shapes the skip verdict the run handler reports.
 */
export function gateRunLoad(load1: number, ncpu: number): RunLoadGate {
	const gate = loadGate(load1, ncpu, LOAD_GATE_FACTOR);
	if (gate.ok) return { proceed: true };
	return { proceed: false, status: "SKIPPED-LOAD", exit: SKIPPED_LOAD_EXIT,
		detail: `SKIPPED-LOAD: ${gate.reason} No work was done; retry when quiet.` };
}

export interface SpawnHandle {
	readonly pid: number | null;
	wait(): Promise<{ code: number | null; out: string }>;
	kill(): void;
}

export interface CapExec {
	spawn(argv: readonly string[], opts: { cwd: string; env: Record<string, string> }): SpawnHandle;
	sleep(ms: number): Promise<void>;
	now(): number;
}

export type CappedRun =
	| { status: "OK"; exit: number; elapsedMs: number; out: string }
	| { status: "FAILED"; exit: number | null; elapsedMs: number; out: string }
	| { status: "TIMEOUT"; exit: null; elapsedMs: number; out: string };

/**
 * SVC1 time cap: run argv to completion or SIGKILL it at capMs. A run that
 * outlives the cap is TIMEOUT (never OK/FAILED); elapsed time is measured on
 * the injected clock so tests are deterministic. Output travels with the
 * wait result so receipts can quote the tail.
 */
export async function runWithCap(input: {
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	capMs: number;
	exec: CapExec;
}): Promise<CappedRun> {
	const started = input.exec.now();
	const handle = input.exec.spawn(input.argv, { cwd: input.cwd, env: input.env });
	const outcome = await Promise.race([
		handle.wait().then(result => ({ kind: "done" as const, code: result.code, out: result.out })),
		input.exec.sleep(input.capMs).then(() => ({ kind: "timeout" as const, code: null as number | null, out: "" })),
	]);
	const elapsedMs = input.exec.now() - started;
	if (outcome.kind === "timeout") {
		handle.kill();
		const killed = await handle.wait();
		return { status: "TIMEOUT", exit: null, elapsedMs, out: killed.out };
	}
	if (outcome.code === 0) return { status: "OK", exit: 0, elapsedMs, out: outcome.out };
	return { status: "FAILED", exit: outcome.code, elapsedMs, out: outcome.out };
}

/** Live timers + SIGKILL for service run wiring (Bun runtime only). */
export function bunCapExec(): CapExec {
	return {
		spawn: (argv, opts) => {
			const child = Bun.spawn([...argv], { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
			return {
				pid: child.pid,
				wait: async () => {
					const code = await child.exited;
					let out = "";
					try {
						out = await new Response(child.stdout).text();
					} catch { /* killed pipes disturb the body; output is lost, verdict stands */ }
					let err = "";
					try {
						err = await new Response(child.stderr).text();
					} catch { /* same */ }
					return { code, out: `${out}\n${err}` };
				},
				kill: () => {
					try {
						child.kill(9);
					} catch { /* already gone is fine */ }
				},
			};
		},
		sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		now: () => Date.now(),
	};
}
