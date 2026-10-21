import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
/**
 * ci-cache.ts — one shared CI poller and its cache (GH2).
 *
 * The fleet burned 5000 core API requests/hour with every agent running its
 * own `gh run watch`. One launchd job (`ci-poller`, 60s) polls tracked repos
 * with ETag/If-None-Match (a 304 costs no core quota), honours Retry-After
 * and x-ratelimit-reset (sleep until reset, no further requests), and writes
 * a cache file with content fetched_at and freshness last_checked_at per repo. `omp-kit ci status`
 * reads only the cache, never GitHub; rows older than STALE_AFTER_MS are UNAVAILABLE.
 */

export interface CiRunRow {
	id: number;
	name: string;
	branch: string;
	sha: string;
	status: string;
	conclusion: string | null;
	created_at: string;
	updated_at: string;
	/** Last time this row was really fetched (304 keeps the old value). */
	fetched_at: string;
	/** "poll" for a 200 row, "cache" for a 304-kept row, "seed" for fixtures. */
	source: string;
	stale?: boolean;
}

export interface CiRepoTarget {
	name: string;
	path: string | null;
	tracking_status: "TRACKED" | "UNTRACKED";
	tracking_reason?: string;
}

export interface CiRepoCache {
	etag: string | null;
	fetched_at: string;
	/** Last successful cache validation; 304 updates this without refetching run content. */
	last_checked_at?: string | null;
	source: string;
	backoff_until_ms: number | null;
	backoff_reason?: string | null;
	tracking_status?: "TRACKED" | "UNTRACKED";
	tracking_reason?: string;
	runs: CiRunRow[];
}

export interface CiCacheFile {
	version: 1;
	repos: Record<string, CiRepoCache>;
}

export const CI_POLLER_INTERVAL_S = 60;
export const STALE_AFTER_MS = 180_000;
export const CACHE_NAME = "ci-runs.json";

function githubRepo(remote: string): string | null {
	const trimmed = remote.trim();
	const value = trimmed.endsWith(".git") ? trimmed.slice(0, -4) : trimmed;
	const marker = "github.com";
	const at = value.toLowerCase().indexOf(marker);
	if (at < 0) return null;
	const before = value.slice(0, at);
	const preceding = before[before.length - 1];
	if (preceding !== "/" && preceding !== "@" && preceding !== ":") return null;
	let suffix = value.slice(at + marker.length);
	while (suffix.startsWith("/") || suffix.startsWith(":") || suffix.startsWith(" ")) suffix = suffix.slice(1);
	const parts = suffix.split("/").filter(Boolean);
	return parts.length === 2 && parts.every(part => part !== "." && part !== ".." && !part.includes(" ")) ? `${parts[0]}/${parts[1]}` : null;
}

function fleetConfigPath(env: NodeJS.ProcessEnv): string {
	const home = env.HOME ?? homedir();
	return env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
}

/** Discover fleet repos without invoking gh; the GitHub API is polled only by the shared poller. */
export function defaultTrackedRepos(env: NodeJS.ProcessEnv = process.env): (string | CiRepoTarget)[] {
	const override = env.OMP_KIT_CI_REPOS;
	if (override !== undefined && override !== "") {
		return override.split(",").map(name => name.trim()).filter(Boolean);
	}
	let config: unknown;
	try { config = JSON.parse(readFileSync(fleetConfigPath(env), "utf8")); } catch { return []; }
	if (config === null || typeof config !== "object") return [];
	const record = config as Record<string, unknown>;
	const targets: CiRepoTarget[] = [];
	const seen = new Set<string>();
	for (const key of ["sessions", "herdr"] as const) {
		const rows = record[key];
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (row === null || typeof row !== "object") continue;
			const path = (row as Record<string, unknown>).repo;
			if (typeof path !== "string" || !isAbsolute(path) || seen.has(path)) continue;
			seen.add(path);
			const remote = spawnSync("git", ["-C", path, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout: 5000 });
			const remoteUrl = remote.status === 0 ? remote.stdout.trim() : "";
			const name = githubRepo(remoteUrl);
			if (name !== null) targets.push({ name, path, tracking_status: "TRACKED" });
			else targets.push({ name: path, path, tracking_status: "UNTRACKED",
				tracking_reason: remoteUrl === "" ? "origin remote unavailable" : "origin is not a GitHub repository" });
		}
	}
	return targets;
}

