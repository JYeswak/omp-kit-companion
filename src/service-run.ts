import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { loadGate } from "./infra.ts";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

/**
 * SVC1 single-flight: one running job per name. The second overlapping run
 * exits SKIPPED-OVERLAP (exit code below) instead of doubling the work.
 * Wiring (service run) maps OVERLAP to that verdict; this module owns the
 * lock mechanics only.
 */

export const OVERLAP_EXIT = 4;

export interface RunLock {
	release(): void;
}

export type AcquireResult =
	| { status: "ACQUIRED"; lock: RunLock }
	| { status: "OVERLAP"; holderPid: number | null; holderAgeMs: number | null };

export interface RunClaim {
	pid: number;
	startedAt: number;
	token: string;
}

/** Only ESRCH proves death. EPERM and every other failed probe are unknown. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH");
	}
}

function readClaim(dir: string): RunClaim | null {
	try {
		if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "pid")).isFile()) return null;
		const value: unknown = JSON.parse(readFileSync(join(dir, "pid"), "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)
			|| !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
			|| !("startedAt" in value) || typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt)
			|| !("token" in value) || typeof value.token !== "string" || value.token.length === 0) return null;
		return { pid: value.pid, startedAt: value.startedAt, token: value.token };
	} catch {
		return null;
	}
}

/**
 * A persistent SQLite inode supplies the kernel's cross-process writer lock.
 * No SQL state or schema: BEGIN EXCLUSIVE excludes readers before claim-file mutations.
 * Never unlink the gate, which would split existing and incoming waiters.
 */
function mutateClaim<T>(jobsDir: string, job: string, mutation: () => T): T | null {
	let fd: number | undefined;
	let db: Database | undefined;
	try {
		if (!lstatSync(jobsDir).isDirectory()) return null;
		const path = join(jobsDir, `${job}.gate.sqlite`);
		fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0
			|| (process.getuid !== undefined && opened.uid !== process.getuid())) return null;
		db = new Database(path);
		const current = lstatSync(path);
		if (current.dev !== opened.dev || current.ino !== opened.ino || !current.isFile()) return null;
		db.exec("PRAGMA busy_timeout = 0");
		db.exec("BEGIN EXCLUSIVE");
		const result = mutation();
		db.exec("COMMIT");
		return result;
	} catch {
		if (db?.inTransaction) {
			try { db.exec("ROLLBACK"); } catch { /* Claim effects are unknown, never permission to steal. */ }
		}
		return null;
	} finally {
		db?.close();
		if (fd !== undefined) closeSync(fd);
	}
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
 * Claim one job. Only a verified dead PID can be reclaimed; age is not death.
 * Missing, malformed and legacy claims remain OVERLAP until reconciled.
 */
export function acquireRunLock(jobsDir: string, job: string, nowMs: number = Date.now()): AcquireResult {
	const unknown: AcquireResult = { status: "OVERLAP", holderPid: null, holderAgeMs: null };
	if (!Number.isSafeInteger(nowMs)) return unknown;
	return mutateClaim(jobsDir, job, (): AcquireResult => {
		const dir = join(jobsDir, `${job}.lock`);
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch {
			const holder = readClaim(dir);
			if (holder === null) return unknown;
			if (pidAlive(holder.pid)) {
				return { status: "OVERLAP", holderPid: holder.pid, holderAgeMs: nowMs - holder.startedAt };
			}
			removeLock(dir);
			try { mkdirSync(dir, { mode: 0o700 }); } catch { return unknown; }
		}
		const owner = lstatSync(dir);
		const claim: RunClaim = { pid: process.pid, startedAt: nowMs, token: randomUUID() };
		try {
			writeFileSync(join(dir, "pid"), JSON.stringify(claim), { mode: 0o600, flag: "wx" });
		} catch {
			// Do not remove a claim that appeared without our exclusive creation.
			try { rmdirSync(dir); } catch { /* Unknown contents stay untouched. */ }
			return unknown;
		}
		let released = false;
		return { status: "ACQUIRED", lock: { release: () => {
			if (released) return;
			const result = mutateClaim(jobsDir, job, () => {
				const current = readClaim(dir);
				if (current === null || claimIncarnation(current) !== claimIncarnation(claim)) return true;
				const identity = lstatSync(dir);
				if (identity.dev !== owner.dev || identity.ino !== owner.ino) return true;
				removeLock(dir);
				return true;
			});
			if (result !== null) released = true;
		} } };
	}) ?? unknown;
}

/** Read the current claim for the gate/body and delegated-child admission checks. */
export function readRunClaim(jobsDir: string, job: string): RunClaim | null {
	return readClaim(join(jobsDir, `${job}.lock`));
}

