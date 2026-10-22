// ompkit-774u.9.4 ROOTS1: scratch roots come from the fleet's repos, not only a ~/Developer glob. A repo that
// fleet-watch.json names outside ~/Developer is inspected, its source is recorded, a symlink alias and its target
// are one root, and a stock user without fleet-watch.json gets exactly the earlier roots.
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { defaultLiveness, fleetTestTmpBase, planScratch, resolveScratchRootEntries, resolveScratchRoots } from "../../src/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchParent = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const cleanup: string[] = [];
const saved = { roots: process.env.OMP_KIT_SCRATCH_ROOTS, tmp: process.env.TMPDIR, watch: process.env.OMP_KIT_FLEET_WATCH_CONFIG, state: process.env.XDG_STATE_HOME };
afterEach(() => {
	for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const [key, value] of [["OMP_KIT_SCRATCH_ROOTS", saved.roots], ["TMPDIR", saved.tmp], ["OMP_KIT_FLEET_WATCH_CONFIG", saved.watch], ["XDG_STATE_HOME", saved.state]] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A fresh owned dir under the repo's scratch parent, by real path; callers push it (or its child's parent) to cleanup. */
const fixtureDir = (label: string): string => realpathSync(ownedTmp(label, { root: scratchParent }).path);

/** A fixture HOME and an empty TMPDIR so only fixture roots, the fleet test base and the real /tmp omp-* dirs can appear. */
function fixtureHome(): string {
	const home = fixtureDir("roots-home");
	cleanup.push(home);
	const tmp = fixtureDir("roots-tmp");
	cleanup.push(tmp);
	delete process.env.OMP_KIT_SCRATCH_ROOTS;
	delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
	process.env.TMPDIR = tmp;
	return home;
}
function repoWithScratch(parent: string, name: string): string {
	const repo = join(parent, name);
	mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
	return repo;
}
function writeWatch(home: string, config: unknown): string {
	const path = join(home, ".config", "omp-kit", "fleet-watch.json");
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
	return path;
}
const entryFor = (home: string, root: string) => resolveScratchRootEntries(home).find((entry) => entry.root === root);

/** The earlier resolver, verbatim, as the oracle for stock-runner parity. */
function earlierRoots(home: string): string[] {
	const roots: string[] = [];
	const dev = join(home, "Developer");
	let projects: string[] = [];
	try { projects = readdirSync(dev); } catch { projects = []; }
	const isLink = (path: string) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
	for (const project of projects) {
		const candidate = join(dev, project, "var", "agent-tmp");
		try {
			if (statSync(candidate).isDirectory() && !isLink(candidate) && !isLink(join(dev, project, "var")) && !isLink(join(dev, project))) roots.push(candidate);
		} catch { continue; }
	}
	try { if (statSync(fleetTestTmpBase()).isDirectory() && !isLink(fleetTestTmpBase())) roots.push(fleetTestTmpBase()); } catch { /* absent */ }
	const tmpdir = process.env.TMPDIR ?? "/tmp";
	for (const base of [tmpdir, "/tmp"]) {
		let entries: string[] = [];
		try { entries = readdirSync(base); } catch { continue; }
		for (const entry of entries) {
			if (!entry.startsWith("omp-")) continue;
			const candidate = join(base, entry);
			try { if (statSync(candidate).isDirectory() && !isLink(candidate)) roots.push(candidate); } catch { continue; }
		}
	}
	return [...new Set(roots)];
}

test("a fleet-watch repo outside ~/Developer is a scratch root, with its source recorded", () => {
	const home = fixtureHome();
	const outside = repoWithScratch(fixtureDir("roots-outside"), "claude-config");
	cleanup.push(join(outside, ".."));
	const root = join(outside, "var", "agent-tmp");
	// Without the fleet source the repo is invisible.
	expect(entryFor(home, root)).toBeUndefined();
	writeWatch(home, { sessions: [{ session: "omp-test", repo: outside }], herdr: [{ session: "skill-library-growth", repo: outside }], chief: { session: "omp-chief", repo: outside } });
	expect(entryFor(home, root)).toEqual({ root, sources: ["fleet-watch:omp-test", "herdr:skill-library-growth", "chief"] });
	expect(resolveScratchRoots(home)).toContain(root);
	// Planted negative: remove the source and the root disappears again.
	rmSync(join(home, ".config", "omp-kit", "fleet-watch.json"));
	expect(entryFor(home, root)).toBeUndefined();
	expect(resolveScratchRoots(home)).not.toContain(root);
});

test("scratch plan reports the fleet-watch root with its source in rootMetrics", () => {
	const home = fixtureHome();
	process.env.XDG_STATE_HOME = join(home, "state");
	mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
	const outside = repoWithScratch(fixtureDir("roots-plan"), "elsewhere");
	cleanup.push(join(outside, ".."));
	const root = join(outside, "var", "agent-tmp");
	writeWatch(home, { sessions: [{ session: "omp-test", repo: outside }] });
	const plan = planScratch(home, { liveness: defaultLiveness(), run: () => ({ code: 1, stdout: "", stderr: "" }), statfs: () => ({ bavail: 500, blocks: 1000 }) });
	expect(plan.roots).toContain(root);
	expect(plan.rootMetrics.find((metric) => metric.root === root)).toMatchObject({ root, sources: ["fleet-watch:omp-test"] });
	// Every root in the report names where it came from.
	for (const metric of plan.rootMetrics) expect({ root: metric.root, named: metric.sources.length > 0 }).toEqual({ root: metric.root, named: true });
});

test("the real CLI scratch plan lists the fleet-watch root and its source", () => {
	const home = fixtureHome();
	const outside = repoWithScratch(fixtureDir("roots-cli"), "elsewhere");
	cleanup.push(join(outside, ".."));
	const root = join(outside, "var", "agent-tmp");
	writeWatch(home, { sessions: [{ session: "omp-test", repo: outside }] });
	const run = Bun.spawnSync(["bun", "--no-env-file", "run", join(repoRoot, "src", "cli.ts"), "scratch", "plan", "--json"], {
		cwd: repoRoot, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, "state"), TMPDIR: process.env.TMPDIR!, OMP_KIT_SCRATCH_ROOTS: "" },
	});
	expect(run.exitCode).toBe(0);
	const envelope = JSON.parse(run.stdout.toString()) as { data: { roots: string[]; rootMetrics: { root: string; sources: string[] }[] } };
	expect(envelope.data.roots).toContain(root);
	expect(envelope.data.rootMetrics.find((metric) => metric.root === root)?.sources).toEqual(["fleet-watch:omp-test"]);
});

