import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { boardActor, boardClientFromEnv } from "../src/board-events.ts";
import { readJsonl, type JsonlCursor } from "../src/kitlib/jsonl.ts";

const PROBE_PROFILE = "board-wake-probe";
const PROBE_TEXT = "Synthetic Board wake latency probe; no action requested.";
const USAGE = "Usage: bun scripts/board-wake-probe.ts --seat NAME --timeout-ms 5000 --json";
type Result = { observed: boolean; latency_ms: number | null; cursor: string | null };
type Post = { message?: { id?: string; createdAt?: string } };
const missing: Result = { observed: false, latency_ms: null, cursor: null };

async function probe(seat: string, timeout: number): Promise<{ result: Result; cleaned: boolean }> {
	const home = homedir();
	const client = boardClientFromEnv(home, process.env);
	if (!client) throw new Error("local Board credentials unavailable");
	const url = new URL(client.url);
	if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username || url.password || url.pathname !== "/api/board" || url.search || url.hash) {
		throw new Error("refusing a non-local Board URL; use literal loopback HTTP at /api/board");
	}
	const actor = await boardActor(client, seat);
	if (!actor?.startsWith("local:user:") || !actor.endsWith(`+${seat.toLowerCase()}`) || actor.includes("]")) {
		throw new Error("Board did not resolve the requested seat as a local profile");
	}
	const request = async (path: string, body?: object, timeoutMs = 2_000): Promise<Response> => {
		const response = await fetch(`${client.url}${path}`, {
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${client.token}`, "x-board-profile": PROBE_PROFILE,
				accept: "application/json", "content-type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
			redirect: "error", signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok && !(path.startsWith("/posts/") && response.status === 404)) {
			throw new Error(`Board ${body ? "POST" : "GET"} ${path} returned ${response.status}`);
		}
		return response;
	};
	const ledger = join(home, ".local/state/omp-kit/mail-wake.jsonl");
	const stat = statSync(ledger, { throwIfNoEntry: false });
	let cursor: JsonlCursor | null = stat ? { dev: stat.dev, ino: stat.ino, offset: stat.size, line: 0 } : null;
	const posts: Array<{ key: string; id?: string }> = [];
	const post = async (where: { channel: string } | { re: string }, timeoutMs?: number) => {
		const posted: (typeof posts)[number] = { key: randomUUID() };
		posts.push(posted);
		const { message } = await (await request("/messages", { ...where, id: posted.key, text: PROBE_TEXT, noSync: true }, timeoutMs)).json() as Post;
		if (typeof message?.id !== "string" || !message.id) throw new Error("Board post omitted its message ID");
		posted.id = message.id;
		return { id: posted.id, createdAt: Date.parse(message.createdAt ?? "") };
	};

	let result = missing;
	let cleaned = true;
	try {
		const root = await post({ channel: "board-wake-probe" });
		// Address by edit so only the unmentioned reply, not the setup post, can wake the seat.
		await request(`/messages/${encodeURIComponent(root.id)}/edit`, { text: `@[${actor}] ${PROBE_TEXT}` });
		const deadline = performance.now() + timeout;
		const reply = await post({ re: root.id }, timeout);
		if (!Number.isFinite(reply.createdAt)) throw new Error("Board reply omitted a valid creation time");
		do {
			const read = readJsonl(ledger, { fromCursor: cursor });
			cursor = read.cursor;
			for (const row of read.rows) {
				const r = row as { status?: string; backend?: string; recipient?: string; message_id?: string; cursor?: string; ts?: string } | null;
				if (r?.status !== "WOKEN_INPROCESS" || r.backend !== "board" || r.recipient !== seat || r.message_id !== reply.id || !r.cursor) continue;
				const latency = Date.parse(r.ts ?? "") - reply.createdAt;
				if (latency >= 0 && latency <= timeout) result = { observed: true, latency_ms: latency, cursor: r.cursor };
				break;
			}
			const left = deadline - performance.now();
			if (result.observed || left <= 0) break;
			if (!read.more) await sleep(Math.min(50, left));
		} while (true);
	} catch (error) {
		console.error(`board-wake-probe: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		for (const posted of posts.reverse()) {
			try {
				// A lost POST response can still leave an owned message; recover it by its unique client key.
				if (!posted.id) {
					const found = await request(`/posts/${encodeURIComponent(posted.key)}`);
					if (found.status === 404) continue;
					posted.id = ((await found.json()) as Post).message?.id;
				}
				if (!posted.id) throw new Error("Board post lookup omitted its message ID");
				const response = await request(`/messages/${encodeURIComponent(posted.id)}/delete`, {});
				if ((await response.json())?.ok !== true) throw new Error(`Board did not confirm deletion of #${posted.id}`);
			} catch (error) {
				cleaned = false;
				console.error(`board-wake-probe cleanup: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return { result, cleaned };
}

const args = process.argv.slice(2);
let seat: string | undefined, timeout: number | undefined, json = false, invalid = false;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--seat" && seat === undefined) seat = args[++i] ?? "";
	else if (args[i] === "--timeout-ms" && timeout === undefined) timeout = Number(args[++i]);
	else if (args[i] === "--json" && !json) json = true;
	else invalid = true;
}
if (invalid || !seat || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(seat) || timeout === undefined || !Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) {
	console.error(USAGE);
	process.exitCode = 2;
} else {
	try {
		const { result, cleaned } = await probe(seat, timeout);
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = result.observed && cleaned ? 0 : 1;
	} catch (error) {
		console.error(`board-wake-probe: ${error instanceof Error ? error.message : String(error)}`);
		console.log(JSON.stringify(missing, null, 2));
		process.exitCode = 1;
	}
}
