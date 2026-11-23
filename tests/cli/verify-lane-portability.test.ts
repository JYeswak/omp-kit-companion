import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_READBACK_LABEL, liveReadback, liveReadbackAll, verifyBead, withdrawChild } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { nativeBr } from "./lib/native-br.ts";
import { brun, createBead, installFixtureIdentity, repo, restoreFixtureIdentity, row, tracker, trackerEnv } from "./verify-fixture.ts";

beforeAll(installFixtureIdentity);
afterAll(restoreFixtureIdentity);

const gradingRoot = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("verify-lane-portability", gradingRoot === undefined ? {} : { root: gradingRoot }).path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
const BUILD_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

// The same native close policy as verify.test.ts: no forced close or synthetic tracker.
const CLOSE_POLICY = [
	"workflow:", "  strict: true", "  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]", "  transitions:",
	"    initial: [open]", "    open: [in_progress, blocked, deferred, closed]", "    in_progress: [in_review, open, blocked, deferred]",
	"    in_review: [closed, rework]", "    rework: [in_progress, in_review, open]", "    blocked: [open, in_progress]", "    deferred: [open]", "    closed: [open]",
	"  required_fields:", "    \"open -> in_progress\": [acceptance_criteria_present]", "    in_review: [acceptance_criteria_present, transition_comment]",
	"    closed: [acceptance_criteria, transition_comment]", "  gates:", "    \"in_review -> closed\":", "      require_all:", "        - min_reviewers: 1",
	"    \"open -> closed\":", "      require_all:", "        - min_reviewers: 1", "",
].join("\n");

// PRIORART1 (ompkit-dpbsq): a create through the guard needs the five prior-art lines, so a fixture that expects another refusal carries them.
const PRIOR_ART = [
	"GOAL: fixture bead for a readback test; measured by this test.",
	"NATIVE: none needed for a fixture.",
	"EXISTING: none, a fixture.",
	"DECISION: EXTEND the verify path under test; no new tool.",
	"BEST: none, a fixture.",
].join("\n");

test("VERIFYLANEPORT1: a foreign parentless bead retains related readback debt and executes its live phase", async () => {
	const marker = join(base, "parentless-live-observation");
	const code = await repo("parentless-readback", {
		"live.sh": "#!/bin/sh\nprintf observed > \"$VERIFYLANE_MARKER\"\nprintf 'readback observed\\n'\n",
	});
	const t = await policyTracker("parentless-readback-t");
	const env = { ...trackerEnv(t), VERIFYLANE_MARKER: marker };
	const live = "- [ ] [c] [live] `sh scripts/live.sh` -> prints readback observed";
	const id = await reviewBead(t, "foreign parentless readback", `${BUILD_BOXES}\n${live}`);
	expect(id.startsWith("ompkit-")).toBe(false);
	const verified = await verifyBead({
		bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env,
		lesson: "parentless trackers retain live readback debt",
	});
	expect(verified.code, verified.log).toBe("CLOSED");
	expect(existsSync(marker)).toBe(false);
	const child = await row(t, verified.child!);
	expect(child.parent ?? null).toBeNull();
	expect(child).toMatchObject({ status: "open", acceptance_criteria: live, labels: [LIVE_READBACK_LABEL] });
	expect(child.dependencies).toContainEqual(expect.objectContaining({ id, dependency_type: "related" }));
	const readback = await run([
		"bun", "run", "--silent", cliPath, "verify", verified.child!, "--live-readback",
		"--project", code.dir, "--actor", "Peer", "--lesson", "parentless live readback", "--json",
	], { cwd: code.dir, deadline_s: fixtureDeadlineS(30), env });
	const result = JSON.parse(new TextDecoder().decode(readback.stdout));
	expect(readback.rc, new TextDecoder().decode(readback.stderr)).toBe(0);
	expect(result.data.overall).toBe("CLOSED");
	expect(readFileSync(marker, "utf8")).toBe("observed");
	expect(await row(t, verified.child!)).toMatchObject({
		status: "closed", acceptance_criteria: live.replace("- [ ]", "- [x]"),
	});
	expect((await row(t, id)).status).toBe("closed");
}, fixtureDeadlineS(120) * 1_000);

