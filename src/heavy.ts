import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { homedir, cpus, loadavg } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import process from "node:process";
import { inspectStateRoot } from "./state-root.ts";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { incarnation, incarnationSync, isDead, normalizeStart, probeIncarnation } from "./kitlib/proc.ts";
import { run, type RunTimings } from "./kitlib/run.ts";
import { appendJsonl } from "./kitlib/jsonl.ts";
import { admitDiskWork } from "./disk-stage.ts";
import type { LoadJob } from "./load-doctor.ts";
import labelBudgets from "../config/heavy-labels.json";

const LOAD_PER_CORE_LIMIT = 2.5;
const STATUS_INTERVAL_MS = 30_000;
const LOCK_POLL_MS = 100;
const QUEUE_POLL_MS = 1_000;
const MAX_WAIT_SECONDS = 900;

type HeavyJob = LoadJob & { argv: string[]; process_start: string; queued_at: string; started_at?: string; lane?: string };
type DiskObserver = "sbh" | "statfs" | "auto";
const DISK_OBSERVERS: readonly DiskObserver[] = ["sbh", "statfs", "auto"];
type HeavyConfig = { slots: number; max_wait_s: number; disk_observer: DiskObserver; disk_floor_pct: number | null; sbh_deadline_s?: number; runtime_budget_s?: Record<string, number>; lane_slots?: Record<string, number> };
type MachineLoad = { load1: number; ncpu: number };
type HeavySignal = "SIGINT" | "SIGTERM";
type HeavyChild = { exited: Promise<number>; kill(signal: HeavySignal | "SIGKILL"): void };
const SIGNAL_EXIT_CODES: Record<HeavySignal, number> = { SIGINT: 130, SIGTERM: 143 };

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String(error.code) : undefined;
}


function ensurePrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const issue = inspectStateRoot(path);
	if (issue) throw new Error(`unsafe heavy-work state directory ${path}: ${issue.problem} ${issue.mode}; expected ${issue.expected}`);
}

function ensureStorage(root: string): { jobs: string; lock: string } {
	ensurePrivateDirectory(root);
	const jobs = join(root, "jobs");
	ensurePrivateDirectory(jobs);
	return { jobs, lock: join(root, "mutex") };
}

/**
 * SAVEFIRST1 (ompkit-774u.16): `override` is `--disk-observer`; it replaces
 * load.json's disk_observer for one call, so a save path (the pre-push gate)
 * can admit on physical bytes alone while sbh's policy floor stays a flag, not
 * a veto. A caller override to statfs also ignores load.json's percentage floor;
 * every other setting remains unchanged.
 */
