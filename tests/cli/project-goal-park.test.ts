import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deliverFirstSeatGoal } from "../../src/send.ts";
import { projectStatus, resolveTurnOnPath, resolveRosterPath } from "../../src/project-add.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { ROOT, assistantEntry, cli, decoder, dispatchedPayloads, fixture, goalFixture, type Fixture } from "./project-add.helpers.ts";

afterAll(cleanupAllOwnedTmp);

test("GOALSENDLAND1-native: replacing an active goal dispatches one /goal set and never /goal drop", async () => {
	const f = await goalFixture();
	try {
		const before = dispatchedPayloads(f);
		// The fixture's first goal arrives staged, not dispatched: only this apply dispatches.
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		// The replaced goal is reported alongside the new goal id.
		expect(done.previous_goal).toBe("Grow the skill library");
		expect(typeof done.goal_id).toBe("string");
		// Exactly one new dispatch: the native set. The confirm-gated drop is never sent.
		expect(dispatchedPayloads(f).slice(before.length)).toEqual(["/goal set Own skillgrowth: land the queue"]);
		// Planted negative: an implementation that dispatches `/goal drop` fails here.
		expect(dispatchedPayloads(f).filter((payload) => payload === "/goal drop")).toEqual([]);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("GOALPARK1 pause: interrupt then /goal pause parks the goal, proven by goal_paused", async () => {
	const f = await goalFixture();
	try {
		const before = dispatchedPayloads(f);
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--pause", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.action).toBe("PLAN");
		expect(plan.current_goal).toBe("Grow the skill library");
		expect(plan.new_goal).toBe(null);
		expect(plan.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-pause" }]);
		expect(dispatchedPayloads(f)).toEqual(before);
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--pause", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("PAUSED");
		expect(done.previous_goal).toBe("Grow the skill library");
		expect(typeof done.goal_id).toBe("string");
		expect("dropped" in done).toBe(false);
		expect(dispatchedPayloads(f).slice(before.length)).toEqual(["interrupt", "/goal pause"]);
		expect(dispatchedPayloads(f).filter((payload) => payload === "/goal drop")).toEqual([]);
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toContain('"mode":"goal_paused"');
		const replan = await cli(f, ["project", "goal", "skillgrowth", "--pause", "--plan", "--json"]);
		expect(replan.code, replan.out + replan.err).toBe(0);
		expect(JSON.parse(replan.out).data.current_goal).toBe(null);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("GOALPARK1 drop: interrupt then a goal-tool ask drops the goal, never /goal drop text", async () => {
	const f = await goalFixture();
	try {
		const before = dispatchedPayloads(f);
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--drop", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.action).toBe("PLAN");
		expect(plan.current_goal).toBe("Grow the skill library");
		expect(plan.new_goal).toBe(null);
		expect(plan.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-drop" }]);
		expect(dispatchedPayloads(f)).toEqual(before);
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--drop", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("DROPPED");
		expect(done.previous_goal).toBe("Grow the skill library");
		expect(typeof done.goal_id).toBe("string");
		const fresh = dispatchedPayloads(f).slice(before.length);
		expect(fresh.length).toBe(2);
		expect(fresh[0]).toBe("interrupt");
		expect(fresh[1]).toContain("op=drop");
		expect(fresh.filter((payload) => payload === "/goal drop")).toEqual([]);
		expect(fresh.filter((payload) => payload.includes("/goal drop"))).toEqual([]);
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toContain('"status":"dropped"');
		const replan = await cli(f, ["project", "goal", "skillgrowth", "--drop", "--plan", "--json"]);
		expect(replan.code, replan.out + replan.err).toBe(0);
		expect(JSON.parse(replan.out).data.current_goal).toBe(null);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("GOALPARK1 unproven: a seat whose journal never changes reports PROJECT_GOAL_UNPROVEN", async () => {
	const f = await goalFixture();
	try {
		const before = dispatchedPayloads(f);
		f.env.PROJECTGOAL_NO_PARK = "1";
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--pause", "--apply", "--yes", "--json"]);
		expect(changed.code).toBe(1);
		const errors = JSON.parse(changed.out).errors;
		expect(errors[0].code).toBe("PROJECT_GOAL_UNPROVEN");
		expect(errors[0].message).toContain("pause unproven");
		expect(dispatchedPayloads(f).slice(before.length)).toEqual(["interrupt", "/goal pause"]);
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).not.toContain('"mode":"goal_paused"');
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);
