// watch-actuator.ts — 1hqq.2: every fleet watch ships a paired actuator with a
// max-idle SLA. Pure evaluation: given pairings (watch + actuator + activity +
// actuation receipts) and now, report OK vs FLAGGED per watch. Wiring into
// watchd and doctor --scope watch comes after 1hqq.1 lands the .omp/watch spec;
// this module consumes plain data so neither side is blocked.

export type ActuatorKind = "nudge" | "page" | "file";

export interface WatchActuator {
	kind: ActuatorKind;
	maxIdleSeconds: number;
}

export interface ActuationReceipt {
	atMs: number;
	kind: ActuatorKind;
	detail: string;
}

export interface WatchPairing {
	watch: string;
	actuator: WatchActuator;
	lastActivityMs: number;
	actuations: ActuationReceipt[];
}

export type WatchRowStatus = "OK" | "FLAGGED";

export interface WatchRow {
	watch: string;
	status: WatchRowStatus;
	idleSeconds: number;
	lastActuationMs: number | null;
	reason: string;
}

export function evaluatePairings(pairings: WatchPairing[], nowMs: number): WatchRow[] {
	return pairings.map(pairing => evaluateOne(pairing, nowMs));
}

function evaluateOne(pairing: WatchPairing, nowMs: number): WatchRow {
	const idleSeconds = Math.max(0, Math.floor((nowMs - pairing.lastActivityMs) / 1000));
	let lastActuationMs: number | null = null;
	for (const actuation of pairing.actuations) {
		if (lastActuationMs === null || actuation.atMs > lastActuationMs) lastActuationMs = actuation.atMs;
	}
	if (idleSeconds <= pairing.actuator.maxIdleSeconds) {
		return { watch: pairing.watch, status: "OK", idleSeconds, lastActuationMs, reason: "fleet active within SLA" };
	}
	if (lastActuationMs !== null && nowMs - lastActuationMs <= pairing.actuator.maxIdleSeconds * 1000) {
		return { watch: pairing.watch, status: "OK", idleSeconds, lastActuationMs, reason: "actuation receipt within SLA" };
	}
	return { watch: pairing.watch, status: "FLAGGED", idleSeconds, lastActuationMs, reason: `fleet idle ${idleSeconds}s past max-idle ${pairing.actuator.maxIdleSeconds}s with no actuation` };
}
