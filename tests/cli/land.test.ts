// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fixtureDeadlineS, runFixture, runFixtureAsync } from "./fixture-process.ts";
import { EXPECTED_SERVICE, LAND_DEFAULT_TIMEOUT_MS, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, stringEnvironment, type HunkSetup } from "./private-index-land.helpers.ts";

import { disposalGate, type InspectDeps, type LivenessDeps, type OwnedScratchRow, type SeatIdentity } from "../../src/scratch.ts";
import { scratchOwedUnderRepo } from "../../src/land.ts";
import { createHash } from "node:crypto";

const LAND_RUN_FLOOR_MS = 60_000;
const HOOK_MARKER = "LANDPUSH1 pre-push hook started";
setDefaultTimeout(Math.max(LAND_DEFAULT_TIMEOUT_MS, Math.round(fixtureDeadlineS(90) * 1000)));

/** A pre-push hook that prints a marker, then sleeps a bounded time; its sleep holds no pipe of the land process. */
function sleepingPrePush(work: string, seconds: number): void {
	const hook = join(work, ".git", "hooks", "pre-push");
	writeFileSync(hook, `#!/bin/sh\nprintf '%s\\n' '${HOOK_MARKER}'\nsleep ${seconds} </dev/null >/dev/null 2>&1\nexit 0\n`);
	chmodSync(hook, 0o755);
}

/** deadlineS null leaves OMP_KIT_LAND_PUSH_DEADLINE_S unset, so land uses its measured default. */
function landPatch(deadlineS: number | null, runFloorMs = LAND_RUN_FLOOR_MS) {
	const setup = hunkSetup("none");
	return { setup, run: (hookSeconds: number) => {
		sleepingPrePush(setup.work, hookSeconds);
		return command(setup.work, ["--patch", setup.patch, "--message", "feat(land): slow pre-push [test]", "--apply", "--yes"], patchHold(), {
			amDir: setup.fakeBin,
			timeoutMs: runFloorMs,
			gitEnv: {
				OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent,
				OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded,
				OMP_KIT_LAND_PUSH_DEADLINE_S: deadlineS === null ? undefined : String(deadlineS),
			},
		});
	} };
}

function expectPublished(setup: HunkSetup, result: { status: number; body: Record<string, unknown> }): void {
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	const data = result.body.data as { candidate_sha?: string; pushed_sha?: string };
	expect(typeof data.candidate_sha).toBe("string");
	expect(data.pushed_sha).toBe(data.candidate_sha);
	expect(remoteHead(setup.work)).toBe(data.candidate_sha!);
	expect(remoteHead(setup.work)).not.toBe(setup.base);
}

for (const hookSeconds of [3, 0]) {
	test(`LANDGITDEADLINE1 pre-commit sleeping ${hookSeconds} s ${hookSeconds ? "reports the commit deadline" : "publishes within the commit deadline"}`, () => {
		const setup = hunkSetup("none");
		const hook = join(setup.work, ".git", "hooks", "pre-commit");
		writeFileSync(hook, `#!/bin/sh\nsleep ${hookSeconds}\n`);
		chmodSync(hook, 0o755);
		const result = command(setup.work, ["--patch", setup.patch, "--message", "feat(land): commit deadline [test]", "--apply", "--yes"], patchHold(), {
			amDir: setup.fakeBin,
			timeoutMs: LAND_RUN_FLOOR_MS,
			gitEnv: {
				OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent,
				OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded,
				OMP_KIT_LAND_COMMIT_DEADLINE_S: "1",
			},
		});
		if (hookSeconds === 0) {
			expectPublished(setup, result);
			return;
		}
		expect(result.status, JSON.stringify(result.body)).toBe(77);
		expect(responseCode(result.body)).toBe("LAND_COMMIT_TIMEOUT");
		const error = (result.body.errors as { message: string; remediation: string }[])[0]!;
		expect(error.message).toContain("1 s");
		expect(error.message).toContain("commit hooks may still be running");
		expect(error.remediation).toContain("git log -1");
		expect(error.remediation).toContain("reflog");
		expect(error.remediation).toContain("OMP_KIT_LAND_COMMIT_DEADLINE_S");
		expect(remoteHead(setup.work)).toBe(setup.base);
	});
}

test("LANDPUSH1 a 45 s pre-push hook publishes under the default push deadline, past the old 30 s git bound", () => {
	const { setup, run } = landPatch(null, 180_000);
	expectPublished(setup, run(45));
}, Math.round(fixtureDeadlineS(300) * 1000));

test("LANDPUSH1 a pre-push hook slower than the general git bound still publishes within an overridden push deadline", () => {
	const { setup, run } = landPatch(Math.min(7200, Math.ceil(fixtureDeadlineS(20))));
	expectPublished(setup, run(3));
});

test("LANDPUSH1 a pre-push hook past the push deadline reports LAND_PUBLICATION_UNVERIFIED naming the deadline and the hook log", () => {
	// Under load git can take seconds to reach the hook, so the deadline scales (6..24 s) and the hook,
	// which kitlib reaps at the deadline, sleeps well past it.
	const deadlineS = Math.ceil(fixtureDeadlineS(6));
	const { setup, run } = landPatch(deadlineS);
	const result = run(deadlineS * 3);
	expect(result.status, JSON.stringify(result.body)).toBe(77);
	expect(responseCode(result.body)).toBe("LAND_PUBLICATION_UNVERIFIED");
	const message = String((result.body.errors as { message?: string }[])[0]?.message);
	expect(message).toContain(`pre-push hook was still running after ${deadlineS} s`);
	expect(message).toContain("OMP_KIT_LAND_PUSH_DEADLINE_S");
	const log = /hook log: (\S+\.log);/.exec(message)?.[1];
	expect(log, message).toBeDefined();
	expect(log!.startsWith(join(git(setup.work, ["rev-parse", "--absolute-git-dir"]).trim(), "omp-kit", "land-push"))).toBe(true);
	expect(existsSync(log!)).toBe(true);
	expect(readFileSync(log!, "utf8")).toContain(HOOK_MARKER);
	expect(git(setup.work, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0]).toBe(setup.base);
});

/** Install the production shared-main pre-push member: a private-index candidate
 * push is refused, so only a publication from local main itself can pass. */
function installOnMainMember(work: string): void {
	writeFileSync(join(work, ".git", "hooks", "pre-push"),
		readFileSync(join(repoRoot, "scripts", "check-pushed-on-main.sh")), { mode: 0o755 });
}

test("LANDPATCH1 patch mode publishes the reconstructed commit from local main with the on-main member installed", () => {
	const setup = hunkSetup("shift");
	const { work, fakeBin, base, patch } = setup;
	installOnMainMember(work);
	const fresh = remoteHead(work);
	expect(fresh).not.toBe(base);
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
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as {
		overall: string; commit: string; candidate_sha: string; pushed_sha: string; owner: string; paths: string[];
		base: string; localMain: string; check: { status: string; checked_sha: string; pushed_sha: string };
		convergence: { state: string; reason: string | null; applied: boolean; pushed: boolean; published_commits: number; remote_after: string };
	};
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.base).toBe(fresh);
	expect(data.commit).toBe(data.candidate_sha);
	expect(data.pushed_sha).toBe(data.commit);
	expect(data.check.status).toBe("PASS");
	expect(data.check.checked_sha).toBe(data.commit);
	expect(data.check.pushed_sha).toBe(data.commit);
	expect(data.convergence.pushed).toBe(true);
	expect(data.convergence.remote_after).toBe(data.commit);
	// Local main and origin main agree on the published reconstruction.
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(data.commit);
	expect(data.localMain).toBe(data.commit);
	expect(remoteHead(work)).toBe(data.commit);
	expect(git(work, ["show", "-s", "--format=%P", data.commit]).trim()).toBe(fresh);
	expect(git(work, ["show", `${data.commit}:service.txt`])).toBe(EXPECTED_SERVICE);
	expect(git(work, ["show", `${data.commit}:feature/added.txt`])).toBe("caller added file\n");
	// Peer staged and uncommitted bytes on other paths survive exactly.
	expect(git(work, ["rev-parse", ":peer.txt"]).trim()).toBe(stagedOid);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("staged peer bytes\n");
	expect(readFileSync(join(work, "untouched.txt"), "utf8")).toBe("unstaged worktree bytes\n");
	expect(readFileSync(join(work, "service.txt"), "utf8")).toBe(EXPECTED_SERVICE);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("LANDPATCH1 a patch conflicting with a newer main commit is refused naming the path and nothing is pushed", () => {
	const setup = hunkSetup("conflict");
	const { work, fakeBin, base, patch } = setup;
	installOnMainMember(work);
	const originBefore = remoteHead(work);
	expect(originBefore).not.toBe(base);
	const refsBefore = git(work, ["for-each-ref", "refs/heads"]);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--patch", patch, "-m", "feat(land): conflicting selection [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(1);
	expect(responseCode(run.body)).toBe("PATCH_CONFLICT");
	const message = (run.body.errors as { message: string }[])[0]?.message ?? "";
	expect(message).toContain("service.txt");
	expect(remoteHead(work)).toBe(originBefore);
	expect(git(work, ["for-each-ref", "refs/heads"])).toBe(refsBefore);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
});

test("LANDPATCH1 a mid-materialization failure restores every patch path byte-identical", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, base, patch } = setup;
	// Paths land in diff order, so feature/added.txt materializes first: link
	// it (dangling, so only an lstat/readlink snapshot can bring it back) and
	// block service.txt with a non-empty directory so materialization throws
	// midway, after the first path was already written.
	const linkName = join(work, "feature", "added.txt");
	mkdirSync(join(work, "feature"), { recursive: true });
	symlinkSync("nowhere-target.txt", linkName);
	const blockedDir = join(work, "service.txt");
	rmSync(blockedDir);
	mkdirSync(blockedDir, { recursive: true });
	writeFileSync(join(blockedDir, "kept.txt"), "caller keeps this\n");
	const refsBefore = git(work, ["for-each-ref", "refs/heads"]);
	const run = command(work, ["--patch", patch, "-m", "feat(land): blocked materialization [test]", "--apply", "--yes"], patchHold(), { amDir: fakeBin });
	expect(run.status).toBe(77);
	expect(responseCode(run.body)).toBe("LAND_CONSTRUCTION_UNVERIFIED");
	const message = (run.body.errors as { message: string }[])[0]?.message ?? "";
	expect(message).toContain("service.txt");
	expectLandSchema(run.body.data);
	expect(run.body.data).toMatchObject({ overall: "UNRUN", commit: null });
	// The written path came back as the exact same dangling link (not a file,
	// not absent), the blocker dir is intact, and no reconstructed bytes
	// stranded anywhere.
	expect(lstatSync(linkName).isSymbolicLink()).toBe(true);
	expect(readlinkSync(linkName)).toBe("nowhere-target.txt");
	expect(lstatSync(blockedDir).isDirectory()).toBe(true);
	expect(readFileSync(join(blockedDir, "kept.txt"), "utf8")).toBe("caller keeps this\n");
	expect(remoteHead(work)).toBe(base);
	expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(base);
	expect(git(work, ["for-each-ref", "refs/heads"])).toBe(refsBefore);
});

