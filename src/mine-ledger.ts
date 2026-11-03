import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { fsyncDirectory } from "./mutations.ts";

export const MINE_SOURCES = ["transcripts", "tracker", "git", "hooks", "cc"] as const;
export type MineSource = typeof MINE_SOURCES[number];
export type MineCellStatus = "READ" | "PARTIAL" | "MISSING" | "NONE-EXISTS";
export interface MineCell<T = unknown> {
	version: 1;
	project: string;
	day: string;
	source: MineSource;
	input_fingerprint: string;
	status: MineCellStatus;
	reasons: string[];
	attempts: number;
	result: T;
}

// Bounds apply before parsing disk bytes and before publishing serialized values.
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CELLS = 100_000;
const statuses: MineCellStatus[] = ["READ", "PARTIAL", "MISSING", "NONE-EXISTS"];
const hexDigest = (value: unknown): value is string => typeof value === "string" && value.length === 64 && [...value].every(char => "0123456789abcdef".includes(char));
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= max;
const missing = (error: unknown): boolean => object(error) && error.code === "ENOENT";
function day(value: unknown): value is string {
	return typeof value === "string" && value.length === 10 && value[4] === "-" && value[7] === "-"
		&& [...value].every((char, index) => index === 4 || index === 7 || "0123456789".includes(char))
		&& Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
		&& new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}
function directories(path: string, create = false): void {
	const parent = dirname(path);
	if (parent !== path) directories(parent, create);
	let info;
	try { info = lstatSync(path); }
	catch (error) {
		if (!create || !missing(error)) throw error;
		mkdirSync(path, { mode: 0o700 });
		fsyncDirectory(parent);
		info = lstatSync(path);
	}
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("MINE_LEDGER_UNSAFE_DIRECTORY");
}
function privateDirectory(path: string): void {
	directories(path);
	const info = lstatSync(path);
	if (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) throw new Error("MINE_LEDGER_NOT_PRIVATE");
}
function bytes(path: string, max: number): Buffer {
	directories(dirname(path));
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const info = fstatSync(fd);
		if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > max) throw new Error("MINE_LEDGER_UNSAFE_FILE");
		const value = readFileSync(fd);
		if (value.length > max) throw new Error("MINE_LEDGER_SIZE_LIMIT");
		return value;
	} finally { closeSync(fd); }
}

/** Single-writer store: immutable content-addressed cells precede the atomic manifest commit. */
export class MineLedger {
	readonly path: string;
	private readonly directory: string;
	private readonly window: { since: string; until: string };
	private readonly revision: string;
	private entries: Record<string, string> = {};

	constructor(root: string, window: { since: string; until: string }, revision: string) {
		if (!day(window.since) || !day(window.until) || window.since >= window.until || !text(revision, 1024)) throw new Error("MINE_LEDGER_INVALID_WINDOW_OR_REVISION");
		if (!text(root, 4096) || root.split("/").includes("..") || root.includes("\\")) throw new Error("MINE_LEDGER_INVALID_ROOT");
		this.window = { ...window };
		this.revision = revision;
		const base = resolve(root);
		directories(base, true);
		privateDirectory(base);
		this.directory = join(base, hash(JSON.stringify([window.since, window.until, revision])));
		directories(this.directory, true);
		privateDirectory(this.directory);
		this.path = join(this.directory, "manifest.json");
		try {
			const manifest: unknown = JSON.parse(bytes(this.path, MAX_MANIFEST_BYTES).toString("utf8"));
			if (object(manifest) && manifest.version === 1 && manifest.revision === revision && object(manifest.window)
				&& manifest.window.since === window.since && manifest.window.until === window.until && object(manifest.entries)
				&& Object.keys(manifest.entries).length <= MAX_CELLS
				&& Object.entries(manifest.entries).every(([key, value]) => hexDigest(key) && hexDigest(value))) {
				this.entries = { ...manifest.entries } as Record<string, string>;
			}
		} catch (error) {
			// Corruption is a cache miss. Unsafe references are never opened; unknown bytes remain intact.
			if (!missing(error) && !(error instanceof SyntaxError)) throw error;
		}
	}