function loadConfig(override?: DiskObserver): HeavyConfig {
	const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-kit", "load.json");
	let raw: string;
	try { raw = readFileSync(path, "utf8"); }
	catch (error) {
		if (errorCode(error) === "ENOENT") return { slots: 2, max_wait_s: MAX_WAIT_SECONDS, disk_observer: override ?? "auto", disk_floor_pct: null };
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	const slots = "slots" in value ? value.slots : 2;
	const maxWait = "max_wait_s" in value ? value.max_wait_s : MAX_WAIT_SECONDS;
	const observer: unknown = "disk_observer" in value ? value.disk_observer : "auto";
	const floor: unknown = "disk_floor_pct" in value ? value.disk_floor_pct : null;
	const sbhDeadline = "sbh_deadline_s" in value ? value.sbh_deadline_s : SBH_CHECK_DEADLINE_S;
	const runtimeBudgets: unknown = "runtime_budget_s" in value ? value.runtime_budget_s : {};
	const laneSlots: unknown = "lane_slots" in value ? value.lane_slots : {};
	if (typeof laneSlots !== "object" || laneSlots === null || Array.isArray(laneSlots) ||
		Object.entries(laneSlots).some(([lane, count]) => !validLane(lane) || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 64))
		throw new Error("invalid heavy-work config: lane_slots must map lane names to slot counts 1..64");
	if (typeof runtimeBudgets !== "object" || runtimeBudgets === null || Array.isArray(runtimeBudgets) ||
		Object.values(runtimeBudgets).some(budget => typeof budget !== "number" || !Number.isSafeInteger(budget) || budget <= 0))
		throw new Error("invalid heavy-work config for --max-runtime: runtime_budget_s values must be positive integer seconds");
	if (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 || slots > 64 ||
		typeof maxWait !== "number" || !Number.isFinite(maxWait) || maxWait < 0 || maxWait > MAX_WAIT_SECONDS)
		throw new Error(`invalid heavy-work config: slots must be 1..64 and max_wait_s must be 0..${MAX_WAIT_SECONDS}`);
	if (observer !== "sbh" && observer !== "statfs" && observer !== "auto")
		throw new Error(`invalid heavy-work config: disk_observer must be "sbh", "statfs" or "auto": ${path}`);
	if (floor !== null && (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 50))
		throw new Error(`invalid heavy-work config: disk_floor_pct must be 0..50: ${path}`);
	if (typeof sbhDeadline !== "number" || !Number.isFinite(sbhDeadline) || sbhDeadline <= 0)
		throw new Error(`invalid heavy-work config: sbh_deadline_s must be positive finite seconds: ${path}`);
	return { slots, max_wait_s: maxWait, disk_observer: override ?? observer, disk_floor_pct: override === "statfs" ? null : floor, sbh_deadline_s: sbhDeadline, runtime_budget_s: runtimeBudgets as Record<string, number>, lane_slots: laneSlots as Record<string, number> };
}

export function machineLoadBlockReason(load1: number, ncpu: number): string | null {
	if (!Number.isFinite(load1) || !Number.isFinite(ncpu) || ncpu < 1) return "machine load unavailable";
	const threshold = ncpu * LOAD_PER_CORE_LIMIT;
	return load1 > threshold ? `LOAD1 ${load1.toFixed(2)} exceeds ${threshold.toFixed(2)} (${ncpu} cores × ${LOAD_PER_CORE_LIMIT})` : null;
}

/**
 * Test-only load injection for planted contention cases. Production never
 * sets OMP_KIT_HEAVY_FAKE_LOAD1; the real one-minute load average applies.
 */
function testFakeLoad(): number | undefined {
	const raw = process.env.OMP_KIT_HEAVY_FAKE_LOAD1;
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * HEAVYDISK1 (ompkit-fp72.52): disk admission uses the fleet sbh floor.
 * sbh contract: exit 0 healthy, 1 pressure, 2 error. sbhBin is a test seam
 * (fixture PATH shadows the real binary); production always uses "sbh".
 * HEAVYCI1 (ompkit-fp72.117): an observer that cannot run, or answers outside
 * that contract, is a missing prerequisite rather than pressure. Waiting cannot
 * fix it, so admission fails fast with HEAVY_PREREQ_MISSING instead of
 * deferring 75; the disk check is never skipped.
 * HEAVYDEFER1: a deadline expiry is temporary uncertainty, not evidence that an
 * observer is missing. It defers with 75, without admitting or falling back.
 * oq1h.1 (portable default): admission prefers OS-native statfs on the cwd,
 * with sbh as an auto-detected adapter. disk_observer "sbh" keeps the strict
 * contract above byte-for-byte; "statfs" never touches sbh; "auto" (default)
 * takes sbh's 0/1 verdict when sbh resolves on PATH and falls back to statfs
 * when it does not. A statfs failure is unavailable, never healthy.
 */
export const HEAVY_DISK_NEED = "10G";
/** Bytes side of HEAVY_DISK_NEED; keep consistent with the sbh --need flag above. */
export const HEAVY_DISK_NEED_BYTES = 10 * 1024 ** 3;
/** EX_UNAVAILABLE (sysexits.h): a required observer is missing; distinct from the 75 deferral. */
export const HEAVY_PREREQ_MISSING = 69;
export type DiskVerdict = { kind: "ok"; observer: DiskObserver } | { kind: "pressure"; text: string; observer: DiskObserver } | { kind: "unavailable"; text: string; observer: DiskObserver } | { kind: "timeout"; text: string; observer: DiskObserver };
type ObserverTiming = {
	/** Parent-observed Bun.spawn return, never a claim about the child's first instruction. */
	start_boundary: "spawn-return" | null;
	spawn_to_start_ms: number | null;
	start_to_exit_ms: number | null;
	cleanup_ms: number | null;
	/** Epoch milliseconds of the observer answer (or observed spawn failure), before decision/cleanup. */
	answer_observed_at_ms: number;
	total_ms: number;
	deadline_ms: number | null;
};
type ObservedDiskVerdict = DiskVerdict & { timing: ObserverTiming };
/** `statfs: 129.2 GB free (13.6%)` for the cwd, or the reason there is no reading; never throws. */
export function statfsSummary(cwd: string): string {
	const capacity = statfsCapacity(cwd);
	if (capacity === null) return "statfs: no reading";
	return `statfs: ${(capacity.freeBytes / 1024 ** 3).toFixed(1)} GB free (${capacity.freePct.toFixed(1)}%)`;
}
// HEAVYDEFER1: this is a hang guard, not a latency budget. A 15 s diagnostic
// window completed 33 probes at load1 19.30–19.76: spawn-return to first child
// clock median 779.809 ms/max 3090.082 ms; child body median 8.252 ms/max 41.632 ms;
// child-end to observed exit median 1.029 ms/max 1.681 ms. Data:
// var/agent-tmp/heavy-observer-window.79959/observations.jsonl. Four seconds cut
// the startup tail under load 25–40; 30 s guards hangs above that observed tail.
// load.json sbh_deadline_s selects an explicit shorter guard when required.
const SBH_CHECK_DEADLINE_S = 30;

async function sbhVerdict(sbhBin: string, cwd: string, timings: RunTimings, deadlineS: number): Promise<DiskVerdict> {
	let code: number;
	try {
		const result = await run([sbhBin, "check", "--need", HEAVY_DISK_NEED], {
			cwd, deadline_s: deadlineS, grace_s: 0.2, max_output_bytes: 0, timings,
		});
		if (result.timed_out) return { kind: "timeout", text: `sbh check timed out after ${deadlineS}s`, observer: "sbh" };
		if (result.rc === null || result.killed) return { kind: "unavailable", text: "sbh check did not complete", observer: "sbh" };
		code = result.rc;
	} catch {
		return { kind: "unavailable", text: "sbh binary not runnable", observer: "sbh" };
	}
	if (code === 0) return { kind: "ok", observer: "sbh" };
	// MACHINEMEASURES1 (ompkit-774u.9.22): the sbh verdict and the OS reading side by side, so a wedge (sbh pressure
	// while statfs shows free space, 2026-10-25: rc 75 all day at 129 GB free) is visible in the refusal itself.
	if (code === 1) return { kind: "pressure", text: `disk low: sbh check --need ${HEAVY_DISK_NEED} reports pressure; ${statfsSummary(cwd)}`, observer: "sbh" };
	return { kind: "unavailable", text: `sbh check exited ${code}`, observer: "sbh" };
}
export type DiskCapacity = { freeBytes: number; freePct: number };
function statfsCapacity(cwd: string): DiskCapacity | null {
	let stats: { bavail: number; blocks: number; bsize: number };
	try {
		const observed = statfsSync(cwd);
		stats = { bavail: Number(observed.bavail), blocks: Number(observed.blocks), bsize: Number(observed.bsize) };
	} catch {
		return null;
	}
	if (!Number.isFinite(stats.bavail) || !Number.isFinite(stats.blocks) || !Number.isFinite(stats.bsize) ||
		stats.blocks <= 0 || stats.bavail < 0 || stats.bsize <= 0) return null;
	return { freeBytes: stats.bavail * stats.bsize, freePct: Math.min(100, (stats.bavail / stats.blocks) * 100) };
}
/** Pure statfs verdict: capacity in, judgment out. Unit-tested directly with
 * fabricated capacities; production always passes the real statfs reading,
 * so no environment variable can forge a healthy disk. */
export function decideDiskPressure(capacity: DiskCapacity | null, floorPct: number | null): DiskVerdict {
	if (capacity === null) return { kind: "unavailable", text: "no disk observer available", observer: "statfs" };
	if (capacity.freeBytes < HEAVY_DISK_NEED_BYTES) return { kind: "pressure", text: "disk low (statfs)", observer: "statfs" };
	if (floorPct !== null && capacity.freePct < floorPct)
		return { kind: "pressure", text: `disk low (statfs): ${capacity.freePct.toFixed(1)}% free below floor ${floorPct}%`, observer: "statfs" };
	return { kind: "ok", observer: "statfs" };
}
function sbhResolvable(): boolean {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const candidate = resolve(directory || ".", "sbh");
		try {
			const stat = statSync(candidate);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) return true;
		} catch { /* not here; keep looking */ }
	}
	return false;
}
function observerTiming(started: number, observer: DiskObserver, timings?: RunTimings, deadlineS = SBH_CHECK_DEADLINE_S): ObserverTiming {
	const finished = performance.now();
	const spawning = timings?.spawn_started_ms ?? null;
	const spawned = timings?.started_ms ?? null;
	const exited = timings?.exited_ms ?? null;
	return {
		start_boundary: spawned === null ? null : "spawn-return",
		spawn_to_start_ms: spawning === null || spawned === null ? null : spawned - spawning,
		start_to_exit_ms: spawned === null || exited === null ? null : exited - spawned,
		cleanup_ms: exited === null ? null : finished - exited,
		answer_observed_at_ms: performance.timeOrigin + (exited ?? finished),
		total_ms: finished - started,
		deadline_ms: observer === "sbh" ? deadlineS * 1000 : null,
	};
}

