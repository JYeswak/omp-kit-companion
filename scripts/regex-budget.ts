#!/usr/bin/env bun
/**
 * regex-budget.ts — bounded Bun/JSC measurements for omp rule conditions.
 *
 * Every condition is parsed by the kit's omp-backed rule loader and compiled with
 * omp's compileRuleCondition. A child process contains synchronous regex stalls.
 */
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
const STREAM_BUDGET_MS = 500;
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
	ompSource: string;
};
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
	failures: MeasurementFailure[];
};
export type MeasureOptions = {
	sizes?: readonly number[];
	shapes?: readonly Shape[];
	encodings?: readonly Encoding[];
	streamWire?: string;
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

export function failsStreamBudget(totalMs: number): boolean {
	return !Number.isFinite(totalMs) || totalMs > STREAM_BUDGET_MS;
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
		let streamMs: number | undefined;
		let streamLoad1: number | undefined;
		let streamDeltas: number | undefined;
		if (request.streamWire !== undefined) {
			process.stderr.write("RX_BUDGET_STREAM_START\n");
			streamLoad1 = loadavg()[0] ?? Number.NaN;
			const start = performance.now();
			streamDeltas = 0;
			for (let end = 16; end <= request.streamWire.length; end += 16) {
				measureRegex(re, request.streamWire.slice(0, end));
				streamDeltas++;
			}
			if (request.streamWire.length % 16 !== 0) {
				measureRegex(re, request.streamWire);
				streamDeltas++;
			}
			streamMs = performance.now() - start;
		}
		process.stdout.write(JSON.stringify({ type: "complete", streamMs, streamLoad1, streamDeltas }) + "\n");
	} catch (error) {
		process.stdout.write(JSON.stringify({ type: "error", error: String(error) }) + "\n");
	}
}

type WorkerSummary = { samples: WorkerSample[]; complete: boolean; streamMs?: number; streamLoad1?: number; streamDeltas?: number; error?: string };

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
		const timeoutCode = stderr.includes("RX_BUDGET_STREAM_START") ? "STREAM_TIMEOUT" : "NEAR_MISS_TIMEOUT";
		failures.push({ code: timeoutCode, message: "worker exceeded " + timeoutMs + "ms during " + (timeoutCode === "STREAM_TIMEOUT" ? "stream" : "near-miss") + "; rule=" + input.rule + " condition=" + input.conditionIndex });
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
		failures,
	};
}

type GateReport = {
	status: "PASS" | "FAIL";
	timing_samples: number;
	engine: { bun: string; omp_source: string };
	load_average_before: number[];
	load_average_after: number[];
	rules_loaded: number;
	conditions_measured: number;
	stream: {
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
	};
	measurements: ConditionMeasurement[];
	lint_violations: Array<{ rule: string; condition_index: number; code: string; pattern: string }>;
	gate_elapsed_ms: number;
};

