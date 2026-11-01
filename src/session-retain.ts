import { Database } from "bun:sqlite";
import { appendFileSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const SESSION_STATE_SCHEMA = "omp-kit.cc.session-tail.v1";
const SESSION_STATE_MAX_BYTES = 4 << 20;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_FILE = /\.jsonl$/;

type SessionCursor = { path: string; dev: number; inode: number; offset: number };
type SessionState = { schema_version: string; files: Record<string, SessionCursor>; position: number; pending: unknown };
type SessionTick = { position: number; error_code: null };
type SessionEvidence = { raw: string; state: SessionState; tick: SessionTick };

export interface SessionRemoval { path: string; bytes: number }
export interface SessionRetentionResult {
	root: string;
	examined: number;
	kept: number;
	removed: SessionRemoval[];
	bytesRemoved: number;
	ccVerified: boolean;
	recordPath: string | null;
}

function directory(path: string): Stats | null {
	let stat: Stats;
	try { stat = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`SESSION_RETAIN_UNSAFE_DIRECTORY: ${path}`);
	return stat;
}

function regularFile(path: string): Stats | null {
	let stat: Stats;
	try { stat = lstatSync(path); } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
}

function readState(path: string): { raw: string; state: SessionState } | null {
	const stat = regularFile(path);
	if (!stat || stat.size > SESSION_STATE_MAX_BYTES) return null;
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	let raw: string;
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
			|| opened.size > SESSION_STATE_MAX_BYTES) return null;
		raw = readFileSync(fd, "utf8");
	} finally { closeSync(fd); }
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const doc = value as Record<string, unknown>;
		if (doc.schema_version !== SESSION_STATE_SCHEMA || !doc.files || typeof doc.files !== "object" || Array.isArray(doc.files)
			|| !Number.isSafeInteger(doc.position) || (doc.position as number) < 0 || doc.pending !== null) return null;
		const files = doc.files as Record<string, unknown>;
		for (const [key, item] of Object.entries(files)) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return null;
			const cursor = item as Record<string, unknown>;
			if (key !== cursor.path || !isAbsolute(key) || !Number.isSafeInteger(cursor.dev) || !Number.isSafeInteger(cursor.inode)
				|| !Number.isSafeInteger(cursor.offset) || (cursor.dev as number) < 0 || (cursor.inode as number) < 0
				|| (cursor.offset as number) < 0) return null;
		}
		return { raw, state: doc as unknown as SessionState };
	} catch { return null; }
}

function readCommittedTick(ccRoot: string): SessionTick | null {
	const databasePath = join(ccRoot, "cc.db");
	if (!regularFile(databasePath)) return null;
	let db: Database | null = null;
	try {
		db = new Database(databasePath, { readonly: true });
		const row = db.query("SELECT t.position, t.error_code, e.data FROM source_ticks AS t "
			+ "JOIN events AS e ON e.cursor=t.cursor WHERE t.producer='session' AND e.type='source.tick' "
			+ "AND e.producer='session' ORDER BY t.cursor DESC LIMIT 1").get() as
			{ position: unknown; error_code: unknown; data: unknown } | null;
		if (!row || !Number.isSafeInteger(row.position) || row.error_code !== null || typeof row.data !== "string") return null;
		const data: unknown = JSON.parse(row.data);
		if (!data || typeof data !== "object" || Array.isArray(data)) return null;
		const tick = data as Record<string, unknown>;
		if (tick.position !== row.position || tick.error_code !== null) return null;
		return { position: row.position as number, error_code: null };
	} catch { return null; }
	finally { db?.close(); }
}

function readSessionEvidence(ccRoot: string): SessionEvidence | null {
	const loaded = readState(join(ccRoot, "producers", "session.state.json"));
	if (!loaded) return null;
	const tick = readCommittedTick(ccRoot);
	if (!tick || tick.position !== loaded.state.position) return null;
	return { ...loaded, tick };
}

