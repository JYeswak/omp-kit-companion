// Prediction scoring. A prediction document is markdown with exactly one fenced json block whose
// schema is fleet-round.predictions/v1 (or a round report, whose json.predictions carry the same
// expectation fields). Measured values come from a fleet-round.measured/v1 JSON file the chief
// assembles from validator verdicts. Error is per prediction; authors aggregate hit rate and mean
// normalized error over the predictions that were measured.
import { jsonFences, parseBlocks } from "./markdown.ts";
import { isRecord } from "./model.ts";
import { REPORT_SCHEMA } from "./report.ts";

export const PREDICTIONS_SCHEMA = "fleet-round.predictions/v1";
export const MEASURED_SCHEMA = "fleet-round.measured/v1";

export type PredictionScore = {
	author: string;
	id: string;
	metric: string;
	kind: "exact" | "min" | "max" | "shares" | "label";
	expected: unknown;
	measured: unknown;
	status: "HIT" | "MISS" | "UNMEASURED" | "INCOMPARABLE";
	error: number | null;
	normalized_error: number | null;
	detail: string;
};
export type AuthorScore = { author: string; predictions: number; measured: number; hits: number; hit_rate: number | null; mean_normalized_error: number | null };

export function loadPredictionDoc(markdown: string, where: string): { author: string; round: number | null; predictions: Record<string, unknown>[] } {
	const fences = jsonFences(parseBlocks(markdown));
	if (fences.length !== 1) throw new Error(`${where}: expected exactly one fenced json block, found ${fences.length}`);
	const json: unknown = JSON.parse(fences[0]!.text);
	if (!isRecord(json)) throw new Error(`${where}: json block is not an object`);
	if (json.schema !== PREDICTIONS_SCHEMA && json.schema !== REPORT_SCHEMA) throw new Error(`${where}: schema ${JSON.stringify(json.schema)} is neither ${PREDICTIONS_SCHEMA} nor ${REPORT_SCHEMA}`);
	const author = typeof json.author === "string" ? json.author : typeof json.project === "string" && typeof json.seat === "string" ? `${json.project}@${json.seat}` : null;
	if (author === null) throw new Error(`${where}: no author (json.author, or json.project + json.seat)`);
	if (!Array.isArray(json.predictions)) throw new Error(`${where}: json.predictions is not an array`);
	const predictions = json.predictions.map((p, i) => {
		if (!isRecord(p) || typeof p.id !== "string" || typeof p.metric !== "string") throw new Error(`${where}: predictions[${i}] needs string id and metric`);
		return p;
	});
	return { author, round: typeof json.round === "number" ? json.round : null, predictions };
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Score one prediction against the measured value for its metric. */
export function scorePrediction(author: string, p: Record<string, unknown>, measured: unknown): PredictionScore {
	const id = String(p.id);
	const metric = String(p.metric);
	const base = { author, id, metric, measured };
	const tolerance = finite(p.tolerance) ? p.tolerance : 0;
	if (p.expect_min !== undefined || p.expect_max !== undefined) {
		const kind = p.expect_min !== undefined ? "min" : "max";
		const bound = kind === "min" ? p.expect_min : p.expect_max;
		if (!finite(bound)) return { ...base, kind, expected: bound, status: "INCOMPARABLE", error: null, normalized_error: null, detail: `expect_${kind} is not a number` };
		if (measured === undefined) return { ...base, kind, expected: bound, status: "UNMEASURED", error: null, normalized_error: null, detail: "no measured value" };
		if (!finite(measured)) return { ...base, kind, expected: bound, status: "INCOMPARABLE", error: null, normalized_error: null, detail: "measured value is not a number" };
		const error = kind === "min" ? Math.max(0, bound - measured) : Math.max(0, measured - bound);
		return { ...base, kind, expected: bound, status: error === 0 ? "HIT" : "MISS", error, normalized_error: Math.abs(bound) > 1 ? error / Math.abs(bound) : error, detail: `${kind === "min" ? ">=" : "<="} ${bound}, measured ${measured}` };
	}
	const expected = p.expect;
	if (measured === undefined) return { ...base, kind: isRecord(expected) ? "shares" : typeof expected === "string" ? "label" : "exact", expected, status: "UNMEASURED", error: null, normalized_error: null, detail: "no measured value" };
	if (isRecord(expected)) {
		if (!isRecord(measured)) return { ...base, kind: "shares", expected, status: "INCOMPARABLE", error: null, normalized_error: null, detail: "measured value is not an object of shares" };
		const keys = Object.keys(expected).sort();
		const diffs: number[] = [];
		for (const key of keys) {
			const want = expected[key];
			const got = measured[key];
			if (!finite(want) || !finite(got)) return { ...base, kind: "shares", expected, status: "INCOMPARABLE", error: null, normalized_error: null, detail: `share ${key} missing or not numeric` };
			diffs.push(Math.abs(want - got));
		}
		const error = diffs.reduce((a, b) => a + b, 0) / Math.max(1, diffs.length);
		const hit = diffs.every(d => d <= tolerance + 1e-12);
		return { ...base, kind: "shares", expected, status: hit ? "HIT" : "MISS", error, normalized_error: error, detail: `mean |share error| ${error.toFixed(3)}, max ${Math.max(...diffs).toFixed(3)}, tolerance ${tolerance}` };
	}
	if (typeof expected === "string") {
		const hit = measured === expected;
		return { ...base, kind: "label", expected, status: hit ? "HIT" : "MISS", error: hit ? 0 : 1, normalized_error: hit ? 0 : 1, detail: `expected ${JSON.stringify(expected)}, measured ${JSON.stringify(measured)}` };
	}
	if (!finite(expected)) return { ...base, kind: "exact", expected, status: "INCOMPARABLE", error: null, normalized_error: null, detail: "prediction has no expect, expect_min or expect_max" };
	if (!finite(measured)) return { ...base, kind: "exact", expected, status: "INCOMPARABLE", error: null, normalized_error: null, detail: "measured value is not a number" };
	const error = Math.abs(measured - expected);
	return { ...base, kind: "exact", expected, status: error <= tolerance + 1e-12 ? "HIT" : "MISS", error, normalized_error: Math.abs(expected) > 1 ? error / Math.abs(expected) : error, detail: `expected ${expected}${tolerance ? ` ±${tolerance}` : ""}, measured ${measured}` };
}

export function scoreAll(docs: { author: string; predictions: Record<string, unknown>[] }[], values: Record<string, unknown>): { predictions: PredictionScore[]; authors: AuthorScore[] } {
	const predictions = docs.flatMap(doc => doc.predictions.map(p => scorePrediction(doc.author, p, values[String(p.metric)])));
	const authors = [...new Set(predictions.map(p => p.author))].sort().map(author => {
		const own = predictions.filter(p => p.author === author);
		const scored = own.filter(p => p.status === "HIT" || p.status === "MISS");
		const hits = scored.filter(p => p.status === "HIT").length;
		const errors = scored.map(p => p.normalized_error!).filter(e => e !== null);
		return {
			author,
			predictions: own.length,
			measured: scored.length,
			hits,
			hit_rate: scored.length ? hits / scored.length : null,
			mean_normalized_error: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
		};
	});
	return { predictions, authors };
}

export function loadMeasured(text: string, where: string): Record<string, unknown> {
	const json: unknown = JSON.parse(text);
	if (!isRecord(json) || json.schema !== MEASURED_SCHEMA || !isRecord(json.values)) throw new Error(`${where}: expected {"schema": "${MEASURED_SCHEMA}", "values": {metric: value}}`);
	return json.values;
}