test("READBACKKEY1: distinct parentless obligations survive real duplicate admission", async () => {
	const code = await repo("readback-key");
	const t = await policyTracker("readback-key-t");
	const native = nativeBr();
	const bin = join(t.dir, "bin");
	mkdirSync(bin);
	const entry = join(bin, "br");
	const guard = join(import.meta.dir, "..", "..", "scripts", "br-create-guard.py");
	writeFileSync(entry, "#!/bin/sh\nif [ \"$1\" = create ]; then exec python3 -B \"$FIXTURE_CREATE_GUARD\" \"$@\"; fi\nexec \"$BR_SHIM_REAL\" \"$@\"\n");
	chmodSync(entry, 0o755);
	const env = {
		...trackerEnv(t), PATH: `${bin}:${process.env.PATH ?? ""}`,
		FIXTURE_CREATE_GUARD: guard, BR_SHIM_REAL: native, BR_SHIM_PROJECT: t.dir,
		BR_SHIM_DB: t.db, BR_SHIM_AGENT: "Peer", BR_SHIM_ENTRY: entry,
	};
	const firstTitle = "independent export verifies installed updater 18.21";
	const secondTitle = "independent export verifies installed updater 19.0";
	const predecessor = await createBead(t, firstTitle);
	const live1 = "- [ ] [c] [live] `sh scripts/t.sh` -> prints 16 pass";
	const live2 = "- [ ] [c] [live] `sh scripts/t.sh` -> prints 0 fail";
	const first = await reviewBead(t, "first release readback", `${BUILD_BOXES}\n${live1}`);
	const second = await reviewBead(t, secondTitle, `${BUILD_BOXES}\n${live2}`);
	const verify = (bead: string) => verifyBead({
		bead, exportSha: code.sha, repo: code.dir, actor: "Peer", env, lesson: "bind the exact live obligation",
	});

	const interrupted = await verifyBead({
		bead: first, exportSha: code.sha, repo: code.dir, actor: "Peer", env, dryRun: true, lesson: "bind the exact live obligation",
	});
	expect(interrupted.code, interrupted.log).toBe("DRY_RUN");
	const create = interrupted.acts.find(args => args[1] === "create");
	if (create === undefined) throw new Error("no generated create in the verifier's plan");
	const seeded = await brun(create.slice(1), t.dir, env);
	expect(seeded.rc, seeded.out).toBe(0);
	const seededId = JSON.parse(seeded.out).id;
	const duplicate = await brun(create.slice(1), t.dir, env);
	expect(duplicate.rc, duplicate.out).not.toBe(0);
	const firstResult = await verify(first);
	expect(firstResult.code, firstResult.log).toBe("CLOSED");
	expect(firstResult.child).toBe(seededId);
	const firstChild = await row(t, firstResult.child!);
	const old = await brun([
		"create", `LIVEREADBACK: ${secondTitle}`, "-t", "task", "-l", LIVE_READBACK_LABEL,
		"--deps", `related:${second}`, "--description", `WHAT: read back on install.\nWHY: retained fixture obligation.\n${PRIOR_ART}`,
		"--acceptance-criteria", live2, "--json", "--actor", "Peer",
	], t.dir, env);
	expect(old.rc, old.out).toBe(4);
	expect(old.out).toContain("BR_CREATE_POSSIBLE_DUPLICATE");
	expect(old.out).toContain(predecessor);
	expect((await row(t, second)).acceptance_criteria).toBe(`${BUILD_BOXES}\n${live2}`);

	const secondResult = await verify(second);
	expect(secondResult.code, secondResult.log).toBe("CLOSED");
	expect(secondResult.child).not.toBe(firstResult.child);
	const secondChild = await row(t, secondResult.child!);
	expect(secondChild).toMatchObject({ status: "open", acceptance_criteria: live2 });
	expect(secondChild.parent ?? null).toBeNull();
	expect(secondChild.dependencies).toContainEqual(expect.objectContaining({ id: second, dependency_type: "related" }));
	expect(await row(t, firstResult.child!)).toEqual(firstChild);
	expect((await verify(second)).code).toBe("NOT_IN_REVIEW");

	const thirdTitle = "third unrelated readback";
	const third = await reviewBead(t, thirdTitle, `${BUILD_BOXES}\n${live1}`);
	const mismatched = await createBead(t, `LIVEREADBACK: ${thirdTitle}`, [
		"-l", LIVE_READBACK_LABEL, "--deps", `related:${third}`, "--acceptance-criteria", live1,
		"--description", `WHAT: read back the boxes omp-kit verify deferred when it closed ${third} on export ${"0".repeat(40)}: different export.`,
	]);
	const before = await row(t, mismatched);
	const refusal = await verify(third);
	expect(refusal.code, refusal.log).toBe("PENDING");
	expect(refusal.acts).toEqual([]);
	expect(await row(t, mismatched)).toEqual(before);
	expect((await row(t, third)).acceptance_criteria).toBe(`${BUILD_BOXES}\n${live1}`);
	const listed = await brun(["list", "--status", "all", "--deferred", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], t.dir, env);
	expect(listed.rc, listed.out).toBe(0);
	const payload = JSON.parse(listed.out);
	const children = (Array.isArray(payload) ? payload : payload.issues) as { id: string }[];
	expect(children.map(child => child.id).sort()).toEqual([firstResult.child, secondResult.child, mismatched].sort());
}, fixtureDeadlineS(100) * 1_000);

