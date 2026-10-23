/**
 * kitlib artifact: the kit's one bounded, strict local artifact reader and strict JSON/JSONL decoder for
 * TypeScript (ompkit-gvp4j, KL10).
 *
 * `readLocalArtifact()` / `strictJson()` / `strictJsonl()` / `rejectUnknownFields()` are the TypeScript half
 * of a two-language contract; `scripts/kitlib_artifact.py` `read_local_artifact()` / `strict_json()` /
 * `strict_jsonl()` / `reject_unknown_fields()` is the Python half, and both pass the one conformance corpus
 * `tests/fixtures/kitlib-artifact/corpus.json` (`tests/cli/kitlib-artifact.test.ts`,
 * `tests/scripts/kitlib_artifact_test.py`).
 *
 * `readLocalArtifact(path, { allowedRoot, maxBytes, filePolicy, distinctFrom })` checks, in order, before
 * returning any byte (every refusal an `ArtifactError` with `code` and `evidence`):
 * 1. a URL-like string (`scheme:` such as `file:` or `https://`) is NOT_A_PATH;
 * 2. the path must be absolute, normalized and lexically inside `allowedRoot`, else OUTSIDE_ROOT;
 * 3. a missing path (or a dangling link) is MISSING;
 * 4. a symlink at the path is SYMLINK unless `filePolicy.symlinks` is "follow";
 * 5. the realpath must lie inside realpath(`allowedRoot`), else OUTSIDE_ROOT (a symlinked directory
 *    component escaping the root lands here);
 * 6. the realpath is opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK (a FIFO never blocks); not a regular file is
 *    NOT_REGULAR; when symlinks are refused the opened inode must be the one lstat saw, else SYMLINK;
 * 7. `nlink > 1` is HARDLINK unless `filePolicy.hardlinks` is "allow";
 * 8. the opened inode equal to any existing `distinctFrom` path (for example the caller's output) is
 *    COLLISION: reader-side output collision, the input must never alias an output;
 * 9. the read itself is bounded: at most `maxBytes + 1` bytes are read, and more than `maxBytes` is
 *    TOO_LARGE (a size precheck alone does not bound allocation);
 * 10. zero bytes is EMPTY; a byte count that differs from fstat's size is CORRUPT (changed while read).
 * MISSING, EMPTY and CORRUPT are separate outcomes. The result is `{bytes, path, realpath, dev, ino, size,
 * sha256}`.
 *
 * `strictJson(bytes, { path })` decodes one document with its own parser (never `JSON.parse`, which keeps
 * the last duplicate silently). A refusal is an `ArtifactError` with code CORRUPT whose evidence carries
 * `path`, `line`, `column` (1-based, UTF-8 bytes), `offset` (bytes) and `reason`: INVALID_UTF8,
 * DUPLICATE_KEY (at any depth), NONFINITE (NaN, Infinity, -Infinity, or a number that overflows),
 * TRAILING_GARBAGE, DEPTH (deeper than `maxDepth`, default 512) or SYNTAX.
 *
 * `strictJsonl(bytes, { path, maxRows, maxRowBytes, validate })` runs every row through the strict decoder
 * and returns `{rows: [{line, value}], errors: [{path, line, column, offset, reason, message}]}`; no row is
 * ever dropped silently: BLANK_LINE, ROW_TOO_LARGE, TRUNCATED_ROW (an unterminated last row),
 * TOO_MANY_ROWS (the first row past `maxRows`; nothing after it is read), EMPTY (no bytes) and the
 * owner's VALIDATION findings are errors, each with the original path and line. Domain validation stays
 * with the owner: `validate(value)` returns messages; `rejectUnknownFields(row, allowed)` is the helper
 * an owner's validator calls when it wants unknown-field refusal. There is no universal schema.
 *
 * Out of scope: writers (output collision on write, overwrite policy) and domain schemas. POSIX only.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export type ArtifactErrorCode =
	| "INVALID_ARGUMENT" | "NOT_A_PATH" | "OUTSIDE_ROOT" | "MISSING" | "SYMLINK" | "NOT_REGULAR" | "HARDLINK"
	| "COLLISION" | "TOO_LARGE" | "EMPTY" | "CORRUPT" | "IO_ERROR";
export type JsonReason = "INVALID_UTF8" | "DUPLICATE_KEY" | "NONFINITE" | "TRAILING_GARBAGE" | "DEPTH" | "SYNTAX";
export type JsonlReason = JsonReason | "BLANK_LINE" | "ROW_TOO_LARGE" | "TRUNCATED_ROW" | "TOO_MANY_ROWS" | "EMPTY" | "VALIDATION";
export type ArtifactEvidence = { code: ArtifactErrorCode; path: string } & Record<string, unknown>;

export class ArtifactError extends Error {
	readonly code: ArtifactErrorCode;
	readonly evidence: ArtifactEvidence;
	constructor(evidence: ArtifactEvidence, options?: { cause?: unknown }) {
		super(`kitlib-artifact: ${evidence.code} ${evidence.path}${evidence.reason ? ` (${String(evidence.reason)})` : ""}`, options);
		this.name = "ArtifactError";
		this.code = evidence.code;
		this.evidence = evidence;
	}
}

export interface FilePolicy {
	symlinks?: "refuse" | "follow";
	hardlinks?: "refuse" | "allow";
}
export interface ReadArtifactOptions {
	allowedRoot: string;
	maxBytes: number;
	filePolicy?: FilePolicy;
	/** Paths (typically outputs) the artifact must not be the same inode as. */
	distinctFrom?: string[];
}
export interface LocalArtifact {
	bytes: Uint8Array;
	path: string;
	realpath: string;
	dev: number;
	ino: number;
	size: number;
	sha256: string;
}
export interface JsonlRow { line: number; value: unknown }
export interface JsonlRowError {
	path: string;
	line: number;
	column: number;
	offset: number;
	reason: JsonlReason;
	message: string;
}
export interface StrictJsonlResult { rows: JsonlRow[]; errors: JsonlRowError[] }
export interface StrictJsonlOptions {
	path: string;
	maxRows?: number;
	maxRowBytes?: number;
	maxDepth?: number;
	validate?: (value: unknown) => string[];
}

