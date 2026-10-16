import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inspectMcpReadiness, judgeTimeoutFit, mcpExample, readProbeEvidence, readStartupFailures } from "../../src/mcp-readiness.ts";

const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const base = join(import.meta.dir, "../../var/agent-tmp");
 const root = mkdtempSync(join(base, "mcp-readiness-"));
 fixtures.push(root);
 const home = join(root, "home");
 const project = join(root, "project");
 const bin = join(root, "bin");
 mkdirSync(home); mkdirSync(project); mkdirSync(bin);
 const profile = (name: string) => { const path = join(home, ".omp", "profiles", name, "agent"); mkdirSync(path, { recursive: true }); return path; };
 const binary = () => { const path = join(bin, "fixture-mcp"); writeFileSync(path, "#!/bin/sh\necho unsafe > forbidden\n"); chmodSync(path, 0o755); return path; };
 const config = (dir: string, command: string, name = "fixture") => writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { command, args: ["--demo"], env: { SECRET_TOKEN: "sensitive-config-value" } } } }));
 const inspect = (name = "alpha") => inspectMcpReadiness({ home, profile: name, project, pathEnv: bin });
 return { root, home, project, bin, profile, binary, config, inspect };
}
function tree(dir: string): string[] { return readdirSync(dir).sort().flatMap(name => { const path = join(dir, name); const stat = lstatSync(path); return stat.isDirectory() ? [`${name}:dir:${stat.mode & 0o777}`, ...tree(path).map(line => `${name}/${line}`)] : [`${name}:file:${stat.mode & 0o777}:${readFileSync(path).toString("hex")}`]; }); }

test("on-disk native named profile is configured but never startup-ready or callable from inventory", () => {
 const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary(); f.config(dir, exe);
 const before = [tree(f.home), tree(f.project), tree(f.bin)];
 const report = f.inspect();
 expect(report.status).toBe("UNVERIFIED");
 expect(report.servers).toEqual([expect.objectContaining({ name: "fixture", configured: true, startup_ready: "NOT_PROBED", actually_callable: "NOT_PROBED" })]);
 expect(JSON.stringify(report)).not.toContain("sensitive-config-value");
 expect(JSON.stringify(report)).not.toContain(exe);
 expect([tree(f.home), tree(f.project), tree(f.bin)]).toEqual(before);
 expect(existsSync(join(f.project, "forbidden"))).toBe(false);
});

test("missing executable and removed named profile are not discovery candidates", () => {
 const f = fixture(); f.config(f.profile("alpha"), "missing-fixture-mcp");
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", executable_found: false, startup_ready: "NOT_PROBED" }));
 rmSync(join(f.home, ".omp", "profiles", "alpha"), { recursive: true });
 expect(f.inspect()).toEqual(expect.objectContaining({ status: "DEGRADED", servers: [], reason: expect.stringContaining("removed") }));
 expect(existsSync(join(f.home, ".omp", "profiles", "alpha"))).toBe(false);
});

test("invalid JSON, duplicate profile entries and unknown OMP source refuse discovery", () => {
 const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary(); f.config(dir, exe);
 writeFileSync(join(dir, "mcp.json"), "{ malformed");
 expect(f.inspect()).toEqual(expect.objectContaining({ status: "UNVERIFIED", servers: [], reason: expect.stringContaining("malformed") }));
 f.config(dir, exe);
 writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: exe } } }));
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("duplicate") }));
});

test("project override, provider disabled and configured false cannot be promoted to startup", () => {
 const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary(); f.config(dir, exe);
 mkdirSync(join(f.project, ".omp"));
 writeFileSync(join(f.project, ".omp", "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: "/nonexistent/override" } } }));
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("project") }));
 rmSync(join(f.project, ".omp", "mcp.json"));
 writeFileSync(join(dir, "config.yml"), "disabledProviders: [native]\n");
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("disabled") }));
 writeFileSync(join(dir, "config.yml"), "disabledProviders: []\n");
 writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: exe, enabled: false } } }));
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("disabled") }));
});

test("string-disabled and MCP denylisted names never become discovery candidates", () => {
 const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary();
 writeFileSync(join(dir, "config.yml"), "disabledProviders: []\n");
 writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: exe, enabled: "false" } } }));
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("disabled") }));
 writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: exe } }, disabledServers: ["fixture"] }));
 expect(f.inspect().servers[0]).toEqual(expect.objectContaining({ discoverable: "BLOCKED", reason: expect.stringContaining("disabled") }));
});

