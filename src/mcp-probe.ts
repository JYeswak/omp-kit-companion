import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProfileServers, record, type OmpProfileDir } from "./mcp-sources.ts";

/**
 * Per-profile MCP proof through OMP itself. A fresh `omp --mode rpc` runs against a private mirror of the
 * profile's agent config (config files and mcp.json copied, `.env` linked, one mock-model `models.yml`
 * added): `--profile P` cannot take a mock model without writing P's models.yml. OMP connects the servers
 * with its own strict stdio client; `/mcp test NAME` reports each server's tool list, and the mock model
 * makes each requested call through OMP's tool bridge. CALLABLE means the server answered one call through
 * OMP; it does not prove the answer is right.
 */
export type McpProbeStatus = "CALLABLE" | "ZERO_TOOLS" | "START_TIMEOUT" | "START_FAILED" | "CALL_FAILED" | "NOT_CALLED" | "NOT_CONFIGURED";
export interface McpCallSpec { server: string; tool: string; args: Record<string, unknown> }
export interface McpProbeServer {
	server: string;
	status: McpProbeStatus;
	tools: number | null;
	tool_names: string[];
	connect_ms: number | null;
	call: { tool: string; ms: number | null; is_error: boolean | null; result_excerpt: string } | null;
	detail: string;
}
export interface McpProbeProfile {
	profile: string;
	status: "PASS" | "FAIL";
	ready_ms: number | null;
	servers: McpProbeServer[];
	detail: string;
}
export interface McpProbeInput {
	ompPath: string;
	profiles: readonly OmpProfileDir[];
	/** Selected server names; default is every server in each profile's mcp.json. */
	servers?: readonly string[];
	calls: readonly McpCallSpec[];
	startupTimeoutMs: number;
	callTimeoutMs?: number;
	/** Private scratch root for mirrors and the decoy cwd; removed per profile. */
	workDir: string;
	env?: Record<string, string | undefined>;
}

/** `server:tool:<json object>`; the JSON part may itself contain colons. */
export function parseCallSpec(spec: string): McpCallSpec {
	const first = spec.indexOf(":"), second = spec.indexOf(":", first + 1);
	if (first <= 0 || second <= first + 1) throw new Error("INVALID_CALL");
	let args: unknown;
	try { args = JSON.parse(spec.slice(second + 1)); } catch { throw new Error("INVALID_CALL"); }
	if (!record(args)) throw new Error("INVALID_CALL");
	return { server: spec.slice(0, first), tool: spec.slice(first + 1, second), args };
}

/** OMP's MCP tool-name mint (mcp/tool-bridge.ts mintMCPToolName + capMCPToolNameLength), so the mock calls the registered name. */
export function ompMcpToolName(server: string, tool: string): string {
	const sanitize = (value: string, fallback: string) => value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "") || fallback;
	const serverPart = sanitize(server, "server");
	let toolPart = sanitize(tool, "tool");
	if (toolPart.startsWith(`${serverPart}_`)) toolPart = toolPart.slice(serverPart.length + 1);
	const name = `mcp__${serverPart}_${toolPart}`;
	if (name.length <= 64) return name;
	const suffix = Bun.hash(name).toString(36).slice(0, 8);
	return `${name.slice(0, 64 - suffix.length - 1)}_${suffix}`;
}

type RpcEvent = Record<string, unknown> & { type?: unknown };
const MOCK_PROVIDER = "omp-kit-mcp-probe";

/** OpenAI-compatible streaming mock: each tool-carrying request takes the next queued call, then says Done. */
function startMock(queue: { name: string; args: Record<string, unknown> }[]) {
	let callIndex = 0;
	return Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
		let body: unknown;
		try { body = await request.json(); } catch { body = {}; }
		const main = record(body) && Array.isArray(body.tools) && body.tools.length > 0;
		const call = main ? queue.shift() : undefined;
		const chunk = (delta: unknown, finish: string | null = null) =>
			`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const parts = [chunk({ role: "assistant" })];
		if (call) {
			callIndex++;
			parts.push(chunk({ tool_calls: [{ index: 0, id: `omp_kit_call_${callIndex}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }), chunk({}, "tool_calls"));
		} else parts.push(chunk({ content: main ? "Done." : "ok" }), chunk({}, "stop"));
		parts.push(`data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model: "mock", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`, "data: [DONE]\n\n");
		return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });
	} });
}

/** Mirror the profile's agent config privately; nothing under the real profile is written. */
function mirrorProfile(profile: OmpProfileDir, root: string, port: number): string {
	const agent = join(root, "agent");
	mkdirSync(agent, { recursive: true, mode: 0o700 });
	for (const file of ["config.yml", "config.yaml", "settings.json", "mcp.json"]) {
		const source = join(profile.agentDir, file);
		try { if (lstatSync(source).isFile()) copyFileSync(source, join(agent, file)); } catch { /* Absent file. */ }
	}
	if (existsSync(join(profile.agentDir, ".env"))) symlinkSync(join(profile.agentDir, ".env"), join(agent, ".env"));
	writeFileSync(join(agent, "models.yml"), [
		"providers:", `  ${MOCK_PROVIDER}:`, `    baseUrl: http://127.0.0.1:${port}/v1`, "    apiKey: omp-kit-mock", "    api: openai-completions",
		"    models:", "      - id: mock", "        name: mock", "        supportsTools: true", "        contextWindow: 128000", "        maxTokens: 4096", "",
	].join("\n"), { mode: 0o600 });
	return agent;
}

