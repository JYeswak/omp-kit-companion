/**
 * Owner-message source for skill-mine (ompkit-nmke9, box [a]).
 *
 * Faithful TypeScript port of the chief's `owner_chat.py`: extracts the
 * messages the owner actually typed from OMP session journals
 * (`<sessions-root>/<slug>/*.jsonl`), with a byte-offset cursor per file so a
 * second run emits nothing new. Only `type: "message"` entries whose inner
 * role is exactly `"user"` are admitted, and the deterministic synthetic-text
 * filter drops harness-injected rows (continuation steers, system notices,
 * mail wake prompts/relays, tool results arrive with a different role and
 * never reach the filter).
 *
 * Where the bead and the Python differ, the bead wins; the one deliberate
 * difference is documented on `scanOwnerSessions` (cursor keys are absolute
 * paths, so a moved sessions root rescans instead of silently reusing
 * stale offsets).
 *
 * No regular expressions: every pattern is a plain string/char scan, so the
 * push regexploit gate has nothing to judge.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const OWNER_CURSOR_SCHEMA = 1;
/** Read block size for the journal scan; mirrors owner_chat.CHUNK_BYTES. */
export const OWNER_CHUNK_BYTES = 8 << 20;
/** A line longer than this is a tool-result blob, never a typed message:
 * skipped, but it still consumes its line number. */
export const OWNER_MAX_LINE_BYTES = 64 << 20;
/** Stored candidate text is truncated to this many code points; the sha covers the full text. */
export const OWNER_MAX_TEXT_CHARS = 4000;
/** open(2) flag refusing a trailing symlink (ELOOP), so the journal open
 * itself is the containment check instead of a separate check-then-open.
 * Undefined where the platform has no O_NOFOLLOW; the scanner then falls
 * back to an lstat immediately before opening. */
export const OWNER_O_NOFOLLOW: number | undefined = constants.O_NOFOLLOW;

/** Cap on profile directories listed for the default roots: a bounded
 * inventory, never a home-tree scan. */
export const OWNER_MAX_PROFILES = 32;

/**
 * Default owner session roots: every existing
 * `<home>/.omp/profiles/<profile>/agent/sessions` directory, sorted.
 * Both parents are lstated first: a symlink or non-directory at
 * `<home>/.omp` or `<home>/.omp/profiles` rejects the whole inventory, so
 * the default run can never traverse an aliased tree. Per profile, a
 * symlink at `profiles/<p>`, `agent` or `sessions` rejects that profile.
 * Only immediate profile directories are listed. An explicit
 * `--sessions-root` bypasses this inventory entirely (the operator named
 * that tree).
 */
export function defaultOwnerSessionsRoots(home: string): string[] {
	const omp = join(home, ".omp");
	const base = join(omp, "profiles");
	if (!isRealDir(omp) || !isRealDir(base)) return [];
	let names: string[];
	try {
		names = readdirSync(base).sort();
	} catch {
		return [];
	}
	const roots: string[] = [];
	for (const name of names) {
		if (roots.length >= OWNER_MAX_PROFILES) break;
		if (name === "." || name === "..") continue;
		const profile = join(base, name);
		const agent = join(profile, "agent");
		const sessions = join(agent, "sessions");
		if (!isRealDir(profile) || !isRealDir(agent) || !isRealDir(sessions)) continue;
		roots.push(sessions);
	}
	return roots;
}

/** True when the path itself is a directory, not a symlink to one. */
function isRealDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function ownerCursorPath(stateDir: string): string {
	return join(stateDir, "skill-mine", "owner-cursor.json");
}

