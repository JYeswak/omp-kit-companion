import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proveTernCliSend, readComposerRecord, routeSendTarget, COMPOSER_RECORD_MAX_AGE_MS } from "../../src/send.ts";
import type { ComposerVerdict } from "../../src/send.ts";
import type { TernObserverIo } from "../../src/plane-tern.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

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
interface TernFixture { io: TernObserverIo; taken: Taken; repo: string; sessionFile: string }

function ternFixture(opts: { pasteCode?: number } = {}): TernFixture {
	const paneId = 5;
	const repo = freshDir("repo");
	const uuid = `sess-${Math.random().toString(36).slice(2)}`;
	const sessionFile = join(scratch, `session-${Math.random().toString(36).slice(2)}.jsonl`);
	let journal = idleJournal(repo, uuid);
	writeFileSync(sessionFile, journal);
	const taken: Taken = { runs: [], luaDispatches: 0, pastes: 0, enters: 0 };
	let composer = "";
	const userEntry = (content: string) => {
		journal += JSON.stringify({ type: "message", id: `m-live-${taken.runs.length}`, parentId: "m2", message: { role: "user", content } }) + "\n";
		writeFileSync(sessionFile, journal);
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
			if (argv[0] === "/bin/ps") return { code: 0, out: "Mon Oct 20 02:00:00 2026 omp" };
			if (argv[0] === "am") return { code: 0, out: JSON.stringify({ agent_name: "FixtureSeat", pane_id: `tern:${paneId}`, project_key: resolve(repo), binding: "verified-live" }) };
			if (argv.includes("process")) return { code: 0, out: proc };
			if (argv.includes("inspect")) return { code: 0, out: inspect };
			if (argv.includes("capture")) return { code: 0, out: "" };
			return { code: 1, out: "" };
		},
		readSessionFile(path) { return path === sessionFile ? journal : null; },
		wait: noWait,
	};
	return { io, taken, repo, sessionFile };
}

/** Plant the seat's kit-composer-state record exactly as extensions/kit-composer-state.ts writes it. */
function plantComposer(sessionFile: string, rec: Partial<{ empty: boolean; at: number; pid: number; session_file: string; schema: number }> = {}): string {
	const dir = freshDir("composer");
	const real = realpathSync(sessionFile);
	const key = createHash("sha1").update(real).digest("hex").slice(0, 16);
	writeFileSync(join(dir, `${key}.json`), JSON.stringify({ schema: 1, session_file: real, pid: process.pid, at: Date.now(), empty: true, idle: true, ...rec }));
	return dir;
}

function send(fx: TernFixture, dir: string, extra: { windowKey?: string; composer?: (sessionFile: string) => ComposerVerdict } = {}) {
	return proveTernCliSend({ session: "omp-test", pane: "tern:5", message: "status update", dropDir: dir, cwd: fx.repo,
		knownPrefixes: EMPTY_PREFIXES, pollMs: 1, deadlineMs: 20, wait: noWait, io: fx.io, ...extra });
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
	expect(paste.slice(1)).toEqual(["send", "5", "paste", `status update\n[${got.marker}]`]);
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
