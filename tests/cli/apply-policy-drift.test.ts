// Coverage: src/apply-policy.ts, src/cli.ts, src/paths.ts, src/omp-source-cache.ts, tests/cli/profile-fixture.ts
import { afterEach, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPolicyPlan, planPolicy } from "../../src/apply-policy.ts";
import { cleanupPolicyFixtures, fixture, nativeTest, nativeConfigValue, policyValues, seedProfile, setNativeValue } from "./apply-policy.helpers.ts";
afterEach(cleanupPolicyFixtures);

nativeTest("native drift introduced after planning makes apply refuse without overwriting it", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	setNativeValue(f.home, f.project, "work", "ttsr.repeatGap", 3);
	const driftedBefore = readFileSync(configPath);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.enabled")).toBe(false);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.repeatGap")).toBe(3);
	expect(existsSync(f.input.stateRoot)).toBe(false);
	expect(readFileSync(configPath)).toEqual(driftedBefore);
});

