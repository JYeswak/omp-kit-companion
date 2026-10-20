// close drain (ompkit-kdbz.1 DRAIN1): landed-but-open beads and stale claims from
// in-tree fixtures. Planted negatives: verdicts silence the queue, assigned fresh
// beads stay quiet, and both stay scoped to the given tracker.
import { expect, test } from "bun:test";
import { closeQueue, staleClaims, STALE_EVIDENCE_MS, STALE_UNASSIGNED_MS, VERDICT_LINE } from "../../src/drain.ts";
import type { DrainComment, DrainIssue, Landing } from "../../src/drain.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-10-12T12:00:00Z");
const issue = (id: string, extra: Partial<DrainIssue> = {}): DrainIssue => ({
	id, title: `t ${id}`, status: "open", assignee: null, updatedMs: NOW - HOUR, ...extra,
});
const comment = (issueId: string, text: string, atMs: number, author = "grader"): DrainComment => ({
	issueId, author, text, createdMs: atMs,
});
const landing = (sha: string, atMs: number): Landing => ({ sha, committedMs: atMs });

test("close-queue lists a landed-but-open bead with its landing sha", () => {
	const rows = closeQueue(
		[issue("x-1"), issue("x-2", { status: "closed" })],
		[comment("x-1", "looks good", NOW - 2 * HOUR)],
		new Map([["x-1", landing("a".repeat(40), NOW - 3 * HOUR)], ["x-2", landing("b".repeat(40), NOW - 3 * HOUR)]]),
	);
	expect(rows).toEqual([{ id: "x-1", title: "t x-1", landingSha: "a".repeat(40), landedMs: NOW - 3 * HOUR }]);
});

test("planted: a VERDICT comment since landing keeps the bead out of the queue", () => {
	const rows = closeQueue(
		[issue("x-1")],
		[comment("x-1", "CLOSED x-1 deadbeef suite 42/0", NOW - HOUR)],
		new Map([["x-1", landing("a".repeat(40), NOW - 3 * HOUR)]]),
	);
	expect(rows).toEqual([]);
});

test("planted: a verdict before landing does not silence a later landing", () => {
	const rows = closeQueue(
		[issue("x-1")],
		[comment("x-1", "CLOSED x-1 oldsha old evidence", NOW - 5 * HOUR)],
		new Map([["x-1", landing("a".repeat(40), NOW - 3 * HOUR)]]),
	);
	expect(rows).toHaveLength(1);
});

test("planted: non-verdict chatter and other beads never silence the queue", () => {
	const rows = closeQueue(
		[issue("x-1")],
		[comment("x-1", "PROGRESS x-1 abc123 still working", NOW - HOUR), comment("x-9", "CLOSED x-9 nope", NOW - HOUR)],
		new Map([["x-1", landing("a".repeat(40), NOW - 3 * HOUR)]]),
	);
	expect(rows).toHaveLength(1);
});

test("stale-claim flags unassigned in_progress older than 24h with the reclaim command", () => {
	const rows = staleClaims(
		[issue("x-1", { status: "in_progress", updatedMs: NOW - STALE_UNASSIGNED_MS - HOUR })],
		[],
		NOW,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: "x-1", reason: "unassigned-24h" });
	expect(rows[0]?.reclaim).toContain("br comments add x-1");
	expect(rows[0]?.reclaim).toContain("br update x-1 --status open");
});

test("original boundary: holderless rework is surfaced with an open reclaim", () => {
	const rows = staleClaims(
		[issue("x-rework", { status: "rework", updatedMs: NOW - STALE_UNASSIGNED_MS - HOUR })],
		[],
		NOW,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: "x-rework", reason: "unassigned-24h" });
	expect(rows[0]?.reclaim).toContain("br update x-rework --status open --assignee \"\"");
});

test("planted negative: fresh rework and open controls stay out of stale claims", () => {
	const rows = staleClaims(
		[
			issue("fresh-rework", { status: "rework", updatedMs: NOW - HOUR }),
			issue("open-control", { status: "open", updatedMs: NOW - 30 * 24 * HOUR }),
		],
		[],
		NOW,
	);
	expect(rows).toEqual([]);
});

test("planted: assigned beads with same-day evidence stay quiet", () => {
	const rows = staleClaims(
		[
			issue("x-1", { status: "in_progress", assignee: "worker", updatedMs: NOW - HOUR }),
			issue("x-2", { status: "open", updatedMs: NOW - 30 * 24 * HOUR }),
		],
		[comment("x-1", "working on it", NOW - HOUR)],
		NOW,
	);
	expect(rows).toEqual([]);
});

test("planted: evidence-stale in_progress flags at 48h with last activity", () => {
	const rows = staleClaims(
		[issue("x-1", { status: "in_progress", assignee: "worker", updatedMs: NOW - 72 * HOUR })],
		[comment("x-1", "still here", NOW - 72 * HOUR)],
		NOW,
	);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: "x-1", reason: "evidence-stale-48h" });
	expect(rows[0]?.lastActivityMs).toBe(NOW - 72 * HOUR);
});

test("verdict lines: required match, rejects and a bounded long near-miss", () => {
	expect(VERDICT_LINE.test("CLOSED x-1 deadbeef 42/0")).toBe(true);
	expect(VERDICT_LINE.test("GRADE-PARTIAL x-1 unit green, release pending")).toBe(true);
	expect(VERDICT_LINE.test("PROGRESS x-1 abc123 working")).toBe(false);
	expect(VERDICT_LINE.test("  rework x-1 gaps")).toBe(false);
	expect(VERDICT_LINE.test("CLOSEDOWN the theater")).toBe(false);
	const nearMiss = `CLOSED ${"x-".repeat(50_000)}y`;
	const started = performance.now();
	expect(VERDICT_LINE.test(nearMiss)).toBe(true);
	expect(performance.now() - started).toBeLessThan(500);
});
