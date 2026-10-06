import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, relative, resolve, sep } from "node:path";
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
	return ["extensions:", ...extensions.map(path => {
		const entry = path.startsWith(`${plantHome}${sep}`) ? `~/${relative(plantHome, path)}` : path;
		return `  - ${entry}`;
	}), ""].join("\n");
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
	// Fixture bridges mirror each integration's observable contract: blocked
	// dangerous calls or visible RCH rewrites. CI proves matrix mechanics
	// without loading ~/.omp; installed-profile wiring is proven separately.
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
	writeFileSync(join(planted, "extensions/rch-mutator.ts"), [
		"export default function fixtureRch(pi) {",
		'  pi.on("tool_call", (event) => {',
		'    const input = event && typeof event.input === "object" && event.input !== null ? event.input : null;',
		'    const command = input && typeof input.command === "string" ? input.command : "";',
		'    if (event && event.type === "tool_call" && event.toolName === "bash" && command === "cargo check") {',
		'      return { input: { ...input, command: "echo \'rch exec -- cargo check\'" } };',
		"    }",
		"  });",
		"}",
		"",
	].join("\n"));
	writeFileSync(join(planted, "extensions/fleet-guard.ts"),
		"// Test fixture emulating fleet-guard for /tmp writes only.\n" +
		"export default function fixtureFleet(pi) {\n" +
		'  pi.on("tool_call", (event) => {\n' +
		"    const input = event && typeof event.input === \"object\" ? event.input : null;\n" +
		"    const command = input && typeof input.command === \"string\" ? input.command : \"\";\n" +
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
		join(planted, "extensions/rch-mutator.ts"),
		join(planted, "extensions/kit-guard-optin.ts"),
		join(planted, "extensions/fleet-guard.ts"),
	]));
	writeFileSync(join(planted, "mcp.json"), JSON.stringify({ mcpServers: {
		"mcp-agent-mail": { type: "stdio", command: process.execPath, args: [join(REPO_ROOT, "tests/cli/mcp-fake-server.ts"), "agent-mail"] },
	} }));
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

test("planted profile without the dcg extension reports ABSENT without running", async () => {
	const absentHome = join(base, "absent-home");
	const dir = join(absentHome, ".omp/profiles/planted/agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), profileConfig([join(dir, "extensions/slb-guard-fail-closed.ts")]));
	const wiring = readProfileWiring(absentHome, "planted");
	const verdict = staticVerdict(wiring, "dcg");
	expect(verdict?.verdict).toBe("ABSENT");
	expect(verdict?.detail).toContain("dcg-tool-bridge.ts");

	const report = await runIntegrations({ root: release, home: absentHome, profiles: ["planted"],
		integrations: ["dcg"], workDir: join(base, "absent-matrix"), ompPath: ompLauncher });
	const dcg = report.matrix.find(cell => cell.integration === "dcg");
	expect(dcg?.verdict).toBe("ABSENT");
	expect(dcg?.evidence.every(path => existsSync(path))).toBe(true);
}, 120_000);

test("planted profile without the MCP server reports ABSENT", () => {
	const dir = join(base, "no-mcp-home", ".omp/profiles/planted/agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.yml"), profileConfig([]));
	const wiring = readProfileWiring(join(base, "no-mcp-home"), "planted");
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

test("integrations rejects OMP aliases and Darwin sandbox-temp work paths", async () => {
	const ompAlias = join(base, "omp-alias");
	symlinkSync(join(plantHome, ".omp"), ompAlias, "dir");
	const unsafeWorkDir = join(plantHome, ".omp/unsafe-work");
	await expect(runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		workDir: unsafeWorkDir })).rejects.toMatchObject({ code: "INVALID_INTEGRATIONS_SELECTION" });
	expect(existsSync(unsafeWorkDir)).toBe(false);
	await expect(runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		workDir: join(base, "unsafe-report"), out: join(plantHome, ".omp/report.json") }))
		.rejects.toMatchObject({ code: "INVALID_INTEGRATIONS_SELECTION" });
	await expect(runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		workDir: join(ompAlias, "unsafe-work") })).rejects.toMatchObject({ code: "INVALID_INTEGRATIONS_SELECTION" });
	expect(existsSync(join(plantHome, ".omp/unsafe-work"))).toBe(false);
	await expect(runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		workDir: join(base, "symlink-report-work"), out: join(ompAlias, "report.json") }))
		.rejects.toMatchObject({ code: "INVALID_INTEGRATIONS_SELECTION" });
	if (process.platform === "darwin") {
		const unsafeTempWork = join("/tmp", `ompkit-integrations-${process.pid}`);
		await expect(runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
			workDir: unsafeTempWork })).rejects.toMatchObject({ code: "INVALID_INTEGRATIONS_SELECTION" });
		expect(existsSync(unsafeTempWork)).toBe(false);
	}
});

