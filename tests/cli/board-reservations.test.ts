import { afterAll, expect, test } from "bun:test";
import { BoardReservations, boardChannel, globsOverlap } from "../../src/fleet-guard/board-reservations.ts";
import { fakeBoard } from "./lib/fake-board.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const boards: Array<ReturnType<typeof fakeBoard>> = [];
afterAll(() => { for (const b of boards) b.stop(); });

function setup(overlaps?: (a: string, b: string) => boolean) {
	const board = fakeBoard();
	boards.push(board);
	const dir = ownedTmp("board-res").path;
	const make = (sub: string) => new BoardReservations({ url: board.url, token: "t", stateDir: `${dir}/${sub}`, ...(overlaps ? { overlaps } : {}) });
	return { board, make };
}

const FIXTURES: Array<[string, string, boolean]> = [
	["src/mod/**", "src/mod/a.ts", true],
	["src/mod/a.ts", "src/mod/**", true],
	["src/mod", "src/mod/deep/a.ts", true],
	["src/*.ts", "src/a.ts", true],
	["src/*.ts", "src/mod/a.ts", false],
	["src/mod/**", "src/other/a.ts", false],
	["a.ts", "b.ts", false],
];

test("BOARDLIVE-S4 glob-overlap fixtures", () => {
	for (const [a, b, want] of FIXTURES) expect([a, b, globsOverlap(a, b)]).toEqual([a, b, want]);
});

test("BOARDLIVE-S4 channel naming matches the mirror", () => {
	expect(boardChannel("omp-kit")).toBe("res/omp-kit");
	expect(boardChannel("/Users/josh/Developer/omp-kit")).toBe("res/omp-kit");
});

test("BOARDLIVE-S4 fixtures drive reserve verdicts against a fake Board", async () => {
	for (const [a, b, want] of FIXTURES) {
		const { make } = setup();
		const first = await make("a").reserve("omp-kit", "SeatA", [a]);
		expect(first.granted.length).toBe(1);
		const second = await make("b").reserve("omp-kit", "SeatB", [b]);
		expect([a, b, second.granted.length === 0]).toEqual([a, b, want]);
	}
});

async function race(overlaps?: (a: string, b: string) => boolean): Promise<number> {
	const { make } = setup(overlaps);
	const results = await Promise.all([
		make("a").reserve("omp-kit", "SeatA", ["src/mod/**"]),
		make("b").reserve("omp-kit", "SeatB", ["src/mod/a.ts"]),
	]);
	return results.reduce((n, r) => n + r.granted.length, 0);
}

test("BOARDLIVE-S4 2-way race on overlapping paths grants exactly one", async () => {
	for (let i = 0; i < 20; i++) expect(await race()).toBe(1);
});

test("BOARDLIVE-S4 planted negative: skipping the glob match double-grants", async () => {
	// Exact-string overlap is the broken matcher; the one-winner invariant above fails under it.
	let doubles = 0;
	for (let i = 0; i < 5; i++) if ((await race((a, b) => a === b)) === 2) doubles++;
	expect(doubles).toBe(5);
});

test("BOARDLIVE-S4 renew, release and expiry", async () => {
	const { board, make } = setup();
	const a = make("a");
	const b = make("b");
	await a.reserve("omp-kit", "SeatA", ["src/mod/**"], 60);
	expect((await b.reserve("omp-kit", "SeatB", ["src/mod/x.ts"])).granted).toEqual([]);
	expect((await a.renew("omp-kit", "SeatA", [], 600)).length).toBe(1);
	expect(await a.release("omp-kit", "SeatA")).toBe(1);
	expect(board.tasks[0]!.state).toBe("completed");
	expect((await b.reserve("omp-kit", "SeatB", ["src/mod/x.ts"])).granted.length).toBe(1);
});

test("BOARDLIVE-S4 hook lookup: covered, conflict, and fail-closed last-good cache", async () => {
	const { board, make } = setup();
	const a = make("a");
	await a.reserve("omp-kit", "SeatA", ["src/mod/**"]);
	expect((await a.check("omp-kit", "SeatA", "src/mod/a.ts")).covered).toBe(true);
	const other = await a.check("omp-kit", "SeatB", "src/mod/a.ts");
	expect(other.covered).toBe(false);
	expect(other.conflicts.length).toBe(1);
	board.setDown(true);
	expect((await a.check("omp-kit", "SeatA", "src/mod/a.ts")).covered).toBe(true); // last good
	expect((await make("fresh").check("omp-kit", "SeatA", "src/mod/a.ts")).covered).toBe(false); // no snapshot: refuse
});
