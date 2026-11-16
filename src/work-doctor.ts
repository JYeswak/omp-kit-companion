import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { auditStaleReservedEdits, DEFAULT_RESERVATION_LIMIT_MINUTES, type StaleReservedEdit } from "./reservation-age.ts";
import type { ModelLedgerEvent, WorkingModelEvidence } from "./model-ledger.ts";
import type { ModelActivityInspection, ActivityWindow } from "./model-activity.ts";
import type { ActivityModel } from "./model-activity-schema.ts";
import type { VerifyLedgerInspection, VerifyProjectedAttempt } from "./verify-ledger.ts";
import { inspectModelWorkUsage, MODEL_USAGE_MAX_FILES, type ModelSessionSource, type ModelWorkUsageInspection, type ModelWorkUsageRow } from "./model-work-usage.ts";

export type WorkRootStatus = "OK" | "UNAVAILABLE";
export type WorkRepoStatus = "OK" | "WARN" | "UNVERIFIED" | "TIMED_OUT" | "UNKNOWN";

export interface WorkDoctorInput { roots: readonly string[]; concurrency?: number; perRepoTimeoutMs?: number; staleEditLimitMinutes?: number; nowMs?: number; strandedOnly?: boolean; }
export interface WorkRootReport { path: string; status: WorkRootStatus; repo_count: number; reason?: string; discovery?: { max_depth: number; ignored_directory_names: string[]; skipped_depth_directories: number; skipped_symlink_directories: number; skipped_ignored_directories: number }; }
export interface WorkRepoReport {
	name: string; path: string; status: WorkRepoStatus; dirty_file_count: number | null; tracked_dirty_file_count: number | null; untracked_file_count: number | null; untracked_file_cap: number; untracked_scan_status: "OK" | "CAP" | "TIMEOUT" | "ERROR" | "UNKNOWN"; commits_ahead: number | null; commits_behind: number | null;
	unpushed_commits: number | null; has_upstream: boolean | null; has_remote: boolean | null; no_upstream: boolean | null; no_remote: boolean | null; stash_count: number | null;
	detached: boolean | null; branch: string | null; last_commit_epoch: number | null; last_commit_age_days: number | null; active_worktrees: number | null;
	worktree_paths: string[] | null; reservation_scan_status: "OK" | "PARTIAL" | "UNAVAILABLE" | "UNCONFIGURED" | "UNKNOWN"; stale_uncommitted_edits: StaleReservedEdit[] | null; reservation_scan_reason?: string; risk_score: number | null; findings: string[]; stranded: boolean; conditions: string[]; reason?: string;
}
export interface WorkDoctorReport {
	scope: "work"; overall: "REPORT"; roots: WorkRootReport[]; repos: WorkRepoReport[]; concurrency: number; per_repo_timeout_ms: number; stale_edit_limit_minutes: number;
	elapsed_ms: number; timed_out_repos: number; text: string;
}
interface GitResult { code: number | null; stdout: string; stderr: string; timed_out: boolean; }
const DEFAULT_CONCURRENCY = 4;
// Darwin Git status: isolated fixture/real checkout 17/22 ms at load 20.63;
// during three concurrent heavy suites at load 39.92, maxima were 119/1512 ms.
// Round twice the measured loaded maximum up to whole seconds for headroom.
const DEFAULT_REPO_TIMEOUT_MS = 4_000;
const UNTRACKED_FILE_CAP = 1_000;
const DISCOVERY_MAX_DEPTH = 10;

function hasGitConfig(repo: string): boolean {
	try {
		const dotGit = join(repo, ".git");
		const dotGitStat = lstatSync(dotGit);
		if (!dotGitStat.isDirectory()) return false;
		const commonDirFile = join(dotGit, "commondir");
		const commonDir = existsSync(commonDirFile) ? resolve(dotGit, readFileSync(commonDirFile, "utf8").trim()) : dotGit;
		return existsSync(join(commonDir, "config"));
	} catch { return false; }
}

export function resolveWorkRoots(rootFlag: string | undefined, env: Record<string, string | undefined> = process.env): string[] {
	const home = env.HOME;
	const configured = rootFlag ?? env.OMP_KIT_WORK_ROOTS ?? (home ? join(home, "Developer") : "");
	return [...new Set(configured.split(delimiter).filter(Boolean).map((path) => resolve(path)))];
}

