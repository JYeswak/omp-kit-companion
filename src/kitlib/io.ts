/**
 * kitlib io: the kit's one atomic byte-replacement primitive for TypeScript (ompkit-67i70, KL06).
 *
 * `atomicReplaceBytes(path, bytes, { mode, durability })` is the TypeScript half of a two-language
 * contract; `scripts/kitlib_io.py` `atomic_replace_bytes` is the Python half, and both pass the one
 * conformance corpus `tests/fixtures/kitlib-io/corpus.json` (`tests/cli/kitlib-io.test.ts`,
 * `tests/scripts/kitlib_io_test.py`).
 *
 * Steps: a fresh temp `.<name>.<pid>.<12 hex>.tmp` is created in the stage dir (default: the target's
 * own directory) with O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600; it must be a regular file with one link,
 * owned by this user. It is fchmod'ed to `mode` (so the umask never decides the result), every byte is
 * written, and its size is checked. Durability "file" or "full" fsyncs it. The caller's `validate`
 * runs on the complete temp. Just before rename the temp name must still be the same inode with one
 * link and the target must still be absent or a regular file. Then rename; "full" then fsyncs the
 * target's directory (`fsyncDirectory` from src/mutations.ts, reused, not copied).
 *
 * Fixed unsafe-path policy, every refusal an `AtomicReplaceError` with a `code`:
 * - the path must be absolute and normalized, the target absent or a regular file (a symlink,
 *   directory or device at the path is UNSAFE_PATH; its parent must be a directory);
 * - a stage dir other than the default must be given explicitly, be a real directory, and sit on the
 *   target's filesystem (else EXDEV; there is never a copy fallback, and a rename that fails EXDEV is
 *   EXDEV too); when `publicRoot` names a public deployment tree, the stage (default or explicit) must
 *   lie outside it (STAGE_IN_PUBLIC_TREE);
 * - a temp name that already exists is TEMP_EXISTS, or TEMP_SYMLINK when it is a symlink; a temp that
 *   gained a second link is TEMP_HARDLINKED; a temp name that no longer names our inode is TEMP_REPLACED.
 *
 * Any failure before the rename removes the temp (only when the name still names our inode), leaves
 * the target untouched and throws with `published: false`. Once the rename has happened the new bytes
 * are visible: a directory fsync failure throws DIR_SYNC_FAILED with `published: true` (the old bytes
 * are gone), and an abort after the rename is not a cancellation: the requested durability still runs
 * and the result says `cancelledAfterPublish`. Publication and durability are reported separately:
 * `durable` is true only for "full" with both syncs done.
 *
 * Out of scope by contract: serialization (bytes in, bytes out) and transactions. Atomic replacement
 * is not a multi-writer transaction: read-modify-write needs the KL08 lock around the read and this
 * call, or a concurrent update is lost. The primitive installs no exit or signal handlers and never
 * changes the umask.
 */
import { randomBytes } from "node:crypto";
import {
	closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, statSync,
	unlinkSync, writeSync, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fsyncDirectory } from "../mutations.ts";

export const DURABILITIES = ["none", "file", "full"] as const;
export type Durability = typeof DURABILITIES[number];
export type Boundary = "temp-created" | "written" | "file-synced" | "validated" | "renamed" | "directory-synced";
export type AtomicReplaceCode =
	| "INVALID_ARGUMENT" | "UNSAFE_PATH" | "STAGE_UNSAFE" | "STAGE_IN_PUBLIC_TREE" | "EXDEV" | "CANCELLED"
	| "TEMP_EXISTS" | "TEMP_SYMLINK" | "TEMP_CREATE_FAILED" | "TEMP_HARDLINKED" | "TEMP_UNSAFE" | "TEMP_REPLACED"
	| "WRITE_FAILED" | "PARTIAL_WRITE" | "SIZE_MISMATCH" | "FILE_SYNC_FAILED" | "VALIDATION_FAILED"
	| "RENAME_FAILED" | "DIR_SYNC_FAILED" | "UNSUPPORTED_PLATFORM";

/** Only owner rwx and group/other read+execute: the primitive never creates a group- or world-writable file. */
const MODE_MASK = 0o755;
const TEMP_BASE_CHARS = 32;