async function policyTracker(name: string) {
	const t = await tracker(base, name);
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), CLOSE_POLICY);
	return t;
}

async function reviewBead(t: { dir: string; db: string }, title: string, acceptance: string, parent?: string) {
	const id = await createBead(t, title, [
		"--description", "WHAT: closepass fixture.\n\nWHY: proves verify closes done work under the real close policy.",
		"--acceptance-criteria", acceptance, "--assignee", "Author", ...(parent ? ["--parent", parent] : []),
	]);
	const env = trackerEnv(t);
	for (const args of [
		["update", id, "--status", "in_progress", "--actor", "Author"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "Author"],
	]) {
		const result = await brun(args, t.dir, env);
		expect(result.rc, result.out).toBe(0);
	}
	return id;
}

/** A closed bead under `epic` and its open LIVEREADBACK child, through a real non-dry verify. */
async function closedWithChild(t: { dir: string; db: string }, repoDir: { dir: string; sha: string }, title: string, live: string, epic: string): Promise<{ id: string; child: string }> {
	const id = await reviewBead(t, title, `${BUILD_BOXES}\n${live}`, epic);
	const res = await verifyBead({ bead: id, exportSha: repoDir.sha, repo: repoDir.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "deferred readback fixture" });
	if (res.code !== "CLOSED" || res.child === undefined) throw new Error(`verify ${id} -> ${res.code}: ${res.log}`);
	return { id, child: res.child };
}

