import { expect, test } from "bun:test";
import { admitActuator, type AdmissionInput } from "../../src/actuator-admission.ts";

// ompkit-bj08.5 Round-1 test contract: deterministic unit tests for each
// [a]/[b] decision boundary plus the planted negatives. No I/O, no clocks.

const BASE: AdmissionInput = {
	launcherBinding: "keeper",
	authority: "ACTIVE",
	authorityConfirmed: true,
	authorityGeneration: "gen-7",
	launchers: [{ pid: 4242, command: "bun run fleet-watch" }],
	keeper: { pid: 4242, command: "bun run fleet-watch" },
	packet: { action: "nudge", ownedAction: "nudge", generation: "gen-7" },
	governedActions: ["nudge", "tracker-recovery", "lease-mutation"],
};

// [a] positive: an independently qualified isolated permitted packet admits
// its one owned action.
test("[a] qualified packet admits exactly its one owned action", () => {
	const decision = admitActuator(BASE);
	expect(decision.verdict).toBe("ADMIT");
	expect(decision.admittedAction).toBe("nudge");
});

// [a] positive: a legitimate unrelated authorized action remains allowed,
// passing through governance untouched.
test("[a] unrelated authorized action passes through as ALLOW", () => {
	const decision = admitActuator({
		...BASE,
		packet: { action: "status-report", ownedAction: "status-report", generation: "gen-7" },
	});
	expect(decision.verdict).toBe("ALLOW");
	expect(decision.admittedAction).toBeNull();
});

// [a] planted negative: two live launchers while the keeper file lists one.
// Admission refuses; a keeper-only stopped result cannot pass.
test("[a] planted: launcher set exceeding keeper claim refuses", () => {
	const decision = admitActuator({
		...BASE,
		launchers: [
			{ pid: 4242, command: "bun run fleet-watch" },
			{ pid: 9999, command: "bun run fleet-watch --inherited" },
		],
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
	expect(decision.reason).toContain("keeper");
});

// [a] planted negative: keeper claim absent while launchers live refuses.
test("[a] planted: absent keeper claim with live launchers refuses", () => {
	const decision = admitActuator({ ...BASE, keeper: null });
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});

// [b] effects branches: PAUSED, OFF, protected, unconfirmed, stale
// generation and unknown authority produce zero governed effects.
test("[b] paused, off, protected, unconfirmed and stale states refuse", () => {
	const states = [
		{ ...BASE, authority: "PAUSED" },
		{ ...BASE, authority: "OFF" },
		{ ...BASE, authority: "PROTECTED" },
		{ ...BASE, authorityConfirmed: false },
		{ ...BASE, authorityGeneration: null },
		{ ...BASE, packet: { action: "nudge", ownedAction: "nudge", generation: "gen-6" } },
	] as const;
	for (const input of states) {
		const decision = admitActuator({ ...BASE, ...input });
		expect(decision.verdict).toBe("REFUSE");
		expect(decision.admittedAction).toBeNull();
	}
});

// [b] planted negative: an inherited product packet during pause records
// refusal with no admitted action.
test("[b] planted: inherited packet during pause refuses with zero effects", () => {
	const decision = admitActuator({
		...BASE,
		authority: "PAUSED",
		packet: { action: "nudge", ownedAction: "nudge", generation: "gen-7" },
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
	expect(decision.reason).toContain("paused");
});

// [b] planted negative: recovery on a dead-owner observation refuses, and
// send permission alone is not recovery custody.
test("[b] planted: dead-owner recovery refuses", () => {
	const decision = admitActuator({
		...BASE,
		packet: { action: "tracker-recovery", ownedAction: "tracker-recovery", generation: "gen-7" },
		recovery: { hasOwnRecoveryCustody: true, ownerLive: false },
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});

test("[b] planted: send permission without recovery custody refuses", () => {
	const decision = admitActuator({
		...BASE,
		packet: { action: "tracker-recovery", ownedAction: "tracker-recovery", generation: "gen-7" },
		recovery: { hasOwnRecoveryCustody: false, ownerLive: true },
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
	expect(decision.reason).toContain("custody");
});

// [b] planted negative: a STARTED flush without a footer spinner cannot
// become idle or authorize resend.
test("[b] planted: STARTED without spinner authorizes no resend", () => {
	const decision = admitActuator({
		...BASE,
		resend: { flushResult: "STARTED", spinnerVisible: false },
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});

// [b] positive: separately authorized isolated recovery with its own live
// custody proceeds to its one owned action.
test("[b] recovery with its own live custody admits one action", () => {
	const decision = admitActuator({
		...BASE,
		packet: { action: "tracker-recovery", ownedAction: "tracker-recovery", generation: "gen-7" },
		recovery: { hasOwnRecoveryCustody: true, ownerLive: true },
	});
	expect(decision.verdict).toBe("ADMIT");
	expect(decision.admittedAction).toBe("tracker-recovery");
});
// Binding mode: branches with no keeper surface stay bound by authority,
// generation, recovery and resend rules; the missing surface is recorded.
test("[a] mode none admits with the missing keeper surface recorded", () => {
	const decision = admitActuator({ ...BASE, launcherBinding: "none", launchers: [], keeper: null });
	expect(decision.verdict).toBe("ADMIT");
	expect(decision.admittedAction).toBe("nudge");
	expect(decision.reason).toContain("no keeper surface");
});

test("[a] planted: mode none still refuses a paused authority", () => {
	const decision = admitActuator({ ...BASE, launcherBinding: "none", launchers: [], keeper: null, authority: "PAUSED" });
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});

test("[a] planted: mode none still refuses a stale generation", () => {
	const decision = admitActuator({
		...BASE,
		launcherBinding: "none",
		launchers: [],
		keeper: null,
		packet: { action: "nudge", ownedAction: "nudge", generation: "gen-6" },
	});
	expect(decision.verdict).toBe("REFUSE");
	expect(decision.admittedAction).toBeNull();
});
