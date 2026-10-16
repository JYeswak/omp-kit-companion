import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BEAD_ID, buildNativeSendTurn, deliverToTernSeat, dispatchBeads, findTernUserMarker, fleetBeadPrefixes, isBareGoalDirective, luaCharCodes, proveSend, submitQueuedToTernSeat, trackerPrefix, type SendExec } from "../../src/send.ts";
import type { TernIdentityResult, TernObservation, TernObserverIo, TernSeatBinding } from "../../src/plane-tern.ts";
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "send-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=send-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");
const testEnv = { ...process.env, TMUX_TMPDIR: join(scratchRoot, "managed") };
delete testEnv.TMUX;

const socketFixtureRoot = join("var", "agent-tmp", "tw9q" + process.pid);
mkdirSync(socketFixtureRoot, { recursive: true });
writeFileSync(join(socketFixtureRoot, ".owner"), `pid=${process.pid} label=tw9q repo=${repoRoot} created=${new Date().toISOString()}\n`);

const noWait = async (_ms: number) => {};

/** Fake pane: echoes the last sent text into captures once enough polls have passed. */
function echoPane(capturesBeforeEcho: number, sendRc: number[] = []): { exec: SendExec; taken: { sends: number; captures: number; captureArgv: string[][] } } {
	const taken = { sends: 0, captures: 0, captureArgv: [] as string[][] };
	let lastText = "";
	return {
		taken,
		exec: {
			run(argv: string[], _childEnv?: NodeJS.ProcessEnv) {
				if (argv[0] === "ntm") {
					taken.sends++;
					const code = sendRc.length ? sendRc.shift()! : 0;
					if (code === 0) lastText = argv[argv.length - 1] ?? "";
					return { code, out: code === 0 ? "sent" : "ntm failed" };
				}
				taken.captures++;
				taken.captureArgv.push(argv);
				return { code: 0, out: taken.captures >= capturesBeforeEcho ? lastText : "nothing yet" };
			},
		},
	};
}

function dropDir(): string {
	const dir = join(scratch, "drop-" + Math.random().toString(36).slice(2));
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("SEND1: delivered marker returns OK with the marker seen", async () => {
	const { exec, taken } = echoPane(1);
	const seen = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.sends).toBe(1);
	expect(seen.status).toBe("OK");
	expect(seen.drop_path).toBeNull();
	expect(seen.marker.length).toBeGreaterThan(0);
});

test("SEND1 planted: missing pane returns NOT_DELIVERED and writes the drop file", async () => {
	const { exec, taken } = echoPane(Number.MAX_SAFE_INTEGER, [1, 1]);
	const dir = dropDir();
	const missed = await proveSend({ session: "gone", pane: "%9", message: "hello", dropDir: dir, exec, env: testEnv, pollMs: 1, deadlineMs: 20, wait: noWait });
	expect(taken.sends).toBe(2);
	expect(missed.status).toBe("NOT_DELIVERED");
	expect(missed.drop_path ?? "").toContain(dir);
	expect(existsSync(missed.drop_path!)).toBe(true);
	expect(readFileSync(missed.drop_path!, "utf8")).toContain("hello");
	expect(readFileSync(missed.drop_path!, "utf8")).toContain(missed.marker);
});

test("SEND1: late marker within the deadline still returns OK without resending", async () => {
	const { exec, taken } = echoPane(3);
	const late = await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 5000, wait: noWait });
	expect(late.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(taken.captures).toBe(3);
});

test("SEND1 capture uses the bare pane id with scrollback history", async () => {
	const { exec, taken } = echoPane(1);
	await proveSend({ session: "s", pane: "%1", message: "hello", dropDir: dropDir(), exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait });
	expect(taken.captureArgv.length).toBeGreaterThan(0);
	for (const argv of taken.captureArgv) {
		expect(argv).toEqual(["tmux", "capture-pane", "-p", "-S", "-200", "-t", "%1"]);
	}
});

// Use explicit fixture prefixes; tests never depend on host tracker configuration.
const TEST_TRACKER_PREFIXES = new Set<string>(["ompkit", "cfs", "core8", "jev", "kit", "beads_rust"]);
const send = (message: string, noBeadReason?: string, knownPrefixes: ReadonlySet<string> = TEST_TRACKER_PREFIXES) => {
	const pane = echoPane(1);
	return proveSend({ session: "s", pane: "%1", message, noBeadReason, knownPrefixes, dropDir: dropDir(), exec: pane.exec, env: testEnv, pollMs: 1, deadlineMs: 50, wait: noWait })
		.then((result) => ({ result, taken: pane.taken }));
};

test("BEAD1: a D dispatch citing no bead is refused with zero tmux submission", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: mail project /Users/josh/Developer/localbench, thread 48536; prompt w.md@abc1234; ack first");
	expect(result.status).toBe("BEAD_REQUIRED");
	expect(taken.sends).toBe(0);
	expect(taken.captures).toBe(0);
});

test("BEAD1 planted: the same dispatch citing a bead proceeds and records it", async () => {
	const { result, taken } = await send("D AM48600 flywheel-guard: bead ompkit-xa5s; mail thread 48536; ack first");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.bead_ids).toEqual(["ompkit-xa5s"]);
	expect(result.no_bead_reason).toBeNull();
});

