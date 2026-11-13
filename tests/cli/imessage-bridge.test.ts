import { afterAll, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import {
	REPLY_PREFIX,
	inboundPrompt,
	isSelfChatMode,
	normalizeHandle,
	notifyBlocked,
	parseHistoryPayload,
	pickChatForHandle,
	pollBridge,
	readBridgeConfig,
	resolveBridgeSendTarget,
	runBrief,
	sanitizeInbound,
	sendReply,
	type BridgeConfig,
	type Deliver,
} from "../../src/imessage-bridge.ts";
import { ternSteerQueued } from "../../src/send.ts";

const source = resolve(import.meta.dir, "../..");
const scratchRoot = join(source, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("imessage-bridge-tests", { root: scratchRoot });
afterAll(() => scratch.cleanup());

const HANDLE = "+15551234567";
const OTHER = "+19998887777";
const cli = join(source, "src", "cli.ts");

function writeStubBin(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "imsg"), `#!/bin/sh
state="\${IMSG_STUB_STATE:?}"
mode="$1"
shift
case "$mode" in
	chats) cat "$state/chats.json";;
	history) cat "$state/history.json";;
	send)
		to=""
		text=""
		while [ $# -gt 0 ]; do
			case "$1" in
				--to) to="$2"; shift 2;;
				--text) text="$2"; shift 2;;
				*) shift;;
			esac
		done
		n=1
		if [ -f "$state/send-count" ]; then n=$(( $(cat "$state/send-count") + 1 )); fi
		printf '%s' "$n" > "$state/send-count"
		TO="$to" TEXT="$text" OUT="$state/outbox.jsonl" python3 -c 'import json,os; open(os.environ["OUT"],"a").write(json.dumps({"to":os.environ["TO"],"text":os.environ["TEXT"]})+"\\n")'
		printf '{"status":"sent","guid":"stub-reply-%s"}\\n' "$n"
		;;
	*) printf '{"error":"unknown mode"}\\n'; exit 1;;
esac
`);
	writeFileSync(join(dir, "tmux"), `#!/bin/sh
state="\${IMSG_STUB_STATE:?}"
if [ "$1" = "capture-pane" ]; then
	marker=""
	if [ -f "$state/marker" ]; then marker="$(cat "$state/marker")"; fi
	printf 'relay active\\nlast delivered [%s]\\nseat idle\\n' "$marker"
	exit 0
fi
printf 'stub-tmux: %s\\n' "$*" >> "$state/tmux.log"
exit 0
`);
	writeFileSync(join(dir, "ntm"), `#!/bin/sh
state="\${IMSG_STUB_STATE:?}"
printf 'ntm-send-call\n' >> "$state/sends.log"
marker="$(printf '%s' "$*" | sed -n 's/.*\\[\\(kit-send-[0-9a-f][0-9a-f]*\\)\\].*/\\1/p')"
if [ -n "$marker" ]; then printf '%s' "$marker" > "$state/marker"; fi
exit 0
`);
	for (const name of ["imsg", "tmux", "ntm"]) chmodSync(join(dir, name), 0o755);
}

/** Real imsg 0.20.0 shapes, one JSON object per line. */
function toJsonLines(rows: readonly unknown[]): string {
	return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

function makeHome(tag: string, historyRows: readonly unknown[], chatRows?: readonly unknown[], handle = HANDLE, primed = true): { home: string; state: string; env: Record<string, string> } {
	const home = join(scratch.path, tag);
	const state = join(home, "stub-state");
	mkdirSync(state, { recursive: true });
	mkdirSync(join(home, "tmux"), { recursive: true });
	const bin = join(home, "bin");
	writeStubBin(bin);
	writeFileSync(join(home, "fleet-watch.json"), `${JSON.stringify({ imessage: { handle, seat: "leadsession", pane: "%1" } })}\n`);
	// IMSGLIVE1: a running bridge already has a cursor. Seed a prior row and
	// point the cursor at it so existing delivery tests exercise new arrivals,
	// not bridge start; unprimed homes test the fresh-cursor path instead.
	// History arrives newest-first, so the seed goes last as the oldest row.
	const rows = primed ? [...historyRows, { guid: "bridge-prior-0", sender: handle, text: "(seed)", is_from_me: false, is_group: false }] : historyRows;
	const chats = chatRows ?? [{ id: 7, is_group: false, participants: [handle] }];
	writeFileSync(join(state, "chats.json"), toJsonLines(chats));
	writeFileSync(join(state, "history.json"), toJsonLines(rows));
	if (primed) {
		const jobs = join(home, ".local", "state", "omp-kit", "jobs");
		mkdirSync(jobs, { recursive: true });
		writeFileSync(join(jobs, "imessage-bridge.cursor.json"), `${JSON.stringify({ last_key: "bridge-prior-0" })}\n`);
	}
	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		HOME: home,
		XDG_STATE_HOME: join(home, ".local", "state"),
		OMP_KIT_FLEET_WATCH_CONFIG: join(home, "fleet-watch.json"),
		OMP_KIT_IMSG_BIN: join(bin, "imsg"),
		IMSG_STUB_STATE: state,
		TMUX_TMPDIR: join(home, "tmux"),
		AGENT_NAME: "TestBridge",
		PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		GIT_CEILING_DIRECTORIES: home,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	return { home, state, env };
}

function lines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== "");
}