export interface AtomicReplaceOptions {
	/** Exact permission bits of the published file, a subset of 0o755; 0o600 for a private file. */
	mode: number;
	/** "none": rename only. "file": fsync the bytes before rename. "full": also fsync the directory after. */
	durability: Durability;
	/** Explicitly authorized same-filesystem staging directory; default the target's directory. */
	stageDir?: string;
	/** A public deployment tree the stage must lie outside of. */
	publicRoot?: string;
	/** Runs on the complete, closed temp before rename; a throw refuses publication. */
	validate?: (tempPath: string) => void;
	/** Honoured until the rename; after it the publication stands and is reported. */
	signal?: AbortSignal;
	onBoundary?: (boundary: Boundary, tempPath: string) => void;
}

export interface AtomicReplaceResult {
	path: string;
	published: true;
	durability: Durability;
	fileSynced: boolean;
	directorySynced: boolean;
	/** True only for durability "full" with both the file and directory fsync done. */
	durable: boolean;
	cancelledAfterPublish: boolean;
}

export class AtomicReplaceError extends Error {
	readonly code: AtomicReplaceCode;
	readonly path: string;
	/** True when the new bytes are already visible at `path` (the old bytes are gone). */
	readonly published: boolean;
	readonly durable = false;
	/** The errno code of the failing system call, when there was one. */
	readonly errno: string | null;
	/** A temp the cleanup could not remove (its name no longer named our inode, or unlink failed). */
	tempLeft: string | null = null;
	constructor(code: AtomicReplaceCode, path: string, published: boolean, detail: string, cause?: unknown) {
		super(`kitlib-io: ${code}: ${path}: ${detail}`, cause === undefined ? undefined : { cause });
		this.name = "AtomicReplaceError";
		this.code = code;
		this.path = path;
		this.published = published;
		this.errno = errnoOf(cause);
	}
}

/** File-system operations the primitive uses; the test seam replaces them to inject faults. */
export interface IoOps {
	tempName(base: string): string;
	open(path: string, flags: number, mode: number): number;
	write(fd: number, bytes: Uint8Array, offset: number, length: number): number;
	fsync(fd: number): void;
	fchmod(fd: number, mode: number): void;
	fstat(fd: number): Stats;
	lstat(path: string): Stats | null;
	stat(path: string): Stats;
	close(fd: number): void;
	rename(from: string, to: string): void;
	unlink(path: string): void;
	fsyncDirectory(path: string): void;
}

function errnoOf(error: unknown): string | null {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : null;
}

