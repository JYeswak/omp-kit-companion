import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, cpus, loadavg } from "node:os";
import { basename, join } from "node:path";
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
type HeavyConfig = { slots: number; max_wait_s: number };
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
		if (errorCode(error) === "ENOENT") return { slots: 2, max_wait_s: MAX_WAIT_SECONDS };
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid heavy-work config: ${path}`);
	const slots = "slots" in value ? value.slots : 2;
	const maxWait = "max_wait_s" in value ? value.max_wait_s : MAX_WAIT_SECONDS;
	if (typeof slots !== "number" || !Number.isInteger(slots) || slots < 1 || slots > 64 ||
		typeof maxWait !== "number" || !Number.isFinite(maxWait) || maxWait < 0 || maxWait > MAX_WAIT_SECONDS)
		throw new Error(`invalid heavy-work config: slots must be 1..64 and max_wait_s must be 0..${MAX_WAIT_SECONDS}`);
	return { slots, max_wait_s: maxWait };
}

export function machineLoadBlockReason(load1: number, ncpu: number): string | null {
	if (!Number.isFinite(load1) || !Number.isFinite(ncpu) || ncpu < 1) return "machine load unavailable";
	const threshold = ncpu * LOAD_PER_CORE_LIMIT;
	return load1 > threshold ? `LOAD1 ${load1.toFixed(2)} exceeds ${threshold.toFixed(2)} (${ncpu} cores × ${LOAD_PER_CORE_LIMIT})` : null;
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
	const loadReason = machineLoadBlockReason(load.load1, load.ncpu);
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
			try {
				waitingJobs = readJobs(storage.jobs, liveness);
				if (!waitingJobs.some((entry) => entry.id === id)) {
					writeJob(storage.jobs, job);
					rowCreated = true;
					waitingJobs = [...waitingJobs, job];
				}
				reason = admissionReason(waitingJobs, id, config.slots, { load1: loadavg()[0] ?? Number.NaN, ncpu: cpus().length });
				if (!reason) {
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
