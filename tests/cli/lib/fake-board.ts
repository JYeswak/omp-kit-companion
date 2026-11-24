import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A throwaway Board: just the task routes reservations use, with sequential ids.
export interface FakeTask { id: number; channel: string; labels: Record<string, string>; state: string; epoch: number; token: string; until: number }

export function fakeBoard(seedDir?: string, logFile?: string) {
	const tasks: FakeTask[] = [];
	let nextId = 100;
	let down = false;
	let racer: string | undefined; // a seat that grabs the next reserved path just before it is created (a lost race)
	const seedReads = new Map<number, number>();
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (down) return new Response("down", { status: 503 });
			const url = new URL(req.url);
			const path = url.pathname.replace(/^\/api\/board/, "");
			const json = (body: unknown, status = 200) => Response.json(body, { status });
			if (req.method === "GET" && path === "/me") return json({ profile: req.headers.get("x-board-profile") });
			if (req.method === "POST" && path === "/__reset") { tasks.length = 0; racer = undefined; return json({ ok: true }); }
			if (req.method === "POST" && path === "/__race") { racer = ((await req.json()) as { holder?: string }).holder; return json({ ok: true }); }
			if (req.method === "GET" && path === "/tasks" && logFile) appendFileSync(logFile, `robot reservations ${url.searchParams.get("channel")}\n`);
			if (req.method === "GET" && path === "/tasks") {
				const channel = url.searchParams.get("channel") ?? "";
				// seedDir: a sibling process cannot reach `tasks`, so a test may drop <channel with / as _>.json holds there.
				let seeded: FakeTask[] = [];
				if (seedDir) {
					const seedFile = (name: string) => join(seedDir, name.replace(/\//g, "_") + ".json");
					let seedPath = seedFile(channel);
					try { readFileSync(seedPath); } catch { seedPath = seedFile("__default"); } // a channel without its own seed reads the default
					try {
						const holds = JSON.parse(readFileSync(seedPath, "utf8")) as { id: number; path: string; holder: string; exclusive: boolean; until: number; reads?: number }[];
						// reads: the hold is visible to that many listings only (a custody lapse between two reads).
						for (const h of holds) if (h.reads !== undefined) seedReads.set(h.id, (seedReads.get(h.id) ?? 0) + 1);
						seeded = holds.filter((h) => h.reads === undefined || (seedReads.get(h.id) ?? 0) <= h.reads).map((h) => ({ id: h.id, channel, labels: { path: h.path, holder: h.holder, exclusive: h.exclusive ? "1" : "0" }, state: "claimed", epoch: 1, token: "seed", until: h.until }));
					} catch { /* no seed file: no seeded holds */ }
				}
				const rows = [...tasks, ...seeded].filter((t) => t.channel === channel && t.state === url.searchParams.get("state"));
				return json({ tasks: rows.map((t) => ({ message: { id: String(t.id), labels: t.labels, task: { state: t.state, claim: { until: new Date(t.until).toISOString() } } } })), cursor: "1" });
			}
			const body = req.method === "POST" ? await req.json() as Record<string, any> : {};
			if (req.method === "POST" && path === "/tasks") {
				await new Promise((r) => setTimeout(r, Math.random() * 15)); // interleave racers
				if (logFile) appendFileSync(logFile, `file_reservations reserve ${body.channel} ${body.labels.holder} ${body.labels.path} --exclusive --ttl ${body.lease} --reason ${String(body.text).split("\n\n").slice(1).join("\n\n")}\n`);
				if (racer !== undefined) {
					tasks.push({ id: nextId++, channel: body.channel, labels: { path: body.labels.path, holder: racer, exclusive: "1" }, state: "claimed", epoch: 1, token: "race", until: Date.now() + 3_600_000 });
					racer = undefined;
				}
				const t: FakeTask = { id: nextId++, channel: body.channel, labels: body.labels, state: "claimed", epoch: 1, token: "tok" + nextId, until: Date.now() + body.lease * 1000 };
				tasks.push(t);
				return json({ task: { id: String(t.id) }, claim: { epoch: t.epoch, token: t.token, until: new Date(t.until).toISOString() } }, 201);
			}
			const m = /^\/tasks\/(\d+)\/(renew|complete)$/.exec(path);
			const t = m ? tasks.find((x) => x.id === Number(m[1])) : undefined;
			if (!m || !t || t.state !== "claimed" || body.token !== t.token) return json({ error: "claim_lost" }, 409);
			if (m[2] === "complete") t.state = "completed";
			else t.until = Date.now() + body.lease * 1000;
			return json({ task: { id: String(t.id) }, until: new Date(t.until).toISOString() });
		},
	});
	return { url: `http://127.0.0.1:${server.port}/api/board`, tasks, nextId: () => nextId++, setDown: (v: boolean) => { down = v; }, stop: () => server.stop(true) };
}