export function ciApiBase(): string {
	const override = process.env.OMP_KIT_GITHUB_API;
	if (override !== undefined && override !== "") return override.replace(/\/$/, "");
	return "https://api.github.com";
}

export function ciToken(): string | null {
	for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) {
		const value = process.env[key];
		if (value !== undefined && value !== "") return value;
	}
	return null;
}

export interface CiFetchResponse {
	status: number;
	headers: Record<string, string>;
	json: () => Promise<unknown>;
}

export interface CiPollDeps {
	fetch: (url: string, headers: Record<string, string>) => Promise<CiFetchResponse>;
	nowMs?: number;
}

export interface CiPollResult {
	requestsMade: number;
	backoffUntilMs: number | null;
	repos: Record<string, { status: string; runs: number }>;
}

interface ApiRun {
	id: number;
	name: string;
	head_branch: string;
	head_sha: string;
	status: string;
	conclusion: string | null;
	created_at: string;
	updated_at: string;
}

function header(headers: Record<string, string>, name: string): string | null {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === name) return value;
	}
	return null;
}

function preservedLastCheckedAt(previous: CiRepoCache | undefined): string | null {
	if (previous === undefined) return null;
	return previous.last_checked_at === undefined ? previous.fetched_at : previous.last_checked_at;
}

export function readCacheFile(path: string): CiCacheFile | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CiCacheFile;
		if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || parsed.repos === null || typeof parsed.repos !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function pollRepos(deps: CiPollDeps, cache: CiCacheFile, repos: readonly (string | CiRepoTarget)[]): Promise<CiPollResult> {
	const nowMs = deps.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const token = ciToken();
	const base = ciApiBase();
	const result: CiPollResult = { requestsMade: 0, backoffUntilMs: null, repos: {} };
	for (const input of repos) {
		const target: CiRepoTarget = typeof input === "string" ? { name: input, path: null, tracking_status: "TRACKED" } : input;
		const repo = target.name;
		if (target.tracking_status === "UNTRACKED") {
			cache.repos[repo] = { etag: null, fetched_at: nowIso, last_checked_at: nowIso,
				source: "untracked", backoff_until_ms: null, backoff_reason: null,
				tracking_status: "UNTRACKED", tracking_reason: target.tracking_reason, runs: [] };
			result.repos[repo] = { status: "UNTRACKED", runs: 0 };
			continue;
		}
		const previous = cache.repos[repo];
		if (previous?.backoff_until_ms !== null && previous?.backoff_until_ms !== undefined && previous.backoff_until_ms > nowMs) {
			result.repos[repo] = { status: "BACKOFF", runs: previous.runs.length };
			result.backoffUntilMs = Math.max(result.backoffUntilMs ?? 0, previous.backoff_until_ms);
			continue;
		}
		const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
		if (token !== null) headers.Authorization = `Bearer ${token}`;
		if (previous?.etag) headers["If-None-Match"] = previous.etag;
		let response: CiFetchResponse;
		try {
			response = await deps.fetch(`${base}/repos/${repo}/actions/runs?per_page=10&branch=main`, headers);
		} catch (error) {
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				last_checked_at: preservedLastCheckedAt(previous),
				source: `error:${error instanceof Error ? error.message : String(error)}`, backoff_until_ms: null, backoff_reason: null, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "ERROR", runs: cache.repos[repo].runs.length };
			continue;
		}
		result.requestsMade += 1;
		if (response.status === 304) {
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				last_checked_at: nowIso, source: "poll:304", backoff_until_ms: null, backoff_reason: null,
				runs: (previous?.runs ?? []).map(row => ({ ...row, source: "cache" })) };
			result.repos[repo] = { status: "NOT_MODIFIED", runs: cache.repos[repo].runs.length };
			continue;
		}
		if (response.status === 403 || response.status === 429) {
			const retryAfter = header(response.headers, "retry-after");
			const reset = header(response.headers, "x-ratelimit-reset");
			const rateLimitRemaining = header(response.headers, "x-ratelimit-remaining");
			let until = nowMs + 60_000;
			if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) until = nowMs + Number(retryAfter.trim()) * 1000;
			else if (reset !== null && /^\d+$/.test(reset.trim())) until = Number(reset.trim()) * 1000;
			const backoffReason = response.status === 429 || rateLimitRemaining?.trim() === "0" ? "RATE_LIMIT" : "HTTP_403";
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				last_checked_at: preservedLastCheckedAt(previous),
				source: `backoff:${response.status}`, backoff_until_ms: until, backoff_reason: backoffReason, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "BACKOFF", runs: cache.repos[repo].runs.length };
			result.backoffUntilMs = Math.max(result.backoffUntilMs ?? 0, until);
			return result;
		}
		if (response.status !== 200) {
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				last_checked_at: preservedLastCheckedAt(previous),
				source: `error:http-${response.status}`, backoff_until_ms: null, backoff_reason: null, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "ERROR", runs: cache.repos[repo].runs.length };
			continue;
		}
		const body = await response.json() as { workflow_runs?: ApiRun[] };
		const etag = header(response.headers, "etag");
		cache.repos[repo] = { etag, fetched_at: nowIso, last_checked_at: nowIso, source: "poll:200",
			backoff_until_ms: null, backoff_reason: null,
			runs: (body.workflow_runs ?? []).map(run => ({ id: run.id, name: run.name, branch: run.head_branch,
				sha: run.head_sha, status: run.status, conclusion: run.conclusion, created_at: run.created_at,
				updated_at: run.updated_at, fetched_at: nowIso, source: "poll" })) };
		result.repos[repo] = { status: "OK", runs: cache.repos[repo].runs.length };
	}
	return result;
}
export interface CiStatusData {
	overall: string;
	stale_after_ms: number;
	repos: Record<string, {
		fetched_at: string;
		last_checked_at: string | null;
		source: string;
		status: "OK" | "UNAVAILABLE" | "UNTRACKED";
		stale: boolean;
		age_ms: number | null;
		poller_state: "UNKNOWN" | "BACKOFF" | "ERROR";
		backoff_reason: string | null;
		backoff_until_ms: number | null;
		tracking_reason?: string;
		runs: CiRunRow[];
	}>;
}

