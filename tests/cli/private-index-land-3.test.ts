import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { qualifyPublicationCandidate } from "../../src/land.ts";
import {
	EXPECTED_SERVICE, SERVICE_BASE, actualParentSetup, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, verdictPath, writeServiceLines, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

test("a v2 base missing a transitive judging dependency cannot publish using the worktree copy", () => {
	const { work, fakeBin } = fixture();
	git(work, ["rm", "scripts/pysafe.py"]);
	git(work, ["commit", "-m", "plant incomplete v2 judge [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);
	// The available working-tree helper must not repair the authoritative base.
	writeFileSync(join(work, "scripts", "pysafe.py"), readFileSync(join(repoRoot, "scripts", "pysafe.py")));
	writeFileSync(join(work, "owned.txt"), "candidate owned content\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const result = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(result.status).toBe(77);
	expect(responseCode(result.body)).toBe("LAND_FULL_SUITE_UNRUN");
	expect(remoteHead(work)).toBe(base);
});

test("a legacy base without HERMETIC1 helpers still runs its archived judge", { timeout: 120_000 }, async () => {
	const { work, fakeBin } = fixture();
	// Reconstruct a helperless suite-metrics source while preserving the current runtime interface.
	const legacyPatch = readFileSync(join(repoRoot, "tests", "fixtures", "legacy-suite-metrics.patch"));
	const legacy = await kitlibRun(["git", "apply", "--reverse"], {
		cwd: work, stdin: legacyPatch, deadline_s: 30,
	});
	expect(legacy.rc, new TextDecoder().decode(legacy.stderr)).toBe(0);
	expect(legacy.timed_out || legacy.killed).toBe(false);
	git(work, ["rm", "-f", "scripts/suite-hermetic-env.sh", "scripts/kitlib_tmp.py"]);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-m", "legacy base judge without hermetic helpers [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);

	writeFileSync(join(work, "owned.txt"), "candidate owned content\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const result = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	const data = result.body.data as { overall: string; commit: string };
	expect(data.overall).toBe("PUSHED");
	expect(data.commit).not.toBe(base);
	expect(remoteHead(work)).toBe(data.commit);
});

test("a HERMETIC1 base missing suite-hermetic-env cannot borrow the worktree copy", () => {
	const { work, fakeBin } = fixture();
	git(work, ["rm", "scripts/suite-hermetic-env.sh"]);
	git(work, ["commit", "-m", "plant missing hermetic judge dependency [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);
	writeFileSync(join(work, "scripts", "suite-hermetic-env.sh"),
		readFileSync(join(repoRoot, "scripts", "suite-hermetic-env.sh")));
	writeFileSync(join(work, "owned.txt"), "candidate owned content\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const result = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(result.status).toBe(77);
	expect(responseCode(result.body)).toBe("LAND_FULL_SUITE_UNRUN");
	expect(remoteHead(work)).toBe(base);
});

test("refuses a candidate whose exact full suite is red before origin advances", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	const contract = join(work, "suite-contract.txt");
	writeFileSync(contract, "FAIL\n");
	writeFileSync(join(work, "owned.txt"), "candidate with failing full suite\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", "suite-contract.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_FAILED");
	expect(remoteHead(work)).toBe(base);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const entryPath = verdictPath(work, tree, "base", commandEnvironment(work, hold, { amDir: fakeBin }));
	expect(JSON.parse(readFileSync(entryPath, "utf8"))).toMatchObject({
		tree, verdict: "FAIL", evidence: { complete: true },
	});
});

// The 1 s suite deadline is unchanged. Its documented 5 s KILL grace and native
// process drain must finish before this outer test/30 s command bound fires.
test("refuses incomplete full-suite evidence before origin advances", () => {
	const { work, fakeBin } = fixture();
	const base = remoteHead(work);
	writeFileSync(join(work, "suite-contract.txt"), "SLOW\n");
	writeFileSync(join(work, "owned.txt"), "candidate with incomplete full suite\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", "suite-contract.txt"), hold, {
		amDir: fakeBin,
		gitEnv: { FULL_SUITE_TIMEOUT_SECS: "1" },
	});
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_UNRUN");
	expect(remoteHead(work)).toBe(base);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const entryPath = verdictPath(work, tree, "base", commandEnvironment(work, hold, {
		amDir: fakeBin, gitEnv: { FULL_SUITE_TIMEOUT_SECS: "1" },
	}));
	expect(existsSync(entryPath)).toBe(false);
}, 35_000);
test("requires explicit --yes before publishing", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = git(work, ["ls-remote", "origin", "refs/heads/main"]).trim();
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): require explicit confirmation [test]", "--apply"], hold, { amDir: fakeBin });
	expect(run.status).toBe(2);
	expect(responseCode(run.body)).toBe("CONSENT_REQUIRED");

	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(git(work, ["ls-remote", "origin", "refs/heads/main"]).trim()).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});
test("refuses a failing registered check without moving origin", () => {
	const { work, fakeBin } = fixture();
	const checkSha = registerPushCheck(work, "#!/bin/bash\nexit 1\n");
	writeFileSync(join(work, "owned.txt"), "candidate that fails check\n");
	const base = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CHECK_FAILED");
	const data = run.body.data as {
		overall: string;
		candidate_sha: string;
		check: { status: string; sha256: string; checked_sha: string; pushed_sha: string | null };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.check.status).toBe("FAIL");
	expect(data.check.sha256).toBe(checkSha);
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(remoteHead(work)).toBe(base);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("candidate that fails check\n");
});

test("changed check bytes are skipped and never executed in the same candidate", () => {
	const { work, fakeBin } = fixture();
	const checkMarker = join(scratch, `changed-check-${fixtureNumber}.txt`);
	const registeredBody = `#!/bin/bash\nprintf 'old-check\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	const registeredSha = registerPushCheck(work, registeredBody);
	const changedBody = `#!/bin/bash\nprintf 'changed-check-ran\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	writeFileSync(join(work, ".omp", "push-check"), changedBody, { mode: 0o755 });
	writeFileSync(join(work, "owned.txt"), "owner change with check update\n");
	const hold = [
		{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: ".omp/push-check", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("owned.txt", ".omp/push-check"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as {
		overall: string;
		commit: string;
		check: { status: string; reason: string; sha256: string; candidate_sha256: string; checked_sha: string | null; pushed_sha: string };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("SKIP");
	expect(data.check.reason).toBe("hash_changed");
	expect(data.check.sha256).toBe(registeredSha);
	expect(data.check.candidate_sha256).toBe(createHash("sha256").update(changedBody).digest("hex"));
	expect(data.check.checked_sha).toBeNull();
	expect(data.check.pushed_sha).toBe(data.commit);
	expect(existsSync(checkMarker)).toBe(false);
	expect(remoteHead(work)).toBe(data.commit);
});

test("unavailable registered check returns UNRUN before commit or publication", () => {
	const { work, fakeBin } = fixture();
	registerPushCheck(work, "#!/not/a/real/land-check-runner\nexit 0\n");
	writeFileSync(join(work, "owned.txt"), "owner change\n");
	const head = git(work, ["rev-parse", "HEAD"]).trim();
	const remote = remoteHead(work);
	const index = readFileSync(join(work, ".git", "index"));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_CHECK_UNRUN");
	const data = run.body.data as { overall: string; commit: null; check: { status: string; reason: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("UNRUN");
	expect(data.commit).toBeNull();
	expect(data.check.status).toBe("UNRUN");
	expect(data.check.reason).toBe("check_interpreter_unavailable");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
	expect(remoteHead(work)).toBe(remote);
	expect(readFileSync(join(work, ".git", "index"))).toEqual(index);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("owner change\n");
});

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
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
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
}, 60_000);

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

test("compiled public land patch publishes only selected bytes through the linked-worktree stale hook and refuses a foreign removal", async () => {
	const binary = join(scratch, "stale-worktree-land-cli");
	const decoder = new TextDecoder();
	const build = await kitlibRun([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", cliPath, "--outfile", binary], {
		cwd: repoRoot, deadline_s: 120, max_output_bytes: 1024 * 1024, max_total_bytes: 2 * 1024 * 1024,
	});
	expect({ rc: build.rc, timed_out: build.timed_out, killed: build.killed, truncated: build.truncated },
		`${decoder.decode(build.stdout)}\n${decoder.decode(build.stderr)}`).toEqual({
		rc: 0, timed_out: false, killed: false, truncated: false,
	});

	for (const specimen of ["publish", "foreign"] as const) {
		// Real Git origin, index, hooks and full-suite execution. Only AM identity
		// and reservation authority use the existing isolated fixture adapter;
		// this is not installed-hook or live-fleet identity evidence.
		const { work, fakeBin } = fixture();
		writeFileSync(join(work, "service.txt"), SERVICE_BASE);
		git(work, ["add", "--", "service.txt"]);
		git(work, ["commit", "-m", "service landing [test]", "-m", "Bead: t-land"]);
		git(work, ["push", "origin", "HEAD:refs/heads/main"]);
		const base = remoteHead(work);

		const common = resolve(work, git(work, ["rev-parse", "--git-common-dir"]).trim());
		const members = join(common, "hooks", "hooks.d", "commit-msg");
		mkdirSync(members, { recursive: true });
		// Use the working source under test, not HEAD's pre-fix hook.
		writeFileSync(join(members, "49-omp-kit-stale-worktree"),
			readFileSync(join(repoRoot, "scripts", "check-stale-worktree.sh")), { mode: 0o755 });
		writeFileSync(join(members, "kitlib-tmp.sh"),
			readFileSync(join(repoRoot, "scripts", "kitlib-tmp.sh")), { mode: 0o644 });
		const hookTrace = join(scratch, `stale-hook-${specimen}-${fixtureNumber}.trace`);
		writeFileSync(join(common, "hooks", "commit-msg"), [
			"#!/bin/sh",
			"set -eu",
			'if [ -f .git ]; then printf "git-file\\n"; else printf "git-directory\\n"; fi >> "$STALE_HOOK_TRACE"',
			'here=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P)',
			'exec "$here/hooks.d/commit-msg/49-omp-kit-stale-worktree" "$@"',
		].join("\n") + "\n", { mode: 0o755 });

		writeServiceLines(work, (lines) => {
			if (specimen === "publish") lines.splice(10, 0, "selected owned addition");
			else lines.splice(10, 1);
		});
		const selected = readFileSync(join(work, "service.txt"), "utf8");
		const patch = join(scratch, `stale-hook-${specimen}-${fixtureNumber}.patch`);
		writeFileSync(patch, git(work, ["diff", "--", "service.txt"]));
		// Unselected bytes in the very same reserved file must not leak into
		// the publication, nor may unrelated peer staging be rewritten.
		writeServiceLines(work, (lines) => { lines[25] = "unselected peer hunk"; });
		writeFileSync(join(work, "peer.txt"), "peer staged bytes\n");
		git(work, ["add", "--", "peer.txt"]);
		writeFileSync(join(work, "untouched.txt"), "peer unstaged bytes\n");
		const serviceBefore = readFileSync(join(work, "service.txt"));
		const statusBefore = git(work, ["status", "--porcelain"]);
		const indexBefore = readFileSync(join(common, "index"));
		const hold = [{ agent: "DarkFern", path: "service.txt", exclusive: true, remaining_seconds: 3600 }];
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(commandEnvironment(work, hold, {
			amDir: fakeBin, gitEnv: { STALE_HOOK_TRACE: hookTrace },
		}))) {
			if (value !== undefined) env[key] = value;
		}
		const native = await kitlibRun([binary, "land", "--patch", patch, "--message",
			`feat(land): linked ${specimen} [test]\n\nBead: t-other`, "--apply", "--yes", "--json"], {
			cwd: work, env, deadline_s: 30, max_output_bytes: 1024 * 1024, max_total_bytes: 2 * 1024 * 1024,
		});
		const stdout = decoder.decode(native.stdout);
		const stderr = decoder.decode(native.stderr);
		const nativeDetail = `rc=${native.rc} timed_out=${native.timed_out} killed=${native.killed} truncated=${native.truncated}\nstdout=${stdout}\nstderr=${stderr}`;
		expect(native.timed_out || native.killed || native.truncated, nativeDetail).toBe(false);
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(stdout);
		} catch {
			throw new Error(`compiled land emitted invalid JSON: ${nativeDetail}`);
		}
		const run = { status: native.rc ?? 1, body };
		expectLandSchema(run.body.data);
		expect(readFileSync(hookTrace, "utf8")).toBe("git-file\n");
		expect(JSON.stringify(run.body)).not.toContain("Not a directory");
		if (specimen === "publish") {
			expect(run.status, `${JSON.stringify(run.body)}\n${nativeDetail}`).toBe(0);
			const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: string };
			expect(data.overall).toBe("PUSHED");
			expect(data.candidate_sha).toBe(data.commit);
			expect(data.pushed_sha).toBe(data.commit);
			expect(remoteHead(work)).toBe(data.commit);
			expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(base);
			expect(git(work, ["diff", "--name-only", base, data.commit]).trim()).toBe("service.txt");
			expect(git(work, ["show", `${data.commit}:service.txt`])).toBe(selected);
			expect(git(work, ["show", `${data.commit}:peer.txt`])).toBe("peer baseline\n");
			expect(git(work, ["show", `${data.commit}:untouched.txt`])).toBe("untouched baseline\n");
		} else {
			expect(run.status, `${JSON.stringify(run.body)}\n${nativeDetail}`).toBe(1);
			expect(responseCode(run.body)).toBe("COMMIT_CREATION_REFUSED");
			expect(run.body.data).toMatchObject({ overall: "REFUSED", commit: null });
			expect(JSON.stringify(run.body.errors)).toContain(`STALE_WORKTREE service.txt reverts ${base}`);
			expect(JSON.stringify(run.body.errors)).toContain("from bead t-land");
			expect(JSON.stringify(run.body.errors)).toContain("Supersedes:");
			expect(JSON.stringify(run.body.errors)).toContain("rework on a fresh worktree");
			expect(remoteHead(work)).toBe(base);
		}
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
		expect(readFileSync(join(work, "service.txt"))).toEqual(serviceBefore);
		expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer staged bytes\n");
		expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("peer unstaged bytes\n");
		expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
		expect(readFileSync(join(common, "index"))).toEqual(indexBefore);
	}
}, 180_000);

test("pins parsed caller hunks against patch-file replacement during fetch", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, base, caller, patch } = setup;
	writeServiceLines(caller, (lines) => { lines[27] = "unselected foreign replacement"; });
	const replacement = git(caller, ["diff", base]);
	const replacementPath = join(scratch, `replacement-${fixtureNumber}.patch`);
	writeFileSync(replacementPath, replacement);
	const realGit = Bun.which("git");
	if (realGit === null) throw new Error("the real Git executable is required");
	const gitWrapper = join(fakeBin, "git");
	writeFileSync(gitWrapper, [
		"#!/bin/sh",
		'if [ "$1" = fetch ] && [ "$2" = origin ] && [ "$3" = refs/heads/main ]; then',
		'  cp "$TEST_PATCH_REPLACEMENT" "$TEST_PATCH_FILE" || exit "$?"',
		"fi",
		'exec "$TEST_REAL_GIT" "$@"',
	].join("\n") + "\n");
	chmodSync(gitWrapper, 0o755);
	const run = command(work, ["--patch", patch, "--message", "feat(land): pin selected caller bytes [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: {
			TEST_REAL_GIT: realGit,
			TEST_PATCH_REPLACEMENT: replacementPath,
			TEST_PATCH_FILE: patch,
			OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent,
			OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded,
		},
	});
	expect(run.status).toBe(0);
	expect(readFileSync(patch, "utf8")).toBe(replacement);
	const commit = remoteHead(work);
	expect(git(work, ["show", `${commit}:service.txt`])).toBe(EXPECTED_SERVICE);
	expect(git(work, ["show", `${commit}:feature/added.txt`])).toBe("caller added file\n");
});

test("refuses a patch whose exact full suite is red before origin advances", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, bare, base, patch } = setup;
	const caller = join(scratch, `full-suite-caller-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", bare, caller]);
	git(caller, ["config", "user.name", "caller"]);
	git(caller, ["config", "user.email", "caller@example.invalid"]);
	writeFileSync(join(caller, "suite-contract.txt"), "FAIL\n");
	git(caller, ["add", "suite-contract.txt"]);
	git(caller, ["commit", "-m", "break declared suite [test]"]);
	writeFileSync(patch, `${readFileSync(patch, "utf8")}${git(caller, ["diff", base, "HEAD"])}`);
	const hold = [
		...patchHold(),
		{ agent: "DarkFern", path: "suite-contract.txt", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, ["--patch", patch, "--message", "feat(land): reject failing full suite [test]", "--apply", "--yes"], hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_FULL_SUITE_FAILED");
	expect(remoteHead(work)).toBe(base);
	const data = run.body.data;
	if (data === null || typeof data !== "object" || !("commit" in data) || typeof data.commit !== "string")
		throw new Error("land patch refusal omitted its constructed candidate commit");
	const candidate = data.commit;
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const entryPath = verdictPath(work, tree, "base", commandEnvironment(work, hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	}));
	expect(JSON.parse(readFileSync(entryPath, "utf8"))).toMatchObject({
		tree, verdict: "FAIL", evidence: { complete: true },
	});
});

test("refuses a true three-way conflict naming the file and hunks", () => {
	const setup = hunkSetup("conflict");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	expect(originBefore).not.toBe(base);
	const refsBefore = git(work, ["for-each-ref", "refs/heads"]);
	const treesBefore = git(work, ["worktree", "list", "--porcelain"]);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--patch", patch, "--message", "feat(land): conflicting selection [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("PATCH_CONFLICT");
	const data = run.body.data as { overall: string; commit: null; base: string; check: { status: string }; phases: { construction: string; publication: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.commit).toBeNull();
	expect("candidate_sha" in data).toBe(false);
	expect(data.base).toBe(originBefore);
	expect(data.check.status).toBe("UNRUN");
	expect(data.phases.construction).toBe("NOT_APPLIED");
	expect(data.phases.publication).toBe("UNKNOWN");
	const message = (run.body.errors as { message: string }[])[0]?.message ?? "";
	expect(message).toContain("service.txt");
	expect(message).toContain("@@");
	expect(remoteHead(work)).toBe(originBefore);
	// Patch mode fetches fresh origin/main by design, so only local branches must be untouched.
	expect(git(work, ["for-each-ref", "refs/heads"])).toBe(refsBefore);
	expect(git(work, ["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(originBefore);
	expect(git(work, ["worktree", "list", "--porcelain"])).toBe(treesBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("refuses origin movement during construction without publishing", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, bare, base, patch } = setup;
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, writer]);
	git(writer, ["config", "user.name", "writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const writerSha = git(writer, ["rev-parse", "HEAD"]).trim();
	const commitMsg = join(work, ".git", "hooks", "commit-msg");
	// The reconstruction commit runs in a linked scratch worktree, whose absolute
	// GIT_DIR would otherwise capture the nested push into the wrong repository.
	writeFileSync(commitMsg, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE\ngit -C '${writer}' push origin HEAD:refs/heads/main\nexit 0\n`);
	chmodSync(commitMsg, 0o755);
	const attempts = join(scratch, `patch-push-attempts-${fixtureNumber}.txt`);
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 0\n`);
	chmodSync(prePush, 0o755);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--patch", patch, "--message", "feat(land): moved origin [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_ORIGIN_MOVED");
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null; base: string;
		check: { status: string; checked_sha: string; pushed_sha: null }; phases: { publication: string };
		convergence: { state: string; reason: string | null; pushed: boolean; remote_after: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("REFUSED");
	expect(data.base).toBe(base);
	expect(data.candidate_sha).toBe(data.commit);
	expect(data.pushed_sha).toBeNull();
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.candidate_sha);
	expect(data.check.pushed_sha).toBeNull();
	expect(data.phases.publication).toBe("NOT_APPLIED");
	expect(data.convergence.state).toBe("REFUSED");
	expect(data.convergence.reason).toBe("ORIGIN_MOVED");
	expect(data.convergence.pushed).toBe(false);
	expect(data.convergence.remote_after).toBe(writerSha);
	expect(remoteHead(work)).toBe(writerSha);
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(existsSync(attempts)).toBe(false);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("refuses a patch naming a path outside the owner reservation", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const hold = [{ agent: "DarkFern", path: "peer.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--patch", patch, "--message", "feat(land): uncovered selection [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("RESERVATION_REQUIRED");
	const errors = run.body.errors as { message: string }[];
	expect(errors[0]?.message ?? "").toContain("service.txt");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("refuses worktree paths combined with a patch file", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, base, patch } = setup;
	const originBefore = remoteHead(work);
	const run = command(work, ["--paths", "service.txt", "--patch", patch, "--message", "feat(land): mixed modes [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PATCH_EXCLUSIVE");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("publishes only the approved owned delta parented on the actual parent", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	writeFileSync(join(work, "owned.txt"), "actual parent bytes plus approved delta\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(0);
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string;
		paths: string[]; base: string; localMain: string;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string; construction: string; publication: string };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(parent);
	expect(data.owner).toBe("DarkFern");
	expect(data.candidate_sha).toBe(data.commit);
	expect(data.pushed_sha).toBe(data.commit);
	expect(data.localMain).toBe(data.commit);
	// The candidate is parented on exactly the actual publication parent.
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(parent);
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	// The candidate publishes ONLY the approved owned delta.
	expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", data.commit]).trim()).toBe("owned.txt");
	// Nonauthor native observer: real tree/ref/index/worktree postimages.
	expect(git(work, ["show", `${data.commit}:owned.txt`])).toBe("actual parent bytes plus approved delta\n");
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(data.commit);
	expect(git(work, ["rev-parse", ":owned.txt"]).trim()).toBe(git(work, ["rev-parse", `${data.commit}:owned.txt`]).trim());
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("actual parent bytes plus approved delta\n");
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer baseline\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("untouched baseline\n");
	expect(remoteHead(work)).toBe(data.commit);
});

test("refuses a caller patch restoring bytes the actual parent superseded", () => {
	const { work, fakeBin, seed, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const caller = join(scratch, `stale-caller-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, caller]);
	git(caller, ["config", "user.name", "stale caller"]);
	git(caller, ["config", "user.email", "stale-caller@example.invalid"]);
	// The caller selection restores the seed bytes onto the actual parent.
	writeFileSync(join(caller, "owned.txt"), "base owned\n");
	git(caller, ["add", "--", "owned.txt"]);
	git(caller, ["commit", "-m", "stale restore [test]"]);
	const patch = join(scratch, `stale-restore-${fixtureNumber}.patch`);
	writeFileSync(patch, git(caller, ["diff", parent, "HEAD"]));
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const localBefore = git(work, ["rev-parse", "HEAD"]).trim();
	const run = command(work, ["--patch", patch, "--message", "feat(land): stale restore [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_STALE_RESTORE");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null;
		phases: { candidate_sha: string; actual_parents: string[]; publication_ref: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	// The refused candidate really was parented on the actual parent with stale bytes.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("base owned\n");
	expect(data.phases.actual_parents).toEqual([parent]);
	expect(data.phases.publication_ref).toBe("refs/heads/main");
	// Zero publication: the seed bytes never reach origin and local refs never move.
	expect(remoteHead(work)).toBe(parent);
	expect(git(work, ["show", `${parent}:owned.txt`])).toBe("actual parent bytes\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(localBefore);
	expect(seed).not.toBe(parent);
});

test("refuses when the publication parent advances before publication", () => {
	const { work, fakeBin, parent } = actualParentSetup();
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	const peerDir = join(scratch, `race-peer-${fixtureNumber++}`);
	git(scratch, ["clone", "--branch", "main", origin, peerDir]);
	git(peerDir, ["config", "user.name", "race peer"]);
	git(peerDir, ["config", "user.email", "race-peer@example.invalid"]);
	// B3 advances the same owned path, so no silent merge can absorb it.
	writeFileSync(join(peerDir, "owned.txt"), "peer raced publication\n");
	git(peerDir, ["add", "--", "owned.txt"]);
	git(peerDir, ["commit", "-m", "race advance [test]"]);
	const raced = git(peerDir, ["rev-parse", "HEAD"]).trim();
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${peerDir}' push origin main\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "approved delta raced by peer\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: null; base: string;
		convergence: { reason: string };
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.base).toBe(parent);
	expect(data.pushed_sha).toBeNull();
	// The saved candidate is preserved parented on B2, but origin holds B3: zero publication.
	expect(git(work, ["show", "-s", "--format=%P", data.candidate_sha]).trim()).toBe(parent);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("approved delta raced by peer\n");
	expect(remoteHead(work)).toBe(raced);
	expect(remoteHead(work)).not.toBe(data.candidate_sha);
	expect(git(work, ["show", `${raced}:owned.txt`])).toBe("peer raced publication\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
});

test("refuses when live custody lapses between save and publication", () => {
	const { work } = fixture();
	const base = remoteHead(work);
	const holdsFile = join(scratch, `custody-holds-${fixtureNumber++}.json`);
	const currentHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 });
	const attestation = `"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}`;
	writeFileSync(holdsFile, `{"my_reservations":[${currentHolds}],${attestation}}`);
	const expiredHolds = JSON.stringify({ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 0 });
	const statefulBin = join(scratch, `stateful-am-${fixtureNumber}`);
	mkdirSync(statefulBin);
	writeFileSync(join(statefulBin, "am"), String.raw`#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") printf '{"agent_name":"DarkFern"}\n' ;;
  "robot reservations") cat "$FAKE_HOLDS_FILE" ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(statefulBin, "am"), 0o755);
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nprintf '{"my_reservations":[%s],%s}' '${expiredHolds}' '${attestation}' > "$FAKE_HOLDS_FILE"\n`);
	chmodSync(postCommit, 0o755);
	writeFileSync(join(work, "owned.txt"), "owned save with lapsing custody\n");
	const run = command(work, landArgs("owned.txt"), [], { amDir: statefulBin, gitEnv: { FAKE_HOLDS_FILE: holdsFile } });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_CUSTODY_EXPIRED");
	expectLandSchema(run.body.data);
	const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: null };
	expect(data.overall).toBe("REFUSED");
	expect(data.pushed_sha).toBeNull();
	// The save is real and kept, but nothing was published after custody lapsed.
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("owned save with lapsing custody\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(data.candidate_sha);
	expect(remoteHead(work)).toBe(base);
});