async function runGit(repo: string, args: readonly string[], timeoutMs: number): Promise<GitResult> {
	const started = performance.now();
	try {
		const child = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
		const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { code, stdout, stderr, timed_out: performance.now() - started >= timeoutMs && code !== 0 };
	} catch (error) {
		return { code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timed_out: performance.now() - started >= timeoutMs };
	}
}
function lines(value: string): string[] { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function parseInteger(value: string): number | null { const parsed = Number.parseInt(value.trim(), 10); return Number.isFinite(parsed) ? parsed : null; }
function parseUntracked(result: GitResult): { count: number | null; status: "OK" | "CAP" | "TIMEOUT" | "ERROR" } {
	if (result.timed_out) return { count: null, status: "TIMEOUT" };
	if (result.code !== 0) return { count: null, status: "ERROR" };
	const count = result.stdout.split("\0").filter(Boolean).length;
	return count > UNTRACKED_FILE_CAP ? { count: UNTRACKED_FILE_CAP, status: "CAP" } : { count, status: "OK" };
}

function staleEditLimit(input: WorkDoctorInput): number {
	const raw = input.staleEditLimitMinutes ?? process.env.OMP_KIT_WORK_STALE_EDIT_MINUTES;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : DEFAULT_RESERVATION_LIMIT_MINUTES;
}

function agentMailStorageRoot(repo: string, configured: string, env: Record<string, string | undefined> = process.env): string | null {
	const raw = configured.trim() || env.AGENT_MAIL_STORAGE_ROOT?.trim() || env.STORAGE_ROOT?.trim() || "";
	if (!raw) return null;
	const home = env.HOME ?? "";
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	return resolve(repo, expanded);
}

function dirtyFileMetadata(repo: string, paths: readonly string[]): Array<{ path: string; modifiedMs: number }> {
	const files: Array<{ path: string; modifiedMs: number }> = [];
	for (const path of new Set(paths)) {
		const absolute = resolve(repo, path);
		const relativePath = relative(repo, absolute).replaceAll("\\", "/");
		if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) continue;
		try {
			const stat = lstatSync(absolute);
			if (stat.isFile() || stat.isSymbolicLink()) files.push({ path: relativePath, modifiedMs: stat.mtimeMs });
		} catch { /* Removed paths have no current mtime to report. */ }
	}
	return files;
}
interface ReservationScan { status: WorkRepoReport["reservation_scan_status"]; stale: StaleReservedEdit[]; timed_out: boolean; reason?: string; }

async function scanReservedEdits(repo: string, dirtyFiles: number, untracked: GitResult, untrackedResult: ReturnType<typeof parseUntracked>, limitMinutes: number, nowMs: number, timeoutMs: number): Promise<ReservationScan> {
	if (dirtyFiles === 0) return { status: "UNCONFIGURED", stale: [], timed_out: false };
	const storageConfig = await runGit(repo, ["config", "--local", "--get", "omp-kit.agent-mail-storage-root"], timeoutMs);
	if (storageConfig.timed_out) return { status: "UNKNOWN", stale: [], timed_out: true, reason: "Agent Mail storage configuration timed out" };
	const storageLookupFailed = storageConfig.code !== 0 && storageConfig.code !== 1;
	const storageRoot = agentMailStorageRoot(repo, storageConfig.code === 0 ? storageConfig.stdout : "");
	if (storageLookupFailed && !storageRoot) return { status: "UNAVAILABLE", stale: [], timed_out: false, reason: "Agent Mail storage configuration could not be read" };
	if (!storageRoot) return { status: "UNCONFIGURED", stale: [], timed_out: false, reason: "Agent Mail storage root is not configured" };
	const trackedChanges = await runGit(repo, ["diff", "--name-only", "--no-ext-diff", "-z", "HEAD"], timeoutMs);
	if (trackedChanges.timed_out) return { status: "UNKNOWN", stale: [], timed_out: true, reason: "Git tracked dirty-path scan timed out" };
	const trackedPaths = trackedChanges.code === 0 ? trackedChanges.stdout.split("\0").filter(Boolean) : [];
	const untrackedPaths = untrackedResult.status === "OK" ? untracked.stdout.split("\0").filter(Boolean) : [];
	const dirtyFileMtimes = dirtyFileMetadata(repo, [...trackedPaths, ...untrackedPaths]);
	const audit = auditStaleReservedEdits({ archiveRoot: storageRoot, projectKey: repo, dirtyFiles: dirtyFileMtimes, limitMinutes, nowMs });
	const status = trackedChanges.code !== 0 || untrackedResult.status !== "OK" ? "PARTIAL" : audit.status;
	return { status, stale: audit.stale, timed_out: false, ...(status === "OK" ? {} : { reason: "Agent Mail reservation scan " + status.toLowerCase() }) };
}