test("live dcg fire blocks and quiet near-miss is allowed on the planted profile", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["dcg"], workDir: join(base, "live-dcg"), ompPath: ompLauncher, timeoutSecs: 120 });
	const dcg = report.matrix.find(cell => cell.integration === "dcg");
	expect(dcg?.verdict).toBe("WIRED");
	expect(dcg?.detail).toContain("still exists");
	expect(dcg?.quiet?.outcome).toBe("ALLOWED");
	expect(dcg?.evidence.length).toBeGreaterThan(0);
	expect(dcg?.evidence.every(path => existsSync(path))).toBe(true);
	expect(report.ompVersion.length).toBeGreaterThan(0);
	expect(report.limitations.join(" ")).toContain("model tool choice");
	expect(report.realOmpIntegrity).toMatchObject({
		homeOmpPath: join(plantHome, ".omp"), complete: true, unchanged: true,
	});
	expect(existsSync(report.realOmpIntegrity.path)).toBe(true);
}, 300_000);

test("DCG no-op mutant makes the fire assertion fail", async () => {
	const mutantHome = join(base, "mutant-home");
	const agent = join(mutantHome, ".omp/profiles/planted/agent");
	const extension = join(agent, "extensions/dcg-tool-bridge.ts");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	writeFileSync(extension, [
		"export default function mutantDcg(pi) {",
		'  pi.on("tool_call", () => undefined);',
		"}",
		"",
	].join("\n"));
	writeFileSync(join(agent, "config.yml"), profileConfig([extension]));
	const report = await runIntegrations({ root: release, home: mutantHome, profiles: ["planted"],
		integrations: ["dcg"], workDir: join(base, "mutant-dcg"), ompPath: ompLauncher, timeoutSecs: 120 });
	const dcg = report.matrix.find(cell => cell.integration === "dcg");
	expect(dcg?.verdict).toBe("CONFIGURED_NOT_FIRING");
	expect(dcg?.quiet?.outcome).toBe("ALLOWED");
}, 300_000);

test("live slb reports its source hash and allows a quiet near-miss", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["slb"], workDir: join(base, "live-slb"), ompPath: ompLauncher, timeoutSecs: 120 });
	const slb = report.matrix.find(cell => cell.integration === "slb");
	expect(slb?.verdict).toBe("WIRED");
	expect(slb?.quiet?.outcome).toBe("ALLOWED");
	const source = join(plantHome, ".omp/profiles/planted/agent/extensions/slb-guard-fail-closed.ts");
	expect(slb?.source).toEqual({ path: source, sha256: createHash("sha256").update(readFileSync(source)).digest("hex") });
	expect(slb?.evidence.every(path => existsSync(path))).toBe(true);
}, 300_000);

