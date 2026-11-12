/**
 * AMWATCH1 (ompkit-1ra0d.190): the load-watch job's Agent Mail health step.
 *
 * AMLEAK1 found an upstream am 0.3.39 heap leak: RSS grows ~3 GB/h until the
 * server logs its own `memory pressure ... to="fatal"` gauge, after which its
 * DB pool exhausts and every br-shim write, reservation and mail call fails. A
 * `launchctl kickstart -k gui/<uid>/com.agent-mail` recovers it in ~20 s.
 *
 * Each load-watch tick calls checkAmWatch: locate the `am serve-http` process
 * (a pgrep-equivalent `ps` read through the kitlib runner) and the server's
 * stderr log (parsed from `launchctl print gui/<uid>/com.agent-mail`, or a
 * configured path), then restart once when the RSS exceeds its ceiling
 * (default 6 GB) or the log holds a fatal-pressure line newer than the last
 * recorded restart. Restarts are recorded with RSS and reason in the load
 * state dir and rate-limited to once per 30 min. A missing launchd label
 * reports and does nothing; this step adds no refusal code.
 *
 * Every external call (process runs, log tail, clock, uid, paths) is
 * injectable through AmWatchDeps so tests never touch the live server.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { runSync } from "./kitlib/run.ts";

/** The launchd label of the Agent Mail server (never a kit label). */
export const AM_WATCH_LABEL = "com.agent-mail";
/** Default RSS ceiling that triggers a restart: 6 GB. */
export const AM_WATCH_RSS_CEILING_BYTES = 6 * 1024 * 1024 * 1024;
/** Minimum gap between restarts: 30 min. */
export const AM_WATCH_COOLDOWN_MS = 30 * 60 * 1000;
/** Receipt name inside the load-watch state dir (its owned state). */
export const AM_WATCH_RECEIPT_NAME = "am-watch.json";
/** Bounded tail read of the server stderr log per tick. */
export const AM_WATCH_LOG_TAIL_BYTES = 256 * 1024;
export const AM_WATCH_SCHEMA_VERSION = 1;

export interface AmWatchRunResult { code: number; stdout: string; stderr: string }
export type AmWatchRunner = (argv: readonly string[]) => AmWatchRunResult;
export type AmWatchTailReader = (path: string, maxBytes: number) => string | null;

export interface AmWatchDeps {
	run?: AmWatchRunner;
	readTail?: AmWatchTailReader;
	nowMs?: () => number;
	uid?: number;
	label?: string;
	stderrLogPath?: string;
	rssCeilingBytes?: number;
	cooldownMs?: number;
}

export type AmWatchStatus = "RESTARTED" | "COOLDOWN" | "OK" | "NO_LABEL" | "NO_PROCESS" | "NO_LOG" | "UNKNOWN";
export type AmWatchReason = "rss-ceiling" | "fatal-pressure";

export interface AmWatchResult {
	status: AmWatchStatus;
	reason: AmWatchReason | null;
	pid: number | null;
	rssBytes: number | null;
	stderrPath: string | null;
	fatalAt: string | null;
	restartedAt: string | null;
	kickstartRc: number | null;
	detail: string;
}

export interface AmWatchReceipt {
	schema_version: 1;
	checked_at: string;
	finished_at: string;
	label: string;
	pid: number;
	rss_bytes: number;
	reason: AmWatchReason;
	fatal_at: string | null;
	stderr_path: string;
	kickstart_rc: number;
}

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const STDERR_PATH_LINE = /^[ \t]*stderr path[ \t]*=[ \t]*(\S+)[ \t]*$/m;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;
const FATAL_LINE = /^\S+[ ]+\S+[ ]+memory pressure level changed[ ]+from="[A-Za-z_-]+"[ ]+to="fatal"[ ]+rss_bytes=\d+$/;
const TIMESTAMP_HEAD = /^(\S+)[ ].*$/;

function defaultAmRun(argv: readonly string[]): AmWatchRunResult {
	try {
		const child = runSync(argv, { deadline_s: 10, max_output_bytes: 1 << 20, env: { ...process.env, LC_ALL: "C" } });
		const decoder = new TextDecoder();
		return { code: child.rc ?? 127, stdout: decoder.decode(child.stdout), stderr: decoder.decode(child.stderr) };
	} catch {
		return { code: 127, stdout: "", stderr: "spawn failed" };
	}
}

/** Bounded tail read: the last maxBytes of path, never the whole file. */
export function readTailBytes(path: string, maxBytes: number): string | null {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
	let fd = -1;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		const buffer = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const read = readSync(fd, buffer, offset, length - offset, start + offset);
			if (read <= 0) break;
			offset += read;
		}
		closeSync(fd);
		fd = -1;
		return buffer.subarray(0, offset).toString("utf8");
	} catch {
		if (fd >= 0) {
			try { closeSync(fd); } catch { /* already failing */ }
		}
		return null;
	}
}

