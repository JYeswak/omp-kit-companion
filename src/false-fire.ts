import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { digest, EXTERNAL_PACK_LIMITS, readBoundedFile, readExternalPackSnapshot, type ExternalPackSnapshot } from "./external-pack.ts";
import { reduceCandidate, type EvaluationContext, type PredicateOutcome } from "./reducer.ts";
import { runtimeTempRoot } from "./runtime.ts";
import { runMatcherObservation, type MatcherObservation, type MatcherObservationReport } from "./test-runner.ts";
import { isRecord } from "./type-guards.ts";
import { isSha256Hex } from "./regex-guards.ts";

export const FALSE_FIRE_SCHEMA_VERSION = 1 as const;
export const FALSE_FIRE_APPROVED_FIELDS = ["rule", "expect", "source", "tool", "path", "snippet"] as const;
const HASH_FIELDS = [
	"omp_launcher_sha256", "omp_package_sha256", "matcher_sha256", "omp_rule_parser_sha256", "native_sha256",
	"harness_runtime_sha256", "kit_harness_sha256", "policy_sha256", "rule_loader_sha256", "rule_sha256",
] as const;
const FIXTURE_MAX_BYTES = 128 * 1024;
const REDUCER_MAX_ATTEMPTS = 128;
const REDUCER_TIME_BUDGET_MS = EXTERNAL_PACK_LIMITS.totalTimeoutMs;
const OBSERVATION_TIMEOUT_MS = EXTERNAL_PACK_LIMITS.perCaseTimeoutMs;
const CASE_NOTE = "public-synthetic false-fire reduction";
const FALSE_FIRE_SCOPE = "NATIVE_G2_G3_FALSE_FIRE" as const;

export type FalseFireIdentityHashField = typeof HASH_FIELDS[number];
export type FalseFireIdentityPins = Readonly<Record<FalseFireIdentityHashField, string>>;
type StableHashField = FalseFireIdentityHashField;
type HashPins = FalseFireIdentityPins;
export interface FalseFireWitness {
	rule: string;
	expect: "quiet";
	source: "text" | "thinking" | "tool";
	tool: string;
	path: string;
	snippet: string;
}
export interface FalseFireFixture {
	schema_version: typeof FALSE_FIRE_SCHEMA_VERSION;
	classification: "public-synthetic";
	approved_fields: typeof FALSE_FIRE_APPROVED_FIELDS;
	witness: FalseFireWitness;
	preserve: { prefix: string; suffix: string };
	predicate: "G2" | "G3";
	identity_pins?: FalseFireIdentityPins;
}
export type FalseFireStatus = "REDUCED" | "UNCHANGED" | "REPRODUCED" | "NOT_REPRODUCED" | "UNAVAILABLE" | "MINIMIZATION_INCOMPLETE";
export interface FalseFireReport {
	scope: typeof FALSE_FIRE_SCOPE;
	status: FalseFireStatus;
	attempts: number;
	original_bytes: number;
	candidate_bytes: number | null;
	replay_fixture: FalseFireFixture | null;
}
export interface FalseFireRunInput {
	root: string;
	executablePath: string;
	rulesDirectory: string;
	fixturePath: string;
	replayOnly?: boolean;
}

export class FalseFireInputError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "FalseFireInputError";
	}
}


function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const keys = Object.keys(value);
	return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
		&& keys.every(key => required.includes(key) || optional.includes(key));
}

