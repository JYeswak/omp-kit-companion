import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard, { checkContention, handleToolCall, maybeInstallCheckout, type GuardDeps } from "./fleet-guard.ts";
import { liveSeatEndDeps, type SeatEndDeps } from "../src/fleet-guard/seat-end.ts";
import { clearReservationCache } from "../src/fleet-guard/reservations.ts";
import type { FleetGuardBlock, FleetGuardEvent } from "../src/fleet-guard/scratch.ts";
import { parseOwnerFile } from "../src/scratch.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { check as checkDurability } from "../src/fleet-guard/durability.ts";
import { runFixture } from "../tests/cli/fixture-process.ts";
import { boardLog, boardScenario, startBoard, type BoardRow } from "../tests/fleet-guard/board-fixture.ts";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}
// Fresh clones have no var/agent-tmp; the owned fixture root below requires its parent to exist.
mkdirSync(join(import.meta.dir, "../var/agent-tmp"), { recursive: true });
const fleetOwned = ownedTmp("fleet-guard-test", { root: join(import.meta.dir, "../var/agent-tmp") });
const fleetBase = fleetOwned.path;
afterAll(() => fleetOwned.cleanup());

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

/**
 * TMPREDIRECT1 (ompkit-1ra0d.178): load the guard with the fixture recognized as a scratch root
 * and a fixture-local budget ledger, so the seat dir comes from the ownership API without touching
 * live roots or the live ledger. The roots override lives only for the synchronous creation.
 */
async function seated(pi: FakePi, deps: GuardDeps, session: string | null = SESSION): Promise<void> {
	const cwd = deps.cwd ?? "";
	const previous = process.env.OMP_KIT_SCRATCH_ROOTS;
	process.env.OMP_KIT_SCRATCH_ROOTS = join(cwd, "var", "agent-tmp");
	try {
		await fleetGuard(pi, { env: {}, seatScratch: { ledgerPath: join(cwd, "budgets.json") }, ...deps });
		for (const start of pi.startups) await start({}, { cwd, sessionManager: { getSessionId: () => session ?? undefined } });
	} finally {
		if (previous === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = previous;
	}
}

type ToolCallHandler = (event: FleetGuardEvent, context?: { cwd: string; localProtocolOptions?: { getArtifactsDir?: () => string | null }; sessionManager?: { getSessionId?: () => string | undefined } }) => Promise<FleetGuardBlock | undefined>;
type StartupHandler = (event: unknown, context: { cwd: string; sessionManager: { getSessionId: () => string | undefined } }) => void | Promise<void>;
type ShutdownHandler = (event: unknown, context?: { sessionManager?: { getSessionId?: () => string | undefined } }) => Promise<void>;

interface FakePi {
	labels: string[];
	handlers: ToolCallHandler[];
	startups: StartupHandler[];
	shutdowns: ShutdownHandler[];
	setLabel(label: string): void;
	on(event: string, handler: (...args: never[]) => unknown): void;
}

function fakePi(): FakePi {
	return {
		labels: [],
		handlers: [],
		startups: [],
		shutdowns: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(event: string, handler: (...args: never[]) => unknown): void {
			if (event === "session_shutdown") this.shutdowns.push(handler as ShutdownHandler);
			else if (event === "session_start") this.startups.push(handler as StartupHandler);
			else this.handlers.push(handler as ToolCallHandler);
		},
	};
}

function fixture(fleet = true): { cwd: string; pid: number } {
	const cwd = freshDir(fleetBase, "fleet-entry-");
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
	await seated(pi, deps);
	const repoRoot = cwd;
	expect(process.env.TMPDIR).toBe(join(repoRoot, "var", "agent-tmp", `omp.${pid}`));
	const owner = readFileSync(join(repoRoot, "var", "agent-tmp", `omp.${pid}`, ".owner"), "utf8");
	// TMPREDIRECT1: the seat dir carries the ownership API's record (capability, bin, process identity).
	expect(owner).toContain(`pid=${pid}\n`);
	expect(owner).toContain("label=omp\n");
	expect(owner).toContain("bin=throwaway\n");
	expect(parseOwnerFile(owner)).toMatchObject({ pid, label: "omp", bin: "throwaway", agent: null, session: null });
	expect(owner).toMatch(/capability_sha256=[0-9a-f]{64}\n/);
	const handler = pi.handlers[0]!;
	// TMPREWRITE1: a literal simple /tmp file is completed into the session scratch, not refused.
	const completed = await handler({ toolName: "write", input: { path: "/tmp/x", content: "probe\n" } } as never); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect(completed?.block).not.toBe(true);
	expect(completed?.input).toMatchObject({ path: join(repoRoot, "var", "agent-tmp", `omp.${pid}`, "x") });
	expect(completed?.additionalContext).toBe(`AUTO_COMPLETED: /tmp/x -> ${join(repoRoot, "var", "agent-tmp", `omp.${pid}`, "x")}`);
	// a later read of the same literal reads the same file.
	const quiet = await handler({ toolName: "read", input: { path: "/tmp/x" } } as never); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect(quiet?.input).toMatchObject({ path: join(repoRoot, "var", "agent-tmp", `omp.${pid}`, "x") });
});

