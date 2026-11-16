import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	appendVerifyCorrection, beginVerifyAttempt, finalizeVerifyAttempt, inspectVerifyLedger,
	type OriginalClaimEvidence, type VerifyAttemptBegin, type VerifyAttemptContext, type VerifyFinalEvidence,
} from "../../src/verify-ledger.ts";

const unknownModel = { status: "UNKNOWN", reason: "NO_CAUSAL_MODEL" } as const;
const author: OriginalClaimEvidence = {
	status: "UNKNOWN", reason: "NO_CLAIM_EVIDENCE", operation_id: null, actor: null,
	incarnation: null, captured_at: null, intent_sha256: null, attribution: unknownModel,
};
function context(bead = "ompkit-test", beadCreatedAt: string | null = null, tracker = "/tracker/default.db"): VerifyAttemptContext {
	return { tracker, bead, export_requested: "abc123", export_commit: "a".repeat(40),
		bead_created_at: beadCreatedAt, author, verifier: { actor: "reviewer", attribution: unknownModel } };
}
function evidence(outcome: VerifyFinalEvidence["outcome"], result_code = "0"): VerifyFinalEvidence {
	return { result_code, outcome, reason: `result-${result_code}`, replayed: outcome === "PASS" || outcome === "FAIL", export_commit: "a".repeat(40) };
}
function state(): { root: string; cleanup(): void } {
	const owned = ownedTmp("verify-ledger-test");
	return { root: owned.path, cleanup: owned.cleanup };
}
function recorded(result: VerifyAttemptBegin) {
	expect(result.status).toBe("RECORDED");
	if (result.status !== "RECORDED") throw new Error("attempt unavailable");
	return result.attempt;
}

