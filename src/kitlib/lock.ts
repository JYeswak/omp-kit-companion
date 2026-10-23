/**
 * kitlib lock: the kit's one persistent private resource lock for TypeScript (ompkit-lsn3a, KL08).
 *
 * `privateLock()` is the TypeScript half of a two-language contract;
 * `scripts/kitlib_lock.py` `private_lock()` is the Python half, and both pass
 * the one conformance corpus `tests/fixtures/kitlib-lock/corpus.json`
 * (`tests/cli/kitlib-lock.test.ts`, `tests/scripts/kitlib_lock_test.py`). The
 * two halves take the same `flock(2)` on the same inode, so a TypeScript
 * holder blocks a Python waiter and the other way round.
 *
 * The domain names a resource, never a lock path: `{ namespace, path }` (a
 * filesystem resource, canonicalised with the same non-strict realpath as
 * Python's `os.path.realpath`, so two aliases of one file are one key) or
 * `{ namespace, name }` (an abstract resource). The lock is the separate,
 * persistent file `<state>/<namespace>/<sha256(key)>.lock`; `<state>` is
 * `state_dir` when given, else `$XDG_STATE_HOME/omp-kit` (XDG_STATE_HOME must
 * be absolute) or `~/.local/state/omp-kit`. The state and namespace dirs are
 * created mode 0700 when missing, and every use validates them and the lock
 * file: a symlink, a non-directory or non-regular file, another uid, any
 * group/other mode bit or a second hard link refuses with a typed
 * `PrivateLockError`. The lock file is opened O_NOFOLLOW, its inode is
 * compared with the path before the wait and again after the lock is taken,
 * and a replaced inode refuses: a lock on an orphaned inode would not exclude
 * waiters on the new one. Nothing is ever unlinked, renamed or truncated, and
 * neither the file's age nor any pid in it is read: the kernel releases a
 * flock when the last descriptor closes, so a dead or zombie holder holds
 * nothing and a live one is never broken.
 *
 * The wait polls `LOCK_EX|LOCK_NB` against a monotonic deadline
 * (`deadline_s` >= 0; 0 is one attempt) and refuses `DEADLINE` with evidence
 * (path, key, deadline, waited, attempts). An aborted `signal` closes the
 * descriptor at once: while waiting the call rejects with the abort reason,
 * while held the lock is released. `inherit` (default false) decides
 * FD_CLOEXEC, and the flag is read back: true lets the descriptor survive
 * exec (pass `lock.fd` in a Bun.spawn `stdio` slot to hand it to a child;
 * Bun.spawn closes every descriptor it is not given), false keeps it out of
 * exec'd children so a child cannot keep the lock after the owner releases.
 * `release()` closes the descriptor (never LOCK_UN, so an intentionally
 * inherited child keeps its hold) and reports whether the path still names
 * the held inode.
 *
 * POSIX flock through `bun:ffi` libc; macOS and Linux only. Any other
 * platform, or a libc that does not load, refuses `UNSUPPORTED_PLATFORM`
 * rather than faking a lock. Limits: the namespace dir is checked by path
 * (no openat), so a same-uid process can race it; a flock is advisory and
 * per open file description, so a fork without exec shares it.
 */
import { dlopen, FFIType, read } from "bun:ffi";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const POLL_MS = 25;

export type LockResource = { namespace: string; path: string; name?: never } | { namespace: string; name: string; path?: never };
export interface PrivateLockOptions {
	/** Bounded wait in seconds; 0 tries once. Required. */
	deadline_s: number;
	/** Leave FD_CLOEXEC clear so the descriptor survives exec (default false). */
	inherit?: boolean;
	/** Absolute state root replacing `$XDG_STATE_HOME/omp-kit`. */
	state_dir?: string;
	/** Abort closes the descriptor: rejects while waiting, releases while held. */
	signal?: AbortSignal;
}
export type ReleaseStatus = "RELEASED" | "INODE_REPLACED" | "ALREADY_RELEASED";
export interface PrivateLock {
	readonly fd: number;
	readonly path: string;
	readonly key: string;
	readonly dev: number;
	readonly ino: number;
	readonly waited_s: number;
	release(): ReleaseStatus;
}
export type LockErrorCode =
	| "UNSUPPORTED_PLATFORM" | "INVALID_STATE_DIR" | "SYMLINK" | "NOT_DIRECTORY" | "NOT_REGULAR" | "FOREIGN_UID"
	| "PERMISSIVE_MODE" | "LINKED" | "INODE_REPLACED" | "INHERIT_FAILED" | "DEADLINE" | "IO_ERROR";
