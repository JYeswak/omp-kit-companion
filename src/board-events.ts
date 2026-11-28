import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Board event source for kit-inbox-wake. GET /events with `wait` and `after` is the HTTP transport for
 * `vb wait --after` (93 ms raw versus 1.43 s p50 via the CLI, BoardParity P4). Cursors stay opaque.
 */

export interface BoardClient {
	/** The board's mount, e.g. http://127.0.0.1:4178/api/board (no trailing slash). */
	url: string;
	token: string;
}

export interface BoardEvent {
	cursor: string;
	type: string;
	channel: string;
	/** The message the event concerns (string id). */
	messageId: string;
	/** Board's `re`: the thread root for a reply. */
	threadRoot?: string;
	/** Who did it: actor id and handle. */
	by: string;
	byHandle: string;
	text: string;
}

export interface BoardRead {
	events: BoardEvent[];
	cursor: string;
}

const THREAD_PAGE = 500; // Board's largest /threads page
/** Margin over the server-side hold for the TCP and JSON round trip. */
const REQUEST_MARGIN_S = 10;

export const DEFAULT_MAIL_BACKEND = "board";

/** Credential directory for the kit's local Board. */
export function kitBoardLocalDir(home: string): string {
	return join(home, ".local", "share", "omp-kit", "board-trial", "xdg", "board", "local");
}

