/** Original CASSCLOCK1 load replay: nice -n 10 bun tests/cli/memory-readiness-load.ts */
import { resolve } from "node:path";
import { run } from "../../src/kitlib/run.ts";
import { parseBunSummary, type SliceCounts } from "../../src/slice-verify.ts";

const root = resolve(import.meta.dir, "../..");
const bun = Bun.which("bun");
if (!bun) throw new Error("The CASS load replay requires Bun on PATH");
const decoder = new TextDecoder();
const controllers = Array.from({ length: 8 }, () => new AbortController());
const pids = Array<number>(8).fill(0);
const ended = Array<boolean>(8).fill(false);
const ready = controllers.map(() => Promise.withResolvers<number>());
const cpuSource = `
import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ worker: Number(process.argv.at(-1)), pid: process.pid }) + String.fromCharCode(10));
const until = performance.now() + 420_000;
let value = 1;
while (performance.now() < until) value = Math.imul(value + 1, 1664525);
console.error("CPU burner reached its finite ceiling", value);
`;
const workers = controllers.map((controller, index) => {
	let output = "";
	return run([bun, "-e", cpuSource, String(index)], {
		cwd: root, deadline_s: 450, max_output_bytes: 8192, signal: controller.signal,
		on_output(stream, chunk) {
			if (stream !== "stdout") return;
			output += decoder.decode(chunk);
			if (!output.includes("\n")) return;
			const message = JSON.parse(output.trim());
			if (message.worker !== index || !Number.isSafeInteger(message.pid) || message.pid <= 0) return;
			pids[index] = message.pid;
			ready[index]!.resolve(message.pid);
		},
	}).then(result => {
		ended[index] = true;
		if (!pids[index]) ready[index]!.reject(new Error(`CPU worker ${index} exited before readiness: ${decoder.decode(result.stderr)}`));
		return result;
	}, error => {
		ended[index] = true;
		ready[index]!.reject(error);
		throw error;
	});
});
const completion = Promise.allSettled(workers);

async function liveSnapshot(): Promise<string> {
	if (ended.some(Boolean) || new Set(pids).size !== 8) throw new Error("Eight owned CPU workers must remain live throughout the replay");
	const snapshot = await run(["ps", "-p", pids.join(","), "-o", "pid=,pcpu=,state="], {
		cwd: root, deadline_s: 10, max_output_bytes: 8192,
	});
	const output = decoder.decode(snapshot.stdout);
	const live = new Set(output.trim().split("\n").map(row => Number.parseInt(row, 10)));
	if (snapshot.rc !== 0 || snapshot.timed_out || snapshot.truncated || !pids.every(pid => live.has(pid))) {
		throw new Error(`Owned CPU worker liveness is unverified: ${output}${decoder.decode(snapshot.stderr)}`);
	}
	return output;
}

try {
	await Promise.all(ready.map(slot => slot.promise));
	const runs: Array<{
		index: number; rc: number; counts: SliceCounts; before: string; after: string;
	}> = [];
	for (let index = 1; index <= 3; index++) {
		const before = await liveSnapshot();
		const result = await run([bun, "test", "tests/cli/memory-readiness.test.ts"], {
			cwd: root, deadline_s: 120, max_output_bytes: 1024 * 1024,
		});
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		const counts = parseBunSummary(decoder.decode(result.stdout) + "\n" + decoder.decode(result.stderr));
		const after = await liveSnapshot();
		if (result.rc !== 0 || result.timed_out || result.truncated || result.total_truncated ||
			!counts.found || counts.fail !== 0 || (counts.pass ?? 0) === 0) {
			throw new Error(`CASS load replay ${index}/3 failed: rc=${result.rc}, pass=${counts.pass}, fail=${counts.fail}`);
		}
		runs.push({ index, rc: result.rc, counts, before, after });
	}
	console.log(JSON.stringify({ kind: "memory-readiness-load", ok: true, owned_workers: pids, runs }));
} finally {
	for (const controller of controllers) controller.abort();
	const stopped = await completion;
	console.log(JSON.stringify({ cleanup: stopped.map((result, index) => ({ pid: pids[index], settled: result.status })) }));
}
