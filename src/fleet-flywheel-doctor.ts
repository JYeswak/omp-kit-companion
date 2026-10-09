// doctor --scope fleet: Agent Flywheel Kernel invariant 6 (no ringleader) and the
// "Communication purgatory" anti-pattern, measured from the live fleet. Read-only.
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding } from "./diagnostics.ts";
import { paneIsBusy } from "./fleet-watch.ts";

export const DIRECTOR_IDLE_LIMIT_MS = 20 * 60_000;
export const PURGATORY_WINDOW_MS = 2 * 60 * 60_000;
export const PURGATORY_MIN_SENDS = 6;
export const PURGATORY_RATIO = 3;
const ATTRIBUTION_DEPTH = 500;

export type FleetProcess = { pid: number; ppid: number; args: string };
export type MailSends = { repo: string; seat: string; count: number };
export interface FleetIo {
	nowMs(): number;
	/** Runs tmux against the resolved fleet socket; null when tmux fails. */
	tmux(args: readonly string[]): string | null;
	processes(): FleetProcess[];
	/** Open omp session transcript paths per pid (lsof). */
	openSessionFiles(pids: readonly number[]): Map<number, string[]>;
	mtimeMs(path: string): number | null;
	/** Agent Mail messages sent at or after sinceUs, grouped by project and sender; a string is the unavailability reason. */
	mailSends(sinceUs: number): MailSends[] | string;
	readFile(path: string): string | null;
	git(repo: string, args: readonly string[]): string | null;
}

/** Session transcripts live under ~/.omp/agent/sessions or ~/.omp/profiles/<name>/agent/sessions. */
const SESSION_FILE = /\/\.omp\/(?:profiles\/[^/]+\/)?agent\/sessions\/.+\.jsonl$/;
const OMP_ARGV = /(?:^|[\s/])omp(?:\s|$)/;

type Pane = { session: string; window: number; pane: number; pid: number };

function parsePanes(text: string): Pane[] {
	const panes: Pane[] = [];
	for (const line of text.split("\n")) {
		const [session, window, pane, pid] = line.split("\t");
		if (!session || window === undefined || pane === undefined || pid === undefined) continue;
		const parsed = { session, window: Number(window), pane: Number(pane), pid: Number(pid) };
		if ([parsed.window, parsed.pane, parsed.pid].every(Number.isSafeInteger)) panes.push(parsed);
	}
	return panes;
}

function ompDescendants(root: number, children: Map<number, FleetProcess[]>): number[] {
	const found: number[] = [];
	const queue = [root];
	for (let index = 0; index < queue.length; index++) {
		for (const child of children.get(queue[index]!) ?? []) {
			if (OMP_ARGV.test(child.args)) found.push(child.pid);
			queue.push(child.pid);
		}
	}
	return found;
}

type PaneState = { target: string; omp: boolean; busy: boolean; idle_ms: number | null; session_files: number };

