import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { applyMigration, planMigration, planMigrationMutation, unifiedDiff } from "../../src/migrate.ts";
import { ensureOmpSource } from "../../src/omp-source-cache.ts";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);
const repoRoot = resolve(import.meta.dir, "../..");
const entry = join(repoRoot, "src/cli.ts");
const repoRules = join(repoRoot, "rules");
const fixtures: string[] = [];
let OMP_BIN_DIR = "";
let OMP_SOURCE_CACHE = "";
let KIT_ROOT = "";
let KIT_BIN = "";

function certifiedOmpVersion(): string {
	const value: unknown = JSON.parse(readFileSync(join(resolve(import.meta.dir, "../.."), "scripts/omp-compat.json"), "utf8"));
	if (!value || typeof value !== "object" || !("certified" in value) || typeof value.certified !== "string") {
		throw new Error("scripts/omp-compat.json must contain a certified OMP version");
	}
	return value.certified;
}

/**
 * The release root migrate reads. MANIFEST.tsv is packaging output (untracked), so a gate archive with no
 * commit builds pack `uncommitted-<date>`, which migrate correctly refuses as SOURCE_INVALID. The fixture
 * therefore owns its provenance: the repo's rules committed to a fixture git repo, its MANIFEST.tsv written
 * by the real build-manifest.sh (pack = that commit), and the CLI compiled into its bin/ so the release root
 * is this fixture in a checkout and in a history-less archive alike.
 */
