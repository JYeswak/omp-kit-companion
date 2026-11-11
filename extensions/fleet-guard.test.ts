import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard, { checkContention, handleToolCall, type GuardDeps } from "./fleet-guard.ts";
import { liveSeatEndDeps, type SeatEndDeps } from "../src/fleet-guard/seat-end.ts";
import { clearReservationCache } from "../src/fleet-guard/reservations.ts";
import type { FleetGuardBlock, FleetGuardEvent } from "../src/fleet-guard/scratch.ts";
import { parseOwnerFile } from "../src/scratch.ts";
import { ownedTmp } from "../src/kitlib/tmp.ts";

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

type ToolCallHandler = (event: FleetGuardEvent, context?: { cwd: string; localProtocolOptions?: { getArtifactsDir?: () => string | null }; sessionManager?: { getSessionId?: () => string | undefined } }) => Promise<FleetGuardBlock | undefined>;
type ShutdownHandler = (event: unknown, context?: { sessionManager?: { getSessionId?: () => string | undefined } }) => Promise<void>;

interface FakePi {
	labels: string[];
	handlers: ToolCallHandler[];
	shutdowns: ShutdownHandler[];
	setLabel(label: string): void;
	on(event: string, handler: (...args: never[]) => unknown): void;
}

function fakePi(): FakePi {
	return {
		labels: [],
		handlers: [],
		shutdowns: [],
		setLabel(label: string): void {
			this.labels.push(label);
		},
		on(event: string, handler: (...args: never[]) => unknown): void {
			if (event === "session_shutdown") this.shutdowns.push(handler as ShutdownHandler);
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
	await fleetGuard(pi, deps);
	const repoRoot = cwd;
	expect(process.env.TMPDIR).toBe(join(repoRoot, "var", "agent-tmp", `omp.${pid}`));
	const owner = readFileSync(join(repoRoot, "var", "agent-tmp", `omp.${pid}`, ".owner"), "utf8");
	expect(owner).toContain(`pid=${pid}\nlabel=omp\n`);
	const handler = pi.handlers[0]!;
	const blocked = await handler({ toolName: "write", input: { path: "/tmp/x" } } as never); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect(blocked?.block).toBe(true);
	expect(blocked?.reason).toContain("fleet-guard scratch-write");
	const quiet = await handler({ toolName: "read", input: { path: "/tmp/x" } } as never); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect(quiet).toBeUndefined();
});

const SESSION = "01a15012-af9e-7628-bee6-496084668412";
const ownerOf = (cwd: string, pid: number): string => readFileSync(join(cwd, "var", "agent-tmp", `omp.${pid}`, ".owner"), "utf8");

test("OWNERKEY1: the first tool call records the agent and its omp session in the seat owner, once", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await fleetGuard(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" } });
	// Before any call the session is unknown: the owner is the pid-only record it always was.
	expect(ownerOf(cwd, pid)).not.toContain("session=");
	const handler = pi.handlers[0]!;
	await handler({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => SESSION } });
	const first = ownerOf(cwd, pid);
	expect(first).toContain(`pid=${pid}\nlabel=omp\n`);
	expect(first).toContain(`agent=TurquoiseSummit\nsession=${SESSION}\n`);
	// A later call from a subagent session must not replace the main session.
	await handler({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => "01a1502a-5647-76ba-89c5-949087f3e283" } });
	expect(ownerOf(cwd, pid)).toBe(first);
});

test("OWNERKEY1: without a host agent name, or without a session id, the seat owner stays pid-only", async () => {
	for (const [env, session] of [[{}, SESSION], [{ AGENT_NAME: "TurquoiseSummit" }, undefined], [{ AGENT_NAME: "../evil" }, SESSION]] as const) {
		const pi = fakePi();
		const { cwd, pid } = fixture();
		await fleetGuard(pi, { cwd, pid, env });
		await pi.handlers[0]!({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => session } });
		expect(ownerOf(cwd, pid).trim().split("\n").map((line) => line.split("=")[0])).toEqual(["pid", "label", "repo", "created", "bin"]);
	}
});

test("SCRATCHBIN1: a session's own dir names its bin at creation and keeps it when the session is recorded", async () => {
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await fleetGuard(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" } });
	expect(ownerOf(cwd, pid)).toContain("bin=throwaway\n");
	await pi.handlers[0]!({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => SESSION } });
	const recorded = ownerOf(cwd, pid);
	expect(recorded).toContain(`agent=TurquoiseSummit\nsession=${SESSION}\nbin=throwaway\n`);
	expect(parseOwnerFile(recorded)).toMatchObject({ agent: "TurquoiseSummit", session: SESSION, bin: "throwaway" });
});

