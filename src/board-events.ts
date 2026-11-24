import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Board event source for kit-inbox-wake (BOARDLIVE1-S3, ompkit-tnqyr.2): reads the local Board's HTTP feed
 * (`GET /events`, docs/04-reference/03-http.md "Event feed") for mentions of a seat's actor. Long-poll, never
 * `vb wait` (the CLI costs 1.43 s p50 against 93 ms for the raw long-poll, BoardParity P4).
 * Cursors are opaque strings: they are compared for equality and passed back as received.
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
	/** Who did it: actor id and handle. */
	by: string;
	byHandle: string;
	text: string;
}

export interface BoardRead {
	events: BoardEvent[];
	cursor: string;
}

/** Margin over the server-side hold for the TCP and JSON round trip. */
const REQUEST_MARGIN_S = 10;

/**
 * The board this seat talks to: BOARD_URL plus BOARD_TOKEN, else the local board's own credentials file under
 * `$XDG_CONFIG_HOME/board/local/` (or `~/.config/board/local/`), the one `vb serve` writes ({ url, token }).
 */
export function boardClientFromEnv(home: string, env: Readonly<Record<string, string | undefined>>): BoardClient | null {
	const strip = (u: string) => { let end = u.length; while (end > 0 && u[end - 1] === "/") end--; return u.slice(0, end); };
	if (env.BOARD_URL && env.BOARD_TOKEN) return { url: strip(env.BOARD_URL), token: env.BOARD_TOKEN };
	const dir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "board", "local");
	try {
		for (const name of readdirSync(dir).filter(n => n.endsWith(".json")).sort()) {
			const doc = JSON.parse(readFileSync(join(dir, name), "utf8"));
			if (typeof doc?.url === "string" && typeof doc?.token === "string") {
				return { url: strip(env.BOARD_URL || doc.url), token: doc.token };
			}
		}
	} catch { /* no credentials: the source is unavailable */ }
	return null;
}

async function getJson(client: BoardClient, path: string, profile: string, timeoutS: number, signal?: AbortSignal): Promise<unknown | null> {
	try {
		const signals = [AbortSignal.timeout(timeoutS * 1000), ...(signal ? [signal] : [])];
		const res = await fetch(`${client.url}${path}`, {
			headers: { authorization: `Bearer ${client.token}`, "x-board-profile": profile, accept: "application/json" },
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

/** Events mentioning `actor` after `after`; holds up to `waitS` seconds for the first new match. Null when unreadable. */
export async function boardEventsAfter(
	client: BoardClient, agent: string, actor: string, after: string, waitS: number, signal?: AbortSignal,
): Promise<BoardRead | null> {
	const q = `mentions=${encodeURIComponent(actor)}&after=${encodeURIComponent(after)}&wait=${Math.max(0, Math.min(300, Math.floor(waitS)))}`;
	return parseEvents(await getJson(client, `/events?${q}`, agent, waitS + REQUEST_MARGIN_S, signal));
}
