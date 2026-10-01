import { createHash, randomUUID } from "node:crypto";
import {
	closeSync, constants, fchmodSync, fchownSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
	readFileSync, readdirSync, renameSync, rmdirSync, statfsSync, statSync, unlinkSync, writeSync,
	type BigIntStats, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** This module only changes explicitly listed kit-owned files. It does not update OMP. */
export type Image = { sha256: string; size: number; mode: number; uid: number; gid: number };
export type FileMutation = {
	root: string;
	relativePath: string;
	/** Required ownership proof from managed state; null allows only a new, absent target. */
	expectedBefore: Image | null;
	/** null means the target must be absent; an existing unowned file must never be passed as null. */
	after: { bytes: Uint8Array; mode: number; uid?: number; gid?: number } | null;
};
export type MutationInput = { stateRoot: string; roots: readonly { id: string; path: string }[]; files: readonly FileMutation[] };
export type PlannedFile = { root: string; path: string; before: Image | null; after: Image | null };
export type MutationPlan = { readonly stateRoot: string; readonly roots: readonly { id: string; path: string }[]; readonly files: readonly PlannedFile[] };
export type Boundary = "pending-synced" | "directories-created" | `renamed:${number}`;
export type ApplyOptions = { freeBytes?: (path: string) => number; onBoundary?: (boundary: Boundary) => void };
export type PendingInspection = { id: string; state: "BEFORE" | "AFTER" | "PARTIAL" | "DRIFT"; changed: number; remaining: number };
export type RecoveryResult = { id: string; state: "ABORTED_BEFORE" | "COMPLETED_AFTER" };

type ReceiptFile = PlannedFile & { backup: string | null };
type Receipt = { version: 1; id: string; files: ReceiptFile[]; createdDirectories: string[]; cleanupDirectories?: string[]; roots?: { id: string; path: string }[]; undoOf?: string };
type Lock = { release(): void };
const bytesForPlan = new WeakMap<MutationPlan, readonly (Buffer | null)[]>();
const directoriesForPlan = new WeakMap<MutationPlan, Map<string, { dev: bigint; ino: bigint; birthtimeNs: bigint }>>();
const missingForPlan = new WeakMap<MutationPlan, readonly string[]>();
const heldUpdates = new WeakSet<UpdateLockToken>();
const hex = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const fail = (code: string): never => { throw new Error(code); }; // No filesystem exceptions or file bytes cross the public error boundary.
function guarded<T>(run: () => T): T {
	try { return run(); } catch (error) {
		if (error instanceof Error && /^(UNSAFE_PATH|FRESH_PLAN|INSUFFICIENT_SPACE|LOCK_BUSY|LOCK_TOKEN|PENDING_RECOVERY|MUTATION_FAILED|INVALID_PLAN|STATE_UNSAFE|ALREADY_UNDONE|BACKUP_CORRUPT)$/.test(error.message)) throw error;
		return fail("MUTATION_FAILED");
	}
}
function pathComponents(path: string): string[] {
	if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) fail("UNSAFE_PATH");
	const parts: string[] = [];
	for (let cursor = path; cursor !== dirname(cursor); cursor = dirname(cursor)) parts.unshift(cursor);
	parts.unshift(dirname(parts[0] ?? path));
	return parts;
}
function safeDirectory(path: string, create = false, allowMissing = false): void {
	let missing = false;
	for (const part of pathComponents(path)) {
		let info: Stats;
		try { info = lstatSync(part); } catch (error) {
			if (!isNotFound(error)) fail("UNSAFE_PATH");
			if (create) {
				mkdirSync(part, { mode: 0o700 });
				fsyncDirectory(dirname(part));
				info = lstatSync(part);
			} else if (allowMissing) { missing = true; continue; }
			else fail("UNSAFE_PATH");
		}
		if (missing || !info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH");
	}
}
function isNotFound(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function optionalInfo(path: string): Stats | null {
	try { return lstatSync(path); } catch (error) { if (isNotFound(error)) return null; return fail("UNSAFE_PATH"); }
}
function safeState(root: string, create: boolean): void {
	if (!isAbsolute(root) || resolve(root) !== root || root === dirname(root)) fail("STATE_UNSAFE");
	if (create) safeDirectory(root, true);
	else safeDirectory(root, false, true);
	const info = optionalInfo(root);
	if (info && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) fail("STATE_UNSAFE");
}
function openFile(path: string): { bytes: Buffer; image: Image } | null {
	safeDirectory(dirname(path), false, true);
	if (!optionalInfo(dirname(path))) return null;
	const info = optionalInfo(path);
	if (!info) return null;
	if (!info.isFile() || info.isSymbolicLink()) fail("UNSAFE_PATH");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const actual = fstatSync(fd);
		if (!actual.isFile() || actual.ino !== info.ino || actual.dev !== info.dev) fail("FRESH_PLAN");
		const bytes = readFileSync(fd);
		const end = fstatSync(fd);
		if (end.ino !== actual.ino || end.size !== actual.size || end.mtimeMs !== actual.mtimeMs || end.ctimeMs !== actual.ctimeMs) fail("FRESH_PLAN");
		return { bytes, image: { sha256: hex(bytes), size: bytes.length, mode: actual.mode & 0o7777, uid: actual.uid, gid: actual.gid } };
	} finally { closeSync(fd); }
}
function same(a: Image | null, b: Image | null): boolean {
	return a === null || b === null ? a === b : a.sha256 === b.sha256 && a.size === b.size && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
}
function target(root: string, name: string): string {
	if (!name || name.includes("\\") || isAbsolute(name) || name.split("/").some(part => part === "" || part === "." || part === "..")) fail("UNSAFE_PATH");
	const path = resolve(root, name);
	if (path === root || !within(root, path)) fail("UNSAFE_PATH");
	safeDirectory(dirname(path), false, true);
	return path;
}
/** Persist a caller-validated directory's entries after durable file creation or removal. */
export function fsyncDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd: number, value: Buffer | string): void {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	for (let offset = 0; offset < bytes.length;) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		if (written <= 0) fail("MUTATION_FAILED");
		offset += written;
	}
}
/** Exclusively create a mode-0600 file and sync its contents and parent directory. */
export function writePrivate(path: string, value: Buffer | string): void {
	const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try { fchmodSync(fd, 0o600); writeAll(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
	fsyncDirectory(dirname(path));
}
function nearestDirectory(path: string): string {
	let cursor = path;
	while (!optionalInfo(cursor)) cursor = dirname(cursor);
	safeDirectory(cursor);
	return cursor;
}
function checkSpace(plan: MutationPlan, freeBytes: (path: string) => number): void {
	const required = new Map<number, { path: string; bytes: number }>();
	const charge = (path: string, size: number) => {
		const directory = nearestDirectory(path);
		const dev = statSync(directory).dev;
		const previous = required.get(dev);
		required.set(dev, { path: directory, bytes: (previous?.bytes ?? 0) + size });
	};
	// Account for private backup, receipt and adjacent temp plus a conservative metadata/fsync allowance.
	charge(plan.stateRoot, 16_384 + plan.files.length * 4096);
	for (const file of plan.files) {
		if (file.before) charge(plan.stateRoot, file.before.size);
		if (file.after) charge(dirname(file.path), file.after.size + 4096);
	}
	for (const directory of missingForPlan.get(plan) ?? []) charge(directory, 8192);
	for (const item of required.values()) if (freeBytes(item.path) < item.bytes) fail("INSUFFICIENT_SPACE");
}
function availableBytes(path: string): number { const info = statfsSync(path); return info.bavail * info.bsize; }

function directoryInfo(path: string): BigIntStats | null {
	try { return lstatSync(path, { bigint: true }); }
	catch (error) { if (isNotFound(error)) return null; return fail("UNSAFE_PATH"); }
}
function captureDirectory(path: string, identities: Map<string, { dev: bigint; ino: bigint; birthtimeNs: bigint }>): void {
	for (const part of pathComponents(path)) {
		const info = directoryInfo(part);
		if (!info) break;
		if (!info.isDirectory() || info.isSymbolicLink() || info.birthtimeNs === 0n) fail("UNSAFE_PATH");
		identities.set(part, { dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs });
	}
}
function verifyDirectories(plan: MutationPlan): void {
	const identities = directoriesForPlan.get(plan);
	if (!identities) fail("INVALID_PLAN");
	for (const [part, expected] of identities) {
		const actual = directoryInfo(part);
		if (!actual || !actual.isDirectory() || actual.isSymbolicLink() ||
			actual.dev !== expected.dev || actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs)
			fail("FRESH_PLAN");
	}
}

function missingParents(path: string, missing: Set<string>): void {
	for (const part of pathComponents(path)) {
		const info = optionalInfo(part);
		if (!info) missing.add(part);
		else if (!info.isDirectory() || info.isSymbolicLink()) fail("UNSAFE_PATH");
	}
}

function verifyMissingDirectories(plan: MutationPlan): readonly string[] {
	const directories = missingForPlan.get(plan);
	if (!directories) fail("INVALID_PLAN");
	for (const directory of directories) if (optionalInfo(directory)) fail("FRESH_PLAN");
	return directories;
}

/** Read-only: captures bytes and ownership without creating a state directory or managed parents. */
export function planMutation(input: MutationInput): MutationPlan {
	return guarded(() => {
		safeState(input.stateRoot, false);
		if (input.roots.length === 0 || input.files.length === 0) fail("INVALID_PLAN");
		const identities = new Map<string, { dev: bigint; ino: bigint; birthtimeNs: bigint }>();
		captureDirectory(input.stateRoot, identities);
		const roots = new Map<string, string>();
		for (const root of input.roots) {
			if (!/^[a-zA-Z][\w-]*$/.test(root.id) || roots.has(root.id) || !isAbsolute(root.path) || resolve(root.path) !== root.path || root.path === dirname(root.path)) fail("INVALID_PLAN");
			safeDirectory(root.path, false, true);
			captureDirectory(root.path, identities);
			roots.set(root.id, root.path);
		}
		const files: PlannedFile[] = [];
		const content: (Buffer | null)[] = [];
		const seen = new Set<string>();
		const missing = new Set<string>();
		for (const file of input.files) {
			const root = roots.get(file.root);
			if (!root) fail("INVALID_PLAN");
			const path = target(root, file.relativePath);
			if (file.after) missingParents(dirname(path), missing);
			captureDirectory(dirname(path), identities);
			if (within(input.stateRoot, path) || seen.has(path)) fail("INVALID_PLAN");
			seen.add(path);
			const before = openFile(path)?.image ?? null;
			if (!same(before, file.expectedBefore)) fail("FRESH_PLAN");
			if (before === null && file.after === null) fail("INVALID_PLAN");
			const bytes = file.after ? Buffer.from(file.after.bytes) : null;
			const uid = file.after?.uid ?? process.getuid?.();
			const gid = file.after?.gid ?? process.getgid?.();
			if (bytes && (uid === undefined || gid === undefined || !Number.isInteger(file.after?.mode) || file.after!.mode < 0 || file.after!.mode > 0o7777)) fail("INVALID_PLAN");
			files.push(Object.freeze({ root: file.root, path, before: before ? Object.freeze(before) : null, after: bytes ? Object.freeze({ sha256: hex(bytes), size: bytes.length, mode: file.after!.mode, uid: uid!, gid: gid! }) : null }));
			content.push(bytes);
		}
		const plan: MutationPlan = Object.freeze({ stateRoot: input.stateRoot, roots: Object.freeze(input.roots.map(root => Object.freeze({ ...root }))), files: Object.freeze(files) });
		bytesForPlan.set(plan, content);
		directoriesForPlan.set(plan, identities);
		const directories = [...missing];
		if (directories.some(path => within(path, input.stateRoot))) fail("INVALID_PLAN");
		missingForPlan.set(plan, directories);
		return plan;
	});
}

function acquire(stateRoot: string, name: string): Lock {
	safeState(stateRoot, true);
	const path = join(stateRoot, name);
	const reclaimDeadHolder = (): void => {
		const file = openFile(path);
		if (!file || file.image.uid !== process.getuid?.() || file.image.mode !== 0o600 ||
			!/^[1-9]\d{0,9}\n$/.test(file.bytes.toString("ascii"))) fail("STATE_UNSAFE");
		const pid = Number(file.bytes.toString("ascii").trim());
		try { process.kill(pid, 0); fail("LOCK_BUSY"); }
		catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
				if (error instanceof Error && error.message === "LOCK_BUSY") throw error;
				fail("LOCK_BUSY");
			}
		}
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.uid !== file.image.uid ||
			(before.mode & 0o7777) !== file.image.mode ||
			hex(readFileSync(path)) !== file.image.sha256) fail("STATE_UNSAFE");
		const current = lstatSync(path);
		if (current.ino !== before.ino || current.dev !== before.dev ||
			current.birthtimeMs !== before.birthtimeMs) fail("LOCK_BUSY");
		unlinkSync(path);
		fsyncDirectory(stateRoot);
	};
	// Publish a fully fsynced PID through an exclusive hard link: death before publication
	// leaves no empty visible lock, while death afterward leaves a reclaimable holder.
	const candidate = `${path}.candidate-${randomUUID()}`;
	const fd = openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	let linked = false, published = false;
	try {
		writeAll(fd, `${process.pid}\n`);
		fsyncSync(fd);
		try { linkSync(candidate, path); }
		catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			reclaimDeadHolder();
			try { linkSync(candidate, path); } catch { fail("LOCK_BUSY"); }
		}
		linked = true;
		fsyncDirectory(stateRoot);
		published = true;
	} finally {
		if (!published && linked) {
			const linkedInfo = fstatSync(fd), current = lstatSync(path);
			if (current.dev === linkedInfo.dev && current.ino === linkedInfo.ino) unlinkSync(path);
		}
		unlinkSync(candidate);
		fsyncDirectory(stateRoot);
		if (!published) closeSync(fd);
	}
	const info = fstatSync(fd);
	let released = false;
	return { release() {
		if (released) return;
		released = true;
		try {
			const current = lstatSync(path);
			if (current.ino !== info.ino || current.dev !== info.dev || !current.isFile()) fail("STATE_UNSAFE");
			unlinkSync(path); fsyncDirectory(stateRoot);
		} finally { closeSync(fd); }
	} };
}