test("TMPREWRITE1-adopt: an admitted mkdir lets the session adopt the ownerless dir, and session end releases it", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	const released: string[] = [];
	const seatEnd: SeatEndDeps = { startOf: () => "Mon Oct  5 13:27:00 2026", release: (dir) => {
		released.push(dir);
		return { ok: true, changed: true, dir, reason: "released", ownerPid: pid };
	} };
	await seated(pi, { cwd, pid, env: { AGENT_NAME: "AdoptFlow" }, seatEnd });
	const handler = pi.handlers[0]!;
	const ctx = { cwd, sessionManager: { getSessionId: () => SESSION } };
	// an admitted mkdir records the session-created top.
	expect(await handler({ toolName: "bash", input: { command: "mkdir -p var/agent-tmp/hand.9" } }, ctx)).toBeUndefined();
	// the tool creates the dir; the first write then adopts the ownerless dir the session just made.
	mkdirSync(join(cwd, "var", "agent-tmp", "hand.9"));
	const completed = await handler({ toolName: "write", input: { path: "var/agent-tmp/hand.9/out.json", content: "flow\n" } }, ctx);
	expect(completed?.additionalContext).toContain("AUTO_COMPLETED: adopted ownerless scratch dir");
	const owner = readFileSync(join(cwd, "var", "agent-tmp", "hand.9", ".owner"), "utf8");
	expect(owner).toContain("agent=AdoptFlow\n");
	expect(owner).toContain("bin=throwaway\n");
	expect(parseOwnerFile(owner)).toMatchObject({ agent: "AdoptFlow", session: SESSION });
	// session end releases the seat dir and the adopted dir with the same mechanism.
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	expect(released).toContain(join(cwd, "var", "agent-tmp", `omp.${pid}`));
	expect(released).toContain(join(cwd, "var", "agent-tmp", "hand.9"));
});

const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const ownerOf = (cwd: string, pid: number): string => readFileSync(join(cwd, "var", "agent-tmp", `omp.${pid}`, ".owner"), "utf8");

test("OWNERKEY1: startup binds the agent and omp session; a subagent cannot take over", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await seated(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" } });
	const handler = pi.handlers[0]!;
	const first = ownerOf(cwd, pid);
	expect(first).toContain(`pid=${pid}\n`);
	expect(first).toContain("label=omp\n");
	expect(first).toContain(`agent=TurquoiseSummit\nsession=${SESSION}\n`);
	// A later call from a subagent session must not replace the main session.
	await handler({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => "01a1502a-5647-76ba-89c5-949087f3e283" } });
	expect(ownerOf(cwd, pid)).toBe(first);
});

test("OWNERKEY1: without a host agent name, or without a session id, the seat owner stays pid-only", async () => {
	for (const [env, session] of [[{}, SESSION], [{ AGENT_NAME: "TurquoiseSummit" }, undefined], [{ AGENT_NAME: "../evil" }, SESSION]] as const) {
		const pi = fakePi();
		const { cwd, pid } = fixture();
		await seated(pi, { cwd, pid, env }, session ?? null);
		await pi.handlers[0]!({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => session } });
		expect(ownerOf(cwd, pid).trim().split("\n").map((line) => line.split("=")[0])).toEqual(["pid", "process_start", "label", "repo", "created_at", "argv0", "bin", "capability_sha256"]);
	}
});