const STARTED = "Mon Oct 19 01:00:00 2026";
const seatEndDeps = (released: string[], env: Record<string, string | undefined> = {}): SeatEndDeps => ({ startOf: () => STARTED, env, now: Date.UTC(2026, 9, 19, 1, 30, 0),
	release: (dir, agent, session) => { released.push(`${dir} ${agent} ${session}`); return { ok: true, changed: true, dir, reason: "owner-released", ownerPid: null }; } });

test("SCRATCHBIN1: the session that recorded the seat releases its dir when it ends; a subagent's end and an unrecorded seat release nothing", async () => {
	const released: string[] = [];
	const pi = fakePi();
	const { cwd, pid } = fixture();
	await fleetGuard(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: seatEndDeps(released) });
	expect(pi.shutdowns).toHaveLength(1);
	await pi.shutdowns[0]!({}, { sessionManager: { getSessionId: () => SESSION } });
	expect(released).toEqual([]);
	await pi.handlers[0]!({ toolName: "read", input: { path: join(cwd, "x") } } as never, { cwd, sessionManager: { getSessionId: () => SESSION } });
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
	await fleetGuard(pi, { cwd, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: seatEndDeps(released, { XDG_STATE_HOME: state }) });
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
	await fleetGuard(pi, { cwd: project, pid, env: { AGENT_NAME: "TurquoiseSummit" }, seatEnd: liveSeatEndDeps(home) });
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
	await fleetGuard(pi, { cwd, pid });
	const handler = pi.handlers[0]!;
	const event = { toolName: "write", input: { path: "local://notes/out" } };
	expect(await handler(event, { cwd: callingCwd, localProtocolOptions: { getArtifactsDir: () => join(cwd, "artifacts") } })).toBeUndefined();
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => "/tmp/foreign-artifacts" } }))?.reason).toContain("scratch-write"); // tempsafe: fake tool-input path the guard only judges, never touched on disk
	expect((await handler(event, { cwd, localProtocolOptions: { getArtifactsDir: () => null } }))?.reason).toContain("backing root");
	expect((await handler(event, { cwd }))?.reason).toContain("backing root");
	expect(await handler({ toolName: "write", input: { path: "proc://owned-job/kill" } }, { cwd: callingCwd })).toBeUndefined();
});

