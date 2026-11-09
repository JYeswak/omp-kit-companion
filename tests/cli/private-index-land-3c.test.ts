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
	EXPECTED_SERVICE, SERVICE_BASE, actualParentSetup, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, verdictPath, writeServiceLines, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);
// GATESPEED1: land defers the complete suite to the release by default; these cases assert the
// inline suite's refusals, so this file opts in for every land command it runs.
process.env.PRE_PUSH_FULL_SUITE = "push";

test("compiled public land patch publishes only selected bytes through the canonical-checkout stale hook and refuses a foreign removal", async () => {
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
		const stagedPeerOid = git(work, ["rev-parse", ":peer.txt"]).trim();
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
		expect(readFileSync(hookTrace, "utf8")).toBe("git-directory\n");
		expect(JSON.stringify(run.body)).not.toContain("Not a directory");
		let publishedCommit: string | null = null;
		if (specimen === "publish") {
			expect(run.status, `${JSON.stringify(run.body)}\n${nativeDetail}`).toBe(0);
			const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: string };
			publishedCommit = data.commit;
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
		// Patch mode commits the reconstruction on local main like path mode:
		// publish moves HEAD onto the selected bytes, while a refusal restores
		// the exact pre-landing worktree bytes and index.
		expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(publishedCommit ?? base);
		expect(readFileSync(join(work, "service.txt"))).toEqual(serviceBefore);
		expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("peer staged bytes\n");
		expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("peer unstaged bytes\n");
		expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
		if (specimen === "publish") {
			// The local-main commit refreshed only its own path entries, the
			// same contract as path mode's native --only transaction: the
			// unrelated peer staging still names its exact pre-landing blob.
			expect(git(work, ["rev-parse", ":peer.txt"]).trim()).toBe(stagedPeerOid);
			expect(git(work, ["rev-parse", ":service.txt"]).trim()).toBe(git(work, ["rev-parse", `${publishedCommit}:service.txt`]).trim());
		} else expect(readFileSync(join(common, "index"))).toEqual(indexBefore);
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

test("merges a concurrent advance to an unrelated path and publishes the merge", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, bare, base, patch } = setup;
	// A competing writer lands on origin while our local commit runs: the
	// commit-msg hook below pushes it before publication, so convergence must
	// integrate it exactly the way path mode does instead of refusing.
	const writer = join(scratch, `writer-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, writer]);
	git(writer, ["config", "user.name", "writer"]);
	git(writer, ["config", "user.email", "writer@example.invalid"]);
	writeFileSync(join(writer, "untouched.txt"), "concurrent remote change\n");
	git(writer, ["add", "untouched.txt"]);
	git(writer, ["commit", "-m", "competing writer [test]"]);
	const writerSha = git(writer, ["rev-parse", "HEAD"]).trim();
	const commitMsg = join(work, ".git", "hooks", "commit-msg");
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
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; base: string;
		check: { status: string; checked_sha: string; pushed_sha: string }; phases: { construction: string; publication: string };
		convergence: { state: string; reason: string | null; pushed: boolean; published_commits: number; remote_after: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(base);
	expect(data.candidate_sha).toBe(data.pushed_sha);
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.pushed_sha);
	expect(data.check.pushed_sha).toBe(data.pushed_sha);
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	expect(data.convergence.state).toBe("MERGED");
	expect(data.convergence.reason).toBeNull();
	expect(data.convergence.pushed).toBe(true);
	expect(data.convergence.published_commits).toBe(2);
	expect(data.convergence.remote_after).toBe(data.pushed_sha);
	expect(remoteHead(work)).toBe(data.pushed_sha);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(data.pushed_sha);
	// The merge joined the writer advance with the reconstructed hunks: our
	// saved local commit first, the writer advance second, both byte sets
	// present, and the publication push actually ran the installed hooks.
	expect(git(work, ["rev-parse", `${data.pushed_sha}^1`]).trim()).toBe(data.commit);
	expect(git(work, ["rev-parse", `${data.pushed_sha}^2`]).trim()).toBe(writerSha);
	expect(git(work, ["show", `${data.pushed_sha}:untouched.txt`])).toBe("concurrent remote change\n");
	expect(git(work, ["show", `${data.pushed_sha}:feature/added.txt`])).toBe("caller added file\n");
	expect(existsSync(attempts)).toBe(true);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore.replace(" M service.txt\n", ""));
});

