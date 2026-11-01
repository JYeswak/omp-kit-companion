import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync, realpathSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const ROTATION_PREFIX = "rotation-";
const ROTATION_NAME = /^rotation-[0-9]{8}T[0-9]{6}Z$/;

export interface AmRotationRemoval { name: string; bytes: number }
export interface AmRetentionResult {
	storageRoot: string;
	kept: string | null;
	removed: AmRotationRemoval[];
	bytesRemoved: number;
	recordPath: string | null;
}

/** The operator selects the store; native service definitions persist this explicit decision. */
export function agentMailRetentionRoot(value: string | undefined): string | null {
	if (value === undefined || value === "") return null;
	if (!isAbsolute(value) || value.includes("\n") || value.includes("\r") || value.includes("\0")) {
		throw new Error("AM_RETAIN_ROOT_INVALID: AGENT_MAIL_STORAGE_ROOT must be an absolute single-line path");
	}
	return resolve(value);
}

function directory(path: string): Stats | null {
	let stat: Stats;
	try { stat = lstatSync(path); }
	catch (error) {
		if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`AM_RETAIN_UNSAFE_DIRECTORY: ${path}`);
	return stat;
}

/** Logical regular-file bytes only; never read backup contents or follow links. */
function rotationBytes(root: string): number {
	let bytes = 0;
	const pending = [root];
	while (pending.length) {
		const path = pending.pop()!;
		const entries = opendirSync(path);
		try {
			for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
				const child = join(path, entry.name);
				const stat = lstatSync(child);
				if (stat.isDirectory()) pending.push(child);
				else if (stat.isFile()) {
					bytes += stat.size;
					if (!Number.isSafeInteger(bytes)) throw new Error("AM_RETAIN_BYTES_UNREPRESENTABLE: rotation size exceeds safe integer bytes");
				}
			}
		} finally { entries.closeSync(); }
	}
	return bytes;
}

/** Retire ordinary UTC-named rotation directories; the retained rotation is not walked. */
export function retainAgentMailRotations(storageRoot: string, recordPath: string): AmRetentionResult {
	const selected = agentMailRetentionRoot(storageRoot);
	if (selected === null) throw new Error("AM_RETAIN_ROOT_REQUIRED: set AGENT_MAIL_STORAGE_ROOT before running retention");
	const root = realpathSync(selected);
	if (directory(root) === null) throw new Error(`AM_RETAIN_ROOT_UNAVAILABLE: ${root}`);
	const result: AmRetentionResult = { storageRoot: root, kept: null, removed: [], bytesRemoved: 0, recordPath: null };
	const doctor = join(root, "doctor");
	if (directory(doctor) === null) return result;
	const reclaimable = join(doctor, "reclaimable");
	const scope = directory(reclaimable);
	if (scope === null) return result;
	const rotations: Array<{ name: string; path: string; stat: Stats }> = [];
	const entries = opendirSync(reclaimable);
	try {
		for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
			if (!entry.name.startsWith(ROTATION_PREFIX)) continue;
			if (!ROTATION_NAME.test(entry.name)) throw new Error(`AM_RETAIN_UNKNOWN_ROTATION: ${JSON.stringify(entry.name)}`);
			const path = join(reclaimable, entry.name);
			const stat = directory(path);
			if (stat === null) throw new Error(`AM_RETAIN_ROTATION_CHANGED: ${entry.name}`);
			rotations.push({ name: entry.name, path, stat });
		}
	} finally { entries.closeSync(); }
	rotations.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	result.kept = rotations[rotations.length - 1]?.name ?? null;
	if (rotations.length < 2) return result;

	if (!isAbsolute(recordPath)) throw new Error("AM_RETAIN_RECORD_INVALID: deletion record path must be absolute");
	const record = join(realpathSync(dirname(recordPath)), basename(recordPath));
	if (record === reclaimable || record.startsWith(reclaimable + sep)) {
		throw new Error("AM_RETAIN_RECORD_INVALID: deletion records must be outside the retained store");
	}
	const fd = openSync(record, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o077) !== 0 ||
			(process.getuid !== undefined && opened.uid !== process.getuid())) throw new Error("AM_RETAIN_RECORD_UNSAFE: deletion record must be a private owned regular file");
		result.recordPath = record;
		const recordEvent = (event: "planned" | "removed", name: string, bytes: number) => {
			appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), event, storageRoot: root, kept: result.kept, name, bytes }) + "\n");
			fsyncSync(fd);
		};
		for (let index = 0; index < rotations.length - 1; index++) {
			const rotation = rotations[index]!;
			const bytes = rotationBytes(rotation.path);
			const total = result.bytesRemoved + bytes;
			if (!Number.isSafeInteger(total)) throw new Error("AM_RETAIN_BYTES_UNREPRESENTABLE: removed bytes exceed safe integer accounting");
			const currentScope = directory(reclaimable);
			const current = directory(rotation.path);
			if (currentScope === null || currentScope.dev !== scope.dev || currentScope.ino !== scope.ino ||
				current === null || current.dev !== rotation.stat.dev || current.ino !== rotation.stat.ino || current.mtimeMs !== rotation.stat.mtimeMs) {
				throw new Error(`AM_RETAIN_ROTATION_CHANGED: ${rotation.name}`);
			}
			recordEvent("planned", rotation.name, bytes);
			rmSync(rotation.path, { recursive: true });
			recordEvent("removed", rotation.name, bytes);
			result.removed.push({ name: rotation.name, bytes });
			result.bytesRemoved = total;
		}
		return result;
	} finally { closeSync(fd); }
}
