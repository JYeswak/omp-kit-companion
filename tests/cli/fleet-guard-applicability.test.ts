// FLEETAPPLIC1 (ompkit-1ra0d.223): an unreadable fleet opt-in must not lock the repo.
// On `unavailable` the guard falls through to the on-path verdict (reads admitted, raw
// pushes still refused; non-repair writes stay refused by write-own) while admitting the
// marker repair edit and notifying once per session. A symlinked marker stays refused.
import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard from "../../extensions/fleet-guard.ts";
import { fleetPolicyState } from "../../extensions/fleet-policy.ts";
import type { FleetGuardEvent } from "../../src/fleet-guard/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

let freshSeq = 0;

mkdirSync(join(import.meta.dir, "../../var/agent-tmp"), { recursive: true });
const owned = ownedTmp("fleet-guard-applicability", { root: join(import.meta.dir, "../../var/agent-tmp") });
const base = realpathSync(owned.path);
afterAll(() => owned.cleanup());

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const savedEnv = { ...process.env };
afterEach(() => {
	for (const key of ["GIT_CEILING_DIRECTORIES", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"] as const) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

// A fixture repo with its own git init; the ceiling keeps git from discovering the parent checkout.
function fixture(): string {
	const cwd = join(base, `fleetapplic-${process.pid}-${++freshSeq}`);
	mkdirSync(cwd, { recursive: true });
	roots.push(cwd);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	env.GIT_CEILING_DIRECTORIES = base;
	const inited = runFixture(["git", "init", "-q", "-b", "main"], { cwd, env, floor_s: fixtureDeadlineS() });
	if (inited.rc !== 0) throw new Error(`git init failed: ${new TextDecoder().decode(inited.stderr)}`);
	mkdirSync(join(cwd, ".omp"), { recursive: true });
	// Planted negative: a second field makes the opt-in unreadable (unavailable, never stock off).
	writeFileSync(join(cwd, ".omp", "fleet.json"), '{"enabled": true, "value": {}}\n');
	writeFileSync(join(cwd, "note.txt"), "fixture notes\n");
	return cwd;
}

interface GuardCtx {
	cwd: string;
	sessionManager: { getSessionId: () => string };
	ui: { notify: (message: string, type?: string) => void };
}

interface FakePi {
	handlers: ((event: FleetGuardEvent, context?: GuardCtx) => Promise<unknown>)[];
	ctx?: GuardCtx;
	setLabel(label: string): void;
	on(event: string, handler: (...args: never[]) => unknown): void;
}

function fakePi(): FakePi {
	return {
		handlers: [],
		setLabel(_label: string): void {},
		on(event: string, handler: (...args: never[]) => unknown): void {
			if (event === "tool_call") this.handlers.push(handler as FakePi["handlers"][number]);
		},
	};
}

const SESSION = "01a15012-af9e-7628-bee6-496084668412";

async function seated(cwd: string, notices: Array<{ message: string; type?: string }>): Promise<FakePi> {
	const pi = fakePi();
	process.env.GIT_CEILING_DIRECTORIES = base;
	await fleetGuard(pi, { cwd, pid: process.pid, env: {} });
	const handler = pi.handlers[0]!;
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => SESSION },
		ui: { notify: (message: string, type?: string) => notices.push({ message, type }) },
	};
	pi.ctx = ctx;
	return pi;
}

function ctxOf(pi: FakePi): GuardCtx {
	const ctx = pi.ctx;
	if (!ctx) throw new Error("seated() did not attach a tool-call context");
	return ctx;
}

test("FLEETAPPLIC1 planted negative: today's applicability line refuses the read this fixture triggers", async () => {
	const cwd = fixture();
	process.env.GIT_CEILING_DIRECTORIES = base;
	const policy = await fleetPolicyState(cwd);
	expect(policy.kind).toBe("unavailable");
	if (policy.kind !== "unavailable") return;
	expect(policy.reason).toContain("enabled");
	// The removed blanket line, verbatim: today's code refused every call here, including reads
	// and the repair edit.
	const todays = { block: true, reason: `fleet-guard applicability: ${policy.reason}` };
	expect(todays.block).toBe(true);
});

test("FLEETAPPLIC1: a read is admitted and the repair notice fires once per session", async () => {
	const cwd = fixture();
	const notices: Array<{ message: string; type?: string }> = [];
	const pi = await seated(cwd, notices);
	const handler = pi.handlers[0]!;
	const ctx = ctxOf(pi);
	const first = await handler({ toolName: "read", input: { path: join(cwd, "note.txt") } }, ctx);
	expect(first).toBeUndefined();
	expect(notices.length).toBe(1);
	expect(notices[0]!.message).toContain(".omp/fleet.json must be exactly");
	expect(notices[0]!.message).toContain("enabled");
	const second = await handler({ toolName: "read", input: { path: join(cwd, "note.txt") } }, ctx);
	expect(second).toBeUndefined();
	expect(notices.length).toBe(1);
});

test("FLEETAPPLIC1: an edit of .omp/fleet.json is admitted so the seat can repair the marker", async () => {
	const cwd = fixture();
	const notices: Array<{ message: string; type?: string }> = [];
	const pi = await seated(cwd, notices);
	const handler = pi.handlers[0]!;
	const ctx = ctxOf(pi);
	const marker = join(cwd, ".omp", "fleet.json");
	const verdict = await handler({ toolName: "edit", input: { input: `[${marker}#1A2B]\nPUT >$:\n+{"enabled": true}\n` } }, ctx);
	expect(verdict).toBeUndefined();
});

test("FLEETAPPLIC1: a fleet-hazard act the opted-in guard refuses is still refused", async () => {
	const cwd = fixture();
	const notices: Array<{ message: string; type?: string }> = [];
	const pi = await seated(cwd, notices);
	const handler = pi.handlers[0]!;
	const ctx = ctxOf(pi);
	const verdict = await handler({ toolName: "bash", input: { command: "git push origin main" } }, ctx) as
		{ block?: boolean; reason?: string } | undefined;
	expect(verdict?.block).toBe(true);
	expect(verdict?.reason).toContain("raw `git push` is refused");
});

test("FLEETAPPLIC1: a repair edit through a symlinked marker stays refused", async () => {
	const cwd = fixture();
	process.env.GIT_CEILING_DIRECTORIES = base;
	// A symlinked marker is itself an `unavailable` reason: admitting the repair would follow
	// the link and write outside the marker with no checks.
	writeFileSync(join(cwd, ".omp", "fleet-real.json"), '{"enabled": true, "value": {}}\n');
	rmSync(join(cwd, ".omp", "fleet.json"));
	symlinkSync("fleet-real.json", join(cwd, ".omp", "fleet.json"));
	expect((await fleetPolicyState(cwd)).kind).toBe("unavailable");
	const notices: Array<{ message: string; type?: string }> = [];
	const pi = await seated(cwd, notices);
	const handler = pi.handlers[0]!;
	const ctx = ctxOf(pi);
	const marker = join(cwd, ".omp", "fleet.json");
	const verdict = await handler({ toolName: "edit", input: { input: `[${marker}#1A2B]\nPUT >$:\n+{"enabled": true}\n` } }, ctx) as
		{ block?: boolean; reason?: string } | undefined;
	expect(verdict?.block).toBe(true);
	expect(verdict?.reason).toContain("WRITE_OWN_POLICY_UNAVAILABLE");
});