export const defaultIoOps: IoOps = {
	tempName: base => `.${Array.from(base).slice(0, TEMP_BASE_CHARS).join("")}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	open: (path, flags, mode) => openSync(path, flags, mode),
	write: (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length),
	fsync: fd => fsyncSync(fd),
	fchmod: (fd, mode) => fchmodSync(fd, mode),
	fstat: fd => fstatSync(fd),
	lstat: path => { try { return lstatSync(path); } catch (error) { if (errnoOf(error) === "ENOENT") return null; throw error; } },
	stat: path => statSync(path),
	close: fd => closeSync(fd),
	rename: (from, to) => renameSync(from, to),
	unlink: path => unlinkSync(path),
	fsyncDirectory,
};

function normalizedAbsolute(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value) && resolve(value) === value;
}

/**
 * Atomically replaces (or creates) `path` with exactly `bytes`. Throws `AtomicReplaceError`; see the
 * module header for the policy and the published/durable split.
 */
export function atomicReplaceBytes(path: string, bytes: Uint8Array, options: AtomicReplaceOptions): AtomicReplaceResult {
	return atomicReplaceBytesWith(defaultIoOps, new Set(), path, bytes, options);
}

/**
 * Test seam: `ops` injects faults and `bypass` disables named detectors, so the conformance tests can
 * prove each refusal is load-bearing. Production code calls `atomicReplaceBytes`.
 */
export function atomicReplaceBytesWith(ops: IoOps, bypass: ReadonlySet<string>, path: string, bytes: Uint8Array, options: AtomicReplaceOptions): AtomicReplaceResult {
	const refuse = (code: AtomicReplaceCode, detail: string, cause?: unknown, published = false): never => {
		throw new AtomicReplaceError(code, typeof path === "string" ? path : String(path), published, detail, cause);
	};
	if (constants.O_NOFOLLOW === undefined || typeof process.geteuid !== "function")
		refuse("UNSUPPORTED_PLATFORM", "atomic replacement needs POSIX O_NOFOLLOW and euid");
	if (!normalizedAbsolute(path) || basename(path) === "") refuse("UNSAFE_PATH", "path must be absolute and normalized");
	if (!(bytes instanceof Uint8Array)) refuse("INVALID_ARGUMENT", "bytes must be a Uint8Array; serialization is the caller's");
	const { mode, durability, signal } = options ?? ({} as AtomicReplaceOptions);
	if (!Number.isInteger(mode) || (mode & ~MODE_MASK) !== 0) refuse("INVALID_ARGUMENT", `mode must be an explicit subset of 0o755, got ${String(mode)}`);
	if (!DURABILITIES.includes(durability)) refuse("INVALID_ARGUMENT", `durability must be one of ${DURABILITIES.join(", ")}, got ${String(durability)}`);

	const parent = dirname(path);
	let parentInfo: Stats;
	try { parentInfo = ops.stat(parent); } catch (error) { return refuse("UNSAFE_PATH", "parent directory is missing", error); }
	if (!parentInfo.isDirectory()) refuse("UNSAFE_PATH", "parent is not a directory");
	const targetSafe = () => {
		const target = ops.lstat(path);
		if (target && !target.isFile() && !bypass.has("target-check")) refuse("UNSAFE_PATH", "target exists and is not a regular file");
	};
	targetSafe();

	let stage = parent;
	if (options.stageDir !== undefined) {
		if (!normalizedAbsolute(options.stageDir)) refuse("STAGE_UNSAFE", "stageDir must be absolute and normalized");
		const info = ops.lstat(options.stageDir);
		if (!info || !info.isDirectory()) refuse("STAGE_UNSAFE", "stageDir must be an existing real directory");
		stage = options.stageDir;
		if (ops.stat(stage).dev !== parentInfo.dev && !bypass.has("stage-device"))
			refuse("EXDEV", "stageDir is on another filesystem; refusing rather than copying");
	}
	if (options.publicRoot !== undefined) {
		if (!normalizedAbsolute(options.publicRoot)) refuse("INVALID_ARGUMENT", "publicRoot must be absolute and normalized");
		let root: string, real: string;
		try { root = realpathSync(options.publicRoot); real = realpathSync(stage); } catch (error) { return refuse("INVALID_ARGUMENT", "publicRoot or stage cannot be resolved", error); }
		const inside = real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
		if (inside && !bypass.has("stage-public")) refuse("STAGE_IN_PUBLIC_TREE", `stage ${stage} lies inside public tree ${options.publicRoot}`);
	}
	const checkCancel = () => { if (signal?.aborted && !bypass.has("cancel-check")) refuse("CANCELLED", "aborted before publication", signal.reason); };
	checkCancel();

	const temp = join(stage, ops.tempName(basename(path)));
	const fresh = bypass.has("temp-fresh")
		? constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC
		: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
	let fd: number | null;
	try { fd = ops.open(temp, fresh, 0o600); } catch (error) {
		const errno = errnoOf(error);
		if (errno === "EEXIST" || errno === "ELOOP") {
			let link = false;
			try { link = ops.lstat(temp)?.isSymbolicLink() ?? false; } catch { /* classify as plain existence */ }
			return refuse(link ? "TEMP_SYMLINK" : "TEMP_EXISTS", `temp ${temp} already exists`, error);
		}
		return refuse("TEMP_CREATE_FAILED", `cannot create temp ${temp}`, error);
	}

	let identity: Stats | null = null;
	let published = bypass.has("publish-flag");
	let fileSynced = false;
	try {
		identity = ops.fstat(fd);
		if (!identity.isFile() || identity.uid !== process.geteuid?.()) refuse("TEMP_UNSAFE", "temp is not a regular file owned by this user");
		if (identity.nlink !== 1 && !bypass.has("temp-nlink")) refuse("TEMP_HARDLINKED", `temp has ${identity.nlink} links`);
		ops.fchmod(fd, mode);
		options.onBoundary?.("temp-created", temp);
		for (let offset = 0; offset < bytes.length;) {
			let written: number;
			try { written = ops.write(fd, bytes, offset, bytes.length - offset); } catch (error) {
				if (bypass.has("write-error")) break;
				return refuse("WRITE_FAILED", `write failed after ${offset} of ${bytes.length} bytes`, error);
			}
			if (written <= 0) {
				if (bypass.has("write-progress")) break;
				refuse("PARTIAL_WRITE", `write made no progress after ${offset} of ${bytes.length} bytes`);
			}
			offset += written;
		}
		const size = ops.fstat(fd).size;
		if (size !== bytes.length && !bypass.has("size-check")) refuse("SIZE_MISMATCH", `temp holds ${size} of ${bytes.length} bytes`);
		options.onBoundary?.("written", temp);
		checkCancel();
		if (durability !== "none") {
			try { ops.fsync(fd); } catch (error) { if (!bypass.has("file-sync-error")) refuse("FILE_SYNC_FAILED", "temp fsync failed", error); }
			fileSynced = true;
			options.onBoundary?.("file-synced", temp);
		}
		const closing = fd;
		fd = null;
		try { ops.close(closing); } catch (error) { refuse("WRITE_FAILED", "temp close failed", error); }
		if (options.validate && !bypass.has("validate")) {
			try { options.validate(temp); } catch (error) { refuse("VALIDATION_FAILED", "validate refused the staged bytes", error); }
		}
		options.onBoundary?.("validated", temp);
		checkCancel();
		const now = ops.lstat(temp);
		if ((!now || !now.isFile() || now.dev !== identity.dev || now.ino !== identity.ino) && !bypass.has("temp-identity"))
			refuse("TEMP_REPLACED", "temp name no longer names the staged inode");
		if (now && now.nlink !== 1 && !bypass.has("temp-nlink")) refuse("TEMP_HARDLINKED", `temp has ${now.nlink} links before rename`);
		targetSafe();
		try { ops.rename(temp, path); } catch (error) {
			if (errnoOf(error) === "EXDEV") refuse("EXDEV", "rename crossed filesystems; refusing rather than copying", error, published);
			refuse("RENAME_FAILED", "rename failed", error, published);
		}
		published = true;
	} catch (error) {
		if (fd !== null) { try { ops.close(fd); } catch { /* the original failure wins */ } }
		const left = cleanup(ops, temp, identity);
		if (error instanceof AtomicReplaceError) { error.tempLeft = left; throw error; }
		const wrapped = new AtomicReplaceError("WRITE_FAILED", path, published, "unexpected failure before publication", error);
		wrapped.tempLeft = left;
		throw wrapped;
	}

	options.onBoundary?.("renamed", temp);
	if (signal?.aborted && bypass.has("post-publish-cancel")) refuse("CANCELLED", "aborted between rename and directory fsync", signal.reason, true);
	let directorySynced = false;
	if (durability === "full") {
		try { ops.fsyncDirectory(parent); } catch (error) {
			if (!bypass.has("dir-sync-error")) refuse("DIR_SYNC_FAILED", "published, but the directory fsync failed: the new bytes are visible and not durable", error, true);
		}
		directorySynced = true;
		options.onBoundary?.("directory-synced", temp);
	}
	return {
		path, published: true, durability, fileSynced, directorySynced,
		durable: durability === "full" && fileSynced && directorySynced,
		cancelledAfterPublish: signal?.aborted === true,
	};
}

/** Removes our temp when its name still names our inode; returns the temp path when it had to stay. */
function cleanup(ops: IoOps, temp: string, identity: Stats | null): string | null {
	let now: Stats | null;
	try { now = ops.lstat(temp); } catch { return temp; }
	if (!now) return null;
	if (!identity || now.dev !== identity.dev || now.ino !== identity.ino) return temp;
	try { ops.unlink(temp); return null; } catch { return temp; }
}
