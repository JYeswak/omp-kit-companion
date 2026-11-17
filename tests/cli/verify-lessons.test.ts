import { afterAll, beforeAll, expect, jest, test } from "bun:test";

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { readLessonsLog } from "../../src/lessons.ts";
import { LIVE_READBACK_LABEL, liveReadback, verifyBead } from "../../src/verify.ts";
import { brun, createBead, fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity, row, sharedTracker, stateHash, tracker, trackerEnv } from "./verify-fixture.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";
// This bounds fixture Git initialization/publication and verification subprocesses,
// not a product latency contract; retain the 15-second floor and account for load.
jest.setTimeout(fixtureDeadlineS(15) * 1_000);
beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const markerRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-lesson-payload", markerRoot === undefined ? {} : { root: markerRoot }).path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const sourceBead = { id: "kit-source", status: "closed", assignee: "Author", labels: [], acceptance_criteria: "" };
const liveBead = (acceptance: string) => ({ id: "kit-live", status: "open", assignee: "ReadbackAuthor", updated_at: "2026-01-01T00:00:00Z",
	labels: [LIVE_READBACK_LABEL], acceptance_criteria: acceptance, dependencies: [{ id: "kit-source", dependency_type: "related" }] });

function localRow(dir: string): Record<string, unknown> {
	const lines = readFileSync(join(dir, ".omp", "lessons.local.jsonl"), "utf8").trim().split("\n");
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0]!) as Record<string, unknown>;
}

/** Hermetic status: the fixture repo owns its git dir, and the ceiling stops discovery
 * from escaping into the enclosing checkout. */
function porcelain(dir: string): string {
	const res = runFixture(["git", "status", "--porcelain"], { cwd: dir,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: dir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	expect(res.rc).toBe(0);
	return new TextDecoder().decode(res.stdout);
}

test("LESSONAUTO1 CLOSED verify appends one lessons.local.jsonl row with the bead id and lesson text", async () => {
	const { dir, sha } = await repo("lessonauto-closed", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "close lesson fixture" });
	expect(res.code).toBe("CLOSED");
	const row = localRow(dir);
	expect(row.bead).toBe("kit-1");
	expect(String(row.what)).toContain("close lesson fixture");
	expect(String(row.evidence)).toContain(sha);
	expect(Number.isFinite(Date.parse(String(row.ts)))).toBe(true);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("VERIFYLESSONSGREEN1 fixture closes with isolated history and restores untouched caller state", async () => {
	const callerState = join(base, "caller-state");
	mkdirSync(join(callerState, "omp-kit"), { recursive: true, mode: 0o755 });
	const sentinel = join(callerState, "omp-kit", "operator-history");
	writeFileSync(sentinel, "operator history must stay untouched\n");
	const script = `
		import * as fixture from ${JSON.stringify(new URL("./verify-fixture.ts", import.meta.url).href)};
		import { verifyBead } from ${JSON.stringify(new URL("../../src/verify.ts", import.meta.url).href)};
		fixture.installFixtureIdentity();
		let result;
		try {
			const { dir, sha } = await fixture.repo("isolated-history", {}, true);
			const br = fixture.fakeBr(fixture.inReview("- [ ] [a] [build] \`sh scripts/t.sh\` -> 0 fail"));
			result = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "isolated history fixture" });
		} finally {
			fixture.restoreFixtureIdentity();
		}
		console.log(JSON.stringify({ code: result.code, stateHome: process.env.XDG_STATE_HOME }));
	`;
	const result = await run([process.execPath, "-e", script], {
		cwd: base, env: { ...process.env, XDG_STATE_HOME: callerState }, deadline_s: fixtureDeadlineS(60),
	});
	expect(result.rc).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ code: "CLOSED", stateHome: callerState });
	expect(readFileSync(sentinel, "utf8")).toBe("operator history must stay untouched\n");
}, fixtureDeadlineS(90) * 1_000);

test("LESSONAUTO1 a second verify of the same bead appends none", async () => {
	const { dir, sha } = await repo("lessonauto-dedup", {}, true);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "lessons.local.jsonl"), JSON.stringify({ ts: new Date().toISOString(), repo: "lessonauto-dedup", agent: null, pane: null, model: null, kind: "LESSON", class: "OTHER:verify_close", what: "Lesson: earlier close", evidence: "verify kit-1 export earlier", cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: "kit-1" }) + "\n");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "new lesson text" });
	expect(res.code).toBe("CLOSED");
	expect(String(localRow(dir).what)).toContain("earlier close");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 a REWORK verdict adds no lessons row", async () => {
	const { dir, sha } = await repo("lessonauto-rework", {}, true);
	const br = fakeBr(inReview("- [ ] [b] [build] `sh scripts/bad.sh` -> prints PASS"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "rework lesson fixture" });
	expect(res.code).toBe("REWORK");
	expect(existsSync(join(dir, ".omp", "lessons.local.jsonl"))).toBe(false);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONAUTO1 planted: a PENDING verify leaves lessons unchanged", async () => {
	const { dir, sha } = await repo("lessonauto-pending", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [live] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "pending lesson fixture" });
	expect(res.code).toBe("PENDING");
	expect(existsSync(join(dir, ".omp", "lessons.local.jsonl"))).toBe(false);
	expect(existsSync(join(dir, ".omp", "lessons.jsonl"))).toBe(false);
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 a CLOSED verify leaves git status --porcelain empty", async () => {
	const { dir, sha } = await repo("lessondirt-clean", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "clean status fixture" });
	expect(res.code).toBe("CLOSED");
	expect(porcelain(dir)).toBe("");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 the lessons reader returns the new local lesson", async () => {
	const { dir, sha } = await repo("lessondirt-reader", {}, true);
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, lesson: "reader lesson fixture" });
	expect(res.code).toBe("CLOSED");
	const log = readLessonsLog(dir);
	expect(log.status).toBe("OK");
	const rows = log.entries.filter(entry => entry.bead === "kit-1");
	expect(rows).toHaveLength(1);
	expect(rows[0]!.what).toContain("reader lesson fixture");
}, fixtureDeadlineS(60) * 1_000);