export const DEFAULT_MAX_DEPTH = 512;
const CHUNK = 64 * 1024;

/** Test-only seam: detector bypasses for the conformance corpus. Production code never sets it. */
export const __testing: { disabled: Set<string> } = { disabled: new Set() };
const on = (detector: string) => !__testing.disabled.has(detector);

function errnoOf(error: unknown): string {
	return (error as NodeJS.ErrnoException)?.code ?? String(error);
}

/** `scheme:` with an RFC 3986 scheme (ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )); no regex. */
export function isUrlLike(value: string): boolean {
	const text = value.trim();
	const first = text.charCodeAt(0);
	if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
	for (let i = 1; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c === 58) return true;
		const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46;
		if (!ok) return false;
	}
	return false;
}

function inside(child: string, root: string): boolean {
	return child === root || child.startsWith(root === "/" ? "/" : `${root}/`);
}

function normalizedAbsolute(path: string): boolean {
	return !path.includes("\0") && isAbsolute(path) && normalize(path) === path && (path === "/" || !path.endsWith("/"));
}

/** Read one bounded local artifact under the root and file policy; see the module header. */
export function readLocalArtifact(path: string, options: ReadArtifactOptions): LocalArtifact {
	if (typeof path !== "string") throw new ArtifactError({ code: "INVALID_ARGUMENT", path: String(path), reason: "path must be a string" });
	if (options === null || typeof options !== "object") throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "options are required" });
	const { allowedRoot, maxBytes } = options;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "maxBytes must be a positive integer" });
	if (typeof allowedRoot !== "string" || !normalizedAbsolute(allowedRoot)) throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "allowedRoot must be absolute and normalized" });
	const symlinks = options.filePolicy?.symlinks ?? "refuse";
	const hardlinks = options.filePolicy?.hardlinks ?? "refuse";
	if (symlinks !== "refuse" && symlinks !== "follow") throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "filePolicy.symlinks must be refuse or follow" });
	if (hardlinks !== "refuse" && hardlinks !== "allow") throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "filePolicy.hardlinks must be refuse or allow" });
	let rootReal: string;
	try {
		rootReal = realpathSync(allowedRoot);
		if (!lstatSync(rootReal).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "allowedRoot must be an existing directory", allowed_root: allowedRoot });
	}

	if (isUrlLike(path) && on("url")) throw new ArtifactError({ code: "NOT_A_PATH", path, reason: "URL-like value is not a local path" });
	if (!normalizedAbsolute(path)) throw new ArtifactError({ code: "OUTSIDE_ROOT", path, reason: "path must be absolute and normalized" });
	if (!inside(path, allowedRoot) && on("root")) throw new ArtifactError({ code: "OUTSIDE_ROOT", path, reason: "path is outside allowedRoot", allowed_root: allowedRoot });

	let link: Stats;
	try {
		link = lstatSync(path);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") throw new ArtifactError({ code: "MISSING", path });
		throw new ArtifactError({ code: "IO_ERROR", path, step: "lstat", errno: code });
	}
	if (link.isSymbolicLink() && symlinks === "refuse" && on("symlink")) throw new ArtifactError({ code: "SYMLINK", path, reason: "symlink refused by filePolicy" });
	let real: string;
	try {
		real = realpathSync(path);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT" || code === "ENOTDIR") throw new ArtifactError({ code: "MISSING", path, reason: "dangling link" });
		throw new ArtifactError({ code: "IO_ERROR", path, step: "realpath", errno: code });
	}
	if (!inside(real, rootReal) && on("root")) throw new ArtifactError({ code: "OUTSIDE_ROOT", path, realpath: real, reason: "realpath is outside allowedRoot", allowed_root: rootReal });

	let fd: number;
	try {
		fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		const code = errnoOf(error);
		if (code === "ENOENT") throw new ArtifactError({ code: "MISSING", path, reason: "vanished before open" });
		if (code === "ELOOP") throw new ArtifactError({ code: "SYMLINK", path, reason: "replaced by a symlink before open" });
		throw new ArtifactError({ code: "IO_ERROR", path, step: "open", errno: code });
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile() && on("regular")) throw new ArtifactError({ code: "NOT_REGULAR", path, reason: "not a regular file" });
		if (symlinks === "refuse" && !link.isSymbolicLink() && (info.dev !== link.dev || info.ino !== link.ino) && on("symlink")) {
			throw new ArtifactError({ code: "SYMLINK", path, reason: "path changed between lstat and open" });
		}
		if (info.nlink > 1 && hardlinks === "refuse" && on("hardlink")) throw new ArtifactError({ code: "HARDLINK", path, nlink: info.nlink });
		for (const other of options.distinctFrom ?? []) {
			let seen: Stats | undefined;
			try { seen = statSync(other); } catch { seen = undefined; }
			if (seen !== undefined && seen.dev === info.dev && seen.ino === info.ino && on("collision")) {
				throw new ArtifactError({ code: "COLLISION", path, other, reason: "artifact is the same inode as a distinct path" });
			}
		}
		const limit = on("bound") ? maxBytes + 1 : Number.MAX_SAFE_INTEGER;
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const want = Math.min(CHUNK, limit - total);
			if (want <= 0) break;
			const chunk = Buffer.allocUnsafe(want);
			let n: number;
			try {
				n = readSync(fd, chunk, 0, want, total);
			} catch (error) {
				const code = errnoOf(error);
				throw new ArtifactError({ code: "IO_ERROR", path, step: "read", errno: code });
			}
			if (n === 0) break;
			chunks.push(chunk.subarray(0, n));
			total += n;
		}
		if (total > maxBytes && on("bound")) throw new ArtifactError({ code: "TOO_LARGE", path, max_bytes: maxBytes, read_bytes: total });
		if (total === 0 && on("empty")) throw new ArtifactError({ code: "EMPTY", path });
		if (total !== info.size) throw new ArtifactError({ code: "CORRUPT", path, reason: "changed while being read", size: info.size, read_bytes: total });
		const bytes = Buffer.concat(chunks, total);
		return {
			bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length),
			path, realpath: real, dev: info.dev, ino: info.ino, size: total,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	} finally {
		closeSync(fd);
	}
}

