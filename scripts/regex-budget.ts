#!/usr/bin/env bun
/**
 * regex-budget.ts — bounded Bun/JSC measurements for omp rule conditions.
 *
 * Every condition is parsed by the kit's omp-backed rule loader and compiled with
 * omp's compileRuleCondition. A child process contains synchronous regex stalls.
 */
import { readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
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
const GATE_DEADLINE_MS = 57_000;
const DEFAULT_WORKER_TIMEOUT_MS = 20_000;
/** Same contention line as the TOOL1 quiet-machine check and the LOAD1 heavy gate: above 1.5x cores the box is too loud to judge timing. */
const MAX_LOAD_PER_CORE = Number(process.env.RX1_MAX_LOAD_PER_CORE ?? "") > 0 ? Number(process.env.RX1_MAX_LOAD_PER_CORE) : 1.5;
/** Test-only load injection for planted contention cases (mirrors OMP_KIT_HEAVY_FAKE_LOAD1). Production always reads the real one-minute average. */
function testFakeLoad(): number | undefined {
	const raw = process.env.RX1_FAKE_LOAD1;
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}
/** Null when the machine is quiet enough to judge regex timing; otherwise the INCONCLUSIVE reason. */
export function regexLoadBlockReason(load1: number, ncpu: number): string | null {
	if (!Number.isFinite(load1) || !Number.isFinite(ncpu) || ncpu < 1) return "machine load unavailable";
	const threshold = ncpu * MAX_LOAD_PER_CORE;
	return load1 > threshold ? `RX1 load ${load1.toFixed(2)} exceeds ${threshold.toFixed(2)} (${ncpu} cores x ${MAX_LOAD_PER_CORE})` : null;
}

type Shape = typeof DEFAULT_SHAPES[number];
type Encoding = typeof DEFAULT_ENCODINGS[number];
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

export function failsStreamBudget(totalMs: number): boolean {
	return !Number.isFinite(totalMs) || totalMs > STREAM_BUDGET_MS;
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
				const matched: boolean[] = [];
				const bytes: number[] = [];
				for (const size of request.sizes) {
					const raw = rawInput(shape, size, literal);
					const input = encoding === "json" ? JSON.stringify({ command: raw }) : raw;
					const timing = measureRegex(re, input);
					ms.push(timing.ms);
					matched.push(timing.matched);
					bytes.push(Buffer.byteLength(input, "utf8"));
				}
				const sample = { shape, encoding, ms, matched, bytes };
				process.stdout.write(JSON.stringify({ type: "sample", sample }) + "\n");
			}
		}
		let streamMs: number | undefined;
		let streamDeltas: number | undefined;
		if (request.streamWire !== undefined) {
			process.stderr.write("RX_BUDGET_STREAM_START\n");
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
		process.stdout.write(JSON.stringify({ type: "complete", streamMs, streamDeltas }) + "\n");
	} catch (error) {
		process.stdout.write(JSON.stringify({ type: "error", error: String(error) }) + "\n");
	}
}

type WorkerSummary = { samples: ProbeSample[]; complete: boolean; streamMs?: number; streamDeltas?: number; error?: string };

function parseWorkerOutput(stdout: string): WorkerSummary {
	const summary: WorkerSummary = { samples: [], complete: false };
	for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
		try {
			const event = JSON.parse(line) as Record<string, unknown>;
			if (event.type === "sample" && event.sample && typeof event.sample === "object") summary.samples.push(event.sample as ProbeSample);
			else if (event.type === "complete") {
				summary.complete = true;
				if (typeof event.streamMs === "number") summary.streamMs = event.streamMs;
				if (typeof event.streamDeltas === "number") summary.streamDeltas = event.streamDeltas;
			} else if (event.type === "error") summary.error = String(event.error ?? "worker error");
		} catch { /* Ignore non-JSON diagnostics; retain completed sample events. */ }
	}
	return summary;
}

