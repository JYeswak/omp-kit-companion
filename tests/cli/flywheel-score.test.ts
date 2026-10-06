import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { metricBeadSize, metricCloseFlow, metricCommitLinkage, metricFreshness, metricIndexIncidents, metricLandingHygiene, metricLessons, metricSelfPick, metricVerdictCloses, scoreFlywheel, tallyClaims } from "../../src/flywheel-score.ts";

const root = resolve(import.meta.dir, "../..");
const scratchRoot = join(root, "var/agent-tmp");

test("each metric grades A on the good shape and F on the bad shape", () => {
	const known = { "ompkit-aaa": true as const, "ompkit-bbb": true as const };
	expect(metricBeadSize([{ id: "a", status: "in_progress", acceptance_items: [{ checked: false }] }]).grade).toBe("A");
	expect(metricBeadSize([{ id: "a", status: "in_progress", acceptance_items: [{}, {}, {}, {}, {}, {}] }]).grade).toBe("F");
	expect(metricCommitLinkage(["[test] thing ompkit-aaa", "fix ompkit-bbb"], known).grade).toBe("A");
	expect(metricCommitLinkage(["random work", "more work"], known).grade).toBe("F");
	expect(metricSelfPick({ self: 9, dispatched: 1 }).grade).toBe("A");
	expect(metricSelfPick({ self: 0, dispatched: 9 }).grade).toBe("F");
	expect(metricLandingHygiene([{ subject: "[test] x ompkit-aaa", merge: false }], known).grade).toBe("A");
	expect(metricLandingHygiene([{ subject: "drive-by", merge: false }], known).grade).toBe("F");
	expect(metricIndexIncidents(0).grade).toBe("A");
	expect(metricIndexIncidents(2).grade).toBe("F");
	expect(metricCloseFlow(7, 7, 3).grade).toBe("A");
	expect(metricCloseFlow(0, 7, 200).grade).toBe("F");
	expect(metricFreshness(0, 5).grade).toBe("A");
	expect(metricFreshness(5, 5).grade).toBe("F");
	expect(metricVerdictCloses(9, 10).grade).toBe("A");
	expect(metricVerdictCloses(0, 10).grade).toBe("F");
	expect(metricLessons(10, 10).grade).toBe("A");
	expect(metricLessons(0, 10).grade).toBe("F");
});

test("tallyClaims separates self-picks from dispatches inside the window", () => {
	const since = Date.parse("2026-10-01T00:00:00.000Z");
	const events = [[
		{ event_type: "assignee_changed", actor: "SandyLake", new_value: "SandyLake", timestamp: "2026-10-06T00:00:00.000Z" },
		{ event_type: "assignee_changed", actor: "Coord", new_value: "Worker", timestamp: "2026-10-06T00:00:00.000Z" },
		{ event_type: "assignee_changed", actor: "SandyLake", new_value: "", timestamp: "2026-10-06T00:00:00.000Z" },
		{ event_type: "assignee_changed", actor: "Old", new_value: "Old", timestamp: "2020-01-01T00:00:00.000Z" },
		{ event_type: "status_changed", actor: "SandyLake", timestamp: "2026-10-06T00:00:00.000Z" },
	]];
	expect(tallyClaims(events, since)).toEqual({ self: 1, dispatched: 1 });
});

test("unknown bead ids never count as linked; distinct ids count once per commit", () => {
	const known = { "ompkit-aaa": true as const, "ompkit-bbb": true as const };
	expect(metricCommitLinkage(["work ompkit-zzz (not a real bead)"], known).grade).toBe("F");
	expect(metricLandingHygiene([{ subject: "two ompkit-aaa and ompkit-aaa again", merge: false }], known).grade).toBe("A");
	expect(metricLandingHygiene([
		{ subject: "two ompkit-aaa ompkit-bbb", merge: false },
		{ subject: "drive-by with no bead", merge: false },
	], known).grade).toBe("F");
});

test("scoreFlywheel aggregates a planted good week to straight A", () => {
	const now = Date.parse("2026-10-06T12:00:00.000Z");
	const day = "2026-10-05T12:00:00.000Z";
	const issues = [
		{ id: "ompkit-aaa", status: "in_progress", updated_at: day, acceptance_items: [{ checked: true }, { checked: false }] },
		{ id: "ompkit-bbb", status: "closed", created_at: day, updated_at: day },
	];
	const run = (cmd: string[]) => {
		const text = cmd.join(" ");
		if (text.includes(" list ")) return { code: 0, stdout: JSON.stringify({ issues }) };
		if (text.includes("audit log")) return { code: 0, stdout: JSON.stringify({ events: [
			{ event_type: "assignee_changed", actor: "SandyLake", new_value: "SandyLake", timestamp: day },
		] }) };
		if (text.includes(" search ")) return { code: 0, stdout: JSON.stringify({ issues: [] }) };
		if (text.includes("comments")) return { code: 0, stdout: JSON.stringify([
			{ author: "SandyLake", body: "VERDICT box1 PASS\nLesson: plant fixtures first", created_at: day },
		]) };
		const sep = String.fromCharCode(1);
		if (cmd[0] === "git") return { code: 0, stdout: ["aaa1", "[test] x ompkit-aaa", "p0"].join(sep) + "\n" + ["bbb2", "fix ompkit-bbb", "p0"].join(sep) + "\n" };
		throw new Error("unexpected command " + text);
	};
	const grades = Object.fromEntries(scoreFlywheel({ repo: "/repo", beadsDb: "/db", now }, run).map(m => [m.metric, m.grade]));
	expect(grades["bead-size"]).toBe("A");
	expect(grades["commit-linkage"]).toBe("A");
	expect(grades["self-pick"]).toBe("A");
	expect(grades["landing-hygiene"]).toBe("A");
	expect(grades["index-incidents"]).toBe("A");
	expect(grades["close-flow"]).toBe("A");
	expect(grades["freshness"]).toBe("A");
	expect(grades["verdict-closes"]).toBe("A");
	expect(grades["lessons"]).toBe("A");
});
