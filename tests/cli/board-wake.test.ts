import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import kitInboxWake, { boardCursorPath, type InboxWakeDeps } from "../../extensions/kit-inbox-wake.ts";

/** BOARDLIVE1-S3 (ompkit-tnqyr.2): the Board event source of kit-inbox-wake, against a local fake Board. */

const AGENT = "PeachLeopard";
const ACTOR = "local:user:josh+PeachLeopard";
const TOKEN = "fixture-token";

interface FakeEvent { cursor: number; id: string; by: string; text: string; type?: string }

function fakeBoard(events: FakeEvent[], opts: { honorAfter?: boolean } = {}) {
	const requests: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const url = new URL(req.url);
			requests.push(`${url.pathname}${url.search}`);
			if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
			if (url.pathname === "/api/board/me") {
				if (req.headers.get("x-board-profile") !== AGENT) return Response.json({ error: { code: "invalid_profile" } }, { status: 400 });
				return Response.json({ actor: ACTOR });
			}
			if (url.pathname !== "/api/board/events") return Response.json({ error: { code: "not_found" } }, { status: 404 });
			if (url.searchParams.get("mentions") !== ACTOR) return Response.json({ events: [], cursor: "0" });
			const head = String(events.reduce((m, e) => Math.max(m, e.cursor), 0));
			if (url.searchParams.get("last")) return Response.json({ events: [], cursor: head });
			const after = Number(url.searchParams.get("after"));
			const rows = events.filter(e => opts.honorAfter === false || e.cursor > after);
			return Response.json({
				cursor: head,
				events: rows.map(e => ({
					cursor: String(e.cursor), type: e.type ?? "message.posted",
					payload: { channel: "omp-kit", text: e.text },
					message: { id: e.id, channel: "omp-kit", text: e.text },
					actor: { id: e.by, handle: e.by.split("+")[1] ?? e.by },
				})),
			});
		},
	});
	return { events, requests, url: `http://127.0.0.1:${server.port}/api/board`, stop: () => server.stop(true) };
}

type Sent = { content: string; deliverAs?: string; triggerTurn?: boolean };

function seat(home: string, board: { url: string }, extra: Partial<InboxWakeDeps> = {}, env: Record<string, string> = {}) {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sent: Sent[] = [];
	const intervals: Array<() => unknown> = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		sendMessage: (m: { content: string }, o?: { deliverAs?: string; triggerTurn?: boolean }) => {
			sent.push({ content: m.content, deliverAs: o?.deliverAs, triggerTurn: o?.triggerTurn });
		},
	};
	const ctx = {
		cwd: "/repo", mode: "rpc",
		setInterval: (cb: () => unknown) => { intervals.push(cb); return intervals.length; },
		clearTimer: () => {},
	};
	const deps: InboxWakeDeps = {
		home,
		env: { AGENT_NAME: AGENT, AGENT_MAIL_PROJECT: "/repo", FLEET_MAIL_BACKEND: "board", ...env },
		policyOn: async () => true,
		// Never called on the board backend; its presence also skips the once-per-process load guard.
		read: async () => { throw new Error("am read on the board backend"); },
		boardClient: { url: board.url, token: TOKEN },
		boardLoop: false,
		...extra,
	};
	return {
		sent,
		start: async () => { await kitInboxWake(pi, deps); await (handlers.get("session_start") as (e: never, c: never) => Promise<void>)({} as never, ctx as never); },
		tick: async () => { await intervals[0]!(); },
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function setup(events: FakeEvent[], opts: { honorAfter?: boolean } = {}) {
	const tmp = ownedTmp("board-wake-test");
	const board = fakeBoard(events, opts);
	cleanups.push(() => board.stop(), () => tmp.cleanup());
	return { home: tmp.path, board };
}

const mention = (cursor: number, text = `directive ${cursor}`, by = "local:user:josh+RosePine"): FakeEvent =>
	({ cursor, id: String(cursor), by, text: `@[${ACTOR}] ${text}` });

function seedCursor(home: string, cursor: string): void {
	const path = boardCursorPath(home, AGENT);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ schema: 1, agent: AGENT, actor: ACTOR, cursor, delivered: [], at: "2026-11-24T00:00:00.000Z" }));
}

