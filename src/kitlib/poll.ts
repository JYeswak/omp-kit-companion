/**
 * kitlib poll: the kit's one bounded condition-polling primitive for TypeScript (ompkit-u6k6t, KL13).
 *
 * `pollUntil(probe, options)` repeats an owner-supplied observation until the
 * owner's `classify` says `success` or `terminal`, the single monotonic budget
 * `deadline_s` runs out, or `signal` aborts. `scripts/kitlib_poll.py` is the
 * Python half (and the shell adapter, as its CLI); both pass the one corpus
 * `tests/fixtures/kitlib-poll/corpus.json`.
 *
 * - One budget: `deadline_s` becomes one monotonic deadline exactly once.
 *   Probe time counts against it; a wall-clock jump neither extends nor
 *   shortens it.
 * - Each attempt gets `attempt_timeout_s = min(options.attempt_timeout_s, remaining)`,
 *   never more than the remaining budget; the probe must honour it. An
 *   observation that arrives after the deadline is recorded but the outcome is
 *   `deadline`, never `success`.
 * - No interval sleep after expiry (the last sleep is cut to the remaining
 *   budget), and no probe after cancellation or after `success`/`terminal`.
 * - `probe` is an explicit owner observation (a GET, a status read, a file
 *   check). It is never a replayed mutation: do not submit a job, send mail or
 *   re-run an accepted write from a probe.
 * - `classify` owns the verdict: domain predicates decide (HTTP 200 with the
 *   wrong body is `retry` or `terminal`, never `success` by status alone).
 *   `whenAll()` builds a conjunction classifier and refuses an empty set.
 * - The returned observation is bounded: at most `max_observation_bytes` of
 *   UTF-8 JSON; a larger one is returned as its truncated JSON text with
 *   `observation_truncated: true`.
 *
 * A probe or classify exception propagates (an owner bug, not a retry).
 */

export type PollVerdict = "success" | "terminal" | "retry";
export type PollOutcome = "success" | "terminal" | "deadline" | "cancelled";
export const DEFAULT_MAX_OBSERVATION_BYTES = 4096;

export interface ProbeContext {
	/** 1-based attempt number. */
	attempt: number;
	/** Remaining global budget in seconds when the attempt starts. */
	remaining_s: number;
	/** This attempt's bound in seconds; at most `remaining_s`. */
	attempt_timeout_s: number;
	signal?: AbortSignal;
}

/** Detectors a test seam may bypass to prove each planted negative flips. */
export type PollDetector = "probe_time_counts" | "monotonic_clock" | "empty_conditions" | "conjunction" | "cancel_check" | "stop_on_settle";

export interface PollSeams {
	/** Monotonic seconds. */
	now?: () => number;
	/** Wall-clock seconds; used only when `monotonic_clock` is bypassed. */
	wallNow?: () => number;
	sleep?: (seconds: number, signal?: AbortSignal) => Promise<void>;
	bypass?: readonly PollDetector[];
}

export interface PollOptions<T> {
	deadline_s: number;
	interval_s: number;
	classify: (observation: T) => PollVerdict;
	signal?: AbortSignal;
	attempt_timeout_s?: number;
	max_observation_bytes?: number;
	/** Test seam only. */
	_seams?: PollSeams;
}

export interface PollResult<T> {
	outcome: PollOutcome;
	/** Last observation (bounded), or its truncated JSON text; undefined when no attempt ran. */
	observation: T | string | undefined;
	observation_truncated: boolean;
	attempts: number;
	elapsed_s: number;
}

export class PollError extends Error {
	constructor(readonly code: "INVALID_ARGUMENT", message: string) {
		super(`${code}: ${message}`);
		this.name = "PollError";
	}
}

export type Predicate<T> = (observation: T) => boolean;

/** Conjunction classifier: `terminal` if any terminal predicate holds, `success` if every success predicate holds, else `retry`. */
export function whenAll<T>(success: readonly Predicate<T>[], terminal: readonly Predicate<T>[] = [], seams?: Pick<PollSeams, "bypass">): (observation: T) => PollVerdict {
	const off = new Set(seams?.bypass ?? []);
	if (success.length === 0 && !off.has("empty_conditions")) throw new PollError("INVALID_ARGUMENT", "an empty success condition set is refused");
	const conjunction = off.has("conjunction") ? success.slice(0, 1) : success;
	return observation => {
		if (terminal.some(predicate => predicate(observation))) return "terminal";
		return conjunction.every(predicate => predicate(observation)) ? "success" : "retry";
	};
}

