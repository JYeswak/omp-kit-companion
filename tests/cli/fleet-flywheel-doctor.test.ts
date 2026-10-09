import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busyElapsedMs, flushPending, inspectCommunicationPurgatory, inspectDirectorDoingWork, inspectStuckPending, liveFleetIo, parseComposer, parseQueuedBand, tmuxSocketArgs, type FleetIo, type MailSends } from "../../src/fleet-flywheel-doctor.ts";

const NOW = Date.parse("2026-10-09T18:00:00Z");
const MIN = 60_000;
const BUSY = "output\n⠧ Working (12s)\n";
const IDLE = "output\n> \n";

/** `then` replaces the pane text once keys are sent to it (what the pane shows after the remedy). */
type FakePane = { index: number; window?: number; omp: boolean; text: string; idleMin?: number; then?: string };
type SentKeys = { pane: string; keys: string[] }[];
function directorIo(panes: FakePane[], session = "cfsios", sent: SentKeys = []): FleetIo {
	const listing = panes.map((pane, n) => `${session}\t${pane.window ?? 0}\t${pane.index}\t${1000 + n}\t%${100 + n}`).join("\n");
	const find = (target: string) => panes.find((candidate, n) => target === `%${100 + n}` || target === `${session}:${candidate.window ?? 0}.${candidate.index}`);
	return {
		nowMs: () => NOW,
		tmux: (args) => {
			if (args[0] === "list-panes") return listing;
			const pane = find(args[0] === "send-keys" ? args[2]! : args[args.length - 1]!);
			if (!pane) return null;
			if (args[0] === "send-keys") {
				sent.push({ pane: args[2]!, keys: args.slice(3) });
				if (pane.then !== undefined) pane.text = pane.then;
				return "";
			}
			return pane.text;
		},
		processes: () => panes.flatMap((pane, n) => pane.omp ? [{ pid: 2000 + n, ppid: 1000 + n, args: "bun /Users/x/.bun/bin/omp --profile claude" }] : [{ pid: 2000 + n, ppid: 1000 + n, args: "vim notes.txt" }]),
		openSessionFiles: (pids) => new Map(pids.map((pid) => [pid, [`/Users/x/.omp/profiles/claude/agent/sessions/-repo/${pid}.jsonl`]])),
		mtimeMs: (path) => {
			const pane = panes[Number(/(\d+)\.jsonl$/.exec(path)![1]) - 2000]!;
			return pane.idleMin === undefined ? null : NOW - pane.idleMin * MIN;
		},
		sleep: () => {},
		mailSends: () => [],
		readFile: () => null,
		git: () => null,
	};
}
const statusOf = (io: FleetIo) => inspectDirectorDoingWork(io).map((row) => row.status);

test("busy director with every worker idle 25 min fires DIRECTOR_DOING_WORK", () => {
	const rows = inspectDirectorDoingWork(directorIo([
		{ index: 0, omp: false, text: IDLE },
		{ index: 1, omp: true, text: BUSY, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 25 },
		{ index: 3, omp: true, text: IDLE, idleMin: 31 },
	]));
	expect(rows).toHaveLength(1);
	expect(rows[0]!.component).toBe("DIRECTOR_DOING_WORK");
	expect(rows[0]!.status).toBe("DEGRADED");
	expect(rows[0]!.reason).toStartWith("WARN cfsios: director cfsios:0.1 is busy while all 2 worker pane(s) have been idle >= 25 min");
	expect(rows[0]!.evidence).toMatchObject({ level: "WARN", session: "cfsios" });
});

test("one busy worker keeps DIRECTOR_DOING_WORK quiet", () => {
	expect(statusOf(directorIo([
		{ index: 1, omp: true, text: BUSY, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 25 },
		{ index: 3, omp: true, text: BUSY, idleMin: 25 },
	]))).toEqual(["OK"]);
});

test("workers idle only 10 min keep DIRECTOR_DOING_WORK quiet", () => {
	expect(statusOf(directorIo([
		{ index: 1, omp: true, text: BUSY, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 10 },
		{ index: 3, omp: true, text: IDLE, idleMin: 10 },
	]))).toEqual(["OK"]);
});

test("session without an x.1 pane is quiet", () => {
	expect(statusOf(directorIo([
		{ index: 0, omp: true, text: BUSY, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 25 },
		{ index: 1, window: 1, omp: true, text: BUSY, idleMin: 0 },
	]))).toEqual(["OK"]);
});

