import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import kitGoalState, { goalStateRecordPath, type GoalStateContext, type GoalStateRecord } from "./kit-goal-state";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import { run } from "../src/kitlib/run.ts";
let freshSeq = 0;
/** A unique empty child dir under an owned parent; the parent's cleanup removes it. */
function freshDir(parent: string, prefix: string): string {
	const dir = join(parent, `${prefix}${process.pid}-${++freshSeq}`);
	mkdirSync(dir);
	return dir;
}

const base = realpathSync(ownedTmp("kit-goal-state").path);
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function repo(optedIn: boolean | undefined): Promise<string> {
	const cwd = freshDir(base, "repo-");
	const result = await run(["git", "init", "--quiet", cwd], { cwd, deadline_s: 60, max_output_bytes: 16 * 1024 });
	if (result.rc !== 0) throw new Error(`git init -> ${result.rc}`);
	if (optedIn !== undefined) {
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled: optedIn }));
	}
	return cwd;
}

type Handler = (event: never, ctx: GoalStateContext) => unknown;

async function seat(opts: { optedIn?: boolean; env?: Record<string, string | undefined>; now?: number } = {}) {
	const handlers = new Map<string, Handler[]>();
	const home = freshDir(base, "home-");
	const sessionFile = join(home, "session.jsonl");
	writeFileSync(sessionFile, "");
	const now = opts.now ?? 1794403242072;
	const api = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	const ctx: GoalStateContext = {
		cwd: await repo(opts.optedIn ?? true),
		sessionManager: {
			getSessionId: () => "01a1cac4-87df-71e9-b51b-de1a4b4bf039",
			getSessionFile: () => sessionFile,
		},
	};
	await kitGoalState(api, { home, env: opts.env ?? {}, now: () => now, pid: 4242 });
	return {
		home,
		sessionFile,
		ctx,
		emit: async (type: string, event: unknown, override?: GoalStateContext) => {
			const target = override ?? ctx;
			await Promise.all((handlers.get(type) ?? []).map((handler) => handler(event as never, target)));
		},
		otherSession: (file: string): GoalStateContext => ({
			...ctx,
			sessionManager: {
				getSessionId: () => "second-session",
				getSessionFile: () => file,
			},
		}),
	};
}

function recordOf(home: string, sessionFile: string): GoalStateRecord {
	return JSON.parse(readFileSync(goalStateRecordPath(home, sessionFile), "utf8")) as GoalStateRecord;
}

function activeEvent(id = "g1") {
	return { goal: { id, status: "active", updatedAt: 1794403241000 }, state: { enabled: true } };
}

test("goal-state record path is the sha1 of the session realpath, first 16 hex", () => {
	const key = createHash("sha1").update("/s/seat.jsonl").digest("hex").slice(0, 16);
	expect(goalStateRecordPath("/home/u", "/s/seat.jsonl")).toBe(
		`/home/u/.local/state/omp-kit/goal-state/${key}.json`);
	expect(key).toBe("357591cf7316fe5a");
});

test("an active goal_updated writes a live-active sidecar", async () => {
	const { home, sessionFile, emit } = await seat();
	await emit("goal_updated", activeEvent());
	const record = recordOf(home, sessionFile);
	expect(record.schema).toBe(1);
	expect(record.mode).toBe("goal");
	expect(record.goal_id).toBe("g1");
	expect(record.status).toBe("active");
	expect(record.written_at).toBe(1794403242072);
	expect(record.session_file).toBe(realpathSync(sessionFile));
});

test("a paused goal_updated writes a paused sidecar", async () => {
	const { home, sessionFile, emit } = await seat();
	await emit("goal_updated", { goal: { id: "g1", status: "paused" }, state: { enabled: false } });
	const record = recordOf(home, sessionFile);
	expect(record.mode).toBe("goal_paused");
	expect(record.goal_id).toBe("g1");
});

test("the 2un74 shape: a preserve-restore active emission after a pause ends active with no journal", async () => {
	// omp reattaches a restored session paused (journaled by the teardown persist) and a later
	// preserve-restore reactivates the same goal with only a goal_updated emission. The sidecar
	// must track the latest emission, not the journal: paused then active ends active.
	const { home, sessionFile, emit } = await seat();
	await emit("goal_updated", { goal: { id: "g1", status: "paused" }, state: { enabled: false } });
	expect(recordOf(home, sessionFile).mode).toBe("goal_paused");
	await emit("goal_updated", activeEvent());
	expect(recordOf(home, sessionFile).mode).toBe("goal");
	expect(recordOf(home, sessionFile).goal_id).toBe("g1");
});

test("a dropped goal writes a goal-less sidecar", async () => {
	const { home, sessionFile, emit } = await seat();
	await emit("goal_updated", activeEvent());
	expect(recordOf(home, sessionFile).mode).toBe("goal");
	await emit("goal_updated", { goal: null, state: undefined });
	const record = recordOf(home, sessionFile);
	expect(record.mode).toBe("none");
	expect(record.goal_id).toBeNull();
});

test("fleet gate off writes nothing", async () => {
	const { home, sessionFile, emit } = await seat({ optedIn: false });
	await emit("goal_updated", activeEvent());
	expect(existsSync(goalStateRecordPath(home, sessionFile))).toBe(false);
});

test("a malformed goal_updated never throws and writes nothing", async () => {
	const { home, sessionFile, emit } = await seat();
	for (const event of [null, {}, { goal: 42 }, { goal: { id: "g1" } }, "goal_updated"]) {
		emit("goal_updated", event);
	}
	expect(existsSync(goalStateRecordPath(home, sessionFile))).toBe(false);
});

test("session shutdown removes the sidecar", async () => {
	const { home, sessionFile, emit } = await seat();
	await emit("goal_updated", activeEvent());
	expect(existsSync(goalStateRecordPath(home, sessionFile))).toBe(true);
	await emit("session_shutdown", {});
	expect(existsSync(goalStateRecordPath(home, sessionFile))).toBe(false);
});
test("session shutdown removes every sidecar the instance wrote", async () => {
	const { home, sessionFile, emit, otherSession } = await seat();
	const secondFile = join(home, "second.jsonl");
	writeFileSync(secondFile, "");
	await emit("goal_updated", activeEvent("g1"));
	await emit("goal_updated", activeEvent("g2"), otherSession(secondFile));
	const first = goalStateRecordPath(home, sessionFile);
	const second = goalStateRecordPath(home, secondFile);
	expect(first).not.toBe(second);
	expect(existsSync(first)).toBe(true);
	expect(existsSync(second)).toBe(true);
	await emit("session_shutdown", {});
	expect(existsSync(first)).toBe(false);
	expect(existsSync(second)).toBe(false);
});

test("an unresolvable session file skips the write", async () => {
	const { home, emit, otherSession } = await seat();
	const missing = join(home, "no-such-session.jsonl");
	await emit("goal_updated", activeEvent("g1"), otherSession(missing));
	expect(existsSync(goalStateRecordPath(home, missing))).toBe(false);
});

test("the block identity travels with the record when TERN_PANE is set", async () => {
	const { home, sessionFile, emit } = await seat({ env: { TERN_PANE: "8380920008540167" } });
	await emit("goal_updated", activeEvent());
	expect(recordOf(home, sessionFile).block).toBe("8380920008540167");
});