async function runCli(env: Record<string, string>, ...args: string[]) {
	const result = await runFixtureAsync(["bun", "run", "--no-env-file", "--config=/dev/null", cli, ...args, "--json"],
		{ cwd: source, env, floor_s: 10 });
	const out = new TextDecoder().decode(result.stdout);
	const err = new TextDecoder().decode(result.stderr);
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(out) as Record<string, unknown>;
	} catch { /* assertion below names stdout/stderr */ }
	return { result, out, err, json };
}

const allowedRows = [{ guid: "g1", sender: HANDLE, text: "ping from phone", is_from_me: false, is_group: false }];
const otherRows = [{ guid: "g9", sender: OTHER, text: "sneaky other sender body", is_from_me: false, is_group: false }];
const groupChats = [{ id: 99, is_group: true, participants: [HANDLE, OTHER] }];

test("IMSGCHIEF1 poll delivers exactly one proven prompt from the allowed handle", async () => {
	const { state, env } = makeHome("cli-allowed", allowedRows);
	const { result, json, out, err } = await runCli(env, "imessage", "poll");
	expect(`${result.rc} ${out} ${err}`).toContain('"overall":"OK"');
	expect(json?.data).toMatchObject({ delivered: 1, dropped: 0 });
	expect(lines(join(state, "sends.log")).length).toBe(1);
});

test("IMSGCHIEF1 poll drops another sender by hash and never touches the seat", async () => {
	const { home, state, env } = makeHome("cli-other", otherRows);
	const { result, json, out, err } = await runCli(env, "imessage", "poll");
	expect(`${result.rc} ${out} ${err}`).toContain('"overall":"OK"');
	expect(json?.data).toMatchObject({ delivered: 0, dropped: 1 });
	expect(lines(join(state, "sends.log")).length).toBe(0);
	const drops = lines(join(home, ".local", "state", "omp-kit", "jobs", "imessage-bridge.drops.jsonl"));
	expect(drops.length).toBe(1);
	expect(drops[0]).toContain(createHash("sha256").update(OTHER, "utf8").digest("hex"));
	expect(drops[0]).not.toContain("sneaky other sender body");
});

test("IMSGCHIEF1 format-variant handles meet after normalization", async () => {
	const rows = [{ guid: "g2", sender: "+15551234567", text: "variant formats", is_from_me: false, is_group: false }];
	const chats = [{ id: 7, is_group: false, participants: ["5551234567"] }];
	const { env } = makeHome("cli-variant", rows, chats, "+1 (555) 123-4567");
	const { result, json, out, err } = await runCli(env, "imessage", "poll");
	expect(`${result.rc} ${out} ${err}`).toContain('"overall":"OK"');
	expect(json?.data).toMatchObject({ delivered: 1, dropped: 0 });
});

test("IMSGCHIEF1 group chat with the handle never opens the relay", async () => {
	const { state, env } = makeHome("cli-group", allowedRows, groupChats);
	const { result, json, out, err } = await runCli(env, "imessage", "poll");
	expect(`${result.rc} ${out} ${err}`).toContain('"overall":"FINDINGS"');
	expect(json?.data).toMatchObject({ status: "NO_CHAT" });
	expect(lines(join(state, "sends.log")).length).toBe(0);
});

test("IMSGCHIEF1 reply is sent once with a receipt", async () => {
	const { home, state, env } = makeHome("cli-reply", allowedRows);
	const first = await runCli(env, "imessage", "send", "hello josh");
	expect(`${first.result.rc} ${first.out} ${first.err}`).toContain('"overall":"OK"');
	const second = await runCli(env, "imessage", "send", "still here");
	expect(`${second.result.rc} ${second.out} ${second.err}`).toContain('"overall":"OK"');
	const outbox = lines(join(state, "outbox.jsonl")).map(line => JSON.parse(line) as { to: string; text: string });
	expect(outbox.length).toBe(2);
	expect(outbox[0]).toMatchObject({ to: "5551234567", text: "hello josh" });
	const replies = lines(join(home, ".local", "state", "omp-kit", "jobs", "imessage-bridge.replies.jsonl"));
	expect(replies.length).toBe(2);
	expect(replies.every(line => line.includes('"status":"SENT"'))).toBe(true);
});

test("IMSGCHIEF1 restart does not redeliver", async () => {
	const { state, env } = makeHome("cli-restart", allowedRows);
	const first = await runCli(env, "imessage", "poll");
	expect(`${first.result.rc}`).toBe("0");
	const second = await runCli(env, "imessage", "poll");
	expect(`${second.result.rc} ${second.out} ${second.err}`).toContain('"overall":"OK"');
	expect(second.json?.data).toMatchObject({ delivered: 0, dropped: 0 });
	expect(lines(join(state, "sends.log")).length).toBe(1);
});

test("IMSGCHIEF1 notify-blocked pushes once per key", async () => {
	const { state, env } = makeHome("cli-notify", allowedRows);
	const first = await runCli(env, "imessage", "notify-blocked", "--key", "bead-1", "--text", "blocked on you");
	expect(`${first.result.rc} ${first.out} ${first.err}`).toContain('"overall":"OK"');
	const second = await runCli(env, "imessage", "notify-blocked", "--key", "bead-1", "--text", "blocked on you");
	expect(`${second.result.rc} ${second.out} ${second.err}`).toContain("DEDUPED");
	expect(lines(join(state, "outbox.jsonl")).length).toBe(1);
});

const unitHome = join(scratch.path, "unit-state-home");
mkdirSync(unitHome, { recursive: true });
const savedXdg = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = join(unitHome, ".local", "state");
afterAll(() => {
	if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = savedXdg;
});

