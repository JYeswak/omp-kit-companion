// Affected-test source dependencies: src/land.ts
// land reads reservations from the Board only (bead ompkit-tnqyr.3): no Agent Mail call, no attestation from an am server.
import { expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { LAND_DEFAULT_TIMEOUT_MS, command, fixture, landArgs, repoRoot, responseCode } from "./private-index-land.helpers.ts";

setDefaultTimeout(Math.max(LAND_DEFAULT_TIMEOUT_MS, Math.round(fixtureDeadlineS(90) * 1000)));

const own = { agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 };
const other = { agent: "OtherSeat", path: "owned.txt", exclusive: true, remaining_seconds: 3600 };

function land(holds: unknown[], options: { reservationMode?: string } = {}) {
	const f = fixture();
	writeFileSync(join(f.work, "owned.txt"), "base owned\nowner change\n");
	return { f, run: () => command(f.work, landArgs("owned.txt"), holds, { amDir: f.fakeBin, ...options }) };
}

test("BOARDLAND1 a fake Board holding another seat's reservation on the staged path refuses the land", () => {
	// Own hold present too, so only the foreign hold can refuse: ignoring the Board would let this land.
	const { run } = land([own, other]);
	const result = run();
	expect(responseCode(result.body), JSON.stringify(result.body)).toBe("RESERVATION_HELD_BY_OTHER");
	expect(JSON.stringify(result.body)).toContain("OtherSeat");
});

test("BOARDLAND1 a glob another seat holds over the staged path refuses too", () => {
	const { run } = land([own, { ...other, path: "*.txt" }]);
	expect(responseCode(run().body)).toBe("RESERVATION_HELD_BY_OTHER");
});

test("BOARDLAND1 your own reservation proceeds past the reservation step and lands", () => {
	const { run } = land([own]);
	const result = run();
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	const data: unknown = result.body.data;
	expect(data !== null && typeof data === "object" && "overall" in data ? data.overall : undefined).toBe("PUSHED");
});

test("BOARDLAND1 no reservation at all refuses RESERVATION_REQUIRED, not a pass", () => {
	const { run } = land([]);
	expect(responseCode(run().body)).toBe("RESERVATION_REQUIRED");
});

test("BOARDLAND1 Board down with no snapshot refuses BOARD_UNREACHABLE and says so", () => {
	const { run } = land([own], { reservationMode: "unavailable" });
	const result = run();
	expect(responseCode(result.body), JSON.stringify(result.body)).toBe("BOARD_UNREACHABLE");
	expect(JSON.stringify(result.body)).toContain("no last-good snapshot exists");
});

test("BOARDLAND1 Board down after a good read refuses BOARD_UNREACHABLE and names the snapshot age, never admitting from it", () => {
	const f = fixture();
	writeFileSync(join(f.work, "owned.txt"), "base owned\nowner change\n");
	const noPass = { amDir: f.fakeBin };
	// A land that reads the Board successfully writes the last-good snapshot into this fixture's state dir.
	command(f.work, landArgs("owned.txt"), [own], noPass);
	const down = command(f.work, landArgs("owned.txt"), [own], { ...noPass, reservationMode: "unavailable" });
	expect(responseCode(down.body), JSON.stringify(down.body)).toBe("BOARD_UNREACHABLE");
	expect(JSON.stringify(down.body)).toMatch(/last-good snapshot is \d+ s old/);
});

test("BOARDLAND1 land.ts has no Agent Mail call on the reservation or owner path", () => {
	const source = readFileSync(join(repoRoot, "src", "land.ts"), "utf8");
	for (const forbidden of ['"robot", "reservations"', '"agents", "resolve-pane"', '"file_reservations"', "AGENT_MAIL_UNAVAILABLE"]) expect(source).not.toContain(forbidden);
});