/** Kernel invariant 6: the director (pane x.1 of the first window) is busy while every worker has been idle >= 20 min. */
export function inspectDirectorDoingWork(io: FleetIo): Finding[] {
	const listed = io.tmux(["list-panes", "-a", "-F", "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}"]);
	if (listed === null) return [{ component: "DIRECTOR_DOING_WORK", status: "UNVERIFIED", reason: "No live tmux server answered list-panes; fleet panes were not inspected", recommended_action: "Run on the fleet host; set TMUX_TMPDIR when the fleet uses a private socket directory." }];
	const now = io.nowMs();
	const processes = io.processes();
	const children = new Map<number, FleetProcess[]>();
	for (const proc of processes) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
	const panes = parsePanes(listed);
	const ompByPane = new Map(panes.map((pane) => [pane, ompDescendants(pane.pid, children)] as const));
	const files = io.openSessionFiles([...ompByPane.values()].flat());
	const sessions = new Map<string, Pane[]>();
	for (const pane of panes) sessions.set(pane.session, [...(sessions.get(pane.session) ?? []), pane]);
	const rows: Finding[] = [];
	const checked: string[] = [];
	for (const [session, members] of sessions) {
		const firstWindow = Math.min(...members.map((pane) => pane.window));
		const director = members.find((pane) => pane.window === firstWindow && pane.pane === 1);
		if (!director || !ompByPane.get(director)!.length) continue;
		const workers = members.filter((pane) => pane !== director && ompByPane.get(pane)!.length);
		if (!workers.length) continue;
		checked.push(session);
		const state = (pane: Pane): PaneState => {
			const target = `${pane.session}:${pane.window}.${pane.pane}`;
			const paths = ompByPane.get(pane)!.flatMap((pid) => files.get(pid) ?? []);
			const mtimes = paths.map((path) => io.mtimeMs(path)).filter((value): value is number => value !== null);
			return { target, omp: true, busy: paneIsBusy(io.tmux(["capture-pane", "-p", "-t", target]) ?? ""),
				idle_ms: mtimes.length ? Math.max(0, now - Math.max(...mtimes)) : null, session_files: paths.length };
		};
		const directorState = state(director);
		if (!directorState.busy) continue;
		const workerStates = workers.map(state);
		if (!workerStates.every((worker) => !worker.busy && worker.idle_ms !== null && worker.idle_ms >= DIRECTOR_IDLE_LIMIT_MS)) continue;
		const minIdle = Math.min(...workerStates.map((worker) => worker.idle_ms!));
		rows.push({ component: "DIRECTOR_DOING_WORK", status: "DEGRADED",
			reason: `WARN ${session}: director ${directorState.target} is busy while all ${workerStates.length} worker pane(s) have been idle >= ${Math.floor(minIdle / 60_000)} min`,
			recommended_action: "Kernel invariant 6: the director coordinates through artifacts; dispatch the work to an idle worker instead of doing it in the director pane.",
			evidence: { level: "WARN", session, director: directorState, workers: workerStates, idle_limit_ms: DIRECTOR_IDLE_LIMIT_MS, idle_source: "max mtime of omp session transcripts held open (lsof) by the pane's omp process" } });
	}
	if (!rows.length) rows.push({ component: "DIRECTOR_DOING_WORK", status: "OK",
		reason: `No session has a busy director with every worker idle >= ${DIRECTOR_IDLE_LIMIT_MS / 60_000} min (${checked.length} session(s) with a director and workers checked)`,
		recommended_action: "No action required.", evidence: { sessions_checked: checked } });
	return rows;
}

type Issue = { id?: unknown; status?: unknown; assignee?: unknown; closed_at?: unknown };

function readIssues(io: FleetIo, repo: string): Issue[] | null {
	const text = io.readFile(join(repo, ".beads", "issues.jsonl"));
	if (text === null) return null;
	const issues: Issue[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try { issues.push(JSON.parse(line) as Issue); } catch {}
	}
	return issues;
}

type Commit = { author: string; trailerValues: string[]; epochS: number };

function readCommits(io: FleetIo, repo: string): Commit[] | null {
	const text = io.git(repo, ["log", "-n", String(ATTRIBUTION_DEPTH), "--format=%ct%x1f%an%x1f%(trailers:only,unfold,separator=%x1e)%x1d"]);
	if (text === null) return null;
	return text.split("\x1d").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
		const [epoch = "0", author = "", trailers = ""] = record.split("\x1f");
		return { epochS: Number(epoch), author: author.trim(), trailerValues: trailers.split("\x1e").map((line) => line.slice(line.indexOf(":") + 1).trim()).filter(Boolean) };
	});
}

const NAME_TOKEN = /[A-Za-z0-9_-]+/g;
function attributes(commit: Commit, seat: string): boolean {
	const wanted = seat.toLowerCase();
	if (commit.author.toLowerCase() === wanted) return true;
	return commit.trailerValues.some((value) => (value.match(NAME_TOKEN) ?? []).some((token) => token.toLowerCase() === wanted));
}

