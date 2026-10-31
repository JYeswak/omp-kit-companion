import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { runFixture, runFixtureAsync } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	EXPECTED_SERVICE, SERVICE_BASE, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, landSchema, patchHold, remoteHead, repoRoot, responseCode, schemaViolations, scratch, stringEnvironment, verdictPath, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);
const fixtureDecoder = new TextDecoder();

test("the published land schema rejects what land never emits and what a PUSHED land must carry", () => {
	const check = { status: "PASS", path: ".omp/push-check", sha256: null, selected_executable: null, selected_version: null, candidate_sha: null, checked_sha: null, pushed_sha: null, exit_code: null };
	const pushed = { overall: "PUSHED", commit: "a".repeat(40), candidate_sha: "a".repeat(40), pushed_sha: "a".repeat(40), owner: "x", paths: ["p"], base: "b", convergence: {}, check };
	expect(schemaViolations({ overall: "REFUSED", check: { ...check, status: "UNRUN", reason: "not_started" } }, landSchema)).toEqual([]);
	expect(schemaViolations({ ...pushed, overall: "SAVED_NOT_PUBLISHED" }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, pushed_sha: null }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, commit: null }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ ...pushed, check: { ...check, status: "MAYBE" } }, landSchema)).not.toEqual([]);
	expect(schemaViolations({ overall: "UNRUN" }, landSchema)).not.toEqual([]);
});
test("the published grammar lists exit 77 as not_run", () => {
	const child = runFixture([process.execPath, "run", cliPath, "schema", "--json"], {
		cwd: repoRoot, env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" } });
	expect(child.rc).toBe(0);
	const body = JSON.parse(fixtureDecoder.decode(child.stdout)) as { data: { exit_codes: Record<string, number> } };
	expect(body.data.exit_codes).toMatchObject({ not_run: 77, success: 0, finding: 1 });
});
test("checks the exact candidate with the base-registered push check before publishing", { timeout: 120_000 }, async () => {
	const { work, fakeBin } = fixture();
	const prePushFixtureFiles = [
		".github/workflows/release-train.yml", ".github/workflows/release.yml",
		"README.md",
		"scripts/ac_phase.py", "scripts/agent-trailer-hook.sh", "scripts/bead_lint.py",
		"scripts/br-create-guard.py", "scripts/br_create_guard_core.py", "scripts/br-shim.sh",
		"scripts/br-update-lint.py", "scripts/check-pushed-beads.sh",
		"scripts/check-staged-br-init.sh", "scripts/close-guard.sh", "scripts/commit-msg-bead.sh",
		"scripts/doc-drift-check.sh", "scripts/derived-check.sh", "scripts/dispatch-check.sh",
		"scripts/install-agent-trailer-hook.sh", "scripts/kitlib_lock.py", "scripts/kitlib_run.py",
		"scripts/kitlib_tmp.py", "scripts/kitlib_ratchet_core.py", "scripts/publishability-check.sh",
		"scripts/public-files-check.sh", "scripts/pysafe_check.py", "scripts/release-notes.sh",
		"scripts/release-notes.ts", "scripts/release-train.sh", "scripts/br_init_check.py",
		"scripts/stamp-release-line.sh",
		"src/actuator-admission.ts",
		"tests/cli/actuator-admission.test.ts", "tests/cli/agent-trailer.test.sh",
		"tests/cli/br-shim.test.sh", "tests/cli/check-pushed-beads.test.sh",
		"tests/cli/check-staged-br-init.test.sh", "tests/cli/commit-msg-bead.test.sh",
		"tests/cli/derived-check.test.sh", "tests/cli/dispatch-check.test.sh",
		"tests/cli/doc-drift.test.sh", "tests/cli/git-env-fixtures.sh",
		"tests/cli/lib/br-create-guard-tests.sh", "tests/cli/public-files.test.sh",
		"tests/cli/publishability.test.sh", "tests/cli/release-train.test.sh",
	];
	mkdirSync(join(work, ".github", "workflows"), { recursive: true });
	mkdirSync(join(work, "tests", "cli", "lib"), { recursive: true });
	mkdirSync(join(work, "src"), { recursive: true });
	for (const path of prePushFixtureFiles) cpSync(join(repoRoot, path), join(work, path));
	// Bootstrap runner contracts are healthy dependencies, not this land test's subject.
	for (const name of ["full-suite-verdict-incomplete.test.sh", "pre-push-gate.test.sh"])
		writeFileSync(join(work, "tests", "cli", name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	writeFileSync(join(work, "scripts", "fresh-gate.sh"), "#!/bin/sh\nif [ \"${1-}\" = \"--test-workers\" ]; then printf '1\\n'; fi\nexit 0\n", { mode: 0o755 });
	writeFileSync(join(fakeBin, "br"), "#!/bin/sh\nfor arg do\n\t[ \"$arg\" = \"ompkit-kup44.5\" ] && exit 0\ndone\nexit 3\n", { mode: 0o755 });
	mkdirSync(join(work, ".omp"), { recursive: true });
	const checkBody = [
		"#!/bin/bash",
		"set -eu",
		'printf "%s\\n" "$OMP_LAND_CANDIDATE_SHA" > "$OMP_LAND_CHECK_SHA_FILE"',
		'git -C "$OMP_LAND_REPOSITORY" show "$OMP_LAND_CANDIDATE_SHA:owned.txt" > "$OMP_LAND_CHECK_CONTENT_FILE"',
	].join("\n") + "\n";
	const checkPath = join(work, ".omp", "push-check");
	writeFileSync(checkPath, checkBody, { mode: 0o755 });
	git(work, ["add", "-A"]);
	git(work, ["commit", "-m", "register push check [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);

	writeFileSync(join(work, "owned.txt"), "candidate owned content\n");
	writeFileSync(join(work, ".git", "hooks", "post-commit"),
		`#!/bin/sh\nprintf 'post-commit worktree edit\\n' > '${join(work, "owned.txt")}'\n`);
	chmodSync(join(work, ".git", "hooks", "post-commit"), 0o755);
	const checkShaFile = join(scratch, `checked-sha-${fixtureNumber}.txt`);
	const checkContentFile = join(scratch, `checked-content-${fixtureNumber}.txt`);
	const prePushOutput = join(scratch, `land-pre-push-output-${fixtureNumber}.txt`);
	writeFileSync(prePushOutput, "");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const identity = await runFixtureAsync(["python3", join(work, "scripts", "suite-metrics.py"), "identity", "--root", work, "--scope", "full"], {
		cwd: work, floor_s: 30,
	});
	expect(identity.rc, new TextDecoder().decode(identity.stderr)).toBe(0);
	expect(identity.timed_out).toBe(false);
	const expectedChecks = new TextDecoder().decode(identity.stdout).trim();
	const prePushHook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePushHook, "#!/bin/sh\nexec sh scripts/pre-push-gate.sh \"$@\" >\"$OMP_KIT_TEST_PRE_PUSH_OUTPUT\" 2>&1\n", { mode: 0o755 });
	const landCommandArgs = landArgs("owned.txt");
	landCommandArgs[landCommandArgs.indexOf("--message") + 1] = "feat(land): publish reserved fixture ompkit-kup44.5 [test]";
	const run = command(work, landCommandArgs, hold, {
		timeoutMs: 120_000,
		amDir: fakeBin,
		gitEnv: {
			OMP_LAND_CHECK_SHA_FILE: checkShaFile,
			OMP_LAND_REPOSITORY: work,
			OMP_LAND_CHECK_CONTENT_FILE: checkContentFile,
			OMP_KIT_TEST_PRE_PUSH_OUTPUT: prePushOutput,
		},
	});
	expect(run.status, `${JSON.stringify(run.body)}\n${readFileSync(prePushOutput, "utf8")}`).toBe(0);
	const data = run.body.data as {
		overall: string;
		commit: string;
		check?: {
			status: string;
			path: string;
			sha256: string;
			selected_executable: string;
			selected_version: string;
			checked_sha: string;
			pushed_sha: string;
		};
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.check?.status).toBe("PASS");
	expect(data.check?.path).toBe(".omp/push-check");
	expect(data.check?.sha256).toBe(createHash("sha256").update(checkBody).digest("hex"));
	// land.ts records the realpath of the shebang interpreter: /bin/bash on macOS, /usr/bin/bash on usr-merged Linux.
	expect(data.check?.selected_executable).toBe(realpathSync("/bin/bash"));
	expect(data.check?.selected_version.length).toBeGreaterThan(0);
	expect(data.check?.checked_sha).toBe(data.commit);
	expect(data.check?.pushed_sha).toBe(data.commit);
	expect(readFileSync(checkShaFile, "utf8")).toBe(`${data.commit}\n`);
	expect(readFileSync(checkContentFile, "utf8")).toBe("candidate owned content\n");
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("post-commit worktree edit\n");
	const tree = git(work, ["rev-parse", `${data.commit}^{tree}`]).trim();
	const verificationEnv = commandEnvironment(work, hold, {
		amDir: fakeBin,
		gitEnv: {
			OMP_LAND_CHECK_SHA_FILE: checkShaFile,
			OMP_LAND_REPOSITORY: work,
			OMP_LAND_CHECK_CONTENT_FILE: checkContentFile,
		},
	});
	const verdictFile = verdictPath(work, tree, "main", verificationEnv, expectedChecks);
	const verdict = JSON.parse(readFileSync(verdictFile, "utf8")) as {
		tree: string; checks: string; verdict: string; evidence: { complete: boolean };
	};
	expect(verdict).toMatchObject({ tree, checks: expectedChecks, verdict: "PASS", evidence: { complete: true } });
	const judgeArchive = ownedTmp("land-prepush-verdict", { root: scratch });
	try {
		const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		const decoder = new TextDecoder();
		const archive = await runFixtureAsync(["git", "-C", work, "archive", data.commit], {
			cwd: work, env: gitEnv, floor_s: 30,
		});
		expect(archive.rc, decoder.decode(archive.stderr)).toBe(0);
		expect(archive.timed_out || archive.killed || archive.truncated || archive.total_truncated).toBe(false);
		const unpacked = await runFixtureAsync(["tar", "-xf", "-", "-C", judgeArchive.path], {
			cwd: work, env: gitEnv, stdin: archive.stdout, floor_s: 30,
		});
		expect(unpacked.rc, decoder.decode(unpacked.stderr)).toBe(0);
		expect(unpacked.timed_out || unpacked.killed || unpacked.truncated || unpacked.total_truncated).toBe(false);
		const replay = await runFixtureAsync(["sh", join(judgeArchive.path, "scripts", "full-suite-verdict.sh"),
			"--repo", work, "--commit", data.commit, "--judge-role", "main"],
			{ cwd: work, env: stringEnvironment(verificationEnv), floor_s: 30 });
		const replayOutput = decoder.decode(replay.stdout) + decoder.decode(replay.stderr);
		expect(replay.rc, replayOutput).toBe(0);
		expect(replay.timed_out || replay.killed || replay.truncated || replay.total_truncated).toBe(false);
	} finally {
		judgeArchive.cleanup();
	}
	expect(remoteHead(work)).toBe(data.commit);
});
test("contradictory cached PASS evidence is a cache miss and cannot publish", () => {
	const { work } = fixture();
	writeFileSync(join(work, "suite-contract.txt"), "FAIL\n");
	git(work, ["add", "suite-contract.txt"]);
	git(work, ["commit", "-m", "plant red suite [test]"]);
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const script = join(work, "scripts", "full-suite-verdict.sh");
	const cache = join(work, "var", "agent-tmp", "full-suite-verdicts");
	const first = runFixture(["sh", script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, floor_s: 30,
	});
	expect(first.rc, fixtureDecoder.decode(first.stdout) + fixtureDecoder.decode(first.stderr)).toBe(1);
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const entryPath = verdictPath(work, tree, "base", { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" });
	const entry = JSON.parse(readFileSync(entryPath, "utf8")) as { verdict: string; exit_code: number; evidence: Record<string, unknown> };
	entry.verdict = "PASS";
	entry.exit_code = 0;
	entry.evidence.shell_fail = 1;
	writeFileSync(entryPath, JSON.stringify(entry) + "\n");
	const contradictory = runFixture(["sh", script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, floor_s: 30,
	});
	expect(contradictory.rc, fixtureDecoder.decode(contradictory.stdout) + fixtureDecoder.decode(contradictory.stderr)).toBe(1);
	expect(fixtureDecoder.decode(contradictory.stdout) + fixtureDecoder.decode(contradictory.stderr)).toContain("cache miss");
	const missingCount = JSON.parse(readFileSync(entryPath, "utf8")) as { verdict: string; exit_code: number; evidence: Record<string, unknown> };
	missingCount.verdict = "PASS";
	missingCount.exit_code = 0;
	delete missingCount.evidence.bun_files;
	missingCount.evidence.bun_ran = 0;
	missingCount.evidence.bun_fail = 0;
	missingCount.evidence.shell_fail = 0;
	missingCount.evidence.py_fail = 0;
	writeFileSync(entryPath, JSON.stringify(missingCount) + "\n");
	const missing = runFixture(["sh", script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
		cwd: work, env: { ...process.env, OMP_KIT_OMP_SRC_FETCH: "0" }, floor_s: 30,
	});
	expect(missing.rc, fixtureDecoder.decode(missing.stdout) + fixtureDecoder.decode(missing.stderr)).toBe(1);
	expect(fixtureDecoder.decode(missing.stdout) + fixtureDecoder.decode(missing.stderr)).toContain("cache miss");
});
test("missing or corrupt suite logs are not reused as cached PASS", async () => {
	const { work } = fixture();
	const candidate = git(work, ["rev-parse", "HEAD"]).trim();
	const script = join(work, "scripts", "full-suite-verdict.sh");
	const cache = join(work, "var", "agent-tmp", "full-suite-verdicts");
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.OMP_KIT_OMP_SRC_FETCH = "0";
	const runOnce = async () => {
		const result = await runFixtureAsync(["sh", script, "--repo", work, "--commit", candidate, "--cache-dir", cache], {
			cwd: work, env, floor_s: 30,
		});
		const decoder = new TextDecoder();
		return { status: result.rc, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
	};
	const first = await runOnce();
	expect(first.status, first.stdout + first.stderr).toBe(0);
	const tree = git(work, ["rev-parse", `${candidate}^{tree}`]).trim();
	const entryPath = verdictPath(work, tree, "base", env);
	const logPath = entryPath.slice(0, -".json".length) + ".log";
	const originalLog = readFileSync(logPath, "utf8");
	expect(originalLog).toContain("GREEN script-suite tests/cli/land-suite.test.sh");
	const initialEntry = JSON.parse(readFileSync(entryPath, "utf8")) as { evidence: { log_sha256?: string } };
	expect(initialEntry.evidence.log_sha256).toBe(createHash("sha256").update(originalLog).digest("hex"));

	for (const damage of ["corrupt", "missing"] as const) {
		if (damage === "corrupt") writeFileSync(logPath, "corrupted suite evidence\n");
		else unlinkSync(logPath);
		const replay = await runOnce();
		const output = `${replay.stdout}${replay.stderr}`;
		expect(replay.status, output).toBe(0);
		expect(output).toContain("FULL-SUITE: cache miss");
		expect(output).not.toContain("FULL-SUITE: VERDICT REUSED PASS");
		const replacementLog = readFileSync(logPath, "utf8");
		const replacementEntry = JSON.parse(readFileSync(entryPath, "utf8")) as { evidence: { log_sha256?: string } };
		expect(replacementEntry.evidence.log_sha256).toBe(createHash("sha256").update(replacementLog).digest("hex"));
	}
}, 35_000);
test("first check registration is skipped until a later landing", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, ".omp"), { recursive: true });
	const checkMarker = join(scratch, `new-check-${fixtureNumber}.txt`);
	const body = `#!/bin/bash\nprintf 'new-check-ran\\n' > \"$OMP_LAND_CHECK_MARKER_FILE\"\nexit 0\n`;
	writeFileSync(join(work, ".omp", "push-check"), body, { mode: 0o755 });
	writeFileSync(join(work, "new-owned.txt"), "first registration\n");
	const hold = [
		{ agent: "DarkFern", path: "new-owned.txt", exclusive: true, remaining_seconds: 3600 },
		{ agent: "DarkFern", path: ".omp/push-check", exclusive: true, remaining_seconds: 3600 },
	];
	const run = command(work, landArgs("new-owned.txt", ".omp/push-check"), hold, {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_MARKER_FILE: checkMarker },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as { overall: string; commit: string; check: { status: string; reason: string; checked_sha: string | null } };
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("SKIP");
	expect(data.check.reason).toBe("unregistered");
	expect(data.check.checked_sha).toBeNull();
	expect(existsSync(checkMarker)).toBe(false);
	expect(remoteHead(work)).toBe(data.commit);
});

test("reports local catch-up without claiming publication or retrying", () => {
	const { work, fakeBin } = fixture();
	const peerWork = join(scratch, `peer-${fixtureNumber++}`);
	const origin = git(work, ["remote", "get-url", "origin"]).trim();
	git(scratch, ["clone", origin, peerWork]);
	git(peerWork, ["config", "user.name", "LAND1 peer"]);
	git(peerWork, ["config", "user.email", "land1-peer@example.invalid"]);
	writeFileSync(join(peerWork, "remote.txt"), "peer origin advance\n");
	git(peerWork, ["add", "remote.txt"]);
	git(peerWork, ["commit", "-m", "peer origin advance [test]"]);
	const peerTip = git(peerWork, ["rev-parse", "HEAD"]).trim();

	writeFileSync(join(work, "owned.txt"), "owned before catch-up\n");
	unlinkSync(join(work, "peer.txt"));
	git(work, ["add", "-u", "--", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "foreign unstaged postimage\n");
	const before = remoteHead(work);
	const stagedPeer = git(work, ["ls-files", "-s", "--", "peer.txt"]);
	const stagedPeerDiff = git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"]);
	const foreignWorktree = readFileSync(join(work, "untouched.txt"));
	const postCommit = join(work, ".git", "hooks", "post-commit");
	writeFileSync(postCommit, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES\ngit -C '${peerWork}' push origin main\n`);
	chmodSync(postCommit, 0o755);
	const attempts = join(work, "pre-push-count.txt");
	const prePush = join(work, ".git", "hooks", "pre-push");
	writeFileSync(prePush, `#!/bin/sh\nprintf 'attempt\\n' >> '${attempts}'\nexit 1\n`);
	chmodSync(prePush, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];

	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	const data = run.body.data as {
		overall: string; commit: string; base: string; localMain: string;
		convergence: { reason: string };
		phases: {
			candidate_sha: string; actual_parents: string[]; publication_ref: string;
			construction: string; publication: string; local_catch_up: string;
			observed_local_main: string; observed_publication_head: string;
		};
	};
	expect(data.overall).toBe("REFUSED");
	expect(data.convergence.reason).toBe("PUSH_FAILED");
	expect(data.base).toBe(before);
	expect(data.phases).toEqual({
		candidate_sha: data.commit,
		actual_parents: [before],
		publication_ref: "refs/heads/main",
		construction: "APPLIED",
		publication: "NOT_APPLIED",
		local_catch_up: "APPLIED",
		observed_local_main: data.localMain,
		observed_publication_head: peerTip,
	});
	expect(git(work, ["merge-base", "--is-ancestor", data.commit, data.localMain]).length).toBe(0);
	expect(git(work, ["merge-base", "--is-ancestor", peerTip, data.localMain]).length).toBe(0);
	expect(remoteHead(work)).toBe(peerTip);
	expect(git(work, ["ls-files", "-s", "--", "peer.txt"])).toBe(stagedPeer);
	expect(git(work, ["diff", "--cached", "--name-status", "--", "peer.txt"])).toBe(stagedPeerDiff);
	expect(existsSync(join(work, "peer.txt"))).toBe(false);
	expect(readFileSync(join(work, "untouched.txt"))).toEqual(foreignWorktree);
	expect(git(work, ["diff", "--name-only", "--", "untouched.txt"]).trim()).toBe("untouched.txt");
	expect(readFileSync(attempts, "utf8").trim().split("\n")).toEqual(["attempt"]);

});
test("refuses publication when inherited hook attribution is ambiguous", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "owned save\n");
	writeFileSync(join(work, "peer.txt"), "nested hook save\n");
	const before = remoteHead(work);
	const hook = join(work, ".git", "hooks", "post-commit");
	writeFileSync(hook, '#!/bin/sh\nif [ "$PEER_LANDED" != 1 ]; then\n  PEER_LANDED=1 git commit --only -m "nested hook save [test]" -- peer.txt\nfi\n');
	chmodSync(hook, 0o755);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status).toBe(77);
	const data = run.body.data as { overall: string; commit: null; base: string };
	expect(data.overall).toBe("UNRUN");
	expect(data.commit).toBeNull();
	expect(data.base).toBe(before);
	expect(responseCode(run.body)).toBe("LAND_COMMIT_UNVERIFIED");
	expect(git(work, ["show", "HEAD:owned.txt"])).toBe("owned save\n");
	expect(remoteHead(work)).toBe(before);
});

test("reconstructs only caller-selected hunks onto fresh origin/main", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, bare, base, patch } = setup;
	const fresh = remoteHead(work);
	expect(fresh).not.toBe(base);
	// Without three-way reconstruction this exact specimen cannot land: the peer
	// advance shifted the caller hunk and changed its trailing context.
	const checker = join(scratch, `plain-check-${fixtureNumber}`);
	git(scratch, ["clone", "--branch", "main", bare, checker]);
	const plain = runFixture(["git", "apply", "--check", patch], { cwd: checker });
	expect(plain.rc).not.toBe(0);
	expect(fixtureDecoder.decode(plain.stderr)).toContain("service.txt");
	// The shared checkout stays stale with unrelated staged and worktree bytes.
	writeFileSync(join(work, "peer.txt"), "staged peer bytes\n");
	git(work, ["add", "peer.txt"]);
	writeFileSync(join(work, "untouched.txt"), "unstaged worktree bytes\n");
	const stagedOid = git(work, ["rev-parse", ":peer.txt"]).trim();
	const statusBefore = git(work, ["status", "--porcelain"]);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	const run = command(work, ["--patch", patch, "-m", "feat(land): selected hunks [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: { OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status).toBe(0);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string; paths: string[];
		base: string; localMain: string; check: { status: string; sha256: string; checked_sha: string; pushed_sha: string };
		convergence: { state: string; reason: string | null; applied: boolean; pushed: boolean; published_commits: number; remote_after: string };
		phases: { construction: string; publication: string; observed_publication_head: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(fresh);
	expect(data.localMain).toBe(base);
	expect([...data.paths].sort()).toEqual(["feature/added.txt", "service.txt"]);
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.commit);
	expect(data.check.pushed_sha).toBe(data.commit);
	expect(data.convergence.state).toBe("FAST_FORWARD");
	expect(data.convergence.reason).toBeNull();
	expect(data.convergence.applied).toBe(false);
	expect(data.convergence.pushed).toBe(true);
	expect(data.convergence.published_commits).toBe(1);
	expect(data.convergence.remote_after).toBe(data.commit);
	expect(data.phases.construction).toBe("APPLIED");
	expect(data.phases.publication).toBe("APPLIED");
	expect(data.phases.observed_publication_head).toBe(data.commit);
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(fresh);
	expect(remoteHead(work)).toBe(data.commit);
	expect(git(work, ["diff", "--name-only", fresh, data.commit]).trim().split("\n").sort()).toEqual(["feature/added.txt", "service.txt"]);
	expect(git(work, ["show", `${data.commit}:service.txt`])).toBe(EXPECTED_SERVICE);
	expect(git(work, ["show", `${data.commit}:feature/added.txt`])).toBe("caller added file\n");
	expect(readFileSync(setup.checkContent, "utf8")).toBe(EXPECTED_SERVICE);
	expect(readFileSync(setup.checkAdded, "utf8")).toBe("caller added file\n");
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["rev-parse", ":peer.txt"]).trim()).toBe(stagedOid);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("staged peer bytes\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("unstaged worktree bytes\n");
	expect(readFileSync(join(work, "service.txt"), "utf8")).toBe(SERVICE_BASE);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});
