// RULESKILL1 (ompkit-nmke9 box [b]): the coverage command exits 1 naming
// every durable rule older than the grace window whose anchor is absent from
// the skill file a seat loads, and reports stated-to-landed latency from git.
// Planted negatives: an anchor present only in a different skill, and an
// anchor deleted after landing, both count as missing.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	checkCoverageRule, loadCoverageBacklog, normalizeCoverageAnchor, runCoverage,
	renderCoverageText,
} from "../../src/skill-mine-coverage.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const NOW = "2026-11-19T00:00:00Z";
const NOW_MS = Date.parse(NOW);

function gitEnvFor(root: string, home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	return {
		...env, HOME: home, TMPDIR: join(root, "t"), GIT_CEILING_DIRECTORIES: root,
		GIT_AUTHOR_NAME: "Rule Skill", GIT_AUTHOR_EMAIL: "rule-skill@example.com",
		GIT_COMMITTER_NAME: "Rule Skill", GIT_COMMITTER_EMAIL: "rule-skill@example.com",
	};
}

function gitCommit(dir: string, env: Record<string, string>, files: Record<string, string>, subject: string, date: string): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(dir, rel);
		mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	const add = runFixture(["git", "add", "-A"], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect(add.rc).toBe(0);
	const dated = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
	const committed = runFixture(["git", "-c", "user.name=Rule Skill", "-c", "user.email=rule-skill@example.com",
		"commit", "--no-gpg-sign", "-m", subject], { cwd: dir, env: dated, floor_s: fixtureDeadlineS() });
	expect(committed.rc).toBe(0);
}

interface CoverageFixture {
	root: string;
	home: string;
	skills: string;
}

function makeCoverageFixture(label: string): CoverageFixture {
	const root = ownedTmp(label, { root: scratchParent }).path;
	const home = join(root, "home");
	mkdirSync(join(root, "t"), { recursive: true });
	const skills = join(root, "skills");
	mkdirSync(join(skills, "alpha"), { recursive: true });
	mkdirSync(join(skills, "beta"), { recursive: true });
	for (const dir of [join(root, "git-a")]) {
		const init = runFixture(["git", "init", "-b", "main", "-q", dir],
			{ cwd: root, env: gitEnvFor(root, home), floor_s: fixtureDeadlineS() });
		expect(init.rc).toBe(0);
	}
	return { root, home, skills };
}

function ruleRow(ruleId: string, skillPath: string, anchor: string, stated = "2026-11-10T00:00:00Z", extra?: Record<string, unknown>): Record<string, unknown> {
	return {
		rule_id: ruleId, stated_at: stated, source: { kind: "seat_chat", path: "s", line: 1, ref: "x" },
		seat: "OrangeRiver", verbatim: "words here", durable: true, why_durable: "standing rule",
		scope: "cfs", owning_skill: "alpha", skill_path: skillPath, anchor,
		status: "missing", held_evidence: null, proposed_text: "text", ...extra,
	};
}

function writeBacklog(root: string, rows: Record<string, unknown>[]): string {
	const path = join(root, "backlog.jsonl");
	writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, "utf8");
	return path;
}

test("RULESKILL1-coverage: covered rule reports latency from git", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-latency");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nDo the nightly sweep every day.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	writeFileSync(sk, "# Skill\nDo the nightly sweep every day.\nAlways file the job card.\n", "utf8");
	gitCommit(dir, env, {}, "land anchor", "2026-11-12T12:00:00+00:00");
	const backlog = writeBacklog(f.root, [ruleRow("R-2026-11-10-01", sk, "Always file the job card")]);
	const report = await runCoverage({ backlog, graceHours: 24, nowMs: NOW_MS });
	expect(report.exit_code).toBe(0);
	const row = report.rules[0]!;
	expect(row.status).toBe("covered");
	expect(row.landed_at?.startsWith("2026-11-12T12:00")).toBe(true);
	expect(row.latency_hours).toBe(60);
	expect(report.totals.covered).toBe(1);
	expect(report.totals.durable).toBe(1);
	expect(report.overdue).toEqual([]);
});