test("manual recipe uses placeholders and never invokes or writes selected executable", () => {
 const f = fixture(); const before = [tree(f.home), tree(f.project)];
 const recipe = mcpExample();
 expect(recipe).toContain("YOUR_EXISTING_MCP_EXECUTABLE");
 expect(recipe).toContain("--profile NAME");
 expect(recipe).toContain("mcpServers");
 expect(recipe).toContain("NOT_PROBED");
 expect([tree(f.home), tree(f.project)]).toEqual(before);
});

test("configured slow fixture remains NOT_PROBED, without waiting for or spawning it", () => {
 const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary();
 writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { slow: { command: exe, args: ["--hang"], timeout: 1 } } }));
 const before = tree(f.home);
 const report = f.inspect();
 expect(report.servers[0]).toEqual(expect.objectContaining({ startup_ready: "NOT_PROBED", actually_callable: "NOT_PROBED" }));
 expect(tree(f.home)).toEqual(before);
 expect(existsSync(join(f.project, "forbidden"))).toBe(false);
});

// Deliberately opt-in: the only server process is this shipped fixture, with a
// loopback scripted model. A real-model credential is never inherited.
const liveTest = process.env.OMP_KIT_MCP_LIVE === "1" ? test : test.skip;
liveTest("real OMP proves two named calls and rejects disabled or timed-out fixture discovery", async () => {
 const f = fixture();
 const omp = process.env.OMP_KIT_MCP_OMP ?? Bun.which("omp");
 if (!omp) throw new Error("Installed OMP launcher required");
 const packageRoot = dirname(dirname(realpathSync(omp)));
 const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
 if (metadata.name !== "@oh-my-pi/pi-coding-agent" || metadata.version !== "18.4.2") throw new Error("Unknown OMP version: source-backed MCP proof refused");
 const fixtureServer = join(import.meta.dir, "../../examples/mcp/fixture-server.mjs");
 const mockServer = join(import.meta.dir, "../live/mock-model.mjs");
 const home = f.home;
 const xdg = ["config", "cache", "data", "state"].map(name => join(home, `.xdg-${name}`));
 const tmp = join(f.root, "tmp");
 for (const dir of [...xdg, tmp, join(home, ".bun")]) mkdirSync(dir, { recursive: true });
 for (const profile of ["alpha", "beta", "gamma", "delta"]) {
  const agent = f.profile(profile);
  const callLog = join(f.root, `${profile}-mcp-call`);
  const modelLog = join(f.root, `${profile}-model-log`);
  const portfile = join(f.root, `${profile}-model-port`);
  const scenario = join(f.root, `${profile}-scenario.json`);
  writeFileSync(join(agent, "config.yml"), `${profile === "gamma" ? "disabledProviders: [native]\n" : ""}memory:\n  backend: off\nmcp:\n  startupTimeoutMs: 5000\n`);
  writeFileSync(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { fixture: { type: "stdio", command: process.execPath, args: profile === "delta" ? [fixtureServer, "--hang"] : [fixtureServer], timeout: profile === "delta" ? 250 : 5000, env: { OMP_KIT_FIXTURE_CALL_LOG: callLog } } } }));
  writeFileSync(scenario, JSON.stringify({ turns: [{ tool: { name: "mcp__fixture_proof", args: {} } }, { text: "Done." }] }));
  const mock = Bun.spawn([process.execPath, mockServer], { cwd: f.project, env: { HOME: home, PATH: process.env.PATH ?? "", SCEN: scenario, LOG: modelLog, PORTFILE: portfile }, stdout: "pipe", stderr: "pipe" });
  try {
   // External process readiness has no event channel; bound the port-file predicate.
   for (let i = 0; i < 100 && !existsSync(portfile); i++) await Bun.sleep(50);
   if (!existsSync(portfile)) throw new Error(`loopback model did not bind for ${profile}`);
   const port = readFileSync(portfile, "utf8").trim();
   writeFileSync(join(agent, "models.yml"), `providers:\n  mock:\n    baseUrl: http://127.0.0.1:${port}/v1\n    apiKey: sk-mock\n    api: openai-completions\n    models:\n      - id: mock\n        name: mock\n        supportsTools: true\n        contextWindow: 128000\n        maxTokens: 4096\n`);
   const env = { HOME: home, PATH: process.env.PATH ?? "", XDG_CONFIG_HOME: xdg[0]!, XDG_CACHE_HOME: xdg[1]!, XDG_DATA_HOME: xdg[2]!, XDG_STATE_HOME: xdg[3]!, TMPDIR: tmp, BUN_INSTALL: join(home, ".bun"), OMP_MCP_REQUIRE_READY: "1", CI: "true", OMP_PROFILE: profile };
   const child = Bun.spawn([omp, "--profile", profile, "-p", "--no-session", "--model", "mock/mock", "--approval-mode", "yolo", "Call fixture proof tool, then stop."], { cwd: f.project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
   // Timeout protects the opt-in real subprocess; fake timers cannot advance it.
   const timer = setTimeout(() => child.kill(), 45000);
   let code: number; let stdout: string; let stderr: string;
   try { [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); }
   finally { clearTimeout(timer); }
   const requests = existsSync(modelLog) ? readFileSync(modelLog, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
   if (profile === "delta") {
    expect(code).toBe(1);
    expect(stderr).toContain("timed out after 250ms");
    expect(stderr).toContain("MCP servers not ready: fixture");
    expect(existsSync(callLog)).toBe(false);
    continue;
   }
   if (code !== 0) throw new Error(`Isolated OMP MCP process failed for ${profile}: exit=${code}, stderr=${stderr.slice(0, 300)}, stdout=${stdout.slice(0, 300)}`);
   const transcript = JSON.stringify(requests.at(-1)?.body?.messages);
   if (profile === "gamma") {
    expect(existsSync(callLog)).toBe(false);
    expect(transcript).not.toContain("omp-kit-fixture-call-ok");
   } else {
    expect(existsSync(callLog)).toBe(true);
    expect(readFileSync(callLog, "utf8")).toBe("proof-called\n");
    expect(transcript).toContain("omp-kit-fixture-call-ok");
   }
  } finally { mock.kill(); await mock.exited; }
 }
}, 120000);

test("timeout fit judges configured timeout against probe evidence with a fix", () => {
	expect(judgeTimeoutFit(30000, { server: "rea", maxCallMs: 54000, recentTimeouts: [] }))
		.toEqual({ fit: "DRIFT", measuredMs: 54000, suggestedMs: 600000, fix: "rea=600000" });
	expect(judgeTimeoutFit(600000, { server: "rea", maxCallMs: 54000, recentTimeouts: [] }))
		.toMatchObject({ fit: "ALIGNED", fix: null });
	expect(judgeTimeoutFit(null, { server: "r", maxCallMs: null, recentTimeouts: [] }).fit).toBe("UNPROBED");
	expect(judgeTimeoutFit(600000, { server: "r", maxCallMs: 1000, recentTimeouts: [{ at: "2026-10-15T00:00:00Z", kind: "call" }] }).fit).toBe("DRIFT");
	expect(judgeTimeoutFit(null, { server: "r", maxCallMs: 54000, recentTimeouts: [] }).fit).toBe("DRIFT");
});

test("probe evidence and startup failures read from fixture state and log dirs", () => {
	const f = fixture();
	const state = join(f.root, "state");
	mkdirSync(join(state, "mcp-tests"), { recursive: true });
	writeFileSync(join(state, "mcp-tests", "mcp-test-old.json"), JSON.stringify({ recorded_at: "2026-10-10T00:00:00Z",
		profiles: [{ profile: "alpha", status: "PASS", servers: [{ server: "rea", status: "CALLABLE", connect_ms: 100,
			call: { tool: "t", ms: 54000, bound_ms: 60000 } }] }] }));
	writeFileSync(join(state, "mcp-tests", "mcp-test-new.json"), JSON.stringify({ recorded_at: "2026-10-15T00:00:00Z",
		profiles: [{ profile: "alpha", status: "FAIL", servers: [{ server: "rea", status: "CALL_TIMEOUT", connect_ms: 200, call: null },
			{ server: "other", status: "CALLABLE", connect_ms: 50, call: { tool: "t", ms: 1200, bound_ms: 120000 } }] }] }));
	writeFileSync(join(state, "mcp-tests", "malformed.json"), "{ malformed");
	const evidence = readProbeEvidence(state, "alpha");
	expect(evidence.find(row => row.server === "rea")).toMatchObject({ maxCallMs: 54000, recentTimeouts: [{ kind: "call" }] });
	expect(evidence.find(row => row.server === "other")).toMatchObject({ maxCallMs: 1200, recentTimeouts: [] });
	expect(readProbeEvidence(state, "beta")).toEqual([]);
	expect(readProbeEvidence(join(f.root, "missing"), "alpha")).toEqual([]);
	const logs = join(f.root, "logs");
	mkdirSync(logs);
	writeFileSync(join(logs, "omp.2026-10-15.1.log"),
		`${JSON.stringify({ timestamp: "2026-10-15T07:51:46-06:00", level: "error", message: "MCP tool load failed", path: "mcp:chatty", error: "Failed to parse JSONL" })}\nnot json\n${JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", level: "error", message: "MCP tool load failed", path: "mcp:old", error: "x" })}\n`);
	const failures = readStartupFailures(logs, Date.parse("2026-10-14T00:00:00Z"));
	expect(failures).toEqual([{ server: "chatty", at: "2026-10-15T07:51:46-06:00", error: "Failed to parse JSONL" }]);
	expect(readStartupFailures(join(f.root, "missing"), Date.now())).toEqual([]);
});

const DOCTOR_CLI = join(import.meta.dir, "../../src/cli.ts");
const DOCTOR_OMP = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
function doctorCli(args: string[], home: string, state: string, cwd: string) {
	const result = Bun.spawnSync([process.execPath, DOCTOR_CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, HOME: home, XDG_STATE_HOME: state, TMPDIR: join(home, "tmp"),
			PATH: `${dirname(DOCTOR_OMP!)}:${dirname(process.execPath)}:/usr/bin:/bin` } });
	return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("doctor reports DRIFT with the fix at 30 s against a recorded 54 s call, ALIGNED at 600 s", () => {
	if (!DOCTOR_OMP) throw new Error("doctor acceptance needs an installed OMP on PATH");
	const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary();
	const state = join(f.root, "state"); const cwd = join(f.root, "cwd");
	mkdirSync(join(state, "omp-kit", "mcp-tests"), { recursive: true }); mkdirSync(cwd, { recursive: true }); mkdirSync(join(f.home, "tmp"), { recursive: true });
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { rea: { command: exe, timeout: 30000 } } }));
	writeFileSync(join(state, "omp-kit", "mcp-tests", "mcp-test-1.json"), JSON.stringify({ recorded_at: "2026-10-15T00:00:00Z",
		profiles: [{ profile: "alpha", status: "PASS", servers: [{ server: "rea", status: "CALLABLE", connect_ms: 100,
			call: { tool: "t", ms: 54000, bound_ms: 60000 } }] }] }));
	const drifted = doctorCli(["doctor", "--scope", "mcp", "--profile", "alpha", "--json"], f.home, state, cwd);
	expect(drifted.code).toBe(0);
	const rea = JSON.parse(drifted.stdout).data.findings[0].evidence.servers.find((row: { name: string }) => row.name === "rea");
	expect(rea).toMatchObject({ timeout_ms: 30000, timeout_fit: "DRIFT", measured_ms: 54000, timeout_fix: "rea=600000" });
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { rea: { command: exe, timeout: 600000 } } }));
	const aligned = doctorCli(["doctor", "--scope", "mcp", "--profile", "alpha", "--json"], f.home, state, cwd);
	expect(aligned.code).toBe(0);
	expect(JSON.parse(aligned.stdout).data.findings[0].evidence.servers.find((row: { name: string }) => row.name === "rea"))
		.toMatchObject({ timeout_ms: 600000, timeout_fit: "ALIGNED", timeout_fix: null });
});