test("BEAD2: a queue: message without a bead is refused; with one it proceeds", async () => {
	const bare = await send("next up\nqueue: send-guard, doctor-rows");
	expect(bare.result.status).toBe("BEAD_REQUIRED");
	expect(bare.taken.sends).toBe(0);
	const cited = await send("next up for (core8-h9l.31).\nqueue: send-guard, doctor-rows");
	expect(cited.result.status).toBe("OK");
	expect(cited.result.bead_ids).toEqual(["core8-h9l.31"]);
});

test("BEAD3: DONE/BLOCKED returns, R: replies and notes are not dispatches", async () => {
	for (const message of [
		"DONE AM48600 flywheel-guard abc1234 R:AM48601; NEXT doctor-rows — omp-test:0.1",
		"BLOCKED AM48600 flywheel-guard reservation-held R:AM48602",
		"R: AM48600 looks good, ship it",
		"Did you mean D or E? the queue is empty",
	]) {
		const { result, taken } = await send(message);
		expect(result.status).toBe("OK");
		expect(taken.sends).toBe(1);
		expect(result.no_bead_reason).toBeNull();
	}
});

test("BEAD4: --no-bead-reason passes a bead-less dispatch and records the reason", async () => {
	const { result, taken } = await send("D AM48600 machine-reboot: restart the fleet", "  ops recovery, no tracker item  ");
	expect(result.status).toBe("OK");
	expect(taken.sends).toBe(1);
	expect(result.no_bead_reason).toBe("ops recovery, no tracker item");
	const blank = await send("D AM48600 machine-reboot: restart the fleet", "   ");
	expect(blank.result.status).toBe("BEAD_REQUIRED");
	expect(blank.taken.sends).toBe(0);
});

