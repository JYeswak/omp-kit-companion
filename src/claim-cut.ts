/** CUTCLAIM1: one admission policy for native preflight and the tool-call guard.
 * Reads are supplied by their bounded, tracker-bound readers; no tracker mutation occurs here.
 * Leverage #5 (rules): a claim cannot escape the operator's declared cut through another entry point.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
	code: "CLAIM_CUT_ADMITTED" | "CLAIM_OUT_OF_CUT" | "CLAIM_CUT_UNKNOWN";
	blocking: boolean;
	detail: string;
	remedy: string;
	cut: string | null;
	alternative: string | null;
}

type Row = Record<string, unknown>;
type Cut = { epic: string; pinned: string[] };
const MAX_BYTES = 1024 * 1024;
// Bulk reads (CUTREADBULK1) list every active bead at once, so the node cap bounds memory, not process count; the
// live omp-kit tracker held 1,607 active beads on 2026-11-02.
const MAX_NODES = 20_000;
const MAX_EDGES = 4096;
const GRAPH_DEADLINE_MS = 20_000;
const ACTIVE: Record<string, true> = { open: true, in_progress: true, rework: true, blocked: true, in_review: true };
const GATED: Record<string, true> = { "human-gate": true, "owner-decision": true, "kind:process": true, "needs-director": true };

function record(value: unknown): value is Row {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096 && value.trim() === value;
}

/** An explicit DB overrides the caller's cwd; never select the cwd's unrelated session row. */
function trackerRepo(input: ClaimCutInput, env: Record<string, string | undefined>): { repo: string; customDatabase: boolean } {
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
		const directory = dirname(database);
		return basename(directory) === ".beads"
			? { repo: realpathSync(dirname(directory)), customDatabase: false }
			: { repo: realpathSync(directory), customDatabase: true };
	}
	if (env.BEADS_DIR) {
		const directory = realpathSync(resolve(input.repo, env.BEADS_DIR));
		return basename(directory) === ".beads"
			? { repo: realpathSync(dirname(directory)), customDatabase: false }
			: { repo: directory, customDatabase: true };
	}
	for (let dir = realpathSync(input.repo); ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".beads"))) return { repo: dir, customDatabase: false };
		if (dirname(dir) === dir) break;
	}
	return { repo: realpathSync(input.repo), customDatabase: false };
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

