// ompkit-774u.12 OWNERREG1: the ownership census on disposable state with real files. Every class counts records,
// records with no live owner, and the ones with no tracked outcome; an unobservable class is UNKNOWN, never zero;
// the doctor changes nothing.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { censusOwnership, inspectOwnership, liveOwnershipIo, type OwnershipIo, type OwnershipRow } from "../../src/ownership-doctor.ts";
import { OWNERSHIP_REGISTRY } from "../../src/ownership-registry.ts";
import { quarantineEntryFor } from "../../src/scratch.ts";
import { ownerIdentityFromStart, ownerLiveness } from "../../src/kitlib/owner.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { incarnation, type Probe } from "../../src/kitlib/proc.ts";
import { run } from "../../src/kitlib/run.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const NOW = Date.parse("2026-10-18T20:00:00.000Z");
const DAY = 86_400_000;
const AGENT = "TurquoiseSummit";
const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const LIVE_PID = 4242;
const DEAD_PID = 4243;
const cleanup: string[] = [];
const saved = { state: process.env.XDG_STATE_HOME, config: process.env.XDG_CONFIG_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["XDG_STATE_HOME", saved.state], ["XDG_CONFIG_HOME", saved.config]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });

function fixtureHome(): string {
	const home = ownedTmp("ownership-home", { root: join(repo, "var", "agent-tmp") }).path;
	cleanup.push(home);
	process.env.XDG_STATE_HOME = join(home, ".local", "state");
	process.env.XDG_CONFIG_HOME = join(home, ".config");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	return home;
}

/** Real files, injected process-incarnation facts: a liveness result requires the recorded start, and seats have their own lease. */
function io(home: string, over: Partial<OwnershipIo> = {}): OwnershipIo {
	return { ...liveOwnershipIo({ HOME: home }), home, nowMs: () => NOW,
		incarnationState: (pid, start) => pid === LIVE_PID ? start === "live-start" ? "live" : "reused" : "dead",
		seatLive: (_agent, session) => session === SESSION, scratchRoots: () => [], harnessOrphans: () => [], quarantineTtlMs: () => DAY, ...over };
}
const rowOf = (rows: OwnershipRow[], id: string): OwnershipRow => rows.find((row) => row.id === id)!;
const put = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const OWNER = (pid: number, extra = "") => `pid=${pid}\nprocess_start=${pid === LIVE_PID ? "live-start" : "dead-start"}\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-16T20:00:00.000Z\nargv0=omp\n${extra}`;

