/** Exact flake verdicts for `test --repeat`: Clopper-Pearson bounds on the failure rate, Fisher's exact test against a baseline receipt, and the sample size needed to detect the observed change. Zero dependencies; every number here recomputes from the receipt. */

export interface RepeatReceipt { version: 1; scenario?: string; runs: number; failures: number; results?: readonly ("pass" | "fail")[] }
export type RepeatVerdictKind = "improved" | "regressed" | "not-distinguishable" | "below-target" | "above-target" | "unjudged";
export interface RepeatVerdict {
	kind: RepeatVerdictKind;
	failure_rate: number;
	ci_lower: number;
	ci_upper: number;
	p_value: number | null;
	effect_size_h: number | null;
	n_needed_post_hoc: number | null;
}

/** Lanczos log-gamma; anchors the hypergeometric log-probabilities in Fisher's test. */
function logGamma(value: number): number {
	const shape = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531,
		-176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
	if (value < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * value)) - logGamma(1 - value);
	const shifted = value - 1;
	let sum = shape[0]!;
	for (let index = 1; index < 9; index += 1) sum += shape[index]! / (shifted + index);
	const base = shifted + 7.5;
	return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(base) - base + Math.log(sum);
}

/** Continued fraction for the incomplete beta function (Numerical Recipes betacf). */
function betaFraction(a: number, b: number, x: number): number {
	const MAX_ITERATIONS = 200, TINY = 1e-30;
	let c = 1, d = 1 - (a + b) * x / (a + 1);
	if (Math.abs(d) < TINY) d = TINY;
	d = 1 / d;
	let h = d;
	for (let m = 1; m <= MAX_ITERATIONS; m += 1) {
		const even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
		d = 1 + even * d;
		if (Math.abs(d) < TINY) d = TINY;
		c = 1 + even / c;
		if (Math.abs(c) < TINY) c = TINY;
		d = 1 / d;
		h *= d * c;
		const odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
		d = 1 + odd * d;
		if (Math.abs(d) < TINY) d = TINY;
		c = 1 + odd / c;
		if (Math.abs(c) < TINY) c = TINY;
		d = 1 / d;
		const next = h * d * c;
		if (Math.abs(next - h) < 3e-14 * Math.abs(next)) return next;
		h = next;
	}
	return h;
}

/** Regularized incomplete beta I_x(a, b). */
function incompleteBeta(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	if (x < (a + 1) / (a + b + 2)) return front * betaFraction(a, b, x) / a;
	return 1 - front * betaFraction(b, a, 1 - x) / b;
}

/** Inverse regularized beta by bisection; 100 iterations pin far past double precision needs. */
function betaQuantile(probability: number, a: number, b: number): number {
	let low = 0, high = 1;
	for (let index = 0; index < 100; index += 1) {
		const mid = (low + high) / 2;
		if (incompleteBeta(mid, a, b) < probability) low = mid;
		else high = mid;
	}
	return (low + high) / 2;
}

/** Exact Clopper-Pearson interval on the failure rate. Throws on impossible counts. */
export function clopperPearson(failures: number, runs: number, alpha = 0.05): { lower: number; upper: number } {
	if (!Number.isInteger(failures) || !Number.isInteger(runs) || failures < 0 || runs <= 0 || failures > runs) throw new Error(`INVALID_REPEAT_COUNTS: failures=${failures} runs=${runs}`);
	if (!(alpha > 0 && alpha < 1)) throw new Error(`INVALID_ALPHA: ${alpha}`);
	return {
		lower: failures === 0 ? 0 : betaQuantile(alpha / 2, failures, runs - failures + 1),
		upper: failures === runs ? 1 : betaQuantile(1 - alpha / 2, failures + 1, runs - failures),
	};
}

/** Log-probability of one 2x2 table under fixed margins. */
function tableLogProb(a: number, row1: number, col1: number, total: number): number {
	return logGamma(row1 + 1) + logGamma(total - row1 + 1) + logGamma(col1 + 1) + logGamma(total - col1 + 1)
		- logGamma(total + 1) - logGamma(a + 1) - logGamma(row1 - a + 1) - logGamma(col1 - a + 1) - logGamma(total - row1 - col1 + a + 1);
}

/** Two-sided Fisher's exact p-value (sum of tables no likelier than observed). */
export function fisherExact(currentFailures: number, currentRuns: number, baselineFailures: number, baselineRuns: number): number {
	for (const [failures, runs] of [[currentFailures, currentRuns], [baselineFailures, baselineRuns]]) {
		if (!Number.isInteger(failures) || !Number.isInteger(runs) || failures < 0 || runs <= 0 || failures > runs) throw new Error(`INVALID_REPEAT_COUNTS: failures=${failures} runs=${runs}`);
	}
	const row1 = currentRuns, col1 = currentFailures + baselineFailures, total = currentRuns + baselineRuns;
	const low = Math.max(0, row1 + col1 - total), high = Math.min(row1, col1);
	const observed = tableLogProb(currentFailures, row1, col1, total);
	let sum = 0;
	for (let a = low; a <= high; a += 1) {
		const prob = tableLogProb(a, row1, col1, total);
		if (prob <= observed + 1e-12) sum += Math.exp(prob);
	}
	return Math.min(1, sum);
}

