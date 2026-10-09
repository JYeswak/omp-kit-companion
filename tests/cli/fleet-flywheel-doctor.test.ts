import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectCommunicationPurgatory, inspectDirectorDoingWork, liveFleetIo, tmuxSocketArgs, type FleetIo, type MailSends } from "../../src/fleet-flywheel-doctor.ts";

const NOW = Date.parse("2026-10-09T18:00:00Z");
const MIN = 60_000;
const BUSY = "output\n⠧ Working (12s)\n";
const IDLE = "output\n> \n";

type FakePane = { index: number; window?: number; omp: boolean; text: string; idleMin?: number };
function directorIo(panes: FakePane[], session = "cfsios"): FleetIo {
	const listing = panes.map((pane, n) => `${session}\t${pane.window ?? 0}\t${pane.index}\t${1000 + n}`).join("\n");
	return {
		nowMs: () => NOW,
		tmux: (args) => {
			if (args[0] === "list-panes") return listing;
			const target = args[args.length - 1]!;
			const pane = panes.find((candidate) => target === `${session}:${candidate.window ?? 0}.${candidate.index}`);
			return pane ? pane.text : null;
		},
		processes: () => panes.flatMap((pane, n) => pane.omp ? [{ pid: 2000 + n, ppid: 1000 + n, args: "bun /Users/x/.bun/bin/omp --profile claude" }] : [{ pid: 2000 + n, ppid: 1000 + n, args: "vim notes.txt" }]),
		openSessionFiles: (pids) => new Map(pids.map((pid) => [pid, [`/Users/x/.omp/profiles/claude/agent/sessions/-repo/${pid}.jsonl`]])),
		mtimeMs: (path) => {
			const pane = panes[Number(/(\d+)\.jsonl$/.exec(path)![1]) - 2000]!;
			return pane.idleMin === undefined ? null : NOW - pane.idleMin * MIN;
		},
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
