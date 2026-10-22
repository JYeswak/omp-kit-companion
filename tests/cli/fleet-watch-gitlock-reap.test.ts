import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce } from "../../src/fleet-watch.ts";
import type { ScratchRunner } from "../../src/scratch.ts";

// GITLOCK1 (ompkit-fp72.19.1.9) AC2: the gated reaper in src/index-lock.ts had no caller, so stale empty
// index.locks blocked every commit for hours (cfsios 188 min, localbench 28 h on 2026-10-22). The
// fleet-watch tick now reaps each configured repo once per tick, through the same gates.

const NOW = 1_792_650_000_000;
const OLD = NOW - 10 * 60_000;

function fixture(name: string): { scratch: string; repo: string; lock: string; log: string; ledger: string } {
	const parent = join(resolve(import.meta.dir, "../.."), "var/agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, `gitlock-reap-${name}.`));
	const repo = join(scratch, "repo");
	mkdirSync(repo, { recursive: true });
	expect(spawnSync("git", ["init", "--quiet", repo]).status).toBe(0);
	const lock = join(repo, ".git", "index.lock");
	return { scratch, repo, lock, log: join(scratch, "fleet-watch.jsonl"), ledger: join(scratch, "ledger.jsonl") };
}

function plantLock(lock: string, ageFrom: number): void {
	writeFileSync(lock, "");
	utimesSync(lock, ageFrom / 1000, ageFrom / 1000);
}

// lsof stand-in: rc 1 with no output means "no holder" for both the file gate and the git-cwd gate.
const clearRunner: ScratchRunner = () => ({ code: 1, stdout: "", stderr: "" });
// The file gate sees a live holder.
const heldRunner: ScratchRunner = (args) => args.includes("-c")
	? { code: 1, stdout: "", stderr: "" }
	: { code: 0, stdout: "COMMAND PID\ngit 4242\n", stderr: "" };

function tick(repo: string, log: string, extra: Record<string, unknown>) {
	return runFleetWatchOnce(
		{ enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [
			{ session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo, workerPanes: [] },
		] },
		{
			capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
			send: () => { throw new Error("the reaper never steers panes"); },
			sendKeys: () => { throw new Error("the reaper never steers panes"); },
			logPath: log,
			now: () => NOW,
			recoverTracker: () => null,
			retainTracker: null,
			...extra,
		},
	);
}

test("a stale empty index.lock in a configured repo is reaped by the tick through every gate, with a ledger receipt", () => {
	const f = fixture("default");
	try {
		plantLock(f.lock, OLD);
		const actions = tick(f.repo, f.log, { gitLockReap: { run: clearRunner, ledgerPath: f.ledger } });
		expect(existsSync(f.lock)).toBe(false);
		const reaped = actions.filter((action) => action.kind === "GITLOCK_REAPED");
		expect(reaped).toHaveLength(1);
		expect(reaped[0]).toMatchObject({ session: "omp-test", repo: f.repo });
		const ledger = readFileSync(f.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ kind: "GITLOCK_REAPED", checks: "empty,age,file-clear,cwd-clear,identity" });
		expect(existsSync(ledger[0].movedTo)).toBe(true);
		expect(readFileSync(f.log, "utf8")).toContain('"kind":"GITLOCK_REAPED"');
		expect(spawnSync("git", ["-C", f.repo, "status", "--porcelain"]).status).toBe(0);
	} finally { rmSync(f.scratch, { recursive: true, force: true }); }
});

test("planted: a lock held by a live process is never moved", () => {
	const f = fixture("held");
	try {
		plantLock(f.lock, OLD);
		const actions = tick(f.repo, f.log, { gitLockReap: { run: heldRunner, ledgerPath: f.ledger } });
		expect(existsSync(f.lock)).toBe(true);
		expect(actions.filter((action) => action.kind === "GITLOCK_REAPED")).toHaveLength(0);
		expect(existsSync(f.ledger)).toBe(false);
	} finally { rmSync(f.scratch, { recursive: true, force: true }); }
});

test("planted: a young lock and a non-empty lock stay; a null reaper disables the phase", () => {
	const f = fixture("young");
	try {
		plantLock(f.lock, NOW - 5_000);
		tick(f.repo, f.log, { gitLockReap: { run: clearRunner, ledgerPath: f.ledger } });
		expect(existsSync(f.lock)).toBe(true);
		writeFileSync(f.lock, "partial index bytes");
		utimesSync(f.lock, OLD / 1000, OLD / 1000);
		tick(f.repo, f.log, { gitLockReap: { run: clearRunner, ledgerPath: f.ledger } });
		expect(existsSync(f.lock)).toBe(true);
		plantLock(f.lock, OLD);
		tick(f.repo, f.log, { gitLockReap: null });
		expect(existsSync(f.lock)).toBe(true);
	} finally { rmSync(f.scratch, { recursive: true, force: true }); }
});

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;
test.skipIf(!hasLsof)("with no gitLockReap option the tick still reaps, using the kit's own runner (real lsof)", () => {
	const f = fixture("realdefault");
	try {
		plantLock(f.lock, Date.now() - 10 * 60_000);
		const actions = runFleetWatchOnce(
			{ enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [
				{ session: "omp-test", coordinatorPane: "%54", coordinatorSession: "omp-test", repo: f.repo, workerPanes: [] },
			] },
			{
				capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
				send: () => { throw new Error("the reaper never steers panes"); },
				sendKeys: () => { throw new Error("the reaper never steers panes"); },
				logPath: f.log, recoverTracker: () => null, retainTracker: null,
				gitLockReap: { ledgerPath: f.ledger },
			},
		);
		expect(existsSync(f.lock)).toBe(false);
		expect(actions.filter((action) => action.kind === "GITLOCK_REAPED")).toHaveLength(1);
	} finally { rmSync(f.scratch, { recursive: true, force: true }); }
});
