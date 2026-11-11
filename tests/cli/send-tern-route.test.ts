import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveTernCliSend, routeSendTarget, ternSendSeat } from "../../src/send.ts";
import type { TernObserverIo } from "../../src/plane-tern.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratchTmp = ownedTmp("send-tern-route", { root: scratchRoot });
const scratch = scratchTmp.path;
afterAll(() => scratchTmp.cleanup());

const noWait = async (_ms: number) => {};
const EMPTY_PREFIXES: ReadonlySet<string> = new Set<string>();
/** The fleet window's control endpoint (`tern --control EP`): Tern 0.9 ctl has no default window (TERNADDR1). */
const WINDOW = "/run/tern-fixture.sock";

function dropDir(): string {
	const root = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	const dir = join(root, "send-drop");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function repoDir(): string {
	const dir = join(scratch, "repo-" + Math.random().toString(36).slice(2));
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
	// WAKEPENDING1: block ids exceed 2^53, so no JS number carries them (9374096836001793 rounds to
	// ...792 at the literal). The id stays an exact decimal string and is spliced raw into the fake
	// wire text, exactly as `tern inspect --json` emits it.
	paneId?: string;
	repo?: string;
	identityProject?: string;
	agentName?: string;
	agentNameSequence?: string[];
	agentMailName?: string;
	binding?: string;
	sessionUuid?: string;
	working?: boolean;
	exited?: number | null;
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
function ternFixture(opts: TernFixtureOpts = {}): { io: TernObserverIo; taken: { runs: string[][]; luaDispatches: number; blocks: string[] }; repo: string; finishTurn: () => void } {
	const session = opts.session ?? "omp-test";
	const paneId = opts.paneId ?? "5";
	if (!/^[0-9]+$/.test(paneId)) throw new Error(`fixture pane id must be decimal digits: ${paneId}`);
	const repo = opts.repo ?? repoDir();
	const identityProject = opts.identityProject ?? repo;
	const agentName = opts.agentName ?? "FixtureSeat";
	const agentNameSequence = opts.agentNameSequence ?? [agentName];
	const agentMailName = opts.agentMailName ?? "FixtureSeat";
	let psAgentNameReads = 0;
	const binding = opts.binding ?? "verified-live";
	const uuid = opts.sessionUuid ?? "sess-uuid-1";
	let working = opts.working ?? false;
	const exited = opts.exited ?? null;
	const listSession = opts.listSession ?? true;
	const resolveAgent = opts.resolveAgent ?? true;
	const sessionFile = join(scratch, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	let journal = (opts.journal ?? idleJournal)(repo, uuid);
	let activeParentId = opts.journal === busyJournal ? "m3" : "m2";
	writeFileSync(sessionFile, journal);
	const taken = { runs: [] as string[][], luaDispatches: 0, blocks: [] as string[] };
	let pendingPrompt: string | null = null;
	// Raw wire text: Tern emits block ids as bare JSON numbers (past 2^53), so the fixture splices the
	// exact decimal digits, never a JS number (JSON.stringify(9374096836001793) emits ...792).
	const inspect = () => listSession
		? `{"sessions":[{"id":7,"name":${JSON.stringify(session)},"tabs":[{"blocks":[{"id":${paneId},"exited":${JSON.stringify(exited)}}]}]}],"panes":[{"pane":${paneId},"cwd":${JSON.stringify(repo)},"working":${JSON.stringify(working)},"exited":${JSON.stringify(exited)},"omp_session_file":${JSON.stringify(sessionFile)}}]}`
		: `{"sessions":[],"panes":[]}`;
	const process = `{"pane":${paneId},"foreground":{"argv":["omp"],"pid":1234,"cwd":${JSON.stringify(repo)},"name":"omp"}}`;
	const io: TernObserverIo = {
		run(argv) {
			taken.runs.push([...argv]);
			if (argv.includes("carly") && argv.includes("lua")) {
				taken.luaDispatches++;
				const lua = argv[argv.length - 1] ?? "";
				const groups = [...lua.matchAll(/string\.char\(([\d,]+)\)/g)].map((m) => m[1]!);
				// First char group is the addressed block (buildNativeSendTurn), last is the payload.
				taken.blocks.push(Buffer.from((groups[0] ?? "").split(",").filter(Boolean).map(Number)).toString("utf8"));
				const payloadBytes = groups.length >= 2 ? groups[groups.length - 1]!.split(",").map(Number) : [];
				const payload = Buffer.from(payloadBytes).toString("utf8");
				if (working) pendingPrompt = payload;
				else {
					journal += JSON.stringify({ type: "message", id: `m-live-${taken.luaDispatches}`, parentId: activeParentId,
						message: { role: "user", content: payload } }) + "\n";
					writeFileSync(sessionFile, journal);
				}
				return { code: 0, out: "" };
			}
			if (argv.includes("paste") || argv.includes("keys")) throw new Error("composer transport is forbidden");
			if (argv[0] === "/bin/ps") {
				const index = Math.min(psAgentNameReads, Math.max(0, agentNameSequence.length - 1));
				const observedAgentName = agentNameSequence[index] ?? agentName;
				psAgentNameReads++;
				return { code: 0, out: `Mon Oct 20 02:00:00 2026 omp AGENT_NAME=${observedAgentName}` };
			}
			if (argv[0] === "am") {
				return resolveAgent
					? { code: 0, out: JSON.stringify({ agent_name: agentMailName, pane_id: `tern:${paneId}`,
						project_key: resolve(identityProject), binding }) }
					: { code: 1, out: "" };
			}
			if (argv.includes("process")) return { code: 0, out: process };
			if (argv.includes("inspect")) return { code: 0, out: inspect() };
			return { code: 1, out: "" };
		},
		readSessionFile(path) {
			return path === sessionFile ? journal : null;
		},
		wait: noWait,
	};
	const finishTurn = () => {
		if (!working) return;
		working = false;
		const parentId = opts.journal === busyJournal ? "m3" : "m2";
		journal += JSON.stringify({ type: "message", id: "m-finish", parentId,
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }) + "\n";
		activeParentId = "m-finish";
		if (pendingPrompt !== null) {
			journal += JSON.stringify({ type: "message", id: `m-live-${taken.luaDispatches}`, parentId: activeParentId,
				message: { role: "user", content: pendingPrompt } }) + "\n";
			pendingPrompt = null;
		}
		writeFileSync(sessionFile, journal);
	};
	return { io, taken, repo, finishTurn };
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
		dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait,
		io, env: { AGENT_MAIL_PROJECT: repo } });
	expect(got).toMatchObject({ status: "OK", code: "PROVEN" });
	expect(got.sends).toBe(1);
	expect(taken.luaDispatches).toBe(1);
	expect(got.marker).toMatch(/^kit-send-[0-9a-f]+$/);
	expect(got.sessionFile).not.toBeNull();
	expect(got.offset).toBeGreaterThan(0);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
	expect(got.detail).toContain("USER entry proven at offset");
});
test("SENDANY1: matching target runtime identity proves a legacy-unverified seat from a separate identity project", async () => {
	const dir = dropDir();
	const identityProject = "/agent-mail-project";
	const { io, taken, repo } = ternFixture({ session: "Default", identityProject, binding: "legacy-unverified" });
	const seat = ternSendSeat(null, "any-label", "tern:5", {}, "/caller");
	const got = await proveTernCliSend({ session: seat.session, pane: seat.pane, message: "status update",
		dropDir: dir, cwd: repo, windowKey: seat.windowKey, knownPrefixes: EMPTY_PREFIXES,
		pollMs: 1, deadlineMs: 50, wait: noWait, io, composer: () => ({ state: "EMPTY" }),
		env: { AGENT_MAIL_PROJECT: identityProject, AGENT_NAME: "CallerIsNotTheTarget" } });
	expect(got).toMatchObject({ status: "OK", code: "PROVEN" });
	expect(got.sends).toBe(1);
	expect(got.offset).toBeGreaterThan(0);
	expect(got.detail).toContain("via native agent API");
	expect(taken.luaDispatches).toBe(1);
	expect(taken.runs.some(argv => argv.includes("paste") || argv.includes("keys"))).toBe(false);
});
test("SENDANY1 planted: mismatched target AGENT_NAME refuses with zero sends", async () => {
	const dir = dropDir();
	const identityProject = "/agent-mail-project";
	const fx = ternFixture({ session: "Default", identityProject, agentName: "OtherAgent", binding: "legacy-unverified" });
	const got = await proveTernCliSend({ session: "", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait,
		io: fx.io, env: { AGENT_MAIL_PROJECT: identityProject, AGENT_NAME: "FixtureSeat" } });
	expect(got).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND", sends: 0 });
	expect(fx.taken.luaDispatches).toBe(0);
	expect(readdirSync(dir)).toEqual([]);
});
test("SENDANY1 planted: target AGENT_NAME rebound after initial observation refuses with zero sends", async () => {
	const dir = dropDir();
	const identityProject = "/agent-mail-project";
	const fx = ternFixture({ session: "Default", identityProject, binding: "legacy-unverified",
		agentNameSequence: ["FixtureSeat", "FixtureSeat", "OtherAgent", "OtherAgent"], agentMailName: "OtherAgent" });
	const got = await proveTernCliSend({ session: "", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait,
		io: fx.io, env: { AGENT_MAIL_PROJECT: identityProject, AGENT_NAME: "CallerIsNotTheTarget" } });
	expect(got).toMatchObject({ status: "REFUSED", code: "SEAT_REBOUND", sends: 0 });
	expect(fx.taken.luaDispatches).toBe(0);
	expect(readdirSync(dir)).toEqual([]);
});
test("SENDANY1 planted: foreign session-file cwd refuses before sending", async () => {
	const dir = dropDir();
	const identityProject = "/agent-mail-project";
	const fx = ternFixture({ session: "Default", identityProject, binding: "legacy-unverified",
		journal: (_repo, uuid) => idleJournal("/another-agent-repo", uuid) });
	const got = await proveTernCliSend({ session: "", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50, wait: noWait,
		io: fx.io, env: { AGENT_MAIL_PROJECT: identityProject } });
	expect(got).toMatchObject({ status: "REFUSED", code: "PLANE_SEAT_UNBOUND", sends: 0 });
	expect(fx.taken.luaDispatches).toBe(0);
	expect(readdirSync(dir)).toEqual([]);
});