// LANDPANETIMEOUT1 (ompkit-fp72.120.16.280): resolve-pane runs under a base deadline (30 s in production) scaled by
// load (src/land.ts), and a timeout is OWNER_RESOLVE_TIMEOUT instead of OWNER_UNKNOWN. The cases run scaled down
// together, keeping old fixed bound < planted delay < new base: 2 < 4 < 6 s by default. The release card's
// preregistered endpoint (12 s stub, old fixed 10 s bound, production 30 s base) is the same cases re-tuned:
// OMP_KIT_LAND_RESOLVE_BASE_S=30 OMP_KIT_LAND_STUB_DELAY_S=12 OMP_KIT_LAND_MUTANT_BOUND_S=10 bun test tests/cli/land.test.ts -t 'LANDPANETIMEOUT1 (planted|mutant)'
function tunedSeconds(name: string, fallback: number): number {
	const raw = process.env[name];
	const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer number of seconds, got ${raw}`);
	return value;
}
const RESOLVE_BASE_S = tunedSeconds("OMP_KIT_LAND_RESOLVE_BASE_S", 6);
const PLANTED_RESOLVE_SLEEP_S = tunedSeconds("OMP_KIT_LAND_STUB_DELAY_S", 4);
const OLD_FIXED_RESOLVE_TIMEOUT_S = tunedSeconds("OMP_KIT_LAND_MUTANT_BOUND_S", 2);

function expectBoundOrder(): void {
	expect(OLD_FIXED_RESOLVE_TIMEOUT_S).toBeLessThan(PLANTED_RESOLVE_SLEEP_S);
	expect(PLANTED_RESOLVE_SLEEP_S).toBeLessThan(RESOLVE_BASE_S);
}

/** An `am` whose resolve-pane answers DarkFern after `resolve` (a shell fragment) and reads no reservations. */
function stubAm(label: string, resolve: string): string {
	const dir = join(scratch, `${label}-${globalThis.fixtureNumber++}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "am"), `#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") ${resolve}; printf '{"agent_name":"DarkFern"}\\n' ;;
  "robot reservations") printf '{"my_reservations":[],"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}}\\n' ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(dir, "am"), 0o755);
	return dir;
}

/** One land run; the fixture's load-scaled floor_s deadline bounds it and throws TIMEOUT_UNDER_LOAD past it.
 * Async so the three LANDPANETIMEOUT1 cases overlap their waits (test.concurrent) inside the file budget. */
async function landWithAm(amDir: string, floorS: number, loadOverride?: string) {
	const { work } = fixture();
	const env = commandEnvironment(work, [], { amDir, gitEnv: { OMP_KIT_LAND_RESOLVE_BASE_S: String(RESOLVE_BASE_S), OMP_KIT_LOAD_OVERRIDE: loadOverride } });
	const run = await runFixtureAsync(["bun", cliPath, "land", ...landArgs("owned.txt"), "--json"], { cwd: work, env, floor_s: floorS });
	const body = JSON.parse(new TextDecoder().decode(run.stdout)) as Record<string, unknown>;
	return { body, code: responseCode(body), elapsedS: run.elapsed_s };
}

test.concurrent(`LANDPANETIMEOUT1 planted: a resolve-pane answering after ${PLANTED_RESOLVE_SLEEP_S} s resolves the owner under the ${RESOLVE_BASE_S} s scaled bound`, async () => {
	expectBoundOrder();
	const result = await landWithAm(stubAm("am-planted", `sleep ${PLANTED_RESOLVE_SLEEP_S}`), RESOLVE_BASE_S + 60);
	// Owner resolved: the next gate (no reservation held) refuses, not the owner gate.
	expect(result.code, JSON.stringify(result.body)).toBe("RESERVATION_REQUIRED");
	expect(result.elapsedS).toBeGreaterThanOrEqual(PLANTED_RESOLVE_SLEEP_S);
}, Math.round(fixtureDeadlineS(RESOLVE_BASE_S + 90) * 1000));

test.concurrent(`LANDPANETIMEOUT1 control: a resolve-pane that never answers is refused OWNER_RESOLVE_TIMEOUT at the ${RESOLVE_BASE_S} s bound`, async () => {
	expectBoundOrder();
	// Load pinned to factor 1, so the bound is the base; exec keeps the stub a single leader the deadline kills.
	// Bounded: the run must finish inside a fixture deadline of the base plus 30 s land overhead.
	const result = await landWithAm(stubAm("am-hung", "exec sleep 600"), RESOLVE_BASE_S + 30, "0/1");
	expect(result.code, JSON.stringify(result.body)).toBe("OWNER_RESOLVE_TIMEOUT");
	const message = String((result.body.errors as { message?: string }[])[0]?.message);
	expect(message).toContain(`within ${RESOLVE_BASE_S} s`);
	expect(result.elapsedS).toBeGreaterThanOrEqual(RESOLVE_BASE_S);
}, Math.round(fixtureDeadlineS(RESOLVE_BASE_S + 90) * 1000));

test.concurrent(`LANDPANETIMEOUT1 mutant: a fixed ${OLD_FIXED_RESOLVE_TIMEOUT_S} s timeout reads the planted ${PLANTED_RESOLVE_SLEEP_S} s answer as OWNER_UNKNOWN`, async () => {
	expectBoundOrder();
	const source = readFileSync(join(repoRoot, "src", "land.ts"), "utf8");
	const bound = "const deadlineS = Math.ceil(baseS * landLoadFactor());";
	const distinct = "if (identity.timed_out)\n";
	expect(source).toContain(bound);
	expect(source).toContain(distinct);
	// The pre-fix behaviour: a fixed bound whose timeout falls through to the rc check (OWNER_UNKNOWN).
	const mutant = source.replace(bound, `const deadlineS = ${OLD_FIXED_RESOLVE_TIMEOUT_S};`).replace(distinct, "if (false)\n")
		.replaceAll('from "./', `from "${join(repoRoot, "src")}/`).replaceAll('from "../', `from "${repoRoot}/`);
	const mutantPath = join(scratch, `land-resolve-mutant-${globalThis.fixtureNumber++}.ts`);
	writeFileSync(mutantPath, mutant);
	const { work } = fixture();
	const amDir = stubAm("am-mutant", `sleep ${PLANTED_RESOLVE_SLEEP_S}`);
	// The mutant module is generated at runtime, so the probe imports it dynamically.
	const probe = `const { resolvePaneOwner } = await import(${JSON.stringify(mutantPath)}); const r = resolvePaneOwner(process.cwd(), "%60"); console.log(JSON.stringify("error" in r ? r.error.errors[0].code : r.owner));`;
	const env = commandEnvironment(work, [], { amDir });
	const run = await runFixtureAsync(["bun", "-e", probe], { cwd: work, env, floor_s: PLANTED_RESOLVE_SLEEP_S + 30 });
	expect(run.rc, new TextDecoder().decode(run.stderr)).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(run.stdout))).toBe("OWNER_UNKNOWN");
	expect(run.elapsed_s).toBeGreaterThanOrEqual(OLD_FIXED_RESOLVE_TIMEOUT_S);
}, Math.round(fixtureDeadlineS(PLANTED_RESOLVE_SLEEP_S + 60) * 1000));

