import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { sanitizedEnv } from "../../src/runtime.ts";
import { parseOwnerFile } from "../../src/scratch.ts";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const fixtures: OwnedTmp[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

function fixtureRoot(): string {
	const scope = ownedTmp("flywheel-guard-runtime", { root: join(REPO_ROOT, "var", "agent-tmp") });
	fixtures.push(scope);
	return scope.path;
}

type RequestLogRow = { body: { messages: Array<{ role: string; content?: unknown }> } };

function toolResults(log: string): string[] {
	return log.split("\n").filter(Boolean).flatMap(line => {
		const row: RequestLogRow = JSON.parse(line);
		return row.body.messages.filter(message => message.role === "tool")
			.map(({ content }) => typeof content === "string" ? content : JSON.stringify(content) ?? "");
	});
}

async function waitForPort(path: string, child: { readonly exited: Promise<number> }): Promise<string> {
	const { promise: ready, resolve: publishPort } = Promise.withResolvers<{ kind: "ready"; port: string }>();
	const observe = () => {
		const port = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
		if (port) publishPort({ kind: "ready", port });
	};
	const exited = child.exited.then(code => ({ kind: "exit" as const, code }));
	// Directory notifications can be absent while the server is already listening.
	// Observe the durable port state; the child's unchanged deadline remains the bound.
	watchFile(path, { interval: 10, persistent: false }, observe);
	try {
		observe();
		const event = await Promise.race([ready, exited]);
		if (event.kind === "exit") throw new Error(`mock model exited before readiness (${event.code})`);
		return event.port;
	} finally {
		unwatchFile(path, observe);
	}
}
async function runCommand(command: string[], cwd: string, env: Record<string, string>, timeout: number) {
	const result = await kitlibRun(command, { cwd, env, deadline_s: timeout / 1000 });
	return { exitCode: result.rc, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
test("mock readiness refuses an exited child that never published a port", async () => {
	const scope = ownedTmp("mock-readiness-exit");
	try {
		const portPath = join(scope.path, "port");
		const result = kitlibRun([process.execPath, "-e", "process.exit(7)"], {
			cwd: scope.path, env: { BUN_BE_BUN: "1" }, deadline_s: 1,
			max_output_bytes: 4096, max_total_bytes: 8192,
		});
		await expect(waitForPort(portPath, { exited: result.then(value => value.rc ?? 1) }))
			.rejects.toThrow("mock model exited before readiness (7)");
		const completed = await result;
		expect({ rc: completed.rc, timed_out: completed.timed_out, killed: completed.killed, truncated: completed.truncated })
			.toEqual({ rc: 7, timed_out: false, killed: false, truncated: false });
		expect(existsSync(portPath)).toBe(false);
	} finally {
		scope.cleanup();
	}
});


test("the linked OMP plugin refuses an async timeout-zero command before it runs", async () => {
	const base = fixtureRoot();
	const project = join(base, "project");
	const identity = resolveOmpIdentity(process.env);
	const env = sanitizedEnv(identity, { PATH: process.env.PATH, OMP_KIT_CASE_CWD: project }, base);
	for (const directory of [project, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
		env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.BUN_INSTALL]) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const agentDir = join(env.HOME, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(agentDir, "config.yml"), [
		"bash:",
		"  enabled: true",
		"async:",
		"  enabled: true",
		"disabledProviders:",
		"  - ollama",
		'  - "llama.cpp"',
		"  - lm-studio",
		"",
	].join("\n"));

	const linked = await runCommand([identity.launcher, "plugin", "link", REPO_ROOT], project, env, 15_000);
	const linkOutput = `stdout:\n${linked.stdout}\nstderr:\n${linked.stderr}`;
	expect(linked.exitCode, linkOutput).toBe(0);

	const scenarioPath = join(base, "scenario.json");
	const logPath = join(base, "requests.jsonl");
	const portPath = join(base, "port");
	writeFileSync(scenarioPath, JSON.stringify({ turns: [
		{ tool: { name: "bash", args: { command: "printf unsafe > .ran_bgdeadline", async: true, timeout: 0 } } },
		{ tool: { name: "bash", args: { command: "printf bounded > .ran_bounded", timeout: 10 } } },
	] }));

	const mock = Bun.spawn([process.execPath, join(REPO_ROOT, "tests/live/mock-model.mjs")], {
		cwd: REPO_ROOT,
		env: {
			HOME: env.HOME, TMPDIR: env.TMPDIR, TMP: env.TMPDIR, TEMP: env.TMPDIR,
			SCEN: scenarioPath, LOG: logPath, PORTFILE: portPath, BUN_BE_BUN: "1",
		},
		stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 55_000,
	});
	const mockStderr = new Response(mock.stderr).text();
	try {
		const port = await waitForPort(portPath, mock);
		writeFileSync(join(agentDir, "models.yml"), [
			"providers:",
			"  mock:",
			`    baseUrl: http://127.0.0.1:${port}/v1`,
			"    apiKey: sk-mock",
			"    api: openai-completions",
			"    models:",
			"      - id: mock",
			"        name: mock",
			"        supportsTools: true",
			"        contextWindow: 128000",
			"        maxTokens: 4096",
			"",
		].join("\n"));

		const run = await runCommand([identity.launcher, "-p", "--no-session", "--model", "mock/mock",
			"--approval-mode", "yolo", "go"], project, env, 45_000);
		const output = `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`;
		expect(run.exitCode, output).toBe(0);
		expect(existsSync(join(project, ".ran_bgdeadline")), output).toBe(false);
		expect(readFileSync(join(project, ".ran_bounded"), "utf8")).toBe("bounded");
		const refusal = toolResults(readFileSync(logPath, "utf8")).find(result => result.includes("FINITE_JOB_NO_DEADLINE"));
		expect(refusal !== undefined, output).toBe(true);
		expect(refusal, output).toContain("deadline");
		expect(refusal, output).toContain("owning OMP session");
		expect(refusal, output).toContain("job");
	} finally {
		if (mock.exitCode === null) mock.kill("SIGTERM");
		await mock.exited;
		await mockStderr;
	}
}, 75_000);

test("fixture creator lifetime binds the owned root: TERM after allocation removes it, manual residue survives", async () => {
	const base = fixtureRoot();
	const tmpApi = join(REPO_ROOT, "src/kitlib/tmp.ts");
	const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
	const child = (body: string) =>
		`const { ownedTmp } = await import(${JSON.stringify(tmpApi)});\n` + body;
const allocatedOf = (stdout: string) =>
	(stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("ALLOCATED ")) ?? "").slice("ALLOCATED ".length);
const ownerOf = (stdout: string) =>
	(stdout.split("\n").map(line => line.trim()).find(line => line.startsWith("OWNER ")) ?? "").slice("OWNER ".length).split(";").join("\n");

	// Positive: the owned creator allocates, hangs, and is TERM'd at the deadline; the root must be gone.
	const ownedProgram = child(`const scope = ownedTmp("lifetime-owned", { root: ${JSON.stringify(base)} });
const { readFileSync: readOwner } = await import("node:fs");
console.log("ALLOCATED " + scope.path);
console.log("OWNER " + readOwner(scope.path + "/.owner", "utf8").trim().split("\\n").join(";"));
await new Promise(() => {});`);
	const owned = await runCommand([process.execPath, "--no-install", "-e", ownedProgram], base, childEnv, 10_000);
	const ownedOut = `stdout:\n${owned.stdout}\nstderr:\n${owned.stderr}`;
	const ownedPath = allocatedOf(owned.stdout);
	expect(ownedPath.startsWith(base + "/"), ownedOut).toBe(true);
	const ownedMarker = parseOwnerFile(ownerOf(owned.stdout));
	expect(ownedMarker !== null && ownedMarker.label === "lifetime-owned", ownedOut).toBe(true);
	expect(existsSync(ownedPath), ownedOut).toBe(false);

	// Negative (isolated da37 manual constructor): the same kill leaves the residue behind.
	const manualProgram = `const { mkdirSync, writeFileSync } = await import("node:fs");
const { join: joinPath } = await import("node:path");
const root = joinPath(${JSON.stringify(base)}, "manual-residue");
mkdirSync(root, { recursive: true, mode: 0o700 });
writeFileSync(joinPath(root, ".owner"), "pid=" + process.pid + "\\nlabel=manual-residue\\nrepo=" + ${JSON.stringify(base)} + "\\ncreated=" + new Date().toISOString() + "\\n", { mode: 0o600 });
console.log("ALLOCATED " + root);
await new Promise(() => {});`;
	const manual = await runCommand([process.execPath, "--no-install", "-e", manualProgram], base, childEnv, 10_000);
	const manualOut = `stdout:\n${manual.stdout}\nstderr:\n${manual.stderr}`;
	const manualPath = allocatedOf(manual.stdout);
	expect(manualPath, manualOut).toBe(join(base, "manual-residue"));
	expect(existsSync(manualPath), manualOut).toBe(true);
	// Residue retires with the parent-owned base at afterEach; the observed survival is the requirement failure.

	// Mutant control: a registry-disabled creator survives the same kill, so the positive depends on lifetime cleanup.
	const nocleanProgram = child(`const scope = ownedTmp("lifetime-noclean", { root: ${JSON.stringify(base)}, autoCleanup: false });
console.log("ALLOCATED " + scope.path);
await new Promise(() => {});`);
	const noclean = await runCommand([process.execPath, "--no-install", "-e", nocleanProgram], base, childEnv, 10_000);
	const nocleanOut = `stdout:\n${noclean.stdout}\nstderr:\n${noclean.stderr}`;
	const nocleanPath = allocatedOf(noclean.stdout);
	expect(nocleanPath.startsWith(base + "/"), nocleanOut).toBe(true);
	expect(existsSync(nocleanPath), nocleanOut).toBe(true);
}, 120_000);
