#!/usr/bin/env bun
/**
 * regex-budget.ts — bounded Bun/JSC measurements for omp rule conditions.
 *
 * Every condition is parsed by the kit's omp-backed rule loader and compiled with
 * omp's compileRuleCondition. A child process contains synchronous regex stalls.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { OMP_SRC, loadRules } from "./rule-class.ts";
import type { LoadedRule } from "./rule-class.ts";

const KIT = path.resolve(import.meta.dir, "..");
export const DEFAULT_SIZES = [4096, 8192, 16384] as const;
export const DEFAULT_SHAPES = ["single-quote", "escaped-double-quote", "backslash", "space", "semicolon", "newline", "literal"] as const;
export const DEFAULT_ENCODINGS = ["raw", "json"] as const;
const NEAR_MISS_RATIO = 2.6;
const NEAR_MISS_FLOOR_MS = 5;
/** Base stream budget on the calibration host. The gate scales it by the same-moment reference ratio, clamped to [1, REFERENCE_RATIO_CLAMP]. */
export const STREAM_BUDGET_MS = 500;
/** The write/edit live-stream fixture gets its own named budget, equal to the bash stream budget: file-write payloads deserve the same ceiling as streamed bash arguments. */
export const WRITE_EDIT_STREAM_BUDGET_MS = 500;
/** Committed write/edit live-stream fixture; non-authors replay the same bytes. A missing file fails the gate loudly instead of passing vacuously. */
export const DEFAULT_WRITE_EDIT_STREAM_FILE = path.join(KIT, "scripts/fixtures/rx-write-edit-stream.md");
/** Frozen stream reference (REGEXREF1): two backtracking-heavy conditions and a pinned wire, timed in every worker
 * beside the conditions so the stream budget follows how fast this host runs regexes right now. */
export const DEFAULT_REFERENCE_FILE = path.join(KIT, "scripts/fixtures/rx-reference-conditions.json");
/** Beyond this reference ratio the host is too slow to judge: INCONCLUSIVE, never PASS. Measured 2026-11-04 under
 * `taskpolicy -c background` (efficiency cores shared with the fleet, load1 10-22): ratios 3.97, 4.50 and 5.54;
 * 8 leaves about 1.45x headroom over the 5.54 maximum. The verdict is total/ratio against the base budget, so the
 * clamp only bounds how much budget a reference could buy; TRACKING_BAND guards that it still tracks the rules. */
export const REFERENCE_RATIO_CLAMP = 8;
/** Tracking guard: when scaling is what lets a stream pass, the unchanged rules' own slowdown (now / calibration-run
 * per-rule medians) and the reference ratio may differ by at most this factor, else INCONCLUSIVE. Measured under
 * `taskpolicy -c background`: reference vs rule mix 4.50 vs 4.00 (1.13x live), 4.50 vs 3.86 (1.17x write/edit),
 * 4.78 vs 4.21 (1.14x live) and 5.54 vs 4.00 (1.385x live, the largest). 1.385 x about 1.15 headroom = 1.6. The
 * verdict stays total/ratio against the base budget, so a reference that slows more than the rules can loosen it by
 * at most this factor. */
export const TRACKING_BAND = 1.6;
/** Fewer matched baseline milliseconds than this cannot verify tracking (about a quarter of the live stream). */
const MIN_TRACKING_BASELINE_MS = 100;
/** Reference sweeps per gate sample (~190 ms each on the calibration host); spread evenly over the sample's workers. */
const REFERENCE_SWEEPS_PER_SAMPLE = 8;
/** Exit code for INCONCLUSIVE; callers already defer to CI on 75. */
export const INCONCLUSIVE_EXIT_CODE = 75;
/** A single 16k near-miss check may not exceed a tenth of the whole stream budget (also 10x the noise floor): flat catastrophics fail here even when their growth ratio looks innocent. */
export const SINGLE_CHECK_CEILING_MS = STREAM_BUDGET_MS / 10;
const GATE_DEADLINE_MS = 57_000;
const DEFAULT_WORKER_TIMEOUT_MS = 20_000;
const TIMING_SAMPLE_COUNT = 5;

type Shape = typeof DEFAULT_SHAPES[number];
type Encoding = typeof DEFAULT_ENCODINGS[number];
type WorkerSample = {
	shape: Shape;
	encoding: Encoding;
	ms: number[];
	load1: number[];
	matched: boolean[];
	bytes: number[];
};
type WorkerRequest = {
	rule: string;
	conditionIndex: number;
	pattern: string;
	literal: string | null;
	sizes: number[];
	shapes: Shape[];
	encodings: Encoding[];
	streamWire?: string;
	writeEditWire?: string;
	reference?: StreamReference;
	ompSource: string;
};
/** Reference conditions and their encoded wire, swept exactly like a stream condition. */
export type StreamReference = { patterns: string[]; wire: string };
export type ProbeSample = {
	shape: Shape;
	encoding: Encoding;
	ms: number[];
	sample_ms: number[][];
	sample_load1: number[][];
	matched: boolean[];
	bytes: number[];
};
export type MeasurementFailure = { code: string; shape?: Shape; encoding?: Encoding; message: string };
export type ConditionMeasurement = {
	rule: string;
	condition_index: number;
	status: "MEASURED" | "TIMEOUT" | "COMPILE_ERROR" | "GATE_TIMEOUT";
	literal: string | null;
	samples: ProbeSample[];
	stream_ms?: number;
	sample_stream_ms?: number[];
	sample_stream_load1?: number[];
	stream_deltas?: number;
	write_edit_ms?: number;
	sample_write_edit_ms?: number[];
	sample_write_edit_load1?: number[];
	write_edit_deltas?: number;
	/** Reference sweep timed in this worker just before its stream sweeps, when the gate selected it to carry one. */
	reference_ms?: number;
	/** sha256 of the condition pattern; matches it to the calibration-run baseline for the tracking guard. */
	pattern_sha256?: string;
	failures: MeasurementFailure[];
};
export type MeasureOptions = {
	sizes?: readonly number[];
	shapes?: readonly Shape[];
	encodings?: readonly Encoding[];
	streamWire?: string;
	writeEditWire?: string;
	reference?: StreamReference;
	workerTimeoutMs?: number;
};

function classEnd(pattern: string, start: number): number {
	let escaped = false;
	for (let i = start + 1; i < pattern.length; i++) {
		const c = pattern[i];
		if (escaped) { escaped = false; continue; }
		if (c === "\\") { escaped = true; continue; }
		if (c === "]") return i;
	}
	return pattern.length - 1;
}

function groupEnd(pattern: string, start: number): number {
	let depth = 0;
	let escaped = false;
	for (let i = start; i < pattern.length; i++) {
		const c = pattern[i];
		if (escaped) { escaped = false; continue; }
		if (c === "\\") { escaped = true; continue; }
		if (c === "[") { i = classEnd(pattern, i); continue; }
		if (c === "(") depth++;
		else if (c === ")" && --depth === 0) return i;
	}
	return pattern.length - 1;
}



function groupHasTopLevelAlternative(expression: string): boolean {
	let depth = 0;
	for (let i = 0; i < expression.length; i++) {
		if (expression[i] === "\\") { i++; continue; }
		if (expression[i] === "[") { i = classEnd(expression, i); continue; }
		if (expression[i] === "(") depth++;
		else if (expression[i] === ")") depth--;
		else if (expression[i] === "|" && depth === 0) return true;
	}
	return false;
}

