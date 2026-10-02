import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import fleetGuard, { handleToolCall, type GuardDeps } from "./fleet-guard.ts";
import { clearReservationCache } from "../src/fleet-guard/reservations.ts";
import { planExtensions } from "../src/apply-extensions.ts";
import type { FleetGuardBlock } from "../src/fleet-guard/scratch.ts";
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

interface FakePi {
	labels: string[];
	handlers: ((event: never) => Promise<FleetGuardBlock | undefined>)[];
	setLabel(label: string): void;
	on(event: "tool_call", handler: (event: never) => Promise<FleetGuardBlock | undefined>): void;
}

function fakePi(): FakePi {
	return {
		labels: [],
		handlers: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(_event: "tool_call", handler: (event: never) => Promise<FleetGuardBlock | undefined>): void {
			this.handlers.push(handler);
		},
	};
}

function fixture(): { cwd: string; pid: number } {
	const cwd = mkdtempSync(join(import.meta.dir, "../var/agent-tmp", "fleet-entry-"));
	roots.push(cwd);
	return { cwd, pid: 424242 };
}

test("entry sets up session scratch and registers the ordered chain", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	const deps: GuardDeps = { cwd, pid };
	await fleetGuard(pi, deps);
	expect(pi.labels).toEqual(["fleet-guard"]);
	expect(pi.handlers).toHaveLength(1);
	// cwd sits inside the repo, so session scratch resolves to the repo root (shared).
	const repoRoot = resolve(import.meta.dir, "..");
	roots.push(join(repoRoot, "var", "agent-tmp", `omp.${pid}`));
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

test("tracked edits honor injected reservation verdicts and fail open", async () => {
	const dir = mkdtempSync(join(import.meta.dir, "../var/agent-tmp", "fleet-entry-"));
	roots.push(dir);
	mkdirSync(join(dir, ".git"), { recursive: true });
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

test("two-extension policy installs both destinations and appends both to profiles", () => {
	const root = mkdtempSync(join(import.meta.dir, "../var/agent-tmp", "fleet-policy-"));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(join(root, "policy"), { recursive: true });
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(join(home, ".omp", "profiles", "work", "agent"), { recursive: true });
	writeFileSync(join(root, "policy", "extensions.json"),
		JSON.stringify({ extensions: ["kit-guard-optin.ts", "fleet-guard.ts"], skipProfiles: [] }));
	writeFileSync(join(root, "extensions", "kit-guard-optin.ts"), "export default {};\n");
	writeFileSync(join(root, "extensions", "fleet-guard.ts"), "export default {};\n");
	writeFileSync(join(home, ".omp", "profiles", "work", "agent", "config.yml"), "extensions: []\n");
	const plan = planExtensions({ root, home, stateRoot: join(home, "xdg-state", "omp-kit") });
	const dests = plan.steps.filter(step => step.kind === "extension").map(step => step.path).sort();
	expect(dests).toEqual([
		join(home, ".omp", "omp-extensions", "fleet-guard.ts"),
		join(home, ".omp", "omp-extensions", "kit-guard-optin.ts"),
	].sort());
	const profileStep = plan.steps.find(step => step.kind === "profile");
	expect(profileStep?.path).toContain(join("work", "agent"));
});

test("session load completes and registers the chain when the storage-root export fails", async () => {
	const saved = { url: process.env.AGENTMAIL_HTTP_URL, token: process.env.AGENTMAIL_HTTP_BEARER_TOKEN, root: process.env.AGENT_MAIL_STORAGE_ROOT };
	process.env.AGENTMAIL_HTTP_URL = "http://127.0.0.1:1/api";
	delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN;
	delete process.env.AGENT_MAIL_STORAGE_ROOT;
	const pi = fakePi();
	const { cwd, pid } = fixture();
	try {
		await fleetGuard(pi, { cwd, pid });
		expect(pi.labels).toEqual(["fleet-guard"]);
		expect(pi.handlers).toHaveLength(1);
		expect(process.env.AGENT_MAIL_STORAGE_ROOT).toBeUndefined();
	} finally {
		if (saved.url === undefined) delete process.env.AGENTMAIL_HTTP_URL; else process.env.AGENTMAIL_HTTP_URL = saved.url;
		if (saved.token === undefined) delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN; else process.env.AGENTMAIL_HTTP_BEARER_TOKEN = saved.token;
		if (saved.root === undefined) delete process.env.AGENT_MAIL_STORAGE_ROOT; else process.env.AGENT_MAIL_STORAGE_ROOT = saved.root;
	}
	const repoRoot = resolve(import.meta.dir, "..");
	roots.push(join(repoRoot, "var", "agent-tmp", `omp.${pid}`));
});
