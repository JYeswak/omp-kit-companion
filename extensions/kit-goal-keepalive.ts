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
	sendMessage?: (message: { customType: string; content: string; display: boolean }, options: { deliverAs: "aside" }) => void;
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
export default async function kitGoalKeepalive(
	pi: GoalKeepaliveApi,
	deps: { env?: Record<string, string | undefined>; cwd?: string } = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const owner = seatIdentity(env);
	let enabled = false;
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
	pi.on("goal_updated", ((event: { goal?: { status?: string }; state?: { enabled?: boolean } }) => {
		enabled = event.state?.enabled === true && event.goal?.status === "active";
		if (!enabled) { clear(); cancel(); }
	}) as (event: never, ctx: GoalKeepaliveContext) => unknown);
	pi.on("agent_end", ((event: { willContinue?: boolean } | undefined, ctx: GoalKeepaliveContext) => {
		clear();
		cancel();
		if (!enabled || owner === null) return;
		remove = subscribeReleaseVerdicts(ctx.cwd ?? deps.cwd ?? process.cwd(), owner, blockedEvents(ctx), env.AGENT_MAIL_PROJECT);
		if (event?.willContinue === true) return; // omp already scheduled the next turn
		timerCtx = ctx;
		try { timer = ctx.setTimeout?.(fire, IDLE_HEARTBEAT_MS) ?? null; } catch { timer = null; }
		if (timer === null) timerCtx = null;
	}) as (event: never, ctx: GoalKeepaliveContext) => unknown);
	for (const event of ["agent_start", "turn_start", "input"]) pi.on(event, () => { cancel(); });
	for (const event of ["session_start", "session_switch", "session_stop", "session_shutdown"]) {
		pi.on(event, () => { enabled = false; clear(); cancel(); });
	}
}
