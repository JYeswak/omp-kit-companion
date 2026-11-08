import { afterEach, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CACHE_NAME, waitForCi, type CiCacheFile, type CiRunRow } from "../../src/ci-cache.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = ownedTmp("ci-wait", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
 roots.push(root);
 const state = join(root, "state", "omp-kit");
 mkdirSync(state, { recursive: true });
 const path = join(state, CACHE_NAME);
 const row: CiRunRow = { id: 7, name: "CI", branch: "main", sha: "abcdef0123456789", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-11-08T00:00:00Z", fetched_at: "2026-01-01T00:00:00Z", source: "seed" };
 const put = (rows: CiRunRow[]) => {
  const cache: CiCacheFile = { version: 1, repos: { "o/r": { etag: null, fetched_at: row.fetched_at, source: "seed", backoff_until_ms: null, runs: rows } } };
  writeFileSync(`${path}.next`, JSON.stringify(cache)); renameSync(`${path}.next`, path);
 };
 const options = { repo: "o/r", sha: "abcdef0", workflow: "CI", sinceMs: Date.parse(row.updated_at), timeoutMs: fixtureDeadlineS() * 1000 };
 return { root, path, row, put, options };
}

test("stale cache can immediately satisfy a matching completed run", async () => {
 const f = fixture(); f.put([f.row]);
 expect(await waitForCi(f.path, f.options)).toMatchObject({ overall: "PASS", last_row: { id: 7 } });
});
test("directory rename wakes wait and same-id rerun must be newer than since", async () => {
 const f = fixture(); f.put([f.row]);
 const pending = waitForCi(f.path, { ...f.options, sinceMs: f.options.sinceMs + 1000 });
 f.put([{ ...f.row, updated_at: "2026-11-08T00:00:01Z", conclusion: "failure" }]);
 expect(await pending).toMatchObject({ overall: "FAIL", last_row: { id: 7, conclusion: "failure" } });
});
test("missing cache waits for first atomic publication", async () => {
 const f = fixture(); const pending = waitForCi(f.path, f.options);
 f.put([f.row]); expect((await pending).overall).toBe("PASS");
});
test("deadline reports stale last row and ignores wrong workflow, sha, incomplete and old rows", async () => {
 const f = fixture();
 f.put([f.row, { ...f.row, name: "Other", updated_at: "2027-01-01T00:00:00Z" }, { ...f.row, sha: "1234567", updated_at: "2027-01-01T00:00:00Z" }]);
 const result = await waitForCi(f.path, { ...f.options, sinceMs: f.options.sinceMs + 1, timeoutMs: fixtureDeadlineS(0.01) * 1000 });
 expect(result.overall).toBe("UNAVAILABLE"); expect(result.last_row?.id).toBe(7); expect(result.cache_age_ms).toBeGreaterThan(180000);
 f.put([{ ...f.row, status: "in_progress" }]);
 expect((await waitForCi(f.path, { ...f.options, timeoutMs: fixtureDeadlineS(0.01) * 1000 })).overall).toBe("UNAVAILABLE");
});
test("CLI uses cache only, JSON envelope and exit codes", () => {
 const f = fixture(); f.put([f.row]);
 const invoke = (args: string[]) => runFixture([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "ci", "wait", "--repo", "o/r", "--sha", "abcdef0", "--json", ...args], { cwd: f.root, env: { ...process.env, HOME: f.root, XDG_STATE_HOME: join(f.root, "state"), OMP_KIT_GITHUB_API: "http://127.0.0.1:1" } });
 const pass = invoke(["--since", "2026-11-08T00:00:00Z"]);
 expect(pass.rc).toBe(0); expect(JSON.parse(new TextDecoder().decode(pass.stdout)).data.last_row.id).toBe(7);
 f.put([{ ...f.row, conclusion: "cancelled" }]); expect(invoke(["--since", "2026-11-08T00:00:00Z"]).rc).toBe(1);
 expect(invoke(["--timeout-s", "1"]).rc).toBe(3);
});
