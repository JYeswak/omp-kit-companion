import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBoxes, verifyBead } from "../../src/verify.ts";
import { acceptanceDigest, receiptPath } from "../../src/self-replay-receipt.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
import { createFlywheelHost, toolCall, type ExecCall } from "../fleet-guard/kit-flywheel-host.ts";

// SELFREPLAYGATE1 (ompkit-gh3sj): the hand-over to review needs the assignee's passing --self-replay receipt.
// These drive the real verifyBead replay and the live flywheel guard path; only the tracker answers are fixtures.
// This bounds fixture Git initialization/publication and verification subprocesses, not a product latency contract.
jest.setTimeout(fixtureDeadlineS(30) * 1_000);
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const markerRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-self-replay-gate", markerRoot === undefined ? {} : { root: markerRoot }).path;
const inProgress = (acceptance: string) => ({ ...inReview(acceptance), status: "in_progress" });
const PASSING = "- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail";
const FAILING = "- [ ] [b] [landed] `sh scripts/bad.sh` -> selftest: PASS";
const LIVE = "- [ ] [c] [live] `sh scripts/never-run.sh` -> installed kit prints ok";
const AFTER = "- [ ] [d] [after] `sh scripts/never-run.sh` -> next release prints ok";
const REVIEW = "br update kit-1 --status in_review --actor Author";

let seq = 0;
/** A private kit state dir per case, so receipts never leak between tests or into the real state. */
function stateHome(): Record<string, string> {
	const dir = join(base, `state-${++seq}`);
	mkdirSync(dir, { recursive: true });
	return { XDG_STATE_HOME: dir };
}

/** The tracker as the guard reads it: `br show` answers with the bead record, every other exec is not stubbed. */
const trackerResponder = (record: () => Record<string, unknown>) => (call: ExecCall) => {
	if (call.command === "br" && call.args[0] === "show") return { stdout: JSON.stringify([record()]), stderr: "", code: 0 };
	return { stdout: "", stderr: "not stubbed", code: 127 };
};

async function selfReplay(name: string, acceptance: string, bead = "kit-1") {
	const { dir, sha } = await repo(name);
	const br = fakeBr({ ...inProgress(acceptance), id: bead });
	const state = stateHome();
	const res = await verifyBead({ bead, exportSha: sha, repo: dir, actor: "Author", env: { ...br.env, ...state }, selfReplay: true });
	return { dir, sha, br, state, res };
}

async function review(dir: string, state: Record<string, string>, record: () => Record<string, unknown>, command = REVIEW) {
	const h = await createFlywheelHost(base, { env: state, respond: trackerResponder(record) });
	return toolCall(h, dir, command);
}

test("SELFREPLAYGATE1: a passing self-replay writes a receipt bound to bead, export, acceptance, actor and each box, and the guard admits in_review", async () => {
	const { dir, sha, state, br, res } = await selfReplay("gate-pass", PASSING);
	expect(res.code).toBe("SELF_REPLAY");
	expect(res.ok).toBe(true);
	const path = receiptPath(state, "kit-1")!;
	expect(res.log).toContain(path);
	const receipt = JSON.parse(readFileSync(path, "utf8"));
	expect(receipt.bead).toBe("kit-1");
	expect(receipt.export).toBe(sha);
	expect(receipt.actor).toBe("Author");
	expect(receipt.acceptance_sha256).toBe(acceptanceDigest(parseBoxes(PASSING)));
	expect(Date.parse(receipt.time)).not.toBeNaN();
	expect(receipt.boxes).toHaveLength(1);
	expect(receipt.boxes[0]).toMatchObject({ index: res.replays[0]!.index, phase: "landed", command: "sh scripts/t.sh", verdict: "PASS" });
	expect(receipt.boxes[0].output_sha256).toMatch(/^[0-9a-f]{64}$/);
	const result = await review(dir, state, () => br.state());
	expect(result?.block).not.toBe(true);
});

