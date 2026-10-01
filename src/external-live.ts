import { isRecord } from "./type-guards.ts";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	ExternalPackInputError,
	digest,
	EXTERNAL_PACK_LIMITS,
	readBoundedFile,
	readExternalPackSnapshot,
	runExternalPackTest,
	type ExternalPackReport,
	type ExternalPackSnapshot,
} from "./external-pack.ts";
import { releaseRoot } from "./paths.ts";
import { runBundled, runtimeTempRoot } from "./runtime.ts";
import { runMatcherObservation, type MatcherObservation, type MatcherObservationInput } from "./test-runner.ts";

const SCRIPT = "scripts/external-live.mjs";
const FIXTURE_LIMIT = 1024 * 1024;
const BUNDLE_ASSETS = [
	"scripts/external-live.mjs",
	"scripts/runtime-adapter.sh",
	"scripts/limit-process-tree.sh",
	"scripts/ttsr-harness.ts",
	"scripts/rule-class.ts",
	"tests/live/lib.mjs",
	"tests/live/mock-model.mjs",
	"tests/live/scenarios.json",
	"policy/ttsr.json",
] as const;
const SCENARIO_LIMIT = 64 * 1024;
const RULE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SCENARIO_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type ExternalLiveRole = "allow" | "block" | "quiet";
export type ExternalLiveMarkerEffect = "present" | "absent";

export interface ExternalLiveScenario {
	readonly id: string;
	readonly role: ExternalLiveRole;
	readonly content: string;
	readonly expected_marker_effect: ExternalLiveMarkerEffect;
}

export interface ExternalLiveFixture {
	readonly schema_version: 1;
	readonly classification: "public-synthetic";
	readonly rule: string;
	readonly scenarios: readonly [ExternalLiveScenario, ExternalLiveScenario, ExternalLiveScenario];
}

export interface ExternalLiveInput {
	readonly root: string;
	readonly executablePath: string;
	readonly pack: ExternalPackSnapshot;
	readonly fixturePath: string;
}

export class ExternalLiveInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ExternalLiveInputError";
	}
}

export interface ExternalLiveScenarioReport {
	readonly id: string;
	readonly role: ExternalLiveRole;
	readonly expected_marker_effect: ExternalLiveMarkerEffect;
	readonly marker: { readonly present: boolean; readonly sha256: string | null; readonly byte_length: number };
	readonly native_system_interrupt: boolean;
	readonly model_main_requests: number;
	readonly omp_exit_code: number | null;
	readonly omp_diagnostic: "EXIT_ZERO" | "TIMEOUT" | "KILLED" | "NONZERO" | "NOT_RUN";
	readonly content_sha256: string;
	readonly failures: readonly string[];
}

export type ExternalLiveRuntimeIdentity = Readonly<Record<typeof IDENTITY_HASH_FIELDS[number], string>>;

export interface ExternalLiveRuntimeIdentitySnapshot {
	readonly before: ExternalLiveRuntimeIdentity | null;
	readonly after: ExternalLiveRuntimeIdentity | null;
	readonly unchanged: boolean;
}

export interface ExternalLiveBundleIdentitySnapshot {
	readonly before: readonly { readonly asset: string; readonly sha256: string }[];
	readonly after: readonly { readonly asset: string; readonly sha256: string }[];
	readonly unchanged: boolean;
}
export interface ExternalLiveReport {
	readonly status: "PASS" | "FAIL" | "BLOCKED";
	readonly scope: "EXTERNAL_CUSTOM_G4";
	readonly fast: ExternalPackReport;
	readonly live: {
		readonly status: "PASS" | "FAIL" | "NOT_RUN";
		readonly rule: string;
		readonly rule_sha256: string;
		readonly scenarios: readonly ExternalLiveScenarioReport[];
		readonly runtime_identity: ExternalLiveRuntimeIdentitySnapshot;
		readonly bundle_identity: ExternalLiveBundleIdentitySnapshot;
		readonly snapshots: {
			readonly unchanged: boolean;
			readonly fixture_sha256_before: string;
			readonly fixture_sha256_after: string;
			readonly pack_sha256_before: string;
			readonly pack_sha256_after: string;
		};
		readonly producer_rc: number | null;
		readonly failures: readonly string[];
	};
}

