// SCRATCHOWN1 (ompkit-1dnwk): every .owner carries seat identity resolvable to
// a live pane. Creation stamps the seat whenever the caller holds one (even on
// the programmatic path with no injected callerSeat); any structured owner —
// seated or pid-only — attributes to its seat, and dead holders attribute to
// no live seat, which is what makes them reclaimable.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { attributeOwnerSeat, createScratch, defaultLiveness, inspectSession, parseOwnerFile, seatSessionsOfPid } from "../../src/scratch.ts";
import type { InspectDeps, LivenessDeps, ScratchOwner } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repo = resolve(import.meta.dir, "../..");
const AGENT = "TurquoiseSummit";
const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const OTHER_SESSION = "01a1502a-5647-76ba-89c5-949087f3e283";
const LOCK = `/owners/session-owners/${SESSION}.lock`;

const cleanup: string[] = [];
const savedAgent = process.env.AGENT_NAME;
const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedAgent === undefined) delete process.env.AGENT_NAME;
	else process.env.AGENT_NAME = savedAgent;
	if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
	else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
});

function tempDir(label: string): string {
	const dir = ownedTmp(label).path;
	cleanup.push(dir);
	return dir;
}

// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: Pick<LivenessDeps, "signalAlive" | "psVisible" | "processStart" | "probe"> =
	{ signalAlive: () => false, psVisible: () => false, processStart: () => null,
		probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const clearRun = () => ({ code: 1, stdout: "", stderr: "" });

function seatedOwner(): ScratchOwner {
	const parsed = parseOwnerFile(
		`pid=59001\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=test\nagent=${AGENT}\nsession=${SESSION}\n`);
	if (!parsed) throw new Error("seated fixture must parse");
	return parsed;
}

function pidOnlyOwner(pid: number): ScratchOwner {
	const parsed = parseOwnerFile(
		`pid=${pid}\nprocess_start=Mon Oct 18 17:32:44 2026\nlabel=omp\nrepo=${repo}\ncreated_at=2026-10-18T17:32:44Z\nargv0=test\n`);
	if (!parsed) throw new Error("pid-only fixture must parse");
	return parsed;
}

test("a seated owner attributes to its named seat while the lease is held", () => {
	const got = attributeOwnerSeat(seatedOwner(),
		{ run: clearRun, seatLive: (agent, session) => agent === AGENT && session === SESSION });
	expect(got).toEqual({ agent: AGENT, sessions: [SESSION], seatLive: true });
});

test("planted negative: a seated owner whose lease is gone attributes to no live seat, and the reaper reclaims it", () => {
	const got = attributeOwnerSeat(seatedOwner(), { run: clearRun, seatLive: () => false });
	expect(got).toEqual({ agent: AGENT, sessions: [SESSION], seatLive: false });
	const home = tempDir("seat-id-dead");
	mkdirSync(join(home, "var", "agent-tmp"), { recursive: true });
	const root = join(home, "var", "agent-tmp");
	const dir = join(root, "omp.59001");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, ".owner"),
		`pid=59001\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=omp\nrepo=${home}\ncreated_at=2026-10-01T00:00:00Z\nargv0=test\nagent=${AGENT}\nsession=${SESSION}\n`);
	expect(inspectSession(dir, root, { liveness: { ...noPid, seatLive: () => false }, run: clearRun }))
		.toMatchObject({ action: "REAP", reason: "owner-dead-no-open-fds" });
});

test("planted negative: a seated owner whose liveness is unprovable stays unproven, never live", () => {
	const got = attributeOwnerSeat(seatedOwner(), { run: clearRun });
	expect(got.seatLive).toBeNull();
});

test("a pid-only holder inside a session attributes to that live seat without naming an agent", () => {
	const pid = 59002;
	const run = (args: readonly string[]) => args[0] === "ps"
		? { code: 0, stdout: `  ${pid} 100\n  100 1\n`, stderr: "" }
		: { code: 0, stdout: `p${pid}\nn${LOCK}\n`, stderr: "" };
	expect(seatSessionsOfPid(pid, run)).toEqual([SESSION]);
	const got = attributeOwnerSeat(pidOnlyOwner(pid), { run, seatLive: () => true });
	expect(got).toEqual({ agent: null, sessions: [SESSION], seatLive: true });
});

test("planted negative: a pid-only holder outside any session names no seat to nudge", () => {
	const pid = 59003;
	const run = (args: readonly string[]) => args[0] === "ps"
		? { code: 0, stdout: `  ${pid} 100\n  100 1\n`, stderr: "" }
		: { code: 1, stdout: "", stderr: "" };
	expect(attributeOwnerSeat(pidOnlyOwner(pid), { run, seatLive: () => true }))
		.toEqual({ agent: null, sessions: [], seatLive: false });
});

test("planted negative: a dead pid and an unreadable process table attribute to no live seat", () => {
	const dead = attributeOwnerSeat(pidOnlyOwner(59999), { run: clearRun, seatLive: () => true });
	expect(dead).toEqual({ agent: null, sessions: [], seatLive: false });
	const unproven = attributeOwnerSeat(pidOnlyOwner(59998),
		{ run: () => ({ code: 0, stdout: "", stderr: "" }), seatLive: () => true });
	expect(unproven.sessions).toEqual([]);
});

test("creation without an injected seat still stamps it when the caller holds one", () => {
	const me = process.pid;
	const lock = `/owners/session-owners/${OTHER_SESSION}.lock`;
	const run = (args: readonly string[]) => {
		if (args[0] === "ps") return { code: 0, stdout: `  ${me} 100\n  100 1\n`, stderr: "" };
		if (args[0] === "lsof") return { code: 0, stdout: `p${me}\nn${lock}\n`, stderr: "" };
		return { code: 1, stdout: "", stderr: "" };
	};
	process.env.AGENT_NAME = AGENT;
	const home = tempDir("seat-id-create");
	const ledger = join(tempDir("seat-id-ledger"), "ledger.json");
	const deps: InspectDeps = { liveness: { ...defaultLiveness(), seatLive: () => true }, run };
	process.env.OMP_KIT_SCRATCH_ROOTS = join(home, "var", "agent-tmp");
	const created = createScratch("seatidn", home, deps, {}, false, ledger);
	expect(created.ok).toBe(true);
	const owner = parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"));
	expect(owner).toMatchObject({ agent: AGENT, session: OTHER_SESSION });
	expect(attributeOwnerSeat(owner!, { run, seatLive: (agent, s) => agent === AGENT && s === OTHER_SESSION }).seatLive).toBe(true);
});

test("planted negative: creation by a seatless caller keeps a pid owner and still succeeds", () => {
	delete process.env.AGENT_NAME;
	const home = tempDir("seat-id-noseat");
	const ledger = join(tempDir("seat-id-ledger2"), "ledger.json");
	const deps: InspectDeps = { liveness: defaultLiveness(), run: clearRun };
	process.env.OMP_KIT_SCRATCH_ROOTS = join(home, "var", "agent-tmp");
	const created = createScratch("seatless", home, deps, {}, false, ledger);
	expect(created.ok).toBe(true);
	expect(parseOwnerFile(readFileSync(join(created.dir, ".owner"), "utf8"))).toMatchObject({ agent: null, session: null });
});