function matchesIngested(evidence: SessionEvidence, sourcePath: string, source: Stats): boolean {
	const realPath = realpathSync(sourcePath);
	const cursor = evidence.state.files[realPath];
	return cursor !== undefined && cursor.path === realPath && cursor.dev === source.dev && cursor.inode === source.ino
	&& cursor.offset === source.size && evidence.tick.position === evidence.state.position
		&& evidence.tick.error_code === null;
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function appendRecord(path: string, record: Record<string, unknown>): void {
	if (!isAbsolute(path)) throw new Error("SESSION_RETAIN_RECORD_INVALID: deletion journal path must be absolute");
	const parent = realpathSync(dirname(path));
	const target = join(parent, basename(path));
	const existing = regularFile(target);
	if (existing === null) {
		try { lstatSync(target); throw new Error(`SESSION_RETAIN_RECORD_INVALID: ${target}`); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	const fd = openSync(target, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
	try {
		appendFileSync(fd, `${JSON.stringify(record)}\n`);
		fsyncSync(fd);
	} finally { closeSync(fd); }
}

/** Delete only old OMP JSONL transcripts whose exact CC tail cursor and committed source tick agree. */
export function retainOmpSessions(home: string, ccRoot: string, recordPath: string, nowMs = Date.now()): SessionRetentionResult {
	const selectedHome = realpathSync(resolve(home));
	const ompRoot = join(selectedHome, ".omp");
	const profilesRoot = join(ompRoot, "profiles");
	const result: SessionRetentionResult = { root: profilesRoot, examined: 0, kept: 0, removed: [], bytesRemoved: 0,
		ccVerified: false, recordPath: null };
	if (!directory(ompRoot) || !directory(profilesRoot)) return result;
	const ccRootPath = resolve(ccRoot);
	const selectedCcRoot = directory(ccRootPath) ? realpathSync(ccRootPath) : ccRootPath;

	const profiles = opendirSync(profilesRoot);
	let evidence: SessionEvidence | null | undefined;
	try {
		for (let profile = profiles.readSync(); profile; profile = profiles.readSync()) {
			if (profile.isSymbolicLink() || !profile.isDirectory()) continue;
			const agent = join(profilesRoot, profile.name, "agent");
			if (!directory(agent)) continue;
			const sessions = join(agent, "sessions");
			if (!directory(sessions)) continue;
			const entries = opendirSync(sessions);
			try {
				for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
					if (entry.isSymbolicLink() || !entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
					const path = join(sessions, entry.name);
					const stat = regularFile(path);
					if (!stat || stat.mtimeMs >= nowMs - RETENTION_MS) continue;
					result.examined++;
					if (evidence === undefined) evidence = readSessionEvidence(selectedCcRoot);
					if (!evidence || !matchesIngested(evidence, path, stat)) { result.kept++; continue; }
					if (result.recordPath === null) {
						const journalParent = dirname(recordPath);
						if (!directory(journalParent)) throw new Error(`SESSION_RETAIN_RECORD_UNAVAILABLE: ${journalParent}`);
						result.recordPath = join(realpathSync(journalParent), basename(recordPath));
						if (result.recordPath === profilesRoot || result.recordPath.startsWith(profilesRoot + sep)) {
							throw new Error("SESSION_RETAIN_RECORD_INVALID: deletion journal must be outside the transcript tree");
						}
					}
					appendRecord(result.recordPath, { event: "planned", path, bytes: stat.size, dev: stat.dev, inode: stat.ino, at_ms: nowMs });
					const current = regularFile(path);
					const latest = readSessionEvidence(selectedCcRoot);
					if (!current || !sameFile(stat, current) || !latest || latest.raw !== evidence.raw
						|| !matchesIngested(latest, path, current)) {
						result.kept++;
						continue;
					}
					unlinkSync(path);
					appendRecord(result.recordPath, { event: "removed", path, bytes: stat.size, dev: stat.dev, inode: stat.ino, at_ms: nowMs });
					result.removed.push({ path, bytes: stat.size });
					result.bytesRemoved += stat.size;
				}
			} finally { entries.closeSync(); }
		}
	} finally { profiles.closeSync(); }
	result.ccVerified = result.examined > 0 && result.kept === 0;
	return result;
}
