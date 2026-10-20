import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce, type FleetWatchConfig } from "../../src/fleet-watch.ts";
import {
	checkTrackerRecoveryCutover,
	defaultPostRecoverReadback,
	recoverBusyTracker,
	TRACKER_RECOVERY_CUTOVER_KIT_VERSION,
	type TrackerRecoveryCommandResult,
	type TrackerRecoveryCutoverInput,
	type TrackerRecoveryDeps,
	type TrackerRecoveryResult,
} from "../../src/tracker-recovery.ts";
import type { LivenessDeps } from "../../src/scratch.ts";

// ompkit-rhy9.16: retire the duplicated project recovery branch only after the
// exact successor kit ships. Positive, planted negatives, bypass controls, and
// the shipped live-tracker SQLite-reader rule (fires on prohibited readers,
// quiet on native br/bv twins and disposable copies).

const repoRoot = resolve(import.meta.dir, "../..");
const BUSY = JSON.stringify({ error: "database is busy (recovery in progress)" });
const T1 = 1_791_276_000_000;
const SESSION = "omp-test";
const KIT = TRACKER_RECOVERY_CUTOVER_KIT_VERSION;

function plantedRepo(): { scratch: string; repo: string; runDir: string } {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, "tracker-recovery-rhy9-16."));
	writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=tracker-recovery-rhy9-16\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`, { mode: 0o600 });
	const repo = join(scratch, "repo");
	const runDir = join(repo, ".beads", ".br_recovery", "schema-migrations", "20261010T000000.000000Z-9-0");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "recovery-failed.json"), `${BUSY}\n`);
	return { scratch, repo, runDir };
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

function stubRun(brCalls: string[][], lsof: { code: number; stdout: string; stderr: string }) {
	return (args: readonly string[], cwd: string): TrackerRecoveryCommandResult => {
		if (args[0] === "lsof") return { ...lsof };
		if (args[0] === "br" && args[1] === "--version") return { code: 0, stdout: "br 0.7.4\n", stderr: "" };
		if (args[0] === "br") {
			brCalls.push([...args, `cwd=${cwd}`]);
			return { code: 0, stdout: args[1] === "list" ? "[]" : "recovered", stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
}

const CLEAR_LSOF = { code: 0, stdout: "", stderr: "" };

function recoveryDeps(brCalls: string[][], options: { livePids?: ReadonlySet<number>; lsof?: { code: number; stdout: string; stderr: string }; nowMs?: number } = {}) {
	const run = stubRun(brCalls, options.lsof ?? CLEAR_LSOF);
	return {
		pid: OWNER_PID,
		liveness: livenessWith(options.livePids ?? new Set()),
		sessionId: () => "$22" as string | null,
		run,
		now: () => options.nowMs ?? T1,
		leaseId: () => "rhy9-16-lease",
		postRecoverReadback: (repo: string, inner: (args: readonly string[], cwd: string) => TrackerRecoveryCommandResult) => defaultPostRecoverReadback(repo, inner),
	};
}

function tickConfig(repo: string): FleetWatchConfig {
	return {
		enabled: true,
		intervalSeconds: 60,
		noDecisionChecks: 5,
		sessions: [{ session: "s1", coordinatorPane: "%1", coordinatorSession: "s1", repo, workerPanes: [] }],
		registeredTrackers: [{ repo, session: "s1" }],
	};
}

function tickDeps(logPath: string, brCalls: string[][], options: {
	cutover?: TrackerRecoveryCutoverInput | null;
	recovery?: TrackerRecoveryDeps;
	nowMs?: number;
	recoverCalls?: [string, string][];
} = {}) {
	const rec = options.recovery ?? recoveryDeps(brCalls, { nowMs: options.nowMs });
	return {
		capture: () => ({ code: 0, stdout: "", stderr: "" }),
		send: () => { throw new Error("must not send"); },
		sendKeys: () => { throw new Error("must not steer"); },
		logPath,
		statePath: null,
		now: () => options.nowMs ?? T1,
		recoverTracker: (repo: string, session: string): TrackerRecoveryResult | null => {
			options.recoverCalls?.push([repo, session]);
			return recoverBusyTracker(repo, session, rec);
		},
		...(options.cutover === undefined ? {} : { recoveryCutover: options.cutover === null ? null : () => options.cutover }),
		gitLockReap: null,
	};
}

function logLines(logPath: string): Record<string, unknown>[] {
	return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const GREEN: TrackerRecoveryCutoverInput = { installedKitVersion: KIT, healthJobEnabled: true, trackerRegistered: true };

test("[cutover-positive] retired: only kit recovery executes, duplicated branch absent, next tick receipted", () => {
	const planted = plantedRepo();
	const logPath = join(planted.scratch, "fleet-watch.jsonl");
	const brCalls: string[][] = [];
	const recoverCalls: [string, string][] = [];
	try {
		// Pre-recovery native readback on the isolated copy: rc 0.
		const run = stubRun(brCalls, CLEAR_LSOF);
		const pre = run(["br", "list"], planted.repo);
		expect(pre.code).toBe(0);
		const preCalls = brCalls.length;

		const actions = runFleetWatchOnce(tickConfig(planted.repo), tickDeps(logPath, brCalls, { cutover: GREEN, recoverCalls }));
		// Exactly one kit recovery, via the registry loop; the duplicated
		// per-session branch never ran.
		expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
		const cutover = logLines(logPath).filter((line) => line.kind === "TRACKER_RECOVERY_CUTOVER");
		expect(cutover).toHaveLength(1);
		expect(String(cutover[0]?.text)).toContain("duplicated project recovery branch retired");
		const proceeded = actions.filter((action) => action.kind === "RECOVERY_PROCEEDED");
		expect(proceeded).toHaveLength(1);
		const first = proceeded[0];
		const receipt = first && typeof first === "object" && "receipt" in first ? first.receipt : undefined;
		const upstream = receipt && typeof receipt === "object" && "upstream" in receipt ? receipt.upstream : undefined;
		expect(upstream && typeof upstream === "object" && "issue" in upstream ? upstream.issue : undefined).toBe("beads_rust#532");
		expect(receipt && typeof receipt === "object" && "artifact_bound" in receipt ? receipt.artifact_bound : undefined).toBe(1);
		// Only kit commands ran: recover + post-recover native br list (rc 0).
		expect(brCalls.slice(preCalls)).toEqual([
			["br", "doctor", "migrate-schema", "recover", `cwd=${planted.repo}`],
			["br", "list", `cwd=${planted.repo}`],
		]);
		expect(String(proceeded[0]?.text)).toContain("Post-recover native readback ok");

		// Next tick: the rate receipt gates a second recovery; the retired
		// branch stays absent and no further kit command runs.
		const before = brCalls.length;
		const actions2 = runFleetWatchOnce(tickConfig(planted.repo), tickDeps(logPath, brCalls, { cutover: GREEN, recoverCalls, nowMs: T1 + 60_000 }));
		expect(recoverCalls).toHaveLength(2);
		const limited = actions2.filter((action) => action.kind === "RECOVERY_BLOCKED");
		expect(limited).toHaveLength(1);
		expect(String(limited[0]?.text)).toContain("rate-limited");
		expect(brCalls).toHaveLength(before);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

for (const [name, cutover, reason] of [
	["missing install", { installedKitVersion: null, healthJobEnabled: true, trackerRegistered: true }, "install is missing"],
	["stale install", { installedKitVersion: "0.2.62", healthJobEnabled: true, trackerRegistered: true }, "is stale"],
	["unparseable version", { installedKitVersion: "next", healthJobEnabled: true, trackerRegistered: true }, "unparseable"],
	["disabled health job", { installedKitVersion: KIT, healthJobEnabled: false, trackerRegistered: true }, "health job is disabled"],
	["registry omission", { installedKitVersion: KIT, healthJobEnabled: true, trackerRegistered: false }, "absent from the registry"],
] as [string, TrackerRecoveryCutoverInput, string][]) {
	test(`[cutover-negative] ${name} blocks retirement with the incumbent intact`, () => {
		const planted = plantedRepo();
		const logPath = join(planted.scratch, "fleet-watch.jsonl");
		const brCalls: string[][] = [];
		const recoverCalls: [string, string][] = [];
		try {
			const verdict = checkTrackerRecoveryCutover(cutover);
			expect(verdict.retired).toBe(false);
			if (!verdict.retired) expect(verdict.reason).toContain(reason);
			const actions = runFleetWatchOnce(tickConfig(planted.repo), tickDeps(logPath, brCalls, { cutover, recoverCalls }));
			// The local incumbent ran (session branch first, registry dedupes).
			expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
			expect(logLines(logPath).filter((line) => line.kind === "TRACKER_RECOVERY_CUTOVER")).toHaveLength(0);
			expect(actions.filter((action) => action.kind === "RECOVERY_PROCEEDED")).toHaveLength(1);
			expect(brCalls[0]?.slice(0, 4)).toEqual(["br", "doctor", "migrate-schema", "recover"]);
		} finally {
			rmSync(planted.scratch, { recursive: true, force: true });
		}
	});
}

test("[cutover-negative] retired cutover never recovers over a live holder", () => {
	const planted = plantedRepo();
	writeFileSync(join(planted.runDir, ".omp-kit-recovery-lease.json"), `${JSON.stringify({ schema_version: 1, lease_id: "live", pid: LIVE_PID, process_start: LIVE_START, session: SESSION, session_id: "$22", acquired_at: new Date(T1).toISOString() })}\n`, { mode: 0o600 });
	const logPath = join(planted.scratch, "fleet-watch.jsonl");
	const brCalls: string[][] = [];
	const recoverCalls: [string, string][] = [];
	try {
		const actions = runFleetWatchOnce(tickConfig(planted.repo), {
			...tickDeps(logPath, brCalls, { cutover: GREEN, recoverCalls }),
			recoverTracker: (repo: string, session: string): TrackerRecoveryResult | null => {
				recoverCalls.push([repo, session]);
				return recoverBusyTracker(repo, session, recoveryDeps(brCalls, { livePids: new Set([LIVE_PID]) }));
			},
		});
		expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
		const blocked = actions.filter((action) => action.kind === "RECOVERY_BLOCKED");
		expect(blocked).toHaveLength(1);
		expect(String(blocked[0]?.text)).toContain("live holder");
		expect(brCalls.filter((call) => call[1] === "doctor")).toHaveLength(0);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] registry coverage without cutover evidence keeps the incumbent", () => {
	const planted = plantedRepo();
	const logPath = join(planted.scratch, "fleet-watch.jsonl");
	const brCalls: string[][] = [];
	const recoverCalls: [string, string][] = [];
	try {
		const actions = runFleetWatchOnce(tickConfig(planted.repo), tickDeps(logPath, brCalls, { recoverCalls }));
		expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
		expect(logLines(logPath).filter((line) => line.kind === "TRACKER_RECOVERY_CUTOVER")).toHaveLength(0);
		expect(actions.filter((action) => action.kind === "RECOVERY_PROCEEDED")).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] null cutover probe keeps the incumbent", () => {
	const planted = plantedRepo();
	const logPath = join(planted.scratch, "fleet-watch.jsonl");
	const brCalls: string[][] = [];
	const recoverCalls: [string, string][] = [];
	try {
		const actions = runFleetWatchOnce(tickConfig(planted.repo), tickDeps(logPath, brCalls, { cutover: null, recoverCalls }));
		expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
		expect(logLines(logPath).filter((line) => line.kind === "TRACKER_RECOVERY_CUTOVER")).toHaveLength(0);
		expect(actions.filter((action) => action.kind === "RECOVERY_PROCEEDED")).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

test("[bypass] null probe answer for one repo retires nothing", () => {
	const planted = plantedRepo();
	const logPath = join(planted.scratch, "fleet-watch.jsonl");
	const brCalls: string[][] = [];
	const recoverCalls: [string, string][] = [];
	try {
		const verdict = checkTrackerRecoveryCutover(GREEN);
		expect(verdict).toEqual({ retired: true });
		const actions = runFleetWatchOnce(tickConfig(planted.repo), {
			...tickDeps(logPath, brCalls, { recoverCalls }),
			recoveryCutover: () => null,
		});
		expect(recoverCalls).toEqual([[planted.repo, "s1"]]);
		expect(logLines(logPath).filter((line) => line.kind === "TRACKER_RECOVERY_CUTOVER")).toHaveLength(0);
		expect(actions.filter((action) => action.kind === "RECOVERY_PROCEEDED")).toHaveLength(1);
	} finally {
		rmSync(planted.scratch, { recursive: true, force: true });
	}
});

function loadRule(): { patterns: RegExp[]; body: string } {
	const raw = readFileSync(join(repoRoot, "rules", "kit-no-live-tracker-sqlite.md"), "utf8");
	const frontmatter = raw.split("---")[1] ?? "";
	const sources = [...frontmatter.matchAll(/^\s+-\s*'(.*)'\s*$/gm)].map((m) => (m[1] ?? "").replace(/''/g, "'"));
	expect(sources.length).toBeGreaterThan(0);
	return { patterns: sources.map((s) => new RegExp(s)), body: raw };
}

test("[rule] prohibited live SQLite reader fires the shipped rule; native twin stays quiet", () => {
	const { patterns, body } = loadRule();
	const prohibited = [
		`sqlite3 /repo/.beads/beads.db "select * from issues"`,
		`sqlite3 '/repo/.beads/beads.db' .dump`,
		`{"path": "/repo/.beads/beads.db"}`,
		`{"uri": "file:///repo/.beads/beads.db"}`,
		`sqlite3("/repo/.beads/beads.db")`,
		`new Database('/repo/.beads/beads.db')`,
		`ATTACH '/repo/.beads/beads.db' AS live`,
		`persistent kernel: sqlite3.open("/repo/.beads/beads.db")`,
		`db = sqlite3.connect('/repo/.beads/beads.db')`,
	];
	for (const sample of prohibited) expect(patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(sample); })).toBe(true);
	const allowed = [
		"br list --status open --json",
		"br show ompkit-rhy9.16 --json",
		"bv --robot-triage",
		`sqlite3 var/agent-tmp/copy.123/beads-copy.db "select 1"`,
		`cp /repo/.beads/beads.db var/agent-tmp/copy.123/beads-copy.db`,
		`{"path": "/repo/src/tracker-recovery.ts"}`,
		`ATTACH '/tmp/copy.db' AS c`,
	];
	for (const sample of allowed) expect(patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(sample); })).toBe(false);
	expect(body).toContain("br list");
	expect(body).toContain("bv --robot-triage");
	expect(body).toContain("disposable");
	expect(body).toContain("beads_rust#532");
});
