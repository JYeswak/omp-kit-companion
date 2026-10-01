import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { runMatcherObservation, type MatcherObservation } from "./test-runner.ts";

const CASE_HEADER = "rule\texpect\tsource\ttool\tpath\tsnippet\tnote";
const RULE_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const TOOL_NAMES: Record<string, true> = { bash: true, edit: true, write: true };
const SOURCES: Record<string, true> = { text: true, thinking: true, tool: true };
const UNSUPPORTED_RULE_REASONS: Record<string, true> = { JUDGE_REQUIRED: true, RULE_NOT_REGISTERED: true, INVALID_RULE: true };
export const EXTERNAL_PACK_LIMITS = Object.freeze({
	ruleFiles: 128,
	directoryEntries: 512,
	ruleBytes: 64 * 1024,
	totalRuleBytes: 4 * 1024 * 1024,
	caseBytes: 4 * 1024 * 1024,
	caseRows: 512,
	caseLines: 2048,
	perCaseTimeoutMs: 5_000,
	totalTimeoutMs: 60_000,
});

export class ExternalPackInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ExternalPackInputError";
	}
}

export interface ExternalRuleSnapshot {
	readonly name: string;
	readonly path: string;
	readonly sha256: string;
}

export interface ExternalCaseSnapshot {
	readonly line: number;
	readonly rule: string;
	readonly expect: "fire" | "quiet";
	readonly source: "text" | "thinking" | "tool";
	readonly tool: string;
	readonly path: string;
	readonly snippet: string;
	readonly note: string;
}

export interface ExternalPackSnapshot {
	readonly rulesDirectory: string;
	readonly casesFile: string;
	readonly rules: readonly ExternalRuleSnapshot[];
	readonly cases: readonly ExternalCaseSnapshot[];
	readonly casesSha256: string;
}

function inputError(code: string, message: string): never {
	throw new ExternalPackInputError(code, message);
}

export function digest(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function readUtf8(bytes: Uint8Array, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return inputError("INVALID_EXTERNAL_PACK", `${label} is not valid UTF-8`);
	}
}
export function readBoundedFile(path: string, maxBytes: number, label: string): Uint8Array {
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const stat = fstatSync(fd);
		if (!stat.isFile()) return inputError("UNSAFE_EXTERNAL_FILE", `${label} must be a regular file`);
		if (stat.size > maxBytes) return inputError("EXTERNAL_PACK_TOO_LARGE", `${label} exceeds the ${maxBytes}-byte limit`);
		const buffer = new Uint8Array(Math.min(stat.size, maxBytes) + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead !== stat.size) return inputError("EXTERNAL_PACK_CHANGED", `${label} changed while being read`);
		return buffer.subarray(0, bytesRead);
	} catch (error) {
		if (error instanceof ExternalPackInputError) throw error;
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP") {
			return inputError("UNSAFE_EXTERNAL_FILE", `${label} must not be a symlink`);
		}
		return inputError("EXTERNAL_PACK_UNAVAILABLE", `${label} could not be read`);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Validate and snapshot bounded static rule markdown and the existing seven-column cases TSV. */
