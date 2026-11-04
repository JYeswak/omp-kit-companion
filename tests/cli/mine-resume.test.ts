import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { MineLedger } from "../../src/mine-ledger.ts";
import { runMine, renderMine, type MineOptions } from "../../src/mine.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

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
	expect(first.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:unclassified", f.project, 2]]);
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
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:unclassified", f.project, 2]]);
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

test("quarantined unbound CLI telemetry is not a scan-bound failure", async () => {
	const f = await fixture(), path = join(f.home, ".local", "state", "omp-kit", "cc", "cc.db");
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec("CREATE TABLE events(cursor INTEGER PRIMARY KEY,event_id TEXT,type TEXT,time_ms INTEGER,repo TEXT,bead TEXT,data TEXT)");
	db.query("INSERT INTO events VALUES(1,'retained','tool.call',?,?,NULL,'{}')").run(Date.parse("2026-10-01T00:00:00Z"), f.project);
	db.query("INSERT INTO events VALUES(2,'unbound','action.result',?,NULL,NULL,?)").run(Date.parse("2026-10-01T12:00:00Z"), JSON.stringify({ action_id: "unbound", outcome: "failed" }));
	db.close();
	const report = await runMine(f.options);
	expect(report.excluded_inputs.unbound_cli_events).toBe(1);
	expect(report.ledger?.cells.filter(cell => cell.source === "cc").every(cell => cell.status === "READ")).toBe(true);
	expect(report.ledger?.totals.PARTIAL).toBe(0);
});

test("an actual class scan limit remains PARTIAL with its named bound", async () => {
	const f = await fixture(), rows = [JSON.stringify(f.rows[0])];
	for (let i = 0; i < 2050; i++) rows.push(JSON.stringify({ type: "message", timestamp: "2026-10-01T12:00:00Z",
		message: { role: "toolResult", toolCallId: `limited-${i}`, toolName: "bash", isError: true, content: [{ type: "text", text: `AssertionError: distinct cause ${i}` }] } }));
	put(f.source, rows.join("\n") + "\n");
	const report = await runMine(f.options);
	expect(report.ledger?.cells.find(cell => cell.source === "transcripts" && cell.project === f.project && cell.day === "2026-10-01")?.status).toBe("PARTIAL");
	expect(report.ledger?.cells.some(cell => cell.reasons.some(reason => reason.includes("Class limit reached (2048)")))).toBe(true);
	expect(report.status).toBe("PARTIAL");
});

test("a WAL store without side files follows canonical query-only access without changing database bytes", async () => {
	const f = await fixture(false), path = join(f.home, ".local", "state", "omp-kit", "cc", "cc.db");
	mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.exec("PRAGMA journal_mode=WAL; CREATE TABLE events(cursor INTEGER PRIMARY KEY,event_id TEXT,type TEXT,time_ms INTEGER,repo TEXT,bead TEXT,data TEXT)");
	db.query("INSERT INTO events VALUES(1,'wal-failure','tool.call',?,?,NULL,?)").run(Date.parse("2026-10-01T12:00:00Z"), f.project, JSON.stringify({ tool: "wal-tool", is_error: true }));
	db.close();
	for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true });
	const before = createHash("sha256").update(readFileSync(path)).digest("hex"), report = await runMine(f.options);
	expect(report.ledger?.totals.PARTIAL).toBe(0);
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:unclassified", f.project, 1]]);
	expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(before);
});

test("an unavailable CC census stays PARTIAL without suppressing primary findings and recovers on resume", async () => {
	const f = await fixture(), path = join(f.home, ".local", "state", "omp-kit", "cc", "cc.db");
	mkdirSync(path, { recursive: true });
	const before = snapshot(f.home), report = await runMine(f.options);
	expect(snapshot(f.home)).toBe(before);
	expect(report.status).toBe("PARTIAL");
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:unclassified", f.project, 2]]);
	const cells = report.ledger!.cells.filter(cell => cell.source === "cc");
	expect(cells).toHaveLength(4);
	expect(cells.every(cell => cell.status === "PARTIAL" && cell.reasons.some(reason => reason.includes(path)))).toBe(true);
	expect(report.warnings.some(warning => warning.includes("project census") && warning.includes("incomplete"))).toBe(true);
	rmSync(path, { recursive: true });
	const db = new Database(path);
	db.exec("CREATE TABLE events(cursor INTEGER PRIMARY KEY,event_id TEXT,type TEXT,time_ms INTEGER,repo TEXT,bead TEXT,data TEXT)");
	db.query("INSERT INTO events VALUES(1,'retained','tool.call',?,?,NULL,'{}')").run(Date.parse("2026-10-01T00:00:00Z"), f.project);
	db.close();
	const repaired = await runMine(f.options);
	expect(repaired.ledger?.totals.PARTIAL).toBe(0);
	expect(repaired.classes).toEqual(report.classes);
});