/** First required consuming literal outside assertions, alternations, and optional groups. */
export function literalProbe(pattern: string): string | null {
	for (let i = 0; i < pattern.length;) {
		if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i) || pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) { i = groupEnd(pattern, i) + 1; continue; }
		const flagsMatch = /^\(\?[imsu-]+\)/i.exec(pattern.slice(i));
		if (flagsMatch) { i += flagsMatch[0].length; continue; }
		const c = pattern[i];
		if (c === "[") { i = classEnd(pattern, i) + 1; continue; }
		if (c === "(") {
			const end = groupEnd(pattern, i);
			let bodyStart = i + 1;
			if (pattern.startsWith("(?:", i)) bodyStart = i + 3;
			else if (pattern.startsWith("(?<", i)) {
				const nameEnd = pattern.indexOf(">", i + 3);
				if (nameEnd >= 0) bodyStart = nameEnd + 1;
			}
			const body = pattern.slice(bodyStart, end);
			const afterGroup = end + 1;
			const optional = pattern[afterGroup] === "?" || pattern[afterGroup] === "*" || /^\{0(?:,\d*)?\}/.test(pattern.slice(afterGroup));
			if (groupHasTopLevelAlternative(body) || optional) {
				const quantifier = /^(?:[?*+]\??|\{\d+(?:,\d*)?\}\??)/.exec(pattern.slice(afterGroup));
				i = afterGroup + (quantifier?.[0].length ?? 0);
				continue;
			}
			i = bodyStart;
			continue;
		}
		if (c === ")" || c === "^" || c === "$" || c === "*" || c === "+" || c === "?" || c === "{" || c === "}" || c === "|") { i++; continue; }
		if (c === "\\") {
			const next = pattern[i + 1];
			if (!next) return null;
			if ("bBAGZzDdSsWw".includes(next)) { i += 2; continue; }
			if ((next === "p" || next === "P") && pattern[i + 2] === "{") {
				const end = pattern.indexOf("}", i + 3);
				i = end < 0 ? i + 2 : end + 1;
				continue;
			}
			if (next === "n") return "\n";
			if (next === "t") return "\t";
			if (next === "r") return "\r";
			if (next === "x" && /^[0-9a-f]{2}$/i.test(pattern.slice(i + 2, i + 4))) return String.fromCharCode(parseInt(pattern.slice(i + 2, i + 4), 16));
			if (next === "u" && /^[0-9a-f]{4}$/i.test(pattern.slice(i + 2, i + 6))) return String.fromCharCode(parseInt(pattern.slice(i + 2, i + 6), 16));
			return next;
		}
		if (/[A-Za-z0-9_-]/.test(c)) {
			let end = i + 1;
			while (end < pattern.length && /[A-Za-z0-9_-]/.test(pattern[end])) end++;
			return pattern.slice(i, end);
		}
		if (c === ".") { i++; continue; }
		return c;
	}
	return null;
}

function hasUnboundedQuantifier(expression: string): boolean {
	for (let i = 0; i < expression.length; i++) {
		if (expression[i] === "[") { i = classEnd(expression, i); continue; }
		if (expression[i] === "\\") { i++; continue; }
		if (expression[i] === "*" || expression[i] === "+") return true;
		if (expression[i] === "{" && /^\{\d*,\}/.test(expression.slice(i))) return true;
	}
	return false;
}

function startsWithUnboundedWildcard(source: string): boolean {
	let atomEnd = 0;
	let broad = false;
	if (source[0] === ".") { atomEnd = 1; broad = true; }
	else if (source[0] === "[") {
		atomEnd = classEnd(source, 0) + 1;
		const body = source.slice(1, atomEnd - 1);
		broad = body.startsWith("^") || (body.includes("\\s") && body.includes("\\S"));
	} else if (source.startsWith("\\S")) { atomEnd = 2; broad = true; }
	if (!broad) return false;
	return /^(?:\*|\+|\{\d*,\})(?:\?)?/.test(source.slice(atomEnd));
}

/** Structural safety checks used by RX1; fixed-width lookbehinds are allowed after a literal. */
export function lintCondition(pattern: string): string[] {
	const violations: string[] = [];
	let lead = 0;
	while (lead < pattern.length) {
		if (pattern[lead] === "^" || pattern[lead] === "$") { lead++; continue; }
		if (pattern.startsWith("\\b", lead) || pattern.startsWith("\\B", lead)) { lead += 2; continue; }
		const flagsMatch = /^\(\?[imsu-]+\)/i.exec(pattern.slice(lead));
		if (flagsMatch) { lead += flagsMatch[0].length; continue; }
		break;
	}
	if (pattern.startsWith("(?=", lead) || pattern.startsWith("(?!", lead) || pattern.startsWith("(?<=", lead) || pattern.startsWith("(?<!", lead)) violations.push("LEADING_LOOKAROUND");
	if (startsWithUnboundedWildcard(pattern.slice(lead))) violations.push("LEADING_UNBOUNDED_WILDCARD");
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === "[") { i = classEnd(pattern, i); continue; }
		if (pattern[i] === "\\") { i++; continue; }
		if (!pattern.startsWith("(?<=", i) && !pattern.startsWith("(?<!", i)) continue;
		const end = groupEnd(pattern, i);
		const body = pattern.slice(i + 4, end);
		if (hasUnboundedQuantifier(body) && literalProbe(pattern.slice(0, i)) === null) {
			violations.push("UNBOUNDED_LOOKBEHIND_WITHOUT_LITERAL");
		}
		i = end;
	}
	return [...new Set(violations)];
}

export function failsNearMissBudget(times: readonly number[]): boolean {
	if (times.length < 3) return true;
	const at8k = times[times.length - 2];
	const at16k = times[times.length - 1];
	if (!Number.isFinite(at8k) || !Number.isFinite(at16k)) return true;
	return at16k > NEAR_MISS_FLOOR_MS && at16k / Math.max(at8k, 0.01) > NEAR_MISS_RATIO;
}

export function failsSingleCheckCeiling(times: readonly number[]): boolean {
	if (times.length === 0) return true;
	const at16k = times[times.length - 1];
	if (!Number.isFinite(at16k)) return true;
	return at16k > SINGLE_CHECK_CEILING_MS;
}

export function failsStreamBudget(totalMs: number, budgetMs: number = STREAM_BUDGET_MS): boolean {
	return !Number.isFinite(totalMs) || !Number.isFinite(budgetMs) || totalMs > budgetMs;
}

export type TrackingRow = { rule: string; condition_index: number; pattern_sha256: string; ms: number };
export type TrackingVerdict = {
	/** NOT_NEEDED: the stream passes without scaling (or fails anyway), so the reference bought nothing. */
	status: "OK" | "NOT_NEEDED" | "DIVERGED" | "UNVERIFIED";
	reason?: "REFERENCE_TRACKING_DIVERGED" | "REFERENCE_TRACKING_UNVERIFIED";
	message?: string;
	/** Matched conditions' current medians over their calibration-run medians; null without a usable match. */
	mix_ratio: number | null;
	matched_conditions: number;
	matched_baseline_ms: number;
	band: number;
};

/** Compare the unchanged rules' own slowdown with the reference ratio. Conditions match the calibration baseline only
 * by rule, index and pattern hash, so new or edited (possibly slow) rules never count as host slowdown. */
export function judgeTracking(now: readonly TrackingRow[], baseline: readonly TrackingRow[] | undefined, referenceRatio: number | null, needed: boolean): TrackingVerdict {
	const baselineMs = new Map((baseline ?? []).map(row => [row.rule + "#" + row.condition_index + "#" + row.pattern_sha256, row.ms]));
	let nowMs = 0;
	let matchedBaselineMs = 0;
	let matched = 0;
	for (const row of now) {
		const base = baselineMs.get(row.rule + "#" + row.condition_index + "#" + row.pattern_sha256);
		if (base === undefined || !Number.isFinite(row.ms) || !Number.isFinite(base)) continue;
		nowMs += row.ms;
		matchedBaselineMs += base;
		matched++;
	}
	const mixRatio = matchedBaselineMs > 0 ? nowMs / matchedBaselineMs : null;
	const verdict = { mix_ratio: mixRatio, matched_conditions: matched, matched_baseline_ms: matchedBaselineMs, band: TRACKING_BAND };
	if (!needed) return { status: "NOT_NEEDED", ...verdict };
	if (mixRatio === null || mixRatio <= 0 || matchedBaselineMs < MIN_TRACKING_BASELINE_MS || referenceRatio === null || !(referenceRatio > 0))
		return { status: "UNVERIFIED", reason: "REFERENCE_TRACKING_UNVERIFIED", message: "scaling decides this stream but only " + matchedBaselineMs.toFixed(1) + "ms of calibrated rules matched (need " + MIN_TRACKING_BASELINE_MS + "ms)", ...verdict };
	const divergence = Math.max(mixRatio / referenceRatio, referenceRatio / mixRatio);
	if (divergence > TRACKING_BAND)
		return { status: "DIVERGED", reason: "REFERENCE_TRACKING_DIVERGED", message: "rule-mix ratio " + mixRatio.toFixed(2) + " and reference ratio " + referenceRatio.toFixed(2) + " differ " + divergence.toFixed(2) + "x (band " + TRACKING_BAND + "x)", ...verdict };
	return { status: "OK", ...verdict };
}
export type ReferenceVerdict = {
	status: "OK" | "FAIL" | "INCONCLUSIVE";
	reason?: "REFERENCE_MISSING" | "REFERENCE_NAN" | "REFERENCE_ZERO" | "REFERENCE_CALIBRATION_INVALID" | "REFERENCE_RATIO_ABOVE_CLAMP";
	message?: string;
	/** Median over gate samples of each sample's mean reference sweep. */
	ref_now_ms: number | null;
	ref_calibrated_ms: number | null;
	ratio: number | null;
	/** Budget multiplier: clamp(ratio, 1, REFERENCE_RATIO_CLAMP) when judged, else 1 (an unjudged host earns no extra budget). */
	scale: number;
};