/** Anti-pattern "Communication purgatory": a seat holding an in_progress bead sends more mail than it lands. */
export function inspectCommunicationPurgatory(io: FleetIo): Finding[] {
	const now = io.nowMs();
	const since = now - PURGATORY_WINDOW_MS;
	const sends = io.mailSends(since * 1000);
	if (typeof sends === "string") return [{ component: "COMMUNICATION_PURGATORY", status: "UNVERIFIED", reason: `Agent Mail store unavailable: ${sends}`, recommended_action: "Point AGENT_MAIL_STORAGE_ROOT at the live Agent Mail root (it holds storage.sqlite3)." }];
	const rows: Finding[] = [];
	let evaluated = 0;
	for (const { repo, seat, count } of sends) {
		if (count < PURGATORY_MIN_SENDS) continue;
		const issues = readIssues(io, repo);
		if (!issues) continue;
		const claimed = issues.filter((issue) => issue.status === "in_progress" && issue.assignee === seat).map((issue) => String(issue.id));
		if (!claimed.length) continue;
		evaluated++;
		const closes = issues.filter((issue) => issue.assignee === seat && typeof issue.closed_at === "string" && Date.parse(issue.closed_at) >= since).length;
		const commits = readCommits(io, repo);
		const base = { seat, repo, sends_2h: count, claimed_beads: claimed, closes_2h: closes };
		if (!commits || !commits.some((commit) => attributes(commit, seat))) {
			rows.push({ component: "COMMUNICATION_PURGATORY", status: "UNVERIFIED",
				reason: `UNKNOWN ${seat} in ${repo}: ${count} sends in 2 h, but no commit in the last ${ATTRIBUTION_DEPTH} names this seat as author or trailer, so its commits cannot be counted`,
				recommended_action: "Add a seat trailer (e.g. Agent: <seat>) to agent commits so landed work can be attributed.",
				evidence: { level: "UNKNOWN", ...base, commits_2h: null, git_readable: commits !== null } });
			continue;
		}
		const landed = commits.filter((commit) => commit.epochS * 1000 >= since && attributes(commit, seat)).length;
		if (count > (landed + closes) * PURGATORY_RATIO) rows.push({ component: "COMMUNICATION_PURGATORY", status: "DEGRADED",
			reason: `WARN ${seat} in ${repo}: ${count} Agent Mail sends in 2 h against ${landed} commit(s) and ${closes} bead close(s) while holding ${claimed.join(", ")}`,
			recommended_action: "Communication purgatory: stop messaging and land the claimed bead (commit, close) or release it.",
			evidence: { level: "WARN", ...base, commits_2h: landed } });
	}
	if (!rows.length) rows.push({ component: "COMMUNICATION_PURGATORY", status: "OK",
		reason: `No seat holding an in_progress bead sent >= ${PURGATORY_MIN_SENDS} messages and more than ${PURGATORY_RATIO}x its commits plus closes in 2 h (${evaluated} claimed seat(s) evaluated)`,
		recommended_action: "No action required.", evidence: { seats_evaluated: evaluated, mail_senders_2h: sends.length } });
	return rows;
}

export function inspectFleetScope(io: FleetIo): Finding[] {
	return [...inspectDirectorDoingWork(io), ...inspectCommunicationPurgatory(io)];
}

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string | null {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, ...(env ? { env } : {}) });
	return result.status === 0 ? result.stdout : null;
}

/** TMUX_TMPDIR wins; else ~/.tmux-sockets when it holds a live server; else the tmux default. */
export function tmuxSocketArgs(env: NodeJS.ProcessEnv = process.env, probe: (args: readonly string[]) => boolean = (args) => run("tmux", [...args, "list-sessions"]) !== null): string[] {
	if (env.TMUX_TMPDIR) return [];
	const socket = join(env.HOME ?? homedir(), ".tmux-sockets", `tmux-${process.getuid?.() ?? 0}`, "default");
	return existsSync(socket) && probe(["-S", socket]) ? ["-S", socket] : [];
}

export function liveFleetIo(env: NodeJS.ProcessEnv = process.env): FleetIo {
	const socket = tmuxSocketArgs(env);
	return {
		nowMs: () => Date.now(),
		tmux: (args) => run("tmux", [...socket, ...args]),
		processes: () => (run("ps", ["-axo", "pid=,ppid=,args="]) ?? "").split("\n").flatMap((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]! }] : [];
		}),
		openSessionFiles: (pids) => {
			const map = new Map<number, string[]>();
			if (!pids.length) return map;
			let current = 0;
			// lsof exits 1 when any pid has vanished; its partial stdout is still valid.
			const out = spawnSync("lsof", ["-a", "-p", pids.join(","), "-Fpn"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
			for (const line of out.split("\n")) {
				if (line.startsWith("p")) current = Number(line.slice(1));
				else if (line.startsWith("n") && SESSION_FILE.test(line)) map.set(current, [...(map.get(current) ?? []), line.slice(1)]);
			}
			return map;
		},
		mtimeMs: (path) => { try { return statSync(path).mtimeMs; } catch { return null; } },
		mailSends: (sinceUs) => {
			const root = env.AGENT_MAIL_STORAGE_ROOT;
			if (!root) return "AGENT_MAIL_STORAGE_ROOT is unset";
			const path = join(root, "storage.sqlite3");
			if (!existsSync(path)) return `${path} does not exist`;
			let db: Database | undefined;
			try {
				db = new Database(path, { readonly: true });
				return db.query("SELECT p.human_key AS repo, a.name AS seat, COUNT(*) AS count FROM messages m JOIN agents a ON a.id = m.sender_id JOIN projects p ON p.id = m.project_id WHERE m.created_ts >= ? GROUP BY p.human_key, a.name").all(sinceUs) as MailSends[];
			} catch (error) { return `${path} unreadable: ${error instanceof Error ? error.message : String(error)}`; }
			finally { db?.close(); }
		},
		readFile: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
		git: (repo, args) => run("git", ["-C", repo, ...args]),
	};
}
