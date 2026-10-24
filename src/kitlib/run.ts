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
 *
 * Process adoption (ompkit-t8dfi, KL02), all off by default:
 * - `inherit_fds`: an explicit allowlist of open parent descriptors (each >= 3)
 *   the child holds at the same number. Bun maps `stdio[n]` onto child fd n with
 *   dup2, so parent fd F goes in slot F and every other slot above 2 is
 *   `"ignore"` (closed); no descriptor outside the allowlist reaches the child.
 * - `on_output(stream, chunk)`: live raw stdout/stderr bytes while the child
 *   runs, beside the bounded capture. The drain hands each chunk to a queue of at
 *   most `max_sink_queue_bytes` and never awaits the sink; a chunk that does not
 *   fit is dropped and counted (`stream_dropped_bytes`), so a stalled sink can
 *   neither stall the drain nor grow memory. The first sink exception stops
 *   delivery and is reported (`sink_error`); the child is still run and reaped
 *   under the same deadline and group rules. After the reap the queue flushes for
 *   at most `grace_s`; anything undelivered then counts as dropped.
 * - `max_total_bytes`: the combined capture budget across both streams, beside
 *   the per-stream `max_output_bytes` (`total_truncated`). Bytes are never
 *   decoded; strict UTF-8 is caller policy.
 */
import { fstatSync } from "node:fs";
import { constants } from "node:os";

export const DEFAULT_GRACE_S = 2;
export const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
export const DEFAULT_MAX_SINK_QUEUE_BYTES = 1 << 20;
/** Highest descriptor `inherit_fds` accepts (Bun allocates one stdio slot per number). */
const MAX_INHERIT_FD = 1023;
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
	/** Open parent descriptors (each >= 3) the child inherits at the same number; none by default. */
	inherit_fds?: readonly number[];
	/** Live raw chunks while the child runs; may return a promise (backpressure). Never awaited by the drain. */
	on_output?: (stream: OutputStream, chunk: Uint8Array) => unknown;
	/** Combined bytes kept across stdout and stderr; unbounded beyond the per-stream cap by default. */
	max_total_bytes?: number;
	/** Bytes the sink queue may hold before chunks are dropped and counted. */
	max_sink_queue_bytes?: number;
}

export type OutputStream = "stdout" | "stderr";

