import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../src/kitlib/tmp.ts";
import kitGoalKeepalive, {
	constraintGuidance,
	constraintLine,
	downtimeMessage,
	GOAL_IDLE_ESCALATE,
	GOAL_REPEAT_SUPPRESSED,
	IDLE_HEARTBEAT_MS,
	IDLE_WAKE_MS,
	MAX_QUIET_WAKES,
	MIN_WAKE_INTERVAL_MS,
	newestGateKind,
	matchingReleaseVerdicts,
	seatIdentity,
	sessionPaused,
	turnChangedState,
	type AsyncJobView,
	type GoalKeepaliveApi,
	type GoalKeepaliveContext,
	type GoalKeepaliveDeps,
	type KeepaliveEntry,
	type KeepaliveMessage,
} from "./kit-goal-keepalive.ts";

afterAll(cleanupAllOwnedTmp);

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

function fakeHost(opts: { env?: Record<string, string | undefined>; idle?: boolean; clock?: { at: number }; sessionEntries?: KeepaliveEntry[]; jobs?: { snapshot: AsyncJobView | null } } = {}): FakeSeat {
	const sent: Sent[] = [];
	const entries: { customType: string; data: unknown }[] = [];
	const sessionEntries = opts.sessionEntries ?? [];
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
		sessionManager: { getEntries: () => sessionEntries, getBranch: () => sessionEntries },
		getAsyncJobSnapshot: () => opts.jobs?.snapshot ?? null,
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

// KEEPALIVE2a fixture fleet: one session whose repo is FX_REPO, a declared constraint read an hour before the fake
// clock's start, and the clearing bead held by FixtureBuilder in that repo's tracker export.
const FX = ownedTmp("kit-goal-keepalive").path;
const FX_REPO = join(FX, "repo");
mkdirSync(join(FX_REPO, ".beads"), { recursive: true });
writeFileSync(join(FX_REPO, ".beads", "issues.jsonl"), [
	{ id: "fx-0", title: "other", assignee: "Nobody" },
	{ id: "fx-1", title: "clear the wall", assignee: "FixtureBuilder" },
	{ id: "fx-2", title: "unassigned" },
].map(row => JSON.stringify(row)).join("\n") + "\n");
const START = 1_000_000;
const CONSTRAINT = {
	name: "full-suite wall", value: 900, budget: 600, read_at: new Date(START - 3600_000).toISOString(),
	producer: { command: "omp-kit test --full --json", field: "wall_s" }, clearing_bead: "fx-1", set_by: "FixtureLead", decision: "J-fixture",
};
function fleetWatch(name: string, sessions: unknown[]): string {
	const path = join(FX, `${name}.json`);
	writeFileSync(path, JSON.stringify({ chief: { agent: "FixtureLead" }, sessions }));
	return path;
}
const FW = fleetWatch("fleet-watch", [{ session: "other", repo: FX }, { session: "fx", repo: FX_REPO, milestone: { epic: "e", pinned: ["fx-1"], constraint: CONSTRAINT } }]);
const FIXTURE_LINE = "CONSTRAINT full-suite wall 900/600 clearing=fx-1 holder=FixtureBuilder";
const NO_WORK_LINE = "If your next action does not move this line and you hold no pinned bead and no review you did not author, "
	+ "send one NO-WORK line to your director and end the turn; idle is correct off the constraint.";
const BANNED = ["never wait", "downtime", "reality-check", "as a bead", "profiling"];

const SEAT: GoalKeepaliveDeps = {
	env: { AGENT_NAME: "QuietBadger", OMP_KIT_FLEET_WATCH_CONFIG: FW, XDG_STATE_HOME: join(FX, "state") },
	cwd: FX_REPO,
	preflightBlocked: false,
};
const ACTIVE_GOAL = { goal: { status: "active" }, state: { enabled: true } } as never;
const PAUSED_GOAL = { goal: { status: "paused" }, state: { enabled: false } } as never;
// A turn that ran tool calls but changed no tracker or git state.
const TOOL_TURN = [
	{ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "bash", arguments: { command: "br list --status in_progress --json" } }] },
	{ role: "toolResult", toolCallId: "r1", toolName: "bash", content: [{ type: "text", text: "[]" }], isError: false },
] as KeepaliveMessage[];
// A turn that changed a br status.
const STATUS_TURN = [
	{ role: "assistant", content: [{ type: "toolCall", id: "s1", name: "bash", arguments: { command: "br update fx-1 --status in_review" } }] },
	{ role: "toolResult", toolCallId: "s1", toolName: "bash", content: [{ type: "text", text: "Updated" }], isError: false },
] as KeepaliveMessage[];
const QUIET_TURN = [{ role: "assistant", content: [{ type: "text", text: "holding" }] }] as KeepaliveMessage[];