test("LESSONDIRT1 planted: today's append dirties .omp/lessons.jsonl", async () => {
	const { dir } = await repo("lessondirt-tracked", {}, true);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(join(dir, ".omp", "lessons.jsonl"), JSON.stringify({ ts: new Date().toISOString(), repo: "lessondirt-tracked", agent: null, pane: null, model: null, kind: "LESSON", class: "OTHER:verify_close", what: "Lesson: tracked close", evidence: "verify kit-1 export earlier", cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: "kit-1" }) + "\n");
	expect(porcelain(dir).includes(".omp")).toBe(true);
}, fixtureDeadlineS(60) * 1_000);
test("LESSONPAYLOAD1 missing lesson refuses before replay and preserves the bead", async () => {
	const marker = join(base, "lesson-missing-replay");
	const { dir, sha } = await repo("lesson-missing", { "entered.sh": "#!/bin/sh\nprintf entered > \"$LESSON_REPLAY_MARKER\"\nprintf '0 fail\\n'\n" });
	const acceptance = "- [ ] [a] [build] `sh scripts/entered.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { comments: [] });
	const before = br.state();
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: { ...br.env, LESSON_REPLAY_MARKER: marker } });
	expect(res.code).toBe("LESSON_MISSING");
	expect(res.replays).toEqual([]);
	expect(existsSync(marker)).toBe(false);
	expect(br.state()).toEqual(before);
});

test("LESSONPAYLOAD1 newest author lesson reaches the real close-policy consumer", async () => {
	const { dir, sha } = await repo("lesson-author");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"), { comments: [
		{ id: 3, author: "AnotherReviewer", text: "Lesson: not the author's lesson", created_at: "2026-03-01T00:00:00Z" },
		{ id: 2, author: "Author", text: "Review notes\nLesson: preserve the committed frontier", created_at: "2026-02-01T00:00:00Z" },
		{ id: 1, author: "Author", text: "Lesson: old lesson", created_at: "2026-01-01T00:00:00Z" },
	] });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	const closed = br.state();
	expect(closed.status).toBe("closed");
	expect(closed.closed_transition).toContain("Lesson: preserve the committed frontier");
	expect(closed.closed_transition).not.toContain("not the author's lesson");
	const guarded = await run(["sh", join(import.meta.dir, "..", "..", "scripts", "close-guard.sh"), "kit-1", "--sub", "close", "--reason", String(closed.closed_transition)], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env, AGENT_NAME: "Peer" },
	});
	expect(new TextDecoder().decode(guarded.stderr)).toBe("");
	expect(guarded.rc).toBe(0);
