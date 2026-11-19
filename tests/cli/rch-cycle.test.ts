import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { DEAD_LEASE_UNREAPABLE_REASON, deadLeases, parseRchStatus, runRchCycle, type NativeRchResult, type RchCycleResult, type RchExecutor } from "../../src/rch-cycle.ts";

// A real remote_build_id from replay 3 (ev_30924d59) and its neighbour: both above Number.MAX_SAFE_INTEGER, both parse to the same double.
const BIG_ID = "30068411341996668", BIG_ID_NEIGHBOUR = "30068411341996667";

// A journaled lease planted beside the run under test, in the shape a real host journals a dead wrapper (rch 2.1.34): state running, a recovery record present but unretired
// (execution_started, no exit code, sources not released), owner absent, heartbeat an hour old, holding `slots` pool slots until retired.
interface PlantedLease { id: string; worker?: string; pid?: number; birthSeconds?: number; alive?: boolean; ownerPresence?: string; ageMs?: number; acknowledged?: boolean; retired?: boolean; slots?: number }

// The native boundary is injected: these tests must never submit remote work or mutate real caches.
interface FixtureWorker { id: string; memPressure?: number | null; free?: number; health?: string; diskGb?: number | null }
function nativeFixture(options: { freeBefore?: number; freeAfter?: number; nativeExit?: number; remoteExit?: number; remoteExitAfterRetry?: number; executed?: boolean; gcExit?: number; health?: string; fresh?: boolean; cancelled?: boolean; ownerPresence?: string; journalWorker?: string; delayedJournal?: boolean; executionStarted?: boolean; admissionRefused?: boolean; noRecovery?: boolean; rawIds?: [remote: string, build: string]; transport?: boolean; planted?: PlantedLease[]; memPressure?: number | null; diskGb?: number | null; moreWorkers?: FixtureWorker[] } = {}) {
	let submitted = 0, running = false, remoteRunning = false, statusReads = 0, journalReads = 0, recovered = false;
	let currentWorker: string | null = null;
	const submittedWorkers: string[] = [];
	const planted = options.planted ?? [], recoverCalls: string[] = [];
	const plantedDone = (lease: PlantedLease) => lease.retired === true;
	const plantedRow = (lease: PlantedLease) => ({ wrapper_alive: lease.alive ?? false, owner_presence: lease.ownerPresence ?? "absent", lease: {
		schema_version: 1, wrapper_pid: lease.pid ?? 52001, boot_id: "fixture-boot", process_birth: { boot_id: "fixture-boot", start: { platform: "darwin", seconds: lease.birthSeconds ?? 1, microseconds: 3 } },
		identity: { local_wrapper_id: lease.id, remote_build_id: 52 }, worker_id: lease.worker ?? "worker-a", state: plantedDone(lease) ? "finished" : "running", phase: plantedDone(lease) ? "finished" : "finalize",
		heartbeat_unix_ms: Date.now() - (lease.ageMs ?? 3_600_000), terminal_acknowledged: lease.acknowledged ?? plantedDone(lease),
		recovery: { wrapper_id: lease.id, build_id: 52, execution_started: true, preparation_cancelled: false, exit_code: null, retired: plantedDone(lease), sources_released: plantedDone(lease) },
	} });
	let finish: (value: NativeRchResult) => void = () => { throw new Error("build not started"); };
	const statusRow = (id: string, free: number, mem: number | null | undefined, health?: string, disk?: number | null) => ({
		id, status: health ?? options.health ?? "healthy", total_slots: free, used_slots: 0,
		pressure_telemetry_fresh: options.fresh ?? true, pressure_confidence: "high", pressure_state: "healthy", pressure_build_disk_free_gb: disk === undefined ? 20 : disk,
		pressure_memory_pressure: mem === undefined ? 10 : mem,
	});
	const status = () => ({ success: true, data: { daemon: { active_builds: [], queued_builds: [], workers: [{
		id: "worker-a", status: options.health ?? "healthy", total_slots: statusReads++ === 0 ? options.freeBefore ?? 4 : options.freeAfter ?? 4,
		used_slots: planted.reduce((used, lease) => used + (plantedDone(lease) ? 0 : lease.slots ?? 0), 0), pressure_telemetry_fresh: options.fresh ?? true, pressure_confidence: "high", pressure_state: "healthy", pressure_build_disk_free_gb: "diskGb" in options ? options.diskGb : 20,
		pressure_memory_pressure: "memPressure" in options ? options.memPressure : 10,
	}, ...(options.moreWorkers ?? []).map(row => statusRow(row.id, row.free ?? 4, row.memPressure, row.health, row.diskGb))] } } });
	const executor: RchExecutor = {
		async capture(args) {
			let value: unknown;
			if (args[0] === "jobs" && args[1] === "cancel") {
				if (args[2] !== "rchw-fixture") throw new Error("Refusing cancellation of an unrelated native job");
				remoteRunning = false;
				return { exit: 0, state: "exited", stdout: "{}" };
			}
			if (args[0] === "jobs" && args[1] === "recover" && planted.some(lease => lease.id === args[2])) {
				// What a real host answered: the recover cannot establish a terminal state for a dead-owner lease, exits 1, and retires nothing.
				recoverCalls.push(args[2] ?? "");
				return { exit: 1, state: "exited", stdout: "" };
			}
			if (args[0] === "status") value = status();
			else if (args[0] === "gc") return { exit: options.gcExit ?? 0, state: "exited", stdout: "{}" };
			else if (args[0] === "jobs") {
				if (args[1] === "recover") recovered = true;
				if (running && options.delayedJournal && journalReads++ === 0) return { exit: 0, state: "exited", stdout: JSON.stringify({ complete: true, journal_errors: [], jobs: [] }) };
				// Real journals list neighbouring builds; with raw ids, plant one whose id is one below ours (both round to the same double).
				const neighbour = { wrapper_alive: false, owner_presence: "absent", lease: {
					schema_version: 1, wrapper_pid: 41002, boot_id: "fixture-boot", process_birth: { boot_id: "fixture-boot", start: { platform: "darwin", seconds: 1, microseconds: 1 } },
					identity: { local_wrapper_id: "rchw-neighbour", remote_build_id: "NEIGHBOUR" }, worker_id: "worker-a", state: "finished",
					recovery: { wrapper_id: "rchw-neighbour", build_id: "NEIGHBOUR", execution_started: true, preparation_cancelled: false, exit_code: 3, retired: true, sources_released: true },
				} };
			value = { complete: true, journal_errors: [], jobs: [...(options.rawIds ? [neighbour] : []), ...planted.map(plantedRow), { wrapper_alive: running, owner_presence: running ? options.ownerPresence ?? "live" : "absent", lease: {
				schema_version: 1, wrapper_pid: 41001, boot_id: "fixture-boot", process_birth: { boot_id: "fixture-boot", start: { platform: "darwin", seconds: 1, microseconds: 2 } },
				identity: { local_wrapper_id: "rchw-fixture", remote_build_id: options.rawIds ? "RAWREMOTE" : 41 }, worker_id: options.journalWorker ?? currentWorker ?? "worker-a", state: running ? "running" : "finished",
				...(options.noRecovery && !recovered ? {} : { recovery: { wrapper_id: "rchw-fixture", build_id: options.rawIds ? "RAWBUILD" : 41, execution_started: options.executionStarted ?? options.executed ?? true, preparation_cancelled: options.executed === false,
					exit_code: options.transport || remoteRunning ? null : submitted >= 2 && options.remoteExitAfterRetry !== undefined ? options.remoteExitAfterRetry : options.remoteExit ?? options.nativeExit ?? 0, retired: !remoteRunning, sources_released: !remoteRunning } }),
			} }] };
			} else throw new Error("Unexpected native operation");
			// rch prints pretty JSON ("key": value). Real ids are 64-bit integers written as raw digits; JSON.stringify cannot produce them from a double.
			let text = JSON.stringify(value, null, 2);
			if (options.rawIds) text = text.replace('"RAWREMOTE"', options.rawIds[0]).replace('"RAWBUILD"', options.rawIds[1]).replaceAll('"NEIGHBOUR"', BIG_ID_NEIGHBOUR);
			return { exit: 0, state: "exited", stdout: text };
		},
	build(args) {
			if (options.admissionRefused) {
				// Native admission refusal (RCH-I003/RCH-I001): no wrapper is ever journaled and nothing runs remotely.
				return { pid: 0, alive: () => false, result: Promise.resolve({ exit: 1, state: "exited", stdout: "" } as NativeRchResult) };
			}
		submitted++; running = true; remoteRunning = true;
		const at = args.indexOf("--worker");
		currentWorker = at >= 0 && typeof args[at + 1] === "string" ? args[at + 1] as string : null;
		if (currentWorker) submittedWorkers.push(currentWorker);
			const result = new Promise<NativeRchResult>(resolve => { finish = resolve; });
			if (options.delayedJournal) {
				// Hold completion until the identification phase ends; no wall-clock race in this model.
				return { pid: 41001, alive: () => running, get result() {
					running = false; remoteRunning = false;
					finish({ exit: 0, state: "exited", stdout: "" });
					return result;
				} };
			}
			// The journal observation precedes terminal return, as required to bind a live owned PID.
			setImmediate(() => {
				running = false;
				if (!options.cancelled) remoteRunning = false;
				finish({ exit: options.nativeExit ?? 0, state: options.cancelled ? "cancelled" : "exited", stdout: "" });
			});
			return { pid: 41001, alive: () => running, result };
		},
	};
	return { executor, submitted: () => submitted, submittedWorkers: () => submittedWorkers, remoteActive: () => remoteRunning, recoverCalls: () => recoverCalls };
}

