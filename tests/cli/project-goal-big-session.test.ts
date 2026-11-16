import { afterAll, expect, test } from "bun:test";
import { appendFileSync, closeSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readSessionTail } from "../../src/plane-tern.ts";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { cli, dispatchedPayloads, goalFixture, type Fixture } from "./project-add.helpers.ts";

afterAll(cleanupAllOwnedTmp);

const padding = Buffer.alloc(64 * 1024, 0x78);
const recordEnd = Buffer.from('"}\n');

function growGoalJournal(f: Fixture): string {
	const path = f.sessionFile(f.directorBlock);
	const previous = readFileSync(path, "utf8").trimEnd().split("\n");
	const tip: unknown = JSON.parse(previous[previous.length - 1]!);
	if (typeof tip !== "object" || tip === null || !("id" in tip) || typeof tip.id !== "string") {
		throw new Error("goal fixture has no journal tip");
	}
	let parent = tip.id;
	const fd = openSync(path, "a");
	try {
		for (let index = 0; index < 1040; index++) {
			const id = `goal-big-pad-${index}`;
			const prefix = JSON.stringify({ type: "custom", id, parentId: parent,
				customType: "memory_recall", data: "" }).slice(0, -2);
			writeFileSync(fd, prefix);
			writeFileSync(fd, padding);
			writeFileSync(fd, recordEnd);
			parent = id;
		}
	} finally { closeSync(fd); }
	expect(statSync(path).size).toBeGreaterThan(65 * 1024 * 1024);
	return parent;
}

test("GOALBIGSESSION1 a 65 MiB paused goal plans resume/set and preserves the applied goal id", async () => {
	const f = await goalFixture();
	try {
		const path = f.sessionFile(f.directorBlock);
		const parent = growGoalJournal(f);
		appendFileSync(path, JSON.stringify({ type: "mode_change", id: "goal-big-paused", parentId: parent,
			mode: "goal_paused", timestamp: "2026-11-15T00:00:00Z" }) + "\n");
		const before = statSync(path);
		const priorDispatch = dispatchedPayloads(f);
		const goal = "Own the large-journal goal-control queue";
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", goal, "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.current_goal).toBeNull();
		expect(plan.gate.paused).toBeTrue();
		expect(plan.deliveries).toEqual([
			{ seat: `tern:${f.directorBlock}`, kind: "goal-resume" },
			{ seat: `tern:${f.directorBlock}`, kind: "goal-set" },
		]);
		const afterPlan = statSync(path);
		expect([afterPlan.ino, afterPlan.size, afterPlan.mtimeMs, afterPlan.ctimeMs])
			.toEqual([before.ino, before.size, before.mtimeMs, before.ctimeMs]);
		expect(dispatchedPayloads(f)).toEqual(priorDispatch);
		const applied = await cli(f, ["project", "goal", "skillgrowth", "--set", goal, "--apply", "--yes", "--json"]);
		expect(applied.code, applied.out + applied.err).toBe(0);
		const result = JSON.parse(applied.out).data;
		expect(result.action).toBe("APPLIED");
		expect(dispatchedPayloads(f).slice(-2)).toEqual(["/goal resume", `/goal set ${goal}`]);
		const view = readSessionTail(path);
		if (view === null) throw new Error("large applied goal journal was unreadable");
		const start = view.tailStart > 0 && !view.cutAtRecord ? view.tail.indexOf(0x0a) + 1 : 0;
		const records = view.tail.toString("utf8", start).split("\n").filter(Boolean).map(line => JSON.parse(line));
		const latest = records.findLast(record => record.type === "mode_change" && record.mode === "goal");
		expect(typeof result.goal_id).toBe("string");
		expect(result.goal_id).toBe(latest.data.goal.id);
		expect(latest.data.goal.objective).toBe(goal);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1_000);

test("GOALBIGSESSION1 an absent or partial tail checkpoint never guesses goal-less or dispatches", async () => {
	const f = await goalFixture();
	try {
		const path = f.sessionFile(f.directorBlock);
		const parent = growGoalJournal(f);
		const before = dispatchedPayloads(f);
		const missing = await cli(f, ["project", "goal", "skillgrowth", "--set", "Replacement", "--plan", "--json"]);
		expect(missing.code).not.toBe(0);
		expect(JSON.parse(missing.out).errors[0].code).toBe("OBSERVATION_UNKNOWN");
		expect(dispatchedPayloads(f)).toEqual(before);
		appendFileSync(path, JSON.stringify({ type: "mode_change", id: "complete-pause", parentId: parent,
			mode: "goal_paused" }) + "\n");
		appendFileSync(path, '{"type":"mode_change","id":"partial","mode":"goal_paused"');
		const partial = await cli(f, ["project", "goal", "skillgrowth", "--set", "Replacement", "--plan", "--json"]);
		expect(partial.code).not.toBe(0);
		expect(JSON.parse(partial.out).errors[0].code).toBe("OBSERVATION_UNKNOWN");
		expect(dispatchedPayloads(f)).toEqual(before);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1_000);
