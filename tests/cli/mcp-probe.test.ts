import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ERROR_TEXT, judgeResult, ompMcpToolName, parseCallSpec, parseExpectSpec, probeMcpProfiles, RESULT_TEXT_CAP } from "../../src/mcp-probe.ts";

const OMP = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
if (!OMP) throw new Error("mcp-probe tests require an installed OMP on PATH: the proof runs through OMP itself");
const FAKE = join(import.meta.dir, "mcp-fake-server.ts");
const CLI = join(import.meta.dir, "../../src/cli.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
/** Each server: a fake-server mode, or a mode plus the env values its mcp.json entry carries. */
function fixture(modes: Record<string, string | { mode: string; env: Record<string, string> }>, dotenv?: string) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-probe-"));
	roots.push(root);
	const home = join(root, "home"), agentDir = join(home, ".omp", "profiles", "alpha", "agent"), work = join(root, "work");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(work);
	const mcpPath = join(agentDir, "mcp.json");
	writeFileSync(mcpPath, JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(modes).map(([name, spec]) => [name, typeof spec === "string"
		? { command: process.execPath, args: [FAKE, spec] } : { command: process.execPath, args: [FAKE, spec.mode], env: spec.env }])) }));
	if (dotenv !== undefined) writeFileSync(join(agentDir, ".env"), dotenv);
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

test("only an answer that matches --expect without error-shaped text is CALLABLE; a 401 text with isError false is CALL_FAILED", async () => {
	// OMP folds servers with identical launch configs into one, so the echo variants differ by a literal env tag.
	const f = fixture({ echo: "echo", plain: { mode: "echo", env: { TAG: "plain" } }, wrong: { mode: "echo", env: { TAG: "wrong" } }, broken: "fail", auth: "auth" });
	const call = (spec: string, expect?: string) => ({ ...parseCallSpec(spec), ...(expect === undefined ? {} : { expect }) });
	const [row] = await probeMcpProfiles({ ompPath: OMP!, profiles: [f.profile], startupTimeoutMs: 30_000, workDir: f.work,
		calls: [call("echo:echo:{\"text\":\"proof:1\"}", "^echo:proof:1$"), call("plain:echo:{\"text\":\"x\"}"), call("wrong:echo:{\"text\":\"x\"}", "^nine$"),
			call("broken:echo:{\"text\":\"x\"}", "."), call("auth:echo:{\"text\":\"x\"}", ".")] });
	const by = (name: string) => row!.servers.find(server => server.server === name)!;
	expect(by("echo")).toMatchObject({ status: "CALLABLE", tools: 1, tool_names: ["echo"], call: { tool: "echo", is_error: false, result_excerpt: "echo:proof:1", expect_matched: true, error_text: false } });
	expect(by("plain")).toMatchObject({ status: "UNVERIFIED_RESULT", call: { is_error: false, expect: null, expect_matched: null } });
	expect(by("wrong")).toMatchObject({ status: "CALL_FAILED", call: { is_error: false, expect_matched: false } });
	expect(by("broken")).toMatchObject({ status: "CALL_FAILED", call: { is_error: true } });
	// The wolfram-alpha case: auth failure as normal text, isError false, and an --expect that matches anything still fails.
	expect(by("auth")).toMatchObject({ status: "CALL_FAILED", call: { is_error: false, error_text: true, expect_matched: true } });
	expect(row!.status).toBe("FAIL");
	expect(readdirSync(f.work)).toEqual([]);
}, 120_000);

test("the CLI reports the auth-error server CALL_FAILED and exits 1; --expect needs a --call for its server", () => {
	const f = fixture({ auth: "auth" });
	const env = { ...process.env, HOME: f.home, XDG_STATE_HOME: join(f.root, "state"), TMPDIR: f.root, PATH: `${dirname(OMP!)}:${dirname(process.execPath)}:/usr/bin:/bin` };
	const run = (extra: string[]) => Bun.spawnSync([process.execPath, CLI, "test", "--mcp", "--profiles", "alpha", "--startup-timeout-ms", "30000", "--json", ...extra], { cwd: f.root, stdout: "pipe", stderr: "pipe", env });
	const result = run(["--call", "auth:echo:{\"text\":\"x\"}", "--expect", "auth:HTTP"]);
	expect(result.exitCode).toBe(1);
	const server = JSON.parse(result.stdout.toString()).data.mcp.profiles[0].servers[0];
	expect(server).toMatchObject({ server: "auth", status: "CALL_FAILED", call: { is_error: false, error_text: true } });
	const orphan = run(["--expect", "auth:x"]);
	expect(orphan.exitCode).not.toBe(0);
	expect(orphan.stdout.toString() + orphan.stderr.toString()).toContain("INVALID_EXPECT");
	const unparsable = run(["--call", "auth:echo:{}", "--expect", "auth:("]);
	expect(unparsable.stdout.toString() + unparsable.stderr.toString()).toContain("INVALID_EXPECT");
}, 120_000);

