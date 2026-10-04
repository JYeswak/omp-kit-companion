import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectMcpSources } from "../../src/mcp-sources.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const PLANTED_ENV_VALUE = "planted-env-value-should-never-appear";
const PLANTED_TOKEN = ["ghp", "PLANTEDTOKENVALUE0123456789abcdef"].join("_");

test("sources inventory reads every harness config, shows env as names only, and maps every enumerated profile", () => {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-sources-"));
	roots.push(root);
	const home = join(root, "home"), cwd = join(root, "project");
	for (const dir of [join(home, ".omp", "agent"), join(home, ".omp", "profiles", "work", "agent"), join(home, ".omp", "profiles", "off", "agent"), join(home, ".cursor"), join(home, ".codex"), cwd])
		mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { calc: { type: "stdio", command: "calc-mcp", args: ["--token", PLANTED_TOKEN], env: { CALC_KEY: PLANTED_ENV_VALUE } } } }));
	writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { web: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: PLANTED_ENV_VALUE } } } }));
	writeFileSync(join(home, ".codex", "config.toml"), "[mcp_servers.toml-server]\ncommand = \"toml-mcp\"\nargs = [\"serve\"]\n");
	writeFileSync(join(cwd, ".mcp.json"), "{not json");
	writeFileSync(join(home, ".omp", "profiles", "work", "agent", "mcp.json"), JSON.stringify({ mcpServers: { calc: { command: "calc-mcp" } } }));
	writeFileSync(join(home, ".omp", "profiles", "off", "agent", "mcp.json"), JSON.stringify({ mcpServers: { calc: { command: "calc-mcp" } }, disabledServers: ["calc"] }));
	const before = readdirSync(home, { recursive: true }).map(String).sort().map(path => `${path}:${statSync(join(home, path)).mtimeMs}`);
	const report = inspectMcpSources(home, cwd);
	const text = JSON.stringify(report);
	expect(text).not.toContain(PLANTED_ENV_VALUE);
	expect(text).not.toContain(PLANTED_TOKEN);
	const claude = report.sources.find(source => source.id === "claude")!;
	expect(claude.servers).toEqual([expect.objectContaining({ name: "calc", env_names: ["CALC_KEY"], args: ["--token", "<redacted: likely secret>"] })]);
	expect(report.sources.find(source => source.id === "cursor")!.servers).toEqual([expect.objectContaining({ name: "web", transport: "http", header_names: ["Authorization"] })]);
	expect(report.sources.find(source => source.id === "codex")!.servers.map(server => server.name)).toEqual(["toml-server"]);
	expect(report.sources.find(source => source.id === "project")!.status).toBe("UNPARSEABLE");
	expect(report.profiles).toEqual(["default", "off", "work"]);
	expect(report.matrix.calc).toEqual({ default: "ABSENT", off: "DISABLED", work: "CONFIGURED" });
	expect(readdirSync(home, { recursive: true }).map(String).sort().map(path => `${path}:${statSync(join(home, path)).mtimeMs}`)).toEqual(before);
});