function seconds(name: string, value: unknown, allowZero: boolean): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
		throw new PollError("INVALID_ARGUMENT", `${name} must be a ${allowZero ? "non-negative" : "positive"} finite number of seconds, got ${String(value)}`);
	}
	return value;
}

/** Bounds an observation to `cap` bytes of UTF-8 JSON, cutting on a character boundary. */
export function boundObservation<T>(observation: T, cap: number): { observation: T | string; truncated: boolean } {
	const text = JSON.stringify(observation) ?? "null";
	const bytes = Buffer.from(text, "utf8");
	if (bytes.byteLength <= cap) return { observation, truncated: false };
	let cut = cap;
	while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
	return { observation: bytes.subarray(0, cut).toString("utf8"), truncated: true };
}

function defaultSleep(s: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted) { resolve(); return promise; }
	const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
	const timer = setTimeout(done, s * 1000);
	signal?.addEventListener("abort", done, { once: true });
	return promise;
}

export async function pollUntil<T>(probe: (context: ProbeContext) => T | Promise<T>, options: PollOptions<T>): Promise<PollResult<T>> {
	if (typeof probe !== "function") throw new PollError("INVALID_ARGUMENT", "probe must be a function");
	if (options === null || typeof options !== "object" || typeof options.classify !== "function") throw new PollError("INVALID_ARGUMENT", "options need deadline_s, interval_s and classify");
	const deadline = seconds("deadline_s", options.deadline_s, false);
	const interval = seconds("interval_s", options.interval_s, true);
	const perAttempt = options.attempt_timeout_s === undefined ? Infinity : seconds("attempt_timeout_s", options.attempt_timeout_s, false);
	const cap = options.max_observation_bytes ?? DEFAULT_MAX_OBSERVATION_BYTES;
	if (!Number.isSafeInteger(cap) || cap < 0) throw new PollError("INVALID_ARGUMENT", `max_observation_bytes must be a non-negative integer, got ${cap}`);
	const seams = options._seams ?? {};
	const off = new Set(seams.bypass ?? []);
	const monotonic = seams.now ?? (() => performance.now() / 1000);
	const now = off.has("monotonic_clock") ? (seams.wallNow ?? (() => Date.now() / 1000)) : monotonic;
	const sleep = seams.sleep ?? defaultSleep;
	const { signal, classify } = options;

	const started = now();
	let slept = 0; // only read when probe_time_counts is bypassed
	const spent = () => off.has("probe_time_counts") ? slept : now() - started;
	const remaining = () => deadline - spent();
	let attempts = 0;
	let last: T | undefined;
	const finish = (outcome: PollOutcome): PollResult<T> => {
		const bounded = attempts === 0 ? { observation: undefined, truncated: false } : boundObservation(last as T, cap);
		return { outcome, observation: bounded.observation, observation_truncated: bounded.truncated, attempts, elapsed_s: now() - started };
	};
	for (;;) {
		if (signal?.aborted && !off.has("cancel_check")) return finish("cancelled");
		const left = remaining();
		if (left <= 0) return finish("deadline");
		attempts++;
		last = await probe({ attempt: attempts, remaining_s: left, attempt_timeout_s: Math.min(perAttempt, left), signal });
		if (signal?.aborted) return finish("cancelled");
		if (remaining() < 0) return finish("deadline");
		const verdict = classify(last);
		if (verdict !== "success" && verdict !== "terminal" && verdict !== "retry") throw new PollError("INVALID_ARGUMENT", `classify returned ${String(verdict)}, not success|terminal|retry`);
		if ((verdict === "success" || verdict === "terminal") && !off.has("stop_on_settle")) return finish(verdict);
		const pause = Math.min(interval, remaining());
		if (pause <= 0) return finish("deadline");
		const before = now();
		await sleep(pause, signal);
		slept += off.has("probe_time_counts") ? pause : now() - before;
		if (signal?.aborted && !off.has("cancel_check")) return finish("cancelled");
	}
}
