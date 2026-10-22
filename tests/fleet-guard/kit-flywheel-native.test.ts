import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlywheelExecResult } from "../../extensions/kit-flywheel-guard";
import { createFlywheelHost, toolCall, type Responder } from "./kit-flywheel-host";

const base = mkdtempSync(join(tmpdir(), "kit-flywheel-native-"));

afterAll(() => {
 rmSync(base, { recursive: true, force: true });
});

function nativeClaimFixture() {
	const project = mkdtempSync(join(base, "native-claim-"));
	const db = join(project, ".beads", "beads.db");
	writeFileSync(join(project, ".owner"), JSON.stringify({
		pid: process.pid, label: "native-claim-test", repo: join(import.meta.dir, "..", ".."), created: new Date().toISOString(),
	}));
	const run = (args: string[], actor = "ClaimFixture"): FlywheelExecResult => {
		const result = Bun.spawnSync(["br", ...args, "--db", db, "--actor", actor, "--json", "--no-auto-import", "--no-auto-flush"], {
			cwd: project, env: { ...process.env, HOME: project }, stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	const init = run(["init", "--prefix", "gc"]);
	if (init.code !== 0) throw new Error(init.stdout + init.stderr);
	const create = () => {
		const result = run(["create", "--title", "Native claim consumer"]);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		const value: unknown = JSON.parse(result.stdout);
		if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") throw new Error("native create has no id");
		return value.id;
	};
	const respond: Responder = call => {
		const result = Bun.spawnSync([call.command, ...call.args], {
			cwd: call.options?.cwd ?? project, env: { ...process.env, HOME: project },
			stdout: "pipe", stderr: "pipe", timeout: call.options?.timeout ?? 10_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	return { project, db, run, create, respond };
}

test("PULLADMIT1: a competing native claim is refused with its actual holder, not attribution identity", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	expect(fixture.run(["sync", "--flush-only"]).code).toBe(0);
	const exportPath = join(fixture.project, ".beads", "issues.jsonl");
	const exported = readFileSync(exportPath, "utf8");
	expect(fixture.run(["update", id, "--claim"], "Winner").code).toBe(0);
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Loser", BR_AGENT_NAME: "Winner" }, respond: fixture.respond });
	const result = await toolCall(h, fixture.project, `br update ${id} --claim --actor Loser --agent-name Winner --db '${fixture.db}'`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: "Winner", next: expect.stringContaining(id) },
	});
	const observed: unknown = JSON.parse(fixture.run(["show", id]).stdout);
	expect(observed).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Winner" })]));
	expect(readFileSync(exportPath, "utf8")).toBe(exported);
});

test("PULLADMIT1: fresh and same-holder native claims execute, rather than a guard refusing everything", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await toolCall(h, fixture.project, `br update ${id} --claim --actor Worker --db '${fixture.db}'`);
		if (result?.block) throw new Error(result.reason);
		const claimed = fixture.run(["update", id, "--claim"], "Worker");
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Worker", status: "in_progress" })]));
	}
});

test("PULLADMIT1: native lookup failure is not an unassigned claim", async () => {
	const fixture = nativeClaimFixture();
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
	const result = await toolCall(h, fixture.project, `br update gc-nonexistent --claim --actor Worker --db '${fixture.db}'`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "tool_read_failure", bead: "gc-nonexistent", actor: expect.stringContaining("UNKNOWN"), next: expect.stringContaining("gc-nonexistent") },
	});
});

test("PULLADMIT1: a bare in-progress update cannot replace an atomic native ownership claim", async () => {
	for (const status of ["in_progress", "IN_PROGRESS", "inprogress"]) {
		const fixture = nativeClaimFixture();
		const id = fixture.create();
		const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Worker" }, respond: fixture.respond });
		const result = await toolCall(h, fixture.project, `br update ${id} --status ${status} --actor Worker --db '${fixture.db}'`);
		expect(result?.block).toBe(true);
		expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
			refusal: { class: "unsupported_native", bead: id, next: expect.stringContaining("--claim") },
		});
		expect(JSON.parse(fixture.run(["show", id]).stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "open" })]));
	}
});