test("BEAD5: URLs, paths and the D-line slug are not bead ids", () => {
	const urls = dispatchBeads("D AM1 send-guard: see https://github.com/x/omp-kit-companion/pull/12 and src/kit-flywheel-guard.ts and ~/Developer/omp-kit/docs/core8-plan.md");
	expect(urls).toEqual({ dispatch: true, bead_ids: [] });
	expect(dispatchBeads("D AM1 cfs-9yrif: go").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: bead=ompkit-xa5s").bead_ids).toEqual([]);
	expect(dispatchBeads("D AM1 x: cfs-9yrif, ompkit-rc-epic-land-fix-release-dogfood-rz5.125;", new Set(["cfs", "ompkit"])).bead_ids).toEqual(["cfs-9yrif", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]);
});

test("BEAD5 regex: real fleet ids match, near-misses do not, long near-miss is linear", () => {
	for (const id of ["ompkit-xa5s", "cfs-9yrif", "core8-h9l.31", "beads_rust-abc", "ompkit-rc-epic-land-fix-release-dogfood-rz5.125"]) expect(BEAD_ID.test(id)).toBe(true);
	for (const bad of ["ompkit", "-xa5s", "Ompkit-xa5s", "ompkit-", "ompkit-xa5s.", "ompkit-xa5s.a", "a/b-c", "https://a-b", "ompkit--x"]) expect(BEAD_ID.test(bad)).toBe(false);
	const nearMiss = "a" + "-b".repeat(50_000) + ".1".repeat(50_000) + "!";
	const started = performance.now();
	expect(BEAD_ID.test(nearMiss)).toBe(false);
	expect(performance.now() - started).toBeLessThan(200);
});

test("BEAD6 planted: no known tracker prefix means a shaped id is not accepted", async () => {
	const unconfigured = await send("D omp-test:0.1 %999 ompkit-xa5s fix", undefined, new Set());
	expect(unconfigured.result.status).toBe("BEAD_REQUIRED");
	expect(unconfigured.taken.sends).toBe(0);
});

test("BEAD6: with fleet tracker prefixes, hyphenated words are not bead ids; real ids still are", async () => {
	const fleet = new Set(["ompkit", "cfs", "jev", "kit"]);
	// Field case 2026-10-10: this passed the gate on 0.2.16 with bead_ids [follow-up, one-line, diff-check0].
	const words = await send("D omp-test:0.1 %999 fix the follow-up in the one-line diff-check0 helper", undefined, fleet);
	expect(words.result.status).toBe("BEAD_REQUIRED");
	expect(words.taken.sends).toBe(0);
	expect(words.result.detail).toContain("cfs, jev, kit, ompkit");
	for (const [message, id] of [
		["D omp-test:0.1 %999 ompkit-xa5s fix", "ompkit-xa5s"],
		["D jev:0.1 %18 jev-dadu fix", "jev-dadu"],
		["D cfsios:0.1 %47 cfs-twenty-app-portfolio-hgub5.87 read-only first", "cfs-twenty-app-portfolio-hgub5.87"],
	] as const) {
		const cited = await send(message, undefined, fleet);
		expect(cited.result.status).toBe("OK");
		expect(cited.result.bead_ids).toEqual([id]);
	}
});

test("BEAD6 discovery: prefixes come from the env list, fleet-watch repos and the nearest tracker", () => {
	const root = join(scratch, "prefixes-" + Math.random().toString(36).slice(2));
	const configured = join(root, "configured", ".beads");
	const derived = join(root, "derived", ".beads");
	const nested = join(root, "nested", ".beads");
	for (const dir of [configured, derived, nested, join(root, "nested", "src", "deep"), join(root, "home", ".config", "omp-kit")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(configured, "config.yaml"), "issue_prefix: uds\n");
	writeFileSync(join(derived, "config.yaml"), "# issue_prefix: ignored\n");
	writeFileSync(join(derived, "issues.jsonl"), '{"id":"kit-p5wn.1","title":"x"}\n');
	writeFileSync(join(nested, "issues.jsonl"), '{"id":"cfs-9yrif","title":"x"}\n');
	writeFileSync(join(root, "home", ".config", "omp-kit", "fleet-watch.json"),
		JSON.stringify({ sessions: [{ repo: join(root, "configured") }, { repo: join(root, "derived") }, { repo: join(root, "missing") }] }));
	const env = { HOME: join(root, "home"), OMP_KIT_BEAD_PREFIXES: "core8, Bad-Name ,beads_rust" };
	expect([...fleetBeadPrefixes(env, [join(root, "nested", "src", "deep")])].sort()).toEqual(["beads_rust", "cfs", "core8", "kit", "uds"]);
	expect(trackerPrefix(derived)).toBe("kit");
	expect(trackerPrefix(join(root, "missing", ".beads"))).toBeNull();
	expect(fleetBeadPrefixes({ HOME: join(root, "nowhere") }, []).size).toBe(0);
});

const tmuxUid = typeof process.getuid === "function" ? process.getuid() : 0;
function livePrivateServer(socket: string, home: string, tmp: string, name: string) {
	mkdirSync(dirname(socket), { recursive: true });
	const env = { ...process.env, HOME: home, TMPDIR: tmp };
	delete env.TMUX;
	delete env.TMUX_TMPDIR;
	const start = spawnSync("tmux", ["-S", socket, "new-session", "-d", "-s", name, "/bin/sh", "-i"], { encoding: "utf8", env });
	if (start.status !== 0) throw new Error(`private tmux server failed to start: ${start.stderr}`);
	const paneResult = spawnSync("tmux", ["-S", socket, "display-message", "-p", "-t", name, "#{pane_id}"], { encoding: "utf8", env });
	if (paneResult.status !== 0) throw new Error(`private tmux pane lookup failed: ${paneResult.stderr}`);
	return { socket, pane: paneResult.stdout.trim(), env };
}

function privateServerExec(pane: string): SendExec & { ntmEnvs: NodeJS.ProcessEnv[]; calls: string[][] } {
	const ntmEnvs: NodeJS.ProcessEnv[] = [];
	const calls: string[][] = [];
	return {
		ntmEnvs,
		calls,
		run(argv, childEnv) {
			const env = childEnv ?? process.env;
			calls.push(argv);
			if (argv[0] === "ntm") {
				ntmEnvs.push(env);
				const text = argv.at(-1) ?? "";
				const marker = /\[(kit-send-[a-f0-9]+)\]$/.exec(text)?.[1];
				if (!marker) return { code: 2, out: "marker missing" };
				const socketArgs = env.TMUX_TMPDIR ? ["-S", join(env.TMUX_TMPDIR, `tmux-${tmuxUid}`, "default")] : [];
				const sent = spawnSync("tmux", [...socketArgs, "send-keys", "-t", pane, `echo ${marker}`, "Enter"], { encoding: "utf8", env });
				return { code: sent.status ?? 1, out: String(sent.stdout ?? sent.stderr ?? "") };
			}
			const args = argv[0] === "tmux" && env.TMUX_TMPDIR && argv[1] !== "-S"
				? ["-S", join(env.TMUX_TMPDIR, `tmux-${tmuxUid}`, "default"), ...argv.slice(1)]
				: argv.slice(1);
			const result = spawnSync(argv[0]!, args, { encoding: "utf8", env });
			return { code: result.status ?? 1, out: String(result.stdout ?? "") };
		},
	};
}

function capturePrivate(socket: string, pane: string): string {
	const result = spawnSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", pane], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`private tmux capture failed: ${result.stderr}`);
	return result.stdout;
}

// Real private tmux servers; macOS CI runners ship no tmux (same guard as fleet-watch and tracker-recovery).
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
test.skipIf(!tmuxAvailable)("TMUX1: without socket environment, send selects the sole live private server and reports its socket", async () => {
	const home = socketFixtureRoot;
	const tmp = join(socketFixtureRoot, "tmp");
	const socket = join(home, ".tmux-sockets", `tmux-${tmuxUid}`, "default");
	const server = livePrivateServer(socket, home, tmp, "one");
	try {
		const exec = privateServerExec(server.pane);
		const result = await proveSend({ session: "one", pane: server.pane, message: "hello", dropDir: dropDir(), exec, env: server.env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("OK");
		expect(result.tmux_socket).toBe(socket);
		expect(exec.ntmEnvs).toHaveLength(1);
		expect(exec.ntmEnvs[0]!.TMUX_TMPDIR).toBe(join(home, ".tmux-sockets"));
		expect(exec.calls.some(argv => argv[0] === "tmux" && argv[1] === "-S" && argv[2] === socket)).toBe(true);
	} finally {
		spawnSync("tmux", ["-S", socket, "kill-server"], { encoding: "utf8" });
	}
});

test.skipIf(!tmuxAvailable)("TMUX1 planted: two live private servers refuse with both sockets and do not change either pane", async () => {
	const home = socketFixtureRoot;
	const tmp = join(socketFixtureRoot, "tmp");
	const homeSocket = join(home, ".tmux-sockets", `tmux-${tmuxUid}`, "default");
	const tmpSocket = join(tmp, `tmux-${tmuxUid}`, "default");
	const first = livePrivateServer(homeSocket, home, tmp, "first");
	const second = livePrivateServer(tmpSocket, home, tmp, "second");
	try {
		const before = capturePrivate(homeSocket, first.pane);
		const exec = privateServerExec(first.pane);
		const result = await proveSend({ session: "first", pane: first.pane, message: "hello", dropDir: dropDir(), exec, env: first.env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("TMUX_AMBIGUOUS");
		expect(result.detail).toContain(homeSocket);
		expect(result.detail).toContain(tmpSocket);
		expect(exec.ntmEnvs).toHaveLength(0);
		expect(capturePrivate(homeSocket, first.pane)).toBe(before);
	} finally {
		spawnSync("tmux", ["-S", homeSocket, "kill-server"], { encoding: "utf8" });
		spawnSync("tmux", ["-S", tmpSocket, "kill-server"], { encoding: "utf8" });
	}
});

test.skipIf(!tmuxAvailable)("TMUX1 unchanged: explicit TMUX_TMPDIR is honored and its socket is reported", async () => {
	const home = socketFixtureRoot;
	const socketRoot = join(socketFixtureRoot, "custom");
	const socket = join(socketRoot, `tmux-${tmuxUid}`, "default");
	const server = livePrivateServer(socket, home, socketRoot, "set");
	try {
		const env = { ...server.env, TMUX_TMPDIR: socketRoot };
		const exec = privateServerExec(server.pane);
		const result = await proveSend({ session: "set", pane: server.pane, message: "hello", dropDir: dropDir(), exec, env, pollMs: 1, deadlineMs: 100, wait: noWait });
		expect(result.status).toBe("OK");
		expect(result.tmux_socket).toBe(socket);
		expect(exec.ntmEnvs[0]!.TMUX_TMPDIR).toBe(socketRoot);
		expect(exec.calls.some(argv => argv[0] === "tmux" && argv[1] === "-S")).toBe(false);
	} finally {
		spawnSync("tmux", ["-S", socket, "kill-server"], { encoding: "utf8" });
	}
});
// ---- Tern verified delivery fixtures (ompkit-kdbz.2.4) ----
const ternSeat: TernSeatBinding = { session: "s", pane: "7", windowKey: "W", cwd: "/repo" };
function clearTernPending(dir: string): void {
	try { rmSync(join(dir, "..", "tern-pending"), { recursive: true, force: true }); } catch {}
}
const ternRuntimeBinding = { sessionId: 1, sessionFile: "/sf", sessionUuid: "u", paneId: 7,
	foregroundPid: 11, foregroundStarted: 22, cwd: "/repo" };
const settledSha = createHash("sha256").update(settledJournalText(), "utf8").digest("hex");
const ternIdle: TernObservation = { state: "IDLE", working: false, oracleBusy: false, sessionFile: "/sf",
	sessionSha: settledSha, fg: null, runtimeBinding: ternRuntimeBinding, evidence: [], reason: null };
const ternIdentified: TernIdentityResult = { status: "IDENTIFIED", agent: "A", binding: "b", cwdOk: true,
	runtimeBinding: ternRuntimeBinding };
function settledJournalText(): string {
	return `{"type":"session","id":"s1","cwd":"/repo","version":3}\n`
		+ `{"id":"m1","parentId":null,"type":"message","message":{"role":"assistant","stopReason":"stop","toolCallIds":[]},"toolCallId":null,"asyncState":null,"activeLeafId":null,"offset":0}\n`;
}
interface TernTaken { runs: string[][]; reads: number; }
function ternFixture(over: {
	observe?: TernObservation; identify?: TernIdentityResult; reads?: (string | null)[] | null; runRc?: number;
} = {}): { io: TernObserverIo; taken: TernTaken; observe: (seat: TernSeatBinding) => Promise<TernObservation>; identify: (seat: TernSeatBinding) => Promise<TernIdentityResult> } {
	const taken: TernTaken = { runs: [], reads: 0 };
	const reads = over.reads === undefined ? [settledJournalText()] : over.reads;
	return {
		taken,
		io: {
			run: (argv: string[]) => {
				taken.runs.push(argv);
				return { code: over.runRc ?? 0, out: "ok" };
			},
			readSessionFile: (_path: string) => {
				taken.reads++;
				if (reads === null) return null;
				return taken.reads <= reads.length ? reads[taken.reads - 1]! : reads[reads.length - 1]!;
			},
			wait: noWait,
		},
		observe: async (_seat: TernSeatBinding) => over.observe ?? { ...ternIdle },
		identify: async (_seat: TernSeatBinding) => over.identify ?? { ...ternIdentified },
	};
}
function userLine(id: string, parent: string | null, text: string, offset: number): string {
	return JSON.stringify({ id, parentId: parent, type: "message", message: { role: "user" },
		toolCallId: null, asyncState: null, activeLeafId: null, offset, text }) + "\n";
}

test("TERN2.4 gates: paused/custody/pullEnabled/unadmitted/INSIGHT seats get zero sends", async () => {
	for (const gate of [{ paused: true }, { custodyDisabled: true }, { pullEnabled: false }, { admitted: false }, { insight: true }]) {
		const f = ternFixture();
		const r = await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: f.io,
			gate, observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
		expect(r.status).toBe("REFUSED");
		expect(f.taken.runs.length).toBe(0);
	}
});

test("TERN2.4 INV04: unbound seat refuses with zero sends", async () => {
	const f = ternFixture();
	const r = await deliverToTernSeat({ seat: { ...ternSeat, windowKey: "" }, text: "hi", dropDir: dropDir(),
		io: f.io, observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("REFUSED");
	expect(r.code).toBe("PLANE_SEAT_UNBOUND");
	expect(f.taken.runs.length).toBe(0);
});

test("TERN2.4 observation gates: BUSY/DEAD/UNKNOWN get zero sends", async () => {
	const busy = ternFixture({ observe: { ...ternIdle, state: "BUSY", working: true, reason: "working" } });
	expect((await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: busy.io,
		observe: busy.observe, identify: busy.identify, pollMs: 1, deadlineMs: 10 })).code).toBe("SEAT_BUSY");
	expect(busy.taken.runs.length).toBe(0);
	const dead = ternFixture({ observe: { ...ternIdle, state: "DEAD", working: false, sessionFile: null, sessionSha: null, runtimeBinding: null, reason: "exited" } });
	expect((await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: dead.io,
		observe: dead.observe, identify: dead.identify, pollMs: 1, deadlineMs: 10 })).code).toBe("SEAT_DEAD");
	expect(dead.taken.runs.length).toBe(0);
	const unknown = ternFixture({ observe: { ...ternIdle, state: "UNKNOWN", working: null, oracleBusy: null, sessionFile: null, sessionSha: null, runtimeBinding: null, reason: "nope" } });
	expect((await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: unknown.io,
		observe: unknown.observe, identify: unknown.identify, pollMs: 1, deadlineMs: 10 })).code).toBe("OBSERVATION_UNKNOWN");
	expect(unknown.taken.runs.length).toBe(0);
});

test("TERN2.4 INV07: rebound identity refuses with zero sends", async () => {
	const f = ternFixture({ identify: { status: "REFUSED", code: "SEAT_REBOUND", reason: "moved", agent: null,
		binding: null, cwdOk: false, runtimeBinding: null } });
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("REFUSED");
	expect(r.code).toBe("SEAT_REBOUND");
	expect(f.taken.runs.length).toBe(0);
});

test("TERN2.4 eligibility: unsettled turn refuses with zero sends", async () => {
	const live = `{"type":"session","id":"s1","cwd":"/repo","version":3}\n`
		+ `{"id":"m1","parentId":null,"type":"message","message":{"role":"user"},"toolCallId":null,"asyncState":null,"activeLeafId":null,"offset":0}\n`;
	const f = ternFixture({ reads: [live] });
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hi", dropDir: dropDir(), io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("REFUSED");
	expect(r.code).toBe("ELIGIBILITY_UNSETTLED");
	expect(f.taken.runs.length).toBe(0);
});

test("TERN2.4 OK: USER marker past cursor proves delivery with offset", async () => {
	const base = settledJournalText();
	let sentMarker = "";
	const f = ternFixture({ reads: null });
	const io: TernObserverIo = {
		run: (argv: string[]) => {
			f.taken.runs.push(argv);
			if (argv.includes("carly")) {
				// The payload string.char(...) group is the last one in the turn.
				const groups = [...argv.join("\n").matchAll(/string\.char\(([0-9,]+)\)/g)];
				const last = groups.length > 0 ? groups[groups.length - 1]![1]! : null;
				if (last) {
					const text = Buffer.from(last.split(",").map(Number)).toString("utf8");
					const hit = /kit-send-[0-9a-f]+/.exec(text)?.[0];
					if (hit) sentMarker = hit;
				}
			}
			return { code: 0, out: "ok" };
		},
		readSessionFile: (_path: string) => {
			f.taken.reads++;
			if (!sentMarker) return base;
			return base + userLine("m2", "m1", `hello\n[${sentMarker}]`, Buffer.byteLength(base, "utf8"));
		},
		wait: noWait,
	};
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: dir, io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 100 });
	expect(r.status).toBe("OK");
	expect(r.sessionFile).toBe("/sf");
	expect(typeof r.offset).toBe("number");
	expect(r.drop_path).toBeNull();
	expect(f.taken.runs.filter(a => a.includes("carly")).length).toBe(1);
	expect(f.taken.runs.some(a => a.includes("paste") || a.includes("keys"))).toBe(false);
});

