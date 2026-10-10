import { expect, test } from "bun:test";
import { inspectPaneIdentity } from "../../src/diagnostics.ts";
import {
	selectCoordinatorObservation,
	type SeamObservation,
} from "../../src/coordinator-observation.ts";
import { inspectOmpSessions } from "../../src/session-doctor.ts";

// ompkit-bj08.4 Round-1 test contract: deterministic unit tests for each
// [a]/[b] decision boundary plus the planted negatives. No I/O, no clocks.

const SEAM_BASE: SeamObservation = {
	workerCallback: true,
	visibleMarker: true,
	packetDecision: { generation: "gen-7" },
	coordinatorGeneration: "gen-7",
	deliveryCursor: { cursorId: "cursor-1", expired: false },
	messageId: "msg-1",
	receivingEvent: "delivery",
	pendingRefs: ["ref-a", "ref-b"],
};

// [a] positive: the native sessions probe exposes the available
// coordinator/recipient facts (pane binding, resume path, verdict) and the
// identity probe exposes binding only.
test("[a] sessions probe binds process to pane with resume path and verdict", () => {
	const report = inspectOmpSessions({
		processes: [{
			pid: 42,
			ppid: 7,
			command: "bun /fixture/.bun/bin/omp --profile claude --model m --resume /fixture/sess.jsonl",
			start_epoch_ms: 3000,
			start_text: "Sat Oct 3 10:00:00 2026",
		}],
		panes: [{ pane: "omp-test 0.1", pid: 7, start_command: "omp --profile claude" }],
		components: [
			{ label: "OMP package", path: "/omp/package", version: "18.5.0", installed_at_epoch_ms: 1000 },
			{ label: "kit plugin", path: "/kit/plugin", version: "0.2.3", installed_at_epoch_ms: 2000 },
			{ label: "~/.agents/AGENTS.md", path: "/fixture/home/.agents/AGENTS.md", version: null, installed_at_epoch_ms: 2500 },
		],
		now_epoch_ms: 4000,
	});
	const session = report.sessions[0]!;
	expect(session.pane).toBe("omp-test 0.1");
	expect(session.verdict).toBe("CURRENT");
	expect(session.command).toContain("--resume /fixture/sess.jsonl");
});

// [a] positive: the probe surface carries no coordinator-decision,
// delivery-cursor, or consumption field, so UNKNOWN there is measured.
test("[a] sessions report expresses no coordinator consumption field", () => {
	const report = inspectOmpSessions({
		processes: [{
			pid: 42,
			ppid: 7,
			command: "bun /fixture/.bun/bin/omp --profile claude",
			start_epoch_ms: 3000,
			start_text: "Sat Oct 3 10:00:00 2026",
		}],
		panes: [],
		components: [],
		now_epoch_ms: 4000,
	});
	const serialized = JSON.stringify(report);
	for (const field of ["coordinator", "deliveryCursor", "delivery_cursor", "consumed", "CONSUMED", "messageId", "message_id"]) {
		expect(serialized).not.toContain(field);
	}
});

// [a] positive: identity probe reports binding gaps, never consumption.
test("[a] identity probe reports pane binding, not coordinator decisions", () => {
	const row = inspectPaneIdentity({
		listPanes: () => [{ session: "omp-test", window: "1", index: "0", id: "%37" }],
		resolvePane: () => "IndigoIsland",
		listAgents: () => [],
	});
	expect(row.status).toBe("OK");
	expect(JSON.stringify(row.evidence ?? {})).not.toContain("coordinator");
});

// [a] planted negative: callback plus visible marker but no packet-bound
// native coordinator decision must not become a consumption claim.
test("[a] planted: callback without packet-bound decision stays UNKNOWN", () => {
	const decision = selectCoordinatorObservation({ ...SEAM_BASE, packetDecision: null });
	expect(decision.disposition).toBe("UNKNOWN");
	expect(decision.action).toBe("no-action");
	expect(decision.reason).toContain("packet-bound");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
});

// [a] planted negative: callback-shaped text in a process command line still
// yields no coordinator claim from the native probe surface.
test("[a] planted: callback text in command line is not probe consumption", () => {
	const report = inspectOmpSessions({
		processes: [{
			pid: 42,
			ppid: 7,
			command: "bun /fixture/.bun/bin/omp --profile claude -p 'DONE bead-1 callback received'",
			start_epoch_ms: 3000,
			start_text: "Sat Oct 3 10:00:00 2026",
		}],
		panes: [{ pane: "omp-test 0.1", pid: 7, start_command: "omp --profile claude" }],
		components: [],
		now_epoch_ms: 4000,
	});
	expect(JSON.stringify(report)).not.toContain("CONSUMED");
	expect(selectCoordinatorObservation(SEAM_BASE).disposition).toBe("CONSUMED");
});

// [b] positive: the full seam names exactly one custodian and a
// reference-only pending source, with cursor distinct from message identity.
test("[b] full seam hands exactly one custodian a distinct-cursor decision", () => {
	const decision = selectCoordinatorObservation(SEAM_BASE);
	expect(decision.disposition).toBe("CONSUMED");
	expect(decision.custodian).toBe("CB1");
	expect(decision.pendingSource).toBe("agent-mail-inbox-delivery-events");
	expect(decision.action).toBe("hand-to-continuance");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
});

// [b] planted negative: omitted coordinator generation yields UNKNOWN and
// preserves pending references without action.
test("[b] planted: omitted generation yields UNKNOWN, refs preserved", () => {
	const decision = selectCoordinatorObservation({ ...SEAM_BASE, coordinatorGeneration: null });
	expect(decision.disposition).toBe("UNKNOWN");
	expect(decision.action).toBe("no-action");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
	expect(decision.reason).toContain("generation");
});

// [b] planted negative: an expired delivery cursor yields UNKNOWN, never a
// silent reset or manufactured consumption.
test("[b] planted: expired cursor yields UNKNOWN, refs preserved", () => {
	const decision = selectCoordinatorObservation({
		...SEAM_BASE,
		deliveryCursor: { cursorId: "cursor-1", expired: true },
	});
	expect(decision.disposition).toBe("UNKNOWN");
	expect(decision.action).toBe("no-action");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
	expect(decision.reason).toContain("expired");
});

// [b] planted negative: a sender log substituted for the receiving event
// yields UNKNOWN, never consumption.
test("[b] planted: sender log is not a receipt", () => {
	const decision = selectCoordinatorObservation({ ...SEAM_BASE, receivingEvent: "sender-log" });
	expect(decision.disposition).toBe("UNKNOWN");
	expect(decision.action).toBe("no-action");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
});

// [b] planted negative: cursor coinciding with message identity violates the
// cursor/identity distinction and yields UNKNOWN.
test("[b] planted: cursor coinciding with message identity yields UNKNOWN", () => {
	const decision = selectCoordinatorObservation({
		...SEAM_BASE,
		deliveryCursor: { cursorId: "msg-1", expired: false },
	});
	expect(decision.disposition).toBe("UNKNOWN");
	expect(decision.action).toBe("no-action");
	expect(decision.pendingRefs).toEqual(["ref-a", "ref-b"]);
});
