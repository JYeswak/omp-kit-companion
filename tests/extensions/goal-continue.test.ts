import { expect, test } from "bun:test";
import kitGoalKeepalive, { GOAL_CONTINUE, type GoalKeepaliveContext } from "../../extensions/kit-goal-keepalive.ts";

// GOALPARK1: an active-goal seat whose turn ended with zero tool calls gets exactly one
// continuation at agent_end; a paused goal and a turn with pending user input get none.
type Sent = { message: { customType: string; content: string; display: boolean }; options?: { deliverAs?: string } };
/** Drives one seat through events in order. Timers are captured, never fired: only the
 * synchronous agent_end continuation is under test here, not the 30-minute heartbeat. */
async function drive(events: [string, unknown][], opts: { env?: Record<string, string> } = {}) {
	const handlers = new Map<string, ((event: never, ctx: GoalKeepaliveContext) => unknown)[]>();
	const sent: Sent[] = [];
	const ctx: GoalKeepaliveContext = {
		isIdle: () => true,
		setTimeout(fn, ms) { return { fn, ms }; },
		clearTimer() {},
		sessionManager: { getBranch: () => [] },
	};
	await kitGoalKeepalive(
		{ on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			sendMessage(message, options) { sent.push({ message, options }); } },
		{ env: opts.env ?? { AGENT_NAME: "ParkSeat" } },
	);
	for (const [name, event] of events) for (const handler of handlers.get(name) ?? []) await handler(event as never, ctx);
	return sent.filter((s) => s.message.customType === GOAL_CONTINUE);
}

const ACTIVE: [string, unknown] = ["goal_updated", { goal: { id: "goal-1", status: "active" }, state: { enabled: true } }];
const PAUSED: [string, unknown] = ["goal_updated", { goal: { id: "goal-1", status: "active" }, state: { enabled: false } }];
const idleMessages = [{ role: "assistant", content: [{ type: "text", text: "nothing arrived; ending turn" }] }];
const IDLE_END: [string, unknown] = ["agent_end", { messages: idleMessages }];
const TOOL_END: [string, unknown] = ["agent_end", { messages: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash" }] }] }];
const USER_END: [string, unknown] = ["agent_end", { messages: [...idleMessages, { role: "user", content: "hold on, do this first" }] }];

test("GOALPARK1: active goal plus a turn with zero tool calls requests exactly one continuation", async () => {
	const continuations = await drive([ACTIVE, IDLE_END]);
	expect(continuations).toHaveLength(1);
	expect(continuations[0]!.options?.deliverAs).toBe("nextTurn");
	expect(continuations[0]!.message.display).toBe(true);
	expect(continuations[0]!.message.content).toContain("ParkSeat");
});

test("GOALPARK1 planted: a paused goal gets no continuation", async () => {
	expect(await drive([PAUSED, IDLE_END])).toEqual([]);
});

test("GOALPARK1 planted: a turn with pending user input gets none", async () => {
	expect(await drive([ACTIVE, ["input", {}], IDLE_END])).toEqual([]);
	expect(await drive([ACTIVE, USER_END])).toEqual([]);
});

test("GOALPARK1 exactly-once: a second consecutive no-tool turn gets none", async () => {
	expect(await drive([ACTIVE, IDLE_END, IDLE_END])).toHaveLength(1);
});

test("GOALPARK1 controls: a scheduled turn and a tool-call turn suppress, work re-arms", async () => {
	expect(await drive([ACTIVE, ["agent_end", { willContinue: true, messages: idleMessages }]])).toEqual([]);
	expect(await drive([ACTIVE, TOOL_END])).toEqual([]);
	// A turn that did work clears the latch: the next idle turn may continue once.
	expect(await drive([ACTIVE, TOOL_END, IDLE_END])).toHaveLength(1);
});
