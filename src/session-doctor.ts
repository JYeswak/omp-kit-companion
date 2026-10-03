import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolveOmpIdentity } from "./paths.ts";

export type SessionVerdict = "CURRENT" | "STALE" | "UNVERIFIED";

export interface SessionProcess {
	pid: number;
	ppid: number;
	command: string;
	start_epoch_ms: number | null;
	start_text: string;
}

export interface SessionPane {
	pane: string;
	pid: number;
	start_command: string;
}

export interface SessionInstall {
	label: string;
	path: string;
	version: string | null;
	installed_at_epoch_ms: number | null;
}

export interface SessionReport {
	scope: "sessions";
	overall: "REPORT";
	checked_at_epoch_ms: number;
	components: SessionInstall[];
	sessions: SessionEntry[];
	text: string;
}

export interface SessionEntry {
	pid: number;
	ppid: number;
	command: string;
	start_epoch_ms: number | null;
	start_time: string | null;
	pane: string | null;
	pane_pid: number | null;
	pane_start_command: string | null;
	verdict: SessionVerdict;
	predates: string[];
	reason?: string;
}

export interface SessionDoctorInput {
	processes?: readonly SessionProcess[];
	panes?: readonly SessionPane[];
	components?: readonly SessionInstall[];
	parent_map?: Readonly<Record<string, number>>;
	now_epoch_ms?: number;
	home?: string;
	path?: string;
}

interface PsRow {
	pid: number;
	ppid: number;
	start_text: string;
	command: string;
}

function parsePsRows(output: string): PsRow[] {
	const rows: PsRow[] = [];
	for (const line of output.split("\n")) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s+((?:[A-Za-z]{3}\s+){2}\s*\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/);
		if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), start_text: match[3]!.trim(), command: match[4]! });
	}
	return rows;
}

export function parsePsProcesses(output: string): SessionProcess[] {
	return parsePsRows(output).filter((row) => isOmpCommand(row.command)).map((row) => ({
		pid: row.pid,
		ppid: row.ppid,
		command: row.command,
		start_epoch_ms: parseStartEpoch(row.start_text),
		start_text: row.start_text,
	}));
}

function parseStartEpoch(value: string): number | null {
	const epoch = Date.parse(value);
	return Number.isFinite(epoch) ? epoch : null;
}

function runText(args: readonly string[], env?: Record<string, string>): string {
	try {
		const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", ...(env ? { env: { ...process.env, ...env } } : {}) });
		return result.exitCode === 0 ? result.stdout.toString() : "";
	} catch {
		return "";
	}
}

function isOmpCommand(command: string): boolean {
	return /(?:^|[\s/])omp(?:\s|$)/.test(command);
}


export function parseTmuxPanes(output: string): SessionPane[] {
	const panes: SessionPane[] = [];
	for (const line of output.split("\n")) {
		const fields = line.split(line.includes("|") ? "|" : "\t");
		const pane = line.includes("|") ? `${fields[0] ?? ""} ${fields[1] ?? ""}`.trim() : fields[0] ?? "";
		const pidText = line.includes("|") ? fields[2] ?? "" : fields[1] ?? "";
		const start_command = line.includes("|") ? fields[3] ?? "" : fields[2] ?? "";
		const pid = Number(pidText);
		if (!pane || !Number.isInteger(pid) || pid <= 0) continue;
		panes.push({ pane, pid, start_command });
	}
	return panes;
}

interface ProcessSnapshot {
	processes: SessionProcess[];
	parent_by_pid: Map<number, number>;
}

function collectProcessSnapshot(): ProcessSnapshot {
	const rows = parsePsRows(runText(["ps", "-axo", "pid=,ppid=,lstart=,command="]));
	return {
		processes: rows.filter((row) => isOmpCommand(row.command)).map((row) => ({ pid: row.pid, ppid: row.ppid, command: row.command, start_epoch_ms: parseStartEpoch(row.start_text), start_text: row.start_text })),
		parent_by_pid: new Map(rows.map((row) => [row.pid, row.ppid])),
	};
}

function collectPanes(home: string): SessionPane[] {
	const tmuxTmpDir = process.env.TMUX_TMPDIR ?? join(home, ".tmux-sockets");
	return parseTmuxPanes(runText(["tmux", "list-panes", "-a", "-F", "#{session_name}|#{window_index}.#{pane_index}|#{pane_pid}|#{pane_start_command}"], { TMUX_TMPDIR: tmuxTmpDir }));
}

function readVersion(root: string): string | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		return parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function install(label: string, path: string): SessionInstall {
	const manifest = existsSync(join(path, "package.json")) ? join(path, "package.json") : path;
	try {
		return { label, path, version: readVersion(path), installed_at_epoch_ms: statSync(manifest).mtimeMs };
	} catch {
		return { label, path, version: readVersion(path), installed_at_epoch_ms: null };
	}
}

function pathFromPath(name: string, pathValue: string): string | null {
	for (const directory of pathValue.split(":")) {
		const candidate = resolve(directory || ".", name);
		try {
			return realpathSync(candidate);
		} catch {
			// Continue through PATH entries; absence is reported as unverified.
		}
	}
	return null;
}

