// Conformance tests for src/kitlib/run.ts (ompkit-hsfyp, KITLIB-RUN). Every case
// comes from tests/fixtures/kitlib-run/corpus.json, the same corpus
// tests/scripts/kitlib_run_test.py runs against scripts/kitlib_run.py, so the two
// languages cannot drift. Each case runs real processes; survivors are found by
// a marker unique to the case run in their command lines.
import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { run, runSync, type RunOptions, type RunResult, type RunSyncOptions } from "../../src/kitlib/run";

type Expect = {
	rc?: number; rc_signal?: string; timed_out?: boolean; killed?: boolean; truncated?: boolean;
	stdout?: string; stderr?: string; stdout_bytes?: number; max_elapsed_s?: number;
	no_survivor?: boolean; max_parent_rss_growth_bytes?: number; throws?: boolean;
	// KL02 (ompkit-t8dfi)
	total_truncated?: boolean; captured_bytes?: number; streamed_bytes?: number; stream_dropped_bytes?: number;
	min_stream_dropped_bytes?: number; sink_error?: null; sink_error_contains?: string; streamed_stdout?: string;
	streamed_stderr?: string; streamed_stdout_hex?: string; stdout_hex?: string; stdout_sorted_lines?: string[];
	first_chunk_lead_s?: number; min_parent_rss_growth_bytes?: number;
};
type Case = { id: string; argv: string[]; options: Record<string, unknown>; expect: Expect; fds?: string[]; sink?: "record" | "stall" | "throw" };

/** The corpus `sink` directives as an `on_output`: record, stall or throw. */
class Recorder {
	readonly chunks: { at: number; stream: string; chunk: Uint8Array }[] = [];
	constructor(private readonly mode: "record" | "stall" | "throw") {}
	readonly sink = (stream: string, chunk: Uint8Array): unknown => {
		if (this.mode === "stall") return new Promise(() => { /* never settles: the delivery never completes */ });
		if (this.mode === "throw") throw new Error("planted sink failure");
		this.chunks.push({ at: performance.now(), stream, chunk: new Uint8Array(chunk) });
		return undefined;
	};
	joined(stream: string): Buffer {
		return Buffer.concat(this.chunks.filter(item => item.stream === stream).map(item => item.chunk));
	}
}

