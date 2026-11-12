import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { AM_WATCH_RECEIPT_NAME, checkAmWatch, type AmWatchDeps, type AmWatchRunResult } from "../../src/am-watch.ts";
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
	"  111 7340032 /Users/fixture/.local/bin/am serve-http --host 127.0.0.1 --port 8765",
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

function depsFor(world: FakeWorld, extra?: Partial<AmWatchDeps>): AmWatchDeps {
	return { run: world.run, readTail: world.readTail, nowMs: () => world.clock.now, uid: 501, ...extra };
}

test("AMWATCH1: an over-ceiling RSS restarts exactly once and records a receipt", () => {
	const root = fixtureRoot();
	const world = makeWorld({ tail: QUIET_LOG });
	const result = checkAmWatch(root, depsFor(world));
	expect(result.status).toBe("RESTARTED");
	expect(result.reason).toBe("rss-ceiling");
	expect(result.pid).toBe(111);
	expect(result.rssBytes).toBe(7340032 * 1024);
	expect(world.kickstarts).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.agent-mail"]]);
	const receipt = JSON.parse(readFileSync(join(root, AM_WATCH_RECEIPT_NAME), "utf8")) as Record<string, unknown>;
	expect(receipt).toMatchObject({ schema_version: 1, pid: 111, rss_bytes: 7340032 * 1024, reason: "rss-ceiling", kickstart_rc: 0 });
	expect(typeof receipt.finished_at).toBe("string");
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