export async function diskVerdict(input?: { config?: HeavyConfig; cwd?: string; sbhBin?: string }): Promise<ObservedDiskVerdict> {
	const started = performance.now();
	const observer = input?.config?.disk_observer ?? "auto";
	const floor = input?.config?.disk_floor_pct ?? null;
	const cwd = input?.cwd ?? process.cwd();
	const sbhBin = input?.sbhBin ?? "sbh";
	const deadlineS = input?.config?.sbh_deadline_s ?? SBH_CHECK_DEADLINE_S;
	let timings: RunTimings | undefined;
	let verdict: DiskVerdict;
	if (observer === "sbh" || (observer === "auto" && sbhResolvable())) {
		timings = { spawn_started_ms: null, started_ms: null, exited_ms: null };
		verdict = await sbhVerdict(sbhBin, cwd, timings, deadlineS);
		if (observer === "auto" && verdict.kind === "unavailable")
			verdict = { ...verdict, text: `${verdict.text} (set disk_observer to "statfs" for OS-native admission)` };
	} else {
		verdict = decideDiskPressure(statfsCapacity(cwd), floor);
	}
	return { ...verdict, timing: observerTiming(started, verdict.observer, timings, deadlineS) };
}

/**
 * HEAVYDEFER1: a separate append-only ledger survives removal (or absence) of
 * the queued job. Read with kitlib readJsonl at $XDG_STATE_HOME/omp-kit/load/
 * observer-refusals.jsonl. The canonical writer locks, completes the line and
 * fsyncs before returning; an append failure propagates and never admits work.
 * Null subprocess boundaries mean no observed process (e.g. missing sbh or statfs).
 */
