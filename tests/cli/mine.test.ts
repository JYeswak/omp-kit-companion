import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { runMine, renderMine, type MineOptions } from "../../src/mine.ts";

let scratch = "", fixtureNumber = 0;
beforeAll(() => {
	// kitlib owns the temp dir and removes it on exit; no installed kit or native CLI needed (gate-hermetic).
	scratch = realpathSync(ownedTmp("mine-tests").path);
});
afterAll(cleanupAllOwnedTmp);
function put(path: string, value: string | Uint8Array) {
	mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value);
}
function fixture(withTrackerExport = true) {
	const home = join(scratch, `fixture-${++fixtureNumber}`), alpha = join(home, "projects", "alpha"), beta = join(home, "projects", "beta");
	mkdirSync(alpha, { recursive: true }); mkdirSync(beta, { recursive: true });
	put(join(home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "alpha-seat", repo: alpha }, { session: "beta-seat", repo: beta }] }));
	const cc = join(home, ".local", "state", "omp-kit", "cc");
	mkdirSync(join(cc, "spool", "session"), { recursive: true });
	mkdirSync(join(cc, "spool-archive", "session"), { recursive: true });
	if (withTrackerExport) { put(join(alpha, ".beads", "issues.jsonl"), ""); put(join(beta, ".beads", "issues.jsonl"), ""); }
	const env = { HOME: home, PATH: process.env.PATH ?? "" };
	const options: MineOptions = { since: "2026-10-01", until: "2026-11-01", all: true, cwd: alpha, home, env };
	return { home, alpha, beta, cc, options };
}
async function quietGitProject(path: string): Promise<void> {
	if (!path.startsWith(`${scratch}/`)) throw new Error("Fixture git objects require owned scratch");
	const env: Record<string, string> = { OMP_KIT_CC: "0" };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	Object.assign(env, { GIT_AUTHOR_NAME: "Mining fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_NAME: "Mining fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z", OMP_KIT_CC: "0" });
	const git = async (args: string[], input?: string) => {
		const result = await run(["nice", "-n", "10", "git", "-c", "core.hooksPath=/dev/null", "-C", path, ...args], { env, stdin: input, deadline_s: 10 });
		if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(new TextDecoder().decode(result.stderr));
		return new TextDecoder().decode(result.stdout).trim();
	};
	await git(["init", "-q"]);
	const tree = await git(["mktree"], ""), commit = await git(["commit-tree", tree], "quiet baseline before window\n");
	await git(["update-ref", "refs/heads/fixture", commit]);
}
function envelope(id: string, repo: string, type: string, data: object, time = "2026-10-15T12:00:00Z") {
	return { id, repo, type, time, data, confidence: "exact", producer: "session", position: id };
}
function jsonl(rows: unknown[]) { return rows.map(row => JSON.stringify(row)).join("\n") + "\n"; }
function snapshot(root: string): string {
	const rows: string[] = [];
	function visit(path: string) {
		for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) visit(child);
			else if (entry.isFile()) rows.push(`${child}:${createHash("sha256").update(readFileSync(child)).digest("hex")}`);
		}
	}
	visit(root); return rows.join("\n");
}

