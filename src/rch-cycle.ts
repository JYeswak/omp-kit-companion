import { bunCapExec, type SpawnHandle } from "./service-run.ts";

const CONTROL_TIMEOUT_MS = 30_000;
const GC_TIMEOUT_MS = 960_000; // Native GC's 900 s per-worker bound, plus shutdown time; one worker only.
const BUILD_IDLE_TIMEOUT_MS = 1_800_000; // Existing fleet no-progress bound; output rearms it.
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const NATIVE_SAFETY = ["--no-self-healing", "--no-hook-auto-start"] as const;
// A dead owner must also have stopped heartbeating this long ago, so a wrapper whose journal row was published moments ago is never reaped on one racy liveness read.
const DEAD_LEASE_STALE_MS = 900_000;

export interface NativeRchResult {
	exit: number | null;
	state: "exited" | "cancelled" | "timeout" | "spawn-failed" | "output-limit";
	stdout: string;
}
export interface OwnedRchBuild {
	pid: number | null;
	alive(): boolean;
	result: Promise<NativeRchResult>;
}
export interface RchExecutor {
	capture(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<NativeRchResult>;
	build(args: readonly string[], signal?: AbortSignal): OwnedRchBuild;
}
export interface RchWorker {
	id: string;
	status: string;
	fresh: boolean;
	confidence: string;
	pressure: string;
	total: number;
	used: number;
	free: number;
	buildDiskFreeGb: number | null;
	/** Native `pressure_memory_pressure` (rch 2.1.34 `status --json`); null when the daemon omits it. */
	memoryPressure: number | null;
}
export interface RchStatus {
	workers: RchWorker[];
	active: number;
	queued: number;
}
export interface RchCycleInput {
	worker?: string;
	requiredSlots: number;
	command: readonly string[];
	/** Native exec options only; worker selection and command separation belong to this controller. */
	nativeOptions?: readonly string[];
	apply: boolean;
	signal?: AbortSignal;
}
/** A journaled lease whose holder is provably gone: native liveness says absent and the lease neither heartbeats nor retires. */
export interface DeadLease {
	wrapperId: string;
	worker: string;
	pid: number;
	state: string;
	phase: string | null;
	/** `stale_heartbeat`: no heartbeat within the stale bound. `pid_birth_mismatch`: a live wrapper now holds this pid with a different process start time (pid reuse). */
	basis: "stale_heartbeat" | "pid_birth_mismatch";
}
export interface DeadLeaseReport extends DeadLease {
	/** Always `unreapable`: the installed native `rch jobs` verbs (attach, cancel, recover) cannot retire a dead-owner lease, so none is attempted. */
	outcome: "unreapable";
	/** Names the missing native capability. */
	reason: string;
}
export interface DeadLeaseScope {
	now: number;
	/** Only leases on this worker are candidates. */
	worker?: string;
	excludePids?: readonly number[];
	excludeWrapperIds?: readonly string[];
	staleMs?: number;
}
export interface RchCycleResult {
	overall: "PLAN" | "REFUSED" | "COMPLETE" | "BUILD_FAILED" | "CANCELLED" | "UNREADY";
	reason: string;
	worker: string | null;
	nativeExit: number | null;
	executionObserved: boolean | null;
	compilerExit: number | null;
	/** Native wrapper lifetime state; compilerExit requires separate native remote-result evidence. */
	compilerState: NativeRchResult["state"] | "not-submitted";
	cleanup: "not-run" | "complete" | "failed" | "unknown";
	nextAgentReady: boolean | null;
	before: RchStatus | null;
	after: RchStatus | null;
	wrapperId: string | null;
	/** Dead-owner leases on the selected worker; null when the native journal could not be read or no worker was in scope. */
	deadLeases: DeadLeaseReport[] | null;
	lease: string;
	noClaim: string;
}

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function jsonResult(result: NativeRchResult): unknown {
	if (result.state !== "exited" || result.exit !== 0) return null;
	try { return JSON.parse(result.stdout); } catch { return null; }
}

/** Kit admission policy on the native memory-pressure number (observed ~5-6 on idle healthy
workers 2026-10-19; native units/threshold undocumented, read as percent-used: contabo-4 died at
100% memory in the ompkit-774u.6.1 incident). A worker at or above this refuses new builds.
Re-verify against `rch status --json` under load; upstream free-bytes telemetry plus per-build
peak history (ompkit-z7zj follow-up) would replace this heuristic with an exact fit check. */
export const MEMORY_PRESSURE_REFUSE = 90;
/** Decode the installed status envelope. Absent freshness is unknown, never healthy. */
export function parseRchStatus(value: unknown): RchStatus | null {
	const envelope = object(value);
	const data = object(envelope?.data);
	const daemon = object(data?.daemon);
	if (envelope?.success !== true || !daemon || !Array.isArray(daemon.workers) || !Array.isArray(daemon.active_builds) || !Array.isArray(daemon.queued_builds)) return null;
	const workers: RchWorker[] = [];
	const seen = new Set<string>();
	for (const value of daemon.workers) {
		const row = object(value);
		if (!row || typeof row.id !== "string" || !row.id || seen.has(row.id) || !nonnegativeInteger(row.total_slots) || !nonnegativeInteger(row.used_slots) || row.used_slots > row.total_slots) return null;
		seen.add(row.id);
		workers.push({ id: row.id, status: typeof row.status === "string" ? row.status : "unknown", fresh: row.pressure_telemetry_fresh === true,
			confidence: typeof row.pressure_confidence === "string" ? row.pressure_confidence : "unknown", pressure: typeof row.pressure_state === "string" ? row.pressure_state : "unknown",
			total: row.total_slots, used: row.used_slots, free: row.total_slots - row.used_slots,
			buildDiskFreeGb: typeof row.pressure_build_disk_free_gb === "number" && Number.isFinite(row.pressure_build_disk_free_gb) ? row.pressure_build_disk_free_gb : null,
			memoryPressure: typeof row.pressure_memory_pressure === "number" && Number.isFinite(row.pressure_memory_pressure) && row.pressure_memory_pressure >= 0 ? row.pressure_memory_pressure : null });
	}
	return { workers, active: daemon.active_builds.length, queued: daemon.queued_builds.length };
}
function trusted(worker: RchWorker): boolean {
	return worker.status === "healthy" && worker.fresh && worker.confidence === "high" && (worker.pressure === "healthy" || worker.pressure === "warning");
}
/** Slot count alone admitted two heavy builds onto one worker and both died (ompkit-774u.6.1).
A worker is admissible only with known, non-exhausted build disk and known memory pressure below
refusal; among admissible workers the least memory-pressured is chosen. Absent telemetry refuses,
never admits: it is unknown, not free. */
function choose(status: RchStatus, input: RchCycleInput, exclude?: ReadonlySet<string>): RchWorker | undefined {
	let best: RchWorker | undefined, bestPressure = Infinity;
	for (const worker of status.workers) {
		if (input.worker && worker.id !== input.worker) continue;
		if (exclude?.has(worker.id)) continue;
		if (!trusted(worker) || worker.free < input.requiredSlots || worker.buildDiskFreeGb === null || !(worker.buildDiskFreeGb > 0)) continue;
		if (worker.memoryPressure === null || worker.memoryPressure >= MEMORY_PRESSURE_REFUSE) continue;
		if (worker.memoryPressure < bestPressure) { best = worker; bestPressure = worker.memoryPressure; }
	}
	return best;
}
function birthKey(lease: Record<string, unknown>): string | null {
	const start = object(object(lease.process_birth)?.start);
	return start && typeof start.platform === "string" && nonnegativeInteger(start.seconds) && nonnegativeInteger(start.microseconds) ? `${start.platform}:${start.seconds}:${start.microseconds}` : null;
}
/** Null when the reply is not a complete, error-free journal listing: absence of evidence reaps nothing. */
function scanDeadLeases(reply: unknown, scope: DeadLeaseScope): DeadLease[] | null {
	const envelope = object(reply);
	if (envelope?.complete !== true || !Array.isArray(envelope.jobs) || !Array.isArray(envelope.journal_errors) || envelope.journal_errors.length) return null;
	const rows = envelope.jobs.map(object);
	const liveBirths = new Map<number, Set<string>>();
	const idCounts = new Map<string, number>();
	for (const row of rows) {
		const lease = object(row?.lease), id = object(lease?.identity)?.local_wrapper_id;
		if (typeof id === "string") idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
		if (row?.wrapper_alive !== true || row.owner_presence !== "live" || !lease || !nonnegativeInteger(lease.wrapper_pid)) continue;
		const key = birthKey(lease);
		if (key) liveBirths.set(lease.wrapper_pid, (liveBirths.get(lease.wrapper_pid) ?? new Set<string>()).add(key));
	}
	const staleMs = scope.staleMs ?? DEAD_LEASE_STALE_MS;
	const found: DeadLease[] = [];
	for (const row of rows) {
		const lease = object(row?.lease), id = object(lease?.identity)?.local_wrapper_id, recovery = object(lease?.recovery);
		// Only a native-confirmed absent owner qualifies; live and unknown owners are never touched.
		if (!row || !lease || row.wrapper_alive !== false || row.owner_presence !== "absent" || lease.schema_version !== 1) continue;
		const pid = lease.wrapper_pid, worker = lease.worker_id;
		if (typeof id !== "string" || !id || idCounts.get(id) !== 1 || typeof worker !== "string" || !nonnegativeInteger(pid)) continue;
		if ((scope.worker !== undefined && worker !== scope.worker) || scope.excludePids?.includes(pid) || scope.excludeWrapperIds?.includes(id)) continue;
		if (lease.terminal_acknowledged === true || recovery?.retired === true) continue;
		const own = birthKey(lease), births = liveBirths.get(pid);
		const reused = own !== null && births !== undefined && !births.has(own);
		const stale = nonnegativeInteger(lease.heartbeat_unix_ms) && scope.now - lease.heartbeat_unix_ms >= staleMs;
		if (!reused && !stale) continue;
		found.push({ wrapperId: id, worker, pid, state: typeof lease.state === "string" ? lease.state : "unknown", phase: typeof lease.phase === "string" ? lease.phase : null, basis: reused ? "pid_birth_mismatch" : "stale_heartbeat" });
	}
	return found;
}
/** Leases in a native `jobs --json` reply whose holder is provably dead. Pure; an unreadable reply yields none. */
export function deadLeases(reply: unknown, scope: DeadLeaseScope): DeadLease[] {
	return scanDeadLeases(reply, scope) ?? [];
}
/** Why a reported dead lease is left in place. The producer owns retirement: `rch` must write
 * `terminal_acknowledged` or a `recover-consumed-*` marker after its own completion/recovery
 * path. Observed on rch 2.1.34 (daemon.log): `jobs recover` exits 1 for dead-owner leases
 * ("same-id remote execution has no durable completion yet"; "source-authority lock ... invalid
 * claim record") and rchd's dead-client recovery fails the same way on every retry. `rch jobs`
 * has only attach, cancel and recover; omp-kit never deletes or rewrites the producer's lease. */
export const DEAD_LEASE_UNREAPABLE_REASON = "rch owns retirement: only terminal_acknowledged or recover-consumed-* records settle a dead-owner lease; no native rch verb retires it, and omp-kit never deletes or rewrites the lease";
/** Report dead-owner leases on one worker. Never runs a native verb: none can retire them, and an unreadable journal reports nothing. */
async function reportDeadLeases(executor: RchExecutor, worker: string, signal?: AbortSignal): Promise<DeadLeaseReport[] | null> {
	const dead = scanDeadLeases(exactBuildIds(await executor.capture(["jobs", "--json"], CONTROL_TIMEOUT_MS, signal)), { now: Date.now(), worker, excludePids: [process.pid] });
	return dead === null ? null : dead.map(lease => ({ ...lease, outcome: "unreapable", reason: DEAD_LEASE_UNREAPABLE_REASON }));
}

/** Only bind while our unreaped child is still alive; a later reused PID is not our wrapper. */
async function bindOwnedWrapper(executor: RchExecutor, child: OwnedRchBuild, worker: string, signal?: AbortSignal): Promise<string | null> {
	const deadline = performance.now() + CONTROL_TIMEOUT_MS;
	while (child.pid && child.alive() && !signal?.aborted) {
		const remaining = Math.ceil(deadline - performance.now());
		if (remaining <= 0) return null;
		const reply = object(jsonResult(await executor.capture(["jobs", "--json"], remaining, signal)));
		if (!child.alive() || reply?.complete !== true || !Array.isArray(reply.jobs) || !Array.isArray(reply.journal_errors) || reply.journal_errors.length) return null;
		let found: string | null = null;
		for (const item of reply.jobs) {
			const row = object(item), lease = object(row?.lease), identity = object(lease?.identity), birth = object(lease?.process_birth);
			if (lease?.wrapper_pid !== child.pid || row?.wrapper_alive !== true) continue;
			if (row.owner_presence !== "live" || lease.worker_id !== worker || lease.schema_version !== 1 || !birth ||
				typeof birth.boot_id !== "string" || !object(birth.start) || typeof identity?.local_wrapper_id !== "string" || found !== null) return null;
			found = identity.local_wrapper_id;
		}
		if (found !== null) return found;
		// Spawn precedes journal publication. Limit waiting to the control deadline and four reads/s.
		const waitMs = Math.min(250, deadline - performance.now());
		if (waitMs > 0) await new Promise<void>(resolve => setTimeout(resolve, waitMs));
	}
	return null;
}
interface RchReturnEvidence {
	retired: boolean;
	executionObserved: boolean;
	compilerExit: number | null;
}

/** rch build ids are 64-bit and exceed Number.MAX_SAFE_INTEGER, so JSON.parse would round neighbours onto one value. Quote them before parsing and compare as exact decimal strings. */
function exactBuildIds(result: NativeRchResult): unknown {
	if (result.state !== "exited" || result.exit !== 0) return null;
	try { return JSON.parse(result.stdout.replace(/("(?:remote_build_id|build_id)"\s*:\s*)([0-9]+)/g, '$1"$2"')); } catch { return null; }
}

async function returnedLease(executor: RchExecutor, id: string, worker: string): Promise<RchReturnEvidence | null> {
	const reply = object(exactBuildIds(await executor.capture(["jobs", "--json"], CONTROL_TIMEOUT_MS)));
	if (reply?.complete !== true || !Array.isArray(reply.jobs) || !Array.isArray(reply.journal_errors) || reply.journal_errors.length) return null;
	const matches = reply.jobs.map(object).filter(row => object(object(row?.lease)?.identity)?.local_wrapper_id === id);
	if (matches.length !== 1) return null;
	const lease = object(matches[0]?.lease), recovery = object(lease?.recovery), identity = object(lease?.identity);
	const buildId = identity?.remote_build_id;
	if (!lease || lease.schema_version !== 1 || lease.worker_id !== worker || typeof buildId !== "string" || !/^[1-9][0-9]*$/.test(buildId)) return null;
	// A wrapper that exited in running/finalize leaves a journaled lease with identity but no recovery record until `jobs recover` runs.
	// Report it bound-but-unrecovered so the caller recovers it; it proves neither execution nor an exit code.
	if (!recovery) return { retired: false, executionObserved: false, compilerExit: null };
	if (recovery.wrapper_id !== id || recovery.build_id !== buildId) return null;
	// `cargo check` retrieves no artifact, so execution_started may never be set. A recorded exit code on a retired, sources-released,
	// uncancelled lease can only come from a completed remote command, so it proves execution without trusting the native exit alone.
	const observed = recovery.preparation_cancelled === false && nonnegativeInteger(recovery.exit_code) &&
		(recovery.execution_started === true || (recovery.retired === true && recovery.sources_released === true));
	return { retired: recovery.retired === true && recovery.sources_released === true, executionObserved: observed, compilerExit: observed ? recovery.exit_code as number : null };
}

/** Delegate reclaim to native policy; no custom pool deleter, cache scanner, lease database, daemon restart or local fallback. */
export async function runRchCycle(input: RchCycleInput, executor: RchExecutor): Promise<RchCycleResult> {
	const result: RchCycleResult = { overall: "REFUSED", reason: "invalid_input", worker: null, nativeExit: null, compilerExit: null, executionObserved: null, compilerState: "not-submitted", cleanup: "not-run", nextAgentReady: null,
		before: null, after: null, wrapperId: null, deadLeases: null, lease: "", noClaim: "Bounds native admission and post-run readiness; does not prove compiler correctness or retire shared warm caches." };
	const finish = () => {
		result.lease = `LEASE worker=${result.worker ?? "none"} native_exit=${result.nativeExit ?? "none"} build_exit=${result.compilerExit ?? "unknown"} cleanup=${result.cleanup} next_agent_ready=${result.nextAgentReady ?? "unknown"} overall=${result.overall} reason=${result.reason} dead_leases=${result.deadLeases?.length ?? "unknown"} reap=no_native_verb`;
		return result;
	};
	if (!Number.isSafeInteger(input.requiredSlots) || input.requiredSlots < 1 || !input.command.length || input.command.some(arg => typeof arg !== "string" || arg.includes("\0"))) return finish();
	const options = input.nativeOptions ?? [];
	if (options.some(arg => arg === "--" || arg === "--worker" || arg.startsWith("--worker=") || arg === "--no-self-healing" || arg === "--no-hook-auto-start" || arg.includes("\0"))) return finish();
	result.before = parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS, input.signal)));
	if (!result.before) { result.reason = "rch_status_unavailable"; return finish(); }
	// An OOM-killed build (remote exit 137) is retried once on another worker; every other outcome
	// settles on the first attempt. result.before stays the first snapshot; result.after the last.
	const oomExcluded = new Set<string>();
	let oomWorker: string | null = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		const snapshot = attempt === 0 ? result.before : parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS, input.signal)));
		if (!snapshot) {
			if (attempt === 0) { result.reason = "rch_status_unavailable"; return finish(); }
			result.overall = "BUILD_FAILED"; result.reason = `oom_killed_on_${oomWorker}_exit_137_status_unavailable_for_retry`;
			return finish();
		}
		let worker = choose(snapshot, input, oomExcluded);
		const status = snapshot;
		// Dead-owner leases hold pool slots; look on the admissible worker, or the trusted worker whose slots they may be holding.
		const scope = worker ?? snapshot.workers.find(row => (!input.worker || row.id === input.worker) && trusted(row));
		if (!input.apply) {
			if (scope) result.deadLeases = await reportDeadLeases(executor, scope.id, input.signal);
			result.overall = "PLAN"; result.reason = worker ? "admissible_snapshot_not_a_reservation" : "rch_capacity_unavailable";
			result.worker = worker?.id ?? input.worker ?? null; result.nextAgentReady = Boolean(worker); return finish();
		}
		if (input.signal?.aborted) { result.overall = "CANCELLED"; result.reason = "cancelled_before_submit"; return finish(); }
		if (scope) result.deadLeases = await reportDeadLeases(executor, scope.id, input.signal);
		if (!worker || worker.pressure === "warning") {
			// Native policy decides eligibility. A zero-byte reclaim is not restored capacity.
			const candidate = worker ?? status.workers.find(row => (!input.worker || row.id === input.worker) && trusted(row));
			if (candidate) {
				const reclaimed = await executor.capture(["gc", "--workers", candidate.id, "--worker-timeout", "900", "--apply", "--json"], GC_TIMEOUT_MS, input.signal);
				if (reclaimed.state !== "exited" || reclaimed.exit !== 0) { result.reason = "rch_pre_gc_failed"; return finish(); }
				const fresh = parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS, input.signal)));
				if (!fresh) { result.reason = "rch_status_unavailable"; return finish(); }
				worker = choose(fresh, input, oomExcluded);
			}
		}
		if (!worker) {
			if (oomWorker) { result.overall = "BUILD_FAILED"; result.reason = `oom_killed_on_${oomWorker}_exit_137_no_retry_worker`; }
			else result.reason = "rch_capacity_unavailable";
			return finish();
		}
		result.worker = worker.id;
		result.wrapperId = null; result.nativeExit = null; result.compilerExit = null; result.executionObserved = null;
		result.compilerState = "not-submitted"; result.cleanup = "not-run"; result.after = null; result.nextAgentReady = null;
		try {
			const child = executor.build(["exec", "--worker", worker.id, ...options, "--", ...input.command], input.signal);
			result.wrapperId = await bindOwnedWrapper(executor, child, worker.id, input.signal);
			const compiled = await child.result;
			result.nativeExit = compiled.exit; result.compilerState = compiled.state;
		} finally {
			// Recover only our bound native identity, never a PID lookup after exit or an unrelated journal row.
			let returned = result.wrapperId ? await returnedLease(executor, result.wrapperId, worker.id) : null;
			if (result.wrapperId && returned?.retired !== true && (result.compilerState === "cancelled" || input.signal?.aborted)) {
				// Killing the local client is not proof that its remote command stopped.
				const cancelled = await executor.capture(["jobs", "cancel", result.wrapperId, "--json"], CONTROL_TIMEOUT_MS);
				if (cancelled.state === "exited" && cancelled.exit === 0) returned = await returnedLease(executor, result.wrapperId, worker.id);
			}
			if (returned?.retired === false && result.wrapperId) {
				const recovered = await executor.capture(["jobs", "recover", result.wrapperId, "--json"], GC_TIMEOUT_MS);
				if (recovered.state === "exited" && recovered.exit === 0) returned = await returnedLease(executor, result.wrapperId, worker.id);
			}
			result.compilerExit = returned?.compilerExit ?? null;
			result.executionObserved = returned?.executionObserved ?? null;
			// Do not reclaim against an unbound or still-active remote lease.
			if (returned?.retired === true) {
				const reclaimed = await executor.capture(["gc", "--workers", worker.id, "--worker-timeout", "900", "--apply", "--json"], GC_TIMEOUT_MS);
				result.cleanup = reclaimed.state === "exited" && reclaimed.exit === 0 ? "complete" : "failed";
			} else result.cleanup = returned === null ? "unknown" : "failed";
			result.after = parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS)));
			result.nextAgentReady = result.after ? choose(result.after, input, oomExcluded) !== undefined : null;
		}
		// Exit 137 is 128+SIGKILL: the Linux OOM killer's signature on a remote rustc (native RCH-E302
		// remediation names the OOM killer first). The journal records exit codes, not signals, so a
		// deliberate SIGKILL is indistinguishable here; the worker name is always attached.
		const oomKilled = result.compilerState !== "cancelled" && !input.signal?.aborted && result.compilerExit === 137;
		if (result.compilerState === "cancelled" || input.signal?.aborted) { result.overall = "CANCELLED"; result.reason = "native_execution_cancelled"; break; }
		if (oomKilled && attempt === 0) { oomExcluded.add(worker.id); oomWorker = worker.id; continue; }
		if (oomKilled) { result.overall = "BUILD_FAILED"; result.reason = `oom_killed_on_${worker.id}_exit_137_remote_sigkill`; }
		else if (result.compilerExit !== null && result.compilerExit !== 0) { result.overall = "BUILD_FAILED"; result.reason = "native_remote_command_failed"; }
		else if (result.compilerState === "exited" && result.nativeExit !== null && result.nativeExit !== 0 && result.wrapperId === null && result.compilerExit === null && result.executionObserved !== true) { result.overall = "REFUSED"; result.reason = "rch_capacity_unavailable"; }
		else if (result.compilerState === "exited" && result.nativeExit !== null && result.nativeExit !== 0 && result.executionObserved === true) { result.overall = "BUILD_FAILED"; result.reason = "artifact_return_refused"; }
		else if (result.compilerState === "exited" && result.nativeExit !== null && result.nativeExit !== 0) { result.overall = "UNREADY"; result.reason = "rch_transport_unavailable"; }
		else if (result.compilerState !== "exited" || result.executionObserved !== true) { result.overall = "UNREADY"; result.reason = "native_remote_completion_not_observed"; }
		else if (result.cleanup !== "complete" || result.nextAgentReady !== true) { result.overall = "UNREADY"; result.reason = "post_run_readiness_not_proven"; }
		else { result.overall = "COMPLETE"; result.reason = "native_return_and_readiness_observed"; }
		break;
	}
	return finish();
}