test("FIRSTVERIFY1 preserves first durable FAIL through later PASS and conflicting finalize", async () => {
	const fixture = state();
	try {
		writeFileSync(join(fixture.root, "control.json"), "foreign control data\n");
		const first = recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_000));
		expect((await finalizeVerifyAttempt(first, evidence("FAIL", "7"), 1_800_000_000_001)).status).toBe("FINALIZED");
		const later = recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_002));
		expect((await finalizeVerifyAttempt(later, evidence("PASS", "0"), 1_800_000_000_003)).status).toBe("FINALIZED");
		expect((await finalizeVerifyAttempt(first, evidence("FAIL", "7"), 1_800_000_000_004)).status).toBe("ALREADY_FINALIZED");
		expect((await finalizeVerifyAttempt(first, evidence("PASS", "0"), 1_800_000_000_005)).status).toBe("CONFLICT");
		const report = inspectVerifyLedger(fixture.root, 1_800_000_000_006);
		expect(report.first_attempts).toHaveLength(1);
		expect(report.first_attempts[0]?.outcome).toBe("FAIL");
		expect(readFileSync(join(fixture.root, "control.json"), "utf8")).toBe("foreign control data\n");
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 selects an earlier incomplete begin even when a later PASS finishes first", async () => {
	const fixture = state();
	try {
		const earlier = recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_000));
		const later = recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_001));
		expect((await finalizeVerifyAttempt(later, evidence("PASS"), 1_800_000_000_002)).status).toBe("FINALIZED");
		const report = inspectVerifyLedger(fixture.root, 1_800_000_000_003);
		expect(report.first_attempts[0]?.id).toBe(earlier.id);
		expect(report.first_attempts[0]?.outcome).toBe("INCOMPLETE");
		await finalizeVerifyAttempt(earlier, evidence("PASS", "0"), 1_800_000_000_004);
		expect(inspectVerifyLedger(fixture.root, 1_800_000_000_005).first_attempts[0]?.id).toBe(earlier.id);
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 correction appends lineage without replacing original outcome or author", async () => {
	const fixture = state();
	try {
		const attempt = recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_000));
		await finalizeVerifyAttempt(attempt, evidence("FAIL", "9"), 1_800_000_000_001);
		const corrected = await appendVerifyCorrection(attempt, { reason: "claim attribution corrected", author: {
			...author, reason: "newer claim capture", actor: "new-author",
		} }, 1_800_000_000_002);
		expect(corrected.status).toBe("FINALIZED");
		const report = inspectVerifyLedger(fixture.root, 1_800_000_000_003);
		expect(report.first_attempts[0]?.outcome).toBe("FAIL");
		expect(report.first_attempts[0]?.context.author.actor).toBeNull();
		expect(report.attempts[0]?.context.author.actor).toBeNull();
		expect(report.attempts[0]?.corrections).toEqual([{
			at: new Date(1_800_000_000_002).toISOString(), reason: "claim attribution corrected",
			author: { ...author, reason: "newer claim capture", actor: "new-author" },
		}]);
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 non-replayed PASS and FAIL both project as UNJUDGED", async () => {
	const fixture = state(), now = 1_800_000_000_000;
	try {
		const passAttempt = recorded(await beginVerifyAttempt(fixture.root, context("no-replay-pass"), now));
		expect((await finalizeVerifyAttempt(passAttempt, { ...evidence("PASS"), replayed: false }, now + 1)).status).toBe("FINALIZED");
		const failAttempt = recorded(await beginVerifyAttempt(fixture.root, context("no-replay-fail"), now + 2));
		expect((await finalizeVerifyAttempt(failAttempt, { ...evidence("FAIL"), replayed: false }, now + 3)).status).toBe("FINALIZED");
		const report = inspectVerifyLedger(fixture.root, now + 4);
		expect(report.attempts.map(attempt => attempt.outcome)).toEqual(["UNJUDGED", "UNJUDGED"]);
		expect(report.counts.pass).toBe(0);
		expect(report.counts.fail).toBe(0);
	} finally { fixture.cleanup(); }
});
test("FIRSTVERIFY1 missing retained page stays UNKNOWN and cannot admit a replacement attempt", async () => {
	const fixture = state();
	try {
		recorded(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_000));
		rmSync(join(fixture.root, "verify-evidence"), { recursive: true });
		const inspection = inspectVerifyLedger(fixture.root, 1_800_000_000_001);
		expect(inspection.status).toBe("UNKNOWN");
		expect(inspection.problems).toContain("LEDGER_MISSING_OR_UNSAFE");
		expect(await beginVerifyAttempt(fixture.root, context(), 1_800_000_000_002)).toMatchObject({ status: "UNAVAILABLE" });
		expect(inspectVerifyLedger(fixture.root, 1_800_000_000_003).status).toBe("UNKNOWN");
	} finally { fixture.cleanup(); }
});
test("FIRSTVERIFY1 never treats pre-recorder bead history as a proven first PASS", async () => {
	const old = state(), recent = state(), now = 1_800_000_000_000;
	try {
		const oldAttempt = recorded(await beginVerifyAttempt(old.root, context(), now));
		await finalizeVerifyAttempt(oldAttempt, evidence("PASS"), now + 1);
		const oldReport = inspectVerifyLedger(old.root, now + 2);
		expect(oldReport.first_attempts[0]?.outcome).toBe("PASS");
		expect(oldReport.first_attempts[0]?.coverage).toBe("UNKNOWN");
		expect(oldReport.problems).toContain("PRE_RECORDER_HISTORY_UNRESOLVED");

		const recentAttempt = recorded(await beginVerifyAttempt(recent.root,
			context("new-bead", new Date(now).toISOString()), now));
		await finalizeVerifyAttempt(recentAttempt, evidence("PASS"), now + 1);
		const recentReport = inspectVerifyLedger(recent.root, now + 2);
		expect(recentReport.first_attempts[0]?.coverage).toBe("KNOWN");
	} finally { old.cleanup(); recent.cleanup(); }
});
test("FIRSTVERIFY1 malformed and torn journal lines keep readable outcomes UNKNOWN and block begin", async () => {
	const fixture = state(), now = 1_800_000_000_000;
	try {
		const attempt = recorded(await beginVerifyAttempt(fixture.root, context("corrupt", new Date(now).toISOString()), now));
		await finalizeVerifyAttempt(attempt, evidence("FAIL", "7"), now + 1);
		const page = join(fixture.root, "verify-evidence", `${new Date(now).toISOString().slice(0, 10)}.jsonl`);
		appendFileSync(page, "{\"malformed\":\n{\"torn\":");
		const report = inspectVerifyLedger(fixture.root, now + 2);
		expect(report.status).toBe("UNKNOWN");
		expect(report.problems).toContain("PAGE_PARSE_ERROR");
		expect(report.problems).toContain("PAGE_TORN_TAIL");
		expect(report.attempts[0]?.outcome).toBe("FAIL");
		expect(await beginVerifyAttempt(fixture.root, context("retry", new Date(now + 3).toISOString()), now + 3))
			.toMatchObject({ status: "UNAVAILABLE" });
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 same-inode truncation cannot promote a retained later PASS", async () => {
	const fixture = state(), now = 1_800_000_000_000;
	try {
		const bead = context("truncated", new Date(now).toISOString());
		const first = recorded(await beginVerifyAttempt(fixture.root, bead, now));
		await finalizeVerifyAttempt(first, evidence("FAIL", "7"), now + 1);
		const later = recorded(await beginVerifyAttempt(fixture.root, bead, now + 2));
		await finalizeVerifyAttempt(later, evidence("PASS"), now + 3);
		const page = join(fixture.root, "verify-evidence", `${new Date(now).toISOString().slice(0, 10)}.jsonl`);
		const lines = readFileSync(page, "utf8").split("\n");
		writeFileSync(page, lines.slice(2).join("\n"));
		const report = inspectVerifyLedger(fixture.root, now + 4);
		expect(report.status).toBe("UNKNOWN");
		expect(report.problems).toContain("PAGE_UNREGISTERED_REPLACED_OR_TRUNCATED");
		expect(report.first_attempts[0]?.outcome).toBe("PASS");
		expect(report.first_attempts[0]?.coverage).toBe("UNKNOWN");
		expect(report.counts.pass).toBe(0);
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 retention advances coverage for new beads but not a retried old bead", async () => {
	const fixture = state(), start = Date.UTC(2026, 0, 1), later = start + 35 * 86_400_000;
	try {
		const oldContext = context("old-bead", new Date(start).toISOString());
		const first = recorded(await beginVerifyAttempt(fixture.root, oldContext, start));
		await finalizeVerifyAttempt(first, evidence("FAIL", "7"), start + 1);
		const retry = recorded(await beginVerifyAttempt(fixture.root, oldContext, later));
		await finalizeVerifyAttempt(retry, evidence("PASS"), later + 1);
		const newAt = later + 2, newContext = context("new-bead", new Date(newAt).toISOString());
		const fresh = recorded(await beginVerifyAttempt(fixture.root, newContext, newAt));
		await finalizeVerifyAttempt(fresh, evidence("PASS"), newAt + 1);
		const report = inspectVerifyLedger(fixture.root, newAt + 2);
		const oldFirst = report.first_attempts.find(attempt => attempt.context.bead === "old-bead");
		const newFirst = report.first_attempts.find(attempt => attempt.context.bead === "new-bead");
		expect(report.coverage_start).toBe(new Date(Date.UTC(2026, 0, 8)).toISOString());
		expect(oldFirst?.outcome).toBe("PASS");
		expect(oldFirst?.coverage).toBe("UNKNOWN");
		expect(newFirst?.coverage).toBe("KNOWN");
		expect(report.counts.pass).toBe(1);
		expect(report.counts.unknown).toBe(1);
	} finally { fixture.cleanup(); }
});

test("FIRSTVERIFY1 tracker filter scopes attempts, bead coverage, and all-attempt counts", async () => {
	const fixture = state(), now = 1_800_000_000_000;
	try {
		const created = new Date(now).toISOString();
		const a = recorded(await beginVerifyAttempt(fixture.root, context("shared-bead", created, "/tracker/a.db"), now));
		await finalizeVerifyAttempt(a, evidence("PASS"), now + 1);
		const b = recorded(await beginVerifyAttempt(fixture.root, context("shared-bead", created, "/tracker/b.db"), now + 2));
		await finalizeVerifyAttempt(b, evidence("FAIL", "7"), now + 3);
		const report = inspectVerifyLedger(fixture.root, now + 4, "/tracker/a.db");
		expect(report.attempts).toHaveLength(1);
		expect(report.first_attempts).toHaveLength(1);
		expect(report.attempts[0]?.context.tracker).toBe("/tracker/a.db");
		expect(report.counts.pass).toBe(1);
		expect(report.counts.fail).toBe(0);
		expect(report.counts_definition).toContain("all recorded attempts");
	} finally { fixture.cleanup(); }
});
test("FIRSTVERIFY1 rejects non-object-ID export commits without consuming the attempt", async () => {
	const fixture = state(), now = 1_800_000_000_000;
	try {
		const attempt = recorded(await beginVerifyAttempt(fixture.root,
			context("exact-export", new Date(now).toISOString()), now));
		expect(await finalizeVerifyAttempt(attempt, { ...evidence("PASS"), export_commit: "abc123" }, now + 1))
			.toMatchObject({ status: "UNAVAILABLE" });
		expect((await finalizeVerifyAttempt(attempt, evidence("PASS"), now + 2)).status).toBe("FINALIZED");
	} finally { fixture.cleanup(); }
});
