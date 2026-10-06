import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { machineLoadBlockReason } from "../../src/heavy.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

function fixture(): string {
	const root = join(process.cwd(), "var", "agent-tmp");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(root, `heavy-test.${process.pid}.`));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid} label=heavy-test repo=${process.cwd()} created=${new Date().toISOString()}\n`, { mode: 0o600 });
	return dir;
}

function configure(root: string, values: { slots?: number; max_wait_s?: number }): void {
	const directory = join(root, "config", "omp-kit");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "load.json"), JSON.stringify(values), { mode: 0o600 });
}

async function invoke(root: string, args: string[], extraEnv: Record<string, string> = {}) {
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test", ...extraEnv },
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { code, stdout, stderr };
}

async function seedJob(root: string, input: { id: string; process_start?: string; pane?: string; state?: "queued" | "running" }): Promise<string> {
	const stateRoot = join(root, "state", "omp-kit", "load");
	const directory = join(stateRoot, "jobs");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	let processStart = input.process_start;
	if (!processStart) {
		const child = Bun.spawn(["ps", "-p", String(process.pid), "-o", "lstart="], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		const output = await new Response(child.stdout).text();
		processStart = await child.exited === 0 ? output.trim() : "";
	}
	if (!processStart) throw new Error("test process start is unavailable");
	writeFileSync(join(directory, `${input.id}.json`), JSON.stringify({
		id: input.id, pid: process.pid, process_start: processStart, label: "existing", repo: root, cwd: root,
		agent: "seed", tmux_pane: input.pane ?? "", argv: ["held-job"], state: input.state ?? "running",
		queued_at: new Date(0).toISOString(), started_at: new Date(0).toISOString(),
	}), { mode: 0o600 });
	return directory;
}

test("machine admission blocks only above 2.5 times the core count", () => {
	expect(machineLoadBlockReason(80, 32)).toBeNull();
	expect(machineLoadBlockReason(80.01, 32)).toContain("LOAD1");
	expect(machineLoadBlockReason(1, 4)).toBeNull();
});

test("heavy streams the child and preserves its exit code", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const result = await invoke(root, ["heavy", "--label", "tiny", "--", "sh", "-c", "printf child; exit 23"]);

	expect(result.code).toBe(23);
	expect(result.stdout).toBe("child");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("no-wait defers on a full machine slot without starting the command", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "slot-owner" });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", `printf ran > '${marker}'`]);

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual(["slot-owner.json"]);
});

test("a pane cannot start a second heavy command when another global slot is free", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 1 });
	await seedJob(root, { id: "pane-owner", pane: "%heavy-pane" });
	const result = await invoke(root, ["heavy", "--no-wait", "--", "sh", "-c", "exit 0"], { TMUX_PANE: "%heavy-pane" });

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("pane already has running job existing");
});

test("process-reused ledger entries are reaped before admission", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 1 });
	const jobs = await seedJob(root, { id: "reused-owner", process_start: "not-this-process-start" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "printf fresh"]);

	expect(result.code).toBe(0);
	expect(result.stdout).toBe("fresh");
	expect(readdirSync(jobs).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("a zero wait budget returns 75 when admission remains blocked", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 0 });
	await seedJob(root, { id: "timeout-owner" });
	const result = await invoke(root, ["heavy", "--", "sh", "-c", "exit 0"]);

	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred: all 1 heavy-work slot is occupied");
	expect(result.stderr).toContain("queue timeout");
});
// Integration tests below drive real child processes (slot handoff, signal
// delivery); fake timers cannot stand in, so coordination waits poll the job
// ledger for the awaited state with a deadline instead of sleeping blindly.
async function waitForLedgerState(root: string, want: "running" | "empty", timeoutMs: number): Promise<void> {
	const directory = join(root, "state", "omp-kit", "load", "jobs");
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		let entries: string[] = [];
		try {
			entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
		} catch { /* jobs dir appears on first write */ }
		if (want === "empty" && entries.length === 0) return;
		if (want === "running") {
			for (const name of entries) {
				try {
					if (JSON.parse(readFileSync(join(directory, name), "utf8")).state === "running") return;
				} catch { /* concurrent write; keep polling */ }
			}
		}
		await Bun.sleep(100);
	}
	throw new Error(`ledger never reached ${want} within ${timeoutMs}ms`);
}


test("two concurrent runs serialize on one slot", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const firstEnd = join(root, "first.end");
	const secondStart = join(root, "second.start");
	const a = invoke(root, ["heavy", "--label", "first", "--", "sh", "-c", `sleep 2; date +%s%N > '${firstEnd}'`]);
	await waitForLedgerState(root, "running", 15000);
	const b = invoke(root, ["heavy", "--label", "second", "--", "sh", "-c", `date +%s%N > '${secondStart}'`]);
	const [ra, rb] = await Promise.all([a, b]);
	expect(ra.code).toBe(0);
	expect(rb.code).toBe(0);
	const firstEndNs = Number(readFileSync(firstEnd, "utf8").trim());
	const secondStartNs = Number(readFileSync(secondStart, "utf8").trim());
	expect(secondStartNs).toBeGreaterThanOrEqual(firstEndNs);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("the child runs ten nice points above its parent", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 5 });
	const result = await invoke(root, ["heavy", "--label", "nicecheck", "--", "sh", "-c", "ps -o nice= -p $$; ps -o nice= -p $PPID"]);
	expect(result.code).toBe(0);
	const [childNice, parentNice] = result.stdout.trim().split("\n").map((line) => Number(line.trim()));
	expect(Number.isInteger(childNice) && Number.isInteger(parentNice)).toBe(true);
	expect(childNice! - parentNice!).toBe(10);
});

test("SIGINT releases the slot with exit 130", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const child = Bun.spawn([process.execPath, entry, "heavy", "--label", "interruptible", "--", "sleep", "30"], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test" },
		stdin: "ignore", stdout: "ignore", stderr: "pipe",
	});
	await waitForLedgerState(root, "running", 15000);
	child.kill("SIGINT");
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	expect(code).toBe(130);
	expect(stderr).toBe("");
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("SIGTERM releases the slot with exit 143", async () => {
	const root = fixture();
	configure(root, { slots: 1, max_wait_s: 30 });
	const child = Bun.spawn([process.execPath, entry, "heavy", "--label", "terminable", "--", "sleep", "30"], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"), PATH: `${process.env.PATH ?? ""}:/usr/bin:/bin`, TMUX_PANE: "", AGENT_NAME: "heavy-test" },
		stdin: "ignore", stdout: "ignore", stderr: "pipe",
	});
	await waitForLedgerState(root, "running", 15000);
	child.kill("SIGTERM");
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	expect(code).toBe(143);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});

test("planted contention queues the job even with a free slot", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 2 });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--label", "contended", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred:");
	expect(result.stderr).toContain("LOAD1");
	expect(existsSync(marker)).toBe(false);
});

test("planted no-wait under contention exits 75 without starting", async () => {
	const root = fixture();
	configure(root, { slots: 2, max_wait_s: 30 });
	const marker = join(root, "should-not-run");
	const result = await invoke(root, ["heavy", "--no-wait", "--label", "contended-nowait", "--", "sh", "-c", `printf ran > '${marker}'`],
		{ OMP_KIT_HEAVY_FAKE_LOAD1: "9999" });
	expect(result.code).toBe(75);
	expect(result.stderr).toContain("deferred:");
	expect(existsSync(marker)).toBe(false);
	expect(readdirSync(join(root, "state", "omp-kit", "load", "jobs")).filter((name) => name.endsWith(".json"))).toEqual([]);
});