test("SCRATCHBIN1: a session's own dir names its bin and seat at creation", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await seated(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" } });
	const recorded = ownerOf(cwd, pid);
	expect(recorded).toContain(`agent=TurquoiseSummit\nsession=${SESSION}\n`);
	expect(recorded).toContain("bin=throwaway\n");
	expect(parseOwnerFile(recorded)).toMatchObject({ agent: "TurquoiseSummit", session: SESSION, bin: "throwaway" });
});

const STARTED = "Mon Oct 19 01:00:00 2026";
const seatEndDeps = (released: string[], env: Record<string, string | undefined> = {}): SeatEndDeps => ({ startOf: () => STARTED, env, now: Date.UTC(2026, 9, 19, 1, 30, 0),
	release: (dir, agent, session) => { released.push(`${dir} ${agent} ${session}`); return { ok: true, changed: true, dir, reason: "owner-released", ownerPid: null }; } });

test("SCRATCHBIN1: the session that recorded the seat releases its dir when it ends; a subagent's end and an unrecorded seat release nothing", async () => {
	const released: string[] = [];
	const unseated = fakePi();
	const unseatedRepo = fixture();
	await seated(unseated, { ...unseatedRepo, seatEnd: seatEndDeps(released) }, null);
	await unseated.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	expect(released).toEqual([]);
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await seated(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: seatEndDeps(released) });
	expect(pi.shutdowns).toHaveLength(1);
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => "01a1502a-5647-76ba-89c5-949087f3e283" } });
	expect(released).toEqual([]);
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	expect(released).toEqual([`${join(cwd, "var", "agent-tmp", `omp.${pid}`)} TurquoiseSummit ${SESSION}`]);
});

test("SCRATCHBIN1 planted negative: a respawn's session end leaves the dir for the successor", async () => {
	const state = freshDir(fleetBase, "fleet-intent-");
	roots.push(state);
	const released: string[] = [];
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await seated(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: seatEndDeps(released, { XDG_STATE_HOME: state }) });
	await pi.handlers[0]!({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => SESSION } });
	mkdirSync(join(state, "omp-kit-orchestration"));
	writeFileSync(join(state, "omp-kit-orchestration", `respawn-intent.${pid}.json`),
		JSON.stringify({ pid, start: STARTED, agent: "TurquoiseSummit", session: SESSION, block: "b", at: "2026-10-19T01:29:00Z", ttl_s: 900, kind: "respawn" }));
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	expect(released).toEqual([]);
});

test("SCRATCHBIN1: with the real release, the ended session's dir carries the throwaway release marker and its owner is untouched", async () => {
	const home = freshDir(fleetBase, "fleet-home-");
	roots.push(home);
	const project = join(home, "Developer", "proj");
	mkdirSync(join(project, ".omp"), { recursive: true });
	mkdirSync(join(project, "var", "agent-tmp"), { recursive: true });
	writeFileSync(join(project, ".omp", "fleet.json"), '{"enabled":true}\n');
	Bun.spawnSync(["git", "-C", project, "init", "--quiet"], { stdout: "pipe", stderr: "pipe" });
	const pi = fakePi();
	const pid = process.pid;
	await seated(pi, { cwd: project, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: liveSeatEndDeps(home) });
	await pi.handlers[0]!({ toolName: "read", input: { path: join(project, "x") } } as never, { cwd: project, sessionManager: { getSessionId: () => SESSION } });
	const dir = join(project, "var", "agent-tmp", `omp.${pid}`);
	const owner = ownerOf(project, pid);
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	const marker = readFileSync(join(dir, ".omp-kit-release"), "utf8");
	expect(marker).toContain("bin=throwaway\n");
	expect(ownerOf(project, pid)).toBe(owner);
});

test("scratch fires before git and reservations in the chain", async () => {
	const both = await handleToolCall({ toolName: "bash", command: "git add -A" }, { cwd: "/tmp" });
	expect(both?.reason).toContain("fleet-guard blanket-git");
	const foreign = await handleToolCall(
		{ toolName: "edit", input: { path: "/tmp/elsewhere.md" } }, { cwd: "/tmp" }); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect(foreign?.reason).toContain("fleet-guard scratch-write");
});

