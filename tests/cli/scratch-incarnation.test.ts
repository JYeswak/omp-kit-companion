// ompkit-5m6ej (KL09 part b): scratch owner liveness goes through kitlib proc. A recorded {pid, start} incarnation that
// is a zombie or reused reads dead; an unreadable probe (unknown) is never dead, so it neither reaps nor releases.
// Liveness is evidence only: who owns a dir, and who may release it, is unchanged. Subjects are real processes owned by
// one kitlib run tree; each planted case has a passing control.
import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	applyQuarantineExpiry, createScratch, defaultLiveness, defaultRunner, inspectSession, ownerIncarnationState, parseOwnerFile, probeOwner, quarantineDir,
	quarantineEntryFor, reapLogPath, releaseScratch, resolveScratchRootEntries, type ApplyDeps, type InspectDeps, type LivenessDeps,
} from "../../src/scratch.ts";
import { incarnation, type Incarnation, type Probe, type ProbeState } from "../../src/kitlib/proc.ts";
import { run, type RunResult } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { BRIEF_SCRATCH_CREATE, BRIEF_SCRATCH_RELEASE, BRIEF_SCRATCH_STEP } from "../../src/brief.ts";
import { createHash } from "node:crypto";
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

type Subjects = { live: Incarnation; zombie: Incarnation; zombieRawStart: string; stop: () => Promise<void> };

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
	// What a pre-5m6ej writer recorded: the raw `ps -o lstart=` text, read while the subject was alive. kitlib collapses
	// whitespace, so on days 1-9 of a month ("Nov  1") the two strings differ and the legacy probe would read "reused".
	const zombieRawStart = defaultLiveness().processStart(zombiePid);
	if (zombieRawStart === null) { await stop(); throw new Error("no raw lstart for the zombie subject"); }
	process.kill(zombiePid, "SIGKILL");
	// Real-clock poll: the OS marks the killed child Z on its own schedule, which no fake timer drives.
	for (let tries = 0; tries < 60 && ownerIncarnationState(zombiePid, zombie.start, {}) !== "zombie"; tries++) await Bun.sleep(50);
	return { live, zombie, zombieRawStart, stop };
}

