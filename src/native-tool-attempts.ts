import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { ArtifactError, readLocalArtifact, strictJson } from "./kitlib/artifact.ts";
import { captureMineReplay } from "./mine-replay.ts";
import { privateLock } from "./kitlib/lock.ts";

export interface NativeToolAttemptInput {
	seat: string | null;
	tool: string;
	tool_call_id: string | null;
	session_id: string | null;
	journal_identity: string | null;
	assistant_id: string | null;
	assistant_at: string | null;
	model: string | null;
	provider: string | null;
	attribution_reason: string | null;
	own_guard: "REFUSED" | "ALLOWED" | "UNOBSERVED";
	phase: "start" | "end";
	is_error: boolean | null;
	observer_id: string;
	coverage_gap?: boolean;
}

export interface NativeToolAttemptOptions {
	env?: Readonly<Record<string, string | undefined>>;
	home?: string;
	path?: string;
	now?: () => number;
}

interface Attempt extends NativeToolAttemptInput { id: string | null; }
interface Bucket {
	seat: string | null; tool: string; model: string | null; provider: string | null;
	attempted: number | null; own_guard_observed: number; own_guard_refused: number; native_error_results: number;
	own_guard_refusal_rate: number | null; all_guard_refusal_rate: null;
}
interface WindowRecord {
	start: string; end: string;
	coverage: { status: "COMPLETE" | "INCOMPLETE"; reasons: string[] };
	attempts: Attempt[]; buckets: Bucket[];
}
interface Store { schema_version: 1; scope: "observed-native-tool-lifecycle"; rate_scope: "own-kit-guard-observed-admissions"; window_ms: 600000; windows: WindowRecord[]; }

const MAX_WINDOWS = 6, MAX_ATTEMPTS = 128, MAX_BYTES = 512 * 1024;
const NULL_FIELDS = ["seat", "session_id", "journal_identity", "assistant_id", "assistant_at", "model", "provider", "attribution_reason"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 512;
}
function validNullableText(value: unknown): value is string | null { return value === null || safeText(value); }
function validateInput(input: unknown): input is NativeToolAttemptInput {
	if (!isObject(input)) return false;
	return validNullableText(input.seat) && safeText(input.tool)
		&& validNullableText(input.tool_call_id) && validNullableText(input.session_id)
		&& validNullableText(input.journal_identity) && validNullableText(input.assistant_id)
		&& validNullableText(input.assistant_at) && validNullableText(input.model)
		&& validNullableText(input.provider) && validNullableText(input.attribution_reason)
		&& typeof input.own_guard === "string" && ["REFUSED", "ALLOWED", "UNOBSERVED"].includes(input.own_guard)
		&& typeof input.phase === "string" && ["start", "end"].includes(input.phase)
		&& (typeof input.is_error === "boolean" || input.is_error === null)
		&& safeText(input.observer_id) && (input.coverage_gap === undefined || typeof input.coverage_gap === "boolean");
}

function sanitizeInput(input: NativeToolAttemptInput): NativeToolAttemptInput & { redacted: boolean; truncated: boolean } {
	const clean = captureMineReplay({
		tool: input.tool,
		arguments: Object.fromEntries([...NULL_FIELDS, "tool_call_id", "observer_id"].map(key => [key, input[key as keyof NativeToolAttemptInput]])),
	});
	const metadata = isObject(clean.arguments) ? clean.arguments : {};
	const text = (key: string): string | null => {
		if (clean.redacted || clean.truncated) return null;
		const value = metadata[key];
		return typeof value === "string" ? value : null;
	};
	return {
		seat: text("seat"), tool: clean.redacted || clean.truncated || clean.tool === null ? "unknown-tool" : clean.tool,
		tool_call_id: text("tool_call_id"), session_id: text("session_id"), journal_identity: text("journal_identity"),
		assistant_id: text("assistant_id"), assistant_at: text("assistant_at"), model: text("model"),
		provider: text("provider"), attribution_reason: text("attribution_reason"),
		own_guard: input.own_guard, phase: input.phase, is_error: input.is_error,
		observer_id: text("observer_id") ?? "unknown-observer", coverage_gap: input.coverage_gap,
		redacted: clean.redacted, truncated: clean.truncated,
	};
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}
const ATTEMPT_KEYS = ["id", "seat", "tool", "tool_call_id", "session_id", "journal_identity", "assistant_id",
	"assistant_at", "model", "provider", "attribution_reason", "own_guard", "phase", "is_error", "observer_id", "coverage_gap"];