function timedOutRepo(repo: string, sources: readonly string[], timeoutMs: number, detail?: string): WorkRepoReport {
	const reason = detail ?? `Git ${sources.join(", ")} timed out after ${timeoutMs} ms`;
	return {
		name: basename(repo), path: repo, status: "TIMED_OUT", dirty_file_count: null, tracked_dirty_file_count: null,
		untracked_file_count: null, untracked_file_cap: UNTRACKED_FILE_CAP, untracked_scan_status: "UNKNOWN",
		commits_ahead: null, commits_behind: null, unpushed_commits: null, has_upstream: null, has_remote: null, no_upstream: null, no_remote: null, stash_count: null,
		detached: null, branch: null, last_commit_epoch: null, last_commit_age_days: null, active_worktrees: null, worktree_paths: null,
		reservation_scan_status: "UNKNOWN", stale_uncommitted_edits: null, reservation_scan_reason: reason, risk_score: null,
		findings: ["unverified", sources.includes("status") ? "status_timed_out" : "git_probe_timed_out"], stranded: true, conditions: ["unverified"], reason,
	};
}
interface GitMetadata { hasRemote: boolean; stashCount: number; worktreePaths: string[]; readable: boolean; }
function gitMetadata(repo: string): GitMetadata {
	try {
		const dotGit = join(repo, ".git");
		const dotGitStat = lstatSync(dotGit);
		const gitDir = dotGitStat.isDirectory() ? dotGit : resolve(join(repo, readFileSync(dotGit, "utf8").trim().replace(/^gitdir:\s*/, "")));
		const commonDirFile = join(gitDir, "commondir");
		const commonDir = existsSync(commonDirFile) ? resolve(gitDir, readFileSync(commonDirFile, "utf8").trim()) : gitDir;
		const config = readFileSync(join(commonDir, "config"), "utf8");
		const hasRemote = /^\[remote "[^"\n]+"\]/m.test(config);
		const stashLog = join(commonDir, "logs", "refs", "stash");
		const stashCount = existsSync(stashLog) ? lines(readFileSync(stashLog, "utf8")).length : 0;
		const mainPath = dirname(commonDir);
		const worktreeRoot = join(commonDir, "worktrees");
		const worktreePaths = [mainPath];
		if (existsSync(worktreeRoot)) {
			for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const pathFile = join(worktreeRoot, entry.name, "gitdir");
				if (existsSync(pathFile)) {
					const worktreeGitDir = readFileSync(pathFile, "utf8").trim();
					if (worktreeGitDir) worktreePaths.push(dirname(worktreeGitDir));
				}
			}
		}
		return { hasRemote, stashCount, worktreePaths: [...new Set(worktreePaths)], readable: true };
	} catch {
		return { hasRemote: false, stashCount: 0, worktreePaths: [repo], readable: false };
	}
}