test("planted: a zombie owner reads dead and its dir is reapable, where the pre-5m6ej probe read it alive; control: a live owner is LIVE", async () => {
	const { live, zombie, zombieRawStart, stop } = await subjects();
	try {
		expect(ownerIncarnationState(zombie.pid, zombie.start, {})).toBe("zombie");
		// The pre-5m6ej probe: kill -0 succeeds on a zombie and ps still prints its start, so it read "live".
		expect(probeOwner(zombie.pid, zombieRawStart, defaultLiveness())).toBe("live");
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
	mkdirSync(qt, { recursive: true, mode: 0o700 }); // production state dirs are 0700; the users lock refuses group/other bits
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

test("SCRATCHLSOF1 retains a held inode in a large expired tree, then deletes the same closed tree", () => {
	const home = tempDir("scratch-lsof-large");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const entry = join(qt, quarantineEntryFor("large.424242", new Date(now - 30 * 86_400_000)));
	mkdirSync(entry);
	writeFileSync(join(entry, ".owner"), ownerText(424242, "Mon Oct  5 13:27:00 2026"));
	for (let i = 0; i < 50_000; i++) writeFileSync(join(entry, String(i)), "x");
	const outside = join(home, "outside-hardlink");
	linkSync(join(entry, "0"), outside);
	let held: number | null = openSync(outside, "r");
	const runner: ApplyDeps["run"] = (args, opts) => {
		if (args[0] === "lsof" && !args.includes("+D"))
			return { code: 0, stdout: `p${process.pid}\nn${outside}\n`, stderr: "" };
		// Model the observed recursive-provider deadline failure; successful proof still comes from real lsof.
		if (args[0] === "lsof" && (opts?.timeoutMs ?? 0) <= 15_000)
			return { code: null, stdout: "", stderr: "" };
		// The product gives real `lsof +D` over this 50,001-entry tree min(120 s, 15 s + 1 ms per entry) = 65 s
		// (src/scratch.ts lsofTimeoutMs). The 2026-11-04 676f556d verdict at load1 40-108 on 32 cores ran it out
		// (79872 ms, SKIP lsof-evidence-unavailable). The real call's deadline scales with load; a hung lsof still
		// expires and fails the open-fd and DELETE assertions below.
		if (args[0] === "lsof" && opts?.timeoutMs !== undefined)
			return defaultRunner(args, { ...opts, timeoutMs: fixtureDeadlineS(opts.timeoutMs / 1000) * 1000 });
		return defaultRunner(args, opts);
	};
	const deps: ApplyDeps = { liveness: planted("dead"), run: runner, home, now, lsofSnapshot: new Set([outside]) };
	try {
		const retained = applyQuarantineExpiry(home, deps).find(row => row.dir === entry);
		expect(retained).toMatchObject({ action: "SKIP", reason: "owner-released-but-open-fds-present", cause: "open-fd" });
		expect(retained?.sizeBytes).toBeGreaterThan(50_000);
		expect(readFileSync(join(entry, "0"), "utf8")).toBe("x");
		closeSync(held);
		held = null;
		expect(applyQuarantineExpiry(home, deps).find(row => row.dir === entry)?.action).toBe("DELETE");
		expect(existsSync(entry)).toBe(false);
		expect(readFileSync(outside, "utf8")).toBe("x");
	} finally {
		if (held !== null) closeSync(held);
	}
}, fixtureDeadlineS(300) * 1000);

test("SCRATCHLSOF1 cached planning clearance cannot override unavailable deletion evidence", () => {
	const home = tempDir("scratch-lsof-unavailable");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const entry = join(qt, quarantineEntryFor("unavailable.424242", new Date(now - 30 * 86_400_000)));
	mkdirSync(entry);
	writeFileSync(join(entry, ".owner"), ownerText(424242, "Mon Oct  5 13:27:00 2026"));
	writeFileSync(join(entry, "payload"), "preserve");
	const deps: ApplyDeps = { liveness: planted("dead"), home, now, lsofSnapshot: new Set(), run: () => ({ code: null, stdout: "", stderr: "" }) };
	const row = applyQuarantineExpiry(home, deps).find(value => value.dir === entry);
	expect(row).toMatchObject({ action: "SKIP", reason: "lsof-evidence-unavailable", cause: "lsof-unavailable" });
	expect(row?.sizeBytes).toBeGreaterThan(0);
	expect(readFileSync(join(entry, "payload"), "utf8")).toBe("preserve");
	expect(applyQuarantineExpiry(home, { ...deps, run: defaultRunner }).find(value => value.dir === entry)?.action).toBe("DELETE");
	expect(existsSync(entry)).toBe(false);
}, 60_000);

test.each(["live", "unknown"] as const)("SCRATCHLSOF1 rechecks an owner seat that becomes %s during recursive proof", (state: "live" | "unknown") => {
	const home = tempDir("scratch-lsof-seat");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const entry = join(qt, quarantineEntryFor("seat.424242", new Date(now - 30 * 86_400_000)));
	mkdirSync(entry);
	writeFileSync(join(entry, ".owner"), `${ownerText(424242, "Mon Oct  5 13:27:00 2026")}agent=FixtureOwner\nsession=fixture-session\n`);
	writeFileSync(join(entry, "payload"), "preserve");
	let seat: boolean | null = false;
	const deps: ApplyDeps = { liveness: { ...planted("dead"), seatLive: () => seat }, home, now, run: (args, opts) => {
		const result = defaultRunner(args, opts);
		if (args[0] === "lsof" && args.includes("+D")) seat = state === "live" ? true : null;
		return result;
	} };
	const row = applyQuarantineExpiry(home, deps).find(value => value.dir === entry);
	expect(row).toMatchObject({ action: state === "live" ? "LIVE" : "SKIP", reason: state === "live" ? "owner-seat-alive" : "owner-seat-liveness-unproven" });
	expect(readFileSync(join(entry, "payload"), "utf8")).toBe("preserve");
	seat = false;
	expect(applyQuarantineExpiry(home, { ...deps, run: defaultRunner }).find(value => value.dir === entry)?.action).toBe("DELETE");
	expect(existsSync(entry)).toBe(false);
}, 60_000);

test("SCRATCHLSOF1 never deletes a replacement quarantine directory", () => {
	const home = tempDir("scratch-lsof-replaced");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const entry = join(qt, quarantineEntryFor("replace.424242", new Date(now - 30 * 86_400_000)));
	mkdirSync(entry);
	writeFileSync(join(entry, ".owner"), ownerText(424242, "Mon Oct  5 13:27:00 2026"));
	writeFileSync(join(entry, "payload"), "original");
	let replaced = false;
	const deps: ApplyDeps = { liveness: planted("dead"), home, now, run: (args, opts) => {
		const result = defaultRunner(args, opts);
		if (!replaced && args[0] === "lsof" && args.includes("+D")) {
			replaced = true;
			renameSync(entry, `${entry}.preserved`);
			mkdirSync(entry);
			writeFileSync(join(entry, "payload"), "replacement");
		}
		return result;
	} };
	expect(applyQuarantineExpiry(home, deps).find(row => row.dir === entry)?.action).toBe("SKIP");
	expect(readFileSync(join(entry, "payload"), "utf8")).toBe("replacement");
	expect(readFileSync(join(`${entry}.preserved`, "payload"), "utf8")).toBe("original");
}, 60_000);

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
	process.env.OMP_KIT_SCRATCH_ROOTS = join(root, "var", "agent-tmp");
	const created = createScratch("collapsed", root, { liveness: { ...planted("live"), processStart: () => "Mon Oct  5 13:27:00 2026" }, run: clearRun },
		{}, false, join(root, "scratch-budgets.json"));
	expect(created.ok).toBe(true);
	expect(parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"))?.processStart).toBe("Mon Oct 5 13:27:00 2026");
});

test("SCRATCHLSOF1 preserves the released legacy owner's identity", () => {
	const home = tempDir("scratch-lsof-legacy-home");
	const root = tempDir("scratch-lsof-legacy-root");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const old = now - 30 * 86_400_000;
	const original = join(root, `legacy.${process.pid}`);
	mkdirSync(original);
	writeFileSync(join(original, ".owner"), "completed legacy task");
	writeFileSync(join(original, "payload"), "fixture");
	const released = releaseScratch(original, home, { liveness: planted("live"), run: defaultRunner, now: old },
		{ legacyOwner: true, reason: "completed isolated fixture" });
	expect(released.ok).toBe(true);
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const entry = join(qt, quarantineEntryFor(`legacy.${process.pid}`, new Date(old)));
	renameSync(original, entry);
	for (const name of readdirSync(entry)) utimesSync(join(entry, name), new Date(old), new Date(old));
	utimesSync(entry, new Date(old), new Date(old));
	const row = applyQuarantineExpiry(home, { liveness: planted("dead"), run: defaultRunner, home, now })
		.find(value => value.dir === entry);
	expect(row).toMatchObject({ action: "DELETE", reason: "quarantine-expired-owner-released", owner: { pid: process.pid } });
	expect(existsSync(entry)).toBe(false);
}, 60_000);

// QRELEASED1 (ompkit-fp72.120.16.103): an entry its owner released is deleted once its quarantine hold expires,
// even while the owner seat stays alive; an unreleased entry under the same live seat is kept. Measured
// 2026-11-03: 55 released entries (5.5 GB) sat past the 24 h hold because the seat-liveness check ran first.
test("QRELEASED1 a released quarantine entry expires while its owner seat lives; an unreleased one is kept", () => {
	const home = tempDir("scratch-qreleased-home");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const old = now - 30 * 86_400_000;
	const seatOwner = `agent=FixtureOwner\nsession=fixture-session\n`;
	const { root, dir: released } = ownedDir(process.pid, "Mon Oct  5 13:27:00 2026", "released");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	writeFileSync(join(released, ".owner"), `${readFileSync(join(released, ".owner"), "utf8")}${seatOwner}`);
	expect(releaseScratch(released, home, { liveness: planted("live"), run: clearRun, now: old })).toMatchObject({ ok: true, reason: "owner-released" });
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const releasedEntry = join(qt, quarantineEntryFor(`released.${process.pid}`, new Date(old)));
	renameSync(released, releasedEntry);
	const keptEntry = join(qt, quarantineEntryFor(`kept.${process.pid}`, new Date(old)));
	mkdirSync(keptEntry);
	writeFileSync(join(keptEntry, ".owner"), `${ownerText(process.pid, "Mon Oct  5 13:27:00 2026", "kept")}${seatOwner}`);
	writeFileSync(join(keptEntry, "payload"), "keep");
	for (const entry of [releasedEntry, keptEntry]) {
		for (const name of readdirSync(entry)) utimesSync(join(entry, name), new Date(old), new Date(old));
		utimesSync(entry, new Date(old), new Date(old));
	}
	// Control: the same released entry inside its 24 h hold is not touched.
	const early = applyQuarantineExpiry(home, { liveness: { ...planted("live"), seatLive: () => true }, run: defaultRunner, home, now: old + 3_600_000 });
	expect(early.find(row => row.dir === releasedEntry)?.action).not.toBe("DELETE");
	expect(existsSync(releasedEntry)).toBe(true);
	const rows = applyQuarantineExpiry(home, { liveness: { ...planted("live"), seatLive: () => true }, run: defaultRunner, home, now });
	expect(rows.find(row => row.dir === releasedEntry)).toMatchObject({ action: "DELETE", reason: "quarantine-expired-owner-released" });
	expect(existsSync(releasedEntry)).toBe(false);
	expect(rows.find(row => row.dir === keptEntry)).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
	expect(readFileSync(join(keptEntry, "payload"), "utf8")).toBe("keep");
}, 60_000);

/** An owner-released quarantine entry `<label>.<pid>` whose owner names a seat (agent+session), quarantined 30 days before `now`. */
function releasedQuarantineEntry(home: string, label: string, now: number, plant: (dir: string) => void = () => {}): string {
	const old = now - 30 * 86_400_000;
	const { root, dir } = ownedDir(process.pid, "Mon Oct  5 13:27:00 2026", label);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	writeFileSync(join(dir, ".owner"), `${readFileSync(join(dir, ".owner"), "utf8")}agent=FixtureOwner\nsession=fixture-session\n`);
	expect(releaseScratch(dir, home, { liveness: planted("live"), run: clearRun, now: old })).toMatchObject({ ok: true, reason: "owner-released" });
	plant(dir);
	const qt = quarantineDir(home);
	mkdirSync(qt, { recursive: true, mode: 0o700 });
	const entry = join(qt, quarantineEntryFor(`${label}.${process.pid}`, new Date(old)));
	renameSync(dir, entry);
	utimesSync(entry, new Date(old), new Date(old));
	return entry;
}

// QRELEASED1 EACCES (live 2026-11-04, ownerio1-origin-replay.44384, 2.51 GB): a released expired entry holding our own
// mode-000 dir made `lsof +D` warn "can't opendir" on stderr, so the open-fd proof read unavailable and the entry stayed,
// with no reap-log line. The DELETE path grants owner rwx inside the entry first (lstat only, symlinks never followed).
test("QRELEASED1 a released expired entry with an unreadable 000 subdir is deleted; a symlinked outside 000 dir keeps its mode", () => {
	const home = tempDir("scratch-qreleased-eacces-home");
	const outside = join(tempDir("scratch-qreleased-eacces-outside"), "sealed");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "keep"), "outside");
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const sealed = (dir: string) => join(dir, "probe-eacces", ".local", "state", "rch", "job-leases");
	const entry = releasedQuarantineEntry(home, "eacces", now, dir => {
		mkdirSync(sealed(dir), { recursive: true });
		writeFileSync(join(sealed(dir), "lease"), "x".repeat(4096));
		symlinkSync(outside, join(dir, "escape"));
	});
	chmodSync(sealed(entry), 0o000);
	chmodSync(outside, 0o000);
	try {
		const row = applyQuarantineExpiry(home, { liveness: { ...planted("live"), seatLive: () => true }, run: defaultRunner, home, now })
			.find(value => value.dir === entry);
		expect(row).toMatchObject({ action: "DELETE", reason: "quarantine-expired-owner-released" });
		expect(existsSync(entry)).toBe(false);
		expect(lstatSync(outside).mode & 0o777).toBe(0o000);
	} finally {
		if (existsSync(entry)) chmodSync(sealed(entry), 0o700);
		chmodSync(outside, 0o700);
	}
	expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
}, fixtureDeadlineS(60) * 1000);