async function recordObserverRefusal(root: string, job: Pick<HeavyJob, "id" | "label">, phase: "disk-stage" | "precheck" | "admission", verdict: Exclude<ObservedDiskVerdict, { kind: "ok" }>): Promise<void> {
	ensurePrivateDirectory(root);
	await appendJsonl(join(root, "observer-refusals.jsonl"), () => ({
		schema_version: 1, ts: new Date().toISOString(), job_id: job.id, pid: process.pid,
		label: job.label, phase, observer: verdict.observer, kind: verdict.kind, reason: verdict.text,
		load1: loadavg()[0] ?? null, timing: verdict.timing,
	}), { deadline_s: 5, durable: true, state_dir: root });
}

function refuseObserver(verdict: Extract<DiskVerdict, { kind: "unavailable" | "timeout" }>): number {
	if (verdict.kind === "timeout") {
		process.stderr.write(`RESOURCE_DEFERRED: ${verdict.text}; disk state unknown; no command was run\n`);
		process.stderr.write(`deferred: ${verdict.text}\n`);
		return 75;
	}
	process.stderr.write(`heavy: ${verdict.observer} unavailable: ${verdict.text}; disk admission requires ${verdict.observer === "sbh" ? "sbh" : "an observer"}; no command was run\n`);
	return HEAVY_PREREQ_MISSING;
}



function currentRepo(cwd: string): string {
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "ignore" });
		const root = result.stdout.toString().trim();
		if (result.exitCode === 0 && root) return root;
	} catch { /* Standalone commands are attributed to their working directory. */ }
	return cwd;
}

function validLane(value: string): boolean {
	if (value.length < 1 || value.length > 64) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		if (!alphanumeric && (index === 0 || (code !== 45 && code !== 46 && code !== 95))) return false;
	}
	return true;
}

function validJob(value: unknown): value is HeavyJob {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return "id" in value && typeof value.id === "string" && "pid" in value && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
		"process_start" in value && typeof value.process_start === "string" && normalizeStart(value.process_start) !== "" && "label" in value && typeof value.label === "string" &&
		"repo" in value && typeof value.repo === "string" && "cwd" in value && typeof value.cwd === "string" &&
		"agent" in value && typeof value.agent === "string" && "tmux_pane" in value && typeof value.tmux_pane === "string" &&
		(!("lane" in value) || (typeof value.lane === "string" && validLane(value.lane))) &&
		"state" in value && (value.state === "queued" || value.state === "running") && "argv" in value && Array.isArray(value.argv) &&
		value.argv.every((item: unknown) => typeof item === "string") && "queued_at" in value && typeof value.queued_at === "string";
}

async function readJobs(directory: string): Promise<HeavyJob[]> {
	const jobs: HeavyJob[] = [];
	for (const name of readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
		const path = join(directory, name);
		let value: unknown;
		try { value = JSON.parse(readFileSync(path, "utf8")); }
		catch (error) { throw new Error(`cannot read heavy-work ledger ${name}: ${error instanceof Error ? error.message : String(error)}`); }
		if (!validJob(value)) throw new Error(`invalid heavy-work ledger ${name}; refusing admission`);
		// Reclaimable only when kitlib proc proves the incarnation dead, reused or a zombie; unknown is kept.
		if (isDead(await probeIncarnation({ pid: value.pid, start: value.process_start }))) {
			unlinkSync(path);
			continue;
		}
		jobs.push(value);
	}
	return jobs;
}

