// SKILLMINE_SCOPEPRESERVE1 (ompkit-1ra0d.168): a pass restricted to some
// repositories must merge into shared git state, never replace it. Mine A,
// then restrict a pass to B: A's cursor, month coverage and chain evidence
// stay byte-preserved and resuming A keeps known coverage. Covers both the
// --project restriction and the Git-only cwd fallback (no cass workspaces).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	readSkillMineStatus, runSkillMine, type SkillMineOptions,
} from "../../src/skill-mine.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

function put(path: string, content: string, mode = 0o644): void {
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	writeFileSync(path, content, { mode });
	if (mode === 0o755) chmodSync(path, 0o755);
}

interface ScopeFixture {
	root: string; home: string; gitA: string; gitB: string;
	stateDir: string; base: SkillMineOptions; env: Record<string, string>;
}

function gitCommit(dir: string, env: Record<string, string>, files: Record<string, string>, subject: string, date: string, body?: string): void {
	for (const [rel, content] of Object.entries(files)) put(join(dir, rel), content);
	const add = runFixture(["git", "add", "-A"], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect(add.rc).toBe(0);
	const dated = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
	const committed = runFixture(["git", "-c", "user.name=Skill Mine", "-c", "user.email=skill-mine@example.com",
		"commit", "--no-gpg-sign", "-m", subject, ...(body ? ["-m", body] : [])], { cwd: dir, env: dated, floor_s: fixtureDeadlineS() });
	expect(committed.rc).toBe(0);
}

function gitHead(dir: string, env: Record<string, string>): string {
	const rev = runFixture(["git", "rev-parse", "HEAD"], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect(rev.rc).toBe(0);
	return new TextDecoder().decode(rev.stdout).trim();
}

function makeScopeFixture(label: string, withCass: boolean): ScopeFixture {
	const root = ownedTmp(label, { root: scratchParent }).path;
	const home = join(root, "home");
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	mkdirSync(join(root, "t"), { recursive: true });
	Object.assign(env, {
		HOME: home, TMPDIR: join(root, "t"), GIT_CEILING_DIRECTORIES: root,
		GIT_AUTHOR_NAME: "Skill Mine", GIT_AUTHOR_EMAIL: "skill-mine@example.com",
		GIT_COMMITTER_NAME: "Skill Mine", GIT_COMMITTER_EMAIL: "skill-mine@example.com",
	});
	const gitA = join(root, "git-a");
	const gitB = join(root, "git-b");
	for (const dir of [gitA, gitB]) {
		mkdirSync(dir, { recursive: true });
		const init = runFixture(["git", "init", "-b", "main", "-q", dir], { cwd: root, env, floor_s: fixtureDeadlineS() });
		expect(init.rc).toBe(0);
	}
	// Repo A: two October dock chains; repo B stays chain-free.
	gitCommit(gitA, env, { "svc/dock.ts": "a v1\n" }, "break dock pump a", "2026-10-05T12:00:00Z");
	gitCommit(gitA, env, { "svc/dock.ts": "a v2\n" }, "fix(dock): pump a guard", "2026-10-06T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
	gitCommit(gitA, env, { "svc/dock.ts": "b v1\n" }, "break dock pump b", "2026-10-07T12:00:00Z");
	gitCommit(gitA, env, { "svc/dock.ts": "b v2\n" }, "fix(dock): pump b guard", "2026-10-08T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
	gitCommit(gitB, env, { "README.md": "docs\n" }, "docs: readme touch", "2026-10-05T12:00:00Z");
	const cassSh = `#!/bin/sh\nhere="$(dirname "$0")"\nif [ "$1" = "sessions" ]; then cat "$here/../cassdata/sessions.json"; exit 0; fi\nif [ "$1" = "export" ]; then cat "$here/../cassdata/exports/$(basename "$2").json"; exit 0; fi\necho "unexpected cass argv: $*" >&2; exit 2\n`;
	if (withCass) {
		put(join(bin, "cass"), cassSh, 0o755);
		put(join(root, "cassdata", "sessions.json"), `${JSON.stringify([
			{ source_path: "sess-a", workspace: gitA },
			{ source_path: "sess-b", workspace: gitB },
		])}\n`);
		for (const sess of ["sess-a", "sess-b"]) {
			put(join(root, "cassdata", "exports", `${sess}.json`), `${JSON.stringify([{ role: "user", text: "hello" }])}\n`);
		}
	}
	symlinkSync(gitA, join(root, "alias-a"));
	const stateDir = join(home, ".local", "state", "omp-kit");
	const base: SkillMineOptions = {
		since: "2026-10-01T00:00:00Z", sources: ["git"],
		home, pathValue: [bin, process.env.PATH ?? ""].join(delimiter), cwd: gitA, stateDir,
		now: Date.parse("2026-11-10T00:00:00Z"),
	};
	return { root, home, gitA, gitB, stateDir, base, env };
}

interface GitCursorRow { display?: string; months_mined?: string[]; last_error?: string | null; }
interface GitCursorChain { repo: string; }
function readCursors(stateDir: string): { repos: Record<string, GitCursorRow>; chains: GitCursorChain[] } {
	const raw = readFileSync(join(stateDir, "skill-mine", "git-cursors.json"), "utf8");
	return JSON.parse(raw);
}
function keyFor(repos: Record<string, GitCursorRow>, display: string): string {
	for (const [key, value] of Object.entries(repos)) {
		if (value.display === display) return key;
	}
	throw new Error(`no cursor row for ${display}`);
}

test("SKILLMINE_SCOPEPRESERVE1: --project pass preserves other repositories", async () => {
	const f = makeScopeFixture("skill-mine-scope-project", true);
	const first = await runSkillMine({ ...f.base, projects: [f.gitA] });
	expect(first.sources.git.status).toBe("OK");
	expect(first.coverage.git.chains_seen).toBe(2);
	const before = readCursors(f.stateDir);
	const keyA = keyFor(before.repos, f.gitA);
	const cursorA = JSON.stringify(before.repos[keyA]);
	const chainsA = JSON.stringify(before.chains.filter(chain => chain.repo === f.gitA));

	const second = await runSkillMine({ ...f.base, projects: [f.gitB] });
	expect(second.sources.git.status).toBe("OK");
	const after = readCursors(f.stateDir);
	expect(JSON.stringify(after.repos[keyA])).toBe(cursorA);
	expect(JSON.stringify(after.chains.filter(chain => chain.repo === f.gitA))).toBe(chainsA);
	expect(JSON.stringify(after)).not.toContain("no longer registered");

	// Resuming A keeps its known coverage: October stays mined.
	const third = await runSkillMine({ ...f.base, projects: [f.gitA] });
	expect(third.sources.git.status).toBe("OK");
	expect(readSkillMineStatus(f.stateDir).git?.repos_detail[f.gitA]?.months_mined).toContain("2026-10");
	expect(third.coverage.git.chains_seen).toBeGreaterThanOrEqual(2);
});

test("SKILLMINE_SCOPEPRESERVE1-fallback: Git-only cwd pass preserves other repositories", async () => {
	const f = makeScopeFixture("skill-mine-scope-fallback", false);
	const first = await runSkillMine({ ...f.base, cwd: f.gitA });
	expect(first.sources.git.status).toBe("OK");
	expect(first.coverage.git.chains_seen).toBe(2);
	const before = readCursors(f.stateDir);
	const keyA = keyFor(before.repos, f.gitA);
	const cursorA = JSON.stringify(before.repos[keyA]);
	const chainsA = JSON.stringify(before.chains.filter(chain => chain.repo === f.gitA));

	const second = await runSkillMine({ ...f.base, cwd: f.gitB });
	expect(second.sources.git.status).toBe("OK");
	const after = readCursors(f.stateDir);
	expect(JSON.stringify(after.repos[keyA])).toBe(cursorA);
	expect(JSON.stringify(after.chains.filter(chain => chain.repo === f.gitA))).toBe(chainsA);
	expect(JSON.stringify(after)).not.toContain("no longer registered");
});
