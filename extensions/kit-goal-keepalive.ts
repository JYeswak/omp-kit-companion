/**
 * kit-goal-keepalive (GOALKEEP1 ompkit-fp72.120.16.23.1, J-2026-10-18-51): a fleet
 * seat's active goal never sits idle.
 *
 * Measured 2026-10-19: QuietBadger idle 68 min, RusticPine 54 min, TurquoiseSummit
 * 53 min, CopperTrout 33 min, all with goal mode active on prompts that say "never
 * wait". Cause in omp 18.12.2: interactive-mode.ts #scheduleGoalContinuation
 * returns early when #goalSuppressNextContinuation (a continuation turn whose
 * activity is empty or repeats the previous) or #goalOpenWorkAllBlocked (todos
 * all blocked) holds; only a non-synthetic user message resets suppression. So a
 * suppressed goal seat stays silent until a human types.
 *
 * This extension does not touch the continuation logic (another builder owns
 * kit-flywheel-guard.ts). After `agent_end` it arms a contained one-shot timer
 * (ctx.setTimeout, auto-cleared on session shutdown); if the session is still
 * idle at 120 s it sends one `deliverAs: "aside"` message — which starts a turn
 * when idle (types.ts 1728-1730) — carrying the seat's role downtime list plus
 * the idle time. A new turn or user input cancels the timer.
 *
 * Bounds: at most one wake per 10 min per seat; after 3 consecutive wakes whose
 * turns made no tool call, the extension stops waking and records
 * GOAL_IDLE_ESCALATE (custom entry) so the sentinel mails the director and logs
 * a prompt review.
 *
 * Identity is the same env names admissionOwner uses (BR_ACTOR, BR_AGENT_NAME,
 * AGENT_NAME). Sessions without a fleet identity never wake: only a launched
 * seat has downtime duties.
 */

/** ms of still-idle time before one wake. */
export const IDLE_WAKE_MS = 120_000;
/** Minimum ms between two wakes for one seat. */
export const MIN_WAKE_INTERVAL_MS = 600_000;
/** Consecutive no-tool-call wakes before escalation. */
export const MAX_QUIET_WAKES = 3;
/** Custom entry the sentinel watches to mail the director + log prompt review. */
export const GOAL_IDLE_ESCALATE = "GOAL_IDLE_ESCALATE";

const IDENTITY_ENV = ["BR_ACTOR", "BR_AGENT_NAME", "AGENT_NAME"] as const;

/** The seat's fleet identity (admissionOwner env names), or null outside a seat. */
export function seatIdentity(env: Record<string, string | undefined>): string | null {
	for (const name of IDENTITY_ENV) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return null;
}

function formatIdle(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${s % 60 === 0 ? "" : ` ${s % 60}s`}`;
}

/** The wake body: the seat's role downtime list plus the idle time. */
export function downtimeMessage(seat: string, idleMs: number): string {
	return (
		`[kit-goal-keepalive] ${seat}: goal active but the seat has been idle ${formatIdle(idleMs)} ` +
		`with no continuation scheduled. A seat never waits — pull downtime work now, in this order: ` +
		`(1) your held beads; ` +
		`(2) another worker's in_review beads (verify, never your own); ` +
		`(3) bead DAG repair (orphans, cycles, blocked beads with no open fix); ` +
		`(4) /skill:reality-check-for-project, filing every NO_BEAD gap as a bead; ` +
		`(5) /skill:profiling-software-performance then /skill:extreme-software-optimization on the slowest gate, test, or tool. ` +
		`Start with (1); report PROGRESS or DONE the same turn.`
	);
}

/** An assistant message block, as seen in AgentEndEvent messages. */
export interface KeepaliveBlock {
	type: string;
	[key: string]: unknown;
}

/** An agent message, as seen in AgentEndEvent messages. */
export interface KeepaliveMessage {
	role: string;
	content?: KeepaliveBlock[] | unknown;
	[key: string]: unknown;
}

/** True when the turn's messages contain at least one assistant tool call. */
export function turnMadeToolCall(messages: readonly KeepaliveMessage[] | undefined): boolean {
	if (!messages) return false;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "toolCall") return true;
		}
	}
	return false;
}

export interface GoalKeepaliveApi {
	on(event: string, handler: (e: never, ctx: GoalKeepaliveContext) => unknown): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean },
		options?: { deliverAs?: string },
	): void;
	appendEntry(customType: string, data?: unknown): void;
}

