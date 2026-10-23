// Conformance tests for src/kitlib/run.ts (ompkit-hsfyp, KITLIB-RUN). Every case
// comes from tests/fixtures/kitlib-run/corpus.json, the same corpus
// tests/scripts/kitlib_run_test.py runs against scripts/kitlib_run.py, so the two
// languages cannot drift. Each case runs real processes; survivors are found by
// a marker unique to the case run in their command lines.
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run, runSync, type RunOptions, type RunResult, type RunSyncOptions } from "../../src/kitlib/run";

type Expect = {
	rc?: number; rc_signal?: string; timed_out?: boolean; killed?: boolean; truncated?: boolean;
	stdout?: string; stderr?: string; stdout_bytes?: number; max_elapsed_s?: number;
	no_survivor?: boolean; max_parent_rss_growth_bytes?: number; throws?: boolean;
};
type Case = { id: string; argv: string[]; options: Record<string, unknown>; expect: Expect };

const corpus = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/kitlib-run/corpus.json"), "utf8")) as { schema: string; cases: Case[] };
const decoder = new TextDecoder();

function substitute<T>(value: T, marker: string, tmp: string): T {
	if (typeof value === "string") return value.replaceAll("{MARKER}", marker).replaceAll("{TMP}", tmp) as T;
	if (Array.isArray(value)) return value.map(item => substitute(item, marker, tmp)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, marker, tmp)])) as T;
	}
	return value;
}

async function markerPids(marker: string): Promise<number[]> {
	const listing = await run(["ps", "-A", "-o", "pid=", "-o", "command="], { deadline_s: 10, max_output_bytes: 8 << 20 });
	if (listing.timed_out || listing.rc !== 0) throw new Error(`ps failed: rc=${listing.rc} ${decoder.decode(listing.stderr)}`);
	const pids: number[] = [];
	for (const line of decoder.decode(listing.stdout).split("\n")) {
		const match = /^\s*(\d+)\s+(.*)$/.exec(line);
		if (match && match[2]!.includes(marker) && Number(match[1]) !== process.pid) pids.push(Number(match[1]));
	}
	return pids;
}

/** Marker holders still present after `budgetMs`. Real-clock poll: a SIGKILLed
 * member is reaped by the OS on its own schedule, which no fake timer drives. */
async function survivors(marker: string, budgetMs = 3000): Promise<number[]> {
	const end = Date.now() + budgetMs;
	for (;;) {
		const pids = await markerPids(marker);
		if (pids.length === 0 || Date.now() >= end) return pids;
		await Bun.sleep(100);
	}
}

const peakRssBytes = () => process.resourceUsage().maxRSS * 1024;

function judge(result: RunResult, want: Expect, rssGrowth: number): void {
	const shown = JSON.stringify({ ...result, stdout: decoder.decode(result.stdout.subarray(0, 200)), stderr: decoder.decode(result.stderr.subarray(0, 200)) });
	for (const key of ["rc", "timed_out", "killed", "truncated"] as const) {
		if (want[key] !== undefined) expect(result[key], `${key}: ${shown}`).toBe(want[key]!);
	}
	if (want.rc_signal !== undefined) {
		const signum = constants.signals[want.rc_signal as keyof typeof constants.signals];
		expect(result.rc, shown).toBe(-signum);
	}
	if (want.stdout !== undefined) expect(decoder.decode(result.stdout)).toBe(want.stdout);
	if (want.stderr !== undefined) expect(decoder.decode(result.stderr)).toBe(want.stderr);
	if (want.stdout_bytes !== undefined) expect(result.stdout.byteLength).toBe(want.stdout_bytes);
	if (want.max_elapsed_s !== undefined) expect(result.elapsed_s).toBeLessThan(want.max_elapsed_s);
	if (want.max_parent_rss_growth_bytes !== undefined) expect(rssGrowth).toBeLessThan(want.max_parent_rss_growth_bytes);
}