const input = { requiredSlots: 2, command: ["cargo", "test", "--locked", "-j", "2"], apply: true };

test("a zero-exit native refusal with no remote execution never becomes complete-success", async () => {
	const fixture = nativeFixture({ nativeExit: 0, remoteExit: 0, executed: false });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("UNREADY");
	expect(result.compilerExit).toBeNull();
});

test("successful zero-byte GC cannot manufacture capacity or submit a build", async () => {
	const fixture = nativeFixture({ freeBefore: 0, freeAfter: 0 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});

test.each([0, 101])("post-GC failure preserves remote compiler exit %s without complete-success", async compilerExit => {
	const fixture = nativeFixture({ nativeExit: compilerExit, remoteExit: compilerExit, gcExit: 1 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.compilerExit).toBe(compilerExit);
	expect(result.cleanup).toBe("failed");
	expect(result.overall).toBe(compilerExit === 0 ? "UNREADY" : "BUILD_FAILED");
});

test("a pre-build gc failure refuses without submitting anything", async () => {
const fixture = nativeFixture({ freeBefore: 0, freeAfter: 0, gcExit: 1 });
const result = await runRchCycle(input, fixture.executor);
expect(result.overall).toBe("REFUSED");
expect(result.reason).toBe("rch_pre_gc_failed");
expect(fixture.submitted()).toBe(0);
});

test("a pre-build gc failure never becomes a pass even when a later read would admit", async () => {
const fixture = nativeFixture({ freeBefore: 0, freeAfter: 4, gcExit: 1 });
const result = await runRchCycle(input, fixture.executor);
expect(result.overall).toBe("REFUSED");
expect(result.reason).toBe("rch_pre_gc_failed");
expect(result.compilerExit).toBeNull();
expect(fixture.submitted()).toBe(0);
});

test("a returned successful job still refuses a next-agent readiness claim when disk pressure removes its slots", async () => {
	const fixture = nativeFixture({ freeAfter: 0 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.compilerExit).toBe(0);
	expect(result.cleanup).toBe("complete");
	expect(result.nextAgentReady).toBe(false);
	expect(result.overall).toBe("UNREADY");
});

test.each([{ health: "degraded" }, { fresh: false }])("untrusted worker telemetry never authorizes submission: %j", async options => {
	const fixture = nativeFixture(options);
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});

test("cancelling a bound wrapper cancels its still-running remote job before claiming cleanup", async () => {
	const fixture = nativeFixture({ cancelled: true, nativeExit: 130, remoteExit: 130 });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.remoteActive()).toBe(false);
	expect(result.overall).toBe("CANCELLED");
	expect(result.compilerExit).toBe(130);
	expect(result.cleanup).toBe("complete");
});

test.each([{ ownerPresence: "absent" }, { ownerPresence: "unknown" }, { journalWorker: "worker-b" }])("a PID match cannot borrow an unowned or different-worker journal: %j", async options => {
	const fixture = nativeFixture(options);
	const result = await runRchCycle(input, fixture.executor);
	expect(result.wrapperId).toBeNull();
	expect(result.compilerExit).toBeNull();
	expect(result.cleanup).toBe("unknown");
	expect(result.overall).toBe("UNREADY");
});

test("a native journal published after spawn can still bind the live owned build", async () => {
	const fixture = nativeFixture({ delayedJournal: true });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("COMPLETE");
	expect(result.compilerExit).toBe(0);
	expect(result.cleanup).toBe("complete");
});

test("a passing remote check whose lease records exit 0 and retires without an execution_started flag is complete", async () => {
	// `cargo check` retrieves no artifact, so the journal may never flag execution_started; a recorded exit code on a retired, uncancelled lease is remote execution.
	const result = await runRchCycle(input, nativeFixture({ nativeExit: 0, remoteExit: 0, executionStarted: false }).executor);
	expect(result.compilerExit).toBe(0);
	expect(result.overall).toBe("COMPLETE");
	expect(result.reason).toBe("native_return_and_readiness_observed");
});

test("native admission refusal with no bound wrapper and no execution is REFUSED rch_capacity_unavailable, not a build failure", async () => {
	const fixture = nativeFixture({ admissionRefused: true });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.wrapperId).toBeNull();
	expect(result.nativeExit).toBe(1);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.remoteActive()).toBe(false);
});

test("a remote command that ran but whose artifact return was refused is BUILD_FAILED artifact_return_refused with the build exit shown", async () => {
	const result = await runRchCycle(input, nativeFixture({ nativeExit: 1, remoteExit: 0 }).executor);
	expect(result.compilerExit).toBe(0);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toBe("artifact_return_refused");
	expect(result.lease).toContain("build_exit=0");
});

test("a wrapper that exited in running/finalize leaves a lease with no recovery record; the lease is recovered and a passing check is complete", async () => {
	const fixture = nativeFixture({ noRecovery: true });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("COMPLETE");
	expect(result.compilerExit).toBe(0);
	expect(result.executionObserved).toBe(true);
});

test("a real 64-bit rch build id (above Number.MAX_SAFE_INTEGER) binds the lease: a passing check reports build_exit=0 and cleanup=complete", async () => {
	const fixture = nativeFixture({ rawIds: [BIG_ID, BIG_ID] });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("COMPLETE");
	expect(result.compilerExit).toBe(0);
	expect(result.cleanup).toBe("complete");
	expect(result.lease).toContain("build_exit=0 cleanup=complete");
});

test("a real 64-bit lease reports its own recorded remote exit, never the neighbouring build's", async () => {
	// Ours records 101; the neighbour one id below records 3.
	const fixture = nativeFixture({ rawIds: [BIG_ID, BIG_ID], nativeExit: 1, remoteExit: 101 });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toBe("native_remote_command_failed");
	expect(result.compilerExit).toBe(101);
	expect(result.cleanup).toBe("complete");
});

test("a lease whose recovery carries the neighbouring build id (one below, past 2^53) is never trusted", async () => {
	// 30068411341996667 and ...668 round to the same double; only an exact decimal comparison tells them apart.
	const fixture = nativeFixture({ rawIds: [BIG_ID, BIG_ID_NEIGHBOUR] });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("UNREADY");
	expect(result.compilerExit).toBeNull();
	expect(result.cleanup).toBe("unknown");
});

test.each([
	["negative", `-${BIG_ID}`],
	["zero", "0"],
	["non-digit string", `"${BIG_ID}x"`],
	["leading-zero string", `"0${BIG_ID}"`],
	["exponent-form", "3.0068411341996668e16"],
])("a %s rch build id is refused, so the lease proves nothing", async (_shape, token) => {
	const fixture = nativeFixture({ rawIds: [token, token] });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("UNREADY");
	expect(result.compilerExit).toBeNull();
	expect(result.cleanup).toBe("unknown");
});

test("a bound wrapper whose native call failed with no recorded remote exit (SSH transport timeout) is UNREADY rch_transport_unavailable, never BUILD_FAILED", async () => {
	const fixture = nativeFixture({ nativeExit: 1, transport: true });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("UNREADY");
	expect(result.reason).toBe("rch_transport_unavailable");
	expect(result.compilerExit).toBeNull();
});

test("the same native failure with a recorded nonzero remote exit stays BUILD_FAILED native_remote_command_failed", async () => {
	const fixture = nativeFixture({ nativeExit: 1, remoteExit: 101 });
	const result = await runRchCycle({ ...input, command: ["cargo", "check", "--locked"] }, fixture.executor);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toBe("native_remote_command_failed");
	expect(result.compilerExit).toBe(101);
});

const DEAD: PlantedLease = { id: "rchw-dead", slots: 1 };

test("a dead-owner lease is reported unreapable with the missing native capability named, never recovered, and a passing run stays passing", async () => {
	const baseline = await runRchCycle(input, nativeFixture().executor);
	const fixture = nativeFixture({ planted: [DEAD] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases).toEqual([{ wrapperId: "rchw-dead", worker: "worker-a", pid: 52001, state: "running", phase: "finalize", basis: "stale_heartbeat", outcome: "unreapable", reason: DEAD_LEASE_UNREAPABLE_REASON }]);
	expect(DEAD_LEASE_UNREAPABLE_REASON).toContain("rch owns retirement");
	expect(DEAD_LEASE_UNREAPABLE_REASON).toContain("terminal_acknowledged");
	expect(DEAD_LEASE_UNREAPABLE_REASON).toContain("recover-consumed-*");
	expect(DEAD_LEASE_UNREAPABLE_REASON).toContain("omp-kit never deletes or rewrites");
	expect([result.overall, result.reason]).toEqual([baseline.overall, baseline.reason]);
	expect(result.overall).toBe("COMPLETE");
	expect(fixture.submitted()).toBe(1);
	expect(result.lease).toContain("dead_leases=1 reap=no_native_verb");
	expect(result.lease).not.toContain("reaped=");
});

test("a dead lease that holds the pool's slots is not claimed freed: the cycle refuses for capacity instead of pretending a reap", async () => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-dead", slots: 3 }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases?.map(lease => [lease.wrapperId, lease.outcome])).toEqual([["rchw-dead", "unreapable"]]);
	expect(result.before?.workers[0]?.free).toBe(1);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});

test("a dead lease whose pid is now held by a live wrapper with a different process start time is reported even with a fresh heartbeat; neither is recovered", async () => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-dead", pid: 52002, ageMs: 1_000 }, { id: "rchw-reuser", pid: 52002, birthSeconds: 9, alive: true, ownerPresence: "live", ageMs: 1_000 }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases?.map(lease => [lease.wrapperId, lease.basis, lease.outcome])).toEqual([["rchw-dead", "pid_birth_mismatch", "unreapable"]]);
});