function isWordChar(ch: string): boolean {
	if (ch.length === 0) return false;
	const code = ch.charCodeAt(0);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

/** True when `text` starts with `prefix` on a word boundary (end of text or
 * a non-word char follows), mirroring `\b` at the end of a `^...` pattern. */
function startsWord(text: string, prefix: string): boolean {
	if (!text.startsWith(prefix)) return false;
	return text.length === prefix.length || !isWordChar(text[prefix.length]!);
}

function skipSpaces(text: string, at: number): number {
	while (at < text.length) {
		const ch = text[at]!;
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") at++;
		else break;
	}
	return at;
}

function skipWord(text: string, at: number): number {
	const start = at;
	while (at < text.length && isWordChar(text[at]!)) at++;
	return at === start ? -1 : at;
}

/** `(Joshua J-YYYY-MM-DD-N...)` dispatch marker, mirroring
 * `\(Joshua J-\d{4}-\d{2}-\d{2}-\d+` without a regex. */
function hasJoshuaDispatch(text: string): boolean {
	const marker = "(Joshua J-";
	let at = text.indexOf(marker);
	while (at >= 0) {
		let i = at + marker.length;
		const digits = (n: number): boolean => {
			for (let k = 0; k < n; k++) {
				if (i >= text.length) return false;
				const code = text.charCodeAt(i);
				if (code < 48 || code > 57) return false;
				i++;
			}
			return true;
		};
		if (digits(4) && text[i] === "-" && (i++, digits(2)) && text[i] === "-" && (i++, digits(2)) && text[i] === "-" && (i++, digits(1))) {
			// At least one trailing digit; further digits are fine.
			while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
			return true;
		}
		at = text.indexOf(marker, at + 1);
	}
	return false;
}

/** `\bMAIL\s+\d+\s+from\b`, plain scan. */
function hasMailRelayCaps(text: string): boolean {
	let at = text.indexOf("MAIL");
	while (at >= 0) {
		const before = at === 0 ? "" : text[at - 1]!;
		if ((at === 0 || !isWordChar(before)) && !isWordChar(text[at + 4] ?? "")) {
			let i = skipSpaces(text, at + 4);
			if (i > at + 4) {
				const numStart = i;
				while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
				if (i > numStart) {
					const afterNum = skipSpaces(text, i);
					if (afterNum > i && text.startsWith("from", afterNum)
						&& (afterNum + 4 >= text.length || !isWordChar(text[afterNum + 4]!))) return true;
				}
			}
		}
		at = text.indexOf("MAIL", at + 1);
	}
	return false;
}

/** `\bAgent Mail\s*\d`, plain scan. */
function hasMailRelayTitle(text: string): boolean {
	const marker = "Agent Mail";
	let at = text.indexOf(marker);
	while (at >= 0) {
		if (at === 0 || !isWordChar(text[at - 1]!)) {
			let i = skipSpaces(text, at + marker.length);
			if (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) return true;
		}
		at = text.indexOf(marker, at + 1);
	}
	return false;
}

/** `^(QUESTION|HANDOFF|DECISION|PROGRESS|REPORT|Re:)\s+\S*\s*from\s+\w+:`,
 * plain scan. The `\S*` token is read greedily up to whitespace, matching
 * the canonical relay shapes (`Re: <thread> from <seat>:`). */
function hasProseRelay(text: string): boolean {
	const prefixes = ["QUESTION", "HANDOFF", "DECISION", "PROGRESS", "REPORT", "Re:"];
	for (const prefix of prefixes) {
		if (!text.startsWith(prefix)) continue;
		let i = skipSpaces(text, prefix.length);
		if (i === prefix.length) continue;
		while (i < text.length && text[i] !== " " && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r" && text[i] !== "\f" && text[i] !== "\v") i++;
		i = skipSpaces(text, i);
		if (!text.startsWith("from", i)) continue;
		const afterFrom = i + 4;
		if (afterFrom < text.length && isWordChar(text[afterFrom]!)) continue;
		const ws = skipSpaces(text, afterFrom);
		if (ws === afterFrom) continue;
		const wordEnd = skipWord(text, ws);
		if (wordEnd < 0 || text[wordEnd] !== ":") continue;
		return true;
	}
	return false;
}

/** `^To\s+\w+\s+from\s+\w+\s*\|`, plain scan. */
function hasToFromPipe(text: string): boolean {
	if (!text.startsWith("To")) return false;
	let i = skipSpaces(text, 2);
	if (i === 2) return false;
	i = skipWord(text, i);
	if (i < 0) return false;
	const ws1 = skipSpaces(text, i);
	if (ws1 === i || !text.startsWith("from", ws1)) return false;
	const ws2 = skipSpaces(text, ws1 + 4);
	if (ws2 === ws1 + 4) return false;
	i = skipWord(text, ws2);
	if (i < 0) return false;
	i = skipSpaces(text, i);
	return text[i] === "|";
}

/** `^\s*\[(from|observer|system)\b`, case-insensitive, plain scan. */
function hasMailHeader(text: string): boolean {
	let i = skipSpaces(text, 0);
	if (text[i] !== "[") return false;
	i++;
	const words = ["from", "observer", "system"];
	const lower = text.toLowerCase();
	for (const word of words) {
		if (lower.startsWith(word, i) && (i + word.length >= text.length || !isWordChar(text[i + word.length]!))) return true;
	}
	return false;
}

/** `^\s*<(attachment|paste\b[^<>]*)>[ \t]*\r?\n?`, case-insensitive, plain
 * scan. Returns the text after the marker, or null when there is none. */
function stripPasteMarker(text: string): string | null {
	let i = skipSpaces(text, 0);
	if (text[i] !== "<") return null;
	i++;
	const lower = text.toLowerCase();
	let tagEnd = -1;
	if (lower.startsWith("attachment", i)) tagEnd = i + "attachment".length;
	else if (lower.startsWith("paste", i) && (i + 5 >= text.length || !isWordChar(text[i + 5]!))) {
		let j = i + 5;
		while (j < text.length && text[j] !== ">" && text[j] !== "<") j++;
		if (text[j] === ">") tagEnd = j;
	} else return null;
	if (tagEnd >= 0 && lower.startsWith("attachment", i)) {
		if (text[tagEnd] !== ">") return null;
	}
	if (tagEnd < 0) return null;
	i = tagEnd + 1;
	while (text[i] === " " || text[i] === "\t") i++;
	if (text[i] === "\r") i++;
	if (text[i] === "\n") i++;
	return text.slice(i);
}

/** `^\s*<[A-Za-z/!]`, plain scan. */
function hasTagLead(text: string): boolean {
	const i = skipSpaces(text, 0);
	if (text[i] !== "<" || i + 1 >= text.length) return false;
	const code = text.charCodeAt(i + 1);
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || text[i + 1] === "/" || text[i + 1] === "!";
}

/** `"role"\s*:\s*"user"` prefilter, plain scan: avoids parsing lines that
 * cannot be user entries. */
function maybeUserLine(decoded: string): boolean {
	let at = decoded.indexOf('"role"');
	while (at >= 0) {
		let i = skipSpaces(decoded, at + 6);
		if (decoded[i] === ":") {
			i = skipSpaces(decoded, i + 1);
			if (decoded.startsWith('"user"', i)) return true;
		}
		at = decoded.indexOf('"role"', at + 1);
	}
	return false;
}

/**
 * Why a user-role text is synthetic (injected, not typed), or null when the
 * owner genuinely typed it. Mirrors owner_chat.synthetic_reason exactly:
 * steering:true must NOT exclude (real steers carry it too), so only the
 * text is judged, never the row's other fields.
 */
export function ownerSyntheticReason(text: string): string | null {
	if (text.startsWith("Continue active goal") && (text.length === "Continue active goal".length || !isWordChar(text["Continue active goal".length]!))) return "continuation-steer";
	if (text.includes("goal_context")) return "continuation-steer";
	if (text.startsWith("Complete assignment thoroughly:")
		|| text.startsWith("[Wait interrupted by message]")
		|| text.startsWith("[budget notice]")
		|| hasJoshuaDispatch(text)) return "parent-dispatch";
	if (startsWord(text, "You restarted onto")
		|| startsWord(text, "Restarted onto")
		|| startsWord(text, "Continue the work you were doing before the restart")) return "system-notice";
	if (hasMailHeader(text)) return "mail-wake";
	if (hasMailRelayTitle(text) || hasProseRelay(text)) return "mail-relay-prose";
	if (text.trimStart().startsWith("Read existing Agent Mail") || hasToFromPipe(text)) return "mail-relay-prose";
	if (hasTagLead(text)) return "harness-wrapper";
	return null;
}

/** Concatenate the text parts of a message content list. */
export function ownerMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item !== null && typeof item === "object" && !Array.isArray(item)) {
			const record = item as Record<string, unknown>;
			if (record["type"] === "text" && typeof record["text"] === "string" && record["text"].length > 0) parts.push(record["text"]);
		}
	}
	return parts.join("\n");
}