/** Cohen's h between two failure rates. */
export function cohensH(current: number, baseline: number): number {
	return 2 * (Math.asin(Math.sqrt(current)) - Math.asin(Math.sqrt(baseline)));
}

/** Acklam's inverse-normal approximation (relative error below 1.2e-9). */
function inverseNormal(probability: number): number {
	const a = [-3.969683028665376e+1, 2.209460984245205e+2, -2.759285104469687e+2, 1.383577518672690e+2, -3.066479806614716e+1, 2.506628277459239e+0];
	const b = [-5.447609879822406e+1, 1.615858368580409e+2, -1.556989798598866e+2, 6.680131188771972e+1, -1.328068155288572e+1];
	const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e+0, -2.549732539343734e+0, 4.374664141464968e+0, 2.938163982698783e+0];
	const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e+0, 3.754408661907416e+0];
	const low = 0.02425, high = 1 - low;
	let q: number, result: number;
	if (probability < low) {
		q = Math.sqrt(-2 * Math.log(probability));
		result = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
	} else if (probability <= high) {
		q = probability - 0.5;
		const r = q * q;
		result = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
	} else {
		q = Math.sqrt(-2 * Math.log(1 - probability));
		result = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
	}
	return result;
}

/** Per-group runs needed to detect p0 vs p1 (two-sided, normal approximation). Null when rates tie. */
export function sampleSize(p0: number, p1: number, alpha = 0.05, power = 0.8): number | null {
	if (!(p0 >= 0 && p0 <= 1 && p1 >= 0 && p1 <= 1 && alpha > 0 && alpha < 1 && power > 0 && power < 1)) throw new Error(`INVALID_POWER_INPUTS: p0=${p0} p1=${p1} alpha=${alpha} power=${power}`);
	if (p0 === p1) return null;
	const pooled = (p0 + p1) / 2;
	const numerator = inverseNormal(1 - alpha / 2) * Math.sqrt(2 * pooled * (1 - pooled)) + inverseNormal(power) * Math.sqrt(p0 * (1 - p0) + p1 * (1 - p1));
	return Math.ceil((numerator * numerator) / ((p1 - p0) * (p1 - p0)));
}

function checkReceipt(receipt: RepeatReceipt, role: string): void {
	if (!receipt || receipt.version !== 1 || !Number.isInteger(receipt.runs) || !Number.isInteger(receipt.failures) || receipt.runs <= 0 || receipt.failures < 0 || receipt.failures > receipt.runs) {
		throw new Error(`INVALID_REPEAT_RECEIPT: ${role}`);
	}
	if (receipt.results !== undefined && (!Array.isArray(receipt.results) || receipt.results.length !== receipt.runs || receipt.results.some((entry) => entry !== "pass" && entry !== "fail") || receipt.results.filter((entry) => entry === "fail").length !== receipt.failures)) {
		throw new Error(`INVALID_REPEAT_RECEIPT: ${role} results`);
	}
}

/** Parse an untrusted baseline file value into a receipt; throws INVALID_REPEAT_RECEIPT. */
export function parseRepeatReceipt(value: unknown): RepeatReceipt {
	checkReceipt(value as RepeatReceipt, "baseline");
	return value as RepeatReceipt;
}

/** Verdict from a repeat receipt, optionally against a baseline receipt or a fixed failure-rate target. n_needed is post-hoc from the observed effect. */
export function repeatVerdict(current: RepeatReceipt, options?: { baseline?: RepeatReceipt; target?: number; alpha?: number }): RepeatVerdict {
	checkReceipt(current, "current");
	const alpha = options?.alpha ?? 0.05;
	const rate = current.failures / current.runs;
	const interval = clopperPearson(current.failures, current.runs, alpha);
	if (options?.baseline) {
		checkReceipt(options.baseline, "baseline");
		if (current.scenario && options.baseline.scenario && current.scenario !== options.baseline.scenario) throw new Error(`SCENARIO_MISMATCH: current ${current.scenario} vs baseline ${options.baseline.scenario}`);
		const baseRate = options.baseline.failures / options.baseline.runs;
		const p = fisherExact(current.failures, current.runs, options.baseline.failures, options.baseline.runs);
		const effect = cohensH(rate, baseRate);
		const n = sampleSize(baseRate, rate, alpha, 0.8);
		if (p >= alpha) return { kind: "not-distinguishable", failure_rate: rate, ci_lower: interval.lower, ci_upper: interval.upper, p_value: p, effect_size_h: effect, n_needed_post_hoc: n };
		return { kind: rate < baseRate ? "improved" : "regressed", failure_rate: rate, ci_lower: interval.lower, ci_upper: interval.upper, p_value: p, effect_size_h: effect, n_needed_post_hoc: n };
	}
	if (options?.target !== undefined) {
		if (!(options.target >= 0 && options.target <= 1)) throw new Error(`INVALID_TARGET: ${options.target}`);
		const n = sampleSize(rate, options.target, alpha, 0.8);
		return { kind: interval.upper < options.target ? "below-target" : "above-target", failure_rate: rate, ci_lower: interval.lower, ci_upper: interval.upper, p_value: null, effect_size_h: null, n_needed_post_hoc: n };
	}
	return { kind: "unjudged", failure_rate: rate, ci_lower: interval.lower, ci_upper: interval.upper, p_value: null, effect_size_h: null, n_needed_post_hoc: null };
}
