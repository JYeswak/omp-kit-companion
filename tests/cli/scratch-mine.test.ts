// ompkit-774u.15 SCRATCHBIN1 C (library half): the caller's own scratch dirs and where each stands, so a disposal-point
// guard can tell an owner what it still owes. Other owners' dirs never appear.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedScratch, releaseScratch, type InspectDeps, type LivenessDeps, type SeatIdentity } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const NOW = Date.parse("2026-10-18T20:00:00.000Z");
const AGENT = "TurquoiseSummit";
const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const OTHER_SESSION = "01a1502a-5647-76ba-89c5-949087f3e283";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const seat = (agent: string | null, sessions: string[]) => (): SeatIdentity => ({ agent, sessions, main: sessions[0] ?? null });
const deps = (callerSeat: () => SeatIdentity): InspectDeps => ({ liveness: noPid, run: () => ({ code: 1, stdout: "", stderr: "" }), now: NOW, callerSeat });
const owner = (pid: number, label: string, extra = "") => `pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-18T17:00:00Z\n${extra}`;

test("the caller sees its own dirs by seat or by pid, with their state and bin, and nobody else's", () => {
	const root = ownedTmp("mine", { root: scratchParent }).path;
	const home = ownedTmp("mine-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const plant = (name: string, text: string): string => { const dir = join(root, name); mkdirSync(dir); writeFileSync(join(dir, ".owner"), text); return dir; };
	plant("seat.59101", owner(59101, "seat", `agent=${AGENT}\nsession=${SESSION}\nbin=throwaway\n`));
	plant("pid.1", owner(process.pid, "pid"));
	plant("held.59103", owner(59103, "held", `agent=${AGENT}\nsession=${SESSION}\nbin=hold\nbead=ompkit-774u.15\nexpires=2026-10-20\n`));
	plant("lapsed.59104", owner(59104, "lapsed", `agent=${AGENT}\nsession=${SESSION}\nbin=hold\nbead=ompkit-774u.15\nexpires=2026-10-18T19:00:00Z\n`));
	plant("other-agent.59105", owner(59105, "other-agent", `agent=CrimsonHorizon\nsession=${SESSION}\n`));
	plant("other-session.59106", owner(59106, "other-session", `agent=${AGENT}\nsession=${OTHER_SESSION}\n`));
	plant("pid-elsewhere.59107", owner(59107, "pid-elsewhere"));
	mkdirSync(join(root, "unowned.59108"));
	const released = plant("released.59109", owner(process.pid, "released"));
	const caller = deps(seat(AGENT, [SESSION]));
	expect(releaseScratch(released, home, caller, { bin: "throwaway" }).ok).toBe(true);

	const rows = ownedScratch(home, caller);
	expect(rows.map((row) => [row.label, row.state, row.bin])).toEqual([
		["held", "held", "hold"],
		["lapsed", "hold-expired", "hold"],
		["pid", "unreleased", "unbinned"],
		["released", "released", "throwaway"],
		["seat", "unreleased", "throwaway"],
	]);
	expect(ownedScratch(home, deps(seat(null, []))).map((row) => row.label)).toEqual(["pid", "released"]);
	expect(ownedScratch(home, deps(seat("CrimsonHorizon", [SESSION]))).map((row) => row.label)).toEqual(["other-agent", "pid", "released"]);
});

test("ancestor and sibling owners are excluded from exact caller disposal accounting", () => {
	const root = ownedTmp("mine", { root: scratchParent }).path;
	const home = ownedTmp("mine-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	for (const [name, pid] of [["placeholder.1", 1], ["ancestor.2", 4242], ["stranger.3", 4243]] as const) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, ".owner"), owner(pid, name.split(".")[0]!));
	}
	const table = `${process.pid} 4242\n4242 1\n1 0\n`;
	const withTable: InspectDeps = { ...deps(seat(null, [])), run: (args) => (args[0] === "ps" ? { code: 0, stdout: table, stderr: "" } : { code: 1, stdout: "", stderr: "" }) };
	expect(ownedScratch(home, withTable).map((row) => row.label)).toEqual([]);
});

test("one listing reads the process table and the seat once, however many dirs it walks", () => {
	const root = ownedTmp("mine", { root: scratchParent }).path;
	const home = ownedTmp("mine-home", { root: scratchParent }).path;
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	for (let index = 0; index < 40; index++) {
		mkdirSync(join(root, `d.${index}`));
		writeFileSync(join(root, `d.${index}`, ".owner"), owner(60000 + index, `d${index}`, `agent=${AGENT}\nsession=${SESSION}\n`));
	}
	let runs = 0;
	let seats = 0;
	const counting: InspectDeps = { ...deps(seat(AGENT, [SESSION])), run: () => { runs++; return { code: 0, stdout: `${process.pid} 1\n1 0\n`, stderr: "" }; },
		callerSeat: () => { seats++; return { agent: AGENT, sessions: [SESSION], main: SESSION }; } };
	expect(ownedScratch(home, counting)).toHaveLength(40);
	expect(seats).toBe(1);
	expect(runs).toBeLessThanOrEqual(1);
	// Dirs whose owner names neither this seat nor the caller pid are excluded without ancestry attribution.
	for (let index = 0; index < 40; index++) writeFileSync(join(root, `d.${index}`, ".owner"), owner(60000 + index, `d${index}`));
	runs = 0;
	expect(ownedScratch(home, counting)).toHaveLength(0);
	expect(runs).toBe(0);
});