test("HANDOFFPUSHCHECK1 land with a GREEN push-check appends the ledger row for the landed commit; SKIP land appends none", () => {
	const checkBody = "#!/bin/bash\nset -eu\nexit 0\n";
	const expectedSha256 = createHash("sha256").update(checkBody).digest("hex");
	const green = fixture();
	registerPushCheck(green.work, checkBody);
	writeFileSync(join(green.work, "owned.txt"), "base owned\nowner change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(green.work, landArgs("owned.txt"), hold, { amDir: green.fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: string;
		check: { status: string; sha256: string; checked_sha: string } };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.check.status).toBe("PASS");
	expect(data.pushed_sha).toBe(data.commit);
	const ledger = join(git(green.work, ["rev-parse", "--absolute-git-dir"]).trim(), "omp-kit", "push-check-runs.jsonl");
	expect(existsSync(ledger)).toBe(true);
	const rows = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	expect(rows.length).toBe(1);
	const tree = git(green.work, ["rev-parse", "--verify", `${data.commit}^{tree}`]).trim();
	expect(rows[0]).toMatchObject({ version: 1, commit: data.commit, tree, check_sha256: expectedSha256, rc: 0 });
	expect(typeof rows[0].at).toBe("string");
	const skipped = fixture();
	writeFileSync(join(skipped.work, "owned.txt"), "base owned\nowner change\n");
	const skipRun = command(skipped.work, landArgs("owned.txt"), hold, { amDir: skipped.fakeBin });
	expect(skipRun.status, JSON.stringify(skipRun.body)).toBe(0);
	const skipData = skipRun.body.data as { overall: string; check: { status: string } };
	expect(skipData.overall).toBe("PUSHED");
	expect(skipData.check.status).toBe("SKIP");
	const skipLedger = join(git(skipped.work, ["rev-parse", "--absolute-git-dir"]).trim(), "omp-kit", "push-check-runs.jsonl");
	expect(existsSync(skipLedger)).toBe(false);
});

test("HANDOFFPUSHCHECK1 the push-check runs with its own owned TMPDIR, removed when the check ends", () => {
	// The check records the TMPDIR it saw only when it is a push-check-tmp dir that exists, else fails the land.
	const checkBody = "#!/bin/bash\nset -eu\ncase \"$TMPDIR\" in */push-check-tmp.*) ;; *) exit 3 ;; esac\ntest -d \"$TMPDIR\"\nprintf '%s' \"$TMPDIR\" > \"$OMP_LAND_REPOSITORY/.git/push-check-tmpdir\"\nexit 0\n";
	const f = fixture();
	registerPushCheck(f.work, checkBody);
	writeFileSync(join(f.work, "owned.txt"), "base owned\nowner change\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(f.work, landArgs("owned.txt"), hold, { amDir: f.fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; check: { status: string } };
	expect(data.check.status).toBe("PASS");
	expect(data.overall).toBe("PUSHED");
	const seen = readFileSync(join(f.work, ".git", "push-check-tmpdir"), "utf8");
	expect(seen).toContain("push-check-tmp.");
	expect(existsSync(seen)).toBe(false);
});

function writeFakeOvnfs(fakeBin: string): void {
	const script = [
		"#!/bin/sh",
		"case \"$1\" in",
		"  ls)",
		"    if [ \"$OVNFS_FAIL\" = \"ls\" ]; then printf 'ovnfs ls boom\\n' >&2; exit 1; fi",
		"    printf '%s' \"$OVNFS_LS_JSON\"",
		"    ;;",
		"  diff)",
		"    if [ \"$OVNFS_FAIL\" = \"diff\" ]; then printf 'ovnfs diff boom\\n' >&2; exit 1; fi",
		"    if [ -n \"$OVNFS_SLEEP_S\" ]; then sleep \"$OVNFS_SLEEP_S\"; fi",
		"    name=\"$2\"",
		"    if [ -f \"$OVNFS_DIFF_DIR/$name.json\" ]; then cat \"$OVNFS_DIFF_DIR/$name.json\"; else printf '{\"changes\":[]}'; fi",
		"    ;;",
		"  rm)",
		"    if [ \"$OVNFS_FAIL\" = \"rm\" ]; then printf 'ovnfs rm boom\\n' >&2; exit 1; fi",
		"    name=\"$2\"",
		"    printf '%s\\n' \"$name\" >> \"$OVNFS_RM_LOG\"",
		"    exit 0",
		"    ;;",
		"  *) exit 2 ;;",
		"esac",
		"",
	].join("\n");
	writeFileSync(join(fakeBin, "ovnfs"), script);
	chmodSync(join(fakeBin, "ovnfs"), 0o755);
}

function checkoutSetup(work: string, names: { name: string; files: Record<string, string>; diff: { path: string; status: string }[]; touched?: string }[]): { lsJson: string; diffDir: string; rmLog: string } {
	const repo = git(work, ["rev-parse", "--show-toplevel"]).trim();
	const rows = [];
	const diffDir = join(scratch, `co-diff-${globalThis.fixtureNumber++}`);
	mkdirSync(diffDir, { recursive: true });
	const rmLog = join(scratch, `co-rm-${globalThis.fixtureNumber++}.log`);
	writeFileSync(rmLog, "");
	for (const entry of names) {
		const coDir = join(scratch, `${entry.name}-${globalThis.fixtureNumber++}`);
		mkdirSync(coDir, { recursive: true });
		for (const [rel, content] of Object.entries(entry.files)) {
			const parts = rel.split("/");
			if (parts.length > 1) mkdirSync(join(coDir, ...parts.slice(0, -1)), { recursive: true });
			writeFileSync(join(coDir, rel), content);
		}
		rows.push({ name: entry.name, path: coDir, source: repo, dirty: true, created: new Date().toISOString(), touched: entry.touched ?? new Date().toISOString() });
		writeFileSync(join(diffDir, `${entry.name}.json`), JSON.stringify({ changes: entry.diff }));
	}
	return { lsJson: JSON.stringify({ checkouts: rows }), diffDir, rmLog };
}

function rmLogNames(rmLog: string): string[] {
	const text = readFileSync(rmLog, "utf8").trim();
	if (text.length === 0) return [];
	return text.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
}

function firstCheckoutPath(lsJson: string): string {
	const parsed: unknown = JSON.parse(lsJson);
	if (parsed === null || typeof parsed !== "object" || !("checkouts" in parsed)) throw new Error("bad lsJson");
	const checkouts: unknown = parsed.checkouts;
	if (!Array.isArray(checkouts) || checkouts.length === 0) throw new Error("bad lsJson checkouts");
	const first: unknown = checkouts[0];
	if (first === null || typeof first !== "object" || !("path" in first)) throw new Error("bad lsJson row");
	const path: unknown = first.path;
	if (typeof path !== "string" || path.length === 0) throw new Error("bad lsJson path");
	return path;
}

function ovnfsEnv(setup: { lsJson: string; diffDir: string; rmLog: string }, fail = "", sleepS = ""): Record<string, string> {
	return { OVNFS_LS_JSON: setup.lsJson, OVNFS_DIFF_DIR: setup.diffDir, OVNFS_RM_LOG: setup.rmLog, OVNFS_FAIL: fail, OVNFS_SLEEP_S: sleepS };
}

test("LANDREAPDEFAULT1 default without --checkout removes the unnamed fully-landed checkout", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-report", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; ovnfs: string; checkoutScan: string; checkoutsRemoved: string[]; checkoutsKept: unknown[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual(["co-report"]);
	expect(data.checkoutsKept).toEqual([]);
	expect(data.checkoutsMatching).toEqual(["co-report"]);
	expect(data.checkout_text).toContain("Removed ovnfs checkout");
	expect(data.checkout_text).toContain("co-report");
	expect(rmLogNames(setup.rmLog)).toEqual(["co-report"]);
});

