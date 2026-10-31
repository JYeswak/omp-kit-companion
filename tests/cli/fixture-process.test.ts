import { expect, test } from "bun:test";
import { fixtureDeadlineS, fixtureLoad, runFixture, runFixtureAsync } from "./fixture-process";
import type { RunResult } from "../../src/kitlib/run";

const cwd = process.cwd();

test("fixture deadlines keep the quiet floor and bounded load policy", () => {
	for (const factor of [1, 2, 4]) {
		const load = { load1: factor, ncpu: 4, factor, workers: "2" };
		expect(fixtureDeadlineS(undefined, load)).toBe(10 * factor);
		expect(fixtureDeadlineS(3, load)).toBe(3 * factor);
	}
	const load = fixtureLoad();
	expect(load.ncpu).toBeGreaterThan(0);
	expect(load.factor).toBe(Math.max(1, Math.min(4, load.load1 / load.ncpu * 4)));
});

test("fixture commands retain stdout, stderr, cwd, environment and nonzero status", () => {
	const result = runFixture(["python3", "-c", 'import os,sys; print(os.getcwd()); print(os.environ["FIXTURE_VALUE"]); sys.stderr.write("assertion failed\\n"); sys.exit(7)'], {
		cwd, env: { ...process.env, FIXTURE_VALUE: "actual value" },
	});
	expect(result.rc).toBe(7);
	expect(result.timed_out).toBe(false);
	expect(new TextDecoder().decode(result.stdout)).toBe(`${cwd}\nactual value\n`);
	expect(new TextDecoder().decode(result.stderr)).toBe("assertion failed\n");
});

test("real deadline expiry reports machine context and retains original stderr", () => {
	let failure: unknown;
	try {
		runFixture(["python3", "-c", 'import sys,time; sys.stderr.write("before timeout\\n"); sys.stderr.flush(); time.sleep(5)'], {
			cwd, floor_s: 0.2, label: "deadline\ncase",
		});
	} catch (error) { failure = error; }
	expect(failure).toBeInstanceOf(Error);
	const error = failure as Error;
	expect(error.message).toMatch(/^TIMEOUT_UNDER_LOAD /);
	expect(error.message).toContain('label="deadline\\ncase"');
	expect(error.message).toMatch(/deadline_s=[\d.]+ elapsed_s=[\d.]+ loadavg=[\d.]+ ncpu=\d+ workers=/);
	expect(error.message).not.toContain("\n");
	const result = (error as Error & { cause: RunResult }).cause;
	expect(result.timed_out).toBe(true);
	expect(new TextDecoder().decode(result.stderr)).toBe("before timeout\n");
});

test("finite planted delay executes the original argv without shell interpolation", () => {
	const result = runFixture(["python3", "-c", "import sys; print(sys.argv[1])", "literal $HOME ; quote'"], {
		cwd, floor_s: 2, planted_sleep_s: 0.01,
	});
	expect(result.rc).toBe(0);
	expect(new TextDecoder().decode(result.stdout)).toBe("literal $HOME ; quote'\n");
});

test("invalid planted delays are rejected before launching a command", () => {
	for (const planted_sleep_s of [-1, Infinity, NaN]) {
		expect(() => runFixture(["python3", "-c", "pass"], { cwd, planted_sleep_s })).toThrow("planted_sleep_s");
	}
});

test("async fixtures retain command failure and classify real expiry", async () => {
	const result = await runFixtureAsync(["python3", "-c", 'import sys; print("async output"); sys.stderr.write("async failure\\n"); sys.exit(9)'], { cwd });
	expect(result.rc).toBe(9);
	expect(result.timed_out).toBe(false);
	expect(new TextDecoder().decode(result.stdout)).toBe("async output\n");
	expect(new TextDecoder().decode(result.stderr)).toBe("async failure\n");
	await expect(runFixtureAsync(["python3", "-c", "import time; time.sleep(5)"], {
		cwd, floor_s: 0.2, label: "async expiry",
	})).rejects.toThrow("TIMEOUT_UNDER_LOAD");
});
