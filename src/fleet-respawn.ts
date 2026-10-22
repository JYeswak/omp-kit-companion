/**
 * fleet-respawn (ompkit-xa5s.6): after a plugin relink, running panes keep
 * loading the old extensions until they respawn. This module never touches a
 * pane that is busy, frozen, dirty, holding reservations, or missing its
 * session file: those are reported, never acted on.
 *
 * Two phases share one row builder. reportStalePanes is read-only: it lists
 * every pane with its staleness verdict. respawnPanes acts only on explicitly
 * named panes with apply=true, strictly serially (one pane fully verified
 * before the next starts), and only when a fresh re-read still says READY.
 */
import { composerHasText } from "./send.ts";
import { paneIsBusy } from "./fleet-watch.ts";
import type { FleetIo, FleetProcess } from "./fleet-flywheel-doctor.ts";
export type RespawnVerdict =
	| "READY"
	| "SKIP-BUSY"
	| "SKIP-FROZEN"
	| "SKIP-DIRTY"
	| "SKIP-HOLDS"
	| "SKIP-NOSESSION"
	| "SKIP-FRESH";

export interface RespawnRow {
	pane: string;
	id: string;
	profile: string | null;
	ompPid: number | null;
	ompStartedAt: string | null;
	stale: boolean;
	idle: boolean;
	sessionFile: string | null;
	holds: string[];
	composerDraft: boolean;
	verdict: RespawnVerdict;
	reason: string;
}

export interface RespawnReport {
	panes: RespawnRow[];
	applied: boolean;
}

/** Seams the live CLI wires to real tmux/ps/Agent Mail; tests stub all three. */
export interface RespawnDeps {
	/** Process start epoch ms per pid; null when unreadable. */
	psStartMs(pids: readonly number[]): Map<number, number | null>;
	/** Agent name owning a pane id, via pane identity; null when unknown. */
	resolveAgent(paneId: string): string | null;
	/** Exclusive reservation descriptions held by an agent; empty when none. */
	exclusiveHolds(agent: string): string[];
}

// Matches the omp agent argv: a path segment that is exactly `omp`, or `omp`
// plus a version-like suffix (the versioned Tern install path, e.g.
// `.../omp-0.2.37`). The suffix MUST start with a digit (after an optional
// `v`) so nearby helpers such as `omp-helper` never count as the agent, and
// dotted names such as `omp.json` never match either (RedMaple 2026-10-13:
// every fleet pane read SKIP-FROZEN on 0.2.37).
const OMP_ARGV = /(?:^|[\s/])omp([-_@.]v?\d[^/\s]*)?(?=[\s]|$)/;
const PANE_FORMAT = "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_id}\t#{pane_current_path}";

interface Pane {
	session: string;
	window: number;
	pane: number;
	pid: number;
	id: string;
	cwd: string;
}
/** Parse `ps -o etime` elapsed ([[dd-]hh:]mm:ss) into milliseconds. */
export function parsePsElapsed(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	let days = 0;
	let rest = trimmed;
	const dash = rest.indexOf("-");
	if (dash >= 0) {
		const parsed = Number(rest.slice(0, dash));
		if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
		days = parsed;
		rest = rest.slice(dash + 1);
	}
	const parts = rest.split(":").map((part) => Number(part));
	if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
	if (parts.length === 3) return (((days * 24 + parts[0]!) * 60 + parts[1]!) * 60 + parts[2]!) * 1000;
	if (parts.length === 2) return (days * 86400 + parts[0]! * 60 + parts[1]!) * 1000;
	return null;
}

/**
 * POSIX shell-word split over a pinned subset: whitespace separation with
 * single/double quotes and backslash escapes. Anything else shell-active
 * ($, backtick, parens, angle brackets) or an unterminated quote returns
 * null so the respawn refuses instead of rebuilding a mangled argv
 * (FrostyStream 01:13: a suffix match launched fresh sessions). Tested for
 * quoted, escaped, nested, heredoc, substitution and prefix-plus-junk inputs.
 */
export function splitArgv(command: string): string[] | null {
	const words: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;
	let tainted = false;
	for (const character of command) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote !== null) {
			if (character === quote) quote = null;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (character === "$" || character === "`" || character === "(" || character === ")" || character === "<" || character === ">") {
			tainted = true;
		}
		if (character === " " || character === "\t") {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += character;
	}
	if (quote !== null) return null;
	if (escaped) current += "\\";
	if (current.length > 0) words.push(current);
	if (tainted) return null;
	return words;
}

/** Quote one argv word for sh -lc; exact quoting is a safety property. */
export function shellQuote(value: string): string {
	return `'${value.split("'").join("'\\''")}'`;
}

function parsePanes(text: string): Pane[] {
	const panes: Pane[] = [];
	for (const line of text.split("\n")) {
		const [session, window, pane, pid, id, cwd] = line.split("\t");
		if (!session || window === undefined || pane === undefined || pid === undefined || !id || cwd === undefined) continue;
		const parsed = { session, window: Number(window), pane: Number(pane), pid: Number(pid), id, cwd };
		if ([parsed.window, parsed.pane, parsed.pid].every(Number.isSafeInteger)) panes.push(parsed);
	}
	return panes;
}

