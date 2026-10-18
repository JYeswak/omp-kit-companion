import { expect, test } from "bun:test";
import { runRchCycle, type NativeRchResult, type RchExecutor } from "../../src/rch-cycle.ts";

// The native boundary is injected: these tests must never submit remote work or mutate real caches.
function nativeFixture(options: { freeBefore?: number; freeAfter?: number; nativeExit?: number; remoteExit?: number; executed?: boolean; gcExit?: number; health?: string; fresh?: boolean; cancelled?: boolean; ownerPresence?: string; journalWorker?: string; delayedJournal?: boolean } = {}) {
	let submitted = 0, running = false, remoteRunning = false, statusReads = 0, journalReads = 0;
	let finish: (value: NativeRchResult) => void = () => { throw new Error("build not started"); };
	const status = () => ({ success: true, data: { daemon: { active_builds: [], queued_builds: [], workers: [{
		id: "worker-a", status: options.health ?? "healthy", total_slots: statusReads++ === 0 ? options.freeBefore ?? 4 : options.freeAfter ?? 4,
		used_slots: 0, pressure_telemetry_fresh: options.fresh ?? true, pressure_confidence: "high", pressure_state: "healthy", pressure_build_disk_free_gb: 20,
	}] } } });
	const executor: RchExecutor = {
		async capture(args) {
			let value: unknown;
			if (args[0] === "jobs" && args[1] === "cancel") {
				if (args[2] !== "rchw-fixture") throw new Error("Refusing cancellation of an unrelated native job");
				remoteRunning = false;
				return { exit: 0, state: "exited", stdout: "{}" };
			}
			if (args[0] === "status") value = status();
			else if (args[0] === "gc") return { exit: options.gcExit ?? 0, state: "exited", stdout: "{}" };
			else if (args[0] === "jobs") {
				if (running && options.delayedJournal && journalReads++ === 0) return { exit: 0, state: "exited", stdout: JSON.stringify({ complete: true, journal_errors: [], jobs: [] }) };
				value = { complete: true, journal_errors: [], jobs: [{ wrapper_alive: running, owner_presence: running ? options.ownerPresence ?? "live" : "absent", lease: {
					schema_version: 1, wrapper_pid: 41001, boot_id: "fixture-boot", process_birth: { boot_id: "fixture-boot", start: { platform: "darwin", seconds: 1, microseconds: 2 } },
					identity: { local_wrapper_id: "rchw-fixture", remote_build_id: 41 }, worker_id: options.journalWorker ?? "worker-a", state: running ? "running" : "finished",
					recovery: { wrapper_id: "rchw-fixture", build_id: 41, execution_started: options.executed ?? true, preparation_cancelled: options.executed === false,
						exit_code: remoteRunning ? null : options.remoteExit ?? options.nativeExit ?? 0, retired: !remoteRunning, sources_released: !remoteRunning },
				} }] };
			} else throw new Error("Unexpected native operation");
			return { exit: 0, state: "exited", stdout: JSON.stringify(value) };
		},
		build() {
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
	return { executor, submitted: () => submitted, remoteActive: () => remoteRunning };
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
