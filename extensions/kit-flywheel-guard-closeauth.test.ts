import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { FlywheelExecResult } from "./kit-flywheel-guard";
import { createFlywheelHost, toolCall, type Responder } from "../tests/fleet-guard/kit-flywheel-host";
import { ownedTmp } from "../src/kitlib/tmp.ts";

// AGENTCLOSE1 (ompkit-fp72.120.16.124, C3 J-2026-11-03-49): filing a bead is not implementing it.

const base = ownedTmp("kit-flywheel-guard-closeauth").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

let seq = 0;
function project(): string {
	const dir = join(base, `proj-${process.pid}-${++seq}`);
	mkdirSync(dir);
	return dir;
}

const ACCEPTANCE = [
	"- [x] [a] [build] planted refusal `bun test a.test.ts` -> rc 0",
	"- [x] [b] [build] admitted path `bun test b.test.ts` -> rc 0",
].join("\n");
const RECORD = "PASS [a] [b] by non-author background verifier Jev96Verify (Claude family; disclosed) on export a9998f478ee0: [a] rc 0; [b] rc 0.";
const REASON = "verified by Jev96Verify (family: Claude) on export a9998f478ee0: [a] rc 0; [b] rc 0";

type Comment = { author: string; text: string; created_at?: string };

/** Comments get created_at t1, t2, ... in array order unless they carry their own. */
function row(id: string, assignee: string | null, comments: Comment[], status = "in_review"): FlywheelExecResult {
	const stamped = comments.map((comment, index) => ({ created_at: `2026-11-04T0${index + 1}:00:00Z`, ...comment }));
	return {
		stdout: JSON.stringify([{ id, title: "t", status, assignee, created_by: "PeachLeopard", acceptance_criteria: ACCEPTANCE, comments: stamped }]),
		stderr: "",
		code: 0,
	};
}

/** `br show` answers from rows; `br info` names a fixture db; sqlite3 returns that bead's rework event times. */
function table(rows: Record<string, FlywheelExecResult>, reworkAt: Record<string, string[]> = {}): Responder {
	return call => {
		if (call.command === "tmux") return { stdout: "", stderr: "no server", code: 1 };
		if (call.command === "env") return { stdout: "", stderr: "", code: 0 };
		if (call.args[0] === "info") return { stdout: '{"database_path":"/fixture/beads.db"}', stderr: "", code: 0 };
		if (call.command === "sqlite3") {
			const id = /issue_id='([^']+)'/.exec(call.args.at(-1) ?? "")?.[1] ?? "";
			return { stdout: (reworkAt[id] ?? []).map(at => `${at}\n`).join(""), stderr: "", code: 0 };
		}
		return rows[call.args[1] ?? ""] ?? { stdout: JSON.stringify({ error: { message: "Issue not found" } }), stderr: "", code: 3 };
	};
}

const done = { author: "RubyMeadow", text: "DONE export a9998f478ee0: [a] rc 0; [b] rc 0" };

test("AGENTCLOSE1 planted: the assignee closing its own bead is still refused, verify record or not", async () => {
	const h = await createFlywheelHost(base, { respond: table({ "k-1": row("k-1", "RubyMeadow", [done, { author: "PeachLeopard", text: RECORD }]) }) });
	const result = await toolCall(h, project(), `br --actor RubyMeadow close k-1 --reason '${REASON}'`);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("k-1 is assigned to RubyMeadow, which is you");
});

test("AGENTCLOSE1: the filer closing a bead assigned to a different seat, on a verify record bound to an export sha, is admitted", async () => {
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-2": row("k-2", "RubyMeadow", [done, { author: "PeachLeopard", text: RECORD }]) }) });
	const result = await toolCall(h, project(), `br close k-2 --reason '${REASON}'`);
	expect(result?.block).not.toBe(true);
	expect(result?.additionalContext).toContain("AGENTCLOSE1");
	expect(result?.additionalContext).toContain("export a9998f478ee0");
	expect(result?.additionalContext).toContain("verifier family: Claude");
	expect(result?.additionalContext).toContain("implementer RubyMeadow");
	expect(result?.additionalContext).toContain("record by Jev96Verify (posted by PeachLeopard)");
});