function ompChildren(root: number, processes: FleetProcess[]): FleetProcess[] {
	const children = new Map<number, FleetProcess[]>();
	for (const process of processes) {
		const list = children.get(process.ppid) ?? [];
		list.push(process);
		children.set(process.ppid, list);
	}
	const found: FleetProcess[] = [];
	const queue = [root];
	for (let index = 0; index < queue.length; index += 1) {
		for (const child of children.get(queue[index]!) ?? []) {
			if (OMP_ARGV.test(child.args)) found.push(child);
			queue.push(child.pid);
		}
	}
	return found;
}

function profileOf(args: string): string | null {
	const words = splitArgv(args);
	if (words === null) return null;
	for (let index = 0; index + 1 < words.length; index += 1) {
		if (words[index] === "--profile") return words[index + 1] ?? null;
	}
	return null;
}

function withResumeArgv(args: string, sessionFile: string): string[] | null {
	const parsed = splitArgv(args);
	if (parsed === null || parsed.length === 0 || sessionFile.length === 0) return null;
	let head = parsed;
	if (head.slice(-4).join(" ") === "; exec zsh -l") head = head.slice(0, -4);
	const resumeAt = head.findIndex((word) => word === "--resume");
	if (resumeAt >= 0) head = [...head.slice(0, resumeAt), "--resume", sessionFile, ...head.slice(resumeAt + 2)];
	else head = [...head, "--resume", sessionFile];
	return [...head, ";", "exec", "zsh", "-l"];
}

function buildRow(
	io: FleetIo,
	deps: RespawnDeps,
	pane: Pane,
	relinkAtMs: number | null,
	linkNote: string,
	processes: FleetProcess[],
): RespawnRow {
	const label = `${pane.session}:${pane.window}.${pane.pane}`;
	const base = {
		pane: label,
		id: pane.id,
		profile: null as string | null,
		ompPid: null as number | null,
		ompStartedAt: null as string | null,
		stale: false,
		idle: false,
		sessionFile: null as string | null,
		holds: [] as string[],
		composerDraft: false,
	};
	const omp = ompChildren(pane.pid, processes);
	if (omp.length === 0) {
		return { ...base, verdict: "SKIP-FROZEN", reason: `no live omp child under pane pid ${pane.pid}; reported only` };
	}
	const target = omp[0]!;
	const starts = deps.psStartMs(omp.map((entry) => entry.pid));
	const startedAt = starts.get(target.pid) ?? null;
	const row = {
		...base,
		profile: profileOf(target.args),
		ompPid: target.pid,
		ompStartedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
	};
	if (startedAt === null) {
		return { ...row, verdict: "SKIP-FROZEN", reason: `omp pid ${target.pid} start time unreadable; reported only` };
	}
	if (relinkAtMs === null) {
		return { ...row, verdict: "SKIP-FRESH", reason: `no applied relink receipt to compare (${linkNote}); reported only` };
	}
	const capture = io.tmux(["capture-pane", "-p", "-S", "-200", "-t", pane.id]);
	if (capture === null) {
		return { ...row, verdict: "SKIP-FROZEN", reason: `capture of ${pane.id} failed; reported only` };
	}
	const idle = !paneIsBusy(capture);
	const draft = composerHasText(capture);
	const settled: RespawnRow = { ...row, idle, composerDraft: draft, stale: startedAt < relinkAtMs };
	if (!idle) {
		return { ...settled, verdict: "SKIP-BUSY", reason: `pane shows a spinner; reported only` };
	}
	if (draft) {
		return { ...settled, verdict: "SKIP-DIRTY", reason: `composer holds unsent text; reported only, never submitted` };
	}
	if (!settled.stale) {
		return { ...settled, verdict: "SKIP-FRESH", reason: `omp started at ${settled.ompStartedAt}, after the relink; nothing to do` };
	}
	const byPpid = new Map<number, number[]>();
	for (const process of processes) byPpid.set(process.ppid, [...(byPpid.get(process.ppid) ?? []), process.pid]);
	const subtree = [pane.pid];
	for (let index = 0; index < subtree.length; index += 1) subtree.push(...(byPpid.get(subtree[index]!) ?? []));
	const files = io.openSessionFiles(subtree);
	const own = files.get(target.pid)?.find((path) => path.endsWith(".jsonl")) ?? null;
	const fallback = subtree.flatMap((pid) => files.get(pid) ?? []).find((path) => path.endsWith(".jsonl")) ?? null;
	const sessionFile = own ?? fallback;
	if (!sessionFile) {
		return { ...settled, verdict: "SKIP-NOSESSION", reason: `no open session transcript for omp pid ${target.pid}; refusing a fresh respawn` };
	}
	const withFile: RespawnRow = { ...settled, sessionFile };
	const agent = deps.resolveAgent(pane.id);
	if (agent === null) {
		return { ...withFile, verdict: "SKIP-HOLDS", reason: `pane agent identity unresolvable; refusing without a holds check` };
	}
	const holds = deps.exclusiveHolds(agent);
	if (holds.length > 0) {
		return { ...withFile, holds, verdict: "SKIP-HOLDS", reason: `${agent} holds exclusive reservations (${holds.join("; ")}); refusing` };
	}
	return { ...withFile, verdict: "READY", reason: `idle, stale plugin, session file present, no holds` };
}

