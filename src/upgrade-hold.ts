import { lstatSync, readFileSync, type Stats } from "node:fs";
import { join } from "node:path";

/**
 * UPGRADEHOLD1 (ompkit-7pfj1): the one switch that holds the fleet on its current omp-kit release.
 *
 * On 2026-11-21 a macOS permission prompt nobody could answer made every new omp start hang, so the chief had to keep
 * seats from restarting. The only brake was 607 hand-edited per-seat marker files, and the kit-update job still
 * installed the next release by itself 90 seconds after it was published. This file is the switch both consumers read:
 * `kit-upgrade-notice` sends no notice while it holds, and the `kit-update` job installs nothing.
 *
 * `<state root>/upgrade-hold.json`: `{ "reason": "...", "by": "<agent>", "until": "<ISO time>" }`. A hold always
 * ends: it holds while now is before the earlier of `until` and the file's age limit (14 days). A file that cannot be
 * read as a hold (bad JSON, missing field, a directory) still holds, for one day from its mtime, and says why in
 * `problem`, so a typo never leaves the fleet held for good or unheld by accident. Release it by deleting the file.
 */
export const UPGRADE_HOLD_FILE = "upgrade-hold.json";
export const UPGRADE_HOLD_MAX_MS = 14 * 24 * 60 * 60 * 1000;
export const UPGRADE_HOLD_INVALID_MS = 24 * 60 * 60 * 1000;
const MAX_HOLD_BYTES = 8192;

export interface UpgradeHold { reason: string; by: string; until: string }
export type UpgradeHoldState =
	| { held: false }
	| { held: true; hold: UpgradeHold | null; problem: string | null; endsAt: number };

function text(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The hold at `<stateRoot>/upgrade-hold.json` as of `now`. Never throws: an unreadable file is an invalid hold. */
export function readUpgradeHold(stateRoot: string, now: number = Date.now()): UpgradeHoldState {
	const path = join(stateRoot, UPGRADE_HOLD_FILE);
	let stat: Stats | undefined;
	try {
		stat = lstatSync(path, { throwIfNoEntry: false });
	} catch (error) {
		// Not even a stat answers: nothing says when the file was written, so this hold is judged from now (it ends one day after the error stops).
		return heldInvalid(now, now, `UPGRADE_HOLD_UNREADABLE: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (stat === undefined) return { held: false };
	const mtime = stat.mtimeMs;
	if (!stat.isFile() || stat.size > MAX_HOLD_BYTES) return heldInvalid(now, mtime, "UPGRADE_HOLD_INVALID: not a regular file under 8 KiB");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return heldInvalid(now, mtime, `UPGRADE_HOLD_INVALID: not readable JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (parsed === null || typeof parsed !== "object") return heldInvalid(now, mtime, "UPGRADE_HOLD_INVALID: not a JSON object");
	const reason = text(Reflect.get(parsed, "reason"));
	const by = text(Reflect.get(parsed, "by"));
	const until = text(Reflect.get(parsed, "until"));
	const untilMs = until === null ? Number.NaN : Date.parse(until);
	if (reason === null || by === null || until === null || Number.isNaN(untilMs)) {
		return heldInvalid(now, mtime, "UPGRADE_HOLD_INVALID: reason, by and an ISO until are all required");
	}
	const endsAt = Math.min(untilMs, mtime + UPGRADE_HOLD_MAX_MS);
	return now < endsAt ? { held: true, hold: { reason, by, until }, problem: null, endsAt } : { held: false };
}

function heldInvalid(now: number, mtime: number, problem: string): UpgradeHoldState {
	const endsAt = mtime + UPGRADE_HOLD_INVALID_MS;
	return now < endsAt ? { held: true, hold: null, problem, endsAt } : { held: false };
}
