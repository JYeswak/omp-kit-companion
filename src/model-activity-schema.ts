/** Native processing evidence, not request-duration or selected-role accounting.
 * Bounded scalar fields and at most two observed models keep every event below
 * ACTIVITY_MAX_EVENT_BYTES without serializing each append twice. */
import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";

export const ACTIVITY_DIRECTORY = "model-activity";
export const ACTIVITY_MAX_EVENT_BYTES = 32 * 1024;
export const ACTIVITY_MAX_DAY_BYTES = 1024 * 1024;
export const ACTIVITY_MAX_FILES = 32;
export const ACTIVITY_MAX_READ_BYTES = 16 * 1024 * 1024;
export const ACTIVITY_MAX_RECORDS = 65_536;
export const ACTIVITY_RETENTION_DAYS = 28;

export interface ActivityModel { provider: string; model: string; }
export interface ActivityClockSample { epoch_ms: number | null; mono_ns: string | null; }
export interface ActivityIdentity {
	seat: string;
	session_id: string;
	session_file: string;
	file_id: string | null;
	incarnation: string;
	run_id: string;
	segment_id: string;
	turn_index: number;
}
interface ActivityBase {
	schema: 1;
	kind: "open" | "settle" | "invalidate" | "loss";
	id: string;
	sequence: number;
	identity: ActivityIdentity;
	clock: ActivityClockSample;
}
export type ActivityEvent =
	| ActivityBase & { kind: "open"; native_timestamp_ms: number | null }
	| ActivityBase & { kind: "settle"; model: ActivityModel | null; models_seen: ActivityModel[]; reason: string | null }
	| ActivityBase & { kind: "invalidate"; reason: string }
	| ActivityBase & { kind: "loss"; reason: string; lost_events: number };

const BASE_KEYS = ["schema", "kind", "id", "sequence", "identity", "clock"] as const;
const OPEN_KEYS = [...BASE_KEYS, "native_timestamp_ms"] as const;
const SETTLE_KEYS = [...BASE_KEYS, "model", "models_seen", "reason"] as const;
const INVALID_KEYS = [...BASE_KEYS, "reason"] as const;
const LOSS_KEYS = [...BASE_KEYS, "reason", "lost_events"] as const;
const IDENTITY_KEYS = ["seat", "session_id", "session_file", "file_id", "incarnation", "run_id", "segment_id", "turn_index"] as const;
const CLOCK_KEYS = ["epoch_ms", "mono_ns"] as const;
const MODEL_KEYS = ["provider", "model"] as const;

function object(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	let count = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key) || !keys.includes(key)) return false;
		count++;
	}
	return count === keys.length;
}
/** UTF-8, not code-unit, bounds also cover non-ASCII source paths. */
export function activityText(value: unknown, maxBytes = 256): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxBytes || Buffer.byteLength(value, "utf8") > maxBytes) return false;
	for (const character of value) {
		const point = character.codePointAt(0)!;
		if (point < 0x20 || point === 0x7f || point === 0xfffd || (point >= 0xd800 && point <= 0xdfff)) return false;
	}
	return true;
}
function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}
function nullableMilliseconds(value: unknown): value is number | null {
	return value === null || nonnegativeInteger(value);
}
function monotonicNanoseconds(value: unknown): value is string | null {
	if (value === null) return true;
	if (typeof value !== "string" || value.length === 0 || value.length > 32 || (value.length > 1 && value[0] === "0")) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 48 || code > 57) return false;
	}
	return true;
}
export function isActivityModel(value: unknown): value is ActivityModel {
	return object(value) && exactKeys(value, MODEL_KEYS) && activityText(value.provider) && activityText(value.model);
}
export function isActivityIdentity(value: unknown): value is ActivityIdentity {
	return object(value) && exactKeys(value, IDENTITY_KEYS)
		&& activityText(value.seat) && activityText(value.session_id)
		&& activityText(value.session_file, 4096) && isAbsolute(value.session_file)
		&& (value.file_id === null || activityText(value.file_id))
		&& activityText(value.incarnation) && activityText(value.run_id) && activityText(value.segment_id)
		&& nonnegativeInteger(value.turn_index);
}
export function isActivityClockSample(value: unknown): value is ActivityClockSample {
	return object(value) && exactKeys(value, CLOCK_KEYS)
		&& nullableMilliseconds(value.epoch_ms) && monotonicNanoseconds(value.mono_ns);
}
/** Validation does not turn an incomplete endpoint into a valid interval.
 * Null clocks/source identities are preserved for the projector to mark UNKNOWN. */
export function isActivityEvent(value: unknown): value is ActivityEvent {
	if (!object(value) || value.schema !== 1 || !activityText(value.id)
		|| !nonnegativeInteger(value.sequence) || value.sequence === 0
		|| !isActivityIdentity(value.identity) || !isActivityClockSample(value.clock)) return false;
	switch (value.kind) {
		case "open":
			return exactKeys(value, OPEN_KEYS) && nullableMilliseconds(value.native_timestamp_ms);
		case "settle":
			return exactKeys(value, SETTLE_KEYS) && (value.model === null || isActivityModel(value.model))
				&& Array.isArray(value.models_seen) && value.models_seen.length <= 2 && value.models_seen.every(isActivityModel)
				&& (value.reason === null || activityText(value.reason));
		case "invalidate":
			return exactKeys(value, INVALID_KEYS) && activityText(value.reason);
		case "loss":
			return exactKeys(value, LOSS_KEYS) && activityText(value.reason)
				&& nonnegativeInteger(value.lost_events) && value.lost_events > 0;
		default:
			return false;
	}
}
