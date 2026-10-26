/**
 * kitlib proc: process incarnation and typed liveness evidence (ompkit-5m6ej, KL09; liveness half of PIDIDENT1 ompkit-a0vy1).
 *
 * J-2026-10-21-08: "a pid mismatch can never cause us another problem". A bare pid is not an owner: pids are reused,
 * and `kill(pid, 0)` reports zombies alive. An owner is an incarnation `{pid, start}`, where `start` is the process
 * start time from `ps -o lstart=` (LC_ALL=C), whitespace-collapsed so the string is stable.
 *
 * `probeIncarnation()` classifies a recorded incarnation as:
 *   live    the pid runs, state is not Z, and its start equals the recorded start
 *   zombie  the pid is in state Z (exited, unreaped): dead for every caller
 *   reused  the pid runs with a different start: the recorded process is dead
 *   dead    ps does not list the pid and `kill(pid, 0)` says ESRCH
 *   unknown nothing could be read reliably (ps failed, timed out, or disagrees with signal 0): never dead
 * `isDead()` is true only for dead, reused and zombie.
 *
 * `incarnationSync()` and `probeIncarnationSync()` are the same decisions for synchronous callers: one classifier,
 * differing only in reading ps through `runSync` (a leaf command) instead of `run`.
 *
 * Observation only: it grants no authority and has no side effects; the only signal ever sent is signal 0.
 * POSIX only (macOS, Linux); other platforms are refused. `scripts/kitlib_proc.py` is the Python twin; both pass
 * `tests/fixtures/kitlib-proc/corpus.json`.
 */
import { run, runSync, type RunResult } from "./run";

export type ProbeState = "live" | "zombie" | "reused" | "dead" | "unknown";

export interface Incarnation {
	pid: number;
	start: string;
}

export interface ProbeEvidence {
	pid: number;
	recorded_start: string;
	/** Start ps reports now; null when ps does not list the pid or could not be read. */
	observed_start: string | null;
	/** ps STAT column; null when not listed or unreadable. */
	stat: string | null;
	/** `kill(pid, 0)` result, null when ps alone decided. */
	signal0: "alive" | "eperm" | "esrch" | null;
	/** Why the state was chosen. */
	reason: string;
}

export interface Probe {
	state: ProbeState;
	evidence: ProbeEvidence;
}

/** One `ps` read: `rc` null or `timed_out` true means unreadable. */
export interface PsRead {
	rc: number | null;
	timed_out: boolean;
	stdout: string;
}

/** Test seam. Production callers pass nothing. */
export interface ProbeSeam {
	ps?: (pid: number) => Promise<PsRead>;
	/** Planted-negative switches: false disables a detector. Default true. */
	detectZombie?: boolean;
	detectReuse?: boolean;
}

/** The synchronous twin's seam: the same switches, with a synchronous ps read. */
export type ProbeSeamSync = Omit<ProbeSeam, "ps"> & { ps?: (pid: number) => PsRead };

/** Largest pid either platform issues (Linux pid_max ceiling 2^22; macOS 99999); bound generously at int32. */
export const PID_MAX = 0x7fffffff;
const PS_ENV = { LC_ALL: "C", PATH: "/usr/bin:/bin" };
const decoder = new TextDecoder();

function posixOnly(): void {
	if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`kitlib proc needs POSIX ps; ${process.platform} is unsupported`);
}

function checkPid(pid: unknown): number {
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1 || pid > PID_MAX) throw new TypeError(`pid must be an integer in 1..${PID_MAX}, got ${String(pid)}`);
	return pid;
}

/** Collapses runs of whitespace so `Mon Oct  5 ...` and `Mon Oct 5 ...` compare equal. */
export function normalizeStart(start: string): string {
	return start.split(/\s+/).filter(part => part !== "").join(" ");
}

const PS_ARGV = (pid: number): string[] => ["ps", "-o", "stat=", "-o", "lstart=", "-p", String(pid)];
const PS_OPTIONS = { deadline_s: 10, max_output_bytes: 4096, env: PS_ENV };
const psRead = (result: RunResult): PsRead => ({ rc: result.rc, timed_out: result.timed_out, stdout: decoder.decode(result.stdout) });

async function defaultPs(pid: number): Promise<PsRead> {
	try {
		return psRead(await run(PS_ARGV(pid), PS_OPTIONS));
	} catch {
		return { rc: null, timed_out: false, stdout: "" };
	}
}

function defaultPsSync(pid: number): PsRead {
	try {
		return psRead(runSync(PS_ARGV(pid), PS_OPTIONS));
	} catch {
		return { rc: null, timed_out: false, stdout: "" };
	}
}

type Row = { stat: string; start: string };
/** "listed" with a row, "absent" (ps ran and does not list the pid), or "unreadable". */
type Read = { kind: "listed"; row: Row } | { kind: "absent" } | { kind: "unreadable"; why: string };