function configuredCut(input: ClaimCutInput, env: Record<string, string | undefined>): Cut | null {
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
	if (config.sessions.length === 0) return null;
	const binding = trackerRepo(input, env);
	const matches: (Cut | null)[] = [];
	for (const session of config.sessions) {
		if (!record(session) || !nonempty(session.repo) || !isAbsolute(session.repo)) throw new Error("fleet-watch session repo is malformed");
		// Absent foreign checkouts do not prevent a claim in this tracker.
		let sessionRepo: string;
		try { sessionRepo = realpathSync(session.repo); } catch { sessionRepo = resolve(session.repo); }
		if (sessionRepo !== binding.repo) {
			if (!binding.customDatabase) continue;
			// A custom DB inside a managed checkout cannot escape its declared cut.
			const within = relative(sessionRepo, binding.repo);
			if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
		}
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
/** `issues` of a paged br list/blocked envelope (or a bare array); a page with more rows is a partial graph. */
function allIssues(value: unknown, what: string): unknown[] {
	if (Array.isArray(value)) return value;
	if (!record(value) || !Array.isArray(value.issues) || value.has_more === true) throw new Error(`${what} returned a partial or malformed page`);
	return value.issues;
}

/** No declared cut admits without bead reads; configured invalid authority and bounded graph failures refuse. */
export async function admitClaimCut(input: ClaimCutInput): Promise<ClaimCutVerdict> {
	let cut: Cut | null = null;
	let alternative: string | null = null;
	const verdict = (code: ClaimCutVerdict["code"], detail: string, remedy: string): ClaimCutVerdict => ({
		code, blocking: code !== "CLAIM_CUT_ADMITTED", detail, remedy, cut: cut?.epic ?? null, alternative,
	});
	try {
		const env = input.env ?? process.env;
		cut = configuredCut(input, env);
		if (cut === null) return verdict("CLAIM_CUT_ADMITTED", `${input.id}: no declared milestone`, "continue with the remaining claim checks");
		const deadline = Date.now() + GRAPH_DEADLINE_MS;
		const read = async (args: string[]): Promise<unknown> => {
			if (Date.now() >= deadline) throw new Error("cut graph read deadline exceeded");
			const value = await input.read(args);
			if (Date.now() >= deadline) throw new Error("cut graph read deadline exceeded");
			return value;
		};
		const candidate = beadRow(input.bead ?? await read(["show", input.id, "--json"]), input.id);
		if (candidate.status === "open" && cut.pinned.includes(input.id)) return verdict("CLAIM_CUT_ADMITTED", `${input.id}: explicit pin in cut ${cut.epic}`, "continue with the remaining claim checks");
		// CUTREADBULK1 (ompkit-774u.55.2): bulk reads, never one subprocess per bead. Measured 2026-11-02 on the live
		// tracker: the per-bead walk made 128 serial reads for one unpinned claim and ended CLAIM_CUT_UNKNOWN at the
		// deadline; `br list` of the 1,607 active beads took 0.37 s and `br blocked` 0.2 s, while a batched `br show` of
		// the 43 pins took 5.3 s. `br blocked` lists every blocker kind (blocks, waits-for, conditional-blocks) and a
		// child's parent (measured on a native scratch tracker), so it is only a SUPERSET screen: a bead it cannot reach
		// is out of cut, and a bead it reaches is admitted only along typed `blocks` edges read by batched `show`.
		// `--status all`: a stock tracker has no rework/in_review statuses, and naming them is VALIDATION_FAILED (rc 4).
		// `--fields`: the full rows of the live tracker are 7.8 MB, past the 4 MiB claim-read cap (preflight.ts); these
		// four fields are 0.27 MB (measured 2026-11-03, 2,414 beads).
		const listed = allIssues(await read(["list", "--status", "all", "--fields", "id,status,assignee,labels", "--json", "--limit", "0"]), "br list");
		if (listed.length > MAX_NODES) throw new Error(`cut graph exceeds ${MAX_NODES} beads`);
		const active = new Map<string, Row>();
		for (const raw of listed) {
			const row = beadRow(raw, record(raw) && typeof raw.id === "string" ? raw.id : "<missing id>");
			if (typeof row.status === "string" && ACTIVE[row.status] === true) active.set(row.id as string, row);
		}
		const screen = new Map<string, string[]>();
		for (const raw of allIssues(await read(["blocked", "--json", "--limit", "0"]), "br blocked")) {
			if (!record(raw) || !nonempty(raw.id) || !Array.isArray(raw.blocked_by) || !raw.blocked_by.every(nonempty)) throw new Error("malformed blocked row");
			screen.set(raw.id, raw.blocked_by as string[]);
		}
		const activePins = cut.pinned.filter(id => active.has(id));
		for (const id of cut.pinned) if (alternative === null && active.has(id) && eligiblePin(active.get(id)!)) alternative = id;
		// Typed `blocks` prerequisites, read by batched `show` only for the beads that need them.
		const typed = new Map<string, string[]>();
		const loadTyped = async (ids: string[]): Promise<void> => {
			const missing = [...new Set(ids)].filter(id => !typed.has(id));
			if (missing.length === 0) return;
			const shown = await read(["show", ...missing, "--json"]);
			const list = Array.isArray(shown) ? shown : [shown];
			if (list.length !== missing.length) throw new Error(`bulk read returned ${list.length} rows for ${missing.length} beads`);
			for (const raw of list) {
				if (!record(raw) || !nonempty(raw.id) || !missing.includes(raw.id)) throw new Error("malformed bulk show row");
				const deps = raw.dependencies ?? [];
				if (!Array.isArray(deps)) throw new Error(`malformed dependency graph for ${raw.id}`);
				const prerequisites: string[] = [];
				for (const dep of deps) {
					if (!record(dep) || !nonempty(dep.id) || !nonempty(dep.dependency_type)) throw new Error(`malformed dependency edge for ${raw.id}`);
					if (dep.dependency_type === "blocks") prerequisites.push(dep.id);
				}
				typed.set(raw.id, prerequisites);
			}
		};
		// `br blocked` omits in_progress beads, so their typed edges join the screen (2 such beads live on 2026-11-02).
		const inProgress = [...active.values()].filter(row => row.status === "in_progress").map(row => row.id as string);
		await loadTyped(inProgress);
		for (const id of inProgress) screen.set(id, typed.get(id)!);
		const parent = new Map<string, string | null>(activePins.map(id => [id, null]));
		const queue = [...activePins];
		let edgeCount = 0;
		for (let index = 0; index < queue.length && !parent.has(input.id); index++) {
			const prerequisites = screen.get(queue[index]!) ?? [];
			edgeCount += prerequisites.length;
			if (edgeCount > MAX_EDGES) throw new Error(`cut graph exceeds ${MAX_EDGES} edges`);
			for (const dep of prerequisites) {
				if (!active.has(dep) || parent.has(dep)) continue;
				parent.set(dep, queue[index]!);
				queue.push(dep);
			}
		}
		let admitted = false;
		if (candidate.status === "open" && parent.has(input.id)) {
			// Confirm the screened path hop by hop with typed edges; if a hop is not `blocks` (waits-for,
			// conditional-blocks or an inherited parent), search typed `blocks` edges level by level over active beads.
			const path: string[] = [];
			for (let at = parent.get(input.id) ?? null; at !== null; at = parent.get(at) ?? null) path.unshift(at);
			await loadTyped(path);
			admitted = path.every((id, i) => typed.get(id)!.includes(i + 1 < path.length ? path[i + 1]! : input.id));
			let frontier = admitted ? [] : [...activePins];
			const seen = new Set(activePins);
			while (!admitted && frontier.length > 0) {
				await loadTyped(frontier);
				const next: string[] = [];
				for (const id of frontier) for (const dep of typed.get(id)!) {
					if (!active.has(dep) || seen.has(dep)) continue;
					seen.add(dep);
					next.push(dep);
				}
				admitted = seen.has(input.id);
				frontier = next;
			}
		}
		if (admitted) return verdict("CLAIM_CUT_ADMITTED", `${input.id}: open blocks prerequisite in cut ${cut.epic}`, "continue with the remaining claim checks");
		return verdict("CLAIM_OUT_OF_CUT", `${input.id} is outside declared cut ${cut.epic}; nearest eligible pinned alternative: ${alternative ?? "none (no open eligible pin)"}`,
			alternative ? `claim pinned ${alternative} instead` : `ask the cut owner to resolve the pinned work for ${cut.epic}`);
	} catch (error) {
		return verdict("CLAIM_CUT_UNKNOWN", `${input.id}: cut admission inconclusive: ${error instanceof Error ? error.message : String(error)}`, "restore the configured cut and bounded tracker graph reads before claiming");
	}
}
