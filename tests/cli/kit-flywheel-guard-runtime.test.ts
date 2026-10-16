import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { sanitizedEnv } from "../../src/runtime.ts";

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
	const watcher = watch(dirname(path));
	let changed = once(watcher, "change");
	const exited = child.exited.then(code => ({ kind: "exit" as const, code }));
	try {
		while (true) {
			const port = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
			if (port) return port;
			const event = await Promise.race([
				changed.then(() => ({ kind: "change" as const })),
				exited,
			]);
			if (event.kind === "exit") throw new Error(`mock model exited before readiness (${event.code})`);
			changed = once(watcher, "change");
		}
	} finally {
		watcher.close();
	}
}
async function runCommand(command: string[], cwd: string, env: Record<string, string>, timeout: number) {
	const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe", timeout });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}


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
		env: { ...env, SCEN: scenarioPath, LOG: logPath, PORTFILE: portPath, BUN_BE_BUN: "1" },
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
		expect(toolResults(readFileSync(logPath, "utf8")).some(result => result.includes("FINITE_JOB_NO_DEADLINE"))).toBe(true);
	} finally {
		if (mock.exitCode === null) mock.kill("SIGTERM");
		await mock.exited;
		await mockStderr;
	}
}, 75_000);
