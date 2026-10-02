import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type WorkRootStatus = "OK" | "UNAVAILABLE";
export type WorkRepoStatus = "OK" | "WARN" | "UNVERIFIED";

export interface WorkDoctorInput { roots: readonly string[]; concurrency?: number; perRepoTimeoutMs?: number; }
export interface WorkRootReport { path: string; status: WorkRootStatus; repo_count: number; reason?: string; discovery?: { max_depth: number; ignored_directory_names: string[]; skipped_depth_directories: number; skipped_symlink_directories: number; skipped_ignored_directories: number }; }
export interface WorkRepoReport {
	name: string; path: string; status: WorkRepoStatus; dirty_file_count: number; tracked_dirty_file_count: number; untracked_file_count: number | null; untracked_file_cap: number; untracked_scan_status: "OK" | "CAP" | "TIMEOUT" | "ERROR"; commits_ahead: number | null; commits_behind: number | null;
	unpushed_commits: number; has_upstream: boolean; has_remote: boolean; no_upstream: boolean; no_remote: boolean; stash_count: number;
	detached: boolean; branch: string | null; last_commit_epoch: number | null; last_commit_age_days: number | null; active_worktrees: number;
	worktree_paths: string[]; risk_score: number; findings: string[]; reason?: string;
}
export interface WorkDoctorReport {
	scope: "work"; overall: "REPORT"; roots: WorkRootReport[]; repos: WorkRepoReport[]; concurrency: number; per_repo_timeout_ms: number;
	elapsed_ms: number; timed_out_repos: number; text: string;
}
interface GitResult { code: number | null; stdout: string; stderr: string; timed_out: boolean; }
const DEFAULT_CONCURRENCY = 64;
const DEFAULT_REPO_TIMEOUT_MS = 2_000;
const UNTRACKED_FILE_CAP = 1_000;
const DISCOVERY_MAX_DEPTH = 10;

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