export interface ExternalLiveEvidence {
	readonly expectedMarkerEffect: ExternalLiveMarkerEffect;
	readonly markerPresent: boolean;
	readonly markerSha256: string | null;
	readonly expectedContentSha256: string;
	readonly nativeSystemInterrupt: boolean;
}

export interface ExternalLiveEvidenceVerdict {
	readonly status: "PASS" | "FAIL";
	readonly failures: readonly string[];
}

function inputError(code: string, message: string): never {
	throw new ExternalLiveInputError(code, message);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function utf8Bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function bundleAssets(root: string): ExternalLiveBundleIdentitySnapshot["before"] {
	return Object.freeze(BUNDLE_ASSETS.map(asset => Object.freeze({ asset,
		sha256: digest(readBoundedFile(join(root, asset), 4 * 1024 * 1024, `Packaged asset ${asset}`)) })));
}

function bundleIdentity(
	before: ExternalLiveBundleIdentitySnapshot["before"],
	after: ExternalLiveBundleIdentitySnapshot["after"],
): ExternalLiveBundleIdentitySnapshot {
	const unchanged = before.length === after.length && before.every((item, index) =>
		item.asset === after[index]?.asset && item.sha256 === after[index]?.sha256);
	return Object.freeze({ before, after, unchanged });
}

export function validateExternalLiveSchema(value: unknown): ExternalLiveFixture {
	if (!isRecord(value) || !exactKeys(value, ["schema_version", "classification", "rule", "scenarios"])
		|| value.schema_version !== 1 || value.classification !== "public-synthetic"
		|| typeof value.rule !== "string" || !RULE_NAME.test(value.rule)
		|| !Array.isArray(value.scenarios) || value.scenarios.length !== 3) {
		return inputError("INVALID_EXTERNAL_LIVE_SCHEMA", "Fixture requires schema_version 1, public-synthetic classification, one rule, and exactly three scenarios");
	}
	const ids = new Set<string>();
	const roles = new Set<ExternalLiveRole>();
	const scenarios: ExternalLiveScenario[] = [];
	for (const raw of value.scenarios) {
		if (!isRecord(raw) || !exactKeys(raw, ["id", "role", "content", "expected_marker_effect"])
			|| typeof raw.id !== "string" || !SCENARIO_ID.test(raw.id) || ids.has(raw.id)
			|| (raw.role !== "allow" && raw.role !== "block" && raw.role !== "quiet")
			|| typeof raw.content !== "string" || raw.content.length === 0
			|| utf8Bytes(raw.content).length > SCENARIO_LIMIT || raw.content.includes("\0")
			|| (raw.expected_marker_effect !== "present" && raw.expected_marker_effect !== "absent")) {
			return inputError("INVALID_EXTERNAL_LIVE_SCHEMA", "Each scenario needs a unique safe id, allow/block/quiet role, bounded content, and explicit marker effect");
		}
		const role = raw.role as ExternalLiveRole;
		const expected = role === "block" ? "absent" : "present";
		if (roles.has(role) || raw.expected_marker_effect !== expected) {
			return inputError("INVALID_EXTERNAL_LIVE_SCHEMA", "Fixture requires one allow/present, one block/absent, and one quiet/present scenario");
		}
		ids.add(raw.id);
		roles.add(role);
		scenarios.push(Object.freeze({ id: raw.id, role, content: raw.content, expected_marker_effect: expected }));
	}
	if (roles.size !== 3) return inputError("INVALID_EXTERNAL_LIVE_SCHEMA", "Fixture requires one scenario for each allow, block, and quiet role");
	return Object.freeze({ schema_version: 1, classification: "public-synthetic", rule: value.rule,
		scenarios: Object.freeze(scenarios) as unknown as ExternalLiveFixture["scenarios"] });
}

export function evaluateExternalLiveEvidence(evidence: ExternalLiveEvidence): ExternalLiveEvidenceVerdict {
	const failures: string[] = [];
	if (evidence.expectedMarkerEffect === "absent") {
		if (evidence.markerPresent) failures.push("EXPECTED_BLOCKED_MARKER_PRESENT");
		if (!evidence.nativeSystemInterrupt) failures.push("NATIVE_SYSTEM_INTERRUPT_NOT_OBSERVED");
		if (!evidence.markerPresent && evidence.markerSha256 !== null) failures.push("ABSENT_MARKER_HAS_DIGEST");
	} else {
		if (!evidence.markerPresent) failures.push("EXPECTED_MARKER_ABSENT");
		if (evidence.markerPresent && evidence.markerSha256 !== evidence.expectedContentSha256) failures.push("MARKER_BYTES_MISMATCH");
		if (evidence.nativeSystemInterrupt) failures.push("UNEXPECTED_NATIVE_SYSTEM_INTERRUPT");
	}
	return Object.freeze({ status: failures.length === 0 ? "PASS" : "FAIL", failures: Object.freeze(failures) });
}

function externalFixture(input: ExternalLiveInput): { fixture: ExternalLiveFixture; bytes: Uint8Array } {
	if (!isRecord(input) || !exactKeys(input as unknown as Record<string, unknown>, ["root", "executablePath", "pack", "fixturePath"])) {
		return inputError("INVALID_EXTERNAL_LIVE_INPUT", "root, executablePath, pack, and fixturePath are required");
	}
	if (![input.root, input.executablePath, input.fixturePath].every(path => typeof path === "string" && isAbsolute(path))) {
		return inputError("INVALID_EXTERNAL_LIVE_INPUT", "root, executablePath, and fixturePath must be absolute paths");
	}
	const bytes = readBoundedFile(input.fixturePath, FIXTURE_LIMIT, "External live fixture");
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return inputError("INVALID_EXTERNAL_LIVE_SCHEMA", "Fixture must be valid UTF-8 JSON");
	}
	return { fixture: validateExternalLiveSchema(parsed), bytes };
}

