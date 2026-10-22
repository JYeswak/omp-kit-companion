// close-queue --project (ompkit-kdbz.1 box 4): the tracker resolves from the
// project dir, not the cwd tracker. RED first: --project does not exist yet.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

function run(args: string[], cwd: string): { rc: number; out: string; err: string; text: string } {
	const child = Bun.spawnSync([process.execPath, entry, ...args], {
		cwd, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HOME: cwd, TMPDIR: cwd, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
	});
	const out = child.stdout.toString();
	const err = child.stderr.toString();
	return { rc: child.exitCode ?? 99, out, err, text: out + err };
}

function sh(args: string[], cwd: string): void {
	const child = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`setup failed: ${args.join(" ")}: ${child.stderr.toString()}`);
}
// Fixture project: a git repo whose HEAD names planted bead fxplant-1, with a
// tracker that holds fxplant-1 open and nothing else.
function fixtureProject(parent: string): { dir: string; sha: string } {
	const dir = ownedTmp("proj", { root: parent }).path;
	mkdirSync(join(dir, ".beads"), { recursive: true });
	const db = new Database(join(dir, ".beads", "beads.db"));
	db.exec("CREATE TABLE issues(id TEXT PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, updated_at TEXT)");
	db.exec("CREATE TABLE comments(issue_id TEXT, author TEXT, text TEXT, created_at TEXT)");
	db.prepare("INSERT INTO issues VALUES (?,?,?,?,?)").run("fxplant-1", "planted", "open", null, "2026-10-13 05:00:00");
	db.close();
	sh(["git", "init", "-q"], dir);
	sh(["git", "config", "user.email", "test@invalid.example"], dir);
	sh(["git", "config", "user.name", "Test"], dir);
	sh(["git", "commit", "-q", "--allow-empty", "--message", "land fxplant-1 widgets [test]"], dir);
	const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: dir, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
	return { dir, sha };
}

const home = ownedTmp("drain-project-home").path;

test("close-queue --project returns that tracker's rows, not the cwd tracker's", () => {
	const { dir, sha } = fixtureProject(home);
	const r = run(["drain", "close-queue", "--project", dir, "--json"], home);
	expect(r.rc).toBe(0);
	const rows = JSON.parse(r.out).data.rows as Array<{ id: string; landingSha: string }>;
	expect(rows).toHaveLength(1);
	expect(rows[0]!.id).toBe("fxplant-1");
	expect(rows[0]!.landingSha).toBe(sha);
});

test("--db with --project together is refused naming both", () => {
	const { dir } = fixtureProject(home);
	const r = run(["drain", "close-queue", "--db", join(dir, ".beads", "beads.db"), "--project", dir, "--json"], home);
	expect(r.rc).not.toBe(0);
	expect(r.text).toContain("--db");
	expect(r.text).toContain("--project");
});

test("a project dir with no tracker is refused naming the path", () => {
	const empty = ownedTmp("empty", { root: home }).path;
	const r = run(["drain", "close-queue", "--project", empty, "--json"], home);
	expect(r.rc).not.toBe(0);
	expect(r.text).toContain(empty);
});

afterAll(() => cleanupAllOwnedTmp());