function readLockOwner(path: string): { pid: number; process_start: string } | null {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value) || !("pid" in value) || !("process_start" in value)) return null;
		return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && typeof value.process_start === "string" && normalizeStart(value.process_start) !== ""
			? { pid: value.pid, process_start: value.process_start }
			: null;
	} catch { return null; }
}

async function reclaimStaleLock(path: string): Promise<boolean> {
	const ownerPath = join(path, "owner.json");
	const before = readLockOwner(ownerPath);
	if (!before) return false;
	if (!isDead(await probeIncarnation({ pid: before.pid, start: before.process_start }))) return false;
	const current = readLockOwner(ownerPath);
	if (!current || current.pid !== before.pid || normalizeStart(current.process_start) !== normalizeStart(before.process_start)) return false;
	try { unlinkSync(ownerPath); rmdirSync(path); return true; }
	catch { return false; }
}

async function acquireLock(path: string, owner: { pid: number; process_start: string }, deadline: number, noWait: boolean): Promise<boolean> {
	while (true) {
		try {
			mkdirSync(path, { mode: 0o700 });
			atomicReplaceBytes(join(path, "owner.json"), Buffer.from(`${JSON.stringify(owner)}\n`), { mode: 0o600, durability: "none" });
			return true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			if (await reclaimStaleLock(path)) continue;
			if (noWait || Date.now() >= deadline) return false;
			await Bun.sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
		}
	}
}

function releaseLock(path: string, owner: { pid: number; process_start: string }): void {
	const ownerPath = join(path, "owner.json");
	const current = readLockOwner(ownerPath);
	if (!current || current.pid !== owner.pid || normalizeStart(current.process_start) !== normalizeStart(owner.process_start)) return;
	try { unlinkSync(ownerPath); rmdirSync(path); } catch { /* A stale lock is reclaimed by the next bounded admission attempt. */ }
}

function writeJob(directory: string, job: HeavyJob): void {
	atomicReplaceBytes(join(directory, `${job.id}.json`), Buffer.from(`${JSON.stringify(job)}\n`), { mode: 0o600, durability: "none" });
}

function removeJob(directory: string, id: string): void {
	try { unlinkSync(join(directory, `${id}.json`)); }
	catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}


function laneCapacity(config: HeavyConfig, lane: string): number {
	const slots = config.lane_slots;
	return slots && Object.hasOwn(slots, lane) ? slots[lane] ?? 1 : 1;
}

function laneHolders(running: readonly HeavyJob[], lane: string): HeavyJob[] {
	return running.filter((job) => job.lane === lane);
}

function holderDescription(job: HeavyJob): string {
	const age = job.started_at ? `${Math.max(0, (Date.now() - Date.parse(job.started_at)) / 1000).toFixed(1)}s` : "unknown";
	return `${job.label}@${job.repo}[${job.agent}; pane=${job.tmux_pane || "none"}; pid=${job.pid}; held=${age}]`;
}

function admissionReason(jobs: readonly HeavyJob[], id: string, config: HeavyConfig, load: MachineLoad): string | null {
	const loadReason = process.env.GITHUB_ACTIONS === "true" ? null : machineLoadBlockReason(load.load1, load.ncpu);
	if (loadReason) return loadReason;
	const running = jobs.filter((job) => job.state === "running");
	const own = jobs.find((job) => job.id === id);
	if (own?.lane) {
		const holders = laneHolders(running, own.lane);
		const slots = laneCapacity(config, own.lane);
		if (holders.length >= slots) return `lane ${own.lane}: all ${slots} slot${slots === 1 ? " is" : "s are"} occupied; holders=${holders.map(holderDescription).join(", ")}`;
	}
	if (running.length >= config.slots) return `all ${config.slots} heavy-work slot${config.slots === 1 ? " is" : "s are"} occupied`;
	const queued = jobs.filter((job) => job.state === "queued").sort((left, right) => left.queued_at.localeCompare(right.queued_at) || left.id.localeCompare(right.id));
	// A full lane must not strand other lanes (or unlaned work) behind its queue head.
	const eligible = queued.find((job) =>
		(!job.tmux_pane || !running.some((active) => active.tmux_pane === job.tmux_pane)) &&
		(!job.lane || laneHolders(running, job.lane).length < laneCapacity(config, job.lane)));
	if (eligible?.id === id) return null;
	const paneJob = own?.tmux_pane ? running.find((job) => job.tmux_pane === own.tmux_pane) : undefined;
	if (paneJob) return `pane already has running job ${paneJob.label} (${paneJob.repo})`;
	return eligible ? `queued behind ${eligible.label} (${eligible.repo})` : "waiting for an available slot";
}

