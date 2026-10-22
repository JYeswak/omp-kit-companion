import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveTernCliSend, routeSendTarget } from "../../src/send.ts";
import type { TernObserverIo } from "../../src/plane-tern.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-tern-route." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-tern-route repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

const noWait = async (_ms: number) => {};
const EMPTY_PREFIXES: ReadonlySet<string> = new Set<string>();
/** The fleet window's control endpoint (`tern --control EP`): Tern 0.9 ctl has no default window (TERNADDR1). */
const WINDOW = "/run/tern-fixture.sock";

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Idle settled journal: user m1 answered by assistant m2 with a terminal stop. Leaf is m2. */
function idleJournal(repo: string, sessionUuid: string): string {
	return [
		JSON.stringify({ type: "session", id: sessionUuid, cwd: repo, version: 3 }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } }),
		"",
	].join("\n");
}

/** Busy journal: a fresh user turn m3 with no assistant reply yet. Leaf is m3. */
function busyJournal(repo: string, sessionUuid: string): string {
	return [
		JSON.stringify({ type: "session", id: sessionUuid, cwd: repo, version: 3 }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } }),
		JSON.stringify({ type: "message", id: "m3", parentId: "m2", message: { role: "user", content: "new turn" } }),
		"",
	].join("\n");
}

interface TernFixtureOpts {
	session?: string;
	paneId?: number;
	repo?: string;
	sessionUuid?: string;
	working?: boolean;
	listSession?: boolean;
	resolveAgent?: boolean;
	journal?: (repo: string, uuid: string) => string;
}

/**
 * Totally owned Tern surface: inspect/process/ps/am answers are canned, and
 * the one native admission turn (`ctl carly lua`) decodes its string.char
 * payload and journals it as a USER entry, exactly like the OMP composer.
 * `taken.luaDispatches` counts native effects: negatives must stay zero.
 */
