import { bunCapExec, type SpawnHandle } from "./service-run.ts";

const CONTROL_TIMEOUT_MS = 30_000;
const GC_TIMEOUT_MS = 960_000; // Native GC's 900 s per-worker bound, plus shutdown time; one worker only.
const BUILD_IDLE_TIMEOUT_MS = 1_800_000; // Existing fleet no-progress bound; output rearms it.
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const NATIVE_SAFETY = ["--no-self-healing", "--no-hook-auto-start"] as const;

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
			buildDiskFreeGb: typeof row.pressure_build_disk_free_gb === "number" && Number.isFinite(row.pressure_build_disk_free_gb) ? row.pressure_build_disk_free_gb : null });
	}
	return { workers, active: daemon.active_builds.length, queued: daemon.queued_builds.length };
}
function trusted(worker: RchWorker): boolean {
	return worker.status === "healthy" && worker.fresh && worker.confidence === "high" && (worker.pressure === "healthy" || worker.pressure === "warning");
}
function choose(status: RchStatus, input: RchCycleInput): RchWorker | undefined {
	return status.workers.find(worker => (!input.worker || worker.id === input.worker) && trusted(worker) && worker.free >= input.requiredSlots);
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

async function returnedLease(executor: RchExecutor, id: string, worker: string): Promise<RchReturnEvidence | null> {
	const reply = object(jsonResult(await executor.capture(["jobs", "--json"], CONTROL_TIMEOUT_MS)));
	if (reply?.complete !== true || !Array.isArray(reply.jobs) || !Array.isArray(reply.journal_errors) || reply.journal_errors.length) return null;
	const matches = reply.jobs.map(object).filter(row => object(object(row?.lease)?.identity)?.local_wrapper_id === id);
	if (matches.length !== 1) return null;
	const lease = object(matches[0]?.lease), recovery = object(lease?.recovery), identity = object(lease?.identity);
	if (!lease || !recovery || lease.schema_version !== 1 || lease.worker_id !== worker || recovery.wrapper_id !== id ||
		!nonnegativeInteger(identity?.remote_build_id) || identity.remote_build_id === 0 || recovery.build_id !== identity.remote_build_id) return null;
	const observed = recovery.execution_started === true && recovery.preparation_cancelled === false && nonnegativeInteger(recovery.exit_code);
	return { retired: recovery.retired === true && recovery.sources_released === true, executionObserved: observed, compilerExit: observed ? recovery.exit_code as number : null };
}

/** Delegate reclaim to native policy; no custom pool deleter, cache scanner, lease database, daemon restart or local fallback. */
export async function runRchCycle(input: RchCycleInput, executor: RchExecutor): Promise<RchCycleResult> {
	const result: RchCycleResult = { overall: "REFUSED", reason: "invalid_input", worker: null, nativeExit: null, compilerExit: null, executionObserved: null, compilerState: "not-submitted", cleanup: "not-run", nextAgentReady: null,
		before: null, after: null, wrapperId: null, lease: "", noClaim: "Bounds native admission and post-run readiness; does not prove compiler correctness or retire shared warm caches." };
	const finish = () => {
		result.lease = `LEASE worker=${result.worker ?? "none"} native_exit=${result.nativeExit ?? "none"} build_exit=${result.compilerExit ?? "unknown"} cleanup=${result.cleanup} next_agent_ready=${result.nextAgentReady ?? "unknown"} overall=${result.overall} reason=${result.reason}`;
		return result;
	};
	if (!Number.isSafeInteger(input.requiredSlots) || input.requiredSlots < 1 || !input.command.length || input.command.some(arg => typeof arg !== "string" || arg.includes("\0"))) return finish();
	const options = input.nativeOptions ?? [];
	if (options.some(arg => arg === "--" || arg === "--worker" || arg.startsWith("--worker=") || arg === "--no-self-healing" || arg === "--no-hook-auto-start" || arg.includes("\0"))) return finish();
	result.before = parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS, input.signal)));
	if (!result.before) { result.reason = "rch_status_unavailable"; return finish(); }
	let worker = choose(result.before, input);
	if (!input.apply) {
		result.overall = "PLAN"; result.reason = worker ? "admissible_snapshot_not_a_reservation" : "rch_capacity_unavailable";
		result.worker = worker?.id ?? input.worker ?? null; result.nextAgentReady = Boolean(worker); return finish();
	}
	if (input.signal?.aborted) { result.overall = "CANCELLED"; result.reason = "cancelled_before_submit"; return finish(); }
	if (!worker || worker.pressure === "warning") {
		// Native policy decides eligibility. A zero-byte reclaim is not restored capacity.
		const candidate = worker ?? result.before.workers.find(row => (!input.worker || row.id === input.worker) && trusted(row));
		if (candidate) {
			const reclaimed = await executor.capture(["gc", "--workers", candidate.id, "--worker-timeout", "900", "--apply", "--json"], GC_TIMEOUT_MS, input.signal);
			if (reclaimed.state !== "exited" || reclaimed.exit !== 0) { result.reason = "rch_pre_gc_failed"; return finish(); }
			const fresh = parseRchStatus(jsonResult(await executor.capture(["status", "--json"], CONTROL_TIMEOUT_MS, input.signal)));
			if (!fresh) { result.reason = "rch_status_unavailable"; return finish(); }
			worker = choose(fresh, input);
		}
	}
	if (!worker) { result.reason = "rch_capacity_unavailable"; return finish(); }
	result.worker = worker.id;
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
		const after = result.after?.workers.find(row => row.id === worker.id);
		result.nextAgentReady = after ? trusted(after) && after.free >= input.requiredSlots : null;
	}
	if (result.compilerState === "cancelled" || input.signal?.aborted) { result.overall = "CANCELLED"; result.reason = "native_execution_cancelled"; }
	else if (result.compilerExit !== null && result.compilerExit !== 0) { result.overall = "BUILD_FAILED"; result.reason = "native_remote_command_failed"; }
	else if (result.compilerState === "exited" && result.nativeExit !== null && result.nativeExit !== 0) { result.overall = "BUILD_FAILED"; result.reason = "native_return_failed"; }
	else if (result.compilerState !== "exited" || result.executionObserved !== true) { result.overall = "UNREADY"; result.reason = "native_remote_completion_not_observed"; }
	else if (result.cleanup !== "complete" || result.nextAgentReady !== true) { result.overall = "UNREADY"; result.reason = "post_run_readiness_not_proven"; }
	else { result.overall = "COMPLETE"; result.reason = "native_return_and_readiness_observed"; }
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
