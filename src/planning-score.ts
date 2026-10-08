import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { record } from "./mcp-sources.ts";
import type { PresentationResult } from "./output.ts";

export type PlanningStatus = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";
export type PlanningMetric = { value: unknown; target: unknown; status: PlanningStatus; weight: number; evidence?: Record<string, unknown> };
export type PlanningBead = Record<string, unknown>;
export type PlanningCommit = {
	sha: string;
	subject: string;
	timestamp: number;
	changedPaths?: readonly string[];
	planDiffRatio?: number | null;
};
export type LocalCheckReceipt = { sha?: unknown; exit_code?: unknown; time?: unknown };
export type PlanningCiEvidence = {
	mode?: string;
	check?: string;
	configurationError?: string;
	branchHeadSha?: string | null;
	ghConclusion?: string | null;
	localReceipts?: readonly LocalCheckReceipt[] | null;
};
export type PlanningScoreSnapshot = {
	repoPath: string;
	trackerPath: string;
	mission: string;
	planPath: string | null;
	planExists: boolean | null;
	repoCommits: readonly PlanningCommit[] | null;
	trackerCommits: readonly PlanningCommit[] | null;
	beads: readonly PlanningBead[] | null;
	polishPreviousBeads?: readonly PlanningBead[] | null;
	polishCurrentBeads?: readonly PlanningBead[] | null;
	nowEpochSeconds: number | null;
	stage?: string;
	ci: PlanningCiEvidence;
};
export type PlanningScoreTuning = {
	targets: Record<string, number | boolean>;
	weights: Record<string, number>;
};
export type MissionScore = {
	kind: "mission";
	repo: string;
	mission: string;
	stage?: string;
	status: PlanningStatus;
	weighted_score: number | null;
	metrics: Record<string, PlanningMetric>;
};