/**
 * Strip a client paste marker; return null when the entry is synthetic.
 * Mirrors owner_chat.clean_text: a tag-led text without a valid paste marker
 * is a harness wrapper, not a client paste.
 */
export function cleanOwnerText(raw: string): string | null {
	let text = raw.trim();
	if (text.length === 0) return null;
	if (hasTagLead(text)) {
		const stripped = stripPasteMarker(text);
		if (stripped === null || stripped === text) return null;
		if (stripped.trim().length === 0) return null;
		text = stripped.trim();
	}
	if (ownerSyntheticReason(text) !== null) return null;
	return text;
}

/** Parse an ISO-8601 timestamp (or epoch) to epoch milliseconds, else null. */
export function parseOwnerTs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim().length === 0) return null;
	const ms = Date.parse(value.trim());
	return Number.isNaN(ms) ? null : ms;
}

/** Stable row id: sha256 of the absolute session path plus the line number. */
export function ownerMsgId(sessionPath: string, line: number): string {
	return createHash("sha256").update(`${sessionPath}:${line}`, "utf8").digest("hex");
}

export interface OwnerScanRow {
	at: string | number | null;
	seat_or_project_slug: string;
	session_path: string;
	line: number;
	msg_id: string;
	text: string;
	text_sha256: string;
	text_chars: number;
}