test("SELFREPLAYGATE1 planted: no receipt refuses and names the exact self-replay command", async () => {
	const { dir } = await repo("gate-none");
	const br = fakeBr(inProgress(PASSING));
	const result = await review(dir, stateHome(), () => br.state());
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELFREPLAYGATE1");
	expect(result?.reason).toContain("omp-kit verify kit-1 --export <sha> --self-replay");
});

test("SELFREPLAYGATE1 planted: a FAIL box refuses even though the receipt exists", async () => {
	const { dir, sha, state, br, res } = await selfReplay("gate-fail", [PASSING, FAILING].join("\n"));
	expect(res.replays.map(r => r.pass)).toEqual([true, false]);
	const receipt = JSON.parse(readFileSync(receiptPath(state, "kit-1")!, "utf8"));
	expect(receipt.boxes.map((b: { verdict: string }) => b.verdict)).toEqual(["PASS", "FAIL"]);
	const result = await review(dir, state, () => br.state());
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELFREPLAYGATE1");
	expect(result?.reason).toContain("no PASS for box index");
	expect(result?.reason).toContain(`omp-kit verify kit-1 --export ${sha} --self-replay`);
});

test("SELFREPLAYGATE1 planted: a receipt for another bead refuses", async () => {
	const { dir, state, br } = await selfReplay("gate-other", PASSING, "kit-1");
	const other = receiptPath(state, "kit-2")!;
	copyFileSync(receiptPath(state, "kit-1")!, other);
	const two = fakeBr({ ...inProgress(PASSING), id: "kit-2" });
	expect(br.state().id).toBe("kit-1");
	const result = await review(dir, state, () => two.state(), "br update kit-2 --status in_review --actor Author");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("names kit-1, not kit-2");
	expect(result?.reason).toContain("omp-kit verify kit-2 --export <sha> --self-replay");
});

test("SELFREPLAYGATE1 planted: an acceptance edit after the receipt refuses", async () => {
	const { dir, state, br } = await selfReplay("gate-edit", PASSING);
	const edited = `${PASSING}\n- [ ] [b] [landed] \`sh scripts/t.sh\` -> 16 pass 0 fail`;
	const result = await review(dir, state, () => ({ ...br.state(), acceptance_criteria: edited }));
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("acceptance boxes changed after the self-replay receipt");
});

test("SELFREPLAYGATE1 planted: a receipt by a non-assignee refuses (reassigned bead, and a receipt rewritten to another actor)", async () => {
	const { dir, state, br } = await selfReplay("gate-actor", PASSING);
	const reassigned = await review(dir, state, () => ({ ...br.state(), assignee: "Peer" }));
	expect(reassigned?.block).toBe(true);
	expect(reassigned?.reason).toContain("receipt is by Author, but Peer is kit-1's assignee");
	const path = receiptPath(state, "kit-1")!;
	const receipt = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...receipt, actor: "Peer" }));
	const borrowed = await review(dir, state, () => br.state());
	expect(borrowed?.block).toBe(true);
	expect(borrowed?.reason).toContain("receipt is by Peer, but Author is kit-1's assignee");
});

test("SELFREPLAYGATE1: a bead with no acceptance boxes (an epic) needs no receipt", async () => {
	const { dir } = await repo("gate-epic");
	const br = fakeBr(inProgress("Epic: the children carry the boxes."));
	const result = await review(dir, stateHome(), () => br.state());
	expect(result?.block).not.toBe(true);
});

test("SELFREPLAYGATE1: the guard only reads; it runs no replay and writes no receipt", async () => {
	const { dir } = await repo("gate-readonly");
	const br = fakeBr(inProgress(PASSING));
	const state = stateHome();
	const h = await createFlywheelHost(base, { env: state, respond: trackerResponder(() => br.state()) });
	await toolCall(h, dir, REVIEW);
	expect(h.execs.filter(c => c.command === "sh" || c.command === "bun")).toEqual([]);
	expect(() => readFileSync(receiptPath(state, "kit-1")!, "utf8")).toThrow();
});

