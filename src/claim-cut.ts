/** CUTCLAIM1: one admission policy for native preflight and the tool-call guard.
 * Reads are supplied by their bounded, tracker-bound readers; no tracker mutation occurs here.
 * Leverage #5 (rules): a claim cannot escape the operator's declared cut through another entry point.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type ClaimCutRead = (args: string[]) => Promise<unknown>;
export interface ClaimCutInput {
	repo: string;
	id: string;
	env?: Record<string, string | undefined>;
	home?: string;
	db?: string;
	/** Raw br show row already read at this boundary, when available. */
	bead?: unknown;
	read: ClaimCutRead;
}
export interface ClaimCutVerdict {
	code: "CLAIM_CUT_ADMITTED" | "CLAIM_OUT_OF_CUT" | "CLAIM_PILLAR_REQUIRED" | "CLAIM_CUT_UNKNOWN";
	blocking: boolean;
	detail: string;
	remedy: string;
	cut: string | null;
	alternative: string | null;
}

type Row = Record<string, unknown>;
type Cut = { epic: string; pinned: string[] };
const MAX_BYTES = 1024 * 1024;
const MAX_NODES = 128;
const MAX_EDGES = 4096;
const GRAPH_DEADLINE_MS = 10000;
const ACTIVE: Record<string, true> = { open: true, in_progress: true, rework: true, blocked: true, in_review: true };
const GATED: Record<string, true> = { "human-gate": true, "owner-decision": true, "kind:process": true, "needs-director": true };

function record(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value;
}

/** An explicit DB overrides the caller's cwd; never select the cwd's unrelated session row. */
function trackerRepo(input: ClaimCutInput, env: Record<string, string | undefined>): string {
	const db = input.db ?? env.BEADS_DB;
	if (db) {
		let database = resolve(input.repo, db);
		let present = false;
		try { lstatSync(database); present = true; } catch (error) {
			if (!record(error) || error.code !== "ENOENT") throw error;
		}
		if (present) database = realpathSync(database);
		else {
			// Virtual read-only fixtures may omit the file; canonicalize their nearest existing parent.
			// lstat stops at a dangling link so realpath refuses it instead of falling back to its spelling.
			let parent = dirname(database);
			let suffix = basename(database);
			for (;;) {
				try { lstatSync(parent); break; } catch (error) {
					if (!record(error) || error.code !== "ENOENT") throw error;
					suffix = join(basename(parent), suffix);
					parent = dirname(parent);
				}
			}
			database = join(realpathSync(parent), suffix);
		}
		if (basename(dirname(database)) !== ".beads") throw new Error("explicit tracker DB has no canonical .beads repository binding");
		return realpathSync(dirname(dirname(database)));
	}
	if (env.BEADS_DIR) {
		const directory = resolve(input.repo, env.BEADS_DIR);
		if (basename(directory) !== ".beads") throw new Error("BEADS_DIR has no canonical .beads repository binding");
		return realpathSync(dirname(directory));
	}
	for (let dir = realpathSync(input.repo); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".beads"))) return dir;
		if (dirname(dir) === dir) break;
	}
	return realpathSync(input.repo);
}

function readConfig(path: string): unknown {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > MAX_BYTES) throw new Error("fleet-watch config is not a bounded regular file");
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const n = readSync(fd, bytes, length, bytes.length - length, null);
			if (n === 0) break;
			length += n;
		}
		const after = fstatSync(fd);
		if (length > MAX_BYTES || length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("fleet-watch config changed or exceeded its read bound");
		const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
		try { return JSON.parse(source); } catch {
			throw new Error("fleet-watch config is not valid JSON");
		}
	} finally {
		closeSync(fd);
	}
}