function statusLine(jobs: readonly HeavyJob[], id: string, reason: string): string {
	const active = jobs.filter((job) => job.state === "running");
	const running = active.length ? active.map((job) => `${job.label}@${job.repo}[${job.agent}; pane=${job.tmux_pane || "none"}]`).join(", ") : "none";
	const queued = jobs.filter((job) => job.state === "queued").sort((left, right) => left.queued_at.localeCompare(right.queued_at) || left.id.localeCompare(right.id));
	const position = queued.findIndex((job) => job.id === id) + 1;
	return `heavy: queue position ${position}; running=${running}; waiting: ${reason}`;
}


export async function runHeavy(command: readonly string[], options: { label?: string; lane?: string; noWait: boolean; diskObserver?: string; maxRuntime?: string }): Promise<number> {
	if (command.length === 0 || !command[0]) {
		process.stderr.write("heavy: expected `omp-kit heavy [--label LABEL] [--lane NAME] [--no-wait] [--max-runtime SECONDS] [--disk-observer statfs|sbh|auto] -- <command...>`\n");
		return 2;
	}
	if (options.lane !== undefined && !validLane(options.lane)) {
		process.stderr.write("heavy: --lane must be 1..64 ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit; no command was run\n");
		return 2;
	}
	const flagRuntime = options.maxRuntime === undefined ? undefined : Number(options.maxRuntime);
	if (flagRuntime !== undefined && (!Number.isSafeInteger(flagRuntime) || flagRuntime <= 0)) {
		process.stderr.write("heavy: --max-runtime must be positive integer seconds; no command was run\n");
		return 2;
	}
	const envObserver = process.env.OMP_KIT_DISK_OBSERVER;
	const envOverride = envObserver === undefined || envObserver === "" ? undefined : envObserver;
	// SAVEFIRST1 (ompkit-774u.16): OMP_KIT_DISK_OBSERVER is the ambient form of
	// --disk-observer for callers that cannot take a flag (ladder.sh heavy calls
	// nested inside a save). Precedence: flag, then env, then load.json. An invalid
	// env value refuses loudly (exit 2), never silently changes admission.
	const override = options.diskObserver ?? envOverride;
	if (override !== undefined && !DISK_OBSERVERS.includes(override as DiskObserver)) {
		const source = options.diskObserver !== undefined ? "--disk-observer" : "OMP_KIT_DISK_OBSERVER";
		process.stderr.write(`heavy: ${source} must be "statfs", "sbh" or "auto", got "${override}"; no command was run\n`);
		return 2;
	}
	// RELFAILFAST1 (ompkit-fp72.120.16.104, Joshua J-2026-11-03-34): OMP_KIT_HEAVY_MAX_WAIT_S caps the queue wait for a
	// caller whose own budget is shorter than the default. The release's packaged ladder had a 900 s test budget against
	// the 900 s default queue wait, so a held queue surfaced only as that test's timeout. It only lowers the wait; a value
	// that is not 0-9999 whole seconds refuses loudly (exit 2), never silently changes admission.
	const envMaxWait = process.env.OMP_KIT_HEAVY_MAX_WAIT_S;
	let waitCapS: number | null = null;
	if (envMaxWait !== undefined && envMaxWait !== "") {
		if (!/^[0-9]{1,4}$/.test(envMaxWait)) {
			process.stderr.write(`heavy: OMP_KIT_HEAVY_MAX_WAIT_S must be whole seconds 0..9999, got "${envMaxWait}"; no command was run\n`);
			return 2;
		}
		waitCapS = Number(envMaxWait);
	}
	const cwd = process.cwd();
	const id = randomUUID();
	const label = options.label || basename(command[0] ?? "heavy");
	const stateRoot = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-kit", "load");
	// A caller-selected statfs observer makes the physical 10 GiB verdict
	// authoritative; the later check still refuses low or unavailable capacity.
	const stageStarted = performance.now();
	const staged = admitDiskWork("heavy", cwd, { allowLowPercentForStatfs: override === "statfs" });
	if (!staged.allowed) {
		await recordObserverRefusal(stateRoot, { id, label }, "disk-stage", {
			kind: staged.code === "DISK_OBSERVER_UNAVAILABLE" ? "unavailable" : "pressure",
			observer: "statfs", text: staged.code, timing: observerTiming(stageStarted, "statfs"),
		});
		process.stdout.write(`${staged.code}\n`);
		return staged.code === "DISK_OBSERVER_UNAVAILABLE" ? HEAVY_PREREQ_MISSING : 10;
	}
	const observerOverride = override as DiskObserver | undefined;
	let config: HeavyConfig;
	let storage: { jobs: string; lock: string };
	try {
		config = loadConfig(observerOverride);
		storage = ensureStorage(stateRoot);
	} catch (error) {
		process.stderr.write(`heavy: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const ownStart = (await incarnation(process.pid))?.start;
	if (!ownStart) {
		process.stderr.write("heavy: cannot establish this process start identity; no command was run\n");
		return 2;
	}
	const owner = { pid: process.pid, process_start: ownStart };
	const argv = [...command];
	const queuedAt = new Date().toISOString();
	const job: HeavyJob = {
		id, pid: process.pid, process_start: ownStart, label,
		repo: currentRepo(cwd), cwd, agent: process.env.AGENT_NAME ?? process.env.OMP_AGENT_NAME ?? "unknown",
		tmux_pane: process.env.TMUX_PANE ?? "", argv, state: "queued", queued_at: queuedAt,
		...(options.lane !== undefined ? { lane: options.lane } : {}),
	};
	const declared = Object.hasOwn(labelBudgets, job.label) ? labelBudgets[job.label as keyof typeof labelBudgets] : undefined;
	const configured = Object.hasOwn(config.runtime_budget_s ?? {}, job.label) ? config.runtime_budget_s?.[job.label] : undefined;
	const runtimeSeconds = flagRuntime ?? configured ?? declared?.seconds;
	const runtimeSource = flagRuntime !== undefined ? "flag --max-runtime" :
		configured !== undefined ? `label table load.json runtime_budget_s.${job.label}` :
		declared ? `label table config/heavy-labels.json (${declared.source})` : "none";
	// HEAVYCI1: a missing observer fails now, before queueing or waiting on the
	// state mutex, whatever load and slots say. This reading only decides that;
	// admission below observes the disk again inside the mutex, because a
	// reading taken before a lock wait can be stale (QuietBadger AM57798).
	const precheck = await diskVerdict({ config, cwd });
	if (precheck.kind !== "ok") await recordObserverRefusal(stateRoot, job, "precheck", precheck);
	if (precheck.kind === "unavailable" || precheck.kind === "timeout") return refuseObserver(precheck);
	// SAVEFIRST1: explicit statfs pressure is the physical floor, not retryable queue contention.
	if (precheck.kind === "pressure" && observerOverride === "statfs") {
		process.stderr.write(`heavy: REFUSED reason=DISK_BELOW_FLOOR need=${HEAVY_DISK_NEED} need_bytes=${HEAVY_DISK_NEED_BYTES} observer=statfs path=${cwd}: ${precheck.text}; free at least 10 GiB and retry; no command was run\n`);
		return 1;
	}

	const deadline = Date.now() + (waitCapS === null ? config.max_wait_s : Math.min(config.max_wait_s, waitCapS)) * 1000;
	let nextStatus = 0;
	let signal: HeavySignal | null = null;
	let child: HeavyChild | undefined;
	let childStartedAt = 0;
	let rowCreated = false;
	const onSignal = (name: HeavySignal) => {
		signal = name;
		if (child) {
			try { child.kill(name); } catch { /* The child may have exited between the event and kill. */ }
		}
	};
	const onInterrupt = () => onSignal("SIGINT");
	const onTerminate = () => onSignal("SIGTERM");
	process.on("SIGINT", onInterrupt);
	process.on("SIGTERM", onTerminate);
	try {
		while (true) {
			if (rowCreated && Date.now() >= deadline) {
				await removeQueuedJob(storage, job.id, owner);
				process.stderr.write("RESOURCE_DEFERRED: queue timeout\n");
				process.stderr.write("deferred: queue timeout\n");
				return 75;
			}
			if (signal) {
				if (rowCreated) await removeQueuedJob(storage, job.id, owner);
				return SIGNAL_EXIT_CODES[signal] ?? 1;
			}
			if (rowCreated) {
				// A waiting job re-reads the disk settings each poll, so a config change reaches it before
				// its deadline (2026-10-18: one stale job held the queue head for 900 s). Slots and the
				// wait deadline stay as first read.
				const fresh = loadConfig(observerOverride);
				config = { ...config, disk_observer: fresh.disk_observer, disk_floor_pct: fresh.disk_floor_pct, sbh_deadline_s: fresh.sbh_deadline_s };
			}
			const acquired = await acquireLock(storage.lock, owner, deadline, options.noWait);
			if (!acquired) {
				const reason = options.noWait ? "state lock is busy" : "timed out waiting for the state lock";
				process.stderr.write(`RESOURCE_DEFERRED: ${reason}\n`);
				process.stderr.write(`deferred: ${reason}\n`);
				return 75;
			}
			let waitingJobs: HeavyJob[] = [];
			let reason: string | null = null;
			let observerFailure: Extract<DiskVerdict, { kind: "unavailable" | "timeout" }> | null = null;
			try {
				waitingJobs = await readJobs(storage.jobs);
				if (!waitingJobs.some((entry) => entry.id === id)) {
					writeJob(storage.jobs, job);
					rowCreated = true;
					waitingJobs = [...waitingJobs, job];
				}
				reason = admissionReason(waitingJobs, id, config, { load1: testFakeLoad() ?? loadavg()[0] ?? Number.NaN, ncpu: cpus().length });
				if (!reason) {
					const disk = await diskVerdict({ config, cwd: job.cwd });
					if (disk.kind !== "ok") await recordObserverRefusal(stateRoot, job, "admission", disk);
					if (disk.kind === "unavailable" || disk.kind === "timeout") {
						removeJob(storage.jobs, id);
						rowCreated = false;
						observerFailure = disk;
					} else if (disk.kind === "pressure") reason = disk.text;
				}
				// This deadline covers admission only; runtime starts when the child does.
				if (!reason && observerFailure === null && Date.now() >= deadline) {
					reason = "admission deadline expired before child start";
				}
				if (!reason && observerFailure === null) {
					const running: HeavyJob = { ...job, state: "running", started_at: new Date().toISOString() };
					writeJob(storage.jobs, running);
					rowCreated = true;
					childStartedAt = Date.now();
					child = Bun.spawn(["nice", "-n", "10", ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
					// Synchronous on purpose: an await here let a SIGINT kill the child mid-probe, so the probe found no
					// process and heavy exited 1 ("cannot establish ... identity") instead of 130 with the slot released.
					const childStart = incarnationSync(child.pid)?.start;
					if (!childStart) {
						child.kill("SIGTERM");
						await child.exited;
						removeJob(storage.jobs, id);
						rowCreated = false;
						throw new Error("cannot establish child process start identity; command was stopped");
					}
					writeJob(storage.jobs, { ...running, pid: child.pid, process_start: childStart });
				}
			} finally {
				releaseLock(storage.lock, owner);
			}
			if (observerFailure !== null) return refuseObserver(observerFailure);
			if (child) {
				let timer: NodeJS.Timeout | undefined;
				const timeout = Promise.withResolvers<"deadline">();
				const checkRuntime = () => {
					if (runtimeSeconds === undefined) return;
					const remaining = runtimeSeconds * 1000 - (Date.now() - childStartedAt);
					if (remaining <= 0) timeout.resolve("deadline");
					// Native timers overflow above 2^31-1 ms; long declared budgets stay bounded.
					else timer = setTimeout(checkRuntime, Math.min(remaining, 2_147_483_647));
				};
				checkRuntime();
				const result = await Promise.race([child.exited, timeout.promise]);
				clearTimeout(timer);
				if (result === "deadline") {
					try { child.kill("SIGTERM"); } catch { /* child may have exited at the boundary */ }
					const grace = Promise.withResolvers<false>();
					const graceTimer = setTimeout(() => grace.resolve(false), 10_000);
					try {
						const stopped = await Promise.race([
							child.exited.then(() => true),
							grace.promise,
						]);
						if (!stopped) {
							try { child.kill("SIGKILL"); } catch { /* child may have exited at the boundary */ }
							await child.exited;
						}
					} finally {
						clearTimeout(graceTimer);
					}
					await removeQueuedJob(storage, id, owner);
					process.stderr.write(`RUNTIME_BUDGET_EXCEEDED: child ran ${((Date.now() - childStartedAt) / 1000).toFixed(2)}s > --max-runtime ${runtimeSeconds}s (label ${job.label}); source=${runtimeSource}; override with --max-runtime\n`);
					return 124;
				}
				await removeQueuedJob(storage, id, owner);
				return signal ? SIGNAL_EXIT_CODES[signal] : result;
			}
			if (options.noWait || Date.now() >= deadline) {
				await removeQueuedJob(storage, id, owner);
				process.stderr.write(`RESOURCE_DEFERRED: ${reason ?? "admission unavailable"}${options.noWait ? " (--no-wait)" : " (queue timeout)"}\n`);
				process.stderr.write(`deferred: ${reason ?? "admission unavailable"}${options.noWait ? " (--no-wait)" : " (queue timeout)"}\n`);
				return 75;
			}
			const now = Date.now();
			if (now >= nextStatus) {
				process.stderr.write(`${statusLine(waitingJobs, id, reason ?? "waiting for admission")}\n`);
				nextStatus = now + STATUS_INTERVAL_MS;
			}
			await Bun.sleep(Math.min(QUEUE_POLL_MS, Math.max(1, deadline - Date.now())));
		}
	} catch (error) {
		if (rowCreated) await removeQueuedJob(storage, id, owner);
		process.stderr.write(`heavy: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}
}

async function removeQueuedJob(storage: { jobs: string; lock: string }, id: string, owner: { pid: number; process_start: string }): Promise<void> {
	const deadline = Date.now() + 5_000;
	if (!await acquireLock(storage.lock, owner, deadline, false)) return;
	try { removeJob(storage.jobs, id); }
	finally { releaseLock(storage.lock, owner); }
}
