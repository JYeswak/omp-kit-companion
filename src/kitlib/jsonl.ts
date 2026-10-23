/**
 * kitlib jsonl: the kit's one locked, complete-write JSONL append and bounded reader for TypeScript
 * (ompkit-ibgvg, KL11).
 *
 * `appendJsonl()` / `readJsonl()` are the TypeScript half of a two-language contract;
 * `scripts/kitlib_jsonl.py` `append_jsonl()` / `read_jsonl()` is the Python half, and both pass the one
 * conformance corpus `tests/fixtures/kitlib-jsonl/corpus.json` (`tests/cli/kitlib-jsonl.test.ts`,
 * `tests/scripts/kitlib_jsonl_test.py`). Both serialize through the KL08 `privateLock` on
 * `{ namespace: "kitlib-jsonl", path }`, so a TypeScript and a Python writer exclude each other.
 *
 * Append, in order, all under the lock:
 * 1. the target (absolute, normalized) is opened O_APPEND|O_NOFOLLOW; a new file is created O_EXCL and
 *    fchmod'ed to `mode` (a subset of 0o644, default 0o600); an existing file's mode is left alone; a
 *    symlink or non-regular file is UNSAFE_PATH;
 * 2. the tail is checked: a non-empty file whose last byte is not "\n" has a torn last line. `tornTail`
 *    "refuse" (default) refuses TORN_TAIL with evidence (size, last bytes); "newline" prepends "\n" so the
 *    new record starts on its own line and the torn bytes stay as evidence. Nothing is ever truncated or
 *    repaired; repair policy belongs to the owning ledger;
 * 3. `build(state)` runs (it may be async) and returns the record. Domain validation and idempotency live
 *    there; a throw is BUILD_FAILED and nothing is written. The record is serialized compactly
 *    (JSON.stringify); a value that does not serialize is INVALID_RECORD;
 * 4. the path must still name the opened inode, else INODE_REPLACED (nothing written);
 * 5. the whole line is written with a complete-write loop; a write that makes no progress is
 *    NO_PROGRESS, an errno is WRITE_FAILED (both with `written` bytes in evidence: a partial line then
 *    shows as a torn tail to the next append);
 * 6. `durable` fsyncs the file; a failed fsync is SYNC_FAILED (the bytes are appended, `durable` false).
 *    The result reports `durable: true` only after the sync returned.
 * A lock timeout is the KL08 `PrivateLockError` with code DEADLINE, unchanged.
 *
 * `readJsonl(path, { maxBytes, fromCursor })` reads at most `maxBytes` from the cursor (default 0) and
 * returns only complete lines: `rows` (parsed values), `errors` (line number, byte offset, reason,
 * excerpt; invalid JSON, invalid UTF-8, blank lines and lines longer than `maxBytes` are never skipped
 * silently), `cursor` `{dev, ino, offset, line}` to resume from, `more` (bytes remain past the window),
 * `pending_tail_bytes` (an unterminated last line, not consumed) and `reset`: "rotated" when the path
 * names another inode than the cursor, "truncated" when the cursor lies beyond EOF; both restart at 0.
 * A missing file returns `missing: true` and no cursor.
 *
 * Out of scope: multi-file atomicity, exactly-once (the caller's `build`), and the stronger lease
 * protocol of append-safe-write, which sits above this. POSIX only.
 */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync, type Stats } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { privateLock } from "./lock.ts";

export const TORN_TAIL_POLICIES = ["refuse", "newline"] as const;
export type TornTailPolicy = typeof TORN_TAIL_POLICIES[number];
export type JsonlErrorCode =
	| "INVALID_ARGUMENT" | "UNSAFE_PATH" | "TORN_TAIL" | "BUILD_FAILED" | "INVALID_RECORD" | "INODE_REPLACED"
	| "NO_PROGRESS" | "WRITE_FAILED" | "SYNC_FAILED" | "IO_ERROR";