// QRELEASED1 keep-log: every expired entry the reaper keeps or skips leaves one reap-log line naming its reason, at the
// policy gate (owner-seat-alive) and at the proof gate (lsof-evidence-unavailable) alike, so no hold is silent.
test("QRELEASED1 every kept expired quarantine entry logs one reap-log line with its reason", () => {
	const home = tempDir("scratch-qreleased-keeplog-home");
	process.env.XDG_STATE_HOME = join(home, "state");
	process.env.XDG_CONFIG_HOME = join(home, "config");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const now = Date.parse("2026-10-22T00:00:00.000Z");
	const proofHeld = releasedQuarantineEntry(home, "proofheld", now);
	const seatHeld = join(quarantineDir(home), quarantineEntryFor(`seatheld.${process.pid}`, new Date(now - 30 * 86_400_000)));
	mkdirSync(seatHeld);
	writeFileSync(join(seatHeld, ".owner"), `${ownerText(process.pid, "Mon Oct  5 13:27:00 2026", "seatheld")}agent=FixtureOwner\nsession=fixture-session\n`);
	utimesSync(seatHeld, new Date(now - 30 * 86_400_000), new Date(now - 30 * 86_400_000));
	const rows = applyQuarantineExpiry(home, { liveness: { ...planted("live"), seatLive: () => true }, home, now,
		run: () => ({ code: null, stdout: "", stderr: "" }) });
	expect(rows.find(row => row.dir === seatHeld)).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
	expect(rows.find(row => row.dir === proofHeld)).toMatchObject({ action: "SKIP", reason: "lsof-evidence-unavailable" });
	const logged = existsSync(reapLogPath(home)) ? readFileSync(reapLogPath(home), "utf8").split("\n").filter(line => line !== "")
		.map(line => JSON.parse(line) as { event: string; dir: string; reason?: string }) : [];
	const keeps = (dir: string) => logged.filter(line => line.event === "quarantine-keep" && line.dir === dir).map(line => line.reason);
	expect(keeps(seatHeld)).toEqual(["owner-seat-alive"]);
	expect(keeps(proofHeld)).toEqual(["lsof-evidence-unavailable"]);
	expect(existsSync(seatHeld) && existsSync(proofHeld)).toBe(true);
}, fixtureDeadlineS(60) * 1000);

