import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { inspectWorkFleet } from "../../src/work-doctor.ts";

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function repo(root: string, name: string): string {
	const path = join(root, name);
	mkdirSync(path, { recursive: true });
	git(path, "init", "--quiet");
	git(path, "config", "user.email", "fixture@example.invalid");
	git(path, "config", "user.name", "fixture");
	writeFileSync(join(path, "README.md"), `${name}\n`);
	git(path, "add", "README.md");
	git(path, "commit", "--quiet", "-m", "initial [test]");
	return path;
}

function fixture(): { root: string; repos: Record<string, string> } {
	const root = mkdtempSync(join(runtimeTempRoot(), "omp-kit-work-doctor-"));
	fixtures.push(root);
	const clean = repo(root, "clean");
	const dirty = repo(root, "dirty");
	writeFileSync(join(dirty, "untracked.txt"), "dirty\n");
	const ahead = repo(root, "ahead");
	const remote = join(root, "remote.git");
	git(root, "init", "--bare", "--quiet", remote);
	git(ahead, "branch", "-M", "main");
	git(ahead, "remote", "add", "origin", remote);
	git(ahead, "push", "--quiet", "--set-upstream", "origin", "main");
	writeFileSync(join(ahead, "ahead.txt"), "ahead\n");
	git(ahead, "add", "ahead.txt");
	git(ahead, "commit", "--quiet", "-m", "ahead [test]");
	const noUpstream = repo(root, "no-upstream");
	writeFileSync(join(noUpstream, "local.txt"), "local\n");
	git(noUpstream, "add", "local.txt");
	git(noUpstream, "commit", "--quiet", "-m", "local [test]");
	const stash = repo(root, "stash");
	writeFileSync(join(stash, "stashed.txt"), "stashed\n");
	git(stash, "add", "stashed.txt");
	git(stash, "stash", "push", "--quiet", "-m", "fixture");
	const detached = repo(root, "detached");
	git(detached, "checkout", "--quiet", "--detach", "HEAD");
	const worktree = join(root, "worktrees", "ahead");
	mkdirSync(join(root, "worktrees"), { recursive: true });
	git(ahead, "worktree", "add", "--quiet", worktree, "HEAD");
	return { root, repos: { clean, dirty, ahead, noUpstream, stash, detached } };
}

test("read-only work scope classifies clean dirty ahead no-upstream stash detached and worktrees", async () => {
	const f = fixture();
	const before = Bun.spawnSync(["find", f.root, "-type", "f", "-print"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
	const report = await inspectWorkFleet({ roots: [f.root], concurrency: 3, perRepoTimeoutMs: 5_000 });
	const after = Bun.spawnSync(["find", f.root, "-type", "f", "-print"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
	expect(report.scope).toBe("work");
	expect(report.repos.length).toBe(6);
	expect(report.elapsed_ms).toBeGreaterThan(0);
	expect(after).toBe(before);
	const row = (name: string) => report.repos.find((entry) => entry.name === name)!;
	expect(row("clean").dirty_file_count).toBe(0);
	expect(row("dirty").dirty_file_count).toBeGreaterThan(0);
	expect(row("ahead").commits_ahead).toBe(1);
	expect(row("ahead").has_upstream).toBe(true);
	expect(row("no-upstream").has_upstream).toBe(false);
	expect(row("no-upstream").unpushed_commits).toBeGreaterThan(0);
	expect(row("stash").stash_count).toBe(1);
	expect(row("detached").detached).toBe(true);
	expect(row("ahead").active_worktrees).toBe(2);
	expect(report.repos.map((entry) => entry.risk_score)).toEqual([...report.repos].map((entry) => entry.risk_score).sort((a, b) => b - a));
});

test("work scope marks a missing root as unavailable without changing exit semantics", async () => {
	const report = await inspectWorkFleet({ roots: [join(runtimeTempRoot(), "does-not-exist-work-root")], concurrency: 1, perRepoTimeoutMs: 100 });
	expect(report.scope).toBe("work");
	expect(report.roots[0]?.status).toBe("UNAVAILABLE");
	expect(report.repos).toEqual([]);
});


test("work scope CLI renders JSON and human table while exiting zero", async () => {
	const f = fixture();
	const entry = resolve(import.meta.dir, "../../src/cli.ts");
	const args = [entry, "doctor", "--scope", "work", "--root", f.root, "--jobs", "6", "--timeout-ms", "1000"];
	const json = Bun.spawnSync([process.execPath, ...args, "--json"], { cwd: f.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: f.root } });
	expect(json.exitCode).toBe(0);
	const envelope = JSON.parse(json.stdout.toString());
	expect(envelope.data.scope).toBe("work");
	expect(envelope.data.elapsed_ms).toBeGreaterThan(0);
	const human = Bun.spawnSync([process.execPath, ...args], { cwd: f.root, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: f.root } });
	expect(human.exitCode).toBe(0);
	expect(human.stdout.toString()).toContain("RISK");
});
