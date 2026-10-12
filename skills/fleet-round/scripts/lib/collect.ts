// Read-only live capture of one project into a RawBundle. br runs with --no-auto-import
// --no-auto-flush (no database import, no JSONL export); git, tmux and ps only list; identity
// files are read, never resolved through Agent Mail (whose resolver may adopt and rewrite a file).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { missionCandidates } from "./checks.ts";
import { identityDirName, isRecord, PANE_FORMAT, type RawBundle } from "./model.ts";

export const CONFIG_SCHEMA = "fleet-round.config/v1";
/** Agent processes seen on the reference host (references/evidence.md): omp launcher and its dist entry. */
export const DEFAULT_AGENT_MARKERS = ["/.bun/bin/omp", "/pi-coding-agent/dist/cli.js"];
const BR_READ = ["--json", "--no-auto-import", "--no-auto-flush"];
const SHOW_CHUNK = 200;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 4096;
/** root: the br tracker; repo: the git repo whose docs hold the mission (default root); doc_ref: the committed ref those docs are read at. */
export type ProjectConfig = { root: string; repo: string; doc_ref: string; identity_keys: string[] };
/** Barrier phases and the report PHASE each one closes (round 0's execute phase is the sort). */
export const BARRIER_PHASES = { INSIGHT: "insight", AGREE: "agree", SORT: "execute" } as const;
export type BarrierPhase = keyof typeof BARRIER_PHASES;
/** database: Agent Mail's SQLite store, read with readonly; mail_project: the Agent Mail project key holding thread fleet-round-<N>; hours: timebox per barrier phase. */
export type BarrierConfig = { database: string; mail_project: string; hours: Record<BarrierPhase, number> };
export type Config = {
	projects: Record<string, ProjectConfig>;
	tmux_sockets: string[];
	identity_root: string;
	agent_markers: string[];
	stale_hours: number;
	frontier_top: number;
	approver: string | null;
	barrier: BarrierConfig | null;
};

function expand(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(text: string, where: string): Config {
	const json: unknown = JSON.parse(text);
	if (!isRecord(json) || json.schema !== CONFIG_SCHEMA) throw new Error(`${where}: expected "schema": "${CONFIG_SCHEMA}"`);
	if (!isRecord(json.projects) || Object.keys(json.projects).length === 0) throw new Error(`${where}: projects must name at least one project`);
	const projects: Record<string, ProjectConfig> = {};
	for (const [name, value] of Object.entries(json.projects)) {
		if (!isRecord(value) || typeof value.root !== "string") throw new Error(`${where}: projects.${name}.root must be a path`);
		const root = expand(value.root);
		const keys = value.identity_keys === undefined ? [root] : value.identity_keys;
		const repo = value.repo === undefined ? root : typeof value.repo === "string" ? expand(value.repo) : null;
		const ref = value.doc_ref === undefined ? "HEAD" : value.doc_ref;
		if (repo === null || typeof ref !== "string" || ref === "") throw new Error(`${where}: projects.${name}.repo and doc_ref must be strings`);
		projects[name] = { root, repo, doc_ref: ref, identity_keys: keys.map(expand) };
	}
	const seats = isRecord(json.seats) ? json.seats : {};
	const sockets = seats.tmux_sockets ?? [];
	if (!Array.isArray(sockets) || !sockets.every(s => typeof s === "string")) throw new Error(`${where}: seats.tmux_sockets must be socket paths`);
	const markers = seats.agent_markers ?? DEFAULT_AGENT_MARKERS;
	if (!Array.isArray(markers) || !markers.every(m => typeof m === "string" && m.length > 0)) throw new Error(`${where}: seats.agent_markers must be non-empty strings`);
	const number = (key: string, fallback: number): number => {
		const value = json[key] ?? fallback;
		if (typeof value !== "number" || !(value > 0)) throw new Error(`${where}: ${key} must be a positive number`);
		return value;
	};
	return {
		projects,
		tmux_sockets: sockets.map(expand),
		identity_root: expand(typeof seats.identity_root === "string" ? seats.identity_root : "~/.config/agent-mail/identity"),
		agent_markers: markers,
		stale_hours: number("stale_hours", 24),
		frontier_top: number("frontier_top", 3),
		approver: typeof json.approver === "string" ? json.approver : null,
		barrier: json.barrier === undefined ? null : barrierConfig(json.barrier, where),
	};
}

function barrierConfig(value: unknown, where: string): BarrierConfig {
	if (!isRecord(value) || typeof value.agent_mail_db !== "string" || value.agent_mail_db === "" || typeof value.mail_project !== "string" || value.mail_project === "") throw new Error(`${where}: barrier needs agent_mail_db and mail_project paths`);
	const hours = isRecord(value.hours) ? value.hours : {};
	const timeboxes = {} as Record<BarrierPhase, number>;
	for (const phase of Object.keys(BARRIER_PHASES) as BarrierPhase[]) {
		const h = hours[phase];
		if (typeof h !== "number" || !(h > 0)) throw new Error(`${where}: barrier.hours.${phase} must be a positive number of hours`);
		timeboxes[phase] = h;
	}
	return { database: expand(value.agent_mail_db), mail_project: expand(value.mail_project), hours: timeboxes };
}

function run(argv: string[], cwd: string): { ok: boolean; stdout: string; error: string } {
	const child = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } });
	return { ok: child.exitCode === 0, stdout: child.stdout.toString(), error: `${argv.slice(0, 3).join(" ")} exited ${child.exitCode}: ${child.stderr.toString().trim().slice(0, 300)}` };
}

