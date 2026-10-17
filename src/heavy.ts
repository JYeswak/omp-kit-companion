import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, cpus, loadavg } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import process from "node:process";
import { inspectStateRoot } from "./state-root.ts";
import { defaultLiveness, probeOwner, type LivenessDeps } from "./scratch.ts";
import type { LoadJob } from "./load-doctor.ts";

const LOAD_PER_CORE_LIMIT = 2.5;
const STATUS_INTERVAL_MS = 30_000;
const LOCK_POLL_MS = 100;
const QUEUE_POLL_MS = 1_000;
const MAX_WAIT_SECONDS = 900;

type HeavyJob = LoadJob & { argv: string[]; process_start: string; queued_at: string; started_at?: string };
type DiskObserver = "sbh" | "statfs" | "auto";
type HeavyConfig = { slots: number; max_wait_s: number; disk_observer: DiskObserver; disk_floor_pct: number | null };
type MachineLoad = { load1: number; ncpu: number };
type HeavySignal = "SIGINT" | "SIGTERM";
type HeavyChild = { exited: Promise<number>; kill(signal: HeavySignal): void };
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

function loadConfig(): HeavyConfig {
	const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "omp-kit", "load.json");
	let raw: string;
	try { raw = readFileSync(path, "utf8"); }
	catch (error) {
		if (errorCode(error) === "ENOENT") return { slots: 2, max_wait_s: MAX_WAIT_SECONDS, disk_observer: "auto", disk_floor_pct: null };
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	const slots = "slots" in value ? value.slots : 2;
	const maxWait = "max_wait_s" in value ? value.max_wait_s : MAX_WAIT_SECONDS;
	const observer: unknown = "disk_observer" in value ? value.disk_observer : "auto";
	const floor: unknown = "disk_floor_pct" in value ? value.disk_floor_pct : null;
	if (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 || slots > 64 ||
		typeof maxWait !== "number" || !Number.isFinite(maxWait) || maxWait < 0 || maxWait > MAX_WAIT_SECONDS)
		throw new Error(`invalid heavy-work config: slots must be 1..64 and max_wait_s must be 0..${MAX_WAIT_SECONDS}`);
	if (observer !== "sbh" && observer !== "statfs" && observer !== "auto")
		throw new Error(`invalid heavy-work config: disk_observer must be "sbh", "statfs" or "auto": ${path}`);
	if (floor !== null && (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0 || floor > 50))
		throw new Error(`invalid heavy-work config: disk_floor_pct must be 0..50: ${path}`);
	return { slots, max_wait_s: maxWait, disk_observer: observer, disk_floor_pct: floor };
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
export type DiskVerdict = { kind: "ok"; observer: DiskObserver } | { kind: "pressure"; text: string; observer: DiskObserver } | { kind: "unavailable"; text: string; observer: DiskObserver };
async function sbhVerdict(sbhBin = "sbh"): Promise<DiskVerdict> {
	let code: number;
	try {
		const proc = Bun.spawn([sbhBin, "check", "--need", HEAVY_DISK_NEED], { stdout: "ignore", stderr: "ignore" });
		code = await proc.exited;
	} catch {
		return { kind: "unavailable", text: "sbh binary not runnable", observer: "sbh" };
	}
	if (code === 0) return { kind: "ok", observer: "sbh" };
	if (code === 1) return { kind: "pressure", text: `disk low: sbh check --need ${HEAVY_DISK_NEED} reports pressure`, observer: "sbh" };
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
export async function diskVerdict(input?: { config?: HeavyConfig; cwd?: string; sbhBin?: string }): Promise<DiskVerdict> {
	const observer = input?.config?.disk_observer ?? "auto";
	const floor = input?.config?.disk_floor_pct ?? null;
	const cwd = input?.cwd ?? process.cwd();
	const sbhBin = input?.sbhBin ?? "sbh";
	if (observer === "sbh") return sbhVerdict(sbhBin);
	if (observer === "statfs") return decideDiskPressure(statfsCapacity(cwd), floor);
	if (sbhResolvable()) {
		const verdict = await sbhVerdict(sbhBin);
		if (verdict.kind === "unavailable")
			return { kind: "unavailable", text: `${verdict.text} (set disk_observer to "statfs" for OS-native admission)`, observer: "sbh" };
		return verdict;
	}
	return decideDiskPressure(statfsCapacity(cwd), floor);
}
function prerequisiteMissing(observer: "sbh" | "statfs", text: string): number {
	process.stderr.write(`heavy: ${observer} unavailable: ${text}; disk admission requires ${observer === "sbh" ? "sbh" : "an observer"}; no command was run\n`);
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

function writeJsonAtomic(path: string, value: unknown): void {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
	renameSync(temporary, path);
}

function validJob(value: unknown): value is HeavyJob {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return "id" in value && typeof value.id === "string" && "pid" in value && typeof value.pid === "number" && Number.isInteger(value.pid) &&
		"process_start" in value && typeof value.process_start === "string" && "label" in value && typeof value.label === "string" &&
		"repo" in value && typeof value.repo === "string" && "cwd" in value && typeof value.cwd === "string" &&
		"agent" in value && typeof value.agent === "string" && "tmux_pane" in value && typeof value.tmux_pane === "string" &&
		"state" in value && (value.state === "queued" || value.state === "running") && "argv" in value && Array.isArray(value.argv) &&
		value.argv.every((item: unknown) => typeof item === "string") && "queued_at" in value && typeof value.queued_at === "string";
}

function readJobs(directory: string, liveness: LivenessDeps): HeavyJob[] {
	const jobs: HeavyJob[] = [];
	for (const name of readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
		const path = join(directory, name);
		let value: unknown;
		try { value = JSON.parse(readFileSync(path, "utf8")); }
		catch (error) { throw new Error(`cannot read heavy-work ledger ${name}: ${error instanceof Error ? error.message : String(error)}`); }
		if (!validJob(value)) throw new Error(`invalid heavy-work ledger ${name}; refusing admission`);
		const owner = probeOwner(value.pid, value.process_start, liveness);
		if (owner === "dead" || owner === "reused") {
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
		return typeof value.pid === "number" && Number.isInteger(value.pid) && typeof value.process_start === "string"
			? { pid: value.pid, process_start: value.process_start }
			: null;
	} catch { return null; }
}

function reclaimStaleLock(path: string, liveness: LivenessDeps): boolean {
	const ownerPath = join(path, "owner.json");
	const before = readLockOwner(ownerPath);
	if (!before) return false;
	const state = probeOwner(before.pid, before.process_start, liveness);
	if (state !== "dead" && state !== "reused") return false;
	const current = readLockOwner(ownerPath);
	if (!current || current.pid !== before.pid || current.process_start !== before.process_start) return false;
	try { unlinkSync(ownerPath); rmdirSync(path); return true; }
	catch { return false; }
}

async function acquireLock(path: string, owner: { pid: number; process_start: string }, deadline: number, noWait: boolean, liveness: LivenessDeps): Promise<boolean> {
	while (true) {
		try {
			mkdirSync(path, { mode: 0o700 });
			writeJsonAtomic(join(path, "owner.json"), owner);
			return true;
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
			if (reclaimStaleLock(path, liveness)) continue;
			if (noWait || Date.now() >= deadline) return false;
			await Bun.sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
		}
	}
}

function releaseLock(path: string, owner: { pid: number; process_start: string }): void {
	const ownerPath = join(path, "owner.json");
	const current = readLockOwner(ownerPath);
	if (!current || current.pid !== owner.pid || current.process_start !== owner.process_start) return;
	try { unlinkSync(ownerPath); rmdirSync(path); } catch { /* A stale lock is reclaimed by the next bounded admission attempt. */ }
}

function writeJob(directory: string, job: HeavyJob): void {
	writeJsonAtomic(join(directory, `${job.id}.json`), job);
}

function removeJob(directory: string, id: string): void {
	try { unlinkSync(join(directory, `${id}.json`)); }
	catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
}


function admissionReason(jobs: readonly HeavyJob[], id: string, slots: number, load: MachineLoad): string | null {
	const loadReason = process.env.GITHUB_ACTIONS === "true" ? null : machineLoadBlockReason(load.load1, load.ncpu);
	if (loadReason) return loadReason;
	const running = jobs.filter((job) => job.state === "running");
	if (running.length >= slots) return `all ${slots} heavy-work slot${slots === 1 ? " is" : "s are"} occupied`;
	const queued = jobs.filter((job) => job.state === "queued").sort((left, right) => left.queued_at.localeCompare(right.queued_at) || left.id.localeCompare(right.id));
	const eligible = queued.find((job) => !job.tmux_pane || !running.some((active) => active.tmux_pane === job.tmux_pane));
	if (eligible?.id === id) return null;
	const own = jobs.find((job) => job.id === id);
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


export async function runHeavy(command: readonly string[], options: { label?: string; noWait: boolean }): Promise<number> {
	if (command.length === 0 || !command[0]) {
		process.stderr.write("heavy: expected `omp-kit heavy [--label LABEL] [--no-wait] -- <command...>`\n");
		return 2;
	}
	let config: HeavyConfig;
	let storage: { jobs: string; lock: string };
	try {
		config = loadConfig();
		storage = ensureStorage(join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "omp-kit", "load"));
	} catch (error) {
		process.stderr.write(`heavy: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	const liveness = defaultLiveness();
	const ownStart = liveness.processStart(process.pid);
	if (!ownStart) {
		process.stderr.write("heavy: cannot establish this process start identity; no command was run\n");
		return 2;
	}
	const owner = { pid: process.pid, process_start: ownStart };
	const cwd = process.cwd();
	const id = randomUUID();
	const argv = [...command];
	const queuedAt = new Date().toISOString();
	const job: HeavyJob = {
		id, pid: process.pid, process_start: ownStart, label: options.label || basename(command[0] ?? "heavy"),
		repo: currentRepo(cwd), cwd, agent: process.env.AGENT_NAME ?? process.env.OMP_AGENT_NAME ?? "unknown",
		tmux_pane: process.env.TMUX_PANE ?? "", argv, state: "queued", queued_at: queuedAt,
	};
	// HEAVYCI1: a missing observer fails now, before queueing or waiting on the
	// state mutex, whatever load and slots say. This reading only decides that;
	// admission below observes the disk again inside the mutex, because a
	// reading taken before a lock wait can be stale (QuietBadger AM57798).
	const precheck = await diskVerdict({ config, cwd });
	if (precheck.kind === "unavailable") return prerequisiteMissing(precheck.observer, precheck.text);
	const deadline = Date.now() + config.max_wait_s * 1000;
	let nextStatus = 0;
	let signal: HeavySignal | null = null;
	let child: HeavyChild | undefined;
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
				await removeQueuedJob(storage, job.id, owner, liveness);
				process.stderr.write("deferred: queue timeout\n");
				return 75;
			}
			if (signal) {
				if (rowCreated) await removeQueuedJob(storage, job.id, owner, liveness);
				return SIGNAL_EXIT_CODES[signal] ?? 1;
			}
			const acquired = await acquireLock(storage.lock, owner, deadline, options.noWait, liveness);
			if (!acquired) {
				const reason = options.noWait ? "state lock is busy" : "timed out waiting for the state lock";
				process.stderr.write(`deferred: ${reason}\n`);
				return 75;
			}
			let waitingJobs: HeavyJob[] = [];
			let reason: string | null = null;
			let missing: { observer: "sbh" | "statfs"; text: string } | null = null;
			try {
				waitingJobs = readJobs(storage.jobs, liveness);
				if (!waitingJobs.some((entry) => entry.id === id)) {
					writeJob(storage.jobs, job);
					rowCreated = true;
					waitingJobs = [...waitingJobs, job];
				}
				reason = admissionReason(waitingJobs, id, config.slots, { load1: testFakeLoad() ?? loadavg()[0] ?? Number.NaN, ncpu: cpus().length });
				if (!reason) {
					const disk = await diskVerdict({ config, cwd: job.cwd });
					if (disk.kind === "unavailable") {
						removeJob(storage.jobs, id);
						rowCreated = false;
						missing = disk;
					} else if (disk.kind === "pressure") reason = disk.text;
				}
				if (!reason && missing === null) {
					const running: HeavyJob = { ...job, state: "running", started_at: new Date().toISOString() };
					writeJob(storage.jobs, running);
					rowCreated = true;
					child = Bun.spawn(["nice", "-n", "10", ...argv], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
					const childStart = liveness.processStart(child.pid);
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
			if (missing !== null) return prerequisiteMissing(missing.observer, missing.text);
			if (child) {
				const code = await child.exited;
				await removeQueuedJob(storage, id, owner, liveness);
				return signal ? SIGNAL_EXIT_CODES[signal] : code;
			}
			if (options.noWait || Date.now() >= deadline) {
				await removeQueuedJob(storage, id, owner, liveness);
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
		if (rowCreated) await removeQueuedJob(storage, id, owner, liveness);
		process.stderr.write(`heavy: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	} finally {
		process.off("SIGINT", onInterrupt);
		process.off("SIGTERM", onTerminate);
	}
}

async function removeQueuedJob(storage: { jobs: string; lock: string }, id: string, owner: { pid: number; process_start: string }, liveness: LivenessDeps): Promise<void> {
	const deadline = Date.now() + 5_000;
	if (!await acquireLock(storage.lock, owner, deadline, false, liveness)) return;
	try { removeJob(storage.jobs, id); }
	finally { releaseLock(storage.lock, owner); }
}