describe("kitlib run conformance corpus", () => {
	test("corpus is a kitlib-run-corpus.v1 corpus", () => {
		expect(corpus.schema).toBe("kitlib-run-corpus.v1");
		expect(corpus.cases.length).toBeGreaterThan(0);
	});
	for (const testCase of corpus.cases) {
		test(testCase.id, async () => {
			const marker = `kitlib-run-ts-${process.pid}-${randomBytes(6).toString("hex")}`;
			const scratch = ownedTmp("kitlib-run").path;
			const tmp = realpathSync(scratch);
			try {
				const argv = substitute(testCase.argv, marker, tmp);
				const options = substitute(testCase.options, marker, tmp) as RunOptions;
				const want = substitute(testCase.expect, marker, tmp);
				if (want.throws) {
					await expect(run(argv, options)).rejects.toThrow();
					return;
				}
				const before = peakRssBytes();
				const result = await run(argv, options);
				judge(result, want, peakRssBytes() - before);
				if (want.no_survivor) expect(await survivors(marker), `process-group members outlived run(): marker ${marker}`).toEqual([]);
			} finally {
				// Test hygiene: this case's own marker holders only.
				for (const pid of await markerPids(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
				rmSync(scratch, { recursive: true, force: true });
			}
		}, 60_000);
	}
	test("a shell string is refused", async () => {
		await expect(run("echo hi" as unknown as string[], { deadline_s: 5 })).rejects.toThrow(TypeError);
	});
	test("a missing deadline is refused", async () => {
		await expect(run(["/bin/sh", "-c", "exit 0"], {} as RunOptions)).rejects.toThrow(TypeError);
	});
});

// TypeScript-only surface (Python cancellation is pysafe's Cancelled unwinding).
describe("kitlib run cancellation", () => {
	// The leader touches `ready` after forking its marker-bearing grandchild, so a kill always has a group member to reach.
	const sleeper = (marker: string, ready: string) => ["/bin/sh", "-c", `/bin/sh -c 'sleep 30; : ${marker}' & : > '${ready}'; sleep 30; : ${marker}`];
	const scratch = () => realpathSync(ownedTmp("kitlib-run").path);
	test("an aborted signal kills the whole group and rejects with the reason", async () => {
		const marker = `kitlib-run-ts-abort-${process.pid}-${randomBytes(6).toString("hex")}`;
		const dir = scratch(), ready = join(dir, "ready");
		try {
			const controller = new AbortController();
			const pending = run(sleeper(marker, ready), { deadline_s: 30, signal: controller.signal });
			// Real-clock poll for a file a real child writes; no fake timer reaches another process.
			for (let tries = 0; !existsSync(ready) && tries < 200; tries++) await Bun.sleep(25);
			expect(existsSync(ready)).toBe(true);
			controller.abort(new Error("operator cancel"));
			await expect(pending).rejects.toThrow("operator cancel");
			expect(await survivors(marker)).toEqual([]);
		} finally {
			for (const pid of await markerPids(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
	test("a parent that exits mid-run takes its owned groups with it", async () => {
		const marker = `kitlib-run-ts-exit-${process.pid}-${randomBytes(6).toString("hex")}`;
		const dir = scratch(), ready = join(dir, "ready");
		const module = join(import.meta.dir, "../../src/kitlib/run.ts");
		const script = `import { existsSync } from "node:fs";
import { run } from ${JSON.stringify(module)};
void run(${JSON.stringify(sleeper(marker, ready))}, { deadline_s: 60 });
for (let tries = 0; !existsSync(${JSON.stringify(ready)}) && tries < 200; tries++) await Bun.sleep(25);
process.exit(existsSync(${JSON.stringify(ready)}) ? 0 : 9);`;
		try {
			const parent = await run([process.execPath, "-e", script], { deadline_s: 20 });
			expect(parent.rc, new TextDecoder().decode(parent.stderr)).toBe(0);
			// The outer run sweeps the parent's own group; the inner group is a separate session only the parent's exit sweep reaches.
			expect(await survivors(marker)).toEqual([]);
		} finally {
			for (const pid of await markerPids(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});

// runSync: the synchronous leaf-command twin (ompkit-5m6ej). No group ownership, so the corpus's descendant cases do not apply.
describe("kitlib runSync", () => {
	test("planted: the deadline kills a sleep 5 at 0.5 s; control: a fast command is not timed out", () => {
		const slow = runSync(["sleep", "5"], { deadline_s: 0.5 });
		expect(slow.timed_out).toBe(true);
		expect(slow.killed).toBe(true);
		expect(slow.rc).toBeNull();
		expect(slow.elapsed_s).toBeLessThan(3);
		const fast = runSync(["/bin/sh", "-c", "exit 4"], { deadline_s: 5 });
		expect(fast.timed_out).toBe(false);
		expect(fast.killed).toBe(false);
		expect(fast.rc).toBe(4);
	});
	test("output past the cap is cut and stops the writer; control: output under the cap is whole", () => {
		const flood = runSync(["/bin/sh", "-c", "yes"], { deadline_s: 10, max_output_bytes: 100 });
		expect(flood.truncated).toBe(true);
		expect(flood.killed).toBe(true);
		expect(flood.timed_out).toBe(false);
		expect(flood.rc).toBeNull();
		expect(flood.stdout.byteLength).toBe(100);
		const errFlood = runSync(["/bin/sh", "-c", "yes >&2"], { deadline_s: 10, max_output_bytes: 64 });
		expect(errFlood.truncated).toBe(true);
		expect(errFlood.stderr.byteLength).toBe(64);
		const small = runSync(["/bin/sh", "-c", "printf abc; printf def >&2"], { deadline_s: 5, max_output_bytes: 100 });
		expect(small.truncated).toBe(false);
		expect(small.rc).toBe(0);
		expect(decoder.decode(small.stdout)).toBe("abc");
		expect(decoder.decode(small.stderr)).toBe("def");
	});
	test("argv and options are validated like run()", () => {
		expect(() => runSync("echo hi" as unknown as string[], { deadline_s: 5 })).toThrow(TypeError);
		expect(() => runSync([], { deadline_s: 5 })).toThrow(TypeError);
		expect(() => runSync(["echo", 1 as unknown as string], { deadline_s: 5 })).toThrow(TypeError);
		expect(() => runSync(["/bin/sh", "-c", "exit 0"], {} as RunSyncOptions)).toThrow(TypeError);
		expect(() => runSync(["/bin/sh", "-c", "exit 0"], null as unknown as RunSyncOptions)).toThrow(TypeError);
		expect(() => runSync(["/bin/sh", "-c", "exit 0"], { deadline_s: 0 })).toThrow(RangeError);
		expect(() => runSync(["/bin/sh", "-c", "exit 0"], { deadline_s: -1 })).toThrow(RangeError);
		expect(() => runSync(["/bin/sh", "-c", "exit 0"], { deadline_s: 5, max_output_bytes: -1 })).toThrow(RangeError);
	});
});

afterAll(() => cleanupAllOwnedTmp());
