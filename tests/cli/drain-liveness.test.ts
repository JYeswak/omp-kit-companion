// STALEDEF1 (ompkit-f9dun) CLI wiring: `drain stale-claims --project` reads holder
// liveness from the seat inventory (tern/tmux on PATH + the Agent Mail identity
// registry under HOME) and the Agent Mail store (AGENT_MAIL_STORAGE_ROOT). Planted:
// a recent claim by a dead agent is listed DEAD; a reservation holder is not;
// an unreadable store lists both as UNKNOWN instead of authorizing a reclaim.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");
const HOUR = 3600_000;
const owned = ownedTmp("drain-liveness-home");
const home = owned.path;
afterAll(() => owned.cleanup());
let fixtureCount = 0;

function fixtureDir(prefix: string): string {
	const dir = join(home, `${prefix}-${fixtureCount++}`);
	mkdirSync(dir);
	return dir;
}

function shims(): string {
	const dir = fixtureDir("bin");
	writeFileSync(join(dir, "tern"), "#!/bin/sh\nprintf '%s' '{\"panes\":[],\"sessions\":[]}'\n");
	writeFileSync(join(dir, "tmux"), "#!/bin/sh\necho 'no server running on /x/default' >&2\nexit 1\n");
	chmodSync(join(dir, "tern"), 0o755);
	chmodSync(join(dir, "tmux"), 0o755);
	return dir;
}

function project(now: number, touchedHours = 25): string {
	const dir = fixtureDir("proj");
	mkdirSync(join(dir, ".beads"), { recursive: true });
	const db = new Database(join(dir, ".beads", "beads.db"));
	db.exec("CREATE TABLE issues(id TEXT PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, updated_at TEXT)");
	db.exec("CREATE TABLE comments(issue_id TEXT, author TEXT, text TEXT, created_at TEXT)");
	const stale = new Date(now - touchedHours * HOUR).toISOString();
	db.prepare("INSERT INTO issues VALUES (?,?,?,?,?)").run("fx-dead", "dead holder", "in_progress", "DeadAgent", stale);
	db.prepare("INSERT INTO issues VALUES (?,?,?,?,?)").run("fx-live", "live holder", "in_progress", "LiveAgent", stale);
	db.close();
	return dir;
}

function store(now: number): string {
	const dir = fixtureDir("mail");
	const db = new Database(join(dir, "storage.sqlite3"));
	db.exec("CREATE TABLE agents(id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT)");
	db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, project_id INTEGER, sender_id INTEGER, created_ts INTEGER)");
	db.exec("CREATE TABLE message_recipients(message_id INTEGER, agent_id INTEGER, kind TEXT, read_ts INTEGER, ack_ts INTEGER)");
	db.exec("CREATE TABLE file_reservations(id INTEGER PRIMARY KEY, project_id INTEGER, agent_id INTEGER, path_pattern TEXT, exclusive INTEGER, created_ts INTEGER, expires_ts INTEGER, released_ts INTEGER)");
	db.prepare("INSERT INTO agents VALUES (?,?,?)").run(1, 1, "DeadAgent");
	db.prepare("INSERT INTO agents VALUES (?,?,?)").run(2, 1, "LiveAgent");
	db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(1, 1, 2, "src/x.ts", 1, (now - 30 * HOUR) * 1000, (now + HOUR) * 1000, null);
	db.close();
	return dir;
}

function staleClaims(dir: string, mailRoot: string): { rc: number; rows: Array<{ id: string; liveness: string; reclaim: string | null }>; text: string } {
	mkdirSync(join(home, ".config", "agent-mail", "identity", "000000000000"), { recursive: true });
	const child = Bun.spawnSync([process.execPath, entry, "drain", "stale-claims", "--project", dir, "--json"], {
		cwd: home, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, PATH: `${shims()}:${process.env.PATH ?? ""}`, HOME: home, TMPDIR: home, AGENT_MAIL_STORAGE_ROOT: mailRoot, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "" },
	});
	const out = child.stdout.toString();
	const text = out + child.stderr.toString();
	let rows: Array<{ id: string; liveness: string; reclaim: string | null }> = [];
	try { rows = JSON.parse(out).data.rows; } catch { /* rc and text carry the failure */ }
	return { rc: child.exitCode ?? 99, rows, text };
}

test("AC1 CLI: a dead holder's 25 h claim is listed; a reservation holder's is not", () => {
	const now = Date.now();
	const r = staleClaims(project(now), store(now));
	expect(r.rc).toBe(0);
	expect(r.rows.map(row => [row.id, row.liveness])).toEqual([["fx-dead", "DEAD"]]);
	expect(r.rows[0]?.reclaim).toContain("br update fx-dead --status open --assignee \"\" --if-unchanged");
});

test("CLI: a recent orphan is reclaimable while a recent reservation holder stays protected", () => {
	const now = Date.now();
	const r = staleClaims(project(now, 2), store(now));
	expect(r.rc).toBe(0);
	expect(r.rows.map(row => [row.id, row.liveness])).toEqual([["fx-dead", "DEAD"]]);
	expect(r.rows[0]?.reclaim).toContain('br update fx-dead --status open --assignee "" --if-unchanged');
});

test("AC1 CLI planted: an unreadable Agent Mail store lists both claims UNKNOWN, never drops them", () => {
	const now = Date.now();
	const r = staleClaims(project(now), join(home, "no-store"));
	expect(r.rc).toBe(0);
	expect(r.rows.map(row => [row.id, row.liveness]).sort()).toEqual([["fx-dead", "UNKNOWN"], ["fx-live", "UNKNOWN"]]);
	expect(r.rows.every(row => row.reclaim === null)).toBe(true);
});