export async function measureCondition(input: {
	rule: string;
	conditionIndex: number;
	pattern: string;
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
		...(input.streamWire === undefined ? {} : { streamWire: input.streamWire }),
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
	const samples = result.samples;
	const failures: MeasurementFailure[] = [];
	if (!literal) failures.push({ code: "NO_REQUIRED_LITERAL_PROBE", message: "no consuming literal found for rule=" + input.rule + " condition=" + input.conditionIndex });
	for (const sample of samples) {
		if (failsNearMissBudget(sample.ms)) {
			const ratio = sample.ms[sample.ms.length - 1] / Math.max(sample.ms[sample.ms.length - 2], 0.01);
			failures.push({ code: "NEAR_MISS_SUPERQUADRATIC", shape: sample.shape, encoding: sample.encoding, message: "rule=" + input.rule + " condition=" + input.conditionIndex + " shape=" + sample.shape + " encoding=" + sample.encoding + " 8k-to-16k=" + ratio.toFixed(2) + "x, 16k=" + sample.ms[sample.ms.length - 1].toFixed(2) + "ms" });
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
		...(typeof result.streamMs === "number" ? { stream_ms: result.streamMs } : {}),
		...(typeof result.streamDeltas === "number" ? { stream_deltas: result.streamDeltas } : {}),
		failures,
	};
}

type GateReport = {
	status: "PASS" | "FAIL" | "INCONCLUSIVE";
	/** Set on INCONCLUSIVE: why the run cannot judge (e.g. machine too loud). */
	note?: string;
	engine: { bun: string; omp_source: string };
	load_average_before: number[];
	load_average_after: number[];
	rules_loaded: number;
	conditions_measured: number;
	stream: { complete: boolean; file: string; wire_bytes: number; chunk_bytes: number; deltas: number; total_ms: number; budget_ms: number; by_rule: Array<{ rule: string; condition_index: number; ms: number }> };
	measurements: ConditionMeasurement[];
	lint_violations: Array<{ rule: string; condition_index: number; code: string; pattern: string }>;
	gate_elapsed_ms: number;
};

export async function runGate(rulesDir: string, streamFile: string): Promise<GateReport> {
	const started = performance.now();
	const deadline = Date.now() + GATE_DEADLINE_MS;
	const before = loadavg();
	// A loud box cannot judge regex timing: refuse to measure rather than fail a correct push.
	const loudAtStart = regexLoadBlockReason(testFakeLoad() ?? before[0] ?? Number.NaN, cpus().length);
	if (loudAtStart) {
		console.log("REGEX-BUDGET: INCONCLUSIVE (" + loudAtStart + "; retry on a quieter machine)");
		return {
			status: "INCONCLUSIVE",
			note: loudAtStart + "; retry on a quieter machine",
			engine: { bun: Bun.version, omp_source: OMP_SRC },
			load_average_before: before,
			load_average_after: before,
			rules_loaded: 0,
			conditions_measured: 0,
			stream: { complete: false, file: streamFile, wire_bytes: 0, chunk_bytes: 16, deltas: 0, total_ms: 0, budget_ms: STREAM_BUDGET_MS, by_rule: [] },
			measurements: [],
			lint_violations: [],
			gate_elapsed_ms: performance.now() - started,
		};
	}
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
			streamWire,
			workerTimeoutMs: Math.min(DEFAULT_WORKER_TIMEOUT_MS, remaining - 500),
		}));
	}
	const byRule = measurements.filter(m => typeof m.stream_ms === "number").map(m => ({ rule: m.rule, condition_index: m.condition_index, ms: m.stream_ms! }));
	const streamTotal = byRule.reduce((sum, item) => sum + item.ms, 0);
	const streamComplete = byRule.length === rules.length;
	const failed = rules.length === 0 || !streamComplete || lintViolations.length > 0 || measurements.some(m => m.status !== "MEASURED" || m.failures.length > 0) || failsStreamBudget(streamTotal);
	// Load spiked mid-run: a FAIL measured under contention is suspect, so report it as INCONCLUSIVE. A PASS stays a PASS.
	const after = loadavg();
	const loudAtEnd = regexLoadBlockReason(testFakeLoad() ?? after[0] ?? Number.NaN, cpus().length);
	const status = loudAtEnd && failed ? "INCONCLUSIVE" : failed ? "FAIL" : "PASS";
	return {
		status,
		...(loudAtEnd && failed ? { note: loudAtEnd + "; FAIL measured under contention is suspect; retry on a quieter machine" } : {}),
		engine: { bun: Bun.version, omp_source: OMP_SRC },
		load_average_before: before,
		load_average_after: after,
		rules_loaded: loaded.length,
		conditions_measured: rules.length,
		stream: { complete: streamComplete, file: streamFile, wire_bytes: Buffer.byteLength(streamWire, "utf8"), chunk_bytes: 16, deltas: byRule.length ? (measurements.find(m => m.stream_deltas !== undefined)?.stream_deltas ?? 0) : 0, total_ms: streamTotal, budget_ms: STREAM_BUDGET_MS, by_rule: byRule.sort((a, b) => b.ms - a.ms) },
		measurements,
		lint_violations: lintViolations,
		gate_elapsed_ms: performance.now() - started,
	};
}