export function readExternalPackSnapshot(rulesDirectory: string, casesFile: string): ExternalPackSnapshot {
	if (![rulesDirectory, casesFile].every(path => typeof path === "string" && isAbsolute(path))) {
		return inputError("INVALID_EXTERNAL_PACK", "--rules and --cases require absolute paths");
	}

	let rulesRoot: string;
	let casePath: string;
	let ruleEntries: string[];
	let caseBytes: Uint8Array;
	try {
		const rulesStat = lstatSync(rulesDirectory);
		if (rulesStat.isSymbolicLink() || !rulesStat.isDirectory()) {
			return inputError("UNSAFE_RULES_ROOT", "--rules must name a non-symlink directory");
		}
		const casesStat = lstatSync(casesFile);
		if (casesStat.isSymbolicLink() || !casesStat.isFile()) {
			return inputError("UNSAFE_CASES_FILE", "--cases must name a non-symlink regular file");
		}
		if (casesStat.size > EXTERNAL_PACK_LIMITS.caseBytes) {
			return inputError("EXTERNAL_PACK_TOO_LARGE", `--cases exceeds the ${EXTERNAL_PACK_LIMITS.caseBytes}-byte limit`);
		}
		rulesRoot = realpathSync(rulesDirectory);
		casePath = realpathSync(casesFile);
		caseBytes = readBoundedFile(casePath, EXTERNAL_PACK_LIMITS.caseBytes, "External cases TSV");

		ruleEntries = [];
		const directory = opendirSync(rulesRoot);
		try {
			let entryCount = 0;
			for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
				entryCount++;
				if (entryCount > EXTERNAL_PACK_LIMITS.directoryEntries) {
					return inputError("EXTERNAL_PACK_TOO_LARGE", `--rules exceeds the ${EXTERNAL_PACK_LIMITS.directoryEntries}-entry directory limit`);
				}
				if (!entry.name.endsWith(".md")) continue;
				ruleEntries.push(entry.name);
				if (ruleEntries.length > EXTERNAL_PACK_LIMITS.ruleFiles) {
					return inputError("EXTERNAL_PACK_TOO_LARGE", `--rules exceeds the ${EXTERNAL_PACK_LIMITS.ruleFiles}-rule limit`);
				}
			}
		} finally {
			directory.closeSync();
		}
		ruleEntries.sort();
	} catch (error) {
		if (error instanceof ExternalPackInputError) throw error;
		return inputError("EXTERNAL_PACK_UNAVAILABLE", "The selected external rule directory or cases file is missing or unreadable");
	}

	const rules: ExternalRuleSnapshot[] = [];
	let totalRuleBytes = 0;
	for (const name of ruleEntries) {
		const rule = name.slice(0, -3);
		if (!RULE_NAME.test(rule)) return inputError("INVALID_EXTERNAL_RULE_NAME", "The external rules directory contains an unsafe markdown rule name");
		const file = join(rulesRoot, name);
		try {
			const stat = lstatSync(file);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				return inputError("UNSAFE_EXTERNAL_RULE", "External rule markdown files must be regular files, not symlinks");
			}
			if (stat.size > EXTERNAL_PACK_LIMITS.ruleBytes) {
				return inputError("EXTERNAL_PACK_TOO_LARGE", `External rule ${rule} exceeds the ${EXTERNAL_PACK_LIMITS.ruleBytes}-byte limit`);
			}
			totalRuleBytes += stat.size;
			if (totalRuleBytes > EXTERNAL_PACK_LIMITS.totalRuleBytes) {
				return inputError("EXTERNAL_PACK_TOO_LARGE", `External rule markdown exceeds the ${EXTERNAL_PACK_LIMITS.totalRuleBytes}-byte total limit`);
			}
			const canonical = realpathSync(file);
			const relativePath = relative(rulesRoot, canonical);
			if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
				return inputError("UNSAFE_EXTERNAL_RULE", "An external rule resolves outside the selected rules directory");
			}
			const bytes = readBoundedFile(canonical, EXTERNAL_PACK_LIMITS.ruleBytes, "External rule markdown");
			if (bytes.length !== stat.size) return inputError("EXTERNAL_PACK_CHANGED", `External rule ${rule} changed while being read`);
			readUtf8(bytes, "External rule markdown");
			rules.push(Object.freeze({ name: rule, path: canonical, sha256: digest(bytes) }));
		} catch (error) {
			if (error instanceof ExternalPackInputError) throw error;
			return inputError("EXTERNAL_PACK_UNAVAILABLE", "An external rule markdown file is missing or unreadable");
		}
	}

	const text = readUtf8(caseBytes, "External cases TSV");
	const cases: ExternalCaseSnapshot[] = [];
	let cursor = 0;
	let lineNumber = 1;
	while (cursor <= text.length) {
		if (lineNumber > EXTERNAL_PACK_LIMITS.caseLines) {
			return inputError("EXTERNAL_PACK_TOO_LARGE", `--cases exceeds the ${EXTERNAL_PACK_LIMITS.caseLines}-line limit`);
		}
		const newline = text.indexOf("\n", cursor);
		const end = newline === -1 ? text.length : newline;
		const row = text.slice(cursor, end).replace(/\r$/, "");
		if (lineNumber === 1) {
			if (row !== CASE_HEADER) {
				return inputError("INVALID_CASE_SCHEMA", `--cases must start with the exact ${CASE_HEADER} TSV header`);
			}
		} else if (row.trim() !== "" && !row.startsWith("#")) {
			const columns = row.split("\t");
			if (columns.length !== 7) return inputError("INVALID_CASE_SCHEMA", `External cases line ${lineNumber} must have exactly seven TSV columns`);
			const [rule, expect, source, tool, casePathValue, rawSnippet, note] = columns as [string, string, string, string, string, string, string];
			if (!RULE_NAME.test(rule)) return inputError("INVALID_CASE_SCHEMA", `External cases line ${lineNumber} has an invalid rule name`);
			if (expect !== "fire" && expect !== "quiet") return inputError("INVALID_CASE_SCHEMA", `External cases line ${lineNumber} expect must be fire or quiet`);
			if (SOURCES[source] !== true) return inputError("INVALID_CASE_SCHEMA", `External cases line ${lineNumber} has an unsupported source`);
			if (source === "tool" && TOOL_NAMES[tool] !== true) return inputError("INVALID_CASE_SCHEMA", `External cases line ${lineNumber} has an unsupported tool`);
			if (cases.length >= EXTERNAL_PACK_LIMITS.caseRows) {
				return inputError("EXTERNAL_PACK_TOO_LARGE", `--cases exceeds the ${EXTERNAL_PACK_LIMITS.caseRows}-case limit`);
			}
			cases.push(Object.freeze({
				line: lineNumber,
				rule,
				expect,
				source: source as ExternalCaseSnapshot["source"],
				tool,
				path: casePathValue,
				snippet: rawSnippet.replace(/\\([nt])/g, (_match, code: string) => code === "n" ? "\n" : "\t"),
				note,
			}));
		}
		if (newline === -1) break;
		cursor = newline + 1;
		lineNumber++;
	}

	return Object.freeze({
		rulesDirectory: rulesRoot,
		casesFile: casePath,
		rules: Object.freeze(rules),
		cases: Object.freeze(cases),
		casesSha256: digest(caseBytes),
	});
}