/** Opaque, held across the entire update including external launcher and post-check. Never serialize a token. */
export class UpdateLockToken {
	readonly #stateRoot: string;
	readonly #lock: Lock;
	constructor(stateRoot: string, lock: Lock) { this.#stateRoot = stateRoot; this.#lock = lock; }
	validFor(stateRoot: string): boolean { return heldUpdates.has(this) && this.#stateRoot === stateRoot; }
	release(): void { if (!heldUpdates.has(this)) return; this.#lock.release(); heldUpdates.delete(this); }
}
export function acquireKitUpdateLock(stateRoot: string, held?: UpdateLockToken): UpdateLockToken {
	return guarded(() => {
		if (held) { if (!(held instanceof UpdateLockToken) || !held.validFor(stateRoot)) fail("LOCK_TOKEN"); return held; }
		const lock = acquire(stateRoot, ".kit-update.lock");
		const token = new UpdateLockToken(stateRoot, lock);
		heldUpdates.add(token);
		return token;
	});
}

export type KitUpdateStart = {
	scope: "kit" | "omp" | "all";
	/** Hash, not the install path or any credential-bearing launcher output. */
	identitySha256: string;
	kitVersion: string | null;
	ompVersion: string | null;
	channel: string | null;
};
export type PendingKitUpdate = KitUpdateStart & { id: string; state: "PENDING" };
function updatePendingPath(stateRoot: string): string { return join(stateRoot, "kit-update.pending.json"); }
function isUpdateMetadata(value: unknown): value is KitUpdateStart {
	if (!value || typeof value !== "object" || !("scope" in value) || !["kit", "omp", "all"].includes(String(value.scope)) ||
		!("identitySha256" in value) || typeof value.identitySha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.identitySha256)) return false;
	return ["kitVersion", "ompVersion", "channel"].every(key => {
		if (!(key in value)) return false;
		const part = value[key];
		return part === null || (typeof part === "string" && part.length <= 128 && /^[a-zA-Z0-9._@/+:-]*$/.test(part));
	});
}
function requireUpdateToken(stateRoot: string, token: UpdateLockToken): void {
	if (!(token instanceof UpdateLockToken) || !token.validFor(stateRoot)) fail("LOCK_TOKEN");
}
/** Call under the held update token *before* any external launcher or kit update can run. */
export function beginKitUpdateReceipt(stateRoot: string, token: UpdateLockToken, start: KitUpdateStart): PendingKitUpdate {
	return guarded(() => {
		requireUpdateToken(stateRoot, token);
		if (!isUpdateMetadata(start)) fail("INVALID_PLAN");
		if (inspectPendingKitUpdate(stateRoot)) fail("PENDING_RECOVERY");
		const pending: PendingKitUpdate = { scope: start.scope, identitySha256: start.identitySha256,
			kitVersion: start.kitVersion, ompVersion: start.ompVersion, channel: start.channel, id: randomUUID(), state: "PENDING" };
		writePrivate(updatePendingPath(stateRoot), JSON.stringify(pending));
		return pending;
	});
}
/** Safe on restart, even when an abandoned update lock prevents new owners. */
export function inspectPendingKitUpdate(stateRoot: string): PendingKitUpdate | null {
	return guarded(() => {
		safeState(stateRoot, false);
		if (!optionalInfo(stateRoot)) return null;
		const file = openFile(updatePendingPath(stateRoot));
		if (!file) return null;
		if (file.image.mode & 0o077) fail("STATE_UNSAFE");
		const value: unknown = JSON.parse(file.bytes.toString("utf8"));
		if (!value || typeof value !== "object" || !("state" in value) || value.state !== "PENDING" ||
			!("id" in value) || typeof value.id !== "string" || !/^[a-f0-9-]+$/.test(value.id) ||
			!isUpdateMetadata(value)) fail("STATE_UNSAFE");
		return { id: value.id, state: "PENDING", scope: value.scope, identitySha256: value.identitySha256,
			kitVersion: value.kitVersion, ompVersion: value.ompVersion, channel: value.channel };
	});
}
/** Resolve an update only after the caller verifies either successful postimages or a compensated kit-only rollback. */
function finishKitUpdateReceipt<T extends "RECONCILED" | "ABORTED_AFTER_COMPENSATION">(stateRoot: string, token: UpdateLockToken, id: string,
	state: T, rescan: () => boolean): { id: string; state: T } {
	return guarded(() => {
		requireUpdateToken(stateRoot, token);
		const pending = inspectPendingKitUpdate(stateRoot);
		if (!pending || pending.id !== id || state === "ABORTED_AFTER_COMPENSATION" && pending.scope !== "kit") fail("PENDING_RECOVERY");
		if (rescan() !== true) fail("PENDING_RECOVERY");
		safeDirectory(receiptsDir(stateRoot), true);
		const receipt = join(receiptsDir(stateRoot), `update-${id}.json`);
		const content = JSON.stringify({ ...pending, state });
		const existing = openFile(receipt);
		if (existing) {
			if (existing.bytes.toString("utf8") !== content || existing.image.mode & 0o077) fail("STATE_UNSAFE");
		} else writePrivate(receipt, content);
		unlinkSync(updatePendingPath(stateRoot));
		fsyncDirectory(stateRoot);
		return { id, state };
	});
}
/** A successful update needs a real identity/channel/version and passing post-check. */
export function reconcileKitUpdateReceipt(stateRoot: string, token: UpdateLockToken, id: string, rescan: () => boolean): { id: string; state: "RECONCILED" } {
	return finishKitUpdateReceipt(stateRoot, token, id, "RECONCILED", rescan);
}
/** A failed kit-only update may end as compensated, NEVER as a successful post-check. */
export function abortCompensatedKitUpdateReceipt(stateRoot: string, token: UpdateLockToken, id: string, rescan: () => boolean): { id: string; state: "ABORTED_AFTER_COMPENSATION" } {
	return finishKitUpdateReceipt(stateRoot, token, id, "ABORTED_AFTER_COMPENSATION", rescan);
}

function pendingDir(stateRoot: string): string { return join(stateRoot, "pending"); }
function receiptsDir(stateRoot: string): string { return join(stateRoot, "receipts"); }
function isImage(value: unknown): value is Image {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<Image>;
	return typeof item.sha256 === "string" && /^[a-f0-9]{64}$/.test(item.sha256) &&
		typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 &&
		typeof item.mode === "number" && Number.isInteger(item.mode) && item.mode >= 0 && item.mode <= 0o7777 &&
		typeof item.uid === "number" && Number.isSafeInteger(item.uid) && item.uid >= 0 &&
		typeof item.gid === "number" && Number.isSafeInteger(item.gid) && item.gid >= 0;
}
function receiptId(id: string): void { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) fail("STATE_UNSAFE"); }
function readReceipt(path: string): Receipt {
	const file = openFile(path);
	if (!file || file.image.mode & 0o077 || file.image.uid !== process.getuid?.()) fail("STATE_UNSAFE");
	const value: unknown = JSON.parse(file.bytes.toString("utf8"));
	if (!value || typeof value !== "object") fail("STATE_UNSAFE");
	const receipt = value as Partial<Receipt>;
	if (receipt.version !== 1 || typeof receipt.id !== "string") fail("STATE_UNSAFE");
	receiptId(receipt.id);
	if (![`${receipt.id}.json`, `${receipt.id}.ABORTED_BEFORE.json`, `${receipt.id}.COMPLETED_AFTER.json`].includes(basename(path)) ||
		!Array.isArray(receipt.files) || receipt.files.length === 0 ||
		!Array.isArray(receipt.createdDirectories) ||
		receipt.undoOf !== undefined && (typeof receipt.undoOf !== "string" || !/^[a-f0-9-]+$/.test(receipt.undoOf))) fail("STATE_UNSAFE");
	const stateRoot = dirname(dirname(path));
	if (receipt.roots !== undefined && (!Array.isArray(receipt.roots) ||
		receipt.roots.some(root => !root || typeof root.id !== "string" || !/^[a-zA-Z][\w-]*$/.test(root.id) ||
			typeof root.path !== "string" || !isAbsolute(root.path) || resolve(root.path) !== root.path ||
			within(stateRoot, root.path)) ||
		new Set(receipt.roots.map(root => root.id)).size !== receipt.roots.length)) fail("STATE_UNSAFE");
	const seen = new Set<string>();
	for (const [index, entry] of receipt.files.entries()) {
		if (!entry || typeof entry !== "object" || typeof entry.root !== "string" || !/^[a-zA-Z][\w-]*$/.test(entry.root) ||
			typeof entry.path !== "string" || !isAbsolute(entry.path) || resolve(entry.path) !== entry.path ||
			within(stateRoot, entry.path) || seen.has(entry.path) ||
			(receipt.roots !== undefined && !receipt.roots.some(root => root.id === entry.root && entry.path !== root.path && within(root.path, entry.path))) ||
			(entry.before !== null && !isImage(entry.before)) || (entry.after !== null && !isImage(entry.after)) ||
			(entry.before === null && entry.after === null) ||
			entry.backup !== (entry.before ? join(stateRoot, "backups", receipt.id, `${index}.bak`) : null)) fail("STATE_UNSAFE");
		seen.add(entry.path);
	}
	const permittedDirectory = (directory: string): boolean => isAbsolute(directory) &&
		resolve(directory) === directory && !within(stateRoot, directory) && !within(directory, stateRoot) &&
		Boolean(receipt.roots?.some(root => (within(root.path, directory) || within(directory, root.path)) &&
			receipt.files!.some(entry => entry.root === root.id && entry.path !== directory && within(directory, entry.path))));
	if (!receipt.createdDirectories.every(directory => typeof directory === "string" && permittedDirectory(directory)) ||
		(receipt.cleanupDirectories !== undefined && (!receipt.undoOf || !Array.isArray(receipt.cleanupDirectories) ||
			!receipt.cleanupDirectories.every(directory => typeof directory === "string" && permittedDirectory(directory))))) fail("STATE_UNSAFE");
	return receipt as Receipt;
}
function requireDirectoryProof(receipt: Receipt, stateRoot: string): void {
	if (!receipt.createdDirectories.length) return;
	const proof = openFile(join(stateRoot, "backups", receipt.id, "directory-proof.json"));
	if (!proof || proof.image.mode !== 0o600 || proof.image.uid !== process.getuid?.()) fail("STATE_UNSAFE");
	let value: unknown;
	try { value = JSON.parse(proof.bytes.toString("utf8")); } catch { return fail("STATE_UNSAFE"); }
	if (!Array.isArray(value) || value.length !== receipt.createdDirectories.length) fail("STATE_UNSAFE");
	for (const [index, entry] of value.entries()) {
		if (!entry || typeof entry !== "object" || entry.path !== receipt.createdDirectories[index] ||
			!["dev", "ino", "birthtimeNs"].every(key => typeof entry[key] === "string" && /^[0-9]+$/.test(entry[key]))) fail("STATE_UNSAFE");
		const current = directoryInfo(entry.path);
		if (!current || !current.isDirectory() || current.isSymbolicLink() ||
			current.dev.toString() !== entry.dev || current.ino.toString() !== entry.ino ||
			current.birthtimeNs.toString() !== entry.birthtimeNs) fail("FRESH_PLAN");
	}
}

/** Inverse receipts retain this work until all original empty directories are removed. */
function cleanupRestoredDirectories(directories: readonly string[]): void {
	for (const directory of [...directories].reverse()) {
		const info = optionalInfo(directory);
		if (!info) continue;
		safeDirectory(directory);
		if (!info.isDirectory() || info.uid !== process.getuid?.() ||
			(info.mode & 0o7777) !== 0o700 || readdirSync(directory).length !== 0) fail("PENDING_RECOVERY");
		rmdirSync(directory);
		fsyncDirectory(dirname(directory));
	}
}

function pendingReceipts(stateRoot: string): Receipt[] {
	safeState(stateRoot, false);
	if (!optionalInfo(pendingDir(stateRoot))) return [];
	safeDirectory(pendingDir(stateRoot));
	return readdirSync(pendingDir(stateRoot)).map(name => {
		if (!/^[a-f0-9-]+\.json$/.test(name)) fail("STATE_UNSAFE");
		return readReceipt(join(pendingDir(stateRoot), name));
	});
}
function classify(receipt: Receipt): PendingInspection {
	let before = 0, after = 0, drift = 0;
	for (const file of receipt.files) {
		const image = openFile(file.path)?.image ?? null;
		if (same(image, file.after)) after++;
		else if (same(image, file.before)) before++;
		else drift++;
	}
	return { id: receipt.id, state: drift ? "DRIFT" : after === receipt.files.length ? "AFTER" : before === receipt.files.length ? "BEFORE" : "PARTIAL", changed: after, remaining: before };
}
function observedState(receipt: Receipt): PendingInspection["state"] {
	try { return classify(receipt).state; }
	catch (error) {
		if (error instanceof Error && ["UNSAFE_PATH", "FRESH_PLAN"].includes(error.message)) return "DRIFT";
		throw error;
	}
}
/** Read-only restart diagnostic. Any pending transaction blocks all new mutations until reconciled. */
export function inspectPendingMutations(stateRoot: string): PendingInspection[] { return guarded(() => pendingReceipts(stateRoot).map(classify)); }
/** Create and validate the private root before a durable feature backup is written. */
export function ensureMutationStateRoot(stateRoot: string): void { guarded(() => safeState(stateRoot, true)); }
export type AuditStatus = "APPLIED" | "RESTORED" | "UNDO_PARTIAL" | "BEFORE" | "AFTER" |
	"PARTIAL" | "DRIFT" | "ABORTED_BEFORE" | "ABORTED_AFTER_COMPENSATION" | "COMPLETED_AFTER" | "PENDING" | "RECONCILED";
export type AuditReport = {
	id: string; kind: "mutation" | "update"; status: AuditStatus; recordedAt: string;
	files: AuditFile[]; undoOf?: string; undoneBy?: string; scope?: "kit" | "omp" | "all"; rescanRequired?: true;
	current?: PendingInspection["state"];
};
function backupState(file: ReceiptFile): AuditFile["backup"] {
	if (!file.before || !file.backup) return "NONE";
	try {
		const backup = openFile(file.backup);
		if (!backup) return "MISSING";
		return backup.image.sha256 === file.before.sha256 && backup.image.size === file.before.size &&
			backup.image.mode === 0o600 && backup.image.uid === process.getuid?.() ? "READY" : "CORRUPT";
	} catch (error) {
		if (error instanceof Error && error.message === "UNSAFE_PATH") return "CORRUPT";
		throw error;
	}
}
function publicReceiptPath(file: ReceiptFile, receipt: Receipt): string {
	const root = receipt.roots?.find(entry => entry.id === file.root);
	if (!root) return "<private-path>";
	const name = relative(root.path, file.path);
	if (file.root !== "home") return "<private-path>";
	if (/^\.agents\/rules\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name))
		return ".agents/rules/<rule>.md";
	if (name === ".agents/omp-kit-ownership.json" || name === ".omp/agent/config.yml") return name;
	if (/^\.omp\/profiles\/[^/]+\/agent\/config\.yml$/.test(name))
		return ".omp/profiles/<profile>/agent/config.yml";
	return "<private-path>";
}

