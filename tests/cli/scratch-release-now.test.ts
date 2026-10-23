// ompkit-774u.15 SCRATCHBIN1 delete-at-once + SCRATCHRETIRE1 (ompkit-fp72.120.16.37): `release --bin <bin> --now`
// retires the dir in the same turn after the reaper-grade rechecks (pinned device+inode, unchanged owner, owner inside
// the root, no open files): throwaway at once, evidence and promote after their reference verified. Any doubt keeps the
// marked dir and is NOT success (ok false, now-held-*); --now is refused without a bin, on free-prose owners, and never
// touches a hold.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createScratch, releaseScratch, reapLogPath, scratchContent,
	type InspectDeps, type LivenessDeps, type ScratchRunner } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

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
// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const deps = (extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness: noPid, run: clearRun, now: NOW, ...extra });
const ownerText = (pid: number, extra = "", created = CREATED) => `pid=${pid}\nlabel=work\nrepo=${repo}\ncreated=${created}\n${extra}`;
function isolatedCliEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	env.HOME = home;
	env.XDG_STATE_HOME = join(home, "state");
	delete env.OMP_KIT_SCRATCH_ROOTS;
	return env;
}

function fixture(owner: string, label = "work"): { dir: string; home: string } {
	const root = ownedTmp("now", { root: scratchParent }).path;
	const home = ownedTmp("now-home", { root: scratchParent }).path;
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

test("now without a bin is refused and the dir stays unmarked", () => {
	const plain = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	expect(releaseScratch(plain.dir, plain.home, deps(), { now: true })).toMatchObject({ ok: false, reason: "now-needs-bin" });
	expect(existsSync(plain.dir)).toBe(true);
	expect(existsSync(join(plain.dir, ".omp-kit-release"))).toBe(false);
});

/** `br show` of a bead whose comment cites the dir's content token (TRANSFER1): the proven-transfer reference. */
const beadCiting = (dir: string): ScratchRunner => {
	const token = `scratch-sha256:${scratchContent(dir)!.digest}`;
	return (args) => args[0] === "br"
		? { code: 0, stdout: JSON.stringify([{ id: "ompkit-774u.15", comments: [{ text: `run results ${token}` }] }]), stderr: "" } : clearRun(args);
};
const gitUntracked: ScratchRunner = (args) => args[0] === "git" ? { code: 1, stdout: "", stderr: "error: pathspec" } : clearRun(args);

test("SCRATCHRETIRE1 AC2: evidence whose reference proves the transfer retires its source at once", () => {
	const evidenced = fixture(ownerText(process.pid, "bin=evidence\nbead=ompkit-774u.15\n"));
	writeFileSync(join(evidenced.dir, "run.out"), "measured");
	expect(releaseScratch(evidenced.dir, evidenced.home, deps({ run: beadCiting(evidenced.dir) }), { bin: "evidence", ref: "bead:ompkit-774u.15", now: true }))
		.toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(evidenced.dir)).toBe(false);
	expect(logEvents(evidenced.home).filter((e) => e.event === "release-deleted" && e.bin === "evidence")).toHaveLength(1);
});

test("SCRATCHRETIRE1 AC2 planted: an untracked reference refuses and preserves the source, unmarked", () => {
	const evidenced = fixture(ownerText(process.pid, "bin=evidence\nbead=ompkit-774u.15\n"));
	expect(releaseScratch(evidenced.dir, evidenced.home, deps({ run: gitUntracked }), { bin: "evidence", ref: "file:package.json", now: true }))
		.toMatchObject({ ok: false, changed: false, reason: "ref-not-tracked" });
	expect(existsSync(evidenced.dir)).toBe(true);
	expect(existsSync(join(evidenced.dir, ".omp-kit-release"))).toBe(false);
});

test("an open file or missing lsof evidence keeps the marked dir and is not success", () => {
	const busy = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(busy.dir, "open.txt"), "held");
	const held = releaseScratch(busy.dir, busy.home, deps({ lsofSnapshot: new Set([join(busy.dir, "open.txt")]) }), { bin: "throwaway", now: true });
	expect(held).toMatchObject({ ok: false, changed: true, reason: "now-held-open-fds" });
	expect(held.detail).toContain("still yours to retire");
	expect(existsSync(busy.dir)).toBe(true);
	expect(existsSync(join(busy.dir, ".omp-kit-release"))).toBe(true);
	const blind = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	const unknown = releaseScratch(blind.dir, blind.home, deps({ lsofSnapshot: null }), { bin: "throwaway", now: true });
	expect(unknown).toMatchObject({ ok: false, changed: true, reason: "now-held-lsof-unavailable" });
	expect(existsSync(blind.dir)).toBe(true);
	expect(existsSync(join(blind.dir, ".omp-kit-release"))).toBe(true);
});