function unreadableRepo(repo: string): WorkRepoReport {
	const reason = "git metadata is unreadable (.git config cannot be read); repository state is indeterminate";
	return {
		name: basename(repo), path: repo, status: "UNKNOWN", dirty_file_count: null, tracked_dirty_file_count: null,
		untracked_file_count: null, untracked_file_cap: UNTRACKED_FILE_CAP, untracked_scan_status: "UNKNOWN",
		commits_ahead: null, commits_behind: null, unpushed_commits: null, has_upstream: null, has_remote: null, no_upstream: null, no_remote: null, stash_count: null,
		detached: null, branch: null, last_commit_epoch: null, last_commit_age_days: null, active_worktrees: null, worktree_paths: null,
		reservation_scan_status: "UNKNOWN", stale_uncommitted_edits: null, reservation_scan_reason: reason, risk_score: null,
		findings: ["unreadable", "unverified"], stranded: true, conditions: ["unreadable"], reason,
	};
}

 async function inspectRepo(repo: string, timeoutMs: number, staleEditLimitMinutes: number, nowMs: number): Promise<WorkRepoReport> {
 	const metadata = gitMetadata(repo);
	if (!metadata.readable) return unreadableRepo(repo);
	const [status, lastCommit, untracked] = await Promise.all([
		runGit(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"], timeoutMs),
		runGit(repo, ["log", "-1", "--format=%ct"], timeoutMs),
		runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs),
	]);
	const initialTimeouts = [status.timed_out ? "status" : null, lastCommit.timed_out ? "log" : null, untracked.timed_out ? "untracked" : null].filter((source): source is string => source !== null);
	if (initialTimeouts.length) return timedOutRepo(repo, initialTimeouts, timeoutMs);
	const statusLines = lines(status.stdout);
	const branchHead = statusLines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length).trim() ?? null;
	const upstreamName = statusLines.find((line) => line.startsWith("# branch.upstream "))?.slice("# branch.upstream ".length).trim() ?? null;
	const upstreamCount = upstreamName ? await runGit(repo, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], timeoutMs) : null;
	const localCount = upstreamName ? null : await runGit(repo, ["rev-list", "--count", "HEAD"], timeoutMs);
	const countTimeouts = [upstreamCount?.timed_out ? "upstream-count" : null, localCount?.timed_out ? "local-count" : null].filter((source): source is string => source !== null);
	if (countTimeouts.length) return timedOutRepo(repo, countTimeouts, timeoutMs);
	const aheadBehind = upstreamCount?.code === 0 ? upstreamCount.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
	const behind = aheadBehind ? Number.parseInt(aheadBehind[1]!, 10) : null;
	const ahead = aheadBehind ? Number.parseInt(aheadBehind[2]!, 10) : null;
	const coreResults = [status, lastCommit, ...(upstreamCount ? [upstreamCount] : []), ...(localCount ? [localCount] : [])];
	const errors = coreResults.filter((result) => result.code !== 0 && result.code !== 1);
	const coreIncomplete = errors.length > 0 || !metadata.readable;
	const trackedDirtyFiles = statusLines.filter((line) => !line.startsWith("#")).length;
	const untrackedResult = parseUntracked(untracked);
	const dirtyFiles = trackedDirtyFiles + (untrackedResult.count ?? 0);
	const reservationScan = await scanReservedEdits(repo, dirtyFiles, untracked, untrackedResult, staleEditLimitMinutes, nowMs, timeoutMs);
	if (reservationScan.timed_out) return timedOutRepo(repo, ["reservation scan"], timeoutMs, reservationScan.reason);
	const reservationScanStatus = reservationScan.status;
	const staleUncommittedEdits = reservationScan.stale;
	const reservationScanReason = reservationScan.reason;
	const lastEpoch = lastCommit.code === 0 ? parseInteger(lastCommit.stdout) : null;
	const ageDays = lastEpoch === null ? null : Math.max(0, (Date.now() / 1000 - lastEpoch) / 86_400);
	const unpushed = ahead ?? (localCount?.code === 0 ? parseInteger(localCount.stdout) ?? 0 : 0);
	const findings: string[] = [];
	const conditions: string[] = [];
	if (dirtyFiles) { findings.push("dirty"); conditions.push("dirty"); }
	if (unpushed > 0) { findings.push("unpushed"); conditions.push("unpushed"); }
	if (!upstreamName) findings.push("no_upstream");
	if (!upstreamName && metadata.hasRemote) { findings.push("branch_absent_remotely"); conditions.push("branch_absent_remotely"); }
	if (!metadata.hasRemote) { findings.push("no_remote"); conditions.push("no_remote"); }
	if (metadata.stashCount) { findings.push("stashes"); conditions.push("stashes"); }
	if (metadata.worktreePaths.length > 1) { findings.push("linked_worktrees"); conditions.push("linked_worktrees"); }
	if (untrackedResult.status !== "OK") findings.push("untracked_unverified");
	const detached = branchHead === null || branchHead === "(detached)";
	if (detached) findings.push("detached");
	if (coreIncomplete) findings.push("unverified");
	if (staleUncommittedEdits.length) findings.push("stale_uncommitted_edits");
	if (dirtyFiles && reservationScanStatus !== "OK") findings.push("reservation_unverified");
	const stranded = conditions.length > 0;
	const riskScore = unpushed * Math.max(1, ageDays ?? 0);
	return {
		name: basename(repo), path: repo, status: findings.includes("unverified") || findings.includes("reservation_unverified") ? "UNVERIFIED" : findings.length ? "WARN" : "OK", dirty_file_count: dirtyFiles,
		tracked_dirty_file_count: trackedDirtyFiles, untracked_file_count: untrackedResult.count, untracked_file_cap: UNTRACKED_FILE_CAP, untracked_scan_status: untrackedResult.status,
		commits_ahead: ahead, commits_behind: behind, unpushed_commits: unpushed, has_upstream: Boolean(upstreamName), has_remote: metadata.hasRemote,
		no_upstream: !upstreamName, no_remote: !metadata.hasRemote, stash_count: metadata.stashCount, detached, branch: detached ? null : branchHead,
		last_commit_epoch: lastEpoch, last_commit_age_days: ageDays, active_worktrees: metadata.worktreePaths.length, worktree_paths: metadata.worktreePaths, risk_score: riskScore, findings, stranded, conditions,
		reservation_scan_status: reservationScanStatus, stale_uncommitted_edits: staleUncommittedEdits,
		...(reservationScanReason ? { reservation_scan_reason: reservationScanReason } : {}),
		...(coreIncomplete || untrackedResult.status !== "OK" || reservationScanReason ? { reason: [...errors.map((error) => error.stderr).filter(Boolean), ...(untrackedResult.status !== "OK" ? ["untracked scan " + untrackedResult.status] : []), ...(reservationScanReason ? [reservationScanReason] : [])].join("; ") || "git inspection incomplete" } : {}),
	};
}
function discover(root: string): { root: WorkRootReport; repos: string[] } {
	if (!isAbsolute(root) || !existsSync(root) || !lstatSync(root).isDirectory()) return { root: { path: root, status: "UNAVAILABLE", repo_count: 0, reason: "root is missing or not a directory" }, repos: [] };
	const ignored = new Set([".git", "node_modules", "target", "dist", "build", ".cache", "__pycache__"]);
	const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]; const repos: string[] = [];
	let skippedDepth = 0, skippedSymlinks = 0, skippedIgnored = 0;
	while (pending.length && repos.length < 5_000) {
		const current = pending.pop()!; let entries;
		try { entries = readdirSync(current.path, { withFileTypes: true }); } catch { continue; }
		const gitEntry = entries.find((entry) => entry.name === ".git");
		if (gitEntry) { if (gitEntry.isDirectory() && hasGitConfig(current.path)) repos.push(current.path); continue; }
		const names = new Set(entries.map((entry) => entry.name));
		if (names.has("HEAD") && names.has("objects") && names.has("refs")) continue;
		if (current.depth >= DISCOVERY_MAX_DEPTH) { skippedDepth += 1; continue; }
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.isSymbolicLink()) { skippedSymlinks += 1; continue; }
			if (ignored.has(entry.name)) { skippedIgnored += 1; continue; }
			pending.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
		}
	}
	repos.sort();
	return { root: { path: root, status: "OK", repo_count: repos.length, discovery: { max_depth: DISCOVERY_MAX_DEPTH, ignored_directory_names: [...ignored].filter((name) => name !== ".git"), skipped_depth_directories: skippedDepth, skipped_symlink_directories: skippedSymlinks, skipped_ignored_directories: skippedIgnored } }, repos };
}
function renderTable(repos: readonly WorkRepoReport[]): string {
	const rows = ["RISK  DIRTY STALE AHEAD UNPUSHED STASH DETACHED STATUS       REPOSITORY"];
	for (const repo of repos) {
		const staleCount = repo.stale_uncommitted_edits?.length ?? null;
		const staleCell = staleCount === null ? "UNKNOWN" : repo.reservation_scan_status === "OK" ? String(staleCount) : repo.dirty_file_count === null ? "UNKNOWN" : repo.dirty_file_count ? staleCount ? `${staleCount}+?` : "?" : "0";
		const riskCell = repo.risk_score === null ? "UNKNOWN" : repo.risk_score.toFixed(1);
		const dirtyCell = repo.dirty_file_count === null ? "UNKNOWN" : String(repo.dirty_file_count);
		const aheadCell = repo.status === "TIMED_OUT" ? "UNKNOWN" : String(repo.commits_ahead ?? "-");
		const unpushedCell = repo.unpushed_commits === null ? "UNKNOWN" : String(repo.unpushed_commits);
		const stashCell = repo.stash_count === null ? "UNKNOWN" : String(repo.stash_count);
		const detachedCell = repo.detached === null ? "UNKNOWN" : String(repo.detached);
		rows.push(`${riskCell.padStart(6)} ${dirtyCell.padStart(5)} ${staleCell.padStart(5)} ${aheadCell.padStart(5)} ${unpushedCell.padStart(7)} ${stashCell.padStart(5)} ${detachedCell.padStart(8)} ${repo.status.padEnd(12)} ${repo.path}`);
	}
	return rows.join("\n");
}

