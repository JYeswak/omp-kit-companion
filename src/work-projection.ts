// work-projection.ts — director-facing freshness gate for work-coordination projections.
//
// PRODUCER TRACE (jq88 AC [a]): the `work_coordination` / `safe_to_dispatch`
// session-work projection originates OUTSIDE omp-kit (the NTM coordinator).
// Verified 2026-10-19 against installed ntm 1.37.0 (`ntm --version`):
// `ntm inspect-session` is an unknown command and no `work_coordination`
// field exists in `ntm status` or any robot/JSON surface this repo consumes,
// and no work_coordination/safe_to_dispatch consumer exists in companion
// src/scripts or omp-kit scripts. The bead-observed contract (collected
// 2026-10-12T22:11:49Z, stale after 2026-10-12T22:12:34Z) gives the default
// 45s staleness bound below. Fresh queue authority is always native
// `br ready`; a stale/unavailable projection is classified separately from
// a fresh-empty queue and can never authorize dispatch from empty data.

/** Observed producer contract: collected 22:11:49Z, stale after 22:12:34Z. */
export const WORK_PROJECTION_DEFAULT_TTL_MS = 45_000;

export interface WorkProjectionInput {
	/** Raw collected_at passthrough; null/missing/unparseable => UNAVAILABLE. */
	collectedAt: string | null;
	/** Explicit staleness bound; derived as collectedAt + ttl when absent. */
	staleAfter?: string | null;
	/** work_coordination.available; false => UNAVAILABLE. */
	available: boolean;
	/** Whether the runtime projection reported an empty queue. */
	empty: boolean;
	/** Raw producer payload preserved for evidence, never trusted for freshness. */
	raw?: unknown;
}

export type WorkProjectionKind = "FRESH_EMPTY" | "FRESH_NONEMPTY" | "STALE" | "UNAVAILABLE";

export interface WorkProjectionVerdict {
	kind: WorkProjectionKind;
	collected_at: string | null;
	stale_after: string | null;
	warning: string | null;
}

function time(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Classify a work-coordination projection; stale/unavailable is never fresh-empty. */
export function classifyWorkProjection(input: WorkProjectionInput, now: Date,
	ttlMs: number = WORK_PROJECTION_DEFAULT_TTL_MS): WorkProjectionVerdict {
	const collected = time(input.collectedAt);
	const collectedIso = collected === null ? null : new Date(collected).toISOString();
	let staleAfter = time(input.staleAfter ?? null);
	if (staleAfter === null && collected !== null) staleAfter = collected + ttlMs;
	const staleIso = staleAfter === null ? null : new Date(staleAfter).toISOString();
	const base = { collected_at: collectedIso, stale_after: staleIso };
	if (!input.available || collected === null || collected > now.getTime() || staleAfter === null) {
		const why = !input.available ? "available=false"
			: collected === null ? "collected_at missing or unparseable"
				: collected > now.getTime() ? "collected_at is in the future (clock skew)"
					: "staleness bound undeterminable";
		return { ...base, kind: "UNAVAILABLE",
			warning: `FRESHNESS work_projection=UNAVAILABLE collected_at=${collectedIso ?? "UNKNOWN"} stale_after=${staleIso ?? "UNKNOWN"} reason=${why}; require a fresh native br ready read` };
	}
	if (now.getTime() >= staleAfter) {
		return { ...base, kind: "STALE",
			warning: `FRESHNESS work_projection=STALE collected_at=${collectedIso} stale_after=${staleIso} observed_at=${now.toISOString()}; require a fresh native br ready read` };
	}
	return { ...base, kind: input.empty ? "FRESH_EMPTY" : "FRESH_NONEMPTY", warning: null };
}

export type QueueReport = "EMPTY" | "NONEMPTY" | "STALE" | "UNKNOWN";

export interface QueueDispatchGate {
	report: QueueReport;
	/** True only when the projection itself is fresh; otherwise dispatch needs fresh native rows. */
	dispatchFromProjection: boolean;
	detail: string;
}

/**
 * Director gate (jq88 AC [b]): stale/unavailable + live ready>0 reports
 * STALE/UNKNOWN and cannot dispatch from empty data; fresh complete ready=0
 * remains EMPTY. liveReady is a fresh native `br ready` count, null when unread.
 */
export function queueDispatchGate(verdict: WorkProjectionVerdict, liveReady: number | null): QueueDispatchGate {
	switch (verdict.kind) {
		case "FRESH_EMPTY":
			return { report: "EMPTY", dispatchFromProjection: true,
				detail: `fresh complete projection is empty (collected_at=${verdict.collected_at})` };
		case "FRESH_NONEMPTY":
			return { report: "NONEMPTY", dispatchFromProjection: true,
				detail: `fresh projection reports queued work (collected_at=${verdict.collected_at})` };
		case "STALE":
		case "UNAVAILABLE": {
			const state = verdict.kind === "STALE" ? "STALE" : "UNKNOWN";
			if (liveReady !== null && liveReady > 0) {
				return { report: state, dispatchFromProjection: false,
					detail: `work_projection=${verdict.kind} (collected_at=${verdict.collected_at ?? "UNKNOWN"}) but fresh native br ready=${liveReady}; reread native ready before dispatch, never dispatch from the empty projection` };
			}
			if (liveReady !== null) {
				return { report: "EMPTY", dispatchFromProjection: false,
					detail: `work_projection=${verdict.kind} but fresh native br ready=0; queue is empty per native, not per projection` };
			}
			return { report: state, dispatchFromProjection: false,
				detail: `work_projection=${verdict.kind} and native br ready unread; queue state unknown, no dispatch` };
		}
	}
}

export interface SendTargetSignal {
	/** Whether the target pane holds a live seat. */
	active: boolean;
	/** safe_to_dispatch signal; null when the producer exposes none (ntm 1.37.0 has no such field). */
	safeToDispatch: boolean | null;
}

/** Send-target rule (jq88 AC [c]): safe_to_dispatch=false is never a send target. */
export function isSendTargetEligible(pane: SendTargetSignal): { eligible: boolean; reason: string } {
	if (pane.safeToDispatch === false) {
		return { eligible: false,
			reason: `send refused: ${pane.active ? "live active" : "target"} pane reports safe_to_dispatch=false; existing busy/composer admission is not consulted` };
	}
	return { eligible: true,
		reason: pane.safeToDispatch === true ? "safe_to_dispatch=true; existing busy/composer admission still applies"
			: "no safe_to_dispatch signal (producer exposes none); existing busy/composer admission decides" };
}
