import { expect, test } from "bun:test";
import { choosePull, type PullInput } from "../../src/fleet-watch.ts";
import {
	classifyWorkProjection,
	isSendTargetEligible,
	queueDispatchGate,
	WORK_PROJECTION_DEFAULT_TTL_MS,
} from "../../src/work-projection.ts";

const NOW = new Date("2026-10-12T23:09:00Z");
// Bead-observed contract: collected 22:11:49Z, stale after 22:12:34Z.
const STALE_PROJECTION = {
	collectedAt: "2026-10-12T22:11:49Z",
	staleAfter: "2026-10-12T22:12:34Z",
	available: true,
	empty: true,
};

test("stale projection plus live ready>0 is STALE and never dispatches from empty data", () => {
	const verdict = classifyWorkProjection(STALE_PROJECTION, NOW);
	expect(verdict.kind).toBe("STALE");
	expect(verdict.warning).toContain("2026-10-12T22:11:49");
	expect(verdict.warning).toContain("2026-10-12T22:12:34");
	const gate = queueDispatchGate(verdict, 21);
	expect(gate.report).toBe("STALE");
	expect(gate.dispatchFromProjection).toBe(false);
	expect(gate.detail).toContain("21");
});

test("unavailable projection plus live ready>0 is UNKNOWN and never dispatches from empty data", () => {
	const verdict = classifyWorkProjection({ ...STALE_PROJECTION, available: false }, NOW);
	expect(verdict.kind).toBe("UNAVAILABLE");
	const gate = queueDispatchGate(verdict, 5);
	expect(gate.report).toBe("UNKNOWN");
	expect(gate.dispatchFromProjection).toBe(false);
});

test("fresh complete ready=0 remains EMPTY", () => {
	const collected = new Date(NOW.getTime() - 10_000).toISOString();
	const verdict = classifyWorkProjection({ collectedAt: collected, available: true, empty: true }, NOW);
	expect(verdict.kind).toBe("FRESH_EMPTY");
	const gate = queueDispatchGate(verdict, 0);
	expect(gate.report).toBe("EMPTY");
	expect(gate.dispatchFromProjection).toBe(true);
});

test("fresh nonempty projection reports NONEMPTY", () => {
	const collected = new Date(NOW.getTime() - 10_000).toISOString();
	const verdict = classifyWorkProjection({ collectedAt: collected, available: true, empty: false }, NOW);
	expect(verdict.kind).toBe("FRESH_NONEMPTY");
	expect(queueDispatchGate(verdict, 3).report).toBe("NONEMPTY");
});

test("stale projection with no live read stays stale/unknown, never empty", () => {
	const verdict = classifyWorkProjection(STALE_PROJECTION, NOW);
	const gate = queueDispatchGate(verdict, null);
	expect(gate.report).toBe("STALE");
	expect(gate.dispatchFromProjection).toBe(false);
});

test("missing timestamps are UNAVAILABLE, not fresh-empty", () => {
	expect(classifyWorkProjection({ collectedAt: null, available: true, empty: true }, NOW).kind).toBe("UNAVAILABLE");
	expect(classifyWorkProjection({ collectedAt: "not-a-time", available: true, empty: true }, NOW).kind).toBe("UNAVAILABLE");
});

test("default staleness bound matches the observed 45s producer contract", () => {
	expect(WORK_PROJECTION_DEFAULT_TTL_MS).toBe(45_000);
	const collected = new Date(NOW.getTime() - 46_000).toISOString();
	expect(classifyWorkProjection({ collectedAt: collected, available: true, empty: true }, NOW).kind).toBe("STALE");
	const fresh = new Date(NOW.getTime() - 44_000).toISOString();
	expect(classifyWorkProjection({ collectedAt: fresh, available: true, empty: true }, NOW).kind).toBe("FRESH_EMPTY");
});

test("live active pane with safe_to_dispatch=false is never a send target", () => {
	const refused = isSendTargetEligible({ active: true, safeToDispatch: false });
	expect(refused.eligible).toBe(false);
	expect(refused.reason).toContain("safe_to_dispatch=false");
	expect(isSendTargetEligible({ active: true, safeToDispatch: true }).eligible).toBe(true);
	// No signal is not a refusal: ntm 1.37.0 exposes no safe_to_dispatch field.
	expect(isSendTargetEligible({ active: true, safeToDispatch: null }).eligible).toBe(true);
});

function pullInput(projection: typeof STALE_PROJECTION | undefined): PullInput {
	return {
		sessionName: "omp-test", worker: "w", liveWorkers: new Set(), grading: [], rework: [],
		triage: { usable: false, ids: [], reason: "off" }, issues: [], readyRows: [],
		policy: { transitions: {} }, focus: [], skipLabels: [],
		taken: new Set(), workProjection: projection, workProjectionNowMs: NOW.getTime(),
	};
}

test("fleet-watch treats a stale projection as UNKNOWN, never as an empty queue", () => {
	const choice = choosePull(pullInput(STALE_PROJECTION));
	expect(choice.ready).toBe(false);
	if (!choice.ready) expect(choice.kind).toBe("UNKNOWN");
});

test("fleet-watch keeps fresh-empty behavior unchanged", () => {
	const collected = new Date(NOW.getTime() - 10_000).toISOString();
	const choice = choosePull(pullInput({ collectedAt: collected, available: true, empty: true }));
	expect(choice.ready).toBe(false);
	if (!choice.ready) expect(choice.kind).toBe("NO_FREE_LEAF");
});