function receiptReport(path: string, status: AuditStatus): AuditReport {
	const receipt = readReceipt(path);
	const current = observedState(receipt);
	const directoriesDrifted = receipt.cleanupDirectories?.some(directory => optionalInfo(directory) !== null) ?? false;
	return { id: receipt.id, kind: "mutation", status, recordedAt: lstatSync(path).mtime.toISOString(),
		current: current === "AFTER" && directoriesDrifted ? "DRIFT" : current,
		files: receipt.files.map(file => ({
			root: ["home", "rules", "kit", "omp"].includes(file.root) ? file.root : "<root>",
			name: publicReceiptPath(file, receipt),
			action: file.before === null ? "CREATED" : file.after === null ? "DELETED" : "REPLACED",
			backup: backupState(file),
		})), ...(receipt.undoOf ? { undoOf: receipt.undoOf } : {}) };
}
function readUpdateReport(path: string): AuditReport {
	const file = openFile(path);
	if (!file || file.image.mode & 0o077 || file.image.uid !== process.getuid?.()) fail("STATE_UNSAFE");
	const value: unknown = JSON.parse(file.bytes.toString("utf8"));
	if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" ||
		!isUpdateMetadata(value) || !("state" in value) ||
		(value.state !== "RECONCILED" && (value.state !== "ABORTED_AFTER_COMPENSATION" || value.scope !== "kit")) ||
		basename(path) !== `update-${value.id}.json`) fail("STATE_UNSAFE");
	receiptId(value.id);
	return { id: value.id, kind: "update", status: value.state,
		recordedAt: lstatSync(path).mtime.toISOString(), files: [], scope: value.scope };
}
/** No private paths, hashes, receipt internals, or backup contents cross this boundary. */
export function auditMutations(stateRoot: string): AuditReport[] {
	return guarded(() => {
		safeState(stateRoot, false);
		const rows: AuditReport[] = [];
		if (optionalInfo(receiptsDir(stateRoot))) {
			safeDirectory(receiptsDir(stateRoot));
			for (const name of readdirSync(receiptsDir(stateRoot))) {
				const path = join(receiptsDir(stateRoot), name);
				if (name.startsWith("update-")) rows.push(readUpdateReport(path));
				else {
					const match = /^([a-f0-9-]+)(?:\.(ABORTED_BEFORE|COMPLETED_AFTER))?\.json$/.exec(name);
					if (!match) fail("STATE_UNSAFE");
					const status = match[2] === "ABORTED_BEFORE" ? "ABORTED_BEFORE" : match[2] === "COMPLETED_AFTER" ? "COMPLETED_AFTER" : "APPLIED";
					rows.push(receiptReport(path, status));
				}
			}
		}
		if (optionalInfo(pendingDir(stateRoot))) {
			safeDirectory(pendingDir(stateRoot));
			for (const name of readdirSync(pendingDir(stateRoot))) {
				if (!/^[a-f0-9-]+\.json$/.test(name)) fail("STATE_UNSAFE");
				const path = join(pendingDir(stateRoot), name);
				const pending = receiptReport(path, "PARTIAL");
				rows.push({ ...pending, status: pending.current!, rescanRequired: true });
			}
		}
		const pendingUpdate = inspectPendingKitUpdate(stateRoot);
		if (pendingUpdate) rows.push({ id: pendingUpdate.id, kind: "update", status: "PENDING",
			recordedAt: lstatSync(updatePendingPath(stateRoot)).mtime.toISOString(), files: [], scope: pendingUpdate.scope, rescanRequired: true });
		const seen = new Set<string>();
		for (const row of rows) {
			if (seen.has(row.id)) fail("STATE_UNSAFE");
			seen.add(row.id);
		}
		for (const row of rows) {
			if (row.undoOf && ["APPLIED", "COMPLETED_AFTER"].includes(row.status)) {
				const source = rows.find(other => other.id === row.undoOf);
				if (source) {
					source.status = row.current === "AFTER" ? "RESTORED" : "DRIFT";
					source.undoneBy = row.id;
				}
			} else if (row.undoOf && row.status !== "ABORTED_BEFORE") {
				const source = rows.find(other => other.id === row.undoOf);
				if (source) source.status = "UNDO_PARTIAL";
			}
		}
		return rows.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
	});
}
export function whyMutation(stateRoot: string, id: string): AuditReport {
	receiptId(id);
	const report = auditMutations(stateRoot).find(row => row.id === id);
	if (!report) fail("STATE_UNSAFE");
	return report;
}
/** Only fully verified before/after images can be acknowledged; mixed or drifted state needs operator repair. */
export function recoverMutation(stateRoot: string, id: string): RecoveryResult {
	return guarded(() => {
		if (!/^[a-f0-9-]+$/.test(id)) fail("STATE_UNSAFE");
		const lock = acquire(stateRoot, ".mutation-recovery.lock");
		try {
			const receipt = readReceipt(join(pendingDir(stateRoot), `${id}.json`));
			if (receipt.id !== id) fail("STATE_UNSAFE");
			const inspection = classify(receipt);
			if (inspection.state !== "BEFORE" && inspection.state !== "AFTER") fail("PENDING_RECOVERY");
			for (const path of [...receipt.createdDirectories].reverse()) {
				const info = optionalInfo(path);
				if (!info) {
					if (inspection.state === "AFTER") fail("PENDING_RECOVERY");
					continue;
				}
				if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() ||
					(info.mode & 0o777) !== 0o700) fail("PENDING_RECOVERY");
				const marker = `.omp-kit-create-${id}`;
				const proof = openFile(join(path, marker));
				const entries = readdirSync(path);
				if (!proof || proof.image.mode !== 0o600 || proof.bytes.toString("utf8") !== `${id}\n` ||
					(inspection.state === "BEFORE" && (entries.length !== 1 || entries[0] !== marker))) fail("PENDING_RECOVERY");
				unlinkSync(join(path, marker));
				fsyncDirectory(path);
				if (inspection.state === "BEFORE") {
					rmdirSync(path);
					fsyncDirectory(dirname(path));
				}
			}
			if (inspection.state === "AFTER" && receipt.cleanupDirectories)
				cleanupRestoredDirectories(receipt.cleanupDirectories);
			const state = inspection.state === "AFTER" ? "COMPLETED_AFTER" : "ABORTED_BEFORE";
			writePrivate(join(receiptsDir(stateRoot), `${id}.${state}.json`), JSON.stringify(receipt));
			unlinkSync(join(pendingDir(stateRoot), `${id}.json`));
			fsyncDirectory(pendingDir(stateRoot));
			return { id, state };
		} finally { lock.release(); }
	});
}