test("TMPREWRITE1-L1: the session-scratch hint names only the calling repository", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	const other = fixture(false).cwd;
	await seated(pi, { cwd, pid });
	// same repo, still refused: the hint names the seat dir.
	const same = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/sub/x", content: "probe\n" } }, { cwd }); // tempsafe: fake guard input path, never touched on disk
	expect(same?.reason).toContain("Session scratch:");
	expect(same?.reason).toContain(join(cwd, "var", "agent-tmp", `omp.${pid}`));
	// another repo without opt-in: today's refusal is byte-identical, no cross-repo hint.
	const foreign = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/sub/x", content: "probe\n" } }, { cwd: other }); // tempsafe: fake guard input path, never touched on disk
	expect(foreign?.reason).not.toContain("Session scratch:");
	expect(foreign?.reason).toContain("fleet-guard system-temp");
});

test("logical routes traverse the chain without globally allowing tool calls", async () => {
	for (const path of ["proc://owned-job/kill", "agent://coordinator", "xd://report_issue"])
		expect(await handleToolCall({ toolName: "write", input: { path } }, { cwd: "/private/tmp" })).toBeUndefined();
	// A mixed target must still hit scratch, and a later reservation refusal must survive.
	expect((await handleToolCall({ toolName: "edit", input: { paths: ["agent://coordinator", "/tmp/out"] } }, // tempsafe: fake tool-input path the guard only judges, never touched on disk
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
	await seated(pi, { cwd, pid });
	const handler = pi.handlers[0]!;
	const event = { toolName: "write", input: { path: "local://notes/out" } };
	expect(await handler(event, { cwd: callingCwd, localProtocolOptions: { getArtifactsDir: () => join(cwd, "artifacts") } })).toBeUndefined();
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => "/tmp/foreign-artifacts" } }))?.reason).toContain("scratch-write"); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => null } }))?.reason).toContain("backing root");
	expect((await handler(event, { cwd }))?.reason).toContain("backing root");
	expect(await handler({ toolName: "write", input: { path: "proc://owned-job/kill" } }, { cwd: callingCwd })).toBeUndefined();
});

