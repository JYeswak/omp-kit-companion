import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { optInState } from "../../extensions/kit-guard-optin.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { judgeFleet, readProfileWiring, runIntegrations, staticVerdict } from "../../src/integrations.ts";
import type { LiveAttempt } from "../../src/integrations.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base = "";
let binary = "";
let home = "";
let release = "";
let plantHome = "";
let ompLauncher = "";
let environment: Record<string, string>;


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
	mkdirSync(join(planted, "extensions"), { recursive: true });
	// Fixture bridges mirror the real guards' observable contract ({block, reason}
	// on the tested commands) so CI proves the matrix machinery without the
	// machine's real ~/.omp extensions. Real-guard wiring is proven manually
	// with the CLI on the real machine and cited on the bead, never in CI tests.
	writeFileSync(join(planted, "extensions/dcg-tool-bridge.ts"),
		"// Test fixture emulating dcg-tool-bridge for branch -D only.\n" +
		"export default function fixtureDcg(pi) {\n" +
		'  pi.on("tool_call", (event) => {\n' +
		"    const input = event && typeof event.input === \"object\" ? event.input : null;\n" +
		'    const command = input && typeof input.command === "string" ? input.command : "";\n' +
		'    if (event && event.type === "tool_call" && event.toolName === "bash" && command.includes("branch -D")) {\n' +
		'      return { block: true, reason: "fixture dcg: branch force-delete blocked" };\n' +
		"    }\n" +
		"    return undefined;\n" +
		"  });\n" +
		"}\n");
	writeFileSync(join(planted, "extensions/slb-guard-fail-closed.ts"),
		"// Test fixture emulating slb-guard-fail-closed for reset --hard only.\n" +
		"export default function fixtureSlb(pi) {\n" +
		'  pi.on("tool_call", (event) => {\n' +
		"    const input = event && typeof event.input === \"object\" ? event.input : null;\n" +
		'    const command = input && typeof input.command === "string" ? input.command : "";\n' +
		'    if (event && event.type === "tool_call" && event.toolName === "bash" && command.includes("reset --hard")) {\n' +
		'      return { block: true, reason: "fixture slb: reset blocked" };\n' +
		"    }\n" +
		"    return undefined;\n" +
		"  });\n" +
		"}\n");
	writeFileSync(join(planted, "extensions/fleet-guard.ts"),
		"// Test fixture emulating fleet-guard for /tmp writes only.\n" +
		"export default function fixtureFleet(pi) {\n" +
		'  pi.on("tool_call", (event) => {\n' +
		"    const input = event && typeof event.input === \"object\" ? event.input : null;\n" +
		'    if (event && event.type === "tool_call" && event.toolName === "bash" && command.includes("/tmp/")) {\n' +
		'      return { block: true, reason: "fixture fleet-guard: /tmp write blocked" };\n' +
		"    }\n" +
		"    return undefined;\n" +
		"  });\n" +
		"}\n");
	writeFileSync(join(planted, "extensions/kit-guard-optin.ts"),
		readFileSync(join(REPO_ROOT, "extensions/kit-guard-optin.ts")));
	writeFileSync(join(planted, "config.yml"), profileConfig([
		join(planted, "extensions/dcg-tool-bridge.ts"),
		join(planted, "extensions/slb-guard-fail-closed.ts"),
		join(planted, "extensions/kit-guard-optin.ts"),
		join(planted, "extensions/fleet-guard.ts"),
	]));
	const build = Bun.spawnSync([
		process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		"--no-compile-autoload-tsconfig", join(REPO_ROOT, "src/cli.ts"), `--outfile=${binary}`,
	], { cwd: base, stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) throw new Error(`compiled CLI fixture failed (${build.exitCode}): ${build.stdout.toString()}\n${build.stderr.toString()}`);
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
	writeFileSync(join(dir, "config.yml"), profileConfig([join(dir, "extensions/slb-guard-fail-closed.ts")]));
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
	expect(plan?.integrations).toContain("fleet-guard");
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

test("fleet-guard judge reads the /tmp marker and the refusal source", () => {
	const branch = `itg-unit-fleet-${process.pid}`;
	const tmpMarker = join("/tmp", `${branch}.txt`);
	rmSync(tmpMarker, { force: true });
	const attempt = (mockLog: string, stderr = "") => ({
		profile: "planted", integration: "fleet-guard", kind: "fire" as const, rc: 0,
		stdout: "", stderr, mockLog, workRepo: "", marker: tmpMarker, timedOut: false,
	});
	const toolLog = (content: string) =>
		JSON.stringify({ body: { messages: [{ role: "tool", content, tool_call_id: "call_1" }] } });
	const input = (fire: LiveAttempt) => ({ fire, quiet: null, repo: "", vars: { BRANCH: branch } });
	try {
		const wired = judgeFleet(input(attempt(toolLog("fixture fleet-guard: /tmp write blocked"))));
		expect(wired.verdict).toBe("WIRED");
		const preempted = judgeFleet(input(attempt(toolLog("dcg denied the bash tool call (core.git:reset-hard)"))));
		expect(preempted.verdict).toBe("CONFIGURED_NOT_FIRING");
		expect(preempted.detail).toContain("dcg");
		writeFileSync(tmpMarker, "hi\n");
		const executed = judgeFleet(input(attempt(toolLog("(no output)"))));
		expect(executed.verdict).toBe("CONFIGURED_NOT_FIRING");
		expect(executed.detail).toContain("executed");
		const loadError = judgeFleet(input(attempt("", "failed to load extension fleet-guard.ts: boom")));
		expect(loadError.verdict).toBe("LOAD_ERROR");
	} finally {
		rmSync(tmpMarker, { force: true });
	}
});

test("kit-guard opt-in decision is on, off, and project-copy", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-optin-"));
	mkdirSync(join(root, ".git"), { recursive: true });
	try {
		expect(optInState(root, undefined).kind).toBe("off");
		mkdirSync(join(root, ".omp"), { recursive: true });
		writeFileSync(join(root, ".omp/kit-guard.json"), "{}\n");
		expect(optInState(root, undefined)).toMatchObject({ kind: "on", root });
		expect(optInState(root, "/guard/index.ts")).toMatchObject({ kind: "on", src: "/guard/index.ts" });
		mkdirSync(join(root, ".omp/extensions/kit-guard"), { recursive: true });
		expect(optInState(root, undefined).kind).toBe("project-copy");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