/** Synchronous, fail-closed mutation. A fault after the first rename leaves the pending receipt and backups intact. */
export function applyMutation(plan: MutationPlan, options: ApplyOptions = {}): { id: string; files: number } {
	return guarded(() => runMutation(plan, options));
}
function runMutation(plan: MutationPlan, options: ApplyOptions, heldRecovery?: Lock, undoOf?: string,
	cleanupDirectories: readonly string[] = []): { id: string; files: number } {
		const content = bytesForPlan.get(plan);
		if (!content || content.length !== plan.files.length) fail("INVALID_PLAN");
		// The free-space probe precedes *all* writes including lock/state creation.
		checkSpace(plan, options.freeBytes ?? availableBytes);
		const locks: Lock[] = [];
		try {
			if (!heldRecovery) locks.push(acquire(plan.stateRoot, ".mutation-recovery.lock"));
			for (const root of [...plan.roots].sort((a, b) => a.path.localeCompare(b.path))) {
				locks.push(acquire(plan.stateRoot, `.mutation-${hex(Buffer.from(root.path))}.lock`));
			}
			if (pendingReceipts(plan.stateRoot).length !== 0) fail("PENDING_RECOVERY");
			verifyDirectories(plan);
			const newDirectories = verifyMissingDirectories(plan);
			for (const file of plan.files) if (!same(openFile(file.path)?.image ?? null, file.before)) fail("FRESH_PLAN");
			const id = randomUUID();
			const backups = join(plan.stateRoot, "backups", id);
			safeDirectory(backups, true);
			const files: ReceiptFile[] = [];
			for (let n = 0; n < plan.files.length; n++) {
				const file = plan.files[n]!;
				let backup: string | null = null;
				if (file.before) {
					backup = join(backups, `${n}.bak`);
					const original = openFile(file.path);
					if (!original || !same(original.image, file.before)) fail("FRESH_PLAN");
					writePrivate(backup, original.bytes);
				}
				files.push({ ...file, backup });
			}
			fsyncDirectory(backups);
			safeDirectory(pendingDir(plan.stateRoot), true);
			safeDirectory(receiptsDir(plan.stateRoot), true);
			const receipt: Receipt = { version: 1, id, files, createdDirectories: [...newDirectories],
				roots: plan.roots.map(root => ({ ...root })), ...(undoOf ? { undoOf } : {}),
				...(cleanupDirectories.length ? { cleanupDirectories: [...cleanupDirectories] } : {}) };
			const pending = join(pendingDir(plan.stateRoot), `${id}.json`);
			writePrivate(pending, JSON.stringify(receipt));
			options.onBoundary?.("pending-synced");
			verifyMissingDirectories(plan);
			const identities = directoriesForPlan.get(plan);
			if (!identities) fail("INVALID_PLAN");
			for (const directory of newDirectories) {
				if (optionalInfo(directory)) fail("FRESH_PLAN");
				mkdirSync(directory, { mode: 0o700 });
				fsyncDirectory(dirname(directory));
				writePrivate(join(directory, `.omp-kit-create-${id}`), `${id}\n`);
				captureDirectory(directory, identities);
			}
			if (newDirectories.length) {
				const proof = newDirectories.map(path => {
					const info = identities.get(path);
					if (!info) fail("STATE_UNSAFE");
					return { path, dev: info.dev.toString(), ino: info.ino.toString(),
						birthtimeNs: info.birthtimeNs.toString() };
				});
				writePrivate(join(backups, "directory-proof.json"), JSON.stringify(proof));
			}
			options.onBoundary?.("directories-created");
			for (let n = 0; n < files.length; n++) {
				const file = files[n]!;
				verifyDirectories(plan);
				if (!same(openFile(file.path)?.image ?? null, file.before)) fail("FRESH_PLAN");
				if (file.after) {
					const staged = join(dirname(file.path), `.${basename(file.path)}.omp-kit-${id}-${n}`);
					const fd = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
					let renamed = false;
					try {
						try {
							const bytes = content[n]!;
							if (!bytes) fail("INVALID_PLAN");
							writeAll(fd, bytes);
							const meta = fstatSync(fd);
							if (meta.uid !== file.after.uid || meta.gid !== file.after.gid) fchownSync(fd, file.after.uid, file.after.gid);
							fchmodSync(fd, file.after.mode);
							fsyncSync(fd);
						} finally { closeSync(fd); }
						// Recheck immediately before rename; Node does not expose renameat/openat dirfd guarantees.
						verifyDirectories(plan);
						if (!same(openFile(file.path)?.image ?? null, file.before)) fail("FRESH_PLAN");
						renameSync(staged, file.path);
						renamed = true;
					} finally {
						if (!renamed && optionalInfo(staged)) { unlinkSync(staged); fsyncDirectory(dirname(staged)); }
					}
				} else {
					unlinkSync(file.path);
				}
				fsyncDirectory(dirname(file.path));
				if (!same(openFile(file.path)?.image ?? null, file.after)) fail("PENDING_RECOVERY");
				options.onBoundary?.(`renamed:${n}`);
			}
			for (const directory of newDirectories) {
				unlinkSync(join(directory, `.omp-kit-create-${id}`));
				fsyncDirectory(directory);
			}
			if (cleanupDirectories.length) cleanupRestoredDirectories(cleanupDirectories);
			renameSync(pending, join(receiptsDir(plan.stateRoot), `${id}.json`));
			fsyncDirectory(pendingDir(plan.stateRoot)); fsyncDirectory(receiptsDir(plan.stateRoot));
			return { id, files: files.length };
		} finally { for (const lock of locks.reverse()) lock.release(); }
}

