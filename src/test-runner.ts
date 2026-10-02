import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { diagnose, type Finding } from "./diagnostics.ts";
import { resolveOmpIdentity, type OmpIdentity } from "./paths.ts";
import { runBundled, type BundledRunResult } from "./runtime.ts";

const HARNESS = "scripts/ttsr-harness.ts";
const EXPECTED = { rules: 22, ttsrRules: 21, cases: 295, quietCases: 150 } as const;
const SEEDED_PREFIX_PLANT = /^ok\s+plant \(b\) RED as intended: G3 plant-prefix-close quiet tool:bash line 3: fired on prefix/m;
const SELFTEST_GREEN = /^SELFTEST: all seven plants RED and named; controls GREEN$/m;

export interface FastTestInput {
	/** Absolute release root containing rules/, cases/, and scripts/ttsr-harness.ts. */
	root: string;
	/** Absolute installed stable executable symlink whose target is inside root's prefix. */
	executablePath: string;
	/** Absolute HOME to inspect for installed rules and profile evidence. */
	home: string;
	/** Optional absolute project path; diagnostics read it, but no project command is run. */
	project?: string;
}

export type FastProofStatus = "PASS" | "FAIL" | "NOT_RUN";
export type FastTestStatus = "PASS" | "FAIL" | "BLOCKED";
export type FastTestBlockerKind =
	| "OMP_UNAVAILABLE"
	| "NATIVE_MATCHER_UNAVAILABLE"
	| "OMP_IDENTITY_INVALID"
	| "BUNDLED_RUNTIME_UNAVAILABLE";

export interface ProducerCapture {
	/** Exact status returned by runBundled; null means the producer was not launched. */
	producer_rc: number | null;
	/** Complete producer stdout, with private host paths redacted. */
	stdout: string;
	/** Complete producer stderr, with private host paths redacted. */
	stderr: string;
}

export interface FastTestReport {
	/** Matcher result only; never a claim about an operator's effective profile. */
	status: FastTestStatus;
	exitCode: 0 | 1 | 3;
	proofs: {
		G1_registration: {
			status: FastProofStatus;
			expected_rules: number;
			expected_ttsr_rules: number;
			observed_rules: number | null;
			observed_ttsr_rules: number | null;
			failures: string[];
		};
		G2_payload: {
			status: FastProofStatus;
			expected_cases: number;
			observed_cases: number | null;
			failures: string[];
		};
		G3_quiet_prefix: {
			status: FastProofStatus;
			expected_cases: number;
			expected_quiet_cases: number;
			observed_cases: number | null;
			observed_quiet_cases: number | null;
			quiet_prefix_fires: number | null;
			seeded_plant: FastProofStatus;
			failures: string[];
		};
		G4_live: { status: "NOT_RUN"; reason: string };
	};
	diagnostics: {
		kit: Finding;
		manifest: Finding;
		omp: Finding;
		installed_rules: Finding;
		project_rules: Finding;
		effective_profile: Finding;
	};
	producers: {
		gate: ProducerCapture;
		selftest: ProducerCapture;
	};
	blocker?: { kind: FastTestBlockerKind; message: string; remedy: string };
	failures: string[];
}