const unitConfig: BridgeConfig = { handle: HANDLE, seat: "s", pane: "%1", configPath: "unit" };
const unitEnv: NodeJS.ProcessEnv = { ...process.env, HOME: unitHome };

// IMSGLIVE1: a running bridge already has a cursor. Prime a fresh tag once
// with a prior-only tick so the real poll exercises new arrivals, not bridge
// start; history arrives newest-first, so the seed goes last as the oldest
// row and only newer rows deliver.
const primedUnitTags = new Set<string>();
async function runUnitPoll(tag: string, config: BridgeConfig, deliver: Deliver, enforce?: boolean, chats?: string, history?: string) {
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	const chatDoc = chats ?? toJsonLines([{ id: 7, is_group: false, participants: [config.handle] }]);
	const histDoc = history ?? toJsonLines(otherRows);
	const prior = `${JSON.stringify({ guid: "bridge-prior-0", sender: config.handle, text: "(seed)", is_from_me: false, is_group: false })}\n`;
	const now = () => new Date("2026-11-11T10:00:00Z");
	const discard: Deliver = async () => ({ ok: true, marker: "", code: "OK" });
	try {
		if (!primedUnitTags.has(`unit:${tag}`)) {
			primedUnitTags.add(`unit:${tag}`);
			await pollBridge({ home: join(unitHome, tag), config, imsgBin: "imsg",
				runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: prior },
				deliver: discard, ...(enforce === undefined ? {} : { enforceHandleCheck: enforce }), now });
		}
		return await pollBridge({ home: join(unitHome, tag), config, imsgBin: "imsg",
			runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: histDoc + prior },
			deliver, ...(enforce === undefined ? {} : { enforceHandleCheck: enforce }), now });
	} finally {
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	}
}

test("IMSGCHIEF1 planted negative: without the handle check another sender reaches the seat", async () => {
	const seen: string[] = [];
	const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "m1", code: "OK" }; };
	const open = await runUnitPoll("open", { ...unitConfig, handle: OTHER }, deliver);
	expect(open.delivered).toBe(1);
	expect(seen.length).toBe(1);
	const guarded = await runUnitPoll("guarded", unitConfig, deliver);
	expect(guarded.delivered).toBe(0);
	expect(guarded.dropped).toBe(1);
	expect(seen.length).toBe(1);
	const nocheck = await runUnitPoll("nocheck", unitConfig, deliver, false);
	expect(nocheck.delivered).toBe(1);
	expect(seen.length).toBe(2);
});

test("IMSGCHIEF1 JSONL parses line by line with single documents intact", () => {
	const jsonl = toJsonLines([
		{ guid: "a1", sender: HANDLE, text: "one", is_from_me: false },
		"corrupt line",
		{ guid: "a2", sender: OTHER, text: "two", is_from_me: false },
	]);
	const corrupt = `${jsonl}not json at all\n`;
	expect(parseHistoryPayload(corrupt).map(message => message.key)).toEqual(["a1", "a2"]);
	const single = JSON.stringify({ messages: [{ guid: "s1", sender: HANDLE, text: "solo", is_from_me: false }] });
	expect(parseHistoryPayload(single).map(message => message.key)).toEqual(["s1"]);
	const chats = toJsonLines([
		{ id: 9, is_group: false, participants: [OTHER] },
		{ id: 7, is_group: false, participants: [HANDLE] },
	]);
	expect(pickChatForHandle(chats, HANDLE)).toBe("7");
	expect(pickChatForHandle(JSON.stringify({ chats: [{ id: 7, participants: [HANDLE] }] }), HANDLE)).toBe("7");
});

test("IMSGCHIEF1 group rows never open the relay", async () => {
	expect(pickChatForHandle(toJsonLines(groupChats), HANDLE)).toBeNull();
	const groupHistory = toJsonLines([
		{ guid: "gg", sender: OTHER, text: "group ping", is_from_me: false, is_group: true },
		...allowedRows,
	]);
	const seen: string[] = [];
	const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "m9", code: "OK" }; };
	const solo = toJsonLines([{ id: 7, is_group: false, participants: [HANDLE] }]);
	const poll = await runUnitPoll("groupmsg", unitConfig, deliver, undefined, solo, groupHistory);
	expect(poll.delivered).toBe(1);
	expect(poll.skipped).toBe(1); // the group row; the seeded row is older than the cursor
	expect(seen.length).toBe(1);
	expect(seen[0]).toContain("ping from phone");
	const chatless = await runUnitPoll("groupchat", unitConfig, deliver, undefined, toJsonLines(groupChats), groupHistory);
	expect(chatless.status).toBe("NO_CHAT");
	expect(chatless.delivered).toBe(0);
	expect(seen.length).toBe(1);
});

test("IMSGCHIEF1 delivery failure keeps the at-least-once cursor and hides the body", async () => {
	const histDoc = toJsonLines(allowedRows);
	const failing: Deliver = async () => ({ ok: false, marker: "mfail", code: "NOT_DELIVERED" });
	const poll = await runUnitPoll("failcursor", unitConfig, failing, undefined, undefined, histDoc);
	expect(poll.status).toBe("DELIVERY_FAILED");
	expect(poll.receipt.marker).toBe("mfail");
	expect(poll.receipt.delivery_code).toBe("NOT_DELIVERED");
	expect("detail" in poll.receipt).toBe(false);
	expect(JSON.stringify(poll.receipt)).not.toContain("ping from phone");
	const retry = await runUnitPoll("failcursor", unitConfig, async () => ({ ok: true, marker: "m2", code: "OK" }), undefined, undefined, histDoc);
	expect(retry.delivered).toBe(1);
});