// WRITEOWN1 (ompkit-vf33j) + WRITEOWNCHILD1 (ompkit-1ra0d.126): the decision is the caller's attested
// `am robot reservations` read; a failed read refuses, while a free path auto-reserves for the seat and admits.
// `am` is a PATH test seam; the guard's spawn runs unchanged.
test("canonical edits follow the caller's attested reservation read; a free path auto-reserves, a failed read refuses", async () => {
	const { cwd: dir } = fixture();
	const target = join(dir, "tracked.md");
	writeFileSync(target, "x\n");
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "am"), "#!" + process.execPath + "\n" + [
"import { appendFileSync, existsSync, readFileSync } from 'node:fs';",
"const calls = process.env.AM_FIXTURE_CALLS || '';",
"const journalPath = process.env.AM_FIXTURE_JOURNAL || '';",
"const args = process.argv.slice(2);",
"if (calls !== '') appendFileSync(calls, args.join(' ') + '\\n');",
"if (process.env.AM_FIXTURE_MODE === 'fail') { console.error('database is locked'); process.exit(1); }",
"function journaled(base) {",
"  let response;",
"  try { response = JSON.parse(base); } catch (e) { return base; }",
"  if (journalPath === '' || !existsSync(journalPath)) return JSON.stringify(response);",
"  const project = (function() { const i = args.indexOf('--project'); return i >= 0 ? args[i + 1] : undefined; })() || '';",
"  const agent = (function() { const i = args.indexOf('--agent'); return i >= 0 ? args[i + 1] : undefined; })() || '';",
"  const mine = Array.isArray(response.my_reservations) ? response.my_reservations.slice() : [];",
"  const all = Array.isArray(response.all_active) ? response.all_active.slice() : [];",
"  const lines = readFileSync(journalPath, 'utf8').split('\\n');",
"  for (const line of lines) {",
"    const parts = line.split('|');",
"    if (parts.length < 3 || parts[0] === '' || parts[0] !== project) continue;",
"    const row = { agent: parts[1], path: parts[2], exclusive: true, remaining_seconds: 600 };",
"    if (parts[1] === agent) mine.push(row);",
"    all.push(row);",
"  }",
"  response.my_reservations = mine;",
"  response.all_active = all;",
"  return JSON.stringify(response);",
"}",
"if (args[0] === 'file_reservations' && args[1] === 'reserve') {",
"  const agent = args[3] || '';",
"  const paths = []; let reason = ''; let exclusive = true;",
"  for (let i = 4; i < args.length; i++) {",
"    const a = args[i] || '';",
"    if (a === '--ttl') { i++; continue; }",
"    if (a === '--reason') { reason = args[i + 1] || ''; i++; continue; }",
"    if (a === '--shared') { exclusive = false; continue; }",
"    if (a.indexOf('--') === 0) continue;",
"    paths.push(a);",
"  }",
"  if (journalPath !== '') for (const p of paths) appendFileSync(journalPath, (args[2] || '') + '|' + agent + '|' + p + '\\n');",
"  const granted = paths.map((p, n) => ({ id: n + 1, path_pattern: p, exclusive, reason, expires_ts: '2030-01-01T00:00:00.000Z' }));",
"  process.stdout.write(JSON.stringify({ granted, conflicts: [] }));",
"  process.exit(0);",
"}",
"process.stdout.write(journaled(process.env.AM_FIXTURE_RESPONSE || ''));",
].join('\n') + '\n', { mode: 0o755 });
	const journal = join(dir, "am-journal.log");
	writeFileSync(journal, "");
	process.env.AM_FIXTURE_JOURNAL = journal;
	const saved = { PATH: process.env.PATH, AGENT_NAME: process.env.AGENT_NAME, AM_FIXTURE_MODE: process.env.AM_FIXTURE_MODE, AM_FIXTURE_RESPONSE: process.env.AM_FIXTURE_RESPONSE, AM_FIXTURE_JOURNAL: process.env.AM_FIXTURE_JOURNAL };
	const answer = (mode: "ok" | "fail", ...paths: string[]): void => {
		process.env.AM_FIXTURE_MODE = mode;
		process.env.AM_FIXTURE_RESPONSE = JSON.stringify({
			reservation_read_attestation: { state: "current", database_matches_server: true, storage_root_matches_server: true },
			my_reservations: paths.map(path => ({ agent: "tester", path, exclusive: true, remaining_seconds: 600 })) });
	};
	const current = { state: "current", database_matches_server: true, storage_root_matches_server: true };
	const raw = (response: Record<string, unknown>): void => {
		process.env.AM_FIXTURE_MODE = "ok";
		process.env.AM_FIXTURE_RESPONSE = JSON.stringify(response);
	};
	process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
	process.env.AGENT_NAME = "tester";
	try {
		const event = { toolName: "edit", input: { path: target } };
		// The later HTTP reservation layer is held neutral (covered) so each verdict below is the write-ownership read's.
		const context = { cwd: dir, warn: () => {}, lookupReservations: async () => ({ covered: true, conflicts: [] as readonly unknown[] }) };
		answer("ok", "tracked.md");
		expect(await handleToolCall(event, context)).toBeUndefined();
		answer("ok");
		expect(await handleToolCall(event, context)).toBeUndefined();
		answer("fail", "tracked.md");
		const failed = (await handleToolCall(event, context))?.reason ?? "";
		expect(failed).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		expect(failed).toContain("am exited 1: database is locked");
		// ompkit-rz5.158: am omits my_reservations when the agent holds nothing in the project. A current read without
		// the key is zero holds (reserve it first), never a failed lookup (2026-10-22: RusticPine sent to repair a healthy Agent Mail).
		raw({ reservation_read_attestation: current, all_active: [] });
		expect(await handleToolCall(event, context)).toBeUndefined();
		// A shared or expired own row covers nothing: the free path auto-reserves instead of refusing.
		raw({ reservation_read_attestation: current, my_reservations: [
			{ agent: "tester", path: "tracked.md", exclusive: false, remaining_seconds: 600 },
			{ agent: "tester", path: "tracked.md", exclusive: true, remaining_seconds: 0 }] });
		expect(await handleToolCall(event, context)).toBeUndefined();
		// Planted: a stale read still fails closed, and the refusal names the attestation it saw.
		raw({ reservation_read_attestation: { ...current, state: "stale" }, my_reservations: [{ agent: "tester", path: "tracked.md", exclusive: true, remaining_seconds: 600 }] });
		const stale = (await handleToolCall(event, context))?.reason ?? "";
		expect(stale).toContain("WRITE_OWN_LOOKUP_UNAVAILABLE");
		expect(stale).toContain("state=stale");
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
		await fleetGuard(pi, { cwd, pid });
		const refusal = await pi.handlers[0]!({ toolName: "write", input: { path: "/tmp/refused" } }, { cwd }); // tempsafe: fake tool-input path the guard only judges, never touched on disk
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

test.each(["directory-missing", "marker-missing"])("stock marker absence (%s) permits owned temp writes and ordinary Git without fleet state", async missing => {
	const { cwd } = fixture(false);
	if (missing === "marker-missing") mkdirSync(join(cwd, ".omp"));
	const pi = fakePi();
	await fleetGuard(pi, { cwd, pid: process.pid });
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
	await fleetGuard(pi, { cwd, pid: process.pid });
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
