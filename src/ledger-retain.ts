/**
 * ledger-retain.ts — STATERETAIN1 (ompkit-1ra0d.62): rotation for append-only
 * state ledgers and archival for stale claude-save receipts.
 *
 * Scope a of the bead rides the existing scratch/reaper verb path (no new
 * refusal code, no new service): `scratch apply --apply --yes` and the
 * scratch-reaper service body both `await retainStateLedgers()` after the reap.
 *
 * A ledger past `maxBytes` (default 100 MB) or untouched for `maxAgeMs`
 * (default 30 days) is rotated: every row but the newest `keepRows` window is
 * appended to `<stem>.jsonl.<UTC timestamp>.gz` next to it, and the ledger
 * keeps the newest window under its own name, so every current reader (mine,
 * push latency, project wakes, gate-event tails) keeps working unchanged. A
 * `claude-save-*.json` receipt older than `maxAgeMs` is gzipped to `<name>.gz`
 * in place.
 *
 * Concurrency: rotation holds the same KL08 `privateLock` the JSONL writers
 * take (`{ namespace: "kitlib-jsonl", path }`, state beside the ledger) across
 * each read-then-publish section, so an appended row can neither slip between
 * the read and the rename nor be overwritten by it. The slow work (split,
 * gzip, archive write) runs unlocked between two short lock holdings; the
 * second holding re-stats and aborts the publish when the ledger changed
 * meanwhile, unlinking the just-written archive so the next run archives each
 * row exactly once. A crash between the archive write and the rename leaves an
 * orphan archive: a later run reuses it when it holds exactly the rows it
 * would archive, else writes a fresh `-N` name — rotation never refuses
 * forever on a name collision.
 *
 * Out of scope: mail-wake.jsonl is NOT rotated. Both its appenders
 * (extensions/kit-mail-wake.ts, extensions/kit-inbox-wake.ts) write with bare
 * `appendFileSync`, so the writer lock cannot serialize them without changing
 * both notice paths; at 14 MB live it buys nothing today. scratch-reap-log.jsonl
 * self-rotates to `.1` (mine reads base plus `.1`), and bash-corpus.jsonl has
 * no producer or reader anywhere in the repo but stays in the rotation set as
 * evidence-only. Archived rows leave mine's coverage (mine reads the live
 * window plus `.1` only); no mine change.
 */
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { atomicReplaceBytes, AtomicReplaceError } from "./kitlib/io.ts";
import { privateLock, PrivateLockError } from "./kitlib/lock.ts";
import { fsyncDirectory } from "./mutations.ts";

/** Append-only ledgers this rotation owns. mail-wake.jsonl is out; see the module header. */
export const STATE_LEDGERS = ["gate-events.jsonl", "bash-corpus.jsonl"] as const;
/** Default rotation trigger: a ledger past 100 MB. */
export const LEDGER_MAX_BYTES = 100 * 1024 * 1024;
/** Default rotation trigger: a ledger untouched for 30 days. */
export const LEDGER_MAX_AGE_MS = 30 * 86_400_000;
/** Newest rows kept readable in the ledger after a rotation. */
export const LEDGER_KEEP_ROWS = 20_000;
/** A single ledger past 1 GiB is left for the operator: rotation reads it whole. */
export const LEDGER_MAX_READ_BYTES = 1 << 30;
/** Bound on writer-lock waits: a stuck writer never stalls the reaper past this per ledger. */
export const LEDGER_LOCK_DEADLINE_S = 30;
/** Same accept set as the claude-save service's owned receipt (src/service.ts). */
export const CLAUDE_SAVE_RECEIPT_PATTERN = /^claude-save-[A-Za-z0-9._-]+\.json$/;
/** Archives this rotation writes: <stem>.jsonl.<YYYYMMDD>T<HHMMSS>Z[-N].gz. */
export const ARCHIVE_NAME_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.jsonl\.[0-9]{8}T[0-9]{6}Z(?:-[0-9]+)?\.gz$/;
/** Timestamps this rotation accepts and emits. */
export const TIMESTAMP_PATTERN = /^[0-9]{8}T[0-9]{6}Z$/;

export interface LedgerRotation {
	ledger: string;
	archive: string;
	archivedRows: number;
	keptRows: number;
	/** Compressed archive bytes written. */
	archivedBytes: number;
}

export interface ReceiptArchive {
	receipt: string;
	archive: string;
	/** Compressed archive bytes written. */
	bytes: number;
}

export interface LedgerRetentionReport {
	stateRoot: string;
	rotated: LedgerRotation[];
	receiptsArchived: ReceiptArchive[];
	skipped: string[];
	errors: string[];
}

