import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Background-agent supervisor (SUPERVISE1 ompkit-fp72.19.1.27, J-2026-10-19-66).
 *
 * Every background agent a seat launches (omp task, omp -p) is registered with
 * its supervising seat, a checkpoint path and a restart policy. The supervisor
 * restarts or reassigns it after a crash, kill or upgrade notice, and the seat
 * never polls it (Erlang/OTP principle: the parent gets results as an
 * inbox/aside event).
 *
 * Why: an upgrade notice stopped a headless `omp -p` background agent
 * (writer3) after 1 of 4 rounds and nothing restarted it; seats waited on
 * their own background agents 15-59 min (BGWAIT1 ompkit-fp72.19.1.24).
 *
 * Pure plan/apply split: decideOnExit is pure; applyOnExit runs exactly one
 * effect. All refusals throw `bg-supervisor refused: ...` before any write.
 */

export type RestartPolicy = "restart" | "reassign" | "report";
export const RESTART_POLICIES: readonly RestartPolicy[] = ["restart", "reassign", "report"];

/** One registered background agent: pid, parent seat, bead, task digest, checkpoint, deadline, policy. */
export interface BgAgentRow {
	/** OS pid of the background agent process. */
	pid: number;
	/** Supervising seat that launched it (receives results, never polls). */
	parentSeat: string;
	/** Bead the agent works. */
	bead: string;
	/** Digest of the task prompt it was launched with (restart resumes the same task). */
	taskDigest: string;
	/** Absolute checkpoint path the restart resumes from. */
	checkpoint: string;
	/** ISO deadline the agent must deliver by. */
	deadline: string;
	/** What the supervisor does when the agent exits without its declared result. */
	restartPolicy: RestartPolicy;
	/** Kit release the agent started under; it finishes on this release. */
	release: string;
	/** Restarts already consumed. */
	attempts: number;
	/** Restarts allowed before the supervisor reports instead of looping. */
	maxRestarts: number;
}

export interface BgRegistry {
	agents: BgAgentRow[];
}

const NONEMPTY = /^\S(?:.*\S)?$/;
const HEX64 = /^[0-9a-f]{64}$/;

function nonEmpty(value: unknown, field: string): string {
	if (typeof value !== "string" || !NONEMPTY.test(value)) {
		throw new Error(`bg-supervisor refused: ${field} must be a non-empty string`);
	}
	return value;
}

/** Copy the enumerable fields of a narrowed object into a plain record (no casts; Object.entries is exact). */
function fieldsOf(candidate: object): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(candidate)) fields[key] = value;
	return fields;
}

/** Validate a candidate row; throws before any state change. Unknown inputs never pass. */
export function validateRow(candidate: unknown): BgAgentRow {
	if (typeof candidate !== "object" || candidate === null) {
		throw new Error("bg-supervisor refused: agent row must be an object");
	}
	const row = fieldsOf(candidate);
	const { pid, attempts, maxRestarts, restartPolicy, checkpoint, taskDigest } = row;
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
		throw new Error("bg-supervisor refused: pid must be a positive integer");
	}
	if (restartPolicy !== "restart" && restartPolicy !== "reassign" && restartPolicy !== "report") {
		throw new Error(`bg-supervisor refused: restartPolicy must be one of ${RESTART_POLICIES.join("|")}`);
	}
	const checkpointPath = nonEmpty(checkpoint, "checkpoint");
	if (!isAbsolute(checkpointPath)) {
		throw new Error("bg-supervisor refused: checkpoint must be an absolute path");
	}
	const digest = nonEmpty(taskDigest, "taskDigest");
	if (!HEX64.test(digest)) {
		throw new Error("bg-supervisor refused: taskDigest must be a 64-hex sha256");
	}
	if (typeof attempts !== "number" || !Number.isInteger(attempts) || attempts < 0) {
		throw new Error("bg-supervisor refused: attempts must be a non-negative integer");
	}
	if (typeof maxRestarts !== "number" || !Number.isInteger(maxRestarts) || maxRestarts < 0) {
		throw new Error("bg-supervisor refused: maxRestarts must be a non-negative integer");
	}
	if (attempts > maxRestarts) {
		throw new Error("bg-supervisor refused: attempts must not exceed maxRestarts");
	}
	return {
		pid,
		parentSeat: nonEmpty(row.parentSeat, "parentSeat"),
		bead: nonEmpty(row.bead, "bead"),
		taskDigest: digest,
		checkpoint: checkpointPath,
		deadline: nonEmpty(row.deadline, "deadline"),
		restartPolicy,
		release: nonEmpty(row.release, "release"),
		attempts,
		maxRestarts,
	};
}

/** Register one background agent. Refuses duplicate pids; returns a new registry. */
export function registerAgent(reg: BgRegistry, candidate: unknown): BgRegistry {
	const row = validateRow(candidate);
	if (reg.agents.some((agent) => agent.pid === row.pid)) {
		throw new Error(`bg-supervisor refused: pid ${row.pid} already registered`);
	}
	return { agents: [...reg.agents, row] };
}

/** Remove a registration (done or reported agents leave the registry). */
export function deregisterAgent(reg: BgRegistry, pid: number): BgRegistry {
	return { agents: reg.agents.filter((agent) => agent.pid !== pid) };
}

export function findAgent(reg: BgRegistry, pid: number): BgAgentRow | null {
	return reg.agents.find((agent) => agent.pid === pid) ?? null;
}

/** Kit state file holding the registry (one store; seats share it, keyed by pid). */
export function registryPath(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(home, ".local", "state");
	return join(state, "omp-kit-orchestration", "bg-agents.json");
}