export function readStatus(cache: CiCacheFile | null, nowMs: number): CiStatusData {
	if (cache === null) return { overall: "NO_CACHE", stale_after_ms: STALE_AFTER_MS, repos: {} };
	const repos: CiStatusData["repos"] = {};
	for (const [name, entry] of Object.entries(cache.repos)) {
		const lastCheckedAt = entry.last_checked_at === undefined ? entry.fetched_at : entry.last_checked_at;
		const checkedAtMs = lastCheckedAt === null ? Number.NaN : Date.parse(lastCheckedAt);
		const ageMs = Number.isFinite(checkedAtMs) ? nowMs - checkedAtMs : null;
		const stale = ageMs === null || ageMs < 0 || ageMs > STALE_AFTER_MS;
		const activeBackoff = entry.backoff_until_ms !== null && entry.backoff_until_ms > nowMs;
		const pollerState = activeBackoff ? "BACKOFF" : entry.source.startsWith("error:") ? "ERROR" : "UNKNOWN";
		const unavailable = stale || entry.source.startsWith("error:") || entry.source.startsWith("backoff:");
		const untracked = entry.tracking_status === "UNTRACKED";
		repos[name] = {
			fetched_at: entry.fetched_at, last_checked_at: lastCheckedAt, source: entry.source,
			status: untracked ? "UNTRACKED" : unavailable ? "UNAVAILABLE" : "OK", stale, age_ms: ageMs, poller_state: pollerState,
			...(entry.tracking_reason === undefined ? {} : { tracking_reason: entry.tracking_reason }),
			backoff_reason: entry.backoff_reason ?? (activeBackoff ? "UNKNOWN" : null),
			backoff_until_ms: entry.backoff_until_ms,
			runs: entry.runs.map(row => ({ ...row, stale })),
		};
	}
	const overall = Object.values(repos).some(repo => repo.status === "UNAVAILABLE") ? "UNAVAILABLE" : "OK";
	return { overall, stale_after_ms: STALE_AFTER_MS, repos };
}