export type JsonlEvidence = { code: JsonlErrorCode; path: string } & Record<string, unknown>;

export class JsonlError extends Error {
	readonly code: JsonlErrorCode;
	readonly evidence: JsonlEvidence;
	constructor(evidence: JsonlEvidence, options?: { cause?: unknown }) {
		super(`kitlib-jsonl: ${evidence.code} ${evidence.path}`, options);
		this.name = "JsonlError";
		this.code = evidence.code;
		this.evidence = evidence;
	}
}

/** What `build` sees, observed under the lock. */
export interface AppendState {
	path: string;
	size: number;
	created: boolean;
	torn: boolean;
}
export interface AppendOptions {
	/** Bounded lock wait in seconds (KL08). Required. */
	deadline_s: number;
	tornTail?: TornTailPolicy;
	/** fsync the file before reporting. */
	durable?: boolean;
	/** Exact mode of a newly created file, a subset of 0o644; default 0o600. */
	mode?: number;
	/** Absolute lock state root (KL08 `state_dir`). */
	state_dir?: string;
}
export interface AppendResult {
	path: string;
	offset: number;
	bytes: number;
	created: boolean;
	torn_prefixed: boolean;
	durable: boolean;
	waited_s: number;
}
export interface JsonlCursor {
	dev: number;
	ino: number;
	offset: number;
	line: number;
}
export interface JsonlRowError {
	line: number;
	offset: number;
	reason: "INVALID_JSON" | "INVALID_UTF8" | "BLANK_LINE" | "LINE_EXCEEDS_MAX_BYTES";
	excerpt: string;
}
export interface ReadResult {
	rows: unknown[];
	errors: JsonlRowError[];
	cursor: JsonlCursor | null;
	reset: "rotated" | "truncated" | null;
	more: boolean;
	pending_tail_bytes: number;
	missing: boolean;
}

const MODE_MASK = 0o644;
const TAIL_EVIDENCE_BYTES = 64;
const EXCERPT_CHARS = 120;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/** Test-only seam: plants and detector bypasses for the conformance corpus. Production code never sets it. */
export const __testing: {
	disabled: Set<string>;
	write: ((fd: number, buffer: Buffer, offset: number, length: number) => number) | undefined;
	fsync: ((fd: number) => void) | undefined;
	beforeWrite: ((path: string) => void) | undefined;
} = { disabled: new Set(), write: undefined, fsync: undefined, beforeWrite: undefined };

const on = (detector: string) => !__testing.disabled.has(detector);

function checkPath(path: unknown): string {
	if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || normalize(path) !== path || path.endsWith("/")) {
		throw new JsonlError({ code: "UNSAFE_PATH", path: String(path), reason: "path must be absolute and normalized" });
	}
	return path;
}

function errnoOf(error: unknown): string {
	return (error as NodeJS.ErrnoException)?.code ?? String(error);
}

function openTarget(path: string, mode: number): { fd: number; created: boolean } {
	const base = constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW;
	let fd: number;
	let created = false;
	try {
		fd = openSync(path, base | constants.O_CREAT | constants.O_EXCL, 0o600);
		created = true;
	} catch (error) {
		const code = errnoOf(error);
		if (code !== "EEXIST") {
			if (code === "ELOOP") throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "symlink" });
			throw new JsonlError({ code: "IO_ERROR", path, step: "create", errno: code });
		}
		try {
			fd = openSync(path, base);
		} catch (inner) {
			const innerCode = errnoOf(inner);
			if (innerCode === "ELOOP") throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "symlink" });
			if (innerCode === "EISDIR") throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "not a regular file" });
			throw new JsonlError({ code: "IO_ERROR", path, step: "open", errno: innerCode });
		}
	}
	try {
		if (!fstatSync(fd).isFile()) throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "not a regular file" });
		if (created) fchmodSync(fd, mode);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return { fd, created };
}

