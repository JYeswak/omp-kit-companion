/**
 * Rule-coverage check for skill-mine (ompkit-nmke9, box [b]).
 *
 * Faithful TypeScript port of the chief's `rule_coverage.py` minus the seat
 * probe and the probe/latency caches: given a rule backlog
 * (rule_id, stated_at, owning_skill, skill_path, anchor), it proves each
 * durable rule older than the grace window is anchored in the skill file a
 * seat loads, with stated-to-landed latency from git history.
 *
 * Status is always measured; git landing history only enriches covered rows.
 * A superseded rule whose successor is in the backlog is not owed; a
 * successor id that is not in the backlog does not excuse the old wording.
 * An anchor present only in a different skill, or deleted after landing,
 * counts as missing.
 *
 * No regular expressions: normalization is a plain char scan, so the push
 * regexploit gate has nothing to judge.
 */
import { openSync, closeSync, readSync, fstatSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { run } from "./kitlib/run.ts";

/** Byte cap for one backlog read; mirrors rule_coverage's 8 MiB bound. */
export const COVERAGE_BACKLOG_BYTES_CAP = 8 << 20;
/** Byte cap for one skill file read; mirrors rule_coverage.MAX_SKILL_BYTES. */
export const COVERAGE_SKILL_BYTES_CAP = 1 << 20;
/** Byte cap for one `git show` output; skill files stay far under it. */
export const COVERAGE_GIT_SHOW_BYTES_CAP = 2 << 20;
/** Default grace window: a stated rule must land within a day. */
export const COVERAGE_DEFAULT_GRACE_HOURS = 24;
/** Deadline for one git plumbing call. */
export const COVERAGE_GIT_DEADLINE_S = 30;

const EMPHASIS_CHARS: Record<string, true> = { "*": true, "_": true, "`": true, "~": true, "#": true, ">": true, "|": true, "-": true };
/**
 * Lowercase, strip markdown emphasis chars, collapse whitespace. Mirrors
 * rule_coverage.normalize exactly (emphasis set `*_`~#>|`), so an anchor
 * wrapped in `**bold**` or backticks still matches its plain wording.
 */
export function normalizeCoverageAnchor(text: string): string {
	let stripped = "";
	for (const ch of text.toLowerCase()) {
		if (EMPHASIS_CHARS[ch] !== true) stripped += ch;
	}
	const parts: string[] = [];
	let cur = "";
	for (const ch of stripped) {
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
			if (cur.length > 0) {
				parts.push(cur);
				cur = "";
			}
		} else cur += ch;
	}
	if (cur.length > 0) parts.push(cur);
	return parts.join(" ");
}

export interface CoverageBacklogRule {
	rule_id: string;
	stated_at: string | number | null;
	durable: boolean;
	owning_skill: string;
	skill_path: string;
	anchor: string;
	status?: string;
	superseded_by?: string;
}

export type CoverageRuleStatus = "covered" | "missing" | "skill_missing" | "skipped_non_durable" | "superseded";

export interface CoverageRuleResult {
	rule_id: string;
	durable: boolean;
	owning_skill: string;
	skill_path: string;
	status: CoverageRuleStatus;
	landed_at: string | null;
	landed_commit: string | null;
	latency_hours: number | null;
	stated_at: string | number | null;
}

export interface CoverageTotals {
	durable: number;
	covered: number;
	missing: number;
	skill_missing: number;
	superseded: number;
	p50_latency_hours: number | null;
	p90_latency_hours: number | null;
}

export interface CoverageReport {
	rules: CoverageRuleResult[];
	totals: CoverageTotals;
	overdue: string[];
	exit_code: 0 | 1;
}

export class CoverageInputError extends Error {}

/** Bounded backlog read: at most the cap plus one byte, so an oversized
 * backlog is refused instead of truncated into a JSON error. */