async function idleSeat(h: FakeSeat, deps: GoalKeepaliveDeps = SEAT): Promise<void> {
	await kitGoalKeepalive(h.api, { ...deps, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
}

function advance(h: FakeSeat, ms: number): void {
	h.clock.at += ms;
	h.ctx.fireDue();
}

test("live KEEPALIVE2 [a][b][c]: an idle fleet goal seat gets one wake at 120 s that leads with the constraint line, then NO-WORK", async () => {
	const h = fakeHost();
	await idleSeat(h);
	expect(h.ctx.armed()).toBe(1);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.deliverAs).toBe("aside");
	expect(h.sent[0]!.customType).toBe("kit-goal-keepalive");
	const lines = h.sent[0]!.content.split("\n");
	expect(lines[0]).toBe(FIXTURE_LINE);
	expect(lines[1]).toBe(NO_WORK_LINE);
	// J-2026-10-29-18's phrases sit beside the NO-WORK line (planted negative: the never-wait wake text fails here).
	expect(lines[2]).toContain("never idles");
	expect(lines[2]).toContain("in_review");
	expect(lines[3]).toContain("comment on the nearest bead");
	expect(lines.at(-1)).toBe("[kit-goal-keepalive] QuietBadger: goal active, idle 2m.");
	for (const banned of BANNED) expect(h.sent[0]!.content.toLowerCase()).not.toContain(banned);
	// The kit carries no preflight blocked act in this fixture: the command is never printed.
	expect(h.sent[0]!.content).not.toContain("preflight blocked");
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
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
	h.emit("goal_updated", PAUSED_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
});

test("planted (b): a session without fleet identity gets none", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { ...SEAT, env: {}, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
});

test("planted (c): unknown goal state (no goal_updated yet) gets none", async () => {
	const h = fakeHost();
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
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
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
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

test("KEEPALIVE2 (e): three wakes whose turns ran tool calls but changed no tracker or git state escalate", async () => {
	const h = fakeHost();
	await idleSeat(h);
	for (let wake = 0; wake < MAX_QUIET_WAKES; wake++) {
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(wake + 1);
		h.clock.at += MIN_WAKE_INTERVAL_MS;
		h.emit("agent_end", { messages: TOOL_TURN } as never);
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

test("KEEPALIVE2 (e): a wake turn with a br status change resets the count; text-only turns still count", async () => {
	const h = fakeHost();
	await idleSeat(h);
	advance(h, IDLE_WAKE_MS);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: TOOL_TURN } as never); // quiet 1
	advance(h, IDLE_WAKE_MS);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: STATUS_TURN } as never); // a status change: reset to 0
	advance(h, IDLE_WAKE_MS);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: QUIET_TURN } as never); // quiet 1
	advance(h, IDLE_WAKE_MS);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: TOOL_TURN } as never); // quiet 2, not 3
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(5);
	expect(h.entries).toHaveLength(0);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.emit("agent_end", { messages: QUIET_TURN } as never); // quiet 3
	expect(h.entries.map(e => e.customType)).toEqual([GOAL_IDLE_ESCALATE]);
});

test("KEEPALIVE2 (e): turnChangedState reads commits, status changes, verdict comments and gate runs; reads and failures are no change", () => {
	const turn = (command: string, isError = false) => [
		{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: { command } }] },
		{ role: "toolResult", toolCallId: "c", toolName: "bash", content: [], isError },
	] as KeepaliveMessage[];
	for (const command of [
		"git commit --only -m 'x [test]' -- a.ts", "cd r && git -C /r commit -F msg", "br close fx-1 --reason done",
		"br update fx-1 --claim", "br update fx-1 --status in_review", "br update fx-1 --status open --assignee ''",
		"br comments add fx-1 \"ACCEPTED box 1 replayed\"", "br comments add fx-1 'REWORK: box 2 fails'",
		"omp-kit preflight commit --message m.txt", "omp-kit verify fx-1",
	]) expect([command, turnChangedState(turn(command))]).toEqual([command, true]);
	for (const command of [
		"br list --status in_progress --json", "git status", "git log -1", "br comments add fx-1 'PROGRESS: reading'",
		"echo git commit", "br show fx-1", "br create --title x",
	]) expect([command, turnChangedState(turn(command))]).toEqual([command, false]);
	expect(turnChangedState(turn("git commit -m x", true))).toBe(false);
	expect(turnChangedState(STATUS_TURN.slice(0, 1))).toBe(false); // no result: not shown to succeed
	expect(turnChangedState(QUIET_TURN)).toBe(false);
	expect(turnChangedState(undefined)).toBe(false);
	// Linear on a long near-miss.
	const nearMiss = `br comments add fx-1 ${"A".repeat(40_000)}`;
	const t0 = performance.now();
	expect(turnChangedState(turn(nearMiss))).toBe(false);
	expect(performance.now() - t0).toBeLessThan(500); // wallclock: p99=<1ms measured headroom=500x
});