function readTail(fd: number, size: number): Buffer {
	const length = Math.min(size, TAIL_EVIDENCE_BYTES);
	const buffer = Buffer.alloc(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buffer, got, length - got, size - length + got);
		if (n === 0) break;
		got += n;
	}
	return buffer.subarray(0, got);
}

/** Append one record as a complete line under the KL08 lock; see the module header. */
export async function appendJsonl(path: string, build: (state: AppendState) => unknown, options: AppendOptions): Promise<AppendResult> {
	if (typeof build !== "function") throw new JsonlError({ code: "INVALID_ARGUMENT", path: String(path), reason: "build must be a function" });
	if (options === null || typeof options !== "object") throw new JsonlError({ code: "INVALID_ARGUMENT", path: String(path), reason: "options with deadline_s are required" });
	const tornTail = options.tornTail ?? "refuse";
	if (!TORN_TAIL_POLICIES.includes(tornTail)) throw new JsonlError({ code: "INVALID_ARGUMENT", path: String(path), reason: `tornTail must be one of ${TORN_TAIL_POLICIES.join(", ")}` });
	const durable = options.durable ?? false;
	if (typeof durable !== "boolean") throw new JsonlError({ code: "INVALID_ARGUMENT", path: String(path), reason: "durable must be a boolean" });
	const mode = options.mode ?? 0o600;
	if (!Number.isInteger(mode) || (mode & ~MODE_MASK) !== 0) throw new JsonlError({ code: "INVALID_ARGUMENT", path: String(path), reason: "mode must be a subset of 0o644" });
	checkPath(path);

	const lock = await privateLock({ namespace: "kitlib-jsonl", path }, { deadline_s: options.deadline_s, state_dir: options.state_dir });
	try {
		const { fd, created } = openTarget(path, mode);
		try {
			const opened = fstatSync(fd);
			const size = opened.size;
			const tail = size > 0 ? readTail(fd, size) : Buffer.alloc(0);
			const torn = tail.length > 0 && tail[tail.length - 1] !== 0x0a;
			if (torn && tornTail === "refuse" && on("torn-tail")) {
				throw new JsonlError({ code: "TORN_TAIL", path, size, tail: tail.toString("utf8"), tail_bytes: tail.length });
			}
			const prefix = torn && tornTail === "newline";

			let record: unknown;
			try {
				record = await build({ path, size, created, torn });
			} catch (error) {
				if (on("build")) throw new JsonlError({ code: "BUILD_FAILED", path, message: error instanceof Error ? error.message : String(error) }, { cause: error });
				record = null;
			}
			let text: string | undefined;
			try {
				text = JSON.stringify(record);
			} catch (error) {
				throw new JsonlError({ code: "INVALID_RECORD", path, message: error instanceof Error ? error.message : String(error) }, { cause: error });
			}
			if (text === undefined) throw new JsonlError({ code: "INVALID_RECORD", path, message: "record does not serialize to JSON" });
			const line = Buffer.from(`${prefix ? "\n" : ""}${text}\n`, "utf8");

			__testing.beforeWrite?.(path);
			let now: Stats | undefined;
			try { now = lstatSync(path); } catch { now = undefined; }
			if ((now === undefined || now.dev !== opened.dev || now.ino !== opened.ino) && on("inode")) {
				throw new JsonlError({ code: "INODE_REPLACED", path, dev: opened.dev, ino: opened.ino, now_ino: now?.ino ?? null });
			}

			const offset = fstatSync(fd).size;
			const write = __testing.write ?? ((f: number, b: Buffer, o: number, l: number) => writeSync(f, b, o, l));
			let written = 0;
			while (written < line.length) {
				let n: number;
				try {
					n = write(fd, line, written, line.length - written);
				} catch (error) {
					throw new JsonlError({ code: "WRITE_FAILED", path, errno: errnoOf(error), written, bytes: line.length });
				}
				if (n <= 0) {
					if (on("progress")) throw new JsonlError({ code: "NO_PROGRESS", path, written, bytes: line.length });
					break;
				}
				written += n;
			}

			let synced = false;
			if (durable) {
				try {
					(__testing.fsync ?? fsyncSync)(fd);
					synced = true;
				} catch (error) {
					if (on("sync")) throw new JsonlError({ code: "SYNC_FAILED", path, errno: errnoOf(error), written, durable: false });
					synced = true;
				}
			}
			return { path, offset, bytes: written, created, torn_prefixed: prefix, durable: synced, waited_s: lock.waited_s };
		} finally {
			closeSync(fd);
		}
	} finally {
		lock.release();
	}
}