function must(argv: string[], cwd: string): string {
	const result = run(argv, cwd);
	if (!result.ok) throw new Error(result.error);
	return result.stdout;
}

export function collect(config: Config, project: string): RawBundle {
	const target = config.projects[project];
	if (!target) throw new Error(`project ${project} is not in the config (${Object.keys(config.projects).join(", ")})`);
	const root = target.root;
	const captured_at = new Date().toISOString();
	const version = must(["br", "--version"], root).trim();
	const list = must(["br", "list", "--all", "--limit", "0", ...BR_READ], root);
	const parsed: unknown = JSON.parse(list);
	if (!isRecord(parsed) || !Array.isArray(parsed.issues)) throw new Error("br list --json: no issues array");
	const ids = parsed.issues.map(row => (isRecord(row) && typeof row.id === "string" ? row.id : "")).filter(Boolean);
	const shown: unknown[] = [];
	for (let i = 0; i < ids.length; i += SHOW_CHUNK) {
		const chunk: unknown = JSON.parse(must(["br", "show", ...ids.slice(i, i + SHOW_CHUNK), ...BR_READ], root));
		if (!Array.isArray(chunk)) throw new Error("br show --json: expected an array");
		shown.push(...chunk);
	}
	const ready = must(["br", "ready", "--limit", "0", ...BR_READ], root);
	const policyPath = join(root, ".beads", "policy.yaml");
	const repo = target.repo;
	const head = must(["git", "rev-parse", "--verify", `${target.doc_ref}^{commit}`], repo).trim();
	const lsFiles = must(["git", "ls-tree", "-r", "-z", "--name-only", head], repo).split("\0").filter(path => path !== "" && !path.includes("\n")).join("\n");
	const docs: Record<string, string> = {};
	for (const path of missionCandidates(lsFiles)) {
		const blob = run(["git", "cat-file", "blob", `${head}:${path}`], repo);
		if (blob.ok && blob.stdout.length <= MAX_DOC_BYTES) docs[path] = blob.stdout;
	}
	const tmux = config.tmux_sockets.map(socket => {
		if (!existsSync(socket)) return { socket, output: null, error: "socket does not exist" };
		const result = run(["tmux", "-S", socket, "list-panes", "-a", "-F", PANE_FORMAT], root);
		return { socket, output: result.ok ? result.stdout : null, error: result.ok ? null : result.error };
	});
	const ps = run(["ps", "-A", "-o", "pid=,ppid=,command="], root);
	const identity = target.identity_keys.map(key => {
		const dir = join(config.identity_root, identityDirName(key));
		if (!existsSync(dir) || !statSync(dir).isDirectory()) return { key, dir, files: null };
		const files: Record<string, string> = {};
		for (const name of readdirSync(dir).sort()) {
			const full = join(dir, name);
			const stat = statSync(full, { throwIfNoEntry: false });
			if (stat?.isFile() && stat.size <= MAX_IDENTITY_BYTES) files[name] = readFileSync(full, "utf8");
		}
		return { key, dir, files };
	});
	return {
		schema: "fleet-round.raw/v1",
		project,
		root,
		captured_at,
		br: { version, list, show: JSON.stringify(shown), ready, policy_yaml: existsSync(policyPath) ? readFileSync(policyPath, "utf8") : null },
		git: { repo, ref: target.doc_ref, head, ls_files: lsFiles },
		docs,
		seats: { tmux, ps: ps.ok ? ps.stdout : null, identity_root: config.identity_root, identity, agent_markers: config.agent_markers },
	};
}