test("KEEPALIVE2 (d): a seat whose last continuation was repeat-suppressed gets no wake and one GOAL_REPEAT_SUPPRESSED entry", async () => {
	const h = fakeHost();
	await idleSeat(h);
	const continuation = [{ role: "custom", customType: "goal-continuation", content: "continue" }, ...TOOL_TURN] as KeepaliveMessage[];
	h.emit("agent_end", { messages: continuation } as never); // first continuation: compared with nothing
	expect(h.ctx.armed()).toBe(1);
	h.emit("agent_end", { messages: continuation } as never); // same activity: omp suppresses the next continuation
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
	expect(h.entries.map(e => e.customType)).toEqual([GOAL_REPEAT_SUPPRESSED]);
	expect(JSON.stringify(h.entries[0]!.data)).toContain("QuietBadger");
	h.emit("agent_end", { messages: continuation } as never); // the streak goes on: still one entry
	expect(h.entries).toHaveLength(1);
});

test("KEEPALIVE2 (d) controls: a changed continuation, an empty one, or a repeat across a non-continuation turn still wakes", async () => {
	const cont = (turn: KeepaliveMessage[]) => [{ role: "custom", customType: "goal-continuation", content: "continue" }, ...turn] as KeepaliveMessage[];
	for (const pair of [[TOOL_TURN, STATUS_TURN], [QUIET_TURN, QUIET_TURN]]) {
		const h = fakeHost();
		await idleSeat(h);
		h.emit("agent_end", { messages: cont(pair[0]!) } as never);
		h.emit("agent_end", { messages: cont(pair[1]!) } as never);
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(1);
		expect(h.entries).toHaveLength(0);
	}
	const h = fakeHost();
	await idleSeat(h);
	h.emit("agent_end", { messages: cont(TOOL_TURN) } as never);
	h.emit("agent_end", { messages: TOOL_TURN } as never); // a user or wake turn resets omp's comparison
	h.emit("agent_end", { messages: cont(TOOL_TURN) } as never);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
});

test("KEEPALIVE2 [b]: a held bead whose newest gate row is a refusal names omp-kit preflight blocked only when the kit has the act", async () => {
	const state = join(FX, "blocked-state");
	mkdirSync(join(state, "omp-kit"), { recursive: true });
	const row = (target: string, kind: string) => JSON.stringify({ ts: "2026-11-04T00:00:00Z", seat: "QuietBadger", act: "commit", target, gate: "g", kind });
	writeFileSync(join(state, "omp-kit", "gate-events.jsonl"), [row("fx-1", "pass"), row("fx-2", "pass"), row("fx-1", "refuse"), row("fx-2", "refuse"), row("fx-2", "pass")].join("\n") + "\n");
	const deps = (preflightBlocked: boolean): GoalKeepaliveDeps => ({
		...SEAT, env: { ...SEAT.env, XDG_STATE_HOME: state }, preflightBlocked, heldBeads: () => ["fx-2", "fx-1"],
	});
	const withAct = fakeHost();
	await idleSeat(withAct, deps(true));
	advance(withAct, IDLE_WAKE_MS);
	const lines = withAct.sent[0]!.content.split("\n");
	expect(lines[0]).toBe(FIXTURE_LINE);
	expect(lines).toContain("If the bead you hold is blocked, run omp-kit preflight blocked fx-1 and do its rungs; a comment is not a fix.");
	expect(withAct.sent[0]!.content).not.toContain("blocked fx-2"); // fx-2's newest row passed
	// Planted negative: the act is absent from the fixture kit, so the command is never printed.
	const withoutAct = fakeHost();
	await idleSeat(withoutAct, deps(false));
	advance(withoutAct, IDLE_WAKE_MS);
	expect(withoutAct.sent[0]!.content).not.toContain("preflight blocked");
	expect(newestGateKind(join(state, "omp-kit", "gate-events.jsonl"), "fx-1")).toBe("refuse");
	expect(newestGateKind(join(state, "omp-kit", "gate-events.jsonl"), "fx-9")).toBeNull();
	expect(newestGateKind(join(state, "absent.jsonl"), "fx-1")).toBeNull();
});