/** Offset of the first byte that starts an invalid UTF-8 sequence, or -1. */
export function firstInvalidUtf8(bytes: Uint8Array, start = 0, end = bytes.length): number {
	let i = start;
	while (i < end) {
		const b = bytes[i]!;
		if (b < 0x80) { i += 1; continue; }
		let need: number, max = 0xbf, lo = 0x80;
		if (b >= 0xc2 && b <= 0xdf) need = 1;
		else if (b >= 0xe0 && b <= 0xef) { need = 2; if (b === 0xe0) lo = 0xa0; if (b === 0xed) max = 0x9f; }
		else if (b >= 0xf0 && b <= 0xf4) { need = 3; if (b === 0xf0) lo = 0x90; if (b === 0xf4) max = 0x8f; }
		else return i;
		for (let k = 1; k <= need; k++) {
			const c = i + k < end ? bytes[i + k]! : -1;
			const low = k === 1 ? lo : 0x80, high = k === 1 ? max : 0xbf;
			if (c < low || c > high) return i;
		}
		i += need + 1;
	}
	return -1;
}

function position(bytes: Uint8Array, offset: number, base: number): { line: number; column: number } {
	let line = 1, lineStart = base;
	for (let i = base; i < offset; i++) if (bytes[i] === 0x0a) { line += 1; lineStart = i + 1; }
	return { line, column: offset - lineStart + 1 };
}

