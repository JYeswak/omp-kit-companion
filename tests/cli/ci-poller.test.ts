import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
 import { join, resolve } from "node:path";
 import { COMMANDS } from "../../src/commands.ts";
 import { CACHE_NAME, STALE_AFTER_MS, pollRepos, readStatus, type CiCacheFile, type CiFetchResponse } from "../../src/ci-cache.ts";

const roots: string[] = [];
const savedApi = process.env.OMP_KIT_GITHUB_API;
const savedRepos = process.env.OMP_KIT_CI_REPOS;
const savedNoProxy = process.env.NO_PROXY;
const savedNoProxyLower = process.env.no_proxy;
// Localhost fixtures must never route through a proxy: ubuntu CI runners
// carry proxy env vars, and a proxied 127.0.0.1 refuses instantly (red main
// 2026-10-06: 3 poller tests ERROR). Bun honors NO_PROXY per request.
process.env.NO_PROXY = [savedNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
process.env.no_proxy = [savedNoProxyLower, "127.0.0.1", "localhost"].filter(Boolean).join(",");
// Restores API vars per test (asserted on); the proxy bypass stays for the
// process lifetime: re-applying the runner proxy between tests would
// re-break every later localhost fixture in this file.
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

interface FakePlan { etag: string; failFirstWith403?: boolean; resetOnly?: boolean; resetAtSec?: number; seen: string[]; }

 function fakeGitHub(plan: FakePlan) {
 	return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
		const url = new URL(request.url);
		plan.seen.push(`${request.method} ${url.pathname}${url.search}`);
		if (plan.failFirstWith403 && plan.seen.length === 1) {
			const headers: Record<string, string> = { "x-ratelimit-reset": String(plan.resetAtSec ?? (Math.floor(Date.now() / 1000) + 3600)) };
			if (!plan.resetOnly) headers["retry-after"] = "2";
			return new Response("rate limited", { status: 403, headers });
		}
		if (request.headers.get("if-none-match") === plan.etag) return new Response(null, { status: 304 });
		return Response.json({ workflow_runs: [runPayload(1, "success")] }, { headers: { etag: plan.etag } });
	} });
}

function depsFor(port: number, nowMs: number) {
	return { nowMs, fetch: async (url: string, headers: Record<string, string>): Promise<CiFetchResponse> => {
		const response = await fetch(url.replace("http://fake", `http://127.0.0.1:${port}`), { headers });
		const out: Record<string, string> = {};
		response.headers.forEach((value, key) => { out[key] = value; });
		return { status: response.status, headers: out, json: () => response.json() as Promise<unknown> };
	} };
}

test("a 200 stores rows with fetched_at and source, and the etag is reused", async () => {
	const plan: FakePlan = { etag: '"v1"', seen: [] };
	const server = fakeGitHub(plan);
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const first = await pollRepos(depsFor(server.port, 1_000_000), cache, ["o/r"]);
	expect(first.repos["o/r"]).toMatchObject({ status: "OK", runs: 1 });
	expect(cache.repos["o/r"]?.etag).toBe('"v1"');
	expect(cache.repos["o/r"]?.runs[0]).toMatchObject({ id: 1, source: "poll" });
	expect(typeof cache.repos["o/r"]?.fetched_at).toBe("string");
	const second = await pollRepos(depsFor(server.port, 2_000_000), cache, ["o/r"]);
	expect(second.repos["o/r"]?.status).toBe("NOT_MODIFIED");
	expect(second.requestsMade).toBe(1);
	expect(plan.seen[1]).toContain("actions/runs");
	expect(cache.repos["o/r"]?.runs[0]?.source).toBe("cache");
	server.stop();
});