/** Spawn only the selected native executable, preserving its bytes and argv. Build output goes to stderr so JSON stdout stays parseable. */
export function nativeRchExecutor(executable: string, cwd: string, env: NodeJS.ProcessEnv = process.env): RchExecutor {
	const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	function launch(args: readonly string[], capture: boolean, timeoutMs: number, signal?: AbortSignal): OwnedRchBuild {
		let handle: SpawnHandle | undefined;
		let state: NativeRchResult["state"] = "exited", bytes = 0, settled = false, timer: NodeJS.Timeout | undefined;
		const output: string[] = [];
		const stop = (reason: NativeRchResult["state"]) => {
			if (settled || state !== "exited") return;
			state = reason;
			handle?.kill();
		};
		const arm = () => { clearTimeout(timer); timer = setTimeout(() => stop("timeout"), timeoutMs); };
		const executor = bunCapExec({ captureOutput: false, onOutput: (stream, text) => {
			if (!capture) { arm(); process.stderr.write(text); return; }
			if (stream !== "stdout" || state === "output-limit") return;
			bytes += Buffer.byteLength(text);
			if (bytes > MAX_METADATA_BYTES) stop("output-limit"); else output.push(text);
		} });
		try {
			handle = executor.spawn([executable, ...NATIVE_SAFETY, ...args], { cwd, env: childEnv });
		} catch {
			return { pid: null, alive: () => false, result: Promise.resolve({ exit: null, state: "spawn-failed", stdout: "" }) };
		}
		const aborted = () => stop("cancelled");
		signal?.addEventListener("abort", aborted, { once: true });
		const result = handle.wait().then(({ code }) => {
			settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted);
			return { exit: code, state, stdout: capture && bytes <= MAX_METADATA_BYTES ? output.join("") : "" };
		});
		arm();
		if (signal?.aborted) aborted();
		if (state !== "exited") handle.kill();
		return { pid: handle.pid, alive: () => handle?.alive?.() === true, result };
	}
	return {
		capture: (args, timeoutMs, signal) => launch(args, true, timeoutMs, signal).result,
		build: (args, signal) => launch(args, false, BUILD_IDLE_TIMEOUT_MS, signal),
	};
}