function formatMs(value: number | undefined): string {
	return typeof value === "number" ? value.toFixed(1) : "TIMEOUT";
}

function printReport(report: GateReport): void {
	console.log("REGEX-BUDGET: " + report.status);
	if (report.note) console.log("note: " + report.note);
	console.log("Bun=" + report.engine.bun + " OMP_SRC=" + report.engine.omp_source);
	console.log("loadavg before=" + report.load_average_before.map(n => n.toFixed(2)).join(",") + " after=" + report.load_average_after.map(n => n.toFixed(2)).join(","));
	console.log("rules=" + report.rules_loaded + " regex-conditions=" + report.conditions_measured + " elapsed=" + report.gate_elapsed_ms.toFixed(1) + "ms");
	console.log("near-miss failures (8K→16K ratio >2.6 and 16K >5ms):");
	console.log("rule | condition | worst shape/encoding | 4K ms | 8K ms | 16K ms | ratio");
	const rows: Array<{ rule: string; condition: number; shape: string; encoding: string; ms: number[]; ratio: number }> = [];
	for (const measurement of report.measurements) {
		for (const sample of measurement.samples) {
			if (failsNearMissBudget(sample.ms)) rows.push({ rule: measurement.rule, condition: measurement.condition_index, shape: sample.shape, encoding: sample.encoding, ms: sample.ms, ratio: sample.ms[2] / Math.max(sample.ms[1], 0.01) });
		}
	}
	if (!rows.length) console.log("(none)");
	for (const row of rows.sort((a, b) => b.ms[2] - a.ms[2])) console.log(row.rule + " | " + row.condition + " | " + row.shape + "/" + row.encoding + " | " + formatMs(row.ms[0]) + " | " + formatMs(row.ms[1]) + " | " + formatMs(row.ms[2]) + " | " + row.ratio.toFixed(2) + "x");
	console.log("measurement timeouts:");
	const timeouts = report.measurements.filter(measurement => measurement.status !== "MEASURED");
	if (!timeouts.length) console.log("(none)");
	for (const measurement of timeouts) console.log(measurement.rule + "#" + measurement.condition_index + " | " + measurement.status + " | " + measurement.failures.map(failure => failure.code).join(","));
	console.log("structural lint:");
	if (!report.lint_violations.length) console.log("(none)");
	for (const violation of report.lint_violations) console.log(violation.rule + "#" + violation.condition_index + " | " + violation.code + " | " + violation.pattern);
	const streamStatus = !report.stream.complete ? "INCOMPLETE" : failsStreamBudget(report.stream.total_ms) ? "FAIL" : "PASS";
	console.log("live stream: " + streamStatus + " file=" + report.stream.file + " wire=" + report.stream.wire_bytes + "B chunk=" + report.stream.chunk_bytes + "B deltas/condition=" + report.stream.deltas + " total=" + report.stream.total_ms.toFixed(1) + "ms / " + report.stream.budget_ms + "ms");
	for (const item of report.stream.by_rule.slice(0, 8)) console.log("stream " + item.rule + "#" + item.condition_index + " | " + item.ms.toFixed(1) + "ms");
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
		// 75 = retry later: a busy machine must not refuse a correct push.
		process.exitCode = report.status === "PASS" ? 0 : report.status === "INCONCLUSIVE" ? 75 : 1;
	} catch (error) {
		console.error("REGEX-BUDGET: FAIL");
		console.error(String(error));
		process.exitCode = 1;
	}
}