test("KEEPALIVEPAUSE1: a seat in a paused session (pullEnabled false) gets no wake; the same seat unpaused does", async () => {
	expect(sessionPaused({ fleetWatch: fleetWatch("paused-q", [{ repo: FX_REPO, pullEnabled: false }]), cwd: join(FX_REPO, "src") })).toBe(true);
	expect(sessionPaused({ fleetWatch: fleetWatch("live-q", [{ repo: FX_REPO, pullEnabled: true }]), cwd: FX_REPO })).toBe(false);
	expect(sessionPaused({ fleetWatch: join(FX, "absent.json"), cwd: FX_REPO })).toBe(false); // unreadable keeps the wake
	const paused = fakeHost();
	await idleSeat(paused, { ...SEAT, env: { ...SEAT.env, OMP_KIT_FLEET_WATCH_CONFIG: fleetWatch("paused", [{ repo: FX_REPO, pullEnabled: false }]) } });
	advance(paused, IDLE_WAKE_MS);
	expect(paused.sent.length).toBe(0);
	// Planted negative: the same seat in a session that may pull is woken.
	const live = fakeHost();
	await idleSeat(live, { ...SEAT, env: { ...SEAT.env, OMP_KIT_FLEET_WATCH_CONFIG: fleetWatch("live", [{ repo: FX_REPO, pullEnabled: true }]) } });
	advance(live, IDLE_WAKE_MS);
	expect(live.sent.length).toBe(1);
});

test("KEEPALIVE2 [b]: the constraint line is the declared record with its holder, or none naming the lead, never invented", () => {
	const at = (fleet: string, cwd = FX_REPO, now = START) => constraintLine({ fleetWatch: fleet, cwd, now });
	expect(at(FW)).toBe(FIXTURE_LINE);
	expect(at(FW, join(FX_REPO, "src"))).toBe(FIXTURE_LINE); // a subdirectory of the session repo
	expect(at(FW, FX)).toBe("CONSTRAINT none declarer=FixtureLead"); // the outer session declares none
	const unassigned = fleetWatch("unassigned", [{ repo: FX_REPO, milestone: { constraint: { ...CONSTRAINT, clearing_bead: "fx-2" } } }]);
	expect(at(unassigned)).toBe("CONSTRAINT full-suite wall 900/600 clearing=fx-2 holder=none");
	const missing = fleetWatch("missing", [{ repo: FX_REPO, milestone: { constraint: { ...CONSTRAINT, clearing_bead: "fx-404" } } }]);
	expect(at(missing)).toBe("CONSTRAINT full-suite wall 900/600 clearing=fx-404 holder=unknown");
	expect(at(FW, FX_REPO, START + 25 * 3600_000)).toBe("CONSTRAINT INVALID constraint producer reading older than 24 h declarer=FixtureLead");
	const noProducer = fleetWatch("noproducer", [{ repo: FX_REPO, milestone: { constraint: { ...CONSTRAINT, producer: undefined } } }]);
	expect(at(noProducer)).toBe("CONSTRAINT INVALID constraint producer command and field missing declarer=FixtureLead");
	expect(at(join(FX, "absent.json"))).toStartWith("CONSTRAINT UNKNOWN (fleet-watch unreadable: ");
	// none and INVALID name the lead as the declarer; the guidance still leads with the line and offers NO-WORK.
	const none = constraintGuidance("CONSTRAINT none declarer=FixtureLead").split("\n");
	expect(none[0]).toBe("CONSTRAINT none declarer=FixtureLead");
	expect(none[1]).toBe("No valid constraint is declared for this project; the lead (FixtureLead) declares it, and no seat invents one.");
	expect(none[2]).toBe(NO_WORK_LINE);
});