test("CLOSEPASS1: a commandless [v][build] judgement stays on the parent when executable build boxes pass", async () => {
	const code = await repo("closepass-v-build");
	const t = await policyTracker("closepass-v-build-t");
	const env = trackerEnv(t);
	const judgement = "- [ ] [v] [build] Judge whether the causal analysis is complete";
	const acceptance = `${BUILD_BOXES}\n${judgement}`;
	const epic = await createBead(t, "closepass v build epic");
	const id = await reviewBead(t, "closepass v build judgement", acceptance, epic);
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "build judgement fixture" });
	expect(res.code).toBe("PENDING");
	expect(res.log).toContain("[v] build judgement remains on the parent");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true]]);
	expect(res.child).toBeUndefined();
	expect(res.acts).toEqual([]);
	const parent = await row(t, id);
	expect(parent.status).toBe("in_review");
	expect(parent.acceptance_criteria).toBe(acceptance);
	const children = JSON.parse((await brun(["list", "--status", "all", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], t.dir, env)).out) as { issues?: unknown[] } | unknown[];
	expect(Array.isArray(children) ? children : children.issues ?? []).toHaveLength(0);
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1 no active parent: the child goes under the constraint lane's parent and the close reason says so; with no readable lane parent the bead stays PENDING and nothing is written", async () => {
	const code = await repo("closepass-lane");
	const t = await policyTracker("closepass-lane-t");
	const env = trackerEnv(t);
	const live = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const lane = await createBead(t, "constraint lane parent");
	const id = await reviewBead(t, "closepass orphan", `${BUILD_BOXES}\n${live}`);
	const missing = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: "cp-nosuch", lesson: "missing readback home fixture" });
	expect(missing.code).toBe("PENDING");
	expect(missing.acts).toEqual([]);
	expect(missing.log).toContain(`${id} has no active parent and lane parent cp-nosuch is unreadable`);
	expect((await row(t, id)).status).toBe("in_review");
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: lane, lesson: "readback home fixture" });
	expect(res.code).toBe("CLOSED");
	expect(await row(t, res.child!)).toMatchObject({ status: "open", parent: lane, labels: [LIVE_READBACK_LABEL] });
	expect(JSON.stringify(await row(t, id))).toContain(`(LIVEREADBACK, child of lane parent ${lane}, because ${id} has no active parent, related to ${id})`);
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.live: --live-readback runs only the child's boxes on the installed tree; a pass ticks them and closes the child", async () => {
	const code = await repo("closepass-live");
	const t = await policyTracker("closepass-live-t");
	const { id, child } = await closedWithChild(t, code, "closepass live pass", "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass", await createBead(t, "closepass live epic"));
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Author", env: trackerEnv(t) })).code).toBe("NON_AUTHOR_REQUIRED");
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "installed readback fixture" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", true]]);
	expect(await row(t, child)).toMatchObject({ status: "closed", acceptance_criteria: "- [x] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass" });
	expect((await row(t, id)).status).toBe("closed");
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t) })).code).toBe("NOT_LIVE_READBACK");
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.live planted: a failing live box reopens the parent with REWORK naming the box, and the child stays open", async () => {
	const code = await repo("closepass-livefail");
	const t = await policyTracker("closepass-livefail-t");
	const epic = await createBead(t, "closepass livefail epic");
	const { id, child } = await closedWithChild(t, code, "closepass live fail", "- [ ] [c] [live] on the installed kit `sh scripts/bad.sh` -> prints PASS", epic);
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)", lesson: "failed readback fixture" });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", false]]);
	expect((await row(t, id)).status).toBe("open");
	const comments = await brun(["comments", "list", id], t.dir, trackerEnv(t));
	expect(comments.out).toContain(`REWORK ${id}: live readback ${child} failed [c] output lacks "PASS"`);
	// The child hangs off the active epic, not the reopened bead, so the readback never holds the bead's next close.
	expect(await row(t, child)).toMatchObject({ status: "open", parent: epic });
	expect(JSON.stringify((await row(t, id)).dependents ?? [])).not.toContain("parent-child");
}, fixtureDeadlineS(120) * 1_000);

test("ALLLIVE1: an open bead whose every open box is live is read back directly; a bead with an open build box is not; a failure leaves it open with REWORK", async () => {
	const code = await repo("alllive");
	const t = await policyTracker("alllive-t");
	const env = trackerEnv(t);
	const make = async (title: string, acceptance: string) => {
		const id = await createBead(t, title);
		expect((await brun(["update", id, "--acceptance", acceptance], t.dir, env)).rc).toBe(0);
		return id;
	};
	const live = await make("alllive pass", "- [ ] [a] [live] on the installed kit `sh scripts/t.sh` -> 16 pass");
	const mixed = await make("alllive mixed", "- [ ] [a] [build] built `sh scripts/t.sh` -> 16 pass\n- [ ] [b] [live] live `sh scripts/t.sh` -> 16 pass");
	const failing = await make("alllive fail", "- [ ] [a] [live] on the installed kit `sh scripts/bad.sh` -> prints PASS");
	expect((await liveReadback({ bead: mixed, repo: code.dir, actor: "Peer", env, lesson: "mixed fixture" })).code).toBe("NOT_LIVE_READBACK");
	const res = await liveReadback({ bead: live, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "all-live fixture" });
	expect(res.code).toBe("CLOSED");
	expect(await row(t, live)).toMatchObject({ status: "closed", acceptance_criteria: "- [x] [a] [live] on the installed kit `sh scripts/t.sh` -> 16 pass" });
	const bad = await liveReadback({ bead: failing, repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "all-live fail fixture" });
	expect(bad.code).toBe("REWORK");
	expect((await row(t, failing)).status).toBe("open");
	expect((await brun(["comments", "list", failing], t.dir, env)).out).toContain(`REWORK ${failing}: live readback failed [a]`);
}, fixtureDeadlineS(120) * 1_000);

