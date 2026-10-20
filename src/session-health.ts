/**
 * Session HEALTH gate (bead ompkit-fp72.11 HEALTH1, canonical product source).
 *
 * Rule: HEALTH judges agent panes only. A stale user or shell pane is a
 * WARNING and the prelude proceeds to INTEGRATE; only a dead or unreachable
 * orchestrator or worker pane BLOCKS. Non-agent panes never block no matter
 * their state. With no orchestrator or worker pane observed at all, HEALTH
 * blocks (fail closed, never INTEGRATE blind).
 *
 * With ntm retired (chief pane is Tern), the prelude must call
 * `reconcileSessionHealth` below and never gate on an `ntm health` exit code
 * (dead surface). This module never restarts panes, sends input, rotates
 * credentials, or weakens safety; it only types the disposition.
 *
 * Ported from the omp-kit frozen snapshot's HEALTH1 slice
 * (`src/pane-health.ts` reconcileSessionHealth, commit 3f3e617) to the
 * canonical companion per CopperTrout REWORK 2026-10-19 on ompkit-fp72.11.
 * Only the HEALTH1 slice lives here: fp72.43 (reconcilePaneHealth) and
 * PARK1/b0ykd (reconcileParkedSeat) slices stay with their own beads.
 */

/** Session pane role for HEALTH gating. Only agent roles can block. */
export type SessionPaneRole = "user" | "shell" | "orchestrator" | "worker";

/** Observed session pane state. */
export type SessionPaneStatus = "healthy" | "stale" | "dead" | "unreachable";

/** One session pane as the HEALTH prelude observes it. */
export interface SessionPane {
	role: SessionPaneRole;
	status: SessionPaneStatus;
	/** Pane label for the reason string, e.g. "%18". */
	label?: string;
}

/** Session HEALTH verdict. WARN and PASS both proceed to INTEGRATE. */
export type SessionHealthVerdict = "PASS" | "WARN" | "BLOCK";

export interface SessionHealth {
	verdict: SessionHealthVerdict;
	/** True unless an agent pane is dead or unreachable. */
	proceed: boolean;
	authority: string;
	reason: string;
}

const SESSION_AUTHORITY = "omp-kit session-health reconcileSessionHealth (ompkit-fp72.11): HEALTH judges agent panes only";
/**
 * Session HEALTH gate: a stale user or shell pane warns and proceeds, while
 * a dead or unreachable orchestrator or worker pane blocks. Non-agent panes
 * never block. No agent pane observed at all blocks (fail closed).
 */
export function reconcileSessionHealth(panes: SessionPane[]): SessionHealth {
	const agents = panes.filter((pane) => pane.role === "orchestrator" || pane.role === "worker");
	if (agents.length === 0) {
		return {
			verdict: "BLOCK",
			proceed: false,
			authority: SESSION_AUTHORITY,
			reason: "no orchestrator or worker pane observed; fail closed, never INTEGRATE blind",
		};
	}
	const blocked = agents.filter((pane) => pane.status === "dead" || pane.status === "unreachable");
	if (blocked.length > 0) {
		const names = blocked.map((pane) => `${pane.role}${pane.label ? ` ${pane.label}` : ""} ${pane.status}`).join(", ");
		return {
			verdict: "BLOCK",
			proceed: false,
			authority: SESSION_AUTHORITY,
			reason: `agent pane down, INTEGRATE blocked: ${names}`,
		};
	}
	const warnings = panes.filter((pane) => pane.status !== "healthy");
	if (warnings.length === 0) {
		return {
			verdict: "PASS",
			proceed: true,
			authority: SESSION_AUTHORITY,
			reason: "every observed pane healthy",
		};
	}
	const names = warnings.map((pane) => `${pane.role}${pane.label ? ` ${pane.label}` : ""} ${pane.status}`).join(", ");
	return {
		verdict: "WARN",
		proceed: true,
		authority: SESSION_AUTHORITY,
		reason: `non-blocking pane state, proceeding to INTEGRATE: ${names}`,
	};
}
