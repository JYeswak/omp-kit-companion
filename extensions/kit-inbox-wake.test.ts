import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../src/kitlib/tmp.ts";
import kitInboxWake, { cursorPath, type InboxEvent, type InboxRead, type InboxWakeDeps, wakeText } from "./kit-inbox-wake";

type Sent = { content: string; deliverAs?: string; triggerTurn?: boolean };

function harness(deps: InboxWakeDeps) {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sent: Sent[] = [];
	const intervals: Array<() => unknown> = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		sendMessage: (message: { content: string }, options?: { deliverAs?: string; triggerTurn?: boolean }) =>
			sent.push({ content: message.content, deliverAs: options?.deliverAs, triggerTurn: options?.triggerTurn }),
	};
	const ctx = { cwd: "/repo", setInterval: (cb: () => unknown) => { intervals.push(cb); return intervals.length; }, clearTimer: () => {} };
	return {
		sent, intervals,
		start: async () => { await kitInboxWake(pi, deps); await (handlers.get("session_start") as (e: never, c: never) => Promise<void>)({} as never, ctx as never); },
		tick: async () => { await intervals[0]!(); },
		fire: (event: string, payload: unknown = {}) => (handlers.get(event) as (e: unknown, c: never) => unknown)(payload, ctx as never),
	};
}

const event = (id: number, cursor: number, from = "RusticPine", kind = "to"): InboxEvent =>
	({ cursor, message_id: id, kind, subject: `subject ${id}`, from, ack_required: id % 2 === 0 });

const dirs: Array<{ path: string; cleanup: () => void }> = [];
afterEach(() => { for (const d of dirs.splice(0)) d.cleanup(); });

function fixture(reads: Array<InboxRead | null>, env: Record<string, string> = { AGENT_NAME: "PeachLeopard" }) {
	const dir = ownedTmp("inbox-wake-test");
	dirs.push(dir);
	const calls: Array<number | null> = [];
	const deps: InboxWakeDeps = {
		home: dir.path, env, now: () => new Date("2026-10-26T17:00:00Z"), policyOn: async () => true,
		read: async (_agent, _project, after) => { calls.push(after); return reads.shift() ?? null; },
	};
	return { dir: dir.path, calls, deps };
}

