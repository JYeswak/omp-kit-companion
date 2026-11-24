import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fleetPolicyState } from "./fleet-policy";
import { run } from "../src/kitlib/run.ts";
import { type BoardClient, type BoardEvent, boardActor, boardClientFromEnv, boardEventsAfter, boardHead } from "../src/board-events.ts";

const BOARD_WAIT_S = 25;
const BOARD_RETRY_MS = 10_000;
const BOARD_MIN_CYCLE_MS = 1_000;

/**
 * kit-inbox-wake (MAILWAKE1.2, ompkit-uk9wn.2): a seat wakes itself on its own Agent Mail.
 *
 * Sender-side wakes never worked: ~/.local/state/omp-kit/mail-wake.jsonl held 0 successful wakes in 879 rows on
 * 2026-10-26 (chief seats unbound to panes; a goal-mode seat is never idle, so a busy-gated paste never ran; a pane
 * paste into a busy seat strands a draft a person must submit, J-2026-10-26-14). So the recipient wakes itself, in
 * process: every INBOX_POLL_MS it reads its durable inbox delivery events (`am inbox-events --after <cursor>`), and
 * new messages addressed to it become one `deliverAs: "followUp"` message with `triggerTurn`. While the seat works,
 * omp queues a follow-up until the run has no more tool calls or steering, so the wake never lands mid-turn; on an
 * idle seat `triggerTurn` starts a turn at once. (Until 2026-10-26 this was an aside, which omp injects at the next
 * step boundary inside a running turn: Joshua, J-2026-10-26-19, "the mail wake seems to interrupt your work instead
 * of just queuing it".) An Esc interrupt drops queued non-user messages, so a wake queued at that moment is lost;
 * the mail itself stays unread in the inbox.
 *
 * The cursor is kept per (agent, project) under ~/.local/state/omp-kit/inbox-wake/, so mail that arrives while the
 * seat is restarting is delivered on its next start; the first start ever takes the current tail (no backlog flood).
 * Each delivery appends one WOKEN_INPROCESS row to mail-wake.jsonl, the ledger the sender side already writes.
 * Inert without AGENT_NAME, outside a fleet-opted-in project, when `am` is unavailable, or outside an
 * interactive TUI / RPC session (CHILDWAKE1: a finite print-mode child never polls nor wakes).
 */

/** `am inbox-events` costs about 2.25 s per call (5 runs, 2026-10-26); 30 s keeps the read under 8% of a seat's time. */
export const INBOX_POLL_MS = 30_000;
export const READ_DEADLINE_S = 20;
const MAX_EVENTS = 50;

export interface InboxEvent {
	cursor: number;
	message_id: number;
	kind: string;
	subject: string;
	from: string;
	importance?: string;
	ack_required?: boolean;
}

export interface InboxRead {
	events: InboxEvent[];
	next_cursor: number;
	tail_cursor: number;
}

