import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { CACHE_NAME, STALE_AFTER_MS, pollRepos, readStatus, type CiCacheFile, type CiFetchResponse } from "../../src/ci-cache.ts";

const roots: string[] = [];
const savedApi = process.env.OMP_KIT_GITHUB_API;
const savedRepos = process.env.OMP_KIT_CI_REPOS;
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (savedApi === undefined) delete process.env.OMP_KIT_GITHUB_API;
	else process.env.OMP_KIT_GITHUB_API = savedApi;
	if (savedRepos === undefined) delete process.env.OMP_KIT_CI_REPOS;
	else process.env.OMP_KIT_CI_REPOS = savedRepos;
});

function runPayload(id: number, conclusion: string | null) {
	return { id, name: "push", head_branch: "main", head_sha: "abc1234", status: "completed",
		conclusion, created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T01:00:00Z" };
}

interface FakePlan { etag: string; failFirstWith403?: boolean; resetOnly?: boolean; resetAtSec?: number; rateLimitRemaining?: string; seen: string[]; }

// In-process fake GitHub: no sockets, no listen race, no live polling.
// The production fetch wrapper (Bun.fetch) is stdlib and needs no test.
function fakeFetch(plan: FakePlan, nowMs: number) {
	const jsonBody = { workflow_runs: [runPayload(1, "success")] };
	return { nowMs, fetch: async (url: string, headers: Record<string, string>): Promise<CiFetchResponse> => {
		plan.seen.push(url);
		if (plan.failFirstWith403 && plan.seen.length === 1) {
			const out: Record<string, string> = { "x-ratelimit-reset": String(plan.resetAtSec ?? (Math.floor(Date.now() / 1000) + 3600)) };
			if (!plan.resetOnly) out["retry-after"] = "2";
			if (plan.rateLimitRemaining !== undefined) out["x-ratelimit-remaining"] = plan.rateLimitRemaining;
			return { status: 403, headers: out, json: async () => ({}) };
		}
		if (headers["If-None-Match"] === plan.etag) return { status: 304, headers: {}, json: async () => ({}) };
		return { status: 200, headers: { etag: plan.etag }, json: async () => jsonBody };
	} };
}

test("a 200 stores rows with fetched_at and source, and the etag is reused", async () => {
	const plan: FakePlan = { etag: '"v1"', seen: [] };
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const first = await pollRepos(fakeFetch(plan, 1_000_000), cache, ["o/r"]);
	expect(first.repos["o/r"]).toMatchObject({ status: "OK", runs: 1 });
	expect(cache.repos["o/r"]?.etag).toBe('"v1"');
	expect(cache.repos["o/r"]?.runs[0]).toMatchObject({ id: 1, source: "poll" });
	expect(typeof cache.repos["o/r"]?.fetched_at).toBe("string");
	expect(cache.repos["o/r"]?.last_checked_at).toBe(new Date(1_000_000).toISOString());
	expect(readStatus(cache, 1_000_000).overall).toBe("OK");
	const second = await pollRepos(fakeFetch(plan, 2_000_000), cache, ["o/r"]);
	expect(second.repos["o/r"]?.status).toBe("NOT_MODIFIED");
	expect(second.requestsMade).toBe(1);
	expect(plan.seen[1]).toContain("actions/runs");
	expect(cache.repos["o/r"]?.runs[0]?.source).toBe("cache");
});

test("a 403 with retry-after backs off and makes no further requests", async () => {
	const plan: FakePlan = { etag: '"v9"', failFirstWith403: true, seen: [] };
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const result = await pollRepos(fakeFetch(plan, 1_000_000), cache, ["o/r", "o/other"]);
	expect(result.repos["o/r"]?.status).toBe("BACKOFF");
	expect(result.backoffUntilMs).toBe(1_000_000 + 2_000);
	expect(plan.seen.length).toBe(1);
	expect(result.repos["o/other"]).toBeUndefined();
	expect(cache.repos["o/r"]?.backoff_until_ms).toBe(1_000_000 + 2_000);
	const again = await pollRepos(fakeFetch(plan, 1_001_000), cache, ["o/r"]);
	expect(again.repos["o/r"]?.status).toBe("BACKOFF");
	expect(again.requestsMade).toBe(0);
	expect(plan.seen.length).toBe(1);
});

test("planted: a reset-only 403 sleeps until x-ratelimit-reset, not the 60s default", async () => {
	const resetAtSec = Math.floor(9_000_000 / 1000) + 1800;
	const plan: FakePlan = { etag: '"v9"', failFirstWith403: true, resetOnly: true, resetAtSec, rateLimitRemaining: "0", seen: [] };
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const result = await pollRepos(fakeFetch(plan, 9_000_000), cache, ["o/r", "o/other"]);
	expect(result.repos["o/r"]?.status).toBe("BACKOFF");
	expect(result.backoffUntilMs).toBe(resetAtSec * 1000);
	expect(cache.repos["o/r"]?.backoff_until_ms).toBe(resetAtSec * 1000);
	expect(cache.repos["o/r"]?.backoff_reason).toBe("RATE_LIMIT");
	expect(readStatus(cache, 9_000_000).repos["o/r"]).toMatchObject({ status: "UNAVAILABLE",
		poller_state: "BACKOFF", backoff_reason: "RATE_LIMIT", backoff_until_ms: resetAtSec * 1000 });
	expect(plan.seen.length).toBe(1);
	expect(result.repos["o/other"]).toBeUndefined();
});

test("readStatus marks rows stale past the window and reports no cache", () => {
	expect(readStatus(null, 1_000_000).overall).toBe("NO_CACHE");
	const fresh: CiCacheFile = { version: 1, repos: { "o/r": { etag: null,
		fetched_at: new Date(1_000_000).toISOString(), source: "poll:200", backoff_until_ms: null, runs: [] } } };
	expect(readStatus(fresh, 1_000_000 + STALE_AFTER_MS).repos["o/r"]?.stale).toBe(false);
	expect(readStatus(fresh, 1_000_000 + STALE_AFTER_MS + 1).repos["o/r"]?.stale).toBe(true);
	expect(readStatus(fresh, 1_000_000 + STALE_AFTER_MS + 1).overall).toBe("UNAVAILABLE");
});
test("a 304 refreshes status freshness without changing content-fetch timestamps", async () => {
	const plan: FakePlan = { etag: '"v1"', seen: [] };
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const fetchedAt = new Date(1_000_000).toISOString();
	const run: CiCacheFile["repos"][string]["runs"][number] = {
		id: 1, name: "push", branch: "main", sha: "abc1234", status: "completed", conclusion: "success",
		created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T01:00:00Z", fetched_at: fetchedAt, source: "poll",
	};
	const cache: CiCacheFile = { version: 1, repos: { "o/r": { etag: '"v1"', fetched_at: fetchedAt,
		last_checked_at: fetchedAt, source: "poll:200", backoff_until_ms: null, backoff_reason: null, runs: [run] } } };
	const nowMs = 1_000_000 + STALE_AFTER_MS + 5_000;
	const result = await pollRepos(fakeFetch(plan, nowMs), cache, ["o/r"]);
	expect(result.repos["o/r"]?.status).toBe("NOT_MODIFIED");
	expect(cache.repos["o/r"]?.fetched_at).toBe(fetchedAt);
	expect(cache.repos["o/r"]?.last_checked_at).toBe(new Date(nowMs).toISOString());
	expect(cache.repos["o/r"]?.runs[0]?.fetched_at).toBe(fetchedAt);
	expect(cache.repos["o/r"]?.runs[0]?.source).toBe("cache");
	expect(readStatus(cache, nowMs).repos["o/r"]).toMatchObject({ status: "OK", stale: false, age_ms: 0 });
});

test("overall status is unavailable for any stale repo and exposes active rate-limit backoff", () => {
	const nowMs = 9_000_000;
	const freshAt = new Date(nowMs - 1_000).toISOString();
	const staleAt = new Date(nowMs - STALE_AFTER_MS - 1).toISOString();
	const resetAt = nowMs + 60_000;
	const cache: CiCacheFile = { version: 1, repos: {
		"o/fresh": { etag: null, fetched_at: freshAt, last_checked_at: freshAt, source: "poll:200",
			backoff_until_ms: null, backoff_reason: null, runs: [] },
		"o/stale": { etag: '"v9"', fetched_at: staleAt, last_checked_at: staleAt, source: "backoff:403",
			backoff_until_ms: resetAt, backoff_reason: "RATE_LIMIT", runs: [] },
	} };
	const status = readStatus(cache, nowMs);
	expect(status.overall).toBe("UNAVAILABLE");
	expect(status.repos["o/fresh"]).toMatchObject({ status: "OK", stale: false, age_ms: 1_000 });
	expect(status.repos["o/stale"]).toMatchObject({ status: "UNAVAILABLE", stale: true,
		age_ms: STALE_AFTER_MS + 1, poller_state: "BACKOFF", backoff_reason: "RATE_LIMIT", backoff_until_ms: resetAt });
});
test("omitted or untracked repositories remain UNKNOWN without failing overall CI status", () => {
	const cache: CiCacheFile = { version: 1, repos: {
		"local/no-origin": { etag: null, fetched_at: new Date(1_000_000).toISOString(),
			last_checked_at: new Date(1_000_000).toISOString(), source: "untracked",
			backoff_until_ms: null, tracking_status: "UNTRACKED",
			tracking_reason: "origin remote unavailable", runs: [] },
	} };
	const status = readStatus(cache, 1_000_000);
	expect(status.overall).toBe("OK");
	expect(status.repos["local/no-origin"]).toMatchObject({
		status: "UNTRACKED", stale: false, tracking_reason: "origin remote unavailable",
	});
});


test("planted: ci status is wired through the documented grammar", () => {
	const ci = COMMANDS.find(command => command.name === "ci");
	expect(ci).toBeDefined();
	const status = ci?.subcommands?.find(child => child.name === "status");
	expect(status).toBeDefined();
	expect(ci?.example).toContain("ci status");
});

function runCiStatus(cache: CiCacheFile, json: boolean) {
	const home = ownedTmp("ci-status", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(home);
	const state = join(home, "state", "omp-kit");
	mkdirSync(state, { recursive: true });
	const before = JSON.stringify(cache);
	writeFileSync(join(state, CACHE_NAME), before);
	const args = [process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "ci", "status"];
	if (json) args.push("--json");
	const child = Bun.spawnSync(args, {
		cwd: home, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), OMP_KIT_GITHUB_API: "http://127.0.0.1:1" },
		stdout: "pipe", stderr: "pipe",
	});
	return { home, state, before, child };
}

