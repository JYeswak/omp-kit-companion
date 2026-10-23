// RELEASELIVE1 (ompkit-5fn07) AC1: a process can use a scratch dir as its TMPDIR and hold no file open between writes,
// so the lsof gate cannot see it. A user registered with `scratch use` (pid + process start in DIR/.users) keeps the dir:
// `release --now` refuses USER_LIVE and apply keeps it, while the user probes live or unknown. Dead, reused and zombie
// users do not block. Each refusal has a passing control on the same dir.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, blockingScratchUser, inspectOne, releaseScratch, SCRATCH_USERS_FILE, updateScratchUsers,
	type InspectDeps, type LivenessDeps } from "../../src/scratch.ts";
import type { Incarnation, ProbeState } from "../../src/kitlib/proc.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const USER_PID = 77_001;
const USER_START = "Mon Oct 20 06:00:00 2026";
const OTHER_START = "Tue Oct 21 09:30:00 2026";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** The process table seam: what each pid runs as now. A pid absent from the table is dead (ESRCH). */
interface World { table: Map<number, { start: string; state?: ProbeState }> }
function liveness(world: World): LivenessDeps {
	return { signalAlive: () => false, psVisible: () => false, processStart: () => null,
		probe: (recorded) => {
			const row = world.table.get(recorded.pid);
			const evidence = { pid: recorded.pid, recorded_start: recorded.start, observed_start: row?.start ?? null, stat: null, signal0: null, reason: "planted" };
			if (row === undefined) return { state: "dead", evidence };
			if (row.state !== undefined) return { state: row.state, evidence };
			return { state: row.start === recorded.start ? "live" : "reused", evidence };
		} };
}
function incarnationOf(world: World): (pid: number) => Incarnation | null {
	return function seen(pid: number): Incarnation | null {
		const row = world.table.get(pid);
		return row === undefined ? null : { pid, start: row.start };
	};
}
const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
function deps(world: World): InspectDeps {
	return { liveness: liveness(world), run: clearRun, lsofSnapshot: new Set<string>() };
}

function fixture(): { dir: string; root: string; home: string } {
	const root = ownedTmp("users", { root: scratchParent }).path;
	const home = ownedTmp("users-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true, mode: 0o700 });
	const dir = join(root, `grade.${process.pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=grade\nrepo=${repo}\ncreated=2026-10-22T06:00:00.000Z\nbin=throwaway\npurpose=grader-tmpdir\n`);
	writeFileSync(join(dir, "item.json"), "{}");
	return { dir, root, home };
}

async function register(dir: string, world: World): Promise<void> {
	const used = await updateScratchUsers(dir, USER_PID, "use", { liveness: liveness(world), incarnation: incarnationOf(world) });
	expect(used).toMatchObject({ ok: true, reason: "user-registered", user: { pid: USER_PID, start: USER_START } });
}

test("AC1: a live registered user with no open file refuses release --now USER_LIVE and apply keeps the dir; after it exits, the same dir is released", async () => {
	const { dir, root, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	const refused = releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true });
	expect(refused).toMatchObject({ ok: false, changed: false, reason: "user-live" });
	expect(refused.detail).toContain(`pid ${USER_PID}`);
	expect(refused.detail).toContain(USER_START);
	expect(refused.detail).toContain("is live");
	expect(refused.detail).toContain("scratch unuse");
	expect(existsSync(join(dir, "item.json"))).toBe(true);
	// Released marker-only (no --now), the dir is still kept by apply while its user runs.
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway" })).toMatchObject({ ok: true, reason: "owner-released" });
	expect(inspectOne(dir, root, deps(world))).toMatchObject({ action: "LIVE", reason: "user-live" });
	applyScratch(home, { ...deps(world), home });
	expect(existsSync(join(dir, "item.json"))).toBe(true);
	// Control: the user exits; the same release retires the dir.
	world.table.delete(USER_PID);
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(dir)).toBe(false);
});

test("control: apply moves the released dir once its user has exited", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway" })).toMatchObject({ ok: true });
	world.table.delete(USER_PID);
	applyScratch(home, { ...deps(world), home });
	expect(existsSync(dir)).toBe(false);
});

test("a user whose pid was reused (same pid, different start) does not block, and the next rewrite prunes it", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	world.table.set(USER_PID, { start: OTHER_START });
	expect(blockingScratchUser(dir, liveness(world))).toBeNull();
	const pruned = await updateScratchUsers(dir, USER_PID + 1, "unuse", { liveness: liveness(world) });
	expect(pruned).toMatchObject({ ok: true, users: [], pruned: [{ pid: USER_PID, start: USER_START }] });
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
});

test("zombie and dead users do not block; an unknown probe blocks, because unknown is never dead", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	world.table.set(USER_PID, { start: USER_START, state: "zombie" });
	expect(blockingScratchUser(dir, liveness(world))).toBeNull();
	world.table.set(USER_PID, { start: USER_START, state: "unknown" });
	expect(blockingScratchUser(dir, liveness(world))).toMatchObject({ pid: USER_PID, state: "unknown" });
	const refused = releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true });
	expect(refused).toMatchObject({ ok: false, reason: "user-live" });
	expect(refused.detail).toContain("is unknown");
	expect(existsSync(dir)).toBe(true);
});

test("a malformed .users file blocks (unreadable evidence is not absence); a well-formed empty one does not", () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map() };
	writeFileSync(join(dir, SCRATCH_USERS_FILE), "not json");
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "user-live" });
	writeFileSync(join(dir, SCRATCH_USERS_FILE), `${JSON.stringify({ version: 1, users: [] })}\n`);
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
});

test("unuse removes the block while the user still runs", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "user-live" });
	expect(await updateScratchUsers(dir, USER_PID, "unuse", { liveness: liveness(world) })).toMatchObject({ ok: true, reason: "user-removed", users: [] });
	expect(JSON.parse(readFileSync(join(dir, SCRATCH_USERS_FILE), "utf8"))).toEqual({ version: 1, users: [] });
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
});

test("use refuses a pid that is not running and a dir without an owner record; registration grants no release authority", async () => {
	const { dir, root, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	expect(await updateScratchUsers(dir, USER_PID + 9, "use", { liveness: liveness(world), incarnation: incarnationOf(world) }))
		.toMatchObject({ ok: false, reason: "user-pid-not-running" });
	const bare = join(root, "bare");
	mkdirSync(bare);
	expect(await updateScratchUsers(bare, USER_PID, "use", { liveness: liveness(world), incarnation: incarnationOf(world) }))
		.toMatchObject({ ok: false, reason: "not-a-scratch-dir" });
	// A dir owned by another process stays refused caller-not-owner however many users are registered.
	writeFileSync(join(dir, ".owner"), `pid=${USER_PID + 50}\nlabel=grade\nrepo=${repo}\ncreated=2026-10-22T06:00:00.000Z\n`);
	await register(dir, world);
	expect(releaseScratch(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "caller-not-owner" });
});
