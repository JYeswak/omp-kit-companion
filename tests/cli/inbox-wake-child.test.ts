import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import kitInboxWake, {
	cursorPath,
	type InboxEvent,
	type InboxRead,
	type InboxWakeContext,
	type InboxWakeDeps,
} from "../../extensions/kit-inbox-wake.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

type Sent = { customType: string; content: string; deliverAs?: string; triggerTurn?: boolean };

function harness(deps: InboxWakeDeps, session: Omit<InboxWakeContext, "setInterval" | "clearTimer">) {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sent: Sent[] = [];
	const intervals: Array<() => unknown> = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		sendMessage: (message: { customType: string; content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) => {
			sent.push({ customType: message.customType, content: message.content, deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn });
		},
	};
	const ctx = {
		...session,
		setInterval: (cb: () => unknown) => { intervals.push(cb); return intervals.length; },
		clearTimer: () => {},
	};
	return {
		sent, intervals,
		start: async () => { await kitInboxWake(pi, deps); await (handlers.get("session_start") as (e: never, c: never) => Promise<void>)({} as never, ctx as never); },
		tick: async () => { await intervals[0]!(); },
	};
}

const event = (id: number, cursor: number, from = "RusticPine", kind = "to"): InboxEvent =>
	({ cursor, message_id: id, kind, subject: `subject ${id}`, from, ack_required: id % 2 === 0 });

const dirs: Array<{ path: string; cleanup: () => void }> = [];
afterEach(() => { for (const d of dirs.splice(0)) d.cleanup(); });

/** A finite `omp -p` child inherits the parent seat's identity through the environment. */
function childEnv(): Record<string, string> {
	return { AGENT_NAME: "PeachLeopard", TERN_PANE: "1756641624081", AGENT_MAIL_PROJECT: "/repo" };
}

function fixture(reads: Array<InboxRead | null>, env: Record<string, string>) {
	const dir = ownedTmp("inbox-wake-child-test");
	dirs.push(dir);
	const config = join(dir.path, ".config/omp-kit/fleet-watch.json");
	mkdirSync(join(config, ".."), { recursive: true });
	writeFileSync(config, JSON.stringify({ sessions: [{ session: "omp-test", repo: "/repo", pullEnabled: true }] }));
	const calls: Array<number | null> = [];
	const deps: InboxWakeDeps = {
		home: dir.path, env, now: () => new Date("2026-11-12T00:00:00Z"), policyOn: async () => true,
		read: async (_agent, _project, after) => { calls.push(after); return reads.shift() ?? null; },
	};
	return { dir: dir.path, calls, deps };
}

describe("kit-inbox-wake CHILDWAKE1", () => {
	test("CHILDWAKE1 planted: a print-mode / no-UI child starts no timer, reads no inbox, injects no wake", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(81976, 101)], next_cursor: 101, tail_cursor: 101 },
		], childEnv());
		const h = harness(f.deps, { cwd: "/repo", mode: "print", hasUI: false });
		await h.start();
		expect(h.intervals).toEqual([]);
		expect(f.calls).toEqual([]);
		expect(h.sent).toEqual([]);
		expect(existsSync(cursorPath(f.dir, "PeachLeopard", "/repo"))).toBe(false);
		expect(existsSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"))).toBe(false);
	}, fixtureDeadlineS() * 1000);

	test("CHILDWAKE1: a session with no mode and no UI stays silent too", async () => {
		const f = fixture([{ events: [], next_cursor: 100, tail_cursor: 100 }], childEnv());
		const h = harness(f.deps, { cwd: "/repo" });
		await h.start();
		expect(h.intervals).toEqual([]);
		expect(f.calls).toEqual([]);
		expect(h.sent).toEqual([]);
	}, fixtureDeadlineS() * 1000);

	test("CHILDWAKE1: an interactive (tui, hasUI) session still wakes", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69601, 101)], next_cursor: 101, tail_cursor: 101 },
		], childEnv());
		const h = harness(f.deps, { cwd: "/repo", mode: "tui", hasUI: true, ui: { getEditorText: () => "" } });
		await h.start();
		expect(h.intervals.length).toBe(1);
		await h.tick();
		expect(f.calls).toEqual([null, 100]);
		expect(h.sent.length).toBe(1);
		expect(h.sent[0].deliverAs).toBe("followUp");
	}, fixtureDeadlineS() * 1000);

	test("CHILDWAKE1: an RPC seat keeps today's behavior and still wakes", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69602, 101)], next_cursor: 101, tail_cursor: 101 },
		], childEnv());
		const h = harness(f.deps, { cwd: "/repo", mode: "rpc" });
		await h.start();
		expect(h.intervals.length).toBe(1);
		await h.tick();
		expect(f.calls).toEqual([null, 100]);
		expect(h.sent.length).toBe(1);
	}, fixtureDeadlineS() * 1000);
});