// WRITEOWN1 (ompkit-vf33j) + WRITEOWNCHILD1 (ompkit-1ra0d.126): the decision is the caller's attested Board
// read; a failed read refuses, while a free path auto-reserves for the seat and admits. The Board is a fake
// out-of-process server (tests/fleet-guard/board-fixture.ts); the guard's child spawn runs unchanged.
test("canonical edits follow the caller's attested reservation read; a free path auto-reserves, a failed read refuses", async () => {
	const { cwd: dir } = fixture();
	const target = join(dir, "tracked.md");
	writeFileSync(target, "x\n");
	await startBoard(dir);
	const saved = { AGENT_NAME: process.env.AGENT_NAME, BOARD_URL: process.env.BOARD_URL };
	process.env.AGENT_NAME = "tester";
	const row = (path: string, extra: Partial<BoardRow> = {}): BoardRow => ({ agent: "tester", path, exclusive: true, remaining_seconds: 600, ...extra });
	try {
		const event = { toolName: "edit", input: { path: target } };
		// The later HTTP reservation layer is held neutral (covered) so each verdict below is the write-ownership read's.
		const context = { cwd: dir, warn: () => {}, lookupReservations: async () => ({ covered: true, conflicts: [] as readonly unknown[] }) };
		await boardScenario({ rows: [row("tracked.md")] });
		expect(await handleToolCall(event, context)).toBeUndefined();
		await boardScenario({ rows: [] });
		expect(await handleToolCall(event, context)).toBeUndefined();
		expect(boardLog([dir]).some((line) => line.startsWith(`file_reservations reserve ${dir} tester tracked.md`)), "a free path auto-reserved").toBe(true);
		await boardScenario({ rows: [row("tracked.md")], down: true });
		const failed = (await handleToolCall(event, context))?.reason ?? "";
		expect(failed).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		expect(failed).toContain("the Board could not be read");
		// A shared or expired own row covers nothing: the free path auto-reserves instead of refusing.
		await boardScenario({ rows: [row("tracked.md", { exclusive: false }), row("tracked.md", { remaining_seconds: 0 })] });
		expect(await handleToolCall(event, context)).toBeUndefined();
		// Planted: another seat's exclusive hold on the path refuses, naming the holder.
		await boardScenario({ rows: [row("tracked.md", { agent: "PeerHolder" })] });
		const held = (await handleToolCall(event, context))?.reason ?? "";
		expect(held).toContain("WRITE_OWN_UNRESERVED");
		expect(held).toContain("PeerHolder");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});


test("filesystem refusals survive an unavailable storage-root lookup", async () => {
	const saved = { url: process.env.AGENTMAIL_HTTP_URL, token: process.env.AGENTMAIL_HTTP_BEARER_TOKEN, root: process.env.AGENT_MAIL_STORAGE_ROOT };
	process.env.AGENTMAIL_HTTP_URL = "http://127.0.0.1:1/api";
	delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN;
	delete process.env.AGENT_MAIL_STORAGE_ROOT;
	const pi = fakePi();
	const { cwd, pid } = fixture();
	try {
		await seated(pi, { cwd, pid });
		const completed = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/refused", content: "probe\n" } }, { cwd }); // tempsafe: fake tool-input path the guard only judges, never touched on disk
		// TMPREWRITE1: the literal completes despite the unavailable lookup; the recheck still runs first.
		expect(completed?.additionalContext).toContain("AUTO_COMPLETED: /tmp/refused -> ");
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
	await seated(pi, { cwd, pid: process.pid });
	expect(existsSync(join(cwd, "var", "agent-tmp"))).toBe(false);
	expect(process.env.TMPDIR).toBe(previousTmp);
});

test.each(["directory-missing", "marker-missing"])("stock marker absence (%s) permits owned temp writes and ordinary Git without fleet state", async missing => {
	const { cwd } = fixture(false);
	if (missing === "marker-missing") mkdirSync(join(cwd, ".omp"));
	const pi = fakePi();
	await seated(pi, { cwd, pid: process.pid });
	const admit = async (event: Parameters<ToolCallHandler>[0]): Promise<void> => {
		for (const handler of pi.handlers) {
			const result = await handler(event, { cwd });
			expect(result?.block === true).toBe(false);
		}
	};
	const temp = ownedTmp("stock-write", { root: fleetBase }).path;
	roots.push(temp);
	const target = join(temp, "x");
	await admit({ toolName: "write", input: { path: target, content: "stock temporary output\n" } });
	writeFileSync(target, "stock temporary output\n");
	expect(readFileSync(target, "utf8")).toBe("stock temporary output\n");
	// TMPWRITE1: system temp stays refused without the opt-in (judged only; never created on disk).
	for (const handler of pi.handlers)
		expect((await handler({ toolName: "write", input: { path: "/tmp/x", content: "stock temporary output\n" } }, { cwd }))?.reason).toContain("fleet-guard system-temp"); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	const git = (...args: string[]): string => {
		const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString();
	};
	await admit({ toolName: "bash", input: { command: "git checkout -b stock-topic" } });
	git("checkout", "-b", "stock-topic");
	expect(git("symbolic-ref", "--short", "HEAD").trim()).toBe("stock-topic");
	writeFileSync(join(cwd, "change.txt"), "ordinary stock change\n");
	await admit({ toolName: "bash", input: { command: "git add -A" } });
	git("add", "-A");
	expect(git("diff", "--cached", "--name-only")).toBe("change.txt\n");
	expect(existsSync(join(cwd, "var", "agent-tmp"))).toBe(false);
});

// TMPWRITE1 (ompkit-fp72.120.16.158): a background subagent ran `mktemp -d /tmp/x` and `git clone <repo> /tmp/x` from a
// cwd without the fleet opt-in, where the guard registered only the plutil check. System temp is refused everywhere.
test.each([["stock repository", (): string => fixture(false).cwd], ["opted-in repository", (): string => fixture().cwd]] as const)("TMPWRITE1: %s sessions refuse system-temp writes and admit owned scratch", async (_label, make) => {
	const cwd = make();
	const pi = fakePi();
	await seated(pi, { cwd, pid: process.pid });
	const judge = async (command: string, callingCwd = cwd): Promise<string | undefined> => {
		for (const handler of pi.handlers) {
			const result = await handler({ toolName: "bash", input: { command } }, { cwd: callingCwd });
			if (result?.block) return result.reason;
		}
		return undefined;
	};
	// Planted fire: the incident forms and the listed sinks (fake commands the guard only judges, never run).
	for (const command of ["mktemp -d /tmp/x.XXXXXX", "git clone https://example.invalid/r.git /tmp/x", "git worktree add /private/tmp/wt",
		"cp a /var/tmp/b", "rsync -a src/ /var/folders/zz/x/", "tar -xzf a.tgz -C /tmp/out", "echo hi > /private/var/folders/q"])
		expect(await judge(command), command).toContain("scratch");
	// A subagent whose own cwd is system temp cannot clone into it either.
	expect(await judge("git clone https://example.invalid/r.git", "/tmp")).toBeDefined();
	// Quiet controls: owned scratch, reads of system temp, the remedy itself.
	for (const command of ["mkdir -p var/agent-tmp/x && echo hi > var/agent-tmp/x/f", "cat /tmp/x", "cp /tmp/a var/agent-tmp/b",
		"omp-kit scratch new --label probe --json", "git clone /tmp/src var/agent-tmp/clone"])
		expect(await judge(command), command).toBeUndefined();
});

// CONTENTION1 (ompkit-fp72.120.16.172): the check is a pure function over command text; no loop ever runs here.
const bashCall = (command: string): FleetGuardEvent => ({ toolName: "bash", input: { command } });
test("CONTENTION1 planted: an unbounded busy loop outside the heavy lane is refused with the heavy-lane remedy", () => {
	for (const command of ["while :; do :; done", "while true; do :; done &", "yes > /dev/null", "sh -c 'while :; do :; done' &"]) {
		const refusal = checkContention(bashCall(command), 32);
		expect(refusal?.block, command).toBe(true);
		expect(refusal?.reason).toContain("omp-kit heavy --label <x> -- timeout <s> nice -n 19 <cmd>");
		expect(refusal?.reason).toContain("load1 < ncpu");
	}
});
test("CONTENTION1 planted: a 64-copy busy-loop fan-out is refused, even inside the heavy lane", () => {
	const fanout = "for i in $(seq 64); do sh -c 'while :; do :; done' & done";
	expect(checkContention(bashCall(fanout), 32)?.reason).toContain("64");
	expect(checkContention(bashCall(`omp-kit heavy --label c -- timeout 30 nice -n 19 sh -c "${fanout}"`), 32)?.block).toBe(true);
});
test("CONTENTION1 control: a bounded heavy-wrapped fixture of at most ncpu/2 loops is admitted", () => {
	expect(checkContention(bashCall("omp-kit heavy --label contention -- timeout 30 nice -n 19 sh -c 'for i in $(seq 16); do sh -c \"while :; do :; done\" & done; wait'"), 32)).toBeUndefined();
	expect(checkContention(bashCall("omp-kit heavy --label contention -- timeout 30 nice -n 19 sh -c 'while :; do :; done'"), 32)).toBeUndefined();
	expect(checkContention(bashCall("omp-kit heavy --label contention -- sh -c 'while :; do :; done'"), 32)?.block).toBe(true);
});
test("CONTENTION1 control: ordinary loops are admitted", () => {
	for (const command of ["while read line; do echo \"$line\"; done < f", "for f in *; do wc -l \"$f\"; done", "while :; do sleep 5; check || break; done", "yes | head -3", "for i in $(seq 64); do echo $i & done"]) {
		expect(checkContention(bashCall(command), 32), command).toBeUndefined();
	}
});
test("CONTENTION1: a 60k near-miss is judged in under 2 s", () => {
	const started = performance.now();
	for (const command of [`while ${" ".repeat(60_000)}x`, `while :${" ".repeat(60_000)};do x`, `for i in $(seq ${"9".repeat(60_000)}`, `yes ${"a".repeat(60_000)}`, "while :;".repeat(7_500)]) checkContention(bashCall(command), 32);
	expect(performance.now() - started).toBeLessThan(2_000);
});

// SCRATCHOWNERREPO1 (ompkit-1ra0d.196): the scratch's owning repo (the directory above
// /var/agent-tmp/) is the reference, never the caller's cwd. A write to a sibling repo's
// owned scratch from another repo's cwd is admitted; a tracked-source copy into that sibling
// scratch is still refused against the sibling's index; a var/agent-tmp under a non-repo dir
// is refused naming the path.
test("SCRATCHOWNERREPO1: a sibling repo's owned scratch is admitted from another repo's cwd", async () => {
	const caller = fixture();
	const sibling = fixture();
	const siblingPi = fakePi();
	await seated(siblingPi, { cwd: sibling.cwd, pid: sibling.pid });
	const scratch = join(sibling.cwd, "var", "agent-tmp", `omp.${sibling.pid}`);
	const target = join(scratch, "notes.txt");
	// Planted negative: the old caller-repo reference refuses this write (the sibling
	// physical path is not under the caller's scratch root), so it cannot be the reference.
	const callerScratchRoot = join(caller.cwd, "var", "agent-tmp");
	expect(target.startsWith(`${callerScratchRoot}/`)).toBe(false);
	const admitted = await checkDurability(
		{ toolName: "write", input: { path: target, content: "synthetic probe\n" } },
		{ cwd: caller.cwd });
	expect(admitted).toBeUndefined();
});
test("SCRATCHOWNERREPO1: a tracked-source copy into the sibling scratch is refused against the sibling index", async () => {
	const caller = fixture();
	const sibling = fixture();
	const siblingPi = fakePi();
	await seated(siblingPi, { cwd: sibling.cwd, pid: sibling.pid });
	const scratch = join(sibling.cwd, "var", "agent-tmp", `omp.${sibling.pid}`);
	writeFileSync(join(sibling.cwd, "tracked.txt"), "sibling canonical\n");
	expect(runFixture(["git", "-C", sibling.cwd, "add", "tracked.txt"], { cwd: sibling.cwd }).rc).toBe(0);
	const target = join(scratch, "copy.txt");
	const refused = await checkDurability(
		{ toolName: "write", input: { path: target, content: "sibling canonical\n" } },
		{ cwd: caller.cwd });
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("tracked-source-copy");
	expect(refused?.reason).toContain(target);
});
test("SCRATCHOWNERREPO1: a var/agent-tmp under a non-repo dir is refused naming the path", async () => {
	const caller = fixture();
	const plain = freshDir(fleetBase, "fleet-norepo-");
	roots.push(plain);
	const target = join(plain, "var", "agent-tmp", "hand.1", "out.txt");
	const refused = await checkDurability(
		{ toolName: "write", input: { path: target, content: "synthetic probe\n" } },
		{ cwd: caller.cwd });
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain(target);
});
test("SCRATCHOWNERREPO1: every refusal names the physical path", async () => {
	const caller = fixture();
	const sibling = fixture();
	const siblingPi = fakePi();
	await seated(siblingPi, { cwd: sibling.cwd, pid: sibling.pid });
	const scratch = join(sibling.cwd, "var", "agent-tmp", `omp.${sibling.pid}`);
	const script = join(scratch, "rerun.sh");
	const refused = await checkDurability(
		{ toolName: "write", input: { path: script, content: "echo hi\n" } },
		{ cwd: caller.cwd });
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain(script);
	const packet = join(scratch, "packet-plan.md");
	const packetRefused = await checkDurability(
		{ toolName: "write", input: { path: packet, content: "synthetic probe\n" } },
		{ cwd: caller.cwd });
	expect(packetRefused?.block).toBe(true);
	expect(packetRefused?.reason).toContain(packet);
});
// INSTALLAMP1 (ompkit-1ra0d.203): inside an ovnfs checkout node_modules is a cache path, so a
// plain install whose lockfile is byte-identical to the source folder's completes with a notice
// and runs nothing. `ovnfs` is a PATH seam; the guard's spawn runs unchanged.
function fakeOvnfs(bin: string): void {
	writeFileSync(join(bin, "ovnfs"), "#!" + process.execPath + "\n" + [
		"const rows = JSON.parse(process.env.OVNFS_FIXTURE_ROWS || '[]');",
		"if (process.argv[2] === 'ls') {",
		"  process.stdout.write(JSON.stringify({ checkouts: rows.map((r) => ({ name: 'fixture', dirty: false, created: null, touched: null, ...r })) }));",
		"  process.exit(0);",
		"}",
		"console.error('unexpected ovnfs call: ' + process.argv.slice(2).join(' '));",
		"process.exit(1);",
	].join("\n") + "\n", { mode: 0o755 });
}

/** A source folder and a checkout folder, each carrying lockName; the fake ovnfs maps checkout -> source. */
function installPair(lockName: string, checkoutLock: string | null, sourceLock: string | null, opts: { checkoutPkg?: string | null; sourcePkg?: string | null; sourceDeps?: boolean } = {}): { checkout: string; source: string } {
	const source = freshDir(fleetBase, "fleet-install-source-");
	roots.push(source);
	const checkout = freshDir(fleetBase, "fleet-install-checkout-");
	roots.push(checkout);
	if (sourceLock !== null) writeFileSync(join(source, lockName), sourceLock);
	if (checkoutLock !== null) writeFileSync(join(checkout, lockName), checkoutLock);
	const checkoutPkg = opts.checkoutPkg === undefined ? "{}\n" : opts.checkoutPkg;
	const sourcePkg = opts.sourcePkg === undefined ? "{}\n" : opts.sourcePkg;
	if (sourcePkg !== null) writeFileSync(join(source, "package.json"), sourcePkg);
	if (checkoutPkg !== null) writeFileSync(join(checkout, "package.json"), checkoutPkg);
	if (opts.sourceDeps !== false) mkdirSync(join(source, "node_modules"));
	const bin = freshDir(fleetBase, "fleet-install-bin-");
	roots.push(bin);
	fakeOvnfs(bin);
	process.env.OVNFS_FIXTURE_ROWS = JSON.stringify([{ path: checkout, source }]);
	process.env.PATH = `${bin}:${savedPath}`;
	return { checkout, source };
}

const savedPath = process.env.PATH ?? "";
afterEach(() => {
	if (process.env.OVNFS_FIXTURE_ROWS !== undefined) delete process.env.OVNFS_FIXTURE_ROWS;
	process.env.PATH = savedPath;
});
test.each([
	["pnpm install", "pnpm-lock.yaml"],
	["pnpm i", "pnpm-lock.yaml"],
	["npm ci", "package-lock.json"],
	["bun install", "bun.lock"],
] as const)("INSTALLAMP1: an identical lockfile completes `%s` with the source notice and runs nothing", (command, lockName) => {
	const { checkout, source } = installPair(lockName, "lock-A\n", "lock-A\n");
	const completed = maybeInstallCheckout({ toolName: "bash", input: { command } }, { callingCwd: checkout });
	expect(completed?.additionalContext).toContain("dependencies already current through the source folder");
	expect(completed?.additionalContext).toContain(source);
	expect(completed?.additionalContext).toContain("nothing installed");
	expect(completed?.input).toMatchObject({ command: ":" });
	expect(completed?.input?.command).not.toContain("install");
});

test("INSTALLAMP1: a changed or missing lockfile, extra args, a compound command, or no checkout runs", () => {
	const changed = installPair("pnpm-lock.yaml", "lock-B\n", "lock-A\n");
	expect(maybeInstallCheckout({ toolName: "bash", input: { command: "pnpm install" } }, { callingCwd: changed.checkout })).toBeUndefined();
	const missing = installPair("pnpm-lock.yaml", "lock-A\n", null);
	expect(maybeInstallCheckout({ toolName: "bash", input: { command: "pnpm install" } }, { callingCwd: missing.checkout })).toBeUndefined();
	const same = installPair("pnpm-lock.yaml", "lock-A\n", "lock-A\n");
	for (const command of ["pnpm add x", "pnpm install --frozen-lockfile", "pnpm install && pnpm test", "pnpm install > log.txt", "npm install", "bun add x"]) {
		expect(maybeInstallCheckout({ toolName: "bash", input: { command } }, { callingCwd: same.checkout }), command).toBeUndefined();
	}
	expect(maybeInstallCheckout({ toolName: "bash", input: { command: "pnpm install" } }, { callingCwd: same.source })).toBeUndefined();
});

test("INSTALLAMP1: a source without node_modules runs the install", () => {
	const { checkout } = installPair("pnpm-lock.yaml", "lock-A\n", "lock-A\n", { sourceDeps: false });
	expect(maybeInstallCheckout({ toolName: "bash", input: { command: "pnpm install" } }, { callingCwd: checkout })).toBeUndefined();
});

test.each([
	["changed source package.json", { sourcePkg: "{\"b\":1}\n" } as const],
	["missing source package.json", { sourcePkg: null } as const],
	["missing checkout package.json", { checkoutPkg: null } as const],
] as const)("INSTALLAMP1: the same lockfile with a %s runs the install", (_label, opts) => {
	const { checkout } = installPair("pnpm-lock.yaml", "lock-A\n", "lock-A\n", opts);
	expect(maybeInstallCheckout({ toolName: "bash", input: { command: "pnpm install" } }, { callingCwd: checkout })).toBeUndefined();
});

test("INSTALLAMP1 planted negative: the current guard chain passes the identical-lockfile install through", async () => {
	const { checkout } = installPair("pnpm-lock.yaml", "lock-A\n", "lock-A\n");
	expect(await handleToolCall({ toolName: "bash", input: { command: "pnpm install" } }, { cwd: checkout })).toBeUndefined();
});