test("robust: an unwired timer (setTimeout throws) stays silent and never throws", async () => {
	const h = fakeHost();
	const broken = { ...h.ctx, setTimeout: () => { throw new Error("no timers"); } };
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
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

test("KEEPALIVE2 [b] message: the wake leads with the constraint, carries J-2026-10-29-18's phrases beside NO-WORK, then names the seat and idle time", () => {
	const lines = downtimeMessage("RusticPine", 185_000, FIXTURE_LINE).split("\n");
	expect(lines[0]).toBe(FIXTURE_LINE);
	expect(lines[1]).toBe(NO_WORK_LINE);
	expect(lines[2]).toContain("never idles");
	expect(lines[3]).toContain("comment on the nearest bead");
	expect(lines.at(-1)).toBe("[kit-goal-keepalive] RusticPine: goal active, idle 3m 5s.");
	for (const banned of BANNED) expect(lines.join("\n").toLowerCase()).not.toContain(banned);
});
test("resume: session_start with a persisted active goal arms the wake with no goal_updated ever", async () => {
	const h = fakeHost({ sessionEntries: [{ type: "mode_change", mode: "goal", data: { goal: { status: "active" } } }] });
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
	h.emit("session_start");
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(1);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	expect(h.sent[0]!.deliverAs).toBe("aside");
	expect(h.sent[0]!.content).toContain("QuietBadger");
	expect(h.sent[0]!.content).toContain("held bead");
});
test("resume planted: paused, exited, empty, or malformed transcript wakes nothing", async () => {
	const cases: KeepaliveEntry[][] = [
		[{ type: "mode_change", mode: "goal_paused", data: { goal: { status: "paused" } } }],
		[{ type: "mode_change", mode: "none" }],
		[],
		[{ type: "mode_change", mode: "goal" }],
		[{ type: "user", mode: "goal" } as never],
	];
	for (const sessionEntries of cases) {
		const h = fakeHost({ sessionEntries });
		await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
		h.emit("session_start");
		h.emit("agent_end", { messages: QUIET_TURN } as never);
		expect(h.ctx.armed()).toBe(0);
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(0);
	}
});
test("resume: the latest mode_change wins; goal_updated stays authoritative afterwards", async () => {
	const latestPaused = fakeHost({
		sessionEntries: [
			{ type: "mode_change", mode: "goal", data: { goal: { status: "active" } } },
			{ type: "mode_change", mode: "goal_paused", data: { goal: { status: "paused" } } },
		],
	});
	await kitGoalKeepalive(latestPaused.api, { ...SEAT, now: () => latestPaused.clock.at });
	latestPaused.emit("session_start");
	latestPaused.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(latestPaused.ctx.armed()).toBe(0);
	const staleThenLive = fakeHost({
		sessionEntries: [{ type: "mode_change", mode: "goal_paused", data: { goal: { status: "paused" } } }],
	});
	await kitGoalKeepalive(staleThenLive.api, { ...SEAT, now: () => staleThenLive.clock.at });
	staleThenLive.emit("session_start");
	staleThenLive.emit("goal_updated", ACTIVE_GOAL);
	staleThenLive.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(staleThenLive.ctx.armed()).toBe(1);
	const freshThenPaused = fakeHost({
		sessionEntries: [{ type: "mode_change", mode: "goal", data: { goal: { status: "active" } } }],
	});
	await kitGoalKeepalive(freshThenPaused.api, { ...SEAT, now: () => freshThenPaused.clock.at });
	freshThenPaused.emit("session_start");
	freshThenPaused.emit("goal_updated", PAUSED_GOAL);
	freshThenPaused.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(freshThenPaused.ctx.armed()).toBe(0);
});
test("resume: session_switch drops stale goal state and re-learns from the new transcript", async () => {
	const h = fakeHost({ sessionEntries: [{ type: "mode_change", mode: "none" }] });
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("session_switch", { reason: "resume" } as never);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(0);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(0);
});
test("resume robust: an unreadable transcript stays silent and never throws", async () => {
	const h = fakeHost();
	const broken = { ...h.ctx, sessionManager: { getEntries: () => { throw new Error("no transcript"); } } };
	await kitGoalKeepalive(h.api, { ...SEAT, now: () => h.clock.at });
	expect(() => {
		h.handlers["session_start"]?.(undefined as never, broken);
		h.handlers["agent_end"]?.({ messages: QUIET_TURN } as never, broken);
	}).not.toThrow();
	expect(h.sent).toHaveLength(0);
});

test("rearm planted: wake at T, quiet turn ends at T+3 min -> exactly one more wake at T+10 min (fails on the no-rearm mutant)", async () => {
	const h = fakeHost();
	await idleSeat(h);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	const t0 = h.clock.at; // lastWakeAt: the first wake
	// Capture the delay each timer is armed with: the fake fires on demand,
	// so the scheduled delay is the not-before evidence.
	const delays: number[] = [];
	const innerSetTimeout = h.ctx.setTimeout;
	h.ctx.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number) => {
		delays.push(ms ?? 0);
		return innerSetTimeout(cb, ms);
	}) as GoalKeepaliveContext["setTimeout"];
	// The seat's next turn ends quietly 3 min after the wake; its 120 s
	// timer fires 5 min after the wake, inside the 10-min window.
	h.clock.at += 3 * 60_000;
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	expect(h.ctx.armed()).toBe(1);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1); // throttled: no early second wake
	expect(h.ctx.armed()).toBe(1); // re-armed, not dropped (mutant: 0)
	expect(delays.at(-1)).toBe(t0 + MIN_WAKE_INTERVAL_MS - h.clock.at);
	// No new turn ever comes; the re-armed timer lands on the interval edge.
	h.clock.at = t0 + MIN_WAKE_INTERVAL_MS;
	h.ctx.fireDue();
	expect(h.sent).toHaveLength(2);
	expect(h.sent[1]!.deliverAs).toBe("aside");
});