describe("BOARDLIVE-S3 board wake", () => {
	test("BOARDLIVE-S3 a new mention wakes the named seat once, with the Board credentials and profile", async () => {
		const { home, board } = setup([mention(9, "old")]);
		const s = seat(home, board);
		await s.start(); // first start ever: takes the feed's end, no backlog flood
		expect(s.sent).toHaveLength(0);
		board.events.push(mention(10, "ship it"));
		await s.tick();
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
		expect(s.sent[0]!.content).toContain("#10 in omp-kit from RosePine: @[" + ACTOR + "] ship it");
		await s.tick();
		await s.tick();
		expect(s.sent).toHaveLength(1);
		expect(board.requests.some(r => r.startsWith("/api/board/events?") && r.includes("after=9"))).toBe(true);
		expect(board.requests.some(r => r.includes("after=10"))).toBe(true);
	});

	test("BOARDLIVE-S3 a mention at or before the cursor never wakes", async () => {
		const { home, board } = setup([mention(8), mention(9), mention(10)]);
		seedCursor(home, "10");
		const s = seat(home, board);
		await s.start();
		await s.tick();
		expect(s.sent).toHaveLength(0);
		board.events.push(mention(11, "fresh"));
		await s.tick();
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.content).toContain("#11 ");
		expect(s.sent[0]!.content).not.toContain("#10 ");
	});

	test("BOARDLIVE-S3 the cursor file survives a restart: an old mention does not wake the next process", async () => {
		const { home, board } = setup([mention(5)]);
		const first = seat(home, board);
		await first.start();
		board.events.push(mention(6, "wake me"));
		await first.tick();
		expect(first.sent).toHaveLength(1);
		const saved = JSON.parse(readFileSync(boardCursorPath(home, AGENT), "utf8"));
		expect(saved).toMatchObject({ schema: 1, agent: AGENT, actor: ACTOR, cursor: "6", delivered: ["6"] });
		// A restarted seat: same home, the board still holds both mentions.
		const second = seat(home, board);
		await second.start();
		await second.tick();
		expect(second.sent).toHaveLength(0);
	});

	test("BOARDLIVE-S3 a board that re-emits events at or below the cursor never wakes a message twice", async () => {
		const { home, board } = setup([mention(5)], { honorAfter: false });
		const s = seat(home, board);
		await s.start();
		board.events.push(mention(6, "once"));
		await s.tick();
		await s.tick();
		expect(s.sent).toHaveLength(1);
	});

	test("BOARDLIVE-S3 the seat's own post and a non-post event never wake it", async () => {
		const { home, board } = setup([mention(1)]);
		const s = seat(home, board);
		await s.start();
		board.events.push(mention(2, "talking to myself", ACTOR), { ...mention(3, "edited"), type: "message.edited" });
		await s.tick();
		expect(s.sent).toHaveLength(0);
		const saved = JSON.parse(readFileSync(boardCursorPath(home, AGENT), "utf8"));
		expect(saved.cursor).toBe("3");
	});

	test("BOARDLIVE-S3 an unreadable board keeps the cursor and wakes on the next good poll", async () => {
		const { home, board } = setup([mention(1)]);
		const s = seat(home, board);
		await s.start();
		const bad = seat(home, { url: board.url.replace("/api/board", "/nope") });
		await bad.start();
		board.events.push(mention(2, "later"));
		await bad.tick();
		expect(bad.sent).toHaveLength(0);
		await s.tick();
		expect(s.sent).toHaveLength(1);
	});

	test("BOARDLIVE-S3 the am backend never contacts the board and keeps its own cursor file", async () => {
		const { home, board } = setup([mention(1)]);
		const reads: Array<number | null> = [];
		const s = seat(home, board, {
			read: async (_agent, _project, after) => { reads.push(after); return { events: [], next_cursor: 7, tail_cursor: 7 }; },
		}, { FLEET_MAIL_BACKEND: "am" });
		await s.start();
		await s.tick();
		expect(reads).toEqual([null, 7]);
		expect(board.requests).toHaveLength(0);
	});
});