test("AGENTCLOSE1: an omp-kit verify CLOSED comment is a verify record", async () => {
	const verify = { author: "Jev96Verify", text: "CLOSED k-3 by Jev96Verify (family: Claude)\nLesson: x\nexported a9998f478ee0 to /scratch/export\n[a] PASS bun test a.test.ts -> rc 0 (12 ms)\n[b] PASS bun test b.test.ts -> rc 0 (9 ms)" };
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-3": row("k-3", "RubyMeadow", [done, verify]) }) });
	const result = await toolCall(h, project(), `br close k-3 --reason '${REASON}'`);
	expect(result?.block).not.toBe(true);
	expect(result?.additionalContext).toContain("record by Jev96Verify (posted by Jev96Verify) on export a9998f478ee0");
});

test("AGENTCLOSE1 planted: the filer closing a bead assigned to a different seat with NO verify record is refused", async () => {
	const unbound = { author: "PeachLeopard", text: "PASS [a] [b] by Jev96Verify at HEAD a9998f478ee0" };
	const partial = { author: "PeachLeopard", text: "PASS [a] on export a9998f478ee0" };
	const failed = { author: "PeachLeopard", text: "PASS [a], [b] FAIL on export a9998f478ee0" };
	const byAuthor = { author: "RubyMeadow", text: RECORD };
	for (const comments of [[done], [done, unbound], [done, partial], [done, failed], [done, byAuthor]]) {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-4": row("k-4", "RubyMeadow", comments) }) });
		const result = await toolCall(h, project(), `br close k-4 --reason '${REASON}'`);
		expect(result?.block, JSON.stringify(comments)).toBe(true);
		expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
		expect(result?.reason).toContain("PeachLeopard is the bead filer");
		expect(result?.reason).toContain("non-author verification record");
	}
});

test("AGENTCLOSE1 planted: a verify record without a disclosed verifier family in the reason is refused", async () => {
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-5": row("k-5", "RubyMeadow", [done, { author: "PeachLeopard", text: RECORD }]) }) });
	for (const reason of ["verified on export a9998f478ee0: [a] rc 0; [b] rc 0", "verified (family: unknown) on export a9998f478ee0"]) {
		const result = await toolCall(h, project(), `br close k-5 --reason '${reason}'`);
		expect(result?.block, reason).toBe(true);
		expect(result?.reason).toContain("verifier family");
	}
});

// FILERCLOSE1 (ompkit-l5746): a filer closing on its own judgment is the anti-pattern; a self-posted record
// must name a distinct verifier `by <Name>`, and the reason must cite that verifier and the family.
test("AGENTCLOSE1 planted: the filer posting its own record with no distinct `by <Name>` verifier is refused", async () => {
	for (const text of [
		"PASS [a] [b] on export a9998f478ee0",
		"PASS [a] [b] by PeachLeopard on export a9998f478ee0",
		"PASS [a] [b] by RubyMeadow on export a9998f478ee0",
		"PASS [a] [b] verified by the lead on export a9998f478ee0",
	]) {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-8": row("k-8", "RubyMeadow", [done, { author: "PeachLeopard", text }]) }) });
		const result = await toolCall(h, project(), "br close k-8 --reason 'verified by PeachLeopard (family: Claude) on export a9998f478ee0'");
		expect(result?.block, text).toBe(true);
		expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
		expect(result?.reason).toContain("must name a distinct verifier as `by <Name>`");
	}
});

test("AGENTCLOSE1 control: a self-posted `by Jev96Verify` record plus a reason naming Jev96Verify and the family is admitted", async () => {
	const text = "PASS [a] [b] by Jev96Verify (Claude family) on export a9998f478ee0: [a] rc 0; [b] rc 0";
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-9": row("k-9", "RubyMeadow", [done, { author: "PeachLeopard", text }]) }) });
	const admitted = await toolCall(h, project(), `br close k-9 --reason '${REASON}'`);
	expect(admitted?.block).not.toBe(true);
	expect(admitted?.additionalContext).toContain("record by Jev96Verify (posted by PeachLeopard) on export a9998f478ee0");
	// planted: the same record, but the reason cites another verifier, is refused.
	const uncited = await toolCall(h, project(), "br close k-9 --reason 'verified by OtherVerify (family: Claude) on export a9998f478ee0'");
	expect(uncited?.block).toBe(true);
	expect(uncited?.reason).toContain("must cite Jev96Verify");
});