class Fail {
	constructor(readonly at: number, readonly reason: JsonReason, readonly message: string) {}
}

class Parser {
	i = 0;
	constructor(readonly text: string, readonly maxDepth: number) {}

	fail(reason: JsonReason, message: string, at = this.i): never { throw new Fail(at, reason, message); }

	ws(): void {
		const t = this.text;
		while (this.i < t.length) {
			const c = t.charCodeAt(this.i);
			if (c === 32 || c === 9 || c === 10 || c === 13) this.i += 1;
			else break;
		}
	}

	document(): unknown {
		this.ws();
		const value = this.value(0);
		this.ws();
		if (this.i < this.text.length && on("trailing")) this.fail("TRAILING_GARBAGE", "data after the JSON value");
		return value;
	}

	value(depth: number): unknown {
		const t = this.text;
		if (this.i >= t.length) this.fail("SYNTAX", "unexpected end of input");
		const c = t[this.i]!;
		if (c === "{" || c === "[") {
			if (depth >= this.maxDepth) this.fail("DEPTH", `nesting deeper than ${this.maxDepth}`);
			return c === "{" ? this.object(depth + 1) : this.array(depth + 1);
		}
		if (c === "\"") return this.string();
		for (const [token, value] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]] as const) {
			if (t.startsWith(token, this.i)) {
				if (on("nonfinite")) this.fail("NONFINITE", `${token} is not JSON`);
				this.i += token.length;
				return value;
			}
		}
		if (c === "-" || (c >= "0" && c <= "9")) return this.number();
		for (const [token, value] of [["true", true], ["false", false], ["null", null]] as const) {
			if (t.startsWith(token, this.i)) { this.i += token.length; return value; }
		}
		return this.fail("SYNTAX", `unexpected character ${JSON.stringify(c)}`);
	}

	object(depth: number): Record<string, unknown> {
		const t = this.text;
		const out: Record<string, unknown> = {};
		const seen = new Set<string>();
		this.i += 1;
		this.ws();
		if (t[this.i] === "}") { this.i += 1; return out; }
		for (;;) {
			this.ws();
			if (t[this.i] !== "\"") this.fail("SYNTAX", "expected a string key");
			const keyAt = this.i;
			const key = this.string();
			if (seen.has(key) && on("duplicate-key")) this.fail("DUPLICATE_KEY", `duplicate key ${JSON.stringify(key)}`, keyAt);
			seen.add(key);
			this.ws();
			if (t[this.i] !== ":") this.fail("SYNTAX", "expected ':'");
			this.i += 1;
			this.ws();
			const value = this.value(depth);
			Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
			this.ws();
			if (t[this.i] === ",") { this.i += 1; continue; }
			if (t[this.i] === "}") { this.i += 1; return out; }
			this.fail("SYNTAX", "expected ',' or '}'");
		}
	}

	array(depth: number): unknown[] {
		const t = this.text;
		const out: unknown[] = [];
		this.i += 1;
		this.ws();
		if (t[this.i] === "]") { this.i += 1; return out; }
		for (;;) {
			this.ws();
			out.push(this.value(depth));
			this.ws();
			if (t[this.i] === ",") { this.i += 1; continue; }
			if (t[this.i] === "]") { this.i += 1; return out; }
			this.fail("SYNTAX", "expected ',' or ']'");
		}
	}

	string(): string {
		const t = this.text;
		this.i += 1;
		let out = "";
		let run = this.i;
		for (;;) {
			if (this.i >= t.length) this.fail("SYNTAX", "unterminated string");
			const c = t.charCodeAt(this.i);
			if (c === 34) { out += t.slice(run, this.i); this.i += 1; return out; }
			if (c < 0x20) this.fail("SYNTAX", "control character in string");
			if (c !== 92) { this.i += 1; continue; }
			out += t.slice(run, this.i);
			const e = t[this.i + 1];
			const simple: Record<string, string> = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
			if (e !== undefined && e in simple) { out += simple[e]; this.i += 2; }
			else if (e === "u") {
				const hex = t.slice(this.i + 2, this.i + 6);
				let code = 0;
				if (hex.length !== 4) this.fail("SYNTAX", "bad \\u escape");
				for (let k = 0; k < 4; k++) {
					const h = hex.charCodeAt(k);
					const d = h >= 48 && h <= 57 ? h - 48 : h >= 65 && h <= 70 ? h - 55 : h >= 97 && h <= 102 ? h - 87 : -1;
					if (d < 0) this.fail("SYNTAX", "bad \\u escape");
					code = code * 16 + d;
				}
				out += String.fromCharCode(code);
				this.i += 6;
			} else this.fail("SYNTAX", "bad escape");
			run = this.i;
		}
	}

	number(): number {
		const t = this.text;
		const start = this.i;
		const digit = () => this.i < t.length && t.charCodeAt(this.i) >= 48 && t.charCodeAt(this.i) <= 57;
		if (t[this.i] === "-") this.i += 1;
		if (t[this.i] === "0") this.i += 1;
		else if (digit()) while (digit()) this.i += 1;
		else this.fail("SYNTAX", "bad number");
		if (t[this.i] === ".") {
			this.i += 1;
			if (!digit()) this.fail("SYNTAX", "bad number");
			while (digit()) this.i += 1;
		}
		if (t[this.i] === "e" || t[this.i] === "E") {
			this.i += 1;
			if (t[this.i] === "+" || t[this.i] === "-") this.i += 1;
			if (!digit()) this.fail("SYNTAX", "bad number");
			while (digit()) this.i += 1;
		}
		const value = Number(t.slice(start, this.i));
		if (!Number.isFinite(value) && on("nonfinite")) this.fail("NONFINITE", "number overflows to a non-finite value", start);
		return value;
	}
}