function packData(pack: ExternalPackSnapshot): string {
	return JSON.stringify({
		rulesDirectory: pack.rulesDirectory,
		casesFile: pack.casesFile,
		rules: pack.rules.map(rule => [rule.name, rule.path, rule.sha256]),
		cases: pack.cases.map(row => [row.line, row.rule, row.expect, row.source, row.tool, row.path, row.snippet, row.note]),
		casesSha256: pack.casesSha256,
	});
}

function packSnapshot(pack: ExternalPackSnapshot): { snapshot: ExternalPackSnapshot; sha256: string } {
	if (!isRecord(pack) || typeof pack.rulesDirectory !== "string" || typeof pack.casesFile !== "string"
		|| !isAbsolute(pack.rulesDirectory) || !isAbsolute(pack.casesFile)) {
		return inputError("INVALID_EXTERNAL_LIVE_PACK", "A validated absolute ExternalPackSnapshot is required");
	}
	const snapshot = readExternalPackSnapshot(pack.rulesDirectory, pack.casesFile);
	if (packData(snapshot) !== packData(pack)) {
		return inputError("EXTERNAL_LIVE_PACK_SNAPSHOT_MISMATCH", "External pack differs from the supplied G1-G3 snapshot");
	}
	return { snapshot, sha256: digest(packData(snapshot)) };
}

const IDENTITY_HASH_FIELDS = [
	"omp_launcher_sha256", "omp_package_sha256", "matcher_sha256", "omp_rule_parser_sha256", "native_sha256",
	"harness_runtime_sha256", "kit_harness_sha256", "policy_sha256", "rule_loader_sha256", "rule_sha256", "cases_sha256",
] as const;

interface BoundNativeIdentity {
	readonly bindings: Readonly<Record<string, string>>;
	readonly hashes: ExternalLiveRuntimeIdentity;
}