export type LockEvidence = { code: LockErrorCode; path: string } & Record<string, unknown>;

export class PrivateLockError extends Error {
	readonly code: LockErrorCode;
	readonly evidence: LockEvidence;
	constructor(evidence: LockEvidence) {
		super(`kitlib-lock: ${evidence.code} ${evidence.path}`);
		this.name = "PrivateLockError";
		this.code = evidence.code;
		this.evidence = evidence;
	}
}

/** Test-only seam: plants and detector bypasses for the conformance corpus. Production code never sets it. */
export const __testing: {
	disabled: Set<string>;
	expectUid: number | undefined;
	skipInherit: boolean;
	afterLock: ((path: string) => void) | undefined;
} = { disabled: new Set(), expectUid: undefined, skipInherit: false, afterLock: undefined };

const on = (detector: string) => !__testing.disabled.has(detector);

type Libc = {
	flock(fd: number, op: number): number;
	fcntl(fd: number, cmd: number): number;
	ioctl(fd: number, request: bigint): number;
	errno(): number;
	EWOULDBLOCK: number;
	EINTR: number;
	FIOCLEX: bigint;
	FIONCLEX: bigint;
};
let libc: Libc | null | undefined;

function loadLibc(): Libc | null {
	if (libc !== undefined) return libc;
	const darwin = process.platform === "darwin";
	if (!darwin && process.platform !== "linux") return (libc = null);
	try {
		const errnoSymbol = darwin ? "__error" : "__errno_location";
		const lib = dlopen(darwin ? "libSystem.B.dylib" : "libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			ioctl: { args: [FFIType.i32, FFIType.u64], returns: FFIType.i32 },
			[errnoSymbol]: { args: [], returns: FFIType.ptr },
		});
		const symbols = lib.symbols as unknown as Record<string, (...args: unknown[]) => unknown>;
		libc = {
			flock: (fd, op) => symbols.flock(fd, op) as number,
			fcntl: (fd, cmd) => symbols.fcntl(fd, cmd) as number,
			ioctl: (fd, request) => symbols.ioctl(fd, request) as number,
			errno: () => read.i32(symbols[errnoSymbol]() as never, 0),
			EWOULDBLOCK: darwin ? 35 : 11,
			EINTR: 4,
			FIOCLEX: darwin ? 0x20006601n : 0x5451n,
			FIONCLEX: darwin ? 0x20006602n : 0x5450n,
		};
	} catch {
		libc = null;
	}
	return libc;
}

function joinPath(base: string, name: string): string {
	return base.endsWith("/") ? base + name : `${base}/${name}`;
}

function parentPath(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash <= 0 ? "/" : path.slice(0, slash);
}

/** posixpath.normpath for an absolute path. */
function normalize(path: string): string {
	const out: string[] = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return `/${out.join("/")}`;
}

/** A port of CPython's non-strict posixpath._joinrealpath, so both halves derive the same key. */
function joinRealpath(start: string, input: string, seen: Map<string, string | null>): [string, boolean] {
	let path = start, rest = input;
	if (rest.startsWith("/")) { rest = rest.slice(1); path = "/"; }
	while (rest) {
		const slash = rest.indexOf("/");
		const name = slash < 0 ? rest : rest.slice(0, slash);
		rest = slash < 0 ? "" : rest.slice(slash + 1);
		if (name === "" || name === ".") continue;
		if (name === "..") { path = parentPath(path); continue; }
		const next = joinPath(path, name);
		let link = false;
		try { link = lstatSync(next).isSymbolicLink(); } catch { link = false; }
		if (!link) { path = next; continue; }
		if (seen.has(next)) {
			const known = seen.get(next);
			if (known !== null && known !== undefined) { path = known; continue; }
			return [joinPath(next, rest), false];
		}
		seen.set(next, null);
		const [resolved, ok] = joinRealpath(path, readlinkSync(next, "utf8"), seen);
		if (!ok) return [joinPath(resolved, rest), false];
		seen.set(next, resolved);
		path = resolved;
	}
	return [path, true];
}

