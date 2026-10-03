import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { resolveOmpIdentity } from "./paths.ts";
import { runBundled } from "./runtime.ts";

const HARNESS = "scripts/ttsr-harness.ts";
const WILSON_Z = 1.96;

export interface CorpusInput {
	/** Release root carrying rules/ and scripts/ttsr-harness.ts. */
	root: string;
	/** Compiled release executable selecting the release root. */
	executablePath: string;
	/** Absolute session transcripts root; read-only, never written. */
	sessionsDir: string;
	/** Optional absolute path receiving the JSON report; the only write. */
	out?: string;
}

export interface CorpusRuleRate {
	rule: string;
	class: string;
	kind: string;
	scanned: number;
	fires: number;
	rate: number;
	ci_low: number;
	ci_high: number;
	/** Rule-of-three 95% upper bound, present only when fires is 0 and scanned is positive. */
	upper_3n: number | null;
}

export interface CorpusReport {
	sessions_dir: string;
	files: number;
	assistant_messages: number;
	parse_errors: number;
	versions: string[];
	events: Record<string, number>;
	rules: CorpusRuleRate[];
}

export class CorpusInputError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "CorpusInputError";
	}
}

/** Session row shapes the corpus reads; printed by --plan before reading anything. */
export const CORPUS_PLAN = {
	reads: [
		"lines containing '\"assistant\"', '\"version\"', or '\"v\"' are parsed as JSON; anything else is skipped unread",
		"assistant message rows: {type: message, message: {role: assistant, content: [{type: text, text}, {type: toolCall, name, arguments}]}}",
		"bash calls match on JSON-stringified arguments; write calls on content with the path as scope; edit calls on native-parsed or approximate new-content fields",
		"text blocks match as assistant text",
	],
	accepted_versions: ["top-level numeric version 3 (session rows)", "top-level numeric v 1 (title rows)"],
	refuses: "unknown session schema versions refuse: any other top-level numeric version or v exits before writing partial counts",
	writes: "one TSV beside the chosen report path (scratch) plus the JSON report itself; command text never leaves the machine and sample payloads stay out of the JSON",
};

/** Wilson score 95% interval for fires/scanned. */
export function wilsonInterval(fires: number, scanned: number): { low: number; high: number } {
	if (!Number.isSafeInteger(fires) || !Number.isSafeInteger(scanned) || fires < 0 || scanned <= 0 || fires > scanned) {
		return { low: 0, high: 0 };
	}
	const z = WILSON_Z;
	const p = fires / scanned;
	const denom = 1 + (z * z) / scanned;
	const center = (p + (z * z) / (2 * scanned)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / scanned + (z * z) / (4 * scanned * scanned))) / denom;
	return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** Rule-of-three 95% upper bound for zero fires in scanned events. */
export function ruleOfThreeUpper(scanned: number): number | null {
	if (!Number.isSafeInteger(scanned) || scanned <= 0) return null;
	return 3 / scanned;
}

function redactedStderrTail(stderr: string, root: string): string {
	let redacted = stderr.trim().split(/\r?\n/).slice(-5).join("\n");
	const identity = resolveOmpIdentity(process.env);
	const pathRoots: Array<[string, string]> = [
		[identity.source, "<omp-source>"],
		[identity.packageRoot, "<omp-package>"],
		[identity.nativeRoot, "<omp-native>"],
		[root, "."],
	].sort(([left], [right]) => right.length - left.length);
	for (const [path, label] of pathRoots) {
		redacted = redacted.split(path).join(label);
		if (process.platform === "darwin" && path.startsWith("/private/")) {
			redacted = redacted.split(path.slice("/private".length)).join(label);
		}
	}
	// URI syntax places `//` after a colon, which the generic path scrubber
	// mistakes for an absolute path and would erase even the source-relative
	// label above. Hold only trusted root labels across that pass.
	const rootLabels = new Map<string, string>();
	redacted = redacted.replace(/file:\/\/<(?:omp-source|omp-package|omp-native)>/g, match => {
		const token = `__OMP_ROOT_${rootLabels.size}__`;
		rootLabels.set(token, match);
		return token;
	});
	redacted = redacted
		.replace(/(^|[\s"'(=:])\/[^\s"'<>)]*/g, "$1<path>")
		.replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
		.replace(/\b((?:api[_-]?key|token|password)\s*[:=]\s*)\S+/gi, "$1<redacted>");
	for (const [token, label] of rootLabels) redacted = redacted.split(token).join(label);
	return redacted.slice(-600);
}

const SUMMARY = /corpus: files=(\d+)\/\d+ assistant_messages=(\d+) parse_errors=(\d+) versions=\[([^\]]*)\] events=(\{.*\}) secs=/;

function parseSummary(stdout: string): { files: number; messages: number; errors: number; versions: string[]; events: Record<string, number> } | null {
	const match = SUMMARY.exec(stdout);
	if (!match) return null;
	let events: Record<string, number> = {};
	try {
		const parsed: unknown = JSON.parse(match[5] ?? "{}");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			events = parsed as Record<string, number>;
		}
	} catch {
		return null;
	}
	return {
		files: Number(match[1]),
		messages: Number(match[2]),
		errors: Number(match[3]),
		versions: (match[4] ?? "").split(",").map(part => part.trim()).filter(part => part.length > 0),
		events,
	};
}

interface TsvRow {
	rule: string;
	class: string;
	kind: string;
	scanned: number;
	fires: number;
}

function parseTsv(text: string): TsvRow[] {
	const rows: TsvRow[] = [];
	const lines = text.split("\n");
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line || line.trim() === "") continue;
		const cols = line.split("\t");
		if (cols.length < 6) continue;
		const scanned = Number(cols[3]);
		const fires = Number(cols[4]);
		if (!Number.isSafeInteger(scanned) || !Number.isSafeInteger(fires)) continue;
		rows.push({ rule: cols[0] ?? "", class: cols[1] ?? "", kind: cols[2] ?? "", scanned, fires });
	}
	return rows;
}