// DEADLINETESTS1: 3x its observed load-normalized p95 (8.3 s, n=28 full-suite runs at load1 >= 18).
}, fixtureDeadlineS(25) * 1_000);

test("LESSONPAYLOAD1 CLI explicit lesson takes precedence over author comments", async () => {
	const { dir, sha } = await repo("lesson-cli");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--lesson", "explicit reviewer finding", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	expect(new TextDecoder().decode(r.stderr)).not.toContain("Unknown flag");
	expect(r.rc).toBe(0);
	expect(br.state().status).toBe("closed");
	expect(br.state().closed_transition).toContain("Lesson: explicit reviewer finding");
	expect(br.state().closed_transition).not.toContain("fixture review");
});

test("LESSONPAYLOAD1 refused final act reports ACT_FAILED and restores original boxes", async () => {
	const { dir, sha } = await repo("lesson-act-failed");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "close kit-1", failMessage: `policy denies final close ${"detail ".repeat(80)}ACTION_STDERR_END` });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.replays.map(r => r.pass)).toEqual([true]);
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("policy denies final close");
	expect(res.log).toContain("ACTION_STDERR_END");
	expect(res.rollback).toMatchObject({ status: "RESTORED" });
	expect(br.state().status).toBe("in_review");
	expect(br.state().acceptance_criteria).toBe(acceptance);
});

test("LESSONPAYLOAD1 genuine failed replay remains REWORK with its named box", async () => {
	const { dir, sha } = await repo("lesson-real-rework");
	const br = fakeBr(inReview("- [ ] [b] [build] `sh scripts/bad.sh` -> prints PASS"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["b", false]]);
	expect(res.log).toContain("[b]");
	expect(br.state().status).toBe("rework");
});
test("LESSONPAYLOAD1 rollback refusal reports the unmet atomic boundary honestly", async () => {
	const { dir, sha } = await repo("lesson-rollback-refused");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: ["close kit-1", "--acceptance-criteria"], failMessage: "tracker refuses close and restoration" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.rollback).toMatchObject({ status: "ROLLBACK_REFUSED" });
	expect(res.log).toContain("tracker refuses close and restoration");
	expect(br.state().status).toBe("in_review");
	// This is an observed counterexample to the original [b], not atomicity qualification.
	console.error(`LESSONPAYLOAD1[b] counterexample: original boxes unchanged=${br.state().acceptance_criteria === acceptance}; no [b] PASS claimed`);
});

test("LESSONPAYLOAD1 an update committed before its nonzero exit is not reported as untouched", async () => {
	const { dir, sha } = await repo("lesson-update-committed");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "--check-acceptance", commitBeforeRefusal: true, failMessage: "post-commit export refused" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("post-commit export refused");
	expect(res.rollback).toMatchObject({ status: "RESTORED" });
	expect(br.state().acceptance_criteria).toBe(acceptance);
	expect(br.state().status).toBe("in_review");
});

test("LESSONPAYLOAD1 concurrent acceptance is preserved and reported STATE_UNPROVEN", async () => {
	const { dir, sha } = await repo("lesson-peer-acceptance");
	const acceptance = "- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail";
	const peerAcceptance = "- [ ] [c] [build] peer's revised obligation `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance), { failOn: "close kit-1", refusalAcceptance: peerAcceptance });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.rollback).toMatchObject({ status: "STATE_UNPROVEN" });
	expect(br.state().acceptance_criteria).toBe(peerAcceptance);
	expect(br.state().status).toBe("in_review");
});
test("LESSONPAYLOAD1 live readback closes with its author's lesson and preserves the verified source", async () => {
	const { dir } = await repo("lesson-live");
	const acceptance = "- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(br.state().acceptance_criteria).toBe("- [x] [c] [live] `sh scripts/t.sh` -> 0 fail");
	expect(br.state().closed_transition).toContain("Lesson: fixture review");
	expect(br.state("kit-source").status).toBe("closed");
});

