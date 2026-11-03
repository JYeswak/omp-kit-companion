// Coverage: src/apply-policy.ts, src/cli.ts, src/paths.ts, src/omp-source-cache.ts, tests/cli/profile-fixture.ts
import { afterAll, afterEach, expect } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { applyPolicyPlan, planPolicy } from "../../src/apply-policy.ts";
import { cleanupCompiledFixture, cleanupPolicyFixtures, compiledFixture, fixture, nativeTest, nativeTestEnv, nativeConfigValue, policyValues, seedProfile } from "./apply-policy.helpers.ts";
import { runSync } from "../../src/kitlib/run.ts";
afterEach(cleanupPolicyFixtures);
afterAll(cleanupCompiledFixture);
nativeTest("compiled apply policy --plan names the disagreeing file on SOURCE_INVALID", async () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const kit = join(f.workspace, "kit"), good = join(kit, "releases", "v1"), bad = join(kit, "releases", "v2");
	for (const release of [good, bad]) {
		mkdirSync(join(release, "bin"), { recursive: true });
		for (const directory of ["rules", "retired", "policy"]) cpSync(join(f.root, directory), join(release, directory), { recursive: true });
		cpSync(join(f.root, "MANIFEST.tsv"), join(release, "MANIFEST.tsv"));
	}
	writeFileSync(join(bad, "rules", "managed.md"), "tampered after release\n");
	const build = async (release: string) => {
		const binary = join(release, "bin", "omp-kit");
		const compiled = await compiledFixture(binary, f.workspace);
		expect(compiled.exitCode, compiled.stdout.toString() + compiled.stderr.toString()).toBe(0);
		return binary;
	};
	const goodBin = await build(good), badBin = await build(bad);
	const run = (binary: string) => {
		const child = runSync([binary, "apply", "policy", "--plan", "--json"], { cwd: f.project,
			env: { ...nativeTestEnv(f.home) }, deadline_s: 120 });
		const stdout = Buffer.from(child.stdout).toString();
		return { exitCode: child.rc, output: stdout + Buffer.from(child.stderr).toString(), envelope: JSON.parse(stdout) };
	};
	const control = run(goodBin);
	expect(control.exitCode, control.output).toBe(0);
	expect(control.envelope.data.action).toBe("PLAN");
	const refused = run(badBin);
	expect(refused.exitCode).toBe(2);
	expect(refused.envelope.errors[0].code).toBe("SOURCE_INVALID");
	expect(refused.envelope.errors[0].message).toContain("managed");
	expect(refused.envelope.data.cause_code).toBe("SOURCE_INVALID");
	expect(String(refused.envelope.data.cause_message)).toContain("managed");
});
nativeTest("disabled profile rules are never re-enabled and non-TTSR policy keys are refused", () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, disabledRules: ["managed"] });
	const blocked = planPolicy({ ...f.input, profiles: ["work"] });
	expect(blocked.blockedProfiles).toEqual([{ profile: "work", names: ["managed"] }]);
	expect(() => applyPolicyPlan(blocked, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.disabledRules")).toEqual(["managed"]);
	writeFileSync(join(f.root, "policy", "ttsr.json"), JSON.stringify({ ...policyValues, model: "forbidden" }));
	expect(() => planPolicy({ ...f.input, profiles: ["work"] })).toThrow(/INVALID_POLICY/);
});
nativeTest("profile config edit after planning refuses without overwriting it", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	writeFileSync(configPath, YAML.stringify({ model: "operator-updated", ttsr: { ...policyValues, enabled: false } }));
	const external = readFileSync(configPath);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(readFileSync(configPath)).toEqual(external);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});