test("idle director is quiet and an unmeasurable worker idle is not counted as idle", () => {
	expect(statusOf(directorIo([
		{ index: 1, omp: true, text: IDLE, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 25 },
	]))).toEqual(["OK"]);
	expect(statusOf(directorIo([
		{ index: 1, omp: true, text: BUSY, idleMin: 0 },
		{ index: 2, omp: true, text: IDLE, idleMin: 25 },
		{ index: 3, omp: true, text: IDLE },
	]))).toEqual(["OK"]);
});

test("no tmux server is UNVERIFIED, not OK", () => {
	const io = { ...directorIo([]), tmux: () => null };
	expect(statusOf(io)).toEqual(["UNVERIFIED"]);
});

const REPO = "/Users/x/Developer/cfs";
type PurgatoryCase = { sends: number; commits: number; claimed: boolean; attributed: boolean; closes?: number };
function purgatoryIo(input: PurgatoryCase): FleetIo {
	const issues = [
		{ id: "cfs-1", status: input.claimed ? "in_progress" : "open", assignee: input.claimed ? "BlueFox" : null },
		...Array.from({ length: input.closes ?? 0 }, (_, n) => ({ id: `cfs-c${n}`, status: "closed", assignee: "BlueFox", closed_at: new Date(NOW - 30 * MIN).toISOString() })),
	].map((issue) => JSON.stringify(issue)).join("\n");
	const window = Array.from({ length: input.commits }, (_, n) => `${(NOW - (10 + n) * MIN) / 1000}\x1fJosh\x1fAgent: BlueFox\x1d`);
	const old = input.attributed ? [`${(NOW - 3 * 86_400_000) / 1000}\x1fJosh\x1fAgent: BlueFox\x1d`] : [`${(NOW - 3 * 86_400_000) / 1000}\x1fJosh\x1f\x1d`];
	return {
		...directorIo([]),
		mailSends: (sinceUs) => { expect(sinceUs).toBe((NOW - 2 * 60 * MIN) * 1000); return [{ repo: REPO, seat: "BlueFox", count: input.sends }] satisfies MailSends[]; },
		readFile: (path) => path === join(REPO, ".beads", "issues.jsonl") ? issues : null,
		git: (repo) => repo === REPO ? [...window, ...old].join("\n") : null,
	};
}
const purgatory = (input: PurgatoryCase) => inspectCommunicationPurgatory(purgatoryIo(input));

test("9 sends, 0 commits, claimed bead fires COMMUNICATION_PURGATORY", () => {
	const rows = purgatory({ sends: 9, commits: 0, claimed: true, attributed: true });
	expect(rows).toHaveLength(1);
	expect(rows[0]!.status).toBe("DEGRADED");
	expect(rows[0]!.reason).toBe(`WARN BlueFox in ${REPO}: 9 Agent Mail sends in 2 h against 0 commit(s) and 0 bead close(s) while holding cfs-1`);
});

test("9 sends against 3 attributed commits is quiet", () => {
	expect(purgatory({ sends: 9, commits: 3, claimed: true, attributed: true }).map((row) => row.status)).toEqual(["OK"]);
});

test("bead closes count as landed work", () => {
	expect(purgatory({ sends: 9, commits: 1, closes: 2, claimed: true, attributed: true }).map((row) => row.status)).toEqual(["OK"]);
	expect(purgatory({ sends: 10, commits: 1, closes: 2, claimed: true, attributed: true }).map((row) => row.status)).toEqual(["DEGRADED"]);
});

test("no claimed bead is quiet", () => {
	expect(purgatory({ sends: 9, commits: 0, claimed: false, attributed: true }).map((row) => row.status)).toEqual(["OK"]);
});

test("fewer than 6 sends is quiet", () => {
	expect(purgatory({ sends: 5, commits: 0, claimed: true, attributed: true }).map((row) => row.status)).toEqual(["OK"]);
});

test("unknown seat-to-commit mapping is UNKNOWN, not WARN", () => {
	const rows = purgatory({ sends: 9, commits: 0, claimed: true, attributed: false });
	expect(rows).toHaveLength(1);
	expect(rows[0]!.status).toBe("UNVERIFIED");
	expect(rows[0]!.reason).toStartWith("UNKNOWN BlueFox");
	expect(rows[0]!.evidence).toMatchObject({ level: "UNKNOWN", commits_2h: null });
});

