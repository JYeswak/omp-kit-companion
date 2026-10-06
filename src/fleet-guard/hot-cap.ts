/** hot-cap.ts — RES1 (ompkit-wodi): hard cap on exclusive reservation TTL.
 *
 * Fleet-guard refusal for file_reservation_paths(exclusive, ttl>N) and
 * renew_file_reservations whose paths are listed in the repo's .omp/hot-paths.
 * Default cap 30 minutes; renewals are capped the same way so holds cannot be
 * extended past the cap without a release. Non-hot paths are unaffected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const HOT_CAP_MINUTES = 30;
export const HOT_PATHS_FILE = join(".omp", "hot-paths");

export interface HotCapRequest {
	paths: string[];
	exclusive: boolean;
	/** Requested TTL in seconds (ttl_seconds); undefined means the server default. */
	ttlSeconds: number | undefined;
	kind: "reserve" | "renew";
}

export interface HotCapVerdict {
	blocked: boolean;
	reason?: string;
	hotPath?: string;
}

/** Parse a .omp/hot-paths file: one project-relative path per line, # comments. */
export function parseHotPaths(text: string): string[] {
	return text.split("\n")
		.map(line => line.trim().replace(/^\.\//, "").replace(/^\/+/, ""))
		.filter(line => line !== "" && !line.startsWith("#"));
}

export function readHotPaths(repoRoot: string): string[] {
	try {
		return parseHotPaths(readFileSync(join(repoRoot, HOT_PATHS_FILE), "utf8"));
	} catch {
		return [];
	}
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** True when a requested path (concrete or glob) touches a hot entry. */
export function isHotPath(hotPaths: readonly string[], requestedPath: string): string | null {
	const want = normalize(requestedPath);
	if (/[*?[]/.test(want)) {
		for (const raw of hotPaths) {
			const entry = normalize(raw.replace(/\/$/, ""));
			if (globMatch(want, entry)) return raw.trim();
		}
		return null;
	}
	for (const raw of hotPaths) {
		const entry = normalize(raw);
		if (raw.trim().endsWith("/")) {
			if (want === entry || want.startsWith(entry + "/")) return raw.trim();
		} else if (want === entry) {
			return raw.trim();
		}
	}
	return null;
}

/** Minimal glob match (*, **, ?, [...] classes) for hot-path intersection. */
export function globMatch(pattern: string, value: string): boolean {
	let regex = "^";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i];
		if (ch === "*") {
			if (pattern[i + 1] === "*") { regex += ".*"; i++; }
			else regex += "[^/]*";
		} else if (ch === "?") {
			regex += "[^/]";
		} else if (ch === "[") {
			const close = pattern.indexOf("]", i + 1);
			if (close < 0) regex += "\\[";
			else { regex += pattern.slice(i, close + 1); i = close; }
		} else if ("\\.+^$()|{}".includes(ch)) {
			regex += "\\" + ch;
		} else {
			regex += ch;
		}
	}
	try {
		return new RegExp(regex + "$").test(value);
	} catch {
		return false;
	}
}

export function checkHotCap(input: {
	hotPaths: readonly string[];
	request: HotCapRequest;
	capMinutes?: number;
}): HotCapVerdict {
	const capMinutes = input.capMinutes ?? HOT_CAP_MINUTES;
	if (!input.request.exclusive) return { blocked: false };
	const ttlMinutes = input.request.ttlSeconds === undefined ? undefined : input.request.ttlSeconds / 60;
	if (ttlMinutes === undefined || ttlMinutes <= capMinutes) return { blocked: false };
	for (const path of input.request.paths) {
		const hot = isHotPath(input.hotPaths, path);
		if (hot !== null) {
			const verb = input.request.kind === "renew" ? "renewal" : "reservation";
			return { blocked: true, hotPath: hot,
				reason: `fleet-guard hot-path cap: exclusive ${verb} on ${path} asks ${ttlMinutes} min, over the ${capMinutes} min cap for hot path ${hot} (listed in .omp/hot-paths). Release first, or request ${capMinutes} min or less.` };
		}
	}
	return { blocked: false };
}

/** True for Agent Mail reservation/renewal tool calls (any prefix/suffix shape). */
export function isReservationTool(toolName: string): "reserve" | "renew" | null {
	const name = toolName.toLowerCase();
	if (!name.includes("file_reservation")) return null;
	if (name.includes("renew") || name.includes("extend")) return "renew";
	return "reserve";
}

/** Pull reservation args from any of the event arg shapes. */
export function reservationArgs(event: { arguments?: unknown; input?: unknown; params?: unknown }): {
	paths: string[]; exclusive: boolean; ttlSeconds: number | undefined;
} {
	const sources: unknown[] = [event.arguments, event.input, event.params];
	let paths: string[] = [];
	let exclusive = false;
	let ttlSeconds: number | undefined;
	for (const source of sources) {
		if (!source || typeof source !== "object") continue;
		const record = source as Record<string, unknown>;
		if (paths.length === 0) {
			const listed = Array.isArray(record.paths)
				? record.paths.filter((item): item is string => typeof item === "string" && item.trim() !== "")
				: [];
			if (listed.length > 0) paths = listed;
			else if (typeof record.path === "string" && record.path.trim() !== "") paths = [record.path];
		}
		if (record.exclusive === true) exclusive = true;
		if (typeof record.ttl_seconds === "number" && Number.isFinite(record.ttl_seconds)) ttlSeconds = record.ttl_seconds;
		else if (typeof record.ttlSeconds === "number" && Number.isFinite(record.ttlSeconds)) ttlSeconds = record.ttlSeconds;
		else if (typeof record.extend_seconds === "number" && Number.isFinite(record.extend_seconds)) ttlSeconds = record.extend_seconds;
		else if (typeof record.extendSeconds === "number" && Number.isFinite(record.extendSeconds)) ttlSeconds = record.extendSeconds;
	}
	return { paths, exclusive, ttlSeconds };
}

/** Pull renewal scope (hold ids, holder, project, extension) from any arg shape.
 * ID-only renewals carry file_reservation_ids with no paths or exclusive flag;
 * a renewal inherits the hold's exclusivity, so the cap judges the hold. */
export function renewScope(event: { arguments?: unknown; input?: unknown; params?: unknown }): {
	ids: number[]; agentName: string | undefined; projectKey: string | undefined; extendSeconds: number | undefined;
} {
	const sources: unknown[] = [event.arguments, event.input, event.params];
	let ids: number[] = [];
	let agentName: string | undefined;
	let projectKey: string | undefined;
	let extendSeconds: number | undefined;
	for (const source of sources) {
		if (!source || typeof source !== "object") continue;
		const record = source as Record<string, unknown>;
		if (ids.length === 0) {
			const rawIds = record.file_reservation_ids ?? record.reservation_ids ?? record.ids;
			if (Array.isArray(rawIds)) {
				const listed = rawIds.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
				if (listed.length > 0) ids = listed;
			} else if (typeof record.file_reservation_id === "number" && Number.isFinite(record.file_reservation_id)) {
				ids = [record.file_reservation_id];
			} else if (typeof record.reservation_id === "number" && Number.isFinite(record.reservation_id)) {
				ids = [record.reservation_id];
			} else if (typeof record.id === "number" && Number.isFinite(record.id)) {
				ids = [record.id];
			}
		}
		if (agentName === undefined) {
			for (const key of ["agent_name", "agentName", "agent"]) {
				if (typeof record[key] === "string" && (record[key] as string).trim() !== "") { agentName = (record[key] as string).trim(); break; }
			}
		}
		if (projectKey === undefined) {
			for (const key of ["project_key", "projectKey", "project"]) {
				if (typeof record[key] === "string" && (record[key] as string).trim() !== "") { projectKey = (record[key] as string).trim(); break; }
			}
		}
		if (extendSeconds === undefined) {
			if (typeof record.extend_seconds === "number" && Number.isFinite(record.extend_seconds)) extendSeconds = record.extend_seconds;
			else if (typeof record.extendSeconds === "number" && Number.isFinite(record.extendSeconds)) extendSeconds = record.extendSeconds;
		}
	}
	return { ids, agentName, projectKey, extendSeconds };
}