test("the actual-parent guard names its ref and reads real parents", () => {
	const { work } = fixture();
	const base = git(work, ["rev-parse", "HEAD"]).trim();
	const unnamed = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "", qualifiedBlobs: {},
	});
	expect("refusal" in unnamed && unnamed.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNNAMED");
	const foreign = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/feature", qualifiedBlobs: {},
	});
	expect("refusal" in foreign && foreign.refusal.errors?.[0]?.code).toBe("LAND_PUBLICATION_REF_UNSUPPORTED");
	const absent = qualifyPublicationCandidate(work, {
		candidate: "f".repeat(40), base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in absent && absent.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_UNREADABLE");
	// The root fixture commit has no parent at all, so it can never qualify against itself as base.
	const mismatch = qualifyPublicationCandidate(work, {
		candidate: base, base, paths: ["owned.txt"], owner: "DarkFern",
		publicationRef: "refs/heads/main", qualifiedBlobs: {},
	});
	expect("refusal" in mismatch && mismatch.refusal.errors?.[0]?.code).toBe("LAND_ACTUAL_PARENT_MISMATCH");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
});

test("doctor reports the land guard identities and decision", () => {
	const { work, fakeBin } = fixture();
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--scope", "land"], hold, { amDir: fakeBin, subcommand: "doctor" });
	const data: unknown = run.body.data;
	const findings: unknown = data !== null && typeof data === "object" && "findings" in data ? data.findings : undefined;
	expect(Array.isArray(findings)).toBe(true);
	const land = (Array.isArray(findings) ? findings : []).find((entry): entry is { component: unknown; status: unknown; reason: unknown; evidence: unknown } =>
		typeof entry === "object" && entry !== null && "component" in entry && entry.component === "land");
	expect(land?.status).toBe("OK");
	const evidence: unknown = land !== undefined && typeof land.evidence === "object" && land.evidence !== null ? land.evidence : undefined;
	expect(evidence).toMatchObject({
		guard: "actual-parent-custody-v1",
		publication_ref: "refs/heads/main",
		owner: "DarkFern",
		owner_capability: "verified-current",
		actual_parent_capability: "native-git",
		decision: "READY",
	});
	expect(typeof land?.reason).toBe("string");
});
