import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runtimeTempRoot } from "../../src/runtime.ts";
import { runFixture } from "./fixture-process.ts";

const decoder = new TextDecoder();

const fixtures: string[] = [];
const permRestores: Array<{ path: string; mode: number }> = [];
afterEach(() => {
	for (const entry of permRestores.splice(0)) {
		try { chmodSync(entry.path, entry.mode); } catch { /* fixture teardown */ }
	}
	for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const result = runFixture(["git", "-C", cwd, ...args], { cwd, label: `git ${args[0]}` });
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`);
	return decoder.decode(result.stdout);
}

function seed(cwd: string, name: string): void {
	writeFileSync(join(cwd, "README.md"), `${name}\n`);
	git(cwd, "add", "README.md");
	git(cwd, "commit", "--quiet", "-m", `initial ${name} [test]`);
}

// GATEFLAKE1 (ompkit-ll72v): every pushed repo is a directory copy of one Git-built template, so a
// fixture's setup no longer costs eight serial git spawns per repo (plus the commit hook the global
// init.templatedir installs). The 32-repo fleet below was 256 spawns, measured at 22.0-28.7 s of
// setup at load 16-18 on 32 cores; on the loaded full suite of tree 421d0864 the 60 s cap fired
// while seeding clean-8, the 31st of 32 in sorted order. The template costs 8 spawns once (0.7-1.2 s
// at the same load), and the eight-repo fixture() below drops from 65 spawns to 17. Each copy is
// still a distinct real repository with its own bare remote, upstream and remote-tracking ref; the
// doctor sees the same state (the copied index needs a stat refresh, which is more probe work, not
// less).
let template: { root: string; path: string; remote: string } | null = null;
afterAll(() => {
	if (template) rmSync(template.root, { recursive: true, force: true });
	template = null;
});

function pushedTemplate(): { path: string; remote: string } {
	if (template) return template;
	const root = ownedTmp("omp-kit-work-template", { root: runtimeTempRoot() }).path;
	const path = join(root, "template");
	mkdirSync(path, { recursive: true });
	git(path, "init", "--quiet", "-b", "main");
	git(path, "config", "user.email", "fixture@example.invalid");
	git(path, "config", "user.name", "fixture");
	seed(path, "template");
	const remote = join(root, "template.remote.git");
	git(root, "init", "--bare", "--quiet", remote);
	git(path, "remote", "add", "origin", remote);
	git(path, "push", "--quiet", "--set-upstream", "origin", "main");
	template = { root, path, remote };
	return template;
}

function pushedRepo(root: string, name: string): { path: string; remote: string } {
	const source = pushedTemplate();
	const path = join(root, name);
	const remote = join(root, `${name}.remote.git`);
	cpSync(source.remote, remote, { recursive: true });
	cpSync(source.path, path, { recursive: true });
	const configPath = join(path, ".git", "config");
	const config = readFileSync(configPath, "utf8");
	if (!config.includes(source.remote)) throw new Error(`template config does not name its remote ${source.remote}`);
	writeFileSync(configPath, config.replaceAll(source.remote, remote));
	return { path, remote };
}

function fixture(): { root: string; paths: Record<string, string> } {
	const root = ownedTmp("omp-kit-work-stranded", { root: runtimeTempRoot() }).path;
	fixtures.push(root);
	const paths: Record<string, string> = {};
	paths.clean = pushedRepo(root, "clean").path;
	const unpushed = pushedRepo(root, "unpushed");
	writeFileSync(join(unpushed.path, "ahead.txt"), "ahead\n");
	git(unpushed.path, "add", "ahead.txt");
	git(unpushed.path, "commit", "--quiet", "-m", "ahead [test]");
	paths.unpushed = unpushed.path;
	paths.dirty = pushedRepo(root, "dirty").path;
	writeFileSync(join(paths.dirty, "untracked.txt"), "dirty\n");
	const stashed = pushedRepo(root, "stashed");
	writeFileSync(join(stashed.path, "stashed.txt"), "stashed\n");
	git(stashed.path, "add", "stashed.txt");
	git(stashed.path, "stash", "push", "--quiet", "-m", "fixture");
	paths.stashed = stashed.path;
	const linked = pushedRepo(root, "linked");
	git(linked.path, "worktree", "add", "--quiet", join(root, "wt-linked"), "HEAD");
	paths.linked = linked.path;
	const absent = join(root, "branch-absent");
	mkdirSync(absent, { recursive: true });
	git(absent, "init", "--quiet", "-b", "main");
	git(absent, "config", "user.email", "fixture@example.invalid");
	git(absent, "config", "user.name", "fixture");
	seed(absent, "branch-absent");
	const absentRemote = join(root, "branch-absent.remote.git");
	git(root, "init", "--bare", "--quiet", absentRemote);
	git(absent, "remote", "add", "origin", absentRemote);
	paths.absent = absent;
	const noRemote = join(root, "no-remote");
	mkdirSync(noRemote, { recursive: true });
	git(noRemote, "init", "--quiet", "-b", "main");
	git(noRemote, "config", "user.email", "fixture@example.invalid");
	git(noRemote, "config", "user.name", "fixture");
	seed(noRemote, "no-remote");
	paths.noRemote = noRemote;
	paths.unreadable = pushedRepo(root, "unreadable").path;
	const configPath = join(paths.unreadable, ".git", "config");
	permRestores.push({ path: configPath, mode: 0o644 });
	chmodSync(configPath, 0o000);
	return { root, paths };
}

function cli(root: string, args: string[], env?: Record<string, string | undefined>) {
	const entry = resolve(import.meta.dir, "../../src/cli.ts");
	return runFixture([process.execPath, entry, ...args], {
		cwd: root, env: { ...process.env, HOME: root, ...env },
	});
}

const rowByName = (repos: Array<{ name: string }>, name: string) => repos.find((entry) => entry.name === name)!;

test("stranded audit emits one correctly identified row per named condition through the real CLI", async () => {
	const f = fixture();
	const result = cli(f.root, ["doctor", "--scope", "work", "--root", f.root, "--stranded-only", "--json"]);
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(result.stdout));
	expect(envelope.data.scope).toBe("work");
	expect(envelope.data.stranded_only).toBe(true);
	expect(envelope.data.roots[0]?.discovery?.max_depth).toBeGreaterThan(0);
	const names = envelope.data.repos.map((entry: { name: string }) => entry.name);
	expect(names, JSON.stringify(envelope.data.repos)).not.toContain("clean");
	for (const name of ["unpushed", "dirty", "stashed", "linked", "branch-absent", "no-remote", "unreadable"]) {
		expect(names).toContain(name);
	}
	const repos = envelope.data.repos as Array<Record<string, unknown>>;
	const unpushed = rowByName(repos, "unpushed") as Record<string, any>;
	expect(unpushed.conditions).toContain("unpushed");
	expect(unpushed.commits_ahead).toBe(1);
	expect(unpushed.stranded).toBe(true);
	expect(typeof unpushed.last_commit_age_days).toBe("number");
	expect(typeof unpushed.last_commit_epoch).toBe("number");
	const dirty = rowByName(repos, "dirty") as Record<string, any>;
	expect(dirty.conditions).toContain("dirty");
	expect(dirty.dirty_file_count).toBeGreaterThan(0);
	const stashed = rowByName(repos, "stashed") as Record<string, any>;
	expect(stashed.conditions).toContain("stashes");
	expect(stashed.stash_count).toBe(1);
	const linked = rowByName(repos, "linked") as Record<string, any>;
	expect(linked.conditions).toContain("linked_worktrees");
	expect(linked.active_worktrees).toBe(2);
	expect(linked.worktree_paths).toHaveLength(2);
	const absent = rowByName(repos, "branch-absent") as Record<string, any>;
	expect(absent.conditions).toContain("branch_absent_remotely");
	expect(absent.has_remote).toBe(true);
	expect(absent.has_upstream).toBe(false);
	const noRemote = rowByName(repos, "no-remote") as Record<string, any>;
	expect(noRemote.conditions).toContain("no_remote");
	expect(noRemote.has_remote).toBe(false);
	const unreadable = rowByName(repos, "unreadable") as Record<string, any>;
	expect(unreadable.status).toBe("UNKNOWN");
	expect(unreadable.conditions).toEqual(["unreadable"]);
	expect(unreadable.stranded).toBe(true);
	expect(typeof unreadable.reason).toBe("string");
	expect((unreadable.reason as string).length).toBeGreaterThan(0);
}, 60_000);

test("a clean pushed repo produces no stranded row but stays visible in the full report", async () => {
	const f = fixture();
	const full = cli(f.root, ["doctor", "--scope", "work", "--root", f.root, "--json"]);
	expect(full.rc, decoder.decode(full.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(full.stdout));
	const clean = rowByName(envelope.data.repos, "clean") as Record<string, any>;
	expect(clean.stranded).toBe(false);
	expect(clean.conditions).toEqual([]);
	expect(clean.status).toBe("OK");
	expect(clean.unpushed_commits).toBe(0);
	expect(clean.dirty_file_count).toBe(0);
}, 60_000);

// Deadline derivation: the doctor run is bounded by the product, not the machine. Every Git probe
// is SIGKILLed at the default 2000 ms, a clean repo makes two sequential probe rounds (status, log
// and ls-files together, then rev-list), and the default fan-out is 4, so 32 repos finish within
// ceil(32/4) x 2 x 2000 = 32 s even if every probe times out (measured 0.6 s at load 18). Setup is
// at most the template's 8 git spawns plus 64 directory copies: 0.7-1.2 s measured at load 16-18,
// and 2 s at the 0.25 s per spawn of the refused 421d0864 suite (245 spawns started in 60.1 s).
// 32 s + 2 s leaves the 60 s cap 26 s for the CLI start; it no longer depends on a quiet machine.
test("a bulk clean fleet stays measured at the default Git probe deadline", async () => {
	const root = ownedTmp("omp-kit-work-bulk-clean", { root: runtimeTempRoot() }).path;
	fixtures.push(root);
	const names = Array.from({ length: 32 }, (_, index) => `clean-${index}`).sort();
	for (const name of names) pushedRepo(root, name);
	const result = cli(root, ["doctor", "--scope", "work", "--root", root, "--json"]);
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(result.stdout));
	expect(envelope.data.roots[0]?.repo_count).toBe(32);
	expect(envelope.data.repos.map((repo: { name: string }) => repo.name).sort()).toEqual(names);
	for (const repo of envelope.data.repos) {
		expect(repo.status, JSON.stringify(repo)).toBe("OK");
		expect(repo.stranded).toBe(false);
		expect(repo.conditions).toEqual([]);
		expect(repo.unpushed_commits).toBe(0);
		expect(repo.dirty_file_count).toBe(0);
	}
}, 60_000);

test("doctor --scope work --fleet uses the canonical roots and refuses scoped combinations", async () => {
	const f = fixture();
	const fleet = cli(f.root, ["doctor", "--scope", "work", "--fleet", "--stranded-only", "--json"], { OMP_KIT_WORK_ROOTS: f.root });
	expect(fleet.rc, decoder.decode(fleet.stderr)).toBe(0);
	const envelope = JSON.parse(decoder.decode(fleet.stdout));
	expect(envelope.data.fleet).toBe(true);
	expect(envelope.data.roots.map((entry: { path: string }) => entry.path)).toEqual([f.root]);
	expect(envelope.data.repos.map((entry: { name: string }) => entry.name)).not.toContain("clean");
	const conflict = cli(f.root, ["doctor", "--scope", "work", "--fleet", "--root", f.root, "--json"], { OMP_KIT_WORK_ROOTS: f.root });
	expect(conflict.rc).toBe(2);
	expect(decoder.decode(conflict.stdout)).toContain("CONFLICTING_FLAGS");
	const wrongScope = cli(f.root, ["doctor", "--scope", "load", "--fleet", "--json"]);
	expect(wrongScope.rc).toBe(2);
	expect(decoder.decode(wrongScope.stdout)).toContain("INVALID_FLAG");
}, 60_000);
