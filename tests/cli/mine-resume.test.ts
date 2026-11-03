import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { runMine, renderMine, type MineOptions } from "../../src/mine.ts";

const roots: OwnedTmp[] = [];
afterAll(() => { for (const root of roots) root.cleanup(); });
function put(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
async function quietGit(project: string): Promise<void> {
	if (!roots.some(root => project.startsWith(realpathSync(root.path) + "/"))) throw new Error("Fixture git objects require an owned root");
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
	Object.assign(env, { OMP_KIT_CC: "0", GIT_AUTHOR_NAME: "Mining fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Mining fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z" });
	const git = async (args: string[]) => {
		const result = await run(["nice", "-n", "10", "git", "-c", "core.hooksPath=/dev/null", "-C", project, ...args], { env, deadline_s: 10 });
		if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(`Fixture git failed: ${new TextDecoder().decode(result.stderr)}`);
		return new TextDecoder().decode(result.stdout).trim();
	};
	await git(["init", "-q"]);
	const tree = await git(["mktree"]), commit = await git(["commit-tree", tree, "-m", "quiet baseline before mining window"]);
	await git(["update-ref", "refs/heads/fixture", commit]);
}
async function fixture(native = true) {
	const root = ownedTmp("mine-resume"); roots.push(root);
	const base = realpathSync(root.path), home = join(base, "home"), project = join(home, "Developer", "jev");
	mkdirSync(project, { recursive: true });
	// Even when TMPDIR is beneath an exported checkout, git must never walk into its live ancestor.
	await quietGit(project);
	put(join(home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "jev", repo: project }] }));
	const source = join(home, ".omp", "profiles", "default", "agent", "sessions", "-Developer-jev", "native.jsonl");
	const rows = [
		{ type: "session", id: "resume-fixture", cwd: project },
		{ type: "message", timestamp: "2026-10-01T12:00:00Z", message: { role: "toolResult", toolCallId: "one", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 1" }] } },
		{ type: "message", timestamp: "2026-10-02T12:00:00Z", message: { role: "toolResult", toolCallId: "two", toolName: "bash", isError: true, content: [{ type: "text", text: "exit 2" }] } },
	];
	if (native) put(source, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
	const options: MineOptions = { since: "2026-10-01", until: "2026-10-03", all: true, home, cwd: project,
		env: { HOME: home, PATH: process.env.PATH ?? "" }, resumeDir: join(base, "state") };
	return { home, project, source, rows, options };
}
function snapshot(root: string): string {
	const entries: string[] = [];
	function walk(path: string): void { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const child = join(path, entry.name); if (entry.isDirectory()) walk(child); else if (entry.isFile()) entries.push(`${child}:${createHash("sha256").update(readFileSync(child)).digest("hex")}`);
	} }
	walk(root); return entries.join("\n");
}
function receipts(manifestPath: string) {
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	return Object.values(manifest.entries).map(digest => { const path = join(dirname(manifestPath), `${digest}.json`); return { path, cell: JSON.parse(readFileSync(path, "utf8")) }; });
}

test("project/day/source READ receipts survive reopen and skip unchanged cells without touching source bytes", async () => {
	const f = await fixture(), before = snapshot(f.home), first = await runMine(f.options);
	expect(snapshot(f.home)).toBe(before);
	expect(first.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:bash", f.project, 2]]);
	expect(first.ledger?.cells).toHaveLength(20);
	expect(first.ledger?.totals.PARTIAL).toBe(0);
	const second = await runMine(f.options);
	expect(second.ledger?.scanned).toBe(0);
	expect(second.ledger?.reused).toBe(20);
	expect(second.classes).toEqual(first.classes);
	expect(renderMine(second)).toContain("Resumable UTC coverage ledger");
	expect(snapshot(f.home)).toBe(before);
});

test("P missing / Q present cannot certify P from Q's transcript directories or a misleading seat name", async () => {
	const f = await fixture(), missing = join(f.home, "Developer", "missing"); mkdirSync(missing, { recursive: true }); await quietGit(missing);
	put(join(f.home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "jev", repo: f.project }, { session: "missing", repo: missing }] }));
	put(join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-Developer-missing", "wrong-seat.jsonl"), JSON.stringify({ type: "session", id: "wrong-seat", cwd: f.project }) + "\n");
	const report = await runMine(f.options);
	expect(report.ledger?.cells.filter(cell => cell.project === missing && cell.source === "transcripts").map(cell => cell.status)).toEqual(["NONE-EXISTS", "NONE-EXISTS"]);
	expect(report.ledger?.cells.filter(cell => cell.project === f.project && cell.source === "transcripts").map(cell => cell.status)).toEqual(["READ", "READ"]);
	expect(report.projects.find(p => p.path === missing)?.source_records["omp-transcript"]).toBeUndefined();
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:bash", f.project, 2]]);
	expect(renderMine(report)).toContain("not-started project/day/source cells are rebuilt");
});

