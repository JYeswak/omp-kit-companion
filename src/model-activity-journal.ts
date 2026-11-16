import {
	linkSync, lstatSync, mkdirSync, opendirSync, unlinkSync, type Dir, type Stats,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { appendJsonl, readJsonl, type JsonlCursor } from "./kitlib/jsonl.ts";
import { privateLock } from "./kitlib/lock.ts";
import {
	ACTIVITY_DIRECTORY, ACTIVITY_MAX_DAY_BYTES, ACTIVITY_MAX_EVENT_BYTES, ACTIVITY_MAX_FILES,
	ACTIVITY_MAX_READ_BYTES, ACTIVITY_MAX_RECORDS, ACTIVITY_RETENTION_DAYS,
	isActivityEvent, type ActivityEvent,
} from "./model-activity-schema.ts";

const PRODUCER = "omp-kit/native-model-activity";
const ALIAS = "current.jsonl";
const DAY_MS = 86_400_000;
const CHUNK_BYTES = 64 * 1024;
interface PageHeader { schema: 1; producer: string; day: string; }
export interface ActivityJournalRead {
	records: unknown[];
	complete: boolean;
	problems: string[];
	bytes_read: number;
	pages_read: number;
}

function pageDay(name: string): number | null {
	if (name.length !== 16 || !name.endsWith(".jsonl")) return null;
	const text = name.slice(0, 10), day = Date.parse(`${text}T00:00:00.000Z`);
	return Number.isSafeInteger(day) && new Date(day).toISOString().slice(0, 10) === text ? day : null;
}
function stateDirectory(root: string, create: boolean): string {
	if (!root || !isAbsolute(root) || resolve(root) !== root) throw new Error("UNSAFE_STATE_ROOT");
	const path = join(root, ACTIVITY_DIRECTORY);
	if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
	const info = lstatSync(path);
	if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("UNSAFE_DIRECTORY");
	}
	return path;
}
function privateFile(path: string): Stats | null {
	let info: Stats;
	try { info = lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
		throw new Error("UNSAFE_PAGE");
	}
	return info;
}
function header(value: unknown): value is PageHeader {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return Object.keys(row).length === 3 && row.schema === 1 && row.producer === PRODUCER
		&& typeof row.day === "string" && pageDay(`${row.day}.jsonl`) !== null;
}
/** Ownership is the private regular inode and its first physical producer row.
 * A later header-looking row never grants deletion/rotation authority. */