async function stageKitRelease(ompSrc: string): Promise<void> {
	const base = ownedTmp("migrate-kit", { root: join(repoRoot, "var/agent-tmp") }).path;
	KIT_ROOT = join(base, "releases", "vMigrateTest");
	const tmp = join(base, "tmp");
	mkdirSync(tmp, { mode: 0o700 });
	mkdirSync(join(KIT_ROOT, "scripts"), { recursive: true });
	cpSync(repoRules, join(KIT_ROOT, "rules"), { recursive: true });
	for (const file of ["build-manifest.sh", "kitlib-tmp.sh", "runtime-adapter.sh", "rule-class.ts"]) {
		cpSync(join(repoRoot, "scripts", file), join(KIT_ROOT, "scripts", file));
	}
	// Inherited GIT_* (a hook's GIT_DIR) must not redirect fixture git; the ceiling stops discovery at the fixture,
	// so a missing fixture .git fails instead of reaching the enclosing checkout.
	const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
		.filter((kv): kv is [string, string] => kv[1] !== undefined && !kv[0].startsWith("GIT_")));
	Object.assign(env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: base, OMP_SRC: ompSrc, TMPDIR: tmp });
	const step = async (argv: string[], deadline_s = 120): Promise<string> => {
		const result = await run(argv, { deadline_s, cwd: KIT_ROOT, env });
		const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
		if (result.rc !== 0) throw new Error(`${argv.join(" ")} failed: rc=${result.rc} stdout=${text(result.stdout).slice(-500)} stderr=${text(result.stderr).slice(-800)}`);
		return text(result.stdout);
	};
	const git = (...args: string[]) => step(["git", "-C", KIT_ROOT, "-c", "user.email=t@t", "-c", "user.name=t",
		"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args]);
	await git("init", "-q");
	await git("add", "rules", "scripts");
	await git("commit", "-q", "-m", "migrate fixture release");
	const head = (await git("rev-parse", "--short", "HEAD")).trim();
	const manifest = await step(["sh", join(KIT_ROOT, "scripts", "build-manifest.sh"), "--stdout"]);
	const packs = new Set(manifest.trimEnd().split("\n").slice(1).map(row => row.split("\t")[3]));
	if (packs.size !== 1 || !packs.has(head)) throw new Error(`fixture manifest pack ${[...packs].join(",")} is not fixture commit ${head}`);
	writeFileSync(join(KIT_ROOT, "MANIFEST.tsv"), manifest);
	KIT_BIN = join(KIT_ROOT, "bin", "omp-kit");
	await step([process.execPath, "build", entry, "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", `--outfile=${KIT_BIN}`], 300);
}

beforeAll(async () => {
	const runtimeRoot = ownedTmp("omp-kit-migrate-omp").path;
	OMP_SOURCE_CACHE = join(runtimeRoot, "source-cache");
	const installerHome = join(runtimeRoot, "home");
	const installerTmp = join(runtimeRoot, "tmp");
	mkdirSync(installerHome, { recursive: true });
	mkdirSync(installerTmp, { recursive: true });
	const packageRoot = ensureOmpSource(certifiedOmpVersion(), {
		HOME: installerHome, TMPDIR: installerTmp, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
		OMP_KIT_OMP_SRC_CACHE: OMP_SOURCE_CACHE,
	});
	OMP_BIN_DIR = join(dirname(dirname(packageRoot)), ".bin");
	if (!existsSync(join(OMP_BIN_DIR, "omp"))) throw new Error("certified OMP package did not install its launcher");
	await stageKitRelease(join(packageRoot, "src"));
}, 600_000);
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

interface Fixture {
	home: string;
	state: string;
	pluginDir: string;
	pluginName: string;
	kitNames: string[];
}

function workspace(): string {
	// Fresh clones have no var/agent-tmp; mkdtemp below requires its parent to exist.
	// Repo scratch, not tmpdir(): /var is a symlink on macOS and the mutation
	// guards refuse symlinked path components.
	const root = ownedTmp("migrate", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	fixtures.push(root);
	return root;
}

function realOmpDir(): string {
	if (!OMP_BIN_DIR) throw new Error("certified OMP runtime is not initialized");
	return OMP_BIN_DIR;
}

function childEnv(home: string, ompDir: string): Record<string, string | undefined> {
	// Select the pinned launcher before Bun's bin directory, which can also contain a host omp.
	const bunDir = dirname(process.execPath);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home,
		XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_STATE_HOME: join(home, "xdg-state"),
		PATH: `${ompDir}:${bunDir}:/usr/bin:/bin:/usr/sbin:/sbin`, BUN_INSTALL: join(home, ".bun"),
		OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", OMP_KIT_OMP_SRC_CACHE: OMP_SOURCE_CACHE,
		OMP_KIT_OMP_SRC_FETCH: "0", NO_COLOR: "" };
	// An inherited profile makes OMP read that profile's config and rules instead of
	// the fixture HOME's (native dir especially); the lifecycle script unsets these too.
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.PI_CODING_AGENT_DIR;
	return env;
}

test("child PATH selects pinned OMP before Bun and retains Bun for the launcher shim", () => {
	const path = childEnv("/tmp/fake-home", "/tmp/fake-omp").PATH?.split(":") ?? []; // tempsafe: fake path strings fed to childEnv; nothing is created
	expect(path.slice(0, 2)).toEqual(["/tmp/fake-omp", dirname(process.execPath)]); // tempsafe: fake path strings fed to childEnv; nothing is created
});


function profileSpan<T>(span: string, run: () => T): T {
	const started = performance.now();
	try { return run(); } finally {
		const path = process.env.OMP_KIT_TEST_PROFILE_OUT;
		if (process.env.OMP_KIT_TEST_PROFILE === "1" && path) appendFileSync(path, JSON.stringify({ span, ms: performance.now() - started }) + "\n");
	}
}

async function profileSpanAsync<T>(span: string, body: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try { return await body(); } finally {
		const path = process.env.OMP_KIT_TEST_PROFILE_OUT;
		if (process.env.OMP_KIT_TEST_PROFILE === "1" && path) appendFileSync(path, JSON.stringify({ span, ms: performance.now() - started }) + "\n");
	}
}

function omp(args: string[], home: string, ompDir: string) {
	return profileSpan("omp:" + args.join(" "), () => {
	const started = Date.now();
	const child = Bun.spawnSync(["omp", ...args], {
		cwd: home, env: childEnv(home, ompDir), stdout: "pipe", stderr: "pipe",
	});
	if (child.exitCode !== 0) {
		throw new Error(`omp ${args.join(" ")} failed: exit=${child.exitCode} signal=${child.signalCode ?? "none"} elapsed_ms=${Date.now() - started} stdout=${child.stdout.toString().slice(-500)} stderr=${child.stderr.toString().slice(-500)}`);
	}
	return child.stdout.toString();
	});
}

// The compiled fixture CLI can start child processes, so it runs through kitlib run() (process group, deadline).
async function cli(args: string[], home: string, ompDir: string) {
	return profileSpanAsync("cli:" + args.join(" "), async () => {
	const env = Object.fromEntries(Object.entries(childEnv(home, ompDir)).filter((entry): entry is [string, string] => entry[1] !== undefined));
	const child = await run([KIT_BIN, ...args, "--json"], { cwd: home, env, deadline_s: 120 });
	const decoder = new TextDecoder();
	return { code: child.rc, envelope: JSON.parse(decoder.decode(child.stdout)), stderr: decoder.decode(child.stderr) };
	});
}

/** Isolated HOME with a linked fixture plugin serving copies of the repo rules. */
function pluginFixture(editCount: number): Fixture {
	const base = workspace();
	const home = join(base, "home");
	const rulesDir = join(home, ".agents", "rules");
	mkdirSync(rulesDir, { recursive: true });
	for (const dir of ["xdg-config", "xdg-state", "xdg-data", "xdg-cache", "tmp"]) mkdirSync(join(home, dir), { recursive: true });
	const kitNames = readdirSync(repoRules).filter(name => name.endsWith(".md")).map(name => name.slice(0, -3)).sort();
	const pluginDir = join(base, "plugin");
	mkdirSync(join(pluginDir, "rules"), { recursive: true });
	writeFileSync(join(pluginDir, "package.json"), JSON.stringify({ name: "test-migrate-plugin", version: "0.0.1", omp: { rules: ["rules/"] } }));
	for (const name of kitNames) writeFileSync(join(pluginDir, "rules", `${name}.md`), readFileSync(join(repoRules, `${name}.md`)));
	const edited = kitNames.slice(12, 12 + editCount).filter((name) => name !== "kit-standing-law");
	const identical = kitNames.filter((name) => !edited.includes(name));
	for (const name of identical) writeFileSync(join(rulesDir, `${name}.md`), readFileSync(join(repoRules, `${name}.md`)));
	for (const name of edited) writeFileSync(join(rulesDir, `${name}.md`), `${readFileSync(join(repoRules, `${name}.md`), "utf8")}# local edit\n`);
	omp(["plugin", "link", pluginDir], home, realOmpDir());
	return { home, state: join(home, "xdg-state"), pluginDir, pluginName: "test-migrate-plugin", kitNames };
}

function rowByName(rows: { name: string }[], name: string) {
	const row = rows.find(entry => entry.name === name);
	if (!row) throw new Error(`missing plan row for ${name}`);
	return row as { name: string; verdict: string; overlay: boolean; overlayPath: string | null; unlisted: boolean; manifestSha256: string | null; pluginSha256: string | null; pluginPath: string | null; firstDiffLine: number | null; diff: string | null };
}

test("migrate plan lists each legacy copy with its plugin equivalent and byte diff", async () => {
	const { home, kitNames } = pluginFixture(6);
	writeFileSync(join(home, ".agents", "rules", "not-a-kit-rule.md"), "unknown\n");
	const result = await cli(["migrate", "--plan"], home, realOmpDir());
	expect(result.code).toBe(0);
	expect(result.envelope.data.pluginAbsent).toBe(false);
	expect(result.envelope.data.pluginRules).toBeGreaterThan(0);
	const rows = result.envelope.data.rows;
	expect(rows).toHaveLength(kitNames.length + 1);
	for (const name of kitNames.slice(0, 12)) {
		const row = rowByName(rows, name);
		if (row.verdict === "identical-to-plugin") {
			expect(row.overlay).toBe(false);
			expect(row.pluginSha256).not.toBeNull();
		} else {
			expect(row.verdict).toBe("identical-to-manifest");
		}
	}
	const standing = rowByName(rows, "kit-standing-law");
	expect(standing.verdict).toBe("identical-to-manifest");
	expect(standing.pluginSha256).toBeNull();
	expect(standing.overlay).toBe(false);
	for (const name of kitNames.slice(12, 18).filter((entry) => entry !== "kit-standing-law")) {
		const row = rowByName(rows, name);
		expect(row.verdict).toBe("edited");
		expect(row.overlay).toBe(true);
		expect(row.firstDiffLine).not.toBeNull();
	}
	const unknown = rowByName(rows, "not-a-kit-rule");
	expect(unknown.verdict).toBe("unknown-keep");
	expect(unknown.manifestSha256).toBeNull();
// Cold omp/CLI spawns run ~1s each; this test chains several (measured 5.4s locally). Bun's 5s default kills it on loaded runners.
}, 30000);

test("migrate apply removes identical copies, keeps edited and unknown, and verifies sources", async () => {
	const { home } = pluginFixture(6);
	const result = await cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(result.code).toBe(0);
	expect(result.envelope.data.action).toBe("APPLIED");
	expect(typeof result.envelope.data.receipt_id).toBe("string");
	const removed: string[] = result.envelope.data.removed;
	expect(removed.length).toBeGreaterThan(0);
	for (const name of removed) {
		expect(existsSync(join(home, ".agents", "rules", `${name}.md`))).toBe(false);
		expect(existsSync(join(result.envelope.data.backup_dir, `${name}.md`))).toBe(true);
	}
	for (const name of result.envelope.data.kept) {
		expect(existsSync(join(home, ".agents", "rules", `${name}.md`))).toBe(true);
	}
	for (const row of result.envelope.data.verified) {
		expect(row.provider).toBe("omp-plugins");
		expect(row.path.startsWith(join(home, ".agents", "rules"))).toBe(false);
	}
	expect(result.envelope.data.verified.map((row: { name: string }) => row.name).sort()).toEqual([...removed].sort());
// Chains link, apply CLI, and per-row omp verify spawns; Bun's 5s default kills it on loaded runners.
}, 30000);

test("undo restores the removed legacy files byte-for-byte", async () => {
	const { home } = pluginFixture(0);
	const before: Record<string, string> = {};
	for (const name of readdirSync(join(home, ".agents", "rules"))) {
		before[name] = readFileSync(join(home, ".agents", "rules", name), "utf8");
	}
	const applied = await cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(applied.code).toBe(0);
	const receipt = applied.envelope.data.receipt_id;
	expect(typeof receipt).toBe("string");
	const undone = await cli(["undo", receipt, "--yes"], home, realOmpDir());
	expect(undone.code).toBe(0);
	for (const [name, bytes] of Object.entries(before)) {
		expect(readFileSync(join(home, ".agents", "rules", name), "utf8")).toBe(bytes);
	}
// Chains link, apply CLI, undo CLI, and fixture omp spawns; Bun's 5s default kills it on loaded runners.
}, 30000);

test("a file one byte off the release is never treated as identical", async () => {
	const { home, kitNames } = pluginFixture(0);
	const before = await cli(["migrate", "--plan"], home, realOmpDir());
	const target = kitNames.find(name => rowByName(before.envelope.data.rows, name).verdict === "identical-to-plugin");
	if (!target) throw new Error("fixture has no identical row to mutate");
	const path = join(home, ".agents", "rules", `${target}.md`);
	const bytes = readFileSync(path, "utf8");
	writeFileSync(path, `${bytes.slice(0, -1)}${bytes.endsWith("\n") ? "" : "\n"}`);
	const plan = await cli(["migrate", "--plan"], home, realOmpDir());
	expect(rowByName(plan.envelope.data.rows, target).verdict).toBe("edited");
// Chains link and two plan CLI spawns; Bun's 5s default kills it on loaded runners.
}, 30000);
test("a released historical copy is stale-removable, but a one-byte edit stays overlay-edited", () => {
	const { home, pluginDir } = pluginFixture(0);
	const path = join(home, ".agents", "rules", "kit-test-skip.md");
	const historical = readFileSync(resolve(import.meta.dir, "../fixtures/migrate/v0.1.0-kit-test-skip.md"));
	writeFileSync(path, historical);
	const pluginPath = join(pluginDir, "rules", "kit-test-skip.md");
	const run = () => ({ code: 0, stdout: JSON.stringify({ rules: [{ name: "kit-test-skip", path: pluginPath, provider: "omp-plugins" }] }), stderr: "" });
	const input = { root: KIT_ROOT, home, ompLauncher: "omp", run };
	const stale = planMigration(input);
	const staleRow = rowByName(stale.rows as { name: string }[], "kit-test-skip");
	expect(staleRow.verdict).toBe("stale-kit-version");
	expect(staleRow.overlay).toBe(false);
	planMigrationMutation(stale, input);
	const applied = applyMigration(stale, input, { confirmed: true });
	expect(applied.removed).toContain("kit-test-skip");
	expect(existsSync(join(applied.backupDir, "kit-test-skip.md"))).toBe(true);
	writeFileSync(path, Buffer.concat([historical, Buffer.from("x")]));
	const edited = planMigration(input);
	const editedRow = rowByName(edited.rows as { name: string }[], "kit-test-skip");
	expect(editedRow.verdict).toBe("edited");
	expect(editedRow.overlay).toBe(true);
}, 30000);

test("a symlinked rules directory is refused without touching anything", async () => {
	const { home } = pluginFixture(0);
	const linkFarm = `${home}-links`;
	mkdirSync(linkFarm, { recursive: true });
	symlinkSync(join(home, ".agents", "rules"), join(linkFarm, "rules"));
	const linkedHome = join(linkFarm, "home");
	mkdirSync(linkedHome, { recursive: true });
	symlinkSync(join(home, ".agents"), join(linkedHome, ".agents"));
	const result = await cli(["migrate", "--plan"], linkedHome, realOmpDir());
	expect(result.code).toBe(2);
	expect(result.envelope.errors[0].code).toBe("UNSAFE_PATH");
});

test("after migration, disabling the plugin reactivates no kit rule", async () => {
	const { home, kitNames, pluginName } = pluginFixture(0);
	const applied = await cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(applied.code).toBe(0);
	// kit-standing-law is never plugin-listed, so it stays as an edited keep by design.
	expect(applied.envelope.data.kept).toEqual(["kit-standing-law"]);
	omp(["plugin", "disable", pluginName], home, realOmpDir());
	const list = JSON.parse(omp(["ttsr", "list", "--json"], home, realOmpDir()));
	const items = Array.isArray(list) ? list : list.rules;
	const names = new Set(items.map((entry: { name: string }) => entry.name));
	for (const name of kitNames) {
		if (name === "kit-standing-law") continue;
		expect(names.has(name)).toBe(false);
	}
	omp(["plugin", "enable", pluginName], home, realOmpDir());
// Five cold omp/CLI spawns (link, apply, disable, ttsr list, enable) at ~1s each; measured 5.2s on CI. Bun's 5s default SIGTERMs the test mid-spawn, which surfaced as an empty-stderr enable failure.
}, 60000);

test("without an installed plugin the plan reports absence and apply refuses", async () => {
	const base = workspace();
	const home = join(base, "home");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	for (const dir of ["xdg-config", "xdg-state", "xdg-data", "xdg-cache", "tmp"]) mkdirSync(join(home, dir), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), readFileSync(join(repoRules, "kit-test-skip.md")));
	const plan = await cli(["migrate", "--plan"], home, realOmpDir());
	expect(plan.code).toBe(0);
	expect(plan.envelope.data.pluginAbsent).toBe(true);
	const applied = await cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(applied.code).toBe(2);
	expect(applied.envelope.errors[0].code).toBe("PLUGIN_ABSENT");
	expect(existsSync(join(home, ".agents", "rules", "kit-test-skip.md"))).toBe(true);
});

