// ompkit-774u.9.3 OWNERKEY1: a scratch owner is the agent and its omp session, never a bare pid. A respawned seat
// (same agent and session, new pid) and a tool shell whose $$ exited both keep their scratch LIVE while the seat
// lives; the pid rule is unchanged for pid-only owners.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyReap, callerSeat, createScratch, defaultLiveness, defaultRunner, inspectSession, parseOwnerFile, planScratch, releaseScratch,
	type InspectDeps, type LivenessDeps, type SeatIdentity } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const AGENT = "TurquoiseSummit";
const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const OTHER_SESSION = "01a1502a-5647-76ba-89c5-949087f3e283";
const HAVE_LSOF = Bun.which("lsof") !== null;

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
const noPid: Pick<LivenessDeps, "processStart" | "probe"> = { processStart: () => null,
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

test("respawned seat: the same agent and session under a new pid keeps scratch LIVE; legacy PID-only owners stay unproven", () => {
	const root = tempDir("seat-owner");
	const oldPid = 59001;
	const dir = seatDir(root, oldPid);
	const live = inspectSession(dir, root, deps({ ...noPid, seatLive: (agent, session) => agent === AGENT && session === SESSION }));
	expect(live).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: () => false })))
		.toMatchObject({ action: "REAP", reason: "owner-seat-gone-no-open-fds" });
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: () => null })))
		.toMatchObject({ action: "SKIP", reason: "owner-seat-liveness-unproven" });
	expect(inspectSession(dir, root, deps({ ...noPid }))).toMatchObject({ action: "SKIP", reason: "owner-seat-liveness-unproven" });
	// A seat for a different session never keeps this record alive.
	expect(inspectSession(dir, root, deps({ ...noPid, seatLive: (_agent, session) => session === OTHER_SESSION })))
		.toMatchObject({ action: "REAP", reason: "owner-seat-gone-no-open-fds" });

	const legacy = seatDir(root, 59002, seatOwner(59002, ""));
	expect(inspectSession(legacy, root, deps({ ...noPid, seatLive: () => true })))
		.toMatchObject({ action: "SKIP", reason: "owner-liveness-unproven" });
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
		expect(real.seatLive?.(AGENT, SESSION)).toBe(true);
		expect(real.seatLive?.(AGENT, OTHER_SESSION)).toBe(false);
		const shell = Bun.spawnSync(["sh", "-c", "echo $$"], { stdout: "pipe" });
		const shellPid = Number(shell.stdout.toString().trim());
		const dir = join(root, `ts.${shellPid}`);
		mkdirSync(dir);
		writeFileSync(join(dir, ".owner"), `pid=${shellPid}\nlabel=ts\nrepo=${repo}\ncreated=2026-10-18T17:40:00.000Z\nagent=${AGENT}\nsession=${SESSION}\n`);
		expect(inspectSession(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		seat.kill("SIGTERM");
		await seat.exited;
		expect(real.seatLive?.(AGENT, SESSION)).toBe(false);
		expect(inspectSession(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "REAP", reason: "owner-seat-gone-no-open-fds" });
	} finally {
		seat.kill("SIGKILL");
	}
}, 60_000);

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
		expect(inspectSession(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		await stop(second);
		const third = await start();
		expect(inspectSession(dir, root, { liveness: real, run: defaultRunner })).toMatchObject({ action: "LIVE", reason: "owner-seat-alive" });
		// The last seat releases a dir the first one created; an unrelated agent in the same session cannot.
		const work = join(root, `work.${first.pid}`);
		mkdirSync(work);
		writeFileSync(join(work, ".owner"), seatOwner(first.pid).replace("label=omp", "label=work"));
		const sibling = { liveness: real, run: defaultRunner };
		expect(releaseScratch(work, home, { ...sibling, callerSeat: asSeat("CrimsonHorizon", [SESSION]) })).toMatchObject({ ok: false, reason: "caller-not-owner" });
		expect(releaseScratch(work, home, { ...sibling, callerSeat: asSeat(AGENT, [SESSION]) })).toMatchObject({ ok: true, changed: true, ownerPid: first.pid });
		// With the last seat gone and no pid alive, the other dir is REAP as before.
		await stop(third);
		expect(real.seatLive?.(AGENT, SESSION)).toBe(false);
		expect(inspectSession(dir, root, sibling)).toMatchObject({ action: "REAP", reason: "owner-seat-gone-no-open-fds" });
	} finally {
		for (const seat of live) seat.kill("SIGKILL");
	}
}, 60_000);

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

test("release: a pid-only owner cannot be authorized by PID ancestry", () => {
	const legacy = releaseFixture(seatOwner(59041, ""), 59041);
	expect(releaseScratch(legacy.dir, legacy.home, deps({ ...noPid }, { callerSeat: asSeat(AGENT, [SESSION]) })))
		.toMatchObject({ ok: false, reason: "caller-not-owner" });
	const ancestry = releaseFixture(seatOwner(process.pid, ""), process.pid);
	expect(releaseScratch(ancestry.dir, ancestry.home, deps({ ...noPid })))
		.toMatchObject({ ok: false, changed: false, reason: "caller-not-owner" });
	expect(existsSync(join(ancestry.dir, ".omp-kit-release"))).toBe(false);
});

test("release: a complete owner with a recorded process start is released by the successor seat without probing the dead pid", () => {
	const complete = `pid=59051\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=omp\nagent=${AGENT}\nsession=${SESSION}\n`;
	const fixture = releaseFixture(complete, 59051);
	expect(releaseScratch(fixture.dir, fixture.home, deps({ ...noPid }, { callerSeat: asSeat(AGENT, [SESSION]) }))).toMatchObject({ ok: true, changed: true });
	const pidOnly = releaseFixture(complete.replace(/agent=.*\nsession=.*\n/, ""), 59052);
	// The pid runs with another start: the incarnation probe is planted reused to match (ompkit-5m6ej).
	expect(releaseScratch(pidOnly.dir, pidOnly.home, deps({ ...noPid, processStart: () => "Mon Oct 18 17:50:00 2026",
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
