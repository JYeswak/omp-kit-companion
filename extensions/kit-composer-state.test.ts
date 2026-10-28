import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import kitComposerState, { composerRecordPath, type ComposerStateContext, type ComposerStateRecord } from "./kit-composer-state";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { fleetPolicyState } from "./fleet-policy";

let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = realpathSync(ownedTmp("kit-composer-state").path);
afterAll(() => rmSync(base, { recursive: true, force: true }));

function repo(optedIn: boolean | undefined): string {
	const cwd = freshDir(base, "repo-");
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
	if (optedIn !== undefined) {
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled: optedIn }));
	}
	return cwd;
}

async function seat(opts: { optedIn?: boolean; mode?: string; cwd?: string; env?: Record<string, string | undefined>;
	registry?: unknown; malformedRegistry?: boolean; registryOverride?: boolean } = {}) {
	const handlers = new Map<string, ((event: never, ctx: ComposerStateContext) => unknown)[]>();
	const home = freshDir(base, "home-");
	const registryPath = opts.registryOverride ? join(home, "custom-seats.json") : join(home, ".local", "state", "omp-kit", "cc", "seats.v1.json");
	if (opts.registry !== undefined || opts.malformedRegistry) {
		mkdirSync(join(registryPath, ".."), { recursive: true });
		writeFileSync(registryPath, opts.malformedRegistry ? "{" : JSON.stringify(opts.registry));
	}
	const sessionFile = join(home, "session.jsonl");
	writeFileSync(sessionFile, "");
	const state = { text: "", intervals: 0, cleared: 0 };
	const ticks: Array<() => unknown> = [];
	const ctx: ComposerStateContext = {
		cwd: opts.cwd ?? repo(opts.optedIn ?? true), mode: opts.mode ?? "tui", hasUI: true, isIdle: () => true,
		ui: { getEditorText: () => state.text },
		sessionManager: { getSessionFile: () => sessionFile },
		setInterval: (cb: () => unknown) => { ticks.push(cb); return ++state.intervals; },
		clearTimer: () => void ++state.cleared,
	};
	await kitComposerState({ on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
		{ home, env: { ...opts.env, ...(opts.registryOverride ? { CC_SEATS: registryPath } : {}) }, now: () => 1_000, pid: 4242 });
	const fire = async (event: string) => { for (const h of handlers.get(event) ?? []) await h(undefined as never, ctx); };
	const tick = async () => { for (const cb of ticks) await cb(); };
	const path = composerRecordPath(home, realpathSync(sessionFile));
	const record = () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ComposerStateRecord : null;
	return { state, fire, tick, record, path, sessionFile };
}

test("planted: an empty composer is published as empty, keyed by the session file's realpath", async () => {
	const s = await seat();
	await s.fire("session_start");
	expect(s.record()).toEqual({ schema: 1, session_file: realpathSync(s.sessionFile), pid: 4242, at: 1_000, empty: true, idle: true });
	expect(s.state.intervals).toBe(1);
});

test("a draft is published as not empty, and the record never carries its text", async () => {
	const s = await seat();
	s.state.text = "please also check the inbox";
	await s.fire("session_start");
	expect(s.record()?.empty).toBe(false);
	expect(readFileSync(s.path, "utf8")).not.toContain("inbox");
});

test("a turn boundary republishes the composer as it is now", async () => {
	const s = await seat();
	await s.fire("session_start");
	s.state.text = "typed after the turn";
	await s.fire("agent_end");
	expect(s.record()?.empty).toBe(false);
	s.state.text = "  ";
	await s.fire("agent_start");
	expect(s.record()?.empty).toBe(true);
});

test("control: a repo that did not opt into the fleet, or a non-interactive mode, publishes nothing", async () => {
	const off = await seat({ optedIn: false });
	await off.fire("session_start");
	await off.fire("agent_end");
	expect(off.record()).toBeNull();
	const rpc = await seat({ mode: "rpc" });
	await rpc.fire("session_start");
	expect(rpc.record()).toBeNull();
});

test("shutdown removes the record and clears the interval", async () => {
	const s = await seat();
	await s.fire("session_start");
	expect(s.record()).not.toBeNull();
	await s.fire("session_shutdown");
	expect(s.record()).toBeNull();
	expect(s.state.cleared).toBe(1);
});

function registeredSeat(repo: string) {
	return { schema_version: "omp-kit.cc.seats.v1",
		sessions: [{ plane: "tern", repo, session: "omp-chief", tern_session: "Default",
			seats: [{ pane: "tern:1756641624081", role: "chief" }] }] };
}

const chiefCwd = repo(undefined);

test("planted: a registered chief publishes from a cwd outside its policy repo", async () => {
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: "1756641624081" }, registry: registeredSeat(repo(true)) });
	await s.fire("session_start");
	expect(s.record()).toEqual({ schema: 1, session_file: realpathSync(s.sessionFile), pid: 4242, at: 1_000, empty: true, idle: true });
});

