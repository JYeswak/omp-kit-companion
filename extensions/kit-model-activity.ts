import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendActivityEvent } from "../src/model-activity-journal.ts";
import {
	activityText, isActivityModel,
	type ActivityClockSample, type ActivityEvent, type ActivityIdentity, type ActivityModel,
} from "../src/model-activity-schema.ts";

export interface ActivityContext {
	cwd: string;
	sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
export interface ActivityApi {
	on(event: string, handler: (event: unknown, ctx: ActivityContext) => void | Promise<void>): void;
}
export interface ActivityDeps {
	stateRoot?: string;
	env?: Readonly<Record<string, string | undefined>>;
	now?: () => number;
	monotonicNs?: () => bigint;
	incarnation?: string;
}
interface Source { session: string; file: string; fileId: string; }
interface Pending {
	identity: ActivityIdentity;
	nativeTimestamp: number | null;
	models: ActivityModel[];
	invalid: string | null;
}
interface Loss { event: ActivityEvent; count: number; reason: string; }
const MAX_PENDING_WRITES = 64;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function primaryModel(message: unknown): ActivityModel | null {
	if (!object(message) || message.role !== "assistant") return null;
	const model = { provider: message.provider, model: message.model };
	return isActivityModel(model) ? model : null;
}
function captureSource(ctx: ActivityContext): Source | null {
	try {
		const session = ctx.sessionManager.getSessionId(), raw = ctx.sessionManager.getSessionFile();
		if (!activityText(session) || !activityText(raw, 4096)) return null;
		const file = realpathSync(raw), info = lstatSync(file, { bigint: true });
		if (!info.isFile() || !activityText(file, 4096)) return null;
		return { session, file, fileId: `${info.dev}:${info.ino}` };
	} catch { return null; }
}

/** One local observer incarnation; no timer, provider request or goal mutation.
 * Native getters are synchronous (OMP18.20.2 session-manager.ts:3257-3263).
 * Capture state/clocks before returning a write promise: native event observers
 * can overlap while another extension notification is awaiting completion. */
export default async function kitModelActivity(pi: ActivityApi, deps: ActivityDeps = {}): Promise<void> {
	const env = deps.env ?? process.env;
	const stateRoot = deps.stateRoot ?? join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "omp-kit");
	const now = deps.now ?? Date.now, monotonicNs = deps.monotonicNs ?? (() => process.hrtime.bigint());
	const incarnation = deps.incarnation ?? randomUUID();
	let source: Source | null = null, runId: string | null = null, runObserved = false;
	let pending: Pending | null = null, lastIdentity: ActivityIdentity | null = null;
	let lastSettled = -1, lastNativeStart: number | null = null, sequence = 0;
	let tail = Promise.resolve(), queued = 0, loss: Loss | null = null;