// SCRATCHNULL1 (ompkit-fp72.120.16.194): `export TMPDIR=$(omp-kit scratch new ... --json | jq -r .data.dir)` turned a
// refusal into TMPDIR=null and two agents wrote ./null. --print-dir follows mktemp: the dir alone and exit 0, or nothing
// on stdout and a nonzero exit. The assignment is separate from `export`: `export V=$(false) || exit` never exits,
// because export's own status is 0.
const cli = join(repo, "src", "cli.ts");
type Ran = { code: number | null; stdout: string; stderr: string };
/** Each fixture gets its own kit state, so no CLI call reads or writes the operator's. */
const fixtureEnv = (cwd: string, env: Record<string, string>): Record<string, string> => ({ ...process.env as Record<string, string>,
	KIT_BUN: process.execPath, KIT_CLI: cli, XDG_STATE_HOME: join(cwd, ".state"), XDG_CONFIG_HOME: join(cwd, ".config"), ...env });
const ran = (out: RunResult): Ran =>
	({ code: out.rc, stdout: new TextDecoder().decode(out.stdout), stderr: new TextDecoder().decode(out.stderr) });
const kit = async (cwd: string, args: string[], env: Record<string, string> = {}): Promise<Ran> =>
	ran(await run([process.execPath, cli, "scratch", "new", "--label", "scratchnull", ...args], { deadline_s: fixtureDeadlineS(60), cwd, env: fixtureEnv(cwd, env) }));
