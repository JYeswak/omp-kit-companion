import { expect, test } from "bun:test";
import { parsePsElapsed, reportStalePanes, respawnPanes, shellQuote, splitArgv, type RespawnDeps } from "../../src/fleet-respawn.ts";
import type { FleetIo, FleetProcess } from "../../src/fleet-flywheel-doctor.ts";

const SPIN = "⠋";

function composer(busy: boolean, body: string | null): string {
	const lines = ["history line one", "history line two", "╭──────────────────", body === null ? "❯" : `❯ ${body}`];
	if (busy) lines.push(`${SPIN} thinking`);
	return lines.join("\n");
}

interface FakeState {
	captures: Map<string, string>;
	processes: FleetProcess[];
	sessionFiles: Map<number, string[]>;
	starts: Map<number, number | null>;
	agents: Map<string, string | null>;
	holds: Map<string, string[]>;
	tmuxCalls: string[][];
	sleeps: number;
	relist: Map<string, string>;
}

interface FakeInput {
	panes: string;
	captures?: Map<string, string>;
	processes?: FleetProcess[];
	sessionFiles?: Map<number, string[]>;
	starts?: Map<number, number | null>;
	agents?: Map<string, string | null>;
	holds?: Map<string, string[]>;
	relist?: Map<string, string>;
}

function fake(input: FakeInput): { io: FleetIo; rd: RespawnDeps; state: FakeState } {
	const state: FakeState & { panes: string } = {
		captures: new Map<string, string>(),
		processes: new Array<FleetProcess>(),
		sessionFiles: new Map<number, string[]>(),
		starts: new Map<number, number | null>(),
		agents: new Map<string, string | null>(),
		holds: new Map<string, string[]>(),
		relist: new Map<string, string>(),
		tmuxCalls: new Array<string[]>(),
		sleeps: 0,
		...input,
	};
	const io: FleetIo = {
		nowMs: () => 1700000000000,
		tmux: (args: readonly string[]) => {
			state.tmuxCalls.push([...args]);
			if (args[0] === "list-panes") return state.panes;
			if (args[0] === "capture-pane") {
				const at = args.indexOf("-t");
				const id = at >= 0 ? String(args[at + 1] ?? "") : "";
				return state.captures.get(id) ?? null;
			}
			if (args[0] === "respawn-pane") {
				const at = args.indexOf("-t");
				const id = at >= 0 ? String(args[at + 1] ?? "") : "";
				const swap = state.relist.get(id);
				if (swap !== undefined) {
					state.panes = state.panes.split("\n").map((line) => line.includes(`\t${id}\t`) ? swap : line).join("\n");
				}
				return "";
			}
		},
		processes: () => state.processes,
		openSessionFiles: (pids: readonly number[]) => {
			const out = new Map<number, string[]>();
			for (const pid of pids) {
				const files = state.sessionFiles.get(pid);
				if (files) out.set(pid, files);
			}
			return out;
		},
		mtimeMs: () => null,
		sleep: () => {
			state.sleeps++;
		},
		mailSends: () => [],
		readFile: () => null,
		git: () => null,
	};
	const rd: RespawnDeps = {
		psStartMs: (pids: readonly number[]) => new Map(pids.map((pid) => [pid, state.starts.get(pid) ?? null] as const)),
		resolveAgent: (paneId: string) => state.agents.get(paneId) ?? null,
		exclusiveHolds: (agent: string) => state.holds.get(agent) ?? [],
	};
	return { io, rd, state };
}

const RELINK_AT = "2026-10-12T06:00:00.000Z";
const RELINK_MS = Date.parse(RELINK_AT);
const OLD_START = RELINK_MS - 3600_000;
const NEW_START = RELINK_MS + 3600_000;

function workerPane(id: string, pid: number, ompPid: number, started: number | null, capture: string | null, sessionFile: string | null, agent: string | null, holds: string[] = []): FakeInput {
	const state: FakeInput = {
		panes: `omp-test\t0\t1\t${pid}\t${id}\t/Users/josh/Developer/omp-test`,
		processes: [{ pid: ompPid, ppid: pid, args: "bun /x/omp --profile dev --model m1" }],
		starts: new Map([[ompPid, started]]),
		agents: new Map([[id, agent]]),
		holds: new Map(agent === null ? [] : [[agent, holds]]),
	};
	if (capture !== null) {
		const captures = new Map<string, string>();
		captures.set(id, capture);
		state.captures = captures;
	}
	if (sessionFile !== null) {
		state.sessionFiles = new Map([[ompPid, [sessionFile]]]);
	}
	return state;
}

