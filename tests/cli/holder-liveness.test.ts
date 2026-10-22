// STALEDEF1 (ompkit-f9dun): holder liveness for stale-claim reclaim. A holder is live
// when it sits in a live seat (Tern block or tmux pane bound in the Agent Mail identity
// registry), has genuine Agent Mail activity within 24 h, or holds a live reservation.
// Planted negatives: an expired/released reservation, 25 h old mail and a dead Tern block
// never make a holder live; any unreadable source turns DEAD into UNKNOWN.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	agentMailStorageRoot, HOLDER_LIVE_WINDOW_MS, holderVerdict, liveTernBlockKeys, readLivenessSources,
	readMailLiveness, sanitizePaneKey, seatNames, tmuxPaneKeys,
} from "../../src/holder-liveness.ts";
import type { LivenessSources } from "../../src/holder-liveness.ts";

const HOUR = 3600_000;
const NOW = Date.parse("2026-10-22T05:00:00Z");
const base = mkdtempSync(join(tmpdir(), "holder-liveness-"));

function ok<T>(value: T) { return { ok: true as const, value }; }
const sources = (over: Partial<LivenessSources> = {}): LivenessSources => ({
	seats: ok(new Set<string>()), mail: ok(new Map<string, number>()), reservations: ok(new Set<string>()), ...over,
});

test("verdict: no seat, no mail, no reservation with every source readable is DEAD", () => {
	expect(holderVerdict("DeadOne", sources(), NOW).liveness).toBe("DEAD");
});

test("verdict: each source alone makes a holder LIVE, matched case-insensitively", () => {
	expect(holderVerdict("SeatOne", sources({ seats: ok(new Set(["seatone"])) }), NOW).liveness).toBe("LIVE");
	expect(holderVerdict("MailOne", sources({ mail: ok(new Map([["mailone", NOW - 23 * HOUR]])) }), NOW).liveness).toBe("LIVE");
	expect(holderVerdict("HoldOne", sources({ reservations: ok(new Set(["holdone"])) }), NOW).liveness).toBe("LIVE");
});

test("planted: mail older than the 24 h window does not make a holder live", () => {
	const verdict = holderVerdict("MailOne", sources({ mail: ok(new Map([["mailone", NOW - HOLDER_LIVE_WINDOW_MS - HOUR]])) }), NOW);
	expect(verdict.liveness).toBe("DEAD");
});

test("planted: an unreadable source turns DEAD into UNKNOWN naming the source, never DEAD", () => {
	const verdict = holderVerdict("DeadOne", sources({ seats: { ok: false, why: "tern inspect exited 1" } }), NOW);
	expect(verdict.liveness).toBe("UNKNOWN");
	expect(verdict.evidence.join(" ")).toContain("tern inspect exited 1");
	const mail = holderVerdict("DeadOne", sources({ mail: { ok: false, why: "no store" }, reservations: { ok: false, why: "no store" } }), NOW);
	expect(mail.liveness).toBe("UNKNOWN");
});

test("verdict: live evidence wins over an unreadable sibling source", () => {
	const verdict = holderVerdict("SeatOne", sources({ seats: ok(new Set(["seatone"])), mail: { ok: false, why: "no store" } }), NOW);
	expect(verdict.liveness).toBe("LIVE");
});

const TERN = JSON.stringify({
	panes: [{ pane: 11, exited: null }, { pane: 12, exited: null }, { pane: 13, exited: 0 }],
	sessions: [{ name: "Default", tabs: [{ name: "omp-test", blocks: [{ id: 11, live: true }, { id: 12, live: false }, { id: 13, live: true }] }] }],
});

test("tern: only live blocks whose pane has not exited become identity keys", () => {
	expect(liveTernBlockKeys({ code: 0, stdout: TERN, stderr: "" })).toEqual({ ok: true, value: ["tern-11"] });
});

test("planted: tern failure or unparseable output is unreadable, never an empty fleet", () => {
	expect(liveTernBlockKeys({ code: 1, stdout: "", stderr: "daemon down" }).ok).toBe(false);
	expect(liveTernBlockKeys({ code: 0, stdout: "not json", stderr: "" }).ok).toBe(false);
	expect(liveTernBlockKeys({ code: 0, stdout: "{}", stderr: "" }).ok).toBe(false);
});

test("tmux: panes give composite and bare keys; no server is an empty, readable inventory", () => {
	expect(tmuxPaneKeys({ code: 0, stdout: "%7\tfleet:1:2\n", stderr: "" })).toEqual({ ok: true, value: ["fleet-1-2", "7"] });
	expect(tmuxPaneKeys({ code: 1, stdout: "", stderr: "no server running on /x/default" })).toEqual({ ok: true, value: [] });
	expect(tmuxPaneKeys({ code: 1, stdout: "", stderr: "error connecting to /x/default (No such file or directory)" })).toEqual({ ok: true, value: [] });
	expect(tmuxPaneKeys({ code: 1, stdout: "", stderr: "permission denied" }).ok).toBe(false);
	expect(sanitizePaneKey("%3")).toBe("3");
	expect(sanitizePaneKey("a b:c")).toBe("a_b-c");
});

test("seat names: identity files of live keys in any project folder, plain or JSON", () => {
	const root = mkdtempSync(join(base, "identity-"));
	mkdirSync(join(root, "aaaaaaaaaaaa"));
	mkdirSync(join(root, "bbbbbbbbbbbb"));
	writeFileSync(join(root, "aaaaaaaaaaaa", "tern-11"), "SeatOne\n");
	writeFileSync(join(root, "bbbbbbbbbbbb", "fleet-1-2"), JSON.stringify({ name: "PaneOne" }));
	writeFileSync(join(root, "bbbbbbbbbbbb", "tern-99"), "DeadSeat\n");
	const names = seatNames(root, ["tern-11", "fleet-1-2"]);
	expect(names.ok && [...names.value].sort()).toEqual(["paneone", "seatone"]);
	expect(seatNames(join(base, "absent"), ["tern-11"]).ok).toBe(false);
});