test("RCH cargo check rewrite is visible and the quiet cargo version is allowed", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["rch"], workDir: join(base, "live-rch"), ompPath: ompLauncher, timeoutSecs: 120 });
	const rch = report.matrix.find(cell => cell.integration === "rch");
	expect(rch?.verdict).toBe("WIRED");
	expect(rch?.quiet?.outcome).toBe("ALLOWED");
	const mockPath = rch?.evidence.find(path => path.endsWith("/mock.log") && path.includes("rch-fire"));
	expect(mockPath).toBeDefined();
	if (!mockPath) throw new Error("RCH report omitted its model transcript");
	expect(readFileSync(mockPath, "utf8")).toContain("rch exec -- cargo check");
}, 300_000);

test("Agent Mail MCP health_check passes while a failed health tool is not WIRED", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["mcp-agent-mail"], workDir: join(base, "live-mcp"), ompPath: ompLauncher, timeoutSecs: 120 });
	const mcp = report.matrix.find(cell => cell.integration === "mcp-agent-mail");
	expect(mcp?.verdict).toBe("WIRED");
	expect(mcp?.quiet?.outcome).toBe("ALLOWED");

	const mutantHome = join(base, "mutant-mcp-home");
	const agent = join(mutantHome, ".omp/profiles/planted/agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "config.yml"), profileConfig([]));
	writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: {
		"mcp-agent-mail": { type: "stdio", command: process.execPath,
			args: [join(REPO_ROOT, "tests/cli/mcp-fake-server.ts"), "agent-mail-fail"] },
	} }));
	const mutantReport = await runIntegrations({ root: release, home: mutantHome, profiles: ["planted"],
		integrations: ["mcp-agent-mail"], workDir: join(base, "mutant-mcp"), ompPath: ompLauncher, timeoutSecs: 120 });
	const mutant = mutantReport.matrix.find(cell => cell.integration === "mcp-agent-mail");
	expect(mutant?.verdict).toBe("CONFIGURED_NOT_FIRING");
	expect(mutant?.quiet?.outcome).toBe("BLOCKED");
}, 300_000);
test("kit-guard opt-in fires while a no-op guard is not WIRED", async () => {
	const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
		integrations: ["kit-guard"], workDir: join(base, "live-kit-guard"), ompPath: ompLauncher, timeoutSecs: 120 });
	const guard = report.matrix.find(cell => cell.integration === "kit-guard");
	expect(guard?.verdict).toBe("WIRED");
	expect(guard?.quiet?.outcome).toBe("ALLOWED");

	const mutantHome = join(base, "mutant-kit-guard-home");
	const agent = join(mutantHome, ".omp/profiles/planted/agent");
	const extension = join(agent, "extensions/kit-guard-optin.ts");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	writeFileSync(extension, "export default function noOpKitGuard(): void {}\n");
	writeFileSync(join(agent, "config.yml"), profileConfig([extension]));
	const mutantReport = await runIntegrations({ root: release, home: mutantHome, profiles: ["planted"],
		integrations: ["kit-guard"], workDir: join(base, "mutant-kit-guard"), ompPath: ompLauncher, timeoutSecs: 120 });
	const mutant = mutantReport.matrix.find(cell => cell.integration === "kit-guard");
	expect(mutant?.verdict).toBe("CONFIGURED_NOT_FIRING");
	expect(mutant?.quiet?.outcome).toBe("ALLOWED");
}, 300_000);
test.skipIf(process.platform !== "darwin" && Bun.which("bwrap") === null)(
	"fleet-guard blocks /tmp and a disabled guard remains contained", async () => {
		const report = await runIntegrations({ root: release, home: plantHome, profiles: ["planted"],
			integrations: ["fleet-guard"], workDir: join(base, "live-fleet"), ompPath: ompLauncher, timeoutSecs: 120 });
		const fleet = report.matrix.find(cell => cell.integration === "fleet-guard");
		if (!fleet?.markerPath) throw new Error("fleet report omitted the contained marker path");
		const fleetMarkerWritten = existsSync(fleet.markerPath);
		if (fleetMarkerWritten) rmSync(fleet.markerPath, { force: true });
		expect(fleetMarkerWritten).toBe(false);
		expect(fleet.markerPath).toMatch(/^\/tmp\//);
		expect(fleet.verdict).toBe("WIRED");
		expect(fleet.quiet?.outcome).toBe("ALLOWED");

		const mutantHome = join(base, "mutant-fleet-home");
		const agent = join(mutantHome, ".omp/profiles/planted/agent");
		const extension = join(agent, "extensions/fleet-guard.ts");
		mkdirSync(join(agent, "extensions"), { recursive: true });
		writeFileSync(extension, [
			"export default function mutantFleet(pi) {",
			'  pi.on("tool_call", () => undefined);',
			"}",
			"",
		].join("\n"));
		writeFileSync(join(agent, "config.yml"), profileConfig([extension]));
		const mutantReport = await runIntegrations({ root: release, home: mutantHome, profiles: ["planted"],
			integrations: ["fleet-guard"], workDir: join(base, "mutant-fleet"), ompPath: ompLauncher, timeoutSecs: 120 });
		const mutant = mutantReport.matrix.find(cell => cell.integration === "fleet-guard");
		if (!mutant?.markerPath) throw new Error("mutant report omitted the contained marker path");
		const mutantMarkerWritten = existsSync(mutant.markerPath);
		if (mutantMarkerWritten) rmSync(mutant.markerPath, { force: true });
		expect(mutantMarkerWritten).toBe(false);
		expect(mutant.verdict).toBe("CONFIGURED_NOT_FIRING");
		expect(mutant.quiet?.outcome).toBe("ALLOWED");
		expect(mutant.detail).not.toContain("marker was written");
		const mockPath = mutant.evidence.find(path => path.endsWith("/mock.log") && path.includes("fleet-guard-fire"));
		expect(mockPath).toBeDefined();
		if (!mockPath) throw new Error("mutant report omitted its model transcript");
		const mockLog = readFileSync(mockPath, "utf8");
		expect(mockLog).toContain("echo hi > /tmp/");
		expect(mockLog).toContain('"role":"tool"');
		expect(mutantReport.realOmpIntegrity.unchanged).toBe(true);
	},
	300_000,
);



test("fleet-guard judge reads a contained marker and refusal source", () => {
	const branch = `itg-unit-fleet-${process.pid}`;
	const tmpMarker = join(base, `${branch}.txt`);
	const attempt = (mockLog: string, stderr = "") => ({
		profile: "planted", integration: "fleet-guard", kind: "fire" as const, rc: 0,
		stdout: "", stderr, mockLog, workRepo: "", marker: tmpMarker, timedOut: false, evidencePaths: [],
	});
	const input = (fire: LiveAttempt) => ({ fire, quiet: null, repo: "", vars: { BRANCH: branch } });
	try {
		const wired = judgeFleet(input(attempt(JSON.stringify({ body: { messages: [
			{ role: "tool", content: "fixture fleet-guard: /tmp write blocked", tool_call_id: "call_1" },
		] } }))));
		expect(wired.verdict).toBe("WIRED");
		const preempted = judgeFleet(input(attempt(JSON.stringify({ body: { messages: [
			{ role: "tool", content: "dcg denied the bash tool call (core.git:reset-hard)", tool_call_id: "call_1" },
		] } }))));
		expect(preempted.verdict).toBe("CONFIGURED_NOT_FIRING");
		expect(preempted.detail).toContain("dcg");
		writeFileSync(tmpMarker, "hi\n");
		const executed = judgeFleet(input(attempt(JSON.stringify({ body: { messages: [
			{ role: "tool", content: "(no output)", tool_call_id: "call_1" },
		] } }))));
		expect(executed.verdict).toBe("CONFIGURED_NOT_FIRING");
		expect(executed.detail).toContain("written");
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