test("LESSONPAYLOAD1 live missing lesson refuses before replay", async () => {
	const marker = join(base, "live-missing-lesson");
	const { dir } = await repo("lesson-live-missing", { "entered.sh": "#!/bin/sh\nprintf entered > \"$LESSON_REPLAY_MARKER\"\nprintf '0 fail\\n'\n" });
	const acceptance = "- [ ] [c] [live] `sh scripts/entered.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead], comments: [] });
	const before = br.state();
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: { ...br.env, LESSON_REPLAY_MARKER: marker } });
	expect(res.code).toBe("LESSON_MISSING");
	expect(res.replays).toEqual([]);
	expect(existsSync(marker)).toBe(false);
	expect(br.state()).toEqual(before);
});

test("LESSONPAYLOAD1 CLI live-all refused act is nonzero ACT_FAILED with boxes unchanged", async () => {
	const { dir } = await repo("lesson-live-act");
	const acceptance = "- [ ] [c] [live] `sh scripts/t.sh` -> 0 fail";
	const br = fakeBr(liveBead(acceptance), { extraBeads: [sourceBead], failOn: "close kit-live", failMessage: "readback close refused" });
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "--live-readback", "--all", "--project", dir, "--actor", "Peer", "--lesson", "readback evidence", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	const result = JSON.parse(new TextDecoder().decode(r.stdout));
	expect(r.rc).toBe(2);
	expect(result.data.results.map((row: { code: string }) => row.code)).toEqual(["ACT_FAILED"]);
	expect(result.data.results[0].log).toContain("readback close refused");
	expect(br.state().status).toBe("open");
	expect(br.state().acceptance_criteria).toBe(acceptance);
	expect(br.state("kit-source").status).toBe("closed");
});

test("LESSONPAYLOAD1 empty CLI lesson is rejected without replay", async () => {
	const { dir, sha } = await repo("lesson-empty");
	const br = fakeBr(inReview("- [ ] [a] [build] `sh scripts/t.sh` -> 0 fail"));
	const before = br.state();
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--export", sha, "--project", dir, "--actor", "Peer", "--lesson", "", "--json"], {
		cwd: dir, deadline_s: fixtureDeadlineS(30), env: { ...process.env, ...br.env } as Record<string, string>,
	});
	const result = JSON.parse(new TextDecoder().decode(r.stdout));
	expect(r.rc).toBe(2);
	expect(result.errors[0].code).toBe("MISSING_VALUE");
	expect(br.state()).toEqual(before);
});
/** A fixture `am` whose agents-show answers from a fixed script: `{}` for a known verifier, or an
 * AGENT_NOT_FOUND refusal for a stranger. `am` is resolved from PATH, so prepending the bin
 * shadows the real one exactly where verify resolves it. */
function verifygateAgentMailBin(label: string, known: boolean): string {
	const dir = join(base, label);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "am"), known
		? "#!/bin/sh\nif [ \"$1\" = \"agents\" ] && [ \"$2\" = \"show\" ]; then\nprintf '%s' '{}'\nexit 0\nfi\nexit 1\n"
		: "#!/bin/sh\nif [ \"$1\" = \"agents\" ] && [ \"$2\" = \"show\" ]; then\nprintf '%s' '{\"error\":{\"type\":\"AGENT_NOT_FOUND\",\"message\":\"Agent not found in project\"}}' >&2\nexit 1\nfi\nexit 1\n");
	chmodSync(join(dir, "am"), 0o755);
	return dir;
}

