import { lstatSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isHotPath } from "./fleet-guard/hot-cap.ts";

export const DEFAULT_RESERVATION_LIMIT_MINUTES = 30;

export interface OverdueReservation {
	path_pattern: string;
	agent_name: string;
	bead: string;
	age_minutes: number;
	granted_ts: string;
	expires_ts: string;
}

export interface ReservationAgeReport {
	archive_root: string;
	project: string;
	limit_minutes: number;
	checked: number;
	unreadable: number;
	overdue: OverdueReservation[];
}

export function projectSlug(projectKey: string): string {
	return projectKey.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readJsonFile(path: string): unknown {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
	const fd = openSync(path, "r");
	try {
		if (!fstatSync(fd).isFile()) return undefined;
		return JSON.parse(readFileSync(fd, "utf8"));
	} catch {
		return undefined;
	} finally {
		closeSync(fd);
	}
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

interface ActiveReservation { path_pattern: string; agent_name: string; bead: string; granted_ts: string; expires_ts: string; granted_ms: number; }
interface ActiveReservationReport { records: ActiveReservation[]; checked: number; unreadable: number; available: boolean; }

/** A live hold for renewal-cap judgment: the hold's own exclusive and path. */
export interface ActiveHold {
	id: number | null;
	path_pattern: string;
	exclusive: boolean;
	agent_name: string;
	granted_ms: number;
	expires_ms: number | null;
}

export interface ActiveHoldReport { holds: ActiveHold[]; checked: number; unreadable: number; available: boolean; }

/** List live (unreleased, unexpired) holds of any exclusivity for renewal judgment. */
export function readActiveHolds(archiveRoot: string, projectKey: string, nowMs: number): ActiveHoldReport {
	const directory = join(archiveRoot, "projects", projectSlug(projectKey), "file_reservations");
	let names: string[];
	try { names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort(); }
	catch { return { holds: [], checked: 0, unreadable: 0, available: false }; }
	const holds: ActiveHold[] = [];
	let unreadable = 0;
	for (const name of names) {
		const parsed: unknown = readJsonFile(join(directory, name));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { unreadable++; continue; }
		const record = parsed as Record<string, unknown>;
		const released = record.released_ts;
		if (released !== undefined && released !== null && String(released).length > 0) continue;
		const expiresMs = typeof record.expires_ts === "string" && Number.isFinite(Date.parse(record.expires_ts))
			? Date.parse(record.expires_ts as string) : null;
		if (expiresMs !== null && expiresMs <= nowMs) continue;
		const pathPattern = asString(record.path_pattern ?? record.path);
		const holder = asString(record.agent_name ?? record.agent);
		const granted = asString(record.created_ts ?? record.granted_ts);
		if (!pathPattern || !holder || !granted || !Number.isFinite(Date.parse(granted))) { unreadable++; continue; }
		holds.push({
		id: typeof record.id === "number" && Number.isFinite(record.id) ? record.id : null,
			path_pattern: pathPattern,
			exclusive: record.exclusive === true,
			agent_name: holder,
			granted_ms: Date.parse(granted),
			expires_ms: expiresMs,
		});
	}
	return { holds, checked: holds.length, unreadable, available: true };
}

function readActiveReservations(archiveRoot: string, projectKey: string, nowMs: number): ActiveReservationReport {
	const directory = join(archiveRoot, "projects", projectSlug(projectKey), "file_reservations");
	let names: string[];
	try { names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort(); }
	catch { return { records: [], checked: 0, unreadable: 0, available: false }; }
	const records: ActiveReservation[] = [];
	let unreadable = 0;
	for (const name of names) {
		const parsed: unknown = readJsonFile(join(directory, name));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("exclusive" in parsed)) { unreadable++; continue; }
		const record = parsed as { exclusive?: unknown; released_ts?: unknown; expires_ts?: unknown; path_pattern?: unknown; path?: unknown; agent_name?: unknown; agent?: unknown; created_ts?: unknown; reason?: unknown };
		if (record.released_ts !== undefined && record.released_ts !== null && String(record.released_ts).length > 0) continue;
		const expires = asString(record.expires_ts);
		if (expires !== null && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= nowMs) continue;
		if (record.exclusive !== true) continue;
		const pathPattern = asString(record.path_pattern ?? record.path);
		const holder = asString(record.agent_name ?? record.agent);
		const granted = asString(record.created_ts);
		if (!pathPattern || !holder || !granted || !Number.isFinite(Date.parse(granted))) { unreadable++; continue; }
		records.push({ path_pattern: pathPattern, agent_name: holder, bead: asString(record.reason) ?? "", granted_ts: granted, expires_ts: expires ?? "", granted_ms: Date.parse(granted) });
	}
	return { records, checked: records.length, unreadable, available: true };
}

function relativeReservationPattern(projectKey: string, rawPattern: string): string | null {
	let pattern = rawPattern.replaceAll("\\", "/");
	if (isAbsolute(rawPattern)) pattern = relative(resolve(projectKey), resolve(rawPattern)).replaceAll("\\", "/");
	while (pattern.startsWith("./")) pattern = pattern.slice(2);
	if (!pattern || isAbsolute(pattern) || pattern.split("/").includes("..")) return null;
	return pattern;
}

export interface StaleReservedEdit { path: string; path_pattern: string; agent_name: string; bead: string; age_minutes: number; }
export interface StaleReservedEditReport { archive_root: string; project: string; limit_minutes: number; checked: number; unreadable: number; status: "OK" | "PARTIAL" | "UNAVAILABLE"; stale: StaleReservedEdit[]; }

/** Report old dirty files only when a live exclusive reservation covers that path. */
export function auditStaleReservedEdits(input: { archiveRoot: string; projectKey: string; dirtyFiles: readonly { path: string; modifiedMs: number }[]; limitMinutes?: number; nowMs?: number }): StaleReservedEditReport {
	const limitMinutes = input.limitMinutes ?? DEFAULT_RESERVATION_LIMIT_MINUTES;
	const nowMs = input.nowMs ?? Date.now();
	const source = readActiveReservations(input.archiveRoot, input.projectKey, nowMs);
	let unreadable = source.unreadable;
	const reservations = source.records.flatMap((record) => {
		const pattern = relativeReservationPattern(input.projectKey, record.path_pattern);
		if (pattern === null) { unreadable++; return []; }
		try { return [{ record, glob: new Bun.Glob(pattern) }]; } catch { unreadable++; return []; }
	}).sort((a, b) => b.record.granted_ms - a.record.granted_ms);
	const stale: StaleReservedEdit[] = [];
	for (const file of input.dirtyFiles) {
		const path = file.path.replaceAll("\\", "/");
		if (!path || isAbsolute(file.path) || path.split("/").includes("..") || !Number.isFinite(file.modifiedMs)) continue;
		const ageMinutes = (nowMs - file.modifiedMs) / 60_000;
		if (ageMinutes <= limitMinutes) continue;
		const reservation = reservations.find((candidate) => candidate.glob.match(path));
		if (!reservation) continue;
		stale.push({ path, path_pattern: reservation.record.path_pattern, agent_name: reservation.record.agent_name, bead: reservation.record.bead, age_minutes: Math.round(ageMinutes * 10) / 10 });
	}
	stale.sort((a, b) => b.age_minutes - a.age_minutes || a.path.localeCompare(b.path));
	return { archive_root: input.archiveRoot, project: input.projectKey, limit_minutes: limitMinutes, checked: source.checked, unreadable, status: !source.available ? "UNAVAILABLE" : unreadable ? "PARTIAL" : "OK", stale };
}

/** List exclusive reservation holds older than limitMinutes from an Agent Mail archive. */
export function auditReservationAge(input: { archiveRoot: string; projectKey: string; limitMinutes?: number; nowMs?: number; hotPaths?: readonly string[] }): ReservationAgeReport {
	const limitMinutes = input.limitMinutes ?? DEFAULT_RESERVATION_LIMIT_MINUTES;
	const nowMs = input.nowMs ?? Date.now();
	const source = readActiveReservations(input.archiveRoot, input.projectKey, nowMs);
	const hotOnly = (input.hotPaths ?? []).length > 0;
	const overdue = source.records
		.filter((record) => (nowMs - record.granted_ms) / 60_000 > limitMinutes)
		.filter((record) => !hotOnly || isHotPath(input.hotPaths ?? [], record.path_pattern) !== null)
		.map((record) => ({
		path_pattern: record.path_pattern, agent_name: record.agent_name, bead: record.bead, age_minutes: Math.round(((nowMs - record.granted_ms) / 60_000) * 10) / 10, granted_ts: record.granted_ts, expires_ts: record.expires_ts,
	}));
	overdue.sort((a, b) => b.age_minutes - a.age_minutes);
	return { archive_root: input.archiveRoot, project: input.projectKey, limit_minutes: limitMinutes, checked: source.checked, unreadable: source.unreadable, overdue };
}