	function sample(): ActivityClockSample {
		let epoch: number | null = null, mono: string | null = null;
		try {
			const value = now();
			if (Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)) epoch = value;
		} catch { /* The endpoint remains explicitly invalid. */ }
		try {
			const value = monotonicNs();
			if (typeof value === "bigint" && value >= 0n) {
				const text = value.toString();
				if (text.length <= 32) mono = text;
			}
		} catch { /* The endpoint remains explicitly invalid. */ }
		return { epoch_ms: epoch, mono_ns: mono };
	}
	function rememberLoss(event: ActivityEvent, reason: string, count = 1): void {
		loss = { event, reason, count: (loss?.count ?? 0) + count };
	}
	function persist(event: ActivityEvent): Promise<void> {
		if (queued >= MAX_PENDING_WRITES) { rememberLoss(event, "RECORDER_QUEUE_LIMIT"); return tail; }
		queued++;
		const writing = tail.then(async () => {
			try {
				const result = await appendActivityEvent(stateRoot, event, event.clock.epoch_ms ?? Date.now());
				if (!result.appended) rememberLoss(event, result.problem ?? "ACTIVITY_APPEND_INCOMPLETE");
			} catch { rememberLoss(event, "ACTIVITY_APPEND_INCOMPLETE"); }
			if (queued === 1 && loss !== null) {
				const dropped = loss;
				loss = null;
				const marker: ActivityEvent = { schema: 1, kind: "loss", id: `loss:${randomUUID()}`,
					sequence: ++sequence, identity: dropped.event.identity, clock: dropped.event.clock,
					reason: dropped.reason, lost_events: dropped.count };
				try {
					const saved = await appendActivityEvent(stateRoot, marker, marker.clock.epoch_ms ?? Date.now());
					if (!saved.appended) rememberLoss(dropped.event, dropped.reason, dropped.count);
				} catch { rememberLoss(dropped.event, dropped.reason, dropped.count); }
			}
		}).finally(() => { queued--; });
		// Every rejection is consumed; an evidence failure never rejects the native
		// agent operation. A failed loss marker is attempted only on a later drain.
		tail = writing.catch(() => { rememberLoss(event, "ACTIVITY_APPEND_INCOMPLETE"); });
		return tail;
	}
	function invalidate(reason: string, clock: ActivityClockSample): void {
		const previous = pending;
		pending = null;
		if (previous === null) return;
		persist({ schema: 1, kind: "invalidate", id: `${incarnation}:${previous.identity.segment_id}:invalidate:${sequence + 1}`,
			sequence: ++sequence, identity: previous.identity, clock, reason });
	}
	function observe(ctx: ActivityContext, clock: ActivityClockSample): Source | null {
		const current = captureSource(ctx);
		if (current === null) { invalidate("SOURCE_UNAVAILABLE", clock); return null; }
		if (source !== null && (source.session !== current.session || source.file !== current.file || source.fileId !== current.fileId)) {
			invalidate("SOURCE_REPLACED", clock);
			runId = null; runObserved = false; lastSettled = -1; lastNativeStart = null;
		}
		source = current;
		return current;
	}
	function seatFor(current: Source): string {
		const pane = env.TERN_PANE;
		if (typeof pane === "string" && pane.length > 0 && pane.length <= 32) {
			let decimal = true, nonzero = false;
			for (const character of pane) {
				if (character < "0" || character > "9") { decimal = false; break; }
				if (character !== "0") nonzero = true;
			}
			if (decimal && nonzero) return `tern:${pane}`;
		}
		return `session:${current.session}`;
	}

	pi.on("agent_start", (_event, ctx) => {
		const clock = sample(), current = observe(ctx, clock);
		if (current !== null) {
			invalidate("RUN_REPLACED", clock);
			runId = randomUUID(); runObserved = true; lastSettled = -1; lastNativeStart = null;
		}
		return tail;
	});
	pi.on("turn_start", (value, ctx) => {
		const clock = sample(), current = observe(ctx, clock);
		if (current === null || !object(value) || typeof value.turnIndex !== "number"
			|| !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0) return tail;
		const turn = value.turnIndex;
		const timestamp = typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp)
			&& value.timestamp >= 0 && !Object.is(value.timestamp, -0) ? value.timestamp : null;
		if (pending !== null && pending.identity.turn_index === turn && pending.nativeTimestamp === timestamp) return tail;
		if (turn <= lastSettled && timestamp === lastNativeStart) return tail;
		invalidate("TURN_REPLACED", clock);
		const activeRun = runId ?? randomUUID();
		if (runId === null) runObserved = false;
		runId = activeRun;
		const segment = `${activeRun}:${turn}`;
		const identity: ActivityIdentity = { seat: seatFor(current), session_id: current.session, session_file: current.file,
			file_id: current.fileId, incarnation, run_id: activeRun, segment_id: segment, turn_index: turn };
		pending = { identity, nativeTimestamp: timestamp, models: [],
			invalid: runObserved ? timestamp === null ? "NATIVE_START_UNPROVEN" : null : "RUN_START_UNOBSERVED" };
		lastIdentity = identity;
		return persist({ schema: 1, kind: "open", id: `${incarnation}:${segment}:open`, sequence: ++sequence,
			identity, clock, native_timestamp_ms: timestamp });
	});
	pi.on("message_start", (value, ctx) => {
		if (!object(value)) return tail;
		const model = primaryModel(value.message);
		if (model === null || pending === null) return tail;
		const clock = sample();
		if (observe(ctx, clock) === null || pending === null) return tail;
		if (!pending.models.some(known => known.provider === model.provider && known.model === model.model)) {
			if (pending.models.length >= 2) pending.invalid = "MODEL_CONFLICT";
			else pending.models.push(model);
		}
		return tail;
	});
	pi.on("turn_end", (value, ctx) => {
		const clock = sample(), current = observe(ctx, clock);
		if (current === null || !object(value) || typeof value.turnIndex !== "number"
			|| !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0) return tail;
		const turn = value.turnIndex;
		if (pending === null || pending.identity.turn_index !== turn) {
			if (turn <= lastSettled) return tail;
			if (lastIdentity !== null) {
				return persist({ schema: 1, kind: "loss", id: `loss:${randomUUID()}`, sequence: ++sequence,
					identity: lastIdentity, clock, reason: "ORPHAN_TURN_END", lost_events: 1 });
			}
			return tail;
		}
		const previous = pending;
		pending = null;
		lastSettled = turn; lastNativeStart = previous.nativeTimestamp;
		const terminal = primaryModel(value.message);
		const coherent = terminal !== null && previous.models.length === 1
			&& previous.models[0]!.provider === terminal.provider && previous.models[0]!.model === terminal.model;
		const reason = previous.invalid ?? (coherent ? null : "PRIMARY_MODEL_UNPROVEN_OR_CONFLICTING");
		return persist({ schema: 1, kind: "settle", id: `${incarnation}:${previous.identity.segment_id}:settle`,
			sequence: ++sequence, identity: previous.identity, clock,
			model: reason === null ? terminal : null, models_seen: previous.models, reason });
	});
	const abandon = (_event: unknown, ctx: ActivityContext): Promise<void> => {
		const clock = sample();
		observe(ctx, clock);
		invalidate("UNMATCHED_TURN_END", clock);
		runId = null; runObserved = false;
		return tail;
	};
	pi.on("agent_end", abandon);
	pi.on("session_switch", abandon);
	pi.on("session_shutdown", abandon);
}