function ternFixture(opts: TernFixtureOpts = {}): { io: TernObserverIo; taken: { runs: string[][]; luaDispatches: number }; repo: string } {
	const session = opts.session ?? "omp-test";
	const paneId = opts.paneId ?? 5;
	const repo = opts.repo ?? mkdtempSync(join(scratch, "repo-"));
	const uuid = opts.sessionUuid ?? "sess-uuid-1";
	const working = opts.working ?? false;
	const listSession = opts.listSession ?? true;
	const resolveAgent = opts.resolveAgent ?? true;
	const sessionFile = join(scratch, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	let journal = (opts.journal ?? idleJournal)(repo, uuid);
	writeFileSync(sessionFile, journal);
	const taken = { runs: [] as string[][], luaDispatches: 0 };
	const inspect = JSON.stringify(listSession
		? { sessions: [{ id: 7, name: session, tabs: [{ blocks: [{ id: paneId }] }] }],
			panes: [{ pane: paneId, cwd: repo, working, exited: null, omp_session_file: sessionFile }] }
		: { sessions: [], panes: [] });
	const process = JSON.stringify({ pane: paneId, foreground: { argv: ["omp"], pid: 1234, cwd: repo, name: "omp" } });
	const io: TernObserverIo = {
		run(argv) {
			taken.runs.push([...argv]);
			if (argv.includes("carly") && argv.includes("lua")) {
				taken.luaDispatches++;
				const lua = argv[argv.length - 1] ?? "";
				const groups = [...lua.matchAll(/string\.char\(([\d,]+)\)/g)].map((m) => m[1]!);
				const payloadBytes = groups.length >= 2 ? groups[groups.length - 1]!.split(",").map(Number) : [];
				const payload = Buffer.from(payloadBytes).toString("utf8");
				journal += JSON.stringify({ type: "message", id: `m-live-${taken.luaDispatches}`, parentId: "m2",
					message: { role: "user", content: payload } }) + "\n";
				writeFileSync(sessionFile, journal);
				return { code: 0, out: "" };
			}
			if (argv[0] === "/bin/ps") return { code: 0, out: "Mon Oct 20 02:00:00 2026 omp" };
			if (argv[0] === "am") {
				return resolveAgent
					? { code: 0, out: JSON.stringify({ agent_name: "FixtureSeat", pane_id: `tern:${paneId}`, project_key: resolve(repo), binding: "verified-live" }) }
					: { code: 1, out: "" };
			}
			if (argv.includes("process")) return { code: 0, out: process };
			if (argv.includes("inspect")) return { code: 0, out: inspect };
			return { code: 1, out: "" };
		},
		readSessionFile(path) {
			return path === sessionFile ? journal : null;
		},
		wait: noWait,
	};
	return { io, taken, repo };
}

test("router: explicit tern:<id> addresses route to the native Tern delivery", () => {
	expect(routeSendTarget("tern:5")).toEqual({ route: "tern" });
	expect(routeSendTarget("tern:1756641624077")).toEqual({ route: "tern" });
});

test("router: tmux addresses stay on the tmux path (bare digits are pane indexes there)", () => {
	expect(routeSendTarget("%54")).toEqual({ route: "tmux" });
	expect(routeSendTarget("1")).toEqual({ route: "tmux" });
	expect(routeSendTarget("0.1")).toEqual({ route: "tmux" });
	expect(routeSendTarget("omp-test:1")).toEqual({ route: "tmux" });
});

test("router planted: a tern: prefix with no decimal id refuses before delivery, never NOT_DELIVERED", () => {
	for (const pane of ["tern:", "tern:abc", "tern:5x", "tern:1.2"]) {
		const got = routeSendTarget(pane);
		expect(got.route).toBe("refused");
		if (got.route === "refused") expect(got.code).toBe("TERN_MALFORMED_ADDRESS");
	}
});

test("SEND1 tern route: delivered message returns OK with the marker proven in the session file", async () => {
	const dir = dropDir();
	const { io, taken, repo } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("OK");
	expect(got.code).toBe("PROVEN");
	expect(got.sends).toBe(1);
	expect(taken.luaDispatches).toBe(1);
	expect(got.marker).toMatch(/^kit-send-[0-9a-f]+$/);
	expect(got.sessionFile).not.toBeNull();
	expect(got.offset).toBeGreaterThan(0);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
	expect(got.detail).toContain("USER entry proven at offset");
});

test("SEND1 tern route planted: session absent from the window refuses with zero native effects and no drop file", async () => {
	const dir = dropDir();
	const { io, taken } = ternFixture({ listSession: false });
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("PLANE_SEAT_UNBOUND");
	expect(got.sends).toBe(0);
	expect(taken.luaDispatches).toBe(0);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
});

test("SEND1 tern route planted: busy seat with no until-delivered bound refuses SEAT_BUSY with zero native effects", async () => {
	const dir = dropDir();
	const { io, taken, repo } = ternFixture({ working: true, journal: busyJournal });
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("SEAT_BUSY");
	expect(got.sends).toBe(0);
	expect(taken.luaDispatches).toBe(0);
	expect(got.drop_path).toBeNull();
});

test("SEND1 tern route planted: dispatch citing no bead refuses before any seat observation", async () => {
	const dir = dropDir();
	const { io, taken } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "D AM1 ompkit-x do the thing",
		dropDir: dir, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("BEAD_REQUIRED");
	expect(got.sends).toBe(0);
	expect(taken.runs).toEqual([]);
	expect(got.drop_path).toBeNull();
});

test("SEND1 tern route planted: malformed tern: address refuses with zero io calls", async () => {
	const dir = dropDir();
	const { io, taken } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:abc", message: "status update",
		dropDir: dir, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("TERN_MALFORMED_ADDRESS");
	expect(taken.runs).toEqual([]);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
});

test("SEND1 tern route planted: unresolvable agent identity refuses with zero native effects", async () => {
	const dir = dropDir();
	const { io, taken, repo } = ternFixture({ resolveAgent: false });
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("PLANE_SEAT_UNBOUND");
	expect(taken.luaDispatches).toBe(0);
	expect(got.drop_path).toBeNull();
});

test("TERNADDR1 planted: no window control endpoint refuses TERN_WINDOW_UNBOUND with zero io and no drop file", async () => {
	const dir = dropDir();
	const { io, taken, repo } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: repo, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("TERN_WINDOW_UNBOUND");
	expect(got.detail).toContain("tern --control EP");
	expect(taken.runs).toEqual([]);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
});

test("TERNADDR1: the native admission turn addresses the configured control endpoint", async () => {
	const { io, taken, repo } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dropDir(), cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait, io });
	expect(got.status).toBe("OK");
	const turn = taken.runs.find((argv) => argv.includes("carly"))!;
	expect(turn.slice(turn.indexOf("--window"), turn.indexOf("--window") + 2)).toEqual(["--window", WINDOW]);
});