// SCRATCHRETIRE1 AC5: a delete that fails partway keeps the released dir, reports non-success with the retained
// responsibility, and claims no reclaimed bytes; once the cause clears, the same release retires it. A read-only nested
// dir is no longer a cause (REAPRO1 grants owner rwx and retries), so the failure is injected through the removeTree
// seam: the real remover takes `top.txt`, then the nested `locked` dir refuses, on every OS.
test("a partial delete failure keeps the marked dir, is not success, and claims no bytes; a later --now retires it", () => {
	const stuck = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(stuck.dir, "top.txt"), "first");
	const locked = join(stuck.dir, "locked");
	mkdirSync(locked);
	writeFileSync(join(locked, "inner.txt"), "second");
	const failingOnLocked = (path: string): void => {
		if (path === locked) throw Object.assign(new Error("EACCES: injected"), { code: "EACCES" });
		rmSync(path, { recursive: true, force: true });
	};
	{
		const held = releaseScratch(stuck.dir, stuck.home, deps({ lsofSnapshot: new Set(), removeTree: failingOnLocked }), { bin: "throwaway", now: true });
		expect(held).toMatchObject({ ok: false, changed: true, reason: "now-held-delete-failed" });
		expect(held.detail).toContain("still yours to retire");
		expect(Object.keys(held).filter((key) => ["bytes", "reclaimedBytes", "freedBytes", "bytesReclaimed"].includes(key))).toEqual([]);
		expect(existsSync(stuck.dir)).toBe(true);
		expect(existsSync(join(stuck.dir, ".omp-kit-release"))).toBe(true);
	}
	expect(releaseScratch(stuck.dir, stuck.home, deps({ lsofSnapshot: new Set() }), { bin: "throwaway", now: true }))
		.toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(stuck.dir)).toBe(false);
});

// SCRATCHRETIRE1 AC3 planted: the old marker-only release (a delete that removes nothing) must fail the physical-absence
// check and be held, never success; the paired control, the real remover on the same shape, retires the dir.
test("a delete that removes nothing is held by the physical-absence check; the real remover retires the dir", () => {
	const planted = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(planted.dir, "data.txt"), "kept");
	const noop = releaseScratch(planted.dir, planted.home, deps({ lsofSnapshot: new Set(), removeTree: () => {} }), { bin: "throwaway", now: true });
	expect(noop).toMatchObject({ ok: false, reason: "now-held-delete-failed" });
	expect(existsSync(planted.dir)).toBe(true);
	const control = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(control.dir, "data.txt"), "gone");
	expect(releaseScratch(control.dir, control.home, deps({ lsofSnapshot: new Set() }), { bin: "throwaway", now: true }))
		.toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(control.dir)).toBe(false);
});

test("a hold is never deleted by now", () => {
	const hold = fixture(ownerText(process.pid, "bin=hold\nbead=ompkit-774u.15\nexpires=2026-10-27\n"));
	expect(releaseScratch(hold.dir, hold.home, deps(), { bin: "hold", now: true })).toMatchObject({ ok: false });
	expect(existsSync(hold.dir)).toBe(true);
	expect(releaseScratch(hold.dir, hold.home, deps(), { bin: "hold" })).toMatchObject({ ok: false, reason: "hold-is-declared-at-creation" });
});

// SCRATCHRETIRE1 (ompkit-fp72.120.16.37): disposal follows job completion, not the reaper (Joshua). A throwaway its owner
// released marker-only stayed on disk for the paused reaper: on 2026-10-22 one such dir held 64 GB of an 83 GB-free disk.
test("planted: a throwaway released without now is retired by the owner's later release with now", () => {
	const marked = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(marked.dir, "residue.bin"), "x".repeat(4096));
	expect(releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, reason: "owner-released" });
	expect(existsSync(marked.dir)).toBe(true);
	expect(releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway", now: true }))
		.toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(marked.dir)).toBe(false);
	expect(logEvents(marked.home).filter((e) => e.event === "release-deleted" && e.dir === marked.dir)).toHaveLength(1);
});