function decodeFixture(bytes: Uint8Array): FalseFireFixture {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new FalseFireInputError("FIXTURE_JSON_INVALID");
	}
	if (!isRecord(value) || !exactKeys(value,
		["schema_version", "classification", "approved_fields", "witness", "preserve", "predicate"], ["identity_pins"])
		|| value.schema_version !== FALSE_FIRE_SCHEMA_VERSION || value.classification !== "public-synthetic"
		|| !Array.isArray(value.approved_fields) || value.approved_fields.length !== FALSE_FIRE_APPROVED_FIELDS.length
		|| new Set(value.approved_fields).size !== FALSE_FIRE_APPROVED_FIELDS.length
		|| !value.approved_fields.every(field => typeof field === "string" && FALSE_FIRE_APPROVED_FIELDS.includes(field as typeof FALSE_FIRE_APPROVED_FIELDS[number]))
		|| (value.predicate !== "G2" && value.predicate !== "G3") || !isRecord(value.witness)
		|| !exactKeys(value.witness, FALSE_FIRE_APPROVED_FIELDS)
		|| !isRecord(value.preserve) || !exactKeys(value.preserve, ["prefix", "suffix"])) {
		throw new FalseFireInputError("FIXTURE_SCHEMA_INVALID");
	}
	const witness = value.witness;
	if (typeof witness.rule !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(witness.rule)
		|| witness.expect !== "quiet" || (witness.source !== "text" && witness.source !== "thinking" && witness.source !== "tool")
		|| typeof witness.tool !== "string" || typeof witness.path !== "string" || typeof witness.snippet !== "string"
		|| Buffer.byteLength(witness.snippet) > 1024 * 1024 || witness.snippet.includes("\r")
		|| /\\[nt]/.test(witness.snippet) || [witness.rule, witness.source, witness.tool, witness.path].some(
			field => typeof field !== "string" || /[\t\r\n\0]/.test(field))) {
		throw new FalseFireInputError("FIXTURE_WITNESS_INVALID");
	}
	if (!isRecord(value.preserve) || typeof value.preserve.prefix !== "string" || value.preserve.prefix.length === 0
		|| typeof value.preserve.suffix !== "string" || value.preserve.suffix.length === 0
		|| !witness.snippet.startsWith(value.preserve.prefix) || !witness.snippet.endsWith(value.preserve.suffix)
		|| value.preserve.prefix.includes("\r") || value.preserve.suffix.includes("\r")) {
		throw new FalseFireInputError("FIXTURE_PRESERVE_INVALID");
	}
	if (value.identity_pins !== undefined) {
		if (!isRecord(value.identity_pins) || !exactKeys(value.identity_pins, HASH_FIELDS)
			|| Object.values(value.identity_pins).some(digest => !isSha256Hex(digest))) {
			throw new FalseFireInputError("FIXTURE_IDENTITY_PINS_INVALID");
		}
	}
	return value as unknown as FalseFireFixture;
}

function caseText(fixture: FalseFireFixture, snippet: string): string {
	const { witness } = fixture;
	const encodedSnippet = snippet.replace(/\t/g, "\\t").replace(/\n/g, "\\n");
	return `rule\texpect\tsource\ttool\tpath\tsnippet\tnote\n${witness.rule}\tquiet\t${witness.source}\t${witness.tool}\t${witness.path}\t${encodedSnippet}\t${CASE_NOTE}\n`;
}

function rulesFingerprint(pack: ExternalPackSnapshot): string {
	return JSON.stringify(pack.rules.map(rule => [rule.name, rule.sha256]));
}

function hashesFrom(observation: MatcherObservation): HashPins | null {
	if (observation.status !== "OK") return null;
	const hashes = {} as Record<StableHashField, string>;
	for (const field of HASH_FIELDS) {
		const digest = observation.bindings[field];
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return null;
		hashes[field] = digest;
	}
	return Object.freeze(hashes);
}

function matchesPins(hashes: HashPins, fixture: FalseFireFixture): boolean {
	const pins = fixture.identity_pins;
	return pins === undefined || Object.entries(pins).every(([field, digest]) => hashes[field as StableHashField] === digest);
}

function predicateOutcome(
	fixture: FalseFireFixture,
	observation: MatcherObservation,
	hashes: HashPins,
): PredicateOutcome {
	const identity = hashes;
	if (observation.status !== "OK") return { status: "UNAVAILABLE", reason: "native-observation-unavailable" };
	if (!matchesPins(hashes, fixture)) return { status: "UNAVAILABLE", reason: "identity-pin-mismatch" };
	const held = fixture.predicate === "G2" ? observation.whole === "fire" : observation.prefix !== null;
	return { status: held ? "HOLD" : "LOSE", identity };
}

