import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { readProfileWiring, runIntegrations } from "../../src/integrations.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = ownedTmp("extbound", { root: resolve(import.meta.dir, "../../var/agent-tmp") }).path;
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(home, ".omp/profiles/proof/agent");
	fs.mkdirSync(agentDir, { recursive: true });
	const configure = (entries: string[]) => fs.writeFileSync(join(agentDir, "config.yml"),
		`extensions:\n${entries.map(entry => `  - ${entry}\n`).join("")}`);
	const extension = (path: string) => {
		fs.mkdirSync(dirname(path), { recursive: true });
		fs.writeFileSync(path, "// controlled extension source\nexport default function extension() {}\n");
		return path;
	};
	return { root, home, agentDir, configure, extension };
}

test("extension containment preserves profile, global, plugin, absolute and contained symlink wiring", () => {
	const f = fixture();
	const profile = f.extension(join(f.agentDir, "extensions/dcg-tool-bridge.ts"));
	const global = f.extension(join(f.home, ".omp/agent/extensions/slb-guard-fail-closed.ts"));
	const plugin = f.extension(join(f.home, ".omp/plugins/kit/extensions/kit-guard-optin.ts"));
	const alias = join(f.agentDir, "extensions/rch-mutator.ts");
	fs.symlinkSync(profile, alias);
	f.configure(["extensions/dcg-tool-bridge.ts", `~/${relative(f.home, global)}`, relative(f.agentDir, plugin), alias]);
	const wiring = readProfileWiring(f.home, "proof");
	expect(wiring.extensionPaths).toEqual([profile, global, plugin, alias]);
	expect(wiring.extensions).toEqual(["dcg-tool-bridge.ts", "slb-guard-fail-closed.ts", "kit-guard-optin.ts", "rch-mutator.ts"]);
	expect(wiring.hasKitGuard).toBe(true);
	expect(wiring.hooks).toEqual([]);
});

test("MR9 finite traversal transformations refuse the first .. outside HOME and absolute sibling-prefix boundary", () => {
	const f = fixture();
	const sentinel = f.extension(join(f.root, "outside/dcg-tool-bridge.ts"));
	// Four parents reach HOME; the fifth is the first parent outside it.
	const witness = "../../../../../outside/dcg-tool-bridge.ts";
	expect(resolve(f.agentDir, witness)).toBe(sentinel);
	const outsideSibling = f.extension(join(`${f.home}-sibling`, "dcg-tool-bridge.ts"));
	const entries = [witness, sentinel, outsideSibling, `~/../outside/dcg-tool-bridge.ts`];
	// Finite MR9, not fast-check: add normalized-away segments without changing the target.
	for (const padding of ["", "./", "segment/../", "one/../two/../"]) {
		entries.push(`${padding}${witness}`);
	}
	for (const entry of entries) {
		f.configure([entry]);
		expect(() => readProfileWiring(f.home, "proof"), entry).toThrow(expect.objectContaining({ code: "INVALID_EXTENSION_PATH" }));
	}
});

test("extension containment refuses escaping file and ancestor symlinks and ambiguous dangling links", () => {
	const f = fixture();
	const sentinel = f.extension(join(f.root, "outside/dcg-tool-bridge.ts"));
	const fileAlias = join(f.agentDir, "dcg-tool-bridge.ts");
	fs.symlinkSync(sentinel, fileAlias);
	const dirAlias = join(f.agentDir, "linked-extensions");
	fs.symlinkSync(dirname(sentinel), dirAlias, "dir");
	const dangling = join(f.agentDir, "dangling.ts");
	fs.symlinkSync(join(f.home, "missing.ts"), dangling);
	const loop = join(f.agentDir, "loop.ts");
	fs.symlinkSync(loop, loop);
	for (const entry of [fileAlias, join(dirAlias, "dcg-tool-bridge.ts"), dangling, loop]) {
		f.configure([entry]);
		expect(() => readProfileWiring(f.home, "proof"), entry).toThrow(expect.objectContaining({ code: "INVALID_EXTENSION_PATH" }));
	}
});

test("extension paths are filesystem strings, not URL-decoded paths, and missing contained sources remain representable", () => {
	const f = fixture();
	const literal = f.extension(join(f.agentDir, "%2e%2e/%2e%2e/dcg-tool-bridge.ts"));
	f.configure(["%2e%2e/%2e%2e/dcg-tool-bridge.ts", "extensions/missing.ts"]);
	expect(readProfileWiring(f.home, "proof").extensionPaths).toEqual([literal, join(f.agentDir, "extensions/missing.ts")]);
	const aliasHome = join(f.root, "home-alias");
	fs.symlinkSync(f.home, aliasHome, "dir");
	expect(readProfileWiring(aliasHome, "proof").extensionPaths).toEqual([
		join(aliasHome, ".omp/profiles/proof/agent/%2e%2e/%2e%2e/dcg-tool-bridge.ts"),
		join(aliasHome, ".omp/profiles/proof/agent/extensions/missing.ts"),
	]);
});

test("real public integration caller retains legitimate source evidence and never reads an outside sentinel", async () => {
	const f = fixture();
	const source = f.extension(join(f.agentDir, "extensions/dcg-tool-bridge.ts"));
	const sentinel = f.extension(join(f.root, "outside/dcg-tool-bridge.ts"));
	const scenarios = join(f.root, "tests/live/integrations.json");
	fs.mkdirSync(dirname(scenarios), { recursive: true });
	// No fire scenario: exercise source collection without launching an extension.
	fs.writeFileSync(scenarios, JSON.stringify({ scenarios: [] }));
	const omp = resolveOmpIdentity(process.env);
	const input = { root: f.root, home: f.home, profiles: ["proof"], integrations: ["dcg"],
		workDir: join(f.root, "work"), ompPath: omp.launcher };
	f.configure([source]);
	const report = await runIntegrations(input);
	expect(report.matrix[0]?.evidence).toContain(source);
	expect(report.matrix[0]?.detail).toBe("no fire scenario defined");
	expect(report.realOmpIntegrity.unchanged).toBe(true);

	f.configure([relative(f.agentDir, sentinel)]);
	// Observe actual fs calls; delegate all reads rather than replacing file contents.
	const read = fs.readFileSync;
	const observed = spyOn(fs, "readFileSync").mockImplementation(read);
	try {
		await expect(runIntegrations(input)).rejects.toMatchObject({ code: "INVALID_EXTENSION_PATH" });
		expect(observed.mock.calls.some(args => String(args[0]) === sentinel)).toBe(false);
	} finally {
		observed.mockRestore();
	}
});

afterAll(() => cleanupAllOwnedTmp());
