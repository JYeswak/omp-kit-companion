// A fake Board for the fleet-guard write-own and git tests (bead ompkit-tnqyr.3): the Board is the only reservation
// source, so these tests seed holds on it and read back the reserve and read requests it logged. The server runs out
// of process because the guard reads it through a blocking child.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boardChannel } from "../../src/fleet-guard/board-reservations.ts";
import { run } from "../../src/kitlib/run.ts";

export interface BoardRow { agent: string; path: string; exclusive?: boolean; remaining_seconds?: number }
interface Reply { my_reservations?: BoardRow[]; all_active?: BoardRow[] }

const LIFETIME_S = 3000;
let state: { url: string; seeds: string; log: string; home: string } | undefined;
let seedId = 5000;

/** Start the server once per test file; `scratch` is an owned scratch dir. Sets the env the guard's Board client reads.
 * Bun shares this module across test files in one process, so a state whose scratch an earlier file already released
 * is dead and a new server starts for the current file. */
export async function startBoard(scratch: string): Promise<void> {
	if (state && existsSync(state.home)) return;
	const home = join(scratch, "board-home");
	const seeds = join(home, "seeds");
	const log = join(home, "board.log");
	mkdirSync(join(home, "xdg", "board", "local"), { recursive: true });
	mkdirSync(seeds, { recursive: true });
	writeFileSync(join(home, "xdg", "board", "local", "t.json"), JSON.stringify({ token: "t" }));
	writeFileSync(log, "");
	const portFile = join(home, "port");
	void run([process.execPath, join(import.meta.dir, "../cli/lib/fake-board-server.ts"), portFile, seeds, String(LIFETIME_S), log],
		{ cwd: scratch, deadline_s: LIFETIME_S + 600 }).catch(() => undefined);
	for (let waited = 0; !(existsSync(portFile) && readFileSync(portFile, "utf8").startsWith("http")) && waited < 400; waited++) await Bun.sleep(50);
	state = { url: readFileSync(portFile, "utf8"), seeds, log, home };
	process.env.XDG_CONFIG_HOME = join(home, "xdg");
	process.env.FLEET_BOARD_RES_STATE = join(home, "state");
}

/** Rows a reservations reply names, mine and everyone's. */
export function rowsOf(reply: Reply | undefined): BoardRow[] {
	return [...(reply?.my_reservations ?? []), ...(reply?.all_active ?? [])];
}

function seedFile(name: string): string {
	return join(state!.seeds, name.replace(/\//g, "_") + ".json");
}

function writeSeed(name: string, rows: BoardRow[]): void {
	writeFileSync(seedFile(name), JSON.stringify(rows.map((row) => ({ id: seedId++, path: row.path, holder: row.agent, exclusive: row.exclusive !== false, until: Date.now() + (row.remaining_seconds ?? 3600) * 1000 }))));
}

/**
 * Reset the Board and seed it: `rows` answer every project; `route` answers `route.project` with its own rows and every
 * other project with `rows`. `down` points the guard at a dead port. Clears the request log.
 */
export async function boardScenario(options: BoardScenario): Promise<void> {
	if (!state) throw new Error("startBoard first");
	await fetch(state.url + "/__reset", { method: "POST" });
	boardScenarioSync(options);
}

export interface BoardScenario { rows: BoardRow[]; down?: boolean; route?: { project: string; rows: BoardRow[] } }

/** The seeding half of boardScenario, for synchronous tests that never reserve (so open tasks need no reset). */
export function boardScenarioSync(options: BoardScenario): void {
	if (!state) throw new Error("startBoard first");
	for (const name of readdirSync(state.seeds)) rmSync(join(state.seeds, name));
	writeSeed("__default", options.rows);
	if (options.route) writeSeed(boardChannel(options.route.project), options.route.rows);
	writeFileSync(state.log, "");
	process.env.BOARD_URL = options.down ? "http://127.0.0.1:1/api/board" : state.url;
}

/** Request log with each channel named by its project path, in the forms the tests assert on. */
export function boardLog(projects: readonly string[]): string[] {
	let text = readFileSync(state!.log, "utf8");
	for (const project of projects) text = text.replaceAll(boardChannel(project), project);
	return text.split("\n").filter(Boolean);
}

/** The next reserve loses a race: `holder` takes the same path an instant before the seat's task is created. */
export async function boardRace(holder: string): Promise<void> {
	if (!state) throw new Error("startBoard first");
	await fetch(state.url + "/__race", { method: "POST", body: JSON.stringify({ holder }), headers: { "content-type": "application/json" } });
}
