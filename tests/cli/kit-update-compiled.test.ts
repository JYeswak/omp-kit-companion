import { afterAll, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { assertJourneyWorkload, copyReleaseSource, JOURNEY_WORKLOAD, journeyWorkload, MINIMAL_SCENARIOS,
	runCompiledUpdateJourney, scratch } from "./kit-update-fixture.ts";

afterAll(() => cleanupAllOwnedTmp());
test("KITUPDATELOAD1: a journey candidate carrying the full tree fails the workload bound; the minimal candidate passes", async () => {
	const owned = ownedTmp("kit-update-workload", { root: scratch });
	try {
		const repoRoot = realpathSync(resolve(import.meta.dir, "../.."));
		const full = join(owned.path, "full"), minimal = join(owned.path, "minimal");
		// Planted: the full tree, as the journeys packaged it before KITUPDATELOAD1. The bound counts rows, not time.
		await copyReleaseSource(repoRoot, full);
		expect(journeyWorkload(full).ruleScenarioRows).toBeGreaterThan(JOURNEY_WORKLOAD.ruleScenarioRows);
		expect(() => assertJourneyWorkload(full)).toThrow(/KITUPDATELOAD1: journey candidate exceeds its workload bound/);
		await copyReleaseSource(repoRoot, minimal, { minimal: true });
		expect(() => assertJourneyWorkload(minimal)).not.toThrow();
		expect(journeyWorkload(minimal)).toEqual(JOURNEY_WORKLOAD);
		const scenarios = JSON.parse(readFileSync(join(minimal, "tests", "live", "scenarios.json"), "utf8")) as { id: string }[];
		expect(scenarios.map(row => row.id)).toEqual([...MINIMAL_SCENARIOS]);
	} finally { owned.cleanup(); }
}, fixtureDeadlineS(120) * 1000);
test("compiled synthetic predecessor authenticates, activates, and leaves unavailable postcheck pending",
 () => runCompiledUpdateJourney("success"), 900_000);