interface DecodeFailure { offset: number; reason: JsonReason; message: string }

function decodeRange(bytes: Uint8Array, start: number, end: number, maxDepth: number): { value: unknown } | DecodeFailure {
	const slice = bytes.subarray(start, end);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(slice);
	} catch {
		if (on("utf8")) {
			const bad = firstInvalidUtf8(bytes, start, end);
			return { offset: bad < 0 ? start : bad, reason: "INVALID_UTF8", message: "invalid UTF-8" };
		}
		text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(slice);
	}
	try {
		return { value: new Parser(text, maxDepth).document() };
	} catch (error) {
		if (!(error instanceof Fail)) throw error;
		return { offset: start + Buffer.byteLength(text.slice(0, error.at), "utf8"), reason: error.reason, message: error.message };
	}
}

/** Decode one strict JSON document; see the module header. */
export function strictJson(bytes: Uint8Array, options: { path: string; maxDepth?: number }): unknown {
	const path = options?.path;
	if (typeof path !== "string") throw new ArtifactError({ code: "INVALID_ARGUMENT", path: String(path), reason: "options.path is required" });
	const result = decodeRange(bytes, 0, bytes.length, options.maxDepth ?? DEFAULT_MAX_DEPTH);
	if ("value" in result) return result.value;
	const { line, column } = position(bytes, result.offset, 0);
	throw new ArtifactError({ code: "CORRUPT", path, line, column, offset: result.offset, reason: result.reason, message: result.message });
}