describe("mine: observed incidents, not transcript mentions", () => {
	test("planted fire spool ranks loss, deduplicates archive/live, cites source and leaves bytes unchanged", async () => {
		// Cluster determinism uses a spool-only producer set. Native br matching is exercised below.
		const f = fixture(false), start = Date.parse("2026-10-15T12:00:00Z");
		const events = [
			envelope("failed", f.alpha, "tool.call", { tool: "bash", start_ms: start, end_ms: start + 600_000, is_error: true, exit_code: 1 }),
			envelope("slow", f.alpha, "tool.call", { tool: "eval", start_ms: start, end_ms: start + 180_000, is_error: false, exit_code: 0 }),
			envelope("timeout", f.beta, "action.result", { tool: "build", duration_ms: 120_000, outcome: "timeout", code: 124 }),
			{ ...envelope("reopen", f.beta, "bead.status", { from_status: "closed", to_status: "open" }), bead: "beta-123" },
			{ ...envelope("rework", f.beta, "bead.status", { from_status: "in_review", to_status: "rework" }), bead: "beta-456" },
			envelope("outside", f.alpha, "tool.call", { tool: "outside", is_error: true }, "2026-11-01T00:00:00Z"),
			envelope("quiet", f.alpha, "tool.call", { tool: "read", is_error: false, start_ms: start, end_ms: start + 10 }),
		];
		put(join(f.cc, "spool-archive", "session", "2026-10-15.jsonl.gz"), gzipSync(jsonl(events)));
		put(join(f.cc, "spool", "session", "2026-10-16.jsonl"), jsonl(events));
		put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
			{ ts: "2026-10-15T14:00:00Z", repo: f.alpha, act: "commit", gate: "staged-imports", kind: "refuse", cost_min: 3 },
			{ ts: "2026-10-15T14:00:01Z", repo: f.alpha, act: "commit", gate: "staged-imports", kind: "pass" },
		]));
		const before = snapshot(f.home), report = await runMine(f.options);
		expect(snapshot(f.home)).toBe(before);
		expect(report.classes.map(c => c.id)).toEqual(["command-failure:bash", "reopened-bead", "rework", "commit-refusal:staged-imports", "slow-command:eval", "timeout:build"]);
		expect(report.classes.map(c => c.count)).toEqual([1, 1, 1, 1, 1, 1]);
		expect(report.classes[0]?.measured_minutes_lost).toBe(10);
		expect(report.classes.find(c => c.id === "slow-command:eval")?.measured_minutes_lost).toBe(2);
		expect(report.classes.find(c => c.id === "rework")?.measured_minutes_lost).toBeNull();
		expect(report.classes[0]?.evidence[0]?.citation).toContain("2026-10-15.jsonl.gz:1");
		expect(report.classes.every(c => c.cheapest_enforcement.change.length > 20)).toBe(true);
		expect(renderMine(report)).toContain("Recorded min");
		expect(renderMine(report)).toContain("not exclusive human time");
		expect(report).toEqual(await runMine(f.options));
	});

	test("quiet spool does not fire for success, open spans, pass events or quoted REWORK", async () => {
		const f = fixture(), t = Date.parse("2026-10-01T00:00:00Z");
		await quietGitProject(f.alpha); await quietGitProject(f.beta);
		put(join(f.cc, "spool", "session", "2026-10-01.jsonl"), jsonl([
			envelope("ok", f.alpha, "tool.call", { tool: "bash", start_ms: t, end_ms: t + 60_000, is_error: false, exit_code: 0 }, "2026-10-01T00:00:00Z"),
			envelope("open", f.beta, "tool.call", { tool: "bash", start_ms: t, end_ms: null, is_error: null, exit_code: null }),
			envelope("prose", f.alpha, "turn.output", { text: "REWORK timeout refused FAIL" }),
			envelope("allow", f.beta, "guard.decision", { decision: "allow", engine: "ttsr", rule: "quiet" }),
		]));
		const report = await runMine(f.options);
		expect(report.status).toBe("QUIET"); expect(report.classes).toEqual([]);
		expect(report.projects).toHaveLength(2);
		expect(renderMine(report)).toContain("No matching events found");
	});

	test("project selector never leaks another project's events discovered in a late guard ledger", async () => {
		const f = fixture();
		put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
			{ ts: "2026-10-15T12:00:00Z", repo: f.alpha, kind: "refuse", gate: "alpha" },
			{ ts: "2026-10-15T12:00:00Z", repo: f.beta, kind: "refuse", gate: "beta" },
			{ ts: "2026-10-15T12:00:00Z", kind: "refuse", gate: "unbound", target: "main" },
		]));
		const report = await runMine({ ...f.options, all: false, project: "alpha" });
		expect(report.projects.map(p => p.path)).toEqual([f.alpha]);
		expect(report.classes.map(c => c.id)).toEqual(["guard-friction:alpha"]);
		const all = await runMine(f.options);
		expect(all.classes.find(c => c.id === "guard-friction:unbound")?.project).toBe("@unattributed");
	});

	test("read-only CC snapshot and native verdict records feed the same report", async () => {
		const f = fixture(), dbPath = join(f.cc, "cc.db");
		const db = new Database(dbPath);
		db.exec("CREATE TABLE events(cursor INTEGER PRIMARY KEY,event_id TEXT,type TEXT,time_ms INTEGER,repo TEXT,bead TEXT,data TEXT)");
		const t = Date.parse("2026-10-01T00:00:00Z");
		db.query("INSERT INTO events VALUES(1,'failure','tool.call',?,?,NULL,?)").run(t, f.alpha, JSON.stringify({ tool: "bash", is_error: true, start_ms: t, end_ms: t + 180_000 }));
		db.close();
		const init = await run(["nice", "-n", "10", "git", "init", "-q", f.alpha], { deadline_s: 10 });
		expect(init.rc).toBe(0);
		expect(init.timed_out || init.truncated).toBe(false);
		put(join(f.alpha, ".git", "omp-kit", "full-suite-verdicts", "failed.json"), JSON.stringify({ version: 3, tree: "a".repeat(40), checks: "b".repeat(64), recorded_at: "2026-10-18T12:00:00Z", verdict: "FAIL", timing: { wall_ms: 1_200_000 }, judge_role: "main" }));
		const before = snapshot(f.home), report = await runMine(f.options);
		expect(snapshot(f.home)).toBe(before);
		expect(report.classes.map(c => c.id)).toEqual(["release-fail", "command-failure:bash"]);
		expect(report.classes[0]?.measured_minutes_lost).toBe(20);
		expect(report.classes[1]?.evidence[0]?.citation).toContain("#events.cursor=1");
	});

	test("corruption and symlinks stay partial rather than false quiet", async () => {
		const f = fixture();
		put(join(f.cc, "spool", "session", "2026-10-20.jsonl"), "not-json\n{}");
		const target = join(f.home, "outside.jsonl"); put(target, "{}\n");
		symlinkSync(target, join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"));
		const report = await runMine(f.options);
		expect(report.status).toBe("PARTIAL");
		expect(report.classes).toEqual([]);
		expect(report.coverage.filter(c => c.status === "PARTIAL").length).toBeGreaterThanOrEqual(2);
	});

	test("later append shard retains historical backfill and UTC end is exclusive", async () => {
		const f = fixture();
		put(join(f.cc, "spool", "session", "2026-11-02.jsonl"), jsonl([
			envelope("oct", f.alpha, "guard.decision", { decision: "deny", rule: "oct" }, "2026-10-31T23:59:59.999Z"),
			envelope("nov", f.alpha, "guard.decision", { decision: "deny", rule: "nov" }, "2026-11-01T00:00:00.000Z"),
		]));
		const report = await runMine(f.options);
		expect(report.classes.map(c => c.id)).toEqual(["guard-friction:oct"]);
	});

	test("dated REWORK comments and read-only br search reuse the existing tracker export", async () => {
		const f = fixture();
		put(join(f.alpha, ".beads", "issues.jsonl"), jsonl([{
			id: "alpha-123", title: "staged-imports preflight", status: "open", issue_type: "task", priority: 1,
			description: "Fix staged-imports refusal before commit", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-20T00:00:00Z",
			comments: [{ id: 1, issue_id: "alpha-123", text: "REWORK: original acceptance failed", created_at: "2026-10-20T00:00:00Z", author: "Verifier" }],
		}]));
		put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
			{ ts: "2026-10-15T14:00:00Z", target: "alpha-123", act: "commit", gate: "staged-imports", kind: "refuse" },
		]));
		const before = snapshot(f.home), report = await runMine(f.options);
		expect(snapshot(f.home)).toBe(before);
		expect(report.classes.map(c => c.id)).toEqual(["rework", "commit-refusal:staged-imports"]);
		expect(report.classes[1]?.project).toBe(f.alpha);
		expect(report.classes[1]?.existing_beads.map(b => b.id)).toEqual(["alpha-123"]);
		expect(report.classes[1]?.bead_search).toBe("MATCHES");
	});

	test("configured checkout aliases join canonically without trusting unconfigured descendants", async () => {
		const f = fixture(false), alias = join(f.home, "checkout-alias");
		symlinkSync(f.alpha, alias, "dir");
		mkdirSync(join(f.alpha, "incidental"));
		put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl([
			envelope("physical", f.alpha, "guard.decision", { decision: "deny", rule: "configured" }),
			envelope("alias", alias, "guard.decision", { decision: "deny", rule: "configured" }),
			envelope("unconfigured", join(alias, "incidental"), "guard.decision", { decision: "deny", rule: "unconfigured" }),
		]));
		const report = await runMine(f.options);
		expect(report.classes.map(c => ({ id: c.id, project: c.project, count: c.count }))).toEqual([
			{ id: "guard-friction:configured", project: f.alpha, count: 2 },
		]);
		expect(report.projects).toHaveLength(2);
		expect(report.excluded_inputs.unconfigured_scratch_events).toBe(1);
	});

	test("test cwds and unbound CLI results are quarantined, while bound action surfaces join", async () => {
		const f = fixture(), t = Date.parse("2026-10-15T12:00:00Z");
		put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl([
			{ ...envelope("unbound", "", "action.result", { action_id: "unbound", outcome: "failed", duration_ms: 60_000 }), repo: null },
			envelope("scratch", join(f.home, "var", "agent-tmp", "negative-control"), "tool.call", { tool: "bash", is_error: true }),
			envelope("attempt", f.alpha, "action.attempt", { action_id: "bound", surface: "kit-check" }),
			envelope("result", f.alpha, "action.result", { action_id: "bound", outcome: "failed", duration_ms: 60_000 }),
			envelope("waiting", f.alpha, "tool.call", { tool: "wait", category: "wait", start_ms: t, end_ms: t + 3600_000, is_error: false }),
			envelope("engine", f.alpha, "guard.decision", { engine: "observational-hook", decision: "failure", rule: null }),
		]));
		const report = await runMine(f.options);
		expect(report.classes.map(c => c.id)).toEqual(["command-failure:kit-check", "guard-failure:observational-hook"]);
		expect(report.excluded_inputs.unbound_cli_events).toBe(1);
		expect(report.excluded_inputs.unconfigured_scratch_events).toBe(1);
		expect(report.excluded_inputs.evidence).toHaveLength(2);
		expect(report.projects).toHaveLength(2);
		expect(report.projects.find(p => p.path === f.beta)?.telemetry_sources).toEqual([]);
		expect(renderMine(report)).toContain("Quarantined telemetry (not ranked)");
	});

	test("pre-window hook archives cannot consume the October read budget", async () => {
		const f = fixture(), path = join(f.home, ".local", "state", "flywheel", "old-block-audit.jsonl");
		put(path, "malformed June archive\\n");
		utimesSync(path, new Date("2026-06-01T00:00:00Z"), new Date("2026-06-01T00:00:00Z"));
		const report = await runMine(f.options);
		expect(report.coverage.find(c => c.producer === "hook refusals")?.detail).toContain("1 historical logs");
		expect(report.coverage.some(c => c.location === path)).toBe(false);
		expect(report.classes).toEqual([]);
	});

	test("native transcripts cover pre-CC days and replace overlapping normalized failures", async () => {
		const f = fixture(), start = Date.parse("2026-10-20T12:00:00Z");
		put(join(f.cc, "spool", "session", "2026-10-20.jsonl"), jsonl([
			envelope("normalized", f.alpha, "tool.call", { tool: "bash", is_error: true, start_ms: start, end_ms: start + 120_000 }, "2026-10-20T12:00:00Z"),
		]));
		const source = join(f.home, ".omp", "profiles", "native", "agent", "sessions", "-projects-alpha", "october.jsonl");
		put(source, jsonl([
			{ type: "title", v: 1, title: "metadata without event time", updatedAt: "2026-10-31T00:00:00Z" },
			{ type: "session", version: 3, id: "primary", cwd: f.alpha },
			{ type: "message", timestamp: "2026-10-02T12:00:00Z", message: { role: "user", content: [{ type: "text", text: "No, use the canonical checkout." }] } },
			{ type: "tool_execution_start", timestamp: "2026-10-20T12:00:00Z", toolCallId: "commit", toolName: "bash" },
			{ type: "message", timestamp: "2026-10-20T12:02:00Z", message: { role: "toolResult", toolCallId: "commit", toolName: "bash", isError: true, content: [{ type: "text", text: "MEMBER_REFUSED: path is reserved by another worker" }] } },
		]));
		const report = await runMine(f.options);
		expect(report.classes.map(c => c.id)).toEqual(["commit-refusal:MEMBER_REFUSED", "user-correction"]);
		expect(report.classes[0]?.measured_minutes_lost).toBe(2);
		expect(report.classes[1]?.estimated_minutes_lost).toBeNull();
		expect(report.classes[1]?.evidence[0]?.timestamp).toBe("2026-10-02T12:00:00.000Z");
		expect(report.classes.every(c => c.evidence[0]?.citation.startsWith(source))).toBe(true);
		expect(report.projects.find(p => p.path === f.alpha)?.source_records["omp-transcript"]).toBe(3);
	});

	test("invalid dates, reversed dates and conflicting scopes refuse before reading", async () => {
		for (const patch of [{ since: "2026-02-30" }, { until: "2026-09-01" }, { project: "alpha" }, { since: "2026-10-01\n" }]) {
			await expect(runMine({ since: "2026-10-01", until: "2026-11-01", all: true, ...patch })).rejects.toThrow();
		}
	});
});