test("AGENTCLOSE1 planted: a filer who also wrote a DONE-first comment stays refused", async () => {
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-6": row("k-6", "RubyMeadow", [
		{ author: "PeachLeopard", text: "DONE export a9998f478ee0" }, { author: "Jev96Verify", text: RECORD },
	]) }) });
	const result = await toolCall(h, project(), `br close k-6 --reason '${REASON}'`);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("the bead filer and a DONE-first comment author");
});

test("AGENTCLOSE1 planted: the filer closing a bead with no assignee and no claim event is refused (fail closed)", async () => {
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-7": row("k-7", null, [{ author: "Jev96Verify", text: RECORD }]) }) });
	const result = await toolCall(h, project(), `br close k-7 --reason '${REASON}'`);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
	expect(result?.reason).toContain("no assignee, so its implementer is unknown");
});

// A newer negative verification comment, or a rework transition after the PASS, withdraws the PASS.
const pass = { author: "PeachLeopard", text: RECORD };

test("AGENTCLOSE1 planted: PASS at t1, then `REWORK [b] fails on export <sha>` at t2, is refused", async () => {
	for (const text of ["REWORK [b] fails on export a9998f478ee0", "[b] FAIL on export a9998f478ee0 by Jev96Verify", "PENDING [b] live readback"]) {
		const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-10": row("k-10", "RubyMeadow", [done, pass, { author: "PeachLeopard", text }]) }) });
		const result = await toolCall(h, project(), `br close k-10 --reason '${REASON}'`);
		expect(result?.block, text).toBe(true);
		expect(result?.reason).toContain("SELF_CLOSE_REFUSED");
		expect(result?.reason).toContain("The newest verification comment (by PeachLeopard) reports");
		expect(result?.reason).toContain("withdraws any older PASS");
	}
});

test("AGENTCLOSE1 planted: PASS at t1, then a rework status at t2, is refused", async () => {
	// The bead is in rework now.
	const now = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-11": row("k-11", "RubyMeadow", [done, pass], "rework") }) });
	const current = await toolCall(now, project(), `br close k-11 --reason '${REASON}'`);
	expect(current?.block).toBe(true);
	expect(current?.reason).toContain("in rework, which withdraws any earlier verification record");
	// The bead went to rework after the PASS (t2 = 03:00 > PASS at 02:00) and back to in_review with no new PASS.
	const event = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-12": row("k-12", "RubyMeadow", [done, pass]) }, { "k-12": ["2026-11-04T03:00:00.123456+00:00"] }) });
	const later = await toolCall(event, project(), `br close k-12 --reason '${REASON}'`);
	expect(later?.block).toBe(true);
	expect(later?.reason).toContain("moved to rework at 2026-11-04T03:00:00.123456+00:00, after its verification record");
	// planted: an unreadable record time or event log refuses rather than admits.
	const untimed = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table({ "k-13": row("k-13", "RubyMeadow", [done, { ...pass, created_at: "not a time" }]) }) });
	expect((await toolCall(untimed, project(), `br close k-13 --reason '${REASON}'`))?.reason).toContain("no readable created_at");
	const broken: Responder = call => call.command === "sqlite3" ? { stdout: "", stderr: "locked", code: 5 } : table({ "k-14": row("k-14", "RubyMeadow", [done, pass]) })(call);
	const unreadable = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: broken });
	expect((await toolCall(unreadable, project(), `br close k-14 --reason '${REASON}'`))?.reason).toContain("rework-event lookup failed");
});

test("AGENTCLOSE1 control: REWORK at t1, then PASS at t2, is admitted", async () => {
	const rework = { author: "Jev96Verify", text: "REWORK k-15: [b] fails on export 1234567abcde" };
	const h = await createFlywheelHost(base, { env: { AGENT_NAME: "PeachLeopard" }, respond: table(
		{ "k-15": row("k-15", "RubyMeadow", [rework, done, pass]) },
		{ "k-15": ["2026-11-04T01:00:00Z"] },
	) });
	const result = await toolCall(h, project(), `br close k-15 --reason '${REASON}'`);
	expect(result?.block).not.toBe(true);
	expect(result?.additionalContext).toContain("record by Jev96Verify (posted by PeachLeopard) on export a9998f478ee0");
});
