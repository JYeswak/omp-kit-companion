import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce, type FleetWatchConfig } from "../../src/fleet-watch.ts";
import {
	defaultPostRecoverReadback,
	recoverBusyTracker,
	type TrackerRecoveryCommandResult,
	type TrackerRecoveryResult,
} from "../../src/tracker-recovery.ts";
import type { LivenessDeps } from "../../src/scratch.ts";

// ompkit-rhy9.13: guarded native recovery at the registered tracker-health tick.
// Positive, planted negatives, bypass controls, and registry coverage.

const repoRoot = resolve(import.meta.dir, "../..");
const BUSY = JSON.stringify({ error: "database is busy (recovery in progress)" });
const T1 = 1_791_276_000_000;
const SESSION = "omp-test";

function plantedRepo(): { scratch: string; repo: string; root: string; runDir: string } {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = ownedTmp("tracker-recovery-rhy9-13", { root: parent }).path;
	const repo = join(scratch, "repo");
	const root = join(repo, ".beads", ".br_recovery", "schema-migrations");
	const runDir = join(root, "20261010T000000.000000Z-9-0");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "recovery-failed.json"), `${BUSY}\n`);
	return { scratch, repo, root, runDir };
}

function plantLease(runDir: string, lease: Record<string, unknown>): void {
	writeFileSync(join(runDir, ".omp-kit-recovery-lease.json"), `${JSON.stringify(lease)}\n`, { mode: 0o600 });
}

const LIVE_PID = 424242;
const LIVE_START = "Mon Oct  5 12:00:00 2026";
const OWNER_PID = 700000;

function livenessWith(livePids: ReadonlySet<number>): LivenessDeps {
	return {
		signalAlive: (pid) => livePids.has(pid),
		psVisible: () => false,
		processStart: (pid) => pid === LIVE_PID ? LIVE_START : pid === OWNER_PID ? "current-process" : null,
	};
}

