import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildTernProofKey, proveTernCliSend, proveTernEntry, readComposerRecord, routeSendTarget, COMPOSER_RECORD_MAX_AGE_MS } from "../../src/send.ts";
import type { ComposerVerdict } from "../../src/send.ts";
import { parseSessionView, readSessionTail, SESSION_HEAD_BYTES, SESSION_TAIL_WINDOW_BYTES } from "../../src/plane-tern.ts";
import type { SessionProofRange } from "../../src/plane-tern.ts";
import type { SessionJournalView, TernObserverIo } from "../../src/plane-tern.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { ownerIdentity } from "../../src/kitlib/owner.ts";

/** TERNADDR1 (ompkit-fixjo): a Tern seat with no window key admits by `tern send BLOCK paste` + `keys Enter`. */

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratchTmp = ownedTmp("send-tern-paste", { root: scratchRoot });
const scratch = scratchTmp.path;
afterAll(() => scratchTmp.cleanup());

const noWait = async (_ms: number) => {};
const EMPTY_PREFIXES: ReadonlySet<string> = new Set<string>();

function freshDir(prefix: string): string {
	const dir = join(scratch, `${prefix}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Each test gets its own parent, so the sibling tern-pending ledger never leaks between tests. */
function dropDir(): string {
	const dir = join(freshDir("case"), "send-drop");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function idleJournal(repo: string, uuid: string): string {
	return [
		JSON.stringify({ type: "session", id: uuid, cwd: repo, version: 3 }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } }),
		"",
	].join("\n");
}

interface Taken { runs: string[][]; luaDispatches: number; pastes: number; enters: number }

/**
 * Owned Tern surface: canned inspect/process/ps/am answers. `send N paste T` holds T in a fake composer and
 * `send N keys Enter` journals it as a USER entry, as OMP does; `ctl carly lua` journals its decoded payload.
 */
interface TernFixture { io: TernObserverIo; taken: Taken; repo: string; sessionFile: string; tailReads: number[] }

const OVER_CAP = 64 * 1024 * 1024;

/** ~70 MiB of history, then a settled turn, the dispose exit omp writes before cancelling its jobs, and a leaf
 * pin (omp 18.10.3 writes none), so the bounded tail is anchored with a proven leaf (ompkit-774u.1.3). */
function overCapJournal(repo: string, uuid: string): string {
	const filler = "x".repeat(64 * 1024);
	const lines = [JSON.stringify({ type: "session", id: uuid, cwd: repo, version: 3 }),
		JSON.stringify({ type: "message", id: "m0", parentId: null, message: { role: "user", content: "first" } })];
	let parent = "m0";
	for (let n = 1; n <= 1_120; n++) {
		lines.push(JSON.stringify({ type: "custom", id: `pad-${n}`, parentId: parent, customType: "memory_recall", data: filler }));
		parent = `pad-${n}`;
	}
	lines.push(JSON.stringify({ type: "message", id: "m1", parentId: parent, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } }),
		JSON.stringify({ type: "custom", id: "exit-1", parentId: "m2", customType: "session_exit",
			data: { reason: "dispose", kind: "normal", recordedAt: "2026-10-20T02:00:00.000Z" } }),
		JSON.stringify({ type: "model_usage", id: "usage-1", parentId: "exit-1", activeLeafId: "exit-1" }));
	return lines.join("\n") + "\n";
}

function ternFixture(opts: { pasteCode?: number; overCap?: boolean; boundedReader?: boolean } = {}): TernFixture {
	const paneId = 5;
	const repo = freshDir("repo");
	const uuid = `sess-${Math.random().toString(36).slice(2)}`;
	const sessionFile = join(scratch, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	let journal = opts.overCap ? overCapJournal(repo, uuid) : idleJournal(repo, uuid);
	const leafId = opts.overCap ? "exit-1" : "m2";
	writeFileSync(sessionFile, journal);
	const taken: Taken = { runs: [], luaDispatches: 0, pastes: 0, enters: 0 };
	const tailReads: number[] = [];
	let composer = "";
	const userEntry = (content: string) => {
		const entry = JSON.stringify({ type: "message", id: `m-live-${taken.runs.length}`, parentId: leafId, message: { role: "user", content } }) + "\n";
		journal += entry;
		appendFileSync(sessionFile, entry);
	};
	const inspect = JSON.stringify({ sessions: [{ id: 7, name: "omp-test", tabs: [{ blocks: [{ id: paneId }] }] }],
		panes: [{ pane: paneId, cwd: repo, working: false, exited: null, omp_session_file: sessionFile }] });
	const proc = JSON.stringify({ pane: paneId, foreground: { argv: ["omp"], pid: 1234, cwd: repo, name: "omp" } });
	const io: TernObserverIo = {
		run(argv) {
			taken.runs.push([...argv]);
			if (argv.includes("carly") && argv.includes("lua")) {
				taken.luaDispatches++;
				const groups = [...(argv[argv.length - 1] ?? "").matchAll(/string\.char\(([\d,]+)\)/g)].map((m) => m[1]!);
				userEntry(Buffer.from(groups[groups.length - 1]!.split(",").map(Number)).toString("utf8"));
				return { code: 0, out: "" };
			}
			const send = argv.indexOf("send");
			if (send >= 0 && argv[send + 2] === "paste") {
				taken.pastes++;
				if ((opts.pasteCode ?? 0) !== 0) return { code: opts.pasteCode!, out: "" };
				composer += argv[send + 3] ?? "";
				return { code: 0, out: "" };
			}
			if (send >= 0 && argv[send + 2] === "keys" && argv[send + 3] === "Enter") {
				taken.enters++;
				if (composer !== "") userEntry(composer.trim());
				composer = "";
				return { code: 0, out: "" };
			}
			if (argv[0] === "/bin/ps") return { code: 0, out: "Mon Oct 20 02:00:00 2026 omp AGENT_NAME=FixtureSeat" };
			if (argv[0] === "am") return { code: 0, out: JSON.stringify({ agent_name: "FixtureSeat", pane_id: `tern:${paneId}`, project_key: resolve(repo), binding: "verified-live" }) };
			if (argv.includes("process")) return { code: 0, out: proc };
			if (argv.includes("inspect")) return { code: 0, out: inspect };
			if (argv.includes("capture")) return { code: 0, out: "" };
			return { code: 1, out: "" };
		},
		// Whole reads stop at the 64 MiB parse cap, as defaultTernIo's do; past it only the bounded reader sees the file.
		readSessionFile(path) { return path === sessionFile && Buffer.byteLength(journal) <= OVER_CAP ? journal : null; },
		...(opts.boundedReader === false ? {} : {
			readSessionTail(path: string, proof?: SessionProofRange): SessionJournalView | null {
				const view = path === sessionFile ? readSessionTail(path, undefined, proof) : null;
				if (view === null || view.fileSize <= OVER_CAP) return null;
				tailReads.push(view.head.length + view.tail.length);
				return view;
			},
		}),
		wait: noWait,
	};
	return { io, taken, repo, sessionFile, tailReads };
}

/** Plant the seat's kit-composer-state record exactly as extensions/kit-composer-state.ts writes it. */
function plantComposer(sessionFile: string, rec: Partial<{ empty: boolean; at: number; pid: number; process_start: string; session_file: string; schema: number }> = {}): string {
	const dir = freshDir("composer");
	const real = realpathSync(sessionFile);
	const key = createHash("sha1").update(real).digest("hex").slice(0, 16);
	const identity = ownerIdentity(process.pid);
	if (identity === null) throw new Error("test process incarnation is unavailable");
	writeFileSync(join(dir, `${key}.json`), JSON.stringify({ schema: 1, session_file: real, pid: identity.pid, process_start: identity.process_start, at: Date.now(), empty: true, idle: true, ...rec }));
	return dir;
}

function send(fx: TernFixture, dir: string, extra: { windowKey?: string; composer?: (sessionFile: string) => ComposerVerdict } = {}) {
	return proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update", dropDir: dir, cwd: fx.repo,
		knownPrefixes: EMPTY_PREFIXES, env: { AGENT_MAIL_PROJECT: fx.repo }, pollMs: 1, deadlineMs: 20, wait: noWait, io: fx.io, ...extra });
}

const effects = (taken: Taken) => taken.luaDispatches + taken.pastes + taken.enters;

test("AC1 TERNADDR1: no window key delivers by paste + Enter, proven by the USER journal entry", async () => {
	const fx = ternFixture();
	const composerDir = plantComposer(fx.sessionFile);
	const dir = dropDir();
	const got = await send(fx, dir, { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
	expect(got.status).toBe("OK");
	expect(got.code).toBe("PROVEN");
	expect(got.sends).toBe(1);
	expect(got.detail).toContain("via paste+Enter");
	expect(got.offset).toBeGreaterThan(0);
	expect(fx.taken.luaDispatches).toBe(0);
	expect(fx.taken.pastes).toBe(1);
	expect(fx.taken.enters).toBe(1);
	const paste = fx.taken.runs.find((argv) => argv.includes("paste"))!;
	expect(paste.slice(1)).toEqual(["send", "5", "paste", `[from an unnamed agent or kit service via omp-kit send]\nstatus update\n[${got.marker}]`]);
	expect(fx.taken.runs.some((argv) => argv.includes("--window") || argv.includes("ctl"))).toBe(false);
	// Enter comes only after the paste.
	expect(fx.taken.runs.findIndex((argv) => argv.includes("Enter"))).toBeGreaterThan(fx.taken.runs.indexOf(paste));
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
});

test("control: a keyed seat keeps the one ctl turn, never pastes and never consults the composer record", async () => {
	const fx = ternFixture();
	let consulted = 0;
	const got = await send(fx, dropDir(), { windowKey: "/run/tern-fixture.sock", composer: () => { consulted++; return { state: "DRAFT" }; } });
	expect(got.status).toBe("OK");
	expect(fx.taken.luaDispatches).toBe(1);
	expect(fx.taken.pastes + fx.taken.enters).toBe(0);
	expect(consulted).toBe(0);
	expect(got.detail).not.toContain("paste");
});

test("control: a tmux pane still routes to the tmux (ntm) path and the Tern sender refuses it with zero io", async () => {
	expect(routeSendTarget("%54")).toEqual({ route: "tmux" });
	const fx = ternFixture();
	const got = await proveTernCliSend({ session: "omp-test", pane: "%54", message: "status update", dropDir: dropDir(),
		knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 20, wait: noWait, io: fx.io });
	expect(got.code).toBe("TERN_ROUTE_MISMATCH");
	expect(fx.taken.runs).toEqual([]);
});

test("planted: a composer holding a draft refuses TERN_COMPOSER_BUSY with zero sends and no drop or pending file", async () => {
	const fx = ternFixture();
	const composerDir = plantComposer(fx.sessionFile, { empty: false });
	const dir = dropDir();
	const got = await send(fx, dir, { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
	expect(got.status).toBe("REFUSED");
	expect(got.code).toBe("TERN_COMPOSER_BUSY");
	expect(got.sends).toBe(0);
	expect(effects(fx.taken)).toBe(0);
	expect(got.drop_path).toBeNull();
	expect(readdirSync(dir)).toEqual([]);
	const pending = join(dir, "..", "tern-pending");
	expect(existsSync(pending) ? readdirSync(pending).filter((n) => n.endsWith(".json")) : []).toEqual([]);
});

test("planted: a missing, stale, dead-writer or foreign composer record is UNKNOWN and never pastes blind", async () => {
	const cases: Array<[string, (sessionFile: string) => string]> = [
		["missing", () => freshDir("composer-empty")],
		["stale", (sf) => plantComposer(sf, { at: Date.now() - COMPOSER_RECORD_MAX_AGE_MS - 1_000 })],
		["dead writer", (sf) => plantComposer(sf, { pid: 2 ** 22 + 12345 })],
		["foreign session", (sf) => plantComposer(sf, { session_file: "/elsewhere.jsonl" })],
	];
	for (const [label, plant] of cases) {
		const fx = ternFixture();
		const composerDir = plant(fx.sessionFile);
		const dir = dropDir();
		const got = await send(fx, dir, { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
		expect([label, got.status, got.code]).toEqual([label, "REFUSED", "TERN_COMPOSER_UNKNOWN"]);
		expect(got.sends).toBe(0);
		expect(effects(fx.taken)).toBe(0);
		expect(got.drop_path).toBeNull();
	}
});

test("planted: a reused composer writer PID is UNKNOWN", () => {
	const fx = ternFixture();
	const composerDir = plantComposer(fx.sessionFile, { process_start: "Mon Jan 1 00:00:00 2001" });
	expect(readComposerRecord(fx.sessionFile, { dir: composerDir }).state).toBe("UNKNOWN");
});

test("planted: a failed paste never presses Enter (an empty submit aborts a streaming turn); unproven stays pending", async () => {
	const fx = ternFixture({ pasteCode: 1 });
	const composerDir = plantComposer(fx.sessionFile);
	const got = await send(fx, dropDir(), { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
	expect(fx.taken.pastes).toBe(1);
	expect(fx.taken.enters).toBe(0);
	expect(got.status).toBe("PENDING_CONSUME");
	expect(got.code).toBe("SEND_AMBIGUOUS");
	expect(got.drop_path).not.toBeNull();
});

test("SESSIONCAP1: a 70 MiB seat is observed, admitted and proven from bounded tail reads only", async () => {
	const fx = ternFixture({ overCap: true });
	const composerDir = plantComposer(fx.sessionFile);
	const dir = dropDir();
	const got = await send(fx, dir, { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
	expect(got.status).toBe("OK");
	expect(got.code).toBe("PROVEN");
	expect(got.sends).toBe(1);
	expect(got.offset).toBeGreaterThan(OVER_CAP);
	expect(fx.taken.pastes).toBe(1);
	expect(fx.taken.enters).toBe(1);
	// Observe (bracketed), eligibility, pre-effect re-read and proof: every read is bounded.
	expect(fx.tailReads.length).toBeGreaterThanOrEqual(4);
	for (const bytes of fx.tailReads) expect(bytes).toBeLessThanOrEqual(SESSION_TAIL_WINDOW_BYTES + SESSION_HEAD_BYTES);
	expect(readdirSync(dir)).toEqual([]);
});

test("control: the same 70 MiB seat without the bounded reader is never typed into", async () => {
	const fx = ternFixture({ overCap: true, boundedReader: false });
	const composerDir = plantComposer(fx.sessionFile);
	const got = await send(fx, dropDir(), { composer: (sf) => readComposerRecord(sf, { dir: composerDir }) });
	expect(got.sends).toBe(0);
	expect(effects(fx.taken)).toBe(0);
	expect(got.detail).toContain("SESSION_FILE_UNAVAILABLE");
});

test("SESSIONCAP1 proof: past the cap the pre-send pin is the cursor's last bytes plus the inode, so a replaced file never proves", () => {
	const repo = freshDir("repo");
	const path = join(scratch, `session-pin-${Math.random().toString(36).slice(2)}.jsonl`);
	const before = overCapJournal(repo, "sess-pin");
	writeFileSync(path, before);
	const view = readSessionTail(path)!;
	const journal = parseSessionView(view);
	expect(journal).toMatchObject({ status: "KNOWN", leafId: "exit-1", oracleBusy: false });
	if (journal.status !== "KNOWN") return;
	const key = buildTernProofKey(view, journal, { kind: "message", payload: "hi\n[kit-send-pin]", marker: "kit-send-pin", objective: "" });
	expect(key.prefixStart).toBe(key.cursorBytes - 64 * 1024);
	expect(key.fileIdentity).toBe(view.identity);
	const entry = JSON.stringify({ type: "message", id: "m-live", parentId: "exit-1", message: { role: "user", content: "hi\n[kit-send-pin]" } }) + "\n";
	// Rotated: byte-identical content plus the entry, renamed over the path as a new inode.
	const rotated = `${path}.rotated`;
	writeFileSync(rotated, before + entry);
	renameSync(rotated, path);
	expect(proveTernEntry(readSessionTail(path)!, key)).toEqual({ status: "UNCERTAIN", reason: "JOURNAL_REPLACED" });
	// Control: the same entry appended to the pinned inode proves at its offset.
	writeFileSync(path, before);
	const pinned = readSessionTail(path)!;
	const inPlace = buildTernProofKey(pinned, journal, { kind: "message", payload: "hi\n[kit-send-pin]", marker: "kit-send-pin", objective: "" });
	appendFileSync(path, entry);
	expect(proveTernEntry(readSessionTail(path)!, inPlace)).toEqual({ status: "PROVEN", offset: Buffer.byteLength(before),
		entryId: "m-live", steering: false });
	// A rewrite inside the pinned bytes on the same inode is a changed prefix.
	const tampered = Buffer.from(before + entry);
	tampered[Buffer.byteLength(before) - 10] = 0x20;
	writeFileSync(path, tampered);
	expect(proveTernEntry(readSessionTail(path)!, inPlace)).toMatchObject({ status: "UNCERTAIN" });
});

/** ~9 MiB of chained records after `parent`, enough to push a key's pinned range out of the 8 MiB tail. */
function growth(parent: string, tag: string): string {
	const filler = "y".repeat(64 * 1024);
	const lines: string[] = [];
	for (let n = 1; n <= 144; n++) {
		lines.push(JSON.stringify({ type: "custom", id: `${tag}-${n}`, parentId: parent, customType: "memory_recall", data: filler }));
		parent = `${tag}-${n}`;
	}
	return lines.join("\n") + "\n";
}

test("SESSIONCAP1 proof: a key whose pinned range left the 8 MiB tail still proves from a bounded range read", () => {
	const repo = freshDir("repo");
	const path = join(scratch, `session-grow-${Math.random().toString(36).slice(2)}.jsonl`);
	const before = overCapJournal(repo, "sess-grow");
	writeFileSync(path, before);
	const view = readSessionTail(path)!;
	const journal = parseSessionView(view);
	if (journal.status !== "KNOWN") throw new Error("fixture not KNOWN");
	const key = buildTernProofKey(view, journal, { kind: "message", payload: "hi\n[kit-send-grow]", marker: "kit-send-grow", objective: "" });
	const range = { start: key.prefixStart, cursor: key.cursorBytes };
	appendFileSync(path, JSON.stringify({ type: "message", id: "m-live", parentId: "exit-1", message: { role: "user", content: "hi\n[kit-send-grow]" } }) + "\n");
	const proven = { status: "PROVEN", offset: Buffer.byteLength(before), entryId: "m-live", steering: false };
	expect(proveTernEntry(readSessionTail(path, undefined, range)!, key)).toEqual(proven);
	appendFileSync(path, growth("m-live", "late"));
	const grown = readSessionTail(path, undefined, range)!;
	expect(grown.tailStart).toBeGreaterThan(key.cursorBytes);
	expect(proveTernEntry(grown, key)).toEqual(proven);
	// The bytes read stay bounded: the key's range plus one window after its cursor.
	expect(grown.proofRange!.bytes.length).toBeLessThanOrEqual(key.cursorBytes - key.prefixStart + SESSION_TAIL_WINDOW_BYTES);
	// Control: a same-size rewrite inside the pinned range never proves.
	const tampered = readFileSync(path);
	tampered[key.cursorBytes - 10] = 0x20;
	writeFileSync(path, tampered);
	expect(proveTernEntry(readSessionTail(path, undefined, range)!, key)).toEqual({ status: "UNCERTAIN", reason: "JOURNAL_PREFIX_CHANGED" });
	// Control: a replaced file (new inode, original bytes) is JOURNAL_REPLACED.
	tampered[key.cursorBytes - 10] = Buffer.from(before)[key.cursorBytes - 10]!;
	writeFileSync(`${path}.new`, tampered);
	renameSync(`${path}.new`, path);
	expect(proveTernEntry(readSessionTail(path, undefined, range)!, key)).toEqual({ status: "UNCERTAIN", reason: "JOURNAL_REPLACED" });
});

test("SESSIONCAP1 proof: a whole-read key of a small file still proves after the file grows past the cap", () => {
	const repo = freshDir("repo");
	const path = join(scratch, `session-small-${Math.random().toString(36).slice(2)}.jsonl`);
	const small = [JSON.stringify({ type: "session", id: "sess-small", cwd: repo, version: 3 }),
		JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "prior" } }),
		JSON.stringify({ type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "done", stopReason: "stop" } })].join("\n") + "\n";
	writeFileSync(path, small);
	const key = buildTernProofKey(small, { sessionId: "sess-small", leafId: "m2" }, { kind: "message", payload: "hi\n[kit-send-small]", marker: "kit-send-small", objective: "" });
	const range = { start: key.prefixStart, cursor: key.cursorBytes };
	appendFileSync(path, JSON.stringify({ type: "message", id: "m-live", parentId: "m2", message: { role: "user", content: "hi\n[kit-send-small]" } }) + "\n");
	appendFileSync(path, growth("m-live", "a") + growth("a-144", "b") + growth("b-144", "c") + growth("c-144", "d")
		+ growth("d-144", "e") + growth("e-144", "f") + growth("f-144", "g") + growth("g-144", "h"));
	const view = readSessionTail(path, undefined, range)!;
	expect(view.fileSize).toBeGreaterThan(OVER_CAP);
	expect(proveTernEntry(view, key)).toEqual({ status: "PROVEN", offset: Buffer.byteLength(small), entryId: "m-live", steering: false });
	// Control: without the range the same view cannot prove and says so.
	expect(proveTernEntry(readSessionTail(path)!, key)).toEqual({ status: "UNCERTAIN", reason: "JOURNAL_PREFIX_BEYOND_WINDOW" });
});
