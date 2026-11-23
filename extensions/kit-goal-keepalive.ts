import { subscribeReleaseVerdicts } from "../src/release-verdict-mail.ts";

/** NATIVESESSION1: Tern owns process persistence; OMP owns goal continuation and pause.
 * IDLEWAKE1 (J-2026-11-09-03, restoring GOALBREATHE1's heartbeat from before f21234edc8): an active-goal fleet seat
 * that ends a turn and stays idle gets one wake per IDLE_HEARTBEAT_MS, so a lost event (mail, job result, verdict)
 * cannot strand it. The wake never resumes a paused goal or creates one: it arms only while the goal is active.
 * A new turn, user input, goal change or session change cancels it. No constraint text, escalation or sentinel. */
export const IDLE_HEARTBEAT_MS = 1_800_000;
export const IDLE_HEARTBEAT = "kit-goal-keepalive";
export interface GoalKeepaliveContext {
	cwd?: string;
	isIdle?: () => boolean;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
	sessionManager?: { getBranch?: () => readonly { type?: string; customType?: string; data?: { phases?: unknown }; message?: { role?: string; toolName?: string; isError?: boolean; details?: { phases?: unknown } } }[] };
}
export interface GoalKeepaliveApi {
	on(event: string, handler: (event: never, ctx: GoalKeepaliveContext) => unknown): void;
	sendMessage?: (message: { customType: string; content: string; display: boolean }, options?: { deliverAs?: "nextTurn" | "aside" }) => void;
}
export function seatIdentity(env: Record<string, string | undefined>): string | null {
	for (const key of ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"]) {
		const value = env[key]?.trim();
		if (value) return value;
	}
	return null;
}
function blockedEvents(ctx: GoalKeepaliveContext): string[] {
	const entries = ctx.sessionManager?.getBranch?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		const phases = entry.type === "custom" && entry.customType === "user_todo_edit" ? entry.data?.phases
			: entry.message?.role === "toolResult" && entry.message.toolName === "todo" && !entry.message.isError ? entry.message.details?.phases : undefined;
		if (!Array.isArray(phases)) continue;
		const tasks = phases.flatMap(phase => Array.isArray(phase?.tasks) ? phase.tasks : []);
		if (tasks.some(task => task?.status === "pending" || task?.status === "in_progress")) return [];
		return tasks.filter(task => task?.status === "blocked" && typeof task.blocker === "string").map(task => task.blocker);
	}
	return [];
}
export function heartbeatMessage(seat: string): string {
	const minutes = IDLE_HEARTBEAT_MS / 60_000;
	return `[kit-goal-keepalive] ${seat}: goal active, idle ${minutes}m (idle-wake heartbeat, at most one per ${minutes}m). `
		+ `Check mail, job results and what you wait on; act on anything that arrived, otherwise take your next work item or end the turn.`;
}

/** GOALPARK1: an active-goal seat whose turn ended with zero tool calls gets exactly one continuation at
 * agent_end, requested as a single sendMessage with deliverAs "nextTurn" (the house seam kit-upgrade-notice
 * and kit-flywheel-guard use to append-to-context-now when idle: one queued message turns into one more
 * turn, so one send is exactly one continuation). Paused goals and turns with pending user input get none.
 * Zero-tool and pending-input are read off the agent_end messages seam (the AgentEndEvent.messages shape
 * kit-callback already relies on): without a non-empty transcript the idle turn is unproven and the
 * extension fails closed. Exactly-once across consecutive idle turns comes from the `continued` latch,
 * which survives turn boundaries and re-arms only on observed tool use, a fresh goal id, user input consumed
 * by a started turn, or a session reset. No new host API is required. */