export function loadCoverageBacklog(path: string): CoverageBacklogRule[] {
	let size = -1;
	try {
		size = statSync(path).size;
	} catch (error) {
		throw new CoverageInputError(`backlog not found: ${path}`);
	}
	if (size > COVERAGE_BACKLOG_BYTES_CAP) {
		throw new CoverageInputError(`backlog exceeds ${COVERAGE_BACKLOG_BYTES_CAP} bytes: ${path}`);
	}
	let fd = -1;
	let raw: Buffer;
	try {
		fd = openSync(path, "r");
		const stat = fstatSync(fd);
		const take = Math.min(stat.size, COVERAGE_BACKLOG_BYTES_CAP + 1);
		raw = Buffer.alloc(take);
		let at = 0;
		while (at < take) {
			const n = readSync(fd, raw, at, take - at, at);
			if (n <= 0) break;
			at += n;
		}
		raw = raw.subarray(0, at);
	} catch (error) {
		if (error instanceof CoverageInputError) throw error;
		throw new CoverageInputError(`backlog unreadable: ${path}`);
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				/* descriptor already gone */
			}
		}
	}
	if (raw.length > COVERAGE_BACKLOG_BYTES_CAP) {
		throw new CoverageInputError(`backlog exceeds ${COVERAGE_BACKLOG_BYTES_CAP} bytes: ${path}`);
	}
	const rules: CoverageBacklogRule[] = [];
	const text = raw.toString("utf8");
	let lineno = 0;
	for (const line of text.split("\n")) {
		lineno++;
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			throw new CoverageInputError(`backlog line ${lineno}: invalid JSON`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new CoverageInputError(`backlog line ${lineno}: not an object`);
		}
		const row = parsed as Record<string, unknown>;
		rules.push({
			rule_id: typeof row["rule_id"] === "string" ? row["rule_id"] : "?",
			stated_at: typeof row["stated_at"] === "string" || typeof row["stated_at"] === "number" ? row["stated_at"] : null,
			durable: row["durable"] === true,
			owning_skill: typeof row["owning_skill"] === "string" ? row["owning_skill"] : "",
			skill_path: typeof row["skill_path"] === "string" ? row["skill_path"] : "",
			anchor: typeof row["anchor"] === "string" ? row["anchor"] : "",
			...(typeof row["status"] === "string" ? { status: row["status"] } : {}),
			...(typeof row["superseded_by"] === "string" ? { superseded_by: row["superseded_by"] } : {}),
		});
	}
	return rules;
}

/** Bounded skill read: files over the cap read as absent (skill_missing),
 * mirroring rule_coverage.bounded_read_text. */
function boundedReadSkill(path: string): string | null {
	let size = -1;
	try {
		size = statSync(path).size;
	} catch {
		return null;
	}
	if (size > COVERAGE_SKILL_BYTES_CAP) return null;
	let fd = -1;
	try {
		fd = openSync(path, "r");
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > COVERAGE_SKILL_BYTES_CAP) return null;
		const buf = Buffer.alloc(stat.size);
		let at = 0;
		while (at < buf.length) {
			const n = readSync(fd, buf, at, buf.length - at, at);
			if (n <= 0) break;
			at += n;
		}
		return buf.subarray(0, at).toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				/* descriptor already gone */
			}
		}
	}
}

function isHex40(text: string): boolean {
	if (text.length !== 40) return false;
	for (const ch of text) {
		const code = ch.charCodeAt(0);
		if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70))) return false;
	}
	return true;
}

async function runGit(argv: string[], cwd: string, deadlineS: number, maxBytes: number): Promise<{ ok: boolean; out: string }> {
	let result;
	try {
		result = await run(argv, { cwd, deadline_s: deadlineS, max_output_bytes: maxBytes });
	} catch {
		return { ok: false, out: "" };
	}
	if (result.timed_out || result.rc !== 0) return { ok: false, out: "" };
	return { ok: true, out: Buffer.from(result.stdout).toString("utf8") };
}

/** Oldest commit whose version of the file contains the normalized anchor. */
async function firstLandingCommit(repo: string, rel: string, anchorNorm: string): Promise<{ sha: string; committed: string } | null> {
	const log = await runGit(["git", "log", "--reverse", "--format=%H%x00%cI", "--", rel], repo, COVERAGE_GIT_DEADLINE_S, COVERAGE_GIT_SHOW_BYTES_CAP);
	if (!log.ok) return null;
	for (const entry of log.out.split("\n")) {
		if (entry.trim().length === 0) continue;
		const nul = entry.indexOf("\0");
		if (nul < 0) continue;
		const sha = entry.slice(0, nul).trim();
		const committed = entry.slice(nul + 1).trim();
		if (!isHex40(sha) || committed.length === 0) continue;
		const show = await runGit(["git", "show", `${sha}:${rel}`], repo, COVERAGE_GIT_DEADLINE_S, COVERAGE_GIT_SHOW_BYTES_CAP);
		if (!show.ok) continue;
		if (normalizeCoverageAnchor(show.out).includes(anchorNorm)) return { sha, committed };
	}
	return null;
}

/** Status is always measured; git landing history only enriches covered rows. */
export async function checkCoverageRule(rule: CoverageBacklogRule, nowMs: number): Promise<CoverageRuleResult> {
	const statedMs = typeof rule.stated_at === "number" && Number.isFinite(rule.stated_at)
		? rule.stated_at
		: typeof rule.stated_at === "string" && !Number.isNaN(Date.parse(rule.stated_at))
			? Date.parse(rule.stated_at)
			: nowMs;
	const result: CoverageRuleResult = {
		rule_id: rule.rule_id,
		durable: rule.durable,
		owning_skill: rule.owning_skill,
		skill_path: rule.skill_path,
		status: "missing",
		landed_at: null,
		landed_commit: null,
		latency_hours: null,
		stated_at: rule.stated_at,
	};
	const anchorNorm = normalizeCoverageAnchor(rule.anchor);
	if (anchorNorm.length === 0) return result;
	const content = boundedReadSkill(rule.skill_path);
	if (content === null) {
		result.status = "skill_missing";
		return result;
	}
	if (!normalizeCoverageAnchor(content).includes(anchorNorm)) return result;
	result.status = "covered";
	const parent = dirname(resolve(rule.skill_path));
	const root = await runGit(["git", "rev-parse", "--show-toplevel"], parent, COVERAGE_GIT_DEADLINE_S, 64 * 1024);
	if (!root.ok) return result;
	const repo = root.out.trim().split("\n")[0] ?? "";
	if (repo.length === 0) return result;
	let rel: string;
	try {
		rel = relative(resolve(repo), resolve(rule.skill_path));
	} catch {
		return result;
	}
	if (rel.length === 0 || rel.startsWith("..")) return result;
	const landed = await firstLandingCommit(repo, rel, anchorNorm);
	if (landed === null) return result;
	const landedMs = Date.parse(landed.committed);
	if (Number.isNaN(landedMs)) return result;
	result.landed_at = new Date(landedMs).toISOString();
	result.landed_commit = landed.sha;
	result.latency_hours = Math.round(((landedMs - statedMs) / 3600000) * 100) / 100;
	return result;
}

