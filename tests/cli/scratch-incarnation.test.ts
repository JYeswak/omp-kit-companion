// ompkit-5m6ej (KL09 part b): scratch owner liveness goes through kitlib proc. A recorded {pid, start} incarnation that
// is a zombie or reused reads dead; an unreadable probe (unknown) is never dead, so it neither reaps nor releases.
// Liveness is evidence only: who owns a dir, and who may release it, is unchanged. Subjects are real processes owned by
// one kitlib run tree; each planted case has a passing control.
import { afterAll, afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	applyQuarantineExpiry, createScratch, defaultLiveness, defaultRunner, inspectSession, ownerIncarnationState, parseOwnerFile, probeOwner, quarantineDir,
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
}, 300_000);

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