/** Decode strict JSONL rows, reporting every refused row; see the module header. */
export function strictJsonl(bytes: Uint8Array, options: StrictJsonlOptions): StrictJsonlResult {
	const path = options?.path;
	if (typeof path !== "string") throw new ArtifactError({ code: "INVALID_ARGUMENT", path: String(path), reason: "options.path is required" });
	const maxRows = options.maxRows ?? Number.MAX_SAFE_INTEGER;
	const maxRowBytes = options.maxRowBytes ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isSafeInteger(maxRows) || maxRows < 0 || !Number.isSafeInteger(maxRowBytes) || maxRowBytes < 1) {
		throw new ArtifactError({ code: "INVALID_ARGUMENT", path, reason: "maxRows and maxRowBytes must be integers" });
	}
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const rows: JsonlRow[] = [];
	const errors: JsonlRowError[] = [];
	const push = (line: number, offset: number, column: number, reason: JsonlReason, message: string) => errors.push({ path, line, column, offset, reason, message });
	if (bytes.length === 0) {
		if (on("empty")) push(1, 0, 1, "EMPTY", "no rows: empty input");
		return { rows, errors };
	}
	let start = 0, line = 0, accepted = 0;
	while (start < bytes.length) {
		let end = bytes.indexOf(0x0a, start);
		const terminated = end >= 0;
		if (!terminated) end = bytes.length;
		line += 1;
		const rowStart = start;
		start = end + 1;
		if (!terminated && on("truncated-row")) { push(line, rowStart, 1, "TRUNCATED_ROW", `unterminated last row (${end - rowStart} bytes)`); break; }
		if (end - rowStart > maxRowBytes && on("row-size")) { push(line, rowStart, 1, "ROW_TOO_LARGE", `row is ${end - rowStart} bytes; limit ${maxRowBytes}`); continue; }
		let blank = true;
		for (let i = rowStart; i < end; i++) { const b = bytes[i]; if (b !== 32 && b !== 9 && b !== 13) { blank = false; break; } }
		if (blank) { push(line, rowStart, 1, "BLANK_LINE", "blank line"); continue; }
		if (accepted >= maxRows) {
			if (on("max-rows")) push(line, rowStart, 1, "TOO_MANY_ROWS", `more than ${maxRows} rows; nothing from this line on was read`);
			break;
		}
		const result = decodeRange(bytes, rowStart, end, maxDepth);
		if (!("value" in result)) {
			push(line, result.offset, result.offset - rowStart + 1, result.reason, result.message);
			continue;
		}
		accepted += 1;
		rows.push({ line, value: result.value });
		for (const message of options.validate?.(result.value) ?? []) push(line, rowStart, 1, "VALIDATION", message);
	}
	return { rows, errors };
}

/** Owner-validator helper: one message per key of `row` not in `allowed` (a non-object row is one message). */
export function rejectUnknownFields(row: unknown, allowed: Iterable<string>): string[] {
	if (row === null || typeof row !== "object" || Array.isArray(row)) return ["row is not an object"];
	if (!on("unknown-field")) return [];
	const known = new Set(allowed);
	return Object.keys(row).filter(key => !known.has(key)).map(key => `unknown field ${JSON.stringify(key)}`);
}
