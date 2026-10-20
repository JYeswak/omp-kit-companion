import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FlywheelExec, FlywheelToolCallResult } from "./kit-flywheel-guard";

/**
 * kit-mail-wake (MAILWAKE1, ompkit-uk9wn): an Agent Mail send must wake its recipient's live seat,
 * or refuse / warn when there is no wake path. Measured 2026-10-20: 19/19 sends signaled=false, asks
 * unseen for an hour, two asks addressed to background agents that can never read mail.
 *
 * Two entry points, called by kit-agent-mail-guard around one send_message/reply_message call:
 * - `beforeSend(toolCallId, args, projectKey)` runs after every other guard check passed. It resolves
 *   each recipient to a live Tern seat. An ack_required ask to a recipient with no wake path is refused
 *   with NO_WAKE_PATH (nothing is sent) naming the parent seat or director when one resolves. FYI mail
 *   passes; the plan is remembered for the result side.
 * - `afterSend(event)` runs on the tool_result. On success it queues one line,
 *   `MAIL <id> from <sender>: <subject>`, to each seated recipient through the existing wake primitive
 *   `omp-kit send <tab> tern:<block> <line> --cwd <repo> --until-delivered S` (BUSY seats are waited out,
 *   so the line lands at the next turn boundary, never mid-turn). Every outcome is a ledger row keyed by
 *   message id, and the sender gets the outcome appended to the tool result the same turn: WAKE_QUEUED /
 *   WAKE_DELIVERED, or UNSIGNALED with the reason.
 *
 * Seat resolution reuses the Agent Mail pane identity contract (pane_identity.rs, also read by
 * kit-flywheel-guard): ~/.config/agent-mail/identity/<sha1(repo)[:12]>/tern-<block> names the seat in the
 * live Tern block whose cwd is <repo> (`tern inspect --json`). Parents come from fleet-roster.json
 * (worker -> session director, director -> chief lead), an "under <Name>" in the Agent Mail
 * task_description, or the director of the fleet-watch session for the repo.
 *
 * Why a kit ledger and not the server receipt: get_message_delivery_receipt reports signaled=true only
 * from rows the server itself appends to message_delivery_signal_receipts after writing a filesystem
 * notification signal (NOTIFICATIONS_ENABLED, default false and off on this host). No MCP tool or `am`
 * subcommand appends a signal receipt, so a client-side wake cannot set signaled=true.
 */

export const WAKE_UNTIL_DELIVERED_S = 600;
/** How long the send result waits for the wake to settle before reporting it queued. */
export const WAKE_FAST_WAIT_MS = 2500;
const READ_TIMEOUT_MS = 10_000;

export interface MailWakeDeps {
	exec: FlywheelExec;
	env?: Record<string, string | undefined>;
	home?: string;
	now?: () => number;
	ompKitBin?: string;
	ternBin?: string;
	amBin?: string;
	rosterPath?: string;
	fleetWatchPath?: string;
	ledgerPath?: string;
	untilDeliveredS?: number;
	fastWaitMs?: number;
}

export interface Seat { name: string; session: string; block: string; repo: string }
export interface Parent { name: string; basis: string }
export type Resolution = { kind: "seat"; seat: Seat } | { kind: "none"; why: string; parent: Parent | null };

/** OMP's tool_result event, the fields this module reads. */
export interface MailToolResultEvent {
	toolCallId?: unknown;
	content?: unknown;
	isError?: unknown;
}
export interface MailToolResultPatch { content: unknown[] }

interface Plan {
	tool: "send_message" | "reply_message";
	sender: string;
	subject: string;
	projectKey: string;
	targets: { name: string; res: Resolution }[];
}

function prop(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function names(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim()) : [];
}

