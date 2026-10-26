// RELEASELIVE1 (ompkit-5fn07) AC1: a process can use a scratch dir as its TMPDIR and hold no file open between writes,
// so the lsof gate cannot see it. A user registered with `scratch use` (pid + process start in DIR/.users) keeps the dir:
// `release --now` refuses USER_LIVE and apply keeps it, while the user probes live or unknown. Dead, reused and zombie
// users do not block. Each refusal has a passing control on the same dir.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyQuarantineExpiry, applyScratch, blockingScratchUser, defaultRunner, inspectOne, quarantineDir, quarantineEntryFor,
	reapLogPath, releaseScratch, SCRATCH_USERS_FILE, scratchContent, updateScratchUsers, type InspectDeps, type LivenessDeps } from "../../src/scratch.ts";
import type { Incarnation, ProbeState } from "../../src/kitlib/proc.ts";
import { privateLock } from "../../src/kitlib/lock.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { mintOwnerCapability } from "../../src/kitlib/owner.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const USER_PID = 77_001;
const USER_START = "Mon Oct 20 06:00:00 2026";
const ownerCapability = mintOwnerCapability();
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
	return { processStart: () => null,
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
function releaseWithToken(dir: string, home: string, deps: InspectDeps, opts: Parameters<typeof releaseScratch>[3] = {}) {
	return releaseScratch(dir, home, deps, { ...opts, capability: ownerCapability.token });
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
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=grade\nrepo=${repo}\ncreated=2026-10-22T06:00:00.000Z\ncapability_sha256=${ownerCapability.sha256}\nbin=throwaway\npurpose=grader-tmpdir\n`);
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
	const refused = releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true });
	expect(refused).toMatchObject({ ok: false, changed: false, reason: "user-live" });
	expect(refused.detail).toContain(`pid ${USER_PID}`);
	expect(refused.detail).toContain(USER_START);
	expect(refused.detail).toContain("is live");
	expect(refused.detail).toContain("scratch unuse");
	expect(existsSync(join(dir, "item.json"))).toBe(true);
	// Released marker-only (no --now), the dir is still kept by apply while its user runs.
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway" })).toMatchObject({ ok: true, reason: "owner-released" });
	expect(inspectOne(dir, root, deps(world))).toMatchObject({ action: "LIVE", reason: "user-live" });
	applyScratch(home, { ...deps(world), home });
	expect(existsSync(join(dir, "item.json"))).toBe(true);
	// Control: the user exits; the same release retires the dir.
	world.table.delete(USER_PID);
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(dir)).toBe(false);
});

test("control: apply moves the released dir once its user has exited", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway" })).toMatchObject({ ok: true });
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
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
});

test("zombie and dead users do not block; an unknown probe blocks, because unknown is never dead", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	world.table.set(USER_PID, { start: USER_START, state: "zombie" });
	expect(blockingScratchUser(dir, liveness(world))).toBeNull();
	world.table.set(USER_PID, { start: USER_START, state: "unknown" });
	expect(blockingScratchUser(dir, liveness(world))).toMatchObject({ pid: USER_PID, state: "unknown" });
	const refused = releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true });
	expect(refused).toMatchObject({ ok: false, reason: "user-live" });
	expect(refused.detail).toContain("is unknown");
	expect(existsSync(dir)).toBe(true);
});

test("a malformed .users file blocks (unreadable evidence is not absence); a well-formed empty one does not", () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map() };
	writeFileSync(join(dir, SCRATCH_USERS_FILE), "not json");
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "user-live" });
	writeFileSync(join(dir, SCRATCH_USERS_FILE), `${JSON.stringify({ version: 1, users: [] })}\n`);
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
});

test("unuse removes the block while the user still runs", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	await register(dir, world);
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "user-live" });
	expect(await updateScratchUsers(dir, USER_PID, "unuse", { liveness: liveness(world) })).toMatchObject({ ok: true, reason: "user-removed", users: [] });
	expect(JSON.parse(readFileSync(join(dir, SCRATCH_USERS_FILE), "utf8"))).toEqual({ version: 1, users: [] });
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
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

// Review 4 finding #1: `.users` is bookkeeping, not content. It must not move the transfer digest, and its bytes must not
// count as a byte-identical copy of the dir's content.
test("use then unuse leaves the transfer digest unchanged", async () => {
	const { dir } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	const before = scratchContent(dir)?.digest;
	expect(before).toBeDefined();
	await register(dir, world);
	expect(await updateScratchUsers(dir, USER_PID, "unuse", { liveness: liveness(world) })).toMatchObject({ ok: true });
	expect(existsSync(join(dir, SCRATCH_USERS_FILE))).toBe(true);
	expect(scratchContent(dir)?.digest).toBe(before);
});

test("a pushed copy of the empty .users file proves nothing; a pushed copy of result.json proves the transfer", async () => {
	const { home } = fixture();
	const projectDir = ownedTmp("users-repo", { root: scratchParent }).path;
	const remoteDir = ownedTmp("users-remote", { root: scratchParent }).path;
	cleanup.push(projectDir, remoteDir);
	const isolate = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	const gitEnv: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined)), ...isolate };
	const git = (...args: string[]) => run(["git", "-C", projectDir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { deadline_s: 60, env: gitEnv });
	expect((await run(["git", "init", "-q", "--bare", remoteDir], { deadline_s: 60, env: gitEnv })).rc).toBe(0);
	expect((await git("init", "-q", "-b", "main")).rc).toBe(0);
	const emptyUsers = `${JSON.stringify({ version: 1, users: [] })}\n`;
	expect(emptyUsers.length).toBe(25);
	writeFileSync(join(projectDir, "users-copy.json"), emptyUsers);
	writeFileSync(join(projectDir, "result-copy.json"), "{\"score\":0.93}\n");
	expect((await git("add", ".")).rc).toBe(0);
	expect((await git("commit", "-q", "-m", "init")).rc).toBe(0);
	expect((await git("remote", "add", "origin", remoteDir)).rc).toBe(0);
	expect((await git("push", "-q", "-u", "origin", "main")).rc).toBe(0);
	// The owner's repo holds the scratch root, as release --now requires.
	const root = join(projectDir, "var", "agent-tmp");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const dir = join(root, `grade.${process.pid}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=grade\nrepo=${projectDir}\ncreated_at=2026-10-22T06:00:00.000Z\nargv0=test\ncapability_sha256=${ownerCapability.sha256}\n`);
	writeFileSync(join(dir, "result.json"), "{\"score\":0.93}\n");
	writeFileSync(join(dir, SCRATCH_USERS_FILE), emptyUsers);
	// The transfer check runs through the production runner; its git reads see the isolated config via the environment.
	const savedGit = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
	Object.assign(process.env, isolate);
	try {
		const world: World = { table: new Map() };
		const real: InspectDeps = { ...deps(world), run: defaultRunner };
		expect(releaseWithToken(dir, home, real, { bin: "evidence", ref: "file:users-copy.json", now: true }))
			.toMatchObject({ ok: false, reason: "ref-transfer-unproven" });
		expect(existsSync(join(dir, "result.json"))).toBe(true);
		// Control: a byte-identical pushed copy of result.json proves and releases.
		expect(releaseWithToken(dir, home, real, { bin: "evidence", ref: "file:result-copy.json", now: true }))
			.toMatchObject({ ok: true, reason: "owner-released-deleted" });
		expect(existsSync(dir)).toBe(false);
	} finally {
		for (const [key, value] of Object.entries(savedGit)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

// Review 4 finding #5a: the quarantine expiry delete rechecks registered users like every other deleter.
test("an expired quarantine entry with a live registered user is kept; a dead user's is deleted", () => {
	const { home } = fixture();
	delete process.env.XDG_CONFIG_HOME;
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
	const plant = (label: string): string => {
		const path = join(qt, quarantineEntryFor(label, old));
		mkdirSync(path);
		writeFileSync(join(path, "item.json"), "{}");
		writeFileSync(join(path, SCRATCH_USERS_FILE), `${JSON.stringify({ version: 1, users: [{ pid: USER_PID, start: USER_START }] })}\n`);
		for (const p of [join(path, "item.json"), join(path, SCRATCH_USERS_FILE), path]) utimesSync(p, old, old);
		return path;
	};
	const kept = plant("kept.1");
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	const rows = applyQuarantineExpiry(home, { ...deps(world), home });
	expect(rows.find(row => row.dir === kept)).toMatchObject({ action: "LIVE", reason: "user-live" });
	expect(existsSync(join(kept, "item.json"))).toBe(true);
	expect(readFileSync(reapLogPath(home), "utf8")).toContain(`pid ${USER_PID}`);
	// Control: the user exits; the same entry expires.
	world.table.delete(USER_PID);
	const after = applyQuarantineExpiry(home, { ...deps(world), home });
	expect(after.find(row => row.dir === kept)).toMatchObject({ reason: "quarantine-expired" });
	expect(existsSync(kept)).toBe(false);
});

// Review 4 finding #5b: registration and deletion serialize on one lock, so a user is never left registered in a
// deleted dir: a `use` in flight makes the deleter refuse; a `use` that waits behind the deleter finds the dir gone.
test("a use holding the users lock makes release --now refuse; a use that waits behind the delete is refused", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	const inFlight = await privateLock({ namespace: "scratch-users", path: dir }, { deadline_s: 1 });
	const busy = releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true });
	inFlight.release();
	expect(busy).toMatchObject({ ok: false, reason: "now-held-users-lock-busy" });
	expect(existsSync(join(dir, "item.json"))).toBe(true);
	await register(dir, world);
	expect(releaseWithToken(dir, home, deps(world), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "user-live" });
	expect(await updateScratchUsers(dir, USER_PID, "unuse", { liveness: liveness(world) })).toMatchObject({ ok: true });
	// The deleter holds the lock across its delete; a use started mid-delete waits, then finds no dir.
	let late: Promise<Awaited<ReturnType<typeof updateScratchUsers>>> | null = null;
	const remove = (path: string) => {
		late ??= updateScratchUsers(dir, USER_PID, "use", { liveness: liveness(world), incarnation: incarnationOf(world) });
		rmSync(path, { recursive: true, force: true });
	};
	expect(releaseWithToken(dir, home, { ...deps(world), removeTree: remove }, { bin: "throwaway", now: true }))
		.toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(late).not.toBeNull();
	expect(await late!).toMatchObject({ ok: false, reason: "directory-unavailable" });
	expect(existsSync(dir)).toBe(false);
});

// Review 4 finding #5c: use only registers inside a scratch root.
test("use refuses a dir outside the scratch roots; inside a root it registers", async () => {
	const { dir, home } = fixture();
	const world: World = { table: new Map([[USER_PID, { start: USER_START }]]) };
	const outside = join(home, "elsewhere");
	mkdirSync(outside);
	writeFileSync(join(outside, ".owner"), `pid=${process.pid}\nlabel=grade\nrepo=${repo}\ncreated=2026-10-22T06:00:00.000Z\n`);
	expect(await updateScratchUsers(outside, USER_PID, "use", { liveness: liveness(world), incarnation: incarnationOf(world) }))
		.toMatchObject({ ok: false, reason: "outside-scratch-root" });
	expect(existsSync(join(outside, SCRATCH_USERS_FILE))).toBe(false);
	await register(dir, world);
});