test("a symlink alias and its real path are one root, whichever way each is named", () => {
	const home = fixtureHome();
	const real = repoWithScratch(join(home, "Developer"), "real-repo");
	const aliasParent = fixtureDir("roots-alias");
	cleanup.push(aliasParent);
	const alias = join(aliasParent, "alias-repo");
	symlinkSync(real, alias);
	const root = join(real, "var", "agent-tmp");
	// ~/Developer names the real path; fleet-watch names the alias and the real path: one root, both sources.
	writeWatch(home, { sessions: [{ session: "a", repo: alias }, { session: "b", repo: real }] });
	const matches = resolveScratchRootEntries(home).filter((entry) => { try { return realpathSync(entry.root) === root; } catch { return false; } });
	expect(matches).toEqual([{ root, sources: ["developer", "fleet-watch:a", "fleet-watch:b"] }]);
	// An alias alone, outside ~/Developer, resolves to the target's root.
	const only = fixtureHome();
	const target = repoWithScratch(fixtureDir("roots-target"), "target");
	cleanup.push(join(target, ".."));
	const link = join(aliasParent, "only-alias");
	symlinkSync(target, link);
	writeWatch(only, { sessions: [{ session: "alias-only", repo: link }] });
	expect(entryFor(only, join(target, "var", "agent-tmp"))).toEqual({ root: join(target, "var", "agent-tmp"), sources: ["fleet-watch:alias-only"] });
});