test("rearm control: a seat that starts a turn before T+10 min gets no wake", async () => {
	const h = fakeHost();
	await idleSeat(h);
	advance(h, IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(1);
	h.clock.at += 3 * 60_000;
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	advance(h, IDLE_WAKE_MS); // throttled fire re-arms for the remainder
	expect(h.sent).toHaveLength(1);
	expect(h.ctx.armed()).toBe(1);
	h.clock.at += 2 * 60_000; // a new turn starts before the edge: cancel
	h.emit("agent_start");
	expect(h.ctx.armed()).toBe(0);
	h.clock.at += MIN_WAKE_INTERVAL_MS;
	h.ctx.fireDue();
	expect(h.sent).toHaveLength(1);
});

// GOALBREATHE1 fixtures. A todo result as omp persists it (pi-coding-agent tools/todo.ts canonicalTodoPhases reads it).
type FxTask = { content: string; status: string; blocker?: string };
const todoEntry = (...tasks: FxTask[]): KeepaliveEntry =>
	({ type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: { op: "block", phases: [{ name: "wave", tasks }] } } });
const SHIPPED: FxTask = { content: "land the companion change", status: "completed" };
const VERDICT: FxTask = { content: "close .286 on the release verdict", status: "blocked" };
const LIVE_JOB: AsyncJobView = { running: [{ id: "bg_7", type: "task", status: "running" }], delivery: { queued: 0, delivering: false } };
const NO_JOB: AsyncJobView = { running: [], delivery: { queued: 0, delivering: false } };
// The turn a finished job's owner-routed delivery starts (session/async-job-delivery.ts ASYNC_RESULT_MESSAGE_TYPE).
const ASYNC_RESULT_TURN = [{ role: "custom", customType: "async-result", content: "bg_7 completed" }, ...QUIET_TURN] as KeepaliveMessage[];
const HEARTBEAT = (on: string) => "[kit-goal-keepalive] QuietBadger: idle-state heartbeat (at most one per 30m): all 1 open todo item(s) "
	+ `are blocked, waiting on ${on}. If that event already arrived, act on it; otherwise end the turn.`;

/** Fake time that honours each timer's delay: run(ms) fires every timer due within ms, in due order, at its due time. */
function fakeTime(h: FakeSeat): (ms: number) => void {
	type Due = { at: number; cb: (...args: unknown[]) => void };
	const due = new Map<symbol, Due>();
	h.ctx.setTimeout = ((cb: (...args: unknown[]) => void, ms?: number) => {
		const handle = Symbol("timer");
		due.set(handle, { at: h.clock.at + (ms ?? 0), cb });
		return handle;
	}) as GoalKeepaliveContext["setTimeout"];
	h.ctx.clearTimer = timer => { due.delete(timer as symbol); };
	h.ctx.armed = () => due.size;
	return ms => {
		const end = h.clock.at + ms;
		for (;;) {
			let next: [symbol, Due] | undefined;
			for (const entry of due) if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry;
			if (next === undefined) break;
			due.delete(next[0]);
			h.clock.at = next[1].at;
			next[1].cb();
		}
		h.clock.at = end;
	};
}

/** The planted seat (every open todo blocked, job bg_7 live) for 12 min: wake at 2 min if any, a quiet turn, 10 more
 * min. Returns the wakes sent. */
async function quietPlantedWakes(extension: typeof kitGoalKeepalive): Promise<number> {
	const h = fakeHost({ sessionEntries: [todoEntry(SHIPPED, VERDICT)], jobs: { snapshot: LIVE_JOB } });
	const run = fakeTime(h);
	await extension(h.api, { ...SEAT, now: () => h.clock.at });
	h.emit("goal_updated", ACTIVE_GOAL);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	run(IDLE_WAKE_MS);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	run(MIN_WAKE_INTERVAL_MS);
	return h.sent.length;
}