test("control: a re-release without now, or under a different bin or ref, keeps the dir", () => {
	const marked = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway" });
	expect(releaseScratch(marked.dir, marked.home, deps(), { bin: "throwaway" })).toMatchObject({ ok: true, changed: false, reason: "already-released" });
	expect(existsSync(marked.dir)).toBe(true);
	const evidenced = fixture(ownerText(process.pid, "bin=evidence\nbead=ompkit-774u.15\n"));
	writeFileSync(join(evidenced.dir, "run.out"), "measured");
	const citing = beadCiting(evidenced.dir);
	expect(releaseScratch(evidenced.dir, evidenced.home, deps({ run: citing }), { bin: "evidence", ref: "bead:ompkit-774u.15" }))
		.toMatchObject({ ok: true, reason: "owner-released" });
	const asThrowaway = releaseScratch(evidenced.dir, evidenced.home, deps({ run: citing }), { bin: "throwaway", now: true });
	expect(asThrowaway.reason).not.toBe("owner-released-deleted");
	const otherRef = releaseScratch(evidenced.dir, evidenced.home, deps({ run: citing }), { bin: "evidence", ref: "bead:ompkit-other", now: true });
	expect(otherRef.reason).not.toBe("owner-released-deleted");
	expect(existsSync(evidenced.dir)).toBe(true);
});

test("planted: evidence released without now is retired by the owner's later same-ref release with now", () => {
	const evidenced = fixture(ownerText(process.pid, "bin=evidence\nbead=ompkit-774u.15\n"));
	writeFileSync(join(evidenced.dir, "run.out"), "measured");
	const citing = beadCiting(evidenced.dir);
	releaseScratch(evidenced.dir, evidenced.home, deps({ run: citing }), { bin: "evidence", ref: "bead:ompkit-774u.15" });
	expect(existsSync(evidenced.dir)).toBe(true);
	expect(releaseScratch(evidenced.dir, evidenced.home, deps({ run: citing }), { bin: "evidence", ref: "bead:ompkit-774u.15", now: true }))
		.toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(evidenced.dir)).toBe(false);
});

test("retiring a marker-only throwaway with an open file keeps the dir and its marker, not success", () => {
	const busy = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(busy.dir, "open.txt"), "held");
	releaseScratch(busy.dir, busy.home, deps(), { bin: "throwaway" });
	const held = releaseScratch(busy.dir, busy.home, deps({ lsofSnapshot: new Set([join(busy.dir, "open.txt")]) }), { bin: "throwaway", now: true });
	expect(held).toMatchObject({ ok: false, reason: "now-held-open-fds" });
	expect(existsSync(join(busy.dir, ".omp-kit-release"))).toBe(true);
});