/** Per-acquisition identity, not a wall-clock claim about kernel process birth. */
export function claimIncarnation(claim: RunClaim): string {
	return `${claim.pid}:${claim.startedAt}:${claim.token}`;
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

/**
 * Per-job run time caps (ms). Interval jobs cap below their cadence so a
 * hung run dies before the next scheduled start; one-shots get headroom.
 * Initial values; tune from receipts, never past the interval.
 */
export const RUN_TIME_CAPS_MS: Record<string, number> = {
	"omp-watch": 300_000,
	"scratch-reaper": 1_800_000,
	"kit-update": 600_000,
	"fleet-watch": 90_000,
	"fleet-lessons": 1_800_000,
	"load-watch": 45_000,
};

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
 * SVC1 finite-run cap: terminate the owned process group at capMs and bound
 * reaping/output cleanup. Injected executors retain deterministic clock tests;
 * the default executor owns all descendants which retain its POSIX group.
 */
export async function runWithCap(input: {
	argv: readonly string[];
	cwd: string;
	env: Record<string, string>;
	capMs: number;
	exec?: CapExec;
}): Promise<CappedRun> {
	const exec = input.exec ?? bunCapExec();
	const started = exec.now();
	const handle = exec.spawn(input.argv, { cwd: input.cwd, env: input.env });
	const outcome = await Promise.race([
		handle.wait().then(result => ({ kind: "done" as const, code: result.code, out: result.out })),
		exec.sleep(input.capMs).then(() => ({ kind: "timeout" as const, code: null as number | null, out: "" })),
	]);
	const elapsedMs = exec.now() - started;
	if (outcome.kind === "timeout") {
		handle.kill();
		const killed = await handle.wait();
		return { status: "TIMEOUT", exit: null, elapsedMs, out: killed.out };
	}
	if (outcome.code === 0) return { status: "OK", exit: 0, elapsedMs, out: outcome.out };
	return { status: "FAILED", exit: outcome.code, elapsedMs, out: outcome.out };
}

/**
 * Finite pipe-based jobs own a fresh POSIX group by default. Native PTYs and
 * long-lived service launchers have separate lifecycle owners, not this adapter.
 */
export function bunCapExec(): CapExec {
	return {
		spawn: (argv, opts) => {
			const ownsGroup = process.platform === "darwin" || process.platform === "linux";
			const child = Bun.spawn([...argv], { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe", detached: ownsGroup });
			const streams = [Readable.fromWeb(child.stdout), Readable.fromWeb(child.stderr)];
			const output = ["", ""];
			// Node's stream bridge drains both pipes immediately and destroy()
			// cancels their actual readers, including an outstanding read.
			const drained = Promise.all(streams.map((stream, index) => {
				stream.setEncoding("utf8").on("data", chunk => { output[index] += chunk; });
				return finished(stream).catch(() => { /* expected when cancellation destroys the pipe */ });
			}));
			let settled = false, cleanup: Promise<void> | undefined;
			const { promise: stopped, resolve: resolveStopped } = Promise.withResolvers<void>();
			const signal = (name: "SIGTERM" | "SIGKILL") => {
				// Only the group/PID created above; never a discovered peer.
				try { process.kill(ownsGroup ? -child.pid : child.pid, name); } catch { /* already exited */ }
			};
			const stop = (): Promise<void> => cleanup ??= (async () => {
				signal("SIGTERM");
				await Bun.sleep(100);
				// The leader exiting does not imply descendants released their
				// group or inherited FDs. Escalate even after child.exited.
				signal("SIGKILL");
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						Promise.all([child.exited, drained]),
						new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); }),
					]);
				} finally {
					clearTimeout(timer);
					for (const stream of streams) stream.destroy();
					resolveStopped();
				}
			})();
			const kill = () => { if (!settled) void stop(); };
			process.once("SIGTERM", kill);
			process.once("SIGINT", kill);
			const exited = child.exited.then(async code => {
				// A reaped leader can still leave descendants holding its group.
				if (ownsGroup && !cleanup && pidAlive(-child.pid)) await stop();
				return code;
			});
			const result = Promise.race([
				Promise.all([exited, drained]).then(([code]) => code),
				stopped.then(() => child.exitCode),
			]).then(async code => {
				// Even early EOF is not proof that a TERM-ignoring process
				// exited. Finish escalation before relinquishing group ownership.
				if (cleanup) await cleanup;
				settled = true;
				process.off("SIGTERM", kill);
				process.off("SIGINT", kill);
				return { code, out: `${output[0]}\n${output[1]}` };
			});
			return { pid: child.pid, wait: () => result, kill };
		},
		sleep: (ms) => new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			// A completed finite run must not be kept alive by its cap.
			timer.unref();
		}),
		now: () => Date.now(),
	};
}

export type JobOffSwitch = { disabled: true; reason: string | null } | { disabled: false };

/**
 * SVC1 off switch: a `<job>.off` marker beside the job state means no run and
 * no receipt. Any existing entry disables (fail toward no-run); a regular
 * file's trimmed content names the reason. The run handler checks this first.
 */
export function readJobOff(offPath: string): JobOffSwitch {
	let stat;
	try {
		stat = lstatSync(offPath);
	} catch {
		return { disabled: false };
	}
	if (!stat.isFile()) return { disabled: true, reason: null };
	let reason: string | null = null;
	try {
		const text = readFileSync(offPath, "utf8").trim();
		if (text.length > 0) reason = text.split("\n")[0] ?? null;
	} catch { /* unreadable file still disables; reason stays null */ }
	return { disabled: true, reason };
}