test("an env reference unset where OMP runs is ENV_UNSET and a failing !command is COMMAND_FAILED, never a pass", async () => {
	const unset = "OMP_KIT_TEST_UNSET_9F3A";
	const f = fixture({
		unsetref: { mode: "echo", env: { APP_ID: unset } },
		setref: { mode: "echo", env: { APP_ID: "OMP_KIT_TEST_SET_9F3A" } },
		dotref: { mode: "echo", env: { APP_ID: "OMP_KIT_TEST_DOTENV_9F3A" } },
		cmdfail: { mode: "echo", env: { APP_ID: "!exit 3" } },
		cmdempty: { mode: "echo", env: { APP_ID: "!true" } },
		cmdok: { mode: "echo", env: { APP_ID: "!printf command-output-never-shown", MODE: "fast-literal" } },
	}, "OMP_KIT_TEST_DOTENV_9F3A=from-dotenv\n");
	const env = { ...process.env, OMP_KIT_TEST_SET_9F3A: "present" };
	delete env[unset];
	const calls = ["unsetref", "setref", "dotref", "cmdfail", "cmdok"].map(name => ({ ...parseCallSpec(`${name}:echo:{"text":"x"}`), expect: "^echo:x$" }));
	const [row] = await probeMcpProfiles({ ompPath: OMP!, profiles: [f.profile], startupTimeoutMs: 30_000, workDir: f.work, env, calls });
	const by = (name: string) => row!.servers.find(server => server.server === name)!;
	expect(by("unsetref")).toMatchObject({ status: "ENV_UNSET", env: [{ key: "APP_ID", kind: "name", var: unset, state: "UNSET" }] });
	expect(by("unsetref").detail).toContain(unset);
	expect(by("setref")).toMatchObject({ status: "CALLABLE", env: [{ kind: "name", state: "SET" }] });
	expect(by("dotref")).toMatchObject({ status: "CALLABLE", env: [{ kind: "name", state: "SET" }] });
	expect(by("cmdfail")).toMatchObject({ status: "COMMAND_FAILED", env: [{ kind: "command", state: "FAILED" }] });
	expect(by("cmdempty")).toMatchObject({ status: "COMMAND_FAILED", env: [{ kind: "command", state: "FAILED" }] });
	expect(by("cmdok")).toMatchObject({ status: "CALLABLE", env: [{ key: "APP_ID", kind: "command", state: "OK" }, { key: "MODE", kind: "literal", state: "NOT_CHECKED" }] });
	expect(JSON.stringify(row)).not.toContain("command-output-never-shown");
	expect(row!.status).toBe("FAIL");
}, 120_000);

test("the error-text check fires on auth and HTTP 4xx/5xx text, stays quiet on answers, and is linear on near-misses", () => {
	for (const text of ["WOLFRAM_AUTH_ERROR (HTTP 401)", "AUTH_ERROR", "upstream said HTTP 503", "401 Unauthorized", "403 Forbidden: key"])
		expect(ERROR_TEXT.test(text)).toBe(true);
	for (const text of ["x = 9", "HTTP 200 OK", "HTTP 4011 bytes", "AUTH_ERRORS", "MYHTTP 401", "unauthorized access is a topic", "Unauthorizedly", "\"verified\": true"])
		expect(ERROR_TEXT.test(text)).toBe(false);
	for (const nearMiss of ["_AUTH_ERRO".repeat(100_000), "HTTP 4".repeat(100_000), "Unauthorize".repeat(100_000)]) {
		const started = performance.now();
		expect(ERROR_TEXT.test(nearMiss)).toBe(false);
		expect(performance.now() - started).toBeLessThan(250);
	}
	expect(judgeResult("answer: 9", "\\b9\\b")).toMatchObject({ status: "CALLABLE", expect_matched: true });
	expect(judgeResult("answer: 9", undefined)).toMatchObject({ status: "UNVERIFIED_RESULT", expect_matched: null });
	expect(judgeResult("answer: 9", "^10$")).toMatchObject({ status: "CALL_FAILED", expect_matched: false });
	expect(judgeResult("WOLFRAM_AUTH_ERROR (HTTP 401)", ".")).toMatchObject({ status: "CALL_FAILED", error_text: true });
	// Matching is capped: an error string past the cap is not scanned.
	expect(judgeResult(`${"a".repeat(RESULT_TEXT_CAP)} HTTP 401`, ".").status).toBe("CALLABLE");
	expect(parseExpectSpec("wolfram-alpha:\\b9\\b")).toEqual({ server: "wolfram-alpha", pattern: "\\b9\\b" });
	for (const bad of ["nocolon", ":x", "s:", "s:("]) expect(() => parseExpectSpec(bad)).toThrow("INVALID_EXPECT");
});
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
