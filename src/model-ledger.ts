import { createHash } from "node:crypto";
import { opendirSync, realpathSync, type Dir } from "node:fs";
import { join, resolve } from "node:path";
import { readJsonl, type ReadResult } from "./kitlib/jsonl.ts";
import { parseSessionJournalTail, readSessionTail } from "./plane-tern.ts";
import { inspectModelActivity } from "./model-activity.ts";
import { inspectVerifyLedger, type OriginalClaimEvidence } from "./verify-ledger.ts";
import { inspectModelWeek } from "./work-doctor.ts";

export const MODEL_JOURNAL_WINDOW_BYTES = 8 * 1024 * 1024;
export type WorkingModelEvidence =
	| { status: "UNKNOWN"; reason: string }
	| { status: "KNOWN"; provider: string; model: string; upstream_provider: string | null; upstream_model: string | null;
		source: { journal: string; identity: string; session_id: string; entry_id: string; tool_call_id: string;
			cursor_bytes: number; window_start: number; window_sha256: string; head_bytes: number; head_sha256: string;
			entry_start: number; entry_bytes: number; entry_sha256: string; read_bytes: number } };

const unknown = (reason: string): WorkingModelEvidence => ({ status: "UNKNOWN", reason });
const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
function identifier(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code < 0x20 || code === 0x7f || code === 0xfffd || (code >= 0xd800 && code <= 0xdfff)) return false;
	}
	return true;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PROOF_NUMBERS = ["cursor_bytes", "window_start", "head_bytes", "entry_start", "entry_bytes", "read_bytes"] as const;
function sha256Text(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 64) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (!((code >= 48 && code <= 57) || (code >= 97 && code <= 102))) return false;
	}
	return true;
}

/** Observe the assistant that originated this tool invocation, not the latest assistant or selected role.
 * Bash pins these three values at invocation. Eval without a causal id deliberately stays UNKNOWN.
 * Read once through the existing stable-inode, bounded head/tail reader; never widen to scan an old journal. */
export function observeWorkingModel(env: Readonly<Record<string, string | undefined>> = process.env): WorkingModelEvidence {
	const path = env.PI_SESSION_FILE, sessionId = env.PI_SESSION_ID, callId = env.PI_TOOL_CALL_ID;
	if (!identifier(path) || !identifier(sessionId) || !identifier(callId)) return unknown("CAUSAL_SESSION_BINDING_MISSING");
	let canonical: string;
	try { canonical = realpathSync(path); }
	catch { return unknown("JOURNAL_UNREADABLE"); }
	const view = readSessionTail(canonical, MODEL_JOURNAL_WINDOW_BYTES);
	if (view === null || view.identity === null) return unknown("JOURNAL_UNREADABLE_OR_CHANGED");
	const candidates: { id: string; message: Record<string, unknown>; start: number; bytes: number }[] = [];
	let onBranch = false;
	const branch = parseSessionJournalTail(view, {
		record(row, start, bytes) {
			const message = row.type === "message" ? object(row.message) : null;
			if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
			for (const value of message.content) {
				const block = object(value);
				if ((block?.type === "toolCall" || block?.type === "tool_call") && (block.id ?? block.toolCallId) === callId) {
					if (identifier(row.id)) candidates.push({ id: row.id, message, start, bytes });
				}
			}
		},
		branch(ids) { onBranch = candidates.length === 1 && ids.has(candidates[0]!.id); },
	});
	if (branch.status !== "KNOWN") return unknown(branch.reason);
	if (branch.sessionId !== sessionId) return unknown("SESSION_REPLACED");
	if (branch.window?.leafProven !== true) return unknown("ACTIVE_BRANCH_UNPROVEN");
	if (candidates.length > 1) return unknown("CAUSAL_ENTRY_AMBIGUOUS");
	const entry = candidates[0];
	if (entry === undefined) return unknown("CAUSAL_ENTRY_NOT_PERSISTED_OR_OUTSIDE_WINDOW");
	if (!onBranch) return unknown("CAUSAL_ENTRY_OFF_ACTIVE_BRANCH");
	const message = entry.message;
	if (!identifier(message.provider) || !identifier(message.model)) return unknown("WORKING_MODEL_MISSING");
	return { status: "KNOWN", provider: message.provider, model: message.model,
		upstream_provider: identifier(message.upstreamProvider) ? message.upstreamProvider : null,
		upstream_model: identifier(message.upstreamModel) ? message.upstreamModel : null,
		source: { journal: canonical, identity: view.identity, session_id: sessionId, entry_id: entry.id, tool_call_id: callId,
			cursor_bytes: view.fileSize, window_start: view.tailStart, window_sha256: view.sha256,
			head_bytes: view.head.length, head_sha256: hash(view.head), entry_start: entry.start,
			entry_bytes: entry.bytes, entry_sha256: hash(view.tail.subarray(entry.start - view.tailStart, entry.start - view.tailStart + entry.bytes)),
			read_bytes: view.head.length + view.tail.length } };
}

