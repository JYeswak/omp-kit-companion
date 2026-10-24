// close drain: landed-but-open beads and orphaned claims from in-tree fixtures.
// Reclaim follows current holder evidence, not the age of a tracker touch.
import { expect, test } from "bun:test";
import { closeQueue, reclaimCommand, staleClaims, trackerTimeMs, VERDICT_LINE } from "../../src/drain.ts";
import type { DrainComment, DrainIssue, Landing } from "../../src/drain.ts";
import { holderVerdict } from "../../src/holder-liveness.ts";
import type { LivenessSources } from "../../src/holder-liveness.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-10-12T12:00:00Z");
const issue = (id: string, extra: Partial<DrainIssue> = {}): DrainIssue => {
	const updatedMs = extra.updatedMs ?? NOW - HOUR;
	return { id, title: `t ${id}`, status: "open", assignee: null, updatedMs, revision: new Date(updatedMs).toISOString(), ...extra };
};
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

function ok<T>(value: T) { return { ok: true as const, value }; }
const readable = (over: Partial<LivenessSources> = {}): LivenessSources => ({
	seats: ok(new Set<string>()), mail: ok(new Map<string, number>()), reservations: ok(new Set<string>()), ...over,
});
const liveness = (sources: LivenessSources) => (holder: string) => holderVerdict(holder, sources, NOW);
const UNTOUCHED = NOW - 25 * HOUR;

test("AC1 planted: a bead held 25 h by a dead agent is listed DEAD with one atomic reclaim", () => {
	const rows = staleClaims([issue("x-dead", { status: "in_progress", assignee: "DeadOne", updatedMs: UNTOUCHED })], [], NOW, liveness(readable()));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: "x-dead", holder: "DeadOne", liveness: "DEAD", lastActivityMs: UNTOUCHED });
	const revision = new Date(UNTOUCHED).toISOString();
	expect(rows[0]?.revision).toBe(revision);
	expect(rows[0]?.reclaim).toBe(reclaimCommand("x-dead", revision, NOW));
	expect(rows[0]?.reclaim).toBe(`br update x-dead --status open --assignee "" --if-unchanged '${revision}' --transition-comment 'reclaimed 2026-10-12: no live holder'`);
	expect(rows[0]?.reclaim).not.toContain("&&");
	expect(rows[0]?.reclaim).not.toContain("comments add");
});

test("AC1 control: the same bead held by a live seat, mail-active agent or reservation holder is not listed", () => {
	const dead = [issue("x-1", { status: "in_progress", assignee: "Holder", updatedMs: UNTOUCHED })];
	expect(staleClaims(dead, [], NOW, liveness(readable({ seats: ok(new Set(["holder"])) })))).toEqual([]);
	expect(staleClaims(dead, [], NOW, liveness(readable({ mail: ok(new Map([["holder", NOW - 2 * HOUR]])) })))).toEqual([]);
	expect(staleClaims(dead, [], NOW, liveness(readable({ reservations: ok(new Set(["holder"])) })))).toEqual([]);
});

test("AC1 planted: unreadable liveness lists the row as UNKNOWN with no reclaim, never drops it", () => {
	const rows = staleClaims([issue("x-unk", { status: "in_progress", assignee: "Someone", updatedMs: UNTOUCHED })], [], NOW,
		liveness(readable({ seats: { ok: false, why: "tern inspect exited 1" } })));
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ id: "x-unk", liveness: "UNKNOWN", reclaim: null });
	expect(rows[0]?.evidence.join(" ")).toContain("tern inspect exited 1");
});

test("a recent update or comment does not hide a proven dead holder", () => {
	const rows = staleClaims([
		issue("recent-update", { status: "in_progress", assignee: "DeadOne", updatedMs: NOW - HOUR }),
		issue("recent-comment", { status: "rework", assignee: "DeadOne", updatedMs: UNTOUCHED }),
	], [comment("recent-comment", "director records a finding", NOW - 2 * HOUR)], NOW, liveness(readable()));
	expect(rows.map(row => [row.id, row.liveness, row.lastActivityMs])).toEqual([
		["recent-comment", "DEAD", NOW - 2 * HOUR],
		["recent-update", "DEAD", NOW - HOUR],
	]);
	expect(rows.every(row => row.reclaim !== null)).toBe(true);
});

test("holderless in_progress and rework untouched 24 h are listed NO_HOLDER with the reclaim", () => {
	const rows = staleClaims([
		issue("x-1", { status: "in_progress", updatedMs: UNTOUCHED }),
		issue("x-rework", { status: "rework", updatedMs: UNTOUCHED }),
	], [], NOW, () => { throw new Error("no holder needs no liveness probe"); });
	expect(rows.map(row => [row.id, row.liveness])).toEqual([["x-1", "NO_HOLDER"], ["x-rework", "NO_HOLDER"]]);
	expect(rows[1]?.reclaim).toContain("br update x-rework --status open --assignee \"\"");
});

test("live rework and open or closed rows are not reclaimed", () => {
	const rows = staleClaims(
		[
			issue("fresh-rework", { status: "rework", assignee: "LiveOne", updatedMs: NOW - HOUR }),
			issue("open-control", { status: "open", assignee: "DeadOne", updatedMs: NOW - 30 * 24 * HOUR }),
			issue("closed-control", { status: "closed", assignee: "DeadOne", updatedMs: NOW - 30 * 24 * HOUR }),
		],
		[],
		NOW,
		liveness(readable({ seats: ok(new Set(["liveone"])) })),
	);
	expect(rows).toEqual([]);
});

test("reclaim quotes a revision or comment carrying shell metacharacters", () => {
	expect(reclaimCommand("x-1", "2026-10-13 05:00:00", NOW)).toContain("--if-unchanged '2026-10-13 05:00:00'");
	expect(reclaimCommand("x-1", "it's", NOW)).toContain("--if-unchanged 'it'\\''s'");
});

test("planted: br's zoneless comment stamps are UTC, never host-local time", () => {
	const zone = process.env.TZ;
	process.env.TZ = "America/Denver";
	try {
		expect(trackerTimeMs("2026-10-22 05:47:39")).toBe(Date.parse("2026-10-22T05:47:39Z"));
	} finally {
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	}
	expect(trackerTimeMs("2026-10-20T01:13:50.642220+00:00")).toBe(Date.parse("2026-10-20T01:13:50.642Z"));
	expect(trackerTimeMs("2026-10-20T07:13:50-06:00")).toBe(Date.parse("2026-10-20T13:13:50Z"));
	expect(trackerTimeMs("2026-10-20T07:13:50Z")).toBe(Date.parse("2026-10-20T07:13:50Z"));
	expect(trackerTimeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	expect(Number.isNaN(trackerTimeMs("not a time"))).toBe(true);
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
