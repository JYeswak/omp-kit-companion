import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { inspectWorkFleet } from "../../src/work-doctor.ts";
import { projectSlug } from "../../src/reservation-age.ts";
import { run } from "../../src/kitlib/run.ts";
import { runFixture } from "./fixture-process.ts";

const decoder = new TextDecoder();
const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

// These are Git-state fixtures, not tests of the operator's Git template, signing, or hooks.
const gitEnv = {
	...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
};

function git(cwd: string, ...args: string[]): string {
	const result = runFixture(["git", "-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null",
		"-c", "commit.gpgsign=false", "-C", cwd, ...args], { cwd, env: gitEnv, label: `git ${args[0]}` });
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`);
	return decoder.decode(result.stdout);
}

// Reuse one real committed repository instead of running six init/config/add/commit
// sequences per case. The release failure was still inside fixture()'s commit at 30 s,
// before either CLI scan began; copied repositories keep all six classification controls.
let template: { root: string; path: string } | null = null;
afterAll(() => { if (template) rmSync(template.root, { recursive: true, force: true }); });

function repo(root: string, name: string): string {
	if (template === null) {
		const templateRoot = ownedTmp("omp-kit-work-doctor-template", { root: runtimeTempRoot() }).path;
		const templatePath = join(templateRoot, "repo");
		mkdirSync(templatePath);
		git(templatePath, "init", "--quiet");
		git(templatePath, "config", "user.email", "fixture@example.invalid");
		git(templatePath, "config", "user.name", "fixture");
		writeFileSync(join(templatePath, "README.md"), "fixture\n");
		git(templatePath, "add", "README.md");
		git(templatePath, "commit", "--quiet", "-m", "initial [test]");
		template = { root: templateRoot, path: templatePath };
	}
	const path = join(root, name);
	cpSync(template.path, path, { recursive: true });
	return path;
}

function fixture(): { root: string; repos: Record<string, string> } {
	const root = ownedTmp("omp-kit-work-doctor", { root: runtimeTempRoot() }).path;
	fixtures.push(root);
	mkdirSync(join(root, "not-a-repo", ".git"), { recursive: true });
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
	expect(row("dirty").tracked_dirty_file_count).toBe(0);
	expect(row("dirty").untracked_file_count).toBe(1);
	expect(row("dirty").untracked_scan_status).toBe("OK");
	expect(row("ahead").commits_ahead).toBe(1);
	expect(row("ahead").has_upstream).toBe(true);
	expect(row("no-upstream").has_upstream).toBe(false);
	expect(row("no-upstream").unpushed_commits).toBeGreaterThan(0);
	expect(row("stash").stash_count).toBe(1);
	expect(row("detached").detached).toBe(true);
	expect(row("ahead").active_worktrees).toBe(2);
	const riskScores = report.repos.map((entry) => entry.risk_score).filter((score): score is number => score !== null);
	expect(riskScores).toHaveLength(report.repos.length);
	expect(riskScores).toEqual([...riskScores].sort((a, b) => b - a));
}, 30_000);

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
	const json = await run([process.execPath, ...args, "--json"], {
		cwd: f.root, deadline_s: 20, env: { ...gitEnv, HOME: f.root, OMP_KIT_WORK_STALE_EDIT_MINUTES: "45" },
	});
	expect(json.rc, decoder.decode(json.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(json.stdout));
	expect(envelope.data.scope).toBe("work");
	expect(envelope.data.stale_edit_limit_minutes).toBe(45);
	expect(envelope.data.elapsed_ms).toBeGreaterThan(0);
	const human = await run([process.execPath, ...args], { cwd: f.root, deadline_s: 20, env: { ...gitEnv, HOME: f.root } });
	expect(human.rc, decoder.decode(human.stderr)).toBe(0);
	expect(decoder.decode(human.stdout)).toContain("RISK");
}, 30_000);

test("work scope --project overrides --root and scans only the selected repo", async () => {
	const f = fixture();
	const target = f.repos.dirty;
	const entry = resolve(import.meta.dir, "../../src/cli.ts");
	const result = await run([process.execPath, entry, "doctor", "--scope", "work", "--root", f.root, "--project", target, "--json"], {
		cwd: f.root, deadline_s: 20, env: { ...gitEnv, HOME: f.root },
	});
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(result.stdout));
	expect(envelope.data.roots.map((root: { path: string }) => root.path)).toEqual([target]);
	expect(envelope.data.repos.map((repo: { path: string }) => repo.path)).toEqual([target]);
}, 30_000);

test("work scope reports only old dirty files with matching active reservations", async () => {
	const root = ownedTmp("work-doctor-age", { root: runtimeTempRoot() }).path;
	fixtures.push(root);
	const target = join(root, "stale-edits");
	const hooks = join(root, "hooks");
	mkdirSync(target, { recursive: true });
	mkdirSync(hooks, { recursive: true });
	git(target, "init", "--quiet");
	git(target, "config", "user.email", "fixture@example.invalid");
	git(target, "config", "user.name", "fixture");
	git(target, "config", "commit.gpgsign", "false");
	git(target, "config", "core.hooksPath", hooks);
	writeFileSync(join(target, "README.md"), "stale-edits\n");
	git(target, "add", "README.md");
	git(target, "commit", "--quiet", "-m", "seed [test]");
	const stalePath = join(target, "stale.txt");
	const freshPath = join(target, "fresh.txt");
	const freePath = join(target, "unreserved.txt");
	writeFileSync(stalePath, "initial stale\n");
	writeFileSync(freshPath, "initial fresh\n");
	git(target, "add", "stale.txt", "fresh.txt");
	git(target, "commit", "--quiet", "-m", "seed age files [test]");
	writeFileSync(stalePath, "changed stale\n");
	writeFileSync(freshPath, "changed fresh\n");
	writeFileSync(freePath, "unreserved peer change\n");
	const nowMs = Date.parse("2026-10-05T21:00:00Z");
	const staleMtime = new Date(nowMs - 31 * 60_000);
	const freshMtime = new Date(nowMs - 29 * 60_000);
	const freeMtime = new Date(nowMs - 60 * 60_000);
	utimesSync(stalePath, staleMtime, staleMtime);
	utimesSync(freshPath, freshMtime, freshMtime);
	utimesSync(freePath, freeMtime, freeMtime);
	const archiveRoot = join(root, "mail-storage");
	const projectDir = join(archiveRoot, "projects", projectSlug(target));
	const reservations = join(projectDir, "file_reservations");
	mkdirSync(reservations, { recursive: true });
	writeFileSync(join(projectDir, "project.json"), JSON.stringify({ slug: projectSlug(target), human_key: target }));
	const expires = new Date(nowMs + 60 * 60_000).toISOString();
	for (const [index, file] of [[0, "stale.txt"], [1, "fresh.txt"]] as const) {
		writeFileSync(join(reservations, "hold-" + index + ".json"), JSON.stringify({
			id: index + 1, agent_name: index === 0 ? "OldHolder" : "FreshHolder", path_pattern: file, exclusive: true,
			reason: "ompkit-rc-epic-land-fix-release-dogfood-rz5.106.4",
			created_ts: new Date(nowMs - 10 * 60_000).toISOString(), expires_ts: expires,
		}));
	}
	git(target, "config", "--local", "--replace-all", "omp-kit.agent-mail-storage-root", archiveRoot);
	const before = [stalePath, freshPath, freePath].map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
	const statusBefore = git(target, "status", "--porcelain=v1");
	const report = await inspectWorkFleet({ roots: [root], concurrency: 4, perRepoTimeoutMs: 5_000, nowMs, staleEditLimitMinutes: 30 });
	const row = report.repos.find((entry) => entry.path === target)!;
	const stale = (row as any).stale_uncommitted_edits;
	expect(stale).toHaveLength(1);
	expect(stale[0]).toMatchObject({ path: "stale.txt", agent_name: "OldHolder", bead: "ompkit-rc-epic-land-fix-release-dogfood-rz5.106.4", age_minutes: 31 });
	expect(row.findings).toContain("stale_uncommitted_edits");
	expect([stalePath, freshPath, freePath].map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }))).toEqual(before);
	expect(git(target, "status", "--porcelain=v1")).toBe(statusBefore);
	const cliNowMs = Date.now();
	for (const [path, minutes] of [[stalePath, 31], [freshPath, 29], [freePath, 60]] as const) {
		const modified = new Date(cliNowMs - minutes * 60_000);
		utimesSync(path, modified, modified);
	}
	const beforeCli = [stalePath, freshPath, freePath].map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }));
	const statusBeforeCli = git(target, "status", "--porcelain=v1");
	const entry = resolve(import.meta.dir, "../../src/cli.ts");
	const cli = await run([process.execPath, entry, "doctor", "--scope", "work", "--root", root, "--json"], {
		cwd: target, deadline_s: 20, env: { ...gitEnv, HOME: root, OMP_KIT_WORK_STALE_EDIT_MINUTES: "45" },
	});
	expect(cli.rc, decoder.decode(cli.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(cli.stdout));
	expect(envelope.data.stale_edit_limit_minutes).toBe(45);
	const cliRow = envelope.data.repos.find((entry: { path: string }) => entry.path === target);
	expect(cliRow.reservation_scan_status).toBe("OK");
	expect(cliRow.stale_uncommitted_edits).toEqual([]);
	expect([stalePath, freshPath, freePath].map((path) => ({ bytes: readFileSync(path), mtime: statSync(path).mtimeMs }))).toEqual(beforeCli);
	expect(git(target, "status", "--porcelain=v1")).toBe(statusBeforeCli);
});

test("work scope exposes no clean-looking values when Git status times out", async () => {
	const root = ownedTmp("work-doctor-timeout", { root: runtimeTempRoot() }).path;
	fixtures.push(root);
	const target = repo(root, "timeout");
	const hook = join(root, "fsmonitor.sh");
	const marker = join(root, "fsmonitor.started");
	const pidFile = join(root, "fsmonitor.pid");
	writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' "$$" > ${JSON.stringify(pidFile)}\nprintf started > ${JSON.stringify(marker)}\nexec sleep 10 >/dev/null 2>&1\n`);
	chmodSync(hook, 0o755);
	git(target, "config", "core.fsmonitor", hook);
	let hookPid: number | null = null;
	try {
		const report = await inspectWorkFleet({ roots: [root], concurrency: 1, perRepoTimeoutMs: 500 });
		expect(existsSync(marker)).toBe(true);
		hookPid = Number(readFileSync(pidFile, "utf8").trim());
		const row = report.repos.find((entry) => entry.path === target)!;
		expect(report.timed_out_repos).toBe(1);
		expect(row.status).toBe("TIMED_OUT");
		expect(row).toMatchObject({
			dirty_file_count: null, tracked_dirty_file_count: null, untracked_file_count: null, untracked_scan_status: "UNKNOWN",
			commits_ahead: null, commits_behind: null, unpushed_commits: null, has_upstream: null, no_upstream: null,
			has_remote: null, no_remote: null, stash_count: null, detached: null, branch: null,
			last_commit_epoch: null, last_commit_age_days: null, active_worktrees: null, worktree_paths: null,
			risk_score: null, reservation_scan_status: "UNKNOWN", stale_uncommitted_edits: null,
		});
		expect(row.findings).toContain("status_timed_out");
		const values = (value: unknown): unknown[] => Array.isArray(value) ? value.flatMap(values) : value && typeof value === "object" ? Object.values(value as Record<string, unknown>).flatMap(values) : [value];
		const leaves = values(row);
		expect(leaves).not.toContain(0);
		expect(leaves).not.toContain(false);
		expect(leaves).not.toContainEqual([]);
		expect(report.text).toContain("TIMED_OUT");
		expect(report.text).toContain("UNKNOWN");
	} finally {
		if (hookPid !== null && Number.isInteger(hookPid) && hookPid > 0) {
			try { process.kill(hookPid, "SIGKILL"); }
			catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
		}
	}
}, 30_000);
