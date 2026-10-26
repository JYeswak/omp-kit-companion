import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fleetPolicyState } from "./fleet-policy";
import { run } from "../src/kitlib/run.ts";

/**
 * kit-inbox-wake (MAILWAKE1.2, ompkit-uk9wn.2): a seat wakes itself on its own Agent Mail.
 *
 * Sender-side wakes never worked: ~/.local/state/omp-kit/mail-wake.jsonl held 0 successful wakes in 879 rows on
 * 2026-10-26 (chief seats unbound to panes; a goal-mode seat is never idle, so a busy-gated paste never ran; a pane
 * paste into a busy seat strands a draft a person must submit, J-2026-10-26-14). So the recipient wakes itself, in
 * process: every INBOX_POLL_MS it reads its durable inbox delivery events (`am inbox-events --after <cursor>`), and
 * new messages addressed to it become one `deliverAs: "aside"` message. omp injects an aside at the next agent step
 * without interrupting the running tool batch, and starts a turn when the seat is idle.
 *
 * The cursor is kept per (agent, project) under ~/.local/state/omp-kit/inbox-wake/, so mail that arrives while the
 * seat is restarting is delivered on its next start; the first start ever takes the current tail (no backlog flood).
 * Each delivery appends one WOKEN_INPROCESS row to mail-wake.jsonl, the ledger the sender side already writes.
 * Inert without AGENT_NAME, outside a fleet-opted-in project, or when `am` is unavailable.
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
}

/** The repo a registered Tern seat belongs to (the CC seat registry), else null. */
export function registeredRepo(home: string, env: Readonly<Record<string, string | undefined>>): string | null {
	const pane = env.TERN_PANE;
	if (!pane || String(Number(pane)) !== pane) return null;
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

function readCursor(path: string): number | null {
	try {
		const record = JSON.parse(readFileSync(path, "utf8"));
		return record?.schema === 1 && Number.isSafeInteger(record.cursor) ? record.cursor : null;
	} catch {
		return null;
	}
}

function writeCursor(path: string, agent: string, project: string, cursor: number, at: Date): void {
	mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify({ schema: 1, agent, project, cursor, at: at.toISOString() }));
	renameSync(tmp, path);
}

/** The one aside line a batch of new messages becomes. */
export function wakeText(agent: string, events: InboxEvent[]): string {
	const lines = events.map(e => `#${e.message_id} from ${e.from}${e.ack_required ? " [ack required]" : ""}: ${e.subject}`);
	return `MAIL WAKE for ${agent}: ${events.length} new Agent Mail message(s).\n${lines.join("\n")}\n` +
		"Read them with fetch_inbox (include_bodies true) and act; acknowledge each one after acting on it.";
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
	const policyOn = deps.policyOn ?? (async (project: string) => (await fleetPolicyState(project)).kind === "on");
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
	let busy = false;
	let project = "";
	let path = "";

	async function poll(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const after = readCursor(path);
			const got = await read(agent!, project, after);
			if (got === null) return;
			if (after === null) {
				writeCursor(path, agent!, project, got.next_cursor, now());
				return;
			}
			const fresh = got.events.filter(e => e.from !== agent && (e.kind === "to" || e.kind === "cc"));
			if (fresh.length > 0) {
				pi.sendMessage({ customType: "kit-inbox-wake", content: wakeText(agent!, fresh), display: true },
					{ deliverAs: "aside", triggerTurn: true });
				const ledger = join(home, ".local", "state", "omp-kit", "mail-wake.jsonl");
				const ts = now().toISOString();
				for (const e of fresh) {
					appendFileSync(ledger, JSON.stringify({
						ts, message_id: e.message_id, project_key: project, sender: e.from, recipient: agent,
						subject: e.subject, status: "WOKEN_INPROCESS", detail: "kit-inbox-wake aside", cursor: e.cursor,
					}) + "\n");
				}
			}
			if (got.next_cursor !== after) writeCursor(path, agent!, project, got.next_cursor, now());
		} catch {
			// A failed poll keeps the cursor, so the same messages are delivered on the next one.
		} finally {
			busy = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		project = env.AGENT_MAIL_PROJECT || registeredRepo(home, env) || ctx.cwd;
		if (!(await policyOn(project))) return;
		path = cursorPath(home, agent, project);
		await poll();
		if (timer === null && typeof ctx.setInterval === "function") timer = ctx.setInterval(() => poll(), INBOX_POLL_MS);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (timer !== null) {
			try { ctx.clearTimer?.(timer); } catch { /* cleared on shutdown anyway */ }
			timer = null;
		}
	});
}
