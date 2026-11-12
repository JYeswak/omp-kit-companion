import { afterAll, beforeAll, expect, test } from "bun:test";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLessonsLog } from "../../src/lessons.ts";
import { verifyBead } from "../../src/verify.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
// This bounds fixture Git initialization/publication and verification subprocesses,
// not a product latency contract; retain the 15-second floor and account for load.
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

function localRow(dir: string): Record<string, unknown> {
	const lines = readFileSync(join(dir, ".omp", "lessons.local.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** Hermetic status: the fixture repo owns its git dir, and the ceiling stops discovery
 * from escaping into the enclosing checkout. */
function porcelain(dir: string): string {
	const res = runFixture(["git", "status", "--porcelain"], { cwd: dir,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	expect(res.rc).toBe(0);
	return new TextDecoder().decode(res.stdout);
}

test("LESSONAUTO1 CLOSED verify appends one lessons.local.jsonl row with the bead id and lesson text", async () => {
	const { dir, sha } = await repo("lessonauto-closed", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "close lesson fixture" });
	expect(res.code).toBe("CLOSED");
	const row = localRow(dir);
	expect(row.bead).toBe("kit-1");
	expect(String(row.what)).toContain("close lesson fixture");
	expect(String(row.evidence)).toContain(sha);
	expect(Number.isFinite(Date.parse(String(row.ts)))).toBe(true);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 a second verify of the same bead appends none", async () => {
	const { dir, sha } = await repo("lessonauto-dedup", {}, true);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "lessons.local.jsonl"), JSON.stringify({ ts: new Date().toISOString(), repo: "lessonauto-dedup", agent: null, pane: null, model: null, kind: "LESSON", class: "OTHER:verify_close", what: "Lesson: earlier close", evidence: "verify kit-1 export earlier", cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: "kit-1" }) + "\n");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "new lesson text" });
	expect(res.code).toBe("CLOSED");
	expect(String(localRow(dir).what)).toContain("earlier close");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 a REWORK verdict adds no lessons row", async () => {
	const { dir, sha } = await repo("lessonauto-rework", {}, true);
	const br = fakeBr(inReview("- [ ] [b] [build] `sh scripts/bad.sh` -> prints PASS"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "rework lesson fixture" });
	expect(res.code).toBe("REWORK");
	expect(existsSync(join(dir, ".omp", "lessons.local.jsonl"))).toBe(false);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 planted: a PENDING verify leaves lessons unchanged", async () => {
	const { dir, sha } = await repo("lessonauto-pending", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [live] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "pending lesson fixture" });
	expect(res.code).toBe("PENDING");
	expect(existsSync(join(dir, ".omp", "lessons.local.jsonl"))).toBe(false);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 a CLOSED verify leaves git status --porcelain empty", async () => {
	const { dir, sha } = await repo("lessondirt-clean", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "clean status fixture" });
	expect(res.code).toBe("CLOSED");
	expect(porcelain(dir)).toBe("");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 the lessons reader returns the new local lesson", async () => {
	const { dir, sha } = await repo("lessondirt-reader", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "reader lesson fixture" });
	expect(res.code).toBe("CLOSED");
	const log = readLessonsLog(dir);
	expect(log.status).toBe("OK");
	const rows = log.entries.filter(entry => entry.bead === "kit-1");
	expect(rows).toHaveLength(1);
	expect(rows[0]!.what).toContain("reader lesson fixture");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 planted: today's append dirties .omp/lessons.jsonl", async () => {
	const { dir } = await repo("lessondirt-tracked", {}, true);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "lessons.jsonl"), JSON.stringify({ ts: new Date().toISOString(), repo: "lessondirt-tracked", agent: null, pane: null, model: null, kind: "LESSON", class: "OTHER:verify_close", what: "Lesson: tracked close", evidence: "verify kit-1 export earlier", cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: "kit-1" }) + "\n");
	expect(porcelain(dir).includes(".omp")).toBe(true);
}, fixtureDeadlineS(60) * 1_000);
