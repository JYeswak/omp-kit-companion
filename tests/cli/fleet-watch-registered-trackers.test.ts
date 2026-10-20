import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadFleetWatchConfig, runFleetWatchOnce, type FleetWatchConfig } from "../../src/fleet-watch.ts";
import type { TrackerRecoveryResult } from "../../src/tracker-recovery.ts";

// ompkit-ps3lo: config.registeredTrackers lands for retention wiring.
// Positive, planted negatives, and legacy-absent coverage.

const repoRoot = resolve(import.meta.dir, "../..");

function scratchDir(prefix: string): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	return mkdtempSync(join(parent, prefix));
}

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

function tickDeps(logPath: string, recoverCalls: [string, string][]) {
	return {
		capture: () => ({ code: 0, stdout: "", stderr: "" }),
		send: () => { throw new Error("must not send"); },
		sendKeys: () => { throw new Error("must not steer"); },
		logPath,
		recoverTracker: (repo: string, session: string): TrackerRecoveryResult | null => {
			recoverCalls.push([repo, session]);
			return { kind: "RECOVERY_PROCEEDED", text: `Fleet Watch: zero live holders; proceeded for ${session}.` };
		},
	};
}

test("[a-positive] registry fixtures: exact coverage, no duplicates, foreign director blocked", () => {
	const scratch = scratchDir("tracker-registry-ps3lo.");
	const logPath = join(scratch, "fleet-watch.jsonl");
	try {
		const recoverCalls: [string, string][] = [];
		const actions = runFleetWatchOnce(
			fleetConfig(join(scratch, "a"), join(scratch, "b"), join(scratch, "c"), join(scratch, "d")),
			tickDeps(logPath, recoverCalls),
		);
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

test("[a-positive] loadFleetWatchConfig round-trips valid registeredTrackers", () => {
	const scratch = scratchDir("tracker-registry-load-ps3lo.");
	try {
		const path = join(scratch, "fleet-watch.json");
		writeFileSync(path, JSON.stringify({
			enabled: true,
			intervalSeconds: 60,
			noDecisionChecks: 5,
			sessions: [{ session: "s1", coordinatorPane: "%1", coordinatorSession: "s1", repo: join(scratch, "a"), workerPanes: [] }],
			registeredTrackers: [{ repo: join(scratch, "c"), session: "s1" }],
		}));
		const config = loadFleetWatchConfig(path);
		expect(config.registeredTrackers).toEqual([{ repo: join(scratch, "c"), session: "s1" }]);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("[a-negative] loadFleetWatchConfig rejects malformed registeredTrackers", () => {
	const scratch = scratchDir("tracker-registry-bad-ps3lo.");
	try {
		const cases: Array<{ name: string; value: unknown }> = [
			{ name: "non-array", value: { repo: "a", session: "s1" } },
			{ name: "non-object entry", value: ["s1"] },
			{ name: "missing session", value: [{ repo: join(scratch, "a") }] },
			{ name: "empty repo", value: [{ repo: "  ", session: "s1" }] },
			{ name: "empty session", value: [{ repo: join(scratch, "a"), session: "" }] },
		];
		for (const kase of cases) {
			const path = join(scratch, `${kase.name}.json`);
			writeFileSync(path, JSON.stringify({
				enabled: true,
				intervalSeconds: 60,
				noDecisionChecks: 5,
				sessions: [{ session: "s1", coordinatorPane: "%1", coordinatorSession: "s1", repo: join(scratch, "a"), workerPanes: [] }],
				registeredTrackers: kase.value,
			}));
			expect(() => loadFleetWatchConfig(path), kase.name).toThrow("FLEET_WATCH_CONFIG_INVALID: registeredTrackers");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("[a-negative] absent registeredTrackers keeps legacy sessions-only coverage", () => {
	const scratch = scratchDir("tracker-registry-absent-ps3lo.");
	const logPath = join(scratch, "fleet-watch.jsonl");
	try {
		const recoverCalls: [string, string][] = [];
		const config = fleetConfig(join(scratch, "a"), join(scratch, "b"), join(scratch, "c"), join(scratch, "d"));
		delete config.registeredTrackers;
		const actions = runFleetWatchOnce(config, tickDeps(logPath, recoverCalls));
		expect(recoverCalls).toEqual([
			[join(scratch, "a"), "s1"],
			[join(scratch, "b"), "s3"],
		]);
		expect(actions.filter((action) => action.kind === "RECOVERY_BLOCKED")).toHaveLength(0);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
