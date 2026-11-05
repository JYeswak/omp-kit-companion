// PYCACHE1 (ompkit-fp72.120.16.249): fixture python3 processes share one per-checkout bytecode cache instead of
// recompiling every import under each fixture's fresh HOME. Python's own -v trace names every bytecode file it
// writes ("# created '<pyc>'") or loads ("# code object from '<pyc>'"), so each case judges its own run only,
// however many concurrent tests share the cache.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { FIXTURE_PYCACHE_PREFIX, fixturePycachePrefix } from "./lib/fixture-pycache.ts";

afterAll(cleanupAllOwnedTmp);

const decoder = new TextDecoder();
const root = realpathSync(ownedTmp("pycache1").path);
const source = join(root, "src");
mkdirSync(source);
writeFileSync(join(source, "pycache1_probe.py"), "VALUE = 1\n");
const python = Bun.which("python3");
if (!python) throw new Error("python3 is a precondition of PYCACHE1");
const importProbe = [python, "-v", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(source)}); import pycache1_probe`];

const freshHome = (name: string) => { const home = join(root, name); mkdirSync(home); return home; };
const pycFiles = (dir: string): string[] => existsSync(dir)
	? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".pyc"))
	: [];
// Python's -v lines for bytecode files it created or loaded, by path.
const trace = (stderr: Uint8Array) => {
	const lines = decoder.decode(stderr).split("\n");
	// Python quotes each path with repr(): "# created '/a/b.pyc'".
	const paths = (marker: string) => lines.filter(line => line.startsWith(`${marker}'`) && line.endsWith("'"))
		.map(line => line.slice(marker.length + 1, -1));
	return { created: paths("# created "), loaded: paths("# code object from ") };
};
const probe = (paths: string[]) => paths.filter(path => path.includes("pycache1_probe"));

test("PYCACHE1 planted: a fresh-HOME fixture python3 writes no .pyc under HOME; its bytecode goes to the shared prefix", () => {
	const home = freshHome("home-planted");
	// runFixture is the shared builder: an explicit env without a prefix gets the checkout's cache.
	const result = runFixture(importProbe, { cwd: root, env: { PATH: process.env.PATH, HOME: home }, label: "pycache1-planted" });
	expect(result.rc, decoder.decode(result.stderr).slice(-2000)).toBe(0);
	const { created } = trace(result.stderr);
	expect(pycFiles(home)).toEqual([]);
	expect(created.filter(path => path.startsWith(home))).toEqual([]);
	expect(probe(created).length).toBe(1);
	expect(probe(created)[0]!.startsWith(FIXTURE_PYCACHE_PREFIX)).toBe(true);
});

test("PYCACHE1 second run: another fresh HOME reuses the shared prefix and writes no new .pyc", () => {
	const first = runFixture(importProbe, { cwd: root, env: { PATH: process.env.PATH, HOME: freshHome("home-first") }, label: "pycache1-first" });
	expect(first.rc).toBe(0);
	const home = freshHome("home-second");
	const second = runFixture(importProbe, { cwd: root, env: { PATH: process.env.PATH, HOME: home }, label: "pycache1-second" });
	expect(second.rc).toBe(0);
	const { created, loaded } = trace(second.stderr);
	expect(created).toEqual([]);
	expect(probe(loaded).length).toBe(1);
	expect(probe(loaded)[0]!.startsWith(FIXTURE_PYCACHE_PREFIX)).toBe(true);
	expect(pycFiles(home)).toEqual([]);
});

test("PYCACHE1 mutant: without the prefix, a fresh-HOME python3 recompiles its imports outside the shared cache", async () => {
	const home = freshHome("home-mutant");
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
	// The interpreter's own default: Apple's python3 derives its prefix from HOME, other builds have none.
	const defaultPrefix = decoder.decode((await run([python, "-c", "import sys; print(sys.pycache_prefix or '')"],
		{ cwd: root, env, deadline_s: fixtureDeadlineS(30) })).stdout).trim();
	const result = await run(importProbe, { cwd: root, env, deadline_s: fixtureDeadlineS(30) });
	expect(result.rc).toBe(0);
	const { created } = trace(result.stderr);
	expect(probe(created).length).toBe(1);
	expect(created.filter(path => path.startsWith(FIXTURE_PYCACHE_PREFIX))).toEqual([]);
	if (defaultPrefix.startsWith(home)) {
		expect(pycFiles(home).length).toBeGreaterThan(0);
		expect(created.every(path => path.startsWith(home))).toBe(true);
	} else {
		expect(probe(created)[0]!.startsWith(join(source, "__pycache__"))).toBe(true);
	}
});

test("PYCACHE1 control: an explicit caller prefix and the host environment are left alone", () => {
	const explicit = join(root, "caller-prefix");
	const callerEnv = { PATH: process.env.PATH, HOME: freshHome("home-control"), PYTHONPYCACHEPREFIX: explicit };
	expect(fixturePycachePrefix(callerEnv)).toBe(explicit);
	const result = runFixture(importProbe, { cwd: root, env: callerEnv, label: "pycache1-control" });
	expect(result.rc).toBe(0);
	expect(callerEnv.PYTHONPYCACHEPREFIX).toBe(explicit);
	expect(probe(trace(result.stderr).created)[0]!.startsWith(explicit)).toBe(true);
	// The shared cache is this checkout's gitignored var/, never the operator's HOME or /tmp.
	expect(FIXTURE_PYCACHE_PREFIX).toBe(join(resolve(import.meta.dir, "../.."), "var", "pycache"));
	expect(FIXTURE_PYCACHE_PREFIX.startsWith(homedir() + "/Library")).toBe(false);
	// No fixture run here wrote this test's probe into the operator's own Apple bytecode cache.
	expect(existsSync(join(homedir(), "Library", "Caches", "com.apple.python", source))).toBe(false);
});