function stubRun(brCalls: string[][], lsof: { code: number; stdout: string; stderr: string }, recoverCode = 0) {
	return (args: readonly string[], cwd: string): TrackerRecoveryCommandResult => {
		if (args[0] === "lsof") return { ...lsof };
		if (args[0] === "br" && args[1] === "--version") return { code: 0, stdout: "br 0.7.4\n", stderr: "" };
		if (args[0] === "br") {
			brCalls.push([...args, `cwd=${cwd}`]);
			return { code: recoverCode, stdout: "recovered", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

const CLEAR_LSOF = { code: 0, stdout: "", stderr: "" };

function baseDeps(brCalls: string[][], options: {
	livePids?: ReadonlySet<number>;
	lsof?: { code: number; stdout: string; stderr: string };
	sessionId?: (session: string, cwd: string) => string | null | undefined;
	nowMs?: number;
	admission?: never;
	readback?: ((repo: string, run: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult) => { ok: boolean; detail: string }) | null;
} = {}) {
	const run = stubRun(brCalls, options.lsof ?? CLEAR_LSOF);
	return {
		pid: OWNER_PID,
		liveness: livenessWith(options.livePids ?? new Set()),
		sessionId: options.sessionId ?? (() => "$22" as string | null),
		run,
		now: () => options.nowMs ?? T1,
		leaseId: () => "rhy9-13-lease",
		...(options.readback === undefined ? {} : { postRecoverReadback: options.readback }),
	};
}

function rateReceiptPath(repo: string): string {
	return join(repo, ".beads", ".br_recovery", "schema-migrations", ".omp-kit-last-recover.json");
}

test("[a-positive] dead lease, no holders: recovers once, readback runs, receipt written", () => {
	const planted = plantedRepo();
	plantLease(planted.runDir, { schema_version: 1, lease_id: "dead", pid: 999001, process_start: "gone", session: SESSION, session_id: "$9", acquired_at: new Date(T1).toISOString() });
	const brCalls: string[][] = [];
	let readbacks = 0;
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, {
			readback: () => { readbacks++; return { ok: true, detail: "native br list succeeded" }; },
		}));
		expect(result?.kind).toBe("RECOVERY_PROCEEDED");
		expect(result?.text).toContain("stale holder lease isolated");
		expect(result?.text).toContain("Post-recover native readback ok");
		expect(result?.text).toContain(SESSION);
		expect(brCalls).toEqual([["br", "doctor", "migrate-schema", "recover", `cwd=${planted.repo}`]]);
		expect(readbacks).toBe(1);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(true);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-positive] failed native readback flips the outcome to RECOVERY_FAILED", () => {
	const planted = plantedRepo();
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, {
			readback: () => ({ ok: false, detail: "native br list exited 1: locked" }),
		}));
		expect(result?.kind).toBe("RECOVERY_FAILED");
		expect(result?.text).toContain("Post-recover native readback failed");
		expect(brCalls).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-negative] live lease holder: named block, zero recover commands, zero rate receipt", () => {
	const planted = plantedRepo();
	plantLease(planted.runDir, { schema_version: 1, lease_id: "live", pid: LIVE_PID, process_start: LIVE_START, session: SESSION, session_id: "$22", acquired_at: new Date(T1).toISOString() });
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, { livePids: new Set([LIVE_PID]) }));
		expect(result?.kind).toBe("RECOVERY_BLOCKED");
		expect(result?.text).toContain("live holder");
		expect(brCalls).toEqual([]);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(false);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-negative] live database holder: named latch, zero recover commands, zero rate receipt", () => {
	const planted = plantedRepo();
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, {
			livePids: new Set([LIVE_PID]),
			lsof: { code: 0, stdout: `${LIVE_PID}\n`, stderr: "" },
		}));
		expect(result?.kind).toBe("RECOVERY_BLOCKED");
		expect(result?.text).toContain("DATABASE_HOLDER_LATCH");
		expect(result?.text).toContain(`database holder PID ${LIVE_PID} is live`);
		expect(brCalls).toEqual([]);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(false);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-negative] UNKNOWN lsof result: named block, zero recover commands, zero rate receipt", () => {
	const planted = plantedRepo();
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, {
			lsof: { code: 1, stdout: "", stderr: "lsof: status error: Permission denied" },
		}));
		expect(result?.kind).toBe("RECOVERY_BLOCKED");
		expect(result?.text).toContain("database holder liveness is unknown");
		expect(brCalls).toEqual([]);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(false);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-negative] unadmitted director: admission refusal blocks with zero effects", () => {
	const planted = plantedRepo();
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, {
			...baseDeps(brCalls),
			admission: {
				launcherBinding: "keeper",
				authority: "PAUSED",
				authorityConfirmed: true,
				authorityGeneration: 1,
				launchers: [],
				keeper: null,
				packet: { action: "nudge", ownedAction: "nudge", generation: 1 },
				governedActions: ["tracker-recovery"],
			},
		});
		expect(result?.kind).toBe("RECOVERY_BLOCKED");
		expect(result?.text).toContain("refused by pause/custody admission");
		expect(brCalls).toEqual([]);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(false);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[a-negative] blocked holder consumes no rate: next tick after holder exit proceeds", () => {
	const planted = plantedRepo();
	const firstCalls: string[][] = [];
	try {
		const blocked = recoverBusyTracker(planted.repo, SESSION, baseDeps(firstCalls, {
			livePids: new Set([LIVE_PID]),
			lsof: { code: 0, stdout: `${LIVE_PID}\n`, stderr: "" },
		}));
		expect(blocked?.kind).toBe("RECOVERY_BLOCKED");
		expect(firstCalls).toEqual([]);
		expect(existsSync(rateReceiptPath(planted.repo))).toBe(false);
		// Only the holder exits; nothing else changes. The next eligible tick
		// must proceed rather than inherit a rate delay from the refused attempt.
		const secondCalls: string[][] = [];
		const proceeded = recoverBusyTracker(planted.repo, SESSION, baseDeps(secondCalls, {
			lsof: { code: 1, stdout: "", stderr: "" },
		}));
		expect(proceeded?.kind).toBe("RECOVERY_PROCEEDED");
		expect(secondCalls).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] holder guard bypassed (liveness lies): control fails, recovery proceeds", () => {
	const planted = plantedRepo();
	const brCalls: string[][] = [];
	try {
		// lsof names a holder, but the liveness feed claims it is dead: with
		// the guard signal bypassed the branch-specific control must fail.
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, {
			livePids: new Set(),
			lsof: { code: 0, stdout: `${LIVE_PID}\n`, stderr: "" },
		}));
		expect(result?.kind).toBe("RECOVERY_PROCEEDED");
		expect(brCalls).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] lease guard bypassed (holder reads dead): stale takeover proceeds", () => {
	const planted = plantedRepo();
	plantLease(planted.runDir, { schema_version: 1, lease_id: "live", pid: LIVE_PID, process_start: LIVE_START, session: SESSION, session_id: "$22", acquired_at: new Date(T1).toISOString() });
	const brCalls: string[][] = [];
	try {
		// The lease names a live holder, but liveness reports it dead: the
		// lease branch takes the stale path and the control fails to block.
		const result = recoverBusyTracker(planted.repo, SESSION, baseDeps(brCalls, { livePids: new Set() }));
		expect(result?.kind).toBe("RECOVERY_PROCEEDED");
		expect(brCalls).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] rate guard bypassed (receipt unreadable): recovery proceeds inside the window", () => {
	const planted = plantedRepo();
	writeFileSync(rateReceiptPath(planted.repo), JSON.stringify({ schema_version: 1, at_ms: T1, kind: "attempted" }));
	const brCalls: string[][] = [];
	try {
		const result = recoverBusyTracker(planted.repo, SESSION, {
			...baseDeps(brCalls, { nowMs: T1 + 5 * 60_000 }),
			readRateReceipt: () => null,
		});
		expect(result?.kind).toBe("RECOVERY_PROCEEDED");
		expect(brCalls).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("defaultPostRecoverReadback maps native br list exit codes", () => {
	const seen: string[][] = [];
	const ok = defaultPostRecoverReadback("/repo", (args, _cwd) => { seen.push([...args]); return { code: 0, stdout: "[]", stderr: "" }; });
	expect(ok).toEqual({ ok: true, detail: "native br list succeeded" });
	expect(seen).toEqual([["br", "list"]]);
	const failed = defaultPostRecoverReadback("/repo", () => ({ code: 1, stdout: "", stderr: "locked" }));
	expect(failed.ok).toBe(false);
	expect(failed.detail).toContain("native br list exited 1");
});

function fleetConfig(repoA: string, repoB: string, repoC: string, repoD: string): FleetWatchConfig {
	return {
		enabled: true,
		intervalSeconds: 60,
		noDecisionChecks: 5,
		sessions: [
			{ session: "s1", coordinatorPane: "%1", coordinatorSession: "s1", repo: repoA, workerPanes: [] },
			{ session: "s2", coordinatorPane: "%1", coordinatorSession: "s2", repo: repoA, workerPanes: [] },
			{ session: "s3", coordinatorPane: "%1", coordinatorSession: "s3", repo: repoB, workerPanes: [] },
		],
		registeredTrackers: [
			{ repo: repoA, session: "s1" },
			{ repo: repoC, session: "s3" },
			{ repo: repoD, session: "ghost-director" },
		],
	};
}

test("[coverage] registry fixtures: exact coverage, no duplicates, foreign director blocked", () => {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = ownedTmp("tracker-coverage-rhy9-13", { root: parent }).path;
	const logPath = join(scratch, "fleet-watch.jsonl");
	try {
		const recoverCalls: [string, string][] = [];
		const recoverTracker = (repo: string, session: string): TrackerRecoveryResult | null => {
			recoverCalls.push([repo, session]);
			return { kind: "RECOVERY_PROCEEDED", text: `Fleet Watch: zero live holders; proceeded for ${session}.` };
		};
		const actions = runFleetWatchOnce(fleetConfig(join(scratch, "a"), join(scratch, "b"), join(scratch, "c"), join(scratch, "d")), {
			capture: () => ({ code: 0, stdout: "", stderr: "" }),
			send: () => { throw new Error("must not send"); },
			sendKeys: () => { throw new Error("must not steer"); },
			logPath,
			recoverTracker,
			gitLockReap: null,
		});
		// s1+s2 share repo A (one recover), s3 owns B, registry adds C under
		// owning director s3, and D names a foreign director: 3 recovers, 1 block.
		expect(recoverCalls).toEqual([
			[join(scratch, "a"), "s1"],
			[join(scratch, "b"), "s3"],
			[join(scratch, "c"), "s3"],
		]);
		const blocked = actions.filter((action) => action.kind === "RECOVERY_BLOCKED");
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.text).toContain("NO_OWNING_DIRECTOR");
		expect(blocked[0]?.text).toContain("ghost-director");
		expect(blocked[0]?.text).toContain(join(scratch, "d"));
		const logged = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(logged).toHaveLength(4);
		for (const line of logged) {
			expect(line.repo).toMatch(scratch);
			expect(typeof line.session).toBe("string");
			expect(typeof line.text).toBe("string");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