test("IMSGCHIEF1 handle normalization folds format variants", () => {
	expect(normalizeHandle("+1 (555) 123-4567")).toBe("5551234567");
	expect(normalizeHandle("5551234567")).toBe("5551234567");
	expect(normalizeHandle("+15551234567")).toBe("5551234567");
	expect(normalizeHandle("Joshua@Example.com ")).toBe("joshua@example.com");
	const resolved = readBridgeConfig(join(unitHome, "nope"), { ...unitEnv,
		OMP_KIT_FLEET_WATCH_CONFIG: join(unitHome, "absent.json"), OMP_KIT_IMESSAGE_HANDLE: "+1 (555) 123-4567",
		OMP_KIT_IMESSAGE_SEAT: "s", OMP_KIT_IMESSAGE_PANE: "%1" });
	expect(resolved.ok).toBe(true);
	if (resolved.ok) expect(resolved.config.handle).toBe("5551234567");
});

test("IMSGCHIEF1 missing handle refuses to start", () => {
	const resolved = readBridgeConfig(join(unitHome, "nope"), { ...unitEnv, OMP_KIT_FLEET_WATCH_CONFIG: join(unitHome, "absent.json") });
	expect(resolved.ok).toBe(false);
	if (!resolved.ok) expect(resolved.code).toBe("IMESSAGE_NO_HANDLE");
});

test("IMSGCHIEF1 sanitize caps, strips controls, and prefixes untrusted text", () => {
	const dirty = `hi${String.fromCharCode(2)} there${String.fromCharCode(7)} ok`;
	expect(sanitizeInbound(dirty)).toBe("hi there ok");
	expect(sanitizeInbound(`x`.repeat(5000)).length).toBe(4000);
	const prompt = inboundPrompt(HANDLE, "hello");
	expect(prompt.startsWith("[via imessage-bridge:")).toBe(true);
	expect(prompt).toContain(HANDLE);
	expect(prompt.startsWith("[from ")).toBe(false);
	expect(parseHistoryPayload("not json")).toEqual([]);
	expect(pickChatForHandle("not json", HANDLE)).toBeNull();
	expect(pickChatForHandle(JSON.stringify({ chats: [{ chat_id: "7", participants: [OTHER] }] }), HANDLE)).toBeNull();
});

test("IMSGCHIEF1 notify dedupe and brief counts are receipts", () => {
	const home = join(unitHome, "notify-unit");
	const calls: string[][] = [];
	const runImsg = (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "{}" }; };
	const at = new Date("2026-11-11T12:00:00Z");
	const first = notifyBlocked({ home, config: unitConfig, imsgBin: "imsg", runImsg, key: "bead-1", text: "blocked", now: () => at });
	expect(first.sent).toBe(true);
	const second = notifyBlocked({ home, config: unitConfig, imsgBin: "imsg", runImsg, key: "bead-1", text: "blocked", now: () => at });
	expect(second.deduped).toBe(true);
	expect(calls.filter(argv => argv[1] === "send").length).toBe(1);
	const bad = notifyBlocked({ home, config: unitConfig, imsgBin: "imsg", runImsg, key: "no spaces allowed!!", text: "x", now: () => at });
	expect(bad.sent).toBe(false);
	const brief = runBrief({ home, config: unitConfig, imsgBin: "imsg", runImsg, now: () => at });
	expect(brief.sent).toBe(true);
	expect(brief.counts.blocked).toBe(1);
	const sent = calls.filter(argv => argv[1] === "send").at(-1) ?? [];
	expect(sent.join(" ")).toContain("daily brief");
	const reply = sendReply({ home, config: unitConfig, imsgBin: "imsg", runImsg, text: "   ", now: () => at });
	expect(reply.sent).toBe(false);
});

const SELF_CHATS = [{ id: 1, is_group: false, identifier: HANDLE, account_login: OTHER, participants: [HANDLE], service: "iMessage" }];
const selfUserRows = [{ guid: "self-1", sender: HANDLE, destination_caller_id: HANDLE, text: "note to self", is_from_me: true, is_group: false }];
const selfReplyRow = (guid: string, text: string) => ({ guid, sender: HANDLE, destination_caller_id: HANDLE, text, is_from_me: true, is_group: false });

async function runSelfPoll(tag: string, deliver: Deliver, guard?: boolean, chats?: string, history?: string) {
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	const chatDoc = chats ?? toJsonLines(SELF_CHATS);
	const histDoc = history ?? toJsonLines(selfUserRows);
	const prior = `${JSON.stringify({ guid: "bridge-prior-0", sender: HANDLE, destination_caller_id: HANDLE, text: "(seed)", is_from_me: true, is_group: false })}\n`;
	const now = () => new Date("2026-11-11T10:00:00Z");
	const discard: Deliver = async () => ({ ok: true, marker: "", code: "OK" });
	try {
		if (!primedUnitTags.has(`self:${tag}`)) {
			primedUnitTags.add(`self:${tag}`);
			await pollBridge({ home: join(unitHome, tag), config: unitConfig, imsgBin: "imsg",
				runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: prior },
				deliver: discard, ...(guard === undefined ? {} : { enforceLoopGuard: guard }), now });
		}
		return await pollBridge({ home: join(unitHome, tag), config: unitConfig, imsgBin: "imsg",
			runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: histDoc + prior },
			deliver, ...(guard === undefined ? {} : { enforceLoopGuard: guard }), now });
	} finally {
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	}
}