test("SENDANY1: an inspected closed block reports BLOCK_GONE without sending", async () => {
	const dir = dropDir();
	const fx = ternFixture({ session: "Default", exited: 1 });
	const seat = ternSendSeat(null, "any-label", "tern:5", {}, "/caller");
	const got = await proveTernCliSend({ session: seat.session, pane: seat.pane, message: "status update",
		dropDir: dir, cwd: seat.cwd, windowKey: seat.windowKey, knownPrefixes: EMPTY_PREFIXES,
		pollMs: 1, deadlineMs: 50, wait: noWait, io: fx.io });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("BLOCK_GONE");
	expect(got.sends).toBe(0);
	expect(fx.taken.luaDispatches).toBe(0);
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

test("SENDANY1: a busy Tern seat queues by default and reports QUEUED then DELIVERED", async () => {
	const dir = dropDir();
	const fx = ternFixture({ working: true, journal: busyJournal });
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50,
		wait: async () => fx.finishTurn(), io: fx.io, env: { AGENT_MAIL_PROJECT: fx.repo } });
	expect(got).toMatchObject({ status: "OK", queue_states: ["QUEUED", "DELIVERED"] });
	expect(fx.taken.luaDispatches).toBe(1);
});

test("SENDANY1: busy native expiry retains pending and never resubmits", async () => {
	const dir = dropDir();
	const fx = ternFixture({ working: true, journal: busyJournal });
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, untilDeliveredMs: 3,
		pollMs: 1, deadlineMs: 50, wait: noWait, io: fx.io });
	expect(got.status).toBe("PENDING_CONSUME");
	expect(got.code).toBe("PROOF_TIMEOUT");
	expect(got.queue_states).toEqual(["QUEUED", "EXPIRED"]);
	expect(got.sends).toBe(1);
	expect(fx.taken.luaDispatches).toBe(1);
	expect(readFileSync(got.drop_path!, "utf8")).toContain("status update");
	const pending = join(dir, "..", "tern-pending");
	expect(readdirSync(pending).filter(name => name.endsWith(".json"))).toHaveLength(1);
	const retry = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dir, cwd: fx.repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, untilDeliveredMs: 3,
		pollMs: 1, deadlineMs: 50, wait: noWait, io: fx.io });
	expect(retry).toMatchObject({ status: "PENDING_CONSUME", code: "SUPPRESSED_PENDING", sends: 0 });
	expect(fx.taken.luaDispatches).toBe(1);
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
		dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50,
		wait: noWait, io, env: { AGENT_MAIL_PROJECT: repo } });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("PLANE_SEAT_UNBOUND");
	expect(taken.luaDispatches).toBe(0);
	expect(got.drop_path).toBeNull();
});