test("doctor reports START_FAILED for a server failing at session start, OK for a probed healthy one", () => {
	if (!DOCTOR_OMP) throw new Error("doctor acceptance needs an installed OMP on PATH");
	const f = fixture(); const dir = f.profile("alpha"); const exe = f.binary();
	const state = join(f.root, "state"); const cwd = join(f.root, "cwd");
	mkdirSync(join(state, "omp-kit", "mcp-tests"), { recursive: true }); mkdirSync(cwd, { recursive: true }); mkdirSync(join(f.home, "tmp"), { recursive: true });
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { chatty: { command: exe }, healthy: { command: exe }, fresh: { command: exe } } }));
	writeFileSync(join(state, "omp-kit", "mcp-tests", "mcp-test-1.json"), JSON.stringify({ recorded_at: "2026-10-15T00:00:00Z",
		profiles: [{ profile: "alpha", status: "PASS", servers: [{ server: "healthy", status: "CALLABLE", connect_ms: 50,
			call: { tool: "t", ms: 800, bound_ms: 120000 } }] }] }));
	const logs = join(f.home, ".omp", "logs");
	mkdirSync(logs, { recursive: true });
	writeFileSync(join(logs, "omp.2026-10-15.1.log"), `${JSON.stringify({ timestamp: new Date(Date.now() - 3600000).toISOString(),
		level: "error", message: "MCP tool load failed", path: "mcp:chatty", error: "MCP subprocess closed stdout before responding" })}\n`);
	const result = doctorCli(["doctor", "--scope", "mcp", "--profile", "alpha", "--json"], f.home, state, cwd);
	expect(result.code).toBe(0);
	const servers = JSON.parse(result.stdout).data.findings[0].evidence.servers;
	expect(servers.find((row: { name: string }) => row.name === "chatty")).toMatchObject({ startup: "START_FAILED" });
	expect(servers.find((row: { name: string }) => row.name === "healthy")).toMatchObject({ startup: "OK" });
	expect(servers.find((row: { name: string }) => row.name === "fresh")).toMatchObject({ startup: "UNKNOWN" });
});