type TaggedSubject = { mission: string; action: string };
type FleetRepo = { name: string; path: string; tracker?: string };
type LoadedConfig = {
	raw: Record<string, unknown>;
	tuning: PlanningScoreTuning;
	fleet: FleetRepo[];
	planDefault: string;
};
type RepositoryScoreContext = {
	repoPath: string;
	trackerPath: string;
	config: LoadedConfig;
	repoCommits: readonly PlanningCommit[];
	trackerCommits: readonly PlanningCommit[];
	beads: PlanningBead[] | null;
	ci: PlanningCiEvidence;
	home: string;
	nowEpochSeconds: number;
};
const SECONDS_PER_DAY = 86_400;
const MAX_TOML_BYTES = 1_048_576;
const MAX_TRACKER_BYTES = 64 * 1_048_576;
const MAX_RECEIPT_BYTES = 1_048_576;
const SCORE_METRIC_NAMES = ["plan_present", "plan_rounds", "plan_last_diff", "converted_once", "coverage_checks", "polish_rounds", "polish_last_changed", "bead_self_contained", "plan_to_code_hours", "plan_ship_ratio_7d", "main_green"] as const;
const HISTORICAL_METRICS = ["plan_present", "plan_rounds", "plan_last_diff", "converted_once", "coverage_checks", "polish_rounds", "polish_last_changed", "plan_to_code_hours"] as const;
const CODE_EXTENSIONS = new Set([".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".js", ".jsx", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".swift", ".ts", ".tsx", ".vue"]);

function stringValue(value: unknown): string | null { return typeof value === "string" ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function safePathStat(path: string): "missing" | "file" | "directory" | "unsafe" {
	try {
		const stat = lstatSync(path);
		if (stat.isFile() && !stat.isSymbolicLink()) return "file";
		if (stat.isDirectory() && !stat.isSymbolicLink()) return "directory";
		return "unsafe";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
	}
}
function safeRead(path: string, maxBytes: number): string | null {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
		return readFileSync(path, "utf8");
	} catch { return null; }
}
function gitText(cwd: string, args: readonly string[], timeout = 30_000): string | null {
	try {
		const result = spawnSync("git", [...args], { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1_048_576 });
		if (result.error || result.status !== 0) return null;
		return result.stdout ?? "";
	} catch { return null; }
}
function parseTag(subject: string, kind: "plan" | "beads"): TaggedSubject | null {
	const prefix = kind + "(";
	if (!subject.startsWith(prefix)) return null;
	const end = subject.indexOf("):", prefix.length);
	if (end <= prefix.length) return null;
	const mission = subject.slice(prefix.length, end).trim();
	if (!mission || mission.includes("/") || mission.includes("\\") || mission.includes("..")) return null;
	// The commit-msg verification-level hook requires one "[level]" in every subject, so a trailing
	// level tag is part of the convention, not part of the action. Only the hook's six levels strip.
	return { mission, action: subject.slice(end + 2).replace(/ \[(?:pending|selftest|test|mutation|oracle|live)\]$/i, "").trim() };
}
function mergeCommits(repoCommits: readonly PlanningCommit[], trackerCommits: readonly PlanningCommit[]): PlanningCommit[] {
	const rows = new Map<string, PlanningCommit>();
	for (const item of [...repoCommits, ...trackerCommits]) if (!rows.has(item.sha)) rows.set(item.sha, item);
	return [...rows.values()].sort((left, right) => left.timestamp - right.timestamp || left.sha.localeCompare(right.sha));
}
function conversionCount(commits: readonly PlanningCommit[], mission: string): number {
	return commits.reduce((count, item) => {
		const tag = parseTag(item.subject, "beads");
		return tag?.mission === mission && (tag.action === "convert" || tag.action === "reconcile") ? count + 1 : count;
	}, 0);
}
function metric(value: unknown, target: unknown, status: PlanningStatus, weight: number, evidence?: Record<string, unknown>): PlanningMetric {
	return { value, target, status, weight, ...(evidence ? { evidence } : {}) };
}
function isCodePath(path: string): boolean {
	if (path.startsWith(".beads/") || path.startsWith("docs/") || path.startsWith("changelog.d/") || path.startsWith("skills/") || path.startsWith("config/")) return false;
	const dot = path.lastIndexOf(".");
	return dot >= 0 && CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
function isCodeCommit(commit: PlanningCommit): boolean {
	if (parseTag(commit.subject, "plan") || parseTag(commit.subject, "beads")) return false;
	return (commit.changedPaths ?? []).some(isCodePath);
}
function isPlanningCommit(commit: PlanningCommit): boolean {
	return parseTag(commit.subject, "plan") !== null || parseTag(commit.subject, "beads") !== null;
}
function isPolishRound(commit: PlanningCommit, mission: string): boolean {
	const tag = parseTag(commit.subject, "beads");
	return tag?.mission === mission && tag.action.startsWith("polish round ") && positiveRound(tag.action.slice("polish round ".length));
}
function issueText(bead: PlanningBead): string {
	return [stringValue(bead.title) ?? "", stringValue(bead.description) ?? "", stringValue(bead.acceptance_criteria) ?? ""].join("\n");
}
function hasIssueLabel(bead: PlanningBead, expected: string): boolean {
	if (!Array.isArray(bead.labels)) return false;
	for (const label of bead.labels) if (label === expected) return true;
	return false;
}
function hasMissionOrPlanReference(bead: PlanningBead, label: "plan" | "mission", mission: string, planPath: string | null): boolean {
	return hasIssueLabel(bead, label + ":" + mission) || (planPath !== null && issueText(bead).includes(planPath));
}
function isPlanBead(bead: PlanningBead, mission: string, planPath: string | null): boolean {
	return hasMissionOrPlanReference(bead, "plan", mission, planPath);
}
function isMissionBead(bead: PlanningBead, mission: string, planPath: string | null): boolean {
	return bead.issue_type !== "epic" && hasMissionOrPlanReference(bead, "mission", mission, planPath);
}
function isParked(bead: PlanningBead): boolean {
	const status = stringValue(bead.status)?.toLowerCase();
	return status === "parked" || status === "deferred" || hasIssueLabel(bead, "parked") || hasIssueLabel(bead, "deferred");
}
function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stableValue);
	if (!record(value)) return value;
	return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}
function stableJson(value: unknown): string { return JSON.stringify(stableValue(value)); }
export function polishChangedShare(previous: readonly PlanningBead[] | null, current: readonly PlanningBead[] | null, mission: string, planPath: string | null): number | null {
	if (!previous || !current) return null;
	const eligible = (rows: readonly PlanningBead[]) => rows.filter((bead) => isMissionBead(bead, mission, planPath) && !(isParked(bead) && !isPlanBead(bead, mission, planPath)));
	const before = new Map(eligible(previous).map((bead) => [stringValue(bead.id) ?? "", bead]));
	const after = new Map(eligible(current).map((bead) => [stringValue(bead.id) ?? "", bead]));
	const ids = new Set([...before.keys(), ...after.keys()]);
	if (!ids.size) return null;
	let changed = 0;
	for (const id of ids) {
		if (!before.has(id) || !after.has(id) || stableJson(before.get(id)) !== stableJson(after.get(id))) changed++;
	}
	return changed / ids.size;
}
function median(values: readonly number[]): number | null {
	if (!values.length) return null;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 ? ordered[middle] ?? null : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
}
function safeMissionBeads(beads: readonly PlanningBead[] | null, mission: string, planPath: string | null): PlanningBead[] | null {
	return beads === null ? null : beads.filter((bead) => isMissionBead(bead, mission, planPath));
}
type CiVerdict = { value: boolean | null; status: PlanningStatus; evidence: Record<string, unknown> };
function mainGreenUnknown(mode: string, reason: string, context: Record<string, unknown> = {}): CiVerdict {
	return { value: null, status: "UNKNOWN", evidence: { mode, ...context, reason } };
}
function localMainGreen(ci: PlanningCiEvidence): CiVerdict {
	const context = { ...(ci.check ? { check: ci.check } : {}), ...(ci.branchHeadSha ? { branch_head_sha: ci.branchHeadSha } : {}) };
	if (ci.configurationError) return mainGreenUnknown("local", ci.configurationError, context);
	if (!ci.check?.trim()) return mainGreenUnknown("local", "local CI check is not configured", context);
	if (!ci.branchHeadSha || !ci.localReceipts) return mainGreenUnknown("local", "branch head or receipts unavailable", context);
	const matching = ci.localReceipts.flatMap((receipt) => {
		const time = receiptTime(receipt);
		return receipt.sha === ci.branchHeadSha && typeof receipt.exit_code === "number" && Number.isInteger(receipt.exit_code) && time !== null ? [{ receipt, time }] : [];
	});
	if (!matching.length) return mainGreenUnknown("local", "no valid local-check receipt for branch head", context);
	const latest = matching.reduce((best, item) => item.time > best.time ? item : best);
	const green = latest.receipt.exit_code === 0;
	return { value: green, status: green ? "PASS" : "FAIL", evidence: { mode: "local", ...context, exit_code: latest.receipt.exit_code, receipt_time: latest.receipt.time } };
}
function hostedMainGreen(ci: PlanningCiEvidence): CiVerdict {
	if (!ci.ghConclusion) return mainGreenUnknown("hosted", "no hosted CI conclusion available");
	if (ci.ghConclusion === "success") return { value: true, status: "PASS", evidence: { mode: "hosted", conclusion: ci.ghConclusion } };
	if (["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(ci.ghConclusion)) return { value: false, status: "FAIL", evidence: { mode: "hosted", conclusion: ci.ghConclusion } };
	return mainGreenUnknown("hosted", "hosted CI conclusion is not final", { conclusion: ci.ghConclusion });
}
function localMainGreenOrHosted(ci: PlanningCiEvidence): CiVerdict {
	if (ci.mode === "local") return localMainGreen(ci);
	if (ci.mode !== undefined && ci.mode !== "hosted") return mainGreenUnknown(ci.mode, "unknown CI mode");
	return hostedMainGreen(ci);
}
function receiptTime(receipt: LocalCheckReceipt): number | null {
	const value = stringValue(receipt.time);
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}
function scoreOverall(metrics: Record<string, PlanningMetric>): { status: PlanningStatus; weighted_score: number | null } {
	const active = Object.values(metrics).filter((item) => item.status !== "NOT_APPLICABLE");
	const total = active.reduce((sum, item) => sum + item.weight, 0);
	const passed = active.filter((item) => item.status === "PASS").reduce((sum, item) => sum + item.weight, 0);
	const weighted = total > 0 ? Math.round((passed / total) * 10_000) / 100 : null;
	const status: PlanningStatus = active.some((item) => item.status === "FAIL") ? "FAIL" :
		active.some((item) => item.status === "UNKNOWN") ? "UNKNOWN" : active.length ? "PASS" : "NOT_APPLICABLE";
	return { status, weighted_score: weighted };
}
type MetricWriter = (name: string, value: unknown, target: unknown, status: PlanningStatus, evidence?: Record<string, unknown>) => void;
function beadQualityTarget(target: (name: string, fallback: number | boolean) => number | boolean): Record<string, unknown> {
	return { median_chars: target("bead_self_contained_median_chars", 300), test_share: target("bead_self_contained_test_share", 0.4), deps_per_bead: target("bead_self_contained_deps_per_bead", 1) };
}
function beadQualityBounds(target: (name: string, fallback: number | boolean) => number | boolean): Record<string, string> {
	return { median_chars: ">= " + target("bead_self_contained_median_chars", 300), test_share: ">= " + target("bead_self_contained_test_share", 0.4), deps_per_bead: ">= " + target("bead_self_contained_deps_per_bead", 1) };
}
function scorePlanPresence(snapshot: PlanningScoreSnapshot, target: (name: string, fallback: number | boolean) => number | boolean, put: MetricWriter): void {
	if (snapshot.planExists === null || snapshot.beads === null || !snapshot.planPath) { put("plan_present", null, target("plan_present", true), "UNKNOWN"); return; }
	const citing = snapshot.beads.filter((bead) => issueText(bead).includes(snapshot.planPath!)).length;
	const present = snapshot.planExists && citing > 0;
	put("plan_present", present, target("plan_present", true), present ? "PASS" : "FAIL", { plan_path: snapshot.planPath, file_exists: snapshot.planExists, citing_beads: citing });
}
function scoreHistoryMetrics(snapshot: PlanningScoreSnapshot, target: (name: string, fallback: number | boolean) => number | boolean, put: MetricWriter): void {
	const commits = snapshot.repoCommits === null || snapshot.trackerCommits === null ? null : mergeCommits(snapshot.repoCommits, snapshot.trackerCommits);
	if (commits === null) {
		for (const [name, fallback] of [["plan_rounds", 4], ["converted_once", 1], ["coverage_checks", 1], ["polish_rounds", 6]] as const) put(name, null, target(name, fallback), "UNKNOWN");
		put("plan_last_diff", null, "<= " + String(target("plan_last_diff", 0.05)), "UNKNOWN");
		put("polish_last_changed", null, "<= " + String(target("polish_last_changed", 0.05)), "UNKNOWN");
		return;
	}
	const reviews = commits.filter((item) => { const tag = parseTag(item.subject, "plan"); return tag?.mission === snapshot.mission && tag.action.startsWith("review round ") && positiveRound(tag.action.slice("review round ".length)); });
	const roundsTarget = numberValue(target("plan_rounds", 4)) ?? 4;
	put("plan_rounds", reviews.length, ">= " + roundsTarget, reviews.length >= roundsTarget ? "PASS" : "FAIL");
	const conversions = conversionCount(commits, snapshot.mission);
	put("converted_once", conversions, 1, conversions === 1 ? "PASS" : "FAIL");
	const coverage = commits.filter((item) => { const tag = parseTag(item.subject, "beads"); return tag?.mission === snapshot.mission && tag.action.startsWith("coverage check ") && positiveRound(tag.action.slice("coverage check ".length)); }).length;
	const coverageTarget = numberValue(target("coverage_checks", 1)) ?? 1;
	put("coverage_checks", coverage, ">= " + coverageTarget, coverage >= coverageTarget ? "PASS" : "FAIL");
	scorePolishMetrics(snapshot, commits, target, put);
	const latestReview = [...reviews].sort((left, right) => left.timestamp - right.timestamp).at(-1);
	const diff = latestReview ? numberValue(latestReview.planDiffRatio) : null;
	const maxDiff = numberValue(target("plan_last_diff", 0.05)) ?? 0.05;
	put("plan_last_diff", diff, "<= " + maxDiff, diff === null ? "UNKNOWN" : diff <= maxDiff ? "PASS" : "FAIL", latestReview ? { commit: latestReview.sha } : undefined);
}
function scorePolishMetrics(snapshot: PlanningScoreSnapshot, commits: readonly PlanningCommit[], target: (name: string, fallback: number | boolean) => number | boolean, put: MetricWriter): void {
	const rounds = commits.filter((item) => isPolishRound(item, snapshot.mission)).length;
	const changed = polishChangedShare(snapshot.polishPreviousBeads ?? null, snapshot.polishCurrentBeads ?? null, snapshot.mission, snapshot.planPath);
	const maxChanged = numberValue(target("polish_last_changed", 0.05)) ?? 0.05;
	put("polish_last_changed", changed, "<= " + maxChanged, changed === null ? "UNKNOWN" : changed <= maxChanged ? "PASS" : "FAIL", changed === null ? undefined : { non_parked_plan_bead_share: changed });
	const roundsTarget = numberValue(target("polish_rounds", 6)) ?? 6;
	const status: PlanningStatus = rounds >= roundsTarget ? "PASS" : changed === null ? "UNKNOWN" : changed <= maxChanged ? "PASS" : "FAIL";
	put("polish_rounds", rounds, ">= " + roundsTarget + " or steady earlier", status, { rounds, steady: changed !== null && changed <= maxChanged });
}
function scoreBeadQuality(snapshot: PlanningScoreSnapshot, target: (name: string, fallback: number | boolean) => number | boolean, put: MetricWriter): void {
	const unknownTarget = beadQualityTarget(target);
	if (snapshot.beads === null) { put("bead_self_contained", null, unknownTarget, "UNKNOWN"); return; }
	const beads = safeMissionBeads(snapshot.beads, snapshot.mission, snapshot.planPath);
	if (!beads?.length) { put("bead_self_contained", null, unknownTarget, "UNKNOWN"); return; }
	const medianChars = median(beads.map((bead) => issueText(bead).length));
	const testShare = beads.filter((bead) => (stringValue(bead.acceptance_criteria) ?? "").trim().length > 0).length / beads.length;
	const depsPerBead = beads.reduce((sum, bead) => sum + (Array.isArray(bead.dependencies) ? bead.dependencies.length : 0), 0) / beads.length;
	const medianTarget = numberValue(target("bead_self_contained_median_chars", 300)) ?? 300;
	const testTarget = numberValue(target("bead_self_contained_test_share", 0.4)) ?? 0.4;
	const depsTarget = numberValue(target("bead_self_contained_deps_per_bead", 1)) ?? 1;
	const status = medianChars !== null && medianChars >= medianTarget && testShare >= testTarget && depsPerBead >= depsTarget ? "PASS" : "FAIL";
	put("bead_self_contained", { median_chars: medianChars, test_share: testShare, deps_per_bead: depsPerBead, mission_beads: beads.length }, beadQualityBounds(target), status);
}
function scorePlanToCode(snapshot: PlanningScoreSnapshot, target: (name: string, fallback: number | boolean) => number | boolean, put: MetricWriter): void {
	const hours = planToCodeHours(snapshot.repoCommits, snapshot.mission);
	const maxHours = numberValue(target("plan_to_code_hours", 24)) ?? 24;
	put("plan_to_code_hours", hours, "<= " + maxHours, hours === null ? "UNKNOWN" : hours <= maxHours ? "PASS" : "FAIL");
}
export function scorePlanningSnapshot(snapshot: PlanningScoreSnapshot, tuning: PlanningScoreTuning): MissionScore {
	const weight = (name: string) => numberValue(tuning.weights[name]) ?? 1;
	const target = (name: string, fallback: number | boolean) => tuning.targets[name] ?? fallback;
	const metrics: Record<string, PlanningMetric> = {};
	const put: MetricWriter = (name, value, metricTarget, status, evidence) => { metrics[name] = metric(value, metricTarget, status, weight(name), evidence); };
	const stage = snapshot.stage?.toLowerCase();
	if (stage === "build") for (const name of HISTORICAL_METRICS) put(name, null, name === "plan_present" || name === "converted_once" ? true : tuning.targets[name] ?? null, "NOT_APPLICABLE", { stage: "build" });
	else { scorePlanPresence(snapshot, target, put); scoreHistoryMetrics(snapshot, target, put); scorePlanToCode(snapshot, target, put); }
	scoreBeadQuality(snapshot, target, put);
	const planShip = planShipRatio(snapshot, tuning);
	put("plan_ship_ratio_7d", planShip.value, "<= " + String(target("plan_ship_ratio_7d", 2)), planShip.status, planShip.evidence);
	const ci = localMainGreenOrHosted(snapshot.ci);
	put("main_green", ci.value, target("main_green", true), ci.status, ci.evidence);
	return { kind: "mission", repo: snapshot.repoPath, mission: snapshot.mission, ...(snapshot.stage ? { stage: snapshot.stage } : {}), ...scoreOverall(metrics), metrics };
}
function positiveRound(value: string): boolean {
	const parsed = Number(value.trim());
	return Number.isInteger(parsed) && parsed > 0;
}
function planToCodeHours(repoCommits: readonly PlanningCommit[] | null, mission: string): number | null {
	if (!repoCommits) return null;
	const drafts = repoCommits.filter((commit) => { const tag = parseTag(commit.subject, "plan"); return tag?.mission === mission && tag.action === "draft"; });
	const draft = [...drafts].sort((left, right) => left.timestamp - right.timestamp).at(0);
	if (!draft) return null;
	const code = repoCommits.filter((commit) => commit.timestamp >= draft.timestamp && isCodeCommit(commit));
	const firstCode = [...code].sort((left, right) => left.timestamp - right.timestamp).at(0);
	return firstCode ? (firstCode.timestamp - draft.timestamp) / 3600 : null;
}
function planShipRatio(snapshot: PlanningScoreSnapshot, tuning: PlanningScoreTuning): { value: number | null; status: PlanningStatus; evidence: Record<string, unknown> } {
	if (!snapshot.repoCommits || !snapshot.trackerCommits || snapshot.nowEpochSeconds === null) return { value: null, status: "UNKNOWN", evidence: { reason: "commit history or scoring time unavailable" } };
	const recentAfter = snapshot.nowEpochSeconds - 7 * SECONDS_PER_DAY;
	const tagged = mergeCommits(snapshot.repoCommits, snapshot.trackerCommits).filter((commit) => commit.timestamp >= recentAfter && isPlanningCommit(commit));
	const code = snapshot.repoCommits.filter((commit) => commit.timestamp >= recentAfter && isCodeCommit(commit));
	if (!tagged.length && !code.length) return { value: null, status: "UNKNOWN", evidence: { planning_commits: 0, code_commits: 0, reason: "no planning or code commits in scoring window" } };
	if (!code.length) return { value: null, status: "FAIL", evidence: { planning_commits: tagged.length, code_commits: 0, reason: "planning commits exist without a code commit in the window" } };
	const value = tagged.length / code.length;
	const limit = numberValue(tuning.targets.plan_ship_ratio_7d) ?? 2;
	return { value, status: value <= limit ? "PASS" : "FAIL", evidence: { planning_commits: tagged.length, code_commits: code.length } };
}

export type PlanningScoreOptions = { kitRoot: string; repoPath?: string; fleet?: boolean; cwd?: string; home?: string };
function scoreRepoEntry(entry: FleetRepo, kitRoot: string, home: string, defaultTuning: PlanningScoreTuning, nowEpochSeconds: number): MissionScore[] {
	const repoPath = expandPath(entry.path, home, kitRoot);
	const trackerPath = expandPath(entry.tracker ?? entry.path, home, kitRoot);
	let config: LoadedConfig;
	try { config = loadPlanningScoreConfig(kitRoot, repoPath, home); }
	catch (error) { return [unknownScore(entry.name, repoPath, "UNKNOWN", defaultTuning, error instanceof Error ? error.message : String(error))]; }
	const repoCommits = readGitLog(repoPath);
	const trackerCommits = trackerPath === repoPath ? repoCommits : readGitLog(trackerPath);
	if (!repoCommits || !trackerCommits) return [unknownScore(entry.name, repoPath, "UNKNOWN", config.tuning, "Repository or tracker history is unreadable")];
	const missions = discoverMissions(repoCommits, trackerCommits, config.raw);
	if (!missions.length) return [unknownScore(entry.name, repoPath, "UNKNOWN", config.tuning, "No planning mission commits or configured mission were found")];
	const beads = readIssues(trackerPath);
	const ci = collectCiEvidence(repoPath, home, record(config.raw.ci) ? config.raw.ci : {});
	const context: RepositoryScoreContext = { repoPath, trackerPath, config, repoCommits, trackerCommits, beads, ci, home, nowEpochSeconds };
	return missions.map((mission) => scoreMission(context, mission));
}
function scoreMission(context: RepositoryScoreContext, mission: string): MissionScore {
	const { repoPath, trackerPath, config, repoCommits, trackerCommits, beads, ci, home, nowEpochSeconds } = context;
	const missionConfigs = record(config.raw.missions) ? config.raw.missions : {};
	const settings = record(missionConfigs[mission]) ? missionConfigs[mission] : {};
	const planPath = resolvePlanPath(repoPath, mission, stringValue(settings.plan) ?? config.planDefault, home);
	const planExists = planPath === null ? null : safePathStat(join(repoPath, planPath)) === "file";
	const repoWithDiff = attachLastPlanDiff(repoPath, mission, planPath, repoCommits);
	const polish = trackerCommits.filter((commit) => isPolishRound(commit, mission)).sort((left, right) => left.timestamp - right.timestamp);
	const previous = polish.at(-2);
	const current = polish.at(-1);
	return scorePlanningSnapshot({ repoPath, trackerPath, mission, planPath, planExists, repoCommits: repoWithDiff, trackerCommits, beads,
		polishPreviousBeads: previous ? readIssuesAtCommit(trackerPath, previous.sha) : null,
		polishCurrentBeads: current ? readIssuesAtCommit(trackerPath, current.sha) : null, nowEpochSeconds, stage: stringValue(settings.stage) ?? undefined, ci }, config.tuning);
}
export function runPlanningScore(options: PlanningScoreOptions): PresentationResult {
	try {
		if (options.fleet && options.repoPath) return usageFailure("--repo and --fleet are mutually exclusive");
		const kitRoot = resolve(options.kitRoot);
		const home = options.home ?? process.env.HOME ?? "";
		const baseConfig = parseConfigError(kitRoot, home);
		const entries = options.fleet ? baseConfig.fleet : singleRepoEntry(options, baseConfig.fleet, home, kitRoot);
		const nowEpochSeconds = Math.floor(Date.now() / 1000);
		const rows = entries.flatMap((entry) => scoreRepoEntry(entry, kitRoot, home, baseConfig.tuning, nowEpochSeconds));
		const overall = scorePlanningFleet(rows, baseConfig.tuning);
		const jsonl = [...rows, overall];
		const text = [...rows.map((row) => row.repo + " / " + row.mission + ": " + row.status + " (" + (row.weighted_score === null ? "UNKNOWN" : row.weighted_score) + ")"),
			"overall: " + overall.status + " (" + (overall.weighted_score === null ? "UNKNOWN" : overall.weighted_score) + ")"].join("\n");
		const code = overall.status === "FAIL" ? 1 : overall.status === "UNKNOWN" ? 3 : 0;
		return { code, data: { kind: "summary", status: overall.status, weighted_score: overall.weighted_score, mission_count: rows.length, metrics: overall.metrics, text }, jsonl,
			commands: [options.fleet ? "omp-kit planning score --fleet" : "omp-kit planning score --repo PATH"], verification: "PERFORMED" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return unavailable("Planning score could not read its configuration or inputs", message);
	}
}
function singleRepoEntry(options: PlanningScoreOptions, fleet: readonly FleetRepo[], home: string, kitRoot: string): FleetRepo[] {
	const repoPath = resolve(options.repoPath ?? options.cwd ?? process.cwd());
	const matched = fleet.find((entry) => expandPath(entry.path, home, kitRoot) === repoPath);
	return [{ name: matched?.name ?? basename(repoPath), path: repoPath, tracker: matched?.tracker }];
}
function targetForMetric(name: string, tuning: PlanningScoreTuning): unknown {
	if (name === "bead_self_contained") return {
		median_chars: ">= " + String(tuning.targets.bead_self_contained_median_chars ?? 300),
		test_share: ">= " + String(tuning.targets.bead_self_contained_test_share ?? 0.4),
		deps_per_bead: ">= " + String(tuning.targets.bead_self_contained_deps_per_bead ?? 1),
	};
	return tuning.targets[name] ?? null;
}

function unknownScore(repo: string, repoPath: string, mission: string, tuning: PlanningScoreTuning, reason: string): MissionScore {
	const metrics: Record<string, PlanningMetric> = {};
	for (const name of SCORE_METRIC_NAMES) metrics[name] = metric(null, targetForMetric(name, tuning), "UNKNOWN", numberValue(tuning.weights[name]) ?? 1, { reason });
	return { kind: "mission", repo: repoPath || repo, mission, status: "UNKNOWN", weighted_score: 0, metrics };
}
type MetricStatusCounts = { pass: number; fail: number; unknown: number; not_applicable: number };
function emptyMetricStatusCounts(): MetricStatusCounts { return { pass: 0, fail: 0, unknown: 0, not_applicable: 0 }; }
function metricStatus(counts: MetricStatusCounts): PlanningStatus {
	return counts.fail ? "FAIL" : counts.unknown ? "UNKNOWN" : counts.pass ? "PASS" : "NOT_APPLICABLE";
}
type FleetScoreTotals = { totalWeight: number; passedWeight: number; hasFailure: boolean; hasUnknown: boolean };
function recordFleetMetric(counts: MetricStatusCounts, totals: FleetScoreTotals, item: PlanningMetric): void {
	switch (item.status) {
		case "PASS": counts.pass++; totals.totalWeight += item.weight; totals.passedWeight += item.weight; break;
		case "FAIL": counts.fail++; totals.totalWeight += item.weight; totals.hasFailure = true; break;
		case "UNKNOWN": counts.unknown++; totals.totalWeight += item.weight; totals.hasUnknown = true; break;
		case "NOT_APPLICABLE": counts.not_applicable++; break;
	}
}
function aggregateScores(rows: readonly MissionScore[], tuning: PlanningScoreTuning): MissionScore {
	const counts: Record<string, MetricStatusCounts> = {};
	for (const name of SCORE_METRIC_NAMES) counts[name] = emptyMetricStatusCounts();
	const totals: FleetScoreTotals = { totalWeight: 0, passedWeight: 0, hasFailure: false, hasUnknown: false };
	for (const row of rows) for (const name of SCORE_METRIC_NAMES) {
		const item = row.metrics[name];
		if (item) recordFleetMetric(counts[name]!, totals, item);
	}
	const metrics: Record<string, PlanningMetric> = {};
	for (const name of SCORE_METRIC_NAMES) {
		const countsForMetric = counts[name]!;
		metrics[name] = metric(countsForMetric, targetForMetric(name, tuning), metricStatus(countsForMetric), numberValue(tuning.weights[name]) ?? 1);
	}
	const weightedScore = totals.totalWeight > 0 ? Math.round((totals.passedWeight / totals.totalWeight) * 10_000) / 100 : null;
	const status: PlanningStatus = totals.hasFailure ? "FAIL" : totals.hasUnknown ? "UNKNOWN" : totals.totalWeight > 0 ? "PASS" : "NOT_APPLICABLE";
	return { kind: "overall", repo: "fleet", mission: "all", status, weighted_score: weightedScore, metrics };
}
export function scorePlanningFleet(rows: readonly MissionScore[], tuning: PlanningScoreTuning): MissionScore {
	return aggregateScores(rows, tuning);
}

function usageFailure(message: string): PresentationResult {
	return { code: 2, data: { kind: "overall", status: "FAIL", weighted_score: 0, metrics: {}, text: message }, jsonl: [{ kind: "overall", status: "FAIL", weighted_score: 0, metrics: {} }],
		errors: [{ code: "INVALID_FLAGS", message, remediation: "Choose either --repo PATH or --fleet." }], verification: "NOT_RUN" };
}
function unavailable(message: string, remediation: string): PresentationResult {
	const row = { kind: "overall", status: "UNKNOWN", weighted_score: null, metrics: {} };
	return { code: 3, data: { ...row, text: message }, jsonl: [row], errors: [{ code: "PLANNING_SCORE_UNAVAILABLE", message, remediation }], verification: "UNVERIFIED" };
}
type ParsedGitCommit = Omit<PlanningCommit, "changedPaths"> & { changedPaths: string[] };
function parseGitLogHeader(line: string): ParsedGitCommit | null | undefined {
	const first = line.indexOf("\x1f");
	if (first < 0) return undefined;
	const second = line.indexOf("\x1f", first + 1);
	if (second < 0) return null;
	const timestamp = Number(line.slice(first + 1, second));
	if (!Number.isFinite(timestamp)) return null;
	return { sha: line.slice(0, first), timestamp, subject: line.slice(second + 1), changedPaths: [] };
}
function readGitLog(root: string): PlanningCommit[] | null {
	const output = gitText(root, ["log", "--format=%H%x1f%ct%x1f%s", "--name-only"]);
	if (output === null) return null;
	const commits: PlanningCommit[] = [];
	let current: ParsedGitCommit | null = null;
	for (const line of output.split("\n")) {
		if (!line) continue;
		const header = parseGitLogHeader(line);
		if (header === null) return null;
		if (header !== undefined) {
			if (current) commits.push(current);
			current = header;
		} else if (current) current.changedPaths.push(line);
	}
	if (current) commits.push(current);
	return commits.sort((left, right) => left.timestamp - right.timestamp || left.sha.localeCompare(right.sha));
}
function readIssues(root: string): PlanningBead[] | null {
	const path = join(root, ".beads", "issues.jsonl");
	if (safePathStat(path) !== "file") return null;
	const text = safeRead(path, MAX_TRACKER_BYTES);
	return text === null ? null : parseIssues(text);
}
function readIssuesAtCommit(root: string, sha: string): PlanningBead[] | null {
	const text = gitText(root, ["show", sha + ":.beads/issues.jsonl"]);
	return text === null ? null : parseIssues(text);
}
function parseIssues(text: string): PlanningBead[] | null {
	const rows: PlanningBead[] = [];
	try {
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const value: unknown = JSON.parse(line);
			if (!record(value)) return null;
			rows.push(value);
		}
	} catch { return null; }
	return rows;
}
function attachLastPlanDiff(repo: string, mission: string, planPath: string | null, commits: readonly PlanningCommit[]): PlanningCommit[] {
	const reviews = commits.filter((commit) => { const tag = parseTag(commit.subject, "plan"); return planPath !== null && tag?.mission === mission && tag.action.startsWith("review round ") && positiveRound(tag.action.slice("review round ".length)); });
	const last = [...reviews].sort((left, right) => left.timestamp - right.timestamp).at(-1);
	if (!last || !planPath) return [...commits];
	const ratio = planDiffRatio(repo, last.sha, planPath);
	return commits.map((commit) => commit.sha === last.sha ? { ...commit, planDiffRatio: ratio } : commit);
}
function planDiffRatio(repo: string, sha: string, planPath: string): number | null {
	const parent = gitText(repo, ["rev-parse", "--verify", "--end-of-options", sha + "^"] )?.trim();
	if (!parent) return null;
	const stat = gitText(repo, ["diff", "--numstat", parent, sha, "--", planPath]);
	if (stat === null) return null;
	const line = stat.split("\n").find((row) => row.includes("\t"));
	if (!line) return null;
	const parts = line.split("\t");
	const added = Number(parts[0]), deleted = Number(parts[1]);
	if (!Number.isFinite(added) || !Number.isFinite(deleted)) return null;
	const oldText = gitText(repo, ["show", parent + ":" + planPath]);
	const newText = gitText(repo, ["show", sha + ":" + planPath]);
	if (oldText === null || newText === null) return null;
	const oldLines = lineCount(oldText), newLines = lineCount(newText), total = oldLines + newLines;
	return total > 0 ? (added + deleted) / total : null;
}
function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
function parseMissionSubject(subject: string): TaggedSubject | null {
	return parseTag(subject, "plan") ?? parseTag(subject, "beads");
}
function discoverMissions(repoCommits: readonly PlanningCommit[], trackerCommits: readonly PlanningCommit[], config: Record<string, unknown>): string[] {
	const names = new Set<string>();
	for (const commit of [...repoCommits, ...trackerCommits]) {
		const tag = parseMissionSubject(commit.subject);
		if (tag) names.add(tag.mission);
	}
	const missions = record(config.missions) ? config.missions : {};
	for (const name of Object.keys(missions)) if (safeMission(name)) names.add(name);
	return [...names].sort();
}
function safeMission(name: string): boolean { return Boolean(name.trim()) && !name.includes("/") && !name.includes("\\") && !name.includes(".."); }
function resolvePlanPath(repo: string, mission: string, configured: string | null, home: string): string | null {
	if (!configured) return null;
	const expanded = configured.split("{mission}").join(mission);
	const absolute = expandPath(expanded, home, repo);
	const result = relative(repo, absolute);
	if (!result || result === ".") return result || null;
	if (result === ".." || result.startsWith(".." + sep) || isAbsolute(result)) return null;
	return result;
}
function selectFleet(raw: Record<string, unknown>, home: string, kitRoot: string): FleetRepo[] | null {
	const fleet = record(raw.fleet) ? raw.fleet : null;
	if (!fleet || !Array.isArray(fleet.repos)) return null;
	const entries: FleetRepo[] = [];
	for (const item of fleet.repos) {
		if (typeof item === "string") entries.push({ name: basename(expandPath(item, home, kitRoot)), path: item });
		else if (record(item) && typeof item.name === "string" && typeof item.path === "string") entries.push({ name: item.name, path: item.path, ...(typeof item.tracker === "string" ? { tracker: item.tracker } : {}) });
		else return null;
	}
	return entries;
}
function expandPath(path: string, home: string, base: string): string {
	if (path === "~") return home || path;
	if (path.startsWith("~/")) return resolve(home, path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(base, path);
}
function runGitCommand(root: string, args: readonly string[]): string | null { return gitText(root, args); }
function collectCiEvidence(repo: string, home: string, raw: Record<string, unknown>): PlanningCiEvidence {
	const mode = stringValue(raw.mode) ?? "hosted";
	return mode === "local" ? collectLocalCiEvidence(repo, home, raw) : collectHostedCiEvidence(repo, mode, raw);
}
function collectLocalCiEvidence(repo: string, home: string, raw: Record<string, unknown>): PlanningCiEvidence {
	const check = stringValue(raw.check)?.trim();
	const branch = stringValue(raw.branch)?.trim();
	const receiptPath = stringValue(raw.receipts)?.trim();
	if (!check || !branch || !receiptPath) {
		const reason = !check ? "local CI requires a check command" : !branch ? "local CI requires a branch" : "local CI requires a receipts directory";
		return { mode: "local", ...(check ? { check } : {}), configurationError: reason, branchHeadSha: null, localReceipts: [] };
	}
	const branchHeadSha = branch.startsWith("-") ? null : runGitCommand(repo, ["rev-parse", "--verify", "--end-of-options", branch + "^{commit}"])?.trim() ?? null;
	return { mode: "local", check, branchHeadSha, localReceipts: readLocalReceipts(expandPath(receiptPath, home, repo)) };
}
function collectHostedCiEvidence(repo: string, mode: string, raw: Record<string, unknown>): PlanningCiEvidence {
	const branch = stringValue(raw.branch) ?? "main";
	if (mode !== "hosted" || branch.startsWith("-")) return { mode, ghConclusion: null };
	try {
		const result = spawnSync("gh", ["run", "list", "--branch", branch, "--limit", "1", "--json", "conclusion"], { cwd: repo, encoding: "utf8", timeout: 15_000, maxBuffer: 2 * 1_048_576 });
		if (result.error || result.status !== 0) return { mode, ghConclusion: null };
		const parsed: unknown = JSON.parse(result.stdout ?? "[]");
		if (!Array.isArray(parsed) || !parsed.length || !record(parsed[0])) return { mode, ghConclusion: null };
		return { mode, ghConclusion: stringValue(parsed[0].conclusion) };
	} catch { return { mode, ghConclusion: null }; }
}
function appendReceiptLine(line: string, receipts: LocalCheckReceipt[]): void {
	if (!line.trim()) return;
	try { const value: unknown = JSON.parse(line); if (record(value)) receipts.push(value); } catch { /* Invalid receipts never establish green. */ }
}
function appendReceiptFile(path: string, jsonl: boolean, receipts: LocalCheckReceipt[]): void {
	const text = safeRead(path, MAX_RECEIPT_BYTES);
	if (text === null) return;
	for (const line of jsonl ? text.split("\n") : [text]) appendReceiptLine(line, receipts);
}
function readLocalReceipts(path: string): LocalCheckReceipt[] {
	if (safePathStat(path) !== "directory") return [];
	const receipts: LocalCheckReceipt[] = [];
	for (const name of readdirSync(path).sort()) {
		if (!name.endsWith(".json") && !name.endsWith(".jsonl")) continue;
		appendReceiptFile(join(path, name), name.endsWith(".jsonl"), receipts);
	}
	return receipts;
}
function parseTomlFile(path: string, optional: boolean): Record<string, unknown> | null {
	let stat;
	try { stat = lstatSync(path); }
	catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("Cannot read planning-score config: " + path); }
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOML_BYTES) throw new Error("Unsafe or oversized planning-score config: " + path);
	const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
	if (!record(parsed)) throw new Error("Planning-score config must be a TOML table: " + path);
	return parsed;
}
function mergeTable(base: unknown, override: unknown): Record<string, unknown> {
	return { ...(record(base) ? base : {}), ...(record(override) ? override : {}) };
}
function mergeRepoConfig(base: Record<string, unknown>, override: Record<string, unknown> | null): Record<string, unknown> {
	if (!override) return base;
	const merged = { ...base };
	for (const key of ["targets", "weights", "plan", "ci"]) merged[key] = mergeTable(base[key], override[key]);
	const baseMissions = record(base.missions) ? base.missions : {};
	const overrideMissions = record(override.missions) ? override.missions : {};
	const missions: Record<string, unknown> = { ...baseMissions };
	for (const [name, value] of Object.entries(overrideMissions)) missions[name] = mergeTable(baseMissions[name], value);
	merged.missions = missions;
	return merged;
}
function loadOverride(repo: string): Record<string, unknown> | null {
	const path = join(repo, ".omp", "planning-score.toml");
	return safePathStat(path) === "missing" ? null : parseTomlFile(path, false);
}
function validateTuning(raw: Record<string, unknown>): PlanningScoreTuning | null {
	const targets = record(raw.targets) ? raw.targets : null;
	const weights = record(raw.weights) ? raw.weights : null;
	if (!targets || !weights) return null;
	const requiredTargets = ["plan_rounds", "plan_last_diff", "converted_once", "coverage_checks", "polish_rounds", "polish_last_changed", "bead_self_contained_median_chars", "bead_self_contained_test_share", "bead_self_contained_deps_per_bead", "plan_to_code_hours", "plan_ship_ratio_7d"];
	for (const key of requiredTargets) if (numberValue(targets[key]) === null) return null;
	if (typeof targets.plan_present !== "boolean" || typeof targets.main_green !== "boolean") return null;
	for (const name of SCORE_METRIC_NAMES) if (numberValue(weights[name]) === null || numberValue(weights[name])! <= 0) return null;
	return { targets: targets as Record<string, number | boolean>, weights: weights as Record<string, number> };
}
function readFleetConfig(kitRoot: string, home: string): { raw: Record<string, unknown>; tuning: PlanningScoreTuning; fleet: FleetRepo[]; planDefault: string } | null {
	const raw = parseTomlFile(join(kitRoot, "config", "planning-score.toml"), false);
	if (!raw) return null;
	const tuning = validateTuning(raw);
	const fleet = selectFleet(raw, home, kitRoot);
	const plan = record(raw.plan) ? raw.plan : null;
	const planDefault = plan ? stringValue(plan.default) : null;
	if (!tuning || !fleet || !planDefault) return null;
	return { raw, tuning, fleet, planDefault };
}
function parseConfigError(root: string, home: string): LoadedConfig {
	const loaded = readFleetConfig(root, home);
	if (!loaded) throw new Error("Default planning-score config is invalid or unreadable");
	return loaded;
}
export function loadPlanningScoreConfig(kitRoot: string, repoPath: string, home = process.env.HOME ?? ""): LoadedConfig {
	const base = readFleetConfig(resolve(kitRoot), home);
	if (!base) throw new Error("Default planning-score config is invalid or unreadable");
	const raw = mergeRepoConfig(base.raw, loadOverride(resolve(repoPath)));
	const tuning = validateTuning(raw);
	if (!tuning) throw new Error("Repository planning-score config is invalid");
	const plan = record(raw.plan) ? raw.plan : {};
	return { raw, tuning, fleet: base.fleet, planDefault: stringValue(plan.default) ?? base.planDefault };
}
