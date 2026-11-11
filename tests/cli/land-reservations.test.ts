// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { LAND_DEFAULT_TIMEOUT_MS, cliPath, commandEnvironment, fixture, landArgs, repoRoot, responseCode, scratch } from "./private-index-land.helpers.ts";

setDefaultTimeout(Math.max(LAND_DEFAULT_TIMEOUT_MS, Math.round(fixtureDeadlineS(90) * 1000)));

// LANDRESVTIMEOUT1 (ompkit-fp72.120.16.282): `am robot reservations` shares resolve-pane's load-scaled bound
// (src/land.ts runAmBounded, 30 s base in production), and a timeout is RESERVATION_TIMEOUT instead of
// RESERVATION_UNAVAILABLE. Its own file because tests/cli/land.test.ts is at its 90 s per-file budget. The cases
// run scaled down together, keeping old fixed bound < planted delay < new base: 2 < 4 < 6 s by default. The
// preregistered endpoint (12 s stub, old fixed 10 s bound, production 30 s base) is the same cases re-tuned:
// OMP_KIT_LAND_RESOLVE_BASE_S=30 OMP_KIT_LAND_STUB_DELAY_S=12 OMP_KIT_LAND_MUTANT_BOUND_S=10 bun test tests/cli/land-reservations.test.ts -t 'LANDRESVTIMEOUT1 (planted|mutant)'
function tunedSeconds(name: string, fallback: number): number {
	const raw = process.env[name];
	const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer number of seconds, got ${raw}`);
	return value;
}
const RESOLVE_BASE_S = tunedSeconds("OMP_KIT_LAND_RESOLVE_BASE_S", 6);
const PLANTED_RESERVATIONS_SLEEP_S = tunedSeconds("OMP_KIT_LAND_STUB_DELAY_S", 4);
const OLD_FIXED_RESERVATIONS_TIMEOUT_S = tunedSeconds("OMP_KIT_LAND_MUTANT_BOUND_S", 2);

function expectBoundOrder(): void {
	expect(OLD_FIXED_RESERVATIONS_TIMEOUT_S).toBeLessThan(PLANTED_RESERVATIONS_SLEEP_S);
	expect(PLANTED_RESERVATIONS_SLEEP_S).toBeLessThan(RESOLVE_BASE_S);
}

/** An `am` whose resolve-pane answers DarkFern at once and whose robot reservations answers no reservations
 * after `reserve` (a shell fragment). */
function stubAm(label: string, reserve: string): string {
	const dir = join(scratch, `${label}-${globalThis.fixtureNumber++}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "am"), `#!/bin/sh
case "$1 $2" in
  "agents resolve-pane") printf '{"agent_name":"DarkFern"}\\n' ;;
  "robot reservations") ${reserve}; printf '{"my_reservations":[],"reservation_read_attestation":{"state":"current","database_matches_server":true,"storage_root_matches_server":true}}\\n' ;;
  *) exit 2 ;;
esac
`);
	chmodSync(join(dir, "am"), 0o755);
	return dir;
}

/** One land run; the fixture's load-scaled floor_s deadline bounds it and throws TIMEOUT_UNDER_LOAD past it.
 * Async so the three cases overlap their waits (test.concurrent). */
async function landWithAm(amDir: string, floorS: number, loadOverride?: string) {
	const { work } = fixture();
	const env = commandEnvironment(work, [], { amDir, gitEnv: { OMP_KIT_LAND_RESOLVE_BASE_S: String(RESOLVE_BASE_S), OMP_KIT_LOAD_OVERRIDE: loadOverride } });
	const run = await runFixtureAsync(["bun", cliPath, "land", ...landArgs("owned.txt"), "--json"], { cwd: work, env, floor_s: floorS });
	const body = JSON.parse(new TextDecoder().decode(run.stdout)) as Record<string, unknown>;
	return { body, code: responseCode(body), elapsedS: run.elapsed_s };
}