test("SELFREPLAYGATE1-phases: only [live]/[after] unticked passes after self-replay of the build boxes", async () => {
	const { dir, state, br, res } = await selfReplay("gate-phases-pass", [PASSING, LIVE, AFTER].join("\n"));
	expect(res.code).toBe("SELF_REPLAY");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["c", null], ["d", null]]);
	const receipt = JSON.parse(readFileSync(receiptPath(state, "kit-1")!, "utf8"));
	expect(receipt.boxes.map((b: { phase: string; verdict: string }) => [b.phase, b.verdict])).toEqual([["landed", "PASS"], ["live", "PENDING"], ["after", "PENDING"]]);
	const result = await review(dir, state, () => br.state());
	expect(result?.block).not.toBe(true);
});

test("SELFREPLAYGATE1-phases planted: one failing [build] box beside [live]/[after] boxes refuses", async () => {
	const failingBuild = "- [ ] [b] [build] `sh scripts/bad.sh` -> selftest: PASS";
	const { dir, sha, state, br, res } = await selfReplay("gate-phases-fail", [PASSING, failingBuild, LIVE, AFTER].join("\n"));
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", false], ["c", null], ["d", null]]);
	const result = await review(dir, state, () => br.state());
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("SELFREPLAYGATE1");
	expect(result?.reason).toContain(`omp-kit verify kit-1 --export ${sha} --self-replay`);
});

// --- review follow-up: fixes 1-9 -------------------------------------------------------------------------------------------------

const GOOD_B = "- [ ] [b] [build] `sh scripts/t.sh` -> 16 pass 0 fail";
const ticked = (acceptance: string) => acceptance.replaceAll("- [ ]", "- [x]");
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

/** `br show <id>` answers from a per-id table; any other exec is not stubbed. */
const tableResponder = (records: Record<string, () => Record<string, unknown>>) => (call: ExecCall) => {
	if (call.command === "br" && call.args[0] === "show") {
		const record = records[call.args[1]!];
		if (record !== undefined) return { stdout: JSON.stringify([record()]), stderr: "", code: 0 };
	}
	return { stdout: "", stderr: "not stubbed", code: 127 };
};

test("SELFREPLAYGATE1 planted: an unresolved or missing bead id refuses even with a good receipt for the bead the tracker would answer", async () => {
	const { dir, state, br } = await selfReplay("gate-unresolved", PASSING);
	const forms = [
		"br update $BEAD --status in_review --actor Author",
		'br update "$X" --status in_review --actor Author',
		"br update $(printf kit-1) --status in_review --actor Author",
		"for b in kit-1; do br update $b --status in_review --actor Author; done",
		"br update --status in_review --actor Author",
	];
	for (const command of forms) {
		const result = await review(dir, state, () => br.state(), command);
		expect(result?.block, command).toBe(true);
		expect(result?.reason, command).toContain("SELFREPLAYGATE1");
	}
	expect((await review(dir, state, () => br.state()))?.block).not.toBe(true);
});

test("SELFREPLAYGATE1: replay, tick the boxes in a separate update, then in_review is admitted; a box body edited after the replay is refused", async () => {
	const acceptance = [PASSING, GOOD_B].join("\n");
	const { dir, state, br } = await selfReplay("gate-tick", acceptance);
	const admitted = await review(dir, state, () => ({ ...br.state(), acceptance_criteria: ticked(acceptance) }));
	expect(admitted?.block).not.toBe(true);
	const edited = ticked(acceptance).replace("16 pass 0 fail", "1 pass 0 fail");
	const refused = await review(dir, state, () => ({ ...br.state(), acceptance_criteria: edited }));
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("acceptance boxes changed after the self-replay receipt");
});

test("SELFREPLAYGATE1 planted: an unreadable br show (lock timeout, bad JSON) refuses with a retry message instead of skipping the gate", async () => {
	const { dir, state } = await selfReplay("gate-unreadable", PASSING);
	for (const answer of [{ stdout: "", stderr: "database is locked", code: 1 }, { stdout: "not json", stderr: "", code: 0 }]) {
		const h = await createFlywheelHost(base, { env: state, respond: () => answer });
		const result = await toolCall(h, dir, REVIEW);
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("SELFREPLAYGATE1");
		expect(result?.reason).toContain("retry");
	}
});

