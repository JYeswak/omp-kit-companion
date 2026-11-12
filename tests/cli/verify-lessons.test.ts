import { afterAll, beforeAll, expect, test } from "bun:test";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBead } from "../../src/verify.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
// This bounds fixture Git initialization/publication and verification subprocesses,
// not a product latency contract; retain the 15-second floor and account for load.
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

test("LESSONAUTO1 CLOSED verify appends one lessons.jsonl row with the bead id and lesson text", async () => {
	const { dir, sha } = await repo("lessonauto-closed", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "close lesson fixture" });
	expect(res.code).toBe("CLOSED");
	const lines = readFileSync(join(dir, ".omp", "lessons.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	const row = JSON.parse(lines[0]!) as Record<string, unknown>;
	expect(row.bead).toBe("kit-1");
	expect(String(row.what)).toContain("close lesson fixture");
	expect(String(row.evidence)).toContain(sha);
	expect(Number.isFinite(Date.parse(String(row.ts)))).toBe(true);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 a second verify of the same bead appends none", async () => {
	const { dir, sha } = await repo("lessonauto-dedup", {}, true);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "lessons.jsonl"), JSON.stringify({ ts: new Date().toISOString(), repo: "lessonauto-dedup", agent: null, pane: null, model: null, kind: "LESSON", class: "OTHER:verify_close", what: "Lesson: earlier close", evidence: "verify kit-1 export earlier", cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: "kit-1" }) + "\n");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "new lesson text" });
	expect(res.code).toBe("CLOSED");
	const lines = readFileSync(join(dir, ".omp", "lessons.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	expect(String((JSON.parse(lines[0]!) as Record<string, unknown>).what)).toContain("earlier close");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 a REWORK verdict adds no lessons.jsonl row", async () => {
	const { dir, sha } = await repo("lessonauto-rework", {}, true);
	const br = fakeBr(inReview("- [ ] [b] [build] `sh scripts/bad.sh` -> prints PASS"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "rework lesson fixture" });
	expect(res.code).toBe("REWORK");
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 planted: a PENDING verify leaves lessons.jsonl unchanged", async () => {
	const { dir, sha } = await repo("lessonauto-pending", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [live] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "pending lesson fixture" });
	expect(res.code).toBe("PENDING");
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);