test("control: an unregistered pane outside the policy repo stays silent tick after tick", async () => {
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: "99" }, registry: registeredSeat(repo(true)) });
	await s.fire("session_start");
	// RESTARTRACE1: the interval stays armed so a later listing is noticed; silence is no record, not no timer.
	expect(s.state.intervals).toBe(1);
	await s.tick();
	await s.fire("agent_end");
	await s.tick();
	expect(s.record()).toBeNull();
});

test("planted RESTARTRACE1: a seat unlisted at start publishes on the first tick after the registry lists it", async () => {
	// 2026-10-26 17:26:51Z: the lead's new omp started before the seat registry re-listed its block (17:27:06Z).
	const policyRepo = repo(true);
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: "1756641624081" },
		registry: { schema_version: "omp-kit.cc.seats.v1", sessions: [] } });
	await s.fire("session_start");
	expect(s.record()).toBeNull();
	await s.tick();
	expect(s.record()).toBeNull();
	const registryPath = join(dirname(s.sessionFile), ".local", "state", "omp-kit", "cc", "seats.v1.json");
	writeFileSync(registryPath, JSON.stringify(registeredSeat(policyRepo)));
	await s.tick();
	expect(s.record()).toEqual({ schema: 1, session_file: realpathSync(s.sessionFile), pid: 4242, at: 1_000, empty: true, idle: true });
});

test("planted negative: the old session_start-only decision never publishes for a seat unlisted at start", async () => {
	// Pre-RESTARTRACE1 decision: resolve opt-in once at session_start and arm the interval only if on
	// then. A seat unlisted at start stays silent even after the registry lists it, so the admitted
	// first-tick publish above FAILS under this decision and that test is not vacuous. Policy judgment
	// stays in production code (fleetPolicyState); only the decide-once control flow is replicated.
	const pane = "1756641624081";
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: pane },
		registry: { schema_version: "omp-kit.cc.seats.v1", sessions: [] } });
	const registryPath = join(dirname(s.sessionFile), ".local", "state", "omp-kit", "cc", "seats.v1.json");
	// policyCwd mirror (pre-rewrite impl): the pane's registered repo, else the start cwd.
	const registry = JSON.parse(readFileSync(registryPath, "utf8")) as
		{ sessions?: Array<{ repo?: unknown; seats?: Array<{ pane?: unknown }> }> };
	let resolved = chiefCwd;
	for (const session of registry.sessions ?? []) for (const st of session.seats ?? []) {
		if (st.pane === `tern:${pane}` && typeof session.repo === "string") resolved = session.repo;
	}
	const armed: Array<() => unknown> = [];
	if ((await fleetPolicyState(resolved)).kind === "on") armed.push(() => {});
	expect(armed).toHaveLength(0);
	writeFileSync(registryPath, JSON.stringify(registeredSeat(repo(true))));
	for (const cb of armed) await cb();
	expect(s.record()).toBeNull();
});

test("malformed or missing registries fall back to cwd without opting in", async () => {
	for (const registry of [undefined, {}, { schema_version: "wrong", sessions: [] },
		{ schema_version: "omp-kit.cc.seats.v1", sessions: [null] }]) {
		const s = await seat({ cwd: repo(undefined), env: { TERN_PANE: "1756641624081" }, registry });
		await s.fire("session_start");
		expect(s.record()).toBeNull();
	}
	const malformed = await seat({ cwd: repo(undefined), env: { TERN_PANE: "1756641624081" }, malformedRegistry: true });
	await malformed.fire("session_start");
	expect(malformed.record()).toBeNull();
	const unreadable = await seat({ cwd: chiefCwd, env: { TERN_PANE: "1756641624081", CC_SEATS: base } });
	await unreadable.fire("session_start");
	expect(unreadable.record()).toBeNull();
});

test("CC_SEATS selects the registered repo, whose policy still must be on", async () => {
	const on = await seat({ cwd: repo(undefined), env: { TERN_PANE: "1756641624081" },
		registryOverride: true, registry: registeredSeat(repo(true)) });
	await on.fire("session_start");
	expect(on.record()?.empty).toBe(true);
	const off = await seat({ env: { TERN_PANE: "1756641624081" }, registry: registeredSeat(repo(false)) });
	await off.fire("session_start");
	expect(off.record()).toBeNull();
});

test("a malformed registry preserves an opted-in cwd", async () => {
	const s = await seat({ env: { TERN_PANE: "1756641624081" }, malformedRegistry: true });
	await s.fire("session_start");
	expect(s.record()?.empty).toBe(true);
});