test("scratch dirs: live, seat-held, released, unprobed, dead and unowned dirs are told apart and a plain file is not a record", () => {
	const home = fixtureHome();
	const root = join(home, "Developer", "proj", "var", "agent-tmp");
	const dir = (name: string, owner: string | null, files: string[] = []) => {
		mkdirSync(join(root, name), { recursive: true });
		if (owner !== null) writeFileSync(join(root, name, ".owner"), owner);
		for (const file of files) writeFileSync(join(root, name, file), "");
	};
	dir(`live.${LIVE_PID}`, OWNER(LIVE_PID));
	dir(`respawned.${DEAD_PID}`, OWNER(DEAD_PID, `agent=${AGENT}\nsession=${SESSION}\n`));
	dir(`unprobed.${DEAD_PID}`, OWNER(DEAD_PID, `agent=${AGENT}\nsession=${SESSION}\n`));
	dir(`released.${DEAD_PID}`, OWNER(DEAD_PID), [".omp-kit-release"]);
	dir(`dead.${DEAD_PID}`, OWNER(DEAD_PID));
	dir("unowned", null);
	dir("malformed", "owner=nobody\n");
	writeFileSync(join(root, "stray.txt"), "not a record");
	const rows = censusOwnership(io(home, { scratchRoots: () => [root], seatLive: (_agent, session) => (session === SESSION ? true : null) }));
	const census = rowOf(rows, "scratch-seat-dir").census!;
	// Seat answers are keyed by session: both agent+session dirs share SESSION and are LIVE here; see the unprobed case below.
	expect({ records: census.records, no_live_owner: census.no_live_owner, untracked: census.untracked, unproven: census.unproven }).toEqual({ records: 7, no_live_owner: 4, untracked: 3, unproven: 0 });
	expect(census.examples).toHaveLength(3);
	expect(census.oldest_age_s).toBeGreaterThan(0);
	const unprobed = censusOwnership(io(home, { scratchRoots: () => [root], seatLive: () => null }));
	expect(rowOf(unprobed, "scratch-seat-dir").census).toMatchObject({ unproven: 2, untracked: 3 });
	const gone = censusOwnership(io(home, { scratchRoots: () => [root], seatLive: () => false }));
	expect(rowOf(gone, "scratch-seat-dir").census).toMatchObject({ no_live_owner: 6, untracked: 5, unproven: 0 });
});
test("scratch ownership with a bare PID is unproven even when that PID is live", () => {
	const home = fixtureHome();
	const root = join(home, "Developer", "proj", "var", "agent-tmp");
	const dir = join(root, `pid-only.${LIVE_PID}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), `pid=${LIVE_PID}\nlabel=omp\nrepo=${repo}\ncreated=2026-10-16T20:00:00.000Z\n`);
	const census = rowOf(censusOwnership(io(home, { scratchRoots: () => [root] })), "scratch-seat-dir").census!;
	expect(census).toMatchObject({ records: 1, no_live_owner: 0, untracked: 0, unproven: 1 });
});

test("scratch quarantine: young entries wait for the TTL; expired or undated ones have no outcome coming", () => {
	const home = fixtureHome();
	const quarantine = join(home, ".local", "state", "omp-kit", "scratch-quarantine");
	mkdirSync(quarantine, { recursive: true });
	for (const [name, at] of [["young", NOW - DAY / 2], ["old", NOW - 3 * DAY], ["older", NOW - 9 * DAY]] as const)
		mkdirSync(join(quarantine, quarantineEntryFor(name, new Date(at))));
	mkdirSync(join(quarantine, "no-timestamp"));
	const census = rowOf(censusOwnership(io(home)), "scratch-quarantine").census!;
	expect(census).toMatchObject({ records: 4, no_live_owner: 4, untracked: 3, oldest_age_s: 9 * 86_400 });
	// An invalid reaper config means the TTL is unknown: UNKNOWN, not zero.
	const unknown = rowOf(censusOwnership(io(home, { quarantineTtlMs: () => null })), "scratch-quarantine");
	expect(unknown).toMatchObject({ status: "UNKNOWN", census: null });
	expect(unknown.reason).toContain("TTL");
});

test("rch leases: AC3 planted negative — a recovery lock with a dead wrapper and no record is untracked until released through rch", () => {
	const home = fixtureHome();
	const leases = join(home, ".local", "state", "rch", "job-leases");
	const lease = (id: string, wrapper: number, terminal: boolean) => put(join(leases, `rchw-${id}.json`),
		JSON.stringify({ schema_version: 1, wrapper_pid: wrapper, wrapper_process_start: wrapper === LIVE_PID ? "live-start" : "dead-start",
			state: terminal ? "finished" : "running", terminal_acknowledged: terminal, heartbeat_unix_ms: NOW - 2 * DAY }));
	const lock = (id: string) => put(join(leases, `rchw-${id}.recovery.lock`), "");
	lease("alive", LIVE_PID, false);
	lease("finished", DEAD_PID, true); lock("finished");
	lease("abandoned", DEAD_PID, false); lock("abandoned");
	lock("orphan");
	lock("consumed"); put(join(leases, "rchw-consumed.recover-consumed-9f1c"), "");
	const rows = censusOwnership(io(home));
	const census = rowOf(rows, "rch-job-lease").census!;
	// Three leases + four locks; the dead wrappers and terminal outcomes are tracked, while orphan and abandoned records remain untracked.
	expect(census).toMatchObject({ records: 7, no_live_owner: 4, untracked: 2, unproven: 0 });
	expect(census.oldest_age_s).toBeGreaterThanOrEqual(2 * 86_400 - 1);
	// Release the orphan through its producer: rch records the consumption, and the lock is no longer untracked.
	put(join(leases, "rchw-orphan.recover-consumed-77aa"), "");
	expect(rowOf(censusOwnership(io(home)), "rch-job-lease").census).toMatchObject({ untracked: 1, no_live_owner: 4 });
	// Retire the abandoned build the same way (terminal acknowledged): nothing untracked remains.
	lease("abandoned", DEAD_PID, true);
	expect(rowOf(censusOwnership(io(home)), "rch-job-lease").census).toMatchObject({ untracked: 0, no_live_owner: 4, unproven: 0 });
	// A missing job-leases directory is an observed zero (rch never ran), not an unknown.
	expect(rowOf(censusOwnership(io(fixtureHome())), "rch-job-lease")).toMatchObject({ status: "OBSERVED", census: { records: 0, untracked: 0 } });
});

test("uj4af planted: an unreadable (EACCES) job-leases directory is UNKNOWN and the summary is not OK; controls: a readable orphan is untracked 1, an absent directory is an observed zero", () => {
	const home = fixtureHome();
	const leases = join(home, ".local", "state", "rch", "job-leases");
	put(join(leases, "rchw-orphan.recovery.lock"), "");
	const rch = [OWNERSHIP_REGISTRY.find((entry) => entry.id === "rch-job-lease")!];
	expect(rowOf(censusOwnership(io(home), rch), "rch-job-lease")).toMatchObject({ status: "OBSERVED", census: { records: 1, untracked: 1 } });
	chmodSync(leases, 0o000);
	try {
		const row = rowOf(censusOwnership(io(home), rch), "rch-job-lease");
		expect(row).toMatchObject({ status: "UNKNOWN", census: null });
		expect(row.reason).toContain("EACCES");
		const [summary] = inspectOwnership(io(home), rch);
		expect(summary.status).not.toBe("OK");
		expect(summary.evidence).toMatchObject({ census_failed: ["rch-job-lease"] });
	} finally {
		chmodSync(leases, 0o755);
	}
	expect(rowOf(censusOwnership(io(fixtureHome()), rch), "rch-job-lease")).toMatchObject({ status: "OBSERVED", census: { records: 0, untracked: 0 } });
});

test("send-lock census uses process_start and keeps legacy or unverified owners unproven", () => {
	const home = fixtureHome();
	const kit = join(home, ".local", "state", "omp-kit");
	put(join(home, ".local", "state", "ntm", "watcher-live.lock"), `${LIVE_PID}\n`);
	put(join(home, ".local", "state", "ntm", "watcher-dead.lock"), `${DEAD_PID}\n`);
	put(join(home, ".local", "state", "ntm", "notes.txt"), "not a lock");
	put(join(kit, "send-locks", "a_1.lock"), JSON.stringify({ pid: LIVE_PID, process_start: "live-start" }));
	put(join(kit, "send-locks", "b_2.lock"), JSON.stringify({ pid: DEAD_PID, process_start: "dead-start" }));
	put(join(kit, "send-locks", "legacy_3.lock"), `${LIVE_PID}\n`);
	put(join(kit, "send-locks", "unknown_4.lock"), JSON.stringify({ pid: LIVE_PID, process_start: "unreadable-start" }));
	put(join(kit, "send-locks", "c_5.lock"), "garbage\n");
	put(join(kit, "jobs", "fleet-watch.lock", "pid"), JSON.stringify({ pid: LIVE_PID, process_start: "live-start", startedAt: NOW - 1000 }));
	put(join(kit, "jobs", "ci-poller.lock", "pid"), JSON.stringify({ pid: DEAD_PID, process_start: "dead-start", startedAt: NOW - 5 * DAY }));
	put(join(kit, "load", "mutex", "owner.json"), JSON.stringify({ pid: DEAD_PID, process_start: "dead-start" }));
	put(join(kit, "load", "jobs", "j1.json"), JSON.stringify({ id: "j1", pid: LIVE_PID, process_start: "live-start", queued_at: "2026-10-18T19:00:00.000Z" }));
	put(join(kit, "load", "jobs", "j2.json"), JSON.stringify({ id: "j2", pid: DEAD_PID, process_start: "dead-start", queued_at: "2026-10-17T19:00:00.000Z" }));
	const project = join(home, "Developer", "proj");
	put(join(project, ".git", "git_converge.lock"), JSON.stringify({ pid: DEAD_PID, start_time: "dead-start" }));
	const legacyProject = join(home, "Developer", "legacy");
	put(join(legacyProject, ".git", "git_converge.lock"), String(DEAD_PID));
	const liveProject = join(home, "Developer", "live");
	put(join(liveProject, ".git", "git_converge.lock"), JSON.stringify({ pid: LIVE_PID, process_start: "live-start" }));
	const roots = [join(project, "var", "agent-tmp"), join(legacyProject, "var", "agent-tmp"), join(liveProject, "var", "agent-tmp")];
	const rows = censusOwnership(io(home, { scratchRoots: () => roots,
		incarnationState: (_pid, start) => start === "unreadable-start" ? "unknown"
			: start === "live-start" ? "live" : "dead" }));
	const counts = (id: string) => { const census = rowOf(rows, id).census!; return [census.records, census.no_live_owner, census.untracked]; };
	expect(counts("ntm-watcher-lock")).toEqual([2, 0, 0]);
	expect(rowOf(rows, "ntm-watcher-lock").census?.unproven).toBe(2);
	expect(counts("pane-send-lock")).toEqual([5, 2, 2]);
	expect(rowOf(rows, "pane-send-lock").census?.unproven).toBe(2);
	expect(counts("service-job-claim")).toEqual([2, 1, 1]);
	expect(counts("heavy-queue")).toEqual([3, 2, 2]);
	expect(counts("converge-lock")).toEqual([3, 1, 1]);
	expect(rowOf(rows, "converge-lock").census?.unproven).toBe(1);
	expect(rowOf(rows, "service-job-claim").census!.oldest_age_s).toBe(5 * 86_400);
});

test("harness orphans come from the process table; an unreadable table is UNKNOWN, not zero", () => {
	const home = fixtureHome();
	const orphan = { pid: 900, ppid: 1, ageSeconds: 7200, command: "bun mock-model.mjs" };
	const rows = censusOwnership(io(home, { harnessOrphans: () => [orphan] }));
	expect(rowOf(rows, "harness-orphan-server").census).toMatchObject({ records: 1, no_live_owner: 1, untracked: 1, oldest_age_s: 7200 });
	const unknown = rowOf(censusOwnership(io(home, { harnessOrphans: () => null })), "harness-orphan-server");
	expect(unknown).toMatchObject({ status: "UNKNOWN", census: null, reason: "the process table could not be read" });
});

test("classes with no durable record to count are UNKNOWN with the registry's reason, and a census that throws is UNKNOWN too", () => {
	const home = fixtureHome();
	const rows = censusOwnership(io(home));
	for (const entry of OWNERSHIP_REGISTRY.filter((candidate) => candidate.census === null))
		expect(rowOf(rows, entry.id)).toMatchObject({ status: "UNKNOWN", census: null, reason: entry.noCensus });
	const broken = censusOwnership(io(home, { listDir: () => { throw new Error("EIO"); } }));
	const failed = rowOf(broken, "ntm-watcher-lock");
	expect(failed).toMatchObject({ status: "UNKNOWN", census: null });
	expect(failed.reason).toContain("EIO");
});

test("inspectOwnership: one summary row first, DEGRADED when anything is untracked, owner beads named, classes without one called out", () => {
	const home = fixtureHome();
	put(join(home, ".local", "state", "ntm", "watcher-dead.lock"), `${DEAD_PID}\n`);
	put(join(home, ".local", "state", "rch", "job-leases", "rchw-x.recovery.lock"), "");
	const findings = inspectOwnership(io(home));
	expect(findings[0]!.component).toBe("OWNERSHIP");
	expect(findings[0]!.status).toBe("DEGRADED");
	expect(findings[0]!.evidence).toMatchObject({ entries: OWNERSHIP_REGISTRY.length, untracked_total: 1, classes_without_owner_bead: [] });
	expect(findings.slice(1).map((finding) => finding.component)).toEqual(OWNERSHIP_REGISTRY.map((entry) => `OWNERSHIP:${entry.id}`));
	const rch = findings.find((finding) => finding.component === "OWNERSHIP:rch-job-lease")!;
	expect(rch).toMatchObject({ status: "DEGRADED" });
	expect(rch.recommended_action).toContain("ompkit-774u.12.3");
	// A class with untracked records and no owning bead is named in the summary.
	const stripped = inspectOwnership(io(home), OWNERSHIP_REGISTRY.map((entry) => (entry.id === "rch-job-lease" ? { ...entry, ownerBead: null } : entry)));
	expect(stripped[0]!.evidence).toMatchObject({ classes_without_owner_bead: ["rch-job-lease"] });
	expect(stripped[0]!.reason).toContain("no owning bead for: rch-job-lease");
	// A machine with no scratch roots cannot run the scratch and converge censuses: UNVERIFIED, never OK, and the
	// classes with no record to count are reported separately, none read as zero.
	const blind = inspectOwnership(io(fixtureHome()));
	expect(blind[0]).toMatchObject({ status: "UNVERIFIED", evidence: { untracked_total: 0, census_failed: ["scratch-seat-dir", "converge-lock"],
		not_countable: OWNERSHIP_REGISTRY.filter((entry) => entry.census === null).length + 2 } });
	// With an empty scratch root every census runs and finds nothing: OK.
	const quietHome = fixtureHome();
	const quietRoot = join(quietHome, "Developer", "proj", "var", "agent-tmp");
	mkdirSync(quietRoot, { recursive: true });
	expect(inspectOwnership(io(quietHome, { scratchRoots: () => [quietRoot] }))[0]).toMatchObject({ status: "OK", evidence: { untracked_total: 0, census_failed: [] } });
});

function snapshot(root: string): string {
	const lines: string[] = [];
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			const stat = statSync(path);
			if (stat.isDirectory()) { lines.push(`d ${path} ${stat.mtimeMs}`); walk(path); }
			else lines.push(`f ${path} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
		}
	};
	walk(root);
	return lines.join("\n");
}