export interface LedgerRetentionOptions {
	maxBytes?: number;
	maxAgeMs?: number;
	keepRows?: number;
	lockDeadlineS?: number;
	nowMs?: number;
	timestamp?: string;
}

function option(name: string, value: number | undefined, fallback: number): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: ${name} must be a positive integer`);
	return resolved;
}

/** UTC `YYYYMMDDTHHMMSSZ` for archive names; keeps listing order chronological. */
export function rotationTimestamp(nowMs: number): string {
	const date = new Date(nowMs);
	if (!Number.isFinite(date.getTime())) throw new Error("LEDGER_RETENTION_ARGUMENT_INVALID: nowMs must be a finite epoch");
	const pad = (value: number, width: number): string => String(value).padStart(width, "0");
	return `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1, 2)}${pad(date.getUTCDate(), 2)}`
		+ `T${pad(date.getUTCHours(), 2)}${pad(date.getUTCMinutes(), 2)}${pad(date.getUTCSeconds(), 2)}Z`;
}

interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number }

function identify(path: string): FileIdentity | null {
	let current;
	try {
		current = lstatSync(path);
	} catch {
		return null;
	}
	if (!current.isFile() || current.isSymbolicLink()) return null;
	return { dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs };
}

function sameFile(before: FileIdentity, path: string): boolean {
	const current = identify(path);
	return current !== null && current.dev === before.dev && current.ino === before.ino
		&& current.size === before.size && current.mtimeMs === before.mtimeMs;
}
function writeArchive(path: string, bytes: Uint8Array): void {
	let fd: number;
	try {
		fd = openSync(path, "wx", 0o600);
	} catch (error) {
		throw error;
	}
	try {
		let written = 0;
		while (written < bytes.length) {
			const count = writeSync(fd, bytes, written, bytes.length - written);
			if (count <= 0) throw new Error(`LEDGER_RETENTION_WRITE_FAILED: no progress writing ${path}`);
			written += count;
		}
		fsyncSync(fd);
	} catch (error) {
		try { closeSync(fd); } catch { /* best effort */ }
		try { unlinkSync(path); } catch { /* best effort: only our own partial file */ }
		throw error;
	}
	closeSync(fd);
	fsyncDirectory(dirname(path));
}

/** The errno code of a filesystem failure, or null when the failure names none. */
function failureCode(error: unknown): string | null {
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
	return null;
}

/**
 * Publish `archiveBytes` under a collision-proof name: the canonical
 * `<stem>.jsonl.<timestamp>.gz`, reused when an orphan already holds exactly
 * these rows, else the first free `-N` sibling. Returns the archive name.
 * Throws only when no name can be published.
 */
function publishArchive(stateRoot: string, stem: string, timestamp: string, archiveBytes: Uint8Array, plainBytes: Buffer): string {
	const attempt = (name: string): boolean => {
		try {
			writeArchive(join(stateRoot, name), archiveBytes);
			return true;
		} catch (error) {
			if (failureCode(error) !== "EEXIST") throw error;
			return false;
		}
	};
	const canonical = `${stem}.jsonl.${timestamp}.gz`;
	if (!ARCHIVE_NAME_PATTERN.test(canonical)) throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: archive name refused: ${canonical}`);
	if (attempt(canonical)) return canonical;
	let orphan: Buffer | null = null;
	try {
		orphan = gunzipSync(readFileSync(join(stateRoot, canonical)));
	} catch { orphan = null; }
	if (orphan !== null && Buffer.compare(orphan, plainBytes) === 0) return canonical;
	for (let suffix = 2; suffix <= 100; suffix++) {
		const candidate = `${stem}.jsonl.${timestamp}-${suffix}.gz`;
		if (!ARCHIVE_NAME_PATTERN.test(candidate)) throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: archive name refused: ${candidate}`);
		if (attempt(candidate)) return candidate;
	}
	throw new Error(`LEDGER_RETENTION_ARCHIVE_EXHAUSTED: no free archive name for ${stem}.jsonl.${timestamp}.gz`);
}

async function rotateLedger(stateRoot: string, ledger: string, options: { maxBytes: number; maxAgeMs: number; keepRows: number; lockDeadlineS: number; nowMs: number; timestamp: string }, report: LedgerRetentionReport): Promise<void> {
	const path = join(stateRoot, ledger);
	const first = identify(path);
	if (first === null) {
		report.skipped.push(`${ledger}: absent or not a regular file`);
		return;
	}
	if (first.size <= options.maxBytes && options.nowMs - first.mtimeMs <= options.maxAgeMs) {
		report.skipped.push(`${ledger}: under both thresholds`);
		return;
	}
	if (first.size > LEDGER_MAX_READ_BYTES) {
		report.errors.push(`${ledger}: ${first.size} bytes exceeds the ${LEDGER_MAX_READ_BYTES} byte rotation cap; left for the operator`);
		return;
	}
	// Phase 1 (locked): read the whole ledger while writers wait, so no appended row escapes the split.
	const lockOptions = { namespace: "kitlib-jsonl", path };
	let snapshot: FileIdentity;
	let text: string;
	try {
		const lock = await privateLock(lockOptions, { deadline_s: options.lockDeadlineS, state_dir: dirname(path) });
		try {
			const restatted = identify(path);
			if (restatted === null) {
				report.errors.push(`${ledger}: disappeared under its rotation; left for the next run`);
				return;
			}
			if (restatted.size <= options.maxBytes && options.nowMs - restatted.mtimeMs <= options.maxAgeMs) {
				report.skipped.push(`${ledger}: under both thresholds`);
				return;
			}
			snapshot = restatted;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
			} catch {
				report.errors.push(`${ledger}: not valid UTF-8; left untouched`);
				return;
			}
		} finally {
			lock.release();
		}
	} catch (error) {
		const reason = error instanceof PrivateLockError
			? `writer lock unavailable within ${options.lockDeadlineS}s`
			: error instanceof Error ? error.message : String(error);
		report.errors.push(`${ledger}: ${reason}; left untouched for the next run`);
		return;
	}
	const terminated = text.endsWith("\n");
	const parts = text.split("\n");
	if (terminated) parts.pop();
	const pendingTail = terminated ? null : (parts.pop() ?? null);
	if (parts.length === 0) {
		report.skipped.push(`${ledger}: no complete row to archive`);
		return;
	}
	const keepCount = Math.min(options.keepRows, parts.length - 1);
	const archiveRows = parts.slice(0, parts.length - keepCount);
	const keptRows = parts.slice(parts.length - keepCount);
	if (archiveRows.length === 0) {
		report.skipped.push(`${ledger}: no complete row to archive`);
		return;
	}
	const stem = ledger.endsWith(".jsonl") ? ledger.slice(0, -".jsonl".length) : ledger;
	const plainBytes = Buffer.from(`${archiveRows.join("\n")}\n`, "utf8");
	let archiveBytes: Uint8Array;
	try {
		archiveBytes = gzipSync(plainBytes);
	} catch (error) {
		report.errors.push(`${ledger}: gzip failed: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	// Unlocked: the slow archive write never blocks writers.
	let archiveName: string;
	let wroteArchive = false;
	try {
		const before = identify(join(stateRoot, `${stem}.jsonl.${options.timestamp}.gz`));
		archiveName = publishArchive(stateRoot, stem, options.timestamp, archiveBytes, plainBytes);
		wroteArchive = before === null || archiveName !== `${stem}.jsonl.${options.timestamp}.gz`;
	} catch (error) {
		report.errors.push(`${ledger}: ${error instanceof Error ? error.message : String(error)}; left untouched`);
		return;
	}
	// Phase 2 (locked): publish only when the ledger is exactly what was read; a
	// writer that landed meanwhile aborts this run (its rows stay in the ledger)
	// and the just-written archive is withdrawn so no row archives twice.
	try {
		const lock = await privateLock(lockOptions, { deadline_s: options.lockDeadlineS, state_dir: dirname(path) });
		try {
			if (!sameFile(snapshot, path)) {
				if (wroteArchive) {
					try { unlinkSync(join(stateRoot, archiveName)); } catch { /* best effort */ }
				}
				report.errors.push(`${ledger}: changed while archiving; left untouched for the next run`);
				return;
			}
			const keptText = `${keptRows.length > 0 ? `${keptRows.join("\n")}\n` : ""}${pendingTail ?? ""}`;
			let originalMode = 0o600;
			try {
				originalMode = lstatSync(path).mode & 0o755;
			} catch { originalMode = 0o600; }
			try {
				atomicReplaceBytes(path, Buffer.from(keptText, "utf8"), {
					mode: originalMode,
					durability: "file",
					validate: () => {
						if (!sameFile(snapshot, path)) throw new Error(`LEDGER_RETENTION_CHANGED: ${ledger} changed under its rotation`);
					},
				});
			} catch (error) {
				if (wroteArchive) {
					try { unlinkSync(join(stateRoot, archiveName)); } catch { /* best effort: no duplicate archive on retry */ }
				}
				const reason = error instanceof AtomicReplaceError ? error.message : error instanceof Error ? error.message : String(error);
				report.errors.push(`${ledger}: publish refused (${reason}); left untouched`);
				return;
			}
		} finally {
			lock.release();
		}
	} catch (error) {
		if (wroteArchive) {
			try { unlinkSync(join(stateRoot, archiveName)); } catch { /* best effort */ }
		}
		const reason = error instanceof PrivateLockError
			? `writer lock unavailable within ${options.lockDeadlineS}s`
			: error instanceof Error ? error.message : String(error);
		report.errors.push(`${ledger}: ${reason}; left untouched for the next run`);
		return;
	}
	report.rotated.push({ ledger, archive: archiveName, archivedRows: archiveRows.length, keptRows: keptRows.length, archivedBytes: archiveBytes.length });
}