test("LANDREAPDEFAULT1 default keeps the unnamed checkout with one extra unlanded change", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-extra", files: { "owned.txt": "base owned\nowner change\n", "extra.txt": "extra\n" }, diff: [{ path: "owned.txt", status: "M" }, { path: "extra.txt", status: "A" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.name).toBe("co-extra");
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["extra.txt"]);
	expect(data.checkoutsMatching).toEqual(["co-extra"]);
	expect(data.checkout_text).toContain("Kept co-extra");
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("LANDREAPDEFAULT1 --keep-checkout keeps both the fully-landed and the extra-change checkout", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-clean", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
		{ name: "co-extra", files: { "owned.txt": "base owned\nowner change\n", "extra.txt": "extra\n" }, diff: [{ path: "owned.txt", status: "M" }, { path: "extra.txt", status: "A" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--keep-checkout"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: unknown[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept).toEqual([]);
	expect(data.checkoutsMatching).toEqual([]);
	expect(data.checkout_text).toContain("--keep-checkout");
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("LANDREAPDEFAULT1 default removes an old fully-landed checkout regardless of touch age", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-old", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }], touched: "2020-01-01T00:00:00.000Z" },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual(["co-old"]);
	expect(data.checkoutsMatching).toEqual(["co-old"]);
	expect(data.checkout_text).toContain("co-old");
	expect(rmLogNames(setup.rmLog)).toEqual(["co-old"]);
});

test("LANDREAPDEFAULT1 late final deadline is TIMED_OUT with no rm", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-slow-recheck", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	// Each diff fits its own 2 s deadline; together the reads exceed the 2.5 s
	// total budget, so the final gate keeps the checkout and the scan is TIMED_OUT.
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup, "", "1.5") });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutScan: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[]; checkoutsMatching: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutScan).toBe("TIMED_OUT");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.name).toBe("co-slow-recheck");
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["<rm-timeout>"]);
	expect(data.checkoutsMatching).toEqual(["co-slow-recheck"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("LANDREAPDEFAULT1 planted: the report-only default is gone from the reaper", () => {
	const source = readFileSync(join(repoRoot, "src", "ovnfs-checkouts.ts"), "utf8");
	expect(source).not.toContain("not removed without --checkout");
	expect(source).toContain("judgeAndRemoveRow");
});

test("CHECKOUTRETAIN1 named --checkout removes the matching checkout", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-match", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-match"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; ovnfs: string; checkoutScan: string; checkoutsRemoved: string[]; checkoutsKept: unknown[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.ovnfs).toBe("present");
	expect(data.checkoutScan).toBe("OK");
	expect(data.checkoutsRemoved).toEqual(["co-match"]);
	expect(data.checkoutsMatching).toEqual(["co-match"]);
	expect(data.checkout_text).toContain("co-match");
	expect(rmLogNames(setup.rmLog)).toEqual(["co-match"]);
});

test("CHECKOUTRETAIN1 named checkout with an extra unapplied change is kept and named", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-extra", files: { "owned.txt": "base owned\nowner change\n", "extra.txt": "extra\n" }, diff: [{ path: "owned.txt", status: "M" }, { path: "extra.txt", status: "A" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-extra"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.name).toBe("co-extra");
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["extra.txt"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 named checkout whose bytes differ is kept", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-bytes", files: { "owned.txt": "different bytes\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-bytes"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["owned.txt"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 named checkout whose mode differs is kept", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-mode", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	const coDir = firstCheckoutPath(setup.lsJson);
	chmodSync(join(coDir, "owned.txt"), 0o755);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-mode"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["owned.txt"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 deleted file (D) removes the named checkout when both sides deleted", () => {
	const { work, fakeBin } = fixture();
	rmSync(join(work, "owned.txt"));
	const setup = checkoutSetup(work, [
		{ name: "co-del", files: {}, diff: [{ path: "owned.txt", status: "D" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-del"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual(["co-del"]);
	expect(rmLogNames(setup.rmLog)).toEqual(["co-del"]);
});

test("CHECKOUTRETAIN1 rename shape (R) is kept as unhandled", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-rename", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "R" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-rename"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["<unhandled-diff-shape>"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 typechange/symlink is kept", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-link", files: { "owned.txt": "placeholder\n" }, diff: [{ path: "owned.txt", status: "T" }] },
	]);
	const coDir = firstCheckoutPath(setup.lsJson);
	rmSync(join(coDir, "owned.txt"));
	symlinkSync("nowhere-target.txt", join(coDir, "owned.txt"));
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-link"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.name).toBe("co-link");
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 symlink dir escaping the checkout is kept", () => {
	const { work, fakeBin } = fixture();
	mkdirSync(join(work, "link"), { recursive: true });
	writeFileSync(join(work, "link", "inner.txt"), "escape probe\n");
	const setup = checkoutSetup(work, [
		{ name: "co-escape", files: {}, diff: [{ path: "link/inner.txt", status: "M" }] },
	]);
	const coDir = firstCheckoutPath(setup.lsJson);
	const outsideDir = join(scratch, `co-outside-${globalThis.fixtureNumber++}`);
	mkdirSync(outsideDir, { recursive: true });
	writeFileSync(join(outsideDir, "inner.txt"), "escape probe\n");
	symlinkSync(outsideDir, join(coDir, "link"));
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "link/inner.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("link/inner.txt"), "--checkout", "co-escape"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.name).toBe("co-escape");
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["<path-escapes-checkout>"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 diff failure keeps and land stays PUSHED", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-difffail", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-difffail"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup, "diff") });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 rm failure keeps and land stays PUSHED", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-rmfail", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-rmfail"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup, "rm") });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBe(1);
	expect(data.checkoutsKept[0]!.unappliedPaths).toEqual(["<rm-failed>"]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 garbage ls JSON leaves land PUSHED", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-garbage", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-garbage"], hold, {
		amDir: fakeBin,
		gitEnv: { OVNFS_LS_JSON: "not json{{{", OVNFS_DIFF_DIR: setup.diffDir, OVNFS_RM_LOG: setup.rmLog, OVNFS_FAIL: "", OVNFS_SLEEP_S: "" },
	});
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutScan: string; checkoutsRemoved: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutScan).toBe("UNAVAILABLE");
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 scan timeout is fail-open (TIMED_OUT, PUSHED)", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-slow-a", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
		{ name: "co-slow-b", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
		{ name: "co-slow-c", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
		{ name: "co-slow-d", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	// Each diff sleeps past the 2 s diff deadline, so every assessed row is kept
	// with <diff-unavailable> and the sweep stops at its budget: TIMED_OUT,
	// PUSHED, nothing removed. The kept count (1 or 2) depends on kill timing,
	// so only its shape is pinned.
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup, "", "3") });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutScan: string; checkoutsRemoved: string[]; checkoutsKept: { name: string; unappliedPaths: string[] }[]; checkoutsMatching: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutScan).toBe("TIMED_OUT");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsKept.length).toBeGreaterThanOrEqual(1);
	for (const kept of data.checkoutsKept) expect(kept.unappliedPaths).toEqual(["<diff-unavailable>"]);
	expect(data.checkoutsMatching).toEqual([]);
});

test("CHECKOUTRETAIN1 dry run removes nothing", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-dry", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): dry run [test]"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).not.toBe(0);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
	const data = run.body.data as { checkoutsRemoved?: string[] };
	expect(data.checkoutsRemoved ?? []).toEqual([]);
});

test("CHECKOUTRETAIN1 --keep-checkout leaves the named checkout in place", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-keep", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, [...landArgs("owned.txt"), "--checkout", "co-keep", "--keep-checkout"], hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutScan: string; checkoutsRemoved: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutScan).toBe("SKIPPED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(rmLogNames(setup.rmLog)).toEqual([]);
});

test("CHECKOUTRETAIN1 land --patch inside a checkout names it", () => {
	const setup = hunkSetup("none");
	const { work, fakeBin, patch } = setup;
	const repo = git(work, ["rev-parse", "--show-toplevel"]).trim();
	const coDir = join(scratch, `co-patch-${globalThis.fixtureNumber++}`);
	mkdirSync(coDir, { recursive: true });
	mkdirSync(join(coDir, "feature"), { recursive: true });
	writeFileSync(join(coDir, "service.txt"), readFileSync(join(setup.caller, "service.txt"), "utf8"));
	writeFileSync(join(coDir, "feature", "added.txt"), readFileSync(join(setup.caller, "feature", "added.txt"), "utf8"));
	const innerPatch = join(coDir, "change.patch");
	writeFileSync(innerPatch, readFileSync(patch));
	const diffDir = join(scratch, `co-diff-${globalThis.fixtureNumber++}`);
	mkdirSync(diffDir, { recursive: true });
	const rmLog = join(scratch, `co-rm-${globalThis.fixtureNumber++}.log`);
	writeFileSync(rmLog, "");
	const lsJson = JSON.stringify({ checkouts: [{ name: "co-patch", path: coDir, source: repo, dirty: true, created: new Date().toISOString(), touched: new Date().toISOString() }] });
	writeFileSync(join(diffDir, "co-patch.json"), JSON.stringify({ changes: [{ path: "service.txt", status: "M" }, { path: "feature/added.txt", status: "A" }] }));
	writeFakeOvnfs(fakeBin);
	const run = command(work, ["--patch", innerPatch, "-m", "feat(land): patch names checkout [test]", "--apply", "--yes"], patchHold(), {
		amDir: fakeBin,
		gitEnv: { OVNFS_LS_JSON: lsJson, OVNFS_DIFF_DIR: diffDir, OVNFS_RM_LOG: rmLog, OVNFS_FAIL: "", OVNFS_SLEEP_S: "", OMP_LAND_CHECK_CONTENT_FILE: setup.checkContent, OMP_LAND_CHECK_ADDED_FILE: setup.checkAdded },
	});
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutsRemoved: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual(["co-patch"]);
	expect(rmLogNames(rmLog)).toEqual(["co-patch"]);
});

// LANDFINDINGS1 (ompkit-1ra0d.141): a stale restore is refused before any
// commit exists, and a deliberate revert naming the restored commit lands.
/** Advance owned.txt past the fixture seed, then restore the superseded bytes in the worktree. */
function staleRestoreSetup(): { work: string; fakeBin: string; seed: string; base: string } {
	const { work, fakeBin } = fixture();
	const seed = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "newer bytes\n");
	git(work, ["add", "--", "owned.txt"]);
	git(work, ["commit", "-m", "newer owned bytes [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);
	expect(base).not.toBe(seed);
	writeFileSync(join(work, "owned.txt"), git(work, ["show", `${seed}:owned.txt`]));
	return { work, fakeBin, seed, base };
}

const staleRestoreHold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];

test("LANDFINDINGS1 a stale restore without a Revert trailer is refused with no commit on local main", () => {
	const { work, fakeBin, base } = staleRestoreSetup();
	const refsBefore = git(work, ["for-each-ref"]);
	const statusBefore = git(work, ["status", "--porcelain"]);
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): restore old bytes [test]", "--apply", "--yes"], staleRestoreHold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_STALE_RESTORE");
	const message = (run.body.errors as { message?: string }[])[0]?.message ?? "";
	expect(message).toContain("no candidate was committed");
	expectLandSchema(run.body.data);
	// A refusal before anything was committed carries no commit field at all.
	expect(run.body.data).toMatchObject({ overall: "REFUSED" });
	expect("commit" in (run.body.data as Record<string, unknown>)).toBe(false);
	// No reflog-only candidate: every ref is untouched, the index is
	// unchanged (no intent-to-add entries), and the worktree keeps the
	// attempted bytes.
	expect(git(work, ["for-each-ref"])).toBe(refsBefore);
	expect(git(work, ["status", "--porcelain"])).toBe(statusBefore);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(base);
	expect(remoteHead(work)).toBe(base);
	expect(readFileSync(join(work, "owned.txt"), "utf8")).toBe("base owned\n");
});