export async function inspectWorkFleet(input: WorkDoctorInput): Promise<WorkDoctorReport> {
	const started = performance.now(); const concurrency = Math.max(1, Math.min(64, Math.trunc(input.concurrency ?? DEFAULT_CONCURRENCY)));
	const perRepoTimeoutMs = Math.max(100, Math.min(60_000, Math.trunc(input.perRepoTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS)));
	const staleEditLimitMinutes = staleEditLimit(input);
	const nowMs = input.nowMs ?? Date.now();
	const discovered = input.roots.flatMap(discover); const allRepos = [...new Set(discovered.flatMap((entry) => entry.repos))]; const repos: WorkRepoReport[] = []; let cursor = 0;
	async function worker(): Promise<void> { while (cursor < allRepos.length) { const index = cursor++; repos[index] = await inspectRepo(allRepos[index]!, perRepoTimeoutMs, staleEditLimitMinutes, nowMs); } }
	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, allRepos.length)) }, () => worker()));
	const ordered = (input.strandedOnly ? repos.filter(Boolean).filter((entry) => entry.stranded) : repos.filter(Boolean)).sort((left, right) => {
		if (left.risk_score === null) return right.risk_score === null ? left.path.localeCompare(right.path) : 1;
		if (right.risk_score === null) return -1;
		return right.risk_score - left.risk_score || left.path.localeCompare(right.path);
	});
	const elapsedMs = performance.now() - started;
	return { scope: "work", overall: "REPORT", roots: discovered.map((entry) => entry.root), repos: ordered, concurrency, per_repo_timeout_ms: perRepoTimeoutMs, stale_edit_limit_minutes: staleEditLimitMinutes, elapsed_ms: elapsedMs, timed_out_repos: ordered.filter((repo) => repo.status === "TIMED_OUT" || repo.findings.includes("unverified")).length, text: renderTable(ordered) };
}