test("GOALBREATHE1 planted: an all-blocked seat with a live job gets no wake until the job completes; the 30-min ceiling heartbeat fires", async () => {
	const jobs: { snapshot: AsyncJobView | null } = { snapshot: LIVE_JOB };
	const h = fakeHost({ sessionEntries: [todoEntry(SHIPPED, VERDICT)], jobs });
	const run = fakeTime(h);
	await idleSeat(h);
	run(IDLE_HEARTBEAT_MS - 1);
	expect(h.sent).toHaveLength(0); // 30 min of fake time less 1 ms: no wake
	expect(h.ctx.armed()).toBe(1); // asleep to the ceiling, never disarmed
	run(1);
	expect(h.sent).toHaveLength(1); // the ceiling heartbeat
	const heartbeat = h.sent[0]!.content.split("\n");
	expect(heartbeat[0]).toBe(FIXTURE_LINE);
	expect(heartbeat.at(-2)).toBe("[kit-goal-keepalive] QuietBadger: goal active, idle 30m.");
	expect(heartbeat.at(-1)).toBe(HEARTBEAT("job bg_7"));
	// The heartbeat turn ends quietly a minute later; the job still runs, so the next 10 min stay silent.
	run(60_000);
	h.emit("agent_end", { messages: QUIET_TURN } as never);
	run(MIN_WAKE_INTERVAL_MS);
	expect(h.sent).toHaveLength(1);
	expect(h.ctx.armed()).toBe(1);
	// The job completes: its async-result delivery starts a turn, and that turn's end lifts the idle state.
	jobs.snapshot = NO_JOB;
	h.emit("agent_start");
	h.emit("agent_end", { messages: ASYNC_RESULT_TURN } as never);
	run(IDLE_WAKE_MS);
	expect(h.sent).toHaveLength(2);
	expect(h.sent[1]!.content).not.toContain("idle-state heartbeat");
	expect(h.sent[1]!.content.split("\n").at(-1)).toBe("[kit-goal-keepalive] QuietBadger: goal active, idle 2m.");
});

test("GOALBREATHE1 planted: a named blocker with no job, or a job result queued for delivery, also sleeps to the ceiling", async () => {
	const cases: [KeepaliveEntry, AsyncJobView, string][] = [
		[todoEntry(SHIPPED, { ...VERDICT, blocker: "release verdict for .286" }), NO_JOB, "release verdict for .286"],
		[todoEntry(SHIPPED, VERDICT), { running: [], delivery: { queued: 1, delivering: false } }, "job result queued for delivery"],
	];
	for (const [todos, snapshot, on] of cases) {
		const h = fakeHost({ sessionEntries: [todos], jobs: { snapshot } });
		const run = fakeTime(h);
		await idleSeat(h);
		run(IDLE_HEARTBEAT_MS - 1);
		expect([on, h.sent.length]).toEqual([on, 0]);
		run(1);
		expect([on, h.sent.map(s => s.content.split("\n").at(-1))]).toEqual([on, [HEARTBEAT(on)]]);
	}
});

test("GOALBREATHE1 control: an actionable item, unknown status, no todos, or nothing to wait on keeps the ordinary wakes", async () => {
	const work: FxTask = { content: "write the test", status: "pending" };
	const cases: [string, KeepaliveEntry[], AsyncJobView][] = [
		["in_progress beside blocked", [todoEntry(VERDICT, { ...work, status: "in_progress" })], LIVE_JOB],
		["pending beside blocked", [todoEntry(VERDICT, work)], LIVE_JOB],
		["a later user todo edit adds work", [todoEntry(SHIPPED, VERDICT), { type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "wave", tasks: [VERDICT, work] }] } }], LIVE_JOB],
		["unknown status beside blocked", [todoEntry(VERDICT, { ...work, status: "someday" })], LIVE_JOB],
		["no todos", [], LIVE_JOB],
		["all blocked, nothing named, no job", [todoEntry(SHIPPED, VERDICT)], NO_JOB],
	];
	for (const [name, sessionEntries, snapshot] of cases) {
		const h = fakeHost({ sessionEntries, jobs: { snapshot } });
		const run = fakeTime(h);
		await idleSeat(h);
		run(IDLE_WAKE_MS);
		expect([name, h.sent.length]).toEqual([name, 1]);
		h.emit("agent_end", { messages: QUIET_TURN } as never);
		run(MIN_WAKE_INTERVAL_MS);
		expect([name, h.sent.length]).toEqual([name, 2]); // continuations keep firing
		expect(h.sent.every(s => !s.content.includes("idle-state heartbeat"))).toBe(true);
	}
});

