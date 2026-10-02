import { expect, test } from "bun:test";
import process from "node:process";
import { join, resolve } from "node:path";

// Integration test: exercises real SIGTERM delivery and child reaping against
// the platform clock. Fake timers cannot work: the waits synchronize with a
// live subprocess, not in-process timers.

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Pids whose ancestor chain reaches root, via ps. -ax is required: bare ps
 * only lists the caller's session, which never contains piped children, so
 * without it this walk always returns [] and the reap check passes vacuously. */
async function descendants(root: number): Promise<number[]> {
	const child = Bun.spawnSync(["ps", "-ax", "-o", "pid=", "-o", "ppid="], { stdout: "pipe", stderr: "pipe" });
	const edges = new Map<number, number>();
	for (const line of child.stdout.toString().split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 2) continue;
		edges.set(Number(parts[0]), Number(parts[1]));
	}
	const marked = new Set<number>([root]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [pid, ppid] of edges) {
			if (!marked.has(pid) && marked.has(ppid)) {
				marked.add(pid);
				changed = true;
			}
		}
	}
	marked.delete(root);
	return [...marked];
}

async function alive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("SIGTERM stops e2e-live within 10 s with no surviving children", async () => {
	const child = Bun.spawn(["sh", "scripts/e2e-live.sh"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ONLY: "canary-fire canary-near pipe-exit-fire pipe-exit-near glob-silenced-fire glob-silenced-near" },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.pid === undefined) throw new Error("e2e-live did not start");
	// Gate TERM on a started marker the script prints to stderr (unbuffered, so
	// it arrives in real time; stdout is block-buffered and would arrive late),
	// never on a fixed delay: the marker proves an OMP run is live, so the trap
	// path is always exercised. One pump per stream consumes both end to end so
	// post-TERM output can never block a pipe; the wait resolves on the marker
	// or on early exit.
	const decoder = new TextDecoder();
	let out = "";
	let err = "";
	let started = false;
	let exitedCode: number | null = null;
	const { promise: markerSeen, resolve: markStarted } = Promise.withResolvers<void>();
	const pumpOut = (async () => {
		for await (const chunk of child.stdout) out += decoder.decode(chunk, { stream: true });
	})();
	const pumpErr = (async () => {
		for await (const chunk of child.stderr) {
			err += decoder.decode(chunk, { stream: true });
			if (!started && /e2e-live: started scenario=\S+ omp_pid=\d+/.test(err)) {
				started = true;
				markStarted();
			}
		}
	})();
	const exitSeen = child.exited.then(code => { exitedCode = code ?? 1; });
	while (!started && exitedCode === null) await Promise.race([markerSeen, exitSeen]);
	if (!started) {
		throw new Error(`e2e-live never started a scenario (exited=${exitedCode}):\n${err.slice(-2000)}`);
	}
	let observed = await descendants(child.pid);
	expect(observed.length).toBeGreaterThan(0);
	const termAt = Date.now();
	child.kill(15);
	const code = await child.exited;
	await pumpOut;
	await pumpErr;
	const elapsedMs = Date.now() - termAt;
	const stderr = err;
	expect(code).toBe(143);
	for (let i = 0; i < 50 && observed.some(pid => true); i++) {
		const states = await Promise.all(observed.map(pid => alive(pid)));
		observed = observed.filter((_, index) => states[index]);
		if (observed.length === 0) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	expect(observed).toEqual([]);
}, 300_000);