/** Load the registry; a missing file is empty, a malformed one refuses (never half-read). */
export function loadRegistry(path: string): BgRegistry {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const missing = error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
		if (missing) return { agents: [] };
		throw new Error(`bg-supervisor refused: registry unreadable: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`bg-supervisor refused: registry is not JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof parsed !== "object" || parsed === null || !("agents" in parsed)) {
		throw new Error(`bg-supervisor refused: registry must be { agents: [] }: ${path}`);
	}
	const rawAgents: unknown = parsed.agents;
	if (!Array.isArray(rawAgents)) {
		throw new Error(`bg-supervisor refused: registry must be { agents: [] }: ${path}`);
	}
	const agents = rawAgents.map(validateRow);
	const seen: Record<number, true> = {};
	for (const agent of agents) {
		if (seen[agent.pid] === true) throw new Error(`bg-supervisor refused: duplicate pid ${agent.pid} in ${path}`);
		seen[agent.pid] = true;
	}
	return { agents };
}

/** Persist the registry; validates every row before any write. */
export function saveRegistry(path: string, reg: BgRegistry): void {
	const agents = reg.agents.map(validateRow);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ agents }, null, 2)}\n`, "utf8");
}

export type BgExitCause = "exited" | "killed" | "failed" | "upgrade-stopped";

export interface BgExit {
	/** True only when the agent delivered its declared result before exiting. */
	deliveredResult: boolean;
	cause: BgExitCause;
}

export type SuperviseDecision =
	| "done"
	| "restart-from-checkpoint"
	| "reassign"
	| "report-to-director"
	| "unknown-agent";

export interface ExitDecision {
	decision: SuperviseDecision;
	row: BgAgentRow | null;
}

/**
 * Pure policy choice for an exited agent. A delivered result is done; an
 * agent that already consumed maxRestarts is reported, never looped;
 * otherwise the row's policy applies.
 */
export function decideOnExit(reg: BgRegistry, pid: number, exit: BgExit): ExitDecision {
	const row = findAgent(reg, pid);
	if (row === null) return { decision: "unknown-agent", row: null };
	if (exit.deliveredResult) return { decision: "done", row };
	if (row.attempts >= row.maxRestarts) return { decision: "report-to-director", row };
	if (row.restartPolicy === "restart") return { decision: "restart-from-checkpoint", row };
	if (row.restartPolicy === "reassign") return { decision: "reassign", row };
	return { decision: "report-to-director", row };
}

export interface SuperviseEffects {
	/** Relaunch the same task digest from the row's checkpoint. */
	restart(row: BgAgentRow): void;
	/** Hand the task digest + checkpoint to another seat. */
	reassign(row: BgAgentRow): void;
	/** Report the exhausted agent to the parent seat's director. */
	report(row: BgAgentRow, decision: SuperviseDecision): void;
}

export interface ApplyOutcome {
	decision: SuperviseDecision;
	registry: BgRegistry;
	effectRan: boolean;
}

/**
 * Apply the pure decision, running exactly one effect. Restart/reassign
 * consume one attempt in the returned registry; done/report deregister the
 * agent so a dead pid is never supervised twice. Unknown agents run nothing.
 */
export function applyOnExit(reg: BgRegistry, pid: number, exit: BgExit, effects: SuperviseEffects): ApplyOutcome {
	const { decision, row } = decideOnExit(reg, pid, exit);
	if (row === null) return { decision, registry: reg, effectRan: false };
	if (decision === "restart-from-checkpoint") {
		effects.restart(row);
		return {
			decision,
			registry: { agents: reg.agents.map((agent) => (agent.pid === pid ? { ...agent, attempts: agent.attempts + 1 } : agent)) },
			effectRan: true,
		};
	}
	if (decision === "reassign") {
		effects.reassign(row);
		return {
			decision,
			registry: { agents: reg.agents.map((agent) => (agent.pid === pid ? { ...agent, attempts: agent.attempts + 1 } : agent)) },
			effectRan: true,
		};
	}
	if (decision === "report-to-director") {
		effects.report(row, decision);
		return { decision, registry: deregisterAgent(reg, pid), effectRan: true };
	}
	return { decision, registry: deregisterAgent(reg, pid), effectRan: false };
}

export type UpgradeNoticeVerdict = "held" | "unknown-agent";

export interface UpgradeNoticeHold {
	verdict: UpgradeNoticeVerdict;
	/** Release the agent started under; it finishes on this release. */
	release: string | null;
}

/**
 * Upgrade notices never reach a registered background agent: the notice is
 * held and the agent finishes on the release it started under. Unknown pids
 * fall through to the seat's normal notice path.
 */
export function upgradeNoticeForAgent(reg: BgRegistry, pid: number): UpgradeNoticeHold {
	const row = findAgent(reg, pid);
	if (row === null) return { verdict: "unknown-agent", release: null };
	return { verdict: "held", release: row.release };
}

export interface ResultEvent {
	/** Parent seat that launched the agent; the seat never polls. */
	to: string;
	/** Aside delivery: the seat reads it at the next step boundary, never via wait. */
	deliverAs: "aside";
	subject: string;
	body: string;
}

/** Result delivery for the parent seat as an inbox/aside event (no wait, no poll loop). */
export function resultEvent(row: BgAgentRow, summary: string): ResultEvent {
	const text = nonEmpty(summary, "summary");
	return {
		to: row.parentSeat,
		deliverAs: "aside",
		subject: `background agent done: ${row.bead} (pid ${row.pid})`,
		body: `${text}\ncheckpoint: ${row.checkpoint}\ntask: ${row.taskDigest}`,
	};
}