/** Judge per-sample reference means against the calibrated reference. Missing, NaN or non-positive timings fail closed;
 * a ratio beyond the clamp is INCONCLUSIVE; a ratio below 1 clamps to 1 so a fast host keeps exactly the base budget. */
export function judgeReference(sampleRefMs: readonly (number | null | undefined)[], calibratedMs: number | null | undefined): ReferenceVerdict {
	const unjudged = (reason: NonNullable<ReferenceVerdict["reason"]>, message: string): ReferenceVerdict => ({ status: "FAIL", reason, message, ref_now_ms: null, ref_calibrated_ms: typeof calibratedMs === "number" ? calibratedMs : null, ratio: null, scale: 1 });
	if (sampleRefMs.length === 0 || sampleRefMs.some(value => value === undefined || value === null)) return unjudged("REFERENCE_MISSING", "a gate sample has no reference timing");
	const samples = sampleRefMs as readonly number[];
	if (samples.some(value => !Number.isFinite(value))) return unjudged("REFERENCE_NAN", "a reference timing is not a finite number");
	if (samples.some(value => value <= 0)) return unjudged("REFERENCE_ZERO", "a reference timing is 0 ms or less");
	if (typeof calibratedMs !== "number" || !Number.isFinite(calibratedMs) || calibratedMs <= 0) return unjudged("REFERENCE_CALIBRATION_INVALID", "ref_calibrated_ms is missing or not a positive number");
	const ordered = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	const refNow = ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
	const ratio = refNow / calibratedMs;
	if (ratio > REFERENCE_RATIO_CLAMP) return { status: "INCONCLUSIVE", reason: "REFERENCE_RATIO_ABOVE_CLAMP", message: "reference ratio " + ratio.toFixed(2) + " exceeds " + REFERENCE_RATIO_CLAMP + "; this host is too slow to judge", ref_now_ms: refNow, ref_calibrated_ms: calibratedMs, ratio, scale: 1 };
	return { status: "OK", ref_now_ms: refNow, ref_calibrated_ms: calibratedMs, ratio, scale: Math.max(1, ratio) };
}

/** Return the median only when at least five finite timings were observed. */
export function medianMs(samples: readonly number[]): number {
	if (samples.length < TIMING_SAMPLE_COUNT || samples.some(sample => !Number.isFinite(sample))) return Number.POSITIVE_INFINITY;
	const ordered = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function repeatToSize(literal: string, size: number): string {
	if (!literal) literal = "x";
	return literal.repeat(Math.ceil(size / literal.length)).slice(0, size);
}

function rawInput(shape: Shape, size: number, literal: string): string {
	switch (shape) {
		case "single-quote": return "echo '" + "a'".repeat(Math.floor(size / 2));
		case "escaped-double-quote": return 'echo "' + 'a\\"'.repeat(Math.floor(size / 3));
		case "backslash": return "echo " + "\\".repeat(size);
		case "space": return "echo" + " x".repeat(Math.floor(size / 2));
		case "semicolon": return ";".repeat(size);
		case "newline": return "echo x\n".repeat(Math.floor(size / 7));
		case "literal": return repeatToSize(literal, size);
	}
}

function measureRegex(re: RegExp, input: string): { ms: number; matched: boolean } {
	re.lastIndex = 0;
	const start = performance.now();
	const matched = re.test(input);
	return { ms: performance.now() - start, matched };
}

/** Test every 16-byte accumulated prefix of a live-stream wire: the same sweep for the bash stream and the write/edit stream. */
function measureStreamWire(re: RegExp, wire: string): { ms: number; deltas: number } {
	const start = performance.now();
	let deltas = 0;
	for (let end = 16; end <= wire.length; end += 16) {
		measureRegex(re, wire.slice(0, end));
		deltas++;
	}
	if (wire.length % 16 !== 0) {
		measureRegex(re, wire);
		deltas++;
	}
	return { ms: performance.now() - start, deltas };
}

async function workerMain(): Promise<void> {
	const payloadIndex = process.argv.indexOf("--regex-budget-worker") + 1;
	try {
		const request = JSON.parse(Buffer.from(process.argv[payloadIndex] ?? "", "base64").toString("utf8")) as WorkerRequest;
		// OMP_SRC is selected from the installed OMP build at runtime; a static import would pin a version-specific path.
		const ruleModule = await import(path.join(request.ompSource, "capability/rule.ts"));
		const compileRuleCondition = ruleModule.compileRuleCondition as (pattern: string) => RegExp;
		const re = compileRuleCondition(request.pattern);
		const literal = request.literal ?? "x";
		for (const shape of request.shapes) {
			for (const encoding of request.encodings) {
				const ms: number[] = [];
				const load1: number[] = [];
				const matched: boolean[] = [];
				const bytes: number[] = [];
				for (const size of request.sizes) {
					const raw = rawInput(shape, size, literal);
					const input = encoding === "json" ? JSON.stringify({ command: raw }) : raw;
					load1.push(loadavg()[0] ?? Number.NaN);
					const timing = measureRegex(re, input);
					ms.push(timing.ms);
					matched.push(timing.matched);
					bytes.push(Buffer.byteLength(input, "utf8"));
				}
				const sample = { shape, encoding, ms, load1, matched, bytes };
				process.stdout.write(JSON.stringify({ type: "sample", sample }) + "\n");
			}
		}
	// REGEXREF1: the frozen reference is swept in this same worker just before the condition's stream sweeps;
	// the gate spreads such workers through each sample (reference, conditions, reference, ...).
	let referenceMs: number | undefined;
	if (request.reference !== undefined) {
		const referenceRes = request.reference.patterns.map(pattern => compileRuleCondition(pattern));
		process.stderr.write("RX_BUDGET_REFERENCE_START\n");
		referenceMs = 0;
		for (const referenceRe of referenceRes) referenceMs += measureStreamWire(referenceRe, request.reference.wire).ms;
	}
	let streamMs: number | undefined;
	let streamLoad1: number | undefined;
	let streamDeltas: number | undefined;
	let writeEditMs: number | undefined;
	let writeEditLoad1: number | undefined;
	let writeEditDeltas: number | undefined;
	if (request.streamWire !== undefined) {
		process.stderr.write("RX_BUDGET_STREAM_START\n");
		streamLoad1 = loadavg()[0] ?? Number.NaN;
		const sweep = measureStreamWire(re, request.streamWire);
		streamMs = sweep.ms;
		streamDeltas = sweep.deltas;
	}
	if (request.writeEditWire !== undefined) {
		process.stderr.write("RX_BUDGET_STREAM_START\n");
		writeEditLoad1 = loadavg()[0] ?? Number.NaN;
		const sweep = measureStreamWire(re, request.writeEditWire);
		writeEditMs = sweep.ms;
		writeEditDeltas = sweep.deltas;
	}
	process.stdout.write(JSON.stringify({ type: "complete", streamMs, streamLoad1, streamDeltas, writeEditMs, writeEditLoad1, writeEditDeltas, referenceMs }) + "\n");
	} catch (error) {
		process.stdout.write(JSON.stringify({ type: "error", error: String(error) }) + "\n");
	}
}

type WorkerSummary = { samples: WorkerSample[]; complete: boolean; streamMs?: number; streamLoad1?: number; streamDeltas?: number; writeEditMs?: number; writeEditLoad1?: number; writeEditDeltas?: number; referenceMs?: number; error?: string };

function parseWorkerOutput(stdout: string): WorkerSummary {
	const summary: WorkerSummary = { samples: [], complete: false };
	for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "sample" && event.sample && typeof event.sample === "object") summary.samples.push(event.sample as WorkerSample);
			else if (event.type === "complete") {
			summary.complete = true;
			if (typeof event.streamMs === "number") summary.streamMs = event.streamMs;
			if (typeof event.streamLoad1 === "number") summary.streamLoad1 = event.streamLoad1;
			if (typeof event.streamDeltas === "number") summary.streamDeltas = event.streamDeltas;
			if (typeof event.writeEditMs === "number") summary.writeEditMs = event.writeEditMs;
			if (typeof event.writeEditLoad1 === "number") summary.writeEditLoad1 = event.writeEditLoad1;
			if (typeof event.writeEditDeltas === "number") summary.writeEditDeltas = event.writeEditDeltas;
			// JSON turns a NaN timing into null; keep it NaN so the gate fails it closed instead of dropping it.
			if ("referenceMs" in event) summary.referenceMs = typeof event.referenceMs === "number" ? event.referenceMs : Number.NaN;
		} else if (event.type === "error") summary.error = String(event.error ?? "worker error");
		} catch { /* Ignore non-JSON diagnostics; retain completed sample events. */ }
	}
	return summary;
}