export const MODEL_LEDGER_DIRECTORY = "model-evidence";
export const MODEL_LEDGER_MAX_FILES = 32;
export const MODEL_LEDGER_MAX_READ_BYTES = 16 * 1024 * 1024;
export const MODEL_LEDGER_RETENTION_DAYS = 28;
export const MODEL_LEDGER_MAX_DAY_BYTES = 1024 * 1024;
export const MODEL_LEDGER_MAX_EVENT_BYTES = 16 * 1024;

export type ModelLedgerEvent = {
	schema_version: 1; producer: "omp-kit/model-ledger"; phase: "intent" | "outcome";
	operation_id: string; at: string; kind: "claim" | "close" | "release"; actor: string;
	tracker: string; beads: string[]; attribution: WorkingModelEvidence;
	native_rc: number | null; native_timed_out?: boolean; intent_sha256?: string; correction_of?: string;
	claim_incarnations: Record<string, string | null>;
};

function ledgerEvent(value: unknown): ModelLedgerEvent | null {
	const row = object(value);
	if (!row || row.schema_version !== 1 || row.producer !== "omp-kit/model-ledger"
		|| (row.phase !== "intent" && row.phase !== "outcome") || !identifier(row.operation_id)
		|| !identifier(row.at) || !Number.isFinite(Date.parse(row.at))
		|| (row.kind !== "claim" && row.kind !== "close" && row.kind !== "release")
		|| !identifier(row.actor) || !identifier(row.tracker) || !Array.isArray(row.beads)
		|| row.beads.length === 0 || row.beads.length > 100 || !row.beads.every(identifier)
		|| (row.native_rc !== null && (!Number.isInteger(row.native_rc) || typeof row.native_rc !== "number"))
		|| (row.native_timed_out !== undefined && typeof row.native_timed_out !== "boolean")
		|| !object(row.claim_incarnations)) return null;
	const evidence = object(row.attribution);
	if (!evidence || (evidence.status !== "KNOWN" && evidence.status !== "UNKNOWN")) return null;
	if (evidence.status === "KNOWN") {
		const source = object(evidence.source);
		if (!identifier(evidence.provider) || !identifier(evidence.model) || !source
			|| !identifier(source.session_id) || !identifier(source.entry_id) || !identifier(source.tool_call_id)
			|| !sha256Text(source.entry_sha256) || !sha256Text(source.window_sha256) || !sha256Text(source.head_sha256)
			|| !identifier(source.identity) || !identifier(source.journal)) return null;
		for (const key of PROOF_NUMBERS) if (typeof source[key] !== "number" || !Number.isSafeInteger(source[key]) || source[key] < 0) return null;
		if (typeof source.head_bytes !== "number" || typeof source.entry_bytes !== "number"
			|| typeof source.cursor_bytes !== "number" || typeof source.entry_start !== "number"
			|| source.head_bytes > 64 * 1024 || source.entry_bytes === 0 || source.entry_bytes > MODEL_JOURNAL_WINDOW_BYTES
			|| source.entry_start + source.entry_bytes > source.cursor_bytes) return null;
	} else if (!identifier(evidence.reason)) return null;
	return value as ModelLedgerEvent;
}

/** A bounded read model of the shim's captured invocations, not an alternative bead-state authority.
 * Pending intents, malformed/torn/missing pages and unread pages keep coverage UNKNOWN.
 * An outcome commits a digest of its original intent: corrections never rewrite that capture. */