test("hook fingerprints ignore unrelated directory cycles but invalidate admitted top-level logs", async () => {
	const f = await fixture(), directory = join(f.home, ".local", "state", "flywheel"), path = join(directory, "block-audit.jsonl");
	const row = { type: "guard.decision", repo: f.project, time_ms: Date.parse("2026-10-01T12:00:00Z"), data: { decision: "deny", rule: "planted-hook" } };
	put(path, JSON.stringify({ ...row, id: "one" }) + "\n");
	symlinkSync(directory, join(directory, "unrelated-cycle"));
	const first = await runMine(f.options);
	expect(first.ledger?.totals.PARTIAL).toBe(0);
	expect(first.classes.find(c => c.id === "guard-friction:planted-hook")?.count).toBe(1);
	const unchanged = await runMine(f.options);
	expect(unchanged.ledger?.scanned).toBe(0);
	appendFileSync(path, JSON.stringify({ ...row, id: "two" }) + "\n");
	const next = await runMine(f.options);
	expect(next.classes.find(c => c.id === "guard-friction:planted-hook")?.count).toBe(2);
	expect(next.ledger?.scanned).toBe(4);
	expect(next.ledger?.reused).toBe(16);
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
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["tool-error:unclassified", f.project, 1]]);
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

const LEDGER_CELL_BYTES = 8 * 1024 * 1024;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("MINECELLCAP1 planted: an over-8-MiB project/day/source cell is split into bounded sub-cells and later projects are still mined", async () => {
	const f = await fixture(false), later = join(f.home, "Developer", "zed"); mkdirSync(later, { recursive: true }); await quietGit(later);
	put(join(f.home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "jev", repo: f.project }, { session: "zed", repo: later }] }));
	// Each failed call retains an ~8 KB replay; 1400 of them on one UTC day exceed one 8 MiB ledger file.
	const command = "echo planted-oversized-cell ".repeat(280), planted = 1400, rows: unknown[] = [{ type: "session", id: "oversized", cwd: f.project }];
	for (let index = 0; index < planted; index++) {
		const timestamp = new Date(Date.parse("2026-10-01T00:00:00Z") + index * 60_000).toISOString();
		rows.push({ type: "message", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: `call-${index}`, name: "bash", arguments: { command } }] } });
		rows.push({ type: "message", timestamp, message: { role: "toolResult", toolCallId: `call-${index}`, toolName: "bash", isError: true, content: [{ type: "text", text: `exit ${index}` }] } });
	}
	put(f.source, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
	put(join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-Developer-zed", "later.jsonl"), [
		{ type: "session", id: "later-project", cwd: later },
		{ type: "message", timestamp: "2026-10-01T12:00:00Z", message: { role: "toolResult", toolCallId: "later", toolName: "bash", isError: true, content: [{ type: "text", text: "later project still mined" }] } },
	].map(row => JSON.stringify(row)).join("\n") + "\n");
	const first = await runMine(f.options);
	expect(first.ledger?.cells.filter(c => c.day === "2026-10-01" && c.source === "transcripts").map(c => [c.project, c.status, c.reasons]))
		.toEqual([[f.project, "READ", []], [later, "READ", []], ["@unattributed", "NONE-EXISTS", expect.any(Array)]]);
	expect(first.ledger?.cells).toHaveLength(30);
	expect(first.ledger?.totals.PARTIAL).toBe(0);
	expect(first.classes.find(c => c.project === later)?.count).toBe(1);
	expect(first.classes.filter(c => c.project === f.project).reduce((sum, c) => sum + c.count, 0)).toBe(planted);
	// Every receipt stays within the unchanged per-file bound; the split cell's parts together exceed it.
	const all = receipts(first.ledger!.path), split = all.filter(row => row.cell.part);
	expect(all.every(row => readFileSync(row.path).length <= LEDGER_CELL_BYTES)).toBe(true);
	expect(split.length).toBeGreaterThanOrEqual(3);
	expect(split.every(row => row.cell.project === f.project && row.cell.day === "2026-10-01" && row.cell.source === "transcripts" && row.cell.part.count === split.length)).toBe(true);
	expect(split.map(row => row.cell.part.index).sort((a, b) => a - b)).toEqual([...split.keys()]);
	expect(split.reduce((sum, row) => sum + readFileSync(row.path).length, 0)).toBeGreaterThan(LEDGER_CELL_BYTES);
	expect(split.find(row => row.cell.part.index === 0)?.cell.result.findings).toEqual([]);
	expect(split.reduce((sum, row) => sum + row.cell.result.findings.length, 0)).toBe(planted);
	// Resume reassembles the split cell from its parts instead of rescanning it.
	const second = await runMine(f.options);
	expect(second.ledger?.scanned).toBe(0);
	expect(second.ledger?.reused).toBe(30);
	expect(second.classes).toEqual(first.classes);
	// A lost part is never certified: only that logical cell is rescanned and its count is unchanged.
	rmSync(split.find(row => row.cell.part.index === split.length - 1)!.path);
	const repaired = await runMine(f.options);
	expect(repaired.ledger?.scanned).toBe(1);
	expect(repaired.classes).toEqual(first.classes);
}, fixtureDeadlineS(60) * 1000);