test("GOALBREATHE1 mutant: without the idle state the planted seat keeps getting wakes", async () => {
	const source = readFileSync(join(import.meta.dir, "kit-goal-keepalive.ts"), "utf8");
	const mutated = source.replace("const wait = idleState(ctx);", "const wait = null;");
	expect(mutated).not.toBe(source);
	const dir = join(FX, "goalbreathe1-mutant");
	mkdirSync(dir, { recursive: true });
	const parent = join(import.meta.dir, "..");
	writeFileSync(join(dir, "kit-goal-keepalive.ts"), mutated.replaceAll('from "./', `from "${import.meta.dir}/`)
		.replaceAll('from "../', `from "${parent}/`).replaceAll('import("../', `import("${parent}/`));
	// Dynamic: the mutant module is generated at test time, so no static specifier exists.
	const mutant = await import(join(dir, "kit-goal-keepalive.ts")) as { default: typeof kitGoalKeepalive };
	expect(await quietPlantedWakes(kitGoalKeepalive)).toBe(0);
	expect(await quietPlantedWakes(mutant.default)).toBe(2);
});

const VERDICT_SHA = "cc4b06b369012345678901234567890123456789";
const OTHER_VERDICT_SHA = "2849919677012345678901234567890123456789";

function verdictFixture(label: string): { repo: string; log: string } {
	const repo = join(FX, label);
	mkdirSync(join(repo, ".git", "omp-kit"), { recursive: true });
	return { repo, log: join(repo, ".git", "omp-kit", "release-verdict.log") };
}

function verdictTodos(sha: string): KeepaliveEntry[] {
	return [{ type: "custom", customType: "user_todo_edit", data: {
		phases: [{ tasks: [{ status: "blocked", blocker: `release verdict for ${sha}` }] }],
	} }];
}

test.each([VERDICT_SHA, VERDICT_SHA.slice(0, 10)])("VERDICTWAKE1 timer fallback: blocked seat naming %s receives recorded rc values at its existing check", async named => {
	const { repo, log } = verdictFixture(`verdict-${named}`);
	const h = fakeHost({ sessionEntries: verdictTodos(named) });
	await idleSeat(h, { ...SEAT, cwd: repo });
	try {
		writeFileSync(log, `release-verdict: ${VERDICT_SHA} producer_rc=0\nrelease-verdict: ${VERDICT_SHA} ci_only_rc=7\n`);
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.content).toContain(`release-verdict: ${VERDICT_SHA} producer_rc=0 ci_only_rc=7`);
		expect(h.sent[0]!.deliverAs).toBe("aside");
		expect(h.sent[0]!.content).not.toContain("idle-state heartbeat");
		h.emit("agent_end", { messages: STATUS_TURN } as never);
		advance(h, MIN_WAKE_INTERVAL_MS);
		expect(h.sent).toHaveLength(1);
	} finally { h.emit("session_stop"); }
});

test("VERDICTWAKE1 planted: another head and a short prefix do not wake a blocked seat", async () => {
	const { repo, log } = verdictFixture("verdict-negative");
	for (const named of [VERDICT_SHA, OTHER_VERDICT_SHA.slice(0, 9)]) {
		const h = fakeHost({ sessionEntries: verdictTodos(named) });
		await idleSeat(h, { ...SEAT, cwd: repo });
		try {
			writeFileSync(log, `release-verdict: ${OTHER_VERDICT_SHA} producer_rc=0\nrelease-verdict: ${OTHER_VERDICT_SHA} ci_only_rc=0\n`);
			advance(h, IDLE_WAKE_MS);
			expect(h.sent).toHaveLength(0);
			expect(h.ctx.armed()).toBe(1);
		} finally { h.emit("session_stop"); }
	}
});

test("VERDICTWAKE1: durable results survive missing watcher events; partial lines wait for completion", async () => {
	const { repo, log } = verdictFixture("verdict-durable");
	const h = fakeHost({ sessionEntries: verdictTodos(VERDICT_SHA.slice(0, 12)) });
	writeFileSync(log, `release-verdict: ${VERDICT_SHA} ci_only_rc=2`);
	await idleSeat(h, { ...SEAT, cwd: repo });
	try {
		advance(h, IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(0);
		appendFileSync(log, "\n");
		advance(h, IDLE_HEARTBEAT_MS - IDLE_WAKE_MS);
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]!.content).toContain(`release-verdict: ${VERDICT_SHA} ci_only_rc=2`);
	} finally { h.emit("session_stop"); }
});

test("VERDICTWAKE1: bounded long near-miss rejects malformed verdict rows", () => {
	const { log } = verdictFixture("verdict-malformed");
	writeFileSync(log, `release-verdict: ${VERDICT_SHA} producer_rc=${"0".repeat(100_000)}x\n`);
	const start = performance.now();
	expect(matchingReleaseVerdicts(log, [`release verdict for ${VERDICT_SHA}`])).toEqual([]);
	console.log(`VERDICTWAKE1 long near-miss: ${(performance.now() - start).toFixed(2)} ms`);
});