function ownedHeader(path: string): PageHeader | null {
	const before = privateFile(path);
	if (before === null || before.size === 0) return null;
	const read = readJsonl(path, { maxBytes: 512 });
	const after = privateFile(path), first = read.rows[0];
	if (after === null || read.cursor === null || before.dev !== after.dev || before.ino !== after.ino
		|| before.dev !== read.cursor.dev || before.ino !== read.cursor.ino
		|| read.errors.some(error => error.line === 1) || !header(first)) return null;
	return first;
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Only the writer expires its own pages. Doctor reads never mutate storage. */
function expireOwnedPages(directory: string, today: number, addingPage: boolean): void {
	let dir: Dir | null = null;
	let pages = 0;
	try {
		dir = opendirSync(directory);
		for (let count = 0; ; count++) {
			const entry = dir.readSync();
			if (entry === null) break;
			if (count >= ACTIVITY_MAX_FILES + 4) throw new Error("DIRECTORY_LIMIT");
			if (entry.name === ALIAS) continue;
			const day = pageDay(entry.name);
			if (!entry.isFile() || day === null) throw new Error("FOREIGN_PAGE");
			const path = join(directory, entry.name), owner = ownedHeader(path);
			if (owner === null || owner.day !== entry.name.slice(0, 10)) throw new Error("FOREIGN_PAGE");
			if (day < today - ACTIVITY_RETENTION_DAYS * DAY_MS) unlinkSync(path);
			else pages++;
		}
	} finally { dir?.closeSync(); }
	if (pages + Number(addingPage) > ACTIVITY_MAX_FILES) throw new Error("PAGE_LIMIT");
}

/** One rotation identity followed by one fixed KL11 alias identity. Dated hard
 * links are read/retention views, never a new persistent lock per day. */
export async function appendActivityEvent(
	stateRoot: string, event: ActivityEvent, nowMs = Date.now(),
): Promise<{ appended: boolean; problem: string | null }> {
	if (!isActivityEvent(event)) return { appended: false, problem: "INVALID_EVENT" };
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { appended: false, problem: "INVALID_NOW" };
	try {
		const directory = stateDirectory(stateRoot, true), day = new Date(nowMs).toISOString().slice(0, 10);
		const today = Date.parse(`${day}T00:00:00.000Z`), page = join(directory, `${day}.jsonl`), alias = join(directory, ALIAS);
		const rotation = await privateLock({ namespace: "model-activity-rotation", path: directory }, { deadline_s: 1, state_dir: stateRoot });
		try {
			let pageInfo = privateFile(page), aliasInfo = privateFile(alias);
			let aliasHeader = aliasInfo === null ? null : ownedHeader(alias);
			if (aliasInfo !== null && aliasHeader === null) {
				if (aliasInfo.size !== 0 || pageInfo !== null) throw new Error("FOREIGN_ALIAS");
				// A private empty alias can be an interrupted first append. Append its
				// header in place; never delete an unidentified pre-existing inode.
				await appendJsonl(alias, () => ({ schema: 1, producer: PRODUCER, day }),
					{ deadline_s: 1, durable: true, state_dir: stateRoot });
				aliasInfo = privateFile(alias); aliasHeader = ownedHeader(alias);
				if (aliasInfo === null || aliasHeader === null) throw new Error("ALIAS_INCOMPLETE");
			}
			if (pageInfo !== null) {
				const pageHeader = ownedHeader(page);
				if (pageHeader === null || pageHeader.day !== day) throw new Error("FOREIGN_PAGE");
			}
			if (pageInfo === null || aliasInfo === null || !sameFile(pageInfo, aliasInfo)) {
				// Recover a crash after the alias header committed but before its dated
				// link appeared. Preserve that inode before changing aliases.
				if (aliasInfo !== null && aliasHeader !== null) {
					const oldPage = join(directory, `${aliasHeader.day}.jsonl`), oldInfo = privateFile(oldPage);
					if (oldInfo === null) linkSync(alias, oldPage);
					else if (!sameFile(oldInfo, aliasInfo)) throw new Error("ALIAS_PAGE_CONFLICT");
				}
				expireOwnedPages(directory, today, pageInfo === null && aliasHeader?.day !== day);
				if (pageInfo === null && aliasHeader?.day === day) {
					pageInfo = privateFile(page);
					if (pageInfo === null) throw new Error("ALIAS_INCOMPLETE");
				} else {
					if (aliasInfo !== null) unlinkSync(alias);
					if (pageInfo !== null) linkSync(page, alias);
					else {
						await appendJsonl(alias, () => ({ schema: 1, producer: PRODUCER, day }),
							{ deadline_s: 1, durable: true, state_dir: stateRoot });
						linkSync(alias, page);
					}
				}
				aliasInfo = privateFile(alias); aliasHeader = ownedHeader(alias);
				if (aliasInfo === null || aliasHeader?.day !== day) throw new Error("ALIAS_INCOMPLETE");
			}
			let capacity = false;
			await appendJsonl(alias, state => {
				if (state.size + ACTIVITY_MAX_EVENT_BYTES > ACTIVITY_MAX_DAY_BYTES) throw new Error("DAY_CAPACITY");
				if (state.size + 2 * ACTIVITY_MAX_EVENT_BYTES > ACTIVITY_MAX_DAY_BYTES) {
					capacity = true;
					return { schema: 1, kind: "loss", id: event.id, sequence: event.sequence,
						identity: event.identity, clock: event.clock, reason: "DAY_CAPACITY", lost_events: 1 } satisfies ActivityEvent;
				}
				return event;
			}, { deadline_s: 1, durable: true, state_dir: stateRoot });
			return { appended: !capacity, problem: capacity ? "DAY_CAPACITY" : null };
		} finally { rotation.release(); }
	} catch (error) {
		const message = error instanceof Error ? error.message : "APPEND_FAILED";
		return { appended: false, problem: message.includes("DAY_CAPACITY") ? "DAY_CAPACITY"
			: message.includes("TORN_TAIL") ? "TORN_TAIL" : "ACTIVITY_APPEND_INCOMPLETE" };
	}
}

export function readActivityJournal(stateRoot: string | null, nowMs = Date.now()): ActivityJournalRead {
	const result: ActivityJournalRead = { records: [], complete: true, problems: [], bytes_read: 0, pages_read: 0 };
	const problems = new Set<string>();
	if (stateRoot === null || !Number.isSafeInteger(nowMs) || nowMs < 0) {
		result.complete = false; result.problems = ["ACTIVITY_SOURCE_UNAVAILABLE"]; return result;
	}
	let directory: string;
	try { directory = stateDirectory(stateRoot, false); }
	catch { result.complete = false; result.problems = ["ACTIVITY_SOURCE_MISSING_OR_UNSAFE"]; return result; }
	const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
	const pages: { name: string; day: number }[] = [];
	let dir: Dir | null = null;
	try {
		dir = opendirSync(directory);
		for (let count = 0; ; count++) {
			const entry = dir.readSync();
			if (entry === null) break;
			if (count >= ACTIVITY_MAX_FILES + 4) { problems.add("DIRECTORY_LIMIT"); break; }
			if (entry.name === ALIAS) continue;
			const day = pageDay(entry.name);
			if (!entry.isFile() || day === null) { problems.add("UNRECOGNIZED_ACTIVITY_PAGE"); continue; }
			if (day < today - ACTIVITY_RETENTION_DAYS * DAY_MS) { problems.add("ACTIVITY_RETENTION_UNRESOLVED"); continue; }
			if (day > today) { problems.add("FUTURE_ACTIVITY_PAGE"); continue; }
			pages.push({ name: entry.name, day });
		}
	} catch { problems.add("ACTIVITY_DIRECTORY_INCOMPLETE"); }
	finally { dir?.closeSync(); }
	let aliasInfo: Stats | null = null, aliasMatched = false;
	try {
		aliasInfo = privateFile(join(directory, ALIAS));
		if (aliasInfo === null) problems.add("ACTIVITY_ALIAS_MISSING");
	} catch { problems.add("ACTIVITY_ALIAS_UNSAFE"); }
	pages.sort((a, b) => a.day - b.day);
	if (pages.length > ACTIVITY_MAX_FILES) problems.add("PAGE_LIMIT");
	let decoded = 0;
	for (let index = 0; index < Math.min(pages.length, ACTIVITY_MAX_FILES); index++) {
		const page = pages[index]!, path = join(directory, page.name);
		let cursor: JsonlCursor | null = null, first = true;
		try {
			const info = privateFile(path);
			if (info === null) { problems.add("ACTIVITY_PAGE_MISSING"); continue; }
			if (aliasInfo !== null && sameFile(info, aliasInfo)) aliasMatched = true;
			if (info.size >= ACTIVITY_MAX_DAY_BYTES - 2 * ACTIVITY_MAX_EVENT_BYTES) problems.add("ACTIVITY_DAY_CAPACITY");
			result.pages_read++;
			for (;;) {
				const remaining = ACTIVITY_MAX_READ_BYTES - result.bytes_read;
				if (remaining <= 0 || decoded >= ACTIVITY_MAX_RECORDS) { problems.add("ACTIVITY_READ_LIMIT"); break; }
				const length = Math.min(CHUNK_BYTES, remaining), previousOffset = cursor?.offset ?? 0;
				const read = readJsonl(path, { maxBytes: length, fromCursor: cursor });
				const offsetBase = read.reset === null ? previousOffset : 0;
				result.bytes_read += read.more ? length : Math.max(0, (read.cursor?.offset ?? offsetBase) - offsetBase) + read.pending_tail_bytes;
				if (read.missing || read.reset !== null || read.cursor?.dev !== info.dev || read.cursor?.ino !== info.ino) {
					problems.add("ACTIVITY_PAGE_REPLACED"); break;
				}
				if (read.errors.length > 0 || read.pending_tail_bytes > 0) problems.add("ACTIVITY_PAGE_INCOMPLETE");
				for (const row of read.rows) {
					if (++decoded > ACTIVITY_MAX_RECORDS) { problems.add("ACTIVITY_RECORD_LIMIT"); break; }
					if (first) {
						if (!header(row) || row.day !== page.name.slice(0, 10) || read.errors.some(error => error.line === 1)) {
							problems.add("ACTIVITY_PAGE_HEADER_INVALID");
							throw new Error("ACTIVITY_PAGE_HEADER_INVALID");
						}
						first = false;
						continue;
					}
					if (!isActivityEvent(row)) { problems.add("INVALID_ACTIVITY_EVENT"); continue; }
					result.records.push(row);
				}
				const after = privateFile(path);
				if (after === null || !sameFile(info, after)) { problems.add("ACTIVITY_PAGE_REPLACED"); break; }
				if (!read.more) {
					if (after.size > (read.cursor?.offset ?? 0) + read.pending_tail_bytes) problems.add("ACTIVITY_PAGE_CHANGED_DURING_READ");
					break;
				}
				if (read.cursor === null || read.cursor.offset <= previousOffset) { problems.add("ACTIVITY_RECORD_EXCEEDS_WINDOW"); break; }
				cursor = read.cursor;
			}
			if (first) problems.add("ACTIVITY_PAGE_HEADER_MISSING");
		} catch { problems.add("ACTIVITY_PAGE_UNREADABLE_OR_UNSAFE"); }
		if (result.bytes_read >= ACTIVITY_MAX_READ_BYTES || decoded >= ACTIVITY_MAX_RECORDS) break;
	}
	if (aliasInfo !== null && !aliasMatched) problems.add(result.pages_read < pages.length
		? "ACTIVITY_ALIAS_UNVERIFIED" : "ACTIVITY_ALIAS_NOT_LINKED_TO_PAGE");
	if (result.records.length === 0) problems.add("ACTIVITY_JOURNAL_EMPTY");
	result.complete = problems.size === 0;
	result.problems = [...problems];
	return result;
}