function bindNativeIdentity(observation: MatcherObservation): BoundNativeIdentity | null {
	if (observation.status !== "OK") return null;
	const bindings = observation.bindings;
	if (IDENTITY_HASH_FIELDS.some(key => typeof bindings[key] !== "string" || !/^[a-f0-9]{64}$/.test(bindings[key]!))) return null;
	const hashes = Object.fromEntries(IDENTITY_HASH_FIELDS.map(key => [key, bindings[key]])) as ExternalLiveRuntimeIdentity;
	return Object.freeze({ bindings: Object.freeze({ ...bindings }), hashes: Object.freeze(hashes) });
}

function sameIdentity(left: BoundNativeIdentity, right: BoundNativeIdentity): boolean {
	const keys = Object.keys(left.bindings).sort();
	const rightKeys = Object.keys(right.bindings).sort();
	return keys.length === rightKeys.length && keys.every((key, index) => key === rightKeys[index]
		&& left.bindings[key] === right.bindings[key]);
}

function blankLive(
	rule: string,
	ruleSha256: string,
	fixtureSha256: string,
	packSha256: string,
	bundleIdentitySnapshot: ExternalLiveBundleIdentitySnapshot,
): ExternalLiveReport["live"] {
	return Object.freeze({ status: "NOT_RUN", rule, rule_sha256: ruleSha256, scenarios: Object.freeze([]),
		runtime_identity: Object.freeze({ before: null, after: null, unchanged: false }),
		bundle_identity: bundleIdentitySnapshot,
		snapshots: Object.freeze({ unchanged: true, fixture_sha256_before: fixtureSha256,
			fixture_sha256_after: fixtureSha256, pack_sha256_before: packSha256, pack_sha256_after: packSha256 }),
		producer_rc: null, failures: Object.freeze([]) });
}

function outputRecord(value: unknown): value is Record<string, unknown> & {
	status: string; rule: string; rule_sha256: string; scenarios: unknown[];
} {
	return isRecord(value) && typeof value.status === "string" && typeof value.rule === "string"
		&& typeof value.rule_sha256 === "string" && Array.isArray(value.scenarios);
}

function observationInput(root: string, executablePath: string, pack: ExternalPackSnapshot, rule: string, ruleSha256: string): MatcherObservationInput {
	const fireCase = pack.cases.find(row => row.rule === rule && row.expect === "fire");
	if (!fireCase) return inputError("INCOMPLETE_EXTERNAL_COVERAGE", "External rule has no fire case for native identity binding");
	return { root, executablePath, rules: pack.rulesDirectory, cases: pack.casesFile, rule,
		caseLine: fireCase.line, expectedRuleSha256: ruleSha256, timeoutMs: EXTERNAL_PACK_LIMITS.perCaseTimeoutMs };
}

async function observeNativeIdentity(
	root: string, executablePath: string, pack: ExternalPackSnapshot, rule: string, ruleSha256: string,
): Promise<BoundNativeIdentity | null> {
	const report = await runMatcherObservation(observationInput(root, executablePath, pack, rule, ruleSha256));
	return bindNativeIdentity(report.observation);
}

