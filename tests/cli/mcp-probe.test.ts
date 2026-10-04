import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ompMcpToolName, parseCallSpec, probeMcpProfiles } from "../../src/mcp-probe.ts";

const OMP = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
if (!OMP) throw new Error("mcp-probe tests require an installed OMP on PATH: the proof runs through OMP itself");
const FAKE = join(import.meta.dir, "mcp-fake-server.ts");
const CLI = join(import.meta.dir, "../../src/cli.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(modes: Record<string, string>) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-probe-"));
	roots.push(root);
	const home = join(root, "home"), agentDir = join(home, ".omp", "profiles", "alpha", "agent"), work = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(work);
	const mcpPath = join(agentDir, "mcp.json");
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(modes).map(([name, mode]) => [name, { command: process.execPath, args: [FAKE, mode] }])) }));
	return { root, home, work, mcpPath, profile: { name: "alpha", agentDir, mcpPath } };
}

test("a server that lists 0 tools is ZERO_TOOLS, never a pass, and the CLI exits non-zero with a receipt", async () => {
	const f = fixture({ empty: "zero" });
	const [row] = await probeMcpProfiles({ ompPath: OMP!, profiles: [f.profile], calls: [], startupTimeoutMs: 30_000, workDir: f.work });
	expect(row!.servers).toEqual([expect.objectContaining({ server: "empty", status: "ZERO_TOOLS", tools: 0 })]);
	expect(row!.status).toBe("FAIL");
	const before = readFileSync(f.mcpPath);
	const result = Bun.spawnSync([process.execPath, CLI, "test", "--mcp", "--profiles", "alpha", "--startup-timeout-ms", "30000", "--json"], {
		cwd: f.root, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.root, "state"), TMPDIR: f.root, PATH: `${dirname(OMP!)}:${dirname(process.execPath)}:/usr/bin:/bin` } });
	expect(result.exitCode).toBe(1);
	const envelope = JSON.parse(result.stdout.toString());
	expect(envelope.data.overall).toBe("FAIL");
	expect(envelope.data.mcp.profiles[0].servers[0].status).toBe("ZERO_TOOLS");
	expect(readdirSync(join(f.root, "state", "omp-kit", "mcp-tests"))).toEqual([`${envelope.data.mcp.receipt_id}.json`]);
	expect(readFileSync(f.mcpPath)).toEqual(before);
	expect(existsSync(join(f.home, ".omp", "profiles", "alpha", "agent", "models.yml"))).toBe(false);
}, 120_000);

test("a server that answers the requested call through OMP is CALLABLE; an error result is CALL_FAILED", async () => {
	const f = fixture({ echo: "echo", broken: "fail" });
	const [row] = await probeMcpProfiles({ ompPath: OMP!, profiles: [f.profile], startupTimeoutMs: 30_000, workDir: f.work,
		calls: [parseCallSpec("echo:echo:{\"text\":\"proof:1\"}"), parseCallSpec("broken:echo:{\"text\":\"x\"}")] });
	const echo = row!.servers.find(server => server.server === "echo")!;
	expect(echo).toMatchObject({ status: "CALLABLE", tools: 1, tool_names: ["echo"], call: { tool: "echo", is_error: false, result_excerpt: "echo:proof:1" } });
	expect(row!.servers.find(server => server.server === "broken")).toMatchObject({ status: "CALL_FAILED", call: { is_error: true } });
	expect(readdirSync(f.work)).toEqual([]);
}, 120_000);
test("a server that prints a non-JSON banner on stdout fails under OMP's strict reader, from a decoy cwd", async () => {
	const f = fixture({ chatty: "banner" });
	const [row] = await probeMcpProfiles({ ompPath: OMP!, profiles: [f.profile], servers: ["chatty", "absent"], startupTimeoutMs: 30_000, workDir: f.work,
		calls: [parseCallSpec("chatty:echo:{\"text\":\"x\"}")] });
	expect(row!.servers).toEqual([
		expect.objectContaining({ server: "chatty", status: "START_FAILED" }),
		expect.objectContaining({ server: "absent", status: "NOT_CONFIGURED" }),
	]);
	expect(row!.status).toBe("FAIL");
}, 120_000);

test("call specs and OMP tool names parse the way OMP mints them", () => {
	expect(parseCallSpec("z3-prover:solve:{\"a\":\"b:c\"}")).toEqual({ server: "z3-prover", tool: "solve", args: { a: "b:c" } });
	expect(() => parseCallSpec("z3-prover:solve:[1]")).toThrow("INVALID_CALL");
	expect(ompMcpToolName("z3-prover", "solve")).toBe("mcp__z3_prover_solve");
	expect(ompMcpToolName("puppeteer", "puppeteer_screenshot")).toBe("mcp__puppeteer_screenshot");
	expect(ompMcpToolName("s", "t".repeat(80))).toHaveLength(64);
});
