import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { auditReservationAge, projectSlug } from "../../src/reservation-age.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "reservation-age-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=reservation-age-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

const NOW = Date.parse("2026-10-05T20:00:00Z");
const PROJECT = "/Users/josh/Developer/omp-kit-companion";

function fixtureArchive(records: Array<Record<string, unknown>>): string {
	const root = join(scratch, "archive-" + Math.random().toString(36).slice(2));
	const dir = join(root, "projects", projectSlug(PROJECT), "file_reservations");
	mkdirSync(dir, { recursive: true });
	records.forEach((record, index) => {
		writeFileSync(join(dir, "hold-" + index + ".json"), JSON.stringify(record));
	});
	return root;
}

function hold(minutesOld: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 1000 + Math.floor(Math.random() * 1000),
		agent_name: "OldHolder",
		path_pattern: "src/old.ts",
		exclusive: true,
		reason: "ompkit-demo.1",
		created_ts: new Date(NOW - minutesOld * 60000).toISOString(),
		expires_ts: new Date(NOW + 60 * 60000).toISOString(),
		...extra,
	};
}

test("CYCLE1 planted: a 45-minute hold is reported, a 10-minute hold is not", () => {
	const root = fixtureArchive([hold(45), { ...hold(10), agent_name: "FreshHolder", path_pattern: "src/new.ts", reason: "ompkit-demo.2" }]);
	const report = auditReservationAge({ archiveRoot: root, projectKey: PROJECT, nowMs: NOW });
	expect(report.overdue.map((row) => row.agent_name)).toEqual(["OldHolder"]);
	expect(report.overdue[0]).toMatchObject({ path_pattern: "src/old.ts", bead: "ompkit-demo.1" });
	expect(report.overdue[0]?.age_minutes).toBeGreaterThan(30);
	expect(report.limit_minutes).toBe(30);
});

test("CYCLE1: released, expired and non-exclusive holds are excluded; bad records count unreadable", () => {
	const root = fixtureArchive([
		{ ...hold(60), released_ts: new Date(NOW - 5 * 60000).toISOString() },
		{ ...hold(60), expires_ts: new Date(NOW - 5 * 60000).toISOString() },
		{ ...hold(60), exclusive: false },
		{ no_shape: true },
	]);
	const report = auditReservationAge({ archiveRoot: root, projectKey: PROJECT, nowMs: NOW });
	expect(report.overdue).toEqual([]);
	expect(report.checked).toBe(0);
	expect(report.unreadable).toBe(1);
});

test("CYCLE1: missing archive reads as empty, custom limit applies", () => {
	const empty = auditReservationAge({ archiveRoot: join(scratch, "nope"), projectKey: PROJECT, nowMs: NOW });
	expect(empty).toMatchObject({ checked: 0, overdue: [] });
	const root = fixtureArchive([hold(45)]);
	const strict = auditReservationAge({ archiveRoot: root, projectKey: PROJECT, limitMinutes: 60, nowMs: NOW });
	expect(strict.overdue).toEqual([]);
	expect(strict.limit_minutes).toBe(60);
});
