// REAPRO1 (ompkit-nuvvw): installs leave read-only subdirs (`releases/<v>` 0555). Once a dir has passed every gate,
// `release --now` and the reaper's delete give each real dir inside it owner rwx and retry once, never following a
// symlink: a 0555 dir outside, reached only through a symlink, keeps its mode and content.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, releaseScratch, type ApplyDeps, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const companion = resolve(import.meta.dir, "../..");
const scratchParent = join(companion, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const owned: OwnedTmp[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const tmp of owned.splice(0)) tmp.cleanup();
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null };

/** An owned scratch dir holding `releases/1.0` (0555, with a file) and a symlink to a 0555 dir outside it. */
function world(ownerPid: number): { dir: string; home: string; outside: string } {
	const tmp = ownedTmp("scratch-ro", { root: scratchParent });
	owned.push(tmp);
	const repo = join(tmp.path, "repo");
	const root = join(repo, "var", "agent-tmp");
	const home = join(tmp.path, "home");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	const dir = join(root, `ro.${ownerPid}`);
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(dir, ".owner"), `pid=${ownerPid}\nlabel=ro\nrepo=${repo}\ncreated=2026-10-01T00:00:00Z\nbin=throwaway\npurpose=probe\n`);
	const release = join(dir, "releases", "1.0");
	mkdirSync(release, { recursive: true });
	writeFileSync(join(release, "bin"), "installed\n");
	chmodSync(release, 0o555);
	const outside = join(tmp.path, "outside");
	mkdirSync(outside);
	writeFileSync(join(outside, "keep"), "outside\n");
	chmodSync(outside, 0o555);
	symlinkSync(outside, join(dir, "releases", "link"));
	return { dir, home, outside };
}

function outsideIntact(outside: string): void {
	expect(lstatSync(outside).mode & 0o777).toBe(0o555);
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside\n");
	chmodSync(outside, 0o755);
}

test("release --now removes an owned dir holding a 0555 subdir, never touching a symlinked dir outside", () => {
	const { dir, home, outside } = world(process.pid);
	const released = releaseScratch(dir, home, { liveness: noPid, run: clearRun }, { bin: "throwaway", now: true });
	expect(released).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(dir)).toBe(false);
	outsideIntact(outside);
});

test("apply reaps a dead owner's dir holding a 0555 subdir, never touching a symlinked dir outside", () => {
	const { dir, home, outside } = world(999_998);
	const deps: ApplyDeps = { liveness: noPid, run: clearRun, home, systemTempBases: [] };
	const applied = applyScratch(home, deps);
	expect(applied.applied.find(verdict => verdict.dir === dir)?.action).toBe("REAP");
	expect(existsSync(dir)).toBe(false);
	outsideIntact(outside);
});