test("VERIFYGATE1-identity [b]: a verifier unknown to the target project's Agent Mail is refused before any replay", async () => {
	const marker = join(base, "verifygate-identity-replay");
	const { dir, sha } = await repo("verifygate-identity", { "entered.sh": "#!/bin/sh\nprintf entered > \"$VERIFYGATE_REPLAY_MARKER\"\nprintf '0 fail\\n'\n" });
	const acceptance = "- [ ] [a] [build] `sh scripts/entered.sh` -> 0 fail";
	const br = fakeBr(inReview(acceptance));
	const refused = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Stranger", env: { ...br.env, PATH: `${verifygateAgentMailBin("verifygate-unknown-am", false)}${delimiter}${br.env.PATH ?? ""}`, VERIFYGATE_REPLAY_MARKER: marker } });
	expect(refused.code).toBe("NOT_IN_REVIEW");
	expect(refused.log).toContain("UNJUDGED: Agent Mail cannot verify Stranger");
	expect(refused.log).toContain("am agents create");
	expect(refused.replays).toEqual([]);
	expect(refused.acts).toEqual([]);
	expect(br.acts()).toEqual([]);
	expect(existsSync(marker)).toBe(false);
	// A verifier the target mail knows proceeds through replay, ticks, gate report and close.
	const knownMarker = join(base, "verifygate-identity-known-replay");
	const known = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Known", env: { ...br.env, PATH: `${verifygateAgentMailBin("verifygate-known-am", true)}${delimiter}${br.env.PATH ?? ""}`, VERIFYGATE_REPLAY_MARKER: knownMarker } });
	expect(known.code).toBe("CLOSED");
	expect(known.acts.map(a => a.slice(0, 3).join(" "))).toContain("br gate report");
	expect(existsSync(knownMarker)).toBe(true);
});
test("planted: a failing reviewer-gate report fails the close as ACT_FAILED naming the act, never a silent pass", async () => {
	const { dir, sha } = await repo("gaterefail");
	const br = fakeBr(inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"), { failOn: "gate" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACT_FAILED");
	expect(res.log).toContain("act failed");
	expect(res.log).toContain("gate report");
});

/* VERIFYGATE1 (ompkit-1ra0d.137): verify against a tracker whose workflow requires no reviewer gate,
   a verifier the target project's Agent Mail does not know, and the live-readback halves (gateless
   open -> closed; in_review with remaining [live] boxes). */

/** Strict workflow with no gates section: no transition requires min_reviewers. */
const VERIFYGATE1_NO_GATES_POLICY = `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed]
    in_progress: [in_review, open]
    in_review: [closed, rework]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
`;

test("VERIFYGATE1 [a]: in a fixture tracker whose workflow has no min_reviewers gate, verify ticks, skips the gate report and closes", async () => {
	const { dir: cdir, sha } = await repo("verifygate-nogate");
	const t = await tracker(base, "verifygate-t");
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), VERIFYGATE1_NO_GATES_POLICY);
	const envT = trackerEnv(t);
	const ac = "- [ ] [a] [build] probe passes; planted negative: bad input is refused. `sh scripts/t.sh` -> 16 pass 0 fail";
	const desc = "WHAT: verifygate1 no-gate close fixture.\n\nWHY: proves verify closes where the workflow requires no reviewer gate.\n\n## Pitfalls\n- the fixture tracker stays under owned scratch and never touches shipped state";
	const id = await createBead(t, "verifygate no-gate close", ["--description", desc, "--acceptance-criteria", ac, "--labels", "kind:fix", "--assignee", "Author"]);
	for (const m of [["update", id, "--status", "in_progress", "--transition-comment", "fixture start"], ["update", id, "--check-acceptance", "1"], ["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"]]) {
		const r = await brun(m, t.dir, envT);
		if (r.rc !== 0) throw new Error(`${m.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out.slice(0, 300)}`);
	}
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, family: "same (bun)", lesson: "verifygate1 no-gate fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.acts.map(a => a.slice(0, 3).join(" "))).not.toContain("br gate report");
	expect(res.log).toContain("skipping gate report");
	expect(res.log).toContain("not required");
	expect((await row(t, id)).status).toBe("closed");
}, fixtureDeadlineS(60) * 1_000);


