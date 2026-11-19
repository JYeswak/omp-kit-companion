import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, opendirSync, unlinkSync, type Dir, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { appendJsonl, readJsonl } from "./kitlib/jsonl.ts";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { privateLock } from "./kitlib/lock.ts";
import type { WorkingModelEvidence } from "./model-ledger.ts";

export interface OriginalClaimEvidence {
	status: "KNOWN" | "UNKNOWN";
	reason: string | null;
	operation_id: string | null;
	actor: string | null;
	incarnation: string | null;
	captured_at: string | null;
	intent_sha256: string | null;
	attribution: WorkingModelEvidence;
}
export interface VerifyAttemptContext {
	tracker: string;
	bead: string;
	export_requested: string;
	export_commit: string | null;
	bead_created_at: string | null;
	author: OriginalClaimEvidence;
	verifier: { actor: string; attribution: WorkingModelEvidence };
}
export type VerifyAttemptOutcome = "PASS" | "FAIL" | "UNJUDGED" | "INCOMPLETE";
export interface VerifyFinalEvidence {
	result_code: string;
	outcome: VerifyAttemptOutcome;
	reason: string;
	replayed: boolean;
	export_commit: string | null;
}
export interface VerifyAttemptRef { id: string; key: string; digest: string; state_root: string; }
export type VerifyAttemptBegin =
	| { status: "RECORDED"; attempt: VerifyAttemptRef }
	| { status: "UNAVAILABLE"; reason: string };
export type VerifyAttemptFinish =
	| { status: "FINALIZED" | "ALREADY_FINALIZED"; attempt: VerifyAttemptRef }
	| { status: "UNAVAILABLE" | "CONFLICT"; reason: string };
export interface VerifyProjectedAttempt {
	attempt: VerifyAttemptRef | null;
	id: string;
	key: string;
	context: VerifyAttemptContext;
	began_at: string;
	finalized_at: string | null;
	outcome: VerifyAttemptOutcome;
	reason: string;
	result_code: string | null;
	export_commit: string | null;
	replayed: boolean;
	complete: boolean;
	integrity: "KNOWN" | "UNKNOWN";
	coverage: "KNOWN" | "UNKNOWN";
	corrections: { at: string; reason: string; author?: OriginalClaimEvidence }[];
}
export interface VerifyLedgerInspection {
	status: "KNOWN" | "UNKNOWN";
	problems: string[];
	attempts: VerifyProjectedAttempt[];
	first_attempts: VerifyProjectedAttempt[];
	counts: { pass: number; fail: number; unjudged: number; incomplete: number; unknown: number };
	counts_definition: string;
	coverage_start: string | null;
	cohort_definition: string;
	bytes_read: number;
	pages_read: number;
	limits: { retention_days: number; max_pages: number; max_page_bytes: number; max_event_bytes: number; max_control_bytes: number; max_read_bytes: number; max_records: number };
}

export const VERIFY_LEDGER_DIRECTORY = "verify-evidence";
export const VERIFY_LEDGER_RETENTION_DAYS = 28;
export const VERIFY_LEDGER_MAX_FILES = 32;
export const VERIFY_LEDGER_MAX_DAY_BYTES = 1024 * 1024;
export const VERIFY_LEDGER_MAX_EVENT_BYTES = 16 * 1024;
export const VERIFY_LEDGER_MAX_CONTROL_BYTES = 16 * 1024;
export const VERIFY_LEDGER_MAX_READ_BYTES = 16 * 1024 * 1024;
export const VERIFY_LEDGER_MAX_RECORDS = 16_384;
const PRODUCER = "omp-kit/verify-ledger";
const CONTROL_NAMESPACE = "verify-ledger-control";
const CONTROL = "control.json";
const DAY_MS = 86_400_000;

