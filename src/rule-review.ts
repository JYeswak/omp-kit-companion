import { isAbsolute } from "node:path";
import type { MatcherObservation } from "./test-runner.ts";
import { compare } from "./output.ts";

export type RuleReviewExpectation = "fire" | "quiet";
export type RuleReviewSideName = "incumbent" | "candidate";

export interface AuthoredRuleSnapshot {
	name: string;
	sha256: string;
}

export interface AuthoredRuleWitness {
	/** Contextual ID binds rule/source/tool/path/snippet and excludes expectation; changed context is removed plus added. */
	id: string;
	rule: string;
	/** Hash of the exact authored case row, including context and expectation. */
	contentSha256: string;
	case: {
		source: "text" | "thinking" | "tool";
		tool: string;
		path: string;
		expect: RuleReviewExpectation;
		context: string;
	};
	provenance: {
		sourceFile: string;
		sourceLine: number;
		sourceSha256: string;
		expectation: RuleReviewExpectation;
	};
}

export interface RuleReviewObservation {
	witnessId: string;
	witnessContentSha256: string;
	observation: MatcherObservation;
}

export interface RuleReviewSide {
	rules: readonly AuthoredRuleSnapshot[];
	/** Authored on this side only. The reducer unions both sides before pairing observations. */
	witnesses: readonly AuthoredRuleWitness[];
	/** Must contain one observation per frozen-union witness variant, not only this side's cases. */
	observations: readonly RuleReviewObservation[];
}

export interface RuleReviewInput {
	incumbent: RuleReviewSide;
	candidate: RuleReviewSide;
}

export type RuleReviewConflictKind =
	| "INVALID_RULE_IDENTITY"
	| "DUPLICATE_RULE_NAME"
	| "DUPLICATE_WITNESS_ID"
	| "DUPLICATE_OBSERVATION"
	| "RULE_ADDED"
	| "RULE_REMOVED"
	| "WITNESS_ADDED"
	| "WITNESS_REMOVED"
	| "MISSING_RULE"
	| "MISSING_OBSERVATION"
	| "UNAVAILABLE_OBSERVATION"
	| "RULE_HASH_MISMATCH"
	| "INCOMPLETE_IDENTITY"
	| "IDENTITY_MISMATCH"
	| "WITNESS_MISMATCH"
	| "EXPECTATION_PROVENANCE_MISMATCH";

export interface RuleReviewConflict {
	kind: RuleReviewConflictKind;
	witnessId?: string;
	detail: string;
}

export interface RuleReviewPrefixPosition {
	position: number | null;
	phase: "stream" | "final" | null;
	wireLength: number | null;
	finalSentinel: boolean;
}

export interface RuleReviewPrefixUnits {
	unit: "UTF16_CODE_UNITS";
	incumbent: RuleReviewPrefixPosition;
	candidate: RuleReviewPrefixPosition;
}

export interface RuleReviewTransition {
	witnessId: string;
	witnessContentSha256: string;
	expectationProvenance: {
		incumbent?: AuthoredRuleWitness["provenance"];
		candidate?: AuthoredRuleWitness["provenance"];
	};
	incumbent: MatcherObservation;
	candidate: MatcherObservation;
	/** Prefix positions are UTF-16 code units; final phase preserves the terminal wire_length + 1 sentinel. */
	prefixUnits: RuleReviewPrefixUnits;
}