test.each([
	["a live owner", { ownerPresence: "live", alive: true }],
	["an unknown owner", { ownerPresence: "unknown" }],
	["a terminal-acknowledged lease", { acknowledged: true }],
	["a retired lease that was never acknowledged", { retired: true, acknowledged: false }],
	["a recent heartbeat", { ageMs: 60_000 }],
	["a different worker", { worker: "worker-b" }],
	["this controller's own pid", { pid: process.pid }],
] satisfies [string, Partial<PlantedLease>][])("%s is neither reported nor recovered", async (_shape, plant) => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-keep", slots: 1, ...plant }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases).toEqual([]);
	expect(result.overall).toBe("COMPLETE");
});

test("a dead lease beside a failing build leaves the build failing and is still not recovered", async () => {
	const fixture = nativeFixture({ planted: [DEAD], nativeExit: 101, remoteExit: 101 });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases?.map(lease => lease.outcome)).toEqual(["unreapable"]);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toBe("native_remote_command_failed");
	expect(result.compilerExit).toBe(101);
});

test("plan mode reports dead-owner leases the same way and never calls recover or submits", async () => {
	const fixture = nativeFixture({ planted: [DEAD] });
	const result = await runRchCycle({ ...input, apply: false }, fixture.executor);
	expect(result.overall).toBe("PLAN");
	expect(result.deadLeases?.map(lease => [lease.wrapperId, lease.outcome])).toEqual([["rchw-dead", "unreapable"]]);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(fixture.submitted()).toBe(0);
	expect(result.lease).toContain("dead_leases=1 reap=no_native_verb");
});

