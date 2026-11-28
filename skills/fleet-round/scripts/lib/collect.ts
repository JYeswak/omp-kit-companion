// Read-only tracker, repository and native Tern capture; no legacy identity directories.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { missionCandidates } from "./checks.ts";
import { runSync } from "../../../../src/kitlib/run.ts";
import { ternPaneId } from "../../../../src/plane-tern.ts";
import { isRecord, type RawBundle } from "./model.ts";

export const CONFIG_SCHEMA = "fleet-round.config/v1";
const BR_READ = ["--json", "--no-auto-import", "--no-auto-flush"];
const SHOW_CHUNK = 200;
const MAX_DOC_BYTES = 2 * 1024 * 1024;
/** A configured expected local seat; not itself proof of an installed pane. */
export type SeatConfig = { session: string; pane: string };
export type ProjectConfig = { root: string; repo: string; doc_ref: string; holders: Record<string, SeatConfig>; director: SeatConfig | null };
/** Barrier phases and the report PHASE each one closes (round 0's execute phase is the sort). */
export const BARRIER_PHASES = { INSIGHT: "insight", AGREE: "agree", SORT: "execute" } as const;
export type BarrierPhase = keyof typeof BARRIER_PHASES;
export type BarrierConfig = { board_channel: string | null; hours: Record<BarrierPhase, number>; deliver: boolean };
export type Config = {
	projects: Record<string, ProjectConfig>;
	chief: SeatConfig | null;
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
	const projects: Record<string, ProjectConfig> = Object.create(null);
	for (const [name, value] of Object.entries(json.projects)) {
		if (!isRecord(value) || typeof value.root !== "string") throw new Error(`${where}: projects.${name}.root must be a path`);
		const root = resolve(expand(value.root));
		const repo = value.repo === undefined ? root : typeof value.repo === "string" ? resolve(expand(value.repo)) : null;
		const ref = value.doc_ref === undefined ? "HEAD" : value.doc_ref;
		if (repo === null || typeof ref !== "string" || ref === "") throw new Error(`${where}: projects.${name}.repo and doc_ref must be strings`);
		const holders: Record<string, SeatConfig> = Object.create(null);
		if (value.holders !== undefined && !isRecord(value.holders)) throw new Error(`${where}: projects.${name}.holders must be an object`);
		const holderEntries = Object.entries(value.holders ?? {});
		if (holderEntries.length > 64) throw new Error(`${where}: projects.${name}.holders exceeds 64 seats`);
		const panes = new Set<string>();
		for (const [holder, rawSeat] of holderEntries) {
			const field = `${where}: projects.${name}.holders.${holder}`;
			const binding = seat(rawSeat, field);
			if (!holder.trim() || !binding || !binding.pane.startsWith("tern:") || ternPaneId(binding.pane) === null || panes.has(binding.pane))
				throw new Error(`${field}: expected an unambiguous exact Tern pane`);
			holders[holder] = binding;
			panes.add(binding.pane);
		}
		projects[name] = { root, repo, doc_ref: ref, holders, director: seat(value.director, `${where}: projects.${name}.director`) };
	}
	const number = (key: string, fallback: number): number => {
		const value = json[key] ?? fallback;
		if (typeof value !== "number" || !(value > 0)) throw new Error(`${where}: ${key} must be a positive number`);
		return value;
	};
	return {
		projects,
		chief: seat(json.chief, `${where}: chief`),
		stale_hours: number("stale_hours", 24),
		frontier_top: number("frontier_top", 3),
		approver: typeof json.approver === "string" ? json.approver : null,
		barrier: json.barrier === undefined ? null : barrierConfig(json.barrier, where),
	};
}

function barrierConfig(value: unknown, where: string): BarrierConfig {
	if (!isRecord(value)) throw new Error(`${where}: barrier must be an object`);
	const hours = isRecord(value.hours) ? value.hours : {};
	const timeboxes = {} as Record<BarrierPhase, number>;
	for (const phase of Object.keys(BARRIER_PHASES) as BarrierPhase[]) {
		const h = hours[phase];
		if (typeof h !== "number" || !(h > 0)) throw new Error(`${where}: barrier.hours.${phase} must be a positive number of hours`);
		timeboxes[phase] = h;
	}
	const deliver = value.deliver === undefined ? false : value.deliver;
	if (typeof deliver !== "boolean") throw new Error(`${where}: barrier.deliver must be a boolean`);
	if (value.chief !== undefined) throw new Error(`${where}: barrier.chief moved to top-level chief`);
	return { board_channel: typeof value.board_channel === "string" && value.board_channel.trim() ? value.board_channel : null,
		hours: timeboxes, deliver };
}

function seat(value: unknown, where: string): SeatConfig | null {
	if (value === undefined) return null;
	if (!isRecord(value) || typeof value.session !== "string" || value.session === "" || typeof value.pane !== "string" || value.pane === "") throw new Error(`${where} must be {session, pane} with non-empty strings`);
	return { session: value.session, pane: value.pane };
}

function run(argv: string[], cwd: string): { ok: boolean; stdout: string; error: string } {
	try {
		const child = runSync(argv, { cwd, env: { ...process.env, NO_COLOR: "1" }, deadline_s: 30,
			max_output_bytes: 16 * 1024 * 1024 });
		const decoder = new TextDecoder();
		const ok = child.rc === 0 && !child.timed_out && !child.killed && !child.truncated;
		return { ok, stdout: ok ? decoder.decode(child.stdout) : "", error: `${argv[0]} ${argv[1]} unavailable (exit ${child.rc})` };
	} catch {
		return { ok: false, stdout: "", error: `${argv[0]} ${argv[1]} could not be started` };
	}
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
	const tern = run(["tern", "inspect", "--json"], root);
	const bindings = Object.entries(target.holders).map(([name, binding]) => {
		const paneId = ternPaneId(binding.pane);
		const observed = tern.ok && paneId !== null ? run(["tern", "process", paneId, "--json"], root) : null;
		return { name, ...binding, process: observed?.ok ? observed.stdout : null };
	});
	return {
		schema: "fleet-round.raw/v1",
		project,
		root,
		captured_at,
		br: { version, list, show: JSON.stringify(shown), ready, policy_yaml: existsSync(policyPath) ? readFileSync(policyPath, "utf8") : null },
		git: { repo, ref: target.doc_ref, head, ls_files: lsFiles },
		docs,
		seats: { tern: tern.ok ? tern.stdout : null, tern_error: tern.ok ? null : tern.error, bindings },
	};
}