export interface ModelWeekEvidence {
	status: string;
	operations: Array<{ intent: ModelLedgerEvent; outcome: ModelLedgerEvent | null; integrity: "KNOWN" | "UNKNOWN" }>;
	activity: ModelActivityInspection;
	verification: VerifyLedgerInspection;
}
interface WeekCount { eligible: number; known: number; unknown: number; }
interface WeekModel {
	provider: string; model: string;
	authored: number; reviewer: number; first_eligible: number; first_known: number; first_pass: number;
	attempt_eligible: number; attempt_known: number; rework: number;
	close_operations: string[]; first_attempts: string[];
}
interface WeekModels { rows: Map<string, WeekModel>; truncated: boolean; }
export interface ModelWeekRow {
	provider: string; model: string;
	authored_verified_closes: number | null; reviewer_closes: number | null;
	active_hours: number | null; closes_per_active_hour: number | null;
	first_pass_pass_rate: number | null; rework: number | null;
	work_tokens: number | null; tokens_per_close: number | null;
	known_authored_verified_closes: number; known_reviewer_closes: number;
	denominators: { first_attempts: WeekCount; review_attempts: WeekCount };
	evidence: { close_operations: string[]; first_attempts: string[] };
}
export interface ModelWeekReport {
	status: "KNOWN" | "UNKNOWN";
	cohort: { start: string; end: string; closes_per_active_hour_numerator: string;
		closes: string; first_attempts: string; rework: string; work_tokens: string };
	counts: { closes: WeekCount; first_attempts: WeekCount; review_attempts: WeekCount;
		activity: WeekCount; usage: ModelWorkUsageInspection["counts"] };
	coverage: { attribution: string; verification: string; activity: string; usage: string };
	by_model: ModelWeekRow[];
	usage: ModelWorkUsageInspection;
	qualification: { proof_class: "DESCRIPTIVE_SOURCE_COHORT"; parent_week_live: "UNVERIFIED"; causal_staffing_effect: "UNVERIFIED" };
	limits: { max_models: number; models_truncated: boolean };
}
const MODEL_WEEK_MAX_MODELS = 256;

function weekModel(models: WeekModels, model: ActivityModel): WeekModel | null {
	const key = `${model.provider}\0${model.model}`;
	let row = models.rows.get(key);
	if (row !== undefined) return row;
	if (models.rows.size >= MODEL_WEEK_MAX_MODELS) { models.truncated = true; return null; }
	row = { provider: model.provider, model: model.model, authored: 0, reviewer: 0,
		first_eligible: 0, first_known: 0, first_pass: 0, attempt_eligible: 0, attempt_known: 0, rework: 0,
		close_operations: [], first_attempts: [] };
	models.rows.set(key, row);
	return row;
}

/** The same captured assistant/tool call, actor, tracker, bead and original claim
 * bind the close to a non-author verification. A second candidate is ambiguous,
 * not permission to choose the latest verdict or a nearby wall-clock timestamp. */
function verificationKey(tracker: string, bead: string, actor: string, claim: string | null | undefined, model: WorkingModelEvidence): string | null {
	if (!claim || model.status !== "KNOWN") return null;
	return `${tracker}\0${bead}\0${actor}\0${claim}\0${model.source.session_id}\0${model.source.tool_call_id}\0${model.source.entry_sha256}`;
}

function closedAttemptIndex(attempts: readonly VerifyProjectedAttempt[]): Map<string, VerifyProjectedAttempt | null> {
	const candidates = new Map<string, VerifyProjectedAttempt | null>();
	for (const attempt of attempts) {
		if (attempt.result_code !== "CLOSED" || attempt.outcome !== "PASS" || !attempt.replayed
			|| attempt.integrity !== "KNOWN" || attempt.coverage !== "KNOWN") continue;
		const { author, verifier, tracker, bead } = attempt.context;
		if (author.status !== "KNOWN" || author.attribution.status !== "KNOWN" || author.actor === verifier.actor) continue;
		const key = verificationKey(tracker, bead, verifier.actor, author.operation_id, verifier.attribution);
		if (key !== null) candidates.set(key, candidates.has(key) ? null : attempt);
	}
	return candidates;
}

