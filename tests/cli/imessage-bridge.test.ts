import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixtureAsync } from "./fixture-process.ts";
import {
	inboundPrompt,
	normalizeHandle,
	notifyBlocked,
	parseHistoryPayload,
	pickChatForHandle,
	pollBridge,
	readBridgeConfig,
	runBrief,
	sanitizeInbound,
	sendReply,
	type BridgeConfig,
	type Deliver,
} from "../../src/imessage-bridge.ts";

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
		TO="$to" TEXT="$text" OUT="$state/outbox.jsonl" python3 -c 'import json,os; open(os.environ["OUT"],"a").write(json.dumps({"to":os.environ["TO"],"text":os.environ["TEXT"]})+"\\n")'
		printf '{"status":"sent"}\\n'
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

function makeHome(tag: string, historyRows: readonly unknown[], chatRows?: readonly unknown[], handle = HANDLE): { home: string; state: string; env: Record<string, string> } {
	const home = join(scratch.path, tag);
	const state = join(home, "stub-state");
	mkdirSync(state, { recursive: true });
	mkdirSync(join(home, "tmux"), { recursive: true });
	const bin = join(home, "bin");
	writeStubBin(bin);
	writeFileSync(join(home, "fleet-watch.json"), `${JSON.stringify({ imessage: { handle, seat: "leadsession", pane: "%1" } })}\n`);
	const chats = chatRows ?? [{ id: 7, is_group: false, participants: [handle] }];
	writeFileSync(join(state, "chats.json"), toJsonLines(chats));
	writeFileSync(join(state, "history.json"), toJsonLines(historyRows));
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

async function runUnitPoll(tag: string, config: BridgeConfig, deliver: Deliver, enforce?: boolean, chats?: string, history?: string) {
	const prev = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = join(unitHome, tag);
	const chatDoc = chats ?? toJsonLines([{ id: 7, is_group: false, participants: [config.handle] }]);
	const histDoc = history ?? toJsonLines(otherRows);
	try {
		return await pollBridge({ home: join(unitHome, tag), config, imsgBin: "imsg",
			runImsg: argv => argv[1] === "chats" ? { code: 0, out: chatDoc } : { code: 0, out: histDoc },
			deliver, ...(enforce === undefined ? {} : { enforceHandleCheck: enforce }),
			now: () => new Date("2026-11-11T10:00:00Z") });
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
	expect(poll.skipped).toBe(1);
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