test("LANDFINDINGS1 a stale restore of an untracked path is refused without touching the index", () => {
	const { work, fakeBin } = fixture();
	const seed = remoteHead(work);
	git(work, ["rm", "--", "owned.txt"]);
	git(work, ["commit", "-m", "remove owned [test]"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	const base = remoteHead(work);
	expect(base).not.toBe(seed);
	// The removed bytes come back as a purely untracked file.
	writeFileSync(join(work, "owned.txt"), git(work, ["show", `${seed}:owned.txt`]));
	expect(git(work, ["status", "--porcelain"])).toBe("?? owned.txt\n");
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, ["--paths", "owned.txt", "--message", "feat(land): restore removed bytes [test]", "--apply", "--yes"], hold, { amDir: fakeBin });
	expect(run.status, JSON.stringify(run.body)).toBe(1);
	expect(responseCode(run.body)).toBe("LAND_STALE_RESTORE");
	expectLandSchema(run.body.data);
	expect(run.body.data).toMatchObject({ overall: "REFUSED" });
	expect("commit" in (run.body.data as Record<string, unknown>)).toBe(false);
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(base);
	expect(remoteHead(work)).toBe(base);
	// Still purely untracked: no intent-to-add entry was left behind.
	const status = git(work, ["status", "--porcelain"]);
	expect(status).toContain("?? owned.txt");
	expect(status.split("\n").filter((line) => line.startsWith(" A"))).toEqual([]);
});

test("LANDFINDINGS1 a deliberate revert with a Revert trailer lands through the verb", () => {
	const { work, fakeBin, seed } = staleRestoreSetup();
	const run = command(work, ["--paths", "owned.txt", "--message", `feat(land): revert owned bytes [test]\n\nRevert: ${seed}`, "--apply", "--yes"], staleRestoreHold, {
		amDir: fakeBin, timeoutMs: LAND_RUN_FLOOR_MS,
	});
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; commit: string; candidate_sha: string; pushed_sha: string; base: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(typeof data.candidate_sha).toBe("string");
	expect(data.pushed_sha).toBe(data.candidate_sha);
	expect(remoteHead(work)).toBe(data.candidate_sha);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("base owned\n");
	// A subject line that merely mentions reverting is not a trailer: it still refuses without committing.
	writeFileSync(join(work, "owned.txt"), "newer bytes\n");
	const refused = command(work, ["--paths", "owned.txt", "--message", `feat(land): revert owned bytes to ${seed} [test]`, "--apply", "--yes"], staleRestoreHold, { amDir: fakeBin });
	expect(refused.status, JSON.stringify(refused.body)).toBe(1);
	expect(responseCode(refused.body)).toBe("LAND_STALE_RESTORE");
	expect(refused.body.data).toMatchObject({ overall: "REFUSED" });
	expect("commit" in (refused.body.data as Record<string, unknown>)).toBe(false);
});

test("LANDFINDINGS1 a deliberate rewrite with a Supersedes line lands through the verb", () => {
	const { work, fakeBin, seed } = staleRestoreSetup();
	const run = command(work, ["--paths", "owned.txt", "--message", `feat(land): rewrite owned bytes [test]\n\nSupersedes: ${seed}`, "--apply", "--yes"], staleRestoreHold, {
		amDir: fakeBin, timeoutMs: LAND_RUN_FLOOR_MS,
	});
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; candidate_sha: string; pushed_sha: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.pushed_sha).toBe(data.candidate_sha);
	expect(remoteHead(work)).toBe(data.candidate_sha);
	expect(git(work, ["show", `${data.candidate_sha}:owned.txt`])).toBe("base owned\n");
});

test("LANDFINDINGS1-scratch publication ignores unreleased scratch under another checkout of the same repository", () => {
	const n = globalThis.fixtureNumber++;
	const landingRepo = join(scratch, `landf-landing-${n}`);
	const otherRepo = join(scratch, `landf-other-${n}`);
	const landingRoot = join(landingRepo, "var", "agent-tmp");
	const otherRoot = join(otherRepo, "var", "agent-tmp");
	const landingOwed = join(landingRoot, "work.61001");
	const otherOwed = join(otherRoot, "work.61002");
	for (const dir of [landingOwed, otherOwed]) mkdirSync(dir, { recursive: true });
	const agent = "LandSeat";
	const session = "01a156d7-e2c8-732e-abf4-e0333e62902b";
	const ownerText = (pid: number, repo: string) =>
		`pid=${pid}\nprocess_start=Mon Oct  5 13:27:00 2026\nlabel=work\nrepo=${repo}\ncreated_at=2026-10-20T05:00:00Z\nargv0=test\nagent=${agent}\nsession=${session}\n`;
	writeFileSync(join(landingOwed, ".owner"), ownerText(61001, landingRepo));
	writeFileSync(join(otherOwed, ".owner"), ownerText(61002, otherRepo));
	// No such pid: the probe reports every owner dead.
	const liveness: LivenessDeps = { signalAlive: () => false, psVisible: () => false, processStart: () => null,
		probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) };
	const callerSeat = (): SeatIdentity => ({ agent, sessions: [session], main: session });
	const deps: InspectDeps = { liveness, run: () => ({ code: 1, stdout: "", stderr: "" }), now: Date.parse("2026-11-11T00:00:00Z"), callerSeat };
	const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
	const savedState = process.env.XDG_STATE_HOME;
	const home = join(scratch, `landf-home-${n}`);
	mkdirSync(join(home, "state"), { recursive: true });
	process.env.OMP_KIT_SCRATCH_ROOTS = [landingRoot, otherRoot].join(delimiter);
	process.env.XDG_STATE_HOME = join(home, "state");
	try {
		// The raw census charges both checkouts: unscoped, the other checkout's dir would be judged too.
		const gate = disposalGate(home, "push", deps);
		expect(gate.unproven).toBe(false);
		expect(gate.decision).toBe("refuse");
		expect(gate.owed.map((row) => row.dir).sort()).toEqual([landingOwed, otherOwed].sort());
		// Publication scopes to the landing repo: the other checkout's dir is never its notice.
		const scoped = scratchOwedUnderRepo(gate.owed, landingRepo);
		expect(scoped.map((row) => row.dir)).toEqual([landingOwed]);
		expect(scratchOwedUnderRepo(gate.owed, otherRepo).map((row) => row.dir)).toEqual([otherOwed]);
		const rows: OwnedScratchRow[] = gate.owed;
		expect(scratchOwedUnderRepo(rows, join(scratch, `landf-missing-${n}`))).toEqual([]);
	} finally {
		if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
		if (savedState === undefined) delete process.env.XDG_STATE_HOME;
		else process.env.XDG_STATE_HOME = savedState;
	}
});

/** LANDSIBLING1 (ompkit-1ra0d.218.2): a fake ovnfs that models `new --name N --rev R` as a full copy of the calling
 * repository (hooks, config and refs included, as the real checkout carries them) detached at R, and `rm N`. */
function writeExactParentOvnfs(fakeBin: string): void {
	const script = [
		"#!/bin/sh",
		'printf "%s\\n" "$*" >> "$OVNFS_CALL_LOG"',
		'case "$1" in',
		"  new)",
		'    shift; name=""; rev=""',
		'    while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift 2 ;; --rev) rev="$2"; shift 2 ;; *) shift ;; esac; done',
		'    dest="$OVNFS_COPY_ROOT/$name"',
		'    if [ -e "$dest" ]; then printf "checkout %s exists\\n" "$name" >&2; exit 1; fi',
		'    cp -R "$PWD" "$dest" || exit 1',
		'    git -C "$dest" checkout -q --detach "$rev" || exit 1',
		'    printf "%s\\n" "$dest" ;;',
		"  rm)",
		'    rm -rf "$OVNFS_COPY_ROOT/$2" ;;',
		"  *) exit 2 ;;",
		"esac",
		"",
	].join("\n");
	writeFileSync(join(fakeBin, "ovnfs"), script);
	chmodSync(join(fakeBin, "ovnfs"), 0o755);
}

const PLANTED_SECRET = "PLANTED_SECRET_TOKEN";

/** The production on-main member plus a pre-push secret scan of exactly the range git is about to push. */
function installOnMainAndRangeScan(work: string): void {
	const hooks = join(work, ".git", "hooks");
	writeFileSync(join(hooks, "pre-push-on-main"), readFileSync(join(repoRoot, "scripts", "check-pushed-on-main.sh")), { mode: 0o755 });
	writeFileSync(join(hooks, "pre-push"), [
		"#!/bin/sh",
		'input=$(cat)',
		'printf "%s\\n" "$input" | sh "$(dirname "$0")/pre-push-on-main" || exit $?',
		'printf "%s\\n" "$input" | while read -r lref lsha rref rsha; do',
		'  case "$lsha" in *[!0]*) ;; *) continue ;; esac',
		'  range="$lsha"; case "$rsha" in *[!0]*) range="$rsha..$lsha" ;; esac',
		`  if git log -p --format= "$range" | grep -q ${PLANTED_SECRET}; then printf 'range-scan: REFUSED planted secret in %s\\n' "$range" >&2; exit 5; fi`,
		"done",
		"",
	].join("\n"), { mode: 0o755 });
}

type ExactParentSetup = { work: string; fakeBin: string; bare: string; base: string; reviewed: string; held: string[]; calls: string; copyRoot: string; env: Record<string, string>; hold: unknown[] };

/** The companion's scripts/fresh-gate.sh stand-in: logs its arguments when asked, then runs `body` ($2 is the candidate). */
function writeExactParentGate(work: string, body: string, log: string | null = null): void {
	mkdirSync(join(work, "scripts"), { recursive: true });
	const record = log === null ? "" : `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`;
	writeFileSync(join(work, "scripts", "fresh-gate.sh"), `#!/bin/sh\n${record}${body}\n`);
}