test("RULESKILL1-coverage: missing rule exits 1 naming it", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-missing");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nNothing relevant.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	const backlog = writeBacklog(f.root, [ruleRow("R-2026-11-10-02", sk, "Always file the job card")]);
	const report = await runCoverage({ backlog, graceHours: 24, nowMs: NOW_MS });
	expect(report.exit_code).toBe(1);
	expect(report.rules[0]!.status).toBe("missing");
	expect(report.overdue).toEqual(["R-2026-11-10-02"]);
});

test("RULESKILL1-coverage: superseded rule is not owed; unknown successor still owed", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-superseded");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nGift hours expire with the business.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	const old = ruleRow("R-2026-11-10-05", sk, "expire after 24 months", "2026-11-10T00:00:00Z", { status: "superseded", superseded_by: "R-2026-11-10-06" });
	const next = ruleRow("R-2026-11-10-06", sk, "Gift hours expire with the business");
	const report = await runCoverage({ backlog: writeBacklog(f.root, [old, next]), graceHours: 24, nowMs: NOW_MS });
	const byId = new Map(report.rules.map(row => [row.rule_id, row] as const));
	expect(byId.get("R-2026-11-10-05")!.status).toBe("superseded");
	expect(byId.get("R-2026-11-10-06")!.status).toBe("covered");
	expect(report.totals.superseded).toBe(1);
	expect(report.totals.missing).toBe(0);
	expect(report.exit_code).toBe(0);
	const orphan = await runCoverage({
		backlog: writeBacklog(f.root, [{ ...old, superseded_by: "R-2026-11-10-99" }, next]),
		graceHours: 24, nowMs: NOW_MS,
	});
	const orphanById = new Map(orphan.rules.map(row => [row.rule_id, row] as const));
	expect(orphanById.get("R-2026-11-10-05")!.status).toBe("missing");
	expect(orphan.exit_code).toBe(1);
});

test("RULESKILL1-coverage: anchor present only in a different skill counts as missing", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-otherskill");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const a = join(dir, "alpha.md");
	const b = join(dir, "beta.md");
	gitCommit(dir, env, { "alpha.md": "# Alpha\nNothing relevant.\n", "beta.md": "# Beta\nAlways file the job card.\n" },
		"add skills", "2026-11-11T00:00:00+00:00");
	const backlog = writeBacklog(f.root, [ruleRow("R-2026-11-10-03", a, "Always file the job card")]);
	const report = await runCoverage({ backlog, graceHours: 24, nowMs: NOW_MS });
	expect(report.rules[0]!.status).toBe("missing");
	expect(report.exit_code).toBe(1);
});

test("RULESKILL1-coverage: emphasis, whitespace and case normalize", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-normalize");
	expect(normalizeCoverageAnchor("**Always   file** the `job card`")).toBe("always file the job card");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\n**Always   file** the `job card`.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	const backlog = writeBacklog(f.root, [ruleRow("R-2026-11-10-04", sk, "always file the job card")]);
	const report = await runCoverage({ backlog, graceHours: 24, nowMs: NOW_MS });
	expect(report.rules[0]!.status).toBe("covered");
});

test("RULESKILL1-coverage: anchor deleted after landing flips to missing", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-deleted");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nAlways file the job card.\n" }, "land anchor", "2026-11-11T00:00:00+00:00");
	writeFileSync(sk, "# Skill\nRewritten without the rule.\n", "utf8");
	gitCommit(dir, env, {}, "remove anchor", "2026-11-13T00:00:00+00:00");
	const backlog = writeBacklog(f.root, [ruleRow("R-2026-11-10-05", sk, "Always file the job card")]);
	const report = await runCoverage({ backlog, graceHours: 24, nowMs: NOW_MS });
	expect(report.rules[0]!.status).toBe("missing");
	expect(report.exit_code).toBe(1);
});

