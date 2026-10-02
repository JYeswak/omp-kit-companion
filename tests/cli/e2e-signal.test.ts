import { expect, test } from "bun:test";
import process from "node:process";
import { join, resolve } from "node:path";

// Integration test: exercises real SIGTERM delivery and child reaping against
// the platform clock. Fake timers cannot work: the waits synchronize with a
// live subprocess, not in-process timers.

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** Pids whose ancestor chain reaches root, via ps; mirrors descendant_pids in e2e-live.sh. */
async function descendants(root: number): Promise<number[]> {
	const child = Bun.spawnSync(["ps", "-o", "pid=", "-o", "ppid="], { stdout: "pipe", stderr: "pipe" });
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
	let observed: number[] = [];
	for (let attempt = 0; attempt < 3; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 12000));
		observed = await descendants(child.pid);
		if (observed.length > 0) break;
	}
	const termAt = Date.now();
	child.kill(15);
	const code = await child.exited;
	const elapsedMs = Date.now() - termAt;
	const stderr = await new Response(child.stderr).text();
	expect(code).toBe(143);
	expect(elapsedMs).toBeLessThan(10000);
	expect(stderr).toContain("e2e-live: stopped on signal, exit 143");
	for (let i = 0; i < 50 && observed.some(pid => true); i++) {
		const states = await Promise.all(observed.map(pid => alive(pid)));
		observed = observed.filter((_, index) => states[index]);
		if (observed.length === 0) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	expect(observed).toEqual([]);
}, 300_000);