test("VERIFYGATE1-readback gate: live-readback on an open bead skips the unrequired gate report (open -> closed) and closes", async () => {
	const { dir, sha } = await repo("verifygate-readback-gate");
	const noGate = `Error: Validation failed: to: workflow does not require gate 'min_reviewers' for transition 'open -> closed'`;
	const parent = { id: "kit-parent", status: "open", assignee: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [], acceptance_criteria: "" };
	const br = fakeBr({ id: "kit-live", status: "open", assignee: null, created_by: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [LIVE_READBACK_LABEL], acceptance_criteria: "- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass", dependencies: [{ dependency_type: "related", id: "kit-parent" }] }, { failOn: ["gate list", "gate report"], failMessage: noGate, extraBeads: [parent] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env, family: "same (bun)", lesson: "verifygate1 readback gate fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.log).toContain("skipping gate report");
	expect(res.log).toContain("open -> closed");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", true]]);
	expect(br.state("kit-live").status).toBe("closed");
	expect(br.state("kit-live").acceptance_criteria).toBe("- [x] [c] [live] `sh scripts/t.sh` -> 16 pass");
});

test("VERIFYGATE1-readback in-review: live-readback accepts an in_review bead whose remaining boxes are [live]", async () => {
	const { dir } = await repo("verifygate-readback-inreview");
	const parent = { id: "kit-parent", status: "open", assignee: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [], acceptance_criteria: "" };
	const br = fakeBr({ id: "kit-live", status: "in_review", assignee: null, created_by: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [LIVE_READBACK_LABEL], acceptance_criteria: "- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass", dependencies: [{ dependency_type: "related", id: "kit-parent" }] }, { extraBeads: [parent] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env, family: "same (bun)", lesson: "verifygate1 in-review readback fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.acts.map(a => a.slice(0, 3).join(" "))).toContain("br gate report");
	expect(res.log).not.toContain("skipping gate report");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", true]]);
	expect(br.state("kit-live").status).toBe("closed");
});

test("VERIFYGATE1-readback in-review judgement: an unchecked [v][build] box refuses PENDING and ticks nothing", async () => {
	const { dir } = await repo("verifygate-readback-judgement");
	const parent = { id: "kit-parent", status: "open", assignee: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [], acceptance_criteria: "" };
	const acceptance = "- [ ] [v] [build] reviewer judgement; planted negative: a rubber stamp is refused. `echo judgement` -> judgement\n- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass";
	const br = fakeBr({ id: "kit-live", status: "in_review", assignee: null, created_by: "Author", updated_at: "2026-01-01T00:00:00Z", labels: [LIVE_READBACK_LABEL], acceptance_criteria: acceptance, dependencies: [{ dependency_type: "related", id: "kit-parent" }] }, { extraBeads: [parent] });
	const res = await liveReadback({ bead: "kit-live", repo: dir, actor: "Peer", env: br.env, family: "same (bun)", lesson: "verifygate1 judgement fixture" });
	expect(res.code).toBe("PENDING");
	expect(res.log).toContain("build judgement remains");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(br.acts()).toEqual([]);
	expect(br.state("kit-live").status).toBe("in_review");
	expect(br.state("kit-live").acceptance_criteria).toBe(acceptance);
});
/* VERIFYACTOR1 (ompkit-t7cn7.24): native verify binds the explicit reviewer
   identity on every durable br mutation. The fixture tracker's default actor
   is forced away from the reviewer via USER, so the audit log distinguishes
   ambient acts from reviewer acts. These assert durable audit state, never
   argv echoes. Platform limit (probe-proven, JadeThrush 71537/71542): br
   records no audit event for --check-acceptance ticks (real or re-tick) or
   gate reports, so tick binding is evidenced by acts argv plus resulting
   state; close/status/comment/REWORK/intake/gate-provider carry durable
   reviewer proof. Fixtures pre-tick because shim lint AC_UNTICKED_BUILD_LANDED
   refuses unticked in_review entry. */

const REVIEWER = "Peer";
const AMBIENT = "AmbientDefault";

/** Env whose br default actor is ambient, never the reviewer. */
function ambientEnv(db: string): Record<string, string> {
	return { ...process.env, USER: AMBIENT, BEADS_DB: db } as Record<string, string>;
}

/** Minimal strict workflow so the close path runs: open->in_progress->in_review->closed with min_reviewers on the final edge. */
async function actorPolicy(t: { dir: string }): Promise<void> {
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed]
    in_progress: [in_review, open]
    in_review: [closed, rework, open]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
  gates:
    "in_review -> closed":
      require_all:
        - min_reviewers: 1
`);
}

/** Create a fixture bead with its fields, then move it through the gated path as ambient/tester setup acts. */
async function actorBead(t: { dir: string; db: string }, title: string, ac: string): Promise<string> {
	const env = ambientEnv(t.db);
	const desc = "WHAT: verifyactor1 fixture.\n\nWHY: proves native verify binds the reviewer identity on durable mutations.\n\n## Pitfalls\n- the reviewer identity must come from native verify";
	const id = await createBead(t, title, ["--description", desc, "--acceptance-criteria", ac, "--labels", "kind:fix", "--assignee", "Author"]);
	const moves: string[][] = [
		["update", id, "--status", "in_progress", "--transition-comment", "fixture start"],
		["update", id, "--check-acceptance", "1"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"],
	];
	for (const m of moves) {
		const r = await brun(m, t.dir, env);
		if (r.rc !== 0) throw new Error(`${m.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out.slice(0, 300)}`);
	}
	return id;
}

async function auditActors(t: { dir: string; db: string }, id: string): Promise<{ event_type: string; actor: string }[]> {
	const r = await brun(["audit", "log", id, "--json"], t.dir, ambientEnv(t.db));
	if (r.rc !== 0) throw new Error(`audit log -> ${r.rc}: ${r.out.slice(0, 300)}`);
	const doc = JSON.parse(r.out) as { events: { event_type: string; actor: string }[] };
	return doc.events.map(e => ({ event_type: e.event_type, actor: e.actor }));
}

test("VERIFYACTOR1 [a]: passing verify binds the reviewer on ticks, gate report and close; a same-tracker control bead is untouched", async () => {
	const { dir: cdir, sha } = await repo("actorpass");
	const t = await sharedTracker(base, "actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const ac = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass";
	const id = await actorBead(t, "actor close probe", ac);
	const control = await actorBead(t, "actor control probe", ac);
	const beforeEvents = await auditActors(t, id);
	const controlBefore = (await brun(["show", control, "--json"], t.dir, envT)).out;
	const controlEventsBefore = await auditActors(t, control);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)", lesson: "reviewer identity fixture" });
	expect(res.code).toBe("CLOSED");
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	const fresh = afterEvents.slice(0, afterEvents.length - beforeEvents.length);
	for (const e of fresh) expect(e.actor).toBe(REVIEWER);
	const kinds = fresh.map(e => e.event_type);
	expect(kinds).toContain("closed");
	// Durable reviewer-report proof: the gate result itself names the reviewer provider (audit log carries no gate-report event; probe-proven).
	const gates = JSON.parse((await brun(["gate", "list", id, "--json"], t.dir, envT)).out) as unknown;
	const gateText = JSON.stringify(gates);
	expect(gateText).toContain(`reviewer:${REVIEWER}`);
	expect(gateText).toContain("pass");
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; notes: string }[];
	expect(shown[0]!.status).toBe("closed");
	expect((await brun(["show", control, "--json"], t.dir, envT)).out).toBe(controlBefore);
	expect(await auditActors(t, control)).toEqual(controlEventsBefore);
});

test("VERIFYACTOR1 [a]: failing probe REWORK carries the reviewer identity, never the ambient default", async () => {
	const { dir: cdir, sha } = await repo("actorrework");
	const t = await sharedTracker(base, "actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor rework probe", "- [ ] [a] [build] `sh scripts/bad.sh` -> prints PASS");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)", lesson: "replay-failure identity fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.acts[0]).toEqual(["br", "update", id, "--status", "rework", "--transition-comment", expect.stringContaining(`REWORK ${id}:`), "--actor", REVIEWER]);
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
});
test("VERIFYACTOR1 [a]: explicit-author refusal and dry-run leave fixture state and audit untouched", async () => {
	const { dir: cdir, sha } = await repo("actoruntouched");
	const t = await sharedTracker(base, "actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor untouched probe", "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass");
	const beforeHash = stateHash(t);
	const beforeEvents = await auditActors(t, id);
	const refused = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Author", env: envT, lesson: "self-author refusal fixture" });
	expect(refused.code).toBe("NON_AUTHOR_REQUIRED");
	expect(refused.acts).toEqual([]);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
	const dry = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, dryRun: true, family: "same (bun)", lesson: "dry-run identity fixture" });
	expect(dry.code).toBe("DRY_RUN");
	expect(dry.acts.length).toBeGreaterThan(0);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
});

test("VERIFYACTOR1 [a]: intake refusal binds the reviewer on the open/needs-intake mutation (durable)", async () => {
	const { dir: cdir, sha } = await repo("actorintake");
	const t = await sharedTracker(base, "actor-t", actorPolicy);
	const envT = ambientEnv(t.db);
	const id = await actorBead(t, "actor intake probe", "- [ ] [a] [build] prose names no command");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)" });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.acts).toEqual([["br", "update", id, "--status", "open", "--add-label", "needs-intake", "--actor", REVIEWER]]);
	// verifyBead returns intake acts for the operator; execute them as the operator would, then prove durable reviewer binding.
	for (const a of res.acts) {
		const r = await run(a, { cwd: cdir, deadline_s: fixtureDeadlineS(60), env: envT });
		if (r.rc !== 0) throw new Error(`intake act -> ${r.rc}`);
	}
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; labels: string[] }[];
	expect(shown[0]!.status).toBe("open");
	expect(shown[0]!.labels).toContain("needs-intake");
});
/* VERIFYOPEN1 (ompkit-1ra0d.70): verify admits open beads, not just in_review; the non-author
   replay of every box on the exact export is the proof. Unticked boxes are ticked on PASS. */
const OPEN_PASS_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

/** Policy under which an open bead can close (gated, like in_review) or go back for rework. */
async function openPolicy(t: { dir: string; db: string }): Promise<void> {
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed, rework]
    in_progress: [in_review, open]
    in_review: [closed, rework, open]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
  gates:
    "open -> closed":
      require_all:
        - min_reviewers: 1
    "in_review -> closed":
      require_all:
        - min_reviewers: 1
`);
}

/** An open bead with unticked boxes, assigned to Author so Peer verifies as non-author. */
async function openBead(t: { dir: string; db: string }, title: string, ac: string): Promise<string> {
	const desc = "WHAT: verifyopen1 fixture.\n\nWHY: proves non-author verify closes an open bead on a full replay in this same turn.";
	return createBead(t, title, ["--description", desc, "--acceptance-criteria", ac, "--assignee", "Author"]);
}

test("VERIFYOPEN1 [a]: non-author verify of an open bead with unticked boxes replays, ticks, closes; planted: the author is refused and nothing is ticked", async () => {
	const { dir, sha } = await repo("verifyopen");
	const t = await tracker(base, "verifyopen-pass-t").then(async v => { await openPolicy(v); return v; });
	const env = trackerEnv(t);
	const id = await openBead(t, "verifyopen pass", OPEN_PASS_BOXES);
	// Planted negative first: the author running the same verify is refused before replay and ticks nothing.
	const refused = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Author", env, family: "same (bun)", lesson: "author attempt fixture" });
	expect(refused.code).toBe("NON_AUTHOR_REQUIRED");
	expect(refused.replays).toEqual([]);
	expect(refused.acts).toEqual([]);
	expect((await row(t, id)).status).toBe("open");
	expect((await row(t, id)).acceptance_criteria).toBe(OPEN_PASS_BOXES);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Peer", env, family: "same (bun)", lesson: "open-bead close fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true]]);
	const after = await row(t, id);
	expect(after.status).toBe("closed");
	expect(after.acceptance_criteria).toBe(OPEN_PASS_BOXES.replaceAll("- [ ]", "- [x]"));
}, fixtureDeadlineS(120) * 1_000);

test("VERIFYOPEN1 [b]: a failing box on an open bead leaves it unclosed with the REWORK comment and no tick", async () => {
	const { dir, sha } = await repo("verifyopen");
	const t = await tracker(base, "verifyopen-rework-t");
	const env = trackerEnv(t);
	const ac = "- [ ] [a] [build] `sh scripts/bad.sh` -> prints PASS";
	const id = await openBead(t, "verifyopen rework", ac);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: dir, actor: "Peer", env, family: "same (bun)", lesson: "open-bead rework fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.acts[0]).toEqual(["br", "update", id, "--status", "rework", "--transition-comment", expect.stringContaining(`REWORK ${id}:`), "--actor", "Peer"]);
	const after = await row(t, id);
	expect(after.status).not.toBe("closed");
	expect(after.acceptance_criteria).toBe(ac);
	const comments = JSON.parse((await brun(["comments", "list", "--json", id], t.dir, env)).out) as { text: string }[];
	expect(comments.some(c => typeof c.text === "string" && c.text.includes(`REWORK ${id}:`))).toBe(true);
}, fixtureDeadlineS(120) * 1_000);
