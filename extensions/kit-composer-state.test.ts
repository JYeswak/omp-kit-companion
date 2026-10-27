import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitComposerState, { composerRecordPath, type ComposerStateContext, type ComposerStateRecord } from "./kit-composer-state";
import { ownedTmp } from "../src/kitlib/tmp.ts";

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
	const ctx: ComposerStateContext = {
		cwd: opts.cwd ?? repo(opts.optedIn ?? true), mode: opts.mode ?? "tui", hasUI: true, isIdle: () => true,
		ui: { getEditorText: () => state.text },
		sessionManager: { getSessionFile: () => sessionFile },
		setInterval: () => ++state.intervals,
		clearTimer: () => void ++state.cleared,
	};
	await kitComposerState({ on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
		{ home, env: { ...opts.env, ...(opts.registryOverride ? { CC_SEATS: registryPath } : {}) }, now: () => 1_000, pid: 4242 });
	const fire = async (event: string) => { for (const h of handlers.get(event) ?? []) await h(undefined as never, ctx); };
	const path = composerRecordPath(home, realpathSync(sessionFile));
	const record = () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as ComposerStateRecord : null;
	return { state, fire, record, path, sessionFile };
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

test("control: an unregistered pane outside the policy repo stays off", async () => {
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: "99" }, registry: registeredSeat(repo(true)) });
	await s.fire("session_start");
	expect(s.record()).toBeNull();
	expect(s.state.intervals).toBe(0);
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