test("ci status reads only a fresh cache file", () => {
	const stamped = new Date(Date.now()).toISOString();
	const cache: CiCacheFile = { version: 1, repos: { "o/r": { etag: null, fetched_at: stamped,
		source: "poll:200", backoff_until_ms: null,
		runs: [{ id: 7, name: "push", branch: "main", sha: "abc", status: "completed", conclusion: "success",
			created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T01:00:00Z",
			fetched_at: stamped, source: "poll" }] } } };
	const { state, before, child } = runCiStatus(cache, true);
	expect(child.exitCode).toBe(0);
	const envelope = JSON.parse(child.stdout.toString());
	expect(envelope.data.overall).toBe("OK");
	expect(envelope.data.repos["o/r"]?.runs[0]).toMatchObject({ id: 7, stale: false });
	expect(readFileSync(join(state, CACHE_NAME), "utf8")).toBe(before);
});

test("all-stale ci status is unavailable and exits nonzero", () => {
	const nowMs = Date.now();
	const staleAt = new Date(nowMs - STALE_AFTER_MS - 1).toISOString();
	const cache: CiCacheFile = { version: 1, repos: { "o/stale": { etag: null,
		fetched_at: staleAt, last_checked_at: staleAt, source: "backoff:403",
		backoff_until_ms: nowMs + 60_000, backoff_reason: "RATE_LIMIT", runs: [] } } };
	const { child } = runCiStatus(cache, true);
	const envelope = JSON.parse(child.stdout.toString());
	expect(child.exitCode).toBe(3);
	expect(envelope.data.overall).toBe("UNAVAILABLE");
	expect(envelope.data.repos["o/stale"]).toMatchObject({ status: "UNAVAILABLE", stale: true,
		poller_state: "BACKOFF", backoff_reason: "RATE_LIMIT", backoff_until_ms: nowMs + 60_000 });
	expect(envelope.data.repos["o/stale"]?.age_ms).toBeGreaterThan(STALE_AFTER_MS);
});