/** The fail-closed idiom in a fixture shell: assignment apart from export, then a write under the exported TMPDIR. */
const idiom = async (cwd: string, env: Record<string, string> = {}): Promise<Ran> =>
	ran(await run(["/bin/sh", "-c", 'TMPDIR=$("$KIT_BUN" "$KIT_CLI" scratch new --label scratchnull --print-dir) || exit 7; export TMPDIR; mkdir -p "$TMPDIR/out" && printf %s "$TMPDIR"'],
		{ deadline_s: fixtureDeadlineS(60), cwd, env: fixtureEnv(cwd, env) }));

test("SCRATCHNULL1 planted: outside a repo --print-dir prints nothing and exits nonzero, the idiom creates no ./null, and the --json refusal exits nonzero", async () => {
	const outside = tempDir("scratchnull-outside");
	const direct = await kit(outside, ["--print-dir"]);
	expect(direct.stdout).toBe("");
	expect(direct.code).not.toBe(0);
	expect(direct.stderr).toContain("cwd-not-repository");
	const fixture = await idiom(outside);
	expect(fixture).toMatchObject({ code: 7, stdout: "" });
	expect(existsSync(join(outside, "null")) || existsSync(join(outside, "out")) || existsSync(join(outside, "var"))).toBe(false);
	const json = await kit(outside, ["--json"]);
	expect(json.code).not.toBe(0);
	expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, errors: [{ code: "SCRATCH_NEW_REFUSED" }] });
}, fixtureDeadlineS(60) * 1000);

