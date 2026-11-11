import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { loadFleetWatchConfig } from "../../src/fleet-watch.ts";

// ompkit-ps3lo: config.registeredTrackers lands for retention wiring.
// ompkit-1ra0d.123 DEADTICK1: retention wiring is deleted with
// retainTrackerQuarantine; only the config round-trip coverage remains.

const repoRoot = resolve(import.meta.dir, "../..");

function scratchDir(label: string): string {
	const parent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(parent, { recursive: true });
	return ownedTmp(label, { root: parent }).path;
}

// ompkit-1ra0d.123 DEADTICK1: the recovery tick tests are deleted with
// recoverBusyTracker; only the config round-trip coverage remains.

test("[a-positive] loadFleetWatchConfig round-trips valid registeredTrackers", () => {
	const scratch = scratchDir("tracker-registry-load-ps3lo");
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
	const scratch = scratchDir("tracker-registry-bad-ps3lo");
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


afterAll(() => cleanupAllOwnedTmp());
