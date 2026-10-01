import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { resolveOmpIdentity } from "../../src/paths.ts";

const omp = resolveOmpIdentity();
const git = Bun.which("git");
if (!git) throw new Error("git unavailable on PATH; cannot bound native discovery to the disposable project");
const packageVersion: unknown = JSON.parse(readFileSync(join(omp.packageRoot, "package.json"), "utf8")).version;
if (typeof packageVersion !== "string") throw new Error("selected OMP package has no version");
// OMP added the external pre-import TTY guard in 18.4.3; 18.4.2 was observed importing the synthetic hook.
// Every later OMP runs the probe automatically (the operator's updater moves OMP every few hours), so a
// regression in a new release fails here instead of being skipped until someone extends an allowlist.
const HOOK_REFUSAL_MIN = [18, 4, 3] as const;
const versionParts = packageVersion.split(/[.-]/).slice(0, 3).map(Number);
const atLeastMin = versionParts.length === 3 && versionParts.every(Number.isInteger) && (() => {
	for (let i = 0; i < 3; i++) if (versionParts[i] !== HOOK_REFUSAL_MIN[i]) return versionParts[i]! > HOOK_REFUSAL_MIN[i]!;
	return true;
})();
const supportedHookRefusalTest = atLeastMin ? test : test.skip;
if (!atLeastMin) console.info(`native-guide: NOT_RUN: OMP ${packageVersion} predates the pre-import hook TTY guard (18.4.3)`);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface NativeFixture {
	project: string;
	env: Record<string, string>;
}

function fixture(): NativeFixture {
	const scratch = resolve(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "native-guide-"));
	roots.push(root);
	const project = join(root, "project");
	const home = join(root, "home");
	const env: Record<string, string> = {
		HOME: home,
		XDG_CONFIG_HOME: join(home, "xdg-config"),
		XDG_CACHE_HOME: join(home, "xdg-cache"),
		XDG_DATA_HOME: join(home, "xdg-data"),
		XDG_STATE_HOME: join(home, "xdg-state"),
		XDG_RUNTIME_DIR: join(home, "xdg-runtime"),
		TMPDIR: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TEMP: join(root, "tmp"),
		BUN_INSTALL: join(home, "bun-install"),
		PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
		NO_COLOR: "1",
		TERM: "dumb",
	};
	for (const path of [
		project, home, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME,
		env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR, env.TMPDIR, env.BUN_INSTALL,
	]) mkdirSync(path, { recursive: true, mode: 0o700 });
	const options = { cwd: project, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" } as const;
	// A real empty repository prevents both OMP ancestry discovery and gitignore
	// traversal from inheriting the kit checkout. No checkout content is copied.
	const init = Bun.spawnSync([git!, "-c", "init.defaultBranch=main", "init", "--quiet", "--template="], options);
	expect(init.exitCode, init.stderr.toString()).toBe(0);
	return { project, env };
}