	private key(project: string, date: string, source: MineSource, fingerprint: string): string {
		if (!text(project, 4096) || !day(date) || date < this.window.since || date >= this.window.until
			|| !MINE_SOURCES.includes(source) || !text(fingerprint, 1024)) throw new Error("MINE_LEDGER_INVALID_CELL_KEY");
		return hash(JSON.stringify([project, date, source]));
	}
	private load(key: string): MineCell<unknown> | null {
		const digest = this.entries[key];
		if (!digest) return null;
		try {
			const raw = bytes(join(this.directory, `${digest}.json`), MAX_RESULT_BYTES);
			if (hash(raw) !== digest) return null;
			const cell: unknown = JSON.parse(raw.toString("utf8"));
			if (!object(cell) || cell.version !== 1 || !text(cell.project, 4096) || !day(cell.day)
				|| !MINE_SOURCES.includes(cell.source as MineSource) || !text(cell.input_fingerprint, 1024)
				|| !statuses.includes(cell.status as MineCellStatus) || !Number.isSafeInteger(cell.attempts) || Number(cell.attempts) < 1
				|| !Array.isArray(cell.reasons) || cell.reasons.length > 2048 || !cell.reasons.every(reason => text(reason, 4096))
				|| !("result" in cell) || this.key(cell.project, cell.day, cell.source as MineSource, cell.input_fingerprint) !== key) return null;
			return cell as unknown as MineCell<unknown>;
		} catch { return null; }
	}
	get<T>(project: string, date: string, source: MineSource, fingerprint: string): MineCell<T> | null {
		const cell = this.load(this.key(project, date, source, fingerprint));
		return cell?.input_fingerprint === fingerprint ? cell as MineCell<T> : null;
	}
	put<T>(input: Omit<MineCell<T>, "version" | "attempts">): MineCell<T> {
		const key = this.key(input.project, input.day, input.source, input.input_fingerprint);
		if (!statuses.includes(input.status) || !Array.isArray(input.reasons) || input.reasons.length > 2048 || input.reasons.some(reason => !text(reason, 4096))) throw new Error("MINE_LEDGER_INVALID_CELL");
		const previous = this.get(input.project, input.day, input.source, input.input_fingerprint);
		const reasons = [...new Set([...(previous?.reasons ?? []), ...input.reasons])];
		if (reasons.length > 2048) throw new Error("MINE_LEDGER_REASON_LIMIT");
		const cell: MineCell<T> = { ...input, version: 1, reasons, attempts: (previous?.attempts ?? 0) + 1 };
		if (!Number.isSafeInteger(cell.attempts)) throw new Error("MINE_LEDGER_ATTEMPT_LIMIT");
		const raw = Buffer.from(JSON.stringify(cell));
		if (raw.length > MAX_RESULT_BYTES || !Object.hasOwn(JSON.parse(raw.toString()), "result")) throw new Error("MINE_LEDGER_RESULT_LIMIT_OR_INVALID");
		const digest = hash(raw);
		const entries = { ...this.entries, [key]: digest };
		if (Object.keys(entries).length > MAX_CELLS) throw new Error("MINE_LEDGER_CELL_LIMIT");
		const manifest = Buffer.from(JSON.stringify({ version: 1, window: this.window, revision: this.revision, entries }));
		if (manifest.length > MAX_MANIFEST_BYTES) throw new Error("MINE_LEDGER_MANIFEST_LIMIT");
		privateDirectory(this.directory);
		const resultPath = join(this.directory, `${digest}.json`);
		try {
			const existing = bytes(resultPath, MAX_RESULT_BYTES);
			if (!existing.equals(raw)) {
				const actual = hash(existing);
				if (actual === digest) throw new Error("MINE_LEDGER_IMMUTABLE_COLLISION");
				// Preserve corrupt evidence before rebuilding the same deterministic receipt from sources.
				const quarantine = join(this.directory, `${digest}.corrupt.${actual}.json`);
				try {
					if (!bytes(quarantine, MAX_RESULT_BYTES).equals(existing)) throw new Error("MINE_LEDGER_CORRUPTION_ARCHIVE_COLLISION");
				} catch (error) {
					if (!missing(error)) throw error;
					atomicReplaceBytes(quarantine, existing, { mode: 0o600, durability: "full" });
				}
				atomicReplaceBytes(resultPath, raw, { mode: 0o600, durability: "full" });
			}
		} catch (error) {
			if (!missing(error)) throw error;
			atomicReplaceBytes(resultPath, raw, { mode: 0o600, durability: "full" });
		}
		atomicReplaceBytes(this.path, manifest, { mode: 0o600, durability: "full" });
		this.entries = entries;
		return JSON.parse(raw.toString("utf8")) as MineCell<T>;
	}
	get cells(): MineCell<unknown>[] {
		return Object.keys(this.entries).sort().flatMap(key => { const cell = this.load(key); return cell ? [cell] : []; });
	}
	totals(): Record<MineCellStatus, number> {
		const totals: Record<MineCellStatus, number> = { READ: 0, PARTIAL: 0, MISSING: 0, "NONE-EXISTS": 0 };
		for (const cell of this.cells) totals[cell.status]++;
		return totals;
	}
}
