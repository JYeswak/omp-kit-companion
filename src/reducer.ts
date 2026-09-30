import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type PredicateStatus = "HOLD" | "LOSE" | "UNAVAILABLE";
export interface PredicateOutcome {
	status: PredicateStatus;
	/** Stable evaluator/rule/policy identity, excluding candidate-specific input hashes. */
	identity?: Readonly<Record<string, string>>;
	reason?: string;
	evidence?: unknown;
}
export interface EvaluationContext { signal: AbortSignal; remainingMs: number; }
export type ReducerPredicate = (candidate: string, context: EvaluationContext) => Promise<PredicateOutcome>;
export interface ReducerOptions {
	grammar: "lines";
	/** Total evaluator calls, including the initial observation and independent final replay. */
	maxAttempts: number;
	timeBudgetMs: number;
	predicate: ReducerPredicate;
	finalReplay: ReducerPredicate;
}
export interface ReductionStep {
	phase: "initial" | "candidate" | "final_replay";
	/** Bind the attempted payload without retaining a full input-sized copy per trial. */
	candidateSha256: string;
	bytes: number;
	status: PredicateStatus;
	accepted: boolean;
	reason?: string;
}
export interface ReducerResult {
	status: "REDUCED" | "UNCHANGED" | "MINIMIZATION_INCOMPLETE" | "UNAVAILABLE";
	/** Published only after a successful, identity-matching independent final replay. */
	candidate: string | null;
	grammar: "lines";
	stopReason: string;
	attempts: number;
	originalBytes: number;
	candidateBytes: number | null;
	identity: Readonly<Record<string, string>> | null;
	trace: readonly ReductionStep[];
	finalReplay: PredicateOutcome | null;
}

function validIdentity(value: unknown): value is Readonly<Record<string, string>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		&& Object.keys(value).length > 0 && Object.values(value).every(item => typeof item === "string" && item.length > 0);
}
function sameIdentity(left: Readonly<Record<string, string>>, right: unknown): boolean {
	return validIdentity(right) && Object.keys(left).length === Object.keys(right).length
		&& Object.entries(left).every(([key, value]) => Object.prototype.hasOwnProperty.call(right, key) && right[key] === value);
}

/**
 * Deterministically delete complete lines, restarting after each strict UTF-8 size decrease.
 * Inputs are limited to 1 MiB. Attempts count initial/search/final evaluator calls.
 * Completed HOLD/LOSE observations require a nonempty stable evaluator identity.
 * The application predicate owns benign-context preservation and the independent replay.
 * No global minimality is claimed. Callbacks must honor the supplied signal/deadline: an
 * arbitrary synchronous or noncooperative callback cannot be forcibly preempted by JavaScript.
 */