/** A decoy cwd: a server that resolves modules or a project from cwd breaks here, as it would in a real repo. */
function decoyCwd(root: string): string {
	const cwd = join(root, "cwd");
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	writeFileSync(join(cwd, "server.py"), "raise SystemExit('omp-kit decoy: this server imported server.py from its cwd')\n");
	writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = \"omp-kit-decoy\"\nversion = \"0.0.0\"\ndependencies = [\"omp-kit-decoy-does-not-exist==0\"]\n");
	return cwd;
}

class RpcSession {
	readonly events: { at: number; event: RpcEvent }[] = [];
	readonly started = Date.now();
	#buffer = "";
	constructor(readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">) {
		void (async () => {
			const decoder = new TextDecoder();
			for await (const bytes of child.stdout) {
				this.#buffer += decoder.decode(bytes, { stream: true });
				for (let index = this.#buffer.indexOf("\n"); index >= 0; index = this.#buffer.indexOf("\n")) {
					const line = this.#buffer.slice(0, index);
					this.#buffer = this.#buffer.slice(index + 1);
					try {
						const event: unknown = JSON.parse(line);
						if (record(event)) this.events.push({ at: Date.now(), event });
					} catch { /* Non-protocol output is not evidence. */ }
				}
			}
		})();
		// Drain stderr so a chatty session cannot block on a full pipe; it is not evidence.
		void (async () => { for await (const _ of child.stderr) { /* discard */ } })();
	}
	send(command: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(command)}\n`);
		this.child.stdin.flush();
	}
	async until(predicate: (event: RpcEvent) => boolean, ms: number, from = 0): Promise<{ at: number; event: RpcEvent } | null> {
		const deadline = Date.now() + ms;
		for (;;) {
			const found = this.events.slice(from).find(row => predicate(row.event));
			if (found) return found;
			if (Date.now() >= deadline || this.child.exitCode !== null) return null;
			await Bun.sleep(50);
		}
	}
	async close(): Promise<void> {
		try { this.child.kill("SIGTERM"); } catch { /* Already gone. */ }
		const exited = await Promise.race([this.child.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
		if (!exited) { try { this.child.kill("SIGKILL"); } catch { /* Already gone. */ } await this.child.exited; }
	}
}

function excerpt(result: unknown): string {
	const content = record(result) && Array.isArray(result.content) ? result.content : [];
	const text = content.map(part => record(part) && typeof part.text === "string" ? part.text : "").join(" ").replace(/\s+/g, " ").trim();
	return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function probeProfile(input: McpProbeInput, profile: OmpProfileDir): Promise<McpProbeProfile> {
	const configured = readProfileServers(profile.mcpPath);
	if (configured.state === "UNPARSEABLE" || configured.state === "UNSAFE")
		return { profile: profile.name, status: "FAIL", ready_ms: null, servers: [], detail: `profile mcp.json is ${configured.state}` };
	const selected = input.servers ?? [...configured.servers.keys()].sort();
	const results = new Map<string, McpProbeServer>();
	const blank = (server: string, status: McpProbeStatus, detail: string): McpProbeServer => ({ server, status, tools: null, tool_names: [], connect_ms: null, call: null, detail });
	for (const name of selected) {
		if (!configured.servers.has(name)) results.set(name, blank(name, "NOT_CONFIGURED", "absent from the profile's mcp.json"));
		else if (!configured.servers.get(name)) results.set(name, blank(name, "NOT_CONFIGURED", "disabled in the profile's mcp.json"));
	}
	const live = selected.filter(name => !results.has(name));
	if (!live.length) return finish(profile.name, selected, results, null, selected.length ? "no selected server is configured" : "profile has no MCP servers");
	const root = join(input.workDir, `mcp-${profile.name}`);
	rmSync(root, { recursive: true, force: true });
	const queue: { name: string; args: Record<string, unknown> }[] = [];
	const mock = startMock(queue);
	let session: RpcSession | undefined;
	try {
		const agent = mirrorProfile(profile, root, mock.port);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(input.env ?? process.env)) if (value !== undefined) env[key] = value;
		delete env.OMP_PROFILE; delete env.PI_PROFILE;
		env.PI_CODING_AGENT_DIR = agent;
		env.OMP_MCP_STARTUP_TIMEOUT_MS = String(input.startupTimeoutMs);
		session = new RpcSession(Bun.spawn([input.ompPath, "--mode", "rpc", "--no-session", "--no-title", "--model", `${MOCK_PROVIDER}/mock`, "--approval-mode", "yolo"],
			{ cwd: decoyCwd(root), env, stdin: "pipe", stdout: "pipe", stderr: "pipe" }));
		const ready = await session.until(event => event.type === "ready", input.startupTimeoutMs + 60_000);
		if (!ready) {
			for (const name of live) results.set(name, blank(name, "START_TIMEOUT", "OMP rpc session did not become ready within the startup bound"));
			return finish(profile.name, selected, results, null, "OMP rpc session never reported ready");
		}
		const readyMs = ready.at - session.started;
		for (const [index, name] of live.entries()) {
			const from = session.events.length, sent = Date.now(), id = `omp-kit-test-${index}`;
			session.send({ id, type: "prompt", message: `/mcp test ${name}` });
			const response = await session.until(event => event.type === "response" && event.id === id, input.startupTimeoutMs + 15_000, from);
			const ms = (response?.at ?? Date.now()) - sent;
			const output = session.events.slice(from).filter(row => row.event.type === "command_output").map(row => String(row.event.text ?? "")).join("\n");
			const connected = new RegExp(`^Server ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} connected \\((\\d+) tools\\)\\.`, "m").exec(output);
			if (connected) {
				const names = output.split("\n").filter(line => line.startsWith("  - ")).map(line => line.slice(4));
				const count = Number(connected[1]);
				results.set(name, { ...blank(name, count === 0 ? "ZERO_TOOLS" : "NOT_CALLED", count === 0 ? "connected but listed 0 tools" : "tools listed; no --call given for this server"),
					tools: count, tool_names: names, connect_ms: ms });
			} else if (!response) results.set(name, { ...blank(name, "START_TIMEOUT", `no /mcp test answer within ${input.startupTimeoutMs + 15_000} ms`), connect_ms: ms });
			else results.set(name, { ...blank(name, /timed out|timeout/i.test(output) ? "START_TIMEOUT" : "START_FAILED", output.slice(0, 400) || "no /mcp test output"), connect_ms: ms });
		}
		const planned: { id: string; spec: McpCallSpec }[] = [];
		for (const spec of input.calls) {
			const row = results.get(spec.server);
			if (!row || row.status !== "NOT_CALLED") continue;
			if (!row.tool_names.includes(spec.tool)) { results.set(spec.server, { ...row, status: "CALL_FAILED", detail: `tool ${spec.tool} is not in the listed tools` }); continue; }
			queue.push({ name: ompMcpToolName(spec.server, spec.tool), args: spec.args });
			planned.push({ id: `omp_kit_call_${planned.length + 1}`, spec });
		}
		if (planned.length) {
			const from = session.events.length;
			session.send({ id: "omp-kit-calls", type: "prompt", message: "omp-kit MCP probe: run the scripted calls." });
			const ended = await session.until(event => event.type === "agent_end", (input.callTimeoutMs ?? 120_000) * planned.length + 30_000, from);
			const window = session.events.slice(from);
			for (const { id, spec } of planned) {
				const row = results.get(spec.server)!;
				const start = window.find(entry => entry.event.type === "tool_execution_start" && entry.event.toolCallId === id);
				const end = window.find(entry => entry.event.type === "tool_execution_end" && entry.event.toolCallId === id);
				const details = record(end?.event.result) && record(end.event.result.details) ? end.event.result.details : {};
				const isError = end ? end.event.isError === true : null;
				const answered = end !== undefined && isError === false && details.serverName === spec.server;
				results.set(spec.server, { ...row, status: answered ? "CALLABLE" : "CALL_FAILED",
					call: { tool: spec.tool, ms: start && end ? end.at - start.at : null, is_error: isError, result_excerpt: end ? excerpt(end.event.result) : "" },
					detail: answered ? "listed tools and answered one call through OMP (correctness of the answer is not judged)"
						: !end ? (ended ? "OMP never executed the call" : "call did not finish within the call bound")
						: isError ? "the call returned an error" : `the call was answered by ${String(details.serverName)}, not ${spec.server}` });
			}
		}
		return finish(profile.name, selected, results, readyMs, "");
	} finally {
		await session?.close();
		mock.stop(true);
		rmSync(root, { recursive: true, force: true });
	}
}

function finish(profile: string, selected: readonly string[], results: Map<string, McpProbeServer>, readyMs: number | null, detail: string): McpProbeProfile {
	const servers = selected.map(name => results.get(name)!);
	return { profile, status: servers.length && servers.every(row => row.status === "CALLABLE") ? "PASS" : "FAIL", ready_ms: readyMs, servers, detail };
}

/** Profiles run one at a time: each OMP session starts every configured server of that profile. */
export async function probeMcpProfiles(input: McpProbeInput): Promise<McpProbeProfile[]> {
	const rows: McpProbeProfile[] = [];
	for (const profile of input.profiles) rows.push(await probeProfile(input, profile));
	return rows;
}
