import { expect, test } from "bun:test";
import kitGoalKeepalive, {
	downtimeMessage,
	GOAL_IDLE_ESCALATE,
	IDLE_WAKE_MS,
	MAX_QUIET_WAKES,
	MIN_WAKE_INTERVAL_MS,
	seatIdentity,
	turnMadeToolCall,
	type GoalKeepaliveApi,
	type GoalKeepaliveContext,
	type KeepaliveMessage,
} from "./kit-goal-keepalive.ts";

type Handler = (e: never, ctx: GoalKeepaliveContext) => unknown;

interface Sent {
	content: string;
	customType: string;
	deliverAs: string | undefined;
}

interface FakeSeat {
	api: GoalKeepaliveApi;
	handlers: Record<string, Handler>;
	sent: Sent[];
	entries: { customType: string; data: unknown }[];
	ctx: GoalKeepaliveContext & { fireDue: () => number; armed: () => number };
	clock: { at: number };
	setIdle: (idle: boolean) => void;
	emit: (event: string, e?: never) => unknown;
}

function fakeHost(opts: { env?: Record<string, string | undefined>; idle?: boolean; clock?: { at: number } } = {}): FakeSeat {
	const sent: Sent[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const handlers: Record<string, Handler> = {};
	const clock = opts.clock ?? { at: 1_000_000 };
	let idle = opts.idle ?? true;
	let nextHandle = 1;
	const timers: Record<number, (...args: unknown[]) => void> = {};
	const api: GoalKeepaliveApi = {
		on: (event, handler) => {
			handlers[event] = handler;
		},
		sendMessage: (message, options) => {
			sent.push({ content: message.content, customType: message.customType, deliverAs: options?.deliverAs });
		},
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
	};
	const ctx: GoalKeepaliveContext & { fireDue: () => number; armed: () => number } = {
		isIdle: () => idle,
		setTimeout: (cb) => {
			const handle = nextHandle++;
			timers[handle] = cb;
			return handle;
		},
		clearTimer: (timer) => {
			delete timers[timer as number];
		},
		fireDue: () => {
			const due = Object.values(timers);
			for (const key of Object.keys(timers)) delete timers[Number(key)];
			for (const cb of due) cb();
			return due.length;
		},
		armed: () => Object.keys(timers).length,
	};
	return {
		api,
		handlers,
		sent,
		entries,
		ctx,
		clock,
		setIdle: (value) => {
			idle = value;
		},
		emit: (event, e?) => handlers[event]?.(e as never, ctx),
	};
}

const SEAT = { env: { AGENT_NAME: "QuietBadger" } };
const ACTIVE_GOAL = { goal: { status: "active" }, state: { enabled: true } } as never;
const PAUSED_GOAL = { goal: { status: "paused" }, state: { enabled: false } } as never;
const TOOL_TURN = [
	{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
] as KeepaliveMessage[];
const QUIET_TURN = [{ role: "assistant", content: [{ type: "text", text: "holding" }] }] as KeepaliveMessage[];

async function idleSeat(h: FakeSeat): Promise<void> {
	await kitGoalKeepalive(h.api, { env: SEAT.env, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
}

function advance(h: FakeSeat, ms: number): void {
	h.clock.at += ms;
	h.ctx.fireDue();
}

test("live: an idle fleet goal seat gets exactly one wake at 120 s, aside, with the downtime list and idle time", async () => {
	const h = fakeHost();
	await idleSeat(h);
	expect(h.ctx.armed()).toBe(1);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.deliverAs).toBe("aside");
	expect(h.sent[0]!.customType).toBe("kit-goal-keepalive");
	expect(h.sent[0]!.content).toContain("QuietBadger");
	expect(h.sent[0]!.content).toContain("2m");
	for (const item of ["held beads", "in_review", "DAG repair", "reality-check-for-project", "profiling-software-performance"]) {
		expect(h.sent[0]!.content).toContain(item);
	}
	// Still idle with no new agent_end: no second wake from the same arm.
	h.ctx.fireDue();
	expect(h.sent).toHaveLength(1);
});

test("wiring: agent_end arms exactly one timer (fails on the unwired-timer mutant)", async () => {
	const h = fakeHost();
	await idleSeat(h);
	expect(h.ctx.armed()).toBe(1);
	// A second agent_end replaces, never stacks.
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(1);
});

test("planted (a): a paused goal gets none", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { env: SEAT.env, now: () => h.clock.at });
	h.emit("goal_updated", PAUSED_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
});

test("planted (b): a session without fleet identity gets none", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { env: {}, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
});

test("planted (c): unknown goal state (no goal_updated yet) gets none", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { env: SEAT.env, now: () => h.clock.at });
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
});