function readJson(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

/** Identity file body: `{"name":"X"}` (current writer) or a bare name (legacy). */
function identityName(path: string): string | null {
	let raw: string;
	try { raw = readFileSync(path, "utf8").trim(); } catch { return null; }
	if (!raw) return null;
	if (raw.startsWith("{")) {
		const name = prop(readJson(path), "name");
		return typeof name === "string" && name.trim() ? name.trim() : null;
	}
	return /^\S+$/.test(raw) ? raw : null;
}

/** The sent message id from an Agent Mail send/reply result payload. */
export function messageIdOf(payload: unknown): number | null {
	const id = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value > 0 ? value
		: typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : null;
	const deliveries = prop(payload, "deliveries");
	if (Array.isArray(deliveries)) for (const delivery of deliveries) {
		const found = id(prop(prop(delivery, "payload"), "id"));
		if (found !== null) return found;
	}
	return id(prop(payload, "message_id")) ?? id(prop(payload, "id")) ?? id(prop(prop(payload, "message"), "id"));
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(item => (typeof prop(item, "text") === "string" ? prop(item, "text") as string : "")).join("\n");
}

function parseResult(content: unknown): unknown {
	const text = resultText(content).trim();
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	try { return JSON.parse(text.slice(start)); } catch { return undefined; }
}

export function createMailWake(deps: MailWakeDeps) {
	const env = deps.env ?? process.env;
	const home = deps.home ?? homedir();
	const now = deps.now ?? Date.now;
	const ompKitBin = deps.ompKitBin ?? "omp-kit";
	const ternBin = deps.ternBin ?? "tern";
	const amBin = deps.amBin ?? "am";
	const rosterPath = deps.rosterPath ?? join(home, ".claude", "skills", "omp-kit-orchestration", "fleet-roster.json");
	const fleetWatchPath = deps.fleetWatchPath ?? env.OMP_KIT_FLEET_WATCH_CONFIG ?? join(home, ".config", "omp-kit", "fleet-watch.json");
	const ledgerPath = deps.ledgerPath ?? join(env.XDG_STATE_HOME || join(home, ".local", "state"), "omp-kit", "mail-wake.jsonl");
	const untilS = deps.untilDeliveredS ?? WAKE_UNTIL_DELIVERED_S;
	const fastWaitMs = deps.fastWaitMs ?? WAKE_FAST_WAIT_MS;
	const plans = new Map<string, Plan>();
	/** Wakes still running past fastWaitMs; `settled()` awaits them (CLI demo, tests). */
	const inFlight = new Set<Promise<unknown>>();

	function ledger(row: Record<string, unknown>): void {
		try {
			mkdirSync(dirname(ledgerPath), { recursive: true });
			appendFileSync(ledgerPath, `${JSON.stringify({ ts: new Date(now()).toISOString(), ...row })}\n`);
		} catch { /* the sender-facing notice still carries the outcome */ }
	}

	/** Live Tern blocks: tab name, block id, cwd. Null when Tern cannot be read. */
	async function liveBlocks(): Promise<{ session: string; block: string; cwd: string }[] | null> {
		let result;
		try { result = await deps.exec(ternBin, ["inspect", "--json"], { timeout: READ_TIMEOUT_MS }); } catch { return null; }
		if (result.code !== 0) return null;
		let parsed: unknown;
		try { parsed = JSON.parse(result.stdout); } catch { return null; }
		const out: { session: string; block: string; cwd: string }[] = [];
		const sessions = prop(parsed, "sessions");
		for (const session of Array.isArray(sessions) ? sessions : []) {
			const tabs = prop(session, "tabs");
			for (const tab of Array.isArray(tabs) ? tabs : []) {
				const tabName = prop(tab, "name");
				const blocks = prop(tab, "blocks");
				if (typeof tabName !== "string" || !tabName.trim()) continue;
				for (const block of Array.isArray(blocks) ? blocks : []) {
					const id = prop(block, "id");
					const cwd = prop(block, "cwd");
					if (prop(block, "live") === false || (typeof id !== "number" && typeof id !== "string") || typeof cwd !== "string") continue;
					out.push({ session: tabName, block: String(id), cwd });
				}
			}
		}
		return out;
	}

	function roster(): { sessions: Record<string, { director?: string; workers?: string[] }>; lead: string | null } {
		const parsed = readJson(rosterPath);
		const sessions = prop(parsed, "sessions");
		const lead = prop(prop(parsed, "chiefs"), "lead");
		return { sessions: typeof sessions === "object" && sessions !== null ? sessions as Record<string, { director?: string; workers?: string[] }> : {}, lead: typeof lead === "string" ? lead : null };
	}

	async function taskOf(name: string, projectKey: string): Promise<string | null> {
		let result;
		try { result = await deps.exec(amBin, ["agents", "list", "-p", projectKey, "--json"], { timeout: READ_TIMEOUT_MS }); } catch { return null; }
		if (result.code !== 0) return null;
		let rows: unknown;
		try { rows = JSON.parse(result.stdout); } catch { return null; }
		const row = Array.isArray(rows) ? rows.find(item => typeof prop(item, "name") === "string" && (prop(item, "name") as string).toLowerCase() === name.toLowerCase()) : undefined;
		if (row === undefined) return null;
		const task = prop(row, "task_description");
		return typeof task === "string" ? task : "";
	}

	async function parentOf(name: string, projectKey: string, task: string | null): Promise<Parent | null> {
		const { sessions, lead } = roster();
		for (const [session, row] of Object.entries(sessions)) {
			if (row.workers?.some(worker => worker.toLowerCase() === name.toLowerCase()) && row.director) return { name: row.director, basis: `director of ${session} (fleet-roster.json)` };
			if (row.director?.toLowerCase() === name.toLowerCase() && lead) return { name: lead, basis: "chief lead (fleet-roster.json)" };
		}
		const under = task?.slice(0, 500).match(/\bunder ([A-Z][a-z]+[A-Z][a-z]+)\b/);
		if (under) return { name: under[1], basis: "named in its Agent Mail task_description" };
		const watch = prop(readJson(fleetWatchPath), "sessions");
		for (const row of Array.isArray(watch) ? watch : []) {
			const session = prop(row, "session");
			if (prop(row, "repo") !== projectKey || typeof session !== "string") continue;
			const director = sessions[session]?.director;
			if (director) return { name: director, basis: `director of ${session}, the fleet session for ${projectKey}` };
		}
		return null;
	}

	/** One recipient to its live seat, or why there is none plus the parent to re-address to. */
	async function resolve(name: string, projectKey: string, blocks?: { session: string; block: string; cwd: string }[] | null): Promise<Resolution> {
		const live = blocks === undefined ? await liveBlocks() : blocks;
		if (live === null) return { kind: "none", why: "Tern could not be read (`tern inspect --json` failed), so no live seat is proven", parent: await parentOf(name, projectKey, null) };
		const matches: Seat[] = [];
		for (const block of live) {
			const hash = createHash("sha1").update(block.cwd).digest("hex").slice(0, 12);
			const bound = identityName(join(home, ".config", "agent-mail", "identity", hash, `tern-${block.block}`));
			if (bound && bound.toLowerCase() === name.toLowerCase()) matches.push({ name: bound, session: block.session, block: block.block, repo: block.cwd });
		}
		const seat = matches.find(match => match.repo === projectKey) ?? matches[0];
		if (seat) return { kind: "seat", seat };
		const task = await taskOf(name, projectKey);
		const why = task === null
			? `no live Tern seat is bound to ${name}`
			: `${name} is registered in Agent Mail ("${task.slice(0, 80)}") but holds no live Tern seat (a background/task agent cannot read mail)`;
		return { kind: "none", why, parent: await parentOf(name, projectKey, task) };
	}

	async function beforeSend(toolCallId: unknown, tool: "send_message" | "reply_message", args: unknown, projectKey: string): Promise<FlywheelToolCallResult | undefined> {
		const sender = typeof prop(args, "sender_name") === "string" ? (prop(args, "sender_name") as string).trim() : "";
		const recipients = [...new Set([...names(prop(args, "to")), ...names(prop(args, "cc")), ...names(prop(args, "bcc"))])]
			.filter(name => name.toLowerCase() !== sender.toLowerCase());
		// A reply with no explicit recipients goes to the thread's defaults, known only from the result.
		if (tool === "reply_message" && recipients.length === 0) {
			if (typeof toolCallId === "string") plans.set(toolCallId, { tool, sender, subject: "", projectKey, targets: [] });
			return undefined;
		}
		const blocks = recipients.length ? await liveBlocks() : null;
		const targets: Plan["targets"] = [];
		for (const name of recipients) targets.push({ name, res: await resolve(name, projectKey, blocks) });
		const subject = typeof prop(args, "subject") === "string" ? (prop(args, "subject") as string) : "";
		if (prop(args, "ack_required") === true) {
			const dead = targets.filter(target => target.res.kind === "none");
			if (dead.length) {
				for (const target of dead) ledger({ status: "NO_WAKE_PATH", message_id: null, project_key: projectKey, sender, recipient: target.name, subject, refused: true });
				const lines = dead.map(target => {
					const res = target.res as Extract<Resolution, { kind: "none" }>;
					return `${target.name}: ${res.why}; ${res.parent ? `re-address the ask to ${res.parent.name} (${res.parent.basis})` : "no parent seat or director resolves; ask the lead which seat owns this agent"}`;
				});
				return { block: true, reason: `NO_WAKE_PATH: an ack_required ask must wake its recipient, and nothing would wake ${dead.map(target => target.name).join(", ")}. Nothing was sent.\n${lines.join("\n")}` };
			}
		}
		if (typeof toolCallId === "string" && targets.length) plans.set(toolCallId, { tool, sender, subject, projectKey, targets });
		return undefined;
	}

	async function wake(seat: Seat, line: string): Promise<{ ok: boolean; status: string; detail: string }> {
		const args = ["send", seat.session, `tern:${seat.block}`, line, "--cwd", seat.repo, "--until-delivered", String(untilS),
			"--no-bead-reason", "Agent Mail wake (MAILWAKE1)", "--json"];
		let result;
		try { result = await deps.exec(ompKitBin, args, { timeout: (untilS + 60) * 1000 }); }
		catch (error) { return { ok: false, status: "WAKE_FAILED", detail: `\`${ompKitBin} send\` could not run (${error instanceof Error ? error.message : String(error)})` }; }
		let data: unknown;
		try { data = prop(JSON.parse(result.stdout), "data"); } catch { data = undefined; }
		const status = typeof prop(data, "status") === "string" ? prop(data, "status") as string : "";
		if (result.code === 0 && (status === "OK" || status === "DELIVERED")) return { ok: true, status: "WAKE_DELIVERED", detail: `${status} ${typeof prop(data, "detail") === "string" ? prop(data, "detail") : ""}`.trim() };
		const detail = typeof prop(data, "detail") === "string" ? prop(data, "detail") as string : (result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? "";
		return { ok: false, status: "WAKE_FAILED", detail: `\`${ompKitBin} send\` exited ${result.killed ? "after timeout" : result.code}${status ? ` (${status})` : ""}${detail ? `: ${detail}` : ""}` };
	}

	async function afterSend(event: MailToolResultEvent): Promise<MailToolResultPatch | undefined> {
		if (typeof event.toolCallId !== "string") return undefined;
		const plan = plans.get(event.toolCallId);
		if (!plan) return undefined;
		plans.delete(event.toolCallId);
		if (event.isError === true) return undefined;
		const payload = parseResult(event.content);
		const id = messageIdOf(payload);
		if (plan.targets.length === 0) {
			const deliveries = prop(payload, "deliveries");
			const sentPayload = Array.isArray(deliveries) ? prop(deliveries[0], "payload") : payload;
			const subject = prop(sentPayload, "subject");
			if (typeof subject === "string") plan.subject = subject;
			const recipients = [...new Set([...names(prop(sentPayload, "to")), ...names(prop(sentPayload, "cc"))])]
				.filter(name => name.toLowerCase() !== plan.sender.toLowerCase());
			const blocks = recipients.length ? await liveBlocks() : null;
			for (const name of recipients) plan.targets.push({ name, res: await resolve(name, plan.projectKey, blocks) });
		}
		const notices: string[] = [];
		for (const target of plan.targets) {
			const base = { message_id: id, project_key: plan.projectKey, sender: plan.sender, recipient: target.name, subject: plan.subject };
			if (target.res.kind === "none") {
				ledger({ ...base, status: "UNSIGNALED", reason: "NO_WAKE_PATH", detail: target.res.why, parent: target.res.parent?.name ?? null });
				notices.push(`UNSIGNALED: mail ${id ?? "?"} to ${target.name} is persisted but wakes nobody (NO_WAKE_PATH: ${target.res.why}).${target.res.parent ? ` Its parent is ${target.res.parent.name} (${target.res.parent.basis}); send there if it needs action.` : ""}`);
				continue;
			}
			const seat = target.res.seat;
			if (id === null) {
				ledger({ ...base, status: "UNSIGNALED", reason: "NO_MESSAGE_ID", seat: `tern:${seat.block}` });
				notices.push(`UNSIGNALED: the send result carried no message id, so no wake was queued for ${target.name}; tell them directly.`);
				continue;
			}
			const line = `MAIL ${id} from ${plan.sender}: ${plan.subject.replace(/\s+/g, " ").slice(0, 160)}`;
			const where = `tern:${seat.block} (${seat.session}, ${seat.repo})`;
			const pending = wake(seat, line).then(outcome => {
				ledger({ ...base, status: outcome.status, seat: `tern:${seat.block}`, session: seat.session, repo: seat.repo, line, detail: outcome.detail });
				return outcome;
			});
			const timer = Promise.withResolvers<null>();
			const handle = setTimeout(timer.resolve, fastWaitMs, null);
			const outcome = await Promise.race([pending, timer.promise]);
			clearTimeout(handle);
			if (outcome === null) {
				inFlight.add(pending);
				void pending.finally(() => inFlight.delete(pending));
				ledger({ ...base, status: "WAKE_QUEUED", seat: `tern:${seat.block}`, session: seat.session, repo: seat.repo, line });
				notices.push(`WAKE_QUEUED: mail ${id} -> ${target.name} at ${where}; lands at its next turn boundary (until-delivered ${untilS}s). Outcome: ${ledgerPath}`);
			} else if (outcome.ok) {
				notices.push(`WAKE_DELIVERED: mail ${id} -> ${target.name} at ${where}.`);
			} else {
				notices.push(`UNSIGNALED: mail ${id} to ${target.name} is persisted but the wake to ${where} failed: ${outcome.detail}. Wake them another way.`);
			}
		}
		if (!notices.length) return undefined;
		const content = Array.isArray(event.content) ? event.content : [];
		return { content: [...content, { type: "text", text: `[kit-mail-wake] ${notices.join("\n")}` }] };
	}

	/** Resolves once every wake still in flight has written its outcome row. */
	async function settled(): Promise<void> {
		await Promise.all([...inFlight]);
	}

	return { resolve, beforeSend, afterSend, settled, ledgerPath };
}