export interface InboxWakeContext {
	cwd: string;
	/** Session mode and UI presence, same fields kit-composer-state gates on. */
	mode?: string;
	hasUI?: boolean;
	ui?: { getEditorText?: () => string };
	setInterval?: (callback: () => unknown, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

export interface InboxWakeApi {
	on(event: string, handler: (event: never, ctx: InboxWakeContext) => unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
	): void;
}

export interface InboxWakeDeps {
	home?: string;
	env?: Readonly<Record<string, string | undefined>>;
	now?: () => Date;
	/** Reads delivery events after `after` (or the tail position when `after` is null); null when unreadable. */
	read?: (agent: string, project: string, after: number | null) => Promise<InboxRead | null>;
	policyOn?: (project: string) => Promise<boolean>;
	fleetWatchPath?: string;
	/** FLEET_MAIL_BACKEND override: "board" reads the Board feed, anything else is Agent Mail. */
	backend?: string;
	/** Board credentials; defaults to BOARD_URL/BOARD_TOKEN or the local board's credentials file. */
	boardClient?: BoardClient;
	/** Hold the long-poll open for the session (default true); false polls on the 30 s interval instead. */
	boardLoop?: boolean;
	boardWaitS?: number;
}

/** The repo a registered Tern seat belongs to (the CC seat registry), else null. */
export function registeredRepo(home: string, env: Readonly<Record<string, string | undefined>>): string | null {
	const pane = env.TERN_PANE;
	// WAKEPENDING1: block ids exceed 2^53, so no JS number can carry them (9374096836001793 rounds to
	// ...792; 9374092541034498 is no safe integer). They stay exact decimal strings end to end.
	if (!pane || !/^[1-9][0-9]*$/.test(pane)) return null;
	try {
		const registry = JSON.parse(readFileSync(env.CC_SEATS || join(home, ".local", "state", "omp-kit", "cc", "seats.v1.json"), "utf8"));
		if (registry?.schema_version !== "omp-kit.cc.seats.v1" || !Array.isArray(registry.sessions)) return null;
		let repo: string | null = null;
		for (const session of registry.sessions) {
			if (typeof session?.repo !== "string" || !isAbsolute(session.repo) || !Array.isArray(session.seats)) return null;
			for (const seat of session.seats) {
				if (seat?.pane !== `tern:${pane}`) continue;
				if (repo !== null && repo !== session.repo) return null;
				repo = session.repo;
			}
		}
		return repo;
	} catch {
		return null;
	}
}

export function cursorPath(home: string, agent: string, project: string): string {
	const key = createHash("sha1").update(project).digest("hex").slice(0, 12);
	return join(home, ".local", "state", "omp-kit", "inbox-wake", `${agent}.${key}.json`);
}

/** Real paths of the repos the fleet-watch config lists under `sessions` and `herdr`; empty when it is absent. */
export function fleetWatchRepos(fleetWatchPath: string): string[] {
	let watch: unknown;
	try { watch = JSON.parse(readFileSync(fleetWatchPath, "utf8")); } catch { return []; }
	const record = typeof watch === "object" && watch !== null ? watch as Record<string, unknown> : {};
	const repos: string[] = [];
	for (const rows of [record.sessions, record.herdr]) {
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			const repo = typeof row === "object" && row !== null ? (row as Record<string, unknown>).repo : undefined;
			if (typeof repo !== "string" || !isAbsolute(repo)) continue;
			try { repos.push(realpathSync(repo)); } catch { /* a repo that is gone is no fleet repo */ }
		}
	}
	return repos;
}

function readCursor(path: string): number | null {
	try {
		const record = JSON.parse(readFileSync(path, "utf8"));
		return record?.schema === 1 && Number.isSafeInteger(record.cursor) ? record.cursor : null;
	} catch {
		return null;
	}
}

/** Message ids already woken, so a server re-emission never wakes twice. Bounded; oldest evicted first. */
const MAX_DELIVERED = 200;

function readDelivered(path: string): number[] {
	try {
		const record = JSON.parse(readFileSync(path, "utf8"));
		if (record?.schema !== 1 || !Array.isArray(record.delivered)) return [];
		return record.delivered.filter((id: unknown): id is number => Number.isSafeInteger(id)).slice(-MAX_DELIVERED);
	} catch {
		return [];
	}
}

function writeCursor(path: string, agent: string, project: string, cursor: number, delivered: readonly number[], at: Date): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ schema: 1, agent, project, cursor, delivered: [...delivered].slice(-MAX_DELIVERED), at: at.toISOString() }));
	renameSync(tmp, path);
}

/** The one follow-up line a batch of new messages becomes. */
export function wakeText(agent: string, events: InboxEvent[]): string {
	const lines = events.map(e => `#${e.message_id} from ${e.from}${e.ack_required ? " [ack required]" : ""}: ${e.subject}`);
	return `MAIL WAKE for ${agent}: ${events.length} new Agent Mail message(s).\n${lines.join("\n")}\n` +
		"Read them with fetch_inbox (include_bodies true) and act; acknowledge each one after acting on it.";
}

export function boardCursorPath(home: string, agent: string): string {
	return join(home, ".local", "state", "omp-kit", "inbox-wake", `${agent}.board.json`);
}

interface BoardState { agent: string; actor: string; cursor: string; delivered: string[] }

function readBoardState(path: string): BoardState | null {
	try {
		const r = JSON.parse(readFileSync(path, "utf8"));
		if (r?.schema !== 1 || typeof r.cursor !== "string" || r.cursor === "" || typeof r.actor !== "string") return null;
		const delivered = Array.isArray(r.delivered) ? r.delivered.filter((id: unknown): id is string => typeof id === "string") : [];
		return { agent: String(r.agent), actor: r.actor, cursor: r.cursor, delivered: delivered.slice(-MAX_DELIVERED) };
	} catch {
		return null;
	}
}

function writeBoardState(path: string, state: BoardState, at: Date): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ schema: 1, ...state, delivered: state.delivered.slice(-MAX_DELIVERED), at: at.toISOString() }));
	renameSync(tmp, path);
}

export function boardWakeText(agent: string, events: BoardEvent[]): string {
	const lines = events.map(e => `#${e.messageId} in ${e.channel} from ${e.byHandle || e.by}: ${e.text.split("\n", 1)[0].slice(0, 120)}`);
	return `BOARD WAKE for ${agent}: ${events.length} new Board mention(s).\n${lines.join("\n")}\n` +
		"Read the thread on the Board and act; acknowledge each directive after acting on it.";
}