function resolveKitRoot(home: string, pathValue: string): string | null {
	const candidates = [
		process.env.OMP_KIT_RELEASE_ROOT,
		process.env.OMP_KIT_ROOT,
		pathFromPath("omp-kit", pathValue),
		join(home, ".local", "opt", "omp-kit", "bin", "omp-kit"),
	].filter((value): value is string => Boolean(value));
	for (const candidate of candidates) {
		try {
			const real = realpathSync(candidate);
			if (basename(real) === "omp-kit" && basename(dirname(real)) === "bin") return dirname(dirname(real));
			if (existsSync(join(real, "package.json"))) return real;
		} catch {
			// Try the next install candidate.
		}
	}
	return null;
}

function resolveComponents(home: string, pathValue: string): SessionInstall[] {
	const components: SessionInstall[] = [];
	try {
		const identity = resolveOmpIdentity({ ...process.env, PATH: pathValue });
		components.push(install("OMP package", identity.packageRoot));
	} catch {
		components.push({ label: "OMP package", path: "<unresolved>", version: null, installed_at_epoch_ms: null });
	}
	const kitRoot = resolveKitRoot(home, pathValue);
	components.push(kitRoot ? install("kit plugin", kitRoot) : { label: "kit plugin", path: "<unresolved>", version: null, installed_at_epoch_ms: null });
	const agentsPath = join(home, ".agents", "AGENTS.md");
	try {
		components.push({ label: "~/.agents/AGENTS.md", path: agentsPath, version: null, installed_at_epoch_ms: statSync(agentsPath).mtimeMs });
	} catch {
		components.push({ label: "~/.agents/AGENTS.md", path: agentsPath, version: null, installed_at_epoch_ms: null });
	}
	return components;
}

function formatTime(epochMs: number | null): string | null {
	return epochMs === null ? null : new Date(epochMs).toISOString();
}

function entryFor(process: SessionProcess, parentByPid: ReadonlyMap<number, number>, paneByPid: ReadonlyMap<number, SessionPane>, components: readonly SessionInstall[]): SessionEntry {
	let pid = process.pid;
	let pane: SessionPane | undefined;
	const visited = new Set<number>();
	while (!visited.has(pid)) {
		visited.add(pid);
		pane = paneByPid.get(pid);
		if (pane) break;
		const parent = parentByPid.get(pid);
		if (!parent || parent === pid) break;
		pid = parent;
	}
	const predates = components.filter((component) => component.installed_at_epoch_ms !== null && process.start_epoch_ms !== null && process.start_epoch_ms < component.installed_at_epoch_ms).map((component) => component.label);
	const unresolved = components.filter((component) => component.installed_at_epoch_ms === null).map((component) => component.label);
	const verdict: SessionVerdict = predates.length ? "STALE" : unresolved.length ? "UNVERIFIED" : "CURRENT";
	return {
		pid: process.pid,
		ppid: process.ppid,
		command: process.command,
		start_epoch_ms: process.start_epoch_ms,
		start_time: formatTime(process.start_epoch_ms),
		pane: pane?.pane ?? null,
		pane_pid: pane?.pid ?? null,
		pane_start_command: pane?.start_command ?? null,
		verdict,
		predates,
		...(unresolved.length ? { reason: `install time unavailable for ${unresolved.join(", ")}` } : {}),
	};
}

function renderText(report: Omit<SessionReport, "text">): string {
	const components = report.components.map((component) => {
		const version = component.version ? ` ${component.version}` : "";
		const installed = component.installed_at_epoch_ms === null ? "UNKNOWN" : new Date(component.installed_at_epoch_ms).toISOString();
		return `${component.label}${version}: ${installed} (${component.path})`;
	});
	const rows = report.sessions.map((session) => {
		const pane = session.pane ?? "<no-tmux-pane>";
		const predates = session.predates.length ? ` predates ${session.predates.join(", ")}` : "";
		const reason = session.reason ? ` ${session.reason}` : "";
		return `pid=${session.pid} pane=${pane} start=${session.start_time ?? session.start_epoch_ms ?? "UNKNOWN"} verdict=${session.verdict}${predates}${reason}`;
	});
	return ["SESSION COMPONENTS", ...components, "SESSIONS", ...rows].join("\n");
}

export function inspectOmpSessions(input: SessionDoctorInput = {}): SessionReport {
	const now = input.now_epoch_ms ?? Date.now();
	const home = input.home ?? process.env.HOME ?? "";
	const pathValue = input.path ?? process.env.PATH ?? "";
	const snapshot = input.processes === undefined ? collectProcessSnapshot() : null;
	const processes = [...(input.processes ?? snapshot!.processes)].sort((left, right) => left.pid - right.pid);
	const panes = [...(input.panes ?? collectPanes(home))];
	const components = [...(input.components ?? resolveComponents(home, pathValue))];
	const parentByPid = input.parent_map
		? new Map(Object.entries(input.parent_map).map(([pid, ppid]) => [Number(pid), ppid]))
		: snapshot?.parent_by_pid ?? new Map<number, number>(processes.map((process) => [process.pid, process.ppid]));
	const paneByPid = new Map<number, SessionPane>(panes.map((pane) => [pane.pid, pane]));
	const sessions = processes.map((process) => entryFor(process, parentByPid, paneByPid, components));
	const partial = { scope: "sessions" as const, overall: "REPORT" as const, checked_at_epoch_ms: now, components, sessions };
	return { ...partial, text: renderText(partial) };
}

export function liveSessionInventory(): SessionReport {
	return inspectOmpSessions();
}
