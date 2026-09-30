import { describe, expect, test } from "bun:test";
import { reviewAuthoredRuleChange, type AuthoredRuleWitness, type RuleReviewInput } from "../../src/rule-review.ts";
import type { MatcherObservation } from "../../src/test-runner.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CASES_SHA = "c".repeat(64);
const sharedBindings: Record<string, string> = {
	omp_launcher: "/opt/omp/bin/omp",
	omp_package: "/opt/omp/releases/18.4.2",
	omp_source: "/opt/omp/releases/18.4.2/src",
	native_package: "/opt/omp/releases/18.4.2/node_modules/@oh-my-pi/pi-natives",
	kit_root: "/tmp/omp-kit/releases/v1",
	harness_runtime: "/tmp/omp-kit/bin/omp-kit",
	omp_launcher_sha256: HASH_A,
	omp_package_sha256: HASH_A,
	matcher_sha256: HASH_A,
	omp_rule_parser_sha256: HASH_A,
	native_sha256: HASH_A,
	harness_runtime_sha256: HASH_A,
	kit_harness_sha256: HASH_A,
	policy_sha256: HASH_A,
	rule_loader_sha256: HASH_A,
};

function witness(id: string, expect: "fire" | "quiet", sourceLine: number, context = id): AuthoredRuleWitness {
	return {
		id,
		rule: "review-fixture",
		contentSha256: id === "incumbent-quiet" ? HASH_A : HASH_B,
		case: { source: "tool", tool: "bash", path: "-", expect, context },
		provenance: { sourceFile: "cases/cases.tsv", sourceLine, sourceSha256: CASES_SHA, expectation: expect },
	};
}

// Reducer-only fixtures: structured observations here are inputs, not claims about matcher execution.

function observation(
	whole: "fire" | "quiet",
	expect: "fire" | "quiet",
	ruleSha: string,
	prefix: Extract<MatcherObservation, { status: "OK" }>["prefix"],
): MatcherObservation {
	return {
		status: "OK",
		rule: "review-fixture",
		case_line: 2,
		registration: "REGISTERED",
		whole,
		evaluator: "OK",
		prefix,
		witness: { source: "tool", tool: "bash", path: "-", expect },
		bindings: { ...sharedBindings, rule_sha256: ruleSha, cases_sha256: CASES_SHA },
	};
}

function erasedQuietInput(): RuleReviewInput {
	const incumbentQuiet = witness("incumbent-quiet", "quiet", 3, "concrete path, stderr hidden");
	const relabelledCandidate = witness("candidate-renamed", "fire", 4, "broadened path matcher");
	const incumbentSha = HASH_A;
	const candidateSha = HASH_B;
	return {
		incumbent: {
			rules: [{ name: "review-fixture", sha256: incumbentSha }],
			witnesses: [incumbentQuiet],
			observations: [
				{ witnessId: incumbentQuiet.id, witnessContentSha256: incumbentQuiet.contentSha256, observation: observation("quiet", "quiet", incumbentSha, null) },
				{ witnessId: relabelledCandidate.id, witnessContentSha256: relabelledCandidate.contentSha256, observation: observation("quiet", "fire", incumbentSha, null) },
			],
		},
		candidate: {
			rules: [{ name: "review-fixture", sha256: candidateSha }],
			witnesses: [relabelledCandidate],
			observations: [
				// The frozen union requires the incumbent's quiet bytes to be exercised against the new rule.
				{ witnessId: incumbentQuiet.id, witnessContentSha256: incumbentQuiet.contentSha256, observation: observation("fire", "quiet", candidateSha, { phase: "stream", position: 2, wire_length: 31 }) },
				{ witnessId: relabelledCandidate.id, witnessContentSha256: relabelledCandidate.contentSha256, observation: observation("fire", "fire", candidateSha, { phase: "stream", position: 2, wire_length: 31 }) },
			],
		},
	};
}

