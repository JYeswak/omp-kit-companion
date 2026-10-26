// ompkit-774u.15 SCRATCHBIN1 D: a reap or reclaim is an emergency and every one is a gap report. Each reclaimed dir that
// its owner did not bin is named with its agent, label, role, bin and the guard that should have stopped it; a dir the
// owner released into a bin is not a gap.
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyScratch, fileGapReports, filedGapDirs, reapLogPath, releaseScratch, scratchGapReport, type ApplyDeps, type LivenessDeps, type ScratchGap, type ScratchGapReport, type ScratchRunner } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const SESSION_A = "01a15012-af9e-7628-bee6-496084668412";
const SESSION_B = "01a1502a-5647-76ba-89c5-949087f3e283";
const RELEASE_AGENT = "CopperTrout";

const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, state: process.env.XDG_STATE_HOME, fleet: process.env.OMP_KIT_FLEET_WATCH_CONFIG };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["XDG_STATE_HOME", saved.state], ["OMP_KIT_FLEET_WATCH_CONFIG", saved.fleet]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
const liveness: LivenessDeps = { processStart: () => null, seatLive: () => false,
	probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
const applyDeps = (home: string): ApplyDeps => ({ home, liveness, run: () => ({ code: 1, stdout: "", stderr: "" }) });
const releaseDeps = (home: string): ApplyDeps => ({ ...applyDeps(home), callerSeat: () => ({ agent: RELEASE_AGENT, sessions: [SESSION_A], main: SESSION_A }) });

function world(): { root: string; home: string; plant: (name: string, owner: string | null) => string } {
	const root = ownedTmp("gap", { root: scratchParent }).path;
	const home = ownedTmp("gap-home", { root: scratchParent }).path;
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
const owner = (pid: number, label: string, extra = "") => `pid=${pid}\nprocess_start=Thu Jan  1 00:00:00 1970\nlabel=${label}\nrepo=${repo}\ncreated_at=2026-10-10T10:00:00Z\nargv0=test\n${extra}`;
const legacyPidOwner = (pid: number, label: string) => `pid=${pid}\nlabel=${label}\nrepo=${repo}\ncreated=2026-10-10T10:00:00Z\n`;

test("an emergency reap names, for each dir its owner left unbinned, the agent, role, bin and the guard; a binned release is not a gap", () => {
	const { home, plant } = world();
	const fleet = join(home, "fleet-watch.json");
	writeFileSync(fleet, JSON.stringify({ chief: { agent: "ChiefOne", session: "omp-chief" }, sessions: [] }));
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = fleet;
	const pidonly = plant("pidonly.59011", legacyPidOwner(59011, "pidonly"));
	plant("chief.59012", owner(59012, "chief", `agent=ChiefOne\nsession=${SESSION_A}\n`));
	plant("worker.59013", owner(59013, "worker", `agent=WorkerOne\nsession=${SESSION_B}\nbin=throwaway\n`));
	const binned = plant("binned.1", owner(process.pid, "binned", `agent=${RELEASE_AGENT}\nsession=${SESSION_A}\n`));
	const loose = plant("loose.2", owner(process.pid, "loose", `agent=${RELEASE_AGENT}\nsession=${SESSION_A}\n`));
	const unowned = plant("unowned.3", null);
	const old = new Date("2026-10-01T00:00:00Z");
	utimesSync(unowned, old, old);
	utimesSync(join(unowned, "work.txt"), old, old);
	const mismatched = plant("mism.4", owner(59041, "mism"));
	utimesSync(mismatched, old, old);
	utimesSync(join(mismatched, "work.txt"), old, old);
	utimesSync(join(mismatched, ".owner"), old, old);
	expect(releaseScratch(binned, home, releaseDeps(home), { bin: "throwaway" }).ok).toBe(true);
	expect(releaseScratch(loose, home, releaseDeps(home)).ok).toBe(true);

	const result = applyScratch(home, applyDeps(home));
	const byLabel = Object.fromEntries(result.gapReport.rows.map((row) => [row.label, row]));
	expect(Object.keys(byLabel).sort()).toEqual(["chief", "loose", "mism", "unowned.3", "worker"]);
	expect(byLabel.pidonly).toBeUndefined();
	expect(existsSync(pidonly)).toBe(true);
	expect(byLabel.chief).toMatchObject({ class: "never-released", agent: "ChiefOne", session: SESSION_A, role: "chief", bin: "unbinned", guard: "ompkit-774u.15" });
	expect(byLabel.worker).toMatchObject({ class: "never-released", agent: "WorkerOne", role: "UNKNOWN", bin: "throwaway" });
	expect(byLabel.loose).toMatchObject({ class: "released-unbinned", action: "QUARANTINE", guard: "ompkit-774u.15" });
	expect(byLabel["unowned.3"]).toMatchObject({ class: "unowned", agent: null, guard: "NO GUARD: file one", action: "QUARANTINE" });
	expect(byLabel.mism).toMatchObject({ class: "pid-keyed-owner-never-released", action: "REAP", guard: "ompkit-774u.9.3" });
	expect(result.gapReport.by_agent).toEqual({ CopperTrout: 1, UNKNOWN: 2, ChiefOne: 1, WorkerOne: 1 });
	expect(result.gapReport.by_class["never-released"]).toMatchObject({ count: 2, guard: "ompkit-774u.15" });
	expect(result.gapReport.by_class["pid-keyed-owner-never-released"]).toMatchObject({ count: 1, guard: "ompkit-774u.9.3" });
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
	const home = ownedTmp("gap-pure", { root: scratchParent }).path;
	cleanup.push(home);
	const report = scratchGapReport(verdicts, Date.parse("2026-10-18T00:00:00Z"), home);
	expect(report.rows.map((row) => row.dir)).toEqual(["/x/gone.3"]);
	expect(report.rows[0]).toMatchObject({ class: "unowned", label: "gone.3", age_s: null });
});

test("a reclaimed dir past its declared budget is marked over-budget; unbounded and fitting dirs are not", () => {
	const ownerOf = (budget: number | null) => ({ pid: 1, processStart: null, label: "x", repo: "/r",
		createdAt: "2026-10-18T00:00:00Z", argv0: null, agent: "WorkerOne", session: SESSION_A,
		bin: null, purpose: null, bead: null, expires: null, budget, capabilitySha256: null });
	const verdicts = [
		{ dir: "/x/over.1", action: "REAP" as const, reason: "owner-dead-no-open-fds", owner: ownerOf(5), sizeBytes: 100 },
		{ dir: "/x/fit.2", action: "REAP" as const, reason: "owner-dead-no-open-fds", owner: ownerOf(1000), sizeBytes: 100 },
		{ dir: "/x/free.3", action: "REAP" as const, reason: "owner-dead-no-open-fds", owner: ownerOf(null), sizeBytes: 100 },
	];
	const home = ownedTmp("gap-budget", { root: scratchParent }).path;
	cleanup.push(home);
	const report = scratchGapReport(verdicts, Date.parse("2026-10-18T00:00:00Z"), home);
	const byDir = Object.fromEntries(report.rows.map((row) => [row.dir, row]));
	expect(byDir["/x/over.1"]).toMatchObject({ overBudget: true, bytes: 100 });
	expect(byDir["/x/fit.2"]).toMatchObject({ overBudget: false });
	expect(byDir["/x/free.3"]).toMatchObject({ overBudget: false });
});

// ompkit-774u.15 AC3: a reap files each guarded gap class to its owning bead, only dirs no earlier run filed.
const gapRow = (dir: string, guard: string, cls: ScratchGap["class"] = "never-released"): ScratchGap => ({
	dir, label: dir.split("/").at(-1)!, agent: "WorkerOne", session: SESSION_A, role: "UNKNOWN",
	bin: "unbinned" as const, class: cls, reason: "owner-dead-no-open-fds", action: "REAP" as const, bytes: 10, age_s: null, guard, overBudget: false });
const gapReportOf = (rows: ScratchGap[]): ScratchGapReport => ({ rows,
	by_agent: { WorkerOne: rows.length }, by_class: {} });

test("a guarded class is filed to its bead with the new dirs, then up-to-date; unguarded classes are listed, never filed", () => {
	const { home } = world();
	const calls: string[][] = [];
	const run: ScratchRunner = (args) => { calls.push([...args]); return { code: 0, stdout: "{}", stderr: "" }; };
	const report = gapReportOf([gapRow("/x/a.1", "ompkit-774u.15"), gapRow("/x/b.2", "ompkit-774u.15"), gapRow("/x/c.3", "NO GUARD: file one", "unowned")]);
	const first = fileGapReports(home, report, { actor: "TurquoiseSummit", run });
	expect(first.filed).toMatchObject([{ bead: "ompkit-774u.15", class: "never-released", status: "filed", dirs: ["/x/a.1", "/x/b.2"] }]);
	expect(first.unfiled).toMatchObject([{ class: "unowned", count: 1, example: "/x/c.3" }]);
	expect(calls).toHaveLength(1);
	expect(calls[0]!.slice(0, 4)).toEqual(["br", "comments", "add", "ompkit-774u.15"]);
	expect(calls[0]).toContain("--actor");
	expect(calls[0]).toContain("TurquoiseSummit");
	expect(calls[0]!.join(" ")).toContain("/x/a.1");
	expect(filedGapDirs(home, "ompkit-774u.15").sort()).toEqual(["/x/a.1", "/x/b.2"]);
	// A second run with one more dir files only the delta.
	const second = fileGapReports(home, gapReportOf([gapRow("/x/a.1", "ompkit-774u.15"), gapRow("/x/d.4", "ompkit-774u.15")]), { actor: "TurquoiseSummit", run });
	expect(second.filed).toMatchObject([{ bead: "ompkit-774u.15", status: "filed", dirs: ["/x/d.4"] }]);
	expect(calls).toHaveLength(2);
	expect(calls[1]!.join(" ")).not.toContain("/x/a.1");
	// Nothing new: up-to-date, no br call.
	const third = fileGapReports(home, gapReportOf([gapRow("/x/a.1", "ompkit-774u.15")]), { actor: "TurquoiseSummit", run });
	expect(third.filed).toMatchObject([{ bead: "ompkit-774u.15", status: "up-to-date", dirs: [] }]);
	expect(calls).toHaveLength(2);
});

test("planted negatives: a br failure is reported and retried next run; an empty report files nothing", () => {
	const { home } = world();
	let code = 1;
	const calls: string[][] = [];
	const run: ScratchRunner = (args) => { calls.push([...args]); return { code, stdout: "", stderr: "locked" }; };
	const report = gapReportOf([gapRow("/x/a.1", "ompkit-774u.15")]);
	expect(fileGapReports(home, report, { actor: "TurquoiseSummit", run }).filed)
		.toMatchObject([{ bead: "ompkit-774u.15", status: "failed", dirs: ["/x/a.1"] }]);
	expect(filedGapDirs(home, "ompkit-774u.15")).toEqual([]);
	expect(calls).toHaveLength(1);
	code = 0;
	expect(fileGapReports(home, report, { actor: "TurquoiseSummit", run }).filed)
		.toMatchObject([{ bead: "ompkit-774u.15", status: "filed", dirs: ["/x/a.1"] }]);
	expect(calls).toHaveLength(2);
	expect(fileGapReports(home, gapReportOf([]), { actor: "TurquoiseSummit", run }).filed).toEqual([]);
	expect(calls).toHaveLength(2);
});

test("a long class is cut at 15 dirs with a count in the filed comment", () => {
	const { home } = world();
	const calls: string[][] = [];
	const run: ScratchRunner = (args) => { calls.push([...args]); return { code: 0, stdout: "{}", stderr: "" }; };
	const rows: ScratchGap[] = Array.from({ length: 20 }, (_, index) => gapRow(`/x/d.${index}`, "ompkit-774u.15"));
	const result = fileGapReports(home, gapReportOf(rows), { actor: "TurquoiseSummit", run });
	expect(result.filed).toMatchObject([{ status: "filed", dirs: rows.map((row) => row.dir) }]);
	const text = calls[0]!.join("\n");
	expect(text).toContain("/x/d.0");
	expect(text).toContain("/x/d.14");
	expect(text).not.toContain("/x/d.15");
	expect(text).toContain("and 5 more");
});