function inspectClaimLedger(stateRoot: string | null, tracker: string | null, now: number, bead?: string) {
	const records: ModelLedgerEvent[] = [];
	const problems: string[] = [];
	const directory = stateRoot === null ? null : join(stateRoot, MODEL_LEDGER_DIRECTORY);
	const date = new Date(now);
	const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - MODEL_LEDGER_RETENTION_DAYS * 86_400_000;
	let bytesRead = 0;
	const pages: { name: string; day: number }[] = [];
	if (directory === null) problems.push("STATE_ROOT_UNAVAILABLE");
	else {
		let dir: Dir | null = null;
		try {
			dir = opendirSync(directory);
			for (let count = 0; ; count++) {
				const entry = dir.readSync();
				if (entry === null) break;
				if (count >= MODEL_LEDGER_MAX_FILES + 2) { problems.push("LEDGER_FILE_LIMIT"); break; }
				if (entry.name.endsWith(".lock") || entry.name === "current.jsonl") continue;
				const date = entry.name.slice(0, 10), day = Date.parse(`${date}T00:00:00.000Z`);
				if (!entry.isFile() || entry.name !== `${date}.jsonl` || !Number.isFinite(day)
					|| new Date(day).toISOString().slice(0, 10) !== date) {
					problems.push("UNRECOGNIZED_LEDGER_PAGE"); continue;
				}
				if (day >= start && day <= now) pages.push({ name: entry.name, day });
				else if (day < start) problems.push("RETENTION_PAGE_UNRESOLVED");
			}
		} catch (error) { problems.push((error as NodeJS.ErrnoException).code === "ENOENT" ? "LEDGER_MISSING" : "LEDGER_UNREADABLE"); }
		finally { dir?.closeSync(); }
	}
	pages.sort((a, b) => a.day - b.day);
	for (const page of pages) {
		const remaining = MODEL_LEDGER_MAX_READ_BYTES - bytesRead;
		if (remaining <= 0) { problems.push("LEDGER_READ_LIMIT"); break; }
		let result: ReadResult;
		try { result = readJsonl(join(directory!, page.name), { maxBytes: remaining }); }
		catch { problems.push("LEDGER_PAGE_UNREADABLE"); continue; }
		const pageBytes = result.more ? remaining : Math.min(remaining, (result.cursor?.offset ?? 0) + result.pending_tail_bytes);
		bytesRead += pageBytes;
		if (pageBytes >= MODEL_LEDGER_MAX_DAY_BYTES - MODEL_LEDGER_MAX_EVENT_BYTES) problems.push("LEDGER_DAY_CAPACITY");
		if (result.missing || result.more || result.pending_tail_bytes || result.errors.length) problems.push("LEDGER_PAGE_INCOMPLETE");
		for (const value of result.rows) {
			const row = ledgerEvent(value);
			if (!row) { problems.push("INVALID_LEDGER_EVENT"); continue; }
			if ((tracker === null || row.tracker === tracker) && (bead === undefined || row.beads.includes(bead))) records.push(row);
		}
	}
	const intents = new Map<string, ModelLedgerEvent>(), outcomes = new Map<string, ModelLedgerEvent>();
	for (const row of records) {
		const target = row.phase === "intent" ? intents : outcomes;
		if (target.has(row.operation_id)) problems.push("DUPLICATE_OPERATION_PHASE");
		else target.set(row.operation_id, row);
	}
	let claims = 0, known = 0, pending = 0, unresolved = 0, refused = 0;
	const operations: { intent: ModelLedgerEvent; outcome: ModelLedgerEvent | null; integrity: "KNOWN" | "UNKNOWN" }[] = [];
	for (const [id, intent] of intents) {
		const outcome = outcomes.get(id) ?? null;
		const digest = createHash("sha256").update(JSON.stringify(intent)).digest("hex");
		const valid = outcome !== null && outcome.intent_sha256 === digest && outcome.actor === intent.actor
			&& outcome.tracker === intent.tracker && outcome.kind === intent.kind
			&& JSON.stringify(outcome.beads) === JSON.stringify(intent.beads)
			&& JSON.stringify(outcome.claim_incarnations) === JSON.stringify(intent.claim_incarnations)
			&& (JSON.stringify(outcome.attribution) === JSON.stringify(intent.attribution)
				|| (outcome.attribution.status === "UNKNOWN" && outcome.correction_of === digest));
		if (outcome !== null && !valid) problems.push("INTENT_OUTCOME_MISMATCH");
		operations.push({ intent, outcome, integrity: valid ? "KNOWN" : "UNKNOWN" });
		if (!valid || outcome!.native_rc === null || outcome!.native_timed_out === true) {
			unresolved++;
			if (intent.kind === "claim") pending++;
			continue;
		}
		if (outcome!.native_rc !== 0) { refused++; continue; }
		if (intent.kind === "claim") {
			claims++;
			if (outcome!.attribution.status === "KNOWN") known++;
		}
	}
	for (const id of outcomes.keys()) if (!intents.has(id)) problems.push("ORPHAN_OUTCOME");
	const complete = problems.length === 0 && unresolved === 0;
	return { status: complete ? "KNOWN" : "UNKNOWN", problems: [...new Set(problems)],
		cohort: { definition: "Captured shim claim invocations with native rc 0; not all tracker writes or active working time",
			tracker, start: new Date(start).toISOString(), end: new Date(now).toISOString() },
		counts: { successful_claims: claims, known_claims: known, unknown_claims: claims - known, unresolved_claims: pending, unresolved_operations: unresolved, refused_operations: refused },
		known_claim_model_coverage: complete && claims > 0 ? 100 * known / claims : null,
		bytes_read: bytesRead, limits: { max_files: MODEL_LEDGER_MAX_FILES, max_read_bytes: MODEL_LEDGER_MAX_READ_BYTES,
			retention_days: MODEL_LEDGER_RETENTION_DAYS, max_day_bytes: MODEL_LEDGER_MAX_DAY_BYTES, max_event_bytes: MODEL_LEDGER_MAX_EVENT_BYTES },
		operations };
}

