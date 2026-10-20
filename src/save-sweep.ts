/** save-sweep.ts — designated-committer save sweep, packaged for the
 * jeff-planning-enhanced committer-cycle consumer (SKILL.md step 7).
 *
 * Source: docs/core8/prompts/save-sweep.md (private prompt). Two stale source
 * instructions are deliberately NOT packaged here:
 *  - "the fleet is idle: force_release_file_reservation it" — unsafe on an
 *    active fleet. Live reservations are never force-released; held paths stay
 *    stranded and byte-identical.
 *  - "everything else is work: commit it" — too broad. Only paths that pass
 *    the reservation/hold validator AND the generated/junk/secret screens are
 *    eligible; the rest strand with an explicit reason or UNKNOWN.
 *
 * The planner never edits file contents: it emits commit groups (explicit
 * paths, grouped by top-level directory), a push permission verdict, and the
 * strand list. The named committer executes the groups with explicit-path
 * `git add`, guarded commit, conditional push, then releases only its own
 * reservations and re-audits.
 */
import type { WorkRepoReport } from "./work-doctor.ts";

export interface SweepDirtyPath {
	path: string;
	size_bytes: number | null;
	secret_flag: boolean;
}

export interface SweepAssignment {
	repo_path: string;
	committer: string;
}

export interface SweepHold {
	path: string;
	/** Agent Mail id (bead) behind the hold; null/empty means no AM id. */
	bead: string | null;
	holder: string;
}

export interface SweepCommitGroup {
	dir: string;
	paths: string[];
}

export interface SweepStrand {
	path: string;
	reason: string;
}

export interface RepoSweepPlan {
	repo_path: string;
	committer: string | null;
	outcome: "plan" | "refuse" | "nothing-stranded";
	refusal: string | null;
	groups: SweepCommitGroup[];
	push_permitted: boolean;
	push_reason: string;
	stranded: SweepStrand[];
	unknowns: string[];
	/** Own reservation patterns the committer releases after a permitted push. */
	releasable: string[];
}

export interface ValidatedHolds {
	live: SweepHold[];
	stranded: SweepStrand[];
}

export type HoldValidator = (holds: readonly SweepHold[]) => ValidatedHolds;

const OWNER_NAMES: Record<string, true> = { josh: true, joshua: true };

/**
 * Named control SAVE_SWEEP_HOLD_VALIDATOR: a hold strands unless it carries an
 * agent-decided AM id (bead) from a non-owner holder. Holds with no AM id or
 * addressed to Josh strand explicitly; they are never committed and never
 * force-released. Removing this validator fails its named test.
 */
export function validateSweepHolds(holds: readonly SweepHold[]): ValidatedHolds {
	const live: SweepHold[] = [];
	const stranded: SweepStrand[] = [];
	for (const hold of holds) {
		if (!hold.bead || !hold.bead.trim()) {
			stranded.push({ path: hold.path, reason: "hold-no-am-id" });
			continue;
		}
		if (OWNER_NAMES[hold.holder.trim().toLowerCase()] === true) {
			stranded.push({ path: hold.path, reason: "hold-addressed-to-owner" });
			continue;
		}
		live.push(hold);
	}
	return { live, stranded };
}

const GENERATED_PARTS: Record<string, true> = {
	node_modules: true, ".venv": true, target: true, var: true, ".git": true, __pycache__: true,
};
const GENERATED_SUFFIXES = [".log", ".DS_Store", ".db-wal", ".db-shm", ".db-journal", ".lock"];