test("a 403 with retry-after backs off and makes no further requests", async () => {
	const plan: FakePlan = { etag: '"v9"', failFirstWith403: true, seen: [] };
	const server = fakeGitHub(plan);
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const result = await pollRepos(depsFor(server.port, 1_000_000), cache, ["o/r", "o/other"]);
	expect(result.repos["o/r"]?.status).toBe("BACKOFF");
	expect(result.backoffUntilMs).toBe(1_000_000 + 2_000);
	expect(plan.seen.length).toBe(1);
	expect(result.repos["o/other"]).toBeUndefined();
	expect(cache.repos["o/r"]?.backoff_until_ms).toBe(1_000_000 + 2_000);
	const again = await pollRepos(depsFor(server.port, 1_001_000), cache, ["o/r"]);
	expect(again.repos["o/r"]?.status).toBe("BACKOFF");
	expect(again.requestsMade).toBe(0);
	expect(plan.seen.length).toBe(1);
	server.stop();
});

test("planted: a reset-only 403 sleeps until x-ratelimit-reset, not the 60s default", async () => {
	const resetAtSec = Math.floor(9_000_000 / 1000) + 1800;
	const plan: FakePlan = { etag: '"v9"', failFirstWith403: true, resetOnly: true, resetAtSec, seen: [] };
	const server = fakeGitHub(plan);
	process.env.OMP_KIT_GITHUB_API = "http://fake";
	const cache: CiCacheFile = { version: 1, repos: {} };
	const result = await pollRepos(depsFor(server.port, 9_000_000), cache, ["o/r", "o/other"]);
	expect(result.repos["o/r"]?.status).toBe("BACKOFF");
	expect(result.backoffUntilMs).toBe(resetAtSec * 1000);
	expect(cache.repos["o/r"]?.backoff_until_ms).toBe(resetAtSec * 1000);
	expect(plan.seen.length).toBe(1);
	expect(result.repos["o/other"]).toBeUndefined();
	server.stop();
});

 test("readStatus marks rows stale past the window and reports no cache", () => {
 	expect(readStatus(null, 1_000_000).overall).toBe("NO_CACHE");
 	const fresh: CiCacheFile = { version: 1, repos: { "o/r": { etag: null,
 		fetched_at: new Date(1_000_000).toISOString(), source: "poll:200", backoff_until_ms: null, runs: [] } } };
 	expect(readStatus(fresh, 1_000_000 + STALE_AFTER_MS).repos["o/r"]?.stale).toBe(false);
 	expect(readStatus(fresh, 1_000_000 + STALE_AFTER_MS + 1).repos["o/r"]?.stale).toBe(true);
 });
 
 test("planted: ci status is wired through the documented grammar", () => {
 	const ci = COMMANDS.find(command => command.name === "ci");
 	expect(ci).toBeDefined();
 	const status = ci?.subcommands?.find(child => child.name === "status");
 	expect(status).toBeDefined();
 	expect(ci?.example).toContain("ci status");
 });
 
 test("ci status reads only the cache file", () => {
 	const home = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "ci-status-"));
	const state = join(home, "state", "omp-kit");
	mkdirSync(state, { recursive: true });
	const stamped = new Date(Date.now()).toISOString();
	const cache: CiCacheFile = { version: 1, repos: { "o/r": { etag: null, fetched_at: stamped,
		source: "poll:200", backoff_until_ms: null,
		runs: [{ id: 7, name: "push", branch: "main", sha: "abc", status: "completed", conclusion: "success",
			created_at: "2026-10-06T00:00:00Z", updated_at: "2026-10-06T01:00:00Z",
			fetched_at: stamped, source: "poll" }] } } };
	const before = JSON.stringify(cache);
	writeFileSync(join(state, CACHE_NAME), before);
	const child = Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "ci", "status", "--json"], {
		cwd: home, env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), OMP_KIT_GITHUB_API: "http://127.0.0.1:1" },
		stdout: "pipe", stderr: "pipe",
	});
	expect(child.exitCode).toBe(0);
	const envelope = JSON.parse(child.stdout.toString());
	expect(envelope.data.overall).toBe("OK");
 	expect(envelope.data.repos["o/r"]?.runs[0]).toMatchObject({ id: 7, stale: false });
 	expect(readFileSync(join(state, CACHE_NAME), "utf8")).toBe(before);
 });
