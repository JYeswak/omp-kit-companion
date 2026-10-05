import { lstatSync, openSync, closeSync, fstatSync, readFileSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";

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

/** List exclusive reservation holds older than limitMinutes from an Agent Mail archive. */
export function auditReservationAge(input: {
	archiveRoot: string;
	projectKey: string;
	limitMinutes?: number;
	nowMs?: number;
}): ReservationAgeReport {
	const limitMinutes = input.limitMinutes ?? DEFAULT_RESERVATION_LIMIT_MINUTES;
	const nowMs = input.nowMs ?? Date.now();
	const directory = join(input.archiveRoot, "projects", projectSlug(input.projectKey), "file_reservations");
	let names: string[];
	try {
		names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
	} catch {
		return { archive_root: input.archiveRoot, project: input.projectKey, limit_minutes: limitMinutes, checked: 0, unreadable: 0, overdue: [] };
	}
	const overdue: OverdueReservation[] = [];
	let checked = 0, unreadable = 0;
	for (const name of names) {
		const parsed: unknown = readJsonFile(join(directory, name));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("exclusive" in parsed)) {
			unreadable++;
			continue;
		}
		const record = parsed as { exclusive?: unknown; released_ts?: unknown; expires_ts?: unknown; path_pattern?: unknown; path?: unknown; agent_name?: unknown; agent?: unknown; created_ts?: unknown; reason?: unknown };
		if (record.released_ts !== undefined && record.released_ts !== null && String(record.released_ts).length > 0) continue;
		const expires = asString(record.expires_ts);
		if (expires !== null && Number.isFinite(Date.parse(expires)) && Date.parse(expires) <= nowMs) continue;
		if (record.exclusive !== true) continue;
		const pathPattern = asString(record.path_pattern ?? record.path);
		const holder = asString(record.agent_name ?? record.agent);
		const granted = asString(record.created_ts);
		if (!pathPattern || !holder || !granted || !Number.isFinite(Date.parse(granted))) {
			unreadable++;
			continue;
		}
		checked++;
		const ageMinutes = (nowMs - Date.parse(granted)) / 60000;
		if (ageMinutes > limitMinutes) {
			overdue.push({
				path_pattern: pathPattern,
				agent_name: holder,
				bead: asString(record.reason) ?? "",
				age_minutes: Math.round(ageMinutes * 10) / 10,
				granted_ts: granted,
				expires_ts: expires ?? "",
			});
		}
	}
	overdue.sort((a, b) => b.age_minutes - a.age_minutes);
	return { archive_root: input.archiveRoot, project: input.projectKey, limit_minutes: limitMinutes, checked, unreadable, overdue };
}