test("the doctor is read-only: a full census over disposable state changes no file, size, mtime or directory", () => {
	const home = fixtureHome();
	const root = join(home, "Developer", "proj", "var", "agent-tmp");
	mkdirSync(join(root, `dead.${DEAD_PID}`), { recursive: true });
	writeFileSync(join(root, `dead.${DEAD_PID}`, ".owner"), OWNER(DEAD_PID));
	put(join(home, ".local", "state", "ntm", "watcher-dead.lock"), `${DEAD_PID}\n`);
	put(join(home, ".local", "state", "rch", "job-leases", "rchw-x.recovery.lock"), "");
	put(join(home, ".local", "state", "omp-kit", "jobs", "j.lock", "pid"), JSON.stringify({ pid: DEAD_PID, startedAt: 1 }));
	const old = new Date(NOW - 5 * DAY);
	utimesSync(join(root, `dead.${DEAD_PID}`, ".owner"), old, old);
	const before = snapshot(home);
	expect(before.split("\n").length).toBeGreaterThan(8);
	inspectOwnership(io(home, { scratchRoots: () => [root] }));
	expect(snapshot(home)).toBe(before);
});

// PIDIDENT1: owners with a recorded start use the shared kitlib process-incarnation probe. Real processes; each
// planted zombie or reused PID has a passing live-incarnation control.
const STARTED = (pid: number, start: string) => `pid=${pid}\nprocess_start=${start}\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-16T20:00:00.000Z\nargv0=omp\n`;