/** Run one selected external pack's G1-G3 once, then its data-only G4 fixture. */
export async function runExternalLive(input: ExternalLiveInput): Promise<ExternalLiveReport> {
	const { fixture, bytes: fixtureBytes } = externalFixture(input);
	const beforePack = packSnapshot(input.pack);
	const selectedRule = beforePack.snapshot.rules.find(rule => rule.name === fixture.rule);
	if (!selectedRule) return inputError("EXTERNAL_LIVE_RULE_NOT_IN_PACK", "Fixture rule is absent from the supplied external pack");
	const release = realpathSync(input.root);
	if (releaseRoot(input.executablePath) !== release) return inputError("EXTERNAL_LIVE_RELEASE_MISMATCH", "Executable and release root do not identify the same release");
	const fixtureShaBefore = digest(fixtureBytes);
	const bundleBefore = bundleAssets(release);
	const fast = await runExternalPackTest({ root: release, executablePath: input.executablePath, pack: beforePack.snapshot });
	const afterFastPack = packSnapshot(input.pack);
	const fixtureAfterFast = digest(readBoundedFile(input.fixturePath, FIXTURE_LIMIT, "External live fixture"));
	const bundleAfterFast = bundleAssets(release);
	const bundleAfterFastIdentity = bundleIdentity(bundleBefore, bundleAfterFast);
	const inputsUnchangedAfterFast = beforePack.sha256 === afterFastPack.sha256 && fixtureShaBefore === fixtureAfterFast
		&& bundleAfterFastIdentity.unchanged;
	if (fast.status !== "PASS") {
		return Object.freeze({ status: fast.status, scope: "EXTERNAL_CUSTOM_G4", fast,
			live: Object.freeze({ ...blankLive(fixture.rule, selectedRule.sha256, fixtureShaBefore, beforePack.sha256, bundleAfterFastIdentity),
				snapshots: Object.freeze({ unchanged: inputsUnchangedAfterFast, fixture_sha256_before: fixtureShaBefore,
					fixture_sha256_after: fixtureAfterFast, pack_sha256_before: beforePack.sha256, pack_sha256_after: afterFastPack.sha256 }),
				failures: Object.freeze(inputsUnchangedAfterFast ? [] : ["SELECTED_INPUTS_CHANGED_BEFORE_LIVE"]) }) });
	}
	if (!inputsUnchangedAfterFast) {
		return Object.freeze({ status: "FAIL", scope: "EXTERNAL_CUSTOM_G4", fast,
			live: Object.freeze({ ...blankLive(fixture.rule, selectedRule.sha256, fixtureShaBefore, beforePack.sha256, bundleAfterFastIdentity),
				snapshots: Object.freeze({ unchanged: false, fixture_sha256_before: fixtureShaBefore,
					fixture_sha256_after: fixtureAfterFast, pack_sha256_before: beforePack.sha256, pack_sha256_after: afterFastPack.sha256 }),
				failures: Object.freeze(["SELECTED_INPUTS_CHANGED_BEFORE_LIVE"]) }) });
	}

	let identityBefore: BoundNativeIdentity | null = null;
	try { identityBefore = await observeNativeIdentity(release, input.executablePath, beforePack.snapshot, fixture.rule, selectedRule.sha256); }
	catch { /* The native observer reports unavailable evidence; fail closed below. */ }
	if (!identityBefore) {
		return Object.freeze({ status: "BLOCKED", scope: "EXTERNAL_CUSTOM_G4", fast,
			live: Object.freeze({ ...blankLive(fixture.rule, selectedRule.sha256, fixtureShaBefore, beforePack.sha256, bundleAfterFastIdentity),
				failures: Object.freeze(["NATIVE_IDENTITY_UNAVAILABLE_BEFORE_LIVE"]) }) });
	}

	let workspace: string | undefined;
	let producerRc: number | null = null;
	let scriptReport: Record<string, unknown> | undefined;
	const liveFailures: string[] = [];
	const scenarioReports: ExternalLiveScenarioReport[] = [];
	let identityAfter: BoundNativeIdentity | null = null;
	let fixtureShaAfter = fixtureShaBefore;
	let packAfterSha = beforePack.sha256;
	let inputsUnchanged = true;
	let bundleAfter = bundleAfterFast;
	try {
		workspace = mkdtempSync(join(runtimeTempRoot(), "omp-kit-external-live-"));
		const ruleBytes = readBoundedFile(selectedRule.path, EXTERNAL_PACK_LIMITS.ruleBytes, "Selected external rule");
		if (digest(ruleBytes) !== selectedRule.sha256) {
			liveFailures.push("SELECTED_RULE_CHANGED_BEFORE_LIVE");
		} else {
			writeFileSync(join(workspace, "selected-rule.md"), ruleBytes, { flag: "wx", mode: 0o600 });
			const manifest = {
				rule: fixture.rule,
				ruleSha256: selectedRule.sha256,
				scenarios: fixture.scenarios.map(scenario => ({ ...scenario, contentSha256: digest(utf8Bytes(scenario.content)) })),
			};
			writeFileSync(join(workspace, "run.json"), `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
			const run = await runBundled(SCRIPT, [workspace], release, input.executablePath);
			producerRc = run.code;
			if (run.code !== 0) {
				const reason = run.stderr.trim().split(/\r?\n/, 1)[0] ?? "";
				liveFailures.push(/^[A-Z][A-Z0-9_]+$/.test(reason)
					? `EXTERNAL_LIVE_PRODUCER_FAILED:${reason}` : "EXTERNAL_LIVE_PRODUCER_FAILED");
			}
			else {
				try { scriptReport = JSON.parse(run.stdout) as Record<string, unknown>; }
				catch { liveFailures.push("INVALID_EXTERNAL_LIVE_PRODUCER_REPORT"); }
			}
		}
	} catch (error) {
		liveFailures.push(error instanceof ExternalPackInputError ? error.code : "EXTERNAL_LIVE_UNAVAILABLE");
	} finally {
		try { identityAfter = await observeNativeIdentity(release, input.executablePath, beforePack.snapshot, fixture.rule, selectedRule.sha256); }
		catch { /* Missing post-run observer evidence is reported fail-closed. */ }
		if (!identityAfter) liveFailures.push("NATIVE_IDENTITY_UNAVAILABLE_AFTER_LIVE");
		try {
			const after = packSnapshot(input.pack);
			packAfterSha = after.sha256;
			fixtureShaAfter = digest(readBoundedFile(input.fixturePath, FIXTURE_LIMIT, "External live fixture"));
			inputsUnchanged = after.sha256 === beforePack.sha256 && fixtureShaAfter === fixtureShaBefore;
		try { bundleAfter = bundleAssets(release); }
		catch { bundleAfter = Object.freeze([]); }
		} catch {
			inputsUnchanged = false;
		}
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	}

	if (identityAfter && !sameIdentity(identityBefore, identityAfter)) liveFailures.push("NATIVE_RUNTIME_IDENTITY_CHANGED_DURING_LIVE");
	if (!inputsUnchanged) liveFailures.push("SELECTED_INPUTS_CHANGED_DURING_LIVE");
	const finalBundleIdentity = bundleIdentity(bundleBefore, bundleAfter);
	if (!finalBundleIdentity.unchanged) liveFailures.push("PACKAGED_LIVE_ASSETS_CHANGED_DURING_LIVE");
	if (scriptReport) {
		if (!outputRecord(scriptReport) || scriptReport.rule !== fixture.rule || scriptReport.rule_sha256 !== selectedRule.sha256
			|| !/^[a-f0-9]{64}$/.test(scriptReport.rule_sha256) || !["PASS", "FAIL"].includes(scriptReport.status)
			|| scriptReport.scenarios.length !== fixture.scenarios.length) {
			liveFailures.push("INVALID_EXTERNAL_LIVE_PRODUCER_REPORT");
		} else {
			for (let index = 0; index < fixture.scenarios.length; index++) {
				const expected = fixture.scenarios[index]!;
				const observed = scriptReport.scenarios[index];
				if (!isRecord(observed) || observed.id !== expected.id || observed.role !== expected.role
					|| observed.expected_marker_effect !== expected.expected_marker_effect || !isRecord(observed.marker)) {
					liveFailures.push(`INVALID_SCENARIO_REPORT:${expected.id}`);
					continue;
				}
				const markerPresent = observed.marker.present;
				const markerSha = observed.marker.sha256;
				const markerLength = observed.marker.byte_length;
				const nativeInterrupt = observed.native_system_interrupt;
				const requestCount = observed.model_main_requests;
				const exitCode = observed.omp_exit_code;
				const diagnostic = observed.omp_diagnostic;
				const validMarker = typeof markerPresent === "boolean" && typeof markerLength === "number"
					&& Number.isSafeInteger(markerLength) && markerLength >= 0
					&& (markerPresent
						? typeof markerSha === "string" && /^[a-f0-9]{64}$/.test(markerSha)
							&& markerLength > 0 && typeof observed.marker.matches_expected === "boolean"
						: markerSha === null && markerLength === 0);
				const validScenario = validMarker && typeof nativeInterrupt === "boolean"
					&& typeof requestCount === "number" && Number.isSafeInteger(requestCount) && requestCount >= 0
					&& typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= 0
					&& ["EXIT_ZERO", "TIMEOUT", "KILLED", "NONZERO"].includes(String(diagnostic));
				if (!validScenario) {
					liveFailures.push(`INVALID_SCENARIO_REPORT:${expected.id}`);
					continue;
				}
				const markerHash = markerSha as string | null;
				const expectedContentSha256 = digest(utf8Bytes(expected.content));
				const evidence = evaluateExternalLiveEvidence({ expectedMarkerEffect: expected.expected_marker_effect,
					markerPresent: markerPresent as boolean, markerSha256: markerHash, expectedContentSha256,
					nativeSystemInterrupt: nativeInterrupt });
				const failures = [...evidence.failures];
				if (exitCode !== 0) failures.push("OMP_SCENARIO_FAILED");
				if (requestCount < 1) failures.push("MOCK_MODEL_NOT_REACHED");
				if (markerPresent && observed.marker.matches_expected !== true) failures.push("MARKER_CONTENT_MISMATCH");
				if (markerPresent && markerLength !== utf8Bytes(expected.content).length) failures.push("MARKER_LENGTH_MISMATCH");
				const expectedDiagnostic = exitCode === 0 ? "EXIT_ZERO" : exitCode === 124 ? "TIMEOUT"
					: exitCode === 137 ? "KILLED" : "NONZERO";
				if (diagnostic !== expectedDiagnostic) failures.push("OMP_DIAGNOSTIC_MISMATCH");
				const report: ExternalLiveScenarioReport = Object.freeze({ id: expected.id, role: expected.role,
					expected_marker_effect: expected.expected_marker_effect,
					marker: Object.freeze({ present: markerPresent as boolean, sha256: markerHash, byte_length: markerLength }),
					native_system_interrupt: nativeInterrupt, model_main_requests: requestCount,
					omp_exit_code: exitCode, omp_diagnostic: diagnostic as ExternalLiveScenarioReport["omp_diagnostic"],
					content_sha256: expectedContentSha256, failures: Object.freeze(failures) });
				scenarioReports.push(report);
				liveFailures.push(...failures.map(reason => `${expected.id}:${reason}`));
			}
			if (scriptReport.status !== "PASS") liveFailures.push("EXTERNAL_LIVE_SCENARIOS_FAILED");
		}
	}
	const status = liveFailures.length === 0 && scenarioReports.length === 3 ? "PASS" : producerRc === null ? "BLOCKED" : "FAIL";
	const snapshots = Object.freeze({ unchanged: inputsUnchanged && finalBundleIdentity.unchanged, fixture_sha256_before: fixtureShaBefore,
		fixture_sha256_after: fixtureShaAfter, pack_sha256_before: beforePack.sha256, pack_sha256_after: packAfterSha });
	return Object.freeze({ status: status === "PASS" ? "PASS" : status, scope: "EXTERNAL_CUSTOM_G4", fast,
		live: Object.freeze({ status: status === "PASS" ? "PASS" : status === "BLOCKED" ? "NOT_RUN" : "FAIL",
			rule: fixture.rule, rule_sha256: selectedRule.sha256, scenarios: Object.freeze(scenarioReports),
			runtime_identity: Object.freeze({ before: identityBefore.hashes, after: identityAfter?.hashes ?? null,
				unchanged: identityAfter !== null && sameIdentity(identityBefore, identityAfter) }),
			bundle_identity: finalBundleIdentity,
			snapshots, producer_rc: producerRc, failures: Object.freeze(liveFailures) }) });
}
