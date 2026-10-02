import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { readProfileWiring, runIntegrations, staticVerdict } from "../../src/integrations.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let release = "";
let plantHome = "";
let ompLauncher = "";
let environment: Record<string, string>;

const DCG_BRIDGE = "/Users/josh/.omp/omp-extensions/dcg-tool-bridge.ts";
const SLB_GUARD = "/Users/josh/.omp/omp-extensions/slb-guard-fail-closed.ts";
const KIT_OPTIN = "/Users/josh/.omp/omp-extensions/kit-guard-optin.ts";

function profileConfig(extensions: string[]): string {
	return ["extensions:", ...extensions.map(path => `  - ${path}`), ""].join("\n");
}

beforeAll(() => {
	const omp = resolveOmpIdentity(process.env);
	ompLauncher = omp.launcher;
	base = mkdtempSync(join(tmpdir(), "omp-kit-integrations-"));
	release = join(base, "relocated", "release");
	binary = join(release, "bin", "omp-kit");
	home = join(base, "home");
	plantHome = join(base, "plant-home");
	for (const directory of [join(release, "bin"), join(release, "scripts"), join(release, "tests", "live"),
		...(["tmp", "config", "cache", "data", "state"] as const).map(name => join(home, name))]) {
		mkdirSync(directory, { recursive: true });
	}
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(release, directory), { recursive: true });
	}
	for (const file of ["MANIFEST.tsv", "package.json"]) {
		writeFileSync(join(release, file), readFileSync(join(REPO_ROOT, file)));
	}
	mkdirSync(join(release, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(release, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	writeFileSync(join(release, "tests/live/mock-model.mjs"), readFileSync(join(REPO_ROOT, "tests/live/mock-model.mjs")));
	writeFileSync(join(release, "tests/live/integrations.json"), readFileSync(join(REPO_ROOT, "tests/live/integrations.json")));
	const planted = join(plantHome, ".omp/profiles/planted/agent");
	mkdirSync(planted, { recursive: true });
	writeFileSync(join(planted, "config.yml"), profileConfig([DCG_BRIDGE, SLB_GUARD, KIT_OPTIN]));
	writeFileSync(join(planted, "mcp.json"), JSON.stringify({ mcpServers: {} }));
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
	chmodSync(binary, 0o755);
	environment = {
		HOME: home, TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"),
		PATH: process.env.PATH ?? "/usr/bin:/bin", OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
	};
}, 120_000);

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

function runCli(args: string[]): { exitCode: number; envelope: Record<string, unknown> } {
	const child = Bun.spawnSync([binary, ...args], {
		cwd: home, env: { ...environment }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	if (!stdout.trim()) throw new Error(`compiled CLI returned no JSON (rc=${child.exitCode}): ${child.stderr.toString().slice(0, 500)}`);
	return { exitCode: child.exitCode, envelope: JSON.parse(stdout) as Record<string, unknown> };
}

test("planted profile without the dcg extension reports ABSENT without running", () => {
	const dir = join(base, "absent-home", ".omp/profiles/planted/agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), profileConfig([SLB_GUARD]));
	const wiring = readProfileWiring(join(base, "absent-home"), "planted");
	const verdict = staticVerdict(wiring, "dcg");
	expect(verdict?.verdict).toBe("ABSENT");
	expect(verdict?.detail).toContain("dcg-tool-bridge.ts");
});

test("planted profile without the MCP server reports ABSENT", () => {
	const wiring = readProfileWiring(plantHome, "planted");
	const verdict = staticVerdict(wiring, "mcp-agent-mail");
	expect(verdict?.verdict).toBe("ABSENT");
});

test("integrations --plan prints without reading profiles", () => {
	const { exitCode, envelope } = runCli(["test", "--integrations", "--plan", "--json"]);
	expect(exitCode).toBe(0);
	const plan = (envelope.data as { integrations_plan?: { integrations?: string[] } }).integrations_plan;
	expect(plan?.integrations).toContain("dcg");
});

test("live dcg fire is blocked on the planted profile", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["dcg"], workDir: join(base, "live-dcg"), ompPath: ompLauncher, timeoutSecs: 120 });
	const dcg = report.matrix.find(cell => cell.integration === "dcg");
	expect(dcg?.verdict).toBe("WIRED");
	expect(dcg?.detail).toContain("still exists");
}, 300_000);

test("live slb fire is blocked on the planted profile", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["slb"], workDir: join(base, "live-slb"), ompPath: ompLauncher, timeoutSecs: 120 });
	const slb = report.matrix.find(cell => cell.integration === "slb");
	expect(slb?.verdict).toBe("WIRED");
}, 300_000);

test("live kit-guard fire is refused in the opted-in repo", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["kit-guard"], workDir: join(base, "live-kit"), ompPath: ompLauncher, timeoutSecs: 120 });
	const guard = report.matrix.find(cell => cell.integration === "kit-guard");
	expect(guard?.verdict).toBe("WIRED");
}, 300_000);
