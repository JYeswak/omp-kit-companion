import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExternalPackInputError, readExternalPackSnapshot, type ExternalCaseSnapshot, type ExternalPackSnapshot } from "./external-pack.ts";
import { reviewAuthoredRuleChange, witnessKey, type AuthoredRuleWitness, type RuleReviewObservation, type RuleReviewReport, type RuleReviewSide } from "./rule-review.ts";
import { runtimeTempRoot } from "./runtime.ts";
import { runMatcherObservation, type MatcherObservation, type ProducerCapture } from "./test-runner.ts";
import { compare } from "./output.ts";

export interface InstalledRuleReviewInput {
	root: string;
	executablePath: string;
	incumbentRules: string;
	incumbentCases: string;
	candidateRules: string;
	candidateCases: string;
}

export interface InstalledRuleReviewReport {
	status: "COMPLETE" | "UNAVAILABLE";
	scope: "MATCHER_PREFIX_ONLY";
	reason: string | null;
	review: RuleReviewReport | null;
	selectedPacksUnchanged: boolean;
	identityBracket: { before: MatcherObservation; after: MatcherObservation; unchanged: boolean; intermediateIdentitiesMatch: boolean } | null;
	producers: { phase: "before" | "incumbent" | "candidate" | "after"; witnessId: string; capture: ProducerCapture }[];
}

const MAX_WITNESSES = 1024;
const REVIEW_BUDGET_MS = 120_000;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function authored(pack: ExternalPackSnapshot): AuthoredRuleWitness[] {
	return pack.cases.map(row => {
		// TSV has no authored ID column. Contextual input identity excludes the expectation,
		// so relabeling it retains both authored variants rather than erasing the old label.
		const contextualInput = [row.rule, row.source, row.tool, row.path, row.snippet];
		return {
			id: row.rule + ":" + sha(JSON.stringify(contextualInput)), rule: row.rule,
			contentSha256: sha(JSON.stringify([...contextualInput, row.expect])),
			case: { source: row.source, tool: row.tool, path: row.path, expect: row.expect, context: row.snippet },
			provenance: { sourceFile: pack.casesFile, sourceLine: row.line, sourceSha256: pack.casesSha256, expectation: row.expect },
		};
	});
}

function fingerprint(pack: ExternalPackSnapshot): string {
	return JSON.stringify({
		rules: pack.rules.map(rule => [rule.name, rule.sha256, lstatSync(rule.path).mode & 0o777]),
		rulesMode: lstatSync(pack.rulesDirectory).mode & 0o777,
		cases: [pack.casesSha256, lstatSync(pack.casesFile).mode & 0o777],
	});
}

function sameBindings(left: MatcherObservation, right: MatcherObservation, allowRuleChange = false): boolean {
	return left.status === "OK" && right.status === "OK"
		&& Object.keys(left.bindings).length === Object.keys(right.bindings).length
		&& Object.entries(left.bindings).every(([key, value]) => (allowRuleChange && key === "rule_sha256") || right.bindings[key] === value);
}

function caseRow(row: ExternalCaseSnapshot): string {
	const snippet = row.snippet.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
	return [row.rule, row.expect, row.source, row.tool, row.path, snippet, row.note].join("\t");
}