test("mixed fresh and stale ci status names the stale repo in JSON and human output", () => {
	const nowMs = Date.now();
	const freshAt = new Date(nowMs).toISOString();
	const staleAt = new Date(nowMs - STALE_AFTER_MS - 1).toISOString();
	const cache: CiCacheFile = { version: 1, repos: {
		"o/fresh": { etag: null, fetched_at: freshAt, last_checked_at: freshAt, source: "poll:200",
			backoff_until_ms: null, backoff_reason: null, runs: [] },
		"o/stale": { etag: null, fetched_at: staleAt, last_checked_at: staleAt, source: "backoff:403",
			backoff_until_ms: nowMs + 60_000, backoff_reason: "RATE_LIMIT", runs: [] },
	} };
	const json = runCiStatus(cache, true).child;
	const human = runCiStatus(cache, false).child;
	const data = JSON.parse(json.stdout.toString()).data;
	const humanText = human.stdout.toString();
	expect(json.exitCode).toBe(3);
	expect(human.exitCode).toBe(3);
	expect(data.overall).toBe("UNAVAILABLE");
	expect(data.repos["o/fresh"]).toMatchObject({ status: "OK", stale: false });
	expect(data.repos["o/stale"]).toMatchObject({ status: "UNAVAILABLE", stale: true });
	expect(humanText).toContain("UNAVAILABLE");
	expect(humanText).toContain("o/fresh");
	expect(humanText).toContain("o/stale");
});