test("TERN2.4 PENDING: composer holds marker but journal lacks it", async () => {
	const f = ternFixture();
	let sentMarker = "";
	const io: TernObserverIo = {
		run: (argv: string[]) => {
			f.taken.runs.push(argv);
			if (argv.includes("carly")) {
				const groups = [...argv.join("\n").matchAll(/string\.char\(([0-9,]+)\)/g)];
				const last = groups.length > 0 ? groups[groups.length - 1]![1]! : null;
				if (last) {
					const text = Buffer.from(last.split(",").map(Number)).toString("utf8");
					const hit = /kit-send-[0-9a-f]+/.exec(text)?.[0];
					if (hit) sentMarker = hit;
				}
			}
			if (argv.includes("capture")) return { code: 0, out: sentMarker ? `composer [${sentMarker}]` : "empty" };
			return { code: 0, out: "ok" };
		},
		readSessionFile: (_path: string) => { f.taken.reads++; return settledJournalText(); },
		wait: noWait,
	};
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: dir, io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("PENDING_CONSUME");
	expect(r.status).not.toBe("OK");
	expect(r.status).not.toBe("NOT_DELIVERED");
	expect(r.drop_path).not.toBeNull();
});

test("TERN2.4 ACT58506: timeout with empty composer retains pending (uncertainty, never refusal)", async () => {
	const f = ternFixture();
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: dir, io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("PENDING_CONSUME");
	expect(r.code).toBe("PROOF_TIMEOUT");
	expect(r.drop_path).not.toBeNull();
	expect(readdirSync(join(dir, "..", "tern-pending")).length).toBe(1);
});