function weekCloses(evidence: ModelWeekEvidence, window: ActivityWindow, models: WeekModels): WeekCount {
	const candidates = closedAttemptIndex(evidence.verification.attempts);
	const eligible = new Set<string>(), qualified = new Set<string>();
	for (const operation of evidence.operations) {
		const { intent, outcome } = operation;
		const at = Date.parse(outcome?.at ?? intent.at);
		if (intent.kind !== "close" || at < window.start_ms || at >= window.end_ms) continue;
		if (operation.integrity === "KNOWN" && outcome?.native_rc !== null && outcome?.native_rc !== 0) continue;
		for (const bead of intent.beads) {
			const beadKey = `${intent.tracker}\0${bead}`;
			eligible.add(beadKey);
			if (qualified.has(beadKey) || operation.integrity !== "KNOWN" || outcome?.native_rc !== 0 || outcome.native_timed_out) continue;
			const key = verificationKey(intent.tracker, bead, intent.actor, intent.claim_incarnations[bead], outcome.attribution);
			const attempt = key === null ? null : candidates.get(key);
			if (!attempt || attempt.context.author.attribution.status !== "KNOWN" || attempt.context.verifier.attribution.status !== "KNOWN") continue;
			const author = weekModel(models, attempt.context.author.attribution);
			const reviewer = weekModel(models, attempt.context.verifier.attribution);
			if (author === null || reviewer === null) continue;
			qualified.add(beadKey);
			author.authored++; reviewer.reviewer++;
			author.close_operations.push(intent.operation_id);
			if (reviewer !== author) reviewer.close_operations.push(intent.operation_id);
		}
	}
	return { eligible: eligible.size, known: qualified.size, unknown: eligible.size - qualified.size };
}

function weekFirstAttempts(evidence: ModelWeekEvidence, window: ActivityWindow, models: WeekModels): WeekCount {
	const counts: WeekCount = { eligible: 0, known: 0, unknown: 0 };
	for (const attempt of evidence.verification.first_attempts) {
		const at = Date.parse(attempt.began_at);
		if (at < window.start_ms || at >= window.end_ms) continue;
		counts.eligible++;
		const author = attempt.context.author;
		const row = author.status === "KNOWN" && author.attribution.status === "KNOWN" ? weekModel(models, author.attribution) : null;
		if (row === null) continue;
		row.first_eligible++; row.first_attempts.push(attempt.id);
		if (attempt.integrity !== "KNOWN" || attempt.coverage !== "KNOWN" || !attempt.replayed
			|| (attempt.outcome !== "PASS" && attempt.outcome !== "FAIL")) continue;
		counts.known++; row.first_known++;
		if (attempt.outcome === "PASS") row.first_pass++;
	}
	counts.unknown = counts.eligible - counts.known;
	return counts;
}

function weekReviewAttempts(evidence: ModelWeekEvidence, window: ActivityWindow, models: WeekModels): WeekCount {
	const counts: WeekCount = { eligible: 0, known: 0, unknown: 0 };
	for (const attempt of evidence.verification.attempts) {
		const at = Date.parse(attempt.finalized_at ?? attempt.began_at);
		if (at < window.start_ms || at >= window.end_ms) continue;
		counts.eligible++;
		const author = attempt.context.author;
		const row = author.status === "KNOWN" && author.attribution.status === "KNOWN" ? weekModel(models, author.attribution) : null;
		if (row === null) continue;
		row.attempt_eligible++;
		if (attempt.integrity !== "KNOWN" || attempt.coverage !== "KNOWN" || !attempt.replayed
			|| (attempt.outcome !== "PASS" && attempt.outcome !== "FAIL")) continue;
		counts.known++; row.attempt_known++;
		if (attempt.outcome === "FAIL") row.rework++;
	}
	counts.unknown = counts.eligible - counts.known;
	return counts;
}

function weekSessions(evidence: ModelWeekEvidence, window: ActivityWindow) {
	const sources = new Map<string, ModelSessionSource>();
	let complete = evidence.status === "KNOWN" && evidence.activity.status === "KNOWN"
		&& evidence.activity.session_sources_complete && evidence.verification.status === "KNOWN";
	function add(source: ModelSessionSource) {
		const key = `${source.session_id}\0${source.identity}`;
		if (sources.has(key)) return;
		if (sources.size >= MODEL_USAGE_MAX_FILES) { complete = false; return; }
		sources.set(key, source);
	}
	function attribution(model: WorkingModelEvidence) {
		if (model.status === "KNOWN") add(model.source);
		else complete = false;
	}
	for (const source of evidence.activity.session_sources) add(source);
	for (const operation of evidence.operations) {
		const at = Date.parse(operation.outcome?.at ?? operation.intent.at);
		if (at >= window.start_ms && at < window.end_ms) attribution(operation.outcome?.attribution ?? operation.intent.attribution);
	}
	for (const attempt of evidence.verification.attempts) {
		const begin = Date.parse(attempt.began_at), end = Date.parse(attempt.finalized_at ?? attempt.began_at);
		if (begin >= window.end_ms || end < window.start_ms) continue;
		attribution(attempt.context.author.attribution); attribution(attempt.context.verifier.attribution);
	}
	return { sources: [...sources.values()], complete };
}