type Subjects = { live: { pid: number; start: string }; zombie: { pid: number; start: string }; stop: () => Promise<void> };

/**
 * One kitlib-run tree: /bin/sh forks two sleeps, writes their pids, then exec's into sleep, which never reaps. The first
 * sleep is killed and stays a zombie; the second stays live. `stop` aborts the run, which kills the whole group.
 */
async function subjects(): Promise<Subjects> {
	const dir = ownedTmp("proc-subjects", { root: join(repo, "var", "agent-tmp") }).path;
	cleanup.push(dir);
	const out = join(dir, "pids");
	const controller = new AbortController();
	const tree = run(["/bin/sh", "-c", 'sleep 30 & z=$!; sleep 30 & l=$!; echo "$z $l" > "$1.tmp" && mv "$1.tmp" "$1"; exec sleep 30', "subjects", out],
		{ deadline_s: 60, signal: controller.signal }).catch(() => { /* aborted by stop */ });
	const stop = async () => { controller.abort(new Error("subjects done")); await tree; };
	// Real-clock poll for a file a real child writes; no fake timer reaches another process.
	for (let tries = 0; !existsSync(out) && tries < 200; tries++) await Bun.sleep(25);
	if (!existsSync(out)) { await stop(); throw new Error("subject tree did not start"); }
	const [zombiePid, livePid] = readFileSync(out, "utf8").trim().split(" ").map(Number) as [number, number];
	const [zombieSeen, liveSeen] = [await incarnation(zombiePid), await incarnation(livePid)];
	if (zombieSeen === null || liveSeen === null) { await stop(); throw new Error("no incarnation for a subject"); }
	process.kill(zombiePid, "SIGKILL");
	// Real-clock poll: the OS marks the killed child Z on its own schedule, which no fake timer drives.
	for (let tries = 0; tries < 60 && ownerLiveness({ pid: zombiePid, process_start: zombieSeen.start }).state !== "zombie"; tries++) await Bun.sleep(50);
	return { live: liveSeen, zombie: zombieSeen, stop };
}

