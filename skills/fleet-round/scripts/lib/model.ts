// Replay tracker and native Tern observations into the model used by the round checks.
// Report body text and retired identity files never establish installed seat authority.
// Tracker shape drift throws ShapeError instead of silently yielding zero beads.
import { isAbsolute, relative, sep } from "node:path";
import { discoverTernSeatFromInspection, locateBlock, parseTernJson, parseTernProcess, ternPaneId } from "../../../../src/plane-tern.ts";

export class ShapeError extends Error {}

/** Raw outputs captured read-only from one project's tracker, repo and host. Replayable. */
export type RawBundle = {
	schema: "fleet-round.raw/v1";
	project: string;
	root: string;
	captured_at: string;
	br: { version: string; list: string; show: string; ready: string; policy_yaml: string | null };
	/** The repo whose committed docs hold the mission, the ref read, the commit it resolved to, and that commit's file list. */
	git: { repo: string; ref: string; head: string; ls_files: string };
	/** Committed contents (at git.head) of candidate mission docs: repo-root *.md and docs/**.md, keyed by repo-relative path. */
	docs: Record<string, string>;
	/** Absent or legacy-only captures do not carry current native evidence. */
	seats: {
		tern?: string | null;
		tern_error?: string | null;
		bindings?: { name: string; session: string; pane: string; process: string | null }[];
	};
};


/** br built-in statuses (br schema issue, Status enum) used when a tracker has no policy file. */
export const BR_BUILTIN_STATUSES = ["open", "in_progress", "blocked", "deferred", "draft", "closed", "tombstone", "pinned"];
/** Statuses that mean a worker holds the bead. `in_review` exists only where a policy declares it. */
export const HELD_STATUSES = ["in_progress", "in_review"];

export type Dep = { id: string; type: string; status: string };
export type Comment = { author: string; text: string; created_at: string };
export type Bead = {
	id: string;
	status: string;
	issue_type: string;
	assignee: string | null;
	owner: string | null;
	labels: string[];
	created_at: string;
	updated_at: string;
	closed_at: string | null;
	parent: string | null;
	deps: Dep[];
	comments: Comment[];
};
export type Tracker = { beads: Map<string, Bead>; ready: string[]; statuses: string[]; status_source: string };

function str(row: Record<string, unknown>, key: string, where: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new ShapeError(`${where}: field ${key} is ${value === undefined ? "missing" : typeof value}, expected string`);
	return value;
}

