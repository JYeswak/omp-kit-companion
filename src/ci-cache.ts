import { readFileSync } from "node:fs";
/**
 * ci-cache.ts — one shared CI poller and its cache (GH2).
 *
 * The fleet burned 5000 core API requests/hour with every agent running its
 * own `gh run watch`. One launchd job (`ci-poller`, 60s) polls tracked repos
 * with ETag/If-None-Match (a 304 costs no core quota), honours Retry-After
 * and x-ratelimit-reset (sleep until reset, no further requests), and writes
 * a cache file with fetched_at and source per row. `omp-kit ci status` reads
 * only the cache, never GitHub; rows older than STALE_AFTER_MS read stale.
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

export interface CiRepoCache {
	etag: string | null;
	fetched_at: string;
	source: string;
	backoff_until_ms: number | null;
	runs: CiRunRow[];
}

export interface CiCacheFile {
	version: 1;
	repos: Record<string, CiRepoCache>;
}

export const CI_POLLER_INTERVAL_S = 60;
export const STALE_AFTER_MS = 180_000;
export const CACHE_NAME = "ci-runs.json";

export function defaultTrackedRepos(): string[] {
	const fromEnv = (process.env.OMP_KIT_CI_REPOS ?? "").split(",").map(part => part.trim()).filter(part => part !== "");
	if (fromEnv.length > 0) return fromEnv;
	return ["JYeswak/omp-kit-companion"];
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

export function readCacheFile(path: string): CiCacheFile | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CiCacheFile;
		if (parsed === null || typeof parsed !== "object" || parsed.version !== 1 || parsed.repos === null || typeof parsed.repos !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function pollRepos(deps: CiPollDeps, cache: CiCacheFile, repos: string[]): Promise<CiPollResult> {
	const nowMs = deps.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const token = ciToken();
	const base = ciApiBase();
	const result: CiPollResult = { requestsMade: 0, backoffUntilMs: null, repos: {} };
	for (const repo of repos) {
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
				source: `error:${error instanceof Error ? error.message : String(error)}`, backoff_until_ms: null, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "ERROR", runs: cache.repos[repo].runs.length };
			continue;
		}
		result.requestsMade += 1;
		if (response.status === 304) {
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				source: "poll:304", backoff_until_ms: null,
				runs: (previous?.runs ?? []).map(row => ({ ...row, source: "cache" })) };
			result.repos[repo] = { status: "NOT_MODIFIED", runs: cache.repos[repo].runs.length };
			continue;
		}
		if (response.status === 403 || response.status === 429) {
			const retryAfter = header(response.headers, "retry-after");
			const reset = header(response.headers, "x-ratelimit-reset");
			let until = nowMs + 60_000;
			if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) until = nowMs + Number(retryAfter.trim()) * 1000;
			else if (reset !== null && /^\d+$/.test(reset.trim())) until = Number(reset.trim()) * 1000;
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				source: `backoff:${response.status}`, backoff_until_ms: until, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "BACKOFF", runs: cache.repos[repo].runs.length };
			result.backoffUntilMs = Math.max(result.backoffUntilMs ?? 0, until);
			return result;
		}
		if (response.status !== 200) {
			cache.repos[repo] = { etag: previous?.etag ?? null, fetched_at: previous?.fetched_at ?? nowIso,
				source: `error:http-${response.status}`, backoff_until_ms: null, runs: previous?.runs ?? [] };
			result.repos[repo] = { status: "ERROR", runs: cache.repos[repo].runs.length };
			continue;
		}
		const body = await response.json() as { workflow_runs?: ApiRun[] };
		const etag = header(response.headers, "etag");
		cache.repos[repo] = { etag, fetched_at: nowIso, source: "poll:200", backoff_until_ms: null,
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
	repos: Record<string, { fetched_at: string; source: string; stale: boolean; runs: CiRunRow[] }>;
}

export function readStatus(cache: CiCacheFile | null, nowMs: number): CiStatusData {
	if (cache === null) return { overall: "NO_CACHE", stale_after_ms: STALE_AFTER_MS, repos: {} };
	const repos: CiStatusData["repos"] = {};
	for (const [name, entry] of Object.entries(cache.repos)) {
		const ageMs = nowMs - Date.parse(entry.fetched_at);
		const stale = !(ageMs >= 0 && ageMs <= STALE_AFTER_MS);
		repos[name] = { fetched_at: entry.fetched_at, source: entry.source, stale,
			runs: entry.runs.map(row => ({ ...row, stale })) };
	}
	return { overall: "OK", stale_after_ms: STALE_AFTER_MS, repos };
}
