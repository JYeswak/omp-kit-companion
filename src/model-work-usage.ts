import type { ActivityWindow } from "./model-activity.ts";
import { parseSessionJournalTail, readSessionTail } from "./plane-tern.ts";

export const MODEL_USAGE_MAX_FILES = 32;
export const MODEL_USAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MODEL_USAGE_MAX_READ_BYTES = 16 * 1024 * 1024;
export const MODEL_USAGE_MAX_RECORDS = 65_536;
export const MODEL_USAGE_MAX_MODELS = 256;
const HEAD_ALLOWANCE = 64 * 1024 + 1;

export interface ModelSessionSource { journal: string; identity: string; session_id: string; }
export interface ModelUsageSourceEvidence extends ModelSessionSource {
	sha256: string | null; cursor_bytes: number | null; complete: boolean;
	active_branch_entries: number; reason: string | null;
}
export interface ModelWorkUsageRow {
	provider: string; model: string; eligible: number; known: number; unknown: number;
	known_tokens: number | null; work_tokens: number | null;
}
export interface ModelWorkUsageInspection {
	status: "KNOWN" | "UNKNOWN";
	problems: string[];
	counts: { eligible: number; known: number; unknown: number; time_unknown: number; excluded_auxiliary_records: number };
	by_model: ModelWorkUsageRow[];
	bytes_read: number;
	read_budget_bytes: number;
	sources: ModelUsageSourceEvidence[];
	limits: { max_files: number; max_file_bytes: number; max_read_bytes: number; max_records: number; max_models: number };
	definition: string;
}
const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const label = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
	&& value.length <= 4096 && !value.includes("\0") && !value.includes("\n") && !value.includes("\r");
interface UsageAccumulator {
	models: Map<string, ModelWorkUsageRow>;
	counts: ModelWorkUsageInspection["counts"];
	problems: Set<string>;
	complete: boolean;
}

/** A source is staged separately until its native header and physical identity
 * have been checked; untrusted sessions never enter even the known subtotals. */
function emptyUsage(): UsageAccumulator {
	return { models: new Map(), counts: { eligible: 0, known: 0, unknown: 0, time_unknown: 0, excluded_auxiliary_records: 0 },
		problems: new Set(), complete: true };
}

function captureUsageRecord(row: Record<string, unknown>, window: ActivityWindow, result: UsageAccumulator): void {
	if (row.type === "model_usage" || row.customType === "model_usage") { result.counts.excluded_auxiliary_records++; return; }
	const message = row.type === "message" ? object(row.message) : null;
	if (message?.role !== "assistant") return;
	const rawAt = row.timestamp ?? message.timestamp;
	const at = typeof rawAt === "number" ? rawAt : typeof rawAt === "string" ? Date.parse(rawAt) : NaN;
	if (!Number.isSafeInteger(at) || at < 0) {
		result.counts.time_unknown++; result.complete = false; result.problems.add("USAGE_MESSAGE_TIME_UNKNOWN"); return;
	}
	if (at < window.start_ms || at >= window.end_ms) return;
	result.counts.eligible++;
	if (!label(row.id) || !label(message.provider) || !label(message.model)) {
		result.counts.unknown++; result.complete = false; result.problems.add("USAGE_WORKING_MODEL_OR_ENTRY_UNKNOWN"); return;
	}
	const key = `${message.provider}\0${message.model}`;
	let model = result.models.get(key);
	if (model === undefined) {
		if (result.models.size >= MODEL_USAGE_MAX_MODELS) {
			result.counts.unknown++; result.complete = false; result.problems.add("USAGE_MODEL_LIMIT"); return;
		}
		result.models.set(key, model = { provider: message.provider, model: message.model,
			eligible: 0, known: 0, unknown: 0, known_tokens: 0, work_tokens: null });
	}
	model.eligible++;
	const tokens = object(message.usage)?.totalTokens;
	if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0
		|| message.stopReason === "error" || message.stopReason === "aborted") {
		model.unknown++; result.counts.unknown++; result.complete = false; result.problems.add("ASSISTANT_USAGE_UNKNOWN"); return;
	}
	model.known++; result.counts.known++;
	if (model.known_tokens !== null && Number.isSafeInteger(model.known_tokens + tokens)) model.known_tokens += tokens;
	else { model.known_tokens = null; result.complete = false; result.problems.add("USAGE_TOKEN_SUM_OVERFLOW"); }
}

function mergeUsage(target: UsageAccumulator, source: UsageAccumulator): void {
	for (const field of ["eligible", "known", "unknown", "time_unknown", "excluded_auxiliary_records"] as const) target.counts[field] += source.counts[field];
	for (const problem of source.problems) target.problems.add(problem);
	target.complete = target.complete && source.complete;
	for (const [key, row] of source.models) {
		const prior = target.models.get(key);
		if (prior === undefined) {
			if (target.models.size < MODEL_USAGE_MAX_MODELS) target.models.set(key, row);
			else { target.complete = false; target.problems.add("USAGE_MODEL_LIMIT"); }
			continue;
		}
		prior.eligible += row.eligible; prior.known += row.known; prior.unknown += row.unknown;
		if (prior.known_tokens !== null && row.known_tokens !== null && Number.isSafeInteger(prior.known_tokens + row.known_tokens)) prior.known_tokens += row.known_tokens;
		else { prior.known_tokens = null; target.complete = false; target.problems.add("USAGE_TOKEN_SUM_OVERFLOW"); }
	}
}