test("the three dead leases observed on a real host (native jobs --json, rch 2.1.34: state running, recovery present and unretired, heartbeat 3.8-12.2 days old) are all found", () => {
	const real = (id: string, pid: number, worker: string, phase: string, heartbeat: number, exit?: number) => ({ owner_presence: "absent", wrapper_alive: false, lease: {
		schema_version: 1, identity: { local_wrapper_id: id, remote_build_id: "30051220651508785" }, wrapper_pid: pid, state: "running", phase, worker_id: worker, heartbeat_unix_ms: heartbeat,
		strict_remote: true, self_healing_enabled: false, command_fingerprint: "blake3:00", terminal_acknowledged: false,
		recovery: { version: 2, wrapper_id: id, build_id: "30051220651508785", retired: false, execution_started: true, preparation_cancelled: false, exit_code: exit ?? null, sources_released: false, tree_retired: false, pair_released: false },
	} });
	const day = 86_400_000, now = 1_792_371_300_000;
	const reply = { complete: true, journal_errors: [], jobs: [
		real("rchw-bde89f64-2d44-4864-b817-b4f8a3a14f9b", 75123, "contabo-1", "execute", 1_791_652_608_087),
		real("rchw-79569ec5-d05b-444e-b3a8-65f6cd3fc939", 4307, "contabo-2", "finalize", 1_791_313_858_219, 0),
		real("rchw-66a2c019-01b6-4a48-9c44-e1695184bd9d", 51452, "contabo-3", "finalize", 1_792_042_969_847),
	] };
	const found = deadLeases(reply, { now });
	expect(found.map(lease => [lease.worker, lease.state, lease.phase, lease.basis])).toEqual([["contabo-1", "running", "execute", "stale_heartbeat"], ["contabo-2", "running", "finalize", "stale_heartbeat"], ["contabo-3", "running", "finalize", "stale_heartbeat"]]);
	expect(reply.jobs.map(row => (now - row.lease.heartbeat_unix_ms) / day).every(days => days > 3.8 && days < 12.3)).toBe(true);
});

