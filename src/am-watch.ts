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
 * A third trigger covers the wedge that has neither signal (2026-11-21: three
 * wedges with RSS under the ceiling and no fatal line, every br write refused
 * for hours): a real Agent Mail call that times out at 30 s or prints a pool
 * exhaustion error on two consecutive ticks restarts the server once, inside
 * the same cooldown. The call is `am agents show` for
 * OMP_KIT_AM_PROBE_PROJECT + OMP_KIT_AM_PROBE_AGENT (the br-shim whois call),
 * else `am list-projects --json`. Any other failure (agent not found, am not
 * installed) neither counts nor resets the streak.
 *
 * Every external call (process runs, log tail, clock, uid, paths) is
 * injectable through AmWatchDeps so tests never touch the live server.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { runSync } from "./kitlib/run.ts";

/** The launchd label of the Agent Mail server (never a kit label). */
export const AM_WATCH_LABEL = "com.agent-mail";
/** Default RSS ceiling that triggers a restart: 24 GiB (4.7 percent of the 512 GiB Studio). The old 6 GiB default killed a healthy 6.7 GB Agent Mail at 22:27:38Z on 2026-11-22 once an install dropped the hand-set OMP_KIT_AM_RSS_CEILING_BYTES; a default above the real working set means a dropped variable cannot kill the mail server. */
export const AM_WATCH_RSS_CEILING_BYTES = 24 * 1024 * 1024 * 1024;
/** Minimum gap between restarts: 30 min. */
export const AM_WATCH_COOLDOWN_MS = 30 * 60 * 1000;
/** Receipt name inside the load-watch state dir (its owned state). */
export const AM_WATCH_RECEIPT_NAME = "am-watch.json";
/** Bounded tail read of the server stderr log per tick. */
export const AM_WATCH_LOG_TAIL_BYTES = 256 * 1024;
export const AM_WATCH_SCHEMA_VERSION = 1;
/** Wall-clock limit of the liveness probe. */
export const AM_WATCH_PROBE_DEADLINE_S = 30;
/** Consecutive wedged probes (one per load-watch tick) before a restart. */
export const AM_WATCH_PROBE_FAILS = 2;
/** Probe streak file inside the load-watch state dir. */
export const AM_WATCH_PROBE_NAME = "am-watch-probe.json";

export type AmProbeOutcome = "ok" | "wedged" | "inconclusive";
export interface AmProbeResult { outcome: AmProbeOutcome; detail: string }
export type AmWatchProbe = () => AmProbeResult;

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
	probe?: AmWatchProbe;
}

export type AmWatchStatus = "RESTARTED" | "COOLDOWN" | "OK" | "NO_LABEL" | "NO_PROCESS" | "NO_LOG" | "UNKNOWN";
export type AmWatchReason = "rss-ceiling" | "fatal-pressure" | "unresponsive";