async function inspectRepo(repo: string, timeoutMs: number): Promise<WorkRepoReport> {
	const metadata = gitMetadata(repo);
	const [status, lastCommit, untracked] = await Promise.all([
		runGit(repo, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"], timeoutMs),
		runGit(repo, ["log", "-1", "--format=%ct"], timeoutMs),
		runGit(repo, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs),
	]);
	const statusLines = lines(status.stdout);
	const branchHead = statusLines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length).trim() ?? null;
	const upstreamName = statusLines.find((line) => line.startsWith("# branch.upstream "))?.slice("# branch.upstream ".length).trim() ?? null;
	const upstreamCount = upstreamName ? await runGit(repo, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], timeoutMs) : null;
	const localCount = upstreamName ? null : await runGit(repo, ["rev-list", "--count", "HEAD"], timeoutMs);
	const aheadBehind = upstreamCount?.code === 0 ? upstreamCount.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
	const behind = aheadBehind ? Number.parseInt(aheadBehind[1]!, 10) : null;
	const ahead = aheadBehind ? Number.parseInt(aheadBehind[2]!, 10) : null;
	const coreResults = [status, lastCommit, ...(upstreamCount ? [upstreamCount] : []), ...(localCount ? [localCount] : [])];
	const errors = coreResults.filter((result) => result.code !== 0 && result.code !== 1);
	const timeoutSources = [status.timed_out ? "status" : null, lastCommit.timed_out ? "log" : null, upstreamCount?.timed_out ? "upstream-count" : null, localCount?.timed_out ? "local-count" : null].filter((source): source is string => source !== null);
	const coreIncomplete = errors.length > 0 || timeoutSources.length > 0 || !metadata.readable;
	const trackedDirtyFiles = statusLines.filter((line) => !line.startsWith("#")).length;
	const untrackedResult = parseUntracked(untracked);
	const dirtyFiles = trackedDirtyFiles + (untrackedResult.count ?? 0);
	const lastEpoch = lastCommit.code === 0 ? parseInteger(lastCommit.stdout) : null;
	const ageDays = lastEpoch === null ? null : Math.max(0, (Date.now() / 1000 - lastEpoch) / 86_400);
	const unpushed = ahead ?? (localCount?.code === 0 ? parseInteger(localCount.stdout) ?? 0 : 0);
	const findings: string[] = [];
	if (dirtyFiles) findings.push("dirty");
	if (unpushed > 0) findings.push("unpushed");
	if (!upstreamName) findings.push("no_upstream");
	if (!metadata.hasRemote) findings.push("no_remote");
	if (metadata.stashCount) findings.push("stashes");
	if (untrackedResult.status !== "OK") findings.push("untracked_unverified");
	const detached = branchHead === null || branchHead === "(detached)";
	if (detached) findings.push("detached");
	if (coreIncomplete) findings.push("unverified");
	const riskScore = unpushed * Math.max(1, ageDays ?? 0);
	return {
		name: basename(repo), path: repo, status: findings.includes("unverified") ? "UNVERIFIED" : findings.length ? "WARN" : "OK", dirty_file_count: dirtyFiles,
		tracked_dirty_file_count: trackedDirtyFiles, untracked_file_count: untrackedResult.count, untracked_file_cap: UNTRACKED_FILE_CAP, untracked_scan_status: untrackedResult.status,
		commits_ahead: ahead, commits_behind: behind, unpushed_commits: unpushed, has_upstream: Boolean(upstreamName), has_remote: metadata.hasRemote,
		no_upstream: !upstreamName, no_remote: !metadata.hasRemote, stash_count: metadata.stashCount, detached, branch: detached ? null : branchHead,
		last_commit_epoch: lastEpoch, last_commit_age_days: ageDays, active_worktrees: metadata.worktreePaths.length, worktree_paths: metadata.worktreePaths, risk_score: riskScore, findings,
		...(coreIncomplete || untrackedResult.status !== "OK" ? { reason: [...errors.map((error) => error.stderr).filter(Boolean), ...timeoutSources.map((source) => source + " timed out"), ...(untrackedResult.status !== "OK" ? ["untracked scan " + untrackedResult.status] : [])].join("; ") || "git inspection incomplete" } : {}),
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
		if (gitEntry) { if (gitEntry.isDirectory()) repos.push(current.path); continue; }
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
	const rows = ["RISK  DIRTY AHEAD UNPUSHED STASH DETACHED STATUS       REPOSITORY"];
	for (const repo of repos) rows.push(`${repo.risk_score.toFixed(1).padStart(6)} ${String(repo.dirty_file_count).padStart(5)} ${String(repo.commits_ahead ?? "-").padStart(5)} ${String(repo.unpushed_commits).padStart(7)} ${String(repo.stash_count).padStart(5)} ${String(repo.detached).padStart(8)} ${repo.status.padEnd(12)} ${repo.path}`);
	return rows.join("\n");
}

export async function inspectWorkFleet(input: WorkDoctorInput): Promise<WorkDoctorReport> {
	const started = performance.now(); const concurrency = Math.max(1, Math.min(64, Math.trunc(input.concurrency ?? DEFAULT_CONCURRENCY)));
	const perRepoTimeoutMs = Math.max(100, Math.min(60_000, Math.trunc(input.perRepoTimeoutMs ?? DEFAULT_REPO_TIMEOUT_MS)));
	const discovered = input.roots.flatMap(discover); const allRepos = [...new Set(discovered.flatMap((entry) => entry.repos))]; const repos: WorkRepoReport[] = []; let cursor = 0;
	async function worker(): Promise<void> { while (cursor < allRepos.length) { const index = cursor++; repos[index] = await inspectRepo(allRepos[index]!, perRepoTimeoutMs); } }
	await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, allRepos.length)) }, () => worker()));
	const ordered = repos.filter(Boolean).sort((left, right) => right.risk_score - left.risk_score || left.path.localeCompare(right.path)); const elapsedMs = performance.now() - started;
	return { scope: "work", overall: "REPORT", roots: discovered.map((entry) => entry.root), repos: ordered, concurrency, per_repo_timeout_ms: perRepoTimeoutMs, elapsed_ms: elapsedMs, timed_out_repos: ordered.filter((repo) => repo.findings.includes("unverified")).length, text: renderTable(ordered) };
}