/** br omits null-valued keys (observed: list rows without `assignee`), so absent and null are both null. */
function optStr(row: Record<string, unknown>, key: string, where: string): string | null {
	const value = row[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") throw new ShapeError(`${where}: field ${key} is ${typeof value}, expected string or absent`);
	return value;
}

/** The package's one object guard: a non-null, non-array object. Fields stay unknown. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ShapeError(`${where}: expected a JSON object`);
	return value;
}

function array(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) throw new ShapeError(`${where}: expected a JSON array`);
	return value;
}

function parseJson(text: string, where: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ShapeError(`${where}: output is not JSON (${(error as Error).message})`);
	}
}

/** Declared statuses: `.beads/policy.yaml` workflow.statuses when present, else br's built-in enum. */
export function declaredStatuses(policyYaml: string | null): { statuses: string[]; source: string } {
	if (policyYaml === null) return { statuses: BR_BUILTIN_STATUSES, source: "br built-in Status enum (no .beads/policy.yaml)" };
	const parsed = object(Bun.YAML.parse(policyYaml), ".beads/policy.yaml");
	const workflow = parsed.workflow === undefined ? undefined : object(parsed.workflow, ".beads/policy.yaml workflow");
	if (!workflow || workflow.statuses === undefined) return { statuses: BR_BUILTIN_STATUSES, source: "br built-in Status enum (policy declares no workflow.statuses)" };
	const statuses = array(workflow.statuses, ".beads/policy.yaml workflow.statuses").map((s, i) => {
		if (typeof s !== "string") throw new ShapeError(`.beads/policy.yaml workflow.statuses[${i}] is not a string`);
		return s;
	});
	return { statuses, source: ".beads/policy.yaml workflow.statuses" };
}

export function parseTracker(bundle: RawBundle): Tracker {
	const list = object(parseJson(bundle.br.list, "br list --json"), "br list --json");
	const rows = array(list.issues, "br list --json .issues");
	if (typeof list.total !== "number" || list.total !== rows.length)
		throw new ShapeError(`br list --json: total=${String(list.total)} but ${rows.length} rows (paging not exhausted)`);
	const shown = array(parseJson(bundle.br.show, "br show --json"), "br show --json");
	const beads = new Map<string, Bead>();
	for (const [index, value] of shown.entries()) {
		const where = `br show --json [${index}]`;
		const row = object(value, where);
		const id = str(row, "id", where);
		const deps = array(row.dependencies ?? [], `${where} ${id}.dependencies`).map((dep, j) => {
			const edge = object(dep, `${where} ${id}.dependencies[${j}]`);
			return { id: str(edge, "id", `${id}.dependencies[${j}]`), type: str(edge, "dependency_type", `${id}.dependencies[${j}]`), status: str(edge, "status", `${id}.dependencies[${j}]`) };
		});
		const comments = array(row.comments ?? [], `${where} ${id}.comments`).map((c, j) => {
			const comment = object(c, `${id}.comments[${j}]`);
			return { author: str(comment, "author", `${id}.comments[${j}]`), text: str(comment, "text", `${id}.comments[${j}]`), created_at: str(comment, "created_at", `${id}.comments[${j}]`) };
		});
		const labels = array(row.labels ?? [], `${id}.labels`).map((l, j) => {
			if (typeof l !== "string") throw new ShapeError(`${id}.labels[${j}] is not a string`);
			return l;
		});
		beads.set(id, {
			id,
			status: str(row, "status", where),
			issue_type: str(row, "issue_type", where),
			assignee: optStr(row, "assignee", where),
			owner: optStr(row, "owner", where),
			labels,
			created_at: str(row, "created_at", where),
			updated_at: str(row, "updated_at", where),
			closed_at: optStr(row, "closed_at", where),
			parent: optStr(row, "parent", where),
			deps,
			comments,
		});
	}
	for (const [index, value] of rows.entries()) {
		const id = str(object(value, `br list row ${index}`), "id", `br list row ${index}`);
		if (!beads.has(id)) throw new ShapeError(`br list names ${id} but br show returned no record for it`);
	}
	const ready = array(parseJson(bundle.br.ready, "br ready --json"), "br ready --json").map((value, index) => str(object(value, `br ready [${index}]`), "id", `br ready [${index}]`));
	const { statuses, source } = declaredStatuses(bundle.br.policy_yaml);
	return { beads, ready, statuses, status_source: source };
}

/** Parent of a bead: br's `parent` field (br show), else its parent-child dependency, else the dotted-id prefix when that bead exists. */
export function parentOf(bead: Bead, beads: Map<string, Bead>): { id: string; via: "parent" | "parent-child" | "dotted-id" } | null {
	if (bead.parent) return { id: bead.parent, via: "parent" };
	const edge = bead.deps.find(dep => dep.type === "parent-child");
	if (edge) return { id: edge.id, via: "parent-child" };
	const dot = bead.id.lastIndexOf(".");
	if (dot > 0) {
		const suffix = bead.id.slice(dot + 1);
		const prefix = bead.id.slice(0, dot);
		if (suffix.length > 0 && [...suffix].every(c => c >= "0" && c <= "9") && beads.has(prefix)) return { id: prefix, via: "dotted-id" };
	}
	return null;
}

/** Last activity on a bead: newest of updated_at and its comments' created_at (epoch ms). */
export function lastTouch(bead: Bead): number {
	let newest = Date.parse(bead.updated_at);
	for (const comment of bead.comments) newest = Math.max(newest, Date.parse(comment.created_at));
	return newest;
}

// ---- seats -----------------------------------------------------------------------------------

export type Holder = { status: "LIVE" | "DEAD" | "UNKNOWN"; seat: string | null; reason: string };
type Pane = { seat: string; pane_id: string; pane_pid: number; agent: string };
export type SeatView = { available: boolean; reasons: string[]; panes: Pane[]; holders: Map<string, Holder> };

export function parseSeats(bundle: RawBundle, expected?: Readonly<{
	repo: string; holders: Readonly<Record<string, { session: string; pane: string }>>;
}>): SeatView {
	const result: SeatView = { available: false, reasons: [], panes: [], holders: new Map() };
	const { seats } = bundle;
	if (typeof seats?.tern !== "string") {
		result.reasons.push(typeof seats?.tern_error === "string" ? seats.tern_error : "no native Tern inspect capture");
		return result;
	}
	let root: unknown;
	try { root = parseTernJson(seats.tern); }
	catch { result.reasons.push("Tern inspect is not readable JSON"); return result; }
	if (!isRecord(root) || !Array.isArray(root.panes) || !Array.isArray(root.sessions) ||
		!Array.isArray(seats.bindings) || seats.bindings.length === 0 || !isAbsolute(bundle.git.repo)) {
		result.reasons.push("Tern inventory, repository, or configured holder bindings unavailable");
		return result;
	}
	if (expected && expected.repo !== bundle.git.repo) {
		result.reasons.push("Tern capture names a different repository than the configured project");
		return result;
	}
	const rows = new Map<string, Record<string, unknown>[]>();
	for (const row of root.panes) {
		if (!isRecord(row)) continue;
		const id = ternPaneId(String(row.pane));
		if (id === null) continue;
		const matches = rows.get(id) ?? [];
		matches.push(row);
		rows.set(id, matches);
	}
	const names = new Set<string>(), panes = new Set<string>();
	for (const binding of seats.bindings) {
		if (!isRecord(binding) || typeof binding.name !== "string" || !binding.name.trim() ||
			typeof binding.session !== "string" || !binding.session.trim() || typeof binding.pane !== "string" ||
			!binding.pane.startsWith("tern:") || ternPaneId(binding.pane) === null || names.has(binding.name) || panes.has(binding.pane)) {
			result.reasons.push("invalid or ambiguous configured holder bindings");
			return result;
		}
		names.add(binding.name);
		panes.add(binding.pane);
	}
	for (const { name, session, pane, process } of seats.bindings) {
		const id = ternPaneId(pane)!;
		if (expected) {
			const configured = expected.holders[name];
			if (configured?.pane !== pane || configured.session !== session) {
				const reason = `${name}: captured holder binding does not match the current project configuration`;
				result.reasons.push(reason);
				result.holders.set(name, { status: "UNKNOWN", seat: null, reason });
				continue;
			}
		}
		const matches = rows.get(id);
		const location = locateBlock(root, id, session);
		const row = matches?.length === 1 ? matches[0] : undefined;
		if (location.status === "ok" && row && typeof row.cwd === "string" && isAbsolute(row.cwd)) {
			const fromRepo = relative(bundle.git.repo, row.cwd);
			const inside = fromRepo !== ".." && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo);
			if (inside && typeof row.exited === "number" && Number.isFinite(row.exited)) {
				result.holders.set(name, { status: "DEAD", seat: null, reason: `${name}: the configured ${pane} exited` });
				continue;
			}
			const discovered = discoverTernSeatFromInspection(root, pane, { cwd: bundle.git.repo });
			if (inside && discovered.status === "FOUND" && typeof process === "string") {
				const proof = parseTernProcess(process, bundle.git.repo, id);
				if (proof.status === "FOUND" && proof.foreground.pid > 1) {
					result.panes.push({ seat: pane, pane_id: id, pane_pid: proof.foreground.pid, agent: proof.foreground.name });
					result.holders.set(name, { status: "LIVE", seat: pane, reason: `Tern verified ${name} on ${pane} (foreground pid ${proof.foreground.pid})` });
					continue;
				}
			}
		}
		const reason = `${name}: configured ${pane} has no matching native Tern process proof`;
		result.reasons.push(reason);
		result.holders.set(name, { status: "UNKNOWN", seat: null, reason });
	}
	result.available = result.reasons.length === 0;
	return result;
}

export function holderStatus(name: string | null, view: SeatView): Holder {
	if (!name) return { status: "DEAD", seat: null, reason: "bead has no assignee" };
	const proof = view.holders.get(name);
	if (proof) return proof;
	return { status: "UNKNOWN", seat: null, reason: view.reasons.join("; ") || `${name}: no configured pane binding` };
}