function weekRows(evidence: ModelWeekEvidence, models: WeekModels, closes: WeekCount,
	verification: { first: WeekCount; attempts: WeekCount }, usage: ModelWorkUsageInspection): ModelWeekRow[] {
	const activity = new Map<string, number>(), tokens = new Map<string, ModelWorkUsageRow>();
	for (const row of evidence.activity.by_model) activity.set(`${row.provider}\0${row.model}`, row.known_active_ms);
	for (const row of usage.by_model) tokens.set(`${row.provider}\0${row.model}`, row);
	const closeComplete = evidence.status === "KNOWN" && evidence.verification.status === "KNOWN" && closes.eligible > 0 && closes.unknown === 0 && !models.truncated;
	return Array.from(models.rows.values(), row => {
		const key = `${row.provider}\0${row.model}`, clock = activity.get(key), work = tokens.get(key);
		let hours: number | null = null;
		if (evidence.activity.status === "KNOWN") {
			if (clock !== undefined) hours = clock / 3600_000;
			else if (evidence.activity.active_ms === 0) hours = 0;
		}
		const authored = closeComplete ? row.authored : null;
		const firstKnown = evidence.verification.status === "KNOWN" && verification.first.unknown === 0 && row.first_eligible > 0 && !models.truncated;
		const reworkKnown = evidence.verification.status === "KNOWN" && verification.attempts.unknown === 0 && row.attempt_eligible > 0 && !models.truncated;
		const workTokens = work?.work_tokens ?? null;
		return { provider: row.provider, model: row.model, authored_verified_closes: authored,
			reviewer_closes: closeComplete ? row.reviewer : null, active_hours: hours,
			closes_per_active_hour: authored !== null && hours !== null && hours > 0 ? authored / hours : null,
			first_pass_pass_rate: firstKnown ? 100 * row.first_pass / row.first_known : null,
			rework: reworkKnown ? row.rework : null, work_tokens: workTokens,
			tokens_per_close: authored !== null && authored > 0 && workTokens !== null ? workTokens / authored : null,
			known_authored_verified_closes: row.authored, known_reviewer_closes: row.reviewer,
			denominators: {
				first_attempts: { eligible: row.first_eligible, known: row.first_known, unknown: row.first_eligible - row.first_known },
				review_attempts: { eligible: row.attempt_eligible, known: row.attempt_known, unknown: row.attempt_eligible - row.attempt_known },
			}, evidence: { close_operations: row.close_operations, first_attempts: row.first_attempts } };
	}).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}

/** A read model of existing authorities, never a new ledger or a live/causal
 * staffing certificate. No clock, outcome, author, or token default is guessed. */
export function inspectModelWeek(evidence: ModelWeekEvidence, now: number): ModelWeekReport {
	const window = { start_ms: Math.max(0, now - 7 * 86_400_000), end_ms: now };
	const models: WeekModels = { rows: new Map(), truncated: false };
	const closes = weekCloses(evidence, window, models);
	const verification = { first: weekFirstAttempts(evidence, window, models), attempts: weekReviewAttempts(evidence, window, models) };
	const sessions = weekSessions(evidence, window);
	const usage = inspectModelWorkUsage(sessions.sources, window, sessions.complete);
	for (const model of evidence.activity.by_model) weekModel(models, model);
	for (const model of usage.by_model) weekModel(models, model);
	const known = evidence.status === "KNOWN" && evidence.verification.status === "KNOWN" && evidence.activity.status === "KNOWN"
		&& usage.status === "KNOWN" && closes.eligible > 0 && closes.unknown === 0 && verification.first.eligible > 0
		&& verification.first.unknown === 0 && verification.attempts.unknown === 0 && !models.truncated;
	return { status: known ? "KNOWN" : "UNKNOWN",
		cohort: { start: new Date(window.start_ms).toISOString(), end: new Date(window.end_ms).toISOString(),
			closes_per_active_hour_numerator: "authored_and_independently_verified_closes",
			closes: "At most one qualified captured non-author close per tracker/bead in this week; earliest qualifying original claim, never reviewer-as-author or retry credit",
			first_attempts: "Canonical immutable first begins in this week, attributed to their original author; PASS/(PASS+FAIL) percent only when all eligible outcomes are known; UNJUDGED/INCOMPLETE never PASS",
			rework: "Known failed verification attempts finalized in this week, attributed to their captured original author; not raw tracker-state churn",
			work_tokens: usage.definition },
		counts: { closes, first_attempts: verification.first, review_attempts: verification.attempts,
			activity: { eligible: evidence.activity.counts.observed_segments, known: evidence.activity.counts.valid_segments, unknown: evidence.activity.counts.unknown_segments },
			usage: usage.counts },
		coverage: { attribution: evidence.status, verification: evidence.verification.status, activity: evidence.activity.status, usage: usage.status },
		by_model: weekRows(evidence, models, closes, verification, usage), usage,
		qualification: { proof_class: "DESCRIPTIVE_SOURCE_COHORT", parent_week_live: "UNVERIFIED", causal_staffing_effect: "UNVERIFIED" },
		limits: { max_models: MODEL_WEEK_MAX_MODELS, models_truncated: models.truncated } };
}
