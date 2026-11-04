// Affected-test source dependencies retained across the land-3 shards:
// src/kitlib/run.ts src/land.ts scripts/pysafe.py
// scripts/suite-hermetic-env.sh scripts/kitlib_tmp.py
// scripts/check-stale-worktree.sh scripts/kitlib-tmp.sh
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { qualifyPublicationCandidate } from "../../src/land.ts";
import {
	EXPECTED_SERVICE, SERVICE_BASE, actualParentSetup, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, verdictPath, writeServiceLines, LAND_DEFAULT_TIMEOUT_MS, type CommandOptions,
} from "./private-index-land.helpers.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);
// GATESPEED1: land defers the complete suite to the release by default; these cases assert the
// inline suite's refusals, so this file opts in for every land command it runs.
process.env.PRE_PUSH_FULL_SUITE = "push";
// land resolves the pane owner with `am agents resolve-pane` under a fixed 10 s product timeout (src/land.ts
// spawnSync timeout: 10_000) and refuses OWNER_UNKNOWN, before any mutation, when it expires. The 2026-11-04
// 676f556d verdict (load1 40-108 on 32 cores) failed the lost-publication case at 10137 ms with that code. As in
// private-index-land-2b, that case re-runs land only on that pre-mutation refusal, inside a load-scaled budget;
// every other answer is asserted as before.
function ownerResolved(work: string, args: string[], holds: unknown, options: CommandOptions) {
	const until = Date.now() + fixtureDeadlineS(30) * 1000;
	let run = command(work, args, holds, options);
	while (responseCode(run.body) === "OWNER_UNKNOWN" && Date.now() < until) run = command(work, args, holds, options);
	return run;
}

