import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fakeBoard } from "./lib/fake-board.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const CLI = resolve(import.meta.dir, "../../src/cli.ts");
const HOOK = resolve(import.meta.dir, "../../scripts/check-staged-board-reservations.sh");
const board = fakeBoard();
afterAll(() => board.stop());

const root = ownedTmp("board-verbs").path;
const repo = join(root, "repo");
mkdirSync(join(root, "xdg/board/local"), { recursive: true });
writeFileSync(join(root, "xdg/board/local/t.json"), JSON.stringify({ token: "t" }));

function env(seat: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "", HOME: root, AGENT_NAME: seat,
		BOARD_URL: board.url, XDG_CONFIG_HOME: join(root, "xdg"), FLEET_BOARD_RES_STATE: join(root, "state", seat),
		GIT_CEILING_DIRECTORIES: root, ...extra,
	};
}
const cli = (seat: string, args: string[]) => runFixtureAsync(["bun", CLI, ...args, "--project", repo, "--json"], { cwd: repo, env: env(seat), floor_s: 30 });
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const hook = (seat: string, omp: string) => runFixtureAsync(["sh", HOOK], { cwd: repo, env: env(seat, { OMP_KIT_BIN: omp }), floor_s: 30 });

async function git(...args: string[]) {
	const r = await runFixtureAsync(["git", ...args], { cwd: repo, env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: "/dev/null" } });
	expect(r.rc).toBe(0);
}

test("BOARDLIVE-S4 verbs round-trip: reserve -> listed -> release -> gone", async () => {
	mkdirSync(repo, { recursive: true });
	await git("init", "-q");
	const reserved = await cli("SeatA", ["reserve", "src/mod/**", "--reason", "ompkit-x"]);
	expect([reserved.rc, text(reserved.stdout).includes('"granted"')]).toEqual([0, true]);
	const listed = JSON.parse(text((await cli("SeatB", ["reservations"])).stdout)).data.holds;
	expect(listed.map((h: { path: string; holder: string }) => [h.path, h.holder])).toEqual([["src/mod/**", "SeatA"]]);
	const clash = await cli("SeatB", ["reserve", "src/mod/a.ts", "--reason", "ompkit-y"]);
	expect(clash.rc).toBe(1);
	expect((await cli("SeatA", ["release", "--all"])).rc).toBe(0);
	expect(JSON.parse(text((await cli("SeatB", ["reservations"])).stdout)).data.holds).toEqual([]);
});

test("BOARDLIVE-S4 hook refuses a staged path another holder reserved and passes your own", async () => {
	mkdirSync(join(repo, "src/mod"), { recursive: true });
	writeFileSync(join(repo, "src/mod/a.ts"), "x\n");
	await git("add", "src/mod/a.ts");
	expect((await cli("SeatA", ["reserve", "src/mod/**", "--reason", "ompkit-x"])).rc).toBe(0);
	const omp = `bun ${CLI}`;
	expect((await hook("SeatA", omp)).rc).toBe(0);
	const other = await hook("SeatB", omp);
	expect(other.rc).toBe(1);
	expect(text(other.stderr)).toContain("src/mod/a.ts");
	// Board down, last-good snapshot present for this seat's channel: still judged, not passed blind.
	board.setDown(true);
	expect((await hook("SeatB", omp)).rc).toBe(1);
	expect((await hook("SeatA", omp)).rc).toBe(0);
	board.setDown(false);
	await cli("SeatA", ["release", "--all"]);
});

test("BOARDLIVE-S4 planted negative: a hook that ignores the Board passes the other-holder case", async () => {
	expect((await cli("SeatA", ["reserve", "src/mod/**", "--reason", "ompkit-x"])).rc).toBe(0);
	// `true` stands in for a Board-blind check: the refusal asserted above (rc 1) would fail.
	expect((await hook("SeatB", "true")).rc).toBe(0);
});

test("BOARDLOOP reservations refuse a non-loopback credential file without making a request", async () => {
	const tmp = ownedTmp("board-verbs-local-only");
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(req) { requests.push(req.url); return Response.json({ tasks: [] }); },
	});
	try {
		const xdg = join(tmp.path, "xdg");
		const credentials = join(xdg, "board", "local");
		mkdirSync(credentials, { recursive: true });
		writeFileSync(join(credentials, "fixture.json"), JSON.stringify({ url: "http://board.invalid/api/board", token: "fixture-only" }));
		const result = await runFixtureAsync(["bun", CLI, "reservations", "--project", tmp.path, "--json"], {
			cwd: tmp.path, env: env("SeatA", {
				HOME: tmp.path, GIT_CEILING_DIRECTORIES: tmp.path, XDG_CONFIG_HOME: xdg,
				BOARD_URL: `http://127.0.0.1:${server.port}/api/board`, FLEET_BOARD_RES_STATE: join(tmp.path, "state"),
			}),
		});
		expect(requests).toEqual([]);
		expect(result.rc).toBe(1);
		expect(JSON.parse(text(result.stdout))).toMatchObject({ ok: false, errors: [{ code: "BOARD_UNAVAILABLE" }] });
	} finally {
		server.stop(true);
		tmp.cleanup();
	}
});

test("BOARDLOOP reservations refuse a non-loopback BOARD_URL with a token-only credential without making a request", async () => {
	const tmp = ownedTmp("board-verbs-local-only");
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(req) { requests.push(req.url); return Response.json({ tasks: [] }); },
	});
	try {
		const xdg = join(tmp.path, "xdg");
		const credentials = join(xdg, "board", "local");
		mkdirSync(credentials, { recursive: true });
		writeFileSync(join(credentials, "fixture.json"), JSON.stringify({ token: "fixture-only" }));
		const result = await runFixtureAsync(["bun", CLI, "reservations", "--project", tmp.path, "--json"], {
			cwd: tmp.path, env: env("SeatA", {
				HOME: tmp.path, GIT_CEILING_DIRECTORIES: tmp.path, XDG_CONFIG_HOME: xdg,
				BOARD_URL: "https://board.example.test/api/board", FLEET_BOARD_RES_STATE: join(tmp.path, "state"),
			}),
		});
		expect(requests).toEqual([]);
		expect(result.rc).toBe(1);
		expect(JSON.parse(text(result.stdout))).toMatchObject({ ok: false, errors: [{ code: "BOARD_UNAVAILABLE", message: expect.stringContaining("loopback") }] });
	} finally {
		server.stop(true);
		tmp.cleanup();
	}
});