function scratchCensus(home: string, owners: Record<string, string>, over: Partial<OwnershipIo> = {}) {
	const root = join(home, "Developer", "proj", "var", "agent-tmp");
	for (const [name, owner] of Object.entries(owners)) put(join(root, name, ".owner"), owner);
	const live = liveOwnershipIo({ HOME: home });
	return rowOf(censusOwnership(io(home, { scratchRoots: () => [root], incarnationState: live.incarnationState, ...over })), "scratch-seat-dir").census!;
}

test("PIDIDENT1 planted: the shared probe marks zombies dead; control: an owner with a live start remains live", async () => {
	const { live, zombie, stop } = await subjects();
	try {
		expect(ownerLiveness({ pid: zombie.pid, process_start: zombie.start }).state).toBe("zombie");
		expect(scratchCensus(fixtureHome(), { [`zombie.${zombie.pid}`]: STARTED(zombie.pid, zombie.start) })).toMatchObject({ records: 1, untracked: 1, unproven: 0 });
		expect(scratchCensus(fixtureHome(), { [`live.${live.pid}`]: STARTED(live.pid, live.start) })).toMatchObject({ records: 1, untracked: 0, unproven: 0 });
	} finally {
		await stop();
	}
}, 30_000);

test("PIDIDENT1 planted: the shared probe marks a reused PID dead; control: raw multi-space lstart remains live", async () => {
	const { live: subject, stop } = await subjects();
	try {
		const other = "Thu Jan  1 00:00:00 2015";
		expect(scratchCensus(fixtureHome(), { [`reused.${subject.pid}`]: STARTED(subject.pid, other) })).toMatchObject({ records: 1, untracked: 1 });
		// Records written before 5m6ej hold the raw lstart, with a run of spaces: the probe collapses both sides.
		const raw = subject.start.replace(" ", "   ");
		expect(scratchCensus(fixtureHome(), { [`raw.${subject.pid}`]: STARTED(subject.pid, raw) })).toMatchObject({ records: 1, untracked: 0 });
		// The heavy queue records `process_start` the same way.
		const home = fixtureHome();
		const jobs = join(home, ".local", "state", "omp-kit", "load", "jobs");
		put(join(jobs, "reused.json"), JSON.stringify({ id: "r", pid: subject.pid, process_start: other, queued_at: "2026-10-18T19:00:00.000Z" }));
		put(join(jobs, "raw.json"), JSON.stringify({ id: "w", pid: subject.pid, process_start: raw, queued_at: "2026-10-18T19:00:00.000Z" }));
		const live = liveOwnershipIo({ HOME: home });
		const heavy = rowOf(censusOwnership(io(home, { incarnationState: live.incarnationState })), "heavy-queue").census!;
		expect(heavy).toMatchObject({ records: 2, untracked: 1, unproven: 0 });
		expect(heavy.examples).toEqual([join(jobs, "reused.json")]);
	} finally {
		await stop();
	}
}, 30_000);