test("changed source fingerprints invalidate only their source cells, including historical backfill with old mtime", async () => {
	const f = await fixture(), first = await runMine(f.options);
	appendFileSync(f.source, JSON.stringify({ type: "message", timestamp: "2026-10-02T13:00:00Z", message: { role: "toolResult", toolCallId: "backfill", toolName: "bash", isError: true, content: [{ type: "text", text: "failed backfill" }] } }) + "\n");
	utimesSync(f.source, new Date("2026-05-01T00:00:00Z"), new Date("2026-05-01T00:00:00Z"));
	const next = await runMine(f.options);
	expect(first.classes[0]?.count).toBe(2);
	expect(next.classes[0]?.count).toBe(3);
	expect(next.ledger?.scanned).toBe(4);
	expect(next.ledger?.reused).toBe(16);
	expect(next.ledger?.totals.PARTIAL).toBe(0);
});

test("a corrupted receipt is rescanned once rather than treated as completed or duplicated evidence", async () => {
	const f = await fixture(), first = await runMine(f.options);
	const target = receipts(first.ledger!.path).find(row => row.cell.project === f.project && row.cell.source === "transcripts" && row.cell.day === "2026-10-01")!;
	writeFileSync(target.path, "{truncated");
	const next = await runMine(f.options);
	expect(next.ledger?.scanned).toBe(1);
	expect(next.ledger?.reused).toBe(19);
	expect(next.classes[0]?.count).toBe(2);
});

test("unchanged PARTIAL cells alone retry, retain exact source reasons, and recover after source repair", async () => {
	const f = await fixture(); appendFileSync(f.source, "malformed\n");
	const first = await runMine(f.options);
	expect(first.ledger?.totals.PARTIAL).toBe(2);
	expect(first.ledger?.cells.filter(c => c.status === "PARTIAL").every(c => c.reasons.some(reason => reason.includes(f.source + ":4")))).toBe(true);
	const second = await runMine(f.options);
	expect(second.ledger?.scanned).toBe(2);
	expect(second.ledger?.reused).toBe(18);
	expect(receipts(second.ledger!.path).filter(row => row.cell.status === "PARTIAL").every(row => row.cell.attempts === 2)).toBe(true);
	put(f.source, f.rows.map(row => JSON.stringify(row)).join("\n") + "\n");
	const repaired = await runMine(f.options);
	expect(repaired.ledger?.totals.PARTIAL).toBe(0);
	expect(repaired.classes[0]?.count).toBe(2);
});

test("cross-midnight action attempts retain their real surface and project in daily CC slices", async () => {
	const f = await fixture(false), path = join(f.home, ".local", "state", "omp-kit", "cc", "cc.db"); mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec("CREATE TABLE events(cursor INTEGER PRIMARY KEY,event_id TEXT,type TEXT,time_ms INTEGER,repo TEXT,bead TEXT,data TEXT)");
	const insert = db.query("INSERT INTO events VALUES(?,?,?,?,?,NULL,?)");
	insert.run(1, "attempt", "action.attempt", Date.parse("2026-10-01T23:59:00Z"), f.project, JSON.stringify({ action_id: "overnight", surface: "kit-check" }));
	insert.run(2, "result", "action.result", Date.parse("2026-10-02T00:01:00Z"), null, JSON.stringify({ action_id: "overnight", outcome: "failed", duration_ms: 120000 }));
	db.close();
	const report = await runMine(f.options);
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["command-failure:kit-check", f.project, 1]]);
	expect(report.excluded_inputs.unbound_cli_events).toBe(0);
});

test("shared tracker origins retain one canonical owner across project cells", async () => {
	const f = await fixture(false), other = join(f.home, "Developer", "other"), beads = join(f.project, ".beads"); mkdirSync(other, { recursive: true }); await quietGit(other);
	put(join(f.home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "jev", repo: f.project }, { session: "other", repo: other }] }));
	const issue = { id: "p-one", title: "shared", issue_type: "task", priority: 1, source_repo_path: f.project, created_at: "2026-09-01T00:00:00Z" };
	put(join(beads, ".br_history", "issues.20260929_120000_000000001.jsonl"), JSON.stringify({ ...issue, status: "closed", updated_at: "2026-09-29T12:00:00Z" }) + "\n");
	const changed = JSON.stringify({ ...issue, status: "rework", updated_at: "2026-10-02T12:00:00Z" }) + "\n";
	put(join(beads, ".br_history", "issues.20261002_130000_000000001.jsonl"), changed); put(join(beads, "issues.jsonl"), changed); symlinkSync(beads, join(other, ".beads"));
	const report = await runMine(f.options);
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["rework", f.project, 1]]);
	expect(report.ledger?.totals.PARTIAL).toBe(0);
});