test("CLOSEPASS1.all: --live-readback --all visits exactly the open live-readback children, and no others", async () => {
	const code = await repo("closepass-all");
	const t = await policyTracker("closepass-all-t");
	const env = trackerEnv(t);
	const box = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const epic = await createBead(t, "closepass all epic");
	const open = await closedWithChild(t, code, "closepass all open", box, epic);
	const done = await closedWithChild(t, code, "closepass all done", box, epic);
	expect((await liveReadback({ bead: done.child, repo: code.dir, actor: "Peer", env, lesson: "completed readback fixture" })).code).toBe("CLOSED");
	const other = await createBead(t, "closepass unlabelled open bead");
	const labelled = await createBead(t, "closepass labelled but in progress");
	for (const args of [["update", labelled, "--add-label", LIVE_READBACK_LABEL, "--acceptance", box], ["update", labelled, "--status", "in_progress"]]) expect((await brun(args, t.dir, env)).rc).toBe(0);
	const res = await liveReadbackAll({ repo: code.dir, actor: "Peer", env, family: "same (bun)", lesson: "aggregate readback fixture" });
	expect(res.visited).toEqual([open.child]);
	expect(res.visited).not.toContain(other);
	expect(res.results.map(r => [r.bead, r.code])).toEqual([[open.child, "CLOSED"]]);
	expect(res.ok).toBe(true);
}, fixtureDeadlineS(180) * 1_000);

// Native rollback, withdrawal, and retry live in the readback suite.
test("withdraw rehome: real CLI withdraws after a failed close and retries the same marked child", async () => {
	const code = await repo("withdraw-native");
	const t = await policyTracker("withdraw-native-t");
	const env = trackerEnv(t);
	const epic = await createBead(t, "withdraw native home");
	const live = "- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass";
	const acceptance = `${BUILD_BOXES}\n${live}`;
	const id = await reviewBead(t, "withdraw native parent", acceptance, epic);
	const blocker = await createBead(t, "original unfinished child", [
		"--parent", id, "--assignee", "AnotherAuthor", "--acceptance-criteria", BUILD_BOXES,
	]);
	const invoke = () => run([
		"bun", "run", "--silent", cliPath, "verify", id, "--export", code.sha,
		"--project", code.dir, "--actor", "Peer", "--lesson", "native handled rollback", "--json",
	], { cwd: code.dir, env, deadline_s: fixtureDeadlineS(45) });
	const failed = await invoke();
	const first = JSON.parse(new TextDecoder().decode(failed.stdout)).data;
	expect(failed.rc).toBe(2);
	expect(first.overall).toBe("ACT_FAILED");
	expect(first.rollback.status).toBe("RESTORED");
	const withdrawn = await row(t, first.child);
	expect(withdrawn.status).toBe("deferred");
	expect(withdrawn.acceptance_criteria).toBe(live);
	const restored = await row(t, id);
	expect(restored.status).toBe("in_review");
	expect(restored.acceptance_criteria).toBe(acceptance);
	const failedAgain = await invoke();
	const repeated = JSON.parse(new TextDecoder().decode(failedAgain.stdout)).data;
	expect(repeated.overall).toBe("ACT_FAILED");
	expect(repeated.child).toBe(first.child);
	expect((await row(t, first.child)).status).toBe("deferred");
	expect((await row(t, id)).acceptance_criteria).toBe(acceptance);
	const finishedBlocker = await verifyBead({
		bead: blocker, exportSha: code.sha, repo: code.dir, actor: "Peer", env, lesson: "finish the original blocking child",
	});
	expect(finishedBlocker.code, finishedBlocker.log).toBe("CLOSED");
	const retried = await invoke();
	const second = JSON.parse(new TextDecoder().decode(retried.stdout)).data;
	expect(retried.rc, new TextDecoder().decode(retried.stderr)).toBe(0);
	expect(second.overall).toBe("CLOSED");
	expect(second.child).toBe(first.child);
	const resumed = await row(t, first.child);
	expect(resumed.status).toBe("open");
	expect(resumed.acceptance_criteria).toBe(live);
	const comments = JSON.parse((await brun(["comments", "list", first.child, "--json"], t.dir, env)).out);
	const marker = comments.find((comment: { text: string }) => comment.text.startsWith("verify-rollback:"));
	expect(JSON.parse(marker.text.slice("verify-rollback:".length))).toMatchObject({
		version: 1, parent: id, child: first.child, actor: "Peer",
	});
}, fixtureDeadlineS(120) * 1_000);

