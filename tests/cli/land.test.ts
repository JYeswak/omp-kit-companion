// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { EXPECTED_SERVICE, LAND_DEFAULT_TIMEOUT_MS, cliPath, command, commandEnvironment, expectLandSchema, fixture, git, hunkSetup, landArgs, patchHold, registerPushCheck, remoteHead, repoRoot, responseCode, scratch, type HunkSetup } from "./private-index-land.helpers.ts";
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
		.replaceAll('from "./', `from "${join(repoRoot, "src")}/`);
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

function checkoutSetup(work: string, names: { name: string; files: Record<string, string>; diff: { path: string; status: string }[] }[]): { lsJson: string; diffDir: string; rmLog: string } {
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
		rows.push({ name: entry.name, path: coDir, source: repo, dirty: true, created: new Date().toISOString(), touched: new Date().toISOString() });
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

test("CHECKOUTRETAIN1 report-only without --checkout reports the match and removes nothing", () => {
	const { work, fakeBin } = fixture();
	writeFileSync(join(work, "owned.txt"), "base owned\nowner change\n");
	const setup = checkoutSetup(work, [
		{ name: "co-report", files: { "owned.txt": "base owned\nowner change\n" }, diff: [{ path: "owned.txt", status: "M" }] },
	]);
	writeFakeOvnfs(fakeBin);
	const hold = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup) });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; ovnfs: string; checkoutScan: string; checkoutsRemoved: string[]; checkoutsMatching: string[]; checkout_text: string };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutsRemoved).toEqual([]);
	expect(data.checkoutsMatching).toEqual(["co-report"]);
	expect(data.checkout_text).toContain("ovnfs rm co-report");
	expect(rmLogNames(setup.rmLog)).toEqual([]);
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
	const run = command(work, landArgs("owned.txt"), hold, { amDir: fakeBin, gitEnv: ovnfsEnv(setup, "", "1") });
	expect(run.status, JSON.stringify(run.body)).toBe(0);
	const data = run.body.data as { overall: string; checkoutScan: string; checkoutsRemoved: string[] };
	expectLandSchema(run.body.data);
	expect(data.overall).toBe("PUSHED");
	expect(data.checkoutScan).toBe("TIMED_OUT");
	expect(data.checkoutsRemoved).toEqual([]);
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
