import { expect, test } from "bun:test";
import { run, runSync } from "../../src/kitlib/run";
import { fixtureDeadlineS } from "./fixture-process";

const argv = [process.execPath, "-e", "process.stdout.write('control')"];

test("run refuses unknown options before attempting a spawn", async () => {
	for (const key of ["unknown_option", "timeout", "toString"]) {
		await expect(run(["/no-such-stdindrop-child"], { deadline_s: fixtureDeadlineS(), [key]: true })).rejects.toThrow(`unknown option ${key}`);
	}
	const symbol = Symbol("unknown_option");
	await expect(run(argv, { deadline_s: fixtureDeadlineS(), [symbol]: true })).rejects.toThrow(String(symbol));
});

test("runSync refuses unknown options including async-only stdin", () => {
	for (const key of ["unknown_option", "stdin", "signal", "toString"]) {
		expect(() => runSync(["/no-such-stdindrop-child"], { deadline_s: fixtureDeadlineS(), [key]: undefined })).toThrow(`unknown option ${key}`);
	}
	const options = Object.defineProperty({ deadline_s: fixtureDeadlineS() }, "unknown_option", { value: true });
	expect(() => runSync(argv, options)).toThrow("unknown option unknown_option");
});

test("documented synchronous and asynchronous options still run real children", async () => {
	const options = { deadline_s: fixtureDeadlineS(), cwd: process.cwd(), env: { ...process.env }, max_output_bytes: 1024 };
	for (const result of [runSync(argv, options), await run(argv, options)]) {
		expect(result.rc).toBe(0);
		expect(result.timed_out).toBe(false);
		expect(new TextDecoder().decode(result.stdout)).toBe("control");
	}
});