async function runGateSample(rulesDir: string, streamFile: string): Promise<GateReport> {
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
	const measurements: ConditionMeasurement[] = [];
	for (const condition of rules) {
		const remaining = deadline - Date.now();
		if (remaining < 1000) {
			measurements.push({ rule: condition.rule, condition_index: condition.conditionIndex, status: "GATE_TIMEOUT", literal: literalProbe(condition.pattern), samples: [], failures: [{ code: "GATE_TIMEOUT", message: "overall RX1 budget exceeded; rule=" + condition.rule + " condition=" + condition.conditionIndex }] });
			continue;
		}
		measurements.push(await measureCondition({
			rule: condition.rule,
			conditionIndex: condition.conditionIndex,
			pattern: condition.pattern,
			scope: condition.scope,
			streamWire,
			workerTimeoutMs: Math.min(DEFAULT_WORKER_TIMEOUT_MS, remaining - 500),
		}));
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
	const failed = rules.length === 0 || !streamComplete || lintViolations.length > 0 || measurements.some(measurement => measurement.status !== "MEASURED" || measurement.failures.length > 0) || failsStreamBudget(streamTotal);
	const after = loadavg();
	return {
		status: failed ? "FAIL" : "PASS",
		timing_samples: 1,
		engine: { bun: Bun.version, omp_source: OMP_SRC },
		load_average_before: before,
		load_average_after: after,
		rules_loaded: loaded.length,
		conditions_measured: rules.length,
		stream: {
			complete: streamComplete,
			file: streamFile,
			wire_bytes: Buffer.byteLength(streamWire, "utf8"),
			chunk_bytes: 16,
			deltas: byRule.length ? (measurements.find(measurement => measurement.stream_deltas !== undefined)?.stream_deltas ?? 0) : 0,
			total_ms: streamTotal,
			budget_ms: STREAM_BUDGET_MS,
			sample_total_ms: [streamTotal],
			sample_load1: [before[0] ?? Number.NaN],
			by_rule: byRule.sort((left, right) => right.ms - left.ms),
		},
		measurements,
		lint_violations: lintViolations,
		gate_elapsed_ms: performance.now() - started,
	};
}

function summarizeRepeatedReports(reports: readonly GateReport[]): GateReport {
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
		};
		if (hasStream) {
			const sample_stream_ms = streamRuns.map(value => value ?? Number.POSITIVE_INFINITY);
			merged.sample_stream_ms = sample_stream_ms;
			merged.sample_stream_load1 = repeated.map(measurement => measurement?.sample_stream_load1?.[0] ?? Number.NaN);
			merged.stream_ms = medianMs(sample_stream_ms);
			merged.stream_deltas = firstMeasurement.stream_deltas;
		}
		return merged;
	});
	const sample_total_ms = reports.map(report => report.stream.total_ms);
	const sample_load1 = reports.map(report => report.stream.sample_load1[0] ?? report.load_average_before[0] ?? Number.NaN);
	const total_ms = medianMs(sample_total_ms);
	const streamComplete = reports.every(report => report.stream.complete);
	const streamByRule = measurements.filter(measurement => typeof measurement.stream_ms === "number").map(measurement => ({
		rule: measurement.rule,
		condition_index: measurement.condition_index,
		ms: measurement.stream_ms!,
		sample_ms: measurement.sample_stream_ms ?? [],
		sample_load1: measurement.sample_stream_load1 ?? [],
	})).sort((left, right) => right.ms - left.ms);
	const failed = first.rules_loaded === 0 || !streamComplete || first.lint_violations.length > 0 || measurements.some(measurement => measurement.status !== "MEASURED" || measurement.failures.length > 0) || failsStreamBudget(total_ms);
	return {
		...first,
		status: failed ? "FAIL" : "PASS",
		timing_samples: reports.length,
		gate_elapsed_ms: reports.reduce((sum, report) => sum + report.gate_elapsed_ms, 0),
		stream: {
			...first.stream,
			complete: streamComplete,
			total_ms,
			sample_total_ms,
			sample_load1,
			by_rule: streamByRule,
		},
		measurements,
	};
}

/** Run every case once per round so samples for each case are separated by a full pass over the others. */
export async function runGate(rulesDir: string, streamFile: string): Promise<GateReport> {
	const reports: GateReport[] = [];
	for (let sample = 0; sample < TIMING_SAMPLE_COUNT; sample++) reports.push(await runGateSample(rulesDir, streamFile));
	return summarizeRepeatedReports(reports);
}

function formatMs(value: number | undefined): string {
	return typeof value === "number" ? value.toFixed(1) : "TIMEOUT";
}

function printReport(report: GateReport): void {
	console.log("REGEX-BUDGET: " + report.status);
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
	const streamStatus = !report.stream.complete ? "INCOMPLETE" : failsStreamBudget(report.stream.total_ms) ? "FAIL" : "PASS";
	const streamSamples = report.stream.sample_total_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (report.stream.sample_load1[index]?.toFixed(2) ?? "unknown"));
	console.log("live stream: " + streamStatus + " file=" + report.stream.file + " wire=" + report.stream.wire_bytes + "B chunk=" + report.stream.chunk_bytes + "B deltas/condition=" + report.stream.deltas + " median=" + report.stream.total_ms.toFixed(1) + "ms / " + report.stream.budget_ms + "ms samples=[" + streamSamples.join(", ") + "]");
	for (const item of report.stream.by_rule.slice(0, 8)) {
		const samples = item.sample_ms.map((ms, index) => ms.toFixed(1) + "ms@load1=" + (item.sample_load1[index]?.toFixed(2) ?? "unknown"));
		console.log("stream " + item.rule + "#" + item.condition_index + " | median=" + item.ms.toFixed(1) + "ms samples=[" + samples.join(", ") + "]");
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
	const rulesPath = rulesIndex < 0 ? path.join(KIT, "rules") : args[rulesIndex + 1];
	const streamPath = streamIndex < 0 ? path.join(KIT, "scripts/e2e-live.sh") : args[streamIndex + 1];
	if (!rulesPath || !streamPath || rulesPath.startsWith("--") || streamPath.startsWith("--")) throw new Error("--rules and --stream require a path");
	const rulesDir = path.resolve(rulesPath);
	const streamFile = path.resolve(streamPath);
	try {
		const report = await runGate(rulesDir, streamFile);
		printReport(report);
		process.exitCode = report.status === "PASS" ? 0 : 1;
	} catch (error) {
		console.error("REGEX-BUDGET: FAIL");
		console.error(String(error));
		process.exitCode = 1;
	}
}