/** Only the atomic universal matcher with discriminator-bearing write/edit scopes below scratch. */
function isScratchScopedMatchAny(pattern: string, scope: readonly string[] | undefined): boolean {
	if (pattern !== "[\\s\\S]" || !scope?.length) return false;
	return scope.every(token => {
		const prefix = token.startsWith("tool:write(") ? "tool:write("
			: token.startsWith("tool:edit(") ? "tool:edit("
			: undefined;
		if (!prefix || !token.endsWith(")")) return false;
		const segments = token.slice(prefix.length, -1).split("/");
		if (segments.includes(".") || segments.includes("..")) return false;
		let scratchRoot = -1;
		for (let index = 0; index + 1 < segments.length; index++) {
			if (segments[index] === "var" && segments[index + 1] === "agent-tmp") {
				scratchRoot = index;
				break;
			}
		}
		if (scratchRoot < 0) return false;
		// Wildcard syntax alone is too broad; require a literal path discriminator below scratch.
		for (const character of segments.slice(scratchRoot + 2).join("/")) {
			if (!"/*?[]{},".includes(character)) return true;
		}
		return false;
	});
}

/** A vacuous content condition needs no content literal: exact `(?s).+` matches
 * everything in O(n) (greedy scan succeeds at the first position; empty input
 * fails in O(1)), so a literal prefilter can never reject anything and only adds
 * work. Admission must still come from tool calls: every scope token is a
 * tool:edit/write route, otherwise the exemption does not apply. */
function isVacuousContentWithToolScope(pattern: string, scope: readonly string[] | undefined): boolean {
	if (pattern !== "(?s).+" || !scope?.length) return false;
	return scope.every(token =>
		(token.startsWith("tool:write(") || token.startsWith("tool:edit(")) && token.endsWith(")"));
}

/** The live stream fixture represents tool:bash; path-scoped file rules do not run on it. */
function appliesToBashStream(scope: readonly string[] | undefined): boolean {
	return !scope?.length || scope.includes("tool:bash");
}

/** The write/edit stream fixture represents file-write content; bash-only rules do not run on it. */
export function appliesToWriteEditStream(scope: readonly string[] | undefined): boolean {
	return !!scope?.some(token => token.startsWith("tool:write(") || token.startsWith("tool:edit("));
}

export function failsWriteEditStreamBudget(totalMs: number, budgetMs: number = WRITE_EDIT_STREAM_BUDGET_MS): boolean {
	return !Number.isFinite(totalMs) || !Number.isFinite(budgetMs) || totalMs > budgetMs;
}

/** Encode file-write content as the write/edit live-stream wire: a synthetic write/edit tool-call payload swept in 16-byte prefixes, like the bash stream wire. */
export function buildWriteEditWire(content: string): string {
	return JSON.stringify({ path: "src/rx-write-edit-probe.ts", content });
}

