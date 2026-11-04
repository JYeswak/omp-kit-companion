// ompkit-774u.9.3 OWNERKEY1: a scratch owner is the agent and its omp session, never a bare pid. A respawned seat
// (same agent and session, new pid) and a tool shell whose $$ exited both keep their scratch LIVE while the seat
// lives; the pid rule is unchanged for pid-only owners.
import { afterEach, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyReap, callerSeat, createScratch, defaultLiveness, defaultRunner, disposalGate, inspectSession, ownedScratch, parseOwnerFile, parseOwnerFileEx, planScratch, releaseScratch,
	type InspectDeps, type LivenessDeps, type SeatIdentity } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { pollUntil } from "../../src/kitlib/poll.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const AGENT = "TurquoiseSummit";
const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const OTHER_SESSION = "01a1502a-5647-76ba-89c5-949087f3e283";
const HAVE_LSOF = Bun.which("lsof") !== null;

// The real seat probe runs lsof under a 3 s product deadline and reports UNKNOWN (null, or the
// owner-seat-liveness-unproven reason) when it expires. At load 30+ on 32 cores lsof alone can take
// longer, so the real-process tests re-observe an UNKNOWN answer until a definite one arrives within
// a load-scaled budget. A definite answer is asserted exactly as before; UNKNOWN never passes.
async function definite<T>(probe: () => T, unknown: (value: T) => boolean): Promise<T> {
	const polled = await pollUntil(probe, {
		deadline_s: fixtureDeadlineS(10), interval_s: 0.1, max_observation_bytes: 1 << 20,
		classify: value => unknown(value) ? "retry" : "success",
	});
	return polled.observation as T;
}
const seatAnswer = (real: LivenessDeps, session: string) => definite(() => real.seatLive?.(AGENT, session) ?? null, value => value === null);
const inspected = (dir: string, root: string, deps: InspectDeps) =>
	definite(() => inspectSession(dir, root, deps), value => value.reason === "owner-seat-liveness-unproven");

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME, owners: process.env.OMP_KIT_SESSION_OWNERS_DIR };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state], ["OMP_KIT_SESSION_OWNERS_DIR", saved.owners]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function tempDir(label: string): string {
	const dir = ownedTmp(label, { root: scratchParent }).path;
	cleanup.push(dir);
	return dir;
}
const clearRun = () => ({ code: 1, stdout: "", stderr: "" });
// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: Pick<LivenessDeps, "signalAlive" | "psVisible" | "processStart" | "probe"> = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const deps = (liveness: LivenessDeps, extra: Partial<InspectDeps> = {}): InspectDeps => ({ liveness, run: clearRun, ...extra });
const seatOwner = (pid: number, seat = `agent=${AGENT}\nsession=${SESSION}\n`): string =>
	`pid=${pid}\nlabel=omp\nrepo=${repo}\ncreated=2026-10-18T17:32:44.000Z\n${seat}`;

