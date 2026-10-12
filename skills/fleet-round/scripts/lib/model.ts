// Parse a raw capture bundle (exact br / git / tmux / ps / identity-file output) into the model
// the checks read. Every field name and enum used here was observed on a real host; the REA
// evidence ids for each are listed in references/evidence.md. A shape that differs from the
// observation throws ShapeError naming the field, so a changed br contract fails closed instead of
// being read as zero beads.
import { createHash } from "node:crypto";

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
	seats: {
		/** Output of `tmux list-panes -a -F <PANE_FORMAT>` per socket, or null with the reason it was unavailable. */
		tmux: { socket: string; output: string | null; error: string | null }[];
		/** Output of `ps -A -o pid=,ppid=,command=`, or null. */
		ps: string | null;
		identity_root: string;
		/** Identity directory contents per project key: { key, dir, files: {name: content} } or files null when the directory is absent. */
		identity: { key: string; dir: string; files: Record<string, string> | null }[];
		agent_markers: string[];
	};
};

export const PANE_FORMAT = "#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_index}\t#{pane_index}";

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

export type Pane = { seat: string; pane_id: string; pane_pid: number; socket: string; composite: string; agent: string | null };
export type Binding = { name: string; verified: boolean; stale: boolean; file: string };
export type SeatView = {
	available: boolean;
	reasons: string[];
	panes: Pane[];
	/** Bindings per pane seat: names bound to that pane in the scanned identity directories. */
	bindings: Map<string, Binding[]>;
};

/** Agent Mail identity directory name: first 12 hex chars of SHA-1(project_key) (mcp_agent_mail_rust pane_identity.rs project_hash; observed dirs). */
export function identityDirName(projectKey: string): string {
	return createHash("sha1").update(projectKey).digest("hex").slice(0, 12);
}

/** Agent Mail pane-key sanitizer (pane_identity.rs sanitize_pane_id): strip one leading %, keep [A-Za-z0-9-_], `:`→`-`, others→`_`. */
export function sanitizePaneKey(paneId: string): string {
	const stripped = paneId.startsWith("%") ? paneId.slice(1) : paneId;
	let out = "";
	for (const ch of stripped) {
		const code = ch.charCodeAt(0);
		const alnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		out += alnum || ch === "-" || ch === "_" ? ch : ch === ":" ? "-" : "_";
	}
	return out === "" ? "unknown" : out;
}

/** An identity file's content: plain-text name (source contract) or JSON {name, pane_pid?, pane_id?} (observed on this host). */
function parseBinding(content: string, pane: Pane, file: string): Binding | null {
	const trimmed = content.trim();
	if (trimmed === "") return null;
	if (!trimmed.startsWith("{")) return { name: trimmed, verified: false, stale: false, file };
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || !("name" in parsed) || typeof parsed.name !== "string") return null;
	const name = parsed.name;
	const panePid = "pane_pid" in parsed ? parsed.pane_pid : undefined;
	if (typeof panePid !== "number") return { name, verified: false, stale: false, file };
	const boundPane = "pane_id" in parsed ? parsed.pane_id : undefined;
	const live = panePid === pane.pane_pid && (boundPane === undefined || boundPane === pane.pane_id);
	return { name, verified: live, stale: !live, file };
}