/** Local main holds two unpushed commits; the reviewed commit is built directly on the origin tip on a side branch. */
function exactParentSetup(secretIn: "reviewed" | "held" | null = null, baseGate: string | null = null): ExactParentSetup {
	const { work, fakeBin } = fixture();
	installOnMainAndRangeScan(work);
	writeExactParentGate(work, `printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	writeExactParentOvnfs(fakeBin);
	if (baseGate === null) {
		// Default: the parent ships no gate of its own (the fixture seed's real one is removed and pushed), so land falls back to
		// the working tree's stand-in written above.
		git(work, ["rm", "-qf", "--ignore-unmatch", "--", "scripts/fresh-gate.sh"]);
		git(work, ["commit", "--allow-empty", "-m", "feat(gate): the parent ships no gate [test]"]);
		git(work, ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:refs/heads/main"]);
		writeExactParentGate(work, `printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	} else {
		// LANDGATE2: the parent ships its own gate (committed and pushed); a test may then leave a different copy in the working tree.
		writeExactParentGate(work, baseGate);
		git(work, ["add", "--", "scripts/fresh-gate.sh"]);
		git(work, ["commit", "-m", "feat(gate): the parent's own gate [test]"]);
		git(work, ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:refs/heads/main"]);
	}
	const bare = git(work, ["remote", "get-url", "origin"]).trim();
	const base = remoteHead(work);
	const id = globalThis.fixtureNumber++;
	const copyRoot = join(scratch, `exact-parent-co-${id}`);
	mkdirSync(copyRoot, { recursive: true });
	const calls = join(scratch, `exact-parent-calls-${id}.log`);
	writeFileSync(calls, "");
	git(work, ["switch", "-q", "-c", "reviewed"]);
	writeFileSync(join(work, "reviewed.txt"), secretIn === "reviewed" ? `${PLANTED_SECRET}=reviewed\n` : "reviewed bytes\n");
	git(work, ["add", "--", "reviewed.txt"]);
	git(work, ["commit", "-m", "feat(land): reviewed exact-parent commit [test]"]);
	const reviewed = git(work, ["rev-parse", "HEAD"]).trim();
	git(work, ["switch", "-q", "main"]);
	const held: string[] = [];
	for (const n of [1, 2]) {
		writeFileSync(join(work, `held-${n}.txt`), secretIn === "held" && n === 1 ? `${PLANTED_SECRET}=held\n` : `held ${n}\n`);
		git(work, ["add", "--", `held-${n}.txt`]);
		git(work, ["commit", "-m", `held ${n} [test]`]);
		held.push(git(work, ["rev-parse", "HEAD"]).trim());
	}
	return {
		work, fakeBin, bare, base, reviewed, held, calls, copyRoot,
		env: { OVNFS_CALL_LOG: calls, OVNFS_COPY_ROOT: copyRoot },
		hold: [{ agent: "DarkFern", path: "reviewed.txt", exclusive: true, remaining_seconds: 3600 }],
	};
}

function exactParentRun(setup: ExactParentSetup, sha: string) {
	return command(setup.work, ["--exact-parent", sha, "--apply", "--yes"], setup.hold, { amDir: setup.fakeBin, gitEnv: setup.env });
}

function expectUnpublished(setup: ExactParentSetup, sha: string): void {
	expect(() => git(setup.bare, ["cat-file", "-e", `${sha}^{commit}`])).toThrow();
}

test("LANDSIBLING1 exact-parent publishes the reviewed commit while local main keeps two unpushed commits", () => {
	const setup = exactParentSetup();
	const mainBefore = git(setup.work, ["rev-parse", "main"]).trim();
	expect(mainBefore).toBe(setup.held[1]!);
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	expectLandSchema(run.body.data);
	const data = run.body.data as {
		overall: string; candidate_sha: string; pushed_sha: string; base: string; paths: string[];
		exact_parent: { candidate: string; base: string; checkout: string; checkout_removed: boolean };
		local_reconcile: { state: string; applied: boolean };
	};
	expect(data.overall).toBe("PUSHED");
	expect(data.pushed_sha).toBe(setup.reviewed);
	expect(data.base).toBe(setup.base);
	expect(data.paths).toEqual(["reviewed.txt"]);
	expect(remoteHead(setup.work)).toBe(setup.reviewed);
	expect(git(setup.bare, ["rev-parse", "refs/heads/main"]).trim()).toBe(setup.reviewed);
	// The held commits never left this machine and stay on local main, unchanged and unpublished.
	for (const held of setup.held) {
		expectUnpublished(setup, held);
		git(setup.work, ["merge-base", "--is-ancestor", held, "main"]);
	}
	// Local main now also holds the published commit, by a merge that leaves the held commits where they were.
	git(setup.work, ["merge-base", "--is-ancestor", setup.reviewed, "main"]);
	expect(data.local_reconcile).toMatchObject({ state: "MERGED", applied: true });
	const unpublished = git(setup.work, ["rev-list", "origin/main..main"]).trim().split("\n");
	expect(unpublished).toEqual(expect.arrayContaining(setup.held));
	// The private checkout was created for exactly this commit and removed afterwards.
	const name = `exact-parent-${setup.reviewed.slice(0, 12)}`;
	expect(data.exact_parent).toEqual({ candidate: setup.reviewed, base: setup.base, checkout: name, checkout_removed: true });
	expect(readFileSync(setup.calls, "utf8").trim().split("\n")).toEqual([`new --name ${name} --rev ${setup.reviewed}`, `rm ${name}`]);
	expect(existsSync(join(setup.copyRoot, name))).toBe(false);
});

test("LANDSIBLING1 exact-parent refuses a commit whose parent is not the remote tip and creates nothing", () => {
	const setup = exactParentSetup();
	// A peer advances origin after the reviewed commit was built, so its parent is no longer the tip.
	const peer = join(scratch, `exact-parent-peer-${globalThis.fixtureNumber++}`);
	git(scratch, ["clone", "--no-hardlinks", "--branch", "main", setup.bare, peer]);
	git(peer, ["config", "user.name", "peer"]);
	git(peer, ["config", "user.email", "peer@example.invalid"]);
	writeFileSync(join(peer, "peer-advance.txt"), "peer advance\n");
	git(peer, ["add", "--", "peer-advance.txt"]);
	git(peer, ["commit", "-m", "peer advance [test]"]);
	git(peer, ["push", "origin", "HEAD:refs/heads/main"]);
	const tip = remoteHead(setup.work);
	expect(tip).not.toBe(setup.base);
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).not.toBe(0);
	expect(responseCode(run.body)).toBe("LAND_EXACT_PARENT_NOT_TIP");
	expect((run.body.data as { overall: string }).overall).toBe("REFUSED");
	expect(remoteHead(setup.work)).toBe(tip);
	expectUnpublished(setup, setup.reviewed);
	expect(readFileSync(setup.calls, "utf8")).toBe("");
	expect(git(setup.work, ["rev-parse", "main"]).trim()).toBe(setup.held[1]!);
});

test("LANDSIBLING1 exact-parent refuses flags that would change the published commit and an unknown commit", () => {
	const setup = exactParentSetup();
	const withMessage = command(setup.work, ["--exact-parent", setup.reviewed, "--message", "feat(land): other [test]", "--apply", "--yes"], setup.hold, { amDir: setup.fakeBin, gitEnv: setup.env });
	expect(responseCode(withMessage.body)).toBe("LAND_EXACT_PARENT_EXCLUSIVE");
	const unknown = exactParentRun(setup, "0".repeat(40));
	expect(responseCode(unknown.body)).toBe("LAND_EXACT_PARENT_UNKNOWN");
	expect(remoteHead(setup.work)).toBe(setup.base);
	expect(readFileSync(setup.calls, "utf8")).toBe("");
});