/** Read-only selected-pack comparison, using only the existing isolated native observer. */
export async function runInstalledRuleReview(input: InstalledRuleReviewInput): Promise<InstalledRuleReviewReport> {
	const result: InstalledRuleReviewReport = {
		status: "UNAVAILABLE", scope: "MATCHER_PREFIX_ONLY", reason: null, review: null,
		selectedPacksUnchanged: false, identityBracket: null, producers: [],
	};
	let scratch: string | undefined;
	try {
		const packs = {
			incumbent: readExternalPackSnapshot(input.incumbentRules, input.incumbentCases),
			candidate: readExternalPackSnapshot(input.candidateRules, input.candidateCases),
		};
		const before = { incumbent: fingerprint(packs.incumbent), candidate: fingerprint(packs.candidate) };
		const sides: Record<"incumbent" | "candidate", RuleReviewSide> = {
			incumbent: { rules: packs.incumbent.rules, witnesses: authored(packs.incumbent), observations: [] },
			candidate: { rules: packs.candidate.rules, witnesses: authored(packs.candidate), observations: [] },
		};
		const union = new Map<string, { witness: AuthoredRuleWitness; row: ExternalCaseSnapshot }>();
		for (const side of ["incumbent", "candidate"] as const) {
			for (let index = 0; index < sides[side].witnesses.length; index++) {
				const witness = sides[side].witnesses[index]!;
				const key = witnessKey(witness);
				if (!union.has(key)) union.set(key, { witness, row: packs[side].cases[index]! });
			}
		}
		if (union.size === 0 || union.size > MAX_WITNESSES) {
			result.reason = union.size === 0 ? "NO_AUTHORED_WITNESSES" : "REVIEW_WITNESS_LIMIT";
			return result;
		}
		const frozen = [...union.entries()].sort(([left], [right]) => compare(left, right)).map(([, value]) => value);
		scratch = mkdtempSync(join(runtimeTempRoot(), "omp-kit-review-"));
		const cases = join(scratch, "frozen-witnesses.tsv");
		writeFileSync(cases, "rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n" + frozen.map(({ row }) => caseRow(row)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
		const ruleMaps = {
			incumbent: new Map(packs.incumbent.rules.map(rule => [rule.name, rule])),
			candidate: new Map(packs.candidate.rules.map(rule => [rule.name, rule])),
		};
		const deadline = performance.now() + REVIEW_BUDGET_MS;
		async function observe(side: "incumbent" | "candidate", index: number, phase: "before" | "incumbent" | "candidate" | "after"): Promise<MatcherObservation> {
			const { witness } = frozen[index]!;
			const rule = ruleMaps[side].get(witness.rule);
			const remaining = Math.floor(deadline - performance.now());
			if (!rule || remaining < 1) {
				return { status: "UNAVAILABLE", evaluator: "UNAVAILABLE", rule: witness.rule, case_line: index + 2,
					reason: rule ? "REVIEW_BUDGET_EXHAUSTED" : "SELECTED_RULE_MISSING" };
			}
			const observed = await runMatcherObservation({ root: input.root, executablePath: input.executablePath,
				rules: packs[side].rulesDirectory, cases, rule: witness.rule, caseLine: index + 2,
				expectedRuleSha256: rule.sha256, timeoutMs: Math.min(30_000, remaining) });
			result.producers.push({ phase, witnessId: witness.id, capture: observed.producer });
			return observed.observation;
		}
		// The same actual native observation brackets the entire paired run. No second
		// implementation of OMP/native-library hashing is maintained by this adapter.
		const anchorIndex = frozen.findIndex(({ witness }) => ruleMaps.incumbent.has(witness.rule) || ruleMaps.candidate.has(witness.rule));
		if (anchorIndex < 0) { result.reason = "NO_SELECTED_RULE_FOR_WITNESSES"; return result; }
		const anchorSide = ruleMaps.incumbent.has(frozen[anchorIndex]!.witness.rule) ? "incumbent" : "candidate";
		const first = await observe(anchorSide, anchorIndex, "before");
		let unavailable = first.status !== "OK";
		let intermediateIdentitiesMatch = first.status === "OK";
		for (const side of ["incumbent", "candidate"] as const) {
			const observations: RuleReviewObservation[] = [];
			for (let index = 0; index < frozen.length; index++) {
				const { witness } = frozen[index]!;
				const observation = await observe(side, index, side);
				if (observation.status !== "OK") unavailable = true;
				else if (!sameBindings(first, observation, true)) intermediateIdentitiesMatch = false;
				observations.push({ witnessId: witness.id, witnessContentSha256: witness.contentSha256, observation });
			}
			sides[side] = { ...sides[side], observations };
		}
		const last = await observe(anchorSide, anchorIndex, "after");
		result.identityBracket = { before: first, after: last, unchanged: sameBindings(first, last), intermediateIdentitiesMatch };
		result.review = reviewAuthoredRuleChange(sides);
		result.selectedPacksUnchanged = before.incumbent === fingerprint(readExternalPackSnapshot(input.incumbentRules, input.incumbentCases))
			&& before.candidate === fingerprint(readExternalPackSnapshot(input.candidateRules, input.candidateCases));
		if (!result.selectedPacksUnchanged) result.reason = "SELECTED_INPUTS_CHANGED";
		else if (!result.identityBracket.unchanged || !result.identityBracket.intermediateIdentitiesMatch) result.reason = "IDENTITY_BRACKET_UNAVAILABLE_OR_CHANGED";
		else if (unavailable || last.status !== "OK") result.reason = "NATIVE_OBSERVATION_UNAVAILABLE";
		else result.status = "COMPLETE";
		return result;
	} catch (error) {
		result.reason = error instanceof ExternalPackInputError ? error.code : "REVIEW_UNAVAILABLE";
		return result;
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
}
