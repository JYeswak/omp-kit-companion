// Affected-test source dependencies retained across the land-3 shards:
// src/kitlib/run.ts src/land.ts scripts/pysafe.py
// scripts/suite-hermetic-env.sh scripts/kitlib_tmp.py
// scripts/check-stale-worktree.sh scripts/kitlib-tmp.sh
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { run as kitlibRun } from "../../src/kitlib/run.ts";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { qualifyPublicationCandidate, resolvePushCheckExecutable } from "../../src/land.ts";
import {
	EXPECTED_SERVICE, SERVICE_BASE, actualParentSetup, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, verdictPath, writeServiceLines, LAND_DEFAULT_TIMEOUT_MS,
} from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);
// GATESPEED1: land defers the complete suite to the release by default; these cases assert the
// inline suite's refusals, so this file opts in for every land command it runs.
process.env.PRE_PUSH_FULL_SUITE = "push";

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

test("a candidate that replaces an unrunnable registered check lands with the check skipped as hash_changed", () => {
	// The repair of a broken check (here an interpreter that cannot run) must be landable; the case above
	// keeps an unchanged broken check refusing.
	const { work, fakeBin } = fixture();
	const brokenSha = registerPushCheck(work, "#!/not/a/real/land-check-runner\nexit 0\n");
	const repairedBody = "#!/bin/bash\nexit 0\n";
	writeFileSync(join(work, ".omp", "push-check"), repairedBody, { mode: 0o755 });
	const hold = [{ agent: "DarkFern", path: ".omp/push-check", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs(".omp/push-check"), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; commit: string; check: { status: string; reason: string; sha256: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("SKIP");
	expect(data.check.reason).toBe("hash_changed");
	expect(data.check.sha256).toBe(brokenSha);
	expect(remoteHead(work)).toBe(data.commit);
	expect(git(work, ["show", `${data.commit}:.omp/push-check`])).toBe(repairedBody);
});

test("PUSHCHECKSH1 a dash-like check runs without a --version probe and records version unknown", () => {
	// Debian/Ubuntu /bin/sh is dash, which rejects --version (rc 2). The old
	// interpreter rule probed `<interpreter> --version` and left every #!/bin/sh
	// check UNRUN there, and it rejected #!/usr/bin/env outright. The fake
	// interpreter below is executable but refuses --version exactly like dash,
	// so the old rule refuses this land while the direct-exec rule lands it PASS.
	const { work, fakeBin } = fixture();
	writeFileSync(join(fakeBin, "mydash"), "#!/bin/bash\nif [ \"$1\" = \"--version\" ]; then printf 'Illegal option --\\n' >&2; exit 2; fi\nexec /bin/bash \"$@\"\n", { mode: 0o755 });
	chmodSync(join(fakeBin, "mydash"), 0o755);
	const checkBody = "#!/usr/bin/env mydash\nexit 0\n";
	const checkSha = registerPushCheck(work, checkBody);
	writeFileSync(join(work, "owned.txt"), "candidate under a dash-like check\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as {
		overall: string;
		commit: string;
		check: { status: string; sha256: string; selected_executable: string; selected_version: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("PASS");
	expect(data.check.sha256).toBe(checkSha);
	expect(data.check.selected_executable).toBe(realpathSync(join(fakeBin, "mydash")));
	expect(data.check.selected_version).toBe("unknown");
	expect(remoteHead(work)).toBe(data.commit);
	// The portable header itself resolves on this machine and needs no probe.
	expect(resolvePushCheckExecutable(work, Buffer.from("#!/bin/sh\nexit 0\n", "utf8"), checkSha)).toEqual({
		executable: realpathSync("/bin/sh"),
		version: "unknown",
	});
	// A missing interpreter still refuses instead of running.
	expect(resolvePushCheckExecutable(work, Buffer.from("#!/not/a/real/land-check-runner\nexit 0\n", "utf8"), checkSha)).toEqual({
		reason: "check_interpreter_unavailable",
	});
});