function run(target: NativeFixture, args: string[], executable = omp.launcher) {
	const child = Bun.spawnSync([executable, ...args], {
		cwd: target.project, env: target.env, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 20000,
	});
	return { rc: child.exitCode, signal: child.signalCode ?? null, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}


test("published native commands use the selected installed OMP identity and behavior", () => {
	const target = fixture();
	const version = run(target, ["--version"]);
	expect(version.rc, version.stderr).toBe(0);
	// Bind the CLI to its own installed source, not the guide's historical version.
	expect(version.stdout.trim()).toBe(`omp/${packageVersion}`);
	console.info(`native-guide: ${version.stdout.trim()} launcher=${omp.launcher} source=${omp.source}`);
	const list = run(target, ["ttsr", "list"]);
	expect(list.rc, list.stderr).toBe(0);
	expect(list.stdout).toContain("TTSR rules");
	const quiet = run(target, ["ttsr", "test", "--source", "tool", "--tool", "bash", "--path", "run.sh", "echo hello"]);
	expect(quiet.rc, quiet.stderr).toBe(0);
	expect(quiet.stdout).toContain("No rules triggered");
	const scan = run(target, ["ttsr", "scan", "."]);
	expect(scan.rc, scan.stderr).toBe(0);
	expect(scan.stdout).toContain("No files found to scan");
	const doctor = run(target, ["plugin", "doctor", "--json"]);
	expect(doctor.rc, doctor.stderr).toBe(0);
	const inventory = JSON.parse(doctor.stdout);
	expect(inventory).toEqual(expect.arrayContaining([expect.objectContaining({
		name: "plugins_directory", message: expect.any(String),
	})]));
}, 30000);

supportedHookRefusalTest(
	"hook flag without a terminal refuses before importing a hook",
	() => {
		const target = fixture();
		const marker = join(target.project, "hook-imported");
		writeFileSync(join(target.project, "my-hook.ts"), `
			import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(marker)}, "unexpected import");
			export default () => { throw new Error("unexpected factory execution"); };
		`);
		const refused = run(target, ["--hook", "./my-hook.ts"]);
		const imported = existsSync(marker);
		if (refused.rc !== 2 || imported) {
			console.error("native-guide: non-TTY hook diagnostic", JSON.stringify({
				version: packageVersion, rc: refused.rc, signal: refused.signal,
				stdout: refused.stdout, stderr: refused.stderr, markerImported: imported,
			}));
		}
		expect(imported, `OMP ${packageVersion} imported the hook before non-TTY refusal`).toBe(false);
		expect(refused.rc, refused.stderr).toBe(2);
		expect(refused.stdout + refused.stderr).toMatch(/terminal|TTY/);
	},
	30000,
);

test("MANIFEST_IS_NOT_HANDLER: native discovery ignores manifests and never executes candidate factories", () => {
	const target = fixture();
	const claude = join(target.project, ".claude");
	const codex = join(target.project, ".codex");
	mkdirSync(claude);
	mkdirSync(codex);
	const command = "printf fixture > manifest-executed";
	writeFileSync(join(claude, "settings.json"), JSON.stringify({
		hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] },
	}));
	writeFileSync(join(codex, "hooks.json"), JSON.stringify({ hooks: { notify: [{ command }] } }));

	function discover() {
		// The native capability API reads candidate files; the runtime hook loader
		// imports and invokes factories. Deliberately never call the latter.
		// Dynamic imports select the runtime-resolved installed OMP source, not a bundled dependency.
		const result = run(target, ["--eval", `
			const source = ${JSON.stringify(omp.source)};
			const { loadCapability } = await import(source + "/capability/index.ts");
			const { hookCapability } = await import(source + "/capability/hook.ts");
			await import(source + "/discovery/claude.ts");
			await import(source + "/discovery/codex.ts");
			const result = await loadCapability(hookCapability.id, {
				cwd: process.cwd(), providers: ["claude", "codex"],
			});
			process.stdout.write(JSON.stringify(result));
		`], process.execPath);
		expect(result.rc, result.stderr).toBe(0);
		const discovered: { items: { path: string; _source: { provider: string } }[]; warnings: string[] } = JSON.parse(result.stdout);
		expect(discovered.warnings).toEqual([]);
		for (const marker of ["manifest-executed", "module-imported", "factory-executed"]) {
			expect(existsSync(join(target.project, marker))).toBe(false);
		}
		return discovered.items.map(item => ({ path: item.path, provider: item._source.provider }))
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	expect(discover()).toEqual([]);
	const candidates = [
		{ path: join(claude, "hooks/pre/bash.ts"), provider: "claude" },
		{ path: join(codex, "hooks/pre-bash.ts"), provider: "codex" },
	];
	for (const candidate of candidates) {
		mkdirSync(dirname(candidate.path), { recursive: true });
		writeFileSync(candidate.path, `
			import { writeFileSync } from "node:fs";
			writeFileSync(${JSON.stringify(join(target.project, "module-imported"))}, "unexpected import");
			export default () => writeFileSync(${JSON.stringify(join(target.project, "factory-executed"))}, "unexpected factory");
		`);
	}
	// Positive discovery control prevents an empty/disabled provider from
	// masquerading as manifest rejection. This is not factory loadability proof.
	expect(discover()).toEqual(candidates.sort((a, b) => a.path.localeCompare(b.path)));
}, 60000);
