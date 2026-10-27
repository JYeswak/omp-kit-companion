// ompkit-774u.4.1 SCRATCHCARRY1: a respawn rehomes .owner to the successor's pid and keeps the creator's pid in the
// directory name. The owner (the successor) must still be able to release that dir, the release must stand at plan and
// apply time, and a caller that is not the owner must not. The dir name is not release authority.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, inspectOne, releaseScratch, type InspectDeps, type LivenessDeps } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const CREATOR_PID = 59_901;
const OTHER_PID = 59_902;

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const deps = (extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness: noPid, run: clearRun, ...extra });

function fixture(ownerPid: number): { dir: string; root: string; home: string } {
	const root = ownedTmp("rehomed", { root: scratchParent }).path;
	const home = ownedTmp("rehomed-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	// The creator's pid is in the name; respawn_seat rewrote pid= to the successor and kept the name.
	const dir = join(root, `work.${CREATOR_PID}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), `pid=${ownerPid}\nlabel=work\nrepo=${repo}\ncreated=2026-10-18T17:32:44.000Z\n`);
	writeFileSync(join(dir, "notes.txt"), "work");
	return { dir, root, home };
}

test("the successor that owns a rehomed dir releases it; the release stands at plan time as owner-released", () => {
	const { dir, root, home } = fixture(process.pid);
	const released = releaseScratch(dir, home, deps());
	expect(released).toMatchObject({ ok: true, changed: true, reason: "owner-released", ownerPid: process.pid });
	expect(existsSync(join(dir, ".omp-kit-release"))).toBe(true);
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "QUARANTINE", reason: "owner-released-would-quarantine" });
});

test("a caller that is not the owner, and not a descendant of it, cannot release a rehomed dir", () => {
	const { dir, home } = fixture(OTHER_PID);
	expect(releaseScratch(dir, home, deps())).toMatchObject({ ok: false, changed: false, reason: "caller-not-owner", ownerPid: OTHER_PID });
	expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
});

test("an unreleased rehomed dir whose owner is gone is not reaped on sight: the name mismatch keeps its old, safe SKIP", () => {
	const { dir, root } = fixture(OTHER_PID);
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "SKIP", reason: "session-name-owner-mismatch" });
	expect(existsSync(dir)).toBe(true);
});

test("apply moves an owner-released rehomed dir into quarantine; an unreleased one beside it stays", () => {
	const { dir, root, home } = fixture(process.pid);
	const keep = join(root, `keep.${CREATOR_PID + 5}`);
	mkdirSync(keep);
	writeFileSync(join(keep, ".owner"), `pid=${OTHER_PID}\nlabel=keep\nrepo=${repo}\ncreated=2026-10-18T17:32:44.000Z\n`);
	expect(releaseScratch(dir, home, deps()).ok).toBe(true);
	const result = applyScratch(home, { ...deps(), home });
	expect(existsSync(dir)).toBe(false);
	expect(existsSync(keep)).toBe(true);
	expect(result.applied.some((verdict) => verdict.reason === "owner-released-quarantined" && verdict.dir.includes(`work.${CREATOR_PID}`))).toBe(true);
	expect(readdirSync(join(home, "state", "omp-kit", "scratch-quarantine")).length).toBe(1);
});

test("a legacy (free-form owner) release stays bound to the directory name it was made under: a renamed dir is not quarantined on its marker", () => {
	const { dir, root, home } = fixture(process.pid);
	writeFileSync(join(dir, ".owner"), "work\n");
	expect(releaseScratch(dir, home, deps(), { legacyOwner: true, reason: "operator release of a free-form owner" })).toMatchObject({ ok: true, changed: true });
	expect(inspectOne(dir, root, deps())).toMatchObject({ action: "QUARANTINE", reason: "owner-released-would-quarantine" });
	const moved = join(root, "renamed");
	renameSync(dir, moved);
	expect(inspectOne(moved, root, deps())?.reason).not.toBe("owner-released-would-quarantine");
});

test("a hidden or path-like label is still refused: the release is bound to a valid owner record", () => {
	const { dir, home } = fixture(process.pid);
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=.hidden\nrepo=${repo}\ncreated=2026-10-18T17:32:44.000Z\n`);
	expect(releaseScratch(dir, home, deps())).toMatchObject({ ok: false, changed: false });
	expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
});