test("applyMigration refuses without a plugin even when called directly", () => {
	const root = ownedTmp("migrate-unit", { root: join(import.meta.dir, "../../var/agent-tmp") }).path;
	fixtures.push(root);
	const home = join(root, "home");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), readFileSync(join(repoRules, "kit-test-skip.md")));
	const input = { root: KIT_ROOT, home, ompLauncher: "/fixture/omp",
		run: (args: readonly string[]) => {
			expect(args).toEqual(["/fixture/omp", "ttsr", "list", "--json"]);
			return { code: 0, stdout: JSON.stringify({ rules: [] }), stderr: "" };
		} };
	const plan = planMigration(input);
	expect(plan.pluginAbsent).toBe(true);
	expect(() => applyMigration(plan, input, { confirmed: true })).toThrow("PLUGIN_ABSENT");
});

test("kl9p3: a manifest whose pack is uncommitted- stays SOURCE_INVALID; the same bytes with a commit pack plan", () => {
	const base = workspace();
	const root = join(base, "release");
	const home = join(base, "home");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	cpSync(join(KIT_ROOT, "rules"), join(root, "rules"), { recursive: true });
	const verified = readFileSync(join(KIT_ROOT, "MANIFEST.tsv"), "utf8");
	// What build-manifest.sh writes in an archive with no commit: identical rows, provenance unverified.
	const uncommitted = verified.split("\n").map((row, index) => index === 0 || row === "" ? row : [...row.split("\t").slice(0, 3), "uncommitted-2026-10-23"].join("\t")).join("\n");
	const input = { root, home, ompLauncher: "/fixture/omp", run: () => ({ code: 0, stdout: JSON.stringify({ rules: [] }), stderr: "" }) };
	writeFileSync(join(root, "MANIFEST.tsv"), uncommitted);
	expect(() => planMigration(input)).toThrow("SOURCE_INVALID");
	writeFileSync(join(root, "MANIFEST.tsv"), verified);
	expect(planMigration(input).pluginAbsent).toBe(true);
});

