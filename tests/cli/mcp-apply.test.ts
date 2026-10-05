import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { chooseMcpSelection, insertMcpServers, McpApplyError, parseEnvCommand, planMcpApply, removeDisabledServer, scanRenderedSecrets, setMcpEnvValue, validateJsonSchema } from "../../src/mcp-apply.ts";
import { listOmpProfiles, readSource } from "../../src/mcp-sources.ts";

const OMP = process.env.OMP_INSTALLED_PATH ?? Bun.which("omp");
if (!OMP) throw new Error("mcp-apply tests require an installed OMP on PATH (its mcp-schema.json is the contract)");
const SCHEMA_PATH = join(dirname(dirname(realpathSync(OMP))), "src", "config", "mcp-schema.json");
const SCHEMA: unknown = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const CLI = join(import.meta.dir, "../../src/cli.ts");
// Assembled so no credential-shaped literal sits in the source.
const PLANTED_TOKEN = ["sk", "live", "PLANTEDSECRETVALUE0123456789"].join("-");
const PLANTED_ENV_VALUE = "planted-env-value-should-never-appear";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(servers: Record<string, unknown>) {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "mcp-apply-"));
	roots.push(root);
	const home = join(root, "home"), state = join(root, "state"), cwd = join(root, "cwd");
	for (const dir of [join(home, ".omp", "agent"), join(home, ".omp", "profiles", "alpha", "agent"), cwd]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
	const run = (args: string[]) => {
		const result = Bun.spawnSync([process.execPath, CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe",
			env: { ...process.env, HOME: home, XDG_STATE_HOME: state, TMPDIR: root, PATH: `${dirname(OMP!)}:${dirname(process.execPath)}:/usr/bin:/bin` } });
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	const plan = (names: string[]) => planMcpApply({ source: readSource("claude", home, cwd), servers: names, profiles: listOmpProfiles(home).profiles,
		stateRoot: state, schema: SCHEMA, schemaPath: SCHEMA_PATH });
	return { root, home, state, cwd, run, plan, defaultMcp: join(home, ".omp", "agent", "mcp.json"), alphaMcp: join(home, ".omp", "profiles", "alpha", "agent", "mcp.json") };
}
function refusal(work: () => unknown): McpApplyError {
	try { work(); } catch (error) { if (error instanceof McpApplyError) return error; throw error; }
	throw new Error("expected a refusal");
}

test("a planted literal credential in args is refused before any write, and env values become references", () => {
	const f = fixture({ leaky: { command: "tool", args: ["--api-key", PLANTED_TOKEN] }, clean: { command: "tool", env: { APP_ID: PLANTED_ENV_VALUE } } });
	const error = refusal(() => f.plan(["leaky"]));
	expect(error.code).toBe("LITERAL_SECRET");
	expect(error.findings).toContainEqual({ server: "leaky", field: "args[1]" });
	expect(JSON.stringify(error.findings)).not.toContain(PLANTED_TOKEN);
	const cli = f.run(["apply", "mcp", "--from", "claude", "--servers", "leaky", "--profiles", "all", "--apply", "--yes", "--json"]);
	expect(cli.code).toBe(2);
	expect(JSON.parse(cli.stdout).errors[0].code).toBe("LITERAL_SECRET");
	expect(cli.stdout).not.toContain(PLANTED_TOKEN);
	expect(existsSync(f.defaultMcp) || existsSync(f.alphaMcp)).toBe(false);
	const clean = f.run(["apply", "mcp", "--from", "claude", "--servers", "clean", "--profiles", "alpha", "--apply", "--yes", "--json"]);
	expect(clean.code).toBe(0);
	expect(clean.stdout).not.toContain(PLANTED_ENV_VALUE);
	const written = readFileSync(f.alphaMcp, "utf8");
	expect(written).not.toContain(PLANTED_ENV_VALUE);
	expect(JSON.parse(written).mcpServers.clean.env).toEqual({ APP_ID: "APP_ID" });
});

test("a rendered config that fails the installed OMP mcp-schema.json is refused before write", () => {
	const f = fixture({ "bad name!": { command: "tool" }, empty: { command: "" } });
	const named = refusal(() => f.plan(["bad name!"]));
	expect(named.code).toBe("SCHEMA_INVALID");
	expect(refusal(() => f.plan(["empty"])).code).toBe("SCHEMA_INVALID");
	const cli = f.run(["apply", "mcp", "--from", "claude", "--servers", "empty", "--profiles", "all", "--apply", "--yes", "--json"]);
	expect(cli.code).toBe(2);
	expect(JSON.parse(cli.stdout).errors[0].code).toBe("SCHEMA_INVALID");
	expect(existsSync(f.defaultMcp) || existsSync(f.alphaMcp)).toBe(false);
	expect(validateJsonSchema({ mcpServers: { ok: { command: "tool" } } }, SCHEMA)).toEqual([]);
});

test("a profile whose existing mcp.json already fails the OMP schema is skipped and left untouched", () => {
	const f = fixture({ fresh: { command: "tool" } });
	const invalid = "{\"mcpServers\":{\"old\":{\"url\":\"http://127.0.0.1:1\"}}}";
	writeFileSync(f.alphaMcp, invalid);
	const plan = f.plan(["fresh"]);
	expect(plan.profiles.find(row => row.profile === "alpha")).toMatchObject({ action: "SKIPPED", reason: expect.stringContaining("SCHEMA_INVALID") });
	expect(plan.profiles.find(row => row.profile === "default")?.action).toBe("ADD");
	expect(readFileSync(f.alphaMcp, "utf8")).toBe(invalid);
});

test("apply keeps existing bytes in place and undo restores every touched profile byte-for-byte", () => {
	const f = fixture({ fresh: { command: "tool", args: ["--flag"] } });
	const original = "{\n\t\"mcpServers\": {\n\t\t\"keep\": { \"command\": \"true\", \"args\": [\"é\"] }\n\t},\n\t\"disabledServers\": []\n}";
	writeFileSync(f.defaultMcp, original);
	const applied = f.run(["apply", "mcp", "--from", "claude", "--servers", "fresh", "--profiles", "all", "--apply", "--yes", "--json"]);
	expect(applied.code).toBe(0);
	const envelope = JSON.parse(applied.stdout);
	expect(envelope.data.action).toBe("APPLIED");
	const after = readFileSync(f.defaultMcp, "utf8");
	const at = original.indexOf("}\n\t},") + 1;
	expect(after.startsWith(original.slice(0, at))).toBe(true);
	expect(after.endsWith(original.slice(at))).toBe(true);
	expect(JSON.parse(after).mcpServers.fresh).toEqual({ type: "stdio", command: "tool", args: ["--flag"] });
	expect(JSON.parse(readFileSync(f.alphaMcp, "utf8")).mcpServers.fresh.command).toBe("tool");
	const undone = f.run(["undo", envelope.data.receipt_id, "--yes", "--json"]);
	expect(undone.code).toBe(0);
	expect(readFileSync(f.defaultMcp, "utf8")).toBe(original);
	expect(existsSync(f.alphaMcp)).toBe(false);
});

test("without a terminal and without selection flags, apply mcp refuses and names the exact flags", () => {
	const f = fixture({ fresh: { command: "tool" } });
	const result = f.run(["apply", "mcp", "--from", "claude"]);
	expect(result.code).toBe(2);
	expect(result.stderr).toContain("MCP_SELECTION_REQUIRED");
	for (const flag of ["--from", "--servers", "--profiles", "--plan", "--apply --yes"]) expect(result.stderr).toContain(flag);
	expect(existsSync(f.defaultMcp) || existsSync(f.alphaMcp)).toBe(false);
});

test("the interactive walk-through asks for source, servers and profiles, accepting names or numbers", async () => {
	const answers = ["", "2", "alpha,1"];
	const asked: string[] = [];
	const chosen = await chooseMcpSelection({ ask: async question => { asked.push(question); return answers.shift() ?? ""; }, say: () => {} },
		{ sources: [{ id: "claude", servers: ["mathlas", "z3-prover"] }, { id: "cursor", servers: [] }], profiles: ["default", "alpha"] });
	expect(chosen).toEqual({ from: "claude", servers: ["z3-prover"], profiles: ["alpha", "default"] });
	expect(asked).toHaveLength(3);
	const invalid = await chooseMcpSelection({ ask: async () => "nope", say: () => {} }, { from: "claude", sources: [{ id: "claude", servers: ["a"] }], profiles: ["default"] });
	expect(invalid).toBeNull();
});

test("an override replaces one source entry without touching the source, and is recorded in the apply receipt", () => {
	const f = fixture({ sympy: { command: "uv", args: ["run", "python", "-m", "server"] } });
	const override = join(f.root, "sympy.json");
	writeFileSync(override, JSON.stringify({ command: "uv", args: ["run", "--no-project", "python", "-P", "-c", "import server; server.mcp.run()"] }));
	const sourceBefore = readFileSync(join(f.home, ".claude.json"));
	const result = f.run(["apply", "mcp", "--from", "claude", "--servers", "sympy", "--profiles", "alpha", "--override", `sympy=${override}`, "--startup-timeout-ms", "sympy=60000", "--apply", "--yes", "--json"]);
	expect(result.code).toBe(0);
	const receipt = JSON.parse(result.stdout).data.receipt_id;
	expect(JSON.parse(readFileSync(f.alphaMcp, "utf8")).mcpServers.sympy).toEqual({ type: "stdio", command: "uv", args: ["run", "--no-project", "python", "-P", "-c", "import server; server.mcp.run()"], timeout: 60000 });
	expect(readFileSync(join(f.home, ".claude.json"))).toEqual(sourceBefore);
	const recorded = JSON.parse(readFileSync(join(f.state, "omp-kit", `mcp-apply-${receipt}.json`), "utf8"));
	expect(recorded.overrides).toEqual([{ name: "sympy", path: override, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
	expect(recorded.servers[0]).toMatchObject({ name: "sympy", override, timeout: 60000 });
});

test("insertion into an empty or compact file stays valid JSON and preserves every original byte", () => {
	for (const original of ["{}", "{\"mcpServers\":{}}", "{\"x\":1,\"mcpServers\":{\"a\":{\"command\":\"b\"}}}", "{\n  \"x\": 1\n}\n"]) {
		const next = insertMcpServers(original, [["n", { command: "c" }]]);
		expect(next.text.slice(0, next.at) + next.text.slice(next.at + next.length)).toBe(original);
		expect(JSON.parse(next.text).mcpServers.n).toEqual({ command: "c" });
	}
});

const KEYCHAIN = "!security find-generic-password -s APP_ID -w";

test("edit mode sets one env value to a !command and re-enables a server in place; every other byte is kept and undo restores it", () => {
	const f = fixture({});
	const original = "{\n\t\"$schema\": \"x\",\n\t\"mcpServers\": {\n\t\t\"keep\": { \"command\": \"true\", \"args\": [\"é\"], \"env\": { \"APP_ID\": \"APP_ID\" } },\n\t\t\"wolf\": {\n\t\t\t\"command\": \"py\",\n\t\t\t\"env\": {\n\t\t\t\t\"APP_ID\": \"APP_ID\",\n\t\t\t\t\"MODE\": \"x\"\n\t\t\t}\n\t\t}\n\t},\n\t\"disabledServers\": [\n\t\t\"a\",\n\t\t\"sym\",\n\t\t\"b\"\n\t]\n}\n";
	writeFileSync(f.alphaMcp, original);
	const untouched = "{\"mcpServers\":{\"other\":{\"command\":\"x\"}}}";
	writeFileSync(f.defaultMcp, untouched);
	const args = ["apply", "mcp", "--profiles", "all", "--env-command", `wolf:APP_ID=${KEYCHAIN}`, "--enable", "sym", "--json"];
	const planned = f.run([...args, "--plan"]);
	expect(planned.code).toBe(0);
	const plan = JSON.parse(planned.stdout).data;
	expect(plan.profiles.find((row: { profile: string }) => row.profile === "alpha")).toMatchObject({ action: "EDIT", added: [`wolf env.APP_ID=${KEYCHAIN}`, "enable sym"] });
	expect(plan.profiles.find((row: { profile: string }) => row.profile === "default")).toMatchObject({ action: "NO_CHANGE", conflicts: [expect.stringContaining("server absent")] });
	expect(readFileSync(f.alphaMcp, "utf8")).toBe(original);
	const applied = f.run([...args, "--apply", "--yes"]);
	expect(applied.code).toBe(0);
	const envelope = JSON.parse(applied.stdout).data;
	expect(envelope.action).toBe("APPLIED");
	const expected = original.replace("\"APP_ID\": \"APP_ID\",\n\t\t\t\t\"MODE\"", `"APP_ID": ${JSON.stringify(KEYCHAIN)},\n\t\t\t\t"MODE"`).replace("\t\t\"sym\",\n", "");
	expect(expected).not.toBe(original);
	expect(readFileSync(f.alphaMcp, "utf8")).toBe(expected);
	expect(readFileSync(f.defaultMcp, "utf8")).toBe(untouched);
	const recorded = JSON.parse(readFileSync(join(f.state, "omp-kit", `mcp-apply-${envelope.receipt_id}.json`), "utf8"));
	expect(recorded).toMatchObject({ source: null, edits: { env_commands: [{ server: "wolf", key: "APP_ID", command: KEYCHAIN }], enable: ["sym"] } });
	const again = f.run([...args, "--plan"]);
	expect(JSON.parse(again.stdout).data.profiles.find((row: { profile: string }) => row.profile === "alpha").action).toBe("NO_CHANGE");
	const undone = f.run(["undo", envelope.receipt_id, "--yes", "--json"]);
	expect(undone.code).toBe(0);
	expect(readFileSync(f.alphaMcp, "utf8")).toBe(original);
});

test("edit mode accepts a !command but refuses a literal value or a credential inside the command, before any write", () => {
	const f = fixture({});
	const original = "{\"mcpServers\":{\"wolf\":{\"command\":\"py\",\"env\":{\"APP_ID\":\"APP_ID\"}}}}";
	writeFileSync(f.alphaMcp, original);
	const leaked = f.run(["apply", "mcp", "--profiles", "alpha", "--env-command", `wolf:APP_ID=!echo ${PLANTED_TOKEN}`, "--apply", "--yes", "--json"]);
	expect(leaked.code).toBe(2);
	expect(JSON.parse(leaked.stdout).errors[0].code).toBe("LITERAL_SECRET");
	expect(leaked.stdout + leaked.stderr).not.toContain(PLANTED_TOKEN);
	const literal = f.run(["apply", "mcp", "--profiles", "alpha", "--env-command", `wolf:APP_ID=${PLANTED_ENV_VALUE}`, "--apply", "--yes", "--json"]);
	expect(literal.code).toBe(2);
	expect(JSON.parse(literal.stdout).errors[0].code).toBe("INVALID_ENV_COMMAND");
	expect(literal.stdout + literal.stderr).not.toContain(PLANTED_ENV_VALUE);
	const mixed = f.run(["apply", "mcp", "--from", "claude", "--profiles", "alpha", "--enable", "wolf", "--plan", "--json"]);
	expect(mixed.code).toBe(2);
	expect(mixed.stdout + mixed.stderr).toContain("INVALID_FLAG");
	expect(readFileSync(f.alphaMcp, "utf8")).toBe(original);
	expect(scanRenderedSecrets("wolf", { command: "py", env: { APP_ID: KEYCHAIN } })).toEqual([]);
	expect(scanRenderedSecrets("wolf", { command: "py", env: { APP_ID: `!echo ${PLANTED_TOKEN}` } })).toEqual([{ server: "wolf", field: "env.APP_ID" }]);
	expect(scanRenderedSecrets("wolf", { command: "py", env: { APP_ID: "!" } })).toEqual([{ server: "wolf", field: "env.APP_ID" }]);
	expect(parseEnvCommand(`wolfram-alpha:WOLFRAM_APP_ID=${KEYCHAIN}`)).toEqual({ server: "wolfram-alpha", key: "WOLFRAM_APP_ID", command: KEYCHAIN });
	for (const bad of ["wolf:APP_ID", "wolf:APP_ID=", "wolf:APP_ID=!  ", ":APP_ID=!x", "wolf:9X=!x"]) expect(() => parseEnvCommand(bad)).toThrow(McpApplyError);
});

test("in-place edits keep every other byte in compact and pretty files", () => {
	expect(removeDisabledServer("{\"disabledServers\":[\"a\",\"s\",\"b\"]}", "s")).toBe("{\"disabledServers\":[\"a\",\"b\"]}");
	expect(removeDisabledServer("{\"disabledServers\":[\"a\", \"s\"]}", "s")).toBe("{\"disabledServers\":[\"a\"]}");
	expect(removeDisabledServer("{\"disabledServers\": [ \"s\" ]}", "s")).toBe("{\"disabledServers\": []}");
	expect(removeDisabledServer("{\"disabledServers\":[\"s\",\"a\",\"s\"]}", "s")).toBe("{\"disabledServers\":[\"a\"]}");
	expect(removeDisabledServer("{\"disabledServers\":[\"a\"],\"x\":[\"s\"]}", "s")).toBeNull();
	expect(removeDisabledServer("{\"mcpServers\":{}}", "s")).toBeNull();
	const compact = "{\"mcpServers\":{\"w\":{\"env\":{\"K\":\"K\",\"L\":\"K\"}},\"env\":{\"K\":\"K\"}}}";
	expect(setMcpEnvValue(compact, "w", "K", "!c")).toBe("{\"mcpServers\":{\"w\":{\"env\":{\"K\":\"!c\",\"L\":\"K\"}},\"env\":{\"K\":\"K\"}}}");
	expect(setMcpEnvValue(compact, "w", "M", "!c")).toBeNull();
	expect(setMcpEnvValue(compact, "absent", "K", "!c")).toBeNull();
});