/** Non-strict realpath with the semantics of Python's `os.path.realpath`. */
export function canonicalPath(input: string): string {
	if (typeof input !== "string" || input === "" || input.includes("\0")) throw new TypeError("kitlib-lock: a resource path must be a non-empty string without NUL");
	const [resolved] = joinRealpath(process.cwd(), input, new Map());
	return normalize(resolved);
}

/** The canonical key, its lock file and its dirs; no filesystem change. */
export function resolveLock(resource: LockResource, options: { state_dir?: string } = {}): { key: string; state: string; dir: string; path: string } {
	if (resource === null || typeof resource !== "object") throw new TypeError("kitlib-lock: resource must be { namespace, path } or { namespace, name }");
	const { namespace, path, name } = resource as { namespace?: unknown; path?: unknown; name?: unknown };
	if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) throw new TypeError(`kitlib-lock: namespace must match ${NAMESPACE_PATTERN}`);
	if ((path === undefined) === (name === undefined)) throw new TypeError("kitlib-lock: give exactly one of path or name");
	let key: string;
	if (path !== undefined) key = canonicalPath(path as string);
	else if (typeof name === "string" && NAME_PATTERN.test(name)) key = name;
	else throw new TypeError(`kitlib-lock: name must match ${NAME_PATTERN}`);
	const state = stateRoot(options.state_dir);
	const dir = join(state, namespace);
	return { key, state, dir, path: join(dir, `${createHash("sha256").update(key, "utf8").digest("hex")}.lock`) };
}

function stateRoot(stateDir: string | undefined): string {
	if (stateDir !== undefined) {
		if (typeof stateDir !== "string" || !stateDir.startsWith("/")) throw new PrivateLockError({ code: "INVALID_STATE_DIR", path: String(stateDir), reason: "state_dir must be absolute" });
		return stateDir;
	}
	const xdg = process.env.XDG_STATE_HOME;
	if (xdg) {
		if (!xdg.startsWith("/")) throw new PrivateLockError({ code: "INVALID_STATE_DIR", path: xdg, reason: "XDG_STATE_HOME must be absolute" });
		return join(xdg, "omp-kit");
	}
	return join(homedir(), ".local", "state", "omp-kit");
}

function ioError(path: string, error: unknown, step: string): PrivateLockError {
	const code = (error as NodeJS.ErrnoException)?.code ?? String(error);
	return new PrivateLockError({ code: "IO_ERROR", path, step, errno: code });
}

/** Refuses a symlink, a non-directory, another uid or any group/other bit; creates the dir 0700 when missing. */
function privateDir(path: string, create: "single" | "parents"): void {
	let info: Stats;
	try {
		info = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw ioError(path, error, "lstat");
		try {
			if (create === "parents") mkdirSync(parentPath(path), { recursive: true });
			mkdirSync(path, { mode: 0o700 });
			info = lstatSync(path);
		} catch (inner) {
			if ((inner as NodeJS.ErrnoException).code !== "EEXIST") throw ioError(path, inner, "mkdir");
			try { info = lstatSync(path); } catch (again) { throw ioError(path, again, "lstat"); }
		}
	}
	if (info.isSymbolicLink()) {
		if (on("symlink")) throw new PrivateLockError({ code: "SYMLINK", path, which: "directory" });
		try { info = statSync(path); } catch (error) { throw ioError(path, error, "stat"); }
	}
	if (!info.isDirectory() && on("type")) throw new PrivateLockError({ code: "NOT_DIRECTORY", path });
	checkOwnerMode(path, info, "directory");
}

function checkOwnerMode(path: string, info: Stats, which: string): void {
	const uid = __testing.expectUid ?? process.getuid!();
	if (info.uid !== uid && on("owner")) throw new PrivateLockError({ code: "FOREIGN_UID", path, which, uid: info.uid, expected_uid: uid });
	if ((info.mode & 0o077) !== 0 && on("mode")) throw new PrivateLockError({ code: "PERMISSIVE_MODE", path, which, mode: (info.mode & 0o7777).toString(8).padStart(4, "0") });
}

function sameInode(path: string, held: Stats): boolean {
	try {
		const now = on("symlink") ? lstatSync(path) : statSync(path);
		return now.dev === held.dev && now.ino === held.ino;
	} catch {
		return false;
	}
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("kitlib-lock: aborted");
}