test("LANDSIBLING1 exact-parent runs scripts/fresh-gate.sh on the exact candidate first: RED refuses and creates nothing, GREEN publishes", () => {
	const setup = exactParentSetup();
	const gateLog = join(scratch, `exact-parent-gate-${globalThis.fixtureNumber++}.log`);
	const writeGate = (body: string) => writeExactParentGate(setup.work, body, gateLog);
	// Planted negative: the repository's gate is RED for the candidate (exit 1), so nothing is created or published.
	writeGate(`printf 'FRESH-GATE: RED: affected tests did not pass (exit 1); the push is refused\\n'\nexit 1`);
	const red = exactParentRun(setup, setup.reviewed);
	expect(red.status, JSON.stringify(red.body)).not.toBe(0);
	expect(responseCode(red.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(JSON.stringify(red.body)).toContain("did not pass scripts/fresh-gate.sh: FRESH-GATE: RED: affected tests did not pass");
	expect((red.body.data as { overall: string }).overall).toBe("REFUSED");
	expect(remoteHead(setup.work)).toBe(setup.base);
	expectUnpublished(setup, setup.reviewed);
	expect(readFileSync(setup.calls, "utf8")).toBe("");
	expect(git(setup.work, ["rev-parse", "main"]).trim()).toBe(setup.held[1]!);
	// A GREEN line for another commit, or GREEN text with a non-zero exit, is not a pass either.
	writeGate(`printf 'FRESH-GATE: GREEN commit=%s\\n' "${"0".repeat(40)}"`);
	expect(responseCode(exactParentRun(setup, setup.reviewed).body)).toBe("LAND_PUBLICATION_REFUSED");
	writeGate(`printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"\nexit 1`);
	expect(responseCode(exactParentRun(setup, setup.reviewed).body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(remoteHead(setup.work)).toBe(setup.base);
	// Control: the gate reads GREEN for exactly the candidate, so land publishes it.
	writeGate(`printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	const green = exactParentRun(setup, setup.reviewed);
	expect(green.status, JSON.stringify(green.body)).toBe(0);
	expect((green.body.data as { overall: string }).overall).toBe("PUSHED");
	expect(remoteHead(setup.work)).toBe(setup.reviewed);
	// The gate ran on the exact sha (arguments: --commit SHA) every time.
	for (const line of readFileSync(gateLog, "utf8").trim().split("\n")) expect(line).toBe(`--commit ${setup.reviewed}`);
});

test("LANDSIBLING1 exact-parent refuses a candidate whose gate outlives its deadline before creating the checkout or pushing", () => {
	const setup = exactParentSetup();
	// The stand-in gate sleeps far past the 2 s deadline; the push never starts because the gate never answered GREEN.
	writeExactParentGate(setup.work, `sleep 60\nprintf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	const hung = command(setup.work, ["--exact-parent", setup.reviewed, "--apply", "--yes"], setup.hold, { amDir: setup.fakeBin, gitEnv: { ...setup.env, OMP_KIT_LAND_EXACT_GATE_DEADLINE_S: "2" } });
	expect(hung.status, JSON.stringify(hung.body)).not.toBe(0);
	expect(responseCode(hung.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(JSON.stringify(hung.body)).toContain("timed out after 2 s");
	expect(remoteHead(setup.work)).toBe(setup.base);
	expectUnpublished(setup, setup.reviewed);
	expect(readFileSync(setup.calls, "utf8")).toBe("");
});

// LANDGATE2: the candidate is judged by the PARENT's committed gate, exported, never by the canonical working tree's copy
// (a stale checkout with peers' uncommitted hunks lacked the staged members and let two commits reach main RED).
test("LANDGATE2 exact-parent: a RED parent gate refuses although the working-tree copy is permissive, and nothing is created or published", () => {
	const setup = exactParentSetup(null, `printf 'FRESH-GATE: RED: planted parent gate\\n'\nexit 1`);
	// The working tree now holds a permissive copy: before LANDGATE2 this alone decided the verdict.
	writeExactParentGate(setup.work, `printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).not.toBe(0);
	expect(responseCode(run.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(JSON.stringify(run.body)).toContain("planted parent gate");
	expect(remoteHead(setup.work)).toBe(setup.base);
	expectUnpublished(setup, setup.reviewed);
	expect(readFileSync(setup.calls, "utf8")).toBe("");
	expect(readdirSync(join(setup.work, "var", "agent-tmp")).filter(name => name.startsWith("land-parent-gate."))).toEqual([]);
});

test("LANDGATE2 exact-parent: a GREEN parent gate publishes over a RED working-tree copy, runs from an owned export and sees the repository through FRESH_GATE_REPO", () => {
	const log = join(scratch, `parent-gate-${globalThis.fixtureNumber++}.log`);
	const setup = exactParentSetup(null, `printf 'repo=%s cwd=%s\\n' "$FRESH_GATE_REPO" "$(pwd)" >> ${JSON.stringify(log)}\nprintf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	writeExactParentGate(setup.work, `printf 'FRESH-GATE: RED: the working-tree copy must not run\\n'\nexit 1`);
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	expect(remoteHead(setup.work)).toBe(setup.reviewed);
	const [seen] = readFileSync(log, "utf8").trim().split("\n");
	const match = /^repo=(.+) cwd=(.+)$/.exec(seen ?? "");
	expect(match, seen).not.toBeNull();
	expect(realpathSync(match![1]!)).toBe(realpathSync(setup.work));
	// The gate ran from an export under the repository's owned scratch (physical path, as `pwd` prints it), not from the working tree.
	expect(match![2]!.startsWith(`${realpathSync(join(setup.work, "var", "agent-tmp"))}/land-parent-gate.`), match![2]).toBe(true);
	expect(readdirSync(join(setup.work, "var", "agent-tmp")).filter(name => name.startsWith("land-parent-gate."))).toEqual([]);
});

test("LANDGATE2 exact-parent: only the parent's GREEN for exactly the candidate publishes; another sha, GREEN with a non-zero exit and UNQUALIFIED are refusals, a hung gate times out", () => {
	const refusals: [string, string][] = [
		["a GREEN line for another commit", `printf 'FRESH-GATE: GREEN commit=%s\\n' "${"0".repeat(40)}"`],
		["GREEN text with a non-zero exit", `printf 'FRESH-GATE: GREEN commit=%s\\n' "$2"\nexit 1`],
		["UNQUALIFIED", `printf 'FRESH-GATE: UNQUALIFIED: still outside the qualification envelope\\n' >&2\nexit 76`],
	];
	for (const [label, body] of refusals) {
		const setup = exactParentSetup(null, body);
		const run = exactParentRun(setup, setup.reviewed);
		expect(responseCode(run.body), label).toBe("LAND_PUBLICATION_REFUSED");
		expect(remoteHead(setup.work), label).toBe(setup.base);
		expectUnpublished(setup, setup.reviewed);
	}
	const slow = exactParentSetup(null, `sleep 60\nprintf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	const hung = command(slow.work, ["--exact-parent", slow.reviewed, "--apply", "--yes"], slow.hold, { amDir: slow.fakeBin, gitEnv: { ...slow.env, OMP_KIT_LAND_EXACT_GATE_DEADLINE_S: "2" } });
	expect(responseCode(hung.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(JSON.stringify(hung.body)).toContain("timed out after 2 s");
	expect(remoteHead(slow.work)).toBe(slow.base);
	// The parent's gate gets the quiet-window budget: the 2400 s default deadline less 600 s for the runs themselves.
	const waitFile = join(scratch, `parent-gate-quiet-${globalThis.fixtureNumber++}.txt`);
	const quiet = exactParentSetup(null, `printf '%s' "\${FRESH_GATE_QUIET_WAIT_S:-unset}" >'${waitFile}'\nprintf 'FRESH-GATE: GREEN commit=%s\\n' "$2"`);
	expect(exactParentRun(quiet, quiet.reviewed).status).toBe(0);
	expect(readFileSync(waitFile, "utf8")).toBe("1800");
});

test("LANDSIBLING1 exact-parent gives the gate its quiet-window budget and refuses an UNQUALIFIED verdict like any non-GREEN", () => {
	const setup = exactParentSetup();
	const waitFile = join(scratch, `exact-parent-quiet-${globalThis.fixtureNumber++}.txt`);
	// The stand-in gate reports the budget it was given and ends UNQUALIFIED (exit 76): neither RED nor GREEN, so land refuses.
	writeExactParentGate(setup.work, `printf '%s' "\${FRESH_GATE_QUIET_WAIT_S:-unset}" >'${waitFile}'\nprintf 'FRESH-GATE: UNQUALIFIED: still outside the qualification envelope\\n' >&2\nexit 76`);
	const held = exactParentRun(setup, setup.reviewed);
	expect(held.status, JSON.stringify(held.body)).not.toBe(0);
	expect(responseCode(held.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(JSON.stringify(held.body)).toContain("FRESH-GATE: UNQUALIFIED");
	expect(readFileSync(waitFile, "utf8")).toBe("1800"); // the 2400 s default deadline less 600 s for the runs themselves
	expect(remoteHead(setup.work)).toBe(setup.base);
	expectUnpublished(setup, setup.reviewed);
	// A deadline too short to leave room for a rerun turns the wait off instead of going negative.
	const short = command(setup.work, ["--exact-parent", setup.reviewed, "--apply", "--yes"], setup.hold, { amDir: setup.fakeBin, gitEnv: { ...setup.env, OMP_KIT_LAND_EXACT_GATE_DEADLINE_S: "300" } });
	expect(responseCode(short.body)).toBe("LAND_PUBLICATION_REFUSED");
	expect(readFileSync(waitFile, "utf8")).toBe("0");
});

test("LANDSIBLING1 pushed-range secret scan refuses a planted secret in the published commit and publishes nothing", () => {
	const setup = exactParentSetup("reviewed");
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).not.toBe(0);
	expect((run.body.data as { overall: string }).overall).not.toBe("PUSHED");
	expect(remoteHead(setup.work)).toBe(setup.base);
	expectUnpublished(setup, setup.reviewed);
	// Refused publication leaves local main exactly as it was and removes the private checkout it made.
	expect(git(setup.work, ["rev-parse", "main"]).trim()).toBe(setup.held[1]!);
	const name = `exact-parent-${setup.reviewed.slice(0, 12)}`;
	expect(existsSync(join(setup.copyRoot, name))).toBe(false);
	expect(readFileSync(setup.calls, "utf8").trim().split("\n")).toEqual([`new --name ${name} --rev ${setup.reviewed}`, `rm ${name}`]);
});

test("LANDSIBLING1 pushed-range secret scan judges exactly the published commit, not a secret held in an unpushed commit", () => {
	const setup = exactParentSetup("held");
	// Control: pushing local main itself would carry the held secret and the scan refuses it.
	expect(() => git(setup.work, ["push", "origin", "main"])).toThrow(/planted secret/);
	expect(remoteHead(setup.work)).toBe(setup.base);
	const run = exactParentRun(setup, setup.reviewed);
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	expect(remoteHead(setup.work)).toBe(setup.reviewed);
	expectUnpublished(setup, setup.held[0]!);
	git(setup.work, ["merge-base", "--is-ancestor", setup.held[0]!, "main"]);
});

/** GITLOCK1 two-land rig: a pre-commit hook whose first arrival holds the
 * commit (and the wrapper's flock with it) until the test writes `release`,
 * so the second land provably queues behind the first. Whichever land reaches
 * the hook first holds; assertions match lands by path, never by start order. */
function gitlockTwoLandSetup(): { work: string; fakeBin: string; seed: string; barrier: string } {
	const { work, fakeBin } = fixture();
	const seed = remoteHead(work);
	writeFileSync(join(work, "owned.txt"), "gitlock owned bytes\n");
	writeFileSync(join(work, "peer.txt"), "gitlock peer bytes\n");
	const barrier = join(work, "gitlock-barrier");
	mkdirSync(barrier);
	const waitS = Math.ceil(fixtureDeadlineS(300));
	writeFileSync(join(work, ".git", "hooks", "pre-commit"),
		`#!/bin/sh\nB="${barrier}"\nif mkdir "$B/claimed" 2>/dev/null; then\n: > "$B/arrived"\nEND=$(( $(date +%s) + ${waitS} ))\nwhile [ ! -e "$B/release" ] && [ "$(date +%s)" -lt "$END" ]; do sleep 1; done\nexit 0\nfi\nexit 0\n`);
	chmodSync(join(work, ".git", "hooks", "pre-commit"), 0o755);
	return { work, fakeBin, seed, barrier };
}

function gitlockEnv(work: string, fakeBin: string, path: string, extra?: Record<string, string>): Record<string, string> {
	const holds = [{ agent: "DarkFern", path, exclusive: true, remaining_seconds: 3600 }];
	return stringEnvironment(commandEnvironment(work, holds, { amDir: fakeBin, gitEnv: extra }));
}

function gitlockArgv(path: string, message: string): string[] {
	return ["bun", cliPath, "land", "--paths", path, "--message", message, "--apply", "--yes", "--json"];
}

/** Live wrapper processes for this run's two lands, matched by the per-run queue timeout in their argv. */
function gitlockWrappersAlive(work: string, timeoutTag: string): number {
	const found = runFixture(["pgrep", "-f", `kit-commit.py.*--flock-timeout ${timeoutTag}`], { cwd: work, floor_s: 10 });
	if (found.rc !== 0) return 0;
	return new TextDecoder().decode(found.stdout).trim().split("\n").filter((line) => line.trim().length > 0).length;
}

async function gitlockPoll(seen: () => boolean, timeoutMs: number): Promise<boolean> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		if (seen()) return true;
		if (Date.now() >= until) return false;
		// Poll step on the platform clock: hook files and live wrapper
		// processes appear only there, so fake timers cannot advance them.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	}
}

function parseLandResponse(finished: { rc: number | null; stdout: Uint8Array }): { status: number; body: Record<string, unknown> } {
	const body = JSON.parse(new TextDecoder().decode(finished.stdout)) as Record<string, unknown>;
	return { status: finished.rc === null || finished.rc < 0 ? 1 : finished.rc, body };
}

test("GITLOCK1 two concurrent lands serialize on the commit lock without index-lock errors", async () => {
	const { work, fakeBin, barrier } = gitlockTwoLandSetup();
	const ownedMessage = "feat(land): gitlock owned [test]\n\nBead: gitlock-fixture";
	const peerMessage = "feat(land): gitlock peer [test]\n\nBead: gitlock-fixture";
	const queueTimeout = String(200 + (process.pid % 700));
	const ownedP = runFixtureAsync(gitlockArgv("owned.txt", ownedMessage), { cwd: work, env: gitlockEnv(work, fakeBin, "owned.txt", { OMP_KIT_LAND_COMMIT_FLOCK_TIMEOUT_S: queueTimeout }), floor_s: 300 });
	const peerP = runFixtureAsync(gitlockArgv("peer.txt", peerMessage), { cwd: work, env: gitlockEnv(work, fakeBin, "peer.txt", { OMP_KIT_LAND_COMMIT_FLOCK_TIMEOUT_S: queueTimeout }), floor_s: 300 });
	expect(await gitlockPoll(() => existsSync(join(barrier, "arrived")), Math.round(fixtureDeadlineS(60) * 1000))).toBe(true);
	// Both wrappers are alive while the holder still waits for release:
	// the second land reached the serializer and necessarily queued.
	expect(await gitlockPoll(() => gitlockWrappersAlive(work, queueTimeout) >= 2, Math.round(fixtureDeadlineS(60) * 1000))).toBe(true);
	// Grace after both wrappers are observed alive: a live wrapper still
	// runs imports and rev-parse before its first flock attempt, and that
	// prefix exists only on the platform clock.
	const { promise: grace, resolve: releaseGrace } = Promise.withResolvers<void>();
	setTimeout(releaseGrace, Math.round(fixtureDeadlineS(5) * 1000));
	await grace;
	writeFileSync(join(barrier, "release"), "go\n");
	const [ownedRun, peerRun] = await Promise.all([ownedP, peerP]);
	expect(ownedRun.timed_out).toBe(false);
	expect(peerRun.timed_out).toBe(false);
	const owned = parseLandResponse(ownedRun);
	const peer = parseLandResponse(peerRun);
	expect(JSON.stringify(owned.body)).not.toContain("index.lock");
	expect(JSON.stringify(peer.body)).not.toContain("index.lock");
	// Exactly one land published; the queuer committed through the serializer
	// but its parent had moved, so it carries a clean mismatch refusal naming
	// the saved candidate instead of a lock collision.
	const outcomes = [
		{ name: "owned", run: owned, message: ownedMessage, path: "owned.txt" },
		{ name: "peer", run: peer, message: peerMessage, path: "peer.txt" },
	];
	const pushed = outcomes.filter(({ run: outcome }) => outcome.status === 0);
	const refused = outcomes.filter(({ run: outcome }) => outcome.status !== 0);
	expect(pushed).toHaveLength(1);
	expect(refused).toHaveLength(1);
	expectLandSchema(pushed[0]!.run.body.data);
	expect((pushed[0]!.run.body.data as { overall: string }).overall).toBe("PUSHED");
	expect(responseCode(refused[0]!.run.body)).toBe("LAND_ACTUAL_PARENT_MISMATCH");
	const saved = refused[0]!.run.body.data as { commit: string; candidate_sha: string };
	expect(typeof saved.candidate_sha).toBe("string");
	expect(git(work, ["rev-parse", "refs/heads/main"]).trim()).toBe(saved.candidate_sha);
	// Both commits stacked on shared main in order with every peer byte
	// intact: the queuer's save sits directly atop the published commit, so
	// the serializer queued the two contenders instead of colliding them.
	const names = git(work, ["log", "--format=%s", "-n", "2"]).trim().split("\n");
	expect(names).toEqual([refused[0]!.message.split("\n")[0], pushed[0]!.message.split("\n")[0]]);
	const tip = git(work, ["rev-parse", "HEAD"]).trim();
	expect(git(work, ["show", `${tip}:owned.txt`])).toBe("gitlock owned bytes\n");
	expect(git(work, ["show", `${tip}:peer.txt`])).toBe("gitlock peer bytes\n");
}, Math.round(fixtureDeadlineS(600) * 1000));

test("GITLOCK1 a queued land past its flock timeout refuses naming the wait and commits nothing", async () => {
	const { work, fakeBin, seed, barrier } = gitlockTwoLandSetup();
	const holderP = runFixtureAsync(gitlockArgv("owned.txt", "feat(land): gitlock owned [test]"),
		{ cwd: work, env: gitlockEnv(work, fakeBin, "owned.txt"), floor_s: 300 });
	holderP.then(() => {}, () => {});
	expect(await gitlockPoll(() => existsSync(join(barrier, "arrived")), Math.round(fixtureDeadlineS(60) * 1000))).toBe(true);
	// The holder is inside its commit, so this land cannot reach its own:
	// with a short queue bound it refuses naming the wait instead of
	// publishing around the serializer. The refusal proves the attempt
	// landed inside the hold, so no process poll is needed before releasing.
	const refusedRun = await runFixtureAsync(gitlockArgv("peer.txt", "feat(land): gitlock peer [test]"),
		{ cwd: work, env: gitlockEnv(work, fakeBin, "peer.txt", { OMP_KIT_LAND_COMMIT_FLOCK_TIMEOUT_S: "8" }), floor_s: 180 });
	expect(refusedRun.timed_out).toBe(false);
	const refused = parseLandResponse(refusedRun);
	expect(refused.status, JSON.stringify(refused.body)).toBe(1);
	expect(responseCode(refused.body)).toBe("COMMIT_CREATION_REFUSED");
	expectLandSchema(refused.body.data);
	expect(String((refused.body.errors as { message?: string }[])[0]?.message)).toContain("timed out");
	writeFileSync(join(barrier, "release"), "go\n");
	// Nothing was committed for the refused path: the holder's bytes are the
	// only new commit, the refused bytes stay in the worktree, and the remote
	// has not moved yet.
	expect(git(work, ["log", "--format=%s"]).trim().split("\n")).not.toContain("feat(land): gitlock peer [test]");
	expect(remoteHead(work)).toBe(seed);
	expect(readFileSync(join(work, "peer.txt"), "utf8")).toBe("gitlock peer bytes\n");
	const holder = parseLandResponse(await holderP);
	expect(holder.status, JSON.stringify(holder.body)).toBe(0);
	expect((holder.body.data as { overall: string }).overall).toBe("PUSHED");
}, Math.round(fixtureDeadlineS(600) * 1000));