test("PULLADMIT1: explicit native database scope wins over the caller cwd", async () => {
	const local = nativeClaimFixture();
	local.create();
	const remote = nativeClaimFixture();
	const id = remote.create();
	expect(remote.run(["update", id, "--claim"], "ScopedHolder").code).toBe(0);
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: "Requester" }, respond: local.respond });
	const result = await toolCall(h, local.project, `br --db '${remote.db}' --actor Requester update ${id} --claim`);
	expect(result?.block).toBe(true);
	expect(JSON.parse(result?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: "ScopedHolder" },
	});
});

test("PULLADMIT1: concurrent native awards have one winner and name it to the loser", async () => {
	const fixture = nativeClaimFixture();
	const id = fixture.create();
	const actors = ["RaceOne", "RaceTwo"];
	for (const actor of actors) {
		const h = await createFlywheelHost(base, { env: { BR_ACTOR: actor }, respond: fixture.respond });
		const admission = await toolCall(h, fixture.project, `br update ${id} --claim --actor ${actor} --db '${fixture.db}'`);
		if (admission?.block) throw new Error(admission.reason);
	}
	const children = actors.map(actor => ({
		actor,
		child: Bun.spawn(["br", "update", id, "--claim", "--db", fixture.db, "--actor", actor, "--json", "--no-auto-import", "--no-auto-flush"], {
			cwd: fixture.project, env: { ...process.env, HOME: fixture.project },
			stdout: "pipe", stderr: "pipe", timeout: 10_000,
		}),
	}));
	const outcomes = await Promise.all(children.map(async ({ actor, child }) => {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		return { actor, stdout, stderr, code };
	}));
	const winners = outcomes.filter(row => row.code === 0);
	const losers = outcomes.filter(row => row.code !== 0);
	expect(winners).toHaveLength(1);
	expect(losers).toHaveLength(1);
	const winner = winners[0];
	const loser = losers[0];
	if (winner === undefined || loser === undefined) throw new Error(JSON.stringify(outcomes));
	expect(JSON.parse(winner.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: winner.actor })]));
	expect(JSON.parse(loser.stdout)).toMatchObject({
		error: { context: { reason: expect.stringContaining(winner.actor) } },
	});
	const h = await createFlywheelHost(base, { env: { BR_ACTOR: loser.actor }, respond: fixture.respond });
	const refused = await toolCall(h, fixture.project, `br update ${id} --claim --actor ${loser.actor} --db '${fixture.db}'`);
	expect(refused?.block).toBe(true);
	expect(JSON.parse(refused?.reason ?? "null")).toMatchObject({
		refusal: { class: "unsafe_custody", bead: id, actor: winner.actor },
	});
});

test("PULLADMIT1: ownership whitespace follows native same-holder claim semantics", async () => {
	for (const { assignee, actor, explicit } of [
		{ assignee: "Worker ", actor: "Worker", explicit: true },
		{ assignee: "   ", actor: "Worker", explicit: true },
		{ assignee: "Worker", actor: "Worker ", explicit: true },
		{ assignee: "Worker", actor: " Worker ", explicit: false },
	]) {
		// One tracker per case: a claim that succeeded in an earlier case would otherwise make Worker the holder of an
		// active bead, and the one-bead-per-worker rule rightly refuses the next claim (ompkit-lxo83).
		const fixture = nativeClaimFixture();
		const id = fixture.create();
		const updated = fixture.run(["update", id, "--assignee", assignee], "Worker");
		if (updated.code !== 0) throw new Error(updated.stdout + updated.stderr);
		const h = await createFlywheelHost(base, { env: { BR_ACTOR: actor }, respond: fixture.respond });
		const actorFlag = explicit ? ` --actor ${JSON.stringify(actor)}` : "";
		const admission = await toolCall(h, fixture.project, `br update ${id} --claim${actorFlag} --db '${fixture.db}'`);
		expect(admission?.block).not.toBe(true);
		const claimed = fixture.run(["update", id, "--claim"], actor);
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ id, assignee: "Worker", status: "in_progress" })]));
	}
});