function mailStore(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const db = new Database(join(dir, "storage.sqlite3"));
	db.exec("CREATE TABLE agents(id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, last_active_ts INTEGER)");
	db.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, project_id INTEGER, sender_id INTEGER, created_ts INTEGER)");
	db.exec("CREATE TABLE message_recipients(message_id INTEGER, agent_id INTEGER, kind TEXT, read_ts INTEGER, ack_ts INTEGER)");
	db.exec("CREATE TABLE file_reservations(id INTEGER PRIMARY KEY, project_id INTEGER, agent_id INTEGER, path_pattern TEXT, exclusive INTEGER, created_ts INTEGER, expires_ts INTEGER, released_ts INTEGER)");
	const us = (ms: number) => ms * 1000;
	const agents = ["Sender", "Reader", "Holder", "OldMail", "Expired", "Released", "Touched", "Registered"];
	agents.forEach((name, i) => db.prepare("INSERT INTO agents VALUES (?,?,?,?)").run(i + 1, 1, name, us(NOW - HOUR)));
	db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(1, 1, 1, us(NOW - 2 * HOUR));
	db.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(2, 1, 4, us(NOW - 30 * HOUR));
	db.prepare("INSERT INTO message_recipients VALUES (?,?,?,?,?)").run(2, 2, "to", us(NOW - 3 * HOUR), null);
	db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(1, 1, 3, "a", 1, us(NOW - 30 * HOUR), us(NOW + HOUR), null);
	db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(2, 1, 5, "b", 1, us(NOW - 30 * HOUR), us(NOW - HOUR), null);
	db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(3, 1, 6, "c", 1, us(NOW - 30 * HOUR), us(NOW + HOUR), us(NOW - 29 * HOUR));
	db.prepare("INSERT INTO file_reservations VALUES (?,?,?,?,?,?,?,?)").run(4, 1, 7, "d", 1, us(NOW - 5 * HOUR), us(NOW - 4 * HOUR), us(NOW - 4 * HOUR));
	db.close();
	return dir;
}

test("mail: genuine sends, reads, acks and reservation grants within 24 h; last_active_ts alone never counts", () => {
	const root = mailStore(join(base, "mail-1"));
	const read = readMailLiveness(root, NOW);
	expect(read.mail.ok).toBe(true);
	if (!read.mail.ok || !read.reservations.ok) throw new Error("unreadable");
	expect(read.mail.value.get("sender")).toBe(NOW - 2 * HOUR);
	expect(read.mail.value.get("reader")).toBe(NOW - 3 * HOUR);
	expect(read.mail.value.get("touched")).toBe(NOW - 5 * HOUR);
	expect(read.mail.value.has("oldmail")).toBe(false);
	expect(read.mail.value.has("registered")).toBe(false);
	expect([...read.reservations.value]).toEqual(["holder"]);
});

test("planted: a missing store or unset root is unreadable for both mail and reservations", () => {
	const missing = readMailLiveness(join(base, "no-store"), NOW);
	expect(missing.mail.ok || missing.reservations.ok).toBe(false);
	const unset = readMailLiveness(null, NOW);
	expect(unset.mail.ok || unset.reservations.ok).toBe(false);
});

test("storage root: env first, then the Agent Mail config.env keys, else null", () => {
	const home = mkdtempSync(join(base, "home-"));
	expect(agentMailStorageRoot({ AGENT_MAIL_STORAGE_ROOT: "/env/root" }, home)).toBe("/env/root");
	expect(agentMailStorageRoot({}, home)).toBeNull();
	mkdirSync(join(home, ".config", "mcp-agent-mail"), { recursive: true });
	writeFileSync(join(home, ".config", "mcp-agent-mail", "config.env"), "HTTP_PORT=1\nSTORAGE_ROOT=~/store-b\nAGENT_MAIL_STORAGE_ROOT=\"~/store-a\"\n");
	expect(agentMailStorageRoot({}, home)).toBe(join(home, "store-a"));
	writeFileSync(join(home, ".config", "mcp-agent-mail", "config.env"), "# STORAGE_ROOT=/commented\nexport STORAGE_ROOT=/plain/root\n");
	expect(agentMailStorageRoot({}, home)).toBe("/plain/root");
});

test("sources: one probe reads seats, mail and reservations together", () => {
	const home = mkdtempSync(join(base, "home-"));
	const folder = join(home, ".config", "agent-mail", "identity", "cccccccccccc");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "tern-11"), "SeatOne\n");
	const root = mailStore(join(base, "mail-2"));
	const read = readLivenessSources({
		home, env: { AGENT_MAIL_STORAGE_ROOT: root },
		run: argv => argv[0] === "tern" ? { code: 0, stdout: TERN, stderr: "" } : { code: 1, stdout: "", stderr: "no server running" },
	}, NOW);
	expect(holderVerdict("SeatOne", read, NOW).liveness).toBe("LIVE");
	expect(holderVerdict("Holder", read, NOW).liveness).toBe("LIVE");
	expect(holderVerdict("Expired", read, NOW).liveness).toBe("DEAD");
	const noTern = readLivenessSources({
		home, env: { AGENT_MAIL_STORAGE_ROOT: root },
		run: () => ({ code: null, stdout: "", stderr: "spawn tern ENOENT" }),
	}, NOW);
	expect(holderVerdict("Expired", noTern, NOW).liveness).toBe("UNKNOWN");
});