export interface RuleReviewReport {
	status: "CONFLICTS" | "DELTA" | "NO_DELTA_IN_EXERCISED_WITNESSES";
	rules: { added: string[]; removed: string[]; changed: string[] };
	witnesses: { added: string[]; removed: string[]; contextChanged: string[]; expectationChanged: string[] };
	denominator: { exercised: number; total: number };
	conflicts: readonly RuleReviewConflict[];
	transitions: readonly RuleReviewTransition[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY_PATH_KEYS = ["omp_launcher", "omp_package", "omp_source", "native_package", "kit_root", "harness_runtime"] as const;
const IDENTITY_HASH_KEYS = [
	"omp_launcher_sha256", "omp_package_sha256", "matcher_sha256", "omp_rule_parser_sha256", "native_sha256",
	"harness_runtime_sha256", "kit_harness_sha256", "policy_sha256", "rule_loader_sha256", "rule_sha256", "cases_sha256",
] as const;


export function witnessKey(witness: Pick<AuthoredRuleWitness, "id" | "contentSha256">): string {
	return `${witness.id}\0${witness.contentSha256}`;
}

function caseContent(witness: AuthoredRuleWitness): string {
	return JSON.stringify([witness.rule, witness.case.source, witness.case.tool, witness.case.path, witness.case.expect, witness.case.context]);
}

function addConflict(
	conflicts: RuleReviewConflict[],
	kind: RuleReviewConflictKind,
	detail: string,
	witnessId?: string,
): void {
	conflicts.push({ kind, detail, ...(witnessId === undefined ? {} : { witnessId }) });
}

function indexRules(side: RuleReviewSide, name: RuleReviewSideName, conflicts: RuleReviewConflict[]): Map<string, AuthoredRuleSnapshot> {
	const rules = new Map<string, AuthoredRuleSnapshot>();
	for (const rule of side.rules) {
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(rule.name) || !SHA256.test(rule.sha256)) {
			addConflict(conflicts, "INVALID_RULE_IDENTITY", `${name} rule has an invalid name or SHA256: ${rule.name}`);
			continue;
		}
		if (rules.has(rule.name)) {
			addConflict(conflicts, "DUPLICATE_RULE_NAME", `${name} contains rule ${rule.name} more than once`);
			continue;
		}
		rules.set(rule.name, rule);
	}
	return rules;
}

function indexWitnesses(
	side: RuleReviewSide,
	name: RuleReviewSideName,
	conflicts: RuleReviewConflict[],
): Map<string, AuthoredRuleWitness> {
	const witnesses = new Map<string, AuthoredRuleWitness>();
	const ids = new Set<string>();
	for (const source of side.witnesses) {
		if (!source.id.trim() || !/^[a-z0-9][a-z0-9._:-]*$/i.test(source.id)
			|| !SHA256.test(source.contentSha256) || !SHA256.test(source.provenance.sourceSha256)
			|| !Number.isSafeInteger(source.provenance.sourceLine) || source.provenance.sourceLine < 1
			|| source.provenance.expectation !== source.case.expect) {
			addConflict(conflicts, "EXPECTATION_PROVENANCE_MISMATCH", `${name} witness ${source.id || "<empty>"} has invalid identity or expectation provenance`, source.id);
			continue;
		}
		if (ids.has(source.id)) addConflict(conflicts, "DUPLICATE_WITNESS_ID", `${name} contains contextual witness id ${source.id} more than once`, source.id);
		ids.add(source.id);
		const key = witnessKey(source);
		const prior = witnesses.get(key);
		if (prior && caseContent(prior) !== caseContent(source)) {
			addConflict(conflicts, "WITNESS_MISMATCH", `${name} reuses contextual witness id ${source.id} with different content under one content hash`, source.id);
			continue;
		}
		if (!prior) {
			witnesses.set(key, Object.freeze({
				...source,
				case: Object.freeze({ ...source.case }),
				provenance: Object.freeze({ ...source.provenance }),
			}));
		}
	}
	return witnesses;
}

function indexObservations(
	side: RuleReviewSide,
	name: RuleReviewSideName,
	conflicts: RuleReviewConflict[],
): Map<string, MatcherObservation> {
	const observations = new Map<string, MatcherObservation>();
	for (const item of side.observations) {
		if (!item.witnessId || !SHA256.test(item.witnessContentSha256)) {
			addConflict(conflicts, "WITNESS_MISMATCH", `${name} observation has invalid witness identity`, item.witnessId);
			continue;
		}
		const key = `${item.witnessId}\0${item.witnessContentSha256}`;
		if (observations.has(key)) {
			addConflict(conflicts, "DUPLICATE_OBSERVATION", `${name} has more than one observation for witness ${item.witnessId}`, item.witnessId);
			continue;
		}
		observations.set(key, item.observation);
	}
	return observations;
}

function completeBindings(observation: MatcherObservation): observation is Extract<MatcherObservation, { status: "OK" }> {
	if (observation.status !== "OK") return false;
	const bindings = observation.bindings;
	return IDENTITY_PATH_KEYS.every((key) => typeof bindings[key] === "string" && isAbsolute(bindings[key]))
		&& IDENTITY_HASH_KEYS.every((key) => typeof bindings[key] === "string" && SHA256.test(bindings[key]));
}

function prefixPosition(observation: Extract<MatcherObservation, { status: "OK" }>): RuleReviewPrefixPosition {
	const prefix = observation.prefix;
	return prefix === null
		? { position: null, phase: null, wireLength: null, finalSentinel: false }
		: {
			position: prefix.position,
			phase: prefix.phase,
			wireLength: prefix.wire_length,
			finalSentinel: prefix.phase === "final" && prefix.position === prefix.wire_length + 1,
		};
}

function samePrefix(left: Extract<MatcherObservation, { status: "OK" }>, right: Extract<MatcherObservation, { status: "OK" }>): boolean {
	return left.prefix?.phase === right.prefix?.phase
		&& left.prefix?.position === right.prefix?.position
		&& left.prefix?.wire_length === right.prefix?.wire_length;
}



function compareBindings(
	left: Extract<MatcherObservation, { status: "OK" }>,
	right: Extract<MatcherObservation, { status: "OK" }>,
	conflicts: RuleReviewConflict[],
	witnessId: string,
): void {
	const leftBindings = left.bindings;
	const rightBindings = right.bindings;
	const allKeys = [...new Set([...Object.keys(leftBindings), ...Object.keys(rightBindings)])].sort(compare);
	for (const key of allKeys) {
		if (key === "rule_sha256") continue;
		if (leftBindings[key] !== rightBindings[key]) {
			addConflict(conflicts, "IDENTITY_MISMATCH", `incumbent/candidate ${key} binding differs`, witnessId);
			return;
		}
	}
}

/**
 * Reconcile old and new authored rules against both sides' observations of a frozen witness union.
 * This reports exercised matcher transitions only; it does not establish semantic equivalence,
 * safety, profile activation, or live blocking.
 */
export function reviewAuthoredRuleChange(input: RuleReviewInput): RuleReviewReport {
	const conflicts: RuleReviewConflict[] = [];
	const oldRules = indexRules(input.incumbent, "incumbent", conflicts);
	const newRules = indexRules(input.candidate, "candidate", conflicts);
	const oldWitnesses = indexWitnesses(input.incumbent, "incumbent", conflicts);
	const newWitnesses = indexWitnesses(input.candidate, "candidate", conflicts);
	const oldObservations = indexObservations(input.incumbent, "incumbent", conflicts);
	const newObservations = indexObservations(input.candidate, "candidate", conflicts);

	const addedRules: string[] = [];
	const removedRules: string[] = [];
	const changedRules: string[] = [];
	for (const [name, candidate] of newRules) {
		const incumbent = oldRules.get(name);
		if (!incumbent) addedRules.push(name);
		else if (incumbent.sha256 !== candidate.sha256) changedRules.push(name);
	}
	for (const name of oldRules.keys()) if (!newRules.has(name)) removedRules.push(name);

	for (const name of addedRules) addConflict(conflicts, "RULE_ADDED", `candidate adds rule ${name}`);
	for (const name of removedRules) addConflict(conflicts, "RULE_REMOVED", `candidate removes rule ${name}`);

	const union = new Map<string, AuthoredRuleWitness>();
	for (const [key, witness] of oldWitnesses) union.set(key, witness);
	for (const [key, witness] of newWitnesses) {
		const incumbent = union.get(key);
		if (incumbent && caseContent(incumbent) !== caseContent(witness)) {
			addConflict(conflicts, "WITNESS_MISMATCH", `contextual witness ${witness.id} has conflicting content under one content hash`, witness.id);
		} else if (!incumbent) {
			union.set(key, witness);
		}
	}
	const orderedUnion = [...union.entries()].sort(([left], [right]) => compare(left, right));
	const oldById = new Map<string, AuthoredRuleWitness>();
	const newById = new Map<string, AuthoredRuleWitness>();
	for (const witness of oldWitnesses.values()) oldById.set(witness.id, witness);
	for (const witness of newWitnesses.values()) newById.set(witness.id, witness);
	const addedWitnesses = [...newById.keys()].filter((id) => !oldById.has(id)).sort(compare);
	const removedWitnesses = [...oldById.keys()].filter((id) => !newById.has(id)).sort(compare);
	for (const id of addedWitnesses) addConflict(conflicts, "WITNESS_ADDED", `candidate adds contextual witness ${id}`, id);
	for (const id of removedWitnesses) addConflict(conflicts, "WITNESS_REMOVED", `candidate removes contextual witness ${id}`, id);
	const contextChanged: string[] = [];
	const expectationChanged: string[] = [];
	for (const [id, incumbent] of oldById) {
		const candidate = newById.get(id);
		if (!candidate) continue;
		if ((incumbent.rule !== candidate.rule || incumbent.case.source !== candidate.case.source || incumbent.case.tool !== candidate.case.tool || incumbent.case.path !== candidate.case.path || incumbent.case.context !== candidate.case.context)) {
			contextChanged.push(id);
			addConflict(conflicts, "WITNESS_MISMATCH", `contextual witness id ${id} changed its rule/source/tool/path/snippet identity`, id);
		}
		if (incumbent.case.expect !== candidate.case.expect) expectationChanged.push(id);
	}

	const transitions: RuleReviewTransition[] = [];
	let commonIdentity: string | undefined;
	for (const [key, witness] of orderedUnion) {
		const incumbentRule = oldRules.get(witness.rule);
		const candidateRule = newRules.get(witness.rule);
		if (!incumbentRule || !candidateRule) {
			addConflict(conflicts, "MISSING_RULE", `witness ${witness.id} refers to ${!incumbentRule ? "missing incumbent" : "missing candidate"} rule ${witness.rule}`, witness.id);
			continue;
		}
		const incumbentObservation = oldObservations.get(key);
		const candidateObservation = newObservations.get(key);
		if (!incumbentObservation || !candidateObservation) {
			addConflict(conflicts, "MISSING_OBSERVATION", `frozen union witness ${witness.id} is not observed on both sides`, witness.id);
			continue;
		}
		if (incumbentObservation.status === "UNAVAILABLE" || candidateObservation.status === "UNAVAILABLE") {
			addConflict(conflicts, "UNAVAILABLE_OBSERVATION", `witness ${witness.id} has an unavailable ${incumbentObservation.status === "UNAVAILABLE" ? "incumbent" : "candidate"} matcher observation`, witness.id);
			continue;
		}
		if (!completeBindings(incumbentObservation) || !completeBindings(candidateObservation)) {
			addConflict(conflicts, "INCOMPLETE_IDENTITY", `witness ${witness.id} lacks complete OMP/runtime/hash bindings`, witness.id);
			continue;
		}
		if (incumbentObservation.rule !== witness.rule || candidateObservation.rule !== witness.rule
			|| incumbentObservation.witness.source !== witness.case.source || candidateObservation.witness.source !== witness.case.source
			|| incumbentObservation.witness.tool !== witness.case.tool || candidateObservation.witness.tool !== witness.case.tool
			|| incumbentObservation.witness.path !== witness.case.path || candidateObservation.witness.path !== witness.case.path
			|| incumbentObservation.witness.expect !== witness.case.expect || candidateObservation.witness.expect !== witness.case.expect) {
			addConflict(conflicts, "WITNESS_MISMATCH", `matcher observation does not bind the authored witness ${witness.id}`, witness.id);
			continue;
		}
		if (incumbentObservation.bindings.rule_sha256 !== incumbentRule.sha256
			|| candidateObservation.bindings.rule_sha256 !== candidateRule.sha256) {
			addConflict(conflicts, "RULE_HASH_MISMATCH", `matcher observation rule SHA256 does not match the authored ${witness.rule} snapshot`, witness.id);
			continue;
		}
		compareBindings(incumbentObservation, candidateObservation, conflicts, witness.id);
		const commonBindings = Object.entries(incumbentObservation.bindings)
			.filter(([name]) => name !== "rule_sha256").sort(([left], [right]) => compare(left, right));
		const identity = JSON.stringify(commonBindings);
		if (commonIdentity !== undefined && commonIdentity !== identity) {
			addConflict(conflicts, "IDENTITY_MISMATCH", `witness ${witness.id} does not share the complete OMP/policy/cases identity`, witness.id);
		} else commonIdentity = identity;
		transitions.push({
			witnessId: witness.id,
			witnessContentSha256: witness.contentSha256,
			expectationProvenance: {
				...(oldWitnesses.get(key) ? { incumbent: oldWitnesses.get(key)!.provenance } : {}),
				...(newWitnesses.get(key) ? { candidate: newWitnesses.get(key)!.provenance } : {}),
			},
			incumbent: incumbentObservation,
			candidate: candidateObservation,
			prefixUnits: {
				unit: "UTF16_CODE_UNITS",
				incumbent: prefixPosition(incumbentObservation),
				candidate: prefixPosition(candidateObservation),
			},
		});
	}

	const delta = addedRules.length > 0 || removedRules.length > 0 || changedRules.length > 0
		|| addedWitnesses.length > 0 || removedWitnesses.length > 0 || contextChanged.length > 0 || expectationChanged.length > 0
		|| transitions.some(({ incumbent, candidate }) => incumbent.status === "OK" && candidate.status === "OK"
			&& (incumbent.whole !== candidate.whole || !samePrefix(incumbent, candidate)));
	return {
		status: conflicts.length ? "CONFLICTS" : delta ? "DELTA" : "NO_DELTA_IN_EXERCISED_WITNESSES",
		rules: {
			added: addedRules.sort(compare),
			removed: removedRules.sort(compare),
			changed: changedRules.sort(compare),
		},
		witnesses: {
			added: addedWitnesses,
			removed: removedWitnesses,
			contextChanged: contextChanged.sort(compare),
			expectationChanged: expectationChanged.sort(compare),
		},
		denominator: { exercised: transitions.length, total: orderedUnion.length },
		conflicts: Object.freeze(conflicts.sort((left, right) => compare(left.kind, right.kind)
			|| compare(left.witnessId ?? "", right.witnessId ?? "")
			|| compare(left.detail, right.detail))),
		transitions: Object.freeze(transitions),
	};
}