test("5m6ej planted: an unknown probe (ps unreadable) is unproven, never a dead owner; control: a dead probe is untracked", () => {
	const unknown: Probe = { state: "unknown", evidence: { pid: DEAD_PID, recorded_start: "x", observed_start: null, stat: null, signal0: null, reason: "ps timed out" } };
	const unreadable = (pid: number, start: string) => {
		const identity = ownerIdentityFromStart(pid, start);
		return identity === null ? "unknown" : ownerLiveness(identity, { probe: () => unknown }).state;
	};
	const owners = { [`unread.${DEAD_PID}`]: STARTED(DEAD_PID, "Mon Oct  5 13:27:00 2026") };
	expect(scratchCensus(fixtureHome(), owners, { incarnationState: unreadable })).toMatchObject({ records: 1, untracked: 0, no_live_owner: 0, unproven: 1 });
	expect(scratchCensus(fixtureHome(), owners, { incarnationState: () => "dead" })).toMatchObject({ records: 1, untracked: 1, unproven: 0 });
	const home = fixtureHome();
	put(join(home, ".local", "state", "omp-kit", "load", "mutex", "owner.json"), JSON.stringify({ pid: DEAD_PID, process_start: "Mon Oct  5 13:27:00 2026" }));
	expect(rowOf(censusOwnership(io(home, { incarnationState: unreadable })), "heavy-queue").census).toMatchObject({ records: 1, untracked: 0, unproven: 1 });
	expect(rowOf(censusOwnership(io(home)), "heavy-queue").census).toMatchObject({ records: 1, untracked: 1, unproven: 0 });
	const findings = inspectOwnership(io(home, { incarnationState: unreadable }));
	expect(findings.find((finding) => finding.component === "OWNERSHIP:heavy-queue")!.reason).toContain("1 owner(s) or seat lease(s) unprobed");
});