/** Check the literal authority before URL parsing can normalize aliases or strip empty userinfo. */
export function isLoopbackBoardUrl(url: string): boolean {
	return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:[/?#]|$)/i.test(url) && URL.canParse(url);
}

/** Explicit credentials win; otherwise try the XDG override, kit Board, then standard home config. */
export function boardClientFromEnv(home: string, env: Readonly<Record<string, string | undefined>>): BoardClient | null {
	const strip = (u: string) => { let end = u.length; while (end > 0 && u[end - 1] === "/") end--; return u.slice(0, end); };
	if (env.BOARD_URL && env.BOARD_TOKEN)
		return isLoopbackBoardUrl(env.BOARD_URL) ? { url: strip(env.BOARD_URL), token: env.BOARD_TOKEN } : null;
	const dirs = [
		...(env.XDG_CONFIG_HOME ? [join(env.XDG_CONFIG_HOME, "board", "local")] : []),
		kitBoardLocalDir(home),
		join(home, ".config", "board", "local"),
	];
	for (const dir of dirs) {
		try {
			for (const name of readdirSync(dir).filter(n => n.endsWith(".json")).sort()) {
				const doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
				if (typeof doc?.url === "string" && typeof doc?.token === "string") {
					return isLoopbackBoardUrl(doc.url) ? { url: strip(doc.url), token: doc.token } : null;
				}
			}
		} catch { /* This directory is unavailable; continue to the next source. */ }
	}
	return null;
}

async function getJson(client: BoardClient, path: string, profile: string, timeoutS: number, signal?: AbortSignal): Promise<unknown | null> {
	const url = `${client.url}${path}`;
	if (!isLoopbackBoardUrl(url)) return null;
	try {
		const signals = [AbortSignal.timeout(timeoutS * 1000), ...(signal ? [signal] : [])];
		const res = await fetch(url, {
			headers: { authorization: `Bearer ${client.token}`, "x-board-profile": profile, accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.any(signals),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** The actor id the board gives this seat's profile (`GET /me`), the form `mentions=` takes. */
export async function boardActor(client: BoardClient, agent: string, signal?: AbortSignal): Promise<string | null> {
	const me = await getJson(client, "/me", agent, 10, signal) as { actor?: unknown } | null;
	return typeof me?.actor === "string" && me.actor !== "" ? me.actor : null;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function parseEvents(doc: unknown): BoardRead | null {
	const d = doc as { events?: unknown; cursor?: unknown } | null;
	if (!d || !Array.isArray(d.events) || typeof d.cursor !== "string" || d.cursor === "") return null;
	const events: BoardEvent[] = [];
	for (const raw of d.events as Array<Record<string, any>>) {
		if (typeof raw?.cursor !== "string") continue;
		events.push({
			cursor: raw.cursor,
			type: str(raw.type),
			channel: str(raw.message?.channel ?? raw.payload?.channel),
			messageId: str(raw.message?.id ?? raw.payload?.id),
			threadRoot: str(raw.payload?.re ?? raw.message?.re),
			by: str(raw.actor?.id),
			byHandle: str(raw.actor?.handle) || str(raw.actor?.name),
			text: str(raw.message?.text ?? raw.payload?.text),
		});
	}
	return { events, cursor: d.cursor };
}

/** The feed's current end for this actor, without any backlog (`last=1` answers at once with the feed's end as cursor). */
export async function boardHead(client: BoardClient, agent: string, actor: string, signal?: AbortSignal): Promise<string | null> {
	const doc = await getJson(client, `/events?mentions=${encodeURIComponent(actor)}&last=1`, agent, 20, signal);
	return parseEvents(doc)?.cursor ?? null;
}

/** Active thread roots matching one of `bm inbox`'s native filters. Null means the read cannot be trusted. */
async function boardThreadRoots(client: BoardClient, agent: string, query: string, signal?: AbortSignal): Promise<Set<string> | null> {
	const doc = await getJson(client, `/threads?${query}`, agent, 10, signal) as
		{ threads?: Array<{ message?: { id?: unknown } }> } | null;
	if (!Array.isArray(doc?.threads)) return null;
	const roots = new Set<string>();
	for (const thread of doc.threads) {
		if (typeof thread?.message?.id !== "string" || thread.message.id === "") return null;
		roots.add(thread.message.id);
	}
	return roots;
}

/** Direct mentions and replies in threads the seat was mentioned in or posted in; one checkpoint for both. */
export async function boardEventsAfter(
	client: BoardClient, agent: string, actor: string, after: string, waitS: number, signal?: AbortSignal,
): Promise<BoardRead | null> {
	const position = `after=${encodeURIComponent(after)}`;
	const q = `${position}&wait=${Math.max(0, Math.min(300, Math.floor(waitS)))}`;
	const read = parseEvents(await getJson(client, `/events?${q}`, agent, waitS + REQUEST_MARGIN_S, signal));
	if (read === null) return null;
	// A reconnecting feed can re-emit the checkpoint with its prefix. Drop that prefix without ordering opaque cursors.
	const checkpoint = read.events.findLastIndex(e => e.cursor === after);
	const posts = read.events.filter((e, index) => index > checkpoint && e.type === "message.posted" && e.by !== actor && e.messageId !== "");
	if (posts.length === 0) return { events: [], cursor: read.cursor };

	// Keep Board's exact direct-mention matcher; only take results in this batch, never advance on a side read.
	const who = encodeURIComponent(actor);
	const direct = parseEvents(await getJson(client, `/events?mentions=${who}&${position}&wait=0`, agent, 10, signal));
	if (direct === null) return null;
	const addressed = new Set(direct.events.map(e => e.cursor));
	const replies = posts.filter(e => e.threadRoot && !addressed.has(e.cursor));
	const latest = replies.at(-1);
	if (latest) {
		// A point read waits for the Board's tables to index this reply. List reads alone may lag the event feed.
		if (await getJson(client, `/messages/${encodeURIComponent(latest.messageId)}?limit=1`, agent, 10, signal) === null) return null;
		const filters = [`mentions=${who}`, `by=${who}`];
		const [mentioned, authored] = await Promise.all(filters.map(filter =>
			boardThreadRoots(client, agent, `${filter}&${position}&limit=${THREAD_PAGE}`, signal)));
		if (!mentioned || !authored) return null;
		for (const reply of replies) {
			const root = reply.threadRoot!;
			if (mentioned.has(root) || authored.has(root)) {
				addressed.add(reply.cursor);
			} else if (mentioned.size === THREAD_PAGE || authored.size === THREAD_PAGE) {
				// Concurrent activity can move a thread past the first page. Check just this root before ruling it out.
				const scoped = await Promise.all(filters.map(filter =>
					boardThreadRoots(client, agent, `${filter}&re=${encodeURIComponent(root)}&limit=1`, signal)));
				if (scoped.some(set => set === null)) return null;
				if (scoped.some(set => set?.has(root))) addressed.add(reply.cursor);
			}
		}
	}
	return { events: posts.filter(e => addressed.has(e.cursor)), cursor: read.cursor };
}
