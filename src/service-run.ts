import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { loadGate } from "./infra.ts";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { isDead, normalizeStart } from "./kitlib/proc.ts";
import { ownerIdentity, ownerLiveness } from "./kitlib/owner.ts";

/**
 * SVC1 single-flight: one running job per name. The second overlapping run
 * exits SKIPPED-OVERLAP (exit code below) instead of doubling the work.
 * Wiring (service run) maps OVERLAP to that verdict; this module owns the
 * lock mechanics only.
 */

export const OVERLAP_EXIT = 4;
/**
 * CC14 daemon one-instance lock. A daemon (`service run cc`) holds an open
 * SQLite IMMEDIATE transaction on `<jobs>/<name>.lock` for its whole life;
 * the kernel releases the file lock with the fd on death (even SIGKILL), so
 * no stale lock can strand the next start. A second concurrent holder gets
 * HELD, which the run wiring maps to exit 75 ALREADY_RUNNING. Fail-closed:
 * any unusable directory, unsafe file, or busy database is HELD, never a
 * grant. This module owns the lock mechanics only.
 */
export const DAEMON_HELD_EXIT = 75;
export type DaemonAcquire = { status: "ACQUIRED"; lock: RunLock } | { status: "HELD" };
const DAEMON_JOB_PATTERN = /^[A-Za-z0-9._-]+$/;
export function acquireDaemonLock(jobsDir: string, job: string): DaemonAcquire {
	if (!DAEMON_JOB_PATTERN.test(job) || job === "." || job === "..") return { status: "HELD" };
	try {
		mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
	} catch {
		return { status: "HELD" };
	}
	const path = join(jobsDir, `${job}.lock`);
	let fd: number | undefined;
	let db: Database | undefined;
	try {
		fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0
			|| (process.getuid !== undefined && opened.uid !== process.getuid())) return { status: "HELD" };
		db = new Database(path);
		db.exec("PRAGMA busy_timeout = 0");
		try {
			db.exec("BEGIN IMMEDIATE");
		} catch {
			try { db.close(); } catch { /* A failed BEGIN holds nothing; close the handle. */ }
			db = undefined;
			return { status: "HELD" };
		}
	} catch {
		if (db !== undefined) {
			try { db.close(); } catch { /* Best effort; the failed handle holds no lock. */ }
			db = undefined;
		}
		return { status: "HELD" };
	} finally {
		// The pre-lock fd verified identity only; the Database connection
		// holds the live lock from here on.
		if (fd !== undefined) closeSync(fd);
	}
	if (db === undefined) return { status: "HELD" };
	const held = db;
	let released = false;
	return { status: "ACQUIRED", lock: { release: () => {
		if (released) return;
		released = true;
		try { held.exec("ROLLBACK"); } catch { /* Lock effects are unknown, never permission to steal. */ }
		try { held.close(); } catch { /* Close failure leaves the fd to process exit. */ }
	} } };
}

export interface RunLock {
	release(): void;
}

export type AcquireResult =
	| { status: "ACQUIRED"; lock: RunLock }
	| { status: "OVERLAP"; holderPid: number | null; holderAgeMs: number | null };

export interface RunClaim {
	pid: number;
	process_start: string;
	startedAt: number;
	token: string;
}

function readClaim(dir: string): RunClaim | null {
	try {
		if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, "pid")).isFile()) return null;
		const value: unknown = JSON.parse(readFileSync(join(dir, "pid"), "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)
			|| !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid < 1
			|| !("process_start" in value) || typeof value.process_start !== "string" || normalizeStart(value.process_start) === ""
			|| !("startedAt" in value) || typeof value.startedAt !== "number" || !Number.isSafeInteger(value.startedAt)
			|| !("token" in value) || typeof value.token !== "string" || value.token.length === 0) return null;
		return { pid: value.pid, process_start: normalizeStart(value.process_start), startedAt: value.startedAt, token: value.token };
	} catch {
		return null;
	}
}

/**
 * A persistent SQLite inode supplies the kernel's cross-process writer lock.
 * No SQL state or schema: reserve the single writer, then ROLLBACK only to release it.
 * COMMIT can fail behind readers after filesystem effects; readers need not block this mutex.
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
		db.exec("BEGIN IMMEDIATE");
		const result = mutation();
		db.exec("ROLLBACK");
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
 * Claim one job. Only a dead, reused or zombie process incarnation can be reclaimed; unknown and legacy claims stay
 * overlapped. Age is metadata, not death.
 */
