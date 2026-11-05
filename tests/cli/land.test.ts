// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { LAND_DEFAULT_TIMEOUT_MS, cliPath, command, commandEnvironment, fixture, git, hunkSetup, landArgs, patchHold, remoteHead, repoRoot, responseCode, scratch, type HunkSetup } from "./private-index-land.helpers.ts";

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
