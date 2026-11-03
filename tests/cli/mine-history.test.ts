import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mineHistory } from "../../src/mine-history.ts";
import type { MineCoverage, MineSourceContext, MineSourceFinding } from "../../src/mine.ts";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

let scratch = "", serial = 0;
beforeAll(() => {
	// kitlib owns the temp dir and removes it on exit; no installed kit or native CLI needed (gate-hermetic).
	scratch = realpathSync(ownedTmp("mine-history-tests").path);
});
afterAll(cleanupAllOwnedTmp);
function put(path: string, content: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function jsonl(rows: readonly unknown[]): string { return rows.map(row => JSON.stringify(row)).join("\n") + "\n"; }
async function git(cwd: string, args: string[], input?: string, date?: string): Promise<string> {
	if (!scratch || !cwd.startsWith(`${scratch}/`)) throw new Error("git fixture mutations require owned scratch");
	const env: Record<string, string> = { OMP_KIT_CC: "0" };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	env.OMP_KIT_CC = "0";
	env.GIT_AUTHOR_NAME = "History fixture"; env.GIT_AUTHOR_EMAIL = "fixture@example.invalid";
	env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME; env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
	if (date) { env.GIT_AUTHOR_DATE = date; env.GIT_COMMITTER_DATE = date; }
	const result = await run(["nice", "-n", "10", "git", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], { deadline_s: 10, env, stdin: input });
	if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(`fixture git ${args[0]} failed: ${new TextDecoder().decode(result.stderr)}`);
	return new TextDecoder().decode(result.stdout).trim();
}
function fixture() {
	const home = join(scratch, `fixture-${++serial}`), project = join(home, "project");
	mkdirSync(project, { recursive: true });
	return { home, project };
}
function snapshot(root: string): string {
	const files: string[] = [];
	function visit(directory: string) {
		for (const e of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, e.name);
			if (e.isDirectory()) visit(path);
			else if (e.isFile()) files.push(`${path}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	}
	visit(root); return files.join("\n");
}
function context(home: string, paths: string[]) {
	const findings: MineSourceFinding[] = [], coverage: MineCoverage[] = [], sources: { project: string; producer: string; rows: number }[] = [];
	const childEnv: Record<string, string> = { OMP_KIT_CC: "0" };
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) childEnv[key] = value;
	childEnv.OMP_KIT_CC = "0";
	const ctx: MineSourceContext = {
		home, projects: paths.map(path => ({ name: path.split("/").at(-1) ?? path, path })),
		since_ms: Date.parse("2026-10-01T00:00:00Z"), until_ms: Date.parse("2026-11-01T00:00:00Z"),
		emit: row => { findings.push(row); }, markSource: (project, producer, rows) => { sources.push({ project, producer, rows }); },
		coverage: (producer, location, detail = "") => {
			const row: MineCoverage = { producer, location, detail, status: "READ", rows: 0, first_timestamp: null, last_timestamp: null };
			coverage.push(row); return row;
		},
		// Real source-format files are decoded through the adapter's declared streaming-reader seam.
		readLines: async (path, producer, consume) => {
			const cov = ctx.coverage(producer, path);
			if (!existsSync(path)) { cov.status = "MISSING"; return cov; }
			if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) { cov.status = "PARTIAL"; return cov; }
			const rows = readFileSync(path, "utf8").split("\n");
			if (rows.pop()?.trim()) cov.status = "PARTIAL";
			for (let i = 0; i < rows.length; i++) {
				const raw = rows[i]; if (!raw?.trim()) continue;
				try {
					const row: unknown = JSON.parse(raw);
					if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("object required");
					cov.rows++; consume(row as Record<string, unknown>, `${path}:${i + 1}`);
				} catch { cov.status = "PARTIAL"; }
			}
			return cov;
		},
		command: async (argv, cwd, deadlineSeconds = 3, outputBytes = 1024 * 1024) => {
			const result = await run(["nice", "-n", "10", ...argv], { cwd, env: childEnv, deadline_s: deadlineSeconds, grace_s: 0.1, max_output_bytes: outputBytes });
			return result.rc === 0 && !result.timed_out && !result.truncated ? new TextDecoder().decode(result.stdout).trim() : null;
		},
		expired: () => false, warn: () => { throw new Error("unexpected warning"); },
	};
	return { ctx, findings, coverage, sources };
}
function issue(id: string, status: string, updated_at: string) {
	return { id, title: `Issue ${id}`, status, priority: 2, issue_type: "task", created_at: "2026-09-01T00:00:00Z", updated_at };
}
function history(project: string, stamp: string, rows: unknown[]): string {
	const path = join(project, ".beads", ".br_history", `issues.${stamp}.jsonl`); put(path, jsonl(rows)); return path;
}
async function init(project: string): Promise<void> { await git(project, ["init", "-q"]); }
async function commit(project: string, subject: string, date: string, parent?: string): Promise<string> {
	const tree = await git(project, ["mktree"], "");
	return git(project, ["commit-tree", tree, ...(parent ? ["-p", parent] : [])], `${subject}\n`, date);
}

describe("mineHistory native sources", () => {
	test("retained baseline yields dated rework/reopen/blocked diffs, not repeated snapshot or current status counts", async () => {
		const f = fixture();
		const baseline = [issue("p-reopen", "closed", "2026-09-28T12:00:00Z"), issue("p-rework", "in_review", "2026-09-28T12:00:00Z"), issue("p-block", "open", "2026-09-28T12:00:00Z"), issue("p-quiet", "rework", "2026-09-28T12:00:00Z")];
		history(f.project, "20260928_130000_000000000", baseline);
		const changed = [issue("p-reopen", "open", "2026-10-03T12:00:00Z"), { ...issue("p-rework", "rework", "2026-10-04T12:00:00Z"), comments: [{ id: 7, issue_id: "p-rework", text: "VERDICT: REWORK original acceptance failed", created_at: "2026-10-04T12:00:00Z" }] }, issue("p-block", "blocked", "2026-10-05T12:00:00Z"), baseline[3]];
		const changedPath = history(f.project, "20261006_130000_000000000", changed);
		history(f.project, "20261007_130000_000000000", changed);
		put(join(f.project, ".beads", "issues.jsonl"), jsonl(changed));
		const before = snapshot(f.home), result = context(f.home, [f.project]);
		await mineHistory(result.ctx);
		expect(snapshot(f.home)).toBe(before);
		expect(result.findings.map(r => r.class_id).sort()).toEqual(["bead-blocked", "reopened-bead", "rework"]);
		expect(result.findings.find(r => r.class_id === "reopened-bead")?.identity).toBe(`reopen:${f.project}:p-reopen:2026-10-03`);
		expect(result.findings.find(r => r.class_id === "bead-blocked")?.identity).toBe(`blocked:${f.project}:p-block:2026-10-05`);
		expect(result.findings.find(r => r.class_id === "rework")?.identity).toBe(`rework:${f.project}:p-rework:2026-10-04`);
		expect(result.findings.find(r => r.class_id === "reopened-bead")?.summary).toContain("Snapshot inference");
		expect(result.findings.find(r => r.class_id === "reopened-bead")?.citation).toBe(`${changedPath}:1`);
		expect(result.sources.some(s => s.producer === "bead history snapshots" && s.rows > 0)).toBe(true);
	});

	test("current state alone and first-seen blocked/rework issues are quiet; dated comment at until excluded", async () => {
		const f = fixture();
		const rows = [issue("p-one", "rework", "2026-10-06T12:00:00Z"), issue("p-two", "blocked", "2026-10-06T12:00:00Z"), { ...issue("p-prose", "open", "2026-10-06T12:00:00Z"), comments: [{ id: 1, text: "The docs explain REWORK and reopen failures", created_at: "2026-10-06T12:00:00Z" }, { id: 2, text: "REWORK boundary", created_at: "2026-11-01T00:00:00Z" }] }];
		history(f.project, "20261006_130000_000000000", rows);
		put(join(f.project, ".beads", "issues.jsonl"), jsonl(rows));
		const result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(result.findings).toEqual([]);
		const onlyCurrent = fixture(); put(join(onlyCurrent.project, ".beads", "issues.jsonl"), jsonl(rows));
		const current = context(onlyCurrent.home, [onlyCurrent.project]); await mineHistory(current.ctx);
		expect(current.findings).toEqual([]);
		expect(current.coverage.some(c => c.producer === "bead history snapshots" && c.status === "MISSING")).toBe(true);
	});

	test("shared tracker symlinks and copied snapshots coalesce on configured source project", async () => {
		const f = fixture(), shared = join(f.home, "shared"), copy = join(f.home, "copy");
		mkdirSync(shared); mkdirSync(copy);
		const old = [{ ...issue("p-one", "closed", "2026-09-28T12:00:00Z"), source_repo_path: f.project }];
		const changed = [{ ...issue("p-one", "open", "2026-10-04T12:00:00Z"), source_repo_path: f.project }];
		for (const target of [f.project, copy]) {
			history(target, "20260928_130000_000000000", old); history(target, "20261005_130000_000000000", changed);
			put(join(target, ".beads", "issues.jsonl"), jsonl(changed));
		}
		symlinkSync(join(f.project, ".beads"), join(shared, ".beads"));
		const result = context(f.home, [shared, f.project, copy]); await mineHistory(result.ctx);
		expect(result.findings).toHaveLength(1); expect(result.findings[0]?.project).toBe(f.project);
		expect(result.coverage.some(c => c.detail.startsWith("Shared tracker"))).toBe(true);
	});

	test("malformed snapshot cannot become a baseline, and undated changed statuses stay unknown", async () => {
		const f = fixture();
		history(f.project, "20260928_130000_000000000", [issue("p-one", "closed", "2026-09-28T12:00:00Z"), issue("p-undated", "open", "2026-09-28T12:00:00Z")]);
		put(join(f.project, ".beads", ".br_history", "issues.20261003_130000_000000000.jsonl"), `${jsonl([issue("p-one", "open", "2026-10-03T12:00:00Z")])}broken-json\n`);
		const final = [issue("p-one", "open", "2026-10-04T12:00:00Z"), issue("p-undated", "blocked", "not-a-date")];
		const finalPath = history(f.project, "20261005_130000_000000000", final);
		put(join(f.project, ".beads", "issues.jsonl"), jsonl(final));
		const result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(result.findings).toHaveLength(1); expect(result.findings[0]?.citation).toBe(`${finalPath}:1`);
		expect(result.coverage.some(c => c.status === "PARTIAL" && c.detail.includes("baseline"))).toBe(true);
		expect(result.coverage.some(c => c.detail.includes("unknown"))).toBe(true);
	});

	test("real git objects supply exact SHA citations, committer window, correction declarations and no writes", async () => {
		const f = fixture(); await init(f.project);
		const beforeWindow = await commit(f.project, 'Revert "before window"', "2026-09-30T23:59:59Z");
		const atStart = await commit(f.project, 'Revert "bad change"', "2026-10-01T00:00:00Z", beforeWindow);
		const quiet = await commit(f.project, "docs: document Revert and Supersedes examples", "2026-10-03T00:00:00Z", atStart);
		const supersedes = await commit(f.project, `fix: replace invalid gate\n\nSupersedes: ${atStart}`, "2026-10-05T00:00:00Z", quiet);
		const end = await commit(f.project, 'Revert "at until"', "2026-11-01T00:00:00Z", supersedes);
		await git(f.project, ["update-ref", "refs/heads/history", end]);
		const before = snapshot(f.home), result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(snapshot(f.home)).toBe(before);
		expect(result.findings.map(r => r.class_id).sort()).toEqual(["git-revert", "git-supersedes"]);
		expect(result.findings.find(r => r.class_id === "git-revert")?.citation).toBe(`${f.project}#git:${atStart}`);
		expect(result.findings.find(r => r.class_id === "git-supersedes")?.citation).toBe(`${f.project}#git:${supersedes}`);
		expect(result.coverage.find(c => c.producer === "git correction commits")?.rows).toBe(3);
	});

	test("gitdir pointer resolves real audit files and nested non-root refuses ancestor incidents", async () => {
		const f = fixture(), storage = join(f.home, "git-storage");
		await git(f.project, ["init", "-q", "--separate-git-dir", storage]);
		const sha = await commit(f.project, 'Revert "bad change"', "2026-10-03T00:00:00Z"); await git(f.project, ["update-ref", "refs/heads/history", sha]);
		put(join(storage, "omp-kit", "fresh-gate-runs.jsonl"), jsonl([{ ts: "2026-10-03T01:00:00Z", commit: sha, base: "a".repeat(40), changed: 1, selected_files: 1, tests_ran: 1, rc: 1 }]));
		const nested = join(f.project, "not-a-repo"); mkdirSync(nested);
		const nestedResult = context(f.home, [nested]); await mineHistory(nestedResult.ctx);
		expect(nestedResult.findings).toEqual([]);
		expect(nestedResult.coverage.some(c => c.status === "PARTIAL" && c.detail.includes("Ancestor"))).toBe(true);
		const rootResult = context(f.home, [f.project]); await mineHistory(rootResult.ctx);
		expect(rootResult.findings.map(r => r.class_id).sort()).toEqual(["gate-failure:fresh-gate", "git-revert"]);
		expect(rootResult.findings.find(r => r.class_id === "gate-failure:fresh-gate")?.citation).toBe(`${storage}/omp-kit/fresh-gate-runs.jsonl:1`);
	});

	test("native fresh-gate, hook refusals and timestamped release logs fire; passes/prose/undated lines do not", async () => {
		const f = fixture(); await init(f.project);
		const logs = join(f.project, ".git", "omp-kit"), ts = "2026-10-06T12:00:00Z";
		const failed = { ts, commit: "a".repeat(40), base: "b".repeat(40), changed: 1, selected_files: 1, tests_ran: 1, rc: 1 };
		put(join(logs, "fresh-gate-runs.jsonl"), jsonl([failed, { ...failed, rc: 0 }, { ...failed, ts: "2026-11-01T00:00:00Z" }]));
		put(join(logs, "fresh-gate-runs.jsonl.1"), jsonl([failed]));
		put(join(logs, "hook-refusals.jsonl"), jsonl([{ ts, event_id: "deny-1", act: "commit", gate: "acceptance", kind: "refuse" }, { ts, event_id: "quiet-1", act: "commit", gate: "quiet", kind: "pass", text: "REWORK FAIL refused" }, { kind: "refuse", gate: "undated" }]));
		put(join(logs, "release-verdict.log"), `${ts} FULL-SUITE: VERDICT FAIL tree=${"c".repeat(40)}\nFULL-SUITE: VERDICT FAIL undated\n${ts} docs: example FULL-SUITE: VERDICT FAIL\n${ts} release: PASS\n`);
		utimesSync(join(logs, "release-verdict.log"), new Date(ts), new Date(ts));
		const before = snapshot(f.home), result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(snapshot(f.home)).toBe(before);
		expect(result.findings.map(r => r.class_id).sort()).toEqual(["commit-refusal:acceptance", "gate-failure:fresh-gate", "release-fail"]);
		expect(result.findings.find(r => r.class_id === "gate-failure:fresh-gate")?.measured_minutes).toBeNull();
		expect(result.findings.find(r => r.class_id === "release-fail")?.citation).toBe(`${logs}/release-verdict.log:1`);
		expect(result.coverage.some(c => c.status === "PARTIAL" && c.detail.includes("Undated"))).toBe(true);
	});

	test("structured release verdict reuses identity; credentials redacted before 400-character summary bound", async () => {
		const f = fixture(); await init(f.project);
		const ts = "2026-10-06T12:00:00Z", tree = "a".repeat(40), checks = "b".repeat(64);
		const credential = "ghp_" + "A".repeat(32);
		put(join(f.project, ".git", "omp-kit", "release-audit.jsonl"), jsonl([{ recorded_at: ts, verdict: "FAIL", tree, checks, timing: { wall_ms: 120_000 }, commit: credential }]));
		put(join(f.project, ".git", "omp-kit", "release-verdict.log"), `${ts} release: FAIL authorization=Bearer ${credential} ${"x".repeat(10_000)}\n`);
		const result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(result.findings).toHaveLength(2);
		expect(result.findings.some(r => r.identity === `verdict:${f.project}:${tree}:${checks}:${Date.parse(ts)}` && r.measured_minutes === 2)).toBe(true);
		expect(result.findings.every(r => r.summary.length <= 400 && !r.summary.includes(credential))).toBe(true);
	});

	test("large reject prose stays quiet, explicit-zone timestamp is required, symlink logs are partial", async () => {
		const f = fixture(); await init(f.project);
		const logs = join(f.project, ".git", "omp-kit"), outside = join(f.home, "not-a-log.jsonl");
		put(join(logs, "release-verdict.log"), `2026-10-06T12:00:00Z docs: ${"release: FAIL ".repeat(8192)}\n2026-10-06T12:00:00 release: FAIL missing-zone\n`);
		put(outside, jsonl([{ ts: "2026-10-06T12:00:00Z", kind: "refuse", gate: "outside" }]));
		symlinkSync(outside, join(logs, "hook-refusals.jsonl"));
		const result = context(f.home, [f.project]); await mineHistory(result.ctx);
		expect(result.findings).toEqual([]);
		expect(result.coverage.find(c => c.location === join(logs, "release-verdict.log"))?.rows).toBe(2);
		expect(result.coverage.some(c => c.status === "PARTIAL" && c.detail.includes("Nonregular"))).toBe(true);
	});
});