test.concurrent(`LANDRESVTIMEOUT1 planted: robot reservations answering after ${PLANTED_RESERVATIONS_SLEEP_S} s is read under the ${RESOLVE_BASE_S} s scaled bound`, async () => {
	expectBoundOrder();
	const result = await landWithAm(stubAm("am-resv-planted", `sleep ${PLANTED_RESERVATIONS_SLEEP_S}`), RESOLVE_BASE_S + 60);
	// Reservations read: the held-path gate (none held) refuses, not the read.
	expect(result.code, JSON.stringify(result.body)).toBe("RESERVATION_REQUIRED");
	expect(result.elapsedS).toBeGreaterThanOrEqual(PLANTED_RESERVATIONS_SLEEP_S);
}, Math.round(fixtureDeadlineS(RESOLVE_BASE_S + 90) * 1000));

test.concurrent(`LANDRESVTIMEOUT1 control: robot reservations that never answers is refused RESERVATION_TIMEOUT at the ${RESOLVE_BASE_S} s bound`, async () => {
	expectBoundOrder();
	// Load pinned to factor 1, so the bound is the base; exec keeps the stub a single leader the deadline kills.
	const result = await landWithAm(stubAm("am-resv-hung", "exec sleep 600"), RESOLVE_BASE_S + 30, "0/1");
	expect(result.code, JSON.stringify(result.body)).toBe("RESERVATION_TIMEOUT");
	const message = String((result.body.errors as { message?: string }[])[0]?.message);
	expect(message).toContain(`within ${RESOLVE_BASE_S} s`);
	expect(result.elapsedS).toBeGreaterThanOrEqual(RESOLVE_BASE_S);
}, Math.round(fixtureDeadlineS(RESOLVE_BASE_S + 90) * 1000));

test.concurrent(`LANDRESVTIMEOUT1 mutant: a fixed ${OLD_FIXED_RESERVATIONS_TIMEOUT_S} s timeout reads the planted ${PLANTED_RESERVATIONS_SLEEP_S} s reservations answer as RESERVATION_UNAVAILABLE`, async () => {
	expectBoundOrder();
	const source = readFileSync(join(repoRoot, "src", "land.ts"), "utf8");
	const bound = "const deadlineS = Math.ceil(baseS * landLoadFactor());";
	const distinct = "if (active.timed_out)\n";
	expect(source).toContain(bound);
	expect(source).toContain(distinct);
	// The pre-fix behaviour: a fixed bound whose timeout falls through to the rc check (RESERVATION_UNAVAILABLE).
	const mutant = source.replace(bound, `const deadlineS = ${OLD_FIXED_RESERVATIONS_TIMEOUT_S};`).replace(distinct, "if (false)\n")
		.replaceAll('from "./', `from "${join(repoRoot, "src")}/`).replaceAll('from "../', `from "${repoRoot}/`);
	const mutantPath = join(scratch, `land-resv-mutant-${globalThis.fixtureNumber++}.ts`);
	writeFileSync(mutantPath, mutant);
	const { work } = fixture();
	const amDir = stubAm("am-resv-mutant", `sleep ${PLANTED_RESERVATIONS_SLEEP_S}`);
	// The mutant module is generated at runtime, so the probe imports it dynamically.
	const probe = `const { readActiveReservations } = await import(${JSON.stringify(mutantPath)}); const r = readActiveReservations(process.cwd(), "DarkFern"); console.log(JSON.stringify("error" in r ? r.error.errors[0].code : r.rows.length));`;
	const env = commandEnvironment(work, [], { amDir });
	const run = await runFixtureAsync(["bun", "-e", probe], { cwd: work, env, floor_s: PLANTED_RESERVATIONS_SLEEP_S + 30 });
	expect(run.rc, new TextDecoder().decode(run.stderr)).toBe(0);
	expect(JSON.parse(new TextDecoder().decode(run.stdout))).toBe("RESERVATION_UNAVAILABLE");
	expect(run.elapsed_s).toBeGreaterThanOrEqual(OLD_FIXED_RESERVATIONS_TIMEOUT_S);
}, Math.round(fixtureDeadlineS(PLANTED_RESERVATIONS_SLEEP_S + 60) * 1000));
