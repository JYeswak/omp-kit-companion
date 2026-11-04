import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { runMine, scanMine, renderMine, type MineOptions } from "../../src/mine.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

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

for (const resumable of [false, true]) test(`MINECAP exposes all 12 occurrences with stable ids (${resumable ? "resumable" : "ephemeral"})`, async () => {
	const f = fixture(false), source = join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl");
	await quietGitProject(f.alpha); await quietGitProject(f.beta);
	put(source, jsonl(Array.from({ length: 12 }, (_, index) => ({
		ts: `2026-10-15T14:00:${String(index).padStart(2, "0")}Z`, repo: f.alpha,
		...(index % 2 === 0 ? { event_id: `retained-${index}` } : {}),
		act: "commit", gate: "twelve-occurrences", kind: "refuse", input: { command: `original-command-${index}` },
	}))));
	const options = { ...f.options, since: "2026-10-15", until: "2026-10-16",
		...(resumable ? { resumeDir: join(f.home, "mine-state") } : {}) };
	const first = await runMine(options);
	expect(first.classes.map(c => [c.id, c.count, c.evidence.length])).toEqual([["commit-refusal:twelve-occurrences", 12, 5]]);
	expect(first.occurrences).toHaveLength(12);
	expect(new Set(first.occurrences.map(row => row.event_id)).size).toBe(12);
	for (const [index, row] of first.occurrences.entries()) {
		expect(row.event_id.length).toBeGreaterThan(0);
		if (index % 2 === 0) expect(row.event_id).toBe(`retained-${index}`);
		expect(row.class_id).toBe("commit-refusal:twelve-occurrences");
		expect(row.project).toBe(f.alpha);
		expect(row.citation).toBe(`${source}:${index + 1}`);
		expect(row.replay?.arguments).toEqual({ command: `original-command-${index}` });
	}
	expect(JSON.parse(JSON.stringify(first)).occurrences).toEqual(first.occurrences);
	const second = await runMine(options);
	expect(second.occurrences).toEqual(first.occurrences);
	if (resumable) expect(second.ledger?.scanned).toBe(0);
});

test("MINEDEFECTS retained rc zero is neither a refusal nor a false timeout", async () => {
	const f = fixture(false);
	put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
		{ ts: "2026-10-15T14:00:00Z", repo: f.alpha, act: "commit", gate: "planted", kind: "refuse", rc: 0, detail: "findings=0 rc=0" },
	]));
	put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl([
		envelope("not-timeout", f.alpha, "tool.call", { tool: "eval", timed_out: false, rc: 0, is_error: false, output: "timeout settings checked successfully" }),
	]));
	const report = await runMine(f.options);
	expect(report.classes).toEqual([]);
});

test("MINEDEFECTS guard and native result share one occurrence and retained input", async () => {
	const f = fixture(false), id = "shared-native-guard", source = join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-projects-alpha", "joined.jsonl");
	const originalInput = { timeout: fixtureDeadlineS(30) };
	put(source, jsonl([
		{ type: "session", id: "joined", cwd: f.alpha },
		{ type: "message", timestamp: "2026-10-15T13:59:00Z", message: { role: "assistant", content: [{ type: "toolCall", id, name: "wait", arguments: originalInput }] } },
		{ type: "message", timestamp: "2026-10-15T14:00:00Z", message: { role: "toolResult", toolCallId: id, toolName: "wait", isError: true, content: [{ type: "text", text: "kit-flywheel-guard WAIT_REFUSED: this call uses the wait tool" }] } },
	]));
	put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
		{ ts: "2026-10-15T14:00:00Z", event_id: id, attempt: id, act: "wait", gate: "WAIT_REFUSED", kind: "refuse", detail: "kit-flywheel-guard WAIT_REFUSED: this call uses the wait tool" },
	]));
	put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl([
		envelope("normalized-guard", f.alpha, "tool.call", { tool: "wait", tool_call_id: id, is_error: true }),
	]));
	const beforeEnrichment = await scanMine({ ...f.options, sources: ["cc"], lookupBeads: false });
	expect(beforeEnrichment.classes.map(c => c.id)).toEqual(["tool-error:unclassified"]);
	const report = await runMine(f.options);
	expect(report.classes.map(c => [c.id, c.project, c.count])).toEqual([["guard-friction:WAIT_REFUSED", f.alpha, 1]]);
	expect(report.classes[0]?.evidence.some(e => e.event_id === id && JSON.stringify(e.replay?.arguments) === JSON.stringify(originalInput))).toBe(true);
	expect(report.occurrences).toHaveLength(1);
	expect(report.occurrences[0]?.event_id).toBe(beforeEnrichment.occurrences[0]?.event_id);
	expect(report.occurrences[0]?.event_id).toBe(id);
	expect(report.occurrences[0]?.citation).not.toBe(beforeEnrichment.occurrences[0]?.citation);
	expect(report.occurrences[0]?.replay?.arguments).toEqual(originalInput);
	expect(renderMine(report)).toContain(`"timeout": ${originalInput.timeout}`);
});