export async function measureCondition(input: {
	rule: string;
	conditionIndex: number;
	pattern: string;
	scope?: readonly string[];
} & MeasureOptions): Promise<ConditionMeasurement> {
	const literal = literalProbe(input.pattern);
	const request: WorkerRequest = {
		rule: input.rule,
		conditionIndex: input.conditionIndex,
		pattern: input.pattern,
		literal,
		sizes: [...(input.sizes ?? DEFAULT_SIZES)],
		shapes: [...(input.shapes ?? DEFAULT_SHAPES)],
		encodings: [...(input.encodings ?? DEFAULT_ENCODINGS)],
		...(input.streamWire === undefined || !appliesToBashStream(input.scope) ? {} : { streamWire: input.streamWire }),
		...(input.writeEditWire === undefined || !appliesToWriteEditStream(input.scope) ? {} : { writeEditWire: input.writeEditWire }),
		...(input.reference === undefined ? {} : { reference: input.reference }),
		ompSource: OMP_SRC,
	};
	const payload = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
	const child = Bun.spawn([process.execPath, import.meta.path, "--regex-budget-worker", payload], {
		cwd: KIT,
		env: { ...process.env, OMP_SRC, OMP_BIN: process.env.OMP_BIN ?? "omp" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	let timedOut = false;
	const timeoutMs = input.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
	const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
	const exitCode = await child.exited;
	clearTimeout(timer);
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	const result = parseWorkerOutput(stdout);
	const samples: ProbeSample[] = result.samples.map(sample => ({
		shape: sample.shape,
		encoding: sample.encoding,
		ms: sample.ms,
		sample_ms: [sample.ms],
		sample_load1: [sample.load1],
		matched: sample.matched,
		bytes: sample.bytes,
	}));
	const failures: MeasurementFailure[] = [];
	// Only the proven atomic scoped case and the proven vacuous-content case skip the
	// literal precondition; timing checks still run.
	if (!literal && !isScratchScopedMatchAny(input.pattern, input.scope) && !isVacuousContentWithToolScope(input.pattern, input.scope)) failures.push({ code: "NO_REQUIRED_LITERAL_PROBE", message: "no consuming literal found for rule=" + input.rule + " condition=" + input.conditionIndex });
	for (const sample of samples) {
		if (failsNearMissBudget(sample.ms)) {
			const ratio = sample.ms[sample.ms.length - 1] / Math.max(sample.ms[sample.ms.length - 2], 0.01);
			failures.push({ code: "NEAR_MISS_SUPERQUADRATIC", shape: sample.shape, encoding: sample.encoding, message: "rule=" + input.rule + " condition=" + input.conditionIndex + " shape=" + sample.shape + " encoding=" + sample.encoding + " 8k-to-16k=" + ratio.toFixed(2) + "x, 16k=" + sample.ms[sample.ms.length - 1].toFixed(2) + "ms" });
		}
		if (failsSingleCheckCeiling(sample.ms)) {
			failures.push({ code: "SINGLE_CHECK_CEILING", shape: sample.shape, encoding: sample.encoding, message: "rule=" + input.rule + " condition=" + input.conditionIndex + " shape=" + sample.shape + " encoding=" + sample.encoding + " 16k=" + sample.ms[sample.ms.length - 1].toFixed(2) + "ms exceeds " + SINGLE_CHECK_CEILING_MS + "ms single-check ceiling" });
		}
	}
	if (timedOut) {
		// The last phase marker names where the worker was when it was killed.
		const streamAt = stderr.lastIndexOf("RX_BUDGET_STREAM_START");
		const referenceAt = stderr.lastIndexOf("RX_BUDGET_REFERENCE_START");
		const timeoutCode = referenceAt > streamAt ? "REFERENCE_TIMEOUT" : streamAt >= 0 ? "STREAM_TIMEOUT" : "NEAR_MISS_TIMEOUT";
		const phase = timeoutCode === "REFERENCE_TIMEOUT" ? "reference" : timeoutCode === "STREAM_TIMEOUT" ? "stream" : "near-miss";
		failures.push({ code: timeoutCode, message: "worker exceeded " + timeoutMs + "ms during " + phase + "; rule=" + input.rule + " condition=" + input.conditionIndex });
		return { rule: input.rule, condition_index: input.conditionIndex, status: "TIMEOUT", literal, samples, failures };
	}
	if (result.error || !result.complete || exitCode !== 0) {
		failures.push({ code: "REGEX_COMPILE_ERROR", message: result.error ?? (stderr || "worker exited " + exitCode + " without a completion record") });
		return { rule: input.rule, condition_index: input.conditionIndex, status: "COMPILE_ERROR", literal, samples, failures };
	}
	return {
		rule: input.rule,
		condition_index: input.conditionIndex,
		status: "MEASURED",
		literal,
		samples,
		...(typeof result.streamMs === "number" ? { stream_ms: result.streamMs, sample_stream_ms: [result.streamMs] } : {}),
		...(typeof result.streamLoad1 === "number" ? { sample_stream_load1: [result.streamLoad1] } : {}),
		...(typeof result.streamDeltas === "number" ? { stream_deltas: result.streamDeltas } : {}),
		...(typeof result.writeEditMs === "number" ? { write_edit_ms: result.writeEditMs, sample_write_edit_ms: [result.writeEditMs] } : {}),
		...(typeof result.writeEditLoad1 === "number" ? { sample_write_edit_load1: [result.writeEditLoad1] } : {}),
		...(typeof result.writeEditDeltas === "number" ? { write_edit_deltas: result.writeEditDeltas } : {}),
		...(result.referenceMs !== undefined ? { reference_ms: result.referenceMs } : {}),
		failures,
	};
}

type StreamSection = {
	complete: boolean;
	file: string;
	wire_bytes: number;
	chunk_bytes: number;
	deltas: number;
	total_ms: number;
	budget_ms: number;
	sample_total_ms: number[];
	sample_load1: number[];
	by_rule: Array<{ rule: string; condition_index: number; ms: number; sample_ms: number[]; sample_load1: number[] }>;
	tracking: TrackingVerdict;
};
/** Budget scaling evidence; sample_ref_ms[i] is the mean of every reference sweep in gate sample i. */
type ReferenceSection = ReferenceVerdict & { file: string; wire_bytes: number | null; sample_ref_ms: Array<number | null>; load_error?: string };
type GateReport = {
	status: "PASS" | "FAIL" | "INCONCLUSIVE";
	timing_samples: number;
	engine: { bun: string; omp_source: string };
	load_average_before: number[];
	load_average_after: number[];
	rules_loaded: number;
	conditions_measured: number;
	reference: ReferenceSection;
	stream: StreamSection;
	write_edit: StreamSection;
	measurements: ConditionMeasurement[];
	lint_violations: Array<{ rule: string; condition_index: number; code: string; pattern: string }>;
	gate_elapsed_ms: number;
};

export type LoadedReference = { file: string; reference?: StreamReference; calibratedMs?: number; baseline?: { live: TrackingRow[]; write_edit: TrackingRow[] }; wireBytes: number | null; loadError?: string };

function baselineRows(value: unknown): TrackingRow[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const rows: TrackingRow[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object" || !("rule" in row) || !("condition_index" in row) || !("pattern_sha256" in row) || !("ms" in row)) return undefined;
		if (typeof row.rule !== "string" || typeof row.condition_index !== "number" || typeof row.pattern_sha256 !== "string" || typeof row.ms !== "number" || !Number.isFinite(row.ms)) return undefined;
		rows.push({ rule: row.rule, condition_index: row.condition_index, pattern_sha256: row.pattern_sha256, ms: row.ms });
	}
	return rows;
}

/** Read the frozen reference fixture. A missing or malformed fixture yields no reference, which fails the gate as REFERENCE_MISSING;
 * a missing or malformed rule baseline only leaves tracking UNVERIFIED, so scaling can never decide a PASS without it. */
export function loadReference(file: string = DEFAULT_REFERENCE_FILE): LoadedReference {
	try {
		const fixture = JSON.parse(readFileSync(file, "utf8")) as { conditions?: unknown; wire_file?: unknown; ref_calibrated_ms?: unknown; rule_baseline?: { live?: unknown; write_edit?: unknown } };
		const conditions = Array.isArray(fixture.conditions) ? fixture.conditions as Array<{ pattern?: unknown }> : [];
		const patterns = conditions.map(condition => typeof condition?.pattern === "string" ? condition.pattern : "");
		if (!patterns.length || patterns.some(pattern => !pattern)) throw new Error("reference conditions must list non-empty patterns");
		if (typeof fixture.wire_file !== "string" || !fixture.wire_file) throw new Error("reference wire_file is missing");
		const wire = JSON.stringify({ command: readFileSync(path.resolve(path.dirname(file), fixture.wire_file), "utf8") });
		const live = baselineRows(fixture.rule_baseline?.live);
		const writeEdit = baselineRows(fixture.rule_baseline?.write_edit);
		return {
			file,
			reference: { patterns, wire },
			calibratedMs: typeof fixture.ref_calibrated_ms === "number" ? fixture.ref_calibrated_ms : undefined,
			...(live && writeEdit ? { baseline: { live, write_edit: writeEdit } } : {}),
			wireBytes: Buffer.byteLength(wire, "utf8"),
		};
	} catch (error) {
		return { file, wireBytes: null, loadError: String(error) };
	}
}

function referenceSection(loaded: LoadedReference, sampleRefMs: Array<number | null>): ReferenceSection {
	const verdict = judgeReference(sampleRefMs, loaded.calibratedMs);
	return {
		...verdict,
		...(loaded.loadError && verdict.reason === "REFERENCE_MISSING" ? { message: "reference fixture unusable: " + loaded.loadError } : {}),
		file: loaded.file,
		wire_bytes: loaded.wireBytes,
		sample_ref_ms: sampleRefMs,
		...(loaded.loadError ? { load_error: loaded.loadError } : {}),
	};
}

/** Tracking evidence for one stream; it is needed only when the scaled budget, not the base budget, lets the stream pass. */
function streamTracking(measurements: readonly ConditionMeasurement[], field: "stream_ms" | "write_edit_ms", baseline: readonly TrackingRow[] | undefined, reference: ReferenceVerdict, totalMs: number, baseBudgetMs: number): TrackingVerdict {
	const rows = measurements.flatMap(measurement => {
		const ms = measurement[field];
		return typeof ms === "number" && measurement.pattern_sha256 ? [{ rule: measurement.rule, condition_index: measurement.condition_index, pattern_sha256: measurement.pattern_sha256, ms }] : [];
	});
	const needed = reference.status === "OK" && totalMs > baseBudgetMs && totalMs <= baseBudgetMs * reference.scale;
	return judgeTracking(rows, baseline, reference.ratio, needed);
}

/** Named rule failures stand on any host; an unusable reference fails closed; a too-slow host is INCONCLUSIVE; both
 * streams are judged against the scaled budget; a pass that only scaling allows needs the reference to track the rules. */
function gateStatus(ruleFailed: boolean, reference: ReferenceVerdict, stream: StreamSection, writeEdit: StreamSection): GateReport["status"] {
	if (ruleFailed || reference.status === "FAIL") return "FAIL";
	if (reference.status === "INCONCLUSIVE") return "INCONCLUSIVE";
	if (failsStreamBudget(stream.total_ms, stream.budget_ms) || failsWriteEditStreamBudget(writeEdit.total_ms, writeEdit.budget_ms)) return "FAIL";
	if ([stream.tracking, writeEdit.tracking].some(tracking => tracking.status === "DIVERGED" || tracking.status === "UNVERIFIED")) return "INCONCLUSIVE";
	return "PASS";
}

async function runGateSample(rulesDir: string, streamFile: string, writeEditStreamFile: string, reference: LoadedReference, streamSeam?: (rule: string, conditionIndex: number, measuredMs: number) => number): Promise<GateReport> {
	const started = performance.now();
	const deadline = Date.now() + GATE_DEADLINE_MS;
	const before = loadavg();
	const loaded: LoadedRule[] = loadRules(rulesDir);
	const rules = loaded.flatMap(item => (item.rule.condition ?? []).filter((condition): condition is string => typeof condition === "string" && condition.length > 0).map((pattern, conditionIndex) => ({ rule: item.name, conditionIndex, pattern, scope: item.rule.scope ?? [] })));
	const lintViolations: GateReport["lint_violations"] = [];
	for (const condition of rules) {
		// Time every condition; literal-first lint is specific to streamed Bash arguments.
		if (!condition.scope.includes("tool:bash")) continue;
		for (const code of lintCondition(condition.pattern)) lintViolations.push({ rule: condition.rule, condition_index: condition.conditionIndex, code, pattern: condition.pattern });
	}
	const command = readFileSync(streamFile, "utf8");
	const streamWire = JSON.stringify({ command });
	const writeEditContent = readFileSync(writeEditStreamFile, "utf8");
	const writeEditWire = buildWriteEditWire(writeEditContent);
	const measurements: ConditionMeasurement[] = [];
	// Every stride-th worker carries one reference sweep, so about REFERENCE_SWEEPS_PER_SAMPLE sweeps spread across the sample.
	const referenceStride = Math.max(1, Math.ceil(rules.length / REFERENCE_SWEEPS_PER_SAMPLE));
	for (const [index, condition] of rules.entries()) {
		const remaining = deadline - Date.now();
		if (remaining < 1000) {
			measurements.push({ rule: condition.rule, condition_index: condition.conditionIndex, status: "GATE_TIMEOUT", literal: literalProbe(condition.pattern), samples: [], failures: [{ code: "GATE_TIMEOUT", message: "overall RX1 budget exceeded; rule=" + condition.rule + " condition=" + condition.conditionIndex }] });
			continue;
		}
		const measurement = await measureCondition({
			rule: condition.rule,
			conditionIndex: condition.conditionIndex,
			pattern: condition.pattern,
			scope: condition.scope,
			streamWire,
			writeEditWire,
			...(reference.reference && index % referenceStride === 0 ? { reference: reference.reference } : {}),
			workerTimeoutMs: Math.min(DEFAULT_WORKER_TIMEOUT_MS, remaining - 500),
		});
		const streamMs = streamSeam && typeof measurement.stream_ms === "number" ? streamSeam(condition.rule, condition.conditionIndex, measurement.stream_ms) : measurement.stream_ms;
		// The pattern hash matches this condition to its calibration-run baseline for the tracking guard.
		measurements.push({
			...measurement,
			...(streamMs === undefined ? {} : { stream_ms: streamMs, sample_stream_ms: [streamMs] }),
			pattern_sha256: createHash("sha256").update(condition.pattern).digest("hex"),
		});
	}
	const byRule = measurements.filter(measurement => typeof measurement.stream_ms === "number").map(measurement => ({
		rule: measurement.rule,
		condition_index: measurement.condition_index,
		ms: measurement.stream_ms!,
		sample_ms: measurement.sample_stream_ms ?? [],
		sample_load1: measurement.sample_stream_load1 ?? [],
	}));
	const streamTotal = byRule.reduce((sum, item) => sum + item.ms, 0);
	const streamConditions = rules.filter(condition => appliesToBashStream(condition.scope)).length;
	const streamComplete = byRule.length === streamConditions;
	const writeEditByRule = measurements.filter(measurement => typeof measurement.write_edit_ms === "number").map(measurement => ({
		rule: measurement.rule,
		condition_index: measurement.condition_index,
		ms: measurement.write_edit_ms!,
		sample_ms: measurement.sample_write_edit_ms ?? [],
		sample_load1: measurement.sample_write_edit_load1 ?? [],
	}));
	const writeEditTotal = writeEditByRule.reduce((sum, item) => sum + item.ms, 0);
	const writeEditConditions = rules.filter(condition => appliesToWriteEditStream(condition.scope)).length;
	const writeEditComplete = writeEditByRule.length === writeEditConditions;
	const ruleFailed = rules.length === 0 || !streamComplete || !writeEditComplete || lintViolations.length > 0 || measurements.some(measurement => measurement.status !== "MEASURED" || measurement.failures.length > 0);
	// The sample's reference is the mean of its spread reference sweeps.
	const referenceTimings = measurements.flatMap(measurement => measurement.reference_ms === undefined ? [] : [measurement.reference_ms]);
	const sampleRef = referenceTimings.length ? referenceTimings.reduce((sum, value) => sum + value, 0) / referenceTimings.length : null;
	const referenceReport = referenceSection(reference, [sampleRef]);
	const after = loadavg();
	const stream: StreamSection = {
		complete: streamComplete,
		file: streamFile,
		wire_bytes: Buffer.byteLength(streamWire, "utf8"),
		chunk_bytes: 16,
		deltas: byRule.length ? (measurements.find(measurement => measurement.stream_deltas !== undefined)?.stream_deltas ?? 0) : 0,
		total_ms: streamTotal,
		budget_ms: STREAM_BUDGET_MS * referenceReport.scale,
		sample_total_ms: [streamTotal],
		sample_load1: [before[0] ?? Number.NaN],
		by_rule: byRule.sort((left, right) => right.ms - left.ms),
		tracking: streamTracking(measurements, "stream_ms", reference.baseline?.live, referenceReport, streamTotal, STREAM_BUDGET_MS),
	};
	const writeEdit: StreamSection = {
		complete: writeEditComplete,
		file: writeEditStreamFile,
		wire_bytes: Buffer.byteLength(writeEditWire, "utf8"),
		chunk_bytes: 16,
		deltas: writeEditByRule.length ? (measurements.find(measurement => measurement.write_edit_deltas !== undefined)?.write_edit_deltas ?? 0) : 0,
		total_ms: writeEditTotal,
		budget_ms: WRITE_EDIT_STREAM_BUDGET_MS * referenceReport.scale,
		sample_total_ms: [writeEditTotal],
		sample_load1: [before[0] ?? Number.NaN],
		by_rule: writeEditByRule.sort((left, right) => right.ms - left.ms),
		tracking: streamTracking(measurements, "write_edit_ms", reference.baseline?.write_edit, referenceReport, writeEditTotal, WRITE_EDIT_STREAM_BUDGET_MS),
	};
	return {
		status: gateStatus(ruleFailed, referenceReport, stream, writeEdit),
		timing_samples: 1,
		engine: { bun: Bun.version, omp_source: OMP_SRC },
		load_average_before: before,
		load_average_after: after,
		rules_loaded: loaded.length,
		conditions_measured: rules.length,
		reference: referenceReport,
		stream,
		write_edit: writeEdit,
		measurements,
		lint_violations: lintViolations,
		gate_elapsed_ms: performance.now() - started,
	};
}

function summarizeRepeatedReports(reports: readonly GateReport[], reference: LoadedReference): GateReport {
	if (reports.length < TIMING_SAMPLE_COUNT) throw new Error("regex budget requires at least " + TIMING_SAMPLE_COUNT + " interleaved timing samples");
	const first = reports[0]!;
	const measurements = first.measurements.map((firstMeasurement, measurementIndex): ConditionMeasurement => {
		const repeated = reports.map(report => report.measurements[measurementIndex]);
		const status: ConditionMeasurement["status"] = repeated.some(measurement => !measurement)
			? "GATE_TIMEOUT"
			: repeated.find(measurement => measurement!.status !== "MEASURED")?.status ?? "MEASURED";
		const samples = firstMeasurement.samples.map((firstSample, sampleIndex): ProbeSample => {
			const repeatedSamples = repeated.map(measurement => measurement?.samples[sampleIndex]);
			const sample_ms = repeatedSamples.map(sample => sample?.sample_ms[0] ?? sample?.ms ?? []);
			const sample_load1 = repeatedSamples.map(sample => sample?.sample_load1[0] ?? []);
			const ms = firstSample.ms.map((_value, sizeIndex) => medianMs(sample_ms.map(sample => sample[sizeIndex] ?? Number.POSITIVE_INFINITY)));
			return { ...firstSample, ms, sample_ms, sample_load1 };
		});
		const failureMap = new Map<string, MeasurementFailure>();
		for (const measurement of repeated) {
			for (const failure of measurement?.failures ?? []) {
				if (failure.code === "NEAR_MISS_SUPERQUADRATIC" || failure.code === "SINGLE_CHECK_CEILING") continue;
				const key = failure.code + "|" + (failure.shape ?? "") + "|" + (failure.encoding ?? "");
				if (!failureMap.has(key)) failureMap.set(key, failure);
			}
		}
		for (const sample of samples) {
			if (failsNearMissBudget(sample.ms)) {
				const ratio = sample.ms[sample.ms.length - 1]! / Math.max(sample.ms[sample.ms.length - 2]!, 0.01);
				failureMap.set("NEAR_MISS_SUPERQUADRATIC|" + sample.shape + "|" + sample.encoding, {
					code: "NEAR_MISS_SUPERQUADRATIC",
					shape: sample.shape,
					encoding: sample.encoding,
					message: "rule=" + firstMeasurement.rule + " condition=" + firstMeasurement.condition_index + " shape=" + sample.shape + " encoding=" + sample.encoding + " 8k-to-16k=" + ratio.toFixed(2) + "x, 16k=" + sample.ms[sample.ms.length - 1]!.toFixed(2) + "ms",
				});
			}
			if (failsSingleCheckCeiling(sample.ms)) {
				failureMap.set("SINGLE_CHECK_CEILING|" + sample.shape + "|" + sample.encoding, {
					code: "SINGLE_CHECK_CEILING",
					shape: sample.shape,
					encoding: sample.encoding,
					message: "rule=" + firstMeasurement.rule + " condition=" + firstMeasurement.condition_index + " shape=" + sample.shape + " encoding=" + sample.encoding + " 16k=" + sample.ms[sample.ms.length - 1]!.toFixed(2) + "ms exceeds " + SINGLE_CHECK_CEILING_MS + "ms single-check ceiling",
				});
			}
		}
		const streamRuns = repeated.map(measurement => measurement?.sample_stream_ms?.[0] ?? measurement?.stream_ms);
		const hasStream = streamRuns.some(value => typeof value === "number");
		const merged: ConditionMeasurement = {
			rule: firstMeasurement.rule,
			condition_index: firstMeasurement.condition_index,
			status,
			literal: firstMeasurement.literal,
			samples,
			failures: [...failureMap.values()],
			...(firstMeasurement.pattern_sha256 ? { pattern_sha256: firstMeasurement.pattern_sha256 } : {}),
		};
		if (hasStream) {
			const sample_stream_ms = streamRuns.map(value => value ?? Number.POSITIVE_INFINITY);
			merged.sample_stream_ms = sample_stream_ms;
			merged.sample_stream_load1 = repeated.map(measurement => measurement?.sample_stream_load1?.[0] ?? Number.NaN);
			merged.stream_ms = medianMs(sample_stream_ms);
			merged.stream_deltas = firstMeasurement.stream_deltas;
		}
		const writeEditRuns = repeated.map(measurement => measurement?.sample_write_edit_ms?.[0] ?? measurement?.write_edit_ms);
		if (writeEditRuns.some(value => typeof value === "number")) {
			const sample_write_edit_ms = writeEditRuns.map(value => value ?? Number.POSITIVE_INFINITY);
			merged.sample_write_edit_ms = sample_write_edit_ms;
			merged.sample_write_edit_load1 = repeated.map(measurement => measurement?.sample_write_edit_load1?.[0] ?? Number.NaN);
			merged.write_edit_ms = medianMs(sample_write_edit_ms);
			merged.write_edit_deltas = firstMeasurement.write_edit_deltas;
		}
		return merged;
	});
	// The judged total is the sum of the per-rule medians, so by_rule sums to total_ms exactly
	// (apply-plugin refuses a report whose per-rule times do not); sample_total_ms keeps each pass's raw sum.
	const sample_total_ms = reports.map(report => report.stream.total_ms);
	const sample_load1 = reports.map(report => report.stream.sample_load1[0] ?? report.load_average_before[0] ?? Number.NaN);
	const streamComplete = reports.every(report => report.stream.complete);
	const streamByRule = measurements.filter(measurement => typeof measurement.stream_ms === "number").map(measurement => ({
		rule: measurement.rule,
		condition_index: measurement.condition_index,
		ms: measurement.stream_ms!,
		sample_ms: measurement.sample_stream_ms ?? [],
		sample_load1: measurement.sample_stream_load1 ?? [],
	})).sort((left, right) => right.ms - left.ms);
	const total_ms = streamByRule.reduce((sum, item) => sum + item.ms, 0);
	const write_edit_sample_total_ms = reports.map(report => report.write_edit.total_ms);
	const write_edit_sample_load1 = reports.map(report => report.write_edit.sample_load1[0] ?? report.load_average_before[0] ?? Number.NaN);
	const writeEditComplete = reports.every(report => report.write_edit.complete);
	const writeEditByRule = measurements.filter(measurement => typeof measurement.write_edit_ms === "number").map(measurement => ({
		rule: measurement.rule,
		condition_index: measurement.condition_index,
		ms: measurement.write_edit_ms!,
		sample_ms: measurement.sample_write_edit_ms ?? [],
		sample_load1: measurement.sample_write_edit_load1 ?? [],
	})).sort((left, right) => right.ms - left.ms);
	const write_edit_total_ms = writeEditByRule.reduce((sum, item) => sum + item.ms, 0);
	const ruleFailed = first.rules_loaded === 0 || !streamComplete || !writeEditComplete || first.lint_violations.length > 0 || measurements.some(measurement => measurement.status !== "MEASURED" || measurement.failures.length > 0);
	const referenceReport = referenceSection(reference, reports.map(report => report.reference.sample_ref_ms[0] ?? null));
	const stream: StreamSection = {
		...first.stream,
		complete: streamComplete,
		total_ms,
		budget_ms: STREAM_BUDGET_MS * referenceReport.scale,
		sample_total_ms,
		sample_load1,
		by_rule: streamByRule,
		tracking: streamTracking(measurements, "stream_ms", reference.baseline?.live, referenceReport, total_ms, STREAM_BUDGET_MS),
	};
	const writeEdit: StreamSection = {
		...first.write_edit,
		complete: writeEditComplete,
		total_ms: write_edit_total_ms,
		budget_ms: WRITE_EDIT_STREAM_BUDGET_MS * referenceReport.scale,
		sample_total_ms: write_edit_sample_total_ms,
		sample_load1: write_edit_sample_load1,
		by_rule: writeEditByRule,
		tracking: streamTracking(measurements, "write_edit_ms", reference.baseline?.write_edit, referenceReport, write_edit_total_ms, WRITE_EDIT_STREAM_BUDGET_MS),
	};
	return {
		...first,
		status: gateStatus(ruleFailed, referenceReport, stream, writeEdit),
		timing_samples: reports.length,
		gate_elapsed_ms: reports.reduce((sum, report) => sum + report.gate_elapsed_ms, 0),
		reference: referenceReport,
		stream,
		write_edit: writeEdit,
		measurements,
	};
}

export type GateOptions = {
	/** Reference fixture; defaults to the committed DEFAULT_REFERENCE_FILE. */
	referenceFile?: string;
	/** Test seam: replaces each sample's measured reference mean before judging. Not reachable from the CLI. */
	referenceSampleSeam?: (sampleIndex: number, measuredMs: number | null) => number | null | undefined;
	/** Test seam: replaces each condition's measured live-stream time in each sample before judging. Not reachable from the CLI. */
	streamTimingSeam?: (sampleIndex: number, rule: string, conditionIndex: number, measuredMs: number) => number;
};

/** Run every case once per round so samples for each case are separated by a full pass over the others. */
export async function runGate(rulesDir: string, streamFile: string, writeEditStreamFile: string = DEFAULT_WRITE_EDIT_STREAM_FILE, options: GateOptions = {}): Promise<GateReport> {
	const reference = loadReference(options.referenceFile ?? DEFAULT_REFERENCE_FILE);
	const reports: GateReport[] = [];
	for (let sample = 0; sample < TIMING_SAMPLE_COUNT; sample++) {
		const streamSeam = options.streamTimingSeam;
		const report = await runGateSample(rulesDir, streamFile, writeEditStreamFile, reference, streamSeam && ((rule, conditionIndex, measuredMs) => streamSeam(sample, rule, conditionIndex, measuredMs)));
		if (options.referenceSampleSeam) report.reference.sample_ref_ms = [options.referenceSampleSeam(sample, report.reference.sample_ref_ms[0] ?? null) ?? null];
		reports.push(report);
	}
	return summarizeRepeatedReports(reports, reference);
}

/** CLI exit code: 0 PASS, 1 FAIL, INCONCLUSIVE_EXIT_CODE when the host is too slow to judge. */
export function gateExitCode(report: Pick<GateReport, "status">): number {
	return report.status === "PASS" ? 0 : report.status === "INCONCLUSIVE" ? INCONCLUSIVE_EXIT_CODE : 1;
}

/** First report line; INCONCLUSIVE and reference failures carry their named reason. */
export function verdictLine(report: Pick<GateReport, "status" | "reference" | "stream" | "write_edit">): string {
	if (report.status === "INCONCLUSIVE") {
		const cause = report.reference.status === "INCONCLUSIVE" ? report.reference : [report.stream.tracking, report.write_edit.tracking].find(tracking => tracking.reason) ?? report.reference;
		return "REGEX-BUDGET: INCONCLUSIVE " + (cause.reason ?? "") + " (" + (cause.message ?? "") + "; not judged, not PASS)";
	}
	if (report.status === "FAIL" && report.reference.status === "FAIL") return "REGEX-BUDGET: FAIL " + (report.reference.reason ?? "") + " (" + (report.reference.message ?? "") + ")";
	return "REGEX-BUDGET: " + report.status;
}

/** Reference evidence for the summary lines: ref_now, ratio, the budget it yields and the tracking check. */
function referenceSummary(report: GateReport, section: StreamSection): string {
	const ref = report.reference;
	return "ref_now=" + (ref.ref_now_ms === null ? "unknown" : ref.ref_now_ms.toFixed(1) + "ms") + " ref_calibrated=" + (ref.ref_calibrated_ms === null ? "unknown" : ref.ref_calibrated_ms.toFixed(1) + "ms") + " ratio=" + (ref.ratio === null ? "unknown" : ref.ratio.toFixed(2)) + " budget_ms=" + section.budget_ms.toFixed(1)
		+ " tracking=" + section.tracking.status + " mix_ratio=" + (section.tracking.mix_ratio === null ? "unknown" : section.tracking.mix_ratio.toFixed(2)) + " matched=" + section.tracking.matched_conditions;
}

function formatMs(value: number | undefined): string {
	return typeof value === "number" ? value.toFixed(1) : "TIMEOUT";
}

function printReport(report: GateReport): void {
	console.log(verdictLine(report));
	console.log("Bun=" + report.engine.bun + " OMP_SRC=" + report.engine.omp_source);
	console.log("loadavg before=" + report.load_average_before.map(n => n.toFixed(2)).join(",") + " after=" + report.load_average_after.map(n => n.toFixed(2)).join(","));
	console.log("rules=" + report.rules_loaded + " regex-conditions=" + report.conditions_measured + " elapsed=" + report.gate_elapsed_ms.toFixed(1) + "ms");
	console.log("timing samples=" + report.timing_samples + " round-robin passes; JSON sample_ms and sample_load1 rows align by run and size");
	console.log("near-miss failures (median 8K→16K ratio >2.6 and median 16K >5ms):");
	console.log("rule | condition | worst shape/encoding | median 4K ms | median 8K ms | median 16K ms | ratio");
	const rows: Array<{ rule: string; condition: number; shape: string; encoding: string; ms: number[]; ratio: number }> = [];
	for (const measurement of report.measurements) {
		for (const sample of measurement.samples) {
			if (failsNearMissBudget(sample.ms)) rows.push({ rule: measurement.rule, condition: measurement.condition_index, shape: sample.shape, encoding: sample.encoding, ms: sample.ms, ratio: sample.ms[2] / Math.max(sample.ms[1], 0.01) });
		}
	}
	if (!rows.length) console.log("(none)");
	for (const row of rows.sort((a, b) => b.ms[2] - a.ms[2])) console.log(row.rule + " | " + row.condition + " | " + row.shape + "/" + row.encoding + " | " + formatMs(row.ms[0]) + " | " + formatMs(row.ms[1]) + " | " + formatMs(row.ms[2]) + " | " + row.ratio.toFixed(2) + "x");

	console.log("single-check ceiling failures (median 16K >" + SINGLE_CHECK_CEILING_MS + "ms):");
	console.log("rule | condition | worst shape/encoding | median 16K ms");
	const ceilingRows: Array<{ rule: string; condition: number; shape: string; encoding: string; ms: number }> = [];
	for (const measurement of report.measurements) {
		for (const sample of measurement.samples) {
			if (failsSingleCheckCeiling(sample.ms)) ceilingRows.push({ rule: measurement.rule, condition: measurement.condition_index, shape: sample.shape, encoding: sample.encoding, ms: sample.ms[sample.ms.length - 1] });
		}
	}
	if (!ceilingRows.length) console.log("(none)");
	for (const row of ceilingRows.sort((a, b) => b.ms - a.ms)) console.log(row.rule + " | " + row.condition + " | " + row.shape + "/" + row.encoding + " | " + formatMs(row.ms));
	console.log("measurement timeouts:");
	const timeouts = report.measurements.filter(measurement => measurement.status !== "MEASURED");
	if (!timeouts.length) console.log("(none)");
	for (const measurement of timeouts) console.log(measurement.rule + "#" + measurement.condition_index + " | " + measurement.status + " | " + measurement.failures.map(failure => failure.code).join(","));
	console.log("structural lint:");
	if (!report.lint_violations.length) console.log("(none)");
	for (const violation of report.lint_violations) console.log(violation.rule + "#" + violation.condition_index + " | " + violation.code + " | " + violation.pattern);
	const reference = report.reference;
	const referenceSamples = reference.sample_ref_ms.map((ms, index) => (typeof ms === "number" ? ms.toFixed(1) + "ms" : "missing") + "@load1=" + (report.stream.sample_load1[index]?.toFixed(2) ?? "unknown"));
	console.log("stream reference: " + reference.status + (reference.reason ? " " + reference.reason : "") + " file=" + reference.file + " wire=" + (reference.wire_bytes ?? "unknown") + "B clamp=[1," + REFERENCE_RATIO_CLAMP + "] samples=[" + referenceSamples.join(", ") + "]" + (reference.message ? " (" + reference.message + ")" : ""));
	const sectionStatus = (section: StreamSection, fails: (total: number, budget: number) => boolean) => !section.complete ? "INCOMPLETE" : reference.status !== "OK" ? reference.status : fails(section.total_ms, section.budget_ms) ? "FAIL" : section.tracking.status === "DIVERGED" || section.tracking.status === "UNVERIFIED" ? "INCONCLUSIVE" : "PASS";
	const streamStatus = sectionStatus(report.stream, failsStreamBudget);
	const streamSamples = report.stream.sample_total_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (report.stream.sample_load1[index]?.toFixed(2) ?? "unknown"));
	console.log("live stream: " + streamStatus + " file=" + report.stream.file + " wire=" + report.stream.wire_bytes + "B chunk=" + report.stream.chunk_bytes + "B deltas/condition=" + report.stream.deltas + " median=" + report.stream.total_ms.toFixed(1) + "ms / " + report.stream.budget_ms.toFixed(1) + "ms " + referenceSummary(report, report.stream) + " samples=[" + streamSamples.join(", ") + "]");
	for (const item of report.stream.by_rule.slice(0, 8)) {
		const samples = item.sample_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (item.sample_load1[index]?.toFixed(2) ?? "unknown"));
		console.log("stream " + item.rule + "#" + item.condition_index + " | median=" + item.ms.toFixed(1) + "ms samples=[" + samples.join(", ") + "]");
	}
	const writeEditStatus = sectionStatus(report.write_edit, failsWriteEditStreamBudget);
	const writeEditSamples = report.write_edit.sample_total_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (report.write_edit.sample_load1[index]?.toFixed(2) ?? "unknown"));
	console.log("write/edit stream: " + writeEditStatus + " file=" + report.write_edit.file + " wire=" + report.write_edit.wire_bytes + "B chunk=" + report.write_edit.chunk_bytes + "B deltas/condition=" + report.write_edit.deltas + " median=" + report.write_edit.total_ms.toFixed(1) + "ms / " + report.write_edit.budget_ms.toFixed(1) + "ms " + referenceSummary(report, report.write_edit) + " samples=[" + writeEditSamples.join(", ") + "]");
	for (const item of report.write_edit.by_rule.slice(0, 8)) {
		const samples = item.sample_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (item.sample_load1[index]?.toFixed(2) ?? "unknown"));
		console.log("write/edit stream " + item.rule + "#" + item.condition_index + " | median=" + item.ms.toFixed(1) + "ms samples=[" + samples.join(", ") + "]");
	}
	console.log("JSON_REPORT=" + JSON.stringify(report));
	console.log("Scope: measured shapes and this Bun/JSC runtime only; no universal regex-safety claim.");
}

