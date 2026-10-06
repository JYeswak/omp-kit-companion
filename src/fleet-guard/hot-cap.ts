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

/** Exact match, or dir-prefix when the entry ends with /. */
export function isHotPath(hotPaths: readonly string[], requestedPath: string): string | null {
	const want = normalize(requestedPath);
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
	if (name.endsWith("renew_file_reservations")) return "renew";
	if (name.endsWith("file_reservation_paths")) return "reserve";
	return null;
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
	}
	return { paths, exclusive, ttlSeconds };
}