const BUCKET_KEYS = ["seat", "tool", "model", "provider", "attempted", "own_guard_observed", "own_guard_refused",
	"native_error_results", "own_guard_refusal_rate", "all_guard_refusal_rate"];
function validStore(value: unknown): value is Store {
	if (!isObject(value) || !onlyKeys(value, ["schema_version", "scope", "rate_scope", "window_ms", "windows"])
		|| value.schema_version !== 1 || value.scope !== "observed-native-tool-lifecycle"
		|| value.rate_scope !== "own-kit-guard-observed-admissions"
		|| value.window_ms !== 600000 || !Array.isArray(value.windows) || value.windows.length > MAX_WINDOWS) return false;
	const starts = new Set<string>();
	const ids = new Set<string>();
	return value.windows.every(window => {
		if (!isObject(window) || !onlyKeys(window, ["start", "end", "coverage", "attempts", "buckets"])
			|| typeof window.start !== "string" || typeof window.end !== "string" || !isObject(window.coverage)
			|| !onlyKeys(window.coverage, ["status", "reasons"])
			|| !["COMPLETE", "INCOMPLETE"].includes(String(window.coverage.status))
			|| !Array.isArray(window.coverage.reasons) || window.coverage.reasons.length > 32
			|| !window.coverage.reasons.every(reason => typeof reason === "string" && reason.length > 0 && reason.length <= 80)
			|| !Array.isArray(window.attempts) || window.attempts.length > MAX_ATTEMPTS
			|| !Array.isArray(window.buckets) || window.buckets.length > MAX_ATTEMPTS) return false;
		const startMs = Date.parse(window.start), endMs = Date.parse(window.end);
		if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || startMs > 8.64e15
			|| startMs % 600000 !== 0 || endMs !== startMs + 599999
			|| new Date(startMs).toISOString() !== window.start || new Date(endMs).toISOString() !== window.end
			|| starts.has(window.start)) return false;
		starts.add(window.start);
		for (const attempt of window.attempts) {
			if (!isObject(attempt) || !onlyKeys(attempt, ATTEMPT_KEYS) || !validateInput(attempt)) return false;
			const identity = attempt.session_id !== null && attempt.tool_call_id !== null
				? createHash("sha256").update(JSON.stringify([attempt.session_id, attempt.tool_call_id])).digest("hex") : null;
			if (attempt.id !== identity || (identity !== null && ids.has(identity))) return false;
			if (identity !== null) ids.add(identity);
		}
		const complete = window.coverage.status === "COMPLETE";
		return window.buckets.every(bucket => isObject(bucket) && onlyKeys(bucket, BUCKET_KEYS)
			&& validNullableText(bucket.seat) && safeText(bucket.tool)
			&& validNullableText(bucket.model) && validNullableText(bucket.provider)
			&& (bucket.attempted === null || (typeof bucket.attempted === "number" && Number.isSafeInteger(bucket.attempted)
				&& bucket.attempted >= 0 && bucket.attempted <= MAX_ATTEMPTS))
			&& ["own_guard_observed", "own_guard_refused", "native_error_results"]
				.every(key => Number.isSafeInteger(bucket[key]) && Number(bucket[key]) >= 0 && Number(bucket[key]) <= MAX_ATTEMPTS)
			&& Number(bucket.own_guard_refused) <= Number(bucket.own_guard_observed)
			&& (bucket.attempted === null || (Number(bucket.own_guard_observed) <= Number(bucket.attempted)
				&& Number(bucket.native_error_results) <= Number(bucket.attempted)))
			&& (bucket.own_guard_refusal_rate === null
				|| (complete && bucket.attempted !== null && Number(bucket.own_guard_observed) > 0
					&& typeof bucket.own_guard_refusal_rate === "number"
					&& bucket.own_guard_refusal_rate === Number(bucket.own_guard_refused) / Number(bucket.own_guard_observed)))
			&& bucket.all_guard_refusal_rate === null);
	});
}
function addReason(window: WindowRecord, reason: string): void {
	window.coverage.status = "INCOMPLETE";
	if (!window.coverage.reasons.includes(reason) && window.coverage.reasons.length < 32) window.coverage.reasons.push(reason);
}
function bucketKey(input: NativeToolAttemptInput): string {
	return JSON.stringify([input.seat, input.tool, input.model, input.provider]);
}
function rebuildBuckets(window: WindowRecord): void {
	const buckets = new Map<string, Bucket>();
	for (const attempt of window.attempts) {
		const key = bucketKey(attempt);
		let bucket = buckets.get(key);
		if (bucket === undefined) {
			bucket = { seat: attempt.seat, tool: attempt.tool, model: attempt.model, provider: attempt.provider,
				attempted: 0, own_guard_observed: 0, own_guard_refused: 0, native_error_results: 0,
				own_guard_refusal_rate: null, all_guard_refusal_rate: null };
			buckets.set(key, bucket);
		}
		if (attempt.id === null) { bucket.attempted = null; continue; }
		if (bucket.attempted !== null) bucket.attempted++;
		if (attempt.own_guard !== "UNOBSERVED") {
			bucket.own_guard_observed++;
			if (attempt.own_guard === "REFUSED") bucket.own_guard_refused++;
		}
		if (attempt.is_error === true) bucket.native_error_results++;
	}
	for (const bucket of buckets.values()) {
		if (bucket.attempted !== null && bucket.own_guard_observed > 0 && window.coverage.status === "COMPLETE")
			bucket.own_guard_refusal_rate = bucket.own_guard_refused / bucket.own_guard_observed;
		if (bucket.seat === null || bucket.model === null || bucket.provider === null || window.coverage.status !== "COMPLETE")
			bucket.own_guard_refusal_rate = null;
	}
	window.buckets = [...buckets.values()];
}