function percentile(sorted: number[], pct: number): number | null {
	if (sorted.length === 0) return null;
	if (sorted.length === 1) return sorted[0]!;
	const k = ((sorted.length - 1) * pct) / 100;
	const lo = Math.floor(k);
	const hi = Math.min(lo + 1, sorted.length - 1);
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo);
}

export interface CoverageRunOptions {
	backlog: string;
	graceHours?: number;
	nowMs?: number;
}

export async function runCoverage(options: CoverageRunOptions): Promise<CoverageReport> {
	const graceMs = (options.graceHours ?? COVERAGE_DEFAULT_GRACE_HOURS) * 3600000;
	const nowMs = options.nowMs ?? Date.now();
	const rules = loadCoverageBacklog(options.backlog);
	const ids = new Set(rules.map(rule => rule.rule_id));
	const checked: CoverageRuleResult[] = [];
	for (const rule of rules) {
		if (!rule.durable) {
			checked.push({
				rule_id: rule.rule_id, durable: false, owning_skill: rule.owning_skill,
				skill_path: rule.skill_path, status: "skipped_non_durable",
				landed_at: null, landed_commit: null, latency_hours: null, stated_at: rule.stated_at,
			});
			continue;
		}
		if (rule.status === "superseded" && rule.superseded_by !== undefined && ids.has(rule.superseded_by)) {
			checked.push({
				rule_id: rule.rule_id, durable: false, owning_skill: rule.owning_skill,
				skill_path: rule.skill_path, status: "superseded",
				landed_at: null, landed_commit: null, latency_hours: null, stated_at: rule.stated_at,
			});
			continue;
		}
		checked.push(await checkCoverageRule(rule, nowMs));
	}
	const durable = checked.filter(row => row.durable);
	const covered = durable.filter(row => row.status === "covered");
	const missing = durable.filter(row => row.status === "missing");
	const skillMissing = durable.filter(row => row.status === "skill_missing");
	const latencies = covered
		.map(row => row.latency_hours)
		.filter((value): value is number => typeof value === "number")
		.sort((a, b) => a - b);
	const totals: CoverageTotals = {
		durable: durable.length,
		covered: covered.length,
		missing: missing.length,
		skill_missing: skillMissing.length,
		superseded: checked.filter(row => row.status === "superseded").length,
		p50_latency_hours: percentile(latencies, 50),
		p90_latency_hours: percentile(latencies, 90),
	};
	const byId = new Map(rules.map(rule => [rule.rule_id, rule] as const));
	const overdue = durable
		.filter(row => row.status !== "covered")
		.filter(row => {
			const stated = byId.get(row.rule_id)?.stated_at;
			const statedMs = typeof stated === "number" && Number.isFinite(stated)
				? stated
				: typeof stated === "string" && !Number.isNaN(Date.parse(stated))
					? Date.parse(stated)
					: nowMs;
			return nowMs - statedMs > graceMs;
		})
		.map(row => row.rule_id);
	return { rules: checked, totals, overdue, exit_code: overdue.length === 0 ? 0 : 1 };
}

/** Human-readable rendering for non-JSON runs; mirrors rule_coverage's text mode. */
export function renderCoverageText(report: CoverageReport): string {
	const lines: string[] = [];
	for (const row of report.rules) {
		let extra = "";
		if (row.status === "covered") extra = ` landed_at=${row.landed_at ?? "?"} latency_h=${row.latency_hours ?? "?"}`;
		lines.push(`${row.rule_id}: ${row.status}${extra}`);
	}
	const totals = report.totals;
	lines.push(`totals: durable=${totals.durable} covered=${totals.covered} missing=${totals.missing} skill_missing=${totals.skill_missing} superseded=${totals.superseded} p50=${totals.p50_latency_hours ?? "?"} p90=${totals.p90_latency_hours ?? "?"}`);
	if (report.overdue.length > 0) lines.push(`OVERDUE (past grace, not covered): ${report.overdue.join(", ")}`);
	return lines.join("\n");
}

