import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fleetPolicyState } from "./fleet-policy";

/**
 * kit-goal-state (NATIVERESTART1 stale-pause, ompkit-2un74): each fleet seat publishes its live goal
 * state so the self-restart helper can tell a stale journal pause from a live-active goal.
 *
 * Observed journal behaviour on omp 18.18.8: a restored session can come back paused with nothing
 * journaled for the reattach, while the seat's goal is live-active (the journal tail then reports
 * a stale `goal_paused` while the seat keeps working, and the helper would send the paused-seat
 * notice instead of `/goal resume`). The `goal_updated` event stream fires on every live transition
 * the helper examined, so a journal pause with a newer same-goal active sidecar is treated as
 * live-active; every other combination trusts the journal.
 *
 * Source paths examined (installed omp 18.18.8 tree):
 * - node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-goal.ts (`reconcile`, `onThreadResumed`
 *   preserve path, journaling only on explicit persist)
 * - node_modules/@oh-my-pi/pi-coding-agent/src/goals/runtime.ts (`onThreadResumed`, `#commitState`
 *   emit-vs-persist split)
 * under ~/.local/opt/omp-kit/omp-src/18.18.8/.
 *
 * One JSON record per session file under ~/.local/state/omp-kit/goal-state/, rewritten on every
 * goal_updated emission, removed at shutdown. Atomic tmp-and-rename write, owner-only directory.
 */
export interface GoalStateRecord {
	schema: 1;
	/** Realpath of the omp session file this seat writes, as `tern inspect` reports it. */
	session_file: string;
	session_id: string | null;
	/** Tern block id when the seat runs in one; informational only, the reader keys on the file. */
	block: string | null;
	pid: number;
	mode: "goal" | "goal_paused" | "none";
	goal_id: string | null;
	status: string | null;
	updated_at: number | null;
	/** Epoch milliseconds of this observation; the reader requires it newer than the journal pause. */
	written_at: number;
}

/** Where the record for one session file lives: sha1 of its realpath, so the reader needs no listing. */
export function goalStateRecordPath(home: string, sessionFile: string): string {
	const key = createHash("sha1").update(sessionFile).digest("hex").slice(0, 16);
	return join(home, ".local", "state", "omp-kit", "goal-state", `${key}.json`);
}

export interface GoalStateContext {
	cwd?: string;
	sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
}

export interface GoalStateApi {
	on(event: string, handler: (event: never, ctx: GoalStateContext) => unknown): void;
}

export interface GoalStateDeps {
	/** Override homedir (tests). */
	home?: string;
	/** Override process.env (tests). */
	env?: Readonly<Record<string, string | undefined>>;
	/** Override clock (tests). */
	now?: () => number;
	/** Override pid (tests). */
	pid?: number;
}

interface GoalUpdatedEvent {
	goal?: { id?: unknown; status?: unknown; updatedAt?: unknown } | null;
	state?: { enabled?: unknown } | null;
}

export function goalStateMode(event: GoalUpdatedEvent): Pick<GoalStateRecord, "mode" | "goal_id" | "status" | "updated_at"> | null {
	if (event === null || typeof event !== "object") return null;
	const goal = event.goal;
	const state = event.state;
	const id = typeof goal?.id === "string" && goal.id !== "" ? goal.id : null;
	const status = typeof goal?.status === "string" ? goal.status : null;
	const updatedAt = typeof goal?.updatedAt === "number" ? goal.updatedAt : null;
	if (state?.enabled === true && status === "active" && id !== null) {
		return { mode: "goal", goal_id: id, status, updated_at: updatedAt };
	}
	if (id !== null) return { mode: "goal_paused", goal_id: id, status, updated_at: updatedAt };
	if (goal === null || goal === undefined) return { mode: "none", goal_id: null, status, updated_at: updatedAt };
	return null;
}

export default async function kitGoalState(pi: GoalStateApi, deps: GoalStateDeps = {}): Promise<void> {
	const home = deps.home ?? homedir();
	const now = deps.now ?? Date.now;
	const pid = deps.pid ?? process.pid;
	const env = deps.env ?? process.env;
	const writtenPaths = new Set<string>();

	async function publish(event: never, ctx: GoalStateContext): Promise<void> {
		try {
			const cwd = ctx.cwd;
			if (typeof cwd !== "string" || cwd === "") return;
			if ((await fleetPolicyState(cwd)).kind !== "on") return;
			const mode = goalStateMode((event ?? {}) as GoalUpdatedEvent);
			if (mode === null) return;
			const raw = ctx.sessionManager?.getSessionFile?.();
			if (typeof raw !== "string" || raw === "") return;
			let sessionFile: string;
			try {
				sessionFile = realpathSync(raw);
			} catch {
				// Unresolvable session file: the helper hashes os.path.realpath, so a raw-path
				// record would be unreachable. Skip the write; the journal fallback still applies.
				return;
			}
			const pane = env.TERN_PANE;
			const record: GoalStateRecord = {
				schema: 1,
				session_file: sessionFile,
				session_id: ctx.sessionManager?.getSessionId?.() ?? null,
				block: typeof pane === "string" && pane !== "" ? pane : null,
				pid,
				...mode,
				written_at: now(),
			};
			const path = goalStateRecordPath(home, sessionFile);
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			const tmp = `${path}.${pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(record));
			renameSync(tmp, path);
			writtenPaths.add(path);
		} catch {
			// A missed publish only means the helper falls back to its journal-only snapshot.
		}
	}

	pi.on("goal_updated", publish);
	pi.on("session_shutdown", (_event, _ctx) => {
		for (const path of writtenPaths) {
			try { rmSync(path, { force: true }); } catch { /* a stale record is rejected by its timestamp */ }
		}
		writtenPaths.clear();
	});
}