test("a rejecting commit-msg hook refuses before origin moves", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const before = remoteHead(work);
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hookMarker = join(scratch, `commit-msg-${fixtureNumber}.txt`);
	const hook = join(work, ".git", "hooks", "commit-msg");
	writeFileSync(hook, `#!/bin/sh\nprintf 'hook-ran\\n' > '${hookMarker}'\nexit 1\n`);
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("COMMIT_CREATION_REFUSED");
	const data = run.body.data as { overall: string; commit: null; check: { status: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.commit).toBeNull();
	expect(data.check.status).toBe("SKIP");
	expect(readFileSync(hookMarker, "utf8")).toBe("hook-ran\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(before);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

test("reports commit-only phase evidence and preserves foreign state after a post-commit interruption", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "saved before hook interruption\n");
	unlinkSync(join(work, "peer.txt"));
	git(work, ["add", "-u", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const before = remoteHead(work);
	const stagedPeer = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const stagedPeerDiff = git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"]);
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_INTERRUPTED");
	const data = run.body.data as {
		overall: string; commit: string; base: string;
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string; observed_publication_head: string;
		};
	};
	expect(data.overall).toBe("UNRUN");
	expect(data.base).toBe(before);
	expect(data.phases).toEqual({
		candidate_sha: data.commit,
		actual_parents: [before],
		publication_ref: "refs/heads/main",
		construction: "APPLIED",
		publication: "NOT_APPLIED",
		local_catch_up: "NOT_APPLIED",
		observed_local_main: data.commit,
		observed_publication_head: before,
	});
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("saved before hook interruption\n");
	expect(git(work, ["show", ":owned.txt"])).toBe("saved before hook interruption\n");
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPeer);
	expect(git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"])).toBe(stagedPeerDiff);
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(remoteHead(work)).toBe(before);
});

test("recovery after interruption never overwrites foreign postimages changed before retry", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned first save\n");
	writeFileSync(join(work, "peer.txt"), "foreign staged v1\n");
	git(work, ["add", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign worktree v1\n");
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nkill -TERM "$PPID"\nexit 0\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const interrupted = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(interrupted.status).toBe(77);
	expect(responseCode(interrupted.body)).toBe("LAND_COMMIT_INTERRUPTED");
	const firstData = interrupted.body.data as { commit: string };
	const first = firstData.commit;
	// The interrupted candidate must contain only the owned path even though a
	// foreign change was staged; otherwise --only was lost and foreign work leaked in.
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", first]).trim()).toBe("owned.txt");
	// A foreign actor changes F before recovery: the staged index entry and the
	// worktree bytes both move on after the interruption was reported.
	writeFileSync(join(work, "peer.txt"), "foreign staged v2\n");
	git(work, ["add", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign worktree v2\n");
	const stagedPostimage = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	// The faulty hook is repaired before recovery; the saved commit is kept, not undone.
	unlinkSync(hook);
	writeFileSync(join(work, "owned.txt"), "owned second save\n");
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const runData = run.body.data as { overall: string; commit: string };
	expect(runData.overall).toBe("PUSHED");
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", runData.commit]).trim()).toBe("owned.txt");
	expect(git(work, ["merge-base", "--is-ancestor", first, runData.commit]).length).toBe(0);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPostimage);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("foreign staged v2\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("foreign worktree v2\n");
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(remoteHead(work)).toBe(runData.commit);
}, 60_000);

test("lost publication observability stays UNKNOWN instead of a false zero-effects claim", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const before = remoteHead(work);
	git(work, ["remote", "remove", "origin"]);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = ownerResolved(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	const runData = run.body.data as {
		overall: string; commit: string; base: string;
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string | null; observed_publication_head: string | null;
		};
	};
	// Only the dependent publication is blocked; the save itself is real and kept.
	expect(run.status).toBe(1);
	expect(runData.overall).toBe("REFUSED");
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(runData.base).toBe(before);
	expect(runData.phases.candidate_sha).toBe(runData.commit);
	expect(runData.phases.actual_parents).toEqual([before]);
	expect(runData.phases.publication_ref).toBe("refs/heads/main");
	expect(runData.phases.construction).toBe("APPLIED");
	// Publication observability is gone, so this must stay explicitly UNKNOWN:
	// a NOT_APPLIED here would be a false zero-effects claim about origin.
	expect(runData.phases.publication).toBe("UNKNOWN");
	expect(runData.phases.observed_publication_head).toBeNull();
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(runData.commit);
	expect(git(work, ["show", `${runData.commit}:owned.txt`])).toBe("owned save\n");
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
}, fixtureDeadlineS(150) * 1000);

test("an already-published candidate is confirmed, never published twice", () => {
	const { work, fakeBin } = fixture();
	const baseCount = Number(git(work, ["rev-list", "--count", "HEAD"]).trim());
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	const attempts = join(work, "pre-push-count.txt");
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 0\n`);
	chmodSync(prePush, 0o755);
	// The candidate reaches origin out-of-band from the save hook before land's
	// own convergence runs, so the publication phase must observe it, not redo it.
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, '#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit push -q --no-verify origin main\n');
	chmodSync(postCommit, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const runData = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string;
		phases: { candidate_sha: string; construction: string; publication: string; local_catch_up: string };
	};
	expect(runData.overall).toBe("PUSHED");
	expect(runData.pushed_sha).toBe(runData.commit);
	expect(runData.phases.candidate_sha).toBe(runData.commit);
	expect(runData.phases.construction).toBe("APPLIED");
	// Independently observed on the publication ref: applied, not assumed, not retried.
	expect(runData.phases.publication).toBe("APPLIED");
	expect(remoteHead(work)).toBe(runData.commit);
	// Exactly one push attempt for one candidate and exactly one new origin
	// commit: no blind retry loop and no duplicate publication of the candidate.
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);
	expect(Number(git(work, ["rev-list", "--count", "refs/remotes/origin/main"]).trim())).toBe(baseCount + 1);
	const originCommits = git(work, ["rev-list", "refs/remotes/origin/main"]).trim().split("\n");
	expect(originCommits.filter((sha) => sha === runData.commit)).toHaveLength(1);
}, 60_000);


test("attributes the actual owned commit when a peer advances HEAD before Git returns", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "peer later save\n");
	const hook = join(work, ".git", "hooks", "post-commit");
	// The independent peer has its own Git environment, not this call's nonce.
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  unset GIT_REFLOG_ACTION\n  PEER_LANDED=1 git commit --only -m "peer later save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(data.commit).not.toBe(tip);
	expect(git(work, ["rev-parse", "HEAD^"]).trim()).toBe(data.commit);
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	expect(git(work, ["show", `${data.commit}:peer.txt`])).toBe("peer baseline\n");
	expect(git(work, ["show", "HEAD:peer.txt"])).toBe("peer later save\n");
	expect(remoteHead(work)).toBe(tip);
});

