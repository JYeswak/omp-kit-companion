import { isAbsolute } from "node:path";
import { diagnose, type Finding } from "./diagnostics.ts";
import { resolveOmpIdentity, type OmpIdentity } from "./paths.ts";
import { runBundled, type BundledRunResult } from "./runtime.ts";

const HARNESS = "scripts/ttsr-harness.ts";
const EXPECTED = { rules: 18, ttsrRules: 17, cases: 274, quietCases: 138 } as const;
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
	quietPrefixFires: number;
	failures: number;
}
interface ParsedGate {
	summary: GateSummary | null;
	g1Registration: FastTestReport["proofs"]["G1_registration"];
	g2Payload: FastTestReport["proofs"]["G2_payload"];
	g3Prefix: FastTestReport["proofs"]["G3_quiet_prefix"];
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

function redactor(input: FastTestInput, identity?: OmpIdentity): (text: string) => string {
	const replacements: Array<[string, string]> = [
		[input.root, "<release-root>"],
		[input.home, "<home>"],
	];
	if (input.project) replacements.push([input.project, "<project>"]);
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
		return result.replace(/(?:\/private)?\/tmp\/omp-kit-runtime-[^\s"'<>]*|\/var\/folders\/[^/\s]+\/[^/\s]+\/T\/omp-kit-runtime-[^\s"'<>]*/g, "<private-runtime-temp>");
	};
}

function capture(result?: BundledRunResult, redact: (text: string) => string = (text) => text): ProducerCapture {
	return result
		? { producer_rc: result.code, stdout: redact(result.stdout), stderr: redact(result.stderr) }
		: { producer_rc: null, stdout: "", stderr: "" };
}

function parseGate(stdout: string): ParsedGate {
	const lines = stdout.split(/\r?\n/);
	const summaryMatch = /^rules=(\d+) ttsr_rules=(\d+) cases=(\d+) quiet_prefix_fires=(\d+) failures=(\d+)$/m.exec(stdout);
	const summary: GateSummary | null = summaryMatch ? {
		rules: Number(summaryMatch[1]),
		ttsrRules: Number(summaryMatch[2]),
		cases: Number(summaryMatch[3]),
		quietPrefixFires: Number(summaryMatch[4]),
		failures: Number(summaryMatch[5]),
	} : null;
	const g1Rows = lines.filter((line) => /^(?:PASS|FAIL) G1 \S+/.test(line));
	const coverageRows = lines.filter((line) => /^(?:PASS|FAIL|SKIP) coverage \S+/.test(line));
	const g1Failures = lines.filter((line) => /^(?:FAIL G1 |RED (?:G1|COVERAGE|CASES)\b|FAIL coverage )/.test(line));
	const caseRows = lines.filter((line) => /^(?:PASS|FAIL) \S+ (?:fire|quiet) \S+ line \d+ \| G2 /.test(line));
	const g2Failures = lines.filter((line) => /^RED G2\b/.test(line));
	const prefixRows = caseRows.filter((line) => line.includes(" | G3 "));
	const quietRows = caseRows.filter((line) => /^(?:PASS|FAIL) \S+ quiet \S+ line \d+ \| G2 /.test(line));
	const g3Failures = lines.filter((line) => /^RED G3\b/.test(line));
	const g1Ok = summary?.rules === EXPECTED.rules
		&& summary.ttsrRules === EXPECTED.ttsrRules
		&& g1Rows.length === EXPECTED.rules
		&& g1Rows.every((line) => line.startsWith("PASS G1 "))
		&& coverageRows.length === EXPECTED.rules
		&& !coverageRows.some((line) => line.startsWith("FAIL coverage "))
		&& g1Failures.length === 0;
	const g2Ok = summary?.cases === EXPECTED.cases
		&& caseRows.length === EXPECTED.cases
		&& g2Failures.length === 0
		&& !caseRows.some((line) => line.includes("(WRONG)"));
	const g3Ok = summary?.cases === EXPECTED.cases
		&& prefixRows.length === EXPECTED.cases
		&& quietRows.length === EXPECTED.quietCases
		&& summary.quietPrefixFires === 0
		&& g3Failures.length === 0;
	return {
		summary,
		g1Registration: {
			status: g1Ok ? "PASS" : "FAIL",
			expected_rules: EXPECTED.rules,
			expected_ttsr_rules: EXPECTED.ttsrRules,
			observed_rules: summary?.rules ?? null,
			observed_ttsr_rules: summary?.ttsrRules ?? null,
			failures: g1Failures.length ? g1Failures : g1Ok ? [] : ["G1 registration or coverage counts did not match the shipped contract"],
		},
		g2Payload: {
			status: g2Ok ? "PASS" : "FAIL",
			expected_cases: EXPECTED.cases,
			observed_cases: summary?.cases ?? null,
			failures: g2Failures.length ? g2Failures : g2Ok ? [] : ["G2 full-payload case count or output did not match the shipped contract"],
		},
		g3Prefix: {
			status: g3Ok ? "PASS" : "FAIL",
			expected_cases: EXPECTED.cases,
			expected_quiet_cases: EXPECTED.quietCases,
			observed_cases: summary?.cases ?? null,
			observed_quiet_cases: quietRows.length,
			quiet_prefix_fires: summary?.quietPrefixFires ?? null,
			seeded_plant: "NOT_RUN",
			failures: g3Failures.length ? g3Failures : g3Ok ? [] : ["G3 streamed-prefix coverage or quiet-case count did not match the shipped contract"],
		},
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
			G4_live: { status: "NOT_RUN", reason: "P08 runs only the fast matcher; P09 owns isolated live scenarios." },
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
		gate = await runBundled(HARNESS, ["--gate"], input.root, input.executablePath);
	} catch (error) {
		const kind = blockerKind(error);
		return blockedReport(diagnostics, { kind, message: errorText(error), remedy: remedyFor(kind) }, redact);
	}
	const parsed = parseGate(gate.stdout);
	if (!parsed.summary && NATIVE_LOAD_FAILURE.test(`${gate.stderr}\n${gate.stdout}`)) {
		const kind: FastTestBlockerKind = "NATIVE_MATCHER_UNAVAILABLE";
		return blockedReport(diagnostics, { kind, message: gate.stderr || gate.stdout || "OMP matcher did not load", remedy: remedyFor(kind) }, redact, gate);
	}
	if (!parsed.summary) {
		const kind: FastTestBlockerKind = "BUNDLED_RUNTIME_UNAVAILABLE";
		return blockedReport(diagnostics, { kind, message: gate.stderr || gate.stdout || "harness emitted no gate summary", remedy: remedyFor(kind) }, redact, gate);
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
		&& parsed.summary.failures === 0
		&& parsed.g1Registration.status === "PASS"
		&& parsed.g2Payload.status === "PASS"
		&& parsed.g3Prefix.status === "PASS";
	const status = gatePassed && selftest.code === 0 && plantPassed && releaseValid ? "PASS" : "FAIL";
	const failures = [
		...parsed.g1Registration.failures,
		...parsed.g2Payload.failures,
		...parsed.g3Prefix.failures,
		...(gate.code === 0 ? [] : [`ttsr-harness --gate producer_rc=${gate.code}`]),
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
			G4_live: { status: "NOT_RUN", reason: "P08 runs only the fast matcher; P09 owns isolated live scenarios." },
		},
		diagnostics,
		producers: { gate: gateCapture, selftest: selftestCapture },
		failures,
	};
}