/** Lock covers receipt read, all postimages, private preimages, and the inverse durable mutation. */
export function undoMutation(stateRoot: string, id: string, options: { confirmed: true; onBoundary?: ApplyOptions["onBoundary"] }): { id: string; files: number; status: "RESTORED" } {
	return guarded(() => {
		if (options?.confirmed !== true) fail("INVALID_PLAN");
		receiptId(id);
		const lock = acquire(stateRoot, ".mutation-recovery.lock");
		try {
			if (pendingReceipts(stateRoot).length || inspectPendingKitUpdate(stateRoot)) fail("PENDING_RECOVERY");
			const report = whyMutation(stateRoot, id);
			if (report.kind !== "mutation") fail("INVALID_PLAN");
			if (report.undoneBy) fail("ALREADY_UNDONE");
			if (!["APPLIED", "COMPLETED_AFTER"].includes(report.status) || report.undoOf) fail("PENDING_RECOVERY");
			const suffix = report.status === "COMPLETED_AFTER" ? ".COMPLETED_AFTER" : "";
			const receipt = readReceipt(join(receiptsDir(stateRoot), `${id}${suffix}.json`));
			requireDirectoryProof(receipt, stateRoot);
			const roots: { id: string; path: string }[] = receipt.roots ? receipt.roots.map(root => ({ ...root })) : [];
			const files: FileMutation[] = [];
			for (const [index, file] of receipt.files.entries()) {
				if (!same(openFile(file.path)?.image ?? null, file.after)) fail("FRESH_PLAN");
				const backup = file.before ? openFile(file.backup!) : null;
				if (file.before && (!backup || backup.image.sha256 !== file.before.sha256 ||
					backup.image.size !== file.before.size || backup.image.mode !== 0o600 ||
					backup.image.uid !== process.getuid?.())) fail("BACKUP_CORRUPT");
				const originalRoot = receipt.roots?.find(root => root.id === file.root);
				const root = originalRoot?.id ?? `undo-${index}`;
				if (!originalRoot) roots.push({ id: root, path: dirname(file.path) });
				files.push({ root, relativePath: originalRoot ? relative(originalRoot.path, file.path) : basename(file.path), expectedBefore: file.after,
					after: file.before ? { bytes: backup!.bytes, mode: file.before.mode,
						uid: file.before.uid, gid: file.before.gid } : null });
			}
			const plan = planMutation({ stateRoot, roots, files });
			const result = runMutation(plan, { onBoundary: options.onBoundary }, lock, id, receipt.createdDirectories);
			return { ...result, status: "RESTORED" };
		} finally { lock.release(); }
	});
}