export async function reduceCandidate(input: string, options: ReducerOptions): Promise<ReducerResult> {
	const trace: ReductionStep[] = [];
	const result: ReducerResult = { status: "UNAVAILABLE", candidate: null, grammar: "lines", stopReason: "invalid-input",
		attempts: 0, originalBytes: typeof input === "string" ? Buffer.byteLength(input) : 0,
		candidateBytes: null, identity: null, trace, finalReplay: null };
	if (typeof input !== "string" || result.originalBytes > 1024 * 1024 || options.grammar !== "lines"
		|| !Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1
		|| !Number.isFinite(options.timeBudgetMs) || options.timeBudgetMs <= 0 || options.timeBudgetMs > 2_147_483_647
		|| typeof options.predicate !== "function" || typeof options.finalReplay !== "function") return result;
	const deadline = performance.now() + options.timeBudgetMs;
	const remaining = () => deadline - performance.now();

	async function evaluate(phase: ReductionStep["phase"], candidate: string, predicate: ReducerPredicate): Promise<PredicateOutcome> {
		const remainingMs = remaining();
		if (result.attempts >= options.maxAttempts) return { status: "UNAVAILABLE", reason: "attempt-budget" };
		if (remainingMs <= 0) return { status: "UNAVAILABLE", reason: "time-budget" };
		result.attempts++;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let outcome: PredicateOutcome;
		try {
			outcome = await Promise.race([
				Promise.resolve().then(() => predicate(candidate, { signal: controller.signal, remainingMs })),
				new Promise<PredicateOutcome>(resolve => {
					timer = setTimeout(() => { controller.abort(); resolve({ status: "UNAVAILABLE", reason: "time-budget" }); }, remainingMs);
				}),
			]);
			if (remaining() <= 0) outcome = { status: "UNAVAILABLE", reason: "time-budget" };
			if (!outcome || !["HOLD", "LOSE", "UNAVAILABLE"].includes(outcome.status)) {
				outcome = { status: "UNAVAILABLE", reason: "invalid-evaluator-outcome" };
			} else if (outcome.identity !== undefined) {
				outcome = validIdentity(outcome.identity)
					? { ...outcome, identity: Object.freeze({ ...outcome.identity }) }
					: { status: "UNAVAILABLE", reason: "invalid-evaluator-identity" };
			}
		} catch {
			outcome = { status: "UNAVAILABLE", reason: "evaluator-error" };
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
		trace.push({ phase, candidateSha256: createHash("sha256").update(candidate).digest("hex"), bytes: Buffer.byteLength(candidate), status: outcome.status, accepted: false,
			...(outcome.reason ? { reason: outcome.reason } : {}) });
		return outcome;
	}
	function unavailable(outcome: PredicateOutcome): ReducerResult {
		result.stopReason = outcome.reason ?? "evaluator-unavailable";
		result.status = result.stopReason === "time-budget" || result.stopReason === "attempt-budget" ? "MINIMIZATION_INCOMPLETE" : "UNAVAILABLE";
		return result;
	}

	const initial = await evaluate("initial", input, options.predicate);
	if (initial.status === "UNAVAILABLE") return unavailable(initial);
	if (initial.status !== "HOLD") { result.stopReason = "initial-predicate-not-held"; return result; }
	if (!validIdentity(initial.identity)) { result.stopReason = "identity-unavailable"; return result; }
	result.identity = initial.identity;
	let best = input;
	let bestBytes = result.originalBytes;
	let exhausted = false;

	search: for (;;) {
		let improved = false;
		for (let start = 0; start < best.length;) {
			// Leave one evaluator call for independent replay rather than exhausting all
			// attempts on search and publishing a merely predicted candidate.
			if (result.attempts >= options.maxAttempts - 1) { exhausted = true; break search; }
			if (remaining() <= 0) return unavailable({ status: "UNAVAILABLE", reason: "time-budget" });
			const newline = best.indexOf("\n", start);
			const end = newline === -1 ? best.length : newline + 1;
			const candidate = best.slice(0, start) + best.slice(end);
			const bytes = Buffer.byteLength(candidate);
			if (bytes >= bestBytes) { start = end; continue; }
			const outcome = await evaluate("candidate", candidate, options.predicate);
			if (outcome.status === "UNAVAILABLE") return unavailable(outcome);
			if (!sameIdentity(result.identity, outcome.identity)) { result.stopReason = "identity-changed"; return result; }
			if (outcome.status === "HOLD") {
				trace[trace.length - 1]!.accepted = true;
				best = candidate;
				bestBytes = bytes;
				improved = true;
				break;
			}
			start = end;
		}
		if (!improved) break;
	}

	if (result.attempts >= options.maxAttempts) return unavailable({ status: "UNAVAILABLE", reason: "attempt-budget" });
	if (remaining() <= 0) return unavailable({ status: "UNAVAILABLE", reason: "time-budget" });
	const replay = await evaluate("final_replay", best, options.finalReplay);
	result.finalReplay = replay;
	if (replay.status === "UNAVAILABLE") return unavailable(replay);
	if (!sameIdentity(result.identity, replay.identity)) { result.stopReason = "identity-changed"; return result; }
	if (replay.status !== "HOLD") {
		result.status = "MINIMIZATION_INCOMPLETE";
		result.stopReason = "final-predicate-lost";
		return result;
	}
	result.candidate = best;
	result.candidateBytes = bestBytes;
	result.status = exhausted ? "MINIMIZATION_INCOMPLETE" : bestBytes < result.originalBytes ? "REDUCED" : "UNCHANGED";
	result.stopReason = exhausted ? "attempt-budget" : "no-improvement";
	return result;
}
