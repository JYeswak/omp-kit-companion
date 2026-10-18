import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard, { handleToolCall, type GuardDeps } from "./fleet-guard.ts";
import { clearReservationCache } from "../src/fleet-guard/reservations.ts";
// Fresh clones have no var/agent-tmp; mkdtemp below requires its parent to exist.
mkdirSync(join(import.meta.dir, "../var/agent-tmp"), { recursive: true });

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv) as ["TMPDIR" | "TMP" | "TEMP", string | undefined][]) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

type ToolCallHandler = Parameters<Parameters<typeof fleetGuard>[0]["on"]>[1];

interface FakePi {
	labels: string[];
	handlers: ToolCallHandler[];
	setLabel(label: string): void;
	on(event: "tool_call", handler: ToolCallHandler): void;
}

function fakePi(): FakePi {
	return {
		labels: [],
		handlers: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(_event: "tool_call", handler: ToolCallHandler): void {
			this.handlers.push(handler);
		},
	};
}

function fixture(fleet = true): { cwd: string; pid: number } {
	const cwd = mkdtempSync(join(import.meta.dir, "../var/agent-tmp", "fleet-entry-"));
	roots.push(cwd);
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	const initialized = Bun.spawnSync(["git", "-C", cwd, "init", "--quiet"], { env, stdout: "pipe", stderr: "pipe" });
	if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());
	if (fleet) {
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "fleet.json"), '{"enabled":true}\n');
	}
	return { cwd, pid: process.pid };
}

test("an opted-in repository gets owned scratch and filesystem refusals", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	const deps: GuardDeps = { cwd, pid };
	await fleetGuard(pi, deps);
	const repoRoot = cwd;
	expect(process.env.TMPDIR).toBe(join(repoRoot, "var", "agent-tmp", `omp.${pid}`));
	const owner = readFileSync(join(repoRoot, "var", "agent-tmp", `omp.${pid}`, ".owner"), "utf8");
	expect(owner).toContain(`pid=${pid}\nlabel=omp\n`);
	const handler = pi.handlers[0]!;
	const blocked = await handler({ toolName: "write", input: { path: "/tmp/x" } } as never);
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("fleet-guard scratch-write");
	const quiet = await handler({ toolName: "read", input: { path: "/tmp/x" } } as never);
	expect(quiet).toBeUndefined();
});

test("scratch fires before git and reservations in the chain", async () => {
	const both = await handleToolCall({ toolName: "bash", command: "git add -A" }, { cwd: "/tmp" });
	expect(both?.reason).toContain("fleet-guard blanket-git");
	const foreign = await handleToolCall(
		{ toolName: "edit", input: { path: "/tmp/elsewhere.md" } }, { cwd: "/tmp" });
	expect(foreign?.reason).toContain("fleet-guard scratch-write");
});

test("logical routes traverse the chain without globally allowing tool calls", async () => {
	for (const path of ["proc://owned-job/kill", "agent://coordinator", "xd://report_issue"])
		expect(await handleToolCall({ toolName: "write", input: { path } }, { cwd: "/private/tmp" })).toBeUndefined();
	// A mixed target must still hit scratch, and a later reservation refusal must survive.
	expect((await handleToolCall({ toolName: "edit", input: { paths: ["agent://coordinator", "/tmp/out"] } },
		{ cwd: "/private/tmp" }))?.reason).toContain("scratch-write");
	const { cwd } = fixture();
	clearReservationCache();
	expect((await handleToolCall({ toolName: "write", input: { path: "proc://owned-job/kill" } },
		{ cwd, agentName: "tester", isTrackedPath: () => true,
			lookupReservations: async () => ({ covered: false, conflicts: [] }) }))?.reason).toContain("reservations");
	clearReservationCache();
});

test("registered handler uses the actual calling context's local mapping", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	const { cwd: callingCwd } = fixture(false);
	await fleetGuard(pi, { cwd, pid });
	const handler = pi.handlers[0]!;
	const event = { toolName: "write", input: { path: "local://notes/out" } };
	expect(await handler(event, { cwd: callingCwd, localProtocolOptions: { getArtifactsDir: () => join(cwd, "artifacts") } })).toBeUndefined();
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => "/tmp/foreign-artifacts" } }))?.reason).toContain("scratch-write");
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => null } }))?.reason).toContain("backing root");
	expect((await handler(event, { cwd }))?.reason).toContain("backing root");
	expect(await handler({ toolName: "write", input: { path: "proc://owned-job/kill" } }, { cwd: callingCwd })).toBeUndefined();
});

test("tracked edits honor injected reservation verdicts and fail open", async () => {
	const { cwd: dir } = fixture();
	const target = join(dir, "tracked.md");
	writeFileSync(target, "x\n");
	const context = (covered: boolean | "throw") => ({ cwd: dir, agentName: "tester",
		isTrackedPath: async () => true,
		lookupReservations: async () => {
			if (covered === "throw") throw new Error("mail down");
			return { covered, conflicts: [] as readonly unknown[] };
		},
		warn: () => {} });
	const event = { toolName: "edit", input: { path: target } };
	expect(await handleToolCall(event, context(true))).toBeUndefined();
	clearReservationCache();
	const denied = await handleToolCall(event, context(false));
	expect(denied?.block).toBe(true);
	expect(denied?.reason).toContain("fleet-guard reservations");
	clearReservationCache();
	expect(await handleToolCall(event, context("throw"))).toBeUndefined();
});


test("filesystem refusals survive an unavailable storage-root lookup", async () => {
	const saved = { url: process.env.AGENTMAIL_HTTP_URL, token: process.env.AGENTMAIL_HTTP_BEARER_TOKEN, root: process.env.AGENT_MAIL_STORAGE_ROOT };
	process.env.AGENTMAIL_HTTP_URL = "http://127.0.0.1:1/api";
	delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN;
	delete process.env.AGENT_MAIL_STORAGE_ROOT;
	const pi = fakePi();
	const { cwd, pid } = fixture();
	try {
		await fleetGuard(pi, { cwd, pid });
		const refusal = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/refused" } }, { cwd });
		expect(refusal?.reason).toContain("scratch-write");
	} finally {
		if (saved.url === undefined) delete process.env.AGENTMAIL_HTTP_URL; else process.env.AGENTMAIL_HTTP_URL = saved.url;
		if (saved.token === undefined) delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN; else process.env.AGENTMAIL_HTTP_BEARER_TOKEN = saved.token;
		if (saved.root === undefined) delete process.env.AGENT_MAIL_STORAGE_ROOT; else process.env.AGENT_MAIL_STORAGE_ROOT = saved.root;
	}
});

test("stock plugin loading neither creates fleet scratch nor changes caller temp", async () => {
	const { cwd } = fixture(false);
	const pi = fakePi();
	const previousTmp = process.env.TMPDIR;
	await fleetGuard(pi, { cwd, pid: process.pid });
	expect(existsSync(join(cwd, "var", "agent-tmp"))).toBe(false);
	expect(process.env.TMPDIR).toBe(previousTmp);
});