export const GOAL_CONTINUE = "kit-goal-continue";
export function continueMessage(seat: string): string {
	return `[kit-goal-continue] ${seat}: goal still active but the turn ended with no tool call (single continuation). `
		+ `Check mail, job results and what you wait on; act on anything that arrived, otherwise take your next work item or end the turn.`;
}
interface EndMessage {
	role?: unknown;
	content?: unknown;
	tool_calls?: unknown;
}
export interface GoalContinueEvent {
	willContinue?: boolean;
	messages?: readonly EndMessage[];
}
function hasToolCall(messages: readonly EndMessage[]): boolean {
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block && typeof block === "object" && "type" in block && (block.type === "toolCall" || block.type === "tool_call")) return true;
		}
	}
	return false;
}
/** "send": request the one continuation; "rearm": the turn did work, clear the latch; "none": stay quiet. */
function continuationVerdict(event: GoalContinueEvent | undefined, inputPending: boolean, alreadyContinued: boolean): "send" | "rearm" | "none" {
	const messages = event?.messages;
	if (!Array.isArray(messages) || messages.length === 0) return "none";
	if (hasToolCall(messages)) return "rearm";
	if (inputPending || messages[messages.length - 1]?.role === "user") return "none";
	if (alreadyContinued) return "none";
	return "send";
}
export default async function kitGoalKeepalive(
	pi: GoalKeepaliveApi,
	deps: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const owner = seatIdentity(env);
	let enabled = false;
	let continued = false;
	let inputPending = false;
	let goalId: string | null = null;
	let remove: (() => void) | undefined;
	let timer: unknown = null;
	let timerCtx: GoalKeepaliveContext | null = null;
	const clear = () => { remove?.(); remove = undefined; };
	const cancel = () => {
		if (timer !== null) {
			try { timerCtx?.clearTimer?.(timer); } catch { /* the fire re-checks eligibility */ }
		}
		timer = null;
		timerCtx = null;
	};
	const fire = () => {
		const ctx = timerCtx;
		timer = null;
		timerCtx = null;
		if (ctx === null || !enabled || owner === null || ctx.isIdle?.() === false) return;
		try {
			pi.sendMessage?.({ customType: IDLE_HEARTBEAT, content: heartbeatMessage(owner), display: true }, { deliverAs: "aside" });
		} catch { /* never throw out of a timer */ }
	};
	pi.on("goal_updated", ((event: { goal?: { id?: string; status?: string }; state?: { enabled?: boolean } }) => {
		const id = typeof event.goal?.id === "string" ? event.goal.id : null;
		if (id !== goalId) { goalId = id; continued = false; }
		enabled = event.state?.enabled === true && event.goal?.status === "active";
		if (!enabled) { clear(); cancel(); continued = false; inputPending = false; }
	}) as (event: never, ctx: GoalKeepaliveContext) => unknown);
	pi.on("agent_end", ((event: GoalContinueEvent | undefined, ctx: GoalKeepaliveContext) => {
		clear();
		cancel();
		const pending = inputPending;
		inputPending = false;
		if (!enabled || owner === null) return;
		remove = subscribeReleaseVerdicts(ctx.cwd ?? deps.cwd ?? process.cwd(), owner, blockedEvents(ctx), env.AGENT_MAIL_PROJECT);
		if (event?.willContinue === true) return; // omp already scheduled the next turn
		timerCtx = ctx;
		try { timer = ctx.setTimeout?.(fire, IDLE_HEARTBEAT_MS) ?? null; } catch { timer = null; }
		if (timer === null) timerCtx = null;
		const verdict = continuationVerdict(event, pending, continued);
		if (verdict === "send") {
			try {
				pi.sendMessage?.({ customType: GOAL_CONTINUE, content: continueMessage(owner), display: true }, { deliverAs: "nextTurn" });
				continued = true;
			} catch { /* a failed request must never break turn teardown */ }
		} else if (verdict === "rearm") continued = false;
	}) as (event: never, ctx: GoalKeepaliveContext) => unknown);
	// An input event after the last turn_start means user input is still queued at agent_end: the queued
	// input drives the next turn itself, so the continuation stays quiet and the latch re-arms. A started
	// turn consumes the queue; a fresh agent or session resets it.
	pi.on("input", () => { inputPending = true; continued = false; });
	pi.on("turn_start", () => { inputPending = false; });
	pi.on("agent_start", () => { inputPending = false; continued = false; });
	for (const event of ["agent_start", "turn_start", "input"]) pi.on(event, () => { cancel(); });
	for (const event of ["session_start", "session_switch", "session_stop", "session_shutdown"]) {
		pi.on(event, () => { enabled = false; continued = false; inputPending = false; clear(); cancel(); });
	}
}
