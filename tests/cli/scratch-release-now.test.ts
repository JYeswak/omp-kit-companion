// ompkit-774u.15 SCRATCHBIN1 delete-at-once: `release --bin throwaway --now` deletes the dir in the
// same turn after the reaper-grade rechecks (pinned device+inode, unchanged owner, owner inside the
// root, no open files). Any doubt keeps the marked dir for the reaper (ok, now-held-*); --now is
// refused without a throwaway bin, on free-prose owners, and never touches a hold.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScratch, releaseScratch, reapLogPath,
	type InspectDeps, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const NOW = Date.parse("2026-10-20T07:00:00.000Z");
const CREATED = "2026-10-20T06:00:00.000Z";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null };
const deps = (extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness: noPid, run: clearRun, now: NOW, ...extra });
const ownerText = (pid: number, extra = "", created = CREATED) => `pid=${pid}\nlabel=work\nrepo=${repo}\ncreated=${created}\n${extra}`;

function fixture(owner: string, label = "work"): { dir: string; home: string } {
	const root = mkdtempSync(join(scratchParent, "now-"));
	const home = mkdtempSync(join(scratchParent, "now-home-"));
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const dir = join(root, `${label}.${process.pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), owner);
	return { dir, home };
}

function logEvents(home: string): Array<Record<string, unknown>> {
	const path = reapLogPath(home);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

test("a throwaway release with now deletes the dir at once and logs the deletion", () => {
	const { dir, home } = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(dir, "work.txt"), "done");
	const released = releaseScratch(dir, home, deps(), { bin: "throwaway", now: true });
	expect(released).toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(dir)).toBe(false);
	const events = logEvents(home);
	expect(events.filter((e) => e.event === "release" && e.dir === dir)).toHaveLength(1);
	expect(events.filter((e) => e.event === "release-deleted" && e.dir === dir && e.bin === "throwaway")).toHaveLength(1);
});

test("now without a throwaway bin is refused and the dir stays unmarked", () => {
	const plain = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	expect(releaseScratch(plain.dir, plain.home, deps(), { now: true })).toMatchObject({ ok: false, reason: "now-needs-throwaway" });
	expect(existsSync(plain.dir)).toBe(true);
	expect(existsSync(join(plain.dir, ".omp-kit-release"))).toBe(false);
	const evidenced = fixture(ownerText(process.pid, "bin=evidence\nbead=ompkit-774u.15\n"));
	const gitTracked: ScratchRunner = (args) => args[0] === "git" ? { code: 0, stdout: "package.json\n", stderr: "" } : clearRun(args);
	expect(releaseScratch(evidenced.dir, evidenced.home, deps({ run: gitTracked }), { bin: "evidence", ref: "file:package.json", now: true }))
		.toMatchObject({ ok: false, reason: "now-needs-throwaway" });
	expect(existsSync(evidenced.dir)).toBe(true);
	expect(existsSync(join(evidenced.dir, ".omp-kit-release"))).toBe(false);
});

test("an open file holds the marked dir for the reaper; missing lsof evidence holds too", () => {
	const busy = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(busy.dir, "open.txt"), "held");
	const held = releaseScratch(busy.dir, busy.home, deps({ lsofSnapshot: new Set([join(busy.dir, "open.txt")]) }), { bin: "throwaway", now: true });
	expect(held).toMatchObject({ ok: true, changed: true, reason: "now-held-open-fds" });
	expect(existsSync(busy.dir)).toBe(true);
	expect(existsSync(join(busy.dir, ".omp-kit-release"))).toBe(true);
	const blind = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	const unknown = releaseScratch(blind.dir, blind.home, deps({ lsofSnapshot: null }), { bin: "throwaway", now: true });
	expect(unknown).toMatchObject({ ok: true, changed: true, reason: "now-held-lsof-unavailable" });
	expect(existsSync(blind.dir)).toBe(true);
	expect(existsSync(join(blind.dir, ".omp-kit-release"))).toBe(true);
});

test("a hold is never deleted by now; an already-released dir stays the reaper's job", () => {
	const hold = fixture(ownerText(process.pid, "bin=hold\nbead=ompkit-774u.15\nexpires=2026-10-27\n"));
	expect(releaseScratch(hold.dir, hold.home, deps(), { bin: "hold", now: true })).toMatchObject({ ok: false });
	expect(existsSync(hold.dir)).toBe(true);
	expect(releaseScratch(hold.dir, hold.home, deps(), { bin: "hold" })).toMatchObject({ ok: false, reason: "hold-is-declared-at-creation" });
	const marked = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	expect(releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, reason: "owner-released" });
	expect(releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway", now: true }))
		.toMatchObject({ ok: true, reason: "already-released" });
	expect(existsSync(marked.dir)).toBe(true);
});

test("now on a free-prose owner is refused: structured ownership first (79c377fe42 still applies)", () => {
	const { dir, home } = fixture("just-a-label");
	const released = releaseScratch(dir, home, deps(), { now: true });
	expect(released).toMatchObject({ ok: false, reason: "now-needs-structured-owner" });
	expect(existsSync(dir)).toBe(true);
});

test("createScratch dirs release with now through the same path", () => {
	const live: LivenessDeps = { ...noPid, signalAlive: () => true, processStart: () => "Mon Oct 20 06:00:00 2026" };
	process.env.OMP_KIT_SCRATCH_ROOTS = scratchParent;
	const home = mkdtempSync(join(scratchParent, "now-home-"));
	cleanup.push(home);
	const created = createScratch("nowproof", repo, deps({ liveness: live }), { bin: "throwaway", purpose: "probe" });
	expect(created.ok).toBe(true);
	cleanup.push(created.dir);
	const released = releaseScratch(created.dir, home, deps({ liveness: live }), { bin: "throwaway", now: true });
	expect(released).toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(created.dir)).toBe(false);
});