test("overlay rows carry the unified diff and the native destination", async () => {
	const { home } = pluginFixture(6);
	const result = await cli(["migrate", "--plan"], home, realOmpDir());
	expect(result.code).toBe(0);
	const edited = result.envelope.data.rows.filter((row: { verdict: string }) => row.verdict === "edited");
	expect(edited.length).toBeGreaterThan(0);
	for (const row of edited) {
		const full = rowByName(result.envelope.data.rows, row.name);
		expect(full.overlayPath).toBe(`.omp/agent/rules/${row.name}.md`);
		expect(full.diff).toContain("--- a/.agents/rules/");
		expect(full.diff).toContain("+++ b/plugin/");
		expect(full.diff).toContain("# local edit");
	}
	const identical = result.envelope.data.rows.filter((row: { verdict: string }) => row.verdict === "identical-to-plugin");
	expect(identical.length).toBeGreaterThan(0);
	for (const row of identical) {
		expect(rowByName(result.envelope.data.rows, row.name).diff).toBeNull();
	}
});

test("an installed native overlay wins over the plugin in ttsr test", () => {
	const { home } = pluginFixture(0);
	const nativeDir = join(home, ".omp", "agent", "rules");
	mkdirSync(nativeDir, { recursive: true });
	writeFileSync(join(nativeDir, "bash-pipe-exit.md"),
		"---\ncondition: OVERLAY_ONLY_XYZ\nscope: tool:bash\ninterruptMode: never\n---\nOverlay probe.\n");
	const fired = JSON.parse(omp(["ttsr", "test", "--source", "tool", "--tool", "bash", "echo OVERLAY_ONLY_XYZ", "--json"], home, realOmpDir()));
	const overlayHits = (fired.triggered ?? []).filter((entry: { name?: string }) => entry.name === "bash-pipe-exit");
	expect(overlayHits.length).toBeGreaterThan(0);
	for (const entry of overlayHits) expect(entry.sourceProvider ?? entry.provider).toBe("native");
	const shadowed = JSON.parse(omp(["ttsr", "test", "--source", "tool", "--tool", "bash", "deploy.sh | head -1; echo $?", "--json"], home, realOmpDir()));
	expect((shadowed.triggered ?? []).filter((entry: { name?: string }) => entry.name === "bash-pipe-exit")).toEqual([]);
});