interface GateSummary {
	rules: number;
	ttsrRules: number;
	cases: number;
	quietCases: number;
	quietPrefixFires: number;
	failures: number;
}
interface GateCheck {
	total: number;
	passed: number;
}
interface ParsedGate {
	status: "PASS" | "FAIL";
	summary: GateSummary;
	g1Registration: FastTestReport["proofs"]["G1_registration"];
	g2Payload: FastTestReport["proofs"]["G2_payload"];
	g3Prefix: FastTestReport["proofs"]["G3_quiet_prefix"];
	failures: string[];
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function finding(findings: readonly Finding[], component: string, reason: string): Finding {
	return findings.find((item) => item.component === component) ?? {
		component,
		status: "UNVERIFIED",
		reason,
		recommended_action: "Re-run the read-only diagnostic before relying on this evidence.",
	};
}

function redactor(
	input: { root: string; home?: string; project?: string },
	identity?: OmpIdentity,
	additionalPaths: readonly [string, string][] = [],
): (text: string) => string {
	const replacements: Array<[string, string]> = [];
	if (typeof input.root === "string" && isAbsolute(input.root)) replacements.push([input.root, "<release-root>"]);
	if (typeof input.home === "string" && isAbsolute(input.home)) replacements.push([input.home, "<home>"]);
	if (typeof input.project === "string" && isAbsolute(input.project)) replacements.push([input.project, "<project>"]);
	const inheritedHome = process.env.HOME;
	if (inheritedHome && isAbsolute(inheritedHome)) replacements.push([inheritedHome, "<home>"]);
	for (const [path, label] of additionalPaths) {
		if (typeof path === "string" && path && isAbsolute(path)) replacements.push([path, label]);
	}
	if (identity) {
		replacements.push([identity.source, "<omp-source>"]);
		replacements.push([identity.packageRoot, "<omp-package>"]);
		replacements.push([identity.launcher, "<omp-launcher>"]);
		replacements.push([identity.nativeRoot, "<omp-native>"]);
	}

	for (const [key, label] of [["OMP_SRC", "<omp-source>"], ["OMP_BIN", "<omp-launcher>"], ["OMP_PATH", "<omp-launcher>"], ["OMP", "<omp-launcher>"]] as const) {
		const value = process.env[key];
		if (value && isAbsolute(value)) replacements.push([value, label]);
	}
	replacements.sort(([a], [b]) => b.length - a.length);
	return (text: string) => {
		let result = text;
		for (const [path, replacement] of replacements) result = result.split(path).join(replacement);
		const cleaned = result.replace(/(?:\/private)?\/tmp\/omp-kit-runtime-[^\s'"<>]*|\/var\/folders\/[^/\s]+\/[^/\s]+\/T\/omp-kit-runtime-[^\s'"<>]*/g, "<private-runtime-temp>");
		// A failed identity can mention unknown package/source ancestors, not just its launcher.
		return identity ? cleaned : cleaned.replace(/(^|[\s"'(=:])\/[^\s"'<>)]*/g, "$1<private-path>");
	};
}

function capture(result?: BundledRunResult, redact: (text: string) => string = (text) => text): ProducerCapture {
	return result
		? { producer_rc: result.code, stdout: redact(result.stdout), stderr: redact(result.stderr) }
		: { producer_rc: null, stdout: "", stderr: "" };
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readGateCheck(value: unknown): GateCheck | null {
	if (!observationRecord(value) || !isCount(value.total) || !isCount(value.passed) || value.passed > value.total) return null;
	return { total: value.total, passed: value.passed };
}

function parseStructuredGate(stdout: string, producerCode: number): ParsedGate | null {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (!observationRecord(value) || value.schema_version !== 1 || (value.status !== "PASS" && value.status !== "FAIL")) return null;
	if (!observationRecord(value.counts) || !observationRecord(value.checks) || !Array.isArray(value.failures)
		|| !value.failures.every((failure): failure is string => typeof failure === "string" && failure.length > 0)) return null;
	const { counts, checks } = value;
	const prefixEvidence = checks.prefix;
	if (!observationRecord(prefixEvidence)) return null;
	const failures = value.failures;
	const registration = readGateCheck(checks.registration);
	const coverage = readGateCheck(checks.coverage);
	const payload = readGateCheck(checks.payload);
	const prefix = readGateCheck(prefixEvidence);
	if (!registration || !coverage || !payload || !prefix
		|| !isCount(counts.rules) || !isCount(counts.ttsr_rules) || !isCount(counts.cases)
		|| !isCount(counts.quiet_cases) || !isCount(counts.quiet_prefix_fires)
		|| !isCount(prefixEvidence.quiet_cases) || !isCount(prefixEvidence.quiet_passed)
		|| prefixEvidence.quiet_passed > prefixEvidence.quiet_cases
		|| counts.ttsr_rules > counts.rules || counts.quiet_cases > counts.cases
		|| registration.total !== counts.rules || coverage.total !== counts.ttsr_rules
		|| payload.total !== counts.cases || prefix.total !== counts.cases
		|| prefixEvidence.quiet_cases !== counts.quiet_cases) return null;
	const status = value.status;
	if ((status === "PASS") !== (failures.length === 0)
		|| producerCode !== (status === "PASS" ? 0 : 1)) return null;
	if (status === "PASS" && (
		registration.passed !== registration.total || coverage.passed !== coverage.total
		|| payload.passed !== payload.total || prefix.passed !== prefix.total
		|| prefixEvidence.quiet_passed !== prefixEvidence.quiet_cases || counts.quiet_prefix_fires !== 0
	)) return null;

	const summary: GateSummary = {
		rules: counts.rules,
		ttsrRules: counts.ttsr_rules,
		cases: counts.cases,
		quietCases: counts.quiet_cases,
		quietPrefixFires: counts.quiet_prefix_fires,
		failures: failures.length,
	};
	const g1Ok = summary.rules === EXPECTED.rules
		&& summary.ttsrRules === EXPECTED.ttsrRules
		&& registration.total === EXPECTED.rules && registration.passed === EXPECTED.rules
		&& coverage.total === EXPECTED.ttsrRules && coverage.passed === EXPECTED.ttsrRules
		&& !failures.some((failure) => /^(?:G1 |COVERAGE |CASES )/.test(failure));
	const g2Ok = summary.cases === EXPECTED.cases
		&& payload.total === EXPECTED.cases && payload.passed === EXPECTED.cases
		&& !failures.some((failure) => /^(?:G2 |CASES )/.test(failure));
	const g3Ok = summary.cases === EXPECTED.cases
		&& prefix.total === EXPECTED.cases && prefix.passed === EXPECTED.cases
		&& summary.quietCases === EXPECTED.quietCases
		&& prefixEvidence.quiet_passed === EXPECTED.quietCases
		&& summary.quietPrefixFires === 0
		&& !failures.some((failure) => /^(?:G3 |CASES )/.test(failure));
	const g1Failures = failures.filter((failure) => /^(?:G1 |COVERAGE |CASES )/.test(failure));
	const g2Failures = failures.filter((failure) => /^(?:G2 |CASES )/.test(failure));
	const g3Failures = failures.filter((failure) => /^(?:G3 |CASES )/.test(failure));
	return {
		status,
		summary,
		g1Registration: {
			status: g1Ok ? "PASS" : "FAIL",
			expected_rules: EXPECTED.rules,
			expected_ttsr_rules: EXPECTED.ttsrRules,
			observed_rules: summary.rules,
			observed_ttsr_rules: summary.ttsrRules,
			failures: g1Failures.length ? g1Failures : g1Ok ? [] : ["G1 registration or coverage counts did not match the shipped contract"],
		},
		g2Payload: {
			status: g2Ok ? "PASS" : "FAIL",
			expected_cases: EXPECTED.cases,
			observed_cases: summary.cases,
			failures: g2Failures.length ? g2Failures : g2Ok ? [] : ["G2 full-payload case count or output did not match the shipped contract"],
		},
		g3Prefix: {
			status: g3Ok ? "PASS" : "FAIL",
			expected_cases: EXPECTED.cases,
			expected_quiet_cases: EXPECTED.quietCases,
			observed_cases: summary.cases,
			observed_quiet_cases: summary.quietCases,
			quiet_prefix_fires: summary.quietPrefixFires,
			seeded_plant: "NOT_RUN",
			failures: g3Failures.length ? g3Failures : g3Ok ? [] : ["G3 streamed-prefix coverage or quiet-case count did not match the shipped contract"],
		},
		failures,
	};
}

function diagnosticsFor(findings: readonly Finding[]): FastTestReport["diagnostics"] {
	return {
		kit: finding(findings, "kit", "Release inventory was not verified"),
		manifest: finding(findings, "manifest", "Release manifest was not verified"),
		omp: finding(findings, "omp", "OMP identity was not verified"),
		installed_rules: finding(findings, "installed_rules", "Installed rule hashes and ownership were not verified"),
		project_rules: finding(findings, "project_rules", "Project shadows were not inspected"),
		effective_profile: finding(findings, "effective_profile", "Effective profile activation is unverified"),
	};
}


function blockerKind(error: unknown): FastTestBlockerKind {
	const message = errorText(error).toLowerCase();
	if (message.includes("native dependency") || message.includes("pi-natives") || message.includes("matcher source") || message.includes("binary-only omp")) {
		return "NATIVE_MATCHER_UNAVAILABLE";
	}
	if (message.includes("executable not found on path")) return "OMP_UNAVAILABLE";
	if (message.includes("conflicts with the path-selected omp") || message.includes("omp_src conflicts")) return "OMP_IDENTITY_INVALID";
	return "BUNDLED_RUNTIME_UNAVAILABLE";
}

function remedyFor(kind: FastTestBlockerKind): string {
	switch (kind) {
		case "OMP_UNAVAILABLE": return "Install a supported OMP package and put its omp launcher on PATH; omp-kit will not install it.";
		case "NATIVE_MATCHER_UNAVAILABLE": return "Install or repair OMP's matching source and @oh-my-pi/pi-natives package; omp-kit will not install it.";
		case "OMP_IDENTITY_INVALID": return "Resolve conflicting OMP, OMP_BIN, OMP_PATH, or OMP_SRC overrides, then rerun.";
		case "BUNDLED_RUNTIME_UNAVAILABLE": return "Use an intact release executable with scripts/ttsr-harness.ts and its declared resources, then rerun.";
	}
}

function blockedReport(
	diagnostics: FastTestReport["diagnostics"],
	blocker: FastTestReport["blocker"],
	redact: (text: string) => string,
	gate?: BundledRunResult,
	selftest?: BundledRunResult,
): FastTestReport {
	const gateCapture = capture(gate, redact);
	const selftestCapture = capture(selftest, redact);
	return {
		status: "BLOCKED",
		exitCode: 3,
		proofs: {
			G1_registration: { status: "NOT_RUN", expected_rules: EXPECTED.rules, expected_ttsr_rules: EXPECTED.ttsrRules, observed_rules: null, observed_ttsr_rules: null, failures: [] },
			G2_payload: { status: "NOT_RUN", expected_cases: EXPECTED.cases, observed_cases: null, failures: [] },
			G3_quiet_prefix: { status: "NOT_RUN", expected_cases: EXPECTED.cases, expected_quiet_cases: EXPECTED.quietCases, observed_cases: null, observed_quiet_cases: null, quiet_prefix_fires: null, seeded_plant: "NOT_RUN", failures: [] },
			G4_live: { status: "NOT_RUN", reason: "Fast test runs only the matcher; run omp-kit test --full for isolated live scenarios." },
		},
		diagnostics,
		producers: { gate: gateCapture, selftest: selftestCapture },
		blocker: blocker ? { ...blocker, message: redact(blocker.message) } : undefined,
		failures: blocker ? [redact(blocker.message)] : [],
	};
}

const NATIVE_LOAD_FAILURE = /@oh-my-pi\/pi-natives|native (?:module|package|matcher|binding)|cannot find (?:module|package)|failed to load/i;

/** Run the shipped fast matcher through the compiled release runtime; never run project code or live model calls. */
export async function runFastTest(input: FastTestInput): Promise<FastTestReport> {
	const paths = [input.root, input.executablePath, input.home, ...(input.project ? [input.project] : [])];
	if (!paths.every(isAbsolute)) throw new Error("fast-test release, executable, HOME, and project paths must be absolute");

	const fallbackRedact = redactor(input);
	let rawFindings: Finding[] = [];
	let diagnosticFailure: string | undefined;
	try {
		rawFindings = await diagnose({ root: input.root, home: input.home, project: input.project });
	} catch (error) {
		diagnosticFailure = fallbackRedact(errorText(error));
	}
	const diagnostics = diagnosticsFor(rawFindings);
	if (diagnosticFailure) {
		diagnostics.kit = { ...diagnostics.kit, reason: diagnosticFailure };
	}

	let identity: OmpIdentity;
	try {
		identity = resolveOmpIdentity(process.env);
	} catch (error) {
		const kind = blockerKind(error);
		const redact = redactor(input);
		return blockedReport(diagnostics, { kind, message: errorText(error), remedy: remedyFor(kind) }, redact);
	}
	const redact = redactor(input, identity);
	let gate: BundledRunResult;
	try {
		gate = await runBundled(HARNESS, ["--gate-json"], input.root, input.executablePath);
	} catch (error) {
		const kind = blockerKind(error);
		return blockedReport(diagnostics, { kind, message: errorText(error), remedy: remedyFor(kind) }, redact);
	}
	const parsed = parseStructuredGate(gate.stdout, gate.code);
	if (!parsed && NATIVE_LOAD_FAILURE.test(`${gate.stderr}\n${gate.stdout}`)) {
		const kind: FastTestBlockerKind = "NATIVE_MATCHER_UNAVAILABLE";
		return blockedReport(diagnostics, { kind, message: gate.stderr || gate.stdout || "OMP matcher did not load", remedy: remedyFor(kind) }, redact, gate);
	}
	if (!parsed) {
		const kind: FastTestBlockerKind = "BUNDLED_RUNTIME_UNAVAILABLE";
		return blockedReport(diagnostics, { kind, message: gate.stderr || gate.stdout || "harness emitted invalid structured gate evidence", remedy: remedyFor(kind) }, redact, gate);
	}

	let selftest: BundledRunResult;
	try {
		selftest = await runBundled(HARNESS, ["--selftest"], input.root, input.executablePath);
	} catch (error) {
		const kind = blockerKind(error);
		return blockedReport(diagnostics, { kind, message: errorText(error), remedy: remedyFor(kind) }, redact, gate);
	}
	if (!/^SELFTEST:/m.test(selftest.stdout) && NATIVE_LOAD_FAILURE.test(`${selftest.stderr}\n${selftest.stdout}`)) {
		const kind: FastTestBlockerKind = "NATIVE_MATCHER_UNAVAILABLE";
		return blockedReport(diagnostics, { kind, message: selftest.stderr || selftest.stdout || "OMP matcher selftest did not load", remedy: remedyFor(kind) }, redact, gate, selftest);
	}

	const gateCapture = capture(gate, redact);
	const selftestCapture = capture(selftest, redact);
	const plantPassed = selftest.code === 0 && SEEDED_PREFIX_PLANT.test(selftest.stdout) && SELFTEST_GREEN.test(selftest.stdout);
	parsed.g3Prefix.seeded_plant = plantPassed ? "PASS" : "FAIL";
	if (!plantPassed) parsed.g3Prefix.failures.push("Harness selftest did not observe the named quiet-prefix plant going RED with controls GREEN");

	const releaseValid = diagnostics.kit.status !== "FAIL" && diagnostics.manifest.status !== "FAIL";
	const gatePassed = gate.code === 0
		&& parsed.status === "PASS"
		&& parsed.failures.length === 0
		&& parsed.summary.failures === 0
		&& parsed.g1Registration.status === "PASS"
		&& parsed.g2Payload.status === "PASS"
		&& parsed.g3Prefix.status === "PASS";
	const status = gatePassed && selftest.code === 0 && plantPassed && releaseValid ? "PASS" : "FAIL";
	const proofFailures = [
		...parsed.g1Registration.failures,
		...parsed.g2Payload.failures,
		...parsed.g3Prefix.failures,
	];
	const failures = [
		...(parsed.failures.length ? parsed.failures : proofFailures),
		...(gate.code === 0 ? [] : [`ttsr-harness --gate-json producer_rc=${gate.code}`]),
		...(parsed.summary.failures === 0 ? [] : [`ttsr-harness reported ${parsed.summary.failures} gate failure(s)`]),
		...(selftest.code === 0 ? [] : [`ttsr-harness --selftest producer_rc=${selftest.code}`]),
		...(!releaseValid ? [diagnostics.manifest.reason] : []),
	];

	return {
		status,
		exitCode: status === "PASS" ? 0 : 1,
		proofs: {
			G1_registration: parsed.g1Registration,
			G2_payload: parsed.g2Payload,
			G3_quiet_prefix: parsed.g3Prefix,
			G4_live: { status: "NOT_RUN", reason: "Fast test runs only the matcher; run omp-kit test --full for isolated live scenarios." },
		},
		diagnostics,
		producers: { gate: gateCapture, selftest: selftestCapture },
		failures,
	};
}
/** Internal selection only: this does not expand the public test command's pack contract. */
export interface MatcherObservationInput {
	root: string;
	executablePath: string;
	rules: string;
	cases: string;
	rule: string;
	caseLine: number;
	/** Expected bytes from an independent selection, never inferred from the selected file. */
	expectedRuleSha256: string;
	timeoutMs?: number;
}

export type MatcherObservation =
	| {
		status: "OK"; rule: string; case_line: number; registration: "REGISTERED";
		whole: "fire" | "quiet"; evaluator: "OK";
		prefix: { phase: "stream" | "final"; position: number; wire_length: number } | null;
		witness: { source: "text" | "thinking" | "tool"; tool: string; path: string; expect: "fire" | "quiet" };
		bindings: Record<string, string>;
	}
	| { status: "UNAVAILABLE"; rule: string; case_line: number; evaluator: "UNAVAILABLE"; reason: string; detail?: string };

export interface MatcherObservationReport {
	observation: MatcherObservation;
	/** Original streams and exit code; protocol failures must remain inspectable. */
	producer: ProducerCapture;
}

function observationRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMatcherObservation(value: unknown): value is MatcherObservation {
	if (!observationRecord(value) || typeof value.rule !== "string" || !Number.isSafeInteger(value.case_line)) return false;
	if (value.status === "UNAVAILABLE") {
		return value.evaluator === "UNAVAILABLE" && typeof value.reason === "string" && value.reason.length > 0
			&& (value.detail === undefined || typeof value.detail === "string");
	}
	if (value.status !== "OK" || value.evaluator !== "OK" || value.registration !== "REGISTERED"
		|| (value.whole !== "fire" && value.whole !== "quiet")) return false;
	const { prefix, witness, bindings } = value;
	if (prefix !== null) {
		if (!observationRecord(prefix) || !Number.isSafeInteger(prefix.position) || !Number.isSafeInteger(prefix.wire_length)
			|| typeof prefix.position !== "number" || typeof prefix.wire_length !== "number"
			|| prefix.position < 1 || prefix.wire_length < 0) return false;
		if (prefix.phase === "stream" ? prefix.position > prefix.wire_length
			: prefix.phase !== "final" || prefix.position !== prefix.wire_length + 1) return false;
	}
	if (!observationRecord(witness) || (witness.source !== "text" && witness.source !== "thinking" && witness.source !== "tool")
		|| typeof witness.tool !== "string" || typeof witness.path !== "string"
		|| (witness.expect !== "fire" && witness.expect !== "quiet")) return false;
	if (!observationRecord(bindings) || !Object.values(bindings).every(item => typeof item === "string")) return false;
	for (const key of ["omp_launcher", "omp_package", "omp_source", "native_package", "kit_root", "harness_runtime"]) {
		if (typeof bindings[key] !== "string" || !isAbsolute(bindings[key])) return false;
	}
	for (const key of ["omp_launcher_sha256", "omp_package_sha256", "matcher_sha256", "omp_rule_parser_sha256", "native_sha256", "harness_runtime_sha256", "kit_harness_sha256", "policy_sha256", "rule_loader_sha256", "rule_sha256", "cases_sha256"]) {
		if (typeof bindings[key] !== "string" || !/^[a-f0-9]{64}$/.test(bindings[key])) return false;
	}
	return true;
}

/**
 * Observe one source-harness witness using the installed compiled runtime. runBundled
 * validates the release and OMP identity and isolates HOME/XDG/TMP before Bun starts.
 * No human gate output is parsed, no rule is evaluated here, and unavailable is never quiet.
 */
export async function runMatcherObservation(input: MatcherObservationInput): Promise<MatcherObservationReport> {
	let identity: OmpIdentity | undefined;
	try {
		identity = resolveOmpIdentity(process.env);
	} catch {
		// runBundled returns the actionable identity failure; this attempt only enables redaction.
	}
	const privatePaths: Array<[string, string]> = [
		[input.executablePath, "<runtime>"],
		[input.rules, "<rules>"],
		[input.cases, "<cases>"],
	];
	if (typeof input.root === "string" && isAbsolute(input.root)) {
		try {
			const realRoot = realpathSync(input.root);
			if (realRoot !== input.root) privatePaths.push([realRoot, "<release-root>"]);
		} catch {
			// The producer reports invalid or missing roots; retain the supplied absolute path redactor.
		}
	}
	const redact = redactor({ root: input.root, home: process.env.HOME }, identity, privatePaths);
	const unavailable = (reason: string, detail: string, result?: BundledRunResult): MatcherObservationReport => ({
		observation: { status: "UNAVAILABLE", evaluator: "UNAVAILABLE", rule: input.rule, case_line: input.caseLine, reason, detail: redact(detail) },
		producer: capture(result, redact),
	});
	if (![input.root, input.executablePath, input.rules, input.cases].every(path => typeof path === "string" && isAbsolute(path))
		|| typeof input.rule !== "string" || !/^[a-z0-9][a-z0-9_-]*$/i.test(input.rule)
		|| !Number.isSafeInteger(input.caseLine) || input.caseLine < 2
		|| typeof input.expectedRuleSha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRuleSha256)) {
		return unavailable("INVALID_SELECTION", "Absolute paths, a rule name, a case line >= 2, and an independently supplied lowercase rule SHA256 are required");
	}
	if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000)) {
		return unavailable("INVALID_TIMEOUT", "timeoutMs must be an integer from 1 through 120000");
	}
	const args = ["--observe", "--rules", input.rules, "--cases", input.cases, "--rule", input.rule,
		"--line", String(input.caseLine), "--rule-sha256", input.expectedRuleSha256];
	if (input.timeoutMs !== undefined) args.push("--timeout-ms", String(input.timeoutMs));
	let result: BundledRunResult;
	try {
		result = await runBundled(HARNESS, args, input.root, input.executablePath);
	} catch (error) {
		return unavailable(blockerKind(error), errorText(error));
	}
	let observation: unknown;
	try {
		observation = JSON.parse(result.stdout);
	} catch (error) {
		return unavailable("INVALID_OBSERVATION", errorText(error), result);
	}
	if (!isMatcherObservation(observation) || observation.rule !== input.rule || observation.case_line !== input.caseLine) {
		return unavailable("INVALID_OBSERVATION", "Harness returned an invalid or different selection", result);
	}
	if (result.code !== (observation.status === "OK" ? 0 : 1)) {
		return unavailable("PRODUCER_STATUS_MISMATCH", "Harness exit code disagrees with its structured observation", result);
	}
	if (!identity) return unavailable("OMP_IDENTITY_INVALID", "OMP identity could not be resolved for observation binding", result);
	const expectedBindings = {
		omp_launcher: identity.launcher,
		omp_package: identity.packageRoot,
		omp_source: identity.source,
		native_package: identity.nativeRoot,
		kit_root: realpathSync(input.root),
		harness_runtime: realpathSync(input.executablePath),
	};
	for (const [key, expected] of Object.entries(expectedBindings)) {
		if (observation.status === "OK" && observation.bindings[key] !== expected) {
			return unavailable("IDENTITY_MISMATCH", `Harness ${key} does not match the selected runtime identity`, result);
		}
	}
	if (observation.status === "OK" && observation.bindings.rule_sha256 !== input.expectedRuleSha256) {
		return unavailable("BUNDLED_SUBSTITUTION", "Observed rule SHA256 differs from the independently supplied selection", result);
	}
	const publicObservation: MatcherObservation = observation.status === "UNAVAILABLE" && observation.detail !== undefined
		? { ...observation, detail: redact(observation.detail) }
		: observation;
	return { observation: publicObservation, producer: capture(result, redact) };
}