test("TERNADDR1: the native admission turn addresses the configured control endpoint", async () => {
	const { io, taken, repo } = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update",
		dropDir: dropDir(), cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50,
		wait: noWait, io, env: { AGENT_MAIL_PROJECT: repo } });
	expect(got).toMatchObject({ status: "OK", code: "PROVEN" });
	const turn = taken.runs.find((argv) => argv.includes("carly"))!;
	expect(turn.slice(turn.indexOf("--window"), turn.indexOf("--window") + 2)).toEqual(["--window", WINDOW]);
});

// WAKEPENDING1 (ompkit-774u.99): the two skillgrowth seats live on Tern blocks past 2^53. A send to
// each is delivered to exactly that block and proven from its journal. The ids stay decimal strings:
// as JS numbers 9374096836001793 already reads as ...792, so a numeric fixture would wake a neighbour.
test("WAKEPENDING1: sends to 64-bit Tern blocks deliver to exactly that pane and prove from its journal", async () => {
	for (const id of ["9374092541034498", "9374096836001793"]) {
		const dir = dropDir();
		const { io, taken, repo } = ternFixture({ paneId: id });
		const got = await proveTernCliSend({ session: "omp-test", pane: `tern:${id}`, message: "status update",
			dropDir: dir, cwd: repo, windowKey: WINDOW, knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 50,
			wait: noWait, io, env: { AGENT_MAIL_PROJECT: repo } });
		expect(got).toMatchObject({ status: "OK", code: "PROVEN" });
		expect(got.sends).toBe(1);
		expect(taken.luaDispatches).toBe(1);
		expect(taken.blocks).toEqual([id]);
		expect(got.marker).toMatch(/^kit-send-[0-9a-f]+$/);
		expect(got.offset).toBeGreaterThan(0);
		expect(got.drop_path).toBeNull();
		expect(got.detail).toContain("USER entry proven at offset");
	}
});