export interface OwnerCursorFile {
	offset: number;
	next_line: number;
}

export function loadOwnerCursor(path: string): Record<string, OwnerCursorFile> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
	const record = parsed as Record<string, unknown>;
	if (record["schema_version"] !== OWNER_CURSOR_SCHEMA) return {};
	const files = record["files"];
	if (files === null || typeof files !== "object" || Array.isArray(files)) return {};
	const out: Record<string, OwnerCursorFile> = {};
	for (const [key, value] of Object.entries(files as Record<string, unknown>)) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			const row = value as Record<string, unknown>;
			const offset = typeof row["offset"] === "number" ? row["offset"] : -1;
			const nextLine = typeof row["next_line"] === "number" ? row["next_line"] : -1;
			if (Number.isInteger(offset) && offset >= 0 && Number.isInteger(nextLine) && nextLine >= 1) {
				out[key] = { offset, next_line: nextLine };
			}
		}
	}
	return out;
}

export function saveOwnerCursor(path: string, files: Record<string, OwnerCursorFile>): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(path, `${JSON.stringify({ schema_version: OWNER_CURSOR_SCHEMA, files }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * All real *.jsonl files under root, sorted for deterministic output.
 * Physically contained: entries are lstated, so a symlinked dir is never
 * descended and a symlinked file is never collected — loops terminate by
 * construction. Every descended directory is lstated again at descent, so
 * a swap after enumeration is refused too (the operator-named root itself
 * is trusted as given). The wall deadline is checked during enumeration
 * (not only after), stopping with stoppedEarly so the caller keeps the
 * existing "wall budget reached" note.
 */
function iterSessionFiles(root: string, deadlineMs: number): { files: string[]; stoppedEarly: boolean } {
	const found: string[] = [];
	let stoppedEarly = false;
	const walk = (dir: string, isRoot: boolean): void => {
		if (Date.now() > deadlineMs) {
			stoppedEarly = true;
			return;
		}
		if (!isRoot) {
			let here;
			try {
				here = lstatSync(dir);
			} catch {
				return;
			}
			if (here.isSymbolicLink() || !here.isDirectory()) return;
		}
		let names: string[];
		try {
			names = readdirSync(dir).sort();
		} catch {
			return;
		}
		for (const name of names) {
			if (Date.now() > deadlineMs) {
				stoppedEarly = true;
				return;
			}
			const full = join(dir, name);
			let entry;
			try {
				entry = lstatSync(full);
			} catch {
				continue;
			}
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full, false);
			else if (entry.isFile() && name.endsWith(".jsonl")) found.push(full);
			if (stoppedEarly) return;
		}
	};
	walk(root, true);
	return { files: found.sort(), stoppedEarly };
}

interface NewLine {
	/** Complete line bytes without the newline; empty when the line was a skipped blob. */
	bytes: Buffer;
	/** File offset just past this line. */
	offsetAfter: number;
}

function truncateCodePoints(text: string, max: number): string {
	if (text.length <= max) return text;
	return Array.from(text).slice(0, max).join("");
}

/**
 * Read only new bytes per file and return rows plus the updated cursor.
 * Mirrors owner_chat.scan: chunked bounded reads, a trailing partial line
 * (seat mid-write) is held back, one over-long line is skipped but still
 * consumes its line number. Cursor keys are absolute paths (the one
 * deliberate difference from the Python, which keys by the joined root
 * path: absolute keys cannot silently reuse offsets for a different tree).
 * Containment is atomic at open, not check-then-open: each journal is
 * opened with O_NOFOLLOW so a trailing symlink fails the open itself
 * (ELOOP) instead of a separate lstat the file could be swapped under; a
 * descriptor that is not a regular file is closed and refused (still
 * counted in files). Where the platform has no O_NOFOLLOW the pre-open
 * lstat remains as fallback. `beforeOpen` is a deterministic test seam for
 * that path: it runs after enumeration for each listed file, immediately
 * before the open, so a test can swap a file for a symlink or directory
 * without sleeps.
 */
export function scanOwnerSessions(
	root: string,
	sinceMs: number | null,
	untilMs: number | null,
	cursor: Record<string, OwnerCursorFile>,
	options?: { chunkBytes?: number; maxLineBytes?: number; deadlineMs?: number; beforeOpen?: (path: string) => void },
): { rows: OwnerScanRow[]; cursor: Record<string, OwnerCursorFile>; files: number; stoppedEarly: boolean } {
	const chunkBytes = options?.chunkBytes ?? OWNER_CHUNK_BYTES;
	const maxLineBytes = options?.maxLineBytes ?? OWNER_MAX_LINE_BYTES;
	const deadlineMs = options?.deadlineMs ?? Number.POSITIVE_INFINITY;
	const rows: OwnerScanRow[] = [];
	const next: Record<string, OwnerCursorFile> = {};
	let files = 0;
	let stoppedEarly = false;
	const listed = iterSessionFiles(root, deadlineMs);
	if (listed.stoppedEarly) stoppedEarly = true;
	for (const path of listed.files) {
		if (Date.now() > deadlineMs) {
			stoppedEarly = true;
			break;
		}
		files++;
		const absolute = resolve(path);
		const rel = relative(resolve(root), absolute);
		const slug = rel.split(sep)[0] ?? "";
		options?.beforeOpen?.(path);
		if (OWNER_O_NOFOLLOW === undefined) {
			let listed;
			try {
				listed = lstatSync(path);
			} catch {
				continue;
			}
			if (listed.isSymbolicLink() || !listed.isFile()) continue;
		}
		let fd = -1;
		try {
			fd = OWNER_O_NOFOLLOW === undefined ? openSync(path, "r") : openSync(path, OWNER_O_NOFOLLOW | constants.O_RDONLY);
		} catch {
			continue;
		}
		let openedStat;
		try {
			openedStat = fstatSync(fd);
		} catch {
			try {
				closeSync(fd);
			} catch {
				/* descriptor already gone */
			}
			continue;
		}
		if (!openedStat.isFile()) {
			try {
				closeSync(fd);
			} catch {
				/* descriptor already gone */
			}
			continue;
		}
		const size = openedStat.size;
		const state = cursor[absolute];
		let offset = state?.offset ?? 0;
		let lineno = state?.next_line ?? 1;
		if (!Number.isInteger(offset) || offset < 0 || offset > size) {
			offset = 0;
			lineno = 1;
		}
		try {
			let buf = Buffer.alloc(0);
			let skipping = false;
			const lines: NewLine[] = [];
			const chunk = Buffer.alloc(chunkBytes);
			let pos = offset;
			for (;;) {
				let n = 0;
				try {
					n = readSync(fd, chunk, 0, chunk.length, pos);
				} catch {
					break;
				}
				if (n <= 0) break;
				pos += n;
				const blk = chunk.subarray(0, n);
				if (skipping) {
					const cut = blk.indexOf(0x0a);
					if (cut < 0) {
						offset += blk.length;
						continue;
					}
					offset += cut + 1;
					lines.push({ bytes: Buffer.alloc(0), offsetAfter: offset });
					skipping = false;
					buf = Buffer.from(blk.subarray(cut + 1));
				} else {
					buf = Buffer.concat([buf, Buffer.from(blk)]);
				}
				while (!skipping) {
					const cut = buf.indexOf(0x0a);
					if (cut < 0) {
						if (buf.length > maxLineBytes) {
							skipping = true;
							offset += buf.length;
							buf = Buffer.alloc(0);
						}
						break;
					}
					if (cut > maxLineBytes) {
						offset += cut + 1;
						buf = buf.subarray(cut + 1);
						lines.push({ bytes: Buffer.alloc(0), offsetAfter: offset });
						continue;
					}
					const raw = buf.subarray(0, cut);
					buf = buf.subarray(cut + 1);
					offset += cut + 1;
					lines.push({ bytes: Buffer.from(raw), offsetAfter: offset });
				}
			}
			for (const line of lines) {
				if (line.bytes.length > 0) {
					const decoded = line.bytes.toString("utf8");
					if (decoded.trim().length > 0 && maybeUserLine(decoded)) {
						let entry: unknown = null;
						try {
							entry = JSON.parse(decoded) as unknown;
						} catch {
							entry = null;
						}
						if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
							const record = entry as Record<string, unknown>;
							const inner = record["message"];
							if (record["type"] === "message" && inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
								const role = (inner as Record<string, unknown>)["role"];
								if (role === "user") {
									const rawAt = record["timestamp"];
									const at = typeof rawAt === "string" || typeof rawAt === "number" ? rawAt : null;
									const epoch = parseOwnerTs(at);
									const inWindow = (sinceMs === null || (epoch !== null && epoch >= sinceMs))
										&& (untilMs === null || (epoch !== null && epoch < untilMs));
									if (inWindow) {
										const cleaned = cleanOwnerText(ownerMessageText((inner as Record<string, unknown>)["content"]));
										if (cleaned !== null) {
											const full = cleaned;
											const text = truncateCodePoints(full, OWNER_MAX_TEXT_CHARS);
											rows.push({
												at,
												seat_or_project_slug: slug,
												session_path: absolute,
												line: lineno,
												msg_id: ownerMsgId(absolute, lineno),
												text,
												text_sha256: createHash("sha256").update(full, "utf8").digest("hex"),
												text_chars: Array.from(full).length,
											});
										}
									}
								}
							}
						}
					}
				}
				lineno++;
			}
		} finally {
			if (fd >= 0) {
				try {
					closeSync(fd);
				} catch {
					/* descriptor already gone */
				}
			}
		}
		next[absolute] = { offset, next_line: lineno };
	}
	return { rows, cursor: next, files, stoppedEarly };
}
