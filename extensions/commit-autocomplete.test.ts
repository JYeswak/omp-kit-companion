import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommit, planAutocomplete, supersededCommits, type Exec } from "./commit-autocomplete";
import { run } from "../src/kitlib/run.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";

const base = ownedTmp("commit-autocomplete").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function git(repo: string, ...args: string[]): Promise<string> {
	const r = await run(["git", "-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: repo, deadline_s: 60 });
	if (r.rc !== 0) throw new Error(`git ${args.join(" ")} -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return new TextDecoder().decode(r.stdout);
}

const exec: Exec = async (argv, cwd) => {
	const r = await run(argv, { cwd, deadline_s: 60 });
	return { code: r.rc ?? 1, stdout: new TextDecoder().decode(r.stdout) };
};

function store(path: string, rows: { agent: string; project: string; pattern: string; reason: string; expiresMs: number }[]): void {
	const db = new Database(path);
	db.exec(`CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE projects (id INTEGER PRIMARY KEY, human_key TEXT);
		CREATE TABLE file_reservations (id INTEGER PRIMARY KEY, project_id INTEGER, agent_id INTEGER, path_pattern TEXT, exclusive INTEGER, reason TEXT, created_ts INTEGER, expires_ts INTEGER, released_ts INTEGER);`);
	let aid = 0, pid = 0;
	const agents = new Map<string, number>(), projects = new Map<string, number>();
	for (const r of rows) {
		if (!agents.has(r.agent)) { agents.set(r.agent, ++aid); db.query("INSERT INTO agents VALUES (?, ?)").run(aid, r.agent); }
		if (!projects.has(r.project)) { projects.set(r.project, ++pid); db.query("INSERT INTO projects VALUES (?, ?)").run(pid, r.project); }
		db.query("INSERT INTO file_reservations (project_id, agent_id, path_pattern, exclusive, reason, created_ts, expires_ts, released_ts) VALUES (?, ?, ?, 1, ?, 0, ?, NULL)")
			.run(projects.get(r.project)!, agents.get(r.agent)!, r.pattern, r.reason, r.expiresMs * 1000);
	}
	db.close();
}

test("parseCommit: plain git commit statements only", () => {
	expect(parseCommit('git commit --only -m "feat: x [test]" -- a')?.args[0]).toBe("--only");
	expect(parseCommit("cd /r && AGENT_NAME=y git commit -m x")?.prefix).toBe("cd /r && AGENT_NAME=y ");
	for (const c of ["git commit -m x | cat", "git commit -m x; echo done", "echo git commit", "git log"]) expect(parseCommit(c)).toBeNull();
});

test("a commit covered by the seat's live reservation lands with the Bead trailer, a scaffolded fragment and the Supersedes block; planted: an uncovered staged path refuses with every finding and completes nothing", async () => {
	const repo = join(base, "repo");
	mkdirSync(join(repo, "changelog.d"), { recursive: true });
	await git(repo, "init", "-q");
	writeFileSync(join(repo, "src.txt"), "one\ntwo\nthree\n");
	writeFileSync(join(repo, "changelog.d", ".keep"), "");
	await git(repo, "add", "-A");
	await git(repo, "commit", "-q", "-m", "root [test]");
	const first = (await git(repo, "rev-parse", "HEAD")).trim();
	writeFileSync(join(repo, "src.txt"), "one\nTWO\nthree\n");
	writeFileSync(join(repo, "other.txt"), "x\n");
	await git(repo, "add", "src.txt", "other.txt");
	const storePath = join(base, "storage.sqlite3");
	const now = Date.now();
	store(storePath, [{ agent: "Seat", project: repo, pattern: "src.txt", reason: "ompkit-ab12c FIXTURE1", expiresMs: now + 3600_000 }]);
	const planted = await planAutocomplete({ command: 'git commit -m "feat: change two [test]"', repo, agent: "Seat", projectKey: repo, storagePath: storePath, nowMs: now, exec });
	expect(planted?.findings.map(f => f.code)).toEqual(["PATH_UNRESERVED"]);
	expect(planted?.findings[0]?.detail).toContain("other.txt");
	expect(planted?.findings[0]?.fix).toEqual(["git", "restore", "--staged", "--", "other.txt"]);
	expect(planted?.completed).toEqual([]);
	expect(planted?.command).toBe('git commit -m "feat: change two [test]"');
	expect(existsSync(join(repo, "changelog.d", "ab12c.md"))).toBe(false);
	// cover the second path too: everything completes
	store(storePath + ".2", [{ agent: "Seat", project: repo, pattern: "src.txt", reason: "ompkit-ab12c FIXTURE1", expiresMs: now + 3600_000 }, { agent: "Seat", project: repo, pattern: "other.txt", reason: "ompkit-ab12c", expiresMs: now + 3600_000 }]);
	const plan = await planAutocomplete({ command: 'git commit -m "feat: change two [test]"', repo, agent: "Seat", projectKey: repo, storagePath: storePath + ".2", nowMs: now, exec, beadTitle: () => "FIXTURE1: the fixture" });
	expect(plan?.findings).toEqual([]);
	expect(plan?.bead).toBe("ompkit-ab12c");
	expect(plan?.completed.map(c => c.what)).toEqual(["bead-trailer", "fragment", "supersedes"]);
	expect(plan?.command).toBe(`git commit -m "feat: change two [test]" --trailer Bead=ompkit-ab12c --trailer Supersedes=${first}`);
	expect(readFileSync(join(repo, "changelog.d", "ab12c.md"), "utf8")).toContain("- ompkit-ab12c (FIXTURE1): feat: change two.");
	expect(await git(repo, "diff", "--cached", "--name-only")).toContain("changelog.d/ab12c.md");
	// the completed command lands first attempt with the trailers in the commit
	const r = await run(["sh", "-c", plan!.command], { cwd: repo, deadline_s: 60, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
	expect(r.rc).toBe(0);
	const body = await git(repo, "log", "-1", "--format=%B");
	expect(body).toContain("Bead: ompkit-ab12c");
	expect(body).toContain(`Supersedes: ${first}`);
	// planted: an existing Bead trailer and an existing Supersedes are not duplicated (line 3 blames to the root
	// commit `first`, so the one sha already named is the one that would be added)
	writeFileSync(join(repo, "src.txt"), "one\nTWO\nTHREE\n");
	await git(repo, "add", "src.txt");
	const head = (await git(repo, "rev-parse", "HEAD")).trim();
	const again = await planAutocomplete({ command: `git commit -m "feat: three [test]" --trailer Bead=ompkit-ab12c --trailer Supersedes=${first}`, repo, agent: "Seat", projectKey: repo, storagePath: storePath + ".2", nowMs: now, exec });
	expect(again?.completed.map(c => c.what)).toEqual([]);
	expect(again?.command).toBe(`git commit -m "feat: three [test]" --trailer Bead=ompkit-ab12c --trailer Supersedes=${first}`);
	// planted: two covering reservations naming two beads is BEAD_AMBIGUOUS, never a guess
	store(storePath + ".3", [{ agent: "Seat", project: repo, pattern: "src.txt", reason: "ompkit-ab12c", expiresMs: now + 3600_000 }, { agent: "Seat", project: repo, pattern: "src.txt", reason: "ompkit-zz99z", expiresMs: now + 3600_000 }]);
	const amb = await planAutocomplete({ command: 'git commit -m "x [test]"', repo, agent: "Seat", projectKey: repo, storagePath: storePath + ".3", nowMs: now, exec });
	expect(amb?.findings.map(f => f.code)).toEqual(["BEAD_AMBIGUOUS"]);
	// planted: an expired reservation covers nothing
	store(storePath + ".4", [{ agent: "Seat", project: repo, pattern: "src.txt", reason: "ompkit-ab12c", expiresMs: now - 1 }]);
	expect((await planAutocomplete({ command: 'git commit -m "x [test]"', repo, agent: "Seat", projectKey: repo, storagePath: storePath + ".4", nowMs: now, exec }))?.findings.map(f => f.code)).toEqual(["PATH_UNRESERVED"]);
	expect(await supersededCommits(exec, repo)).toEqual([first]);
	void head;
});
