import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard, { type GuardDeps } from "../../extensions/fleet-guard.ts";
import { parseOwnerFile } from "../../src/scratch.ts";
import { createSeatScratch, recordSeatOwner } from "../../src/fleet-guard/seat-end.ts";
import type { FleetGuardEvent } from "../../src/fleet-guard/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

let freshSeq = 0;
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// Fresh clones have no var/agent-tmp; the owned fixture root below requires its parent to exist.
mkdirSync(join(import.meta.dir, "../../var/agent-tmp"), { recursive: true });
const owned = ownedTmp("tmp-redirect", { root: join(import.meta.dir, "../../var/agent-tmp") });
const base = owned.path;
afterAll(() => owned.cleanup());

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, ROOTS: process.env.OMP_KIT_SCRATCH_ROOTS };
afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv) as ["TMPDIR" | "TMP" | "TEMP" | "ROOTS", string | undefined][]) {
		const name = key === "ROOTS" ? "OMP_KIT_SCRATCH_ROOTS" : key;
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function fixture(): string {
	const cwd = freshDir(base, "tmp-redirect-");
	roots.push(cwd);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	env.GIT_CONFIG_NOSYSTEM = "1";
	env.GIT_CONFIG_GLOBAL = "/dev/null";
	const inited = runSync(["git", "-C", cwd, "init", "--quiet"], { env, deadline_s: fixtureDeadlineS(), max_output_bytes: 4096 });
	if (inited.rc !== 0) throw new Error(new TextDecoder().decode(inited.stderr));
	mkdirSync(join(cwd, ".omp"));
	writeFileSync(join(cwd, ".omp", "fleet.json"), '{"enabled":true}\n');
	return cwd;
}

interface FakePi {
	handlers: ((event: FleetGuardEvent, context?: { cwd: string; sessionManager?: { getSessionId?: () => string | undefined } }) => Promise<unknown>)[];
	shutdowns: unknown[];
	setLabel(label: string): void;
	on(event: string, handler: (...args: never[]) => unknown): void;
}

function fakePi(): FakePi {
	return {
		handlers: [],
		shutdowns: [],
		setLabel(_label: string): void {},
		on(event: string, handler: (...args: never[]) => unknown): void {
			if (event === "session_shutdown") this.shutdowns.push(handler);
			else this.handlers.push(handler as FakePi["handlers"][number]);
		},
	};
}

/** Load the guard with the fixture recognized as a scratch root and a fixture-local budget ledger. */
async function seated(cwd: string, extra: GuardDeps = {}): Promise<FakePi> {
	const pi = fakePi();
	// /var is a symlink to /private/var: the guard resolves the repo root, so register both spellings.
	const spellings = [...new Set([cwd, realpathSync(cwd)])].map((base) => join(base, "var", "agent-tmp")) as string[];
	process.env.OMP_KIT_SCRATCH_ROOTS = spellings.join(":");
	try {
		await fleetGuard(pi, { cwd, pid: process.pid, env: {}, seatScratch: { ledgerPath: join(cwd, "budgets.json") }, ...extra });
	} finally {
		if (savedEnv.ROOTS === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = savedEnv.ROOTS;
	}
	return pi;
}

const SESSION = "01a15012-af9e-7628-bee6-496084668412";

test("TMPREDIRECT1: literal simple system-temp writes complete into the owned seat dir", async () => {
	const cwd = fixture();
	const pi = await seated(cwd);
	const seat = join(cwd, "var", "agent-tmp", `omp.${process.pid}`);
	const handler = pi.handlers[0]!;
	const ctx = { cwd, sessionManager: { getSessionId: () => SESSION } };
	// write completions name the seat file and carry the one-line notice.
	const completed = await handler({ toolName: "write", input: { path: "/tmp/r1.json", content: "{}\n" } }, ctx) as { input?: { path?: string }; additionalContext?: string }; // tempsafe: fake guard input path, never touched on disk
	expect(completed?.input?.path).toBe(join(seat, "r1.json"));
	expect(completed?.additionalContext).toBe(`AUTO_COMPLETED: /tmp/r1.json -> ${join(seat, "r1.json")}`);
	// a bash redirect of the same shape rewrites the command through the shared parser.
	const shell = await handler({ toolName: "bash", input: { command: "echo hi > /tmp/r2.json" } }, ctx) as { input?: { command?: string }; additionalContext?: string };
	expect(shell?.input?.command).toBe(`echo hi > ${join(seat, "r2.json")}`);
	expect(shell?.additionalContext).toBe(`AUTO_COMPLETED: /tmp/r2.json -> ${join(seat, "r2.json")}`);
	// a later read of a mapped literal reads the same session file.
	const quiet = await handler({ toolName: "read", input: { path: "/tmp/r1.json" } }, ctx) as { input?: { path?: string } }; // tempsafe: fake guard input path, never touched on disk
	expect(quiet?.input?.path).toBe(join(seat, "r1.json"));
});

test("TMPREDIRECT1: computed, nested, quoted and allocation shapes keep today's refusal", async () => {
	const cwd = fixture();
	const pi = await seated(cwd);
	const handler = pi.handlers[0]!;
	const ctx = { cwd, sessionManager: { getSessionId: () => SESSION } };
	const refused = async (event: FleetGuardEvent): Promise<string | undefined> => {
		const verdict = await handler(event, ctx) as { block?: boolean; reason?: string; additionalContext?: string } | undefined;
		expect(verdict?.block).toBe(true);
		expect(verdict?.additionalContext).toBeUndefined();
		return verdict?.reason;
	};
	// variable-built, subdirectory, quoted and nested-execution targets are never spliced.
	expect(await refused({ toolName: "write", input: { path: "/tmp/$name", content: "{}\n" } })).toContain("scratch-write"); // tempsafe: fake guard input path, never touched on disk
	expect(await refused({ toolName: "write", input: { path: "/tmp/sub/x.json", content: "{}\n" } })).toContain("scratch-write"); // tempsafe: fake guard input path, never touched on disk
	expect(await refused({ toolName: "bash", input: { command: "echo hi > \"/tmp/q.json\"" } })).toContain("scratch-write");
	expect(await refused({ toolName: "bash", input: { command: "cp out.json /tmp/b.json" } })).toContain("scratch-write");
	expect(await refused({ toolName: "bash", input: { command: "mktemp /tmp/x.XXXXXX" } })).toContain("scratch-alloc");
	// a remote execution context is never spliced, and today it is allowed: the rewrite refuses, the guard admits.
	expect(await handler({ toolName: "bash", input: { command: "ssh deploy \"echo hi > /tmp/x.json\"" } }, ctx)).toBeUndefined();
});

test("TMPREDIRECT1: the seat dir comes from the scratch ownership API, recorded once", async () => {
	const cwd = fixture();
	process.env.OMP_KIT_SCRATCH_ROOTS = join(cwd, "var", "agent-tmp");
	try {
		const ledger = join(cwd, "budgets.json");
		const first = createSeatScratch(cwd, { ledgerPath: ledger });
		expect("dir" in first).toBe(true);
		if (!("dir" in first)) return;
		expect(first.dir).toBe(join(cwd, "var", "agent-tmp", `omp.${process.pid}`));
		const text = readFileSync(join(first.dir, ".owner"), "utf8");
		const owner = parseOwnerFile(text);
		expect(owner).toMatchObject({ pid: process.pid, label: "omp", bin: "throwaway", agent: null, session: null });
		expect(owner?.capabilitySha256).toMatch(/^[0-9a-f]{64}$/);
		expect(owner?.processStart).toBeTruthy();
		// same-process re-init reuses the dir instead of inventing another.
		expect(createSeatScratch(cwd, { ledgerPath: ledger })).toEqual({ dir: first.dir });
		// the first tool call records the seat; a later session never replaces it.
		expect(recordSeatOwner(first.dir, "TurquoiseSummit", SESSION)).toBe(true);
		expect(recordSeatOwner(first.dir, "TurquoiseSummit", "01a1502a-5647-76ba-89c5-949087f3e283")).toBe(false);
		expect(parseOwnerFile(readFileSync(join(first.dir, ".owner"), "utf8"))).toMatchObject({ agent: "TurquoiseSummit", session: SESSION });
		// an ill-formed pair and a missing dir refuse, leaving the owner valid.
		expect(recordSeatOwner(first.dir, "../evil", SESSION)).toBe(false);
		expect(recordSeatOwner(join(cwd, "var", "agent-tmp", "missing.1"), "TurquoiseSummit", SESSION)).toBe(false);
	} finally {
		if (savedEnv.ROOTS === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = savedEnv.ROOTS;
	}
});

test("TMPREDIRECT1: an unavailable seat fails closed to today's refusal", async () => {
	const cwd = fixture();
	const pi = fakePi();
	process.env.OMP_KIT_SCRATCH_ROOTS = join(cwd, "no-such-root");
	try {
		await fleetGuard(pi, { cwd, pid: process.pid, env: {}, seatScratch: { ledgerPath: join(cwd, "budgets.json") } });
	} finally {
		if (savedEnv.ROOTS === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = savedEnv.ROOTS;
	}
	const verdict = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/x.json", content: "{}\n" } }, { cwd }) as // tempsafe: fake guard input path, never touched on disk
		{ block?: boolean; reason?: string; additionalContext?: string } | undefined;
	expect(verdict?.block).toBe(true);
	// today's write-tool refusal, with no session hint and no completion: the seat never existed.
	expect(verdict?.reason).toContain("fleet-guard scratch-write");
	expect(verdict?.reason).not.toContain("Session scratch:");
	expect(verdict?.additionalContext).toBeUndefined();
	expect(existsSync(join(cwd, "var", "agent-tmp"))).toBe(false);
});
