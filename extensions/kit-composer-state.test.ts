import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
registry?: unknown; malformedRegistry?: boolean; registryOverride?: boolean } = {},
	runner: typeof kitComposerState = kitComposerState) {
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
	await runner({ on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
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

test("planted negative: the admitted first-tick publish FAILS under the old session_start-only decision", async () => {
	// Box 2, second clause: run the SAME admitted scenario against the actual pre-rewrite production
	// decision with real policy helpers and real session_start wiring through the seat harness.
	// The old decision is a committed exported test input
	// (extensions/kit-composer-state.session-start-only.ts): publication runs have no ancestor
	// history, so materializing it via `git show` fails before the negative behavior (publication02a2
	// log810-820). Provenance: git blob 146f450e441f3aea9833c70455999d2c6b9b1244, the pre-rewrite
	// production decision (parent side of the RESTARTRACE1 rewrite 6fe186b1aa; re-verify with
	// `git log --oneline --find-object=146f450e441f3aea9833c70455999d2c6b9b1244 --
	// extensions/kit-composer-state.ts` and `git hash-object` on the fixture). The blob-sha1
	// assertion below pins the fixture bytes to that exact production module. Old logic checks
	// opt-in once and arms the interval only if on then, so a seat unlisted at start never
	// publishes even after the registry lists it.
	const repoRoot = join(import.meta.dir, "..");
	const oldSource = readFileSync(join(repoRoot, "extensions", "kit-composer-state.session-start-only.ts"), "utf8");
	const oldBytes = Buffer.from(oldSource, "utf8");
	const blobId = createHash("sha1").update(`blob ${oldBytes.length}\0`).update(oldBytes).digest("hex");
	expect(blobId).toBe("146f450e441f3aea9833c70455999d2c6b9b1244");
	const oldDir = freshDir(base, "old-decision-");
	writeFileSync(join(oldDir, "kit-composer-state.ts"), oldSource);
	writeFileSync(join(oldDir, "fleet-policy.ts"), readFileSync(join(repoRoot, "extensions", "fleet-policy.ts")));
	writeFileSync(join(oldDir, "kit-guard-optin.ts"), readFileSync(join(repoRoot, "extensions", "kit-guard-optin.ts")));
	// Dynamic import: the old decision has no static path; its bytes are materialized into the
	// fixture tmp dir at test time, so no static import can name it.
	const oldImpl: { default: typeof kitComposerState } = await import(pathToFileURL(join(oldDir, "kit-composer-state.ts")).href);
	// Paired control: the old production module is live through this same wiring — a seat listed at
	// start publishes on session_start. The late-listing silence below is the old session_start-only
	// decision, not a dead module or an empty tick array.
	const listedRepo = repo(true);
	const live = await seat({ cwd: chiefCwd, env: { TERN_PANE: "1756641624081" }, registry: registeredSeat(listedRepo) }, oldImpl.default);
	await live.fire("session_start");
	expect(live.record()).toEqual({ schema: 1, session_file: realpathSync(live.sessionFile), pid: 4242, at: 1_000, empty: true, idle: true });
	const s = await seat({ cwd: chiefCwd, env: { TERN_PANE: "1756641624081" },
		registry: { schema_version: "omp-kit.cc.seats.v1", sessions: [] } }, oldImpl.default);
	await s.fire("session_start");
	expect(s.record()).toBeNull();
	expect(s.state.intervals).toBe(0);
	const registryPath = join(dirname(s.sessionFile), ".local", "state", "omp-kit", "cc", "seats.v1.json");
	writeFileSync(registryPath, JSON.stringify(registeredSeat(repo(true))));
	await s.tick();
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