test("without fleet-watch.json the roots equal the earlier list exactly, in order", () => {
	const home = fixtureHome();
	repoWithScratch(join(home, "Developer"), "alpha");
	repoWithScratch(join(home, "Developer"), "beta");
	const linkTarget = repoWithScratch(fixtureDir("roots-link"), "linked");
	cleanup.push(join(linkTarget, ".."));
	symlinkSync(linkTarget, join(home, "Developer", "linkproj"));
	mkdirSync(join(process.env.TMPDIR!, "omp-work-1"));
	expect(resolveScratchRoots(home)).toEqual(earlierRoots(home));
	expect(resolveScratchRoots(home).some((root) => root.includes("linkproj"))).toBe(false);
	expect(resolveScratchRootEntries(home).filter((entry) => entry.root.startsWith(join(home, "Developer"))).map((entry) => entry.sources)).toEqual([["developer"], ["developer"]]);
});

test("an unusable fleet-watch.json, a relative repo, a missing or symlinked scratch dir and the override change nothing", () => {
	const home = fixtureHome();
	const baseline = resolveScratchRoots(home);
	const parent = fixtureDir("roots-bad");
	cleanup.push(parent);
	const noScratch = join(parent, "no-scratch");
	mkdirSync(noScratch);
	const linked = join(parent, "linked-var");
	mkdirSync(join(linked, "real"), { recursive: true });
	// The symlinked `var` leads somewhere that really holds agent-tmp, so only the symlink check can refuse it.
	mkdirSync(join(parent, "elsewhere", "agent-tmp"), { recursive: true });
	symlinkSync(join(parent, "elsewhere"), join(linked, "var"));
	// A relative repo that resolves against the working directory (the repository root) must still be refused.
	const relativeRepo = repoWithScratch(fixtureDir("roots-relative"), "rel");
	cleanup.push(join(relativeRepo, ".."));
	const relative = relativeRepo.slice(repoRoot.length + 1);
	for (const config of ["not json", "[]", "null", { sessions: "x" }, { sessions: [{ session: "s", repo: relative }, { session: "s", repo: noScratch }, { session: "s", repo: linked }, { session: "s" }, 7, null] }]) {
		writeWatch(home, config);
		expect(resolveScratchRoots(home)).toEqual(baseline);
	}
	const real = repoWithScratch(parent, "fleet-repo");
	writeWatch(home, { sessions: [{ session: "s", repo: real }] });
	process.env.OMP_KIT_SCRATCH_ROOTS = `/a${delimiter}/b`;
	expect(resolveScratchRootEntries(home)).toEqual([{ root: "/a", sources: ["override"] }, { root: "/b", sources: ["override"] }]);
});

test("roots are de-duplicated by real path even when the home directory is named through an alias", () => {
	const home = fixtureHome();
	const real = repoWithScratch(join(home, "Developer"), "project");
	const aliasHome = join(fixtureDir("roots-home-alias"), "home-link");
	cleanup.push(join(aliasHome, ".."));
	symlinkSync(home, aliasHome);
	writeWatch(aliasHome, { sessions: [{ session: "s", repo: real }] });
	const entries = resolveScratchRootEntries(aliasHome).filter((entry) => { try { return realpathSync(entry.root) === join(real, "var", "agent-tmp"); } catch { return false; } });
	// One root, spelled through the alias the ~/Developer scan used, carrying both sources.
	expect(entries).toEqual([{ root: join(aliasHome, "Developer", "project", "var", "agent-tmp"), sources: ["developer", "fleet-watch:s"] }]);
});

test("OMP_KIT_FLEET_WATCH_CONFIG selects the config file", () => {
	const home = fixtureHome();
	const repo = repoWithScratch(fixtureDir("roots-env"), "envrepo");
	cleanup.push(join(repo, ".."));
	const path = join(home, "custom-watch.json");
	writeFileSync(path, JSON.stringify({ sessions: [{ session: "custom", repo }] }));
	process.env.OMP_KIT_FLEET_WATCH_CONFIG = path;
	expect(entryFor(home, join(repo, "var", "agent-tmp"))?.sources).toEqual(["fleet-watch:custom"]);
});