function parseRelinkAt(relinkAt: string | null): number | null {
	if (relinkAt === null) return null;
	const parsed = Date.parse(relinkAt);
	return Number.isNaN(parsed) ? null : parsed;
}

export function reportStalePanes(
	io: FleetIo,
	deps: RespawnDeps,
	relinkAt: string | null,
	linkNote: string,
	processes: FleetProcess[],
): RespawnReport {
	const listed = io.tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
	if (listed === null) return { panes: [], applied: false };
	const relinkAtMs = parseRelinkAt(relinkAt);
	const panes = parsePanes(listed).map((pane) => buildRow(io, deps, pane, relinkAtMs, linkNote, processes));
	return { panes, applied: false };
}

export interface RespawnOutcome {
	pane: string;
	id: string;
	result: "RESPAWNED" | "SKIPPED" | "FAILED";
	reason: string;
}

export function respawnPanes(
	io: FleetIo,
	deps: RespawnDeps,
	relinkAt: string | null,
	linkNote: string,
	linkMs: number,
	processes: FleetProcess[],
	selection: string[],
	apply: boolean,
): { outcomes: RespawnOutcome[]; applied: boolean } {
	const outcomes: RespawnOutcome[] = [];
	const listed = io.tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
	if (listed === null) {
		return { outcomes: selection.map((pane) => ({ pane, id: "", result: "SKIPPED", reason: "tmux list-panes failed" })), applied: false };
	}
	const relinkAtMs = parseRelinkAt(relinkAt);
	const byLabel = new Map(parsePanes(listed).map((pane) => [`${pane.session}:${pane.window}.${pane.pane}`, pane]));
	for (const pane of selection) {
		const target = byLabel.get(pane);
		if (!target) {
			outcomes.push({ pane, id: "", result: "SKIPPED", reason: "pane not present in this fleet snapshot" });
			continue;
		}
		const row = buildRow(io, deps, target, relinkAtMs, linkNote, processes);
		if (row.verdict !== "READY") {
			outcomes.push({ pane, id: target.id, result: "SKIPPED", reason: row.reason });
			continue;
		}
		if (!apply) {
			outcomes.push({ pane, id: target.id, result: "SKIPPED", reason: `would respawn (${row.reason}); re-run with --apply --yes` });
			continue;
		}
		const source = processes.find((entry) => entry.pid === row.ompPid)?.args ?? "";
		const argv = withResumeArgv(source, row.sessionFile ?? "");
		if (argv === null) {
			outcomes.push({ pane, id: target.id, result: "FAILED", reason: "launch argv unparseable or session file missing; refusing" });
			continue;
		}
		const relaunched = io.tmux(["respawn-pane", "-k", "-t", target.id, "-c", target.cwd, "zsh", "-lc", argv.map(shellQuote).join(" ")]);
		const rest = (reason: string): void => {
			for (const later of selection.slice(selection.indexOf(pane) + 1)) {
				const restTarget = byLabel.get(later);
				outcomes.push({ pane: later, id: restTarget?.id ?? "", result: "SKIPPED", reason });
			}
		};
		if (relaunched === null) {
			outcomes.push({ pane, id: target.id, result: "FAILED", reason: "tmux respawn-pane failed" });
			rest(`stopped after ${pane} failed to relaunch`);
			break;
		}
		io.sleep(2000);
		const after = io.tmux(["list-panes", "-a", "-F", PANE_FORMAT]);
		const next = after === null ? undefined : parsePanes(after).find((entry) => entry.id === target.id);
		if (!next) {
			outcomes.push({ pane, id: target.id, result: "FAILED", reason: "pane id gone after respawn" });
			rest(`stopped after ${pane} failed verification`);
			break;
		}
		const afterStarts = deps.psStartMs([next.pid]);
		const opened = io.openSessionFiles([next.pid]).get(next.pid) ?? [];
		const sameSession = opened.some((path) => path === row.sessionFile);
		const freshProcess = (afterStarts.get(next.pid) ?? 0) > linkMs;
		if (!sameSession || !freshProcess) {
			outcomes.push({ pane, id: target.id, result: "FAILED", reason: `post-respawn check failed (sameSession=${sameSession} freshProcess=${freshProcess}); stopping before the next pane` });
			rest(`stopped after ${pane} failed verification`);
			break;
		}
		outcomes.push({ pane, id: target.id, result: "RESPAWNED", reason: `same session file open, process postdates the link` });
	}
	return { outcomes, applied: apply };
}
