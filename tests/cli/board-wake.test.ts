import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import kitInboxWake, { boardCursorPath, type InboxWakeDeps } from "../../extensions/kit-inbox-wake.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

/** BOARDLIVE1-S3 (ompkit-tnqyr.2): the Board event source of kit-inbox-wake, against a local fake Board. */

const AGENT = "PeachLeopard";
const ACTOR = "local:user:josh+peachleopard";
const TOKEN = "fixture-token";

interface FakeEvent { cursor: number; id: string; by: string; text: string; type?: string; re?: string }

function fakeBoard(events: FakeEvent[], opts: { honorAfter?: boolean } = {}) {
	const requests: string[] = [];
	const deleted: string[] = [];
	const waiting = Promise.withResolvers<void>();
	let changed = Promise.withResolvers<void>();
	function push(...rows: FakeEvent[]) {
		events.push(...rows);
		changed.resolve();
		changed = Promise.withResolvers<void>();
	}
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			requests.push(`${url.pathname}${url.search}`);
			if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
			if (url.pathname === "/api/board/me") {
				if (req.headers.get("x-board-profile") !== AGENT) return Response.json({ error: { code: "invalid_profile" } }, { status: 400 });
				return Response.json({ actor: ACTOR });
			}
			if (req.method === "POST" && url.pathname === "/api/board/messages") {
				const body = await req.json() as { re?: string; text: string; channel?: string; noSync?: boolean };
				if (body.noSync !== true || (!body.re && body.channel !== "board-wake-probe") || body.text.includes("@")) {
					return Response.json({ error: "bad probe post" }, { status: 400 });
				}
				const cursor = (events.at(-1)?.cursor ?? 0) + 1;
				const id = String(cursor);
				const createdAt = new Date().toISOString();
				push({ cursor, id, by: "local:user:josh+board-wake-probe", text: body.text, re: body.re });
				return Response.json({ message: { id, createdAt } }, { status: 201 });
			}
			const write = /^\/api\/board\/messages\/(\d+)\/(edit|delete)$/.exec(url.pathname);
			if (req.method === "POST" && write) {
				const original = events.find(e => e.id === write[1]);
				if (!original || req.headers.get("x-board-profile") !== "board-wake-probe") return new Response(null, { status: 403 });
				if (write[2] === "delete") deleted.push(original.id);
				else {
					const { text } = await req.json() as { text: string };
					push({ ...original, text, cursor: (events.at(-1)?.cursor ?? 0) + 1, type: "message.edited" });
				}
				return Response.json({ ok: true });
			}
			if (url.pathname.startsWith("/api/board/messages/")) return Response.json({ message: {}, replies: [] });
			const mentions = url.searchParams.get("mentions");
			const by = url.searchParams.get("by");
			const after = Number(url.searchParams.get("after"));
			const matches = (e: FakeEvent) => (!mentions || e.text.includes(`@[${mentions}]`)) && (!by || e.by === by);
			if (url.pathname === "/api/board/threads") {
				const active = new Set(events.filter(e => e.cursor > after).map(e => e.re ?? e.id));
				const roots = new Set(events.filter(matches).map(e => e.re ?? e.id)
					.filter(root => active.has(root) && (!url.searchParams.has("re") || url.searchParams.get("re") === root)));
				return Response.json({ threads: [...roots].map(id => ({ message: { id } })) });
			}
			if (url.pathname !== "/api/board/events") return Response.json({ error: { code: "not_found" } }, { status: 404 });
			const head = () => String(events.reduce((m, e) => Math.max(m, e.cursor), 0));
			if (url.searchParams.get("last")) return Response.json({ events: [], cursor: head() });
			const matchingEvents = () => events.filter(e => (opts.honorAfter === false || e.cursor > after) && matches(e));
			if (Number(url.searchParams.get("wait")) > 0 && matchingEvents().length === 0) {
				waiting.resolve();
				await changed.promise;
			}
			return Response.json({
				cursor: head(),
				events: matchingEvents().map(e => ({
					cursor: String(e.cursor), type: e.type ?? "message.posted",
					payload: { channel: "omp-kit", text: e.text, re: e.re ?? null },
					message: { id: e.id, channel: "omp-kit", text: e.text, re: e.re ?? null },
					actor: { id: e.by, handle: e.by.split("+")[1] ?? e.by },
				})),
			});
		},
	});
	return { events, push, waiting: waiting.promise, requests, deleted, url: `http://127.0.0.1:${server.port}/api/board`, stop: () => { changed.resolve(); server.stop(true); } };
}

type Sent = { content: string; deliverAs?: string; triggerTurn?: boolean };

