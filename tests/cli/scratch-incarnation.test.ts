// ompkit-5m6ej (KL09 part b): scratch owner liveness goes through kitlib proc. A recorded {pid, start} incarnation that
// is a zombie or reused reads dead; an unreadable probe (unknown) is never dead, so it neither reaps nor releases.
// Liveness is evidence only: who owns a dir, and who may release it, is unchanged. Subjects are real processes owned by
// one kitlib run tree; each planted case has a passing control.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	applyQuarantineExpiry, createScratch, defaultLiveness, inspectSession, ownerIncarnationState, parseOwnerFile, probeOwner, quarantineDir,
	quarantineEntryFor, releaseScratch, type ApplyDeps, type InspectDeps, type LivenessDeps,
} from "../../src/scratch.ts";
import { incarnation, type Incarnation, type Probe, type ProbeState } from "../../src/kitlib/proc.ts";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state], ["XDG_CONFIG_HOME", saved.config]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
const real = (): InspectDeps => ({ liveness: defaultLiveness(), run: clearRun });
const planted = (state: ProbeState): LivenessDeps => ({ ...defaultLiveness(),
	probe: (owner: Incarnation): Probe => ({ state, evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: null, reason: "planted" } }) });
const ownerText = (pid: number, start: string, label = "omp") =>
	`pid=${pid}\nprocess_start=${start}\nlabel=${label}\nrepo=${repo}\ncreated_at=2026-10-01T00:00:00Z\nargv0=test\n`;

function tempDir(label: string): string {
	const dir = ownedTmp(label, { root: scratchParent }).path;
	cleanup.push(dir);
	return dir;
}

/** A scratch dir `<label>.<pid>` under a fresh root, owned by `{pid, start}`. */
function ownedDir(pid: number, start: string, label = "omp"): { root: string; dir: string } {
	const root = tempDir("incarnation-root");
	const dir = join(root, `${label}.${pid}`);
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), ownerText(pid, start, label));
	return { root, dir };
}

type Subjects = { live: Incarnation; zombie: Incarnation; stop: () => Promise<void> };

/**
 * One kitlib-run tree: /bin/sh forks two sleeps, writes their pids, then exec's into sleep, which never reaps. The first
 * sleep is killed and stays a zombie; the second stays live. `stop` aborts the run, which kills the whole group.
 */
async function subjects(): Promise<Subjects> {
	const out = join(tempDir("incarnation-subjects"), "pids");
	const controller = new AbortController();
	const tree = run(["/bin/sh", "-c", 'sleep 30 & z=$!; sleep 30 & l=$!; echo "$z $l" > "$1.tmp" && mv "$1.tmp" "$1"; exec sleep 30', "subjects", out],
		{ deadline_s: 60, signal: controller.signal }).catch(() => { /* aborted by stop */ });
	const stop = async () => { controller.abort(new Error("subjects done")); await tree; };
	// Real-clock poll for a file a real child writes; no fake timer reaches another process.
	for (let tries = 0; !existsSync(out) && tries < 200; tries++) await Bun.sleep(25);
	if (!existsSync(out)) { await stop(); throw new Error("subject tree did not start"); }
	const [zombiePid, livePid] = readFileSync(out, "utf8").trim().split(" ").map(Number) as [number, number];
	const [zombie, live] = [await incarnation(zombiePid), await incarnation(livePid)];
	if (zombie === null || live === null) { await stop(); throw new Error("no incarnation for a subject"); }
	process.kill(zombiePid, "SIGKILL");
	// Real-clock poll: the OS marks the killed child Z on its own schedule, which no fake timer drives.
	for (let tries = 0; tries < 60 && ownerIncarnationState(zombiePid, zombie.start, {}) !== "zombie"; tries++) await Bun.sleep(50);
	return { live, zombie, stop };
}