test("withdraw: a real peer edit after creation is retained and the child stays active", async () => {
	const t = await policyTracker("withdraw-native-peer-t");
	const env = trackerEnv(t);
	const parent = await createBead(t, "withdraw peer parent");
	const created = await brun(["create", "withdraw peer child", "--json", "--actor", "Peer"], t.dir, env);
	expect(created.rc, created.out).toBe(0);
	const initial = JSON.parse(created.out);
	const changed = await brun(["update", initial.id, "--notes", "peer owns this changed obligation", "--actor", "AnotherPeer"], t.dir, env);
	expect(changed.rc, changed.out).toBe(0);
	const before = await row(t, initial.id);
	const acts: string[][] = [];
	const result = await withdrawChild(initial.id, { status: initial.status, updatedAt: initial.updated_at }, parent, "Peer", t.dir, env, acts);
	expect(result.status).toBe("STATE_UNPROVEN");
	expect(await row(t, initial.id)).toEqual(before);
	expect(before.status).toBe("open");
});

test("rehome: an operator-deferred readback is not resumed, replaced or remarked", async () => {
	const code = await repo("withdraw-operator");
	const t = await policyTracker("withdraw-operator-t");
	const env = trackerEnv(t);
	const epic = await createBead(t, "operator native home");
	const live = "- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass";
	const acceptance = `${BUILD_BOXES}\n${live}`;
	const id = await reviewBead(t, "operator native parent", acceptance, epic);
	const child = await createBead(t, "LIVEREADBACK: operator native parent", [
		"--parent", epic, "-l", LIVE_READBACK_LABEL, "--deps", `related:${id}`, "--acceptance-criteria", live,
		"--description", `WHAT: read back the boxes omp-kit verify deferred when it closed ${id} on export ${code.sha}: live proof.`,
	]);
	const paused = await brun(["update", child, "--status", "deferred", "--transition-comment", "Operator paused this readback", "--actor", "Operator"], t.dir, env);
	expect(paused.rc, paused.out).toBe(0);
	const before = await row(t, child);
	const comments = (await brun(["comments", "list", child, "--json"], t.dir, env)).out;
	const result = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, lesson: "honor operator deferred state" });
	expect(result.code).toBe("PENDING");
	expect(result.log).toContain("has no unchanged machine-withdrawal receipt");
	expect(result.acts).toEqual([]);
	expect(await row(t, child)).toEqual(before);
	expect((await brun(["comments", "list", child, "--json"], t.dir, env)).out).toBe(comments);
	expect((await row(t, id)).acceptance_criteria).toBe(acceptance);
}, fixtureDeadlineS(90) * 1_000);

test("rehome: a peer change invalidates the withdrawn child's exact retry receipt", async () => {
	const code = await repo("withdraw-changed-receipt");
	const t = await policyTracker("withdraw-changed-receipt-t");
	const env = trackerEnv(t);
	const epic = await createBead(t, "receipt native home");
	const live = "- [ ] [c] [live] `sh scripts/t.sh` -> 16 pass";
	const acceptance = `${BUILD_BOXES}\n${live}`;
	const parent = await reviewBead(t, "receipt native parent", acceptance, epic);
	const created = await brun([
		"create", "LIVEREADBACK: receipt native parent", "--parent", epic, "-l", LIVE_READBACK_LABEL,
		"--description", `WHAT: read back the boxes omp-kit verify deferred when it closed ${parent} on export ${code.sha}: live proof.`,
		"--deps", `related:${parent}`, "--acceptance-criteria", live, "--actor", "Peer", "--json",
	], t.dir, env);
	expect(created.rc, created.out).toBe(0);
	const initial = JSON.parse(created.out);
	const withdrawal = await withdrawChild(initial.id, { status: initial.status, updatedAt: initial.updated_at }, parent, "Peer", t.dir, env, []);
	expect(withdrawal.status).toBe("WITHDRAWN");
	const changed = await brun(["update", initial.id, "--notes", "peer requires a new review", "--actor", "AnotherPeer"], t.dir, env);
	expect(changed.rc, changed.out).toBe(0);
	const before = await row(t, initial.id);
	const result = await verifyBead({ bead: parent, exportSha: code.sha, repo: code.dir, actor: "Peer", env, lesson: "never resume a peer-modified receipt" });
	expect(result.code).toBe("PENDING");
	expect(result.log).toContain("has no unchanged machine-withdrawal receipt");
	expect(result.acts).toEqual([]);
	expect(await row(t, initial.id)).toEqual(before);
	expect(before.status).toBe("deferred");
	expect((await row(t, parent)).acceptance_criteria).toBe(acceptance);
}, fixtureDeadlineS(90) * 1_000);