function parsePs(read: PsRead): Read {
	if (read.timed_out || read.rc === null) return { kind: "unreadable", why: read.timed_out ? "ps timed out" : "ps did not run" };
	const lines = read.stdout.split("\n").map(line => line.trim()).filter(line => line !== "");
	if (read.rc !== 0) {
		// Both platforms exit 1 with no rows for an unknown pid; anything else is an error.
		return read.rc === 1 && lines.length === 0 ? { kind: "absent" } : { kind: "unreadable", why: `ps exited ${read.rc}` };
	}
	if (lines.length !== 1) return lines.length === 0 ? { kind: "absent" } : { kind: "unreadable", why: `ps printed ${lines.length} rows` };
	const fields = lines[0]!.split(/\s+/);
	// STAT then a five-field ctime start: "Thu Oct 22 07:50:28 2026".
	if (fields.length !== 6) return { kind: "unreadable", why: "ps row is not STAT plus lstart" };
	return { kind: "listed", row: { stat: fields[0]!, start: fields.slice(1).join(" ") } };
}

function signal0(pid: number): "alive" | "eperm" | "esrch" | "error" {
	try {
		process.kill(pid, 0);
		return "alive";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM" ? "eperm" : code === "ESRCH" ? "esrch" : "error";
	}
}

/** The current incarnation of `pid`, or null when ps does not list it (or cannot be read). */
export async function incarnation(pid: number, seam: ProbeSeam = {}): Promise<Incarnation | null> {
	posixOnly();
	checkPid(pid);
	return incarnationOf(pid, await (seam.ps ?? defaultPs)(pid));
}

/** `incarnation()` for synchronous callers. */
export function incarnationSync(pid: number, seam: ProbeSeamSync = {}): Incarnation | null {
	posixOnly();
	checkPid(pid);
	return incarnationOf(pid, (seam.ps ?? defaultPsSync)(pid));
}

function incarnationOf(pid: number, ps: PsRead): Incarnation | null {
	const read = parsePs(ps);
	return read.kind === "listed" ? { pid, start: read.row.start } : null;
}

/** Validates a recorded incarnation before any ps read; returns it with its start normalized. */
function checkRecorded(recorded: Incarnation): Incarnation {
	posixOnly();
	if (recorded === null || typeof recorded !== "object") throw new TypeError("probeIncarnation takes {pid, start}");
	const pid = checkPid(recorded.pid);
	if (typeof recorded.start !== "string" || normalizeStart(recorded.start) === "") throw new TypeError("start must be a non-empty process start string");
	return { pid, start: normalizeStart(recorded.start) };
}

export async function probeIncarnation(recorded: Incarnation, seam: ProbeSeam = {}): Promise<Probe> {
	const checked = checkRecorded(recorded);
	return classify(checked, await (seam.ps ?? defaultPs)(checked.pid), seam);
}

/** `probeIncarnation()` for synchronous callers: the same classifier over a `runSync` ps read. */
export function probeIncarnationSync(recorded: Incarnation, seam: ProbeSeamSync = {}): Probe {
	const checked = checkRecorded(recorded);
	return classify(checked, (seam.ps ?? defaultPsSync)(checked.pid), seam);
}

/** The one decision both probes share; `recorded` is already checked and normalized. */
function classify(recorded: Incarnation, ps: PsRead, seam: Omit<ProbeSeam, "ps">): Probe {
	const { pid, start: recordedStart } = recorded;
	const read = parsePs(ps);
	const evidence: ProbeEvidence = { pid, recorded_start: recordedStart, observed_start: null, stat: null, signal0: null, reason: "" };
	const decide = (state: ProbeState, reason: string): Probe => ({ state, evidence: { ...evidence, reason } });
	if (read.kind === "unreadable") return decide("unknown", read.why);
	if (read.kind === "absent") {
		const sig = signal0(pid);
		evidence.signal0 = sig === "error" ? null : sig;
		if (sig === "esrch") return decide("dead", "ps does not list the pid and signal 0 says ESRCH");
		return decide("unknown", `ps does not list the pid but signal 0 says ${sig}`);
	}
	evidence.observed_start = read.row.start;
	evidence.stat = read.row.stat;
	if (seam.detectZombie !== false && read.row.stat.startsWith("Z")) return decide("zombie", "ps state Z: exited, not reaped");
	if (seam.detectReuse !== false && read.row.start !== recordedStart) return decide("reused", "pid runs with a different start time");
	return decide("live", "pid runs with the recorded start time");
}

/** True only for dead, reused and zombie; unknown is never dead. */
export function isDead(probe: Probe | ProbeState): boolean {
	const state = typeof probe === "string" ? probe : probe.state;
	return state === "dead" || state === "reused" || state === "zombie";
}