function seat(home: string, board: { url: string }, extra: Partial<InboxWakeDeps> = {}, env: Record<string, string> = {}) {
	const handlers = new Map<string, (event: never, ctx: never) => unknown>();
	const sent: Sent[] = [];
	const woke = Promise.withResolvers<number>();
	const intervals: Array<() => unknown> = [];
	const pi = {
		on: (event: string, handler: (event: never, ctx: never) => unknown) => handlers.set(event, handler),
		sendMessage: (m: { content: string }, o?: { deliverAs?: string; triggerTurn?: boolean }) => {
			sent.push({ content: m.content, deliverAs: o?.deliverAs, triggerTurn: o?.triggerTurn });
			woke.resolve(performance.now());
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
		woke: woke.promise,
		stop: () => handlers.get("session_shutdown")?.({} as never, ctx as never),
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

test("BOARDWAKE1 an addressed reply wakes once after a cursor, and an unrelated reply stays quiet", async () => {
	const author = "local:user:josh+RosePine";
	const { home, board } = setup([
		mention(1, "thread addressed before this watcher started"),
		{ cursor: 2, id: "2", by: author, text: "unrelated root" },
		{ cursor: 3, id: "3", by: ACTOR, text: "thread I posted in" },
	]);
	const first = seat(home, board, { boardLoop: true, boardWaitS: 2 });
	const deadline = new AbortController();
	const expired = sleep(5_000, null, { signal: deadline.signal }).catch(() => null);
	try {
		await first.start();
		expect(await Promise.race([board.waiting.then(() => true), expired])).toBe(true);
		expect(first.sent).toHaveLength(0);
		const posted = performance.now();
		board.push(
			{ cursor: 4, id: "reply", re: "1", by: author, text: "answer without a repeated mention" },
			{ cursor: 5, id: "noise", re: "2", by: author, text: "not for this seat" },
			{ cursor: 6, id: "reply", re: "1", by: author, text: "duplicate in same delivery" },
			{ cursor: 7, id: "own", re: "3", by: ACTOR, text: "my own reply" },
			{ cursor: 8, id: "reaction", re: "1", by: author, text: "reaction", type: "reaction.added" },
		);
		const woke = await Promise.race([first.woke, expired]);
		expect(woke).not.toBeNull();
		const latency = woke! - posted;
		expect(latency).toBeLessThan(5_000);
		expect(first.sent).toHaveLength(1);
		expect(first.sent[0]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
		expect(first.sent[0]!.content.match(/#reply /g)).toEqual(["#reply "]);
		expect(first.sent[0]!.content).not.toMatch(/#(noise|own|reaction) /);
		console.log(`BOARDWAKE1 fixture wake ${latency.toFixed(1)} ms`);
	} finally {
		deadline.abort();
		first.stop();
	}
	board.push(
		{ cursor: 9, id: "reply", re: "1", by: author, text: "duplicate after restart" },
		{ cursor: 10, id: "participation", re: "3", by: author, text: "answer in thread I posted in" },
	);
	const next = seat(home, board);
	await next.start();
	expect(next.sent).toHaveLength(1);
	expect(next.sent[0]!.content).toContain("#participation ");
	expect(next.sent[0]!.content).not.toContain("#reply ");
	const ledger = readFileSync(join(home, ".local/state/omp-kit/mail-wake.jsonl"), "utf8").trim().split("\n").map(row => JSON.parse(row));
	expect(ledger.map(row => [row.message_id, row.cursor, row.status])).toEqual([
		["reply", "4", "WOKEN_INPROCESS"], ["participation", "10", "WOKEN_INPROCESS"],
	]);
}, fixtureDeadlineS(8) * 1_000);

test("live wake probe reports the exact mention-free reply and deletes both synthetic posts", async () => {
	const { home, board } = setup([]);
	const s = seat(home, board, { boardLoop: true, boardWaitS: 2 });
	try {
		await s.start();
		const { rc, stdout, stderr } = await runFixtureAsync(
			[process.execPath, "--no-env-file", join(import.meta.dir, "../../scripts/board-wake-probe.ts"), "--seat", AGENT, "--timeout-ms", "5000", "--json"],
			{ cwd: process.cwd(), env: { ...process.env, HOME: home, BOARD_URL: board.url, BOARD_TOKEN: TOKEN },
				floor_s: 8, label: "Board wake probe with owned local fixture" },
		);
		const decoder = new TextDecoder();
		expect(decoder.decode(stderr)).toBe("");
		expect(rc).toBe(0);
		const result = JSON.parse(decoder.decode(stdout));
		expect(result).toMatchObject({ observed: true, cursor: "3" });
		expect(result.latency_ms).toBeGreaterThanOrEqual(0);
		expect(result.latency_ms).toBeLessThan(5_000);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.content).toContain("#3 ");
		expect(board.deleted).toEqual(["3", "1"]);
	} finally {
		s.stop();
	}
}, fixtureDeadlineS(9) * 1_000);