test("SELFREPLAYGATE1 planted: an acceptance edit in the same br update as --status in_review refuses with edit acceptance, self-replay, then move", async () => {
	const { dir, state, br } = await selfReplay("gate-sameedit", PASSING);
	for (const flag of ["--acceptance-criteria 'x'", "--add-acceptance 'x'", "--acceptance='x'", "--acceptance 'x'"]) {
		const result = await review(dir, state, () => br.state(), `br update kit-1 --status in_review ${flag} --actor Author`);
		expect(result?.block, flag).toBe(true);
		expect(result?.reason, flag).toContain("edit acceptance, self-replay, then move");
	}
	// ticking boxes in the same call is not an acceptance edit
	const tick = await review(dir, state, () => br.state(), "br update kit-1 --status in_review --check-acceptance 1 --actor Author");
	expect(tick?.block).not.toBe(true);
});

test("SELFREPLAYGATE1 planted: the DONE line's sha binds the receipt: another commit refuses, the receipt's own (full or prefix) admits, none admits and prints the receipt's sha", async () => {
	const { dir, sha, state, br } = await selfReplay("gate-sha", PASSING);
	const handOver = (comment: string) => review(dir, state, () => br.state(), `br update kit-1 --status in_review --transition-comment '${comment}' --actor Author`);
	const wrong = await handOver("DONE omp-kit@deadbe1 landed");
	expect(wrong?.block).toBe(true);
	expect(wrong?.reason).toContain("deadbe1");
	expect(wrong?.reason).toContain(sha);
	expect(wrong?.reason).toContain(`omp-kit verify kit-1 --export ${sha} --self-replay`);
	expect(wrong?.reason).not.toContain("<sha>");
	let n = 7;
	while (n < 40 && !(/[a-f]/.test(sha.slice(0, n)))) n += 1;
	for (const named of [sha, sha.slice(0, n)]) expect((await handOver(`DONE omp-kit@${named} landed`))?.block, named).not.toBe(true);
	const none = await handOver("DONE nothing named here, 20261124 only");
	expect(none?.block).not.toBe(true);
	expect(none?.additionalContext).toContain(sha);
	const noDone = await handOver("landed export deadbe1 with no DONE line");
	expect(noDone?.block).not.toBe(true);
});

test("SELFREPLAYGATE1: only the DONE subject binds; a parent, a series, a pasted digest, a hash-like file name and hex-spelled words beside it admit", async () => {
	const { dir, sha, state, br } = await selfReplay("gate-sha-scope", PASSING);
	const handOver = (comment: string) => review(dir, state, () => br.state(), `br update kit-1 --status in_review --transition-comment '${comment}' --actor Author`);
	const short = sha.slice(0, 10);
	for (const comment of [
		`DONE omp-kit@${short} on top of b8a4ddd5db`,
		`DONE omp-kit@${short} (follow-up to b8a4ddd5db, 4a95cf28bd)`,
		`DONE omp-kit@${short} digest ab12cd34ef56 in src/e5d0cafe.ts, face2face cafe1234 decade20`,
		`Notes: base b8a4ddd5db\nDONE omp-kit@${short} landed\nLesson: scope the bind`,
	]) {
		const result = await handOver(comment);
		expect(result?.block, comment).not.toBe(true);
		expect(result?.additionalContext, comment).toContain(sha);
	}
	// planted: the DONE sha itself is not the receipt's export, even with the export named beside it
	const wrongDone = await handOver(`DONE omp-kit@b8a4ddd5db on top of ${short}`);
	expect(wrongDone?.block).toBe(true);
	expect(wrongDone?.reason).toContain("b8a4ddd5db");
	// a bare sha subject binds too
	expect((await handOver("DONE b8a4ddd5db landed"))?.block).toBe(true);
	expect((await handOver(`DONE ${short} landed`))?.block).not.toBe(true);
});