test("planted: idle stale pane with session file and no holds is READY", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), "/s/profiles/dev/agent/sessions/a.jsonl", "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp --profile dev" }]);
	expect(report.panes).toHaveLength(1);
	const row = report.panes[0]!;
	expect(row.verdict).toBe("READY");
	expect(row.stale).toBe(true);
	expect(row.idle).toBe(true);
	expect(row.profile).toBe("dev");
	expect(row.sessionFile).toContain("a.jsonl");
});

test("planted: busy pane is reported only", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(true, null), "/s/a.jsonl", "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	expect(report.panes[0]!.verdict).toBe("SKIP-BUSY");
});

test("planted: composer draft is reported, never submitted", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, "human draft"), "/s/a.jsonl", "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	const row = report.panes[0]!;
	expect(row.verdict).toBe("SKIP-DIRTY");
	expect(row.composerDraft).toBe(true);
});

test("planted: reservation holder is refused with the holds named", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), "/s/a.jsonl", "Agenta", ["src/send.ts [excl]"]));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	const row = report.panes[0]!;
	expect(row.verdict).toBe("SKIP-HOLDS");
	expect(row.holds).toEqual(["src/send.ts [excl]"]);
});

test("planted: missing session file refuses a fresh respawn", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), null, "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	expect(report.panes[0]!.verdict).toBe("SKIP-NOSESSION");
});

test("planted: fresh process after the relink has nothing to do", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, NEW_START, composer(false, null), "/s/a.jsonl", "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	const row = report.panes[0]!;
	expect(row.verdict).toBe("SKIP-FRESH");
	expect(row.stale).toBe(false);
});

test("planted: unknown agent refuses without a holds check", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), "/s/a.jsonl", null));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 101, ppid: 100, args: "bun /x/omp" }]);
	expect(report.panes[0]!.verdict).toBe("SKIP-HOLDS");
});

test("planted: no omp child is frozen, not ready", () => {
	const { io, rd } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), "/s/a.jsonl", "Agenta"));
	const report = reportStalePanes(io, rd, RELINK_AT, "receipt", [{ pid: 999, ppid: 100, args: "zsh -l" }]);
	expect(report.panes[0]!.verdict).toBe("SKIP-FROZEN");
});

test("planted: apply respawns serially with structural argv and verifies each", () => {
	const panes = ["omp-test\t0\t1\t100\t%11\t/wd1", "omp-test\t0\t2\t200\t%12\t/wd2"].join("\n");
	const { io, rd, state } = fake({
		panes,
		processes: [
			{ pid: 101, ppid: 100, args: "bun /x/omp --profile dev" },
			{ pid: 201, ppid: 200, args: "bun /x/omp --profile dev" },
		],
		starts: new Map([[101, OLD_START], [201, OLD_START], [301, NEW_START], [401, NEW_START]]),
		agents: new Map([["%11", "Agenta"], ["%12", "Agentb"]]),
		holds: new Map(),
		sessionFiles: new Map([[101, ["/s/a.jsonl"]], [201, ["/s/b.jsonl"]], [301, ["/s/a.jsonl"]], [401, ["/s/b.jsonl"]]]),
		relist: new Map([["%11", "omp-test\t0\t1\t301\t%11\t/wd1"], ["%12", "omp-test\t0\t2\t401\t%12\t/wd2"]]),
	});
	state.captures.set("%11", composer(false, null));
	state.captures.set("%12", composer(false, null));
	const result = respawnPanes(io, rd, RELINK_AT, "receipt", RELINK_MS,
		[{ pid: 101, ppid: 100, args: "bun /x/omp --profile dev" }, { pid: 201, ppid: 200, args: "bun /x/omp --profile dev" }],
		["omp-test:0.1", "omp-test:0.2"], true);
	expect(result.applied).toBe(true);
	expect(result.outcomes.map((outcome) => outcome.result)).toEqual(["RESPAWNED", "RESPAWNED"]);
	const relaunches = state.tmuxCalls.filter((argv) => argv[0] === "respawn-pane");
	expect(relaunches).toHaveLength(2);
	expect(relaunches[0]!.join(" ")).toContain("--resume");
	expect(relaunches[0]!.join(" ")).toContain("/s/a.jsonl");
	expect(relaunches[1]!.join(" ")).toContain("/s/b.jsonl");
	const firstRelaunch = state.tmuxCalls.findIndex((argv) => argv[0] === "respawn-pane");
	const secondRelaunch = state.tmuxCalls.findIndex((argv, index) => argv[0] === "respawn-pane" && index > firstRelaunch);
	expect(secondRelaunch).toBeGreaterThan(firstRelaunch);
	expect(state.tmuxCalls.slice(firstRelaunch, secondRelaunch).some((argv) => argv[0] === "list-panes")).toBe(true);
});