test("TERN2.4 capture failure keeps pending instead of refusing blind", async () => {
	const f = ternFixture();
	const io: TernObserverIo = {
		run: (argv: string[]) => {
			f.taken.runs.push(argv);
			if (argv.includes("capture")) return { code: 1, out: "" };
			return { code: 0, out: "ok" };
		},
		readSessionFile: (_path: string) => { f.taken.reads++; return settledJournalText(); },
		wait: noWait,
	};
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: dir, io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("PENDING_CONSUME");
	expect(r.code).toBe("PROOF_TIMEOUT");
	expect(r.detail).toContain("capture failed");
});

test("TERN2.4 brackets: payload with ]] proceeds to the turn and pends", async () => {
	const f = ternFixture();
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello ]] world", dropDir: dir, io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("PENDING_CONSUME");
	expect(f.taken.runs.filter(a => a.includes("carly")).length).toBe(1);
});

test("TERN2.4 builder: block must be bare digits; payload wires as byte codes", () => {
	const turn = buildNativeSendTurn("1756641624115", "hello [kit-send-abc]");
	expect(turn).not.toBeNull();
	expect(buildNativeSendTurn("s/p", "hello")).toBeNull();
	expect(buildNativeSendTurn('7"; evil() --', "hello")).toBeNull();
	expect(buildNativeSendTurn("", "hello")).toBeNull();
	// AM58562-1: commas/braces/]] in payload never reach source as literals.
	const tricky = buildNativeSendTurn("7", "a, b ]] c {d} ? e")!;
	expect(tricky.includes("a, b")).toBe(false);
	expect(tricky.includes("string.char(")).toBe(true);
});