function parseCeilingEnv(raw: string | undefined): number | null {
	if (raw === undefined) return null;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Every `ps` row running the Agent Mail HTTP server, with RSS in bytes. */
export function parseAmProcesses(output: string): { pid: number; rssBytes: number; command: string }[] {
	const rows: { pid: number; rssBytes: number; command: string }[] = [];
	for (const line of output.split("\n")) {
		const match = PS_LINE.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const rssKb = Number(match[2]);
		const command = (match[3] ?? "").trim();
		if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(rssKb) || command.length === 0) continue;
		if (!command.includes("serve-http")) continue;
		rows.push({ pid, rssBytes: rssKb * 1024, command });
	}
	return rows;
}

/** The newest fatal-pressure line's timestamp, or null when the tail has none. */
export function latestFatalPressure(tail: string): { at: string; ms: number } | null {
	let newest: { at: string; ms: number } | null = null;
	for (const line of tail.split("\n")) {
		if (!line.includes("memory pressure level changed") || !line.includes('to="fatal"')) continue;
		if (!FATAL_LINE.test(line)) continue;
		const stamp = TIMESTAMP_HEAD.exec(line)?.[1] ?? null;
		if (stamp === null) continue;
		const ms = Date.parse(stamp);
		if (!Number.isFinite(ms)) continue;
		if (newest === null || ms > newest.ms) newest = { at: stamp, ms };
	}
	return newest;
}

function readAmReceipt(stateRoot: string): { finishedAt: string; finishedMs: number } | null {
	try {
		const raw = JSON.parse(readFileSync(join(stateRoot, AM_WATCH_RECEIPT_NAME), "utf8")) as Record<string, unknown>;
		if (raw.schema_version !== AM_WATCH_SCHEMA_VERSION || typeof raw.finished_at !== "string") return null;
		const ms = Date.parse(raw.finished_at);
		return Number.isFinite(ms) ? { finishedAt: raw.finished_at, finishedMs: ms } : null;
	} catch {
		return null;
	}
}

function baseResult(overrides: Partial<AmWatchResult> & { status: AmWatchStatus; detail: string }): AmWatchResult {
	return {
		reason: null, pid: null, rssBytes: null, stderrPath: null,
		fatalAt: null, restartedAt: null, kickstartRc: null, ...overrides,
	};
}

/**
 * One Agent Mail health check. Never throws and never touches the live
 * server except for a single `launchctl kickstart -k` on a fresh trigger
 * outside the cooldown. Returns UNKNOWN (no restart) on any unreadable
 * input so the load census still records.
 */
export function checkAmWatch(stateRoot: string, deps: AmWatchDeps = {}): AmWatchResult {
	try {
		return checkAmWatchInner(stateRoot, deps);
	} catch {
		return baseResult({ status: "UNKNOWN", detail: "am-watch failed closed on an unexpected error; no restart attempted" });
	}
}