function judgeKl02(result: RunResult, want: Expect, rssGrowth: number, recorder: Recorder | null, returnedAt: number): void {
	for (const key of ["total_truncated", "captured_bytes", "streamed_bytes", "stream_dropped_bytes"] as const) {
		if (want[key] !== undefined) expect(result[key], key).toBe(want[key]!);
	}
	if (want.sink_error !== undefined) expect(result.sink_error).toBeNull();
	if (want.sink_error_contains !== undefined) expect(result.sink_error ?? "").toContain(want.sink_error_contains);
	if (want.min_stream_dropped_bytes !== undefined) expect(result.stream_dropped_bytes).toBeGreaterThanOrEqual(want.min_stream_dropped_bytes);
	if (want.min_parent_rss_growth_bytes !== undefined) expect(rssGrowth).toBeGreaterThanOrEqual(want.min_parent_rss_growth_bytes);
	if (want.stdout_hex !== undefined) expect(Buffer.from(result.stdout).toString("hex")).toBe(want.stdout_hex);
	if (want.stdout_sorted_lines !== undefined) expect(decoder.decode(result.stdout).split("\n").filter(Boolean).sort()).toEqual([...want.stdout_sorted_lines].sort());
	if (want.streamed_stdout !== undefined) expect(decoder.decode(recorder!.joined("stdout"))).toBe(want.streamed_stdout);
	if (want.streamed_stderr !== undefined) expect(decoder.decode(recorder!.joined("stderr"))).toBe(want.streamed_stderr);
	if (want.streamed_stdout_hex !== undefined) expect(recorder!.joined("stdout").toString("hex")).toBe(want.streamed_stdout_hex);
	if (want.first_chunk_lead_s !== undefined) {
		expect(recorder!.chunks.length, "no chunk was streamed").toBeGreaterThan(0);
		expect((returnedAt - recorder!.chunks[0]!.at) / 1000).toBeGreaterThanOrEqual(want.first_chunk_lead_s);
	}
}

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
	});
	for (const testCase of corpus.cases) {
		test(testCase.id, async () => {
			const measuresRss = testCase.expect.max_parent_rss_growth_bytes !== undefined ||
				testCase.expect.min_parent_rss_growth_bytes !== undefined;
			let rssChild = false;
			if (process.env.KITLIB_RUN_RSS_CASE === testCase.id) {
				const nonce = process.env.KITLIB_RUN_RSS_NONCE;
				const fd = Number(process.env.KITLIB_RUN_RSS_FD);
				if (!nonce || !Number.isInteger(fd) || fd < 3) throw new Error("RSS child marker has no capability");
				if (readFileSync(fd, "utf8") !== nonce) throw new Error("RSS child capability mismatch");
				rssChild = true;
			}
			if (measuresRss && !rssChild) {
				// maxRSS is process-global: an earlier test's peak must not hide this case's allocation.
				const isolated = ownedTmp("run-rss");
				const proof = join(isolated.path, "completed.json");
				const nonce = randomBytes(24).toString("hex");
				const ticket = `${proof}.ticket`;
				let ticketFd: number | undefined;
				try {
					writeFileSync(ticket, nonce, { flag: "wx", mode: 0o600 });
					ticketFd = openSync(ticket, "r");
					const child = await run([process.execPath, "test", "--test-name-pattern", RegExp.escape(testCase.id), import.meta.path], {
						deadline_s: 60, inherit_fds: [ticketFd],
						env: { ...process.env, TMPDIR: isolated.path, KITLIB_RUN_RSS_CASE: testCase.id,
							KITLIB_RUN_RSS_PROOF: proof, KITLIB_RUN_RSS_NONCE: nonce, KITLIB_RUN_RSS_FD: String(ticketFd) },
					});
					if (child.rc !== 0 || child.timed_out || child.truncated) {
						throw new Error(decoder.decode(child.stderr) || "isolated RSS case did not complete");
					}
					// Written only after the original case's assertions: zero selected tests cannot pass.
					const completed = JSON.parse(readFileSync(proof, "utf8"));
					expect({ id: completed.id, nonce: completed.nonce }).toEqual({ id: testCase.id, nonce });
				} finally {
					if (ticketFd !== undefined) closeSync(ticketFd);
					isolated.cleanup();
				}
				return;
			}
			const marker = `kitlib-run-ts-${process.pid}-${randomBytes(6).toString("hex")}`;
			const scratch = ownedTmp("kitlib-run").path;
			const tmp = realpathSync(scratch);
			const opened: number[] = [];
			const recorder = testCase.sink ? new Recorder(testCase.sink) : null;
			try {
				const tokens: [string, string][] = [];
				for (const name of testCase.fds ?? []) {
					const fd = openSync(join(tmp, name), "w+", 0o600);
					opened.push(fd);
					tokens.push([`{${name.toUpperCase()}FD}`, String(fd)]);
				}
				function sub<T>(value: T): T {
					let text = JSON.stringify(substitute(value, marker, tmp));
					for (const [token, fd] of tokens) text = text.replaceAll(token, fd);
					return JSON.parse(text) as T;
				}
				const argv = sub(testCase.argv);
				const options = sub(testCase.options) as RunOptions & { inherit_fds?: (number | string)[] };
				const want = sub(testCase.expect);
				if (options.inherit_fds) options.inherit_fds = options.inherit_fds.map(Number);
				if (recorder) options.on_output = recorder.sink;
				if (want.throws) {
					await expect(run(argv, options)).rejects.toThrow();
					return;
				}
				const before = peakRssBytes();
				const result = await run(argv, options);
				const returnedAt = performance.now();
				judge(result, want, peakRssBytes() - before);
				judgeKl02(result, want, peakRssBytes() - before, recorder, returnedAt);
				if (want.no_survivor) expect(await survivors(marker), `process-group members outlived run(): marker ${marker}`).toEqual([]);
				if (measuresRss && rssChild) {
					const proof = process.env.KITLIB_RUN_RSS_PROOF;
					if (!proof) throw new Error("RSS child needs its completion proof path");
					writeFileSync(proof, JSON.stringify({
						id: testCase.id, nonce: process.env.KITLIB_RUN_RSS_NONCE,
					}), { flag: "wx" });
				}
			} finally {
				// Test hygiene: this case's own marker holders only.
				for (const pid of await markerPids(marker)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
				for (const fd of opened) closeSync(fd);
				rmSync(scratch, { recursive: true, force: true });
			}
		}, 60_000);
	}
	test("accepted callback chunks remain readable after capture truncation and completion", async () => {
		const size = 128 * 1024;
		const expected = Uint8Array.from({ length: size }, (_, index) => index % 251);
		const retained: Uint8Array[] = [];
		const child = `const bytes = Uint8Array.from({ length: ${size} }, (_, index) => index % 251);
await Bun.write(Bun.stdout, bytes);`;
		const result = await run([process.execPath, "-e", child], {
			deadline_s: 5, max_output_bytes: size, max_total_bytes: 17, max_sink_queue_bytes: size * 2,
			on_output: (stream, chunk) => {
				// Retain the actual delivered view: a defensive copy would hide detachment.
				if (stream === "stdout") retained.push(chunk);
			},
		});
		expect(result.rc).toBe(0);
		expect(result.stdout).toEqual(expected.subarray(0, 17));
		expect(result.stream_dropped_bytes).toBe(0);
		expect(createHash("sha256").update(Buffer.concat(retained)).digest("hex"))
			.toBe(createHash("sha256").update(expected).digest("hex"));
	}, 10_000);
	test("dropping later chunks preserves the actual view already handed to a stalled sink", async () => {
		const size = 1024 * 1024;
		const expected = Uint8Array.from({ length: size }, (_, index) => index % 251);
		let retained: Uint8Array | undefined;
		const result = await run([process.execPath, "-e",
			`await Bun.write(Bun.stdout, Uint8Array.from({ length: ${size} }, (_, index) => index % 251));`], {
			deadline_s: 5, grace_s: 0.01, max_output_bytes: 17, max_sink_queue_bytes: 256 * 1024,
			on_output: (_stream, chunk) => {
				retained = chunk;
				return new Promise(() => {});
			},
		});
		expect(result.rc).toBe(0);
		expect(result.stdout).toEqual(expected.subarray(0, 17));
		expect(result.stream_dropped_bytes).toBe(size);
		if (!retained || retained.byteLength === 0) throw new Error("accepted sink view was lost or detached");
		expect(createHash("sha256").update(retained).digest("hex"))
			.toBe(createHash("sha256").update(expected.subarray(0, retained.byteLength)).digest("hex"));
	}, 10_000);
	test("optional buffer release failures never stop draining the child", async () => {
		const module = join(import.meta.dir, "../../src/kitlib/run.ts");
		for (const mode of ["native", "absent", "non-detachable"]) {
			const script = `import { run } from ${JSON.stringify(module)};
const mode = ${JSON.stringify(mode)};
let attempts = 0;
if (mode === "absent") Object.defineProperty(ArrayBuffer.prototype, "transfer", { value: undefined });
if (mode === "non-detachable") Object.defineProperty(ArrayBuffer.prototype, "transfer", {
	value() { attempts++; throw new TypeError("synthetic non-detachable buffer"); }
});
const result = await run(["/bin/sh", "-c", "head -c 1048576 /dev/zero; printf drained >&2"], {
	deadline_s: 5, max_output_bytes: 17
});
console.log(JSON.stringify({ rc: result.rc, timed_out: result.timed_out,
	stdout: Array.from(result.stdout), stderr: new TextDecoder().decode(result.stderr), attempts }));`;
			const child = await run([process.execPath, "-e", script], { deadline_s: 10 });
			expect(child.rc, decoder.decode(child.stderr)).toBe(0);
			const result = JSON.parse(decoder.decode(child.stdout));
			expect({ rc: result.rc, timed_out: result.timed_out, stdout: result.stdout, stderr: result.stderr })
				.toEqual({ rc: 0, timed_out: false, stdout: Array(17).fill(0), stderr: "drained" });
			if (mode === "non-detachable") expect(result.attempts).toBeGreaterThan(0);
		}
	}, 30_000);
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