test("TERN2.4 luaCharCodes: byte-exact round trip incl multibyte", () => {
	expect(luaCharCodes("A,B?C")).toBe("65,44,66,63,67");
	const s = "hi ✓\n";
	expect(Buffer.from(luaCharCodes(s).split(",").map(Number)).toString("utf8")).toBe(s);
});

test("TERN2.4 INV03/F5: send turn failure is NOT_DELIVERED with drop and retained pending", async () => {
	const f = ternFixture({ runRc: 1 });
	const dir = dropDir();
	clearTernPending(dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: dir, io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("NOT_DELIVERED");
	expect(r.drop_path).not.toBeNull();
	// AM58562-3: dispatch failure does not prove zero effects; the attempt stays pending.
	expect(readdirSync(join(dir, "..", "tern-pending")).length).toBe(1);
});

test("TERN2.4 F1: session move between observe and effect refuses with zero sends", async () => {
	const moved = settledJournalText() + userLine("mx", "m1", "other", 9999);
	const f = ternFixture({ reads: [settledJournalText(), moved] });
	const f1dir = dropDir();
	clearTernPending(f1dir);
	const r = await deliverToTernSeat({ seat: ternSeat, text: "hello", dropDir: f1dir, io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("REFUSED");
	expect(r.code).toBe("SEAT_REBOUND");
	expect(f.taken.runs.length).toBe(0);
});

test("TERN2.4 F4: stale and assistant-echo markers never prove", () => {
	const marker = "kit-send-aaaaaaaaaaaaaaaa";
	const oldLine = JSON.stringify({ type: "message", message: { role: "user" }, text: `old [${marker}]` });
	const echoLine = JSON.stringify({ type: "message", message: { role: "assistant" }, text: `echo [${marker}]` });
	const newLine = JSON.stringify({ type: "message", message: { role: "user" }, text: `new [${marker}]` });
	const text = [oldLine, echoLine, newLine].join("\n") + "\n";
	const afterOld = Buffer.byteLength(oldLine, "utf8") + 1;
	expect(findTernUserMarker(text, `[${marker}]`, afterOld)).toBe(
		Buffer.byteLength(oldLine, "utf8") + 1 + Buffer.byteLength(echoLine, "utf8") + 1);
	expect(findTernUserMarker(text, `[${marker}]`, Buffer.byteLength(text, "utf8"))).toBeNull();
	expect(findTernUserMarker(JSON.stringify({ role: "user", text: `flat [${marker}]` }) + "\n", `[${marker}]`, -1)).toBe(0);
});

test("TERN2.4 B5-7: unconsumed pending suppresses the new send; consumed pending clears", async () => {
	const dir = dropDir();
	const seatKey = "s_7_W";
	const tag = createHash("sha256").update("s1", "utf8").digest("hex").slice(0, 16);
	mkdirSync(join(dir, "..", "tern-pending"), { recursive: true });
	const pendingPath = join(dir, "..", "tern-pending", `${seatKey}.${tag}.json`);
	writeFileSync(pendingPath, JSON.stringify({ marker: "kit-send-oldoldold0", textSha256: "t", seatKey,
		sessionSha: settledSha, sessionId: "s1", leafId: "m1", cursorBytes: 0, createdAt: "2026-10-16T00:00:00Z" }) + "\n");
	const f = ternFixture();
	const suppressed = await deliverToTernSeat({ seat: ternSeat, text: "new", dropDir: dir, io: f.io,
		observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(suppressed.status).toBe("PENDING_CONSUME");
	expect(suppressed.code).toBe("SUPPRESSED_PENDING");
	expect(suppressed.marker).toBe("kit-send-oldoldold0");
	expect(f.taken.runs.length).toBe(0);
	const base = settledJournalText();
	const settledAgain = base
		+ userLine("m9", "m1", "old [kit-send-oldoldold0] done", Buffer.byteLength(base, "utf8"));
	const m10offset = Buffer.byteLength(settledAgain, "utf8");
	const consumedText = settledAgain
		+ JSON.stringify({ id: "m10", parentId: "m9", type: "message",
			message: { role: "assistant", stopReason: "stop", toolCallIds: [] },
			toolCallId: null, asyncState: null, activeLeafId: null, offset: m10offset }) + "\n";
	const consumedIo: TernObserverIo = {
		run: f.io.run,
		readSessionFile: (_path: string) => consumedText,
		wait: noWait,
	};
	const resumedObserve = async (_seat: TernSeatBinding) => ({ ...ternIdle,
		sessionSha: createHash("sha256").update(consumedText, "utf8").digest("hex") });
	const resumed = await deliverToTernSeat({ seat: ternSeat, text: "new", dropDir: dir, io: consumedIo,
		observe: resumedObserve, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	// ACT58506: the send turn ran but neither journal nor composer ever showed
	// the new marker — uncertainty, not known-zero admission. Pending is
	// retained under the same session identity, never auto-resent.
	expect(resumed.status).toBe("PENDING_CONSUME");
	expect(resumed.marker).not.toBe("kit-send-oldoldold0");
	expect(resumed.code).toBe("PROOF_TIMEOUT");
	expect(JSON.parse(readFileSync(pendingPath, "utf8")).marker).toBe(resumed.marker);
});

test("TERN2.4 AM58562-4: journal append without consumption keeps suppression", async () => {
	const dir = dropDir();
	const seatKey = "s_7_W";
	const tag = createHash("sha256").update("s1", "utf8").digest("hex").slice(0, 16);
	mkdirSync(join(dir, "..", "tern-pending"), { recursive: true });
	writeFileSync(join(dir, "..", "tern-pending", `${seatKey}.${tag}.json`), JSON.stringify({
		marker: "kit-send-append0", textSha256: "t", seatKey, sessionSha: settledSha,
		sessionId: "s1", leafId: "m1", cursorBytes: 0, createdAt: "2026-10-16T00:00:00Z" }) + "\n");
	// Same session identity, new assistant line: content hash moves, marker unconsumed.
	const appended = settledJournalText()
		+ JSON.stringify({ id: "mx", parentId: "m1", type: "message",
			message: { role: "assistant", stopReason: "stop", toolCallIds: [] },
			toolCallId: null, asyncState: null, activeLeafId: null, offset: 999 }) + "\n";
	const f = ternFixture({ reads: [appended] });
	const appendedObserve = async (_seat: TernSeatBinding) => ({ ...ternIdle,
		sessionSha: createHash("sha256").update(appended, "utf8").digest("hex") });
	const r = await deliverToTernSeat({ seat: ternSeat, text: "new", dropDir: dir, io: f.io,
		observe: appendedObserve, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(r.status).toBe("PENDING_CONSUME");
	expect(r.code).toBe("SUPPRESSED_PENDING");
	expect(r.marker).toBe("kit-send-append0");
	expect(f.taken.runs.length).toBe(0);
});

test("TERN2.4 AM58562-4: dead incarnation releases suppression without resend", async () => {
	const dir = dropDir();
	const seatKey = "s_7_W";
	const oldTag = createHash("sha256").update("old-sess", "utf8").digest("hex").slice(0, 16);
	mkdirSync(join(dir, "..", "tern-pending"), { recursive: true });
	const oldPath = join(dir, "..", "tern-pending", `${seatKey}.${oldTag}.json`);
	writeFileSync(oldPath, JSON.stringify({ marker: "kit-send-dead000", textSha256: "t", seatKey,
		sessionSha: "oldsha", sessionId: "old-sess", leafId: "m1", cursorBytes: 0,
		createdAt: "2026-10-16T00:00:00Z" }) + "\n");
	// New incarnation, settled, marker nowhere: old file swept, new send proceeds.
	const journal2 = `{"type":"session","id":"s2","cwd":"/repo","version":3}\n`
		+ `{"id":"m1","parentId":null,"type":"message","message":{"role":"assistant","stopReason":"stop","toolCallIds":[]},"toolCallId":null,"asyncState":null,"activeLeafId":null,"offset":0}\n`;
	const f = ternFixture({ reads: [journal2] });
	const obs2 = async (_seat: TernSeatBinding) => ({ ...ternIdle,
		sessionSha: createHash("sha256").update(journal2, "utf8").digest("hex") });
	const r = await deliverToTernSeat({ seat: ternSeat, text: "new", dropDir: dir, io: f.io,
		observe: obs2, identify: f.identify, pollMs: 1, deadlineMs: 10 });
	expect(existsSync(oldPath)).toBe(false);
	expect(r.status).toBe("PENDING_CONSUME");
	expect(r.code).toBe("PROOF_TIMEOUT");
	expect(r.marker).not.toBe("kit-send-dead000");
	expect(f.taken.runs.filter(a => a.includes("carly")).length).toBe(1);
	const tag2 = createHash("sha256").update("s2", "utf8").digest("hex").slice(0, 16);
	expect(JSON.parse(readFileSync(join(dir, "..", "tern-pending", `${seatKey}.${tag2}.json`), "utf8")).marker).toBe(r.marker);
});

test("TERN2.4 submitQueued disabled: IDLE provisioned seat still refused with zero calls", async () => {
	let calls = 0;
	const io: TernObserverIo = {
		run: (_argv: string[]) => { calls++; return { code: 0, out: "" }; },
		readSessionFile: (_path: string) => { calls++; return null; },
		wait: noWait,
	};
	const r = submitQueuedToTernSeat(ternSeat);
	expect(r.status).toBe("REFUSED");
	expect(r.code).toBe("SUBMITQUEUED_DISABLED");
	expect(r.marker).toBe("");
	expect(calls).toBe(0);
	void io;
});

// ---- GOALSEND form gate (ompkit-kdbz.2.4 AM55009/55134/c55136) ----
test("GOALSEND classifier: bare /goal rejected, set/lifecycle/non-directive pass", () => {
	for (const bare of ["/goal take the hill", "/goal", "  /goal oops", "/goal status now", "/goal\tTabbed"]) {
		expect(isBareGoalDirective(bare)).toBe(true);
	}
	for (const ok of ["/goal set new objective", "/goal  set  spaced", "/goal pause", "/goal resume", "/goal drop",
		"fix the /goal handling", "/goals are great", "plain text", ""]) {
		expect(isBareGoalDirective(ok)).toBe(false);
	}
});

test("TERN2.4 GOALSEND: bare /goal refused with zero sends and zero session reads", async () => {
	for (const text of ["/goal take the hill", "/goal", "/goal status now"]) {
		const f = ternFixture();
		const r = await deliverToTernSeat({ seat: ternSeat, text, dropDir: dropDir(), io: f.io,
			observe: f.observe, identify: f.identify, pollMs: 1, deadlineMs: 10 });
		expect(r.status).toBe("REFUSED");
		expect(r.code).toBe("GOAL_REQUIRES_SET_FORM");
		expect(r.sends).toBe(0);
		expect(f.taken.runs.length).toBe(0);
		expect(f.taken.reads).toBe(0);
	}
});

test("TERN2.4 GOALSEND: /goal set and lifecycle verbs pass the form gate", async () => {
	const busy = ternFixture({ observe: { ...ternIdle, state: "BUSY", working: true, reason: "working" } });
	for (const text of ["/goal set new objective", "/goal pause", "/goal resume", "/goal drop", "mention /goal mid-text"]) {
		const r = await deliverToTernSeat({ seat: ternSeat, text, dropDir: dropDir(), io: busy.io,
			observe: busy.observe, identify: busy.identify, pollMs: 1, deadlineMs: 10 });
		expect(r.code).toBe("SEAT_BUSY");
	}
});

test("GOALSEND proveSend: bare /goal refused before any exec call", async () => {
	const { result, taken } = await send("/goal take the hill");
	expect(result.status).toBe("ADMISSION_REFUSED");
	expect(result.detail).toContain("GOAL_REQUIRES_SET_FORM");
	expect(taken.sends).toBe(0);
	expect(taken.captures).toBe(0);
});

test("GOALSEND proveSend: /goal set passes the form gate", async () => {
	const { result, taken } = await send("/goal set new objective");
	expect(result.detail ?? "").not.toContain("GOAL_REQUIRES_SET_FORM");
	expect(taken.sends).toBe(1);
	expect(result.status).toBe("OK");
});