export interface RunResult {
	/** Exit status, `-signum` when a signal ended the leader, null if it was not reaped. */
	rc: number | null;
	timed_out: boolean;
	/** The group was signalled: the deadline passed, or descendants held the pipes past grace. */
	killed: boolean;
	stdout: Uint8Array;
	stderr: Uint8Array;
	/** A stream lost bytes to `max_output_bytes` (per stream) or `max_total_bytes`. */
	truncated: boolean;
	elapsed_s: number;
	/** The per-stream captures together exceeded `max_total_bytes`. */
	total_truncated: boolean;
	/** Bytes kept in `stdout` + `stderr`. */
	captured_bytes: number;
	/** Bytes `on_output` accepted. */
	streamed_bytes: number;
	/** Bytes read but never delivered to `on_output` (queue overflow, sink failure, flush bound). */
	stream_dropped_bytes: number;
	/** The first error `on_output` threw or rejected with, else null. */
	sink_error: string | null;
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

/** Bounded hand-off from the drain to `on_output`: `offer` never blocks or awaits. */
class Sink {
	private readonly queue: [OutputStream, Uint8Array][] = [];
	private queued = 0;
	private closed = false;
	private abandoned = false;
	private wake: (() => void) | null = null;
	private readonly done: Promise<void>;
	streamed = 0;
	dropped = 0;
	error: string | null = null;
	constructor(private readonly deliver: (stream: OutputStream, chunk: Uint8Array) => unknown, private readonly limit: number) {
		this.done = this.loop();
	}
	offer(stream: OutputStream, chunk: Uint8Array): boolean {
		if (this.error !== null || this.closed || this.queued + chunk.byteLength > this.limit) { this.dropped += chunk.byteLength; return false; }
		this.queue.push([stream, chunk]);
		this.queued += chunk.byteLength;
		this.wake?.();
		return true;
	}
	private async loop(): Promise<void> {
		for (;;) {
			while (this.queue.length === 0 && !this.closed) await new Promise<void>(resolve => { this.wake = resolve; });
			this.wake = null;
			const next = this.queue.shift();
			if (next === undefined || this.abandoned) return;
			const [stream, chunk] = next;
			try {
				await this.deliver(stream, chunk);
			} catch (error) {
				if (!this.abandoned) {
					this.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
					this.queued -= chunk.byteLength;
					this.dropped += chunk.byteLength + this.queued;
					this.queue.length = 0;
					this.queued = 0;
				}
				return;
			}
			if (this.abandoned) return; // finish() already counted this chunk as dropped
			this.queued -= chunk.byteLength;
			this.streamed += chunk.byteLength;
		}
	}
	/** Flush for at most `ms`; whatever is undelivered then (a chunk inside a stalled sink too) counts as dropped. */
	async finish(ms: number): Promise<void> {
		this.closed = true;
		this.wake?.();
		await within(this.done, ms);
		this.abandoned = true;
		this.dropped += this.queued;
		this.queue.length = 0;
		this.queued = 0;
	}
}

/** Combined capture budget shared by both streams of one run. */
type Budget = { total: number; kept: number };

/** Reads a pipe to EOF keeping at most `cap` bytes (and at most the shared budget); a partial chunk is copied so the rest is not retained. */
function capture(stream: ReadableStream<Uint8Array>, cap: number, name: OutputStream, budget: Budget, sink: Sink | null) {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let kept = 0, read = 0, truncated = false;
	const done = (async () => {
		for (;;) {
			const { done: eof, value } = await reader.read();
			if (eof) return;
			read += value.byteLength;
			const retainedBySink = sink?.offer(name, value) ?? false;
			const room = Math.min(cap - kept, budget.total - budget.kept);
			if (value.byteLength <= room) { chunks.push(value); kept += value.byteLength; budget.kept += value.byteLength; continue; }
			if (room > 0) { chunks.push(value.slice(0, room)); kept += room; budget.kept += room; }
			truncated = true;
			const buffer = value.buffer;
			// Accepted chunks may outlive run(); partial views may share backing storage.
			if (!retainedBySink && buffer instanceof ArrayBuffer && value.byteOffset === 0 &&
				value.byteLength === buffer.byteLength && typeof buffer.transfer === "function") {
				try { buffer.transfer(0); }
				catch (error) {
					// Non-detachable backing stores keep their ordinary GC lifetime; draining must continue.
					if (!(error instanceof TypeError)) throw error;
				}
			}
		}
	})().catch(() => { /* the reader was cancelled after the drain bound */ });
	return {
		done,
		cancel: () => reader.cancel().catch(() => { /* already closed */ }),
		bytes: () => Buffer.concat(chunks, kept),
		get truncated() { return truncated; },
		/** Bytes this stream would have kept under the per-stream cap alone. */
		get perStream() { return Math.min(read, cap); },
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
	const totalCap = options.max_total_bytes ?? Infinity;
	if (options.max_total_bytes !== undefined && (!Number.isSafeInteger(totalCap) || totalCap < 0)) throw new RangeError(`max_total_bytes must be a non-negative integer, got ${totalCap}`);
	const queueCap = options.max_sink_queue_bytes ?? DEFAULT_MAX_SINK_QUEUE_BYTES;
	if (!Number.isSafeInteger(queueCap) || queueCap < 0) throw new RangeError(`max_sink_queue_bytes must be a non-negative integer, got ${queueCap}`);
	if (options.on_output !== undefined && typeof options.on_output !== "function") throw new TypeError("on_output must be a function");
	const inherit = options.inherit_fds ?? [];
	if (!Array.isArray(inherit)) throw new TypeError("inherit_fds must be an array of descriptor numbers");
	for (const fd of inherit) {
		if (!Number.isInteger(fd) || fd < 3 || fd > MAX_INHERIT_FD) throw new RangeError(`inherit_fds entries must be integers in 3..${MAX_INHERIT_FD}, got ${fd}`);
		fstatSync(fd); // a closed descriptor is refused here, never silently skipped
	}
	if (new Set(inherit).size !== inherit.length) throw new RangeError(`inherit_fds has duplicates: ${inherit.join(",")}`);
	abort?.throwIfAborted();

	const started = performance.now();
	const stdinSpec = stdin ?? "ignore";
	const io = inherit.length === 0
		? { stdin: stdinSpec, stdout: "pipe" as const, stderr: "pipe" as const }
		: { stdio: inheritedStdio(stdinSpec, inherit) };
	const child = Bun.spawn(args, { cwd: options.cwd, env: options.env, ...io, detached: true });
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
	const sink = options.on_output ? new Sink(options.on_output, queueCap) : null;
	const budget: Budget = { total: totalCap, kept: 0 };
	const out = capture(child.stdout as ReadableStream<Uint8Array>, cap, "stdout", budget, sink);
	const err = capture(child.stderr as ReadableStream<Uint8Array>, cap, "stderr", budget, sink);
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
		await sink?.finish(graceMs);
	}
	const signalCode = child.signalCode as keyof typeof constants.signals | null;
	const rc = child.exitCode ?? (signalCode ? -constants.signals[signalCode] : null);
	return {
		rc, timed_out: timedOut, killed,
		stdout: out.bytes(), stderr: err.bytes(), truncated: out.truncated || err.truncated,
		elapsed_s: (performance.now() - started) / 1000,
		total_truncated: out.perStream + err.perStream > totalCap,
		captured_bytes: budget.kept,
		streamed_bytes: sink?.streamed ?? 0, stream_dropped_bytes: sink?.dropped ?? 0, sink_error: sink?.error ?? null,
	};
}

/** stdio for `inherit_fds`: slot n becomes child fd n, so parent fd F sits in slot F; every other slot above 2 is closed. */
function inheritedStdio(stdin: Uint8Array | "ignore", fds: readonly number[]): (Uint8Array | number | "ignore" | "pipe")[] {
	const stdio: (Uint8Array | number | "ignore" | "pipe")[] = [stdin, "pipe", "pipe"];
	for (let slot = 3; slot <= Math.max(...fds); slot++) stdio.push(fds.includes(slot) ? slot : "ignore");
	return stdio;
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
		total_truncated: false, captured_bytes: Math.min(stdout.byteLength, cap) + Math.min(stderr.byteLength, cap),
		streamed_bytes: 0, stream_dropped_bytes: 0, sink_error: null,
	};
}
