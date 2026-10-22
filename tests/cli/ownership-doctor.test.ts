// ompkit-774u.12 OWNERREG1: the ownership census on disposable state with real files. Every class counts records,
// records with no live owner, and the ones with no tracked outcome; an unobservable class is UNKNOWN, never zero;
// the doctor changes nothing.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { censusOwnership, inspectOwnership, liveOwnershipIo, type OwnershipIo, type OwnershipRow } from "../../src/ownership-doctor.ts";
import { OWNERSHIP_REGISTRY } from "../../src/ownership-registry.ts";
import { quarantineEntryFor } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
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

/** Real files, injected process facts: a pid is alive only if it is LIVE_PID, a seat only if it holds SESSION. */
function io(home: string, over: Partial<OwnershipIo> = {}): OwnershipIo {
	return { ...liveOwnershipIo({ HOME: home }), home, nowMs: () => NOW, pidAlive: (pid) => pid === LIVE_PID,
		seatLive: (_agent, session) => session === SESSION, scratchRoots: () => [], harnessOrphans: () => [], quarantineTtlMs: () => DAY, ...over };
}
const rowOf = (rows: OwnershipRow[], id: string): OwnershipRow => rows.find((row) => row.id === id)!;
const put = (path: string, text: string): void => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const OWNER = (pid: number, extra = "") => `pid=${pid}\nlabel=omp\nrepo=${repo}\ncreated=2026-10-16T20:00:00.000Z\n${extra}`;

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
		JSON.stringify({ schema_version: 1, wrapper_pid: wrapper, state: terminal ? "finished" : "running", terminal_acknowledged: terminal, heartbeat_unix_ms: NOW - 2 * DAY }));
	const lock = (id: string) => put(join(leases, `rchw-${id}.recovery.lock`), "");
	lease("alive", LIVE_PID, false);
	lease("finished", DEAD_PID, true); lock("finished");
	lease("abandoned", DEAD_PID, false); lock("abandoned");
	lock("orphan");
	lock("consumed"); put(join(leases, "rchw-consumed.recover-consumed-9f1c"), "");
	const rows = censusOwnership(io(home));
	const census = rowOf(rows, "rch-job-lease").census!;
	// records: 3 leases + 4 locks; no live owner: finished, abandoned, orphan, consumed (+ the locks of dead leases do not add owners)
	expect(census).toMatchObject({ records: 7, no_live_owner: 4, untracked: 2 });
	expect(census.oldest_age_s).toBeGreaterThanOrEqual(2 * 86_400 - 1);
	// Release the orphan through its producer: rch records the consumption, and the lock is no longer untracked.
	put(join(leases, "rchw-orphan.recover-consumed-77aa"), "");
	expect(rowOf(censusOwnership(io(home)), "rch-job-lease").census).toMatchObject({ untracked: 1 });
	// Retire the abandoned build the same way (terminal acknowledged): nothing untracked remains.
	lease("abandoned", DEAD_PID, true);
	expect(rowOf(censusOwnership(io(home)), "rch-job-lease").census).toMatchObject({ untracked: 0, no_live_owner: 4 });
	// A missing job-leases directory is an observed zero (rch never ran), not an unknown.
	expect(rowOf(censusOwnership(io(fixtureHome())), "rch-job-lease")).toMatchObject({ status: "OBSERVED", census: { records: 0, untracked: 0 } });
});

test("pid-keyed locks: a dead holder is untracked, a live holder is not, for ntm watchers, send locks, service claims, heavy rows and converge locks", () => {
	const home = fixtureHome();
	const kit = join(home, ".local", "state", "omp-kit");
	put(join(home, ".local", "state", "ntm", "watcher-alive.lock"), `${LIVE_PID}\n`);
	put(join(home, ".local", "state", "ntm", "watcher-dead.lock"), `${DEAD_PID}\n`);
	put(join(home, ".local", "state", "ntm", "notes.txt"), "not a lock");
	put(join(kit, "send-locks", "a_1.lock"), `${LIVE_PID}\n`);
	put(join(kit, "send-locks", "b_2.lock"), `${DEAD_PID}\n`);
	put(join(kit, "send-locks", "c_3.lock"), "garbage\n");
	put(join(kit, "jobs", "fleet-watch.lock", "pid"), JSON.stringify({ pid: LIVE_PID, startedAt: NOW - 1000 }));
	put(join(kit, "jobs", "ci-poller.lock", "pid"), JSON.stringify({ pid: DEAD_PID, startedAt: NOW - 5 * DAY }));
	put(join(kit, "load", "mutex", "owner.json"), JSON.stringify({ pid: DEAD_PID, process_start: "x" }));
	put(join(kit, "load", "jobs", "j1.json"), JSON.stringify({ id: "j1", pid: LIVE_PID, queued_at: "2026-10-18T19:00:00.000Z" }));
	put(join(kit, "load", "jobs", "j2.json"), JSON.stringify({ id: "j2", pid: DEAD_PID, queued_at: "2026-10-17T19:00:00.000Z" }));
	const project = join(home, "Developer", "proj");
	put(join(project, ".git", "git_converge.lock"), String(DEAD_PID));
	const root = join(project, "var", "agent-tmp");
	mkdirSync(root, { recursive: true });
	const rows = censusOwnership(io(home, { scratchRoots: () => [root] }));
	const counts = (id: string) => { const census = rowOf(rows, id).census!; return [census.records, census.no_live_owner, census.untracked]; };
	expect(counts("ntm-watcher-lock")).toEqual([2, 1, 1]);
	expect(counts("pane-send-lock")).toEqual([3, 2, 2]);
	expect(counts("service-job-claim")).toEqual([2, 1, 1]);
	expect(counts("heavy-queue")).toEqual([3, 2, 2]);
	expect(counts("converge-lock")).toEqual([1, 1, 1]);
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
	expect(findings[0]!.evidence).toMatchObject({ entries: OWNERSHIP_REGISTRY.length, untracked_total: 2, classes_without_owner_bead: [] });
	expect(findings.slice(1).map((finding) => finding.component)).toEqual(OWNERSHIP_REGISTRY.map((entry) => `OWNERSHIP:${entry.id}`));
	const rch = findings.find((finding) => finding.component === "OWNERSHIP:rch-job-lease")!;
	expect(rch).toMatchObject({ status: "DEGRADED" });
	expect(rch.recommended_action).toContain("ompkit-774u.12.3");
	// A class with untracked records and no owning bead is named in the summary.
	const stripped = inspectOwnership(io(home), OWNERSHIP_REGISTRY.map((entry) => (entry.id === "ntm-watcher-lock" ? { ...entry, ownerBead: null } : entry)));
	expect(stripped[0]!.evidence).toMatchObject({ classes_without_owner_bead: ["ntm-watcher-lock"] });
	expect(stripped[0]!.reason).toContain("no owning bead for: ntm-watcher-lock");
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