test("RULESKILL1-coverage: fresh misses stay in grace; absent skill files are skill_missing", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-grace");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nNothing relevant.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	const ghost = join(dir, "NOSKILL.md");
	const rows = [
		ruleRow("R-2026-11-18-01", sk, "Brand new rule", "2026-11-18T12:00:00Z"),
		ruleRow("R-2026-11-10-06", ghost, "Ghost anchor"),
	];
	const report = await runCoverage({ backlog: writeBacklog(f.root, rows), graceHours: 24, nowMs: NOW_MS });
	const byId = new Map(report.rules.map(row => [row.rule_id, row] as const));
	expect(byId.get("R-2026-11-18-01")!.status).toBe("missing");
	expect(byId.get("R-2026-11-10-06")!.status).toBe("skill_missing");
	expect(report.exit_code).toBe(1);
	const freshOnly = await runCoverage({
		backlog: writeBacklog(f.root, [rows[0]!]),
		graceHours: 24, nowMs: Date.parse("2026-11-18T13:00:00Z"),
	});
	expect(freshOnly.exit_code).toBe(0);
});

test("RULESKILL1-coverage: checkCoverageRule measures status without git when history is absent", async () => {
	const f = makeCoverageFixture("skill-mine-coverage-nogit");
	const sk = join(f.skills, "alpha", "SKILL.md");
	mkdirSync(join(f.skills, "alpha"), { recursive: true });
	writeFileSync(sk, "# Skill\nAlways file the job card.\n", "utf8");
	const row = await checkCoverageRule(
		{ rule_id: "R-1", stated_at: "2026-11-10T00:00:00Z", durable: true, owning_skill: "alpha", skill_path: sk, anchor: "Always file the job card" },
		NOW_MS,
	);
	// skills/ is not a git repo: covered by file content, no landing history.
	expect(row.status).toBe("covered");
	expect(row.latency_hours).toBeNull();
});

test("RULESKILL1-coverage: invalid backlog input throws", () => {
	expect(() => loadCoverageBacklog(join(scratchParent, "does-not-exist.jsonl"))).toThrow("backlog not found");
	const bad = join(scratchParent, "bad-backlog.jsonl");
	writeFileSync(bad, '{"rule_id": "R-1", broken\n', "utf8");
	expect(() => loadCoverageBacklog(bad)).toThrow("invalid JSON");
});

test("RULESKILL1-coverage: CLI coverage exits 1 naming the rule and 0 when covered", () => {
	const f = makeCoverageFixture("skill-mine-coverage-cli");
	const dir = join(f.root, "git-a");
	const env = gitEnvFor(f.root, f.home);
	const sk = join(dir, "SKILL.md");
	gitCommit(dir, env, { "SKILL.md": "# Skill\nAlways file the job card.\n" }, "add skill", "2026-11-11T00:00:00+00:00");
	const tmp = join(f.root, "t");
	const cliEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") cliEnv[key] = value;
	Object.assign(cliEnv, { HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root, PATH: process.env.PATH ?? "" });
	const miss = writeBacklog(f.root, [ruleRow("R-2026-11-10-02", sk, "A rule that never landed")]);
	const bad = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", "coverage",
		"--backlog", miss, "--now", NOW, "--json"],
		{ cwd: f.root, env: cliEnv, floor_s: fixtureDeadlineS() });
	expect(bad.rc).toBe(1);
	const badEnvelope = JSON.parse(new TextDecoder().decode(bad.stdout));
	expect(badEnvelope.errors ?? []).toEqual([]);
	expect(badEnvelope.data.overdue).toEqual(["R-2026-11-10-02"]);
	expect(badEnvelope.data.exit_code).toBe(1);
	const hit = writeBacklog(f.root, [ruleRow("R-2026-11-10-01", sk, "Always file the job card")]);
	const good = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", "coverage",
		"--backlog", hit, "--now", NOW, "--json"],
		{ cwd: f.root, env: cliEnv, floor_s: fixtureDeadlineS() });
	expect(good.rc).toBe(0);
	const goodEnvelope = JSON.parse(new TextDecoder().decode(good.stdout));
	expect(goodEnvelope.data.exit_code).toBe(0);
	expect(goodEnvelope.data.rules[0].status).toBe("covered");
	const text = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", "coverage",
		"--backlog", hit, "--now", NOW],
		{ cwd: f.root, env: cliEnv, floor_s: fixtureDeadlineS() });
	expect(text.rc).toBe(0);
	expect(new TextDecoder().decode(text.stdout)).toMatch(/R-2026-11-10-01: covered/);
	expect(renderCoverageText(goodEnvelope.data)).toMatch(/totals: durable=1 covered=1/);
}, fixtureDeadlineS() * 1000);