function archiveReceipts(stateRoot: string, options: { maxAgeMs: number; nowMs: number }, report: LedgerRetentionReport): void {
	let entries: string[];
	try {
		entries = readdirSync(stateRoot);
	} catch (error) {
		report.errors.push(`receipts: cannot list ${stateRoot}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	for (const entry of entries.sort()) {
		if (!CLAUDE_SAVE_RECEIPT_PATTERN.test(entry)) continue;
		const path = join(stateRoot, entry);
		const snapshot = identify(path);
		if (snapshot === null) continue;
		if (options.nowMs - snapshot.mtimeMs <= options.maxAgeMs) continue;
		const archiveName = `${entry}.gz`;
		const archivePath = join(stateRoot, archiveName);
		let raw: Buffer;
		try {
			raw = readFileSync(path);
		} catch {
			report.errors.push(`${entry}: unreadable; left untouched`);
			continue;
		}
		let compressed: Uint8Array;
		try {
			compressed = gzipSync(raw);
		} catch (error) {
			report.errors.push(`${entry}: gzip failed: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		try {
			writeArchive(archivePath, compressed);
		} catch (error) {
			const reason = failureCode(error) === "EEXIST"
				? "archive already exists"
				: error instanceof Error ? error.message : String(error);
			report.errors.push(`${entry}: ${reason}; left untouched`);
			continue;
		}
		if (!sameFile(snapshot, path)) {
			try { unlinkSync(archivePath); } catch { /* best effort */ }
			report.errors.push(`${entry}: changed while archiving; left untouched for the next run`);
			continue;
		}
		try {
			unlinkSync(path);
		} catch (error) {
			try { unlinkSync(archivePath); } catch { /* best effort */ }
			report.errors.push(`${entry}: original not removable: ${error instanceof Error ? error.message : String(error)}; archive withdrawn`);
			continue;
		}
		report.receiptsArchived.push({ receipt: entry, archive: archiveName, bytes: compressed.length });
	}
}

/**
 * Rotate oversized or stale append-only ledgers and archive stale claude-save
 * receipts in `stateRoot`. Read-only when everything is under threshold.
 * Throws only on unusable arguments or an unreadable state root.
 */
export async function retainStateLedgers(stateRoot: string, options: LedgerRetentionOptions = {}): Promise<LedgerRetentionReport> {
	if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || resolve(stateRoot) !== stateRoot) {
		throw new Error("LEDGER_RETENTION_ARGUMENT_INVALID: stateRoot must be a canonical absolute path");
	}
	const maxBytes = option("maxBytes", options.maxBytes, LEDGER_MAX_BYTES);
	const maxAgeMs = option("maxAgeMs", options.maxAgeMs, LEDGER_MAX_AGE_MS);
	const keepRows = option("keepRows", options.keepRows, LEDGER_KEEP_ROWS);
	const lockDeadlineS = option("lockDeadlineS", options.lockDeadlineS, LEDGER_LOCK_DEADLINE_S);
	const nowMs = options.nowMs ?? Date.now();
	if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("LEDGER_RETENTION_ARGUMENT_INVALID: nowMs must be a non-negative safe integer");
	const timestamp = options.timestamp ?? rotationTimestamp(nowMs);
	if (!TIMESTAMP_PATTERN.test(timestamp)) throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: timestamp must match ${TIMESTAMP_PATTERN}`);
	const report: LedgerRetentionReport = { stateRoot, rotated: [], receiptsArchived: [], skipped: [], errors: [] };
	let rootStat;
	try {
		rootStat = lstatSync(stateRoot);
	} catch {
		throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: state root is missing: ${stateRoot}`);
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new Error(`LEDGER_RETENTION_ARGUMENT_INVALID: state root is not a directory: ${stateRoot}`);
	}
	for (const ledger of STATE_LEDGERS) {
		await rotateLedger(stateRoot, ledger, { maxBytes, maxAgeMs, keepRows, lockDeadlineS, nowMs, timestamp }, report);
	}
	archiveReceipts(stateRoot, { maxAgeMs, nowMs }, report);
	return report;
}