export async function recordNativeToolAttempt(
	input: NativeToolAttemptInput,
	options: NativeToolAttemptOptions = {},
): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
	if (!validateInput(input)) return { ok: false, why: "INVALID_INPUT" };
	const captured = sanitizeInput(input);
	const { redacted, truncated, ...sanitized } = captured;
	input = sanitized;
	if (redacted || truncated) input = { ...input, coverage_gap: true };
	const env = options.env ?? process.env, home = options.home ?? homedir();
	const stateRoot = env.XDG_STATE_HOME || join(home, ".local", "state");
	const path = options.path ?? join(stateRoot, "omp-kit", "native-tool-attempts.json");
	let clock: number;
	try { clock = (options.now ?? Date.now)(); } catch { clock = NaN; }
	const timestampValid = Number.isSafeInteger(clock) && clock >= 0 && !Object.is(clock, -0);
	if (!timestampValid) clock = Date.now();
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const lockState = options.path === undefined ? join(stateRoot, "omp-kit", "locks") : dirname(path);
		const lock = await privateLock({ namespace: "native-tool-attempts", path }, { deadline_s: 2, state_dir: lockState });
		try {
			let store: Store = { schema_version: 1, scope: "observed-native-tool-lifecycle", rate_scope: "own-kit-guard-observed-admissions", window_ms: 600000, windows: [] };
			try {
				const artifact = readLocalArtifact(path, { allowedRoot: dirname(path), maxBytes: MAX_BYTES });
				const parsed = strictJson(artifact.bytes, { path });
				if (!validStore(parsed)) return { ok: false, why: "CORRUPT_STORE" };
				store = parsed;
			} catch (error) {
				if (!(error instanceof ArtifactError) || error.code !== "MISSING") return { ok: false, why: "READ_FAILED" };
			}
			const now = timestampValid ? clock : Date.now();
			const parsedAssistantAt = input.assistant_at === null ? NaN : Date.parse(input.assistant_at);
			const assistantClockValid = Number.isFinite(parsedAssistantAt);
			const start = assistantClockValid ? Math.floor(parsedAssistantAt / 600000) * 600000 : Math.floor(now / 600000) * 600000;
			const startText = new Date(start).toISOString();
			store.windows = store.windows.filter(window => Date.parse(window.end) >= now - MAX_WINDOWS * 600000);
			const identity = input.session_id !== null && input.tool_call_id !== null
				? createHash("sha256").update(JSON.stringify([input.session_id, input.tool_call_id])).digest("hex") : null;
			let window = identity === null ? undefined
				: store.windows.find(candidate => candidate.attempts.some(attempt => attempt.id === identity));
			const prior = window?.attempts.find(attempt => attempt.id === identity);
			if (window === undefined && start < now - MAX_WINDOWS * 600000) return { ok: true, path };
			if (window === undefined) window = store.windows.find(candidate => candidate.start === startText);
			if (window === undefined) {
				window = { start: startText, end: new Date(start + 600000 - 1).toISOString(),
					coverage: { status: "COMPLETE", reasons: [] }, attempts: [], buckets: [] };
				store.windows.push(window);
				store.windows.sort((a, b) => a.start.localeCompare(b.start));
				while (store.windows.length > MAX_WINDOWS) store.windows.shift();
			}
			if (!timestampValid || !assistantClockValid) addReason(window, "CLOCK_UNAVAILABLE");
			if (input.coverage_gap || redacted || truncated) addReason(window, "OBSERVER_COVERAGE_GAP");
			if (input.seat === null || input.model === null || input.provider === null || input.session_id === null
				|| input.journal_identity === null || input.assistant_id === null || input.assistant_at === null)
				addReason(window, "ATTRIBUTION_INCOMPLETE");
			if (window.attempts.some(attempt => attempt.seat === input.seat && attempt.session_id === input.session_id
				&& attempt.observer_id !== input.observer_id)) addReason(window, "OBSERVER_CHANGED");
			if (prior !== undefined) {
				const bindingConflict = ["journal_identity", "assistant_id", "assistant_at", "model", "provider"]
					.some(key => {
						const previous = prior[key as keyof Attempt], current = input[key as keyof NativeToolAttemptInput];
						return previous !== null && current !== null && previous !== current;
					});
				if (bindingConflict) addReason(window, "IDENTITY_BINDING_CONFLICT");
				else if (input.phase === "end") {
					if (prior.own_guard !== "UNOBSERVED" && input.own_guard !== "UNOBSERVED" && prior.own_guard !== input.own_guard)
						addReason(window, "OWN_GUARD_CONFLICT");
					else if (prior.own_guard === "UNOBSERVED") prior.own_guard = input.own_guard;
					if (prior.is_error !== null && input.is_error !== null && prior.is_error !== input.is_error)
						addReason(window, "NATIVE_ERROR_CONFLICT");
					else if (input.is_error !== null) prior.is_error = input.is_error;
				}
			} else if (window.attempts.length >= MAX_ATTEMPTS) addReason(window, "ATTEMPT_CAPACITY");
			else window.attempts.push({ ...input, id: identity });
			rebuildBuckets(window);
			const bytes = new TextEncoder().encode(JSON.stringify(store) + "\n");
			if (bytes.byteLength > MAX_BYTES) return { ok: false, why: "STORE_CAPACITY" };
			atomicReplaceBytes(path, bytes, { mode: 0o600, durability: "full" });
			return { ok: true, path };
		} finally { lock.release(); }
	} catch { return { ok: false, why: "IO_FAILED" }; }
}