describe("reviewAuthoredRuleChange", () => {
	test("ERASED_QUIET retains a deleted/relabelled incumbent quiet witness and reports its new fire", () => {
		const input = erasedQuietInput();
		const before = structuredClone(input);
		const report = reviewAuthoredRuleChange(input);
		const erased = report.transitions.find((item) => item.witnessId === "incumbent-quiet");

		expect(erased).toBeDefined();
		expect(erased?.expectationProvenance.incumbent).toMatchObject({ sourceLine: 3, expectation: "quiet" });
		expect(erased?.incumbent).toMatchObject({ status: "OK", whole: "quiet", prefix: null });
		expect(erased?.candidate).toMatchObject({ status: "OK", whole: "fire", witness: { expect: "quiet" } });
		expect(erased?.prefixUnits).toEqual({
			unit: "UTF16_CODE_UNITS",
			incumbent: { position: null, phase: null, wireLength: null, finalSentinel: false },
			candidate: { position: 2, phase: "stream", wireLength: 31, finalSentinel: false },
		});
		expect(report.witnesses.removed).toContain("incumbent-quiet");
		expect(report.witnesses.added).toContain("candidate-renamed");
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "WITNESS_REMOVED", witnessId: "incumbent-quiet" }));
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "WITNESS_ADDED", witnessId: "candidate-renamed" }));
		expect(report.transitions.map((item) => item.witnessId)).toContain("incumbent-quiet");
		expect(report.transitions.map((item) => item.witnessId)).toContain("candidate-renamed");
		expect(report.rules.changed).toContain("review-fixture");
		expect(report.denominator).toEqual({ exercised: 2, total: 2 });
		expect(report.status).toBe("CONFLICTS");
		expect(input).toEqual(before);

		// Candidate-only union mutation: deleting the incumbent observation must fail closed, not erase its denominator row.
		const candidateOnly = erasedQuietInput();
		candidateOnly.candidate.observations = candidateOnly.candidate.observations.filter((item) => item.witnessId !== "incumbent-quiet");
		const mutated = reviewAuthoredRuleChange(candidateOnly);
		expect(mutated.conflicts).toContainEqual(expect.objectContaining({ kind: "MISSING_OBSERVATION", witnessId: "incumbent-quiet" }));
		expect(mutated.denominator).toEqual({ exercised: 1, total: 2 });
	});
	test("added/removed rules are explicit conflicts without suppressing paired witness transitions", () => {
		const input = erasedQuietInput();
		input.incumbent.rules = [...input.incumbent.rules, { name: "obsolete", sha256: HASH_A }];
		input.candidate.rules = [...input.candidate.rules, { name: "fresh", sha256: HASH_B }];
		const report = reviewAuthoredRuleChange(input);

		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "RULE_REMOVED", detail: expect.stringContaining("obsolete") }));
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "RULE_ADDED", detail: expect.stringContaining("fresh") }));
		expect(report.transitions.map((item) => item.witnessId)).toContain("incumbent-quiet");
		expect(report.transitions.map((item) => item.witnessId)).toContain("candidate-renamed");
	});

	test("final prefix sentinel and phase survive the UTF-16 unit label", () => {
		const input = erasedQuietInput();
		const oldQuiet = input.incumbent.witnesses[0]!;
		input.candidate.observations = input.candidate.observations.map((item) => item.witnessId === oldQuiet.id
			? { ...item, observation: observation("fire", "quiet", HASH_B, { phase: "final", position: 32, wire_length: 31 }) }
			: item);

		const report = reviewAuthoredRuleChange(input);
		expect(report.transitions.find((item) => item.witnessId === oldQuiet.id)?.prefixUnits).toEqual({
			unit: "UTF16_CODE_UNITS",
			incumbent: { position: null, phase: null, wireLength: null, finalSentinel: false },
			candidate: { position: 32, phase: "final", wireLength: 31, finalSentinel: true },
		});
	});

	test("orders witness transitions by locale-independent ASCII order", () => {
		const input = erasedQuietInput();
		const cases = [witness("a", "quiet", 3), witness("Z", "quiet", 4)];
		const observations = cases.map((item) => ({
			witnessId: item.id,
			witnessContentSha256: item.contentSha256,
			observation: observation("quiet", "quiet", HASH_A, null),
		}));
		input.incumbent.rules = [{ name: "review-fixture", sha256: HASH_A }];
		input.candidate.rules = [{ name: "review-fixture", sha256: HASH_A }];
		input.incumbent.witnesses = cases;
		input.candidate.witnesses = structuredClone(cases);
		input.incumbent.observations = observations;
		input.candidate.observations = structuredClone(observations);

		const report = reviewAuthoredRuleChange(input);
		expect(report.transitions.map((item) => item.witnessId)).toEqual(["Z", "a"]);
	});


	test("identical exercised inputs report a bounded no-delta denominator", () => {
		const input = erasedQuietInput();
		input.candidate = structuredClone(input.incumbent);
		const report = reviewAuthoredRuleChange(input);

		expect(report.status).toBe("NO_DELTA_IN_EXERCISED_WITNESSES");
		expect(report.denominator).toEqual({ exercised: 1, total: 1 });
	});

	test("duplicate identities and a missing side rule are explicit conflicts", () => {
		const input = erasedQuietInput();
		const original = input.incumbent.witnesses[0]!;
		input.incumbent.witnesses = [...input.incumbent.witnesses, original];
		input.candidate.rules = [];
		const report = reviewAuthoredRuleChange(input);

		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "DUPLICATE_WITNESS_ID", witnessId: original.id }));
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "MISSING_RULE", witnessId: original.id }));
		expect(report.status).toBe("CONFLICTS");
	});

	test("changed contextual input is removed and added while both variants remain observed", () => {
		const input = erasedQuietInput();
		const incumbent = input.incumbent.witnesses[0]!;
		const candidate = {
			...incumbent,
			id: "incumbent-quiet-new-context",
			contentSha256: HASH_B,
			case: { ...incumbent.case, context: "updated authored context" },
		};
		input.candidate.witnesses = [candidate];
		input.incumbent.observations = [
			...input.incumbent.observations.filter((item) => item.witnessId === incumbent.id),
			{ witnessId: candidate.id, witnessContentSha256: candidate.contentSha256, observation: observation("quiet", "quiet", HASH_A, null) },
		];
		input.candidate.observations = [
			...input.candidate.observations.filter((item) => item.witnessId === incumbent.id),
			{ witnessId: candidate.id, witnessContentSha256: candidate.contentSha256, observation: observation("fire", "quiet", HASH_B, { phase: "stream", position: 4, wire_length: 31 }) },
		];
		const report = reviewAuthoredRuleChange(input);

		expect(report.witnesses.contextChanged).toEqual([]);
		expect(report.witnesses.removed).toContain(incumbent.id);
		expect(report.witnesses.added).toContain(candidate.id);
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "WITNESS_REMOVED", witnessId: incumbent.id }));
		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "WITNESS_ADDED", witnessId: candidate.id }));
		expect(report.transitions.map((item) => item.witnessId)).toContain(incumbent.id);
		expect(report.transitions.map((item) => item.witnessId)).toContain(candidate.id);
		expect(report.denominator).toEqual({ exercised: 2, total: 2 });
	});

	test("a relabelled expectation keeps contextual identity and both expectation variants", () => {
		const input = erasedQuietInput();
		const incumbent = { ...witness("same-context", "quiet", 3, "same authored context"), contentSha256: HASH_A };
		const candidate = {
			...incumbent,
			contentSha256: HASH_B,
			case: { ...incumbent.case, expect: "fire" as const },
			provenance: { ...incumbent.provenance, expectation: "fire" as const },
		};
		const variants = [incumbent, candidate];
		input.incumbent.witnesses = [incumbent];
		input.candidate.witnesses = [candidate];
		input.incumbent.observations = variants.map((item) => ({
			witnessId: item.id,
			witnessContentSha256: item.contentSha256,
			observation: observation("quiet", item.case.expect, HASH_A, null),
		}));
		input.candidate.observations = variants.map((item) => ({
			witnessId: item.id,
			witnessContentSha256: item.contentSha256,
			observation: observation("fire", item.case.expect, HASH_B, { phase: "stream", position: 2, wire_length: 31 }),
		}));

		const report = reviewAuthoredRuleChange(input);
		expect(report.witnesses.expectationChanged).toEqual([incumbent.id]);
		expect(report.witnesses.added).toEqual([]);
		expect(report.witnesses.removed).toEqual([]);
		expect(report.transitions).toHaveLength(2);
		expect(report.denominator).toEqual({ exercised: 2, total: 2 });
	});
	test("rejects paired observations whose complete policy identity differs", () => {
		const input = erasedQuietInput();
		const first = input.candidate.observations[0]!;
		if (first.observation.status !== "OK") throw new Error("test setup requires a complete candidate observation");
		input.candidate.observations = [
			{ ...first, observation: { ...first.observation, bindings: { ...first.observation.bindings, policy_sha256: HASH_B } } },
			...input.candidate.observations.slice(1),
		];
		const report = reviewAuthoredRuleChange(input);

		expect(report.conflicts).toContainEqual(expect.objectContaining({ kind: "IDENTITY_MISMATCH" }));
		expect(report.status).toBe("CONFLICTS");
	});
});
