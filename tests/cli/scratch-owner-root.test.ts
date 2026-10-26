import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyReap, applyUnowned, inspectOne, type InspectDeps } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const owned: string[] = [];
const savedState = process.env.XDG_STATE_HOME;
const savedTmp = process.env.TMPDIR;
afterEach(() => {
	for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
	if (savedState === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedState;
	if (savedTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmp;
});

function fixture(repoKind: "matching" | "foreign" | "relative", runtime = false) {
	const base = ownedTmp("owner-root", { root: resolve(import.meta.dir, "../../var/agent-tmp") }).path;
	owned.push(base);
	process.env.XDG_STATE_HOME = join(base, "state");
	const repo = join(base, "project");
	const foreign = join(base, "other-project");
	const root = runtime ? join(base, "private-temp") : join(repo, "var", "agent-tmp");
	const label = runtime ? "omp-kit-work" : "work";
	const dir = join(root, runtime ? "omp-kit-work.fixture" : "work.999999");
	mkdirSync(repo, { recursive: true });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (runtime) process.env.TMPDIR = root;
	mkdirSync(foreign);
	const owner = {
		pid: 999999, process_start: "Thu Jan  1 00:00:00 1970", label,
		repo: repoKind === "matching" ? repo : repoKind === "foreign" ? foreign : "project",
		created_at: "2026-10-01T00:00:00Z", argv0: "owned-fixture",
	};
	writeFileSync(join(dir, ".owner"), JSON.stringify(owner), { mode: 0o600 });
	writeFileSync(join(dir, "payload"), "preserve foreign and unresolved owners\n");
	const deps: InspectDeps = {
		// No such pid: the kitlib proc incarnation probe is planted dead to match (ompkit-5m6ej).
		liveness: { processStart: () => null,
			probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) },
		run: () => ({ code: 1, stdout: "", stderr: "" }),
	};
	return { base, root, dir, owner, deps };
}

test("dead descriptor-free owner from another repository is not a cleanup candidate", () => {
	const f = fixture("foreign");
	const verdict = inspectOne(f.dir, f.root, f.deps);
	expect(verdict?.action).toBe("SKIP");
	expect(readFileSync(join(f.dir, "payload"), "utf8")).toBe("preserve foreign and unresolved owners\n");
});

test("relative repository names cannot acquire cleanup authority from the current cwd", () => {
	const f = fixture("relative");
	expect(inspectOne(f.dir, f.root, f.deps)?.action).toBe("SKIP");
});

test("matching absolute repository retains the dead descriptor-free cleanup verdict", () => {
	const f = fixture("matching");
	expect(inspectOne(f.dir, f.root, f.deps)?.action).toBe("REAP");
});

test("matching repository can still reap its owned fixture through the quarantine recheck", () => {
	const f = fixture("matching");
	const verdict = inspectOne(f.dir, f.root, f.deps);
	if (!verdict) throw new Error("owned fixture was not inspected");
	const result = applyReap(f.dir, f.root, verdict, { ...f.deps, home: f.base });
	expect(result.action).toBe("REAP");
	expect(existsSync(f.dir)).toBe(false);
});

test("apply cannot delete a foreign owner even when handed a reap verdict", () => {
	const f = fixture("foreign");
	const before = readFileSync(join(f.dir, ".owner"), "utf8");
	const result = applyReap(f.dir, f.root, { dir: f.dir, sizeBytes: 0, action: "REAP", reason: "owner-dead-no-open-fds", owner: {
		pid: f.owner.pid, processStart: f.owner.process_start, label: f.owner.label,
		repo: f.owner.repo, createdAt: f.owner.created_at, argv0: f.owner.argv0,
		agent: null, session: null, bin: null, purpose: null, bead: null, expires: null, budget: null, capabilitySha256: null,
	} }, { ...f.deps, home: f.base });
	expect(result.action).toBe("SKIP");
	expect(existsSync(f.dir)).toBe(true);
	expect(readFileSync(join(f.dir, ".owner"), "utf8")).toBe(before);
	expect(readFileSync(join(f.dir, "payload"), "utf8")).toBe("preserve foreign and unresolved owners\n");
});

test("private runtime work outside repository scratch needs the native caller's exact release root", () => {
	const f = fixture("matching", true);
	const deps = { ...f.deps, runtimeRepo: f.owner.repo };
	expect(inspectOne(f.dir, f.root, deps)?.action).toBe("REAP");
	expect(inspectOne(f.dir, f.root, f.deps)?.action).toBe("SKIP");
	expect(inspectOne(f.dir, f.root, { ...deps, runtimeRepo: join(f.base, "other-project") })?.action).toBe("SKIP");
	const verdict = inspectOne(f.dir, f.root, deps);
	if (!verdict) throw new Error("runtime fixture was not inspected");
	expect(applyReap(f.dir, f.root, verdict, { ...deps, home: f.base }).action).toBe("REAP");
	expect(existsSync(f.dir)).toBe(false);
});

test("a runtime-shaped directory is not sufficient authority without private ownership modes", () => {
	const f = fixture("matching", true);
	const deps = { ...f.deps, runtimeRepo: f.owner.repo };
	chmodSync(f.dir, 0o755);
	expect(inspectOne(f.dir, f.root, deps)?.action).toBe("SKIP");
});

test("a foreign owner substituted after a reap plan is not moved, regardless of its directory suffix", () => {
	const f = fixture("matching");
	const dir = join(f.root, "renamed-without-owner-pid");
	renameSync(f.dir, dir);
	const old = new Date(0);
	for (const path of [join(dir, ".owner"), join(dir, "payload"), dir]) utimesSync(path, old, old);
	const planned = inspectOne(dir, f.root, f.deps);
	expect(planned?.action).toBe("REAP");
	if (planned === null || planned.action !== "REAP") throw new Error("matching dead owner was not planned for reap");
	f.owner.repo = join(f.base, "other-project");
	const replacement = JSON.stringify(f.owner);
	writeFileSync(join(dir, ".owner"), replacement);
	for (const path of [join(dir, ".owner"), dir]) utimesSync(path, old, old);
	const result = applyReap(dir, f.root, planned, { ...f.deps, home: f.base });
	expect(result.action).toBe("SKIP");
	expect(existsSync(dir)).toBe(true);
	expect(readFileSync(join(dir, ".owner"), "utf8")).toBe(replacement);
});

test("an owner appearing after an unowned quarantine plan is not adopted", () => {
	const f = fixture("matching");
	const ownerPath = join(f.dir, ".owner");
	rmSync(ownerPath);
	const old = new Date(0);
	for (const path of [join(f.dir, "payload"), f.dir]) utimesSync(path, old, old);
	const planned = inspectOne(f.dir, f.root, f.deps);
	expect(planned?.action).toBe("QUARANTINE");
	writeFileSync(ownerPath, JSON.stringify(f.owner));
	for (const path of [ownerPath, f.dir]) utimesSync(path, old, old);
	expect(applyUnowned(f.dir, f.root, { ...f.deps, home: f.base }, planned ?? undefined).action).toBe("SKIP");
	expect(existsSync(f.dir)).toBe(true);
});