export type ExternalProofStatus = "PASS" | "FAIL" | "NOT_RUN";

export interface ExternalPackReport {
	readonly status: "PASS" | "FAIL" | "BLOCKED";
	readonly exitCode: 0 | 1 | 3;
	readonly scope: "EXTERNAL_G1_G3";
	readonly counts: { readonly rules: number; readonly cases: number; readonly quiet_cases: number };
	readonly proofs: {
		readonly G1_registration: { readonly status: ExternalProofStatus; readonly expected_rules: number; readonly observed_rules: number | null };
		readonly G2_payload: { readonly status: ExternalProofStatus; readonly expected_cases: number; readonly observed_cases: number | null };
		readonly G3_quiet_prefix: {
			readonly status: ExternalProofStatus; readonly expected_cases: number; readonly expected_quiet_cases: number;
			readonly observed_cases: number | null; readonly observed_quiet_cases: number | null; readonly quiet_prefix_fires: number | null;
		};
	};
	readonly observations: readonly {
		readonly rule: string; readonly case_line: number; readonly expected: "fire" | "quiet";
		readonly whole: "fire" | "quiet"; readonly prefix: Extract<MatcherObservation, { status: "OK" }>["prefix"];
	}[];
	readonly failures: readonly string[];
	readonly blocker?: { readonly reason: string; readonly detail?: string };
}

export interface ExternalPackRunInput {
	readonly root: string;
	readonly executablePath: string;
	readonly pack: ExternalPackSnapshot;
}

function validateExternalTestPack(pack: ExternalPackSnapshot): void {
	if (pack.rules.length === 0) inputError("EMPTY_EXTERNAL_RULES", "External test mode requires at least one markdown rule");
	if (pack.cases.length === 0) inputError("EMPTY_EXTERNAL_CASES", "External test mode requires at least one case");
	const coverage = new Map(pack.rules.map(rule => [rule.name, { fire: 0, quiet: 0 }]));
	for (const selected of pack.cases) {
		const counts = coverage.get(selected.rule);
		if (!counts) inputError("MISSING_EXTERNAL_RULE", `External cases line ${selected.line} names a rule absent from --rules`);
		counts[selected.expect]++;
	}
	for (const rule of pack.rules) {
		const counts = coverage.get(rule.name);
		if (!counts || counts.fire === 0 || counts.quiet === 0) {
			inputError("INCOMPLETE_EXTERNAL_COVERAGE", `External test rule ${rule.name} needs at least one fire and one quiet case`);
		}
	}
}

