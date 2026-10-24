// STALEDEF1 (ompkit-f9dun) AC3: the reclaim command `omp-kit drain stale-claims` prints
// passes kit-flywheel-guard custody for a dead holder and is refused for a live one.
// The guard re-reads liveness at the act from the same sources drain reads: the seat
// inventory (tern/tmux answered by the fake host + identity files under HOME) and the
// Agent Mail store at AGENT_MAIL_STORAGE_ROOT. Planted: live seat, live reservation,
// unreadable liveness and a non-atomic shape are each refused, even for a recent claim.
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reclaimCommand } from "../../src/drain.ts";
import { createFlywheelHost, toolCall, type Responder } from "./kit-flywheel-host";
import type { FlywheelToolCallResult } from "../../extensions/kit-flywheel-guard";

const HOUR = 3600_000;
const base = ownedTmp("flywheel-reclaim").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));
const NO_SEATS = JSON.stringify({ panes: [], sessions: [] });
const SEAT_11 = JSON.stringify({ panes: [{ pane: 11, exited: null }], sessions: [{ name: "Default", tabs: [{ name: "t", blocks: [{ id: 11, live: true }] }] }] });

type Plant = { holder: string; touchedMs: number; tern?: string | null; reservationFor?: string; activityFor?: string };

function plantedHome(): string {
	const home = ownedTmp("home", { root: base }).path;
	const folder = join(home, ".config", "agent-mail", "identity", "dddddddddddd");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "tern-11"), "SeatHolder\n");
	return home;
}

function plantedStore(now: number, reservationFor?: string, activityFor?: string): string {
	const dir = ownedTmp("mail", { root: base }).path;
	const db = new Database(join(dir, "storage.sqlite3"));
	db.exec("CREATE TABLE agents(id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT)");
	db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, project_id INTEGER, sender_id INTEGER, created_ts INTEGER)");
	db.exec("CREATE TABLE message_recipients(message_id INTEGER, agent_id INTEGER, kind TEXT, read_ts INTEGER, ack_ts INTEGER)");
	db.exec("CREATE TABLE file_reservations(id INTEGER PRIMARY KEY, project_id INTEGER, agent_id INTEGER, path_pattern TEXT, exclusive INTEGER, created_ts INTEGER, expires_ts INTEGER, released_ts INTEGER)");
	db.prepare("INSERT INTO agents VALUES (?,?,?)").run(1, 1, "DeadHolder");
	db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(1, 1, 1, (now - 40 * HOUR) * 1000);
	if (reservationFor !== undefined) {
		db.prepare("INSERT INTO agents VALUES (?,?,?)").run(2, 1, reservationFor);
		db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(1, 1, 2, "src/a.ts", 1, (now - 30 * HOUR) * 1000, (now + HOUR) * 1000, null);
	}
	if (activityFor !== undefined) {
		db.prepare("INSERT INTO agents VALUES (?,?,?)").run(3, 1, activityFor);
		db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(2, 1, 3, (now - HOUR) * 1000);
	}
	db.close();
	return dir;
}

async function reclaim(plant: Plant, command?: (revision: string, now: number) => string): Promise<FlywheelToolCallResult | undefined> {
	const now = Date.now();
	const revision = new Date(plant.touchedMs).toISOString();
	const respond: Responder = call => {
		if (call.command === "tern") return plant.tern === null ? { stdout: "", stderr: "tern daemon unreachable", code: 1 } : { stdout: plant.tern ?? NO_SEATS, stderr: "", code: 0 };
		if (call.command === "tmux") return { stdout: "", stderr: "no server running on /x/default", code: 1 };
		if (call.command === "env") return { stdout: "", stderr: "", code: 0 };
		return { stdout: JSON.stringify([{ id: "k-1", title: "t", status: "in_progress", assignee: plant.holder, updated_at: revision }]), stderr: "", code: 0 };
	};
	const h = await createFlywheelHost(base, {
		env: { BR_ACTOR: "Lead", AGENT_MAIL_STORAGE_ROOT: plantedStore(now, plant.reservationFor, plant.activityFor) },
		home: plantedHome(), respond,
	});
	const project = ownedTmp("proj", { root: base }).path;
	return toolCall(h, project, command ? command(revision, now) : reclaimCommand("k-1", revision, now));
}

const STALE = () => Date.now() - 25 * HOUR;

test("AC3: drain's printed reclaim passes custody for a dead holder (no PARTIAL_RELEASE_REFUSED)", async () => {
	expect(await reclaim({ holder: "DeadHolder", touchedMs: STALE() })).toBeUndefined();
});

test("AC3: the same reclaim is refused for a holder sitting in a live seat", async () => {
	const refused = await reclaim({ holder: "SeatHolder", touchedMs: STALE(), tern: SEAT_11 });
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("PARTIAL_RELEASE_REFUSED");
	expect(refused?.reason).toContain("sits in a live seat");
});

test("AC3: the same reclaim is refused for a holder with a live reservation", async () => {
	const refused = await reclaim({ holder: "Keeper", touchedMs: STALE(), reservationFor: "Keeper" });
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("holds a live reservation");
});

test("a recently touched claim is reclaimable when the holder is proven dead", async () => {
	expect(await reclaim({ holder: "DeadHolder", touchedMs: Date.now() - 2 * HOUR })).toBeUndefined();
});

test("a recent claim remains protected by a live seat, mail activity or reservation", async () => {
	for (const plant of [
		{ holder: "SeatHolder", tern: SEAT_11 },
		{ holder: "Keeper", reservationFor: "Keeper" },
		{ holder: "Correspondent", activityFor: "Correspondent" },
	]) {
		const refused = await reclaim({ ...plant, touchedMs: Date.now() - 2 * HOUR });
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("PARTIAL_RELEASE_REFUSED");
	}
});

test("unreadable liveness refuses both recent and old claims instead of guessing dead", async () => {
	for (const touchedMs of [Date.now() - 2 * HOUR, STALE()]) {
		const refused = await reclaim({ holder: "DeadHolder", touchedMs, tern: null });
		expect(refused?.block).toBe(true);
		expect(refused?.reason).toContain("tern inspect exited 1");
	}
});

test("planted: a dead-holder reclaim without the revision or the transition comment is refused", async () => {
	const noRevision = await reclaim({ holder: "DeadHolder", touchedMs: STALE() }, () =>
		`br update k-1 --status open --assignee "" --transition-comment 'reclaimed: no live holder'`);
	expect(noRevision?.block).toBe(true);
	expect(noRevision?.reason).toContain("--if-unchanged");
	const noComment = await reclaim({ holder: "DeadHolder", touchedMs: STALE() }, revision =>
		`br update k-1 --status open --assignee "" --if-unchanged '${revision}'`);
	expect(noComment?.block).toBe(true);
	expect(noComment?.reason).toContain("--transition-comment");
	const keepsHolder = await reclaim({ holder: "DeadHolder", touchedMs: STALE() }, revision =>
		`br update k-1 --status open --if-unchanged '${revision}' --transition-comment 'x'`);
	expect(keepsHolder?.block).toBe(true);
});