export interface AmWatchResult {
	status: AmWatchStatus;
	reason: AmWatchReason | null;
	pid: number | null;
	rssBytes: number | null;
	stderrPath: string | null;
	fatalAt: string | null;
	restartedAt: string | null;
	kickstartRc: number | null;
	probeStreak: number | null;
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

const WEDGE_TEXT = /no connections available|acquire timeout|pool error/i;

/** Pure verdict of one probe run: a timeout or a pool-exhaustion message is a wedge; success is ok; the rest says nothing. */
export function classifyAmProbe(rc: number | null, timedOut: boolean, text: string): AmProbeResult {
	if (timedOut) return { outcome: "wedged", detail: `am probe timed out after ${AM_WATCH_PROBE_DEADLINE_S} s` };
	if (rc === 0) return { outcome: "ok", detail: "am probe answered" };
	if (WEDGE_TEXT.test(text)) return { outcome: "wedged", detail: `am probe reported pool exhaustion (exit ${rc})` };
	return { outcome: "inconclusive", detail: `am probe exited ${rc} without a pool error` };
}

function defaultAmProbe(): AmProbeResult {
	const project = process.env.OMP_KIT_AM_PROBE_PROJECT ?? "";
	const agent = process.env.OMP_KIT_AM_PROBE_AGENT ?? "";
	if (project.startsWith("-") || agent.startsWith("-")) return { outcome: "inconclusive", detail: "am probe target refused: a value starts with '-'" };
	const argv = project !== "" && agent !== ""
		? ["am", "agents", "show", "--project", project, "--json", agent]
		: ["am", "list-projects", "--json"];
	try {
		const child = runSync(argv, { deadline_s: AM_WATCH_PROBE_DEADLINE_S, max_output_bytes: 4 << 20, env: { ...process.env, LC_ALL: "C" } });
		const decoder = new TextDecoder();
		return classifyAmProbe(child.rc, child.timed_out, `${decoder.decode(child.stdout)}\n${decoder.decode(child.stderr)}`);
	} catch {
		return { outcome: "inconclusive", detail: "am probe could not start" };
	}
}

function readProbeStreak(stateRoot: string): number {
	try {
		const raw = JSON.parse(readFileSync(join(stateRoot, AM_WATCH_PROBE_NAME), "utf8")) as Record<string, unknown>;
		const count = raw.consecutive_failures;
		return raw.schema_version === AM_WATCH_SCHEMA_VERSION && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
	} catch {
		return 0;
	}
}

function writeProbeStreak(stateRoot: string, streak: number, nowMs: number): void {
	try {
		mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
		const body = { schema_version: AM_WATCH_SCHEMA_VERSION, updated_at: new Date(nowMs).toISOString(), consecutive_failures: streak };
		writeFileSync(join(stateRoot, AM_WATCH_PROBE_NAME), `${JSON.stringify(body)}\n`, { mode: 0o600 });
	} catch {
		// A streak that cannot be persisted can only under-count, so the server is never restarted on a guess.
	}
}

/** Applies one probe outcome to the persisted streak: wedged adds one, ok clears it, inconclusive leaves it. */
function nextProbeStreak(stateRoot: string, outcome: AmProbeOutcome, nowMs: number): number {
	const previous = readProbeStreak(stateRoot);
	const next = outcome === "wedged" ? previous + 1 : outcome === "ok" ? 0 : previous;
	if (next !== previous) writeProbeStreak(stateRoot, next, nowMs);
	return next;
}

function baseResult(overrides: Partial<AmWatchResult> & { status: AmWatchStatus; detail: string }): AmWatchResult {
	return {
		reason: null, pid: null, rssBytes: null, stderrPath: null,
		fatalAt: null, restartedAt: null, kickstartRc: null, probeStreak: null, ...overrides,
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
	let probeStreak: number | null = null;
	let probeDetail = "";
	if (reason === null) {
		let probed: AmProbeResult;
		try {
			probed = (deps.probe ?? defaultAmProbe)();
		} catch {
			probed = { outcome: "inconclusive", detail: "am probe threw" };
		}
		probeStreak = nextProbeStreak(stateRoot, probed.outcome, now);
		probeDetail = `; ${probed.detail} (streak ${probeStreak}/${AM_WATCH_PROBE_FAILS})`;
		if (probed.outcome === "wedged" && probeStreak >= AM_WATCH_PROBE_FAILS) reason = "unresponsive";
	}
	if (reason === null) {
		return baseResult({ status: "OK", pid: target.pid, rssBytes: target.rssBytes, stderrPath, probeStreak,
			detail: `am serve-http pid=${target.pid} rss=${target.rssBytes} B under ceiling ${ceiling} B with no fresh fatal line${probeDetail}` });
	}
	if (lastRestartMs !== null && now - lastRestartMs < cooldownMs) {
		return baseResult({ status: "COOLDOWN", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath,
			fatalAt, restartedAt: receipt?.finishedAt ?? null, probeStreak,
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
	writeProbeStreak(stateRoot, 0, now);
	return baseResult({ status: "RESTARTED", reason, pid: target.pid, rssBytes: target.rssBytes, stderrPath, fatalAt,
		restartedAt: finishedAt, kickstartRc: kicked.code, probeStreak,
		detail: `restarted ${domainLabel} for ${reason}: pid=${target.pid} rss=${target.rssBytes} B` });
}

/**
 * AMREPLAY1 (ompkit-wy0ka): the load-watch tick's UNSENT-artifact replay step.
 * Runs scripts/am_replay.py tick when Agent Mail health answered, so replayed
 * LAND requests and verify assignments stop dying silently in pending_sends.
 * Like the health step it never throws and never fails the census: anything
 * unreadable is UNKNOWN with the detail naming it.
 */
export const AM_REPLAY_SCRIPT_REL = "scripts/am_replay.py";
// product-deadline: the step must finish inside the load-watch cap; the script
// bounds itself (--max-actions 5, 20 s per am call), so 180 s is the outer wall.
export const AM_REPLAY_DEADLINE_S = 180;
export const AM_REPLAY_MAX_ACTIONS = 5;
export const AM_REPLAY_MAX_AGE_H = 72;
export const AM_REPLAY_FIRST_RUN_MAX_AGE_H = 24;

export interface AmReplayDeps {
	run?: AmWatchRunner;
	scriptPath?: string;
	pendingDir?: string;
	archiveDir?: string;
	maxActions?: number;
	replayMaxAgeH?: number;
}

export type AmReplayStatus = "REPLAYED" | "CLEAN" | "SKIPPED-UNHEALTHY" | "UNKNOWN";

export interface AmReplayDiscard { artifact: string; reason: string }
export interface AmReplayError { artifact: string; op: string; detail: string }
export interface AmReplayResult {
	status: AmReplayStatus;
	unsentCount: number;
	oldestAgeHours: number;
	replayed: string[];
	discarded: AmReplayDiscard[];
	held: string[];
	errors: AmReplayError[];
	p1: boolean;
	detail: string;
}

function amReplayBase(status: AmReplayStatus, detail: string): AmReplayResult {
	return { status, unsentCount: -1, oldestAgeHours: -1, replayed: [], discarded: [],
		held: [], errors: [], p1: false, detail };
}

function defaultAmReplayRun(argv: readonly string[]): AmWatchRunResult {
	try {
		const child = runSync(argv, { deadline_s: AM_REPLAY_DEADLINE_S, max_output_bytes: 1 << 20,
			env: { ...process.env, LC_ALL: "C" } });
		const decoder = new TextDecoder();
		return { code: child.rc ?? 127, stdout: decoder.decode(child.stdout), stderr: decoder.decode(child.stderr) };
	} catch {
		return { code: 127, stdout: "", stderr: "spawn failed" };
	}
}

export function checkAmReplay(stateRoot: string, amOk: boolean, deps: AmReplayDeps = {}): AmReplayResult {
	try {
		if (!amOk) return amReplayBase("SKIPPED-UNHEALTHY", "Agent Mail health did not answer; replay waits for a healthy tick");
		const run = deps.run ?? defaultAmReplayRun;
		const script = deps.scriptPath ?? resolve(import.meta.dir, "..", AM_REPLAY_SCRIPT_REL);
		const argv = ["python3", "-B", script, "tick",
			"--max-actions", String(deps.maxActions ?? AM_REPLAY_MAX_ACTIONS),
			"--replay-max-age-h", String(deps.replayMaxAgeH ?? AM_REPLAY_MAX_AGE_H)];
		if (deps.pendingDir !== undefined) argv.push("--pending", deps.pendingDir);
		if (deps.archiveDir !== undefined) argv.push("--archive", deps.archiveDir);
		const child = run(argv);
		if (child.code !== 0) return amReplayBase("UNKNOWN", `am_replay.py exited ${child.code}: ${child.stderr.slice(0, 300)}`);
		let report: Record<string, unknown>;
		try {
			report = JSON.parse(child.stdout) as Record<string, unknown>;
		} catch {
			return amReplayBase("UNKNOWN", "am_replay.py printed no parseable report");
		}
		if (report["schema_version"] !== "am-replay-report.v1" || typeof report["unsent_count"] !== "number") {
			return amReplayBase("UNKNOWN", "am_replay.py report has the wrong schema");
		}
		const replayed = Array.isArray(report["replayed"]) ? (report["replayed"] as string[]) : [];
		const discarded = Array.isArray(report["discarded"]) ? (report["discarded"] as AmReplayDiscard[]) : [];
		const held = Array.isArray(report["held"]) ? (report["held"] as string[]) : [];
		const errors = Array.isArray(report["errors"]) ? (report["errors"] as AmReplayError[]) : [];
		const unsent = report["unsent_count"] as number;
		const oldest = report["oldest_age_hours"] as number;
		const acted = replayed.length > 0 || discarded.length > 0;
		const status: AmReplayStatus = acted ? "REPLAYED" : errors.length > 0 ? "UNKNOWN" : "CLEAN";
		void stateRoot;
		return { status, unsentCount: unsent, oldestAgeHours: oldest, replayed, discarded, held, errors,
			p1: report["p1"] === true,
			detail: `unsent=${unsent} oldest=${oldest}h replayed=${replayed.length} discarded=${discarded.length} held=${held.length} errors=${errors.length}` };
	} catch (error) {
		return amReplayBase("UNKNOWN", `replay step threw: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
	}
}