describe("kit-inbox-wake", () => {
	test("first start takes the tail, a later message wakes the seat once as a queued follow-up", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69601, 101), event(69602, 103)], next_cursor: 103, tail_cursor: 103 },
		]);
		const h = harness(f.deps);
		await h.start();
		expect(h.sent).toEqual([]);
		await h.tick();
		expect(f.calls).toEqual([null, 100]);
		expect(h.sent.length).toBe(1);
		// J-2026-10-26-19: an aside lands at the next step boundary inside a running turn (36 of 60 wakes on
		// 2026-10-26); a follow-up waits for the run to end, and triggerTurn wakes an idle seat.
		expect(h.sent[0]!.deliverAs).toBe("followUp");
		expect(h.sent[0]!.triggerTurn).toBe(true);
		expect(h.sent[0]!.content).toContain("#69601 from RusticPine: subject 69601");
		expect(h.sent[0]!.content).toContain("#69602 from RusticPine [ack required]");
		const cursor = JSON.parse(readFileSync(cursorPath(f.dir, "PeachLeopard", "/repo"), "utf8"));
		expect(cursor.cursor).toBe(103);
		const ledger = readFileSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
		expect(ledger.map(r => [r.message_id, r.status, r.recipient])).toEqual([[69601, "WAKE_ENQUEUED", "PeachLeopard"], [69602, "WAKE_ENQUEUED", "PeachLeopard"]]);
		// WAKECONSUMED: only the agent receiving the wake (omp's message_end) writes the row launch T5 counts.
		h.fire("message_end", { message: { role: "custom", customType: "kit-inbox-wake", content: h.sent[0]!.content } });
		const after = readFileSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
		expect(after.slice(2).map(r => [r.message_id, r.status])).toEqual([[69601, "WAKE_CONSUMED"], [69602, "WAKE_CONSUMED"]]);
		h.fire("message_end", { message: { role: "custom", customType: "kit-inbox-wake", content: h.sent[0]!.content } });
		expect(readFileSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"), "utf8").trim().split("\n").length).toBe(4);
	});

	test("planted: an unreadable inbox keeps the cursor, so the same mail is delivered on the next poll", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			null,
			{ events: [event(69601, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		expect(h.sent).toEqual([]);
		await h.tick();
		expect(f.calls).toEqual([null, 100, 100]);
		expect(h.sent.length).toBe(1);
	});

	test("planted: the seat's own sends and bcc-free noise never wake it", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69601, 101, "PeachLeopard"), event(69602, 102, "RusticPine", "bcc")], next_cursor: 102, tail_cursor: 102 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		expect(h.sent).toEqual([]);
		expect(existsSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"))).toBe(false);
	});

	test("a restarted seat resumes from its stored cursor and gets mail sent while it was down", async () => {
		const f = fixture([{ events: [], next_cursor: 100, tail_cursor: 100 }]);
		await harness(f.deps).start();
		const reads: Array<InboxRead | null> = [{ events: [event(69605, 104)], next_cursor: 104, tail_cursor: 104 }];
		const calls: Array<number | null> = [];
		const h2 = harness({ ...f.deps, read: async (_a, _p, after) => { calls.push(after); return reads.shift() ?? null; } });
		await h2.start();
		expect(calls).toEqual([100]);
		expect(h2.sent.length).toBe(1);
	});

	test("planted: no AGENT_NAME, or a project outside the fleet, registers nothing", async () => {
		const noName = fixture([{ events: [], next_cursor: 1, tail_cursor: 1 }], {});
		const h = harness(noName.deps);
		await h.start().catch(() => { /* no handler registered */ });
		expect(noName.calls).toEqual([]);
		const off = fixture([{ events: [], next_cursor: 1, tail_cursor: 1 }]);
		const h2 = harness({ ...off.deps, policyOn: async () => false });
		await h2.start();
		await h2.tick();
		expect(off.calls).toEqual([]);
		expect(h2.sent).toEqual([]);
	});

	test("planted RESTARTRACE1: a seat whose project is not on at start begins reading once it is", async () => {
		// 2026-10-26 17:26:51Z: the lead's new omp started before the seat registry re-listed its block (17:27:06Z).
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69641, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		let listed = false;
		const h = harness({ ...f.deps, policyOn: async () => listed });
		await h.start();
		expect(f.calls).toEqual([]);
		listed = true;
		await h.tick();
		await h.tick();
		expect(f.calls).toEqual([null, 100]);
		expect(h.sent.map(s => s.content.split("\n")[1])).toEqual(["#69641 from RusticPine: subject 69641"]);
	});

	test("wakeText names every message and the action", () => {
		const text = wakeText("QuietBadger", [event(1, 1), event(2, 2)]);
		expect(text.split("\n")[0]).toBe("MAIL WAKE for QuietBadger: 2 new Agent Mail message(s).");
		expect(text).toContain("acknowledge each one after acting on it");
	});

	const aborted = { messages: [{ role: "assistant", stopReason: "aborted" }] };
	const finished = { messages: [{ role: "assistant", stopReason: "stop" }] };

	test("planted ESCREDELIVER: a wake an aborted (Esc) run dropped is sent once more, then dropped", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69720, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		expect(h.sent.length).toBe(1);
		h.fire("agent_end", aborted);
		expect(h.sent.map(s => s.content)).toEqual([h.sent[0]!.content, h.sent[0]!.content]);
		expect(h.sent[1]!.deliverAs).toBe("followUp");
		h.fire("agent_end", aborted);
		expect(h.sent.length).toBe(2);
	});

	test("planted DUPWAKE1: a wake queued mid-run is delivered after the run ends, so a normal run end never resends it", async () => {
		// Lead seat, 2026-10-26: 69773 was consumed at 19:53:53Z and reached the seat again at 20:42Z, because every
		// run end resent the follow-up omp had not delivered yet (it is delivered only after that run ends).
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69773, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		h.fire("agent_end", finished);
		expect(h.sent.length).toBe(1);
		h.fire("message_end", { message: { role: "custom", customType: "kit-inbox-wake", content: h.sent[0]!.content } });
		h.fire("agent_end", finished);
		h.fire("agent_end", aborted);
		expect(h.sent.length).toBe(1);
		const rows = readFileSync(join(f.dir, ".local/state/omp-kit/mail-wake.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
		expect(rows.map(r => [r.message_id, r.status])).toEqual([[69773, "WAKE_ENQUEUED"], [69773, "WAKE_CONSUMED"]]);
	});

	test("control: an agent_end with no messages (unknown stop reason) never resends", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69722, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		h.fire("agent_end");
		h.fire("agent_end", { messages: [] });
		expect(h.sent.length).toBe(1);
	});

	test("control: a wake the agent consumed is never sent again", async () => {
		const f = fixture([
			{ events: [], next_cursor: 100, tail_cursor: 100 },
			{ events: [event(69721, 101)], next_cursor: 101, tail_cursor: 101 },
		]);
		const h = harness(f.deps);
		await h.start();
		await h.tick();
		h.fire("message_end", { message: { role: "custom", customType: "kit-inbox-wake", content: h.sent[0]!.content } });
		h.fire("agent_end", aborted);
		expect(h.sent.length).toBe(1);
		h.fire("message_end", { message: { role: "custom", customType: "other", content: "x" } });
		h.fire("agent_end", aborted);
		expect(h.sent.length).toBe(1);
	});
});
