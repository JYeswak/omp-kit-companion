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


test("PROJECTGOAL1 replace: a single native /goal set replaces the active goal, previous text reported, status shows the new goal", async () => {
	const f = await goalFixture();
	try {
		const journalBefore = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		// Plan is the default and changes nothing.
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		const plan = JSON.parse(planned.out).data;
		expect(plan.action).toBe("PLAN");
		expect(plan.seat).toBe(`tern:${f.directorBlock}`);
		expect(plan.current_goal).toBe("Grow the skill library");
		expect(plan.new_goal).toBe("Own skillgrowth: land the queue");
		expect(plan.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-set" }]);
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toBe(journalBefore);
		// Apply replaces the old goal with one native set, proven from the journal.
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.seat).toBe(`tern:${f.directorBlock}`);
		expect(done.previous_goal).toBe("Grow the skill library");
		expect(typeof done.goal_id).toBe("string");
		expect("dropped" in done).toBe(false);
		const journal = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		expect(journal).not.toContain('"status":"dropped"');
		expect(journal).toContain('"objective":"Own skillgrowth: land the queue"');
		// Status reads the new active goal from the journal.
		const status = await cli(f, ["project", "status", "skillgrowth", "--json"]);
		expect(status.code, status.out + status.err).toBe(0);
		expect(JSON.parse(status.out).data.seats[0].activeGoal).toBe("Own skillgrowth: land the queue");
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 set on a goal-less seat sends a single set", async () => {
	const f = await goalFixture();
	try {
		// A restarted seat whose journal carries no active goal.
		const lines = readFileSync(f.sessionFile(f.directorBlock), "utf8").split("\n");
		writeFileSync(f.sessionFile(f.directorBlock), lines.slice(0, 2).join("\n") + "\n");
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		expect(JSON.parse(planned.out).data.current_goal).toBe(null);
		expect(JSON.parse(planned.out).data.deliveries).toEqual([{ seat: `tern:${f.directorBlock}`, kind: "goal-set" }]);
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.previous_goal).toBe(null);
		expect("dropped" in done).toBe(false);
		expect(typeof done.goal_id).toBe("string");
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).not.toContain('"status":"dropped"');
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 a paused seat resumes, then sets the new goal", async () => {
	const f = await goalFixture();
	try {
		const path = f.sessionFile(f.directorBlock);
		const before = readFileSync(path, "utf8");
		const tip = JSON.parse(before.split("\n").filter((line) => line.trim() !== "").pop()!);
		writeFileSync(path, before + JSON.stringify({ type: "mode_change", id: "gp1", parentId: tip.id, mode: "goal_paused" }) + "\n");
		const planned = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--plan", "--json"]);
		expect(planned.code, planned.out + planned.err).toBe(0);
		expect(JSON.parse(planned.out).data.current_goal).toBe(null);
		expect(JSON.parse(planned.out).data.deliveries).toEqual([
			{ seat: `tern:${f.directorBlock}`, kind: "goal-resume" },
			{ seat: `tern:${f.directorBlock}`, kind: "goal-set" },
		]);
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code, changed.out + changed.err).toBe(0);
		const done = JSON.parse(changed.out).data;
		expect(done.action).toBe("APPLIED");
		expect(done.previous_goal).toBe(null);
		expect(typeof done.goal_id).toBe("string");
		expect("dropped" in done).toBe(false);
		const journal = readFileSync(path, "utf8");
		expect(journal).not.toContain('"status":"dropped"');
		expect(journal).toContain('"objective":"Own skillgrowth: land the queue"');
		expect(dispatchedPayloads(f).slice(-2)).toEqual(["/goal resume", "/goal set Own skillgrowth: land the queue"]);
		// Status reads the resumed-then-replaced goal from the journal.
		const status = await cli(f, ["project", "status", "skillgrowth", "--json"]);
		expect(status.code, status.out + status.err).toBe(0);
		expect(JSON.parse(status.out).data.seats[0].activeGoal).toBe("Own skillgrowth: land the queue");
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 goal text refusals: empty, over cap, and a line starting with /", async () => {
	const f = await goalFixture();
	try {
		const before = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		const empty = await cli(f, ["project", "goal", "skillgrowth", "--set", "   ", "--apply", "--yes", "--json"]);
		expect(empty.code).toBe(2);
		expect(JSON.parse(empty.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const slashed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\n/goal drop", "--apply", "--yes", "--json"]);
		expect(slashed.code).toBe(2);
		expect(JSON.parse(slashed.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const crSlashed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\r/goal drop", "--apply", "--yes", "--json"]);
		expect(crSlashed.code).toBe(2);
		expect(JSON.parse(crSlashed.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const indented = await cli(f, ["project", "goal", "skillgrowth", "--set", "Legit line\n   /goal drop", "--apply", "--yes", "--json"]);
		expect(indented.code).toBe(2);
		expect(JSON.parse(indented.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const nul = join(f.dir, "nul-goal.txt");
		writeFileSync(nul, "Own skillgrowth: " + String.fromCharCode(0) + "land the queue");
		const nulled = await cli(f, ["project", "goal", "skillgrowth", "--from-file", nul, "--apply", "--yes", "--json"]);
		expect(nulled.code).toBe(2);
		expect(JSON.parse(nulled.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const big = join(f.dir, "big-goal.txt");
		writeFileSync(big, "x".repeat(16 * 1024 + 1));
		const capped = await cli(f, ["project", "goal", "skillgrowth", "--from-file", big, "--apply", "--yes", "--json"]);
		expect(capped.code).toBe(2);
		expect(JSON.parse(capped.out).errors[0].code).toBe("PROJECT_GOAL_INVALID");
		const missing = await cli(f, ["project", "goal", "nosuch", "--set", "Something", "--apply", "--yes", "--json"]);
		expect(missing.code).toBe(2);
		expect(JSON.parse(missing.out).errors[0].code).toBe("PROJECT_SESSION_UNKNOWN");
		expect(readFileSync(f.sessionFile(f.directorBlock), "utf8")).toBe(before);
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);

test("PROJECTGOAL1 set unproven reports the partial state", async () => {
	const f = await goalFixture();
	try {
		f.env.PROJECTGOAL_NO_SET = "1";
		const changed = await cli(f, ["project", "goal", "skillgrowth", "--set", "Own skillgrowth: land the queue", "--apply", "--yes", "--json"]);
		expect(changed.code).toBe(1);
		const errors = JSON.parse(changed.out).errors;
		expect(errors[0].code).toBe("PROJECT_GOAL_UNPROVEN");
		expect(errors[0].message).toContain("set unproven");
		expect(errors[0].message).not.toContain("drop proven");
		expect(errors[0].message).toContain("still carries goal");
		const journal = readFileSync(f.sessionFile(f.directorBlock), "utf8");
		expect(journal).not.toContain('"status":"dropped"');
		expect(journal).not.toContain('"objective":"Own skillgrowth: land the queue"');
	} finally {
		f.killDecoys();
		f.mail.server.stop(true);
	}
}, fixtureDeadlineS(300) * 1000);