type VerifyEvent = {
	schema_version: 1; producer: typeof PRODUCER; phase: "begin" | "finalize" | "correction";
	id: string; sequence: number; at: string; begin_digest: string;
	context?: VerifyAttemptContext; evidence?: VerifyFinalEvidence; correction?: { reason: string; author?: OriginalClaimEvidence };
};
type Control = {
	schema_version: 1; producer: typeof PRODUCER; epoch: string; coverage_floor: string; next_sequence: number;
	pages: { day: string; dev: number; ino: number; size: number }[]; integrity_sha256?: string;
};
const object = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function sha256(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 64) return false;
	for (const character of value) if (!((character >= "a" && character <= "f") || (character >= "0" && character <= "9"))) return false;
	return true;
}
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
const validAt = (value: unknown): value is string => text(value, 64) && Number.isFinite(Date.parse(value));
function validGitObjectId(value: unknown): value is string {
	if (typeof value !== "string" || (value.length !== 40 && value.length !== 64)) return false;
	for (const character of value) if (!((character >= "a" && character <= "f") || (character >= "0" && character <= "9"))) return false;
	return true;
}
function validAttemptKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 8193) return false;
	const separator = value.indexOf("\0");
	return separator > 0 && separator === value.lastIndexOf("\0")
		&& text(value.slice(0, separator)) && text(value.slice(separator + 1));
}
function validModel(value: unknown): value is WorkingModelEvidence {
	const row = object(value);
	if (!row || (row.status !== "KNOWN" && row.status !== "UNKNOWN")) return false;
	if (row.status === "UNKNOWN") return text(row.reason);
	const source = object(row.source);
	if (!source || !text(row.provider) || !text(row.model)
		|| (row.upstream_provider !== null && !text(row.upstream_provider))
		|| (row.upstream_model !== null && !text(row.upstream_model))
		|| !text(source.journal) || !text(source.identity) || !text(source.session_id)
		|| !text(source.entry_id) || !text(source.tool_call_id)
		|| !sha256(source.entry_sha256) || !sha256(source.window_sha256) || !sha256(source.head_sha256)) return false;
	for (const key of ["cursor_bytes", "window_start", "head_bytes", "entry_start", "entry_bytes", "read_bytes"] as const) {
		if (typeof source[key] !== "number" || !Number.isSafeInteger(source[key]) || source[key] < 0) return false;
	}
	const entryBytes = source.entry_bytes, headBytes = source.head_bytes;
	const entryStart = source.entry_start, cursorBytes = source.cursor_bytes;
	return typeof entryBytes === "number" && entryBytes > 0
		&& typeof headBytes === "number" && headBytes <= 64 * 1024
		&& typeof entryStart === "number" && typeof cursorBytes === "number"
		&& entryStart + entryBytes <= cursorBytes;
}
function validAuthor(value: unknown): value is OriginalClaimEvidence {
	const row = object(value);
	return !!row && (row.status === "KNOWN" || row.status === "UNKNOWN")
		&& (row.reason === null || typeof row.reason === "string")
		&& ["operation_id", "actor", "incarnation"].every(key => row[key] === null || text(row[key]))
		&& (row.captured_at === null || validAt(row.captured_at))
		&& (row.intent_sha256 === null || sha256(row.intent_sha256)) && validModel(row.attribution);
}
function validContext(value: unknown): value is VerifyAttemptContext {
	const row = object(value), verifier = object(row?.verifier);
	return !!row && text(row.tracker) && text(row.bead) && text(row.export_requested)
		&& (row.export_commit === null || validGitObjectId(row.export_commit))
		&& (row.bead_created_at === null || validAt(row.bead_created_at)) && validAuthor(row.author)
		&& !!verifier && text(verifier.actor) && validModel(verifier.attribution);
}
function normalizedFinal(value: unknown): VerifyFinalEvidence | null {
	const row = object(value);
	if (!row || !text(row.result_code, 256) || !["PASS", "FAIL", "UNJUDGED", "INCOMPLETE"].includes(String(row.outcome))
		|| !text(row.reason, 4096) || typeof row.replayed !== "boolean"
		|| (row.export_commit !== null && !validGitObjectId(row.export_commit))) return null;
	const outcome: VerifyAttemptOutcome = row.replayed ? row.outcome as VerifyAttemptOutcome
		: row.outcome === "PASS" || row.outcome === "FAIL" ? "UNJUDGED" : row.outcome as VerifyAttemptOutcome;
	return { result_code: row.result_code, outcome, reason: row.reason, replayed: row.replayed, export_commit: row.export_commit as string | null };
}
function validEvent(value: unknown): value is VerifyEvent {
	const row = object(value);
	if (!row || row.schema_version !== 1 || row.producer !== PRODUCER
		|| !["begin", "finalize", "correction"].includes(String(row.phase)) || !text(row.id, 128)
		|| typeof row.sequence !== "number" || !Number.isSafeInteger(row.sequence) || row.sequence < 1
		|| !validAt(row.at) || !sha256(row.begin_digest)) return false;
	if (row.phase === "begin") {
		if (!validContext(row.context)) return false;
		return digest({ ...row, begin_digest: "" }) === row.begin_digest;
	}
	if (row.phase === "finalize") return normalizedFinal(row.evidence) !== null;
	const correction = object(row.correction);
	return !!correction && text(correction.reason, 4096)
		&& (correction.author === undefined || validAuthor(correction.author));
}
function control(value: unknown): Control | null {
	const row = object(value);
	if (!row || row.schema_version !== 1 || row.producer !== PRODUCER || !text(row.epoch, 128)
		|| !validAt(row.coverage_floor)
		|| typeof row.next_sequence !== "number" || !Number.isSafeInteger(row.next_sequence) || row.next_sequence < 1
		|| !Array.isArray(row.pages) || row.pages.length > VERIFY_LEDGER_MAX_FILES
		|| !sha256(row.integrity_sha256)) return null;
	const { integrity_sha256, ...payload } = row;
	if (digest(payload) !== integrity_sha256) return null;
	const pages: Control["pages"] = [];
	for (const value of row.pages) {
		const page = object(value);
		if (!page || !text(page.day, 10)) return null;
		const day = Date.parse(`${page.day}T00:00:00.000Z`);
		if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== page.day
			|| typeof page.dev !== "number" || !Number.isSafeInteger(page.dev)
			|| typeof page.ino !== "number" || !Number.isSafeInteger(page.ino)
			|| typeof page.size !== "number" || !Number.isSafeInteger(page.size) || page.size < 0) return null;
		pages.push({ day: page.day, dev: page.dev, ino: page.ino, size: page.size });
	}
	return { ...row, pages } as unknown as Control;
}
function ensureStateRoot(root: string): void {
	if (!root || !isAbsolute(root) || resolve(root) !== root) throw new Error("UNSAFE_STATE_ROOT");
	let info: Stats;
	try { info = lstatSync(root); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(root, { recursive: true, mode: 0o700 });
		info = lstatSync(root);
	}
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("UNSAFE_STATE_ROOT");
	}
}
function directoryPath(root: string, create: boolean): string {
	if (!root || !isAbsolute(root) || resolve(root) !== root) throw new Error("UNSAFE_STATE_ROOT");
	if (create) mkdirSync(join(root, VERIFY_LEDGER_DIRECTORY), { recursive: true, mode: 0o700 });
	const info = lstatSync(root);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("UNSAFE_STATE_ROOT");
	const directory = join(root, VERIFY_LEDGER_DIRECTORY), state = lstatSync(directory);
	if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) throw new Error("UNSAFE_DIRECTORY");
	return directory;
}
function privateFile(path: string): Stats | null {
	let info: Stats;
	try { info = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("UNSAFE_FILE");
	return info;
}
function controlPath(root: string, create = false): string | null {
	const directory = join(root, CONTROL_NAMESPACE);
	if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
	let info: Stats;
	try { info = lstatSync(directory); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("UNSAFE_CONTROL_DIRECTORY");
	}
	return join(directory, CONTROL);
}
function writeControl(root: string, value: Control): void {
	const path = controlPath(root, true);
	if (path === null) throw new Error("CONTROL_DIRECTORY_MISSING");
	const payload = { ...value };
	delete payload.integrity_sha256;
	const bytes = Buffer.from(`${JSON.stringify({ ...payload, integrity_sha256: digest(payload) })}\n`, "utf8");
	atomicReplaceBytes(path, bytes, { mode: 0o600, durability: "full" });
}
function readControl(root: string): Control | null {
	const path = controlPath(root);
	if (path === null) return null;
	const info = privateFile(path);
	if (!info) return null;
	const result = readJsonl(path, { maxBytes: VERIFY_LEDGER_MAX_CONTROL_BYTES });
	const after = privateFile(path);
	if (!after || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
		|| result.missing || result.errors.length || result.more || result.pending_tail_bytes || result.rows.length !== 1) return null;
	return control(result.rows[0]);
}
function ensureControl(directory: string, root: string, now: number): Control {
	const path = controlPath(root, true);
	if (path === null) throw new Error("CONTROL_DIRECTORY_MISSING");
	const existing = readControl(root);
	if (existing) return existing;
	if (privateFile(path) !== null) throw new Error("CONTROL_MISSING_OR_REPLACED");
	const dir = opendirSync(directory);
	let hasPage = false;
	try {
		for (let i = 0; ; i++) {
			const entry = dir.readSync();
			if (!entry) break;
			if (i >= VERIFY_LEDGER_MAX_FILES + 2) throw new Error("DIRECTORY_LIMIT");
			if (entry.name.endsWith(".jsonl")) hasPage = true;
		}
	} finally { dir.closeSync(); }
	if (hasPage) throw new Error("CONTROL_MISSING_OR_REPLACED");
	const created: Control = { schema_version: 1, producer: PRODUCER, epoch: randomUUID(),
		coverage_floor: new Date(now).toISOString(), next_sequence: 1, pages: [] };
	writeControl(root, created);
	return created;
}
function pageName(day: string): string { return `${day}.jsonl`; }
function dayStart(now: number): number { return Date.parse(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`); }
function pageFor(directory: string, at: number): string {
	return join(directory, pageName(new Date(at).toISOString().slice(0, 10)));
}
function addPage(controlState: Control, page: string, day: string, before: Stats | null): void {
	const info = privateFile(page);
	if (!info) throw new Error("PAGE_MISSING_AFTER_APPEND");
	// Check the live path across the append, not the device number from a previous boot.
	if (before && (before.dev !== info.dev || before.ino !== info.ino)) throw new Error("PAGE_REPLACED");
	const known = controlState.pages.findIndex(item => item.day === day);
	if (known >= 0) {
		controlState.pages[known] = { day, dev: info.dev, ino: info.ino, size: info.size };
		return;
	}
	controlState.pages.push({ day, dev: info.dev, ino: info.ino, size: info.size });
	controlState.pages.sort((a, b) => a.day.localeCompare(b.day));
}
function matchesRegisteredPage(page: Control["pages"][number] | undefined, info: Stats): boolean {
	// Device numbers can change across boots. Keep the persisted field for schema compatibility.
	return page !== undefined && page.ino === info.ino && page.size === info.size;
}
function expirePages(directory: string, state: Control, now: number): void {
	const minimum = dayStart(now) - VERIFY_LEDGER_RETENTION_DAYS * DAY_MS;
	const floor = new Date(minimum).toISOString();
	for (const page of [...state.pages]) {
		const day = Date.parse(`${page.day}T00:00:00.000Z`);
		if (day >= minimum) continue;
		const path = join(directory, pageName(page.day)), info = privateFile(path);
		if (!info) throw new Error("PAGE_MISSING_BEFORE_RETENTION");
		if (!matchesRegisteredPage(page, info)) throw new Error("PAGE_REPLACED");
		unlinkSync(path);
		state.pages = state.pages.filter(candidate => candidate.day !== page.day);
		if (Date.parse(state.coverage_floor) < minimum) state.coverage_floor = floor;
	}
}
function prepareRetention(directory: string, root: string, state: Control, now: number): void {
	expirePages(directory, state, now);
	writeControl(root, state);
}
interface JournalRead { events: VerifyEvent[]; problems: string[]; bytes: number; pages: number; coverage_start: string | null; }
function readJournal(root: string | null, now: number): JournalRead {
	const events: VerifyEvent[] = [], problems: string[] = [];
	let bytes = 0, pagesRead = 0;
	if (root === null || !isAbsolute(root) || resolve(root) !== root) return { events, problems: ["STATE_ROOT_UNAVAILABLE"], bytes, pages: pagesRead, coverage_start: null };
	let directory: string;
	try { directory = directoryPath(root, false); } catch { return { events, problems: ["LEDGER_MISSING_OR_UNSAFE"], bytes, pages: pagesRead, coverage_start: null }; }
	let metadata: Control | null = null;
	try { metadata = readControl(root); } catch { problems.push("CONTROL_UNREADABLE_OR_UNSAFE"); }
	if (!metadata) problems.push("CONTROL_MISSING_OR_INVALID");
	const pages: { name: string; day: number }[] = [];
	const observedDays = new Set<string>();
	let dir: Dir | null = null;
	try {
		dir = opendirSync(directory);
		for (let i = 0; ; i++) {
			const entry = dir.readSync();
			if (!entry) break;
			if (i >= VERIFY_LEDGER_MAX_FILES + 2) { problems.push("DIRECTORY_LIMIT"); break; }
			const day = entry.name.slice(0, 10), parsed = Date.parse(`${day}T00:00:00.000Z`);
			if (!entry.isFile() || entry.name !== `${day}.jsonl` || !Number.isFinite(parsed)
				|| new Date(parsed).toISOString().slice(0, 10) !== day) { problems.push("UNRECOGNIZED_PAGE"); continue; }
			if (parsed < dayStart(now) - VERIFY_LEDGER_RETENTION_DAYS * DAY_MS) { problems.push("RETENTION_PAGE_UNRESOLVED"); continue; }
			if (parsed > now) { problems.push("FUTURE_PAGE"); continue; }
			pages.push({ name: entry.name, day: parsed });
			observedDays.add(day);
		}
	} catch { problems.push("DIRECTORY_INCOMPLETE"); }
	finally { dir?.closeSync(); }
	if (metadata) for (const entry of metadata.pages) if (!observedDays.has(entry.day)) problems.push("PAGE_MISSING_FROM_CONTROL");
	if (pages.length > VERIFY_LEDGER_MAX_FILES) problems.push("PAGE_LIMIT");
	let records = 0;
	for (const page of pages.slice(0, VERIFY_LEDGER_MAX_FILES)) {
		if (bytes >= VERIFY_LEDGER_MAX_READ_BYTES || records >= VERIFY_LEDGER_MAX_RECORDS) { problems.push("READ_LIMIT"); break; }
		const path = join(directory, page.name);
		try {
			const before = privateFile(path);
			if (!before) { problems.push("PAGE_MISSING"); continue; }
			const registered = metadata?.pages.find(value => value.day === page.name.slice(0, 10));
			if (!matchesRegisteredPage(registered, before)) {
				problems.push("PAGE_UNREGISTERED_REPLACED_OR_TRUNCATED");
			}
			if (before.size >= VERIFY_LEDGER_MAX_DAY_BYTES - VERIFY_LEDGER_MAX_EVENT_BYTES) problems.push("PAGE_CAPACITY");
			const result = readJsonl(path, { maxBytes: Math.min(VERIFY_LEDGER_MAX_READ_BYTES - bytes, VERIFY_LEDGER_MAX_DAY_BYTES) });
			bytes += result.more ? VERIFY_LEDGER_MAX_READ_BYTES - bytes : Math.min(VERIFY_LEDGER_MAX_READ_BYTES - bytes, (result.cursor?.offset ?? 0) + result.pending_tail_bytes);
			if (result.missing) problems.push("PAGE_MISSING_DURING_READ");
			if (result.errors.length) problems.push("PAGE_PARSE_ERROR");
			if (result.more) problems.push("PAGE_READ_LIMIT");
			if (result.pending_tail_bytes > 0) problems.push("PAGE_TORN_TAIL");
			pagesRead++;
			for (const raw of result.rows) {
				records++;
				if (records > VERIFY_LEDGER_MAX_RECORDS) { problems.push("RECORD_LIMIT"); break; }
				if (!validEvent(raw)) { problems.push("INVALID_EVENT"); continue; }
				if (Date.parse(raw.at) > now) problems.push("FUTURE_EVENT_TIMESTAMP");
				events.push(raw);
			}
			const after = privateFile(path);
			if (!after || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) problems.push("PAGE_REPLACED_DURING_READ");
		} catch { problems.push("PAGE_UNREADABLE_OR_UNSAFE"); }
	}
	return { events, problems: [...new Set(problems)], bytes, pages: pagesRead, coverage_start: metadata?.coverage_floor ?? null };
}
function keyOf(context: VerifyAttemptContext): string { return `${context.tracker}\0${context.bead}`; }
function refFor(event: VerifyEvent, root: string): VerifyAttemptRef {
	return { id: event.id, key: keyOf(event.context!), digest: event.begin_digest, state_root: root };
}
function matchingBegin(events: VerifyEvent[], ref: VerifyAttemptRef): VerifyEvent | null {
	return events.find(event => event.phase === "begin" && event.id === ref.id && event.begin_digest === ref.digest && keyOf(event.context!) === ref.key) ?? null;
}
async function withControl<T>(root: string, now: number, action: (directory: string, controlState: Control) => Promise<T>): Promise<T> {
	ensureStateRoot(root);
	const lock = await privateLock({ namespace: CONTROL_NAMESPACE, name: "global" }, { deadline_s: 1, state_dir: root });
	try {
		const directory = directoryPath(root, true), state = ensureControl(directory, root, now);
		return await action(directory, state);
	} finally { lock.release(); }
}
async function appendEvent(directory: string, root: string, state: Control, event: VerifyEvent, now: number): Promise<void> {
	const day = new Date(now).toISOString().slice(0, 10), page = pageFor(directory, now);
	const info = privateFile(page), registered = state.pages.find(value => value.day === day);
	if (info && !matchesRegisteredPage(registered, info)) {
		throw new Error("PAGE_REPLACED_OR_TRUNCATED");
	}
	if (!info && state.pages.length >= VERIFY_LEDGER_MAX_FILES) throw new Error("PAGE_LIMIT");
	const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
	if (eventBytes > VERIFY_LEDGER_MAX_EVENT_BYTES) throw new Error("EVENT_LIMIT");
	if ((info?.size ?? 0) + eventBytes > VERIFY_LEDGER_MAX_DAY_BYTES) throw new Error("DAY_CAPACITY");
	await appendJsonl(page, () => event, { deadline_s: 1, durable: true, state_dir: root });
	addPage(state, page, day, info);
	state.next_sequence = Math.max(state.next_sequence, event.sequence + 1);
	writeControl(root, state);
}
export function resolveVerifyStateRoot(env: Readonly<Record<string, string | undefined>>): string | null {
	const home = env.HOME;
	if (env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== "") {
		if (!isAbsolute(env.XDG_STATE_HOME) || resolve(env.XDG_STATE_HOME) !== env.XDG_STATE_HOME) return null;
		return join(env.XDG_STATE_HOME, "omp-kit");
	}
	if (!home || !isAbsolute(home) || resolve(home) !== home) return null;
	return join(home, ".local", "state", "omp-kit");
}
export async function beginVerifyAttempt(stateRoot: string | null, context: VerifyAttemptContext, now = Date.now()): Promise<VerifyAttemptBegin> {
	if (stateRoot === null || !Number.isSafeInteger(now) || now < 0 || !validContext(context)) return { status: "UNAVAILABLE", reason: "INVALID_STATE_OR_CONTEXT" };
	try {
		return await withControl(stateRoot, now, async (directory, state) => {
			prepareRetention(directory, stateRoot, state, now);
			const scan = readJournal(stateRoot, now);
			if (scan.problems.length > 0) throw new Error(`HISTORY_UNAVAILABLE:${scan.problems.join(",")}`);
			const sequence = scan.events.reduce((next, event) => Math.max(next, event.sequence + 1), state.next_sequence);
			const id = randomUUID();
			const begin: VerifyEvent = { schema_version: 1, producer: PRODUCER, phase: "begin", id, sequence,
				at: new Date(now).toISOString(), begin_digest: "", context: structuredClone(context) };
			begin.begin_digest = digest(begin);
			await appendEvent(directory, stateRoot, state, begin, now);
			return { status: "RECORDED", attempt: refFor(begin, stateRoot) };
		});
	} catch (error) { return { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "BEGIN_FAILED" }; }
}
export async function finalizeVerifyAttempt(attempt: VerifyAttemptRef, evidence: VerifyFinalEvidence, now = Date.now()): Promise<VerifyAttemptFinish> {
	if (!attempt || !isAbsolute(attempt.state_root) || resolve(attempt.state_root) !== attempt.state_root || !text(attempt.id)
		|| !validAttemptKey(attempt.key) || !sha256(attempt.digest) || !Number.isSafeInteger(now) || now < 0) return { status: "UNAVAILABLE", reason: "INVALID_ATTEMPT_REF" };
	const final = normalizedFinal(evidence);
	if (!final) return { status: "UNAVAILABLE", reason: "INVALID_FINAL_EVIDENCE" };
	try {
		return await withControl(attempt.state_root, now, async (directory, state) => {
			prepareRetention(directory, attempt.state_root, state, now);
			const scan = readJournal(attempt.state_root, now);
			if (scan.problems.length) throw new Error(`HISTORY_UNAVAILABLE:${scan.problems.join(",")}`);
			const begin = matchingBegin(scan.events, attempt);
			if (!begin) return { status: "CONFLICT", reason: "BEGIN_NOT_FOUND_OR_MISMATCHED" };
			const previous = scan.events.find(event => event.phase === "finalize" && event.id === attempt.id);
			if (previous) {
				return JSON.stringify(normalizedFinal(previous.evidence)) === JSON.stringify(final)
					? { status: "ALREADY_FINALIZED", attempt } : { status: "CONFLICT", reason: "FINALIZE_CONFLICT" };
			}
			if (now < Date.parse(begin.at)) return { status: "UNAVAILABLE", reason: "CLOCK_ROLLBACK_BEFORE_BEGIN" };
			const at = new Date(now).toISOString(), event: VerifyEvent = { schema_version: 1, producer: PRODUCER,
				phase: "finalize", id: attempt.id, sequence: begin.sequence, at, begin_digest: begin.begin_digest, evidence: final };
			await appendEvent(directory, attempt.state_root, state, event, now);
			return { status: "FINALIZED", attempt };
		});
	} catch (error) { return { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "FINALIZE_FAILED" }; }
}
export async function appendVerifyCorrection(
	attempt: VerifyAttemptRef, correction: { reason: string; author?: OriginalClaimEvidence }, now = Date.now(),
): Promise<VerifyAttemptFinish> {
	if (!attempt || !isAbsolute(attempt.state_root) || resolve(attempt.state_root) !== attempt.state_root
		|| !text(attempt.id) || !validAttemptKey(attempt.key) || !sha256(attempt.digest) || !text(correction?.reason, 4096)
		|| (correction.author !== undefined && !validAuthor(correction.author)) || !Number.isSafeInteger(now) || now < 0) {
		return { status: "UNAVAILABLE", reason: "INVALID_CORRECTION" };
	}
	try {
		return await withControl(attempt.state_root, now, async (directory, state) => {
			prepareRetention(directory, attempt.state_root, state, now);
			const scan = readJournal(attempt.state_root, now);
			if (scan.problems.length) throw new Error(`HISTORY_UNAVAILABLE:${scan.problems.join(",")}`);
			const begin = matchingBegin(scan.events, attempt);
			if (!begin) return { status: "CONFLICT", reason: "BEGIN_NOT_FOUND_OR_MISMATCHED" };
			const final = scan.events.some(event => event.phase === "finalize" && event.id === attempt.id);
			if (!final) return { status: "CONFLICT", reason: "ATTEMPT_NOT_FINALIZED" };
			if (now < Date.parse(begin.at)) return { status: "UNAVAILABLE", reason: "CLOCK_ROLLBACK_BEFORE_BEGIN" };
			const at = new Date(now).toISOString(), event: VerifyEvent = { schema_version: 1, producer: PRODUCER,
				phase: "correction", id: attempt.id, sequence: begin.sequence, at, begin_digest: begin.begin_digest,
				correction: structuredClone(correction) };
			await appendEvent(directory, attempt.state_root, state, event, now);
			return { status: "FINALIZED", attempt };
		});
	} catch (error) { return { status: "UNAVAILABLE", reason: error instanceof Error ? error.message : "CORRECTION_FAILED" }; }
}
export function inspectVerifyLedger(stateRoot: string | null, now = Date.now(), tracker?: string): VerifyLedgerInspection {
	if (!Number.isSafeInteger(now) || now < 0) now = Date.now();
	const scan = readJournal(stateRoot, now), begins = new Map<string, VerifyEvent>(), finals = new Map<string, VerifyEvent>(), corrections = new Map<string, VerifyEvent[]>();
	for (const event of scan.events) {
		if (event.phase === "begin") {
			if (begins.has(event.id)) scan.problems.push("DUPLICATE_BEGIN"); else begins.set(event.id, event);
		} else if (event.phase === "finalize") {
			if (finals.has(event.id)) scan.problems.push("DUPLICATE_FINALIZE"); else finals.set(event.id, event);
		} else {
			const list = corrections.get(event.id) ?? []; list.push(event); corrections.set(event.id, list);
		}
	}
	for (const id of finals.keys()) if (!begins.has(id)) scan.problems.push("ORPHAN_FINALIZE");
	for (const id of corrections.keys()) if (!begins.has(id)) scan.problems.push("ORPHAN_CORRECTION");
	for (const event of [...finals.values(), ...[...corrections.values()].flat()]) {
		const begin = begins.get(event.id);
		if (begin && (event.sequence !== begin.sequence || event.begin_digest !== begin.begin_digest)) scan.problems.push("EVENT_LINK_MISMATCH");
		if (begin && event.phase === "finalize" && Date.parse(event.at) < Date.parse(begin.at)) scan.problems.push("CLOCK_ROLLBACK_FINALIZATION");
	}
	const scopedBegins = [...begins.values()].filter(begin => tracker === undefined || begin.context!.tracker === tracker);
	const retainedCoverageComplete = scan.problems.length === 0;
	for (const begin of scopedBegins) {
		const created = begin.context!.bead_created_at;
		if (!scan.coverage_start || created === null || Date.parse(created) < Date.parse(scan.coverage_start)) {
			scan.problems.push("PRE_RECORDER_HISTORY_UNRESOLVED");
		}
		if (created !== null && Date.parse(created) > Date.parse(begin.at)) scan.problems.push("FUTURE_BEAD_CREATED_AT");
	}
	const attempts = scopedBegins.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)).map(begin => {
		const final = finals.get(begin.id), raw = final ? normalizedFinal(final.evidence) : null;
		const integrity = final && (final.sequence !== begin.sequence || final.begin_digest !== begin.begin_digest
			|| Date.parse(final.at) < Date.parse(begin.at) || !raw) ? "UNKNOWN" : "KNOWN";
		const complete = !!final && integrity === "KNOWN";
		return { id: begin.id, attempt: stateRoot !== null && isAbsolute(stateRoot) && resolve(stateRoot) === stateRoot ? refFor(begin, stateRoot) : null,
			key: keyOf(begin.context!), context: begin.context!,
			began_at: begin.at, finalized_at: complete ? final!.at : null,
			outcome: !complete ? "INCOMPLETE" : raw!.outcome, reason: complete ? raw!.reason : final ? "FINAL_EVIDENCE_UNRESOLVED" : "BEGIN_WITHOUT_FINALIZE",
			result_code: complete ? raw!.result_code : null, export_commit: complete ? raw!.export_commit : null,
			replayed: complete && raw!.replayed, complete, integrity,
			coverage: retainedCoverageComplete && scan.coverage_start !== null && begin.context!.bead_created_at !== null
				&& Date.parse(begin.context!.bead_created_at) >= Date.parse(scan.coverage_start)
				&& Date.parse(begin.context!.bead_created_at) <= Date.parse(begin.at) ? "KNOWN" : "UNKNOWN",
			corrections: (corrections.get(begin.id) ?? []).map(event => ({ at: event.at, reason: event.correction!.reason,
				...(event.correction!.author === undefined ? {} : { author: event.correction!.author }) })) } satisfies VerifyProjectedAttempt;
	});
	const selected = new Map<string, VerifyProjectedAttempt>();
	for (const attempt of attempts) if (!selected.has(attempt.key)) selected.set(attempt.key, attempt);
	const firstAttempts = [...selected.values()].sort((a, b) => a.context.tracker.localeCompare(b.context.tracker) || a.context.bead.localeCompare(b.context.bead));
	const counts = { pass: 0, fail: 0, unjudged: 0, incomplete: 0, unknown: 0 };
	for (const attempt of attempts) {
		if (attempt.integrity === "UNKNOWN" || attempt.coverage === "UNKNOWN") counts.unknown++;
		else if (attempt.outcome === "PASS" && attempt.replayed) counts.pass++;
		else if (attempt.outcome === "FAIL" && attempt.replayed) counts.fail++;
		else if (attempt.outcome === "INCOMPLETE") counts.incomplete++;
		else counts.unjudged++;
	}
	return { status: scan.problems.length === 0 ? "KNOWN" : "UNKNOWN", problems: [...new Set(scan.problems)], attempts,
		first_attempts: firstAttempts, counts,
		counts_definition: "Counts cover all recorded attempts in the requested tracker scope, not only first_attempts.",
		coverage_start: scan.coverage_start,
		cohort_definition: "Recorder-observed begins after the retained first-verification coverage floor; older or missing bead history is UNKNOWN",
		bytes_read: scan.bytes, pages_read: scan.pages,
		limits: { retention_days: VERIFY_LEDGER_RETENTION_DAYS, max_pages: VERIFY_LEDGER_MAX_FILES,
			max_page_bytes: VERIFY_LEDGER_MAX_DAY_BYTES, max_event_bytes: VERIFY_LEDGER_MAX_EVENT_BYTES,
			max_control_bytes: VERIFY_LEDGER_MAX_CONTROL_BYTES, max_read_bytes: VERIFY_LEDGER_MAX_READ_BYTES,
			max_records: VERIFY_LEDGER_MAX_RECORDS } };
}