/** All persisted primary assistant messages in the captured sessions, including
 * abandoned branches whose work was still spent. Never selected-role inference,
 * auxiliary model_usage, message text, or a missing usage value defaulted to zero. */
export function inspectModelWorkUsage(
	sources: readonly ModelSessionSource[], window: ActivityWindow, sourcesComplete: boolean,
): ModelWorkUsageInspection {
	const result = emptyUsage();
	const evidence: ModelUsageSourceEvidence[] = [];
	const seenSources = new Set<string>();
	result.complete = sourcesComplete;
	let bytesRead = 0, budgetBytes = 0, records = 0;
	if (!sourcesComplete) result.problems.add("USAGE_SOURCE_COHORT_INCOMPLETE");
	if (sources.length === 0) { result.complete = false; result.problems.add("NO_USAGE_SESSION_EVIDENCE"); }
	for (const source of sources) {
		const sourceKey = `${source.session_id}\0${source.identity}`;
		if (seenSources.has(sourceKey)) continue;
		if (seenSources.size >= MODEL_USAGE_MAX_FILES) { result.complete = false; result.problems.add("USAGE_FILE_LIMIT"); break; }
		seenSources.add(sourceKey);
		const remaining = MODEL_USAGE_MAX_READ_BYTES - budgetBytes - HEAD_ALLOWANCE;
		if (remaining <= 0) { result.complete = false; result.problems.add("USAGE_READ_LIMIT"); break; }
		const proof: ModelUsageSourceEvidence = { journal: source.journal, identity: source.identity, session_id: source.session_id,
			sha256: null, cursor_bytes: null, complete: false, active_branch_entries: 0, reason: null };
		evidence.push(proof);
		const windowBytes = Math.min(MODEL_USAGE_MAX_FILE_BYTES, remaining);
		const charge = windowBytes + HEAD_ALLOWANCE;
		budgetBytes += charge;
		const view = readSessionTail(source.journal, windowBytes);
		// A failed positioned read does not reveal how many bytes it consumed:
		// keep its worst-case charge instead of granting another full budget.
		if (view === null) { result.complete = false; proof.reason = "USAGE_JOURNAL_UNREADABLE_OR_CHANGED"; result.problems.add(proof.reason); continue; }
		const observedBytes = view.head.length + view.tail.length + (view.tailStart === 0 ? 0 : 1);
		bytesRead += observedBytes;
		budgetBytes -= charge - observedBytes;
		proof.sha256 = view.sha256; proof.cursor_bytes = view.fileSize;
		if (view.identity !== source.identity) { result.complete = false; proof.reason = "USAGE_JOURNAL_REPLACED"; result.problems.add(proof.reason); continue; }
		const pending = emptyUsage();
		if (view.tailStart !== 0) { pending.complete = false; pending.problems.add("USAGE_JOURNAL_PREFIX_OUTSIDE_WINDOW"); }
		const parsed = parseSessionJournalTail(view, {
			record(row) {
				if (++records > MODEL_USAGE_MAX_RECORDS) { pending.complete = false; pending.problems.add("USAGE_RECORD_LIMIT"); return; }
				captureUsageRecord(row, window, pending);
			},
			branch(ids) { proof.active_branch_entries = ids.size; },
		});
		if (parsed.status !== "KNOWN" || parsed.sessionId !== source.session_id) {
			result.complete = false;
			proof.reason = parsed.status === "KNOWN" ? "USAGE_SESSION_REPLACED" : `USAGE_${parsed.reason}`;
			result.problems.add(proof.reason);
			continue;
		}
		proof.complete = pending.complete;
		proof.reason = pending.problems.values().next().value ?? null;
		mergeUsage(result, pending);
	}
	for (const model of result.models.values()) model.work_tokens = result.complete && model.eligible > 0 && model.unknown === 0 ? model.known_tokens : null;
	return { status: result.complete && result.counts.eligible > 0 && result.counts.unknown === 0 ? "KNOWN" : "UNKNOWN",
		problems: [...result.problems], counts: result.counts, by_model: [...result.models.values()], bytes_read: bytesRead, read_budget_bytes: budgetBytes, sources: evidence,
		limits: { max_files: MODEL_USAGE_MAX_FILES, max_file_bytes: MODEL_USAGE_MAX_FILE_BYTES,
			max_read_bytes: MODEL_USAGE_MAX_READ_BYTES, max_records: MODEL_USAGE_MAX_RECORDS, max_models: MODEL_USAGE_MAX_MODELS },
		definition: "Native per-assistant-message usage.totalTokens in the declared UTC window across captured sessions, all persisted branches; auxiliary model_usage excluded, missing/partial/error usage UNKNOWN; not per-bead causal token allocation. bytes_read is returned buffers; read_budget_bytes also charges failed positioned reads at their maximum possible size" };
}