export function parseSeats(bundle: RawBundle): SeatView {
	const reasons: string[] = [];
	const panes: Pane[] = [];
	const { seats } = bundle;
	if (seats.ps === null) reasons.push("ps output unavailable: agent processes cannot be observed");
	const children = new Map<number, number[]>();
	const command = new Map<number, string>();
	for (const raw of (seats.ps ?? "").split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		const first = line.indexOf(" ");
		const rest = line.slice(first + 1).trimStart();
		const second = rest.indexOf(" ");
		const pid = Number(line.slice(0, first));
		const ppid = Number(rest.slice(0, second < 0 ? undefined : second));
		if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
		command.set(pid, second < 0 ? "" : rest.slice(second + 1));
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	const agentIn = (root: number): string | null => {
		const stack = [root];
		const seen = new Set<number>();
		while (stack.length > 0) {
			const pid = stack.pop()!;
			if (seen.has(pid)) continue;
			seen.add(pid);
			const text = command.get(pid);
			if (text !== undefined && !text.includes("__omp_worker")) {
				const argv = text.split(" ").filter(Boolean).slice(0, 2);
				if (argv.some(arg => seats.agent_markers.some(marker => arg.endsWith(marker)))) return text;
			}
			stack.push(...(children.get(pid) ?? []));
		}
		return null;
	};
	const reachable = seats.tmux.filter(entry => entry.output !== null);
	if (reachable.length === 0) reasons.push(`tmux unavailable on every configured socket (${seats.tmux.map(t => `${t.socket}: ${t.error ?? "no output"}`).join("; ") || "none configured"})`);
	for (const entry of reachable) {
		for (const raw of entry.output!.split("\n")) {
			if (raw.trim() === "") continue;
			const fields = raw.split("\t");
			if (fields.length !== 6) throw new ShapeError(`tmux list-panes (${entry.socket}): expected 6 tab-separated fields, got ${fields.length}: ${JSON.stringify(raw.slice(0, 120))}`);
			const [seat, paneId, pid, session, window, index] = fields as [string, string, string, string, string, string];
			const panePid = Number(pid);
			if (!Number.isInteger(panePid)) throw new ShapeError(`tmux list-panes: pane_pid ${JSON.stringify(pid)} is not an integer`);
			panes.push({ seat, pane_id: paneId, pane_pid: panePid, socket: entry.socket, composite: `${session}:${window}:${index}`, agent: seats.ps === null ? null : agentIn(panePid) });
		}
	}
	const bindings = new Map<string, Binding[]>();
	const present = seats.identity.filter(dir => dir.files !== null);
	if (present.length === 0) reasons.push(`no Agent Mail identity directory exists for ${seats.identity.map(d => `${d.key} (${d.dir})`).join(", ") || "any project key"}`);
	for (const pane of panes) {
		const found: Binding[] = [];
		for (const dir of present) {
			for (const key of [sanitizePaneKey(pane.pane_id), sanitizePaneKey(pane.composite)]) {
				const content = dir.files![key];
				if (content === undefined) continue;
				const binding = parseBinding(content, pane, `${dir.dir}/${key}`);
				if (binding) found.push(binding);
			}
		}
		bindings.set(pane.seat, found);
	}
	return { available: reasons.length === 0, reasons, panes, bindings };
}

export type Holder = { status: "LIVE" | "DEAD" | "UNKNOWN"; seat: string | null; reason: string };

/**
 * Liveness of a bead holder. LIVE: a pane running an agent process carries a verified binding
 * (identity file pane_pid equals the live pane_pid) to the name. UNKNOWN: a source is unavailable,
 * or the only bindings to the name are unverified (plain-text or pid-less legacy files) on agent
 * panes. DEAD: every source was read and no agent pane carries any binding to the name.
 */
export function holderStatus(name: string | null, view: SeatView): Holder {
	if (!name) return { status: "DEAD", seat: null, reason: "bead has no assignee" };
	if (!view.available) return { status: "UNKNOWN", seat: null, reason: view.reasons.join("; ") };
	let unverified: string | null = null;
	let stale: string | null = null;
	for (const pane of view.panes) {
		for (const binding of view.bindings.get(pane.seat) ?? []) {
			if (binding.name !== name) continue;
			if (pane.agent === null) {
				stale ??= `${pane.seat} binds ${name} (${binding.file}) but runs no agent process`;
				continue;
			}
			if (binding.verified) return { status: "LIVE", seat: pane.seat, reason: `verified binding ${binding.file} (pane_pid ${pane.pane_pid})` };
			if (binding.stale) stale ??= `${pane.seat} binding ${binding.file} names ${name} for an earlier pane_pid`;
			else unverified ??= `${pane.seat} binds ${name} via unverified identity file ${binding.file} (no pane_pid)`;
		}
	}
	if (unverified) return { status: "UNKNOWN", seat: null, reason: unverified };
	return { status: "DEAD", seat: null, reason: stale ?? `no agent pane binds ${name} in the scanned identity directories` };
}