/** Per-rule fire rates over local session transcripts; the machine is the boundary. */
export async function runCorpus(input: CorpusInput): Promise<CorpusReport> {
	if (typeof input.sessionsDir !== "string" || !isAbsolute(input.sessionsDir)) {
		throw new CorpusInputError("INVALID_CORPUS_SELECTION", "Session transcripts need an absolute directory");
	}
	let sessionsIsDirectory = false;
	try {
		sessionsIsDirectory = statSync(input.sessionsDir).isDirectory();
	} catch {
		// Missing and unstatable paths cannot be valid session roots.
	}
	if (!sessionsIsDirectory) {
		throw new CorpusInputError("INVALID_CORPUS_SELECTION", "Session transcripts path must be an existing directory");
	}
	if (input.out !== undefined && (typeof input.out !== "string" || !isAbsolute(input.out))) {
		throw new CorpusInputError("INVALID_CORPUS_SELECTION", "The report path must be absolute");
	}
	if (![input.root, input.executablePath].every(value => typeof value === "string" && isAbsolute(value))) {
		throw new CorpusInputError("CORPUS_UNAVAILABLE", "Release root and executable must be absolute paths");
	}
	const scratch = mkdtempSync(join(tmpdir(), "omp-kit-corpus-"));
	const tsv = join(scratch, "corpus-fire-rate.tsv");
	try {
		const result = await runBundled(HARNESS,
			["--corpus", "--sessions-root", input.sessionsDir, "--out", tsv], input.root, input.executablePath);
		if (result.code !== 0) {
			if (result.code === 2 && result.stderr.includes("unknown session schema versions")) {
				throw new CorpusInputError("UNKNOWN_SESSION_SCHEMA",
					`Session transcripts use an unknown schema version; no counts were written: ${result.stderr.trim().split("\n").pop() ?? ""}`);
			}
			throw new CorpusInputError("CORPUS_UNAVAILABLE",
				`Session scan failed (producer_rc=${result.code}): ${redactedStderrTail(result.stderr, input.root) || "<empty stderr>"}`);
		}
		const summary = parseSummary(result.stdout);
		if (!summary) {
			throw new CorpusInputError("CORPUS_UNAVAILABLE", "Session scan printed no parseable summary");
		}
		let tsvText: string;
		try {
			tsvText = readFileSync(tsv, "utf-8");
		} catch {
			throw new CorpusInputError("CORPUS_UNAVAILABLE", "Session scan wrote no report");
		}
		const rules: CorpusRuleRate[] = parseTsv(tsvText).map(row => {
			const interval = wilsonInterval(row.fires, row.scanned);
			return {
				rule: row.rule,
				class: row.class,
				kind: row.kind,
				scanned: row.scanned,
				fires: row.fires,
				rate: row.scanned > 0 ? row.fires / row.scanned : 0,
				ci_low: interval.low,
				ci_high: interval.high,
				upper_3n: row.fires === 0 ? ruleOfThreeUpper(row.scanned) : null,
			};
		});
		const report: CorpusReport = {
			sessions_dir: input.sessionsDir,
			files: summary.files,
			assistant_messages: summary.messages,
			parse_errors: summary.errors,
			versions: summary.versions,
			events: summary.events,
			rules,
		};
		if (input.out !== undefined) {
			writeFileSync(input.out, `${JSON.stringify({ overall: "OK", corpus: report }, null, 2)}\n`);
		}
		return report;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