test("SCRATCHNULL1 control: inside a repo the idiom yields an owned dir under var/agent-tmp", async () => {
	const inside = tempDir("scratchnull-inside");
	mkdirSync(join(inside, ".git"));
	const root = join(inside, "var", "agent-tmp");
	const fixture = await idiom(inside, { OMP_KIT_SCRATCH_ROOTS: root });
	expect(fixture.stderr).toBe("");
	expect(fixture.code).toBe(0);
	expect(fixture.stdout.startsWith(join(root, "scratchnull."))).toBe(true);
	expect(fixture.stdout).toMatch(/\/scratchnull\.\d+$/);
	expect(existsSync(join(fixture.stdout, ".owner")) && existsSync(join(fixture.stdout, "out"))).toBe(true);
	expect(existsSync(join(inside, "null"))).toBe(false);
}, fixtureDeadlineS(60) * 1000);

// PRINTDIRCAP1 (ompkit-fp72.120.16.240): the brief taught `--print-dir`, which returns no release capability, so a dir an
// unseated agent made that way could be released by nobody and waited for the reaper. The taught idiom now keeps the
// capability (--json into a variable, read with `jq -e`); release authority is unchanged: seat or capability. Each
// fixture runs the brief's own constants through an `omp-kit` shim, with no seat (no agent name, no session claim).
const unseated = { AGENT_NAME: "", BR_ACTOR: "", BR_AGENT_NAME: "", PI_SESSION_ID: "", PI_SESSION_FILE: "", OMP_KIT_SCRATCH_CAPABILITY: "" };
function shimmed(dir: string): string {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "omp-kit"), '#!/bin/sh\nexec "$KIT_BUN" "$KIT_CLI" "$@"\n');
	chmodSync(join(bin, "omp-kit"), 0o755);
	return bin;
}
let scripts = 0;
/** The script body is the brief's own text, built at runtime, so it is written to a fixture file and run as `/bin/sh FILE`. */
async function runScript(cwd: string, body: string, env: Record<string, string>): Promise<Ran> {
	const bin = shimmed(cwd);
	const file = join(bin, `script.${++scripts}.sh`);
	writeFileSync(file, `${body}\n`);
	return ran(await run(["/bin/sh", file], { deadline_s: fixtureDeadlineS(60), cwd,
		env: fixtureEnv(cwd, { ...unseated, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env }) }));
}
/** One fixture repo with its own scratch root and an `omp-kit` shim; `sh` runs a script there as an unseated caller. */
function printDirFixture(label: string) {
	const inside = tempDir(label);
	mkdirSync(join(inside, ".git"));
	const root = join(inside, "var", "agent-tmp");
	const sh = (body: string, extra: Record<string, string> = {}): Promise<Ran> =>
		runScript(inside, body, { OMP_KIT_SCRATCH_ROOTS: root, OWNER_COPY: join(inside, "owner.copy"), ...extra });
	return { inside, root, sh };
}
const create = BRIEF_SCRATCH_CREATE.replace("<x>", "printdircap");
const output = (out: Ran) => `${out.stdout}\n${out.stderr}`;