test("SELFREPLAYGATE1 planted: a DONE ref that is not a sha (HEAD, a branch, a substitution) refuses with name the exact sha you replayed", async () => {
	const { dir, sha, state, br } = await selfReplay("gate-sha-ref", PASSING);
	for (const ref of ["HEAD", "main", "$(git rev-parse HEAD)", "feature/x"]) {
		const result = await review(dir, state, () => br.state(), `br update kit-1 --status in_review --transition-comment 'DONE omp-kit@${ref} landed' --actor Author`);
		expect(result?.block, ref).toBe(true);
		expect(result?.reason, ref).toContain("name the exact sha you replayed");
		expect(result?.reason, ref).toContain(sha);
	}
});

test("SELFREPLAYGATE1: --self-replay that could not write its receipt exits non-zero with the reason", async () => {
	const { dir, sha } = await repo("gate-nowrite");
	const br = fakeBr(inProgress(PASSING));
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--actor", "Author", "--self-replay", "--project", dir, "--json"],
		{ cwd: base, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env, XDG_STATE_HOME: "relative/state" } });
	const out = new TextDecoder().decode(r.stdout);
	expect(r.rc).not.toBe(0);
	expect(out).toContain("NOT WRITTEN");
	expect(out).toContain("SELF_REPLAY");
});

test("SELFREPLAYGATE1: with no usable state dir a bead with only [live]/[after]/[v] boxes is admitted, and one with a build box is refused for it", async () => {
	const { dir } = await repo("gate-nostate");
	const unusable = { XDG_STATE_HOME: "relative/state" };
	const exempt = fakeBr(inProgress([LIVE, AFTER, "- [ ] [v] [build] Judge whether the analysis is complete"].join("\n")));
	expect((await review(dir, unusable, () => exempt.state()))?.block).not.toBe(true);
	const needs = fakeBr(inProgress(PASSING));
	const refused = await review(dir, unusable, () => needs.state());
	expect(refused?.block).toBe(true);
	expect(refused?.reason).toContain("no usable kit state dir");
});

test("SELFREPLAYGATE1: a [v] judgement box is exempt from the receipt", async () => {
	const { dir, state, br, res } = await selfReplay("gate-v", [PASSING, "- [ ] [v] [build] Judge whether the analysis is complete"].join("\n"));
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	const receipt = JSON.parse(readFileSync(receiptPath(state, "kit-1")!, "utf8"));
	expect(receipt.boxes.map((b: { verdict: string }) => b.verdict)).toEqual(["PASS"]);
	expect((await review(dir, state, () => br.state()))?.block).not.toBe(true);
});

test("SELFREPLAYGATE1 planted: with several ids in one call the second id's missing receipt refuses", async () => {
	const { dir, state, br } = await selfReplay("gate-multi", PASSING);
	const two = fakeBr({ ...inProgress(PASSING), id: "kit-2" });
	const h = await createFlywheelHost(base, { env: state, respond: tableResponder({ "kit-1": () => br.state(), "kit-2": () => two.state() }) });
	const result = await toolCall(h, dir, "br update kit-1 kit-2 --status in_review --actor Author");
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain("kit-2 has no self-replay receipt");
	const ok = await toolCall(h, dir, "br update kit-1 --status in_review --actor Author");
	expect(ok?.block).not.toBe(true);
});

test("SELFREPLAYGATE1: the refusal names --tracker <repo> (the flag verify takes) when the bead's tracker is not the session cwd, and not otherwise", async () => {
	const { dir } = await repo("gate-project");
	const other = join(base, "other-tracker");
	mkdirSync(join(other, ".beads"), { recursive: true });
	const br = fakeBr(inProgress(PASSING));
	const state = stateHome();
	const remote = await review(dir, state, () => br.state(), `br update kit-1 --status in_review --actor Author --db ${join(other, ".beads", "beads.db")}`);
	expect(remote?.block).toBe(true);
	expect(remote?.reason).toContain(`omp-kit verify kit-1 --export <sha> --self-replay --tracker ${other}`);
	const local = await review(dir, state, () => br.state());
	expect(local?.block).toBe(true);
	expect(local?.reason).toContain("omp-kit verify kit-1 --export <sha> --self-replay`");
	expect(local?.reason).not.toContain("--project");
	expect(local?.reason).not.toContain("--tracker");
	expect(remote?.reason).not.toContain("--project");
});