test("MINEDEFECTS merged replay preserves actual commit context instead of diagnostic status", async () => {
	const f = fixture(false), id = "commit-context", source = join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-projects-alpha", "commit.jsonl");
	put(source, jsonl([
		{ type: "session", id: "commit-context-session", cwd: f.alpha },
		{ type: "message", timestamp: "2026-10-15T13:59:00Z", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "git commit -F .git/COMMIT_EDITMSG" } }] } },
		{ type: "message", timestamp: "2026-10-15T14:00:00Z", message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: true, content: [{ type: "text", text: "MEMBER_REFUSED: path is reserved" }] } },
	]));
	const custody = { source: "canonical-custody", status: "OWNED" }, message = "fix(owned): repair witnessed failure", digest = "a".repeat(64);
	put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
		{ ts: "2026-10-15T14:00:00Z", repo: f.alpha, attempt: id, event_id: id, act: "commit", gate: "MEMBER_REFUSED", kind: "refuse",
			replay: { version: 1, tool: "git-hook", arguments: { hook: "commit-msg", argv: [".git/COMMIT_EDITMSG"] }, cwd: f.alpha,
				staged_paths: ["src/owned.ts"], diff_sha256: digest, message, custody, redacted: false, truncated: false, missing: [] } },
	]));
	const report = await runMine(f.options), replay = report.classes[0]?.evidence[0]?.replay;
	expect(report.classes.map(c => [c.id, c.count])).toEqual([["commit-refusal:MEMBER_REFUSED", 1]]);
	expect(replay?.arguments).toEqual({ command: "git commit -F .git/COMMIT_EDITMSG" });
	expect(replay?.message).toBe(message);
	expect(replay?.custody).toEqual(custody);
	expect(replay?.staged_paths).toEqual(["src/owned.ts"]);
	expect(replay?.diff_sha256).toBe(digest);
	expect(replay?.missing).not.toContain("message");
});

test("MINEDEFECTS resumable source cells deduplicate by event id and keep distinct CC errors", async () => {
	const f = fixture(false), id = "shared-resume-guard";
	const originalInput = { timeout: fixtureDeadlineS(30) };
	await quietGitProject(f.alpha); await quietGitProject(f.beta);
	put(join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-projects-alpha", "joined.jsonl"), jsonl([
		{ type: "session", id: "joined-resume", cwd: f.alpha },
		{ type: "message", timestamp: "2026-10-15T13:59:00Z", message: { role: "assistant", content: [{ type: "toolCall", id, name: "wait", arguments: originalInput }] } },
		{ type: "message", timestamp: "2026-10-15T14:00:00Z", message: { role: "toolResult", toolCallId: id, toolName: "wait", isError: true, content: [{ type: "text", text: "kit-flywheel-guard WAIT_REFUSED: this call uses the wait tool" }] } },
	]));
	put(join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl"), jsonl([
		{ ts: "2026-10-15T14:00:00Z", repo: f.alpha, event_id: id, attempt: id, act: "wait", gate: "WAIT_REFUSED", kind: "refuse" },
	]));
	put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl([
		envelope("normalized-same", f.alpha, "tool.call", { tool: "wait", tool_call_id: id, guard_decision: "deny", guard_rule: "WAIT_REFUSED" }),
		envelope("distinct-cc-failure", f.alpha, "tool.call", { tool: "bash", tool_call_id: "a-different-real-call", is_error: true, exit_code: 7 }),
	]));
	const options = { ...f.options, since: "2026-10-15", until: "2026-10-16", resumeDir: join(f.home, "mine-state") };
	const first = await runMine(options), second = await runMine(options);
	expect(first.classes.reduce((sum, c) => sum + c.count, 0)).toBe(2);
	expect(first.classes.find(c => c.id === "guard-friction:WAIT_REFUSED")?.count).toBe(1);
	expect(first.classes.flatMap(c => c.evidence).some(e => e.event_id === "a-different-real-call")).toBe(true);
	expect(second.classes).toEqual(first.classes);
	expect(second.ledger?.scanned).toBe(0);
});