test("PRINTDIRCAP1 planted: a dir made by the brief's idiom is released --now by its unseated creator, and the capability is never printed", async () => {
	expect(BRIEF_SCRATCH_STEP).toContain(BRIEF_SCRATCH_CREATE);
	expect(BRIEF_SCRATCH_STEP).toContain(BRIEF_SCRATCH_RELEASE);
	const { root, sh, inside } = printDirFixture("printdircap-planted");
	const out = await sh(`${create}; mkdir -p "$TMPDIR/out" || exit 8; cp "$TMPDIR/.owner" "$OWNER_COPY" || exit 9; `
		+ `${BRIEF_SCRATCH_RELEASE} >&2 || exit 10; test ! -e "$TMPDIR" || exit 11; printf %s "$TMPDIR"`);
	expect({ code: out.code, ...(out.code === 0 ? {} : { output: output(out) }) }).toEqual({ code: 0 });
	expect(out.stdout.startsWith(join(root, "printdircap."))).toBe(true);
	expect(out.stdout).toMatch(/\/printdircap\.\d+$/);
	expect(existsSync(out.stdout)).toBe(false);
	const recorded = readFileSync(join(inside, "owner.copy"), "utf8").match(/"capability_sha256":\s*"([0-9a-f]{64})"/)?.[1];
	expect(recorded).toMatch(/^[0-9a-f]{64}$/);
	// The capability sits only in the creator's unexported variable: no printed 64-hex token hashes to the recorded one.
	for (const token of output(out).match(/[0-9a-f]{64}/g) ?? [])
		expect(new Bun.CryptoHasher("sha256").update(token).digest("hex")).not.toBe(recorded);
	// SCRATCHNULL1 kept: outside a repo the same idiom exits at the create, before any write, and leaves no ./null.
	const outside = tempDir("printdircap-outside");
	const refused = await runScript(outside, `${create}; mkdir -p "$TMPDIR/out"; printf %s "$TMPDIR"`, {});
	expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: "" });
	expect(["null", "out", "var"].some(name => existsSync(join(outside, name)))).toBe(false);
}, fixtureDeadlineS(120) * 1000);

test("PRINTDIRCAP1 control: another session's release of that dir is still refused caller-not-owner, with no token or with another dir's", async () => {
	const { sh, inside } = printDirFixture("printdircap-control");
	const made = await sh(`${create}; printf %s "$TMPDIR"`);
	expect(made.code).toBe(0);
	const dir = made.stdout;
	expect(existsSync(join(dir, ".owner"))).toBe(true);
	const other = await kit(inside, ["--json"], { ...unseated, OMP_KIT_SCRATCH_ROOTS: join(inside, "var", "agent-tmp") });
	const otherCapability = other.stdout.match(/"capability":\s*"([0-9a-f]{64})"/)?.[1] ?? "";
	expect(otherCapability).toMatch(/^[0-9a-f]{64}$/);
	for (const extra of [{ PI_SESSION_ID: "othersession-0001" }, { PI_SESSION_ID: "othersession-0001", OMP_KIT_SCRATCH_CAPABILITY: otherCapability }]) {
		const refused = await sh(`omp-kit scratch release "$DIR" --bin throwaway --now`, { DIR: dir, ...extra });
		expect(refused.code).not.toBe(0);
		expect(output(refused)).toContain("caller-not-owner");
		expect(existsSync(join(dir, ".owner"))).toBe(true);
	}
}, fixtureDeadlineS(120) * 1000);

test("PRINTDIRCAP1 mutant: with the capability carry removed from the taught release, the creator itself is refused caller-not-owner and the dir stays", async () => {
	const mutant = BRIEF_SCRATCH_RELEASE.replace(' --capability "$CAP"', "");
	expect(mutant).not.toBe(BRIEF_SCRATCH_RELEASE);
	const { sh } = printDirFixture("printdircap-mutant");
	const out = await sh(`${create}; printf '%s\\n' "$TMPDIR"; ${mutant} >&2; echo "rc=$?"`);
	const [dir, rc] = out.stdout.trim().split("\n");
	expect(rc).toMatch(/^rc=[1-9]\d*$/);
	expect(out.stderr).toContain("caller-not-owner");
	expect(existsSync(join(dir!, ".owner"))).toBe(true);
}, fixtureDeadlineS(120) * 1000);

// PRINTDIRCAP1 [b]: `scratch new` from the top of a git repo the default root set does not name (~/.claude) records that
// repo's own var/agent-tmp, so release and the reaper find it from any cwd; outside a repo it is still refused. Each
// fixture has its own HOME (no ~/Developer, no fleet-watch) and state, and no OMP_KIT_SCRATCH_ROOTS override.
function dotRepoFixture(label: string) {
	const home = tempDir(label);
	const repo = join(home, ".claude");
	const root = join(repo, "var", "agent-tmp");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(root, { recursive: true });
	const state = join(home, ".state");
	const env = { HOME: home, XDG_STATE_HOME: state, XDG_CONFIG_HOME: join(home, ".config"), OMP_KIT_SCRATCH_ROOTS: "",
		OMP_KIT_FLEET_WATCH_CONFIG: join(home, "fleet-watch.json") };
	const record = join(state, "omp-kit", "scratch-roots", createHash("sha256").update(root, "utf8").digest("hex"));
	return { home, repo, root, state, env, record };
}