export interface GoalKeepaliveContext {
	isIdle?: () => boolean;
	setTimeout(callback: (...args: unknown[]) => void, ms?: number): unknown;
	clearTimer(timer: unknown): void;
}

export interface GoalKeepaliveDeps {
	env?: Record<string, string | undefined>;
	now?: () => number;
}

export default async function kitGoalKeepalive(
	pi: GoalKeepaliveApi,
	deps: GoalKeepaliveDeps = {},
): Promise<void> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	let goal: { enabled: boolean; status: string } | null = null;
	let timer: unknown = null;
	let timerCtx: GoalKeepaliveContext | null = null;
	let lastWakeAt = 0;
	let quietWakes = 0;
	let escalated = false;
	/** A wake fired and the next agent_end attributes that turn's tool calls. */
	let wakePending = false;
	let idleSince = 0;

	const cancel = (ctx: GoalKeepaliveContext) => {
		if (timer !== null) {
			try {
				ctx.clearTimer(timer);
			} catch {
				// A failed clear leaves a contained one-shot that re-checks
				// eligibility before sending; never throw out of a handler.
			}
			timer = null;
			timerCtx = null;
		}
	};

	const eligible = (): boolean => {
		if (escalated) return false;
		if (seatIdentity(env) === null) return false;
		if (goal === null || goal.enabled !== true || goal.status !== "active") return false;
		return true;
	};

	/** The timer callback: uses the ctx captured at arm time (contained timers pass no ctx). */
	const fire = () => {
		const ctx = timerCtx;
		timer = null;
		timerCtx = null;
		if (ctx === null || !eligible()) return;
		if (ctx.isIdle?.() === false) return; // busy: that turn's agent_end re-arms
		const at = now();
		if (at - lastWakeAt < MIN_WAKE_INTERVAL_MS) return;
		const seat = seatIdentity(env);
		if (seat === null) return;
		pi.sendMessage(
			{
				customType: "kit-goal-keepalive",
				content: downtimeMessage(seat, at - idleSince),
				display: true,
			},
			{ deliverAs: "aside" },
		);
		lastWakeAt = at;
		wakePending = true;
	};

	const arm = (ctx: GoalKeepaliveContext) => {
		cancel(ctx);
		if (!eligible()) return;
		idleSince = now();
		timerCtx = ctx;
		try {
			timer = ctx.setTimeout(fire, IDLE_WAKE_MS);
		} catch {
			timer = null; // timer unwired: stay silent, never throw out of agent_end
			timerCtx = null;
		}
	};

	type GoalEvent = { goal?: { status?: string } | null; state?: { enabled?: boolean } | null };
	type EndEvent = { messages?: KeepaliveMessage[]; willContinue?: boolean };

	pi.on("goal_updated", (event: GoalEvent) => {
		if (event.goal === undefined && event.state === undefined) return;
		goal = { enabled: event.state?.enabled === true, status: String(event.goal?.status ?? "") };
	});
	pi.on("agent_end", ((event: EndEvent, ctx: GoalKeepaliveContext) => {
		if (wakePending) {
			wakePending = false;
			if (turnMadeToolCall(event.messages)) {
				quietWakes = 0;
			} else {
				quietWakes += 1;
				if (quietWakes >= MAX_QUIET_WAKES && !escalated) {
					escalated = true;
					cancel(ctx);
					pi.appendEntry(GOAL_IDLE_ESCALATE, {
						seat: seatIdentity(env),
						quietWakes,
						at: new Date(now()).toISOString(),
						next: "sentinel mails the director and logs a prompt review",
					});
					return;
				}
			}
		}
		if (event.willContinue === true) {
			cancel(ctx); // not a terminal settle: a continuation is already scheduled
			return;
		}
		arm(ctx);
	}) as (e: never, ctx: GoalKeepaliveContext) => unknown);
	const cancelOn = (event: string) => {
		pi.on(event, ((_e: never, ctx: GoalKeepaliveContext) => cancel(ctx)) as (e: never, ctx: GoalKeepaliveContext) => unknown);
	};
	// A new turn or user input ends the idle window the timer watches.
	cancelOn("agent_start");
	cancelOn("turn_start");
	cancelOn("input");
	cancelOn("session_stop");
}
