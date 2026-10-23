/**
 * kitlib run: the kit's one bounded-run primitive for TypeScript (ompkit-hsfyp, KITLIB-RUN).
 *
 * J-2026-10-21-17: deadlines, cancellation and memory bounds belong in the
 * script, not in a call-site `timeout N`. `run()` is the TypeScript half of a
 * two-language contract; `scripts/kitlib_run.py` is the Python half, and both
 * pass the one conformance corpus `tests/fixtures/kitlib-run/corpus.json`
 * (`tests/cli/kitlib-run.test.ts` and `tests/scripts/kitlib_run_test.py`).
 *
 * Semantics match `pysafe.run_bounded`, which backs the Python half: the child
 * leads a new session (its own process group), stdin is `/dev/null` unless
 * bytes are supplied, stdout and stderr are read here with at most
 * `max_output_bytes` kept per stream (the rest is read and discarded so the
 * child never blocks on a full pipe), and at the deadline the whole group gets
 * SIGTERM, `grace_s` seconds, then SIGKILL; the leader is always reaped. When
 * the leader exits first, group members still holding the pipes past `grace_s`
 * are killed (`killed`), and any member left after that is swept, so no
 * descendant in the group outlives the call. Only the group this call created
 * is ever signalled; nothing is found by name. An aborted `signal` kills the
 * group at once, reaps, and rejects with the abort reason.
 *
 * Optional POSIX resource limits go through the same `/bin/sh` `ulimit`
 * prologue as the Python half: `rlimit_cpu_s` (RLIMIT_CPU) and
 * `rlimit_as_bytes` (RLIMIT_AS, rounded up to KiB). A limit the platform
 * refuses (macOS cannot lower RLIMIT_AS) fails closed: exit 126 with
 * `kitlib-run: cannot apply ...` on stderr, and argv never runs.
 */
import { constants } from "node:os";

export const DEFAULT_GRACE_S = 2;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
/** Bound on reading the pipes once the group has been SIGKILLed (pysafe `_DRAIN_S`). */
const DRAIN_MS = 1000;

/** $1 = CPU seconds or "-", $2 = address-space KiB or "-", then argv. Mirrors RLIMIT_PROLOGUE in scripts/kitlib_run.py. */
export const RLIMIT_PROLOGUE = 'cpu=$1; as=$2; shift 2; '
	+ 'if [ "$cpu" != - ]; then ulimit -t "$cpu" || { printf "kitlib-run: cannot apply RLIMIT_CPU=%s\\n" "$cpu" >&2; exit 126; }; fi; '
	+ 'if [ "$as" != - ]; then ulimit -v "$as" || { printf "kitlib-run: cannot apply RLIMIT_AS=%sKiB\\n" "$as" >&2; exit 126; }; fi; '
	+ 'exec "$@"';

export interface RunOptions {
	/** Wall-clock bound in seconds; required and positive. */
	deadline_s: number;
	/** Seconds between SIGTERM and SIGKILL, and the wait for pipe-holding descendants after the leader exits. */
	grace_s?: number;
	/** Bytes kept per stream; the rest is read and discarded. */
	max_output_bytes?: number;
	/** Bytes (or UTF-8 text) written to the child's stdin; absent means `/dev/null`. */
	stdin?: Uint8Array | string;
	cwd?: string;
	/** Replaces the child's environment when given. */
	env?: Record<string, string>;
	rlimit_cpu_s?: number;
	rlimit_as_bytes?: number;
	signal?: AbortSignal;
}

export interface RunResult {
	/** Exit status, `-signum` when a signal ended the leader, null if it was not reaped. */
	rc: number | null;
	timed_out: boolean;
	/** The group was signalled: the deadline passed, or descendants held the pipes past grace. */
	killed: boolean;
	stdout: Uint8Array;
	stderr: Uint8Array;
	/** Either stream exceeded `max_output_bytes`. */
	truncated: boolean;
	elapsed_s: number;
}

const liveGroups = new Set<number>();
let exitSweepInstalled = false;

/** SIGKILL every process group a `run()` call still owns; returns how many were signalled. */
export function killLiveGroups(): number {
	let signalled = 0;
	for (const pgid of liveGroups) {
		try { process.kill(-pgid, "SIGKILL"); signalled++; } catch { /* group already gone */ }
	}
	return signalled;
}