test("MINECELLCAP1 planted: an item too large for any sub-cell is returned for a PARTIAL reason, never written, and stale parts are released", () => {
	const root = ownedTmp("mine-cell-cap"); roots.push(root);
	const ledger = new MineLedger(join(realpathSync(root.path), "ledger"), { since: "2026-10-01", until: "2026-10-02" }, "MINECELLCAP1");
	const cell = { project: "/fixture/p", day: "2026-10-01", source: "transcripts" as const, input_fingerprint: "planted" };
	const half = "h".repeat(5 * 1024 * 1024), huge = "x".repeat(LEDGER_CELL_BYTES + 1);
	const { results, oversized } = ledger.split(cell, ["a", half, huge, half, "b"], items => ({ items }));
	expect(oversized).toEqual([huge]);
	expect(results).toEqual([{ items: ["a", half] }, { items: [half, "b"] }]);
	const oversizedInput = { ...cell, status: "READ" as const, reasons: [], result: { items: ["a", half, half, "b"] } };
	expect(ledger.fits(oversizedInput)).toBe(false);
	expect(() => ledger.put(oversizedInput)).toThrow("MINE_LEDGER_RESULT_LIMIT_OR_INVALID");
	const written = ledger.putParts({ ...cell, status: "PARTIAL", reasons: ["huge: omitted"], result: { items: [] as string[] } }, results);
	expect(written.map(part => [part.part, part.attempts, part.reasons])).toEqual([[{ index: 0, count: 3 }, 1, ["huge: omitted"]], [{ index: 1, count: 3 }, 1, []], [{ index: 2, count: 3 }, 1, []]]);
	expect(ledger.parts(cell.project, cell.day, cell.source, cell.input_fingerprint)?.map(part => part.result)).toEqual([{ items: [] }, ...results]);
	expect(ledger.cells).toHaveLength(1);
	expect(ledger.totals().PARTIAL).toBe(1);
	// A later whole write releases every previous sub-cell key from the manifest.
	const fits = ledger.put({ ...cell, status: "READ", reasons: [], result: { items: ["a"] } });
	expect(fits.part).toBeUndefined();
	expect(Object.keys(JSON.parse(readFileSync(ledger.path, "utf8")).entries)).toEqual([sha256(JSON.stringify([cell.project, cell.day, cell.source]))]);
	expect(ledger.parts(cell.project, cell.day, cell.source, cell.input_fingerprint)?.map(part => part.result)).toEqual([{ items: ["a"] }]);
});

test("MINECELLCAP1 control: a run whose cells all fit writes the pre-split receipt bytes and manifest keys", async () => {
	const f = await fixture(), report = await runMine(f.options), manifest = JSON.parse(readFileSync(report.ledger!.path, "utf8"));
	const all = receipts(report.ledger!.path);
	expect(report.ledger?.cells).toHaveLength(20);
	expect(all).toHaveLength(20);
	for (const { path, cell } of all) {
		const { project, day, source, input_fingerprint, status, reasons, result, version, attempts } = cell;
		// Pre-split put serialized exactly `{ ...input, version, reasons, attempts }` under key sha256([project, day, source]).
		expect(sha256(JSON.stringify({ project, day, source, input_fingerprint, status, reasons, result, version, attempts }))).toBe(basename(path, ".json"));
		expect(manifest.entries[sha256(JSON.stringify([project, day, source]))]).toBe(basename(path, ".json"));
		expect(Object.keys(cell)).toEqual(["project", "day", "source", "input_fingerprint", "status", "reasons", "result", "version", "attempts"]);
	}
	expect(Object.keys(manifest)).toEqual(["version", "window", "revision", "entries"]);
});
