import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { fsyncDirectory } from "./mutations.ts";

export const MINE_SOURCES = ["transcripts", "tracker", "git", "hooks", "cc"] as const;
export type MineSource = typeof MINE_SOURCES[number];
export type MineCellStatus = "READ" | "PARTIAL" | "MISSING" | "NONE-EXISTS";
/** Sub-cell position of one oversized cell; absent on every cell that fits one bounded file. */
export interface MineCellPart { index: number; count: number }
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
	part?: MineCellPart;
}
type MineCellInput<T> = Omit<MineCell<T>, "version" | "attempts" | "part">;

// Bounds apply before parsing disk bytes and before publishing serialized values.
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_CELLS = 100_000;
const MAX_PARTS = 4096;
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

	private key(project: string, date: string, source: MineSource, fingerprint: string, index = 0): string {
		if (!text(project, 4096) || !day(date) || date < this.window.since || date >= this.window.until
			|| !MINE_SOURCES.includes(source) || !text(fingerprint, 1024)) throw new Error("MINE_LEDGER_INVALID_CELL_KEY");
		// Part 0 keeps the original cell key, so unsplit ledgers keep byte-identical manifests.
		return hash(JSON.stringify(index ? [project, date, source, index] : [project, date, source]));
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
				|| ("part" in cell && !(object(cell.part) && Number.isSafeInteger(cell.part.count) && Number.isSafeInteger(cell.part.index)
					&& Number(cell.part.count) >= 2 && Number(cell.part.count) <= MAX_PARTS && Number(cell.part.index) >= 0 && Number(cell.part.index) < Number(cell.part.count)))
				|| !("result" in cell) || this.key(cell.project, cell.day, cell.source as MineSource, cell.input_fingerprint, object(cell.part) ? Number(cell.part.index) : 0) !== key) return null;
			return cell as unknown as MineCell<unknown>;
		} catch { return null; }
	}
	/** The cell, or part 0 of a split cell; use parts() for every sub-cell. */
	get<T>(project: string, date: string, source: MineSource, fingerprint: string): MineCell<T> | null {
		const cell = this.load(this.key(project, date, source, fingerprint));
		return cell?.input_fingerprint === fingerprint ? cell as MineCell<T> : null;
	}
	/** Every sub-cell of one recorded write in order, or null when any part is absent, stale or corrupt. */
	parts<T>(project: string, date: string, source: MineSource, fingerprint: string): MineCell<T>[] | null {
		const head = this.get<T>(project, date, source, fingerprint);
		if (!head?.part) return head ? [head] : null;
		const cells = [head];
		for (let index = 1; index < head.part.count; index++) {
			const cell = this.load(this.key(project, date, source, fingerprint, index));
			if (cell?.input_fingerprint !== fingerprint || cell.part?.index !== index || cell.part.count !== head.part.count
				|| cell.attempts !== head.attempts || cell.status !== head.status) return null;
			cells.push(cell as MineCell<T>);
		}
		return cells;
	}
	private serialize<T>(input: MineCellInput<T>, part?: MineCellPart, attempts?: number): { key: string; raw: Buffer } {
		const key = this.key(input.project, input.day, input.source, input.input_fingerprint, part?.index ?? 0);
		if (!statuses.includes(input.status) || !Array.isArray(input.reasons) || input.reasons.length > 2048 || input.reasons.some(reason => !text(reason, 4096))) throw new Error("MINE_LEDGER_INVALID_CELL");
		let reasons = input.reasons;
		if (attempts === undefined) {
			const previous = this.get(input.project, input.day, input.source, input.input_fingerprint);
			reasons = [...new Set([...(previous?.reasons ?? []), ...input.reasons])];
			attempts = (previous?.attempts ?? 0) + 1;
		}
		if (reasons.length > 2048) throw new Error("MINE_LEDGER_REASON_LIMIT");
		const cell: MineCell<T> = { ...input, version: 1, reasons, attempts, ...(part ? { part } : {}) };
		if (!Number.isSafeInteger(cell.attempts)) throw new Error("MINE_LEDGER_ATTEMPT_LIMIT");
		return { key, raw: Buffer.from(JSON.stringify(cell)) };
	}
	/** True when put() can record this cell as one bounded file. */
	fits<T>(input: MineCellInput<T>): boolean {
		return this.serialize(input).raw.length <= MAX_RESULT_BYTES;
	}
	/**
	 * Packs consecutive items into sub-cell results that fit one bounded file at any status, attempt count and part position.
	 * `build` must vary only by the items array. An item too large for any sub-cell is returned in `oversized`, never written.
	 */
	split<T, I>(input: Pick<MineCell, "project" | "day" | "source" | "input_fingerprint">, items: readonly I[], build: (items: I[]) => T): { results: T[]; oversized: I[] } {
		const envelope = { ...input, status: "NONE-EXISTS", reasons: [], result: build([]), version: 1, attempts: Number.MAX_SAFE_INTEGER, part: { index: MAX_PARTS, count: MAX_PARTS } };
		const base = Buffer.byteLength(JSON.stringify(envelope)), results: T[] = [], oversized: I[] = [];
		let chunk: I[] = [], size = base;
		for (const item of items) {
			const bytes = Buffer.byteLength(JSON.stringify(item));
			if (base + bytes > MAX_RESULT_BYTES) { oversized.push(item); continue; }
			if (chunk.length && size + 1 + bytes > MAX_RESULT_BYTES) { results.push(build(chunk)); chunk = []; size = base; }
			size += (chunk.length ? 1 : 0) + bytes; chunk.push(item);
		}
		if (chunk.length) results.push(build(chunk));
		return { results, oversized };
	}
	put<T>(input: MineCellInput<T>): MineCell<T> {
		const write = this.serialize(input);
		if (write.raw.length > MAX_RESULT_BYTES || !Object.hasOwn(JSON.parse(write.raw.toString()), "result")) throw new Error("MINE_LEDGER_RESULT_LIMIT_OR_INVALID");
		this.commit(input, [write]);
		return JSON.parse(write.raw.toString("utf8")) as MineCell<T>;
	}
	/** Records one oversized cell as bounded sub-cells: part 0 carries `input.result`, its reasons and attempt count; later parts carry `rest`. */
	putParts<T>(input: MineCellInput<T>, rest: readonly T[]): MineCell<T>[] {
		if (!rest.length) return [this.put(input)];
		const count = rest.length + 1;
		if (count > MAX_PARTS) throw new Error("MINE_LEDGER_PART_LIMIT");
		const head = this.serialize(input, { index: 0, count }), attempts = (JSON.parse(head.raw.toString()) as MineCell<T>).attempts;
		const writes = [head, ...rest.map((result, index) => this.serialize({ ...input, reasons: [], result }, { index: index + 1, count }, attempts))];
		if (writes.some(write => write.raw.length > MAX_RESULT_BYTES || !Object.hasOwn(JSON.parse(write.raw.toString()), "result"))) throw new Error("MINE_LEDGER_RESULT_LIMIT_OR_INVALID");
		this.commit(input, writes);
		return writes.map(write => JSON.parse(write.raw.toString("utf8")) as MineCell<T>);
	}
	/** Immutable receipts first, then one atomic manifest commit; sub-cells beyond the new write are released. */
	private commit(input: Pick<MineCell, "project" | "day" | "source" | "input_fingerprint">, writes: { key: string; raw: Buffer }[]): void {
		const entries = { ...this.entries };
		for (let index = Math.max(1, writes.length); ; index++) {
			const stale = this.key(input.project, input.day, input.source, input.input_fingerprint, index);
			if (!(stale in entries)) break;
			delete entries[stale];
		}
		const digests = writes.map(write => hash(write.raw));
		writes.forEach((write, index) => { entries[write.key] = digests[index]!; });
		if (Object.keys(entries).length > MAX_CELLS) throw new Error("MINE_LEDGER_CELL_LIMIT");
		const manifest = Buffer.from(JSON.stringify({ version: 1, window: this.window, revision: this.revision, entries }));
		if (manifest.length > MAX_MANIFEST_BYTES) throw new Error("MINE_LEDGER_MANIFEST_LIMIT");
		privateDirectory(this.directory);
		writes.forEach((write, index) => this.receipt(digests[index]!, write.raw));
		atomicReplaceBytes(this.path, manifest, { mode: 0o600, durability: "full" });
		this.entries = entries;
	}
	private receipt(digest: string, raw: Buffer): void {
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
	}
	/** Whole cells: sub-cells after part 0 are reached through parts(). */
	get cells(): MineCell<unknown>[] {
		return Object.keys(this.entries).sort().flatMap(key => { const cell = this.load(key); return cell && !cell.part?.index ? [cell] : []; });
	}
	totals(): Record<MineCellStatus, number> {
		const totals: Record<MineCellStatus, number> = { READ: 0, PARTIAL: 0, MISSING: 0, "NONE-EXISTS": 0 };
		for (const cell of this.cells) totals[cell.status]++;
		return totals;
	}
}