function excerpt(bytes: Buffer): string {
	return bytes.toString("utf8").slice(0, EXCERPT_CHARS);
}

/** Read complete JSONL lines from a cursor, bounded by `maxBytes`; see the module header. */
export function readJsonl(path: string, options: { maxBytes?: number; fromCursor?: JsonlCursor | null } = {}): ReadResult {
	checkPath(path);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new JsonlError({ code: "INVALID_ARGUMENT", path, reason: "maxBytes must be a positive integer" });
	const from = options.fromCursor ?? null;
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT") return { rows: [], errors: [], cursor: null, reset: from === null ? null : "rotated", more: false, pending_tail_bytes: 0, missing: true };
		if (code === "ELOOP") throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "symlink" });
		throw new JsonlError({ code: "IO_ERROR", path, step: "open", errno: code });
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw new JsonlError({ code: "UNSAFE_PATH", path, reason: "not a regular file" });
		let offset = 0, line = 0;
		let reset: ReadResult["reset"] = null;
		if (from !== null) {
			if (from.dev !== info.dev || from.ino !== info.ino) reset = "rotated";
			else if (from.offset > info.size) reset = "truncated";
			else { offset = from.offset; line = from.line; }
		}
		const length = Math.min(maxBytes, info.size - offset);
		const buffer = Buffer.alloc(length);
		let got = 0;
		while (got < length) {
			const n = readSync(fd, buffer, got, length - got, offset + got);
			if (n === 0) break;
			got += n;
		}
		const window = buffer.subarray(0, got);
		const rows: unknown[] = [];
		const errors: JsonlRowError[] = [];
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let start = 0;
		for (;;) {
			const end = window.indexOf(0x0a, start);
			if (end < 0) break;
			line += 1;
			const bytes = window.subarray(start, end);
			const at = offset + start;
			start = end + 1;
			if (bytes.length === 0) { errors.push({ line, offset: at, reason: "BLANK_LINE", excerpt: "" }); continue; }
			let text: string;
			try { text = decoder.decode(bytes); } catch { errors.push({ line, offset: at, reason: "INVALID_UTF8", excerpt: excerpt(bytes) }); continue; }
			if (text.trim() === "") { errors.push({ line, offset: at, reason: "BLANK_LINE", excerpt: text.slice(0, EXCERPT_CHARS) }); continue; }
			try { rows.push(JSON.parse(text)); } catch { errors.push({ line, offset: at, reason: "INVALID_JSON", excerpt: text.slice(0, EXCERPT_CHARS) }); }
		}
		const consumed = offset + start;
		const remaining = info.size - consumed;
		const windowFull = got === maxBytes && offset + got < info.size;
		if (start === 0 && got === maxBytes && remaining > 0) {
			errors.push({ line: line + 1, offset: consumed, reason: "LINE_EXCEEDS_MAX_BYTES", excerpt: excerpt(window) });
		}
		return {
			rows, errors, cursor: { dev: info.dev, ino: info.ino, offset: consumed, line }, reset,
			more: windowFull, pending_tail_bytes: windowFull ? 0 : remaining, missing: false,
		};
	} finally {
		closeSync(fd);
	}
}
