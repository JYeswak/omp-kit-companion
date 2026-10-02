import { isAbsolute, resolve } from "node:path";
import { runBundled, type BundledRunResult } from "./runtime.ts";

const HARNESS = "scripts/ttsr-harness.ts";

export interface MetamorphicBreak {
	rule: string;
	line: number;
	relation: string;
	variant: string;
	expected: "fire" | "quiet";
	observed: "fire" | "quiet";
}

export interface MetamorphicCliReport {
	status: "PASS" | "FAIL" | "UNVERIFIED";
	counts?: { cases: number; variants: number; breaks: number; skipped: number };
	breaks: MetamorphicBreak[];
	producer?: BundledRunResult;
	detail?: string;
}

export interface MetamorphicInput {
	root: string;
	executablePath: string;
	rules?: string;
	cases?: string;
}

function isReport(value: unknown): value is { status?: unknown; counts?: unknown; breaks?: unknown } {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Metamorphic relation report through the release runtime. The harness
 * generates every variant and grades it on the same G2 matcher path as the
 * gate; any relation break fails the report. Nothing is written.
 */
export async function runMetamorphicReport(input: MetamorphicInput): Promise<MetamorphicCliReport> {
	const unverified = (detail: string): MetamorphicCliReport =>
		({ status: "UNVERIFIED", breaks: [], detail });
	for (const path of [input.root, input.executablePath]) {
		if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
			return unverified(`non-canonical input path: ${String(path)}`);
		}
	}
	const args = ["--metamorphic-json"];
	if (input.rules !== undefined) {
		if (!isAbsolute(input.rules)) return unverified("non-absolute rules dir");
		args.push("--rules", input.rules);
	}
	if (input.cases !== undefined) {
		if (!isAbsolute(input.cases)) return unverified("non-absolute cases file");
		args.push("--cases", input.cases);
	}
	let result: BundledRunResult;
	try {
		result = await runBundled(HARNESS, args, input.root, input.executablePath);
	} catch (error) {
		return unverified(`harness launch failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { status: "UNVERIFIED", breaks: [], producer: result, counts: undefined };
	}
	if (!isReport(parsed)) return { status: "UNVERIFIED", breaks: [], producer: result, counts: undefined };
	const counts = parsed.counts as MetamorphicCliReport["counts"];
	const breaks = Array.isArray(parsed.breaks) ? parsed.breaks as MetamorphicBreak[] : [];
	const status = parsed.status === "PASS" && breaks.length === 0 ? "PASS"
		: parsed.status === "FAIL" ? "FAIL" : "UNVERIFIED";
	if ((status === "PASS") !== (result.code === 0)) {
		return { status: "UNVERIFIED", breaks, producer: result, counts };
	}
	return { status, breaks, producer: result, counts };
}