export async function privateLock(resource: LockResource, options: PrivateLockOptions): Promise<PrivateLock> {
	if (options === null || typeof options !== "object") throw new TypeError("kitlib-lock: options with deadline_s are required");
	const deadlineS = options.deadline_s;
	if (typeof deadlineS !== "number" || !Number.isFinite(deadlineS) || deadlineS < 0) throw new TypeError("kitlib-lock: deadline_s must be a finite number >= 0");
	const inherit = options.inherit ?? false;
	if (typeof inherit !== "boolean") throw new TypeError("kitlib-lock: inherit must be a boolean");
	const resolved = resolveLock(resource, { state_dir: options.state_dir });
	const lib = loadLibc();
	if (lib === null || process.getuid === undefined) throw new PrivateLockError({ code: "UNSUPPORTED_PLATFORM", path: resolved.path, platform: process.platform });
	const signal = options.signal;
	if (signal?.aborted) throw abortReason(signal);

	privateDir(resolved.state, options.state_dir === undefined ? "parents" : "single");
	privateDir(resolved.dir, "single");
	const flags = constants.O_CREAT | constants.O_RDWR | (on("symlink") ? constants.O_NOFOLLOW : 0);
	let fd: number;
	try {
		fd = openSync(resolved.path, flags, 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new PrivateLockError({ code: "SYMLINK", path: resolved.path, which: "lock-file" });
		throw ioError(resolved.path, error, "open");
	}
	let open = true;
	const close = () => { if (open) { open = false; closeSync(fd); } };
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() && on("type")) throw new PrivateLockError({ code: "NOT_REGULAR", path: resolved.path });
		checkOwnerMode(resolved.path, opened, "lock-file");
		if (opened.nlink !== 1 && on("links")) throw new PrivateLockError({ code: "LINKED", path: resolved.path, nlink: opened.nlink });
		if (!sameInode(resolved.path, opened) && on("inode")) throw new PrivateLockError({ code: "INODE_REPLACED", path: resolved.path, step: "open" });

		const started = performance.now();
		const limit = started + deadlineS * 1000;
		let attempts = 0;
		for (;;) {
			if (signal?.aborted) throw abortReason(signal);
			attempts += 1;
			const rc = on("flock") ? lib.flock(fd, 2 | 4) : 0; // LOCK_EX | LOCK_NB
			if (rc === 0) break;
			const errno = lib.errno();
			if (errno !== lib.EWOULDBLOCK && errno !== lib.EINTR) throw new PrivateLockError({ code: "IO_ERROR", path: resolved.path, step: "flock", errno });
			const remaining = limit - performance.now();
			if (remaining <= 0) {
				throw new PrivateLockError({
					code: "DEADLINE", path: resolved.path, key: resolved.key, namespace: resource.namespace,
					deadline_s: deadlineS, waited_s: (performance.now() - started) / 1000, attempts,
				});
			}
			await Bun.sleep(Math.min(POLL_MS, remaining));
		}
		const waited = (performance.now() - started) / 1000;

		__testing.afterLock?.(resolved.path);
		if (!sameInode(resolved.path, opened) && on("inode")) throw new PrivateLockError({ code: "INODE_REPLACED", path: resolved.path, step: "locked" });

		if (!(inherit && __testing.skipInherit)) lib.ioctl(fd, inherit ? lib.FIONCLEX : lib.FIOCLEX);
		const cloexec = (lib.fcntl(fd, 1) & 1) === 1; // F_GETFD & FD_CLOEXEC
		if (cloexec === inherit && on("inherit")) throw new PrivateLockError({ code: "INHERIT_FAILED", path: resolved.path, inherit, cloexec });

		let onAbort: (() => void) | undefined;
		const lock: PrivateLock = {
			fd, path: resolved.path, key: resolved.key, dev: opened.dev, ino: opened.ino, waited_s: waited,
			release(): ReleaseStatus {
				if (!open) return "ALREADY_RELEASED";
				if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
				const intact = sameInode(resolved.path, opened) || !on("inode");
				close();
				return intact ? "RELEASED" : "INODE_REPLACED";
			},
		};
		if (signal !== undefined) {
			onAbort = () => { lock.release(); };
			signal.addEventListener("abort", onAbort, { once: true });
		}
		return lock;
	} catch (error) {
		close();
		throw error;
	}
}