function seatDir(root: string, pid: number, text = seatOwner(pid)): string {
	const dir = join(root, `omp.${pid}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"), text);
	return dir;
}

test("owner files: agent and session parse with both owner formats and JSON; one without the other, or an unsafe value, is malformed", () => {
	const legacy = seatOwner(42);
	expect(parseOwnerFile(legacy)).toMatchObject({ pid: 42, label: "omp", agent: AGENT, session: SESSION, processStart: null, argv0: null });
	const complete = `pid=42\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=a\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=omp\nagent=${AGENT}\nsession=${SESSION}\n`;
	expect(parseOwnerFile(complete)).toMatchObject({ pid: 42, agent: AGENT, session: SESSION, argv0: "omp" });
	expect(parseOwnerFile(JSON.stringify({ pid: 42, label: "omp", repo, created: "x", agent: AGENT, session: SESSION }))).toMatchObject({ agent: AGENT, session: SESSION });
	// Existing records parse unchanged and carry no durable owner.
	expect(parseOwnerFile(`pid=42\nlabel=omp\nrepo=${repo}\ncreated=2026-10-18T17:32:44.000Z\n`)).toMatchObject({ agent: null, session: null });
	expect(parseOwnerFile(complete.split("\n").slice(0, 6).join("\n") + "\n")).toMatchObject({ agent: null, session: null });
	for (const text of [
		seatOwner(42, `agent=${AGENT}\n`), seatOwner(42, `session=${SESSION}\n`),
		seatOwner(42, `agent=../evil\nsession=${SESSION}\n`), seatOwner(42, `agent=${AGENT}\nsession=short\n`),
		seatOwner(42, `agent=${AGENT}\nsession=${SESSION}\nagent=${AGENT}\n`), seatOwner(42, `agent=${AGENT}\nsession=${SESSION}\nowner=x\n`),
		seatOwner(42, `agent=\nsession=${SESSION}\n`),
	]) expect(parseOwnerFile(text)).toBeNull();
});

test("owner file field patterns accept the boundary lengths, refuse one past them, and stay linear on long near-misses", () => {
	const owner = (agent: string, session: string) => parseOwnerFile(seatOwner(42, `agent=${agent}\nsession=${session}\n`));
	expect(owner("A".repeat(64), "0".repeat(8))).not.toBeNull();
	expect(owner("A".repeat(65), "0".repeat(8))).toBeNull();
	expect(owner("A", "0".repeat(7))).toBeNull();
	expect(owner("A", "0".repeat(64))).not.toBeNull();
	expect(owner("A", "0".repeat(65))).toBeNull();
	const started = performance.now();
	expect(owner("A".repeat(200_000), SESSION)).toBeNull();
	expect(owner(AGENT, `${"0".repeat(200_000)}!`)).toBeNull();
	expect(performance.now() - started).toBeLessThan(500);
});

test("respawned seat: the same agent and session under a new pid keeps its scratch LIVE; without the seat proof it is REAP", () => {
	const root = tempDir("seat-owner");
	const oldPid = 59001;
	const dir = seatDir(root, oldPid);
	const live = inspectSession(dir, root, deps({ ...noPid, seatLive: (agent, session) => agent === AGENT && session === SESSION }));
	expect(live).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
	// Planted negatives: the same record with the agent+session liveness removed is REAP, or never reaped when unprovable.
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: () => false }))).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: () => null }))).toMatchObject({ action: "SKIP", reason: "owner-seat-liveness-unproven" });
	expect(inspectSession(dir, root, deps({ ...noPid }))).toMatchObject({ action: "SKIP", reason: "owner-seat-liveness-unproven" });
	// A seat for a different session never keeps this record alive.
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: (_agent, session) => session === OTHER_SESSION }))).toMatchObject({ action: "REAP" });
	// A pid-only owner keeps today's rule even when every seat is alive.
	const legacyDir = seatDir(root, 59002, seatOwner(59002, ""));
	expect(inspectSession(legacyDir, root, deps({ ...noPid, seatLive: () => true }))).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	// A live pid is LIVE with or without the seat.
	const alive = seatDir(root, 59003);
	// The live process started before the record was written, so it can be the writer.
	expect(inspectSession(alive, root, deps({ signalAlive: () => true, psVisible: () => true, processStart: () => "Mon Sep  1 00:00:00 2025", seatLive: () => false })))
		.toMatchObject({ action: "LIVE" });
});

test("scratch plan reports the respawned seat dir as LIVE and counts it as reapable only when the seat is gone", () => {
	const root = tempDir("seat-plan");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	const home = tempDir("seat-home");
	const dir = seatDir(root, 59011);
	const verdictOf = (seatLive: LivenessDeps["seatLive"]) => planScratch(home, deps({ ...noPid, seatLive })).sessions.find((session) => session.dir === dir);
	expect(verdictOf(() => true)).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
	expect(verdictOf(() => false)).toMatchObject({ action: "REAP" });
});

test("apply re-checks the seat: a seat that came back after the plan stops the reap and the directory stays", () => {
	const root = tempDir("seat-apply");
	const home = tempDir("seat-apply-home");
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const dir = seatDir(root, 59021);
	const planned = inspectSession(dir, root, deps({ ...noPid, seatLive: () => false }));
	expect(planned.action).toBe("REAP");
	const applied = applyReap(dir, root, planned, { ...deps({ ...noPid, seatLive: () => true }), home });
	expect(applied.action).toBe("SKIP");
	expect(existsSync(join(dir, ".owner"))).toBe(true);
	const reaped = applyReap(dir, root, planned, { ...deps({ ...noPid, seatLive: () => false }), home });
	expect(reaped.action).toBe("REAP");
	expect(existsSync(dir)).toBe(false);
});

test("apply refuses when the owner's agent or session changed after the plan, even though no seat is live", () => {
	for (const [field, replacement] of [["session", `session=${OTHER_SESSION}`], ["agent", "agent=CrimsonHorizon"]] as const) {
		const root = tempDir("seat-apply-owner");
		const home = tempDir("seat-apply-owner-home");
		process.env.XDG_STATE_HOME = join(home, "state");
		mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
		const dir = seatDir(root, 59026);
		const planned = inspectSession(dir, root, deps({ ...noPid, seatLive: () => false }));
		expect(planned.action).toBe("REAP");
		const changed = readFileSync(join(dir, ".owner"), "utf8").replace(new RegExp(`${field}=.*`), replacement);
		writeFileSync(join(dir, ".owner"), changed);
		const applied = applyReap(dir, root, planned, { ...deps({ ...noPid, seatLive: () => false }), home });
		expect({ field, action: applied.action }).toEqual({ field, action: "SKIP" });
		expect(existsSync(join(dir, ".owner"))).toBe(true);
	}
});

test.skipIf(!HAVE_LSOF)("real seat process: a scratch dir written by a tool shell whose $$ exited stays LIVE while the seat holds its session, and is REAP once it is gone", async () => {
	const owners = join(tempDir("seat-real"), "session-owners");
	mkdirSync(owners, { recursive: true });
	process.env.OMP_KIT_SESSION_OWNERS_DIR = owners;
	const lock = join(owners, `${SESSION}.lock`);
	writeFileSync(lock, "");
	const root = tempDir("seat-real-root");
	const seat = Bun.spawn(["sh", "-c", `exec 9<>"$LOCK"; echo ready; exec sleep 120`], { env: { ...process.env, LOCK: lock }, stdout: "pipe", stderr: "ignore" });
	try {
		await seat.stdout.getReader().read();
		const real = defaultLiveness();
		expect(await seatAnswer(real, SESSION)).toBe(true);
		expect(await seatAnswer(real, OTHER_SESSION)).toBe(false);
		const shell = Bun.spawnSync(["sh", "-c", "echo $$"], { stdout: "pipe" });
		const shellPid = Number(shell.stdout.toString().trim());
		const dir = join(root, `ts.${shellPid}`);
		mkdirSync(dir);
		writeFileSync(join(dir, ".owner"), `pid=${shellPid}\nlabel=ts\nrepo=${repo}\ncreated=2026-10-18T17:40:00.000Z\nagent=${AGENT}\nsession=${SESSION}\n`);
		expect(await inspected(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		seat.kill("SIGTERM");
		await seat.exited;
		expect(await seatAnswer(real, SESSION)).toBe(false);
		expect(await inspected(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	} finally {
		seat.kill("SIGKILL");
	}
}, fixtureDeadlineS(60) * 1000);

test.skipIf(!HAVE_LSOF)("a chain of two respawns keeps the dir LIVE and releasable by the last seat; with no seat left it is REAP (SCRATCHCARRY1 AC3)", async () => {
	const owners = join(tempDir("seat-chain"), "session-owners");
	mkdirSync(owners, { recursive: true });
	process.env.OMP_KIT_SESSION_OWNERS_DIR = owners;
	const lock = join(owners, `${SESSION}.lock`);
	writeFileSync(lock, "");
	const root = tempDir("seat-chain-root");
	const home = tempDir("seat-chain-home");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const real = defaultLiveness();
	const live: { kill(signal?: string): void }[] = [];
	const start = async () => {
		const seat = Bun.spawn(["sh", "-c", `exec 9<>"$LOCK"; echo ready; exec sleep 120`], { env: { ...process.env, LOCK: lock }, stdout: "pipe", stderr: "ignore" });
		live.push(seat);
		await seat.stdout.getReader().read();
		return seat;
	};
	const stop = async (seat: { kill(signal?: string): void; exited: Promise<number> }) => { seat.kill("SIGTERM"); await seat.exited; };
	try {
		const first = await start();
		const dir = join(root, `omp.${first.pid}`);
		mkdirSync(dir);
		writeFileSync(join(dir, ".owner"), seatOwner(first.pid));
		await stop(first);
		const second = await start();
		expect(real.signalAlive(first.pid)).toBe(false);
		expect(await inspected(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		await stop(second);
		const third = await start();
		expect(real.signalAlive(first.pid)).toBe(false);
		expect(await inspected(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		// The last seat releases a dir the first one created; an unrelated agent in the same session cannot.
		const work = join(root, `work.${first.pid}`);
		mkdirSync(work);
		writeFileSync(join(work, ".owner"), seatOwner(first.pid).replace("label=omp", "label=work"));
		const sibling = { liveness: real, run: defaultRunner };
		expect(releaseScratch(work, home, { ...sibling, callerSeat: asSeat("CrimsonHorizon", [SESSION]) })).toMatchObject({ ok: false, reason: "caller-not-owner" });
		expect(releaseScratch(work, home, { ...sibling, callerSeat: asSeat(AGENT, [SESSION]) })).toMatchObject({ ok: true, changed: true, ownerPid: first.pid });
		// With the last seat gone and no pid alive, the other dir is REAP as before.
		await stop(third);
		expect(await seatAnswer(real, SESSION)).toBe(false);
		expect(await inspected(dir, root, sibling)).toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
	} finally {
		for (const seat of live) seat.kill("SIGKILL");
	}
}, fixtureDeadlineS(60) * 1000);

// Planted: lsof takes 2.4-3.7 s on a loaded 32-core Mac (2026-11-04). A stub that answers after 4 s,
// past the old 3 s probe deadline, must still give a definite seat answer, never UNKNOWN (null).
// Bun resolves a bare command from the PATH it started with, so the probe runs in a child bun whose
// PATH starts with the stub.
// The product runs that lsof under a fixed 10 s deadline (src/scratch.ts sessionOwnerLive, deadline_s: 10) and answers
// null when it expires. The 2026-11-04 18:5xZ commit gate at load1 36 got null after 10058 ms: `sh` startup plus the
// planted sleep 4 outran the 10 s. Only a null whose call ran the whole product deadline is re-observed, inside a
// load-scaled budget; a null returned sooner fails at once, so the 4 s stub must still answer definitely in time.
const SEAT_LSOF_DEADLINE_MS = 10_000;
test("planted: a slow lsof (4 s) still gives a definite seat answer: held is true, unheld is false", () => {
	const owners = join(tempDir("seat-slow-lsof"), "session-owners");
	mkdirSync(owners, { recursive: true });
	writeFileSync(join(owners, `${SESSION}.lock`), "");
	const bin = tempDir("seat-slow-lsof-bin");
	const probe = `import { defaultLiveness } from ${JSON.stringify(resolve(repo, "src/scratch.ts"))}; const started = performance.now(); const value = defaultLiveness().seatLive?.(${JSON.stringify(AGENT)}, ${JSON.stringify(SESSION)}) ?? null; console.log(JSON.stringify({ value, ms: performance.now() - started }));`;
	const answer = (stub: string) => {
		writeFileSync(join(bin, "lsof"), stub, { mode: 0o755 });
		const until = Date.now() + fixtureDeadlineS(30) * 1000;
		for (;;) {
			const child = runSync([process.execPath, "-e", probe], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, OMP_KIT_SESSION_OWNERS_DIR: owners },
				deadline_s: fixtureDeadlineS(30), max_output_bytes: 65536,
			});
			expect({ rc: child.rc, timedOut: child.timed_out }).toEqual({ rc: 0, timedOut: false });
			const observed: { value: boolean | null; ms: number } = JSON.parse(new TextDecoder().decode(child.stdout).trim());
			if (observed.value !== null || observed.ms < SEAT_LSOF_DEADLINE_MS || Date.now() >= until) return observed.value;
		}
	};
	expect(answer("#!/bin/sh\nsleep 4\necho 4242\n")).toBe(true);
	expect(answer("#!/bin/sh\nsleep 4\nexit 1\n")).toBe(false);
}, fixtureDeadlineS(150) * 1000);

const PS_TABLE = "  100     1\n  200   100\n  300   200\n  400     1\n";
const LOCK_A = `/Users/josh/.omp/run/session-owners/${SESSION}.lock`;
const LOCK_B = `/Users/josh/.omp/run/session-owners/${OTHER_SESSION}.lock`;
const TRANSCRIPT_A = `/Users/josh/.omp/profiles/claude/agent/sessions/-Developer-omp-kit/2026-10-18T17-32-44-318Z_${SESSION}.jsonl`;
const ADVISOR_B = `/Users/josh/.omp/profiles/claude/agent/sessions/-Developer-omp-kit/2026-10-18T17-32-44-318Z_${SESSION}/__advisor_${OTHER_SESSION}.jsonl`;

test("callerSeat reads the agent and the session leases held by the caller's ancestors, and names the main session only when it is unambiguous", () => {
	const calls: (readonly string[])[] = [];
	const run = (lsof: string, code: number | null = 0) => (args: readonly string[]) => {
		calls.push(args);
		return args[0] === "ps" ? { code: 0, stdout: PS_TABLE, stderr: "" } : { code, stdout: lsof, stderr: "" };
	};
	const both = callerSeat(run(`p200\nn${LOCK_A}\nn${TRANSCRIPT_A}\nn${ADVISOR_B}\nn${LOCK_B}\n`, 1), { AGENT_NAME: AGENT }, 300);
	expect(both).toEqual({ agent: AGENT, sessions: [SESSION, OTHER_SESSION], main: SESSION });
	expect(calls.find((args) => args[0] === "lsof")).toEqual(["lsof", "-a", "-p", "300,200,100", "-Fn"]);
	// Two main transcripts, or two bare leases, cannot name one main session.
	expect(callerSeat(run(`n${LOCK_A}\nn${LOCK_B}\n`), { AGENT_NAME: AGENT }, 300).main).toBeNull();
	expect(callerSeat(run(`n${LOCK_A}\n`), { AGENT_NAME: AGENT }, 300).main).toBe(SESSION);
	// No host agent, an unsafe agent, a failed lsof or an unreadable process table never invents an identity.
	expect(callerSeat(run(`n${LOCK_A}\n`), {}, 300).agent).toBeNull();
	expect(callerSeat(run(`n${LOCK_A}\n`), { AGENT_NAME: "../x" }, 300).agent).toBeNull();
	expect(callerSeat(run("", null), { AGENT_NAME: AGENT }, 300)).toEqual({ agent: AGENT, sessions: [], main: null });
	expect(callerSeat(() => ({ code: 1, stdout: "", stderr: "" }), { AGENT_NAME: AGENT }, 300)).toEqual({ agent: AGENT, sessions: [], main: null });
	// A lock outside a session-owners directory is not a lease.
	expect(callerSeat(run(`n/tmp/${SESSION}.lock\n`), { AGENT_NAME: AGENT }, 300).sessions).toEqual([]);
});

test.skipIf(!HAVE_LSOF)("callerSeat against a real seat process finds the session lease its own process holds", async () => {
	// A lease id no real seat holds, so an omp host further up this test's own ancestry cannot be mistaken for it.
	const probeSession = "0f0f0f0f-aaaa-7bbb-8ccc-ddddeeeeffff";
	const owners = join(tempDir("seat-caller"), "session-owners");
	mkdirSync(owners, { recursive: true });
	const lock = join(owners, `${probeSession}.lock`);
	writeFileSync(lock, "");
	const script = join(tempDir("seat-caller-script"), "probe.ts");
	writeFileSync(script, [
		`import { callerSeat, defaultRunner } from ${JSON.stringify(join(repo, "src", "scratch.ts"))};`,
		"console.log(JSON.stringify(callerSeat(defaultRunner)));",
	].join("\n"));
	const child = Bun.spawnSync(["sh", "-c", `exec 9<>"$LOCK"; exec "$BUN" --no-env-file run "$SCRIPT"`],
		{ env: { ...process.env, LOCK: lock, BUN: process.execPath, SCRIPT: script, AGENT_NAME: AGENT }, stdout: "pipe", stderr: "pipe" });
	expect(child.stderr.toString()).toBe("");
	const seat = JSON.parse(child.stdout.toString()) as SeatIdentity;
	expect(seat.agent).toBe(AGENT);
	expect(seat.sessions).toContain(probeSession);
}, 60_000);

function releaseFixture(owner: string, pid = 59031): { dir: string; home: string; root: string } {
	const root = tempDir("seat-release");
	const home = tempDir("seat-release-home");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	return { dir: seatDir(root, pid, owner), home, root };
}
const asSeat = (agent: string | null, sessions: string[]) => (): SeatIdentity => ({ agent, sessions, main: sessions[0] ?? null });

test("release: the successor seat (same agent, same session, new pid) can release its own dir; another agent or session cannot", () => {
	const ok = releaseFixture(seatOwner(59031));
	const released = releaseScratch(ok.dir, ok.home, deps({ ...noPid }, { callerSeat: asSeat(AGENT, [SESSION, OTHER_SESSION]) }));
	expect(released).toMatchObject({ ok: true, changed: true, reason: "owner-released" });
	expect(existsSync(join(ok.dir, ".omp-kit-release"))).toBe(true);

	for (const [name, seat] of [["a different agent", asSeat("CrimsonHorizon", [SESSION])], ["the same agent in another session", asSeat(AGENT, [OTHER_SESSION])],
		["an unidentified caller", asSeat(null, [SESSION])], ["a caller holding no session", asSeat(AGENT, [])]] as const) {
		const refused = releaseFixture(seatOwner(59032), 59032);
		const result = releaseScratch(refused.dir, refused.home, deps({ ...noPid }, { callerSeat: seat }));
		expect({ name, ...result }).toMatchObject({ name, ok: false, changed: false, reason: "caller-not-owner" });
		expect(existsSync(join(refused.dir, ".omp-kit-release"))).toBe(false);
	}
});

test("release: a pid-only owner is still releasable only by its pid or a descendant, whatever seat the caller holds", () => {
	const legacy = releaseFixture(seatOwner(59041, ""), 59041);
	expect(releaseScratch(legacy.dir, legacy.home, deps({ ...noPid }, { callerSeat: asSeat(AGENT, [SESSION]) })))
		.toMatchObject({ ok: false, reason: "caller-not-owner" });
	// Today's rule: the owner pid in the caller's ancestry still releases.
	const ancestry = releaseFixture(seatOwner(process.pid, ""), process.pid);
	expect(releaseScratch(ancestry.dir, ancestry.home, deps({ ...noPid }))).toMatchObject({ ok: true, changed: true });
});

test("release: a complete owner with a recorded process start is released by the successor seat without probing the dead pid", () => {
	const complete = `pid=59051\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=omp\nagent=${AGENT}\nsession=${SESSION}\n`;
	const fixture = releaseFixture(complete, 59051);
	expect(releaseScratch(fixture.dir, fixture.home, deps({ ...noPid }, { callerSeat: asSeat(AGENT, [SESSION]) }))).toMatchObject({ ok: true, changed: true });
	const pidOnly = releaseFixture(complete.replace(/agent=.*\nsession=.*\n/, ""), 59052);
	// The pid runs with another start: the incarnation probe is planted reused to match (ompkit-5m6ej).
	expect(releaseScratch(pidOnly.dir, pidOnly.home, deps({ ...noPid, signalAlive: () => true, processStart: () => "Mon Oct 18 17:50:00 2026",
		probe: (owner) => ({ state: "reused", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: "Mon Oct 18 17:50:00 2026", stat: "S", signal0: null, reason: "planted" } }) },
		{ callerSeat: asSeat(AGENT, [SESSION]) })))
		.toMatchObject({ ok: false });
});

test("createScratch records the caller's agent and main session in the owner; an unidentified or ambiguous caller records neither", () => {
	const make = (seat: SeatIdentity | undefined, label: string) => {
		const root = tempDir("seat-create");
		process.env.OMP_KIT_SCRATCH_ROOTS = join(root, "var", "agent-tmp");
		const result = createScratch(label, root, deps(defaultLiveness(), seat ? { callerSeat: () => seat } : {}), {}, false, join(root, "scratch-budgets.json"));
		expect(result.ok).toBe(true);
		return parseOwnerFile(readFileSync(join(result.dir, ".owner"), "utf8"));
	};
	expect(make({ agent: AGENT, sessions: [SESSION], main: SESSION }, "mine")).toMatchObject({ agent: AGENT, session: SESSION, label: "mine", pid: process.pid });
	expect(make({ agent: AGENT, sessions: [SESSION, OTHER_SESSION], main: null }, "ambiguous")).toMatchObject({ agent: null, session: null });
	expect(make({ agent: null, sessions: [SESSION], main: SESSION }, "anon")).toMatchObject({ agent: null, session: null });
	expect(make(undefined, "plain")).toMatchObject({ agent: null, session: null, pid: process.pid });
});

// --- SCRATCHSIBLING1 (ompkit-fp72.120.16.214) -------------------------------------------------------------------------
// Every background `task` agent runs inside the lead's omp process: one agent name, one main session, one ancestry, and
// the seat's process holds every live incarnation's session lease (measured 2026-11-04: the lead's main and each running
// agent's lease are held by omp pid 78248; finished agents' leases by nothing). Each incarnation names itself through
// PI_SESSION_ID. A dir records its creator; mine, gate and release reach it only from that incarnation while its lease
// is held.
const A_SUB = "01a1a6d1-65fc-736e-bd99-51de45679811";
const B_SUB = "01a1a751-0cd4-7400-9971-c4c20abcaa82";

const incarnationOwner = (pid: number, label: string, creator?: string): string =>
	`pid=${pid}\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=${label}\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=omp-kit\n`
	+ `agent=${AGENT}\nsession=${SESSION}\n${creator === undefined ? "" : `creator_session=${creator}\n`}`;

/** One seat whose omp process holds the main lease and every lease in `live`; `own` is the calling incarnation. */
function sibWorld() {
	const root = tempDir("sib-root");
	const home = tempDir("sib-home");
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const live = new Set([SESSION, A_SUB, B_SUB]);
	const make = (name: string, owner: string) => {
		const dir = join(root, name);
		mkdirSync(dir);
		writeFileSync(join(dir, ".owner"), owner);
		writeFileSync(join(dir, "work.txt"), "in progress");
		return dir;
	};
	const as = (own: string | undefined): InspectDeps => deps({ ...noPid, seatLive: (_agent, session) => live.has(session) }, {
		callerSeat: (): SeatIdentity => ({ agent: AGENT, sessions: [...live], main: SESSION, ...(own === undefined ? {} : { own }) }),
		lsofSnapshot: new Set<string>() });
	return { root, home, live, make, as };
}
const listed = (rows: { dir: string }[]) => rows.map(row => row.dir).sort();

test("SCRATCHSIBLING1 owner records: creator_session parses only inside a seat, with the session pattern's boundaries, and stays linear on long near-misses", () => {
	expect(parseOwnerFile(incarnationOwner(42, "a", B_SUB))).toMatchObject({ agent: AGENT, session: SESSION, creatorSession: B_SUB });
	expect(parseOwnerFile(incarnationOwner(42, "a", SESSION))).toMatchObject({ creatorSession: SESSION });
	expect(parseOwnerFile(incarnationOwner(42, "a"))).not.toHaveProperty("creatorSession");
	expect(parseOwnerFile(incarnationOwner(42, "a", "0".repeat(8)))).not.toBeNull();
	expect(parseOwnerFile(incarnationOwner(42, "a", "0".repeat(64)))).not.toBeNull();
	for (const bad of ["0".repeat(7), "0".repeat(65), "-0000000", "0000_0000", ""])
		expect({ bad, parsed: parseOwnerFile(incarnationOwner(42, "a", bad)) }).toEqual({ bad, parsed: null });
	const seatless = incarnationOwner(42, "a", B_SUB).replace(`agent=${AGENT}\nsession=${SESSION}\n`, "");
	expect(parseOwnerFileEx(seatless)).toMatchObject({ failure: { field: "creator_session" } });
	const nearMiss = `${"0".repeat(200_000)}_`;
	const started = performance.now();
	expect(parseOwnerFile(incarnationOwner(42, "a", nearMiss))).toBeNull();
	expect(performance.now() - started).toBeLessThan(500);
});

test("SCRATCHSIBLING1 callerSeat names the calling incarnation from PI_SESSION_ID, else from PI_SESSION_FILE's session record", () => {
	const run = (args: readonly string[]) => args[0] === "ps" ? { code: 0, stdout: PS_TABLE, stderr: "" } : { code: 0, stdout: `n${LOCK_A}\nn${TRANSCRIPT_A}\n`, stderr: "" };
	expect(callerSeat(run, { AGENT_NAME: AGENT, PI_SESSION_ID: B_SUB }, 300)).toEqual({ agent: AGENT, sessions: [SESSION], main: SESSION, own: B_SUB });
	const transcript = join(tempDir("sib-transcript"), "ScratchSibling.jsonl");
	writeFileSync(transcript, `${JSON.stringify({ type: "title", v: 1, title: "", pad: " ".repeat(180) })}\n`
		+ `${JSON.stringify({ type: "session", version: 3, id: A_SUB, parentSession: "/x/main.jsonl" })}\n{"type":"model_change"}\n`);
	expect(callerSeat(run, { AGENT_NAME: AGENT, PI_SESSION_FILE: transcript }, 300).own).toBe(A_SUB);
	// PI_SESSION_ID wins; a malformed id, a relative or missing file, or no variable names no incarnation.
	expect(callerSeat(run, { AGENT_NAME: AGENT, PI_SESSION_ID: B_SUB, PI_SESSION_FILE: transcript }, 300).own).toBe(B_SUB);
	for (const env of [{ PI_SESSION_ID: "../x" }, { PI_SESSION_FILE: "ScratchSibling.jsonl" }, { PI_SESSION_FILE: join(transcript, "..", "absent.jsonl") }, {}])
		expect(callerSeat(run, { AGENT_NAME: AGENT, ...env }, 300)).not.toHaveProperty("own");
});

test("SCRATCHSIBLING1 createScratch records the creating incarnation; a caller that names none records no creator", () => {
	const make = (seat: SeatIdentity, label: string) => {
		const root = tempDir("sib-create");
		process.env.OMP_KIT_SCRATCH_ROOTS = join(root, "var", "agent-tmp");
		const result = createScratch(label, root, deps(defaultLiveness(), { callerSeat: () => seat }), {}, false, join(root, "scratch-budgets.json"));
		expect(result.ok).toBe(true);
		return parseOwnerFile(readFileSync(join(result.dir, ".owner"), "utf8"));
	};
	expect(make({ agent: AGENT, sessions: [SESSION, B_SUB], main: SESSION, own: B_SUB }, "sub")).toMatchObject({ agent: AGENT, session: SESSION, creatorSession: B_SUB });
	expect(make({ agent: AGENT, sessions: [SESSION, B_SUB], main: SESSION, own: SESSION }, "lead")).toMatchObject({ session: SESSION, creatorSession: SESSION });
	expect(make({ agent: AGENT, sessions: [SESSION], main: SESSION }, "unnamed")).not.toHaveProperty("creatorSession");
});

test("SCRATCHSIBLING1 planted: two incarnations on one seat; B's mine lists only B's dir and B's release of A's live dir is refused; A's own release and a release after A exits succeed", () => {
	const w = sibWorld();
	const aOwn = w.make("aown.59101", incarnationOwner(59101, "aown", A_SUB));
	const aLeft = w.make("aleft.59102", incarnationOwner(59102, "aleft", A_SUB));
	const bDir = w.make("bwork.59103", incarnationOwner(59103, "bwork", B_SUB));
	const lead = w.make("lead-hooks2.59104", incarnationOwner(59104, "lead-hooks2", SESSION));
	// mine and gate: each incarnation is told about its own dirs only.
	expect(listed(ownedScratch(w.home, w.as(B_SUB)))).toEqual([bDir]);
	expect(listed(disposalGate(w.home, "session-end", w.as(B_SUB)).owed)).toEqual([bDir]);
	expect(listed(ownedScratch(w.home, w.as(A_SUB)))).toEqual([aLeft, aOwn]);
	expect(listed(ownedScratch(w.home, w.as(SESSION)))).toEqual([lead]);
	// B's seat release of A's live dir, and of the lead's live TMPDIR (the 2026-11-04 lead-hooks2.13390 case), is refused.
	for (const dir of [aLeft, lead]) {
		const refused = releaseScratch(dir, w.home, w.as(B_SUB), { bin: "throwaway", now: true });
		expect({ dir, ...refused }).toMatchObject({ dir, ok: false, changed: false, reason: "sibling-live" });
		expect(refused.detail).toContain("--capability");
		expect(existsSync(join(dir, "work.txt"))).toBe(true);
		expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
	}
	// The lead's main session is just another incarnation to A's dirs: refused while A lives.
	expect(releaseScratch(aLeft, w.home, w.as(SESSION), { bin: "throwaway", now: true })).toMatchObject({ ok: false, reason: "sibling-live" });
	// A's own release succeeds.
	expect(releaseScratch(aOwn, w.home, w.as(A_SUB), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(aOwn)).toBe(false);
	// A exits: its lease is no longer held. Its leftovers fall to the seat; the main session is told about them, B is not.
	w.live.delete(A_SUB);
	expect(listed(ownedScratch(w.home, w.as(SESSION)))).toEqual([aLeft, lead]);
	expect(listed(ownedScratch(w.home, w.as(B_SUB)))).toEqual([bDir]);
	expect(releaseScratch(aLeft, w.home, w.as(B_SUB), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	expect(existsSync(aLeft)).toBe(false);
	// B's own dir and the lead's live TMPDIR were never touched.
	expect(existsSync(join(bDir, "work.txt")) && existsSync(join(lead, "work.txt"))).toBe(true);
});

test("SCRATCHSIBLING1: an unprovable lease is live, the capability is still the cross-process route, and the open-file and user checks still hold", () => {
	const w = sibWorld();
	const capability = "c".repeat(64);
	const sha = new Bun.CryptoHasher("sha256").update(capability).digest("hex");
	const aDir = w.make("acap.59111", `${incarnationOwner(59111, "acap", A_SUB)}capability_sha256=${sha}\n`);
	// A's lease is outside the caller's ancestry and the probe cannot tell: unprovable reads live, never dead.
	w.live.delete(A_SUB);
	const unprovable = deps({ ...noPid, seatLive: () => null }, { callerSeat: (): SeatIdentity => ({ agent: AGENT, sessions: [SESSION, B_SUB], main: SESSION, own: B_SUB }),
		lsofSnapshot: new Set<string>() });
	const refused = releaseScratch(aDir, w.home, unprovable, { bin: "throwaway", now: true });
	expect(refused).toMatchObject({ ok: false, reason: "sibling-live" });
	expect(refused.detail).toContain("unprovable");
	// The capability releases A's dir from B, through the same open-file check (held) ...
	w.live.add(A_SUB);
	const held = releaseScratch(aDir, w.home, { ...w.as(B_SUB), lsofSnapshot: new Set([join(aDir, "work.txt")]) }, { bin: "throwaway", now: true, capability });
	expect(held).toMatchObject({ ok: false, changed: true, reason: "now-held-open-fds" });
	// ... and a wrong token is still a sibling refusal, never caller-not-owner by another route.
	expect(releaseScratch(aDir, w.home, w.as(B_SUB), { bin: "throwaway", now: true, capability: "d".repeat(64) })).toMatchObject({ ok: false, reason: "sibling-live" });
	expect(existsSync(join(aDir, "work.txt"))).toBe(true);
});

test("SCRATCHSIBLING1 control: a dir with no creator_session (made before it existed) keeps today's seat authority, unchanged", () => {
	const w = sibWorld();
	const legacy = w.make("legacy.59121", incarnationOwner(59121, "legacy"));
	// Every seat holder still sees it and may release it, as before; only the open-file and user checks decide --now.
	for (const own of [B_SUB, A_SUB, SESSION, undefined]) expect({ own, rows: listed(ownedScratch(w.home, w.as(own))) }).toEqual({ own, rows: [legacy] });
	expect(releaseScratch(legacy, w.home, { ...w.as(B_SUB), lsofSnapshot: new Set([join(legacy, "work.txt")]) }, { bin: "throwaway", now: true }))
		.toMatchObject({ ok: false, changed: true, reason: "now-held-open-fds" });
	expect(releaseScratch(legacy, w.home, w.as(B_SUB), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	// A caller naming no incarnation (an extension's own process) keeps that authority too, and gains none over a live creator.
	const legacy2 = w.make("legacy2.59122", incarnationOwner(59122, "legacy2"));
	expect(releaseScratch(legacy2, w.home, w.as(undefined), { bin: "throwaway" })).toMatchObject({ ok: true, reason: "owner-released" });
	const bDir = w.make("bwork.59123", incarnationOwner(59123, "bwork", B_SUB));
	expect(releaseScratch(bDir, w.home, w.as(undefined), { bin: "throwaway" })).toMatchObject({ ok: false, reason: "sibling-live" });
	expect(listed(ownedScratch(w.home, w.as(undefined)))).toEqual([legacy2]);
});

test("SCRATCHSIBLING1 control: a dead lease leaves the dir releasable by the seat; a lease that comes back (a resumed agent) refuses again", () => {
	const w = sibWorld();
	const first = w.make("adead.59131", incarnationOwner(59131, "adead", A_SUB));
	const second = w.make("aback.59132", incarnationOwner(59132, "aback", A_SUB));
	w.live.delete(A_SUB);
	expect(releaseScratch(first, w.home, w.as(B_SUB), { bin: "throwaway" })).toMatchObject({ ok: true, changed: true, reason: "owner-released" });
	expect(releaseScratch(first, w.home, w.as(SESSION), { bin: "throwaway", now: true })).toMatchObject({ ok: true, reason: "owner-released-deleted" });
	w.live.add(A_SUB);
	expect(releaseScratch(second, w.home, w.as(SESSION), { bin: "throwaway" })).toMatchObject({ ok: false, reason: "sibling-live" });
	expect(existsSync(join(second, ".omp-kit-release"))).toBe(false);
});

// The real lease path end to end: the CLI under PI_SESSION_ID=B, a child of this test process, which holds the seat's
// leases open as the seat's omp process does. While A's lease is held the CLI exits SCRATCH_RELEASE_SIBLING_LIVE; once
// only the main and B leases are held, lsof finds no holder for A and the same release retires the dir.
test.skipIf(!HAVE_LSOF)("SCRATCHSIBLING1 CLI: SCRATCH_RELEASE_SIBLING_LIVE while A's lease is held; released once A's lease is free", async () => {
	const owners = join(tempDir("sib-cli-owners"), "session-owners");
	mkdirSync(owners, { recursive: true });
	const lease = (session: string) => { const path = join(owners, `${session}.lock`); writeFileSync(path, ""); return openSync(path, "r"); };
	const [main, a, b] = [lease(SESSION), lease(A_SUB), lease(B_SUB)];
	const root = tempDir("sib-cli-root");
	const state = join(tempDir("sib-cli-home"), "state");
	const dir = join(root, "awork.59141");
	mkdirSync(dir);
	writeFileSync(join(dir, ".owner"), incarnationOwner(59141, "awork", A_SUB));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, { AGENT_NAME: AGENT, PI_SESSION_ID: B_SUB, OMP_KIT_SCRATCH_ROOTS: root, XDG_STATE_HOME: state, OMP_KIT_SESSION_OWNERS_DIR: owners });
	const release = () => {
		const child = runSync([process.execPath, "--no-env-file", join(repo, "src", "cli.ts"), "scratch", "release", dir, "--bin", "throwaway", "--now", "--json"],
			{ deadline_s: fixtureDeadlineS(30), env, max_output_bytes: 1 << 20 });
		const out = JSON.parse(new TextDecoder().decode(child.stdout)) as { ok: boolean; data?: { deleted?: boolean }; errors?: { code: string; message: string }[] };
		return { code: child.rc, ok: out.ok, deleted: out.data?.deleted ?? false, error: out.errors?.[0]?.code ?? null, message: out.errors?.[0]?.message ?? "" };
	};
	try {
		// A slow lsof makes the seat unproven (caller-not-owner) or the lease unprovable; re-observe until definite.
		const refused = await definite(release, value => value.error === "SCRATCH_RELEASE_REFUSED" && value.message.includes("caller-not-owner"));
		expect(refused).toMatchObject({ ok: false, error: "SCRATCH_RELEASE_SIBLING_LIVE" });
		expect(refused.message).toContain(`incarnation ${A_SUB}`);
		expect(existsSync(join(dir, ".omp-kit-release"))).toBe(false);
		closeSync(a);
		const released = await definite(release,
			value => (value.error === "SCRATCH_RELEASE_SIBLING_LIVE" && value.message.includes("unprovable")) || value.message.includes("caller-not-owner"));
		expect(released).toMatchObject({ code: 0, ok: true, deleted: true });
		expect(existsSync(dir)).toBe(false);
	} finally {
		for (const fd of [main, a, b]) try { closeSync(fd); } catch { /* already closed */ }
	}
}, fixtureDeadlineS(90) * 1000);