test("IMSGSELF1 self-chat row typed by Joshua is delivered once", async () => {
	const seen: string[] = [];
	const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "mself", code: "OK" }; };
	const first = await runSelfPoll("selfonce", deliver);
	expect(first.selfChat).toBe(true);
	expect(first.status).toBe("OK");
	expect(first.delivered).toBe(1);
	expect(seen.length).toBe(1);
	expect(seen[0]).toContain("note to self");
	const second = await runSelfPoll("selfonce", deliver);
	expect(second.delivered).toBe(0);
	expect(seen.length).toBe(1);
});

test("IMSGSELF1 bridge reply with recorded guid and prefix is never delivered", async () => {
	const tag = "selfreply";
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	const home = join(unitHome, tag);
	const priorRow = selfReplyRow("bridge-prior-0", "(seed)");
	let histDoc = toJsonLines([...selfUserRows, priorRow]);
	const sent: string[][] = [];
	const at = () => new Date("2026-11-11T10:00:00Z");
	const runImsg = (argv: readonly string[]) => {
		if (argv[1] === "chats") return { code: 0, out: toJsonLines(SELF_CHATS) };
		if (argv[1] === "send") { sent.push([...argv]); return { code: 0, out: '{"status":"sent","guid":"reply-1"}' }; }
		return { code: 0, out: histDoc };
	};
	try {
		const seen: string[] = [];
		const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "mself", code: "OK" }; };
		// IMSGLIVE1: prime the cursor with a prior-only tick so the first
		// real poll delivers the pre-existing note as a new arrival.
		const primeHist = toJsonLines([priorRow]);
		const prime = await pollBridge({ home, config: unitConfig, imsgBin: "imsg",
			runImsg: argv => argv[1] === "chats" ? { code: 0, out: toJsonLines(SELF_CHATS) } : argv[1] === "send" ? runImsg(argv) : { code: 0, out: primeHist },
			deliver: async () => ({ ok: true, marker: "", code: "OK" }), now: at });
		expect(prime.delivered).toBe(0);
		const first = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg, deliver, now: at });
		expect(first.selfChat).toBe(true);
		expect(first.delivered).toBe(1);
		const reply = sendReply({ home, config: unitConfig, imsgBin: "imsg", runImsg, text: "got it", selfChat: true, now: at });
		expect(reply.sent).toBe(true);
		expect(reply.receipt.guid).toBe("reply-1");
		expect(reply.receipt.prefixed).toBe(true);
		expect(sent.at(-1) ?? []).toContain(`${REPLY_PREFIX}got it`);
		histDoc = toJsonLines([selfReplyRow("reply-1", `${REPLY_PREFIX}got it`), ...selfUserRows, priorRow]);
		const second = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg, deliver, now: at });
		expect(second.delivered).toBe(0);
		expect(seen.length).toBe(1);
		expect(JSON.stringify(seen)).not.toContain("got it");
		// A prefixed echo with no recorded guid is still caught by the prefix.
		histDoc = toJsonLines([selfReplyRow("mystery", `${REPLY_PREFIX}typed echo`), selfReplyRow("reply-1", `${REPLY_PREFIX}got it`), ...selfUserRows, priorRow]);
		const third = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg, deliver, now: at });
		expect(third.delivered).toBe(0);
		expect(seen.length).toBe(1);
	} finally {
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	}
});

test("IMSGSELF1 planted negative: without the receipt check the reply loops back as a prompt", async () => {
	const seen: string[] = [];
	const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "mneg", code: "OK" }; };
	const recordGuid = (home: string, guid: string) => sendReply({ home, config: unitConfig, imsgBin: "imsg",
		runImsg: () => ({ code: 0, out: `{"status":"sent","guid":"${guid}"}` }),
		text: "bare echo", selfChat: false, now: () => new Date("2026-11-11T10:00:00Z") });
	// An unprefixed row whose guid the bridge recorded: only the receipt check can block it.
	const history = toJsonLines([selfReplyRow("reply-9", "bare echo")]);
	const guardedTag = "selfneg-guarded";
	const openTag = "selfneg-open";
	for (const tag of [guardedTag, openTag]) {
		const prev = process.env.XDG_STATE_HOME;
		process.env.XDG_STATE_HOME = join(unitHome, tag);
		try {
			expect(recordGuid(join(unitHome, tag), "reply-9").sent).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.XDG_STATE_HOME;
			else process.env.XDG_STATE_HOME = prev;
		}
	}
	const guarded = await runSelfPoll(guardedTag, deliver, true, undefined, history);
	expect(guarded.selfChat).toBe(true);
	expect(guarded.delivered).toBe(0);
	const open = await runSelfPoll(openTag, deliver, false, undefined, history);
	expect(open.delivered).toBe(1);
	expect(seen.length).toBe(1);
	expect(seen[0]).toContain("bare echo");
});

test("IMSGSELF1 ordinary mode keeps skipping is_from_me", async () => {
	const seen: string[] = [];
	const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "mord", code: "OK" }; };
	const chats = toJsonLines([{ id: 7, is_group: false, participants: [HANDLE] }]);
	const history = toJsonLines([{ guid: "o1", sender: HANDLE, text: "typed on the mac", is_from_me: true, is_group: false }]);
	const poll = await runSelfPoll("selfordinary", deliver, undefined, chats, history);
	expect(poll.selfChat).toBe(false);
	expect(poll.delivered).toBe(0);
	expect(poll.skipped).toBe(1); // the from_me row; the seeded row is older than the cursor
	expect(seen.length).toBe(0);
});