export function acquireRunLock(jobsDir: string, job: string, nowMs: number = Date.now()): AcquireResult {
	const unknown: AcquireResult = { status: "OVERLAP", holderPid: null, holderAgeMs: null };
	if (!Number.isSafeInteger(nowMs)) return unknown;
	const ownerIncarnation = ownerIdentity(process.pid);
	if (ownerIncarnation === null) return unknown;
	return mutateClaim(jobsDir, job, (): AcquireResult => {
		const dir = join(jobsDir, `${job}.lock`);
		try {
			mkdirSync(dir, { mode: 0o700 });
		} catch {
			const holder = readClaim(dir);
			if (holder === null) return unknown;
			const dead = isDead(ownerLiveness({ pid: holder.pid, process_start: holder.process_start }));
			if (!dead) return { status: "OVERLAP", holderPid: holder.pid, holderAgeMs: nowMs - holder.startedAt };
			removeLock(dir);
			try { mkdirSync(dir, { mode: 0o700 }); } catch { return unknown; }
		}
		const owner = lstatSync(dir);
		const claim: RunClaim = { pid: ownerIncarnation.pid, process_start: ownerIncarnation.process_start, startedAt: nowMs, token: randomUUID() };
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

/** Claim binding used by delegated consumers: token plus the exact process incarnation and admission timestamp. */
export function claimIncarnation(claim: RunClaim): string {
	return `${claim.pid}:${claim.process_start}:${claim.startedAt}:${claim.token}`;
}

export interface ServiceLauncherMember {
	pid: number;
	command: string;
}

export type ServiceLauncherObservation =
	| { launchers: ServiceLauncherMember[] }
	| { failure: string };

/**
 * ompkit-bj08.5 [d]: observe the live launchers of one service job — every
 * process whose argv runs `service run <job>` — through a `ps` snapshot.
 * Exact-token match on the three argv tokens (never substring: `fleet-watch`
 * must not match `fleet-watcher`, per the OMP_TOKEN lesson in services.ts),
 * so job names with regex metacharacters need no escaping. Observed rows
 * are normalized to `service run <job>` for the keeper comparison; a live
 * second launcher shares the command but not the keeper pid, so the
 * admission's excess check fires. ps lines are capped at 4096 chars and
 * unparseable rows are skipped, never assumed. Failure is explicit (the
 * caller must fail closed: an unobservable launcher set confirms
 * nothing). Never throws.
 */
export function observeServiceLaunchers(run: (args: readonly string[]) => { code: number; stdout: string }, job: string): ServiceLauncherObservation {
	let stdout: string;
	try {
		const result = run(["ps", "-axo", "pid=,args="]);
		if (result.code !== 0) return { failure: `ps exited ${result.code}: launcher set unobservable` };
		stdout = result.stdout;
	} catch (error) {
		return { failure: `ps probe threw: ${error instanceof Error ? error.message : String(error)}` };
	}
	const command = `service run ${job}`;
	const launchers: ServiceLauncherMember[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.length > 4096 ? raw.slice(0, 4096) : raw;
		const tokens = line.trim().split(/\s+/);
		if (tokens.length < 4) continue;
		const pid = Number(tokens[0]);
		if (!Number.isSafeInteger(pid)) continue;
		for (let i = 1; i + 2 < tokens.length; i++) {
			if (tokens[i] === "service" && tokens[i + 1] === "run" && tokens[i + 2] === job) {
				launchers.push({ pid, command });
				break;
			}
		}
	}
	return { launchers };
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
	"gate-rationalize": 600_000,
};

export interface SpawnHandle {
	readonly pid: number | null;
	wait(): Promise<{ code: number | null; out: string }>;
	kill(): void;
	/** True only while this owned leader has not exited; descendants alone do not identify it. */
	alive?(): boolean;
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

/** An owned child process-group cleanup probe; this transient group is not a persisted owner identity. */
function processGroupAlive(group: number): boolean {
	try {
		process.kill(group, 0);
		return true;
	} catch (error) {
		return !(error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH");
	}
}
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

export interface CapOutputOptions {
	/** False streams without retaining a second copy of potentially large build logs. */
	captureOutput?: boolean;
	onOutput?(stream: "stdout" | "stderr", text: string): void;
}

/**
 * Finite pipe-based jobs own a fresh POSIX group by default. Native PTYs and
 * long-lived service launchers have separate lifecycle owners, not this adapter.
 */
export function bunCapExec(options: CapOutputOptions = {}): CapExec {
	return {
		spawn: (argv, opts) => {
			const ownsGroup = process.platform === "darwin" || process.platform === "linux";
			const child = Bun.spawn([...argv], { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe", detached: ownsGroup });
			const streams = [Readable.fromWeb(child.stdout), Readable.fromWeb(child.stderr)];
			const output = ["", ""];
			// Node's stream bridge drains both pipes immediately and destroy()
			// cancels their actual readers, including an outstanding read.
			const drained = Promise.all(streams.map((stream, index) => {
				stream.setEncoding("utf8").on("data", chunk => {
					if (options.captureOutput !== false) output[index] += chunk;
					options.onOutput?.(index === 0 ? "stdout" : "stderr", chunk);
				});
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
				if (ownsGroup && !cleanup && processGroupAlive(-child.pid)) await stop();
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
				return { code, out: options.captureOutput === false ? "" : `${output[0]}\n${output[1]}` };
			});
			return { pid: child.pid, wait: () => result, kill, alive: () => !settled && child.exitCode === null };
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