test("planted (d): a busy seat at fire time gets none; a new turn or user input cancels the timer", async () => {
	const h = fakeHost();
	await idleSeat(h);
	h.setIdle(false);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);

	const h2 = fakeHost();
	await idleSeat(h2);
	for (const event of ["agent_start", "turn_start", "input", "session_stop"]) {
		h2.emit("agent_end", { messages: QUIET_TURN } as never);
		expect(h2.ctx.armed()).toBe(1);
		h2.emit(event);
		expect(h2.ctx.armed()).toBe(0);
	}
	advance(h2, IDLE_WAKE_MS);
	expect(h2.sent).toHaveLength(0);
});

test("planted (e): willContinue agent_end (scheduled continuation) arms nothing", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { env: SEAT.env, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN, willContinue: true } as never);
	expect(h.ctx.armed()).toBe(0);
});

test("bounds: at most one wake per 10 min per seat", async () => {
	const h = fakeHost();
	await idleSeat(h);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	// The wake turn ends quietly; re-arm inside the throttle window stays silent.
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	// Past the window the seat wakes again.
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(2);
});

test("escalation: 3 consecutive no-tool-call wakes stop waking and record GOAL_IDLE_ESCALATE", async () => {
	const h = fakeHost();
	await idleSeat(h);
	for (let wake = 0; wake < MAX_QUIET_WAKES; wake++) {
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(wake + 1);
		h.clock.at += MIN_WAKE_INTERVAL_MS;
		h.emit("agent_end", { messages: QUIET_TURN } as never);
	}
	expect(h.entries).toHaveLength(1);
	expect(h.entries[0]!.customType).toBe(GOAL_IDLE_ESCALATE);
	expect(String(JSON.stringify(h.entries[0]!.data))).toContain("QuietBadger");
	// Escalated: further agent_end arms nothing, further time wakes nothing.
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(MAX_QUIET_WAKES);
});

test("escalation: a tool-calling wake turn resets the quiet count", async () => {
	const h = fakeHost();
	await idleSeat(h);
	advance(h, IDLE_WAKE_MS);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: TOOL_TURN } as never); // worked: reset
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(2);
	expect(h.entries).toHaveLength(0);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: QUIET_TURN } as never); // quiet 1, not 2
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(3);
	expect(h.entries).toHaveLength(0);
});

test("robust: an unwired timer (setTimeout throws) stays silent and never throws", async () => {
	const h = fakeHost();
	const broken = { ...h.ctx, setTimeout: () => { throw new Error("no timers"); } };
	await kitGoalKeepalive(h.api, { env: SEAT.env, now: () => h.clock.at });
	expect(() => {
		h.handlers["goal_updated"]?.(ACTIVE_GOAL, broken);
		h.handlers["agent_end"]?.({ messages: QUIET_TURN } as never, broken);
	}).not.toThrow();
	expect(h.sent).toHaveLength(0);
});

test("identity: BR_ACTOR wins over BR_AGENT_NAME wins over AGENT_NAME; blanks read null", () => {
	expect(seatIdentity({ BR_ACTOR: "A", BR_AGENT_NAME: "B", AGENT_NAME: "C" })).toBe("A");
	expect(seatIdentity({ BR_AGENT_NAME: "B", AGENT_NAME: "C" })).toBe("B");
	expect(seatIdentity({ AGENT_NAME: "C" })).toBe("C");
	expect(seatIdentity({})).toBeNull();
	expect(seatIdentity({ AGENT_NAME: "  " })).toBeNull();
});

test("turnMadeToolCall: assistant toolCall reads true; text-only, tool results alone, and missing read false", () => {
	expect(turnMadeToolCall(TOOL_TURN)).toBe(true);
	expect(turnMadeToolCall(QUIET_TURN)).toBe(false);
	expect(turnMadeToolCall([{ role: "toolResult", content: "ok" } as never])).toBe(false);
	expect(turnMadeToolCall(undefined)).toBe(false);
});

test("message: names the seat, the idle time, and every downtime step", () => {
	const body = downtimeMessage("RusticPine", 185_000);
	expect(body).toContain("RusticPine");
	expect(body).toContain("3m 5s");
	for (const item of ["(1)", "(2)", "(3)", "(4)", "(5)", "never waits"]) {
		expect(body).toContain(item);
	}
});