test("planted: two seats share one poller cache with zero network (two watchers collapse to one)", () => {
	const shared = ownedTmp("ci-shared", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(shared);
	const state = join(shared, "state", "omp-kit");
	mkdirSync(state, { recursive: true });
	const stamped = new Date(Date.now()).toISOString();
	const cache: CiCacheFile = { version: 1, repos: { "o/r": { etag: null, fetched_at: stamped,
		last_checked_at: stamped, source: "poll:200", backoff_until_ms: null, backoff_reason: null,
		runs: [{ id: 7, name: "push", branch: "main", sha: "abc", status: "completed", conclusion: "success",
			created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T01:00:00Z",
			fetched_at: stamped, source: "poll" }] } } };
	const before = JSON.stringify(cache);
	writeFileSync(join(state, CACHE_NAME), before);
	const seat = (name: string) => {
		const home = join(shared, name);
		mkdirSync(home, { recursive: true });
		return Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "ci", "status", "--json"], {
			cwd: home,
			env: { ...process.env, HOME: home, XDG_STATE_HOME: join(shared, "state"), OMP_KIT_GITHUB_API: "http://127.0.0.1:1" },
			stdout: "pipe", stderr: "pipe",
		});
	};
	const first = seat("seat-a");
	const second = seat("seat-b");
	expect(first.exitCode).toBe(0);
	expect(second.exitCode).toBe(0);
	const a = JSON.parse(first.stdout.toString()).data;
	const b = JSON.parse(second.stdout.toString()).data;
	expect(a.overall).toBe("OK");
	expect(b.overall).toBe("OK");
	expect(a.repos["o/r"]).toMatchObject({ status: "OK", stale: false });
	expect(b.repos["o/r"]).toMatchObject({ status: "OK", stale: false });
	expect(b.repos["o/r"]?.runs[0]).toMatchObject({ id: 7, stale: false });
	expect(a.repos["o/r"]?.runs[0]).toMatchObject({ id: 7, stale: false });
	expect(readFileSync(join(state, CACHE_NAME), "utf8")).toBe(before);
});