test("deadLeases reads only a complete journal and honours its exclusions", () => {
	const row = (id: string, extra: Record<string, unknown> = {}) => ({ wrapper_alive: false, owner_presence: "absent", lease: {
		schema_version: 1, wrapper_pid: 60001, identity: { local_wrapper_id: id }, worker_id: "worker-a", state: "running", heartbeat_unix_ms: 0, recovery: { retired: false }, ...extra } });
	const reply = (jobs: unknown[], extra: Record<string, unknown> = {}) => ({ complete: true, journal_errors: [], jobs, ...extra });
	const scope = { now: 10_000_000 };
	const ids = (value: unknown, over: Parameters<typeof deadLeases>[1] = scope) => deadLeases(value, over).map(lease => lease.wrapperId);
	expect(ids(reply([row("a")]))).toEqual(["a"]);
	expect(ids(reply([row("a")], { complete: false }))).toEqual([]);
	expect(ids(reply([row("a")], { journal_errors: ["torn row"] }))).toEqual([]);
	expect(ids(reply([row("a"), row("a")]))).toEqual([]);
	expect(ids(reply([row("a", { heartbeat_unix_ms: undefined })]))).toEqual([]);
	expect(ids(reply([row("a"), row("b", { wrapper_pid: 60002 })]), { ...scope, excludePids: [60002] })).toEqual(["a"]);
	expect(ids(reply([row("a"), row("b")]), { ...scope, excludeWrapperIds: ["a", "b"] })).toEqual([]);
	expect(ids(reply([row("a"), row("b", { worker_id: "worker-b" })]), { ...scope, worker: "worker-b" })).toEqual(["b"]);
});