if (process.argv.includes("--regex-budget-worker")) {
	await workerMain();
} else if (import.meta.main) {
	const args = process.argv.slice(2);
	const rulesIndex = args.indexOf("--rules");
	const streamIndex = args.indexOf("--stream");
	const writeEditIndex = args.indexOf("--write-edit-stream");
	const rulesPath = rulesIndex < 0 ? path.join(KIT, "rules") : args[rulesIndex + 1];
	const streamPath = streamIndex < 0 ? path.join(KIT, "scripts/e2e-live.sh") : args[streamIndex + 1];
	const writeEditPath = writeEditIndex < 0 ? DEFAULT_WRITE_EDIT_STREAM_FILE : args[writeEditIndex + 1];
	if (!rulesPath || !streamPath || !writeEditPath || rulesPath.startsWith("--") || streamPath.startsWith("--") || writeEditPath.startsWith("--")) throw new Error("--rules, --stream, and --write-edit-stream require a path");
	const rulesDir = path.resolve(rulesPath);
	const streamFile = path.resolve(streamPath);
	const writeEditStreamFile = path.resolve(writeEditPath);
	try {
		const report = await runGate(rulesDir, streamFile, writeEditStreamFile);
		printReport(report);
		process.exitCode = gateExitCode(report);
	} catch (error) {
		console.error("REGEX-BUDGET: FAIL");
		console.error(String(error));
		process.exitCode = 1;
	}
}