test("missing Agent Mail store is UNVERIFIED", () => {
	const io = { ...purgatoryIo({ sends: 9, commits: 0, claimed: true, attributed: true }), mailSends: () => "AGENT_MAIL_STORAGE_ROOT is unset" };
	expect(inspectCommunicationPurgatory(io).map((row) => row.status)).toEqual(["UNVERIFIED"]);
});

test("live io reads Agent Mail sqlite read-only and git trailers from a real repo", () => {
	const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fleet-doctor-"));
	try {
		const db = new Database(join(root, "storage.sqlite3"));
		db.run("CREATE TABLE projects (id INTEGER PRIMARY KEY, slug TEXT, human_key TEXT, created_at INTEGER)");
		db.run("CREATE TABLE agents (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT)");
		db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, project_id INTEGER, sender_id INTEGER, created_ts INTEGER)");
		db.run("INSERT INTO projects VALUES (1, 'r', '/repo', 0)");
		db.run("INSERT INTO agents VALUES (1, 1, 'BlueFox'), (2, 1, 'RedOwl')");
		const nowUs = Date.now() * 1000;
		for (let n = 0; n < 7; n++) db.run("INSERT INTO messages (project_id, sender_id, created_ts) VALUES (1, 1, ?)", [nowUs - n * 1_000_000]);
		db.run("INSERT INTO messages (project_id, sender_id, created_ts) VALUES (1, 2, ?)", [nowUs - 3 * 3_600_000_000]);
		db.close();
		const io = liveFleetIo({ ...process.env, AGENT_MAIL_STORAGE_ROOT: root });
		expect(io.mailSends(nowUs - 7_200_000_000)).toEqual([{ repo: "/repo", seat: "BlueFox", count: 7 }]);
		expect(liveFleetIo({ ...process.env, AGENT_MAIL_STORAGE_ROOT: "" }).mailSends(0)).toBe("AGENT_MAIL_STORAGE_ROOT is unset");

		const repo = join(root, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => expect(spawnSync("git", ["-C", repo, "-c", "user.name=Josh", "-c", "user.email=j@x", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, ...args], { encoding: "utf8" }).status).toBe(0);
		git("init", "-q");
		writeFileSync(join(repo, "a"), "a");
		git("add", "a");
		git("commit", "-q", "-m", "work\n\nAgent: BlueFox");
		mkdirSync(join(repo, ".beads"));
		writeFileSync(join(repo, ".beads", "issues.jsonl"), `${JSON.stringify({ id: "r-1", status: "in_progress", assignee: "BlueFox" })}\n`);
		const rows = inspectCommunicationPurgatory({ ...io, mailSends: () => [{ repo, seat: "BlueFox", count: 7 }] });
		expect(rows.map((row) => row.reason)).toEqual([`WARN BlueFox in ${repo}: 7 Agent Mail sends in 2 h against 1 commit(s) and 0 bead close(s) while holding r-1`]);
		const unattributed = inspectCommunicationPurgatory({ ...io, mailSends: () => [{ repo, seat: "GreenElk", count: 7 }] });
		expect(unattributed.map((row) => row.status)).toEqual(["OK"]);
		writeFileSync(join(repo, ".beads", "issues.jsonl"), `${JSON.stringify({ id: "r-1", status: "in_progress", assignee: "GreenElk" })}\n`);
		expect(inspectCommunicationPurgatory({ ...io, mailSends: () => [{ repo, seat: "GreenElk", count: 7 }] }).map((row) => row.status)).toEqual(["UNVERIFIED"]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("tmux socket: TMUX_TMPDIR wins, then a live ~/.tmux-sockets server, else default", () => {
	const home = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fleet-sock-"));
	try {
		const socket = join(home, ".tmux-sockets", `tmux-${process.getuid?.() ?? 0}`, "default");
		expect(tmuxSocketArgs({ HOME: home }, () => true)).toEqual([]);
		mkdirSync(join(socket, ".."), { recursive: true });
		writeFileSync(socket, "");
		expect(tmuxSocketArgs({ HOME: home }, () => true)).toEqual(["-S", socket]);
		expect(tmuxSocketArgs({ HOME: home }, () => false)).toEqual([]);
		expect(tmuxSocketArgs({ HOME: home, TMUX_TMPDIR: "/elsewhere" }, () => true)).toEqual([]);
	} finally { rmSync(home, { recursive: true, force: true }); }
});

// Captured from OMP 18.8.7 panes (flushprobe %127, omp-test %110, cfsios %6, jev %18); rule lines shortened.
const RULE = "─".repeat(40);
const TOOL_BOX = ["│ 12                                       │", "│ ⟦Timeout: 300s⟧                          │", "╰──────────────────────────────────────────╯"];
const STATUS_IDLE = " π · ◔ GPT-6-Luna · 📁 …panion/var/agent-tmp/flushpending.14277 · ⑂ main *2 +391 ?160 · ◫ 15.4%/272K ⟲ · S0.00";
const statusBusy = (elapsed: string) => ` ⠼ ${elapsed} · ◔ GPT-6-Luna · 📁 …panion/var/agent-tmp/flushpending.14277 · ⑂ main *2 +391 ?160 · ◫ 15.4%/272K ⟲ · S0.00`;
const STEER_BAND = [" Steering · 1", "   1. Read-only reviewer for cfs-census-regexp-var-repair-u8gcs. Please i…", "   └ ⌥↑ to edit"];
const FOLLOW_BAND = [" After yield · 1", "   1. Reply with only the word MANGO.", "   └ ⌥↑ to edit"];
const screen = (band: string[], composer: string, status: string, extra: string[] = []) =>
	[...TOOL_BOX, ...band, ...extra, `${RULE} Run bash echo sleep loop ─`, composer, RULE, status, ""].join("\n");
const IDLE_BAND = screen(STEER_BAND, "❯", STATUS_IDLE);
const BUSY_BAND = (elapsed: string) => screen(FOLLOW_BAND, "❯", statusBusy(elapsed), ["  ⎋ Running requested loop"]);
const STARTED = screen([], "❯", statusBusy("1s"));
const DRAFT = (text: string) => screen([], `❯ ${text}`, STATUS_IDLE);
const pendingPane = (text: string, idleMin: number, then?: string): FakePane[] => [{ index: 1, omp: true, text, idleMin, ...(then === undefined ? {} : { then }) }];

test("band parser reads the real QueuedMessagesBand render and ignores look-alikes", () => {
	expect(parseQueuedBand(IDLE_BAND.split("\n"))).toMatchObject({ groups: [{ label: "Steering", count: 1 }], messages: ["Read-only reviewer for cfs-census-regexp-var-repair-u8gcs. Please i…"] });
	expect(parseQueuedBand(BUSY_BAND("15s").split("\n"))).toMatchObject({ groups: [{ label: "After yield", count: 1 }] });
	expect(parseQueuedBand([" Steering · 2", "   1. a", "   2. b", "   `- Alt+↑ to edit"])).toMatchObject({ groups: [{ label: "Steering", count: 2 }], messages: ["a", "b"] });
	expect(parseQueuedBand(" Steering·1\n   1. x\n   └ ⌥↑ to edit".split("\n"))).toBeNull();
	expect(parseQueuedBand(["   1. x", "   └ ⌥↑ to edit"])).toBeNull();
	expect(parseQueuedBand(DRAFT("hello").split("\n"))).toBeNull();
});

test("composer parser reads ❯ and box composers, not tool boxes", () => {
	expect(parseComposer(IDLE_BAND.split("\n"))).toBe("");
	expect(parseComposer(DRAFT("[kit-send-cad02693789f]").split("\n"))).toBe("[kit-send-cad02693789f]");
	expect(parseComposer(["╭── π > ⟳ GPT-6-Luna > 📁 …/jev > ⑂ main ?75 ▶──19%─────┃─272K───╮", "╰─                                                              ─╯"])).toBe("");
	expect(parseComposer(["╭── π > ⟳ GPT-6-Luna ───╮", "│ first line            │", "╰─ second line        ─╯"])).toBe("first line\nsecond line");
	expect(parseComposer(TOOL_BOX)).toBeNull();
});

test("busy elapsed comes from the status-line spinner", () => {
	expect(busyElapsedMs(STARTED.split("\n").slice(0, -1))).toBe(1000);
	expect(busyElapsedMs(["╭── ⠦ 19m > ◒ CI glm-5.3-flash > 📁 ~/Developer/modeltest ──╮", "╰─   ─╯"])).toBe(19 * MIN);
	expect(busyElapsedMs([statusBusy("1h5m")])).toBe(65 * MIN);
	expect(busyElapsedMs([STATUS_IDLE])).toBeNull();
});

test("band over an idle empty composer is STUCK_PENDING and --apply sends M-Up then Enter", () => {
	const rows = inspectStuckPending(directorIo(pendingPane(IDLE_BAND, 3)));
	expect(rows[0]).toMatchObject({ component: "STUCK_PENDING", status: "DEGRADED", evidence: { level: "WARN", target: "cfsios:0.1", pane_id: "%100", shape: "QUEUED_BAND", action: "FLUSH", preview: "Read-only reviewer for cfs-census-regexp-var-repair-u8gcs. Please i…" } });
	const planSent: SentKeys = [];
	expect(flushPending(directorIo(pendingPane(IDLE_BAND, 3, STARTED), "cfsios", planSent), false).panes.map((pane) => pane.result)).toEqual(["PLANNED"]);
	expect(planSent).toEqual([]);
	const sent: SentKeys = [];
	const report = flushPending(directorIo(pendingPane(IDLE_BAND, 3, STARTED), "cfsios", sent), true);
	expect(sent).toEqual([{ pane: "%100", keys: ["M-Up"] }, { pane: "%100", keys: ["Enter"] }]);
	expect(report).toMatchObject({ overall: "CHANGED", panes: [{ result: "STARTED", keys_sent: ["M-Up", "Enter"] }] });
});

test("no spinner after the flush is STILL_STUCK", () => {
	const sent: SentKeys = [];
	const report = flushPending(directorIo(pendingPane(IDLE_BAND, 3, DRAFT("Read-only reviewer")), "cfsios", sent), true);
	expect(sent.flatMap((entry) => entry.keys)).toEqual(["M-Up", "Enter"]);
	expect(report).toMatchObject({ overall: "FINDINGS", panes: [{ result: "STILL_STUCK" }] });
});

test("band while busy is quiet; band while busy 5 min is STALE_STEER and gets no keys", () => {
	expect(inspectStuckPending(directorIo(pendingPane(BUSY_BAND("15s"), 3))).map((row) => [row.component, row.status])).toEqual([["STUCK_PENDING", "OK"], ["STALE_STEER", "OK"], ["FROZEN_TURN", "OK"]]);
	const sent: SentKeys = [];
	const io = directorIo(pendingPane(BUSY_BAND("6m"), 6), "cfsios", sent);
	expect(inspectStuckPending(io).map((row) => [row.component, row.status])).toEqual([["STALE_STEER", "DEGRADED"], ["STUCK_PENDING", "OK"], ["FROZEN_TURN", "OK"]]);
	expect(flushPending(io, true)).toMatchObject({ overall: "FINDINGS", panes: [], stale_steer: [{ pane_id: "%100", busy_ms: 6 * MIN }] });
	expect(sent).toEqual([]);
});

test("band idle only 30 s is quiet", () => {
	expect(inspectStuckPending(directorIo(pendingPane(IDLE_BAND, 0.5))).map((row) => row.status)).toEqual(["OK", "OK", "OK"]);
	expect(flushPending(directorIo(pendingPane(IDLE_BAND, 0.5)), true).panes).toEqual([]);
});

test("human draft without a marker is ALERT and receives zero keys", () => {
	const sent: SentKeys = [];
	const io = directorIo(pendingPane(DRAFT("After that, reply with only the word PINEAPPLE."), 3, STARTED), "cfsios", sent);
	expect(inspectStuckPending(io)[0]).toMatchObject({ status: "DEGRADED", evidence: { shape: "COMPOSER_TEXT", action: "ALERT" } });
	expect(flushPending(io, true)).toMatchObject({ overall: "FINDINGS", panes: [{ action: "ALERT", result: "ALERTED", keys_sent: [] }] });
	expect(sent).toEqual([]);
});

test("band over a non-empty composer is ALERT, not flushed", () => {
	const sent: SentKeys = [];
	expect(flushPending(directorIo(pendingPane(screen(STEER_BAND, "❯ half typed", STATUS_IDLE), 3), "cfsios", sent), true).panes).toMatchObject([{ action: "ALERT", result: "ALERTED" }]);
	expect(sent).toEqual([]);
});

test("kit-send marker composers are classified but report-only: zero keys", () => {
	const sent: SentKeys = [];
	expect(flushPending(directorIo(pendingPane(DRAFT("[kit-send-cad02693789f]"), 3, DRAFT("")), "cfsios", sent), true).panes).toMatchObject([{ action: "CLEAR", result: "REPORTED", keys_sent: [] }]);
	expect(flushPending(directorIo(pendingPane(DRAFT("DONE kit-1 abc [kit-send-cad02693789f]"), 3, STARTED), "cfsios", sent), true).panes).toMatchObject([{ action: "SUBMIT", result: "REPORTED", keys_sent: [] }]);
	expect(sent).toEqual([]);
});

// cfsios %6 (omp pid 61924) as captured while frozen: spinner glyph and timer drawn, nothing moving.
const FROZEN_6 = [
	"│ policy                                                                  │",
	"│ └─ ☐ Prepare director handoff with own hunk boundaries, tests/logs/docs │",
	"│ status, preserved hunks, and any actual fired rules; do not commit or   │",
	"│ close                                                                   │",
	"╰─────────────────────────────────────────────────────────────────────────╯",
	" Preparing scratch directory",
	" Steering · 1",
	"   1. Read-only reviewer for cfs-census-regexp-var-repair-u8gcs. Please i…",
	"   └ ⌥↑ to edit",
	"TODO 3/6 · ☐ Apply only the authorized matcher-regex hoist and ignored-di…",
	" ⠙ 35m > ◑ GPT-6-Luna > 📁 ….ios > ⑂ main *148 +14 ?235 ▶───23%─────┃─872K─",
	"╰─",
	"",
].join("\n");
function sleepsOf(io: FleetIo): number[] {
	const sleeps: number[] = [];
	io.sleep = (ms) => { sleeps.push(ms); };
	return sleeps;
}

test("%6 frozen screen: identical 60 s apart over a 35 min old transcript is FROZEN_TURN, report only", () => {
	const sent: SentKeys = [];
	const io = directorIo(pendingPane(FROZEN_6, 35), "cfsios", sent);
	const sleeps = sleepsOf(io);
	const rows = inspectStuckPending(io);
	expect(sleeps).toEqual([60_000]);
	expect(rows.map((row) => [row.component, row.status])).toEqual([["FROZEN_TURN", "DEGRADED"], ["STUCK_PENDING", "OK"], ["STALE_STEER", "OK"]]);
	expect(rows[0]!.evidence).toMatchObject({ level: "WARN", pane_id: "%100", shown_ms: 35 * MIN, idle_ms: 35 * MIN, preview: "Read-only reviewer for cfs-census-regexp-var-repair-u8gcs. Please i…" });
	expect(flushPending(io, true)).toMatchObject({ overall: "FINDINGS", panes: [], frozen_turn: [{ pane_id: "%100" }], stale_steer: [] });
	expect(sent).toEqual([]);
});

test("%6 screen that changes between the captures is a live turn: STALE_STEER, not FROZEN_TURN", () => {
	const panes = pendingPane(FROZEN_6, 35);
	const io = directorIo(panes);
	const tmux = io.tmux;
	io.tmux = (args) => { const out = tmux(args); if (args[0] === "capture-pane") panes[0]!.text = FROZEN_6.replace("⠙ 35m", "⠹ 36m"); return out; };
	sleepsOf(io);
	expect(inspectStuckPending(io).map((row) => [row.component, row.status])).toEqual([["STALE_STEER", "DEGRADED"], ["STUCK_PENDING", "OK"], ["FROZEN_TURN", "OK"]]);
});

test("%6 screen over a fresh transcript is not rechecked or frozen", () => {
	const io = directorIo(pendingPane(FROZEN_6, 5));
	const sleeps = sleepsOf(io);
	expect(inspectStuckPending(io).map((row) => [row.component, row.status])).toEqual([["STALE_STEER", "DEGRADED"], ["STUCK_PENDING", "OK"], ["FROZEN_TURN", "OK"]]);
	expect(sleeps).toEqual([]);
});

test("a pane that changed before the keys is skipped", () => {
	const sent: SentKeys = [];
	const panes = pendingPane(IDLE_BAND, 3);
	const io = directorIo(panes, "cfsios", sent);
	const tmux = io.tmux;
	let captures = 0;
	io.tmux = (args) => { if (args[0] === "capture-pane" && ++captures === 2) panes[0]!.text = DRAFT("typing"); return tmux(args); };
	expect(flushPending(io, true).panes).toMatchObject([{ result: "SKIPPED_CHANGED", keys_sent: [] }]);
	expect(sent).toEqual([]);
});