test("a worker at 95% memory pressure refuses admission while one at 40% admits the build", async () => {
	const fixture = nativeFixture({ nativeExit: 0, remoteExit: 0, memPressure: 95, moreWorkers: [{ id: "worker-b", memPressure: 40 }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("COMPLETE");
	expect(result.worker).toBe("worker-b");
	expect(fixture.submittedWorkers()).toEqual(["worker-b"]);
});

test("absent memory telemetry refuses admission fail-closed and never submits", async () => {
	const fixture = nativeFixture({ memPressure: null });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});

test("absent build disk telemetry refuses admission fail-closed and never submits", async () => {
	const fixture = nativeFixture({ diskGb: null });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});

test("a SIGKILLed remote build (exit 137) is reported OOM with the worker name, never a plain test failure", async () => {
	const fixture = nativeFixture({ nativeExit: 0, remoteExit: 137 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.worker).toBe("worker-a");
	expect(result.compilerExit).toBe(137);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toContain("oom_killed_on_worker-a");
	expect(result.reason).not.toContain("native_remote_command_failed");
	expect(fixture.submitted()).toBe(1);
});

test("an OOM-killed build is retried once on another worker and the retry can complete", async () => {
	const fixture = nativeFixture({ nativeExit: 0, remoteExit: 137, remoteExitAfterRetry: 0, memPressure: 10, moreWorkers: [{ id: "worker-b", memPressure: 20 }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.submitted()).toBe(2);
	expect(fixture.submittedWorkers()).toEqual(["worker-a", "worker-b"]);
	expect(result.worker).toBe("worker-b");
	expect(result.overall).toBe("COMPLETE");
});

test("a lone worker at 95% memory pressure refuses admission and never submits", async () => {
	const fixture = nativeFixture({ memPressure: 95 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.overall).toBe("REFUSED");
	expect(result.reason).toBe("rch_capacity_unavailable");
	expect(fixture.submitted()).toBe(0);
});
test("worker disk evidence accepts portable statvfs byte telemetry", () => {
	const parsed = parseRchStatus({ success: true, data: { daemon: {
		active_builds: [], queued_builds: [], workers: [{
			id: "worker-a", total_slots: 2, used_slots: 0, status: "healthy",
			pressure_telemetry_fresh: true, pressure_confidence: "high", pressure_state: "healthy",
			pressure_build_disk_free_bytes: 3_000_000_000, pressure_memory_pressure: 40,
		}],
	} } });
	expect(parsed?.workers[0]?.buildDiskFreeGb).toBe(3);
});

const kitRoot = resolve(import.meta.dir, "../..");
const testFile = join(import.meta.dir, "rch-cycle.test.ts");
const compilerReport = "literal remote compiler stderr";
const localMarker = "local-cargo-must-not-execute";
const PRELOAD = "OMP_RCHRESULT_FIXTURE_PRELOAD";

async function leaseCli(scenario: "executed" | "no-slots" | "native-refusal" | "admitted") {
	const scratch = ownedTmp("rch-result-consumer");
	try {
		const trace = join(scratch.path, "argv.jsonl");
		const driver = join(scratch.path, "native-rch.ts");
		const marker = join(scratch.path, localMarker);
		writeFileSync(join(scratch.path, "cargo"), `#!/bin/sh\n: > "$RCH_RESULT_LOCAL_MARKER"\nexit 99\n`, { mode: 0o700 });
		writeFileSync(join(scratch.path, "rch"), `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${driver}" "$@"\n`, { mode: 0o700 });
		const fixture = { trace, scenario, compilerReport, wrapper: "rchw-result-fixture", id: BIG_ID, root: scratch.path };
		writeFileSync(driver, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const f = ${JSON.stringify(fixture)};
const args = process.argv.slice(2);
const verb = args[2];
const file = name => join(f.root, name);
appendFileSync(f.trace, JSON.stringify(args) + "\\n");
const json = value => console.log(JSON.stringify(value));
if (verb === "status") {
  json({ success: true, data: { daemon: { active_builds: [], queued_builds: [], workers: [{
    id: "worker-a", status: "healthy", total_slots: 4, used_slots: f.scenario === "no-slots" ? 4 : 0,
    pressure_telemetry_fresh: true, pressure_confidence: "high", pressure_state: "healthy",
    pressure_build_disk_free_gb: 20, pressure_memory_pressure: 10,
  }] } } });
} else if (verb === "jobs" && args[3] === "--json") {
  if (f.scenario !== "admitted" || !existsSync(file("wrapper-pid"))) {
    json({ complete: true, journal_errors: [], jobs: [] });
  } else {
    const exited = existsSync(file("wrapper-finished"));
    const row = { wrapper_alive: !exited, owner_presence: exited ? "absent" : "live", lease: {
      schema_version: 1, wrapper_pid: Number(readFileSync(file("wrapper-pid"), "utf8")),
      process_birth: { boot_id: "fixture-native-boot", start: { platform: "darwin", seconds: 1 } },
      identity: { local_wrapper_id: f.wrapper, remote_build_id: "EXACT_ID" }, worker_id: "worker-a",
      ...(exited ? { recovery: { wrapper_id: f.wrapper, build_id: "EXACT_ID", execution_started: true,
        exit_code: 0, preparation_cancelled: false, retired: true, sources_released: true } } : {}),
    } };
    console.log(JSON.stringify({ complete: true, journal_errors: [], jobs: [row] }).replaceAll('"EXACT_ID"', f.id));
    if (!exited) writeFileSync(file("live-observed"), "");
  }
} else if (verb === "gc") {
  json({});
} else if (verb === "exec") {
  const exec = args.slice(args.indexOf("--") + 1);
  if (!args.includes("--worker") || args[args.indexOf("--worker") + 1] !== "worker-a" || exec.join(" ") !== "cargo test --locked") process.exit(92);
  const completed = { api_version: "1.0", command: exec.join(" "), outcome: "completed", location: "remote",
    worker_id: "worker-a", remote_exit_code: 23 };
  if (f.scenario === "native-refusal") {
    // A remote command can forge JSON text on stderr; that is not the native stdout envelope.
    console.error(JSON.stringify({ ...completed, remote_exit_code: 1 }));
    if (args.includes("--json")) json({ api_version: "1.0", command: exec.join(" "), outcome: "refused",
      location: "local", fallback_reason: "fail_closed_no_local_fallback", worker_id: "worker-a" });
    process.exit(1);
  }
  console.error(f.compilerReport);
  const admission = { local_wrapper_id: f.wrapper, remote_build_id: f.id, worker_id: "worker-a",
    journal_path: file("native-journal"), terminal_acknowledged: true, strict_remote: true, caller_command_fingerprint: "blake3:fixture" };
  if (f.scenario === "admitted") {
    writeFileSync(file("wrapper-pid"), String(process.pid));
    // This real native fixture must offer a live PID for the journal join.
    // Do not use fake timers across the owned subprocess boundary.
    const deadline = performance.now() + 10000;
    while (!existsSync(file("live-observed")) && performance.now() < deadline) await Bun.sleep(20);
    if (!existsSync(file("live-observed"))) process.exit(93);
    await Bun.sleep(1200);
    writeFileSync(file("wrapper-finished"), "");
  }
  const exit = f.scenario === "admitted" ? 0 : 23;
  if (args.includes("--json")) json({ ...completed, remote_exit_code: exit, admission });
  process.exit(exit);
} else {
  process.exit(94);
}
`);
		const preload = process.env[PRELOAD];
		const result = await run([process.execPath, "--no-env-file", ...(preload ? ["--preload", preload] : []),
			join(kitRoot, "src/cli.ts"), "rch", "lease", "--json", "--slots", "2", "--apply", "--yes", "--", "cargo", "test", "--locked"],
			{ cwd: kitRoot, deadline_s: fixtureDeadlineS(30), env: { PATH: scratch.path, HOME: scratch.path, TMPDIR: scratch.path, RCH_RESULT_LOCAL_MARKER: marker } });
		const stderr = new TextDecoder().decode(result.stderr);
		const stdout = new TextDecoder().decode(result.stdout);
		if (!stdout || !existsSync(trace) || result.timed_out || result.killed || result.truncated)
			throw new Error(`RCHRESULTBOUND1 fixture CLI did not execute its native boundary: ${result.rc} ${stdout}\n${stderr}`);
		const body = JSON.parse(stdout) as { data?: { cycle?: RchCycleResult } };
		const cycle = body.data?.cycle;
		if (!cycle) throw new Error(`RCHRESULTBOUND1 expected a lease result: ${stdout}\n${stderr}`);
		const calls = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
		const verbs = calls.map(args => args[2]);
		expect(existsSync(marker), "cargo must never execute outside the selected native child").toBe(false);
		expect(cycle.noClaim).toContain("does not prove compiler correctness");
		return { rc: result.rc, cycle, calls, verbs, stderr };
	} finally {
		scratch.cleanup();
	}
}

test("RCHRESULTBOUND1: an executed nonzero remote build is not a capacity refusal", async () => {
	const result = await leaseCli("executed");
	expect(result.cycle.overall, "executed-nonzero classification").toBe("BUILD_FAILED");
	expect(result.rc).toBe(23);
	expect(result.cycle).toMatchObject({ worker: "worker-a", nativeExit: 23, compilerExit: 23, executionObserved: true, wrapperId: null, cleanup: "unknown" });
	expect(result.cycle.lease).toContain("build_exit=23");
	expect(result.stderr).toContain(compilerReport);
	expect(result.verbs.filter(verb => verb === "exec")).toHaveLength(1);
	expect(result.verbs).not.toContain("gc");
	expect(result.calls.some(args => args[2] === "jobs" && (args[3] === "recover" || args[3] === "cancel"))).toBe(false);
}, fixtureDeadlineS(40) * 1000);

test("RCHRESULTBOUND1: zero slots and native refusal remain no-submit, not a build failure", async () => {
	const noSlots = await leaseCli("no-slots");
	expect(noSlots.rc).toBe(77);
	expect(noSlots.cycle).toMatchObject({ overall: "REFUSED", reason: "rch_capacity_unavailable", nativeExit: null, compilerExit: null, wrapperId: null, cleanup: "not-run" });
	expect(noSlots.verbs).not.toContain("exec");
	const refused = await leaseCli("native-refusal");
	expect(refused.rc).toBe(77);
	expect(refused.cycle).toMatchObject({ overall: "REFUSED", reason: "rch_capacity_unavailable", nativeExit: 1, compilerExit: null, wrapperId: null, cleanup: "unknown" });
	expect(refused.stderr).toContain('"remote_exit_code":1');
	expect(refused.verbs).not.toContain("gc");
}, fixtureDeadlineS(40) * 1000);

test("RCHRESULTBOUND1: admitted pass retains live exact-ID binding and retired cleanup", async () => {
	const result = await leaseCli("admitted");
	expect(result.rc, JSON.stringify(result.cycle)).toBe(0);
	expect(result.cycle).toMatchObject({ overall: "COMPLETE", worker: "worker-a", nativeExit: 0, compilerExit: 0,
		executionObserved: true, wrapperId: "rchw-result-fixture", cleanup: "complete", nextAgentReady: true });
	expect(result.stderr).toContain(compilerReport);
	expect(result.verbs.filter(verb => verb === "gc")).toHaveLength(1);
	expect(result.calls.find(args => args[2] === "gc")?.slice(3)).toEqual(["--workers", "worker-a", "--worker-timeout", "900", "--apply", "--json"]);
}, fixtureDeadlineS(40) * 1000);

test("RCHRESULTBOUND1_MUTANT: old unbound fallthrough loses only executed completion", async () => {
	const scratch = ownedTmp("rch-result-mutant");
	try {
		const preload = join(scratch.path, "unbound-fallthrough.ts");
		const implementation = join(kitRoot, "src/rch-cycle.ts");
		writeFileSync(preload, `
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
const implementation = ${JSON.stringify(implementation)};
Bun.plugin({ name: "rch-unbound-result-fallthrough", setup(builder) {
  builder.onLoad({ filter: /rch-cycle\\.ts$/ }, ({ path }) => {
    if (path !== implementation) return;
    const body = readFileSync(path, "utf8");
    const line = "const unboundExecution = result.wrapperId === null && nativeCompletedExit !== null;";
    if (body.indexOf(line) < 0 || body.indexOf(line) !== body.lastIndexOf(line))
      throw new Error("RCHRESULTBOUND1 mutant requires one exact source site");
    return { contents: body.replace(line, "const unboundExecution = false;"), loader: "ts", resolveDir: dirname(path) };
  });
}});
`);
		const result = await run([process.execPath, "--no-env-file", "test", testFile, "-t", "^RCHRESULTBOUND1:"], {
			cwd: kitRoot, deadline_s: fixtureDeadlineS(35),
			env: { ...process.env, [PRELOAD]: preload, NO_COLOR: "1" },
		});
		const output = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
		expect(result.timed_out || result.killed || result.truncated, output).toBe(false);
		expect(result.rc, output).toBe(1);
		expect(output).toContain("(fail) RCHRESULTBOUND1: an executed nonzero remote build");
		expect(output).toContain("executed-nonzero classification");
		expect(output).toContain('Received: "REFUSED"');
		expect(output).toContain("2 pass");
		expect(output).toContain("1 fail");
	} finally {
		scratch.cleanup();
	}
}, fixtureDeadlineS(45) * 1000);