test("IMSGSELF1 self-chat detection needs the own-account signal", () => {
	const dest = toJsonLines([{ guid: "d1", sender: HANDLE, destination_caller_id: HANDLE, text: "x", is_from_me: true }]);
	const nodest = toJsonLines([{ guid: "d2", sender: HANDLE, text: "x", is_from_me: true }]);
	expect(isSelfChatMode({ identifier: HANDLE, accountLogin: OTHER }, parseHistoryPayload(dest), HANDLE)).toBe(true);
	expect(isSelfChatMode({ identifier: HANDLE, accountLogin: OTHER }, parseHistoryPayload(nodest), HANDLE)).toBe(false);
	expect(isSelfChatMode({ identifier: HANDLE, accountLogin: HANDLE }, parseHistoryPayload(nodest), HANDLE)).toBe(true);
	expect(isSelfChatMode({ identifier: OTHER, accountLogin: HANDLE }, parseHistoryPayload(dest), HANDLE)).toBe(false);
	expect(isSelfChatMode(null, parseHistoryPayload(dest), HANDLE)).toBe(false);
});

test("IMSGSELF1 cli send prefixes in self-chat mode and poll never replays it", async () => {
	const selfChats = [{ id: 1, is_group: false, identifier: HANDLE, account_login: OTHER, participants: [HANDLE], service: "iMessage" }];
	const selfHist = [{ guid: "c1", sender: HANDLE, destination_caller_id: HANDLE, text: "cli note", is_from_me: true, is_group: false }];
	const { home, state, env } = makeHome("cli-self", selfHist, selfChats);
	const poll = await runCli(env, "imessage", "poll");
	expect(`${poll.result.rc} ${poll.out} ${poll.err}`).toContain('"overall":"OK"');
	expect(poll.json?.data).toMatchObject({ delivered: 1, self_chat: true });
	const sent = await runCli(env, "imessage", "send", "on it");
	expect(`${sent.result.rc} ${sent.out} ${sent.err}`).toContain('"overall":"OK"');
	expect(sent.json?.data).toMatchObject({ self_chat: true, prefixed: true });
	const outboxLast: unknown = JSON.parse(lines(join(state, "outbox.jsonl")).at(-1) ?? "{}");
	const outboxText = typeof outboxLast === "object" && outboxLast !== null && "text" in outboxLast && typeof outboxLast.text === "string"
		? outboxLast.text
		: null;
	expect(outboxText).toBe(`${REPLY_PREFIX}on it`);
	const receipts = lines(join(home, ".local", "state", "omp-kit", "jobs", "imessage-bridge.replies.jsonl"));
	const lastReceipt: unknown = JSON.parse(receipts.at(-1) ?? "{}");
	const guid = typeof lastReceipt === "object" && lastReceipt !== null && "guid" in lastReceipt && typeof lastReceipt.guid === "string"
		? lastReceipt.guid
		: null;
	expect(typeof guid).toBe("string");
	appendFileSync(join(state, "history.json"),
		`${JSON.stringify({ guid, sender: HANDLE, destination_caller_id: HANDLE, text: `${REPLY_PREFIX}on it`, is_from_me: true, is_group: false })}\n`);
	const repoll = await runCli(env, "imessage", "poll");
	expect(`${repoll.result.rc} ${repoll.out} ${repoll.err}`).toContain('"overall":"OK"');
	expect(repoll.json?.data).toMatchObject({ delivered: 0 });
	const pushed = await runCli(env, "imessage", "notify-blocked", "--key", "bead-9", "--text", "blocked on you");
	expect(`${pushed.result.rc} ${pushed.out} ${pushed.err}`).toContain('"overall":"OK"');
	const pushLast: unknown = JSON.parse(lines(join(state, "outbox.jsonl")).at(-1) ?? "{}");
	const pushText = typeof pushLast === "object" && pushLast !== null && "text" in pushLast && typeof pushLast.text === "string"
		? pushLast.text
		: null;
	expect(pushText).toBe(`${REPLY_PREFIX}blocked on you`);
});

test("IMSGLIVE1 fresh cursor delivers nothing pre-existing", async () => {
	const tag = "live-fresh";
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	try {
		const home = join(unitHome, tag);
		const chatDoc = toJsonLines([{ id: 7, is_group: false, participants: [HANDLE] }]);
		// Newest-first, as imsg emits: g2 is the conversation tail.
		const older = { guid: "g1", sender: HANDLE, text: "old hello", is_from_me: false, is_group: false };
		const newer = { guid: "g2", sender: HANDLE, text: "new hello", is_from_me: false, is_group: false };
		const oldHist = toJsonLines([newer, older]);
		const seen: string[] = [];
		const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "m1", code: "OK" }; };
		const at = () => new Date("2026-11-11T10:00:00Z");
		const oldRunner = (argv: readonly string[]) => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: oldHist };
		const first = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg: oldRunner, deliver, now: at });
		expect(first.status).toBe("OK");
		expect(first.delivered).toBe(0);
		expect(first.dropped).toBe(0);
		expect(first.skipped).toBe(2);
		expect(seen.length).toBe(0);
		const cursor = JSON.parse(readFileSync(join(unitHome, tag, "omp-kit", "jobs", "imessage-bridge.cursor.json"), "utf8")) as { last_key: string };
		expect(cursor.last_key).toBe("g2");
		// A row arriving after the bridge starts is newer still, so it leads the next window and delivers.
		const arrived = { guid: "g3", sender: HANDLE, text: "fresh hello", is_from_me: false, is_group: false };
		const newRunner = (argv: readonly string[]) => argv[1] === "chats"
			? { code: 0, out: chatDoc }
			: { code: 0, out: toJsonLines([arrived, newer, older]) };
		const second = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg: newRunner, deliver, now: at });
		expect(second.status).toBe("OK");
		expect(second.delivered).toBe(1);
		expect(seen.length).toBe(1);
		expect(seen[0]).toContain("fresh hello");
	} finally {
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	}
});

