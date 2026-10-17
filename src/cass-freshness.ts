import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionFreshness {
	roots: string[];
	files: number;
	newest_path: string | null;
	newest_mtime: string | null;
	complete: boolean;
}

export interface CassFreshness {
	status: "FRESH" | "STALE" | "UNAVAILABLE";
	observed_at: string;
	last_indexed_at: string | null;
	sessions: SessionFreshness;
	warning: string | null;
	command_exit: number | null;
	command_error: string | null;
	rebuild: { active: boolean | null; reported_pid: number | null; started_at: string | null; held_seconds: number | null };
	fallback: { status: "NOT_NEEDED" | "COMPLETE" | "UNAVAILABLE"; window_start: string | null; eligible_files: number;
		matching_files: string[]; command_exit: number | null; reason: string | null };
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function time(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Compare source clocks, never cass's fresh=true flag or age counter alone. */
export function assessCassFreshness(value: unknown, sessions: SessionFreshness, now: Date, commandExit: number | null): CassFreshness {
	const status = object(value), index = object(status.index), rebuild = object(status.rebuild);
	const indexed = time(index.last_indexed_at), newest = time(sessions.newest_mtime), started = time(rebuild.started_at);
	const active = typeof rebuild.active === "boolean" ? rebuild.active : null;
	const pid = typeof rebuild.pid === "number" && Number.isSafeInteger(rebuild.pid) && rebuild.pid > 0 ? rebuild.pid : null;
	const result: CassFreshness = {
		status: "UNAVAILABLE", observed_at: now.toISOString(),
		last_indexed_at: indexed === null ? null : new Date(indexed).toISOString(), sessions,
		warning: null, command_exit: commandExit, command_error: null,
		rebuild: { active, reported_pid: pid, started_at: started === null ? null : new Date(started).toISOString(),
			held_seconds: started !== null && started <= now.getTime() ? Math.floor((now.getTime() - started) / 1000) : null },
		fallback: { status: "NOT_NEEDED", window_start: null, eligible_files: 0, matching_files: [], command_exit: null, reason: null },
	};
	const budget = object(status.budget), fingerprint = object(index.fingerprint);
	const usable = commandExit === 0 && index.exists === true && indexed !== null && indexed <= now.getTime()
		&& newest !== null && newest <= now.getTime() && sessions.complete && budget.timed_out === false && active !== null
		&& typeof fingerprint.matches_current_db_fingerprint === "boolean"
		&& index.partial !== true && index.hollow !== true && index.engine_incompatible !== true
		&& !(index.rebuilding === true && active === false);
	if (usable) {
		result.status = indexed < newest || active === true || index.stale === true
			|| fingerprint.matches_current_db_fingerprint === false ? "STALE" : "FRESH";
	}
	if (result.status !== "FRESH") {
		result.warning = `FRESHNESS cass=${result.status} index=${result.last_indexed_at ?? "UNKNOWN"} newest_session=${sessions.newest_mtime ?? "UNKNOWN"} source_scan=${sessions.complete ? "complete" : "incomplete"} rebuild_pid=${pid ?? "UNKNOWN"} held_seconds=${result.rebuild.held_seconds ?? "UNKNOWN"}`;
	}
	return result;
}

/** Organic roots shared with the existing skill-ledger importer; no transcript bytes are read here. */
function sessionFreshness(home: string, since: number): { summary: SessionFreshness; recent: string[] } {
	const candidates = [join(home, ".omp", "agent", "sessions"), join(home, ".claude", "projects"), join(home, ".codex", "sessions")];
	const profiles = join(home, ".omp", "profiles");
	let complete = true;
	try {
		if (existsSync(profiles)) for (const entry of readdirSync(profiles, { withFileTypes: true })) {
			if (entry.isDirectory()) candidates.push(join(profiles, entry.name, "agent", "sessions"));
			else if (entry.isSymbolicLink()) complete = false;
		}
	} catch { complete = false; }
	const roots = candidates.filter(path => {
		try {
			if (!existsSync(path)) return false;
			const info = lstatSync(path);
			if (info.isDirectory() && !info.isSymbolicLink()) return true;
			complete = false;
		} catch { complete = false; }
		return false;
	});
	const pending = [...roots];
	const recent: string[] = [];
	let files = 0, newest = Number.NEGATIVE_INFINITY, newestPath: string | null = null;
	// This is a metadata preflight, not a corpus walk without a deadline. A capped scan cannot say FRESH.
	const deadline = Date.now() + 2000;
	while (pending.length) {
		if (Date.now() > deadline) { complete = false; break; }
		const directory = pending.pop()!;
		try {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				if (Date.now() > deadline) { complete = false; break; }
				const path = join(directory, entry.name);
				if (entry.isSymbolicLink()) { complete = false; continue; }
				if (entry.isDirectory()) { pending.push(path); continue; }
				if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
				const modified = lstatSync(path).mtimeMs;
				files++;
				if (modified >= since) recent.push(path);
				if (modified > newest) { newest = modified; newestPath = path; }
			}
		} catch { complete = false; }
	}
	return { summary: { roots, files, newest_path: newestPath, newest_mtime: Number.isFinite(newest) ? new Date(newest).toISOString() : null, complete }, recent };
}

/** Read-only status and a last-24h fixed-string fallback; no matching transcript text is returned. */
export function readCassFreshness(home: string): CassFreshness {
	const windowStart = Date.now() - 24 * 60 * 60 * 1000;
	const command = spawnSync("cass", ["status", "--json"], { cwd: home, env: { ...process.env, HOME: home },
		encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, input: "" });
	let value: unknown = null;
	try { value = JSON.parse(command.stdout ?? ""); } catch { /* Invalid status remains UNAVAILABLE. */ }
	const scan = sessionFreshness(home, windowStart);
	// Sources may advance while status runs: compare against observation time, not the report's earlier start.
	const result = assessCassFreshness(value, scan.summary, new Date(), command.status);
	result.command_error = command.error?.message ?? (command.status !== 0 ? command.stderr || `cass status exit ${command.status}` : value === null ? "Invalid cass status JSON" : null);
	result.fallback.window_start = new Date(windowStart).toISOString();
	result.fallback.eligible_files = scan.recent.length;
	if (result.status === "FRESH") return result;
	if (!scan.summary.roots.length) {
		result.fallback.status = "UNAVAILABLE";
		result.fallback.reason = "No organic session roots exist; no empty-input search was run.";
		return result;
	}
	const deadline = Date.now() + 10_000;
	for (let offset = 0; offset < scan.recent.length; offset += 128) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			result.fallback.status = "UNAVAILABLE";
			result.fallback.reason = "Lexical fallback exceeded its total 10s budget.";
			return result;
		}
		const fallback = spawnSync("rg", ["--files-with-matches", "--null", "--fixed-strings",
			"-e", "LESSON", "-e", "REWORK", "-e", "BLOCKED", "--", ...scan.recent.slice(offset, offset + 128)],
			{ cwd: home, encoding: "utf8", timeout: remaining, maxBuffer: 1024 * 1024, input: "" });
		result.fallback.command_exit = fallback.status;
		if (fallback.error || (fallback.status !== 0 && fallback.status !== 1)) {
			result.fallback.status = "UNAVAILABLE";
			result.fallback.reason = fallback.error?.message ?? (fallback.stderr || `Lexical search exit ${fallback.status}`);
			return result;
		}
		result.fallback.matching_files.push(...fallback.stdout.split("\0").filter(Boolean));
	}
	result.fallback.status = scan.summary.complete ? "COMPLETE" : "UNAVAILABLE";
	result.fallback.reason = !scan.summary.complete ? "Session metadata coverage is incomplete; fallback is not full coverage."
		: scan.recent.length === 0 ? "No session files changed in the last24h; no empty-input search was run." : null;
	return result;
}