async function amRead(agent: string, project: string, after: number | null): Promise<InboxRead | null> {
	const argv = ["am", "inbox-events", "--agent", agent, "--project", project, "--json", "--limit", String(MAX_EVENTS)];
	argv.push(...(after === null ? ["--position-now"] : ["--after", String(after)]));
	try {
		const result = await run(argv, { deadline_s: READ_DEADLINE_S });
		if (result.rc !== 0 || result.timed_out) return null;
		const doc = JSON.parse(Buffer.from(result.stdout).toString("utf8"));
		if (!Array.isArray(doc?.events) || !Number.isSafeInteger(doc.next_cursor)) return null;
		return { events: doc.events, next_cursor: doc.next_cursor, tail_cursor: doc.tail_cursor ?? doc.next_cursor };
	} catch {
		return null;
	}
}

export default async function kitInboxWake(pi: InboxWakeApi, deps: InboxWakeDeps = {}): Promise<void> {
	const home = deps.home ?? homedir();
	const env = deps.env ?? process.env;
	const now = deps.now ?? (() => new Date());
	const read = deps.read ?? amRead;
	const fleetWatchPath = deps.fleetWatchPath ?? env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
	// J-2026-11-09-02: mail wake is on by default for every fleet agent. A repo opts in with .omp/fleet.json, or by
	// being a fleet-watch repo (that file exists only on fleet machines); an explicit `"enabled": false` stays off.
	const policyOn = deps.policyOn ?? (async (project: string) => {
		const state = await fleetPolicyState(project);
		if (state.kind !== "off") return state.kind === "on";
		if (existsSync(join(state.root, ".omp", "fleet.json"))) return false;
		return fleetWatchRepos(fleetWatchPath).includes(state.root);
	});
	const agent = env.AGENT_NAME;
	if (!agent || agent.length > 64 || [...agent].some(c => !((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9")))) return;
	// One wake per process: the extension may load twice (a profile line during rollout plus the plugin manifest).
	if (!deps.read) {
		const loaded = Symbol.for("omp-kit.kit-inbox-wake.loaded");
		const globals = globalThis as Record<symbol, unknown>;
		if (globals[loaded]) return;
		globals[loaded] = true;
	}
	let timer: unknown = null;
	const backend = deps.backend ?? env.FLEET_MAIL_BACKEND ?? "am";
	const boardLoop = deps.boardLoop ?? true;
	const boardWaitS = deps.boardWaitS ?? BOARD_WAIT_S;
	const boardPath = boardCursorPath(home, agent);
	const abort = new AbortController();
	let stopped = false;
	let looping = false;
	let busy = false;
	let project = "";
	let path = "";
	let cwd = "";

	/** RESTARTRACE1 (J-2026-10-26-20): the registry naming this seat's project lists a Tern block only while omp runs
	 *  in it, so a restarted seat can start before it is re-listed (lead 2026-10-26: omp up 17:26:51Z, block re-listed
	 *  17:27:06Z). The project and its fleet policy are resolved on every tick until on, then kept for this process. */
	async function tick(): Promise<void> {
		if (path === "") {
			const candidate = env.AGENT_MAIL_PROJECT || registeredRepo(home, env) || cwd;
			if (!(await policyOn(candidate).catch(() => false))) return;
			project = candidate;
			path = cursorPath(home, agent!, project);
		}
		await poll();
	}

	/**
	 * BOARDLIVE1-S3: the Board source. One long-poll `GET /events?mentions=<actor>&after=<cursor>` per call; a mention
	 * at or before the cursor never wakes, and the cursor file is written after every wake, so a restart replays nothing.
	 * The first start ever takes the feed's current end (no backlog flood). Returns false when the board was unreadable.
	 */
	async function pollBoard(waitS: number): Promise<boolean> {
		if (busy) return true;
		busy = true;
		try {
			const client = deps.boardClient ?? boardClientFromEnv(home, env);
			if (client === null) return false;
			const state = readBoardState(boardPath);
			const actor = state?.actor ?? await boardActor(client, agent!, abort.signal);
			if (actor === null) return false;
			if (state === null) {
				const head = await boardHead(client, agent!, actor, abort.signal);
				if (head === null) return false;
				writeBoardState(boardPath, { agent: agent!, actor, cursor: head, delivered: [] }, now());
				return true;
			}
			const got = await boardEventsAfter(client, agent!, actor, state.cursor, waitS, abort.signal);
			if (got === null) return false;
			// Position AND prior delivery: a server that re-emits events at or below the cursor never wakes twice.
			const delivered = new Set(state.delivered);
			const fresh = got.events.filter(e => e.type === "message.posted" && e.by !== actor && e.messageId !== ""
				&& !delivered.has(e.messageId));
			if (fresh.length > 0) {
				pi.sendMessage({ customType: "kit-inbox-wake", content: boardWakeText(agent!, fresh), display: true },
					{ deliverAs: "followUp", triggerTurn: true });
				const ledger = join(home, ".local", "state", "omp-kit", "mail-wake.jsonl");
				mkdirSync(join(ledger, ".."), { recursive: true });
				const ts = now().toISOString();
				for (const e of fresh) {
					appendFileSync(ledger, JSON.stringify({
						ts, message_id: e.messageId, project_key: project, sender: e.byHandle, recipient: agent,
						subject: e.text.split("\n", 1)[0].slice(0, 120), status: "WOKEN_INPROCESS",
						detail: "kit-inbox-wake board followUp", cursor: e.cursor, backend: "board",
					}) + "\n");
					delivered.add(e.messageId);
				}
			}
			if (got.cursor !== state.cursor || fresh.length > 0) {
				writeBoardState(boardPath, { agent: agent!, actor, cursor: got.cursor, delivered: [...delivered] }, now());
			}
			return true;
		} catch {
			return false; // a failed poll keeps the cursor, so the same mentions are delivered on the next one
		} finally {
			busy = false;
		}
	}

	/** Holds the long-poll open for the life of the session; backs off when the board is unreadable. */
	async function runBoardLoop(): Promise<void> {
		while (!stopped) {
			const started = Date.now();
			if (path === "") await tick();
			const ok = path !== "" && (await pollBoard(boardWaitS));
			if (stopped) return;
			// An unreadable board or a hold that returned at once must not spin: wait out the rest of a second, or 10 s.
			const pause = ok ? Math.max(0, BOARD_MIN_CYCLE_MS - (Date.now() - started)) : BOARD_RETRY_MS;
			if (pause > 0) {
				const { promise, resolve: wake } = Promise.withResolvers<void>();
				setTimeout(wake, pause);
				await promise;
			}
		}
	}

	async function poll(): Promise<void> {
		if (backend === "board") { await pollBoard(0); return; }
		if (busy) return;
		busy = true;
		try {
			const after = readCursor(path);
			const got = await read(agent!, project, after);
			if (got === null) return;
			if (after === null) {
				writeCursor(path, agent!, project, got.next_cursor, [], now());
				return;
			}
			// WAKEPENDING1 cursor/dedup: the feed carries no read state, so a server re-emission at or
			// below the cursor would re-wake. Judge freshness by position AND prior delivery, never by
			// position alone. A crash between sendMessage and the write below still replays once
			// (at-least-once delivery is kept); the steady-state replay class is closed.
			const delivered = new Set(readDelivered(path));
			const fresh = got.events.filter(e => e.from !== agent && (e.kind === "to" || e.kind === "cc")
				&& e.cursor > after && !delivered.has(e.message_id));
			if (fresh.length > 0) {
				// J-2026-11-09-02: every agent wakes on its mail; no fleet stop or paused goal silences it.
				pi.sendMessage({ customType: "kit-inbox-wake", content: wakeText(agent!, fresh), display: true },
					{ deliverAs: "followUp", triggerTurn: true });
				const ledger = join(home, ".local", "state", "omp-kit", "mail-wake.jsonl");
				mkdirSync(join(ledger, ".."), { recursive: true });
				const ts = now().toISOString();
				for (const e of fresh) {
					appendFileSync(ledger, JSON.stringify({
						ts, message_id: e.message_id, project_key: project, sender: e.from, recipient: agent,
						subject: e.subject, status: "WOKEN_INPROCESS", detail: "kit-inbox-wake followUp", cursor: e.cursor,
					}) + "\n");
					delivered.add(e.message_id);
				}
			}
			if (got.next_cursor !== after || fresh.length > 0) {
				writeCursor(path, agent!, project, got.next_cursor, [...delivered], now());
			}
		} catch {
			// A failed poll keeps the cursor, so the same messages are delivered on the next one.
		} finally {
			busy = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		// CHILDWAKE1 (ompkit-1ra0d.225): a finite `omp -p` child inherits the parent's AGENT_NAME and
		// TERN_PANE, so an ungated wake polls the parent's inbox and injects the parent's mail into the
		// child, which abandons its task and consumes the parent's unread cursor. The wake runs only in
		// an interactive TUI session (same predicate as kit-composer-state) or an RPC seat, which wakes
		// today and keeps doing so; a print-mode / no-UI child neither polls, reads the cursor, writes
		// it, nor receives wakes.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (ctx.mode === "tui" && (ctx.hasUI !== true || typeof ctx.ui?.getEditorText !== "function")) return;
		cwd = ctx.cwd;
		await tick();
		if (backend === "board" && boardLoop && !looping) { looping = true; void runBoardLoop(); return; }
		if (timer === null && typeof ctx.setInterval === "function") timer = ctx.setInterval(() => tick(), INBOX_POLL_MS);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopped = true;
		abort.abort();
		if (timer !== null) {
			try { ctx.clearTimer?.(timer); } catch { /* cleared on shutdown anyway */ }
			timer = null;
		}
	});
}
