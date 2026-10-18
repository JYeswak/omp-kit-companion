// ompkit-774u.15 SCRATCHBIN1 C (library half): the caller's own scratch dirs and where each stands, so a disposal-point
// guard can tell an owner what it still owes. Other owners' dirs never appear.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedScratch, releaseScratch, type InspectDeps, type LivenessDeps, type SeatIdentity } from "../../src/scratch.ts";

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

const noPid: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null };
const seat = (agent: string | null, sessions: string[]) => (): SeatIdentity => ({ agent, sessions, main: sessions[0] ?? null });
const deps = (callerSeat: () => SeatIdentity): InspectDeps => ({ liveness: noPid, run: () => ({ code: 1, stdout: "", stderr: "" }), now: NOW, callerSeat });
const owner = (pid: number, label: string, extra = "") => `pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-18T17:00:00Z\n${extra}`;

test("the caller sees its own dirs by seat or by pid, with their state and bin, and nobody else's", () => {
	const root = mkdtempSync(join(scratchParent, "mine-"));
	const home = mkdtempSync(join(scratchParent, "mine-home-"));
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
