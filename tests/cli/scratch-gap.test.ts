// ompkit-774u.15 SCRATCHBIN1 D: a reap or reclaim is an emergency and every one is a gap report. Each reclaimed dir that
// its owner did not bin is named with its agent, label, role, bin and the guard that should have stopped it; a dir the
// owner released into a bin is not a gap.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, reapLogPath, releaseScratch, scratchGapReport, type ApplyDeps, type LivenessDeps } from "../../src/scratch.ts";

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const SESSION_A = "01a15012-af9e-7628-bee6-496084668412";
const SESSION_B = "01a1502a-5647-76ba-89c5-949087f3e283";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME, fleet: process.env.OMP_KIT_FLEET_WATCH_CONFIG };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state], ["OMP_KIT_FLEET_WATCH_CONFIG", saved.fleet]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const liveness: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null, seatLive: () => false };
const applyDeps = (home: string): ApplyDeps => ({ home, liveness, run: () => ({ code: 1, stdout: "", stderr: "" }) });

function world(): { root: string; home: string; plant: (name: string, owner: string | null) => string } {
	const root = mkdtempSync(join(scratchParent, "gap-"));
	const home = mkdtempSync(join(scratchParent, "gap-home-"));
	cleanup.push(root, home);
	process.env.OMP_KIT_SCRATCH_ROOTS = root;
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const plant = (name: string, owner: string | null): string => {
		const dir = join(root, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "work.txt"), "work");
		if (owner !== null) writeFileSync(join(dir, ".owner"), owner);
		return dir;
	};
	return { root, home, plant };
}
const owner = (pid: number, label: string, extra = "") => `pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-10T10:00:00Z\n${extra}`;

test("an emergency reap names, for each dir its owner left unbinned, the agent, role, bin and the guard; a binned release is not a gap", () => {
	const { root, home, plant } = world();
	const fleet = join(home, "fleet-watch.json");
	writeFileSync(fleet, JSON.stringify({ chief: { agent: "ChiefOne", session: "omp-chief" }, sessions: [] }));
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = fleet;
	plant("pidonly.59011", owner(59011, "pidonly"));
	plant("chief.59012", owner(59012, "chief", `agent=ChiefOne\nsession=${SESSION_A}\n`));
	plant("worker.59013", owner(59013, "worker", `agent=WorkerOne\nsession=${SESSION_B}\nbin=throwaway\n`));
	const binned = plant("binned.1", owner(process.pid, "binned"));
	const loose = plant("loose.2", owner(process.pid, "loose"));
	const unowned = plant("unowned.3", null);
	const old = new Date("2026-10-01T00:00:00Z");
	utimesSync(unowned, old, old);
	utimesSync(join(unowned, "work.txt"), old, old);
	const mismatched = plant("mism.4", owner(59041, "mism"));
	utimesSync(mismatched, old, old);
	utimesSync(join(mismatched, "work.txt"), old, old);
	utimesSync(join(mismatched, ".owner"), old, old);
	expect(releaseScratch(binned, home, applyDeps(home), { bin: "throwaway" }).ok).toBe(true);
	expect(releaseScratch(loose, home, applyDeps(home)).ok).toBe(true);

	const result = applyScratch(home, applyDeps(home));
	const byLabel = Object.fromEntries(result.gapReport.rows.map((row) => [row.label, row]));
	expect(Object.keys(byLabel).sort()).toEqual(["chief", "loose", "mism", "pidonly", "unowned.3", "worker"]);
	expect(byLabel.pidonly).toMatchObject({ class: "pid-keyed-owner-never-released", agent: null, role: "UNKNOWN", bin: "unbinned", guard: "ompkit-774u.9.3", action: "REAP" });
	expect(byLabel.chief).toMatchObject({ class: "never-released", agent: "ChiefOne", session: SESSION_A, role: "chief", bin: "unbinned", guard: "ompkit-774u.15" });
	expect(byLabel.worker).toMatchObject({ class: "never-released", agent: "WorkerOne", role: "UNKNOWN", bin: "throwaway" });
	expect(byLabel.loose).toMatchObject({ class: "released-unbinned", action: "QUARANTINE", guard: "ompkit-774u.15" });
	expect(byLabel["unowned.3"]).toMatchObject({ class: "unowned", agent: null, guard: "NO GUARD: file one", action: "QUARANTINE" });
	expect(byLabel.mism).toMatchObject({ class: "mismatched-owner", action: "QUARANTINE", guard: "NO GUARD: file one" });
	expect(byLabel.binned).toBeUndefined();
	expect(result.gapReport.by_agent).toEqual({ UNKNOWN: 4, ChiefOne: 1, WorkerOne: 1 });
	expect(result.gapReport.by_class["never-released"]).toMatchObject({ count: 2, guard: "ompkit-774u.15" });
	expect(result.gapReport.by_class.unowned).toMatchObject({ count: 1, guard: "NO GUARD: file one" });
	expect(result.gapReport.rows.every((row) => row.bytes > 0)).toBe(true);
	// The same rows are in the reap log, one gap event per reclaimed dir.
	const events = readFileSync(reapLogPath(home), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { event: string; class?: string });
	expect(events.filter((event) => event.event === "gap").map((event) => event.class).sort()).toEqual(result.gapReport.rows.map((row) => row.class).sort());
});

test("with no seat map the role is UNKNOWN, never guessed from the agent name; a quiet run has an empty report", () => {
	const { home, plant } = world();
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = join(home, "absent.json");
	plant("chief.59021", owner(59021, "chief", `agent=ChiefOne\nsession=${SESSION_A}\n`));
	const result = applyScratch(home, applyDeps(home));
	expect(result.gapReport.rows).toMatchObject([{ agent: "ChiefOne", role: "UNKNOWN" }]);
	expect(applyScratch(home, applyDeps(home)).gapReport).toEqual({ rows: [], by_agent: {}, by_class: {} });
});

test("only reaped and quarantined dirs are gaps: live, skipped and held dirs never appear", () => {
	const verdicts = [
		{ dir: "/x/live.1", action: "LIVE" as const, reason: "owner-alive", owner: null, sizeBytes: 10 },
		{ dir: "/x/skip.2", action: "SKIP" as const, reason: "owner-seat-liveness-unproven", owner: null, sizeBytes: 10 },
		{ dir: "/x/gone.3", action: "REAP" as const, reason: "owner-dead-no-open-fds", owner: null, sizeBytes: 10 },
	];
	const home = mkdtempSync(join(scratchParent, "gap-pure-"));
	cleanup.push(home);
	const report = scratchGapReport(verdicts, Date.parse("2026-10-18T00:00:00Z"), home);
	expect(report.rows.map((row) => row.dir)).toEqual(["/x/gone.3"]);
	expect(report.rows[0]).toMatchObject({ class: "unowned", label: "gone.3", age_s: null });
});