function configuredCut(input: ClaimCutInput, repo: string, env: Record<string, string | undefined>): Cut | null {
	const override = env.OMP_KIT_FLEET_WATCH_CONFIG;
	if (override !== undefined && !nonempty(override)) throw new Error("OMP_KIT_FLEET_WATCH_CONFIG is empty");
	const path = override ?? join(env.XDG_CONFIG_HOME ?? join(input.home ?? env.HOME ?? homedir(), ".config"), "omp-kit", "fleet-watch.json");
	let config: unknown;
	try { config = readConfig(path); } catch (error) {
		if (override === undefined && record(error) && error.code === "ENOENT") {
			try { lstatSync(path); } catch (missing) {
				if (record(missing) && missing.code === "ENOENT") return null;
				throw missing;
			}
		}
		throw new Error(`cannot read configured cut (${path}): ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!record(config) || !Array.isArray(config.sessions)) throw new Error("fleet-watch sessions is malformed");
	const matches: (Cut | null)[] = [];
	for (const session of config.sessions) {
		if (!record(session) || !nonempty(session.repo) || !isAbsolute(session.repo)) throw new Error("fleet-watch session repo is malformed");
		// Absent foreign checkouts do not prevent a claim in this tracker.
		let sessionRepo: string;
		try { sessionRepo = realpathSync(session.repo); } catch { sessionRepo = resolve(session.repo); }
		if (sessionRepo !== repo) continue;
		if (!("milestone" in session)) { matches.push(null); continue; }
		const milestone = session.milestone;
		if (!record(milestone) || !nonempty(milestone.epic) || !Array.isArray(milestone.pinned)
			|| !milestone.pinned.every(nonempty)
			|| new Set(milestone.pinned).size !== milestone.pinned.length) {
			throw new Error("matching session milestone is malformed (epic, pinned)");
		}
		matches.push({ epic: milestone.epic, pinned: milestone.pinned });
	}
	if (matches.some(cut => JSON.stringify(cut) !== JSON.stringify(matches[0]))) throw new Error("matching tracker sessions disagree about the declared cut");
	return matches[0] ?? null;
}

function beadRow(value: unknown, id: string): Row {
	const row = Array.isArray(value) && value.length === 1 ? value[0] : value;
	if (!record(row) || row.id !== id || !nonempty(row.status)
		|| (row.labels !== undefined && row.labels !== null && (!Array.isArray(row.labels) || !row.labels.every(nonempty)))
		|| (row.assignee !== null && row.assignee !== undefined && typeof row.assignee !== "string")) throw new Error(`malformed bead/labels for ${id}`);
	return row.labels === undefined || row.labels === null ? { ...row, labels: [] } : row;
}
function eligiblePin(row: Row): boolean {
	return row.status === "open" && !row.assignee && Array.isArray(row.labels) && !row.labels.some(label => typeof label === "string" && GATED[label] === true);
}

/** Fail closed on missing authority, invalid config, unreadable graph, or bounded-read exhaustion. */
export async function admitClaimCut(input: ClaimCutInput): Promise<ClaimCutVerdict> {
	let cut: Cut | null = null;
	let alternative: string | null = null;
	const verdict = (code: ClaimCutVerdict["code"], detail: string, remedy: string): ClaimCutVerdict => ({
		code, blocking: code !== "CLAIM_CUT_ADMITTED", detail, remedy, cut: cut?.epic ?? null, alternative,
	});
	try {
		const env = input.env ?? process.env;
		const repo = trackerRepo(input, env);
		cut = configuredCut(input, repo, env);
		const deadline = Date.now() + GRAPH_DEADLINE_MS;
		const read = async (args: string[]): Promise<unknown> => {
			if (Date.now() >= deadline) throw new Error("cut graph read deadline exceeded");
			const value = await input.read(args);
			if (Date.now() >= deadline) throw new Error("cut graph read deadline exceeded");
			return value;
		};
		const candidate = beadRow(input.bead ?? await read(["show", input.id, "--json"]), input.id);
		if (cut === null) {
			if (!Array.isArray(candidate.labels) || !candidate.labels.some(label => typeof label === "string" && /^pillar:\S+$/.test(label))) {
				return verdict("CLAIM_PILLAR_REQUIRED", `${input.id}: no declared milestone in ${repo}; pillar:* label required`, "choose a bead carrying its mission pillar label");
			}
			return verdict("CLAIM_CUT_ADMITTED", `${input.id}: no declared milestone; mission pillar label present`, "continue with the remaining claim checks");
		}
		if (candidate.status === "open" && cut.pinned.includes(input.id)) return verdict("CLAIM_CUT_ADMITTED", `${input.id}: explicit pin in cut ${cut.epic}`, "continue with the remaining claim checks");
		const rows = new Map<string, Row>([[input.id, candidate]]);
		const load = async (id: string): Promise<Row> => {
			const cached = rows.get(id);
			if (cached) return cached;
			if (rows.size >= MAX_NODES) throw new Error(`cut graph exceeds ${MAX_NODES} beads`);
			const row = beadRow(await read(["show", id, "--json"]), id);
			rows.set(id, row);
			return row;
		};
		const activePins: string[] = [];
		for (const id of cut.pinned) {
			const row = await load(id);
			if (typeof row.status === "string" && ACTIVE[row.status] === true) activePins.push(id);
			if (alternative === null && eligiblePin(row)) alternative = id;
		}
		const reachable = new Set(activePins);
		const queue = [...activePins];
		let edgeCount = 0;
		for (let index = 0; index < queue.length; index++) {
			const id = queue[index]!;
			const edges = await read(["dep", "list", id, "--json"]);
			if (!Array.isArray(edges)) throw new Error(`malformed dependency graph for ${id}`);
			edgeCount += edges.length;
			if (edgeCount > MAX_EDGES) throw new Error(`cut graph exceeds ${MAX_EDGES} edges`);
			for (const edge of edges) {
				if (!record(edge) || edge.issue_id !== id || !nonempty(edge.depends_on_id) || !nonempty(edge.type) || !nonempty(edge.status)) throw new Error(`malformed dependency edge for ${id}`);
				if (edge.type !== "blocks" || ACTIVE[edge.status] !== true) continue;
				const dependency = await load(edge.depends_on_id);
				if (typeof dependency.status !== "string" || ACTIVE[dependency.status] !== true) continue;
				if (!reachable.has(edge.depends_on_id)) {
					reachable.add(edge.depends_on_id);
					queue.push(edge.depends_on_id);
				}
			}
		}
		if (candidate.status === "open" && reachable.has(input.id)) return verdict("CLAIM_CUT_ADMITTED", `${input.id}: open blocks prerequisite in cut ${cut.epic}`, "continue with the remaining claim checks");
		return verdict("CLAIM_OUT_OF_CUT", `${input.id} is outside declared cut ${cut.epic}; nearest eligible pinned alternative: ${alternative ?? "none (no open eligible pin)"}`,
			alternative ? `claim pinned ${alternative} instead` : `ask the cut owner to resolve the pinned work for ${cut.epic}`);
	} catch (error) {
		return verdict("CLAIM_CUT_UNKNOWN", `${input.id}: cut admission inconclusive: ${error instanceof Error ? error.message : String(error)}`, "restore the configured cut and bounded tracker graph reads before claiming");
	}
}
