import { expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { readUpgradeHold, UPGRADE_HOLD_FILE, UPGRADE_HOLD_INVALID_MS, UPGRADE_HOLD_MAX_MS } from "../../src/upgrade-hold.ts";

// UPGRADEHOLD1 (ompkit-7pfj1): the one switch that holds the fleet on its release. Every case passes `now`, so no test waits.

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-21T14:00:00.000Z");

function stateWith(content: string | null, mtimeMs: number = NOW): { root: string; cleanup: () => void } {
	const temp = ownedTmp("upgrade-hold");
	const root = join(temp.path, "omp-kit");
	mkdirSync(root, { recursive: true });
	if (content !== null) {
		const file = join(root, UPGRADE_HOLD_FILE);
		writeFileSync(file, content);
		utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	}
	return { root, cleanup: temp.cleanup };
}

const valid = (until: string) => JSON.stringify({ reason: "consent prompt pending", by: "PeachLeopard", until });

test("no file is no hold", () => {
	const state = stateWith(null);
	try {
		expect(readUpgradeHold(state.root, NOW)).toEqual({ held: false });
	} finally { state.cleanup(); }
});

test("a valid hold holds until its until, then ends by itself", () => {
	const until = new Date(NOW + 2 * HOUR).toISOString();
	const state = stateWith(valid(until));
	try {
		const during = readUpgradeHold(state.root, NOW + HOUR);
		expect(during).toMatchObject({ held: true, problem: null, hold: { reason: "consent prompt pending", by: "PeachLeopard", until } });
		expect(readUpgradeHold(state.root, NOW + 2 * HOUR)).toEqual({ held: false });
		expect(readUpgradeHold(state.root, NOW + 3 * HOUR)).toEqual({ held: false });
	} finally { state.cleanup(); }
});

test("a hold cannot outlive the file's age limit, whatever its until says", () => {
	const state = stateWith(valid(new Date(NOW + 365 * 24 * HOUR).toISOString()));
	try {
		expect(readUpgradeHold(state.root, NOW + UPGRADE_HOLD_MAX_MS - HOUR).held).toBe(true);
		expect(readUpgradeHold(state.root, NOW + UPGRADE_HOLD_MAX_MS + HOUR)).toEqual({ held: false });
	} finally { state.cleanup(); }
});

test("a file that is not a readable hold still holds, for one day from its mtime, and says why", () => {
	for (const content of ["not json", "[1,2]", "null", JSON.stringify({ reason: "x", by: "y" }), JSON.stringify({ reason: " ", by: "y", until: new Date(NOW + HOUR).toISOString() }), JSON.stringify({ reason: "x", by: "y", until: "tomorrow-ish" })]) {
		const state = stateWith(content);
		try {
			const during = readUpgradeHold(state.root, NOW + HOUR);
			expect(during, content).toMatchObject({ held: true, hold: null });
			expect(during.held && during.problem, content).toContain("UPGRADE_HOLD_INVALID");
			expect(readUpgradeHold(state.root, NOW + UPGRADE_HOLD_INVALID_MS + HOUR), content).toEqual({ held: false });
		} finally { state.cleanup(); }
	}
});

test("a directory in place of the file is an invalid hold, not a crash", () => {
	const state = stateWith(null);
	try {
		mkdirSync(join(state.root, UPGRADE_HOLD_FILE));
		const result = readUpgradeHold(state.root, Date.now());
		expect(result.held && result.problem).toContain("UPGRADE_HOLD_INVALID");
	} finally { state.cleanup(); }
});
