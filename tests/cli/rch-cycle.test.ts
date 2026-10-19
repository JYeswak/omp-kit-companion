import { expect, test } from "bun:test";
import { deadLeases, runRchCycle, type NativeRchResult, type RchExecutor } from "../../src/rch-cycle.ts";

// A real remote_build_id from replay 3 (ev_30924d59) and its neighbour: both above Number.MAX_SAFE_INTEGER, both parse to the same double.
const BIG_ID = "30068411341996668", BIG_ID_NEIGHBOUR = "30068411341996667";

// A journaled lease planted beside the run under test. Defaults: owner absent, heartbeat an hour old, running/finalize, unretired, holding `slots` pool slots until recovered.
interface PlantedLease { id: string; worker?: string; pid?: number; birthSeconds?: number; alive?: boolean; ownerPresence?: string; ageMs?: number; acknowledged?: boolean; retired?: boolean; slots?: number }

// The native boundary is injected: these tests must never submit remote work or mutate real caches.
function nativeFixture(options: { freeBefore?: number; freeAfter?: number; nativeExit?: number; remoteExit?: number; executed?: boolean; gcExit?: number; health?: string; fresh?: boolean; cancelled?: boolean; ownerPresence?: string; journalWorker?: string; delayedJournal?: boolean; executionStarted?: boolean; admissionRefused?: boolean; noRecovery?: boolean; rawIds?: [remote: string, build: string]; transport?: boolean; planted?: PlantedLease[]; recoverFails?: "exit" | "noop" } = {}) {
	let submitted = 0, running = false, remoteRunning = false, statusReads = 0, journalReads = 0, recovered = false;
	const planted = options.planted ?? [], recoverCalls: string[] = [], reapedIds = new Set<string>();
	const plantedDone = (lease: PlantedLease) => lease.retired === true || reapedIds.has(lease.id);
	const plantedRow = (lease: PlantedLease) => ({ wrapper_alive: lease.alive ?? false, owner_presence: lease.ownerPresence ?? "absent", lease: {
		schema_version: 1, wrapper_pid: lease.pid ?? 52001, boot_id: "fixture-boot", process_birth: { boot_id: "fixture-boot", start: { platform: "darwin", seconds: lease.birthSeconds ?? 1, microseconds: 3 } },
		identity: { local_wrapper_id: lease.id, remote_build_id: 52 }, worker_id: lease.worker ?? "worker-a", state: plantedDone(lease) ? "finished" : "running", phase: plantedDone(lease) ? "finished" : "finalize",
		heartbeat_unix_ms: Date.now() - (lease.ageMs ?? 3_600_000), terminal_acknowledged: lease.acknowledged ?? plantedDone(lease),
		recovery: { wrapper_id: lease.id, build_id: 52, execution_started: true, preparation_cancelled: false, exit_code: null, retired: plantedDone(lease), sources_released: plantedDone(lease) },
	} });
	let finish: (value: NativeRchResult) => void = () => { throw new Error("build not started"); };
	const status = () => ({ success: true, data: { daemon: { active_builds: [], queued_builds: [], workers: [{
		id: "worker-a", status: options.health ?? "healthy", total_slots: statusReads++ === 0 ? options.freeBefore ?? 4 : options.freeAfter ?? 4,
		used_slots: planted.reduce((used, lease) => used + (plantedDone(lease) ? 0 : lease.slots ?? 0), 0), pressure_telemetry_fresh: options.fresh ?? true, pressure_confidence: "high", pressure_state: "healthy", pressure_build_disk_free_gb: 20,
	}] } } });
	const executor: RchExecutor = {
		async capture(args) {
			let value: unknown;
			if (args[0] === "jobs" && args[1] === "cancel") {
				if (args[2] !== "rchw-fixture") throw new Error("Refusing cancellation of an unrelated native job");
				remoteRunning = false;
				return { exit: 0, state: "exited", stdout: "{}" };
			}
			if (args[0] === "jobs" && args[1] === "recover" && planted.some(lease => lease.id === args[2])) {
				recoverCalls.push(args[2] ?? "");
				if (options.recoverFails === "exit") return { exit: 1, state: "exited", stdout: "" };
				if (options.recoverFails !== "noop") reapedIds.add(args[2] ?? "");
				return { exit: 0, state: "exited", stdout: "{}" };
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
					identity: { local_wrapper_id: "rchw-fixture", remote_build_id: options.rawIds ? "RAWREMOTE" : 41 }, worker_id: options.journalWorker ?? "worker-a", state: running ? "running" : "finished",
					...(options.noRecovery && !recovered ? {} : { recovery: { wrapper_id: "rchw-fixture", build_id: options.rawIds ? "RAWBUILD" : 41, execution_started: options.executionStarted ?? options.executed ?? true, preparation_cancelled: options.executed === false,
						exit_code: options.transport || remoteRunning ? null : options.remoteExit ?? options.nativeExit ?? 0, retired: !remoteRunning, sources_released: !remoteRunning } }),
				} }] };
			} else throw new Error("Unexpected native operation");
			// rch prints pretty JSON ("key": value). Real ids are 64-bit integers written as raw digits; JSON.stringify cannot produce them from a double.
			let text = JSON.stringify(value, null, 2);
			if (options.rawIds) text = text.replace('"RAWREMOTE"', options.rawIds[0]).replace('"RAWBUILD"', options.rawIds[1]).replaceAll('"NEIGHBOUR"', BIG_ID_NEIGHBOUR);
			return { exit: 0, state: "exited", stdout: text };
		},
		build() {
			if (options.admissionRefused) {
				// Native admission refusal (RCH-I003/RCH-I001): no wrapper is ever journaled and nothing runs remotely.
				return { pid: 0, alive: () => false, result: Promise.resolve({ exit: 1, state: "exited", stdout: "" } as NativeRchResult) };
			}
			submitted++; running = true; remoteRunning = true;
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
	return { executor, submitted: () => submitted, remoteActive: () => remoteRunning, recoverCalls: () => recoverCalls };
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

const DEAD: PlantedLease = { id: "rchw-dead", slots: 3 };

test("a dead-owner lease holding the pool's slots is recovered through the native call, reported reaped, and its slots return to the pool", async () => {
	const fixture = nativeFixture({ planted: [DEAD] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual(["rchw-dead"]);
	expect(result.deadLeases).toEqual([{ wrapperId: "rchw-dead", worker: "worker-a", pid: 52001, state: "running", phase: "finalize", basis: "stale_heartbeat", outcome: "reaped" }]);
	expect(result.before?.workers[0]?.free).toBe(1);
	expect(result.after?.workers[0]?.free).toBe(4);
	expect(fixture.submitted()).toBe(1);
	expect(result.overall).toBe("COMPLETE");
	expect(result.lease).toContain("dead_leases=1 reaped=1");
});

test("a dead lease whose pid is now held by a live wrapper with a different process start time is reaped even with a fresh heartbeat; the live holder is untouched", async () => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-dead", pid: 52002, ageMs: 1_000 }, { id: "rchw-reuser", pid: 52002, birthSeconds: 9, alive: true, ownerPresence: "live", ageMs: 1_000 }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual(["rchw-dead"]);
	expect(result.deadLeases?.map(lease => [lease.wrapperId, lease.basis, lease.outcome])).toEqual([["rchw-dead", "pid_birth_mismatch", "reaped"]]);
});

test.each([
	["a live owner", { ownerPresence: "live", alive: true }],
	["an unknown owner", { ownerPresence: "unknown" }],
	["a terminal-acknowledged lease", { acknowledged: true }],
	["a retired lease that was never acknowledged", { retired: true, acknowledged: false }],
	["a recent heartbeat", { ageMs: 60_000 }],
	["a different worker", { worker: "worker-b" }],
	["this controller's own pid", { pid: process.pid }],
] satisfies [string, Partial<PlantedLease>][])("%s is never recovered", async (_shape, plant) => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-keep", slots: 1, ...plant }] });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(result.deadLeases).toEqual([]);
	expect(result.overall).toBe("COMPLETE");
});

test.each(["exit", "noop"] as const)("a failed dead-lease recover (%s) is reported reap_failed and leaves a passing run passing", async recoverFails => {
	const baseline = await runRchCycle(input, nativeFixture().executor);
	const fixture = nativeFixture({ planted: [{ id: "rchw-dead", slots: 1 }], recoverFails });
	const result = await runRchCycle(input, fixture.executor);
	expect(fixture.recoverCalls()).toEqual(["rchw-dead"]);
	expect(result.deadLeases?.map(lease => lease.outcome)).toEqual(["reap_failed"]);
	expect([result.overall, result.reason]).toEqual([baseline.overall, baseline.reason]);
	expect(result.overall).toBe("COMPLETE");
	expect(result.lease).toContain("dead_leases=1 reaped=0");
});

test("a failed dead-lease recover leaves a failing build failing", async () => {
	const fixture = nativeFixture({ planted: [{ id: "rchw-dead", slots: 1 }], recoverFails: "exit", nativeExit: 101, remoteExit: 101 });
	const result = await runRchCycle(input, fixture.executor);
	expect(result.deadLeases?.map(lease => lease.outcome)).toEqual(["reap_failed"]);
	expect(result.overall).toBe("BUILD_FAILED");
	expect(result.reason).toBe("native_remote_command_failed");
	expect(result.compilerExit).toBe(101);
});

test("plan mode reports dead-owner leases and never calls recover or submits", async () => {
	const fixture = nativeFixture({ planted: [DEAD] });
	const result = await runRchCycle({ ...input, apply: false }, fixture.executor);
	expect(result.overall).toBe("PLAN");
	expect(result.deadLeases?.map(lease => [lease.wrapperId, lease.outcome])).toEqual([["rchw-dead", "plan_only"]]);
	expect(fixture.recoverCalls()).toEqual([]);
	expect(fixture.submitted()).toBe(0);
	expect(result.lease).toContain("dead_leases=1 reaped=0");
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
