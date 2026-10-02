import { isAbsolute } from "node:path";
import { runBundled } from "./runtime.ts";

const HARNESS = "scripts/ttsr-harness.ts";

export interface MutantsInput {
	/** Release root carrying rules/, cases/ and scripts/ttsr-harness.ts. */
	root: string;
	/** Compiled release executable selecting the release root. */
	executablePath: string;
	/** Read-only external rules directory; defaults to the bundled pack. */
	rules?: string;
	/** External TSV cases file; defaults to the bundled cases. */
	cases?: string;
	/** Wall-clock budget in seconds; the run stops early and reports truncated. */
	budgetSecs?: number;
}

export interface MutantSurvivor {
	kind: string;
	edit: string;
}

export interface MutantRuleReport {
	rule: string;
	cases: number;
	mutants: number;
	killed: number;
	score: number | null;
	skipped_compile: number;
	baseline_failures: number;
	survivors: MutantSurvivor[];
}

export interface MutantsReport {
	rules: MutantRuleReport[];
	totals: { rules: number; mutants: number; killed: number; score: number | null; skipped_compile: number };
	truncated: boolean;
	budget_secs: number;
}

export class MutantsInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "MutantsInputError";
	}
}

function isReport(value: unknown): value is MutantsReport {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const report = value as Record<string, unknown>;
	return Array.isArray(report["rules"])
		&& typeof report["totals"] === "object" && report["totals"] !== null
		&& typeof report["truncated"] === "boolean";
}

/** Token mutants of rule conditions, evaluated through the real matcher. */
export async function runMutants(input: MutantsInput): Promise<MutantsReport> {
	if (![input.root, input.executablePath].every(value => typeof value === "string" && isAbsolute(value))) {
		throw new MutantsInputError("MUTANTS_UNAVAILABLE", "Release root and executable must be absolute paths");
	}
	if (input.rules !== undefined && (typeof input.rules !== "string" || !isAbsolute(input.rules))) {
		throw new MutantsInputError("INVALID_MUTANTS_SELECTION", "External rules need an absolute directory");
	}
	if (input.cases !== undefined && (typeof input.cases !== "string" || !isAbsolute(input.cases))) {
		throw new MutantsInputError("INVALID_MUTANTS_SELECTION", "External cases need an absolute file");
	}
	if ((input.rules === undefined) !== (input.cases === undefined)) {
		throw new MutantsInputError("INVALID_MUTANTS_SELECTION", "External packs need both --rules and --cases");
	}
	const budget = input.budgetSecs ?? 300;
	if (!Number.isSafeInteger(budget) || budget < 1) {
		throw new MutantsInputError("INVALID_MUTANT_BUDGET", "The mutant budget needs a positive integer number of seconds");
	}
	const args = ["--mutants", "--mutant-budget-secs", String(budget),
		...(input.rules !== undefined ? ["--rules", input.rules] : []),
		...(input.cases !== undefined ? ["--cases", input.cases] : [])];
	const result = await runBundled(HARNESS, args, input.root, input.executablePath);
	if (result.code !== 0) {
		throw new MutantsInputError("MUTANTS_UNAVAILABLE",
			`Mutant evaluation failed (rc=${result.code}): ${(result.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new MutantsInputError("MUTANTS_UNAVAILABLE", "Mutant evaluation printed no parseable report");
	}
	if (!isReport(parsed)) {
		throw new MutantsInputError("MUTANTS_UNAVAILABLE", "Mutant evaluation report has the wrong shape");
	}
	return parsed;
}