/** Run only the selected external rules and cases through the installed native matcher observation. */
export async function runExternalPackTest(input: ExternalPackRunInput): Promise<ExternalPackReport> {
	const { pack } = input;
	validateExternalTestPack(pack);
	const rulesByName = new Map(pack.rules.map(rule => [rule.name, rule]));
	const deadline = Date.now() + EXTERNAL_PACK_LIMITS.totalTimeoutMs;
	const observations: Array<ExternalPackReport["observations"][number]> = [];
	const registered = new Set<string>();
	let payloadPassed = 0;
	let quietPassed = 0;
	let quietPrefixFires = 0;
	const failures: string[] = [];

	for (const selected of pack.cases) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
				[...failures, `External matcher exceeded the ${EXTERNAL_PACK_LIMITS.totalTimeoutMs}ms total limit`],
				"BLOCKED", 3, { reason: "TOTAL_TIME_LIMIT" });
		}
		const rule = rulesByName.get(selected.rule);
		if (!rule) inputError("MISSING_EXTERNAL_RULE", `External cases line ${selected.line} names a rule absent from --rules`);
		const result = await runMatcherObservation({
			root: input.root,
			executablePath: input.executablePath,
			rules: pack.rulesDirectory,
			cases: pack.casesFile,
			rule: selected.rule,
			caseLine: selected.line,
			expectedRuleSha256: rule.sha256,
			timeoutMs: Math.min(EXTERNAL_PACK_LIMITS.perCaseTimeoutMs, remaining),
		});
		if (Date.now() > deadline) {
			return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
				[...failures, `External matcher exceeded the ${EXTERNAL_PACK_LIMITS.totalTimeoutMs}ms total limit`],
				"BLOCKED", 3, { reason: "TOTAL_TIME_LIMIT" });
		}
		const observation = result.observation;
		if (observation.status === "UNAVAILABLE") {
			if (UNSUPPORTED_RULE_REASONS[observation.reason] === true) {
				throw new ExternalPackInputError("UNSUPPORTED_RULE_KIND", "An external rule requires unsupported judge or non-stream evaluation");
			}
			if (observation.reason === "BUNDLED_SUBSTITUTION") {
				return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
					[...failures, `External rule hash changed during observation of ${selected.rule} case line ${selected.line}`],
					"FAIL", 1, { reason: observation.reason });
			}
			return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
				[...failures, `Matcher observation unavailable for ${selected.rule} case line ${selected.line}: ${observation.reason}`],
				"BLOCKED", 3, { reason: observation.reason, ...(observation.detail ? { detail: observation.detail } : {}) });
		}
		if (observation.bindings.cases_sha256 !== pack.casesSha256) {
			return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
				[...failures, `External cases changed during observation of ${selected.rule} case line ${selected.line}`], "FAIL", 1);
		}
		if (observation.witness.expect !== selected.expect || observation.witness.source !== selected.source
			|| observation.witness.tool !== selected.tool || observation.witness.path !== selected.path) {
			return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires,
				[...failures, `Observed external case differs from its validated snapshot at line ${selected.line}`], "FAIL", 1);
		}
		registered.add(selected.rule);
		if (observation.whole === selected.expect) payloadPassed++;
		else failures.push(`G2 ${selected.rule} case line ${selected.line}: expected ${selected.expect}, observed ${observation.whole}`);
		if (selected.expect === "quiet") {
			if (observation.prefix === null) quietPassed++;
			else {
				quietPrefixFires++;
				failures.push(`G3 ${selected.rule} quiet case line ${selected.line}: fired on prefix ${observation.prefix.position}/${observation.prefix.wire_length}`);
			}
		}
		observations.push(Object.freeze({
			rule: selected.rule,
			case_line: selected.line,
			expected: selected.expect,
			whole: observation.whole,
			prefix: observation.prefix,
		}));
	}

	if (registered.size !== pack.rules.length) failures.push(`G1 registered ${registered.size} of ${pack.rules.length} external rules`);
	const status = failures.length === 0 ? "PASS" : "FAIL";
	return report(pack, observations, registered, payloadPassed, quietPassed, quietPrefixFires, failures, status, status === "PASS" ? 0 : 1);
}

function report(
	pack: ExternalPackSnapshot,
	observations: readonly ExternalPackReport["observations"][number][],
	registered: ReadonlySet<string>,
	payloadPassed: number,
	quietPassed: number,
	quietPrefixFires: number,
	failures: readonly string[],
	status: ExternalPackReport["status"],
	exitCode: ExternalPackReport["exitCode"],
	blocker?: ExternalPackReport["blocker"],
): ExternalPackReport {
	const complete = observations.length === pack.cases.length;
	const quietCases = pack.cases.filter(item => item.expect === "quiet").length;
	const g1: ExternalProofStatus = registered.size === pack.rules.length ? "PASS" : "NOT_RUN";
	const g2: ExternalProofStatus = !complete ? "NOT_RUN" : payloadPassed === pack.cases.length ? "PASS" : "FAIL";
	const g3: ExternalProofStatus = !complete ? "NOT_RUN" : quietPassed === quietCases && quietPrefixFires === 0 ? "PASS" : "FAIL";
	return Object.freeze({
		status,
		exitCode,
		scope: "EXTERNAL_G1_G3",
		counts: Object.freeze({ rules: pack.rules.length, cases: pack.cases.length, quiet_cases: quietCases }),
		proofs: Object.freeze({
			G1_registration: Object.freeze({ status: g1, expected_rules: pack.rules.length, observed_rules: registered.size }),
			G2_payload: Object.freeze({ status: g2, expected_cases: pack.cases.length, observed_cases: observations.length }),
			G3_quiet_prefix: Object.freeze({
				status: g3, expected_cases: pack.cases.length, expected_quiet_cases: quietCases,
				observed_cases: observations.length,
				observed_quiet_cases: complete ? quietCases : observations.filter(item => item.expected === "quiet").length,
				quiet_prefix_fires: quietPrefixFires,
			}),
		}),
		observations: Object.freeze([...observations]),
		failures: Object.freeze([...failures]),
		...(blocker ? { blocker: Object.freeze(blocker) } : {}),
	});
}