test("kit-standing-law stays unlisted with and without a native overlay", async () => {
	const { home } = pluginFixture(0);
	const namesOf = (json: string): Set<string> => {
		const data = JSON.parse(json);
		const items = Array.isArray(data) ? data : data.rules;
		return new Set(items.map((entry: { name: string }) => entry.name));
	};
	const before = namesOf(omp(["ttsr", "list", "--json"], home, realOmpDir()));
	expect(before.has("kit-standing-law")).toBe(false);
	const nativeDir = join(home, ".omp", "agent", "rules");
	mkdirSync(nativeDir, { recursive: true });
	writeFileSync(join(nativeDir, "kit-standing-law.md"), readFileSync(join(repoRules, "kit-standing-law.md")));
	const after = namesOf(omp(["ttsr", "list", "--json"], home, realOmpDir()));
	expect(after.has("kit-standing-law")).toBe(false);
	const plan = await cli(["migrate", "--plan"], home, realOmpDir());
	expect(rowByName(plan.envelope.data.rows, "kit-standing-law").unlisted).toBe(true);
});

test("unifiedDiff marks changed lines with context", () => {
	const diff = unifiedDiff("a\nb\nc\nd\ne\nf\ng\n", "a\nB\nc\nd\ne\nf\ng\n", "a/old", "b/new");
	expect(diff).toContain("--- a/old");
	expect(diff).toContain("+++ b/new");
	expect(diff).toContain("-b");
	expect(diff).toContain("+B");
	expect(diff).toContain("@@ ");
	expect(unifiedDiff("same\n", "same\n", "a", "b")).toBe("--- a\n+++ b\n");
});

test("omp helper failure reports exit, signal, elapsed, and both streams", () => {
	const base = workspace();
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	let message = "";
	try {
		omp(["plugin", "enable", "no-such-plugin"], home, realOmpDir());
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("exit=1");
	expect(message).toContain("signal=");
	expect(message).toContain("elapsed_ms=");
	expect(message).toContain("stdout=");
	expect(message).toContain("not found in runtime config");
});
