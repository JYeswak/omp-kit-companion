import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { run } from "../src/kitlib/run.ts";
import { resolveRealBr } from "../src/kitlib/readonly-br.ts";
import { resolveOmpIdentity, resolveOmpLauncher } from "../src/paths.ts";
import { sanitizedEnv } from "../src/runtime.ts";

const root = resolve(import.meta.dir, "..");

/** Prefer Tern's direct launcher when present: operator trust wrappers depend on the real HOME. */
export function spawnSmokePrerequisites(env: Record<string, string | undefined> = process.env) {
	const ternBin = env.HOME && process.platform === "darwin"
		? join(env.HOME, "Library", "Application Support", "Tern", "omp", "bin") : undefined;
	const path = ternBin && Bun.which("omp", { PATH: ternBin }) ? `${ternBin}:${env.PATH ?? ""}` : env.PATH ?? "";
	const br = resolveRealBr(path);
	const missing = [
		...(resolveOmpLauncher({ PATH: path }) ? [] : ["omp executable on PATH"]),
		...(br.ok ? [] : [`native br binary (${br.code})`]),
	];
	return { path, br, missing };
}

/** Release-local credential-free native task journey. Never loads the installed kit predecessor. */
export async function runSpawnSmoke(options: { guard?: string } = {}) {
	const prerequisites = spawnSmokePrerequisites();
	if (prerequisites.missing.length) throw new Error(`spawn-smoke: SKIP unmet prerequisite: ${prerequisites.missing.join(", ")}`);
	const br = prerequisites.br;
	if (!br.ok) throw new Error(br.reason);
	const scope = ownedTmp("spawn-smoke");
	let server: Bun.Server<undefined> | undefined;
	try {
		const project = join(scope.path, "project");
		const identity = resolveOmpIdentity({ HOME: process.env.HOME, PATH: prerequisites.path,
			BUN_INSTALL: process.env.BUN_INSTALL, OMP_KIT_OMP_SRC_CACHE: process.env.OMP_KIT_OMP_SRC_CACHE });
		const env = sanitizedEnv(identity, { PATH: prerequisites.path }, scope.path);
		for (const directory of [project, env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
			env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.BUN_INSTALL]) mkdirSync(directory!, { recursive: true, mode: 0o700 });
		const bin = join(scope.path, "bin");
		mkdirSync(bin);
		symlinkSync(realpathSync(br.path), join(bin, "br"));
		env.PATH = `${bin}:${env.PATH}`;
		env.GIT_CEILING_DIRECTORIES = scope.path;
		env.BEADS_DB = join(project, ".beads", "beads.db");
		const command = async (argv: string[], cwd = project, deadline = 30) => {
			const result = await run(argv, { cwd, env, deadline_s: deadline, max_output_bytes: 4 * 1024 * 1024 });
			const stdout = new TextDecoder().decode(result.stdout), stderr = new TextDecoder().decode(result.stderr);
			if (result.rc !== 0 || result.timed_out || result.truncated || result.total_truncated)
				throw new Error(`spawn-smoke: ${argv[0]} rc=${result.rc}\n${stdout}\n${stderr}`);
			return stdout;
		};
		await command(["git", "init", "-q"]);
		await command(["git", "-c", "user.name=Spawn Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]);
		await command([br.path, "init", "--prefix", "smoke"]);
		// The actual shipped hook supplies quoted kit ids to the real brief. It is installed after fixture commit.
		const hook = join(project, ".git", "hooks", "pre-commit");
		writeFileSync(hook, readFileSync(join(root, "scripts/check-staged-kitlib.sh")));
		chmodSync(hook, 0o700);
		const brief = await command([process.execPath, join(root, "src/cli.ts"), "brief", "--repo", project]);
		const guard = realpathSync(options.guard ?? join(root, "extensions/kit-flywheel-guard.ts"));
		const agentDir = join(env.HOME!, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "config.yml"), "bash:\n  enabled: true\nasync:\n  enabled: false\nmodelRoles:\n  task: mock/mock\n  smol: mock/mock\ntask:\n  batch: true\n  isolation:\n    enabled: false\ndisabledProviders:\n  - ollama\n  - llama.cpp\n  - lm-studio\n");
		const requests: { messages?: { role: string; content?: unknown }[]; tools?: unknown[] }[] = [];
		let parentTurn = 0, childTurn = 0;
		const task = { context: `Repo: ${project}\n${brief}`, tasks: [{
			name: "build", solutionSpace: "Write only spawned.txt in this repository.",
			task: "# Change\nCreate spawned.txt containing native-spawn-admitted. Use the write tool.",
		}] };
		server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
			const body = await request.json() as typeof requests[number];
			requests.push(body);
			const main = Array.isArray(body.tools) && body.tools.length > 0;
			const child = body.messages?.some(message => message.role === "user" && JSON.stringify(message.content).includes(task.tasks[0]!.task.split("\n")[1]!)) === true;
			const step = main ? (child ? childTurn++ : parentTurn++) : -1;
			const tool = main && !child && step === 0 ? { name: "task", args: task }
				: main && child && step === 0 ? { name: "write", args: { path: "spawned.txt", content: "native-spawn-admitted" } } : undefined;
			const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
				: { role: "assistant", content: "Smoke complete." };
			const chunk = { id: "smoke", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		} });
		writeFileSync(join(agentDir, "models.yml"), `providers:\n  mock:\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    apiKey: sk-mock\n    api: openai-completions\n    models:\n      - id: mock\n        name: mock\n        supportsTools: true\n        contextWindow: 128000\n        maxTokens: 4096\n`);
		const output = await command([identity.launcher, "-p", "--no-session", "--no-title", "--no-lsp", "--no-skills", "--no-rules", "--no-extensions", "-e", guard,
			"--model", "mock/mock", "--approval-mode", "yolo", "Run the native build smoke."], project, 60);
		const transcript = JSON.stringify(requests.map(request => request.messages?.filter(message => message.role === "tool")));
		// Only the child may write: if task admission fails, the parent's next scripted turn must not fake success.
		const childStarted = childTurn > 0;
		if (!childStarted || !existsSync(join(project, "spawned.txt"))) throw new Error(`spawn-smoke: native build did not execute\n${output}\n${transcript}`);
		const childOutput = readFileSync(join(project, "spawned.txt"), "utf8");
		if (childOutput !== "native-spawn-admitted") throw new Error(`spawn-smoke: wrong child output: ${childOutput}`);
		return { guard, childOutput };
	} finally {
		await server?.stop(true);
		scope.cleanup();
	}
}

if (import.meta.main) {
	try { console.log(`spawn-smoke: PASS ${JSON.stringify(await runSpawnSmoke())}`); }
	catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
