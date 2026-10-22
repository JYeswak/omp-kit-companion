import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kitComposerState, { composerRecordPath, type ComposerStateContext, type ComposerStateRecord } from "./kit-composer-state";

const base = realpathSync(mkdtempSync(join(tmpdir(), "kit-composer-state-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function repo(optedIn: boolean): string {
	const cwd = mkdtempSync(join(base, "repo-"));
	const git = Bun.spawnSync(["git", "init", "--quiet", cwd]);
	if (git.exitCode !== 0) throw new Error(git.stderr.toString());
	mkdirSync(join(cwd, ".omp"));
	writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled: optedIn }));
	return cwd;
}

async function seat(opts: { optedIn?: boolean; mode?: string } = {}) {
	const handlers = new Map<string, ((event: never, ctx: ComposerStateContext) => unknown)[]>();
	const home = mkdtempSync(join(base, "home-"));
	const sessionFile = join(home, "session.jsonl");
	writeFileSync(sessionFile, "");
	const state = { text: "", intervals: 0, cleared: 0 };
	const ctx: ComposerStateContext = {
		cwd: repo(opts.optedIn ?? true), mode: opts.mode ?? "tui", hasUI: true, isIdle: () => true,
		ui: { getEditorText: () => state.text },
		sessionManager: { getSessionFile: () => sessionFile },
		setInterval: () => ++state.intervals,
		clearTimer: () => void ++state.cleared,
	};
	await kitComposerState({ on: (event, handler) => void handlers.set(event, [...(handlers.get(event) ?? []), handler]) },
		{ home, now: () => 1_000, pid: 4242 });
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