test("IMSGLIVE1 Tern seat config routes pane, cwd and identity project", () => {
	const home = join(scratch.path, "live-tern-config");
	mkdirSync(home, { recursive: true });
	const seatDir = join(scratch.path, "live-seat");
	const projectDir = join(scratch.path, "live-project");
	const watchPath = join(home, "fleet-watch.json");
	writeFileSync(watchPath, JSON.stringify({ imessage: { handle: HANDLE, seat: "omp-chief", pane: "tern:8380920008540167", cwd: seatDir, project: projectDir } }));
	const resolved = readBridgeConfig(home, { ...unitEnv, OMP_KIT_FLEET_WATCH_CONFIG: watchPath });
	expect(resolved.ok).toBe(true);
	if (!resolved.ok) return;
	expect(resolved.config.cwd).toBe(seatDir);
	expect(resolved.config.project).toBe(projectDir);
	expect(resolveBridgeSendTarget(resolved.config)).toEqual(
		{ route: "tern", session: "omp-chief", pane: "tern:8380920008540167", cwd: seatDir, identityProject: projectDir });
	// A bare pane with no Tern keys keeps the legacy tmux route.
	expect(resolveBridgeSendTarget({ handle: HANDLE, seat: "s", pane: "%1", configPath: "unit" }))
		.toEqual({ route: "tmux", session: "s", pane: "%1" });
	// Env overrides win over the file.
	const over = readBridgeConfig(home, { ...unitEnv, OMP_KIT_FLEET_WATCH_CONFIG: watchPath, OMP_KIT_IMESSAGE_CWD: seatDir });
	expect(over.ok).toBe(true);
	if (!over.ok) return;
	expect(over.config.cwd).toBe(seatDir);
	// A relative cwd refuses before anything is delivered.
	const bad = readBridgeConfig(home, { ...unitEnv, OMP_KIT_FLEET_WATCH_CONFIG: watchPath, OMP_KIT_IMESSAGE_CWD: "relative/path" });
	expect(bad.ok).toBe(false);
	if (bad.ok) return;
	expect(bad.code).toBe("IMESSAGE_CONFIG_INVALID");
});

test("IMSGLIVE1 planted negative: bare-pane delivery failure reports NOT_DELIVERED", async () => {
	const failing: Deliver = async () => ({ ok: false, marker: "", code: "NOT_DELIVERED" });
	const poll = await runUnitPoll("liveneg", { ...unitConfig, pane: "%3" }, failing, undefined, undefined, toJsonLines(allowedRows));
	expect(poll.status).toBe("DELIVERY_FAILED");
	expect(poll.receipt.delivery_code).toBe("NOT_DELIVERED");
	expect(JSON.stringify(poll.receipt)).not.toContain("ping from phone");
	// At-least-once: the cursor still points at the prior row, so the next tick replays the message.
	const cursor = JSON.parse(readFileSync(join(unitHome, "liveneg", "omp-kit", "jobs", "imessage-bridge.cursor.json"), "utf8")) as { last_key: string };
	expect(cursor.last_key).toBe("bridge-prior-0");
});

test("IMSGLIVE1 self-chat echo pair delivers once and the guard covers both reply copies", async () => {
	const tag = "live-echo";
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	const home = join(unitHome, tag);
	try {
		const at = () => new Date("2026-11-11T22:32:00Z");
		// Real row shapes: typed row plus its echo a fraction of a second later, newest-first.
		const row = (guid: string, text: string, fromMe: boolean, created: string) => ({ guid, sender: HANDLE, destination_caller_id: HANDLE, text, is_from_me: fromMe, is_group: false, created_at: created });
		const priorRow = row("bridge-prior-0", "(seed)", true, "2026-11-11T22:29:00.000Z");
		const chatDoc = toJsonLines(SELF_CHATS);
		const seen: string[] = [];
		const deliver: Deliver = async text => { seen.push(text); return { ok: true, marker: "m-echo", code: "OK" }; };
		await pollBridge({ home, config: unitConfig, imsgBin: "imsg",
			runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: toJsonLines([priorRow]) },
			deliver: async () => ({ ok: true, marker: "", code: "OK" }), now: at });
		const runImsg = (argv: readonly string[]) => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: toJsonLines([
			row("echo-1", "call me", false, "2026-11-11T22:31:23.400Z"),
			row("typed-1", "call me", true, "2026-11-11T22:31:23.100Z"),
			row("old-1", "earlier note", true, "2026-11-11T22:30:00.000Z"),
			priorRow,
		]) };
		const first = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg, deliver, now: at });
		expect(first.selfChat).toBe(true);
		expect(first.delivered).toBe(2);
		expect(first.skipped).toBe(1);
		expect(seen.filter(text => text.includes("call me")).length).toBe(1);
		expect(first.lastKey).toBe("echo-1");
		const jobs = join(unitHome, tag, "omp-kit", "jobs");
		expect(lines(join(jobs, "imessage-bridge.deliveries.jsonl"))
			.some(line => line.includes('"key":"echo-1"') && line.includes('"status":"ECHO_DUP"'))).toBe(true);
		// A sent reply and both of its copies never deliver: the recorded
		// row via guid, the echo twin via twin-guid.
		const reply = sendReply({ home, config: unitConfig, imsgBin: "imsg",
			runImsg: () => ({ code: 0, out: '{"status":"sent","guid":"reply-8"}' }),
			text: "bare ok", selfChat: false, now: at });
		expect(reply.sent).toBe(true);
		const runImsg2 = (argv: readonly string[]) => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: toJsonLines([
			row("echo-8", "bare ok", false, "2026-11-11T22:31:50.200Z"),
			row("reply-8", "bare ok", true, "2026-11-11T22:31:50.100Z"),
			row("echo-1", "call me", false, "2026-11-11T22:31:23.400Z"),
			row("typed-1", "call me", true, "2026-11-11T22:31:23.100Z"),
			row("old-1", "earlier note", true, "2026-11-11T22:30:00.000Z"),
			priorRow,
		]) };
		const second = await pollBridge({ home, config: unitConfig, imsgBin: "imsg", runImsg: runImsg2, deliver, now: at });
		expect(second.delivered).toBe(0);
		expect(seen.length).toBe(2);
		const receipts = lines(join(jobs, "imessage-bridge.deliveries.jsonl"));
		expect(receipts.some(line => line.includes('"key":"reply-8"') && line.includes('"via":"guid"'))).toBe(true);
		expect(receipts.some(line => line.includes('"key":"echo-8"') && line.includes('"via":"twin-guid"'))).toBe(true);
	} finally {
		if (prev === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = prev;
	}
});