test("planted: without apply nothing is relaunched", () => {
	const { io, rd, state } = fake(workerPane("%11", 100, 101, OLD_START, composer(false, null), "/s/a.jsonl", "Agenta"));
	const result = respawnPanes(io, rd, RELINK_AT, "receipt", RELINK_MS,
		[{ pid: 101, ppid: 100, args: "bun /x/omp" }], ["omp-test:0.1"], false);
	expect(result.applied).toBe(false);
	expect(result.outcomes[0]!.result).toBe("SKIPPED");
	expect(state.tmuxCalls.filter((argv) => argv[0] === "respawn-pane")).toHaveLength(0);
});

test("planted: failed post-respawn check stops before the next pane", () => {
	const panes = ["omp-test\t0\t1\t100\t%11\t/wd1", "omp-test\t0\t2\t200\t%12\t/wd2"].join("\n");
	const { io, rd, state } = fake({
		panes,
		processes: [
			{ pid: 101, ppid: 100, args: "bun /x/omp --profile dev" },
			{ pid: 201, ppid: 200, args: "bun /x/omp --profile dev" },
		],
		starts: new Map([[101, OLD_START], [201, OLD_START]]),
		agents: new Map([["%11", "Agenta"], ["%12", "Agentb"]]),
		holds: new Map(),
		sessionFiles: new Map([[101, ["/s/a.jsonl"]], [201, ["/s/b.jsonl"]]]),
	});
	state.captures.set("%11", composer(false, null));
	state.captures.set("%12", composer(false, null));
	const result = respawnPanes(io, rd, RELINK_AT, "receipt", RELINK_MS,
		[{ pid: 101, ppid: 100, args: "bun /x/omp --profile dev" }, { pid: 201, ppid: 200, args: "bun /x/omp --profile dev" }],
		["omp-test:0.1", "omp-test:0.2"], true);
	expect(result.outcomes[0]!.result).toBe("FAILED");
	expect(result.outcomes[1]).toMatchObject({ result: "SKIPPED" });
	expect(state.tmuxCalls.filter((argv) => argv[0] === "respawn-pane")).toHaveLength(1);
});

test("planted: shell-word split handles quotes, escapes, nesting and refuses the rest", () => {
	expect(splitArgv("omp --profile dev --model m")).toEqual(["omp", "--profile", "dev", "--model", "m"]);
	expect(splitArgv(`omp --title "my task" --path '/a b/c'`)).toEqual(["omp", "--title", "my task", "--path", "/a b/c"]);
	expect(splitArgv(`omp --title "say 'hi'"`)).toEqual(["omp", "--title", "say 'hi'"]);
	expect(splitArgv("omp --msg a\\ b")).toEqual(["omp", "--msg", "a b"]);
	expect(splitArgv("omp --prefix x\"a b\"y")).toEqual(["omp", "--prefix", "xa by"]);
	expect(splitArgv("omp --x $(evil)")).toBeNull();
	expect(splitArgv("omp --x `evil`")).toBeNull();
	expect(splitArgv("omp --x (group)")).toBeNull();
	expect(splitArgv("omp --x a > out")).toBeNull();
	expect(splitArgv("omp --x <<EOF")).toBeNull();
	expect(splitArgv("omp --x 'unterminated")).toBeNull();
});

test("planted: FrostyStream suffix case splits structurally and keeps resume", () => {
	expect(splitArgv("omp --profile dev --resume f.jsonl ; exec zsh -l")).toEqual(
		["omp", "--profile", "dev", "--resume", "f.jsonl", ";", "exec", "zsh", "-l"]);
});

test("planted: ps elapsed parses day, hour and minute forms", () => {
	expect(parsePsElapsed("04:05")).toBe(245000);
	expect(parsePsElapsed("1:02:03")).toBe(3723000);
	expect(parsePsElapsed("2-01:02:03")).toBe(176523000);
	expect(parsePsElapsed("")).toBe(null);
	expect(parsePsElapsed("abc")).toBe(null);
});

test("planted: shell quoting round-trips single quotes", () => {
	expect(shellQuote("it's")).toBe("'it'\\''s'");
});
