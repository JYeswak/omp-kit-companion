import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { AM_WATCH_PROBE_NAME, AM_WATCH_RECEIPT_NAME, checkAmWatch, classifyAmProbe, type AmProbeResult, type AmWatchDeps, type AmWatchRunResult } from "../../src/am-watch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

afterAll(cleanupAllOwnedTmp);
// Mirrors load-doctor.test.ts: every state root is its own owned dir under
// var/agent-tmp so overlapping runs never share a receipt.
const fixtureRoot = () => ownedTmp("am-watch-fixture", { root: join(process.cwd(), "var", "agent-tmp") }).path;

const BASE_NOW = Date.parse("2026-11-12T00:00:00Z");
const LOG_PATH = "/fixture/agent-mail/stderr.log";
const PRINT_OK = [
	"gui/501/com.agent-mail = {",
	"\tpath = /Users/fixture/Library/LaunchAgents/com.agent-mail.plist",
	"\tpid = 111",
	"\tstderr path = /fixture/agent-mail/stderr.log",
	"}",
].join("\n");
const PS_OVER = [
	"    1      64 /sbin/launchd",
	"  111 27262976 /Users/fixture/.local/bin/am serve-http --host 127.0.0.1 --port 8765",
	"  222    1024 /usr/bin/python3 census",
].join("\n");
const PS_QUIET = [
	"    1      64 /sbin/launchd",
	"  111 2097152 /Users/fixture/.local/bin/am serve-http --host 127.0.0.1 --port 8765",
].join("\n");
const FATAL_LOG = [
	"2026-11-11T23:16:27.477783Z  INFO memory pressure level changed from=\"critical\" to=\"warning\" rss_bytes=4227661824",
	"2026-11-11T23:22:37.635433Z  INFO memory pressure level changed from=\"critical\" to=\"fatal\" rss_bytes=8790884352",
	"2026-11-12T00:02:46.184149Z  INFO ACK TTL scan slice completed event=\"ack_ttl_scan\" scanned=128 overdue=1 lap_incomplete=true",
].join("\n");
const QUIET_LOG = [
	"2026-11-12T00:02:46.184149Z  INFO ACK TTL scan slice completed event=\"ack_ttl_scan\" scanned=128 overdue=1 lap_incomplete=true",
	"2026-11-12T00:02:47.431839Z  INFO ACK TTL scan slice completed event=\"ack_ttl_scan\" scanned=128 overdue=1 lap_incomplete=true",
].join("\n");

interface FakeWorld {
	kickstarts: string[][];
	tailCalls: string[];
	printCalls: number;
	clock: { now: number };
	run: (argv: readonly string[]) => AmWatchRunResult;
	readTail: (path: string, maxBytes: number) => string | null;
}