test("planted: a zombie owner reads dead and its dir is reapable, where the pre-5m6ej probe read it alive; control: a live owner is LIVE", async () => {
	const { live, zombie, stop } = await subjects();
	try {
		expect(ownerIncarnationState(zombie.pid, zombie.start, {})).toBe("zombie");
		// The pre-5m6ej probe: kill -0 succeeds on a zombie and ps still prints its start, so it read "live".
		expect(probeOwner(zombie.pid, zombie.start, defaultLiveness())).toBe("live");
		const dead = ownedDir(zombie.pid, zombie.start);
		expect(inspectSession(dead.dir, dead.root, real())).toMatchObject({ action: "REAP", reason: "owner-zombie-no-open-fds" });
		const alive = ownedDir(live.pid, live.start);
		expect(inspectSession(alive.dir, alive.root, real())).toMatchObject({ action: "LIVE", reason: "owner-alive" });
	} finally {
		await stop();
	}
}, 60_000);

test("planted: a reused pid (same pid, other start) reads dead; control: a raw pre-5m6ej lstart with a run of spaces reads live", async () => {
	const { live, stop } = await subjects();
	try {
		const reused = ownedDir(live.pid, "Thu Jan  1 00:00:00 2015");
		expect(inspectSession(reused.dir, reused.root, real())).toMatchObject({ action: "REAP", reason: "owner-reused-no-open-fds" });
		// Owner files written before 5m6ej hold the raw `ps -o lstart=` text; the probe collapses whitespace on both sides.
		const raw = ownedDir(live.pid, live.start.replace(" ", "   "));
		expect(readFileSync(join(raw.dir, ".owner"), "utf8")).toContain("   ");
		expect(inspectSession(raw.dir, raw.root, real())).toMatchObject({ action: "LIVE", reason: "owner-alive" });
	} finally {
		await stop();
	}
}, 60_000);

test("planted: an unknown probe (ps unreadable) never reaps; control: a dead probe reaps the same dir", () => {
	const { root, dir } = ownedDir(4_242_42, "Mon Oct  5 13:27:00 2026");
	expect(inspectSession(dir, root, { liveness: planted("unknown"), run: clearRun })).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
	expect(inspectSession(dir, root, { liveness: planted("dead"), run: clearRun })).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	// A blank recorded start proves nothing: unknown, never dead.
	expect(ownerIncarnationState(4_242_42, "   ", { probe: () => { throw new Error("a blank start is never probed"); } })).toBe("unknown");
});

test("planted: an unknown probe never deletes a quarantined dir; control: a dead probe deletes it", () => {
	const home = tempDir("incarnation-home");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const entry = join(qt, quarantineEntryFor("held.424242", new Date(now - 30 * 86_400_000)));
	mkdirSync(entry);
	writeFileSync(join(entry, ".owner"), ownerText(424242, "Mon Oct  5 13:27:00 2026"));
	const deps = (state: ProbeState): ApplyDeps => ({ liveness: planted(state), run: clearRun, home, now, lsofSnapshot: new Set() });
	expect(applyQuarantineExpiry(home, deps("unknown")).find((row) => row.dir === entry)).toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
	expect(existsSync(entry)).toBe(true);
	expect(applyQuarantineExpiry(home, deps("zombie")).find((row) => row.dir === entry)?.reason).toBe("quarantine-expired-owner-zombie");
	expect(existsSync(entry)).toBe(false);
});

test("planted: an unknown probe never releases; control: a live probe releases the same dir", () => {
	const home = tempDir("incarnation-release-home");
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const { root, dir } = ownedDir(process.pid, "Mon Oct  5 13:27:00 2026");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const unknown = releaseScratch(dir, home, { liveness: planted("unknown"), run: clearRun });
	expect(unknown).toMatchObject({ ok: false, changed: false, reason: "owner-process-identity-unverified" });
	expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
	expect(releaseScratch(dir, home, { liveness: planted("zombie"), run: clearRun })).toMatchObject({ ok: false, changed: false });
	expect(releaseScratch(dir, home, { liveness: planted("live"), run: clearRun })).toMatchObject({ ok: true, changed: true, reason: "owner-released" });
});

test("createScratch records the start whitespace-collapsed, as kitlib proc compares it", () => {
	const root = tempDir("incarnation-create");
	const created = createScratch("collapsed", root, { liveness: { ...planted("live"), processStart: () => "Mon Oct  5 13:27:00 2026" }, run: clearRun },
		{}, false, join(root, "scratch-budgets.json"));
	expect(created.ok).toBe(true);
	expect(parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"))?.processStart).toBe("Mon Oct 5 13:27:00 2026");
});