function positive(name: string, value: unknown): number {
	if (typeof value !== "number") throw new TypeError(`${name} must be a number of seconds, got ${typeof value}`);
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number, got ${value}`);
	return value;
}

/** Settles true when `promise` settles within `ms`, false otherwise; never leaves a timer behind. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
	const { promise: expired, resolve } = Promise.withResolvers<boolean>();
	const timer: NodeJS.Timeout = setTimeout(resolve, Math.max(0, ms), false);
	try {
		return await Promise.race([promise.then(() => true, () => true), expired]);
	} finally {
		clearTimeout(timer);
	}
}

/** Reads a pipe to EOF keeping at most `cap` bytes; a partial chunk is copied so the rest is not retained. */
function capture(stream: ReadableStream<Uint8Array>, cap: number) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let kept = 0, truncated = false;
	const done = (async () => {
		for (;;) {
			const { done: eof, value } = await reader.read();
			if (eof) return;
			const room = cap - kept;
			if (value.byteLength <= room) { chunks.push(value); kept += value.byteLength; continue; }
			if (room > 0) { chunks.push(value.slice(0, room)); kept = cap; }
			truncated = true;
		}
	})().catch(() => { /* the reader was cancelled after the drain bound */ });
	return {
		done,
		cancel: () => reader.cancel().catch(() => { /* already closed */ }),
		bytes: () => Buffer.concat(chunks, kept),
		get truncated() { return truncated; },
	};
}

export async function run(argv: readonly string[], options: RunOptions): Promise<RunResult> {
	if (!Array.isArray(argv)) throw new TypeError("kitlib run takes an argv array, never a shell string");
	if (argv.length === 0 || argv.some(item => typeof item !== "string")) throw new TypeError("kitlib run needs a non-empty argv of strings");
	if (options === null || typeof options !== "object") throw new TypeError("kitlib run needs options with deadline_s");
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`kitlib run needs POSIX process groups; ${process.platform} is unsupported`);
	const deadlineMs = positive("deadline_s", options.deadline_s) * 1000;
	const graceMs = positive("grace_s", options.grace_s ?? DEFAULT_GRACE_S) * 1000;
	const cap = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError(`max_output_bytes must be a non-negative integer, got ${cap}`);
	const cpu = options.rlimit_cpu_s === undefined ? "-" : String(Math.ceil(positive("rlimit_cpu_s", options.rlimit_cpu_s)));
	const addressKib = options.rlimit_as_bytes === undefined ? "-" : String(Math.ceil(positive("rlimit_as_bytes", options.rlimit_as_bytes) / 1024));
	const args = cpu === "-" && addressKib === "-" ? [...argv] : ["/bin/sh", "-c", RLIMIT_PROLOGUE, "kitlib-run", cpu, addressKib, ...argv];
	const stdin = typeof options.stdin === "string" ? Buffer.from(options.stdin, "utf8") : options.stdin;
	const abort = options.signal;
	abort?.throwIfAborted();

	const started = performance.now();
	const child = Bun.spawn(args, {
		cwd: options.cwd, env: options.env, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", detached: true,
	});
	const pgid = child.pid;
	liveGroups.add(pgid);
	if (!exitSweepInstalled) {
		exitSweepInstalled = true;
		process.on("exit", () => { killLiveGroups(); });
	}
	// Only the group created above; never a process found by name.
	const signalGroup = (name: "SIGTERM" | "SIGKILL"): boolean => {
		try { process.kill(-pgid, name); return true; } catch { return false; }
	};
	const out = capture(child.stdout, cap), err = capture(child.stderr, cap);
	const pipesClosed = Promise.all([out.done, err.done]);
	const { promise: aborted, resolve: onAbort } = Promise.withResolvers<void>();
	const abortListener = () => onAbort();
	abort?.addEventListener("abort", abortListener, { once: true });
	let timedOut = false, killed = false, settled = false;
	try {
		const deadlineAt = started + deadlineMs;
		const remaining = () => deadlineAt - performance.now();
		// Every wait also ends on abort, so an aborted call keeps no timer alive.
		const exited = await within(Promise.race([child.exited, aborted]), remaining());
		if (abort?.aborted) throw abort.reason;
		if (exited) {
			const pipeWait = Math.min(graceMs, remaining());
			const closed = await within(Promise.race([pipesClosed, aborted]), pipeWait);
			if (abort?.aborted) throw abort.reason;
			if (closed) {
				// A descendant that redirected its pipes away is still in the group.
				signalGroup("SIGKILL");
			} else if (pipeWait < graceMs) {
				timedOut = true;
			} else {
				killed = signalGroup("SIGKILL");
				await within(pipesClosed, DRAIN_MS);
			}
		} else {
			timedOut = true;
		}
		if (timedOut) {
			killed = true;
			signalGroup("SIGTERM");
			await within(child.exited, graceMs);
			signalGroup("SIGKILL");
			await within(pipesClosed, DRAIN_MS);
		}
		await within(child.exited, graceMs);
		settled = true;
	} finally {
		abort?.removeEventListener("abort", abortListener);
		if (!settled) {
			// Aborted (or any other exception) mid-run: the group dies first.
			signalGroup("SIGKILL");
			await within(child.exited, graceMs);
		}
		await Promise.all([out.cancel(), err.cancel()]);
		await pipesClosed;
		liveGroups.delete(pgid);
	}
	const signalCode = child.signalCode as keyof typeof constants.signals | null;
	const rc = child.exitCode ?? (signalCode ? -constants.signals[signalCode] : null);
	return {
		rc, timed_out: timedOut, killed,
		stdout: out.bytes(), stderr: err.bytes(), truncated: out.truncated || err.truncated,
		elapsed_s: (performance.now() - started) / 1000,
	};
}

export interface RunSyncOptions {
	/** Wall-clock bound in seconds; required and positive. */
	deadline_s: number;
	/** Bytes kept per stream. A child that writes more is stopped (`killed`, `truncated`, rc null). */
	max_output_bytes?: number;
	cwd?: string;
	/** Replaces the child's environment when given. */
	env?: Record<string, string>;
}

/**
 * Synchronous bounded run for SHORT LEAF commands only (a `ps -p`, an `lsof -t`), for callers that cannot await.
 * stdin is `/dev/null`. At the deadline the child gets SIGKILL and the result is `timed_out: true, rc: null`.
 * Output past `max_output_bytes` on either stream also stops it with SIGKILL (`killed`, `truncated`, rc null):
 * a synchronous call cannot keep draining a pipe it discards, so the cap bounds memory by stopping the writer.
 * There is NO process-group ownership: only the leader is signalled, so a descendant can outlive the call.
 * A command that can fork descendants must use async `run()`.
 */
export function runSync(argv: readonly string[], options: RunSyncOptions): RunResult {
	if (!Array.isArray(argv)) throw new TypeError("kitlib runSync takes an argv array, never a shell string");
	if (argv.length === 0 || argv.some(item => typeof item !== "string")) throw new TypeError("kitlib runSync needs a non-empty argv of strings");
	if (options === null || typeof options !== "object") throw new TypeError("kitlib runSync needs options with deadline_s");
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`kitlib runSync needs POSIX; ${process.platform} is unsupported`);
	const deadlineMs = Math.max(1, Math.ceil(positive("deadline_s", options.deadline_s) * 1000));
	const cap = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
	if (!Number.isSafeInteger(cap) || cap < 0) throw new RangeError(`max_output_bytes must be a non-negative integer, got ${cap}`);
	const started = performance.now();
	const child = Bun.spawnSync([...argv], {
		cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
		// maxBuffer 0 would mean unbounded, so a zero cap still stops at the first byte.
		timeout: deadlineMs, killSignal: "SIGKILL", maxBuffer: Math.max(cap, 1),
	});
	const timedOut = child.exitedDueToTimeout === true;
	const overflowed = child.exitedDueToMaxBuffer === true;
	const stdout = child.stdout ?? Buffer.alloc(0), stderr = child.stderr ?? Buffer.alloc(0);
	const signalCode = child.signalCode as keyof typeof constants.signals | null;
	const rc = timedOut || overflowed ? null : child.exitCode ?? (signalCode ? -constants.signals[signalCode] : null);
	return {
		rc, timed_out: timedOut, killed: timedOut || overflowed,
		stdout: new Uint8Array(stdout.subarray(0, cap)), stderr: new Uint8Array(stderr.subarray(0, cap)),
		truncated: overflowed || stdout.byteLength > cap || stderr.byteLength > cap,
		elapsed_s: (performance.now() - started) / 1000,
	};
}