test("PRINTDIRCAP1 planted: scratch new inside a non-companion git repo with var/agent-tmp (the ~/.claude shape) is admitted there, and released --now from outside it", async () => {
	const f = dotRepoFixture("printdircap-dotrepo");
	const out = await runScript(f.repo, `${create}; cd "$HOME" || exit 8; ${BRIEF_SCRATCH_RELEASE} >&2 || exit 10; test ! -e "$TMPDIR" || exit 11; printf %s "$TMPDIR"`, f.env);
	expect({ code: out.code, ...(out.code === 0 ? {} : { output: output(out) }) }).toEqual({ code: 0 });
	expect(out.stdout.startsWith(join(f.root, "printdircap."))).toBe(true);
	expect(out.stdout).toMatch(/\/printdircap\.\d+$/);
	expect(readFileSync(f.record, "utf8")).toBe(f.root);
	// The reaper's root set (what plan and apply walk) names it from any cwd, as a registered root.
	process.env.XDG_STATE_HOME = f.state;
	delete process.env.OMP_KIT_SCRATCH_ROOTS;
	expect(resolveScratchRootEntries(f.home).find(entry => entry.root === f.root)?.sources).toContain("registered");
}, fixtureDeadlineS(120) * 1000);

test("PRINTDIRCAP1 control: outside any repo scratch new is still refused, a repo without var/agent-tmp is refused, and only the repo the caller is inside gets recorded", async () => {
	const f = dotRepoFixture("printdircap-dotrepo-control");
	const refused = await runScript(f.home, `${create}; mkdir -p "$TMPDIR/out"; printf %s "$TMPDIR"`, f.env);
	expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: "" });
	expect(refused.stderr).toContain("cwd-not-repository");
	expect(["null", "out", "var"].some(name => existsSync(join(f.home, name))) || existsSync(f.record)).toBe(false);
	// A git repo that has not opted in (no var/agent-tmp) is refused, twice: the refusal leaves no var behind.
	const bare = join(f.home, "bare");
	mkdirSync(join(bare, ".git"), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		const notOptedIn = await runScript(bare, `${create}; printf %s "$TMPDIR"`, f.env);
		expect({ code: notOptedIn.code, stdout: notOptedIn.stdout }).toEqual({ code: 1, stdout: "" });
		expect(notOptedIn.stderr).toContain("scratch-root-unrecognized");
		expect(existsSync(join(bare, "var"))).toBe(false);
	}
	const other = join(f.home, "work");
	mkdirSync(join(other, ".git"), { recursive: true });
	mkdirSync(join(other, "var", "agent-tmp"), { recursive: true });
	const made = await runScript(other, `${create}; printf %s "$TMPDIR"`, f.env);
	expect(made.code).toBe(0);
	expect(made.stdout.startsWith(join(other, "var", "agent-tmp", "printdircap."))).toBe(true);
	expect(existsSync(f.record)).toBe(false);
	process.env.XDG_STATE_HOME = f.state;
	delete process.env.OMP_KIT_SCRATCH_ROOTS;
	expect(resolveScratchRootEntries(f.home).some(entry => entry.root === f.root)).toBe(false);
}, fixtureDeadlineS(120) * 1000);

test("PRINTDIRCAP1 mutant: with the recording bypassed (an explicit OMP_KIT_SCRATCH_ROOTS replaces the set), the same repo is refused scratch-root-unrecognized and nothing is created or recorded", async () => {
	const f = dotRepoFixture("printdircap-dotrepo-mutant");
	const refused = await runScript(f.repo, `${create}; printf %s "$TMPDIR"`, { ...f.env, OMP_KIT_SCRATCH_ROOTS: join(f.home, "elsewhere") });
	expect({ code: refused.code, stdout: refused.stdout }).toEqual({ code: 1, stdout: "" });
	expect(refused.stderr).toContain("scratch-root-unrecognized");
	expect(readdirSync(f.root)).toEqual([]);
	expect(existsSync(f.record)).toBe(false);
}, fixtureDeadlineS(120) * 1000);