function unknownClaim(reason: string): OriginalClaimEvidence {
	return { status: "UNKNOWN", reason, operation_id: null, actor: null, incarnation: null,
		captured_at: null, intent_sha256: null, attribution: unknown(reason) };
}

/** Bind an unambiguous successful captured claim, never a later closer or selected model.
 * Multiple claims require the attempt's retained original snapshot, not a last-claim guess. */
export function observeAuthorClaim(stateRoot: string | null, tracker: string, bead: string, now = Date.now()): OriginalClaimEvidence {
	const report = inspectClaimLedger(stateRoot, resolve(tracker), now, bead);
	if (report.status !== "KNOWN") return unknownClaim("AUTHOR_EVIDENCE_INCOMPLETE");
	let selected: typeof report.operations[number] | null = null;
	for (const operation of report.operations) {
		if (operation.intent.kind !== "claim" || !operation.intent.beads.includes(bead)
			|| operation.integrity !== "KNOWN" || operation.outcome?.native_rc !== 0
			|| operation.outcome.native_timed_out === true) continue;
		if (selected !== null) return unknownClaim("AUTHOR_CLAIM_AMBIGUOUS");
		selected = operation;
	}
	if (selected === null || selected.outcome === null) return unknownClaim("AUTHOR_CLAIM_MISSING");
	const outcome = selected.outcome;
	const incarnation = outcome.claim_incarnations[bead];
	const digest = outcome.intent_sha256;
	const reason = !identifier(incarnation) ? "AUTHOR_CLAIM_INCARNATION_UNAVAILABLE"
		: !sha256Text(digest) ? "AUTHOR_CLAIM_BINDING_UNAVAILABLE"
		: outcome.attribution.status === "UNKNOWN" ? outcome.attribution.reason : null;
	return { status: reason === null ? "KNOWN" : "UNKNOWN", reason,
		operation_id: selected.intent.operation_id, actor: selected.intent.actor,
		incarnation: identifier(incarnation) ? incarnation : null, captured_at: selected.intent.at,
		intent_sha256: sha256Text(digest) ? digest : null, attribution: outcome.attribution };
}

/** Compose the human-facing inspection without making claim lookup read activity journals. */
export function inspectModelLedger(stateRoot: string | null, project?: string, now = Date.now()) {
	const tracker = project === undefined ? null : resolve(project, ".beads/beads.db");
	const evidence = Object.assign(inspectClaimLedger(stateRoot, tracker, now), {
		activity: inspectModelActivity(stateRoot, now),
		verification: inspectVerifyLedger(stateRoot, now, tracker ?? undefined),
	});
	return Object.assign(evidence, { weekly: inspectModelWeek(evidence, now) });
}
