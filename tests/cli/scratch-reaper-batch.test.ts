// REAPTIMEOUT1 (ompkit-1ra0d.232): the live census outgrew an unbounded scan (TIMEOUT every run
// since 2026-11-04, one full-system lsof snapshot per dir). applyScratch now covers a budgeted slice
// per run and persists its scan cursor, so successive runs advance to full coverage.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, type ApplyDeps, type LivenessDeps, type ReaperCursorStore, type ScratchRunner } from "../../src/scratch.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const companion = resolve(import.meta.dir, "../..");
const scratchParent = join(companion, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const owned: OwnedTmp[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const tmp of owned.splice(0)) tmp.cleanup();
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const clearRun: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });
// Two live pids and every other pid dead: the kitlib proc incarnation probe is planted per pid.
const LIVE = new Set([59311, 59312]);
const liveness: LivenessDeps = {
	signalAlive: pid => LIVE.has(pid),
	psVisible: pid => LIVE.has(pid),
	processStart: () => null,
	probe: owner => LIVE.has(owner.pid)
		? { state: "live", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: owner.start, stat: null, signal0: "alive", reason: "planted: pid live" } }
		: { state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } },
};

const BUDGET = 5;

function world(): { root: string; home: string; repo: string; kept: string[]; dead: string[] } {
	const tmp = ownedTmp("reaptimeout", { root: scratchParent });
	owned.push(tmp);
	const repo = join(tmp.path, "repo");
	const root = join(repo, "var", "agent-tmp");
	const home = join(tmp.path, "home");
	mkdirSync(root, { recursive: true });
	mkdirSync(join(home, "state"), { recursive: true });
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	// Kept dirs sort first so a cursorless run never reaches the dead tail.
	const kept: string[] = [];
	const plant = (name: string, owner: string | null): string => {
		const dir = join(root, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "work.txt"), "work");
		if (owner !== null) writeFileSync(join(dir, ".owner"), owner);
		return dir;
	};
	const ownerOf = (pid: number, label: string) =>
		`pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-01T00:00:00Z\nbin=throwaway\npurpose=probe\n`;
	kept.push(plant("a-live.59311", ownerOf(59311, "a-live")));
	kept.push(plant("b-live.59312", ownerOf(59312, "b-live")));
	kept.push(plant("c-text", "agent: KeepSeat | label: c-text | repo: placeholder | bead: some-bead | created: 2026-10-01T00:00:00Z"));
	kept.push(plant("d-fresh", null));
	kept.push(plant("e-fresh", null));
	// The text owner's repo must resolve to a directory or the dir reaps as repo-gone.
	const dead: string[] = [];
	for (let i = 1; i <= 6; i++) {
		const pid = 599900 + i;
		dead.push(plant(`f-dead-${String(i).padStart(2, "0")}.${pid}`, ownerOf(pid, `f-dead-${String(i).padStart(2, "0")}`)));
	}
	return { root, home, repo, kept, dead };
}

// Fix the text owner's repo placeholder to the fixture repo (a directory), so the bead probe
// (clearRun: br unavailable) keeps it SKIP text-owner-bead-unproven instead of reaping it repo-gone.
function fixTextRepo(root: string, repo: string): void {
	const path = join(root, "c-text", ".owner");
	writeFileSync(path, `agent: KeepSeat | label: c-text | repo: ${repo} | bead: some-bead | created: 2026-10-01T00:00:00Z`);
}

function memoryStore(): ReaperCursorStore & { seen(): (string | null)[] } {
	const saves: (string | null)[] = [];
	let cursor: string | null = null;
	return {
		load: () => cursor,
		save: (next: string | null) => { cursor = next; saves.push(next); },
		seen: () => saves,
	};
}

function runOnce(home: string, store: ReaperCursorStore | null, visited: string[][]): { sessions: number; applied: number } {
	const runVisited: string[] = [];
	const deps: ApplyDeps = {
		liveness, run: clearRun, home, systemTempBases: [],
		entryBudget: BUDGET, cursorStore: store,
		onProgress: verdict => { runVisited.push(verdict.dir); },
	};
	const result = applyScratch(home, deps);
	visited.push(runVisited);
	return { sessions: result.sessions.length, applied: result.applied.length };
}

test("REAPTIMEOUT1 control: a census larger than one run's budget is fully processed across successive runs", () => {
	const { root, home, repo, kept, dead } = world();
	fixTextRepo(root, repo);
	const store = memoryStore();
	const visited: string[][] = [];
	// Three runs of budget 5 cover 5 kept + 6 dead (5 + 5 + 1).
	for (let run = 0; run < 3; run++) {
		const { sessions, applied } = runOnce(home, store, visited);
		expect(sessions).toBeLessThanOrEqual(BUDGET);
		expect(applied).toBeLessThanOrEqual(BUDGET);
	}
	// Every dead dir reaped, every kept dir (live owner, unprovable bead, fresh unowned) still present.
	for (const dir of dead) expect(existsSync(dir)).toBe(false);
	for (const dir of kept) expect(existsSync(dir)).toBe(true);
	// The cursor advanced past the head slice and reset once the census was fully covered.
	expect(store.seen().length).toBe(3);
	expect(store.seen()[2]).toBeNull();
	expect(visited.flat().some(dir => dir.endsWith("f-dead-06.599906"))).toBe(true);
}, fixtureDeadlineS() * 1000);

test("REAPTIMEOUT1 mutant: with cursor persistence disabled, the same census never completes", () => {
	const { root, home, repo, kept, dead } = world();
	fixTextRepo(root, repo);
	const visited: string[][] = [];
	for (let run = 0; run < 3; run++) {
		const { sessions } = runOnce(home, null, visited);
		expect(sessions).toBeLessThanOrEqual(BUDGET);
	}
	// No run ever reaches the dead tail: every run re-inspects the same kept head slice.
	expect(visited[0]).toEqual(visited[1]);
	expect(visited[1]).toEqual(visited[2]);
	expect(visited.flat().some(dir => dir.includes("f-dead"))).toBe(false);
	for (const dir of dead) expect(existsSync(dir)).toBe(true);
	for (const dir of kept) expect(existsSync(dir)).toBe(true);
}, fixtureDeadlineS() * 1000);