function makeWorld(opts: { print?: string; printCode?: number; printStderr?: string; ps?: string; tail?: string | null } = {}): FakeWorld {
	const world: FakeWorld = {
		kickstarts: [],
		tailCalls: [],
		printCalls: 0,
		clock: { now: BASE_NOW },
		run: argv => {
			if (argv[0] === "launchctl" && argv[1] === "print") {
				world.printCalls += 1;
				return { code: opts.printCode ?? 0, stdout: opts.print ?? PRINT_OK, stderr: opts.printStderr ?? "" };
			}
			if (argv[0] === "ps") return { code: 0, stdout: opts.ps ?? PS_OVER, stderr: "" };
			if (argv[0] === "launchctl" && argv[1] === "kickstart") {
				world.kickstarts.push([...argv]);
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected argv ${JSON.stringify(argv)}`);
		},
		readTail: (path, _max) => {
			world.tailCalls.push(path);
			return opts.tail ?? null;
		},
	};
	return world;
}

const PROBE_OK: AmProbeResult = { outcome: "ok", detail: "fixture answered" };
const PROBE_WEDGED: AmProbeResult = { outcome: "wedged", detail: "fixture pool exhausted" };
const PROBE_INCONCLUSIVE: AmProbeResult = { outcome: "inconclusive", detail: "fixture agent not found" };

function depsFor(world: FakeWorld, extra?: Partial<AmWatchDeps>): AmWatchDeps {
	// The probe is injected everywhere so no test ever calls the live Agent Mail.
	return { run: world.run, readTail: world.readTail, nowMs: () => world.clock.now, uid: 501, probe: () => PROBE_OK, ...extra };
}

/** A probe whose answers are scripted per tick, with a call counter. */
function scriptedProbe(...answers: AmProbeResult[]) {
	const state = { calls: 0 };
	return { state, probe: () => { const answer = answers[Math.min(state.calls, answers.length - 1)] as AmProbeResult; state.calls += 1; return answer; } };
}

test("AMWATCH1: an over-ceiling RSS restarts exactly once and records a receipt", () => {
	const root = fixtureRoot();
	const world = makeWorld({ tail: QUIET_LOG });
	const result = checkAmWatch(root, depsFor(world));
	expect(result.status).toBe("RESTARTED");
	expect(result.reason).toBe("rss-ceiling");
	expect(result.pid).toBe(111);
	expect(result.rssBytes).toBe(27262976 * 1024);
	expect(world.kickstarts).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.agent-mail"]]);
	const receipt = JSON.parse(readFileSync(join(root, AM_WATCH_RECEIPT_NAME), "utf8")) as Record<string, unknown>;
	expect(receipt).toMatchObject({ schema_version: 1, pid: 111, rss_bytes: 27262976 * 1024, reason: "rss-ceiling", kickstart_rc: 0 });
	expect(typeof receipt.finished_at).toBe("string");
});

// AMCEILKEEP1 (ompkit-yf8sg): the 0.2.145 install dropped the hand-set ceiling and the 6 GiB default killed a healthy 6.7 GB server.
const PS_HEALTHY_LARGE = [
	"    1      64 /sbin/launchd",
	"  111 7000000 /Users/fixture/.local/bin/am serve-http --host 127.0.0.1 --port 8765",
].join("\n");

test("AMCEILKEEP1: a healthy 7 GiB Agent Mail is not restarted under the default ceiling; an explicit 6 GiB ceiling still restarts it", () => {
	const saved = process.env.OMP_KIT_AM_RSS_CEILING_BYTES;
	try {
		delete process.env.OMP_KIT_AM_RSS_CEILING_BYTES;
		const quiet = makeWorld({ ps: PS_HEALTHY_LARGE, tail: QUIET_LOG });
		const result = checkAmWatch(fixtureRoot(), depsFor(quiet));
		expect(result.status).not.toBe("RESTARTED");
		expect(quiet.kickstarts).toEqual([]);
		process.env.OMP_KIT_AM_RSS_CEILING_BYTES = String(6 * 1024 * 1024 * 1024);
		const strict = makeWorld({ ps: PS_HEALTHY_LARGE, tail: QUIET_LOG });
		const restarted = checkAmWatch(fixtureRoot(), depsFor(strict));
		expect(restarted.status).toBe("RESTARTED");
		expect(restarted.reason).toBe("rss-ceiling");
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_AM_RSS_CEILING_BYTES; else process.env.OMP_KIT_AM_RSS_CEILING_BYTES = saved;
	}
});

test("AMWATCH1: a fresh fatal line restarts at low RSS", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: FATAL_LOG });
	const result = checkAmWatch(root, depsFor(world));
	expect(result.status).toBe("RESTARTED");
	expect(result.reason).toBe("fatal-pressure");
	expect(result.fatalAt).toBe("2026-11-11T23:22:37.635433Z");
	expect(world.kickstarts).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.agent-mail"]]);
	const receipt = JSON.parse(readFileSync(join(root, AM_WATCH_RECEIPT_NAME), "utf8")) as Record<string, unknown>;
	expect(receipt).toMatchObject({ reason: "fatal-pressure", fatal_at: "2026-11-11T23:22:37.635433Z" });
});

test("AMWATCH1: a second tick inside 30 min does not kickstart again", () => {
	const root = fixtureRoot();
	const world = makeWorld({ tail: QUIET_LOG });
	const first = checkAmWatch(root, depsFor(world));
	expect(first.status).toBe("RESTARTED");
	world.clock.now = BASE_NOW + 5 * 60 * 1000;
	const second = checkAmWatch(root, depsFor(world));
	expect(second.status).toBe("COOLDOWN");
	expect(second.reason).toBe("rss-ceiling");
	expect(world.kickstarts).toHaveLength(1);
});

test("AMWATCH1 planted negative: 2 GB with no fatal line does nothing", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: QUIET_LOG });
	const result = checkAmWatch(root, depsFor(world));
	expect(result.status).toBe("OK");
	expect(result.reason).toBeNull();
	expect(world.kickstarts).toHaveLength(0);
	expect(existsSync(join(root, AM_WATCH_RECEIPT_NAME))).toBe(false);
});

test("AMWATCH1: a missing launchd label reports and does nothing", () => {
	const root = fixtureRoot();
	const world = makeWorld({ print: "", printCode: 113, printStderr: "Could not find service: gui/501/com.agent-mail" });
	const result = checkAmWatch(root, depsFor(world));
	expect(result.status).toBe("NO_LABEL");
	expect(world.kickstarts).toHaveLength(0);
	expect(world.tailCalls).toHaveLength(0);
	expect(existsSync(join(root, AM_WATCH_RECEIPT_NAME))).toBe(false);
});

test("AMWATCH2: two consecutive wedged probes at low RSS restart once as unresponsive", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: QUIET_LOG });
	const probe = scriptedProbe(PROBE_WEDGED);
	const first = checkAmWatch(root, depsFor(world, { probe: probe.probe }));
	expect(first.status).toBe("OK");
	expect(first.probeStreak).toBe(1);
	expect(world.kickstarts).toHaveLength(0);
	world.clock.now = BASE_NOW + 5 * 60 * 1000;
	const second = checkAmWatch(root, depsFor(world, { probe: probe.probe }));
	expect(second.status).toBe("RESTARTED");
	expect(second.reason).toBe("unresponsive");
	expect(world.kickstarts).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.agent-mail"]]);
	const receipt = JSON.parse(readFileSync(join(root, AM_WATCH_RECEIPT_NAME), "utf8")) as Record<string, unknown>;
	expect(receipt).toMatchObject({ reason: "unresponsive", kickstart_rc: 0 });
	const streak = JSON.parse(readFileSync(join(root, AM_WATCH_PROBE_NAME), "utf8")) as Record<string, unknown>;
	expect(streak.consecutive_failures).toBe(0);
});

test("AMWATCH2 planted negative: a successful probe between two wedged ones resets the streak", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: QUIET_LOG });
	const probe = scriptedProbe(PROBE_WEDGED, PROBE_OK, PROBE_WEDGED);
	const results = [0, 1, 2].map(tick => {
		world.clock.now = BASE_NOW + tick * 5 * 60 * 1000;
		return checkAmWatch(root, depsFor(world, { probe: probe.probe }));
	});
	expect(results.map(r => r.status)).toEqual(["OK", "OK", "OK"]);
	expect(results.map(r => r.probeStreak)).toEqual([1, 0, 1]);
	expect(world.kickstarts).toHaveLength(0);
});

test("AMWATCH2: an inconclusive probe neither counts nor resets the streak", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: QUIET_LOG });
	const probe = scriptedProbe(PROBE_WEDGED, PROBE_INCONCLUSIVE, PROBE_WEDGED);
	const results = [0, 1, 2].map(tick => {
		world.clock.now = BASE_NOW + tick * 5 * 60 * 1000;
		return checkAmWatch(root, depsFor(world, { probe: probe.probe }));
	});
	expect(results.map(r => r.probeStreak)).toEqual([1, 1, 2]);
	expect(results[2]?.status).toBe("RESTARTED");
	expect(world.kickstarts).toHaveLength(1);
});

test("AMWATCH2: a restart is not repeated inside the 30 min cooldown", () => {
	const root = fixtureRoot();
	const world = makeWorld({ ps: PS_QUIET, tail: QUIET_LOG });
	const probe = scriptedProbe(PROBE_WEDGED);
	const statuses: string[] = [];
	for (let tick = 0; tick < 4; tick += 1) {
		world.clock.now = BASE_NOW + tick * 5 * 60 * 1000;
		statuses.push(checkAmWatch(root, depsFor(world, { probe: probe.probe })).status);
	}
	expect(statuses).toEqual(["OK", "RESTARTED", "OK", "COOLDOWN"]);
	expect(world.kickstarts).toHaveLength(1);
});

test("AMWATCH2: no probe call is made when RSS already forces a restart", () => {
	const root = fixtureRoot();
	const world = makeWorld({ tail: QUIET_LOG });
	const probe = scriptedProbe(PROBE_WEDGED);
	const result = checkAmWatch(root, depsFor(world, { probe: probe.probe }));
	expect(result.reason).toBe("rss-ceiling");
	expect(probe.state.calls).toBe(0);
});

test("AMWATCH2: classifyAmProbe judges only a timeout or a pool error as wedged", () => {
	expect(classifyAmProbe(null, true, "").outcome).toBe("wedged");
	expect(classifyAmProbe(1, false, "error: Pool error: acquire timeout: no connections available").outcome).toBe("wedged");
	expect(classifyAmProbe(0, false, "[]").outcome).toBe("ok");
	expect(classifyAmProbe(1, false, "error: agent 'X' not found").outcome).toBe("inconclusive");
	expect(classifyAmProbe(127, false, "spawn failed").outcome).toBe("inconclusive");
});
