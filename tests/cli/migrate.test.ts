import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { applyMigration, planMigration, unifiedDiff } from "../../src/migrate.ts";
const entry = resolve(import.meta.dir, "../../src/cli.ts");
const repoRules = resolve(import.meta.dir, "../../rules");
const fixtures: string[] = [];
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
	// Repo scratch, not tmpdir(): /var is a symlink on macOS and the mutation
	// guards refuse symlinked path components.
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "migrate-"));
	fixtures.push(root);
	return root;
}

function realOmpDir(): string {
	const launcher = Bun.which("omp");
	if (!launcher) throw new Error("real OMP is required for migrate tests");
	return dirname(launcher);
}

function childEnv(home: string, ompDir: string): Record<string, string | undefined> {
	// dirname(process.execPath): the omp launcher is a bun shim; CI minimal PATH lacks it.
	const bunDir = dirname(process.execPath);
	const env: Record<string, string | undefined> = { ...process.env, HOME: home,
		XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_STATE_HOME: join(home, "xdg-state"),
		XDG_DATA_HOME: join(home, "xdg-data"), XDG_CACHE_HOME: join(home, "xdg-cache"), TMPDIR: join(home, "tmp"),
		PATH: `${bunDir}:${ompDir}:/usr/bin:/bin:/usr/sbin:/sbin`, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", NO_COLOR: "" };
	// An inherited profile makes OMP read that profile's config and rules instead of
	// the fixture HOME's (native dir especially); the lifecycle script unsets these too.
	delete env.OMP_PROFILE;
	delete env.PI_PROFILE;
	delete env.PI_CODING_AGENT_DIR;
	return env;
}

test("child PATH carries the bun binary dir for the omp launcher shim", () => {
	const path = childEnv("/tmp/fake-home", "/tmp/fake-omp").PATH ?? "";
	expect(path.split(":")[0]).toBe(dirname(process.execPath));
});


function omp(args: string[], home: string, ompDir: string) {
	const child = Bun.spawnSync(["omp", ...args], {
		cwd: home, env: childEnv(home, ompDir), stdout: "pipe", stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(`omp ${args.join(" ")} failed: ${child.stderr.toString()}`);
	return child.stdout.toString();
}

function cli(args: string[], home: string, ompDir: string) {
	const child = Bun.spawnSync([process.execPath, entry, ...args, "--json"], {
		cwd: home, env: childEnv(home, ompDir), stdout: "pipe", stderr: "pipe",
	});
	return { code: child.exitCode, envelope: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
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
	const identical = kitNames.slice(0, 12);
	const edited = kitNames.slice(12, 12 + editCount);
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

test("migrate plan lists each legacy copy with its plugin equivalent and byte diff", () => {
	const { home, kitNames } = pluginFixture(6);
	writeFileSync(join(home, ".agents", "rules", "not-a-kit-rule.md"), "unknown\n");
	const result = cli(["migrate", "--plan"], home, realOmpDir());
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
	for (const name of kitNames.slice(12, 18)) {
		const row = rowByName(rows, name);
		expect(row.verdict).toBe("edited");
		expect(row.overlay).toBe(true);
		expect(row.firstDiffLine).not.toBeNull();
	}
	const unknown = rowByName(rows, "not-a-kit-rule");
	expect(unknown.verdict).toBe("unknown-keep");
	expect(unknown.manifestSha256).toBeNull();
});

test("migrate apply removes identical copies, keeps edited and unknown, and verifies sources", () => {
	const { home } = pluginFixture(6);
	const result = cli(["migrate", "--apply", "--yes"], home, realOmpDir());
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
});

test("undo restores the removed legacy files byte-for-byte", () => {
	const { home } = pluginFixture(0);
	const before: Record<string, string> = {};
	for (const name of readdirSync(join(home, ".agents", "rules"))) {
		before[name] = readFileSync(join(home, ".agents", "rules", name), "utf8");
	}
	const applied = cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(applied.code).toBe(0);
	const receipt = applied.envelope.data.receipt_id;
	expect(typeof receipt).toBe("string");
	const undone = cli(["undo", receipt, "--yes"], home, realOmpDir());
	expect(undone.code).toBe(0);
	for (const [name, bytes] of Object.entries(before)) {
		expect(readFileSync(join(home, ".agents", "rules", name), "utf8")).toBe(bytes);
	}
});

test("a file one byte off the release is never treated as identical", () => {
	const { home, kitNames } = pluginFixture(0);
	const target = kitNames.find(name => {
		const plan = cli(["migrate", "--plan"], home, realOmpDir());
		return rowByName(plan.envelope.data.rows, name).verdict === "identical-to-plugin";
	});
	if (!target) throw new Error("fixture has no identical row to mutate");
	const path = join(home, ".agents", "rules", `${target}.md`);
	const bytes = readFileSync(path, "utf8");
	writeFileSync(path, `${bytes.slice(0, -1)}${bytes.endsWith("\n") ? "" : "\n"}`);
	const plan = cli(["migrate", "--plan"], home, realOmpDir());
	expect(rowByName(plan.envelope.data.rows, target).verdict).toBe("edited");
});

test("a symlinked rules directory is refused without touching anything", () => {
	const { home } = pluginFixture(0);
	const linkFarm = `${home}-links`;
	mkdirSync(linkFarm, { recursive: true });
	symlinkSync(join(home, ".agents", "rules"), join(linkFarm, "rules"));
	const linkedHome = join(linkFarm, "home");
	mkdirSync(linkedHome, { recursive: true });
	symlinkSync(join(home, ".agents"), join(linkedHome, ".agents"));
	const result = cli(["migrate", "--plan"], linkedHome, realOmpDir());
	expect(result.code).toBe(2);
	expect(result.envelope.errors[0].code).toBe("UNSAFE_PATH");
});

test("after migration, disabling the plugin reactivates no kit rule", () => {
	const { home, kitNames, pluginName } = pluginFixture(0);
	const applied = cli(["migrate", "--apply", "--yes"], home, realOmpDir());
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
});

test("without an installed plugin the plan reports absence and apply refuses", () => {
	const base = workspace();
	const home = join(base, "home");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	for (const dir of ["xdg-config", "xdg-state", "xdg-data", "xdg-cache", "tmp"]) mkdirSync(join(home, dir), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), readFileSync(join(repoRules, "kit-test-skip.md")));
	const plan = cli(["migrate", "--plan"], home, realOmpDir());
	expect(plan.code).toBe(0);
	expect(plan.envelope.data.pluginAbsent).toBe(true);
	const applied = cli(["migrate", "--apply", "--yes"], home, realOmpDir());
	expect(applied.code).toBe(2);
	expect(applied.envelope.errors[0].code).toBe("PLUGIN_ABSENT");
	expect(existsSync(join(home, ".agents", "rules", "kit-test-skip.md"))).toBe(true);
});

test("applyMigration refuses without a plugin even when called directly", () => {
	const root = mkdtempSync(join(import.meta.dir, "../../var/agent-tmp", "migrate-unit-"));
	fixtures.push(root);
	const home = join(root, "home");
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	writeFileSync(join(home, ".agents", "rules", "kit-test-skip.md"), readFileSync(join(repoRules, "kit-test-skip.md")));
	const input = { root: resolve(import.meta.dir, "../.."), home };
	const plan = planMigration(input);
	expect(plan.pluginAbsent).toBe(true);
	expect(() => applyMigration(plan, input, { confirmed: true })).toThrow("PLUGIN_ABSENT");
});

test("overlay rows carry the unified diff and the native destination", () => {
	const { home } = pluginFixture(6);
	const result = cli(["migrate", "--plan"], home, realOmpDir());
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

test("kit-standing-law stays unlisted with and without a native overlay", () => {
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
	const plan = cli(["migrate", "--plan"], home, realOmpDir());
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