// The --now path existed in cli.ts but the command registry never declared the flag, so `omp-kit scratch release
// DIR --bin throwaway --now` failed UNKNOWN_FLAG and delete-at-once was unreachable from the CLI (2026-10-22).
test("the CLI accepts --now and retires the directory", () => {
	const { dir, home } = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(dir, "work.txt"), "done");
	const cli = Bun.spawnSync([process.execPath, join(repo, "src", "cli.ts"), "scratch", "release", dir, "--bin", "throwaway", "--now", "--json"], {
		cwd: repo, env: { ...process.env, HOME: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const out = JSON.parse(cli.stdout.toString()) as { ok: boolean; data?: { reason?: string }; errors?: { code: string }[] };
	expect(out.errors?.map((e) => e.code) ?? []).not.toContain("UNKNOWN_FLAG");
	expect(out.ok).toBe(true);
	expect(existsSync(dir)).toBe(false);
});

test("scratch new refuses an unregistered hidden repository before creating a scratch directory", async () => {
	const home = ownedTmp("hidden-home", { root: scratchParent }).path;
	cleanup.push(home);
	const hiddenRepo = join(home, ".claude");
	mkdirSync(join(hiddenRepo, ".git"), { recursive: true });
	const result = await run([process.execPath, join(repo, "src", "cli.ts"), "scratch", "new",
		"--label", "hidden-root", "--json"], { deadline_s: 15, cwd: hiddenRepo, env: isolatedCliEnv(home) });
	const out = JSON.parse(new TextDecoder().decode(result.stdout)) as {
		errors?: { code: string; message: string; remediation: string }[];
	};
	expect(result.rc).toBe(2);
	expect(result.timed_out).toBe(false);
	expect(out.errors?.[0]?.code).toBe("SCRATCH_NEW_REFUSED");
	expect(out.errors?.[0]?.message).toContain("scratch-root-unrecognized");
	expect(out.errors?.[0]?.remediation).toContain("OMP_KIT_SCRATCH_ROOTS");
	const root = join(hiddenRepo, "var", "agent-tmp");
	const leafDirs = existsSync(root) ? readdirSync(root).filter(name => name.startsWith("hidden-root.")) : [];
	expect(leafDirs).toEqual([]);
});

test("scratch new and release roundtrip under a registered Developer root", async () => {
	const home = ownedTmp("developer-home", { root: scratchParent }).path;
	cleanup.push(home);
	const project = join(home, "Developer", "project");
	mkdirSync(join(project, ".git"), { recursive: true });
	const env = isolatedCliEnv(home);
	const created = await run([process.execPath, join(repo, "src", "cli.ts"), "scratch", "new",
		"--label", "registered-root", "--json"], { deadline_s: 15, cwd: project, env });
	const createdOutput = JSON.parse(new TextDecoder().decode(created.stdout)) as {
		data?: { overall?: string; dir?: string; capability?: string };
	};
	expect(created.rc).toBe(0);
	expect(created.timed_out).toBe(false);
	expect(createdOutput.data?.overall).toBe("OK");
	const dir = createdOutput.data?.dir;
	const capability = createdOutput.data?.capability;
	if (!dir || !capability) throw new Error("scratch new returned no directory or capability");
	expect(dir.startsWith(join(project, "var", "agent-tmp", "registered-root."))).toBe(true);
	const released = await run([process.execPath, join(repo, "src", "cli.ts"), "scratch", "release", dir,
		"--bin", "throwaway", "--now", "--capability", capability, "--json"],
	{ deadline_s: 15, cwd: project, env });
	const releasedOutput = JSON.parse(new TextDecoder().decode(released.stdout)) as {
		data?: { overall?: string; deleted?: boolean };
	};
	expect(released.rc).toBe(0);
	expect(released.timed_out).toBe(false);
	expect(releasedOutput.data?.overall).toBe("CHANGED");
	expect(releasedOutput.data?.deleted).toBe(true);
	expect(existsSync(dir)).toBe(false);
});


test("--now without an injected snapshot takes one system-wide lsof snapshot, never the per-dir walk", () => {
	const { dir, home } = fixture(ownerText(process.pid, "bin=throwaway\npurpose=probe\n"));
	writeFileSync(join(dir, "residue.bin"), "x");
	const calls: string[][] = [];
	const run: ScratchRunner = (args) => {
		calls.push([...args]);
		if (args[0] === "lsof" && args[1] === "+D") return { code: null, stdout: "", stderr: "timed out" };
		if (args[0] === "lsof" && args[1] === "-nP") return { code: 0, stdout: "p1\nn/somewhere/else.txt\n", stderr: "" };
		return clearRun(args);
	};
	expect(releaseScratch(dir, home, deps({ run }), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(dir)).toBe(false);
	expect(calls.some((a) => a[0] === "lsof" && a[1] === "+D")).toBe(false);
});

test("now on a free-prose owner is refused: structured ownership first (79c377fe42 still applies)", () => {
	const { dir, home } = fixture("just-a-label");
	const released = releaseScratch(dir, home, deps(), { now: true });
	expect(released).toMatchObject({ ok: false, reason: "now-needs-structured-owner" });
	expect(existsSync(dir)).toBe(true);
});

test("createScratch dirs release with now through the same path", () => {
	// The recorded start is this stub's; the owner's incarnation probe is planted live (ompkit-5m6ej) to match it.
	const live: LivenessDeps = { ...noPid, signalAlive: () => true, processStart: () => "Mon Oct 20 06:00:00 2026",
		probe: (owner) => ({ state: "live", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: owner.start, stat: "S", signal0: null, reason: "planted" } }) };
	process.env.OMP_KIT_SCRATCH_ROOTS = scratchParent;
	const home = ownedTmp("now-home", { root: scratchParent }).path;
	cleanup.push(home);
	const created = createScratch("nowproof", repo, deps({ liveness: live }), { bin: "throwaway", purpose: "probe" }, false, join(home, "scratch-budgets.json"));
	expect(created.ok).toBe(true);
	cleanup.push(created.dir);
	const released = releaseScratch(created.dir, home, deps({ liveness: live }), { bin: "throwaway", now: true });
	expect(released).toMatchObject({ ok: true, changed: true, reason: "owner-released-deleted" });
	expect(existsSync(created.dir)).toBe(false);
});