function isGenerated(path: string): boolean {
	const parts = path.split("/");
	if (parts.some((part) => GENERATED_PARTS[part] === true)) return true;
	if (path === ".DS_Store" || path.endsWith("/.DS_Store")) return true;
	return GENERATED_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

export function planRepoSweep(input: {
	repo: WorkRepoReport;
	dirty: readonly SweepDirtyPath[];
	assignments: readonly SweepAssignment[];
	holds: readonly SweepHold[];
	validator: HoldValidator | null | undefined;
	ownReservations: readonly string[];
}): RepoSweepPlan {
	const base = {
		repo_path: input.repo.path,
		groups: [],
		stranded: [],
		unknowns: [],
		releasable: [],
	} as const;
	if (input.validator === null || input.validator === undefined) {
		return {
			...base, committer: null, outcome: "refuse",
			refusal: "SAVE_SWEEP_HOLD_VALIDATOR_REQUIRED",
			push_permitted: false, push_reason: "refused: no hold validator",
		};
	}
	const mine = input.assignments.filter((a) => a.repo_path === input.repo.path);
	if (mine.length > 1) {
		return {
			...base, committer: null, outcome: "refuse",
			refusal: "two-committers-for-one-repo",
			push_permitted: false, push_reason: "refused: committer ambiguous",
		};
	}
	if (mine.length === 0) {
		return {
			...base, committer: null, outcome: "refuse",
			refusal: "no-committer-configured",
			push_permitted: false, push_reason: "refused: no committer",
		};
	}
	const committer = mine[0]!.committer;
	if (input.repo.status === "UNKNOWN" || input.repo.status === "TIMED_OUT") {
		return {
			...base, committer, outcome: "refuse",
			refusal: `repo-${input.repo.status.toLowerCase()}`,
			push_permitted: false, push_reason: "refused: repo not readable",
		};
	}
	const { live, stranded } = input.validator(input.holds);
	const rejectedByValidator: Record<string, string> = {};
	for (const strand of stranded) rejectedByValidator[strand.path] = strand.reason;
	const strandedOut: SweepStrand[] = [...stranded];
	const unknowns: string[] = [];
	const eligible: string[] = [];
	for (const file of input.dirty) {
		if (rejectedByValidator[file.path] !== undefined) continue;
		const covering = live.find((hold) =>
			file.path === hold.path || file.path.startsWith(hold.path.endsWith("/") ? hold.path : hold.path + "/"));
		if (covering) {
			strandedOut.push({ path: file.path, reason: `live-hold:${covering.bead}` });
			continue;
		}
		if (file.secret_flag) {
			strandedOut.push({ path: file.path, reason: "secret-flagged" });
			continue;
		}
		if (file.size_bytes !== null && file.size_bytes > 10 * 1024 * 1024) {
			strandedOut.push({ path: file.path, reason: "over-10mb" });
			continue;
		}
		if (isGenerated(file.path)) {
			strandedOut.push({ path: file.path, reason: "generated-gitignore-candidate" });
			continue;
		}
		if (file.size_bytes === null) {
			unknowns.push(file.path);
			continue;
		}
		eligible.push(file.path);
	}
	if (eligible.length === 0 && strandedOut.length === 0 && unknowns.length === 0) {
		return {
			...base, committer, outcome: "nothing-stranded",
			refusal: null, stranded: strandedOut, unknowns,
			push_permitted: false, push_reason: "nothing to sweep",
		};
	}
	const byDir = new Map<string, string[]>();
	for (const path of eligible) {
		const slash = path.indexOf("/");
		const dir = slash < 0 ? "." : path.slice(0, slash);
		const list = byDir.get(dir) ?? [];
		list.push(path);
		byDir.set(dir, list);
	}
	const groups: SweepCommitGroup[] = [...byDir.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([dir, paths]) => ({ dir, paths: [...paths].sort() }));
	const push_permitted = input.repo.has_remote === true && input.repo.has_upstream === true && !input.repo.detached;
	const push_reason = !input.repo.has_remote
		? "no-remote: commit locally only"
		: input.repo.has_upstream !== true
			? "branch-absent-remotely: commit locally only"
			: input.repo.detached === true
				? "detached: commit locally only"
				: "origin-owned-and-branch-present: push permitted";
	return {
		repo_path: input.repo.path, committer,
		outcome: "plan", refusal: null, groups,
		push_permitted, push_reason,
		stranded: strandedOut, unknowns,
		releasable: push_permitted ? [...input.ownReservations] : [],
	};
}

/**
 * Re-audit after the committer runs: the only acceptable leftovers are
 * explicitly stranded paths and UNKNOWNs. Returns the offending paths.
 */
export function reauditSweep(plan: RepoSweepPlan, remaining: readonly string[]): string[] {
	const allowed = new Set([...plan.stranded.map((s) => s.path), ...plan.unknowns]);
	return remaining.filter((path) => !allowed.has(path));
}

export interface SweepSchedule { interval_minutes: number; }

/** Save-sweep cadence from the fleet overlay (`[fleet] sweep_interval_minutes`). Default 90; the designated-committer sweep runs every 1-2h, so values outside 60-120 fail closed. */
export function parseSweepSchedule(fleet: Record<string, unknown>): SweepSchedule {
	const raw = fleet.sweep_interval_minutes ?? 90;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 60 || raw > 120) throw new Error("LESSONS_CONFIG_SWEEP_INTERVAL_INVALID");
	return { interval_minutes: raw };
}

/**
 * One named committer per repo from the existing fleet overlay's raw repo
 * rows (`fleet.toml` repo `committer`), keyed by repo name so the caller can
 * join against resolved `readUserFleetRepos` rows. Rows without a committer
 * get no sweep; invalid names or committers fail closed. Two committers for
 * one repo is refused later by planRepoSweep, not here.
 */
export function sweepCommittersByName(reposValue: unknown): Record<string, string> {
	if (!Array.isArray(reposValue)) throw new Error("SAVE_SWEEP_REPOS_INVALID");
	const committers: Record<string, string> = {};
	reposValue.forEach((value, index) => {
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`SAVE_SWEEP_REPO_${index}_INVALID`);
		const row = value as Record<string, unknown>;
		if (typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.name)) throw new Error(`SAVE_SWEEP_REPO_${index}_NAME_INVALID`);
		if (row.committer === undefined || row.committer === null) return;
		if (typeof row.committer !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.committer)) throw new Error(`SAVE_SWEEP_REPO_${index}_COMMITTER_INVALID`);
		committers[row.name] = row.committer;
	});
	return committers;
}