function replayFixture(fixture: FalseFireFixture, snippet: string, hashes: HashPins): FalseFireFixture {
	return {
		schema_version: FALSE_FIRE_SCHEMA_VERSION,
		classification: "public-synthetic",
		approved_fields: FALSE_FIRE_APPROVED_FIELDS,
		witness: { ...fixture.witness, snippet },
		preserve: { prefix: fixture.preserve.prefix, suffix: fixture.preserve.suffix },
		predicate: fixture.predicate,
		identity_pins: hashes,
	};
}

function unavailable(attempts = 0, originalBytes = 0, candidateBytes: number | null = null): FalseFireReport {
	return { scope: FALSE_FIRE_SCOPE, status: "UNAVAILABLE", attempts, original_bytes: originalBytes,
		candidate_bytes: candidateBytes, replay_fixture: null };
}

export async function runFalseFireReduction(input: FalseFireRunInput): Promise<FalseFireReport> {
	if (![input.root, input.executablePath, input.rulesDirectory, input.fixturePath].every(path => typeof path === "string" && isAbsolute(path))) {
		throw new FalseFireInputError("ABSOLUTE_PATHS_REQUIRED");
	}
	const fixtureBytes = readBoundedFile(input.fixturePath, FIXTURE_MAX_BYTES, "false-fire fixture");
	const fixtureDigest = digest(fixtureBytes);
	const fixture = decodeFixture(fixtureBytes);
	const scratch = mkdtempSync(join(runtimeTempRoot(), "false-fire-"));
	const casesPath = join(scratch, "witness.tsv");
	const originalBytes = Buffer.byteLength(fixture.witness.snippet);
	let baselineRules = "";
	let attempts = 0;
	let lastHashes: HashPins | null = null;
	try {
		writeFileSync(casesPath, caseText(fixture, fixture.witness.snippet), { mode: 0o600, flag: "wx" });
		const baseline = readExternalPackSnapshot(input.rulesDirectory, casesPath);
		baselineRules = rulesFingerprint(baseline);
		const selectedRule = baseline.rules.find(rule => rule.name === fixture.witness.rule);
		if (!selectedRule || baseline.cases.length !== 1) throw new FalseFireInputError("FIXTURE_SELECTION_INVALID");
		const selected = baseline.cases[0];
		if (selected.rule !== fixture.witness.rule || selected.expect !== "quiet" || selected.source !== fixture.witness.source
			|| selected.tool !== fixture.witness.tool || selected.path !== fixture.witness.path || selected.snippet !== fixture.witness.snippet) {
			throw new FalseFireInputError("FIXTURE_CASE_ROUNDTRIP_INVALID");
		}

		const observe = async (snippet: string, context?: EvaluationContext): Promise<PredicateOutcome> => {
			if (context?.signal.aborted) return { status: "UNAVAILABLE", reason: "time-budget" };
			if (!snippet.startsWith(fixture.preserve.prefix) || !snippet.endsWith(fixture.preserve.suffix)) {
				if (!lastHashes) return { status: "UNAVAILABLE", reason: "identity-not-yet-observed" };
				return { status: "LOSE", identity: lastHashes, reason: "preserve-context-lost" };
			}
			writeFileSync(casesPath, caseText(fixture, snippet), { mode: 0o600 });
			const pack = readExternalPackSnapshot(input.rulesDirectory, casesPath);
			if (rulesFingerprint(pack) !== baselineRules || pack.rules.find(rule => rule.name === fixture.witness.rule)?.sha256 !== selectedRule.sha256
				|| pack.cases.length !== 1 || pack.cases[0].snippet !== snippet) {
				return { status: "UNAVAILABLE", reason: "input-changed-or-case-mismatch" };
			}
			attempts++;
			const report: MatcherObservationReport = await runMatcherObservation({
				root: input.root,
				executablePath: input.executablePath,
				rules: input.rulesDirectory,
				cases: casesPath,
				rule: fixture.witness.rule,
				caseLine: 2,
				expectedRuleSha256: selectedRule.sha256,
				timeoutMs: Math.max(1, Math.min(OBSERVATION_TIMEOUT_MS, Math.floor(context?.remainingMs ?? OBSERVATION_TIMEOUT_MS))),
			});
			const hashes = hashesFrom(report.observation);
			if (!hashes || report.observation.status !== "OK" || report.observation.bindings.cases_sha256 !== pack.casesSha256) {
				return { status: "UNAVAILABLE", reason: "native-identity-or-case-pin-invalid" };
			}
			lastHashes = hashes;
			return predicateOutcome(fixture, report.observation, hashes);
		};
		const finalizeInputs = (): boolean => {
			try {
				const fixtureNow = readBoundedFile(input.fixturePath, FIXTURE_MAX_BYTES, "false-fire fixture");
				if (digest(fixtureNow) !== fixtureDigest) return false;
				const rulesNow = readExternalPackSnapshot(input.rulesDirectory, casesPath);
				return rulesFingerprint(rulesNow) === baselineRules;
			} catch {
				return false;
			}
		};

		if (input.replayOnly) {
			const outcome = await observe(fixture.witness.snippet);
			if (!finalizeInputs() || outcome.status === "UNAVAILABLE" || !lastHashes) return unavailable(attempts, originalBytes);
			if (outcome.status !== "HOLD") return { ...unavailable(attempts, originalBytes), status: "NOT_REPRODUCED" };
			return { scope: FALSE_FIRE_SCOPE, status: "REPRODUCED", attempts, original_bytes: originalBytes,
				candidate_bytes: originalBytes, replay_fixture: replayFixture(fixture, fixture.witness.snippet, lastHashes) };
		}

		const result = await reduceCandidate(fixture.witness.snippet, {
			grammar: "lines",
			maxAttempts: REDUCER_MAX_ATTEMPTS,
			timeBudgetMs: REDUCER_TIME_BUDGET_MS,
			predicate: (snippet, context) => observe(snippet, context),
			finalReplay: (snippet, context) => observe(snippet, context),
		});
		if (!finalizeInputs()) return unavailable(attempts, originalBytes, result.candidateBytes);
		if (result.trace[0]?.phase === "initial" && result.trace[0].status === "LOSE") {
			return { scope: FALSE_FIRE_SCOPE, status: "NOT_REPRODUCED", attempts, original_bytes: originalBytes,
				candidate_bytes: null, replay_fixture: null };
		}
		if (result.status === "UNAVAILABLE" || !result.identity || !lastHashes) return unavailable(attempts, originalBytes, result.candidateBytes);
		if (result.status === "MINIMIZATION_INCOMPLETE") {
			return { scope: FALSE_FIRE_SCOPE, status: "MINIMIZATION_INCOMPLETE", attempts, original_bytes: originalBytes,
				candidate_bytes: result.candidateBytes, replay_fixture: null };
		}
		if ((result.status !== "REDUCED" && result.status !== "UNCHANGED") || !result.candidate || result.finalReplay?.status !== "HOLD") {
			return { scope: FALSE_FIRE_SCOPE, status: "MINIMIZATION_INCOMPLETE", attempts, original_bytes: originalBytes,
				candidate_bytes: result.candidateBytes, replay_fixture: null };
		}
		const resultHashes = {} as Record<StableHashField, string>;
		for (const field of HASH_FIELDS) {
			const digest = result.identity[field];
			if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return unavailable(attempts, originalBytes, result.candidateBytes);
			resultHashes[field] = digest;
		}
		return { scope: FALSE_FIRE_SCOPE, status: result.status, attempts, original_bytes: originalBytes,
			candidate_bytes: result.candidateBytes, replay_fixture: replayFixture(fixture, result.candidate, Object.freeze(resultHashes)) };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
