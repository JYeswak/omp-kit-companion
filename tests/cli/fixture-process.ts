import { availableParallelism, loadavg } from "node:os";
import { run, runSync, type RunResult } from "../../src/kitlib/run.ts";

export function fixtureLoad(): { load1: number; ncpu: number; factor: number; workers: string } {
	const load1 = loadavg()[0] ?? 0;
	const ncpu = availableParallelism();
	return {
		load1, ncpu, factor: Math.max(1, Math.min(4, load1 / ncpu * 4)),
		workers: process.env.OMP_KIT_TEST_WORKERS ?? "unreported",
	};
}

export function fixtureDeadlineS(floorS = 10, load = fixtureLoad()): number {
	return floorS * load.factor;
}

interface FixtureOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	stdin?: string | Uint8Array;
	floor_s?: number;
	label?: string;
	planted_sleep_s?: number;
}

function prepareFixture(argv: readonly string[], options: FixtureOptions) {
	const load = fixtureLoad();
	const deadlineS = fixtureDeadlineS(options.floor_s, load);
	const plantedSleepS = options.planted_sleep_s ?? 0;
	if (!Number.isFinite(plantedSleepS) || plantedSleepS < 0)
		throw new RangeError(`planted_sleep_s must be a non-negative finite number, got ${plantedSleepS}`);
	// Validate before wrapping: otherwise an empty argv becomes a successful Python run.
	if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== "string"))
		throw new TypeError("runFixture needs a non-empty argv of strings");
	// One leader sleeps then replaces itself: runSync kills only the leader, not a process group.
	// Never background a shell sleep here, which would leave a descendant after a timeout.
	const command = plantedSleepS > 0
		? ["python3", "-c", "import os,sys,time; time.sleep(float(sys.argv[1])); os.execvp(sys.argv[2], sys.argv[2:])", String(plantedSleepS * load.factor), ...argv]
		: argv;
	let env: Record<string, string> | undefined;
	if (options.env !== undefined) {
		env = {};
		for (const [key, value] of Object.entries(options.env))
			if (value !== undefined) env[key] = value;
	}
	return {
		command, load, deadlineS, plantedSleepS,
		label: options.label ?? argv[0],
		runOptions: { cwd: options.cwd, env, stdin: options.stdin, deadline_s: deadlineS },
	};
}

type FixtureContext = {
	load: { load1: number; ncpu: number; factor: number; workers: string };
	deadlineS: number;
	plantedSleepS: number;
	label: string;
};

function finishFixture(result: RunResult, context: FixtureContext): RunResult {
	const { load, deadlineS, plantedSleepS, label } = context;
	if (result.timed_out) {
		// JSON escaping keeps the diagnostic one line; cause retains original output bytes and status.
		throw Object.assign(new Error(`TIMEOUT_UNDER_LOAD label=${JSON.stringify(label)} `
			+ `deadline_s=${deadlineS} elapsed_s=${result.elapsed_s} loadavg=${load.load1} ncpu=${load.ncpu} `
			+ `workers=${JSON.stringify(load.workers)} planted_sleep_s=${plantedSleepS} `
			+ `stderr=${JSON.stringify(new TextDecoder().decode(result.stderr))}`), { cause: result });
	}
	return result;
}

/** Retains runSync's leader-only timeout semantics; use async when group cancellation is required. */
export function runFixture(argv: readonly string[], options: FixtureOptions): RunResult {
	const context = prepareFixture(argv, options);
	return finishFixture(runSync(context.command, context.runOptions), context);
}

/** Retains kitlib run's process-group ownership and asynchronous pipe draining. */
export async function runFixtureAsync(argv: readonly string[], options: FixtureOptions): Promise<RunResult> {
	const context = prepareFixture(argv, options);
	return finishFixture(await run(context.command, context.runOptions), context);
}
