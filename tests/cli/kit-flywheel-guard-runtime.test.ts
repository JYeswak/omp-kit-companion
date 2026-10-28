import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import process from "node:process";
import { join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { sanitizedEnv } from "../../src/runtime.ts";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const fixtures: string[] = [];

afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixtureRoot(): string {
	const scratch = join(REPO_ROOT, "var", "agent-tmp");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const label = `kit-flywheel-guard-runtime-${randomUUID()}`;
	const root = join(scratch, `${label}.${process.pid}`);
	mkdirSync(root, { mode: 0o700 });
	fixtures.push(root);
	writeFileSync(join(root, ".owner"), `pid=${process.pid}\nlabel=${label}\nrepo=${REPO_ROOT}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	return root;
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