test("IMSGLIVE1 dispatched pending steer advances the cursor as QUEUED", async () => {
	const stalled: Deliver = async () => ({ ok: false, marker: "m-queued", code: "PROOF_TIMEOUT", queued: true });
	const poll = await runUnitPoll("livequeued", unitConfig, stalled, undefined, undefined, toJsonLines(allowedRows));
	expect(poll.status).toBe("OK");
	expect(poll.queued).toBe(1);
	expect(poll.delivered).toBe(0);
	expect(poll.markers).toEqual(["m-queued"]);
	expect(poll.lastKey).toBe("g1");
	const jobs = join(unitHome, "livequeued", "omp-kit", "jobs");
	expect(JSON.parse(readFileSync(join(jobs, "imessage-bridge.cursor.json"), "utf8"))).toMatchObject({ last_key: "g1" });
	expect(lines(join(jobs, "imessage-bridge.deliveries.jsonl"))
		.some(line => line.includes('"status":"QUEUED"') && line.includes('"marker":"m-queued"'))).toBe(true);
	// The next tick does not re-steer the queued message.
	const retry = await runUnitPoll("livequeued", unitConfig, async () => ({ ok: true, marker: "m2", code: "OK" }), undefined, undefined, toJsonLines(allowedRows));
	expect(retry.delivered).toBe(0);
	expect(retry.queued).toBe(0);
});

test("IMSGLIVE1 undispatched pending keeps the cursor for retry", async () => {
	const ambiguous: Deliver = async () => ({ ok: false, marker: "", code: "SEND_AMBIGUOUS" });
	const poll = await runUnitPoll("liveamb", unitConfig, ambiguous, undefined, undefined, toJsonLines(allowedRows));
	expect(poll.status).toBe("DELIVERY_FAILED");
	expect(poll.queued).toBe(0);
	expect(poll.receipt.delivery_code).toBe("SEND_AMBIGUOUS");
	expect(poll.lastKey).toBe("g1");
});

test("IMSGLIVE1 ternSteerQueued admits only dispatched pendings", () => {
	expect(ternSteerQueued("PENDING_CONSUME", "PROOF_TIMEOUT")).toBe(true);
	expect(ternSteerQueued("PENDING_CONSUME", "GOAL_NOT_ADOPTED")).toBe(true);
	expect(ternSteerQueued("PENDING_CONSUME", "SEND_AMBIGUOUS")).toBe(false);
	expect(ternSteerQueued("PENDING_CONSUME", "SUPPRESSED_PENDING")).toBe(false);
	expect(ternSteerQueued("OK", "PROVEN")).toBe(false);
	expect(ternSteerQueued("NOT_DELIVERED", "UNTIL_DELIVERED_EXHAUSTED")).toBe(false);
	expect(ternSteerQueued("REFUSED", "TERN_WINDOW_UNBOUND")).toBe(false);
});

// IMSGRUN1 (ompkit-1ra0d.240): the scheduled tick is `service run imessage-bridge`. Its job is
// lockedRun with a native body and no configured program; routing it to the configured-command
// runner crashed every tick with HANDLER_FAILED on job.program.argv (planted negative: pre-fix).
test("IMSGRUN1 service run imessage-bridge reaches the native bridge body and records its receipt", async () => {
	const { home, state, env } = makeHome("svc-run", allowedRows);
	chmodSync(join(home, ".local", "state", "omp-kit"), 0o700);
	const { result, json, out, err } = await runCli(env, "service", "run", "imessage-bridge");
	expect(`${out}\n${err}`).not.toContain("job.program.argv");
	expect(`${result.rc} ${out} ${err}`).toContain('"overall":"OK"');
	expect(json?.data).toMatchObject({ job: "imessage-bridge", delivered: 1 });
	expect(lines(join(state, "sends.log")).length).toBe(1);
	const receipt = JSON.parse(readFileSync(join(home, ".local", "state", "omp-kit", "jobs", "imessage-bridge.json"), "utf8")) as Record<string, unknown>;
	expect(receipt.exit).toBe(0);
});