test("MINEDEFECTS historical event citations never become executable firing proof", async () => {
	const f = fixture(false), source = join(f.home, ".local", "state", "omp-kit", "gate-events.jsonl");
	put(source, jsonl([{ ts: "2026-10-15T14:00:00Z", repo: f.alpha, event_id: "observation-not-proof",
		act: "wait", gate: "WAIT_REFUSED", kind: "refuse", proof_it_fires: `live case: ${source}:1` }]));
	const report = await runMine(f.options);
	expect(report.classes[0]?.proof_it_fires).toBeNull();
	expect(report.classes[0]?.evidence[0]?.citation).toBe(`${source}:1`);
	expect(report.classes[0]?.evidence[0]?.replay?.missing).toEqual(expect.arrayContaining(["arguments", "cwd", "message", "custody"]));
	expect(renderMine(report)).toContain("historical observations, not regression-test proof");
});

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
		expect(report.classes.map(c => c.id)).toEqual(["tool-error:unclassified", "reopened-bead", "rework", "commit-refusal:staged-imports", "slow-command:eval", "timeout:build"]);
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
		expect(report.occurrences).toEqual([]);
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
		expect(report.classes.map(c => c.id)).toEqual(["release-fail", "tool-error:unclassified"]);
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
		expect(report.classes.map(c => c.id)).toEqual(["guard-failure:observational-hook", "tool-error:unclassified"]);
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

	test("native transcripts cover pre-CC days and join normalized failures by retained call id", async () => {
		const f = fixture(), start = Date.parse("2026-10-20T12:00:00Z");
		put(join(f.cc, "spool", "session", "2026-10-20.jsonl"), jsonl([
			envelope("normalized", f.alpha, "tool.call", { tool: "bash", tool_call_id: "commit", is_error: true, start_ms: start, end_ms: start + 120_000 }, "2026-10-20T12:00:00Z"),
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

function nativeMessage(role: string, content: unknown, time: string, extra: object = {}) {
	return { type: "message", timestamp: time, message: { role, content, ...extra } };
}
function nativeCall(id: string, command: string, time: string, tokens?: number, title?: string) {
	return nativeMessage("assistant", [{ type: "toolCall", id, name: "bash", arguments: { command, ...(title ? { title } : {}) } }], time,
		tokens === undefined ? {} : { usage: { totalTokens: tokens } });
}
function nativeResult(id: string, body: string, time: string, failed = false) {
	return nativeMessage("toolResult", [{ type: "text", text: body }], time, { toolCallId: id, toolName: "bash", isError: failed });
}
function nativePath(f: { home: string }, name: string) {
	return join(f.home, ".omp", "profiles", "default", "agent", "sessions", "-projects-alpha", `${name}.jsonl`);
}

test("WASTEMINE1 three refused commits then landing is one episode with all reasons and recorded cost", async () => {
	const f = fixture(false), command = 'git commit -m "repair original acceptance"', source = nativePath(f, "retry");
	const rows: unknown[] = [{ type: "session", id: "retry", cwd: f.alpha }];
	const reasons = ["MEMBER_REFUSED: first missing import", "MEMBER_REFUSED: second wrong owner", "MEMBER_REFUSED: third stale witness"];
	for (let index = 0; index < 4; index++) {
		rows.push(nativeCall(`commit-${index}`, command, `2026-10-15T12:0${index * 2}:00Z`, 100, index === 2 ? "Retry repair" : "Commit repair"));
		rows.push(nativeResult(`commit-${index}`, index < 3 ? `${"M unrelated/status/path.ts\n".repeat(40)}${reasons[index]}` : "[main abcdef1234] repair original acceptance",
			`2026-10-15T12:0${index * 2 + 1}:00Z`, index < 3));
	}
	put(source, jsonl(rows));
	const before = snapshot(f.home), report = await scanMine({ ...f.options, sources: ["transcripts"], lookupBeads: false });
	expect(snapshot(f.home)).toBe(before);
	const episodes = report.occurrences.filter(row => row.waste?.kind === "commit-retries");
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.waste?.attempts).toBe(3);
	expect(episodes[0]?.waste?.causes).toEqual(reasons);
	expect(episodes[0]?.waste?.cost).toEqual({ rounds: 3, minutes: 7, tokens: 400 });
	expect(episodes[0]?.related_evidence).toHaveLength(3);
	expect(episodes[0]?.waste?.counterfactual).toContain("first missing import");
	expect(report.waste_classes[0]?.id).toBe("waste:commit-retries");
	expect(renderMine(report)).toContain("Top 10 waste classes by cost");
});

test("WASTEMINE1 async completion joins original commit, spans midnight, and does not count a successful quotation", async () => {
	const f = fixture(false), source = nativePath(f, "async-retry"), command = 'git commit -m "async repair"';
	put(source, jsonl([
		{ type: "session", id: "async-retry", cwd: f.alpha },
		nativeCall("async-1", command, "2026-10-14T23:58:00Z"),
		nativeResult("async-1", "Backgrounded as bg_7", "2026-10-14T23:58:01Z"),
		{ type: "custom_message", customType: "async-result", timestamp: "2026-10-14T23:59:00Z",
			content: "Background job bg_7 has completed\nMEMBER_REFUSED: missing acceptance witness" },
		nativeCall("async-2", command, "2026-10-15T00:01:00Z"),
		nativeResult("async-2", "[main abcdef7654] async repair\nOld diagnostic REFUSED quoted in commit text", "2026-10-15T00:02:00Z"),
		nativeCall("unrelated-read", "git log --oneline", "2026-10-15T00:03:00Z"),
		nativeResult("unrelated-read", "[main abcdef7654] search REFUSED", "2026-10-15T00:04:00Z"),
	]));
	const options = { ...f.options, since: "2026-10-15", until: "2026-10-16", sources: ["transcripts"] as const, lookupBeads: false };
	const report = await scanMine(options), episodes = report.occurrences.filter(row => row.waste);
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.waste?.attempts).toBe(1);
	expect(episodes[0]?.waste?.cost).toEqual({ rounds: 1, minutes: 4, tokens: null });
	expect(episodes[0]?.related_evidence[0]?.citation).toBe(`${source}:4`);
});

test("WASTEMINE1 native bead rework to review twice preserves two causes, not same-day coalescing", async () => {
	const f = fixture(false), bead = "alpha-repair", history = join(f.alpha, ".beads", ".br_history");
	const states = [
		{ status: "in_review", updated_at: "2026-10-15T10:00:00Z" },
		{ status: "rework", updated_at: "2026-10-15T10:01:00Z", reason: "wrong producer fixture" },
		{ status: "in_review", updated_at: "2026-10-15T10:11:00Z" },
		{ status: "rework", updated_at: "2026-10-15T10:12:00Z", reason: "missing mobile acceptance" },
		{ status: "in_review", updated_at: "2026-10-15T10:32:00Z" },
	];
	for (const [index, state] of states.entries()) put(join(history, `issues.20261015_10000${index}_000000000.jsonl`), jsonl([{ id: bead, ...state }]));
	put(join(f.alpha, ".beads", "issues.jsonl"), jsonl([{ id: bead, ...states.at(-1) }]));
	const before = snapshot(f.home), report = await scanMine({ ...f.options, sources: ["tracker"], lookupBeads: false });
	expect(snapshot(f.home)).toBe(before);
	const episodes = report.occurrences.filter(row => row.waste?.kind === "rework-rounds");
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.waste?.rework_rounds).toBe(2);
	expect(episodes[0]?.waste?.causes).toEqual(["wrong producer fixture", "missing mobile acceptance"]);
	expect(episodes[0]?.waste?.cost).toEqual({ rounds: 2, minutes: 30, tokens: null });
	expect(episodes[0]?.waste?.counterfactual).toContain("missing mobile acceptance");
});

test("WASTEMINE1 normalized transitions deduplicate archive/live but preserve repeated rounds", async () => {
	const f = fixture(false), rows = [
		{ ...envelope("r1", f.alpha, "bead.status", { from_status: "in_review", to_status: "rework", cause: "wrong scope" }, "2026-10-15T12:00:00Z"), bead: "alpha-1" },
		{ ...envelope("v1", f.alpha, "bead.status", { from_status: "rework", to_status: "in_review" }, "2026-10-15T12:10:00Z"), bead: "alpha-1" },
		{ ...envelope("r2", f.alpha, "bead.status", { from_status: "in_review", to_status: "rework", cause: "missing real service" }, "2026-10-15T12:11:00Z"), bead: "alpha-1" },
		{ ...envelope("v2", f.alpha, "bead.status", { from_status: "rework", to_status: "in_review" }, "2026-10-15T12:31:00Z"), bead: "alpha-1" },
	];
	put(join(f.cc, "spool", "session", "2026-10-15.jsonl"), jsonl(rows));
	put(join(f.cc, "spool-archive", "session", "2026-10-15.jsonl.gz"), gzipSync(jsonl(rows)));
	const report = await scanMine({ ...f.options, sources: ["cc"], lookupBeads: false });
	expect(report.occurrences.find(row => row.waste)?.waste?.rework_rounds).toBe(2);
	expect(report.occurrences.find(row => row.waste)?.waste?.cost.minutes).toBe(30);
});

test("WASTEMINE1 corrections join an agent brief until DONE; wake retries and owner decisions do not inflate rounds", async () => {
	const f = fixture(false), mail = join(f.home, ".local", "state", "omp-kit", "mail-wake.jsonl");
	const correction = { ts: "2026-10-15T12:00:00Z", message_id: 1, project_key: f.alpha, sender: "Lead", recipient: "Worker", brief_id: "brief-1", subject: "CORRECTION alpha-1 do not edit exports" };
	put(mail, jsonl([correction, { ...correction, status: "WOKEN_INPROCESS" },
		{ ...correction, message_id: 2, ts: "2026-10-15T12:01:00Z", subject: "REWORK alpha-1 use fixtureDeadlineS" },
		{ ...correction, message_id: 3, ts: "2026-10-15T12:05:00Z", sender: "Worker", recipient: "Lead", subject: "DONE alpha-1" },
		{ ...correction, message_id: 4, subject: "PROGRESS alpha-1 documents explain REWORK" },
	]));
	const ownerCorrections = join(f.home, "owner-corrections.jsonl");
	put(ownerCorrections, jsonl([
		{ id: "J-correction", at: "2026-10-15T12:02:00Z", date: "2026-10-14", said: "Why did you halt for work you own?", rule: "Analyze and land owned work instead of waiting." },
		{ id: "J-boundary", at: "2026-11-01T00:00:00Z", date: "2026-10-15", said: "Why wait?", rule: "Act." },
		{ id: "J-decision", at: "2026-10-15T12:03:00Z", said: "Thank you", rule: "Keep going." },
	]));
	const report = await scanMine({ ...f.options, env: { ...f.options.env, OMP_KIT_OWNER_CORRECTIONS_PATH: ownerCorrections }, sources: ["transcripts"], lookupBeads: false });
	const brief = report.occurrences.find(row => row.waste?.kind === "brief-corrections");
	expect(brief?.waste?.correction_messages).toBe(2);
	expect(brief?.waste?.cost).toEqual({ rounds: 2, minutes: 5, tokens: null });
	expect(brief?.waste?.counterfactual).toContain("do not edit exports");
	const owners = report.occurrences.filter(row => row.waste?.kind === "owner-correction");
	expect(owners).toHaveLength(1);
	expect(owners[0]?.project).toBe("@unattributed");
	expect(owners[0]?.waste?.counterfactual).toBe("Analyze and land owned work instead of waiting.");
	expect(owners[0]?.waste?.cost).toEqual({ rounds: 1, minutes: null, tokens: null });
});

test("WASTEMINE1 bounded long command near-miss remains quiet in the shipping Bun matcher", async () => {
	const f = fixture(false), start = performance.now();
	put(nativePath(f, "long-near-miss"), jsonl([
		{ type: "session", id: "long-near-miss", cwd: f.alpha },
		nativeCall("near-miss", `git ${" ".repeat(65_536)}commix`, "2026-10-15T12:00:00Z"),
		nativeResult("near-miss", `[${"[".repeat(65_536)} abcdefg]`, "2026-10-15T12:01:00Z"),
	]));
	const report = await scanMine({ ...f.options, sources: ["transcripts"], lookupBeads: false });
	expect(report.occurrences.filter(row => row.waste)).toEqual([]);
	expect(performance.now() - start).toBeLessThan(fixtureDeadlineS(10) * 1000);
});

test("WASTEMINE1 delivered task-brief correction is counted but a failed send and quoted user text are not", async () => {
	const f = fixture(false), source = nativePath(f, "direct-brief");
	put(source, jsonl([
		{ type: "session", id: "direct-brief", cwd: f.alpha },
		nativeMessage("assistant", [{ type: "toolCall", id: "dispatch-1", name: "task",
			arguments: { tasks: [{ name: "Builder", task: "Repair the original requirement" }] } }], "2026-10-15T12:00:00Z"),
		nativeMessage("assistant", [{ type: "toolCall", id: "correction-1", name: "write",
			arguments: { path: "agent://Builder", content: "Correction: do not edit exports; consume the native tracker." } }], "2026-10-15T12:01:00Z"),
		nativeMessage("toolResult", [{ type: "text", text: "Delivered to Builder." }], "2026-10-15T12:01:01Z", { toolCallId: "correction-1", toolName: "write" }),
		nativeMessage("assistant", [{ type: "toolCall", id: "correction-failed", name: "write",
			arguments: { path: "agent://Builder", content: "REWORK wrong fixture" } }], "2026-10-15T12:02:00Z"),
		nativeMessage("toolResult", [{ type: "text", text: "Failed: unknown agent" }], "2026-10-15T12:02:01Z", { toolCallId: "correction-failed", toolName: "write", isError: true }),
		nativeMessage("user", "The documentation explains correction messages.", "2026-10-15T12:03:00Z"),
	]));
	put(nativePath(f, "copied-direct-brief"), readFileSync(source, "utf8").replace('"id":"direct-brief"', '"id":"copied-direct-brief"'));
	const report = await scanMine({ ...f.options, sources: ["transcripts"], lookupBeads: false });
	const episodes = report.occurrences.filter(row => row.waste?.kind === "brief-corrections");
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.waste?.subject).toBe("dispatch-1:Builder");
	expect(episodes[0]?.waste?.correction_messages).toBe(1);
	expect(episodes[0]?.waste?.cost).toEqual({ rounds: 1, minutes: null, tokens: null });
	expect(episodes[0]?.summary).toContain("DONE endpoint not retained");
});

test("WASTEMINE1 resumable UTC cells retain rework rounds across days and owner corrections without invented project scope", async () => {
	const f = fixture(false), bead = "alpha-crossday", ownerCorrections = join(f.home, "owner-corrections.jsonl");
	await quietGitProject(f.alpha); await quietGitProject(f.beta);
	const states = [
		{ status: "in_review", updated_at: "2026-10-15T10:00:00Z" },
		{ status: "rework", updated_at: "2026-10-15T10:01:00Z", reason: "first witness" },
		{ status: "in_review", updated_at: "2026-10-15T10:11:00Z" },
		{ status: "rework", updated_at: "2026-10-16T10:01:00Z", reason: "second witness" },
		{ status: "in_review", updated_at: "2026-10-16T10:21:00Z" },
	];
	for (const [index, state] of states.entries()) put(join(f.alpha, ".beads", ".br_history", `issues.${index < 3 ? "20261015" : "20261016"}_10000${index}_000000000.jsonl`), jsonl([{ id: bead, ...state }]));
	put(join(f.alpha, ".beads", "issues.jsonl"), jsonl([{ id: bead, ...states.at(-1) }]));
	put(ownerCorrections, jsonl([{ id: "J-1", at: "2026-10-15T12:00:00Z", said: "Why wait?", rule: "Dispatch ready work." }]));
	const options = { ...f.options, since: "2026-10-15", until: "2026-10-17", resumeDir: join(f.home, "resume"),
		env: { ...f.options.env, OMP_KIT_OWNER_CORRECTIONS_PATH: ownerCorrections } };
	const report = await runMine(options), again = await runMine(options);
	const rework = report.occurrences.filter(row => row.waste?.kind === "rework-rounds");
	expect(rework).toHaveLength(1);
	expect(rework[0]?.waste?.rework_rounds).toBe(2);
	expect(rework[0]?.waste?.cost.minutes).toBe(30);
	expect(rework[0]?.waste?.causes).toEqual(["first witness", "second witness"]);
	expect(report.occurrences.filter(row => row.waste?.kind === "owner-correction")).toHaveLength(1);
	expect(again.occurrences).toEqual(report.occurrences);
	expect(again.waste_classes).toEqual(report.waste_classes);
});

test("WASTEMINE1 explicitly selected coordinator sessions retain unknown repository ownership and stable deduplication", async () => {
	const f = fixture(false), source = join(f.home, "coordinator.jsonl"), command = 'git commit -m "coordinator repair"';
	put(source, jsonl([
		{ type: "session", id: "coordinator", cwd: join(f.home, "workspace") },
		nativeCall("coordinator-refused", command, "2026-10-15T12:00:00Z"),
		nativeResult("coordinator-refused", "MEMBER_REFUSED: missing original witness", "2026-10-15T12:01:00Z", true),
		nativeCall("coordinator-landed", command, "2026-10-15T12:02:00Z"),
		nativeResult("coordinator-landed", "[main 1234abcdef] coordinator repair", "2026-10-15T12:03:00Z"),
	]));
	const copy = join(f.home, "copied-coordinator.jsonl");
	put(copy, readFileSync(source, "utf8").replace('"id":"coordinator"', '"id":"copied-coordinator"'));
	const report = await scanMine({ ...f.options, env: { ...f.options.env, OMP_KIT_MINE_SESSION_ROOTS: [source, copy, source].join(delimiter) }, sources: ["transcripts"], lookupBeads: false });
	const episodes = report.occurrences.filter(row => row.waste?.kind === "commit-retries");
	expect(episodes).toHaveLength(1);
	expect(episodes[0]?.project).toBe("@unattributed");
	expect(episodes[0]?.waste?.attempts).toBe(1);
	expect(episodes[0]?.waste?.cost.minutes).toBe(3);
	expect(episodes[0]?.citation).toBe(`${source}:5`);
	const scoped = await scanMine({ ...f.options, all: false, project: f.alpha, env: { ...f.options.env, OMP_KIT_MINE_SESSION_ROOTS: source }, sources: ["transcripts"], lookupBeads: false });
	expect(scoped.occurrences).toEqual([]);
});

test("WASTEMINE1 long export paths keep bounded class reports resumable and recover to quiet", async () => {
	const f = fixture(false), home = join(f.home, "long-export-root".repeat(7)), project = join(home, "projects", "alpha");
	mkdirSync(project, { recursive: true });
	await quietGitProject(project);
	put(join(home, ".config", "omp-kit", "fleet-watch.json"), JSON.stringify({ sessions: [{ session: "alpha", repo: project }] }));
	const source = join(home, ".omp", "profiles", "default", "agent", "sessions", "-projects-alpha", "native.jsonl");
	const header = { type: "session", id: "long-export-bound", cwd: project };
	put(source, jsonl([header, ...Array.from({ length: 2050 }, (_, index) =>
		nativeResult(`bounded-${index}`, `AssertionError: distinct cause ${index}`, "2026-10-15T12:00:00Z", true))]));
	const options: MineOptions = { since: "2026-10-15", until: "2026-10-16", all: true, home, cwd: project,
		env: { HOME: home, PATH: process.env.PATH ?? "" }, resumeDir: join(f.home, "long-export-state") };
	const first = await runMine(options), reopened = await runMine(options);
	expect(first.status).toBe("PARTIAL");
	expect(first.classes).toHaveLength(2048);
	expect(first.occurrences).toHaveLength(2048);
	expect(first.waste_classes).toHaveLength(2048);
	expect(first.ledger?.cells.some(cell => cell.status === "PARTIAL" && cell.reasons.some(reason => reason.includes("Class limit reached (2048)")))).toBe(true);
	expect(reopened.classes).toEqual(first.classes);
	expect(reopened.occurrences).toEqual(first.occurrences);
	expect(reopened.waste_classes).toEqual(first.waste_classes);
	put(source, jsonl([header, nativeResult("quiet", "Completed successfully", "2026-10-15T12:00:00Z")]));
	const quiet = await runMine(options), quietReopened = await runMine(options);
	expect(quiet.ledger?.totals.PARTIAL).toBe(0);
	expect(quiet.classes).toEqual([]);
	expect(quiet.occurrences).toEqual([]);
	expect(quiet.waste_classes).toEqual([]);
	expect(quietReopened.ledger?.scanned).toBe(0);
	expect(quietReopened.waste_classes).toEqual([]);
});

for (const withWasteProjection of [false, true]) test(`WASTEMINE1 resumes legacy receipts with ${withWasteProjection ? "both cached class projections" : "cached classes only"}`, async () => {
	const f = fixture(false), source = nativePath(f, "legacy-receipt");
	await quietGitProject(f.alpha); await quietGitProject(f.beta);
	// Minimized/redacted from retained v1 cell 18eb79fdc354719ca4a75d63604f2055121be3bd404287c69c1fc000b6c2199a:
	// preserve its recorded timeout observation and replay envelope; replace machine paths, arguments and call identity.
	const finding = {
		class_id: "timeout:glob", project: f.alpha, time_ms: 1793672207314, producer: "omp-transcript",
		citation: "redacted/session.jsonl:39",
		summary: "Glob timed out after 5s before finding any matches — the scan is incomplete, NOT proof of absence. The walk is bounded by directory size, not pattern width; scope the search to a deeper directory (e.g. `sub/dir/*.ext` instead of `*.ext` at a huge root).",
		measured_minutes: null, proxy_minutes: 0, identity: "legacy-timeout-glob", event_id: "legacy-timeout-glob",
		replay: { version: 1, tool: "glob", arguments: { path: "redacted/**/*.ts" }, cwd: f.alpha, staged_paths: null,
			diff_sha256: null, message: null, custody: null, redacted: true, truncated: false,
			missing: ["staged_paths", "diff_sha256", "message", "custody"] },
	};
	put(source, jsonl([{ type: "session", id: "legacy-receipt", cwd: f.alpha },
		nativeMessage("toolResult", [{ type: "text", text: finding.summary }], "2026-11-03T02:16:47.314Z",
			{ toolCallId: finding.event_id, toolName: "glob", isError: true })]));
	const options = { ...f.options, since: "2026-11-03", until: "2026-11-04", resumeDir: join(f.home, "legacy-state") };
	const first = await runMine(options), manifestPath = first.ledger!.path, directory = dirname(manifestPath);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const entry = Object.entries<string>(manifest.entries).map(([key, digest]) =>
		({ key, cell: JSON.parse(readFileSync(join(directory, `${digest}.json`), "utf8")) }))
		.find(row => row.cell.project === f.alpha && row.cell.source === "transcripts")!;
	const legacy = { ...entry.cell, result: {
		report: { ...entry.cell.result.report, classes: first.classes.map(row => ({ ...row, count: 999 })),
			...(withWasteProjection ? { waste_classes: first.waste_classes.map(row => ({ ...row, count: 999, cost: { ...row.cost, rounds: 999 } })) } : {}) },
		findings: [finding],
	} };
	const bytes = JSON.stringify(legacy), digest = createHash("sha256").update(bytes).digest("hex");
	writeFileSync(join(directory, `${digest}.json`), bytes, { mode: 0o600 });
	manifest.entries[entry.key] = digest;
	put(manifestPath, JSON.stringify(manifest));
	const resumed = await runMine(options);
	expect(resumed.ledger?.scanned).toBe(0); // Read the old shape; rescanning would conceal a compatibility failure.
	expect(resumed.ledger?.reused).toBe(first.ledger?.scanned);
	expect(resumed.classes.map(row => [row.id, row.count])).toEqual([["timeout:glob", 1]]);
	expect(resumed.waste_classes.map(row => [row.id, row.count, row.cost.rounds])).toEqual([["timeout:glob", 1, 1]]);
	expect(resumed.occurrences).toHaveLength(1);
	expect(resumed.occurrences[0]?.event_id).toBe(finding.event_id);
	expect(resumed.occurrences[0]?.citation).toBe(finding.citation);
	expect(resumed.occurrences[0]?.replay).toEqual(finding.replay);
});