function checkAmWatchInner(stateRoot: string, deps: AmWatchDeps): AmWatchResult {
	const run = deps.run ?? defaultAmRun;
	const readTail = deps.readTail ?? readTailBytes;
	const nowMs = deps.nowMs ?? Date.now;
	const label = deps.label ?? process.env.OMP_KIT_AM_LABEL ?? AM_WATCH_LABEL;
	if (!LABEL_PATTERN.test(label) || label.length > 255) {
		return baseResult({ status: "UNKNOWN", detail: `am-watch refuses an invalid Agent Mail label ${JSON.stringify(label)}; no restart attempted` });
	}
	const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 501);
	if (!Number.isSafeInteger(uid) || uid < 0) {
		return baseResult({ status: "UNKNOWN", detail: "am-watch refuses an invalid uid; no restart attempted" });
	}
	const ceiling = deps.rssCeilingBytes ?? parseCeilingEnv(process.env.OMP_KIT_AM_RSS_CEILING_BYTES) ?? AM_WATCH_RSS_CEILING_BYTES;
	const cooldownMs = deps.cooldownMs ?? AM_WATCH_COOLDOWN_MS;
	const now = nowMs();
	if (!Number.isFinite(now)) {
		return baseResult({ status: "UNKNOWN", detail: "am-watch refuses an invalid clock reading; no restart attempted" });
	}
	const domainLabel = `gui/${uid}/${label}`;

	let printed: AmWatchRunResult;
	try {
		printed = run(["launchctl", "print", domainLabel]);
	} catch {
		return baseResult({ status: "UNKNOWN", detail: `launchctl print ${domainLabel} threw; no restart attempted` });
	}
	if (printed.code !== 0) {
		const text = `${printed.stdout}\n${printed.stderr}`;
		if (text.includes("Could not find service") || text.includes("No such process")) {
			return baseResult({ status: "NO_LABEL", detail: `launchd has no ${domainLabel}; leaving Agent Mail alone` });
		}
		return baseResult({ status: "UNKNOWN", detail: `launchctl print ${domainLabel} exited ${printed.code}; no restart attempted` });
	}
	const stderrPath = deps.stderrLogPath ?? process.env.OMP_KIT_AM_STDERR_PATH ?? STDERR_PATH_LINE.exec(printed.stdout)?.[1] ?? null;
	if (stderrPath === null || stderrPath.length === 0) {
		return baseResult({ status: "NO_LOG", detail: `launchctl print ${domainLabel} names no stderr path; no restart attempted` });
	}

	let listed: AmWatchRunResult;
	try {
		listed = run(["ps", "-axo", "pid=,rss=,command="]);
	} catch {
		return baseResult({ status: "UNKNOWN", stderrPath, detail: "ps read threw; no restart attempted" });
	}
	if (listed.code !== 0) {
		return baseResult({ status: "UNKNOWN", stderrPath, detail: `ps exited ${listed.code}; no restart attempted` });
	}
	const candidates = parseAmProcesses(listed.stdout);
	if (candidates.length === 0) {
		return baseResult({ status: "NO_PROCESS", stderrPath, detail: "no am serve-http process is running; leaving launchd to supervise it" });
	}
	const target = candidates.reduce((a, b) => (b.rssBytes > a.rssBytes ? b : a));
	const receipt = readAmReceipt(stateRoot);
	const lastRestartMs = receipt?.finishedMs ?? null;

	let reason: AmWatchReason | null = null;
	let fatalAt: string | null = null;
	if (target.rssBytes >= ceiling) {
		reason = "rss-ceiling";
	} else {
		let tail: string | null = null;
		try {
			tail = readTail(stderrPath, AM_WATCH_LOG_TAIL_BYTES);
		} catch {
			tail = null;
		}
		if (tail !== null) {
			const fatal = latestFatalPressure(tail);
			if (fatal !== null && (lastRestartMs === null || fatal.ms > lastRestartMs)) {
				reason = "fatal-pressure";
				fatalAt = fatal.at;
			}
		}
	}
	if (reason === null) {
		return baseResult({ status: "OK", pid: target.pid, rssBytes: target.rssBytes, stderrPath,
			detail: `am serve-http pid=${target.pid} rss=${target.rssBytes} B under ceiling ${ceiling} B with no fresh fatal line` });
	}
	if (lastRestartMs !== null && now - lastRestartMs < cooldownMs) {
		return baseResult({ status: "COOLDOWN", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath,
			fatalAt, restartedAt: receipt?.finishedAt ?? null,
			detail: `am restart for ${reason} suppressed: last restart ${receipt?.finishedAt} is inside the 30 min cooldown` });
	}
	let kicked: AmWatchRunResult;
	try {
		kicked = run(["launchctl", "kickstart", "-k", domainLabel]);
	} catch {
		return baseResult({ status: "UNKNOWN", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath, fatalAt,
			detail: `launchctl kickstart -k ${domainLabel} threw; no receipt recorded` });
	}
	if (kicked.code !== 0) {
		return baseResult({ status: "UNKNOWN", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath, fatalAt,
			kickstartRc: kicked.code, detail: `launchctl kickstart -k ${domainLabel} exited ${kicked.code}; no receipt recorded` });
	}
	const finishedAt = new Date(now).toISOString();
	const receiptBody: AmWatchReceipt = { schema_version: AM_WATCH_SCHEMA_VERSION, checked_at: finishedAt, finished_at: finishedAt,
		label, pid: target.pid, rss_bytes: target.rssBytes, reason, fatal_at: fatalAt, stderr_path: stderrPath, kickstart_rc: kicked.code };
	try {
		mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		writeFileSync(join(stateRoot, AM_WATCH_RECEIPT_NAME), `${JSON.stringify(receiptBody)}\n`, { mode: 0o600 });
	} catch {
		return baseResult({ status: "UNKNOWN", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath, fatalAt,
			kickstartRc: kicked.code, detail: "am restart kickstarted but the receipt could not be written" });
	}
	return baseResult({ status: "RESTARTED", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath, fatalAt,
		restartedAt: finishedAt, kickstartRc: kicked.code,
		detail: `restarted ${domainLabel} for ${reason}: pid=${target.pid} rss=${target.rssBytes} B` });
}
