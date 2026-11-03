// Coverage: src/apply-policy.ts, src/cli.ts, src/paths.ts, src/omp-source-cache.ts, tests/cli/profile-fixture.ts
import { afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { planPolicy } from "../../src/apply-policy.ts";
import { writeProfileConfig } from "./profile-fixture.ts";
import { cleanupPolicyFixtures, fixture, nativeTest, nativeTestEnv, nativeConfigValue, policyValues, seedProfile, setNativeValue } from "./apply-policy.helpers.ts";
import { runSync } from "../../src/kitlib/run.ts";
afterEach(cleanupPolicyFixtures);
nativeTest("doctor settings reads native per-profile values and reports drift plus unsafe profiles", () => {
	const f = fixture();
	const defaultPath = seedProfile(f.home, "default", policyValues);
	const defaultBefore = readFileSync(defaultPath);
	const workPath = seedProfile(f.home, "work", policyValues);
	setNativeValue(f.home, f.project, "work", "ttsr.enabled", false);
	const workBefore = readFileSync(workPath);
	const unsafePath = join(f.home, ".omp", "profiles", "unreadable", "agent", "config.yml");
	mkdirSync(dirname(unsafePath), { recursive: true, mode: 0o700 });
	const outside = join(f.workspace, "outside-config.yml");
	writeFileSync(outside, "ttsr:\n  enabled: true\n");
	symlinkSync(outside, unsafePath);
	const run = runSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "settings", "--json"], {
		cwd: f.project, env: nativeTestEnv(f.home), deadline_s: 120,
	});
	expect(run.rc, Buffer.from(run.stdout).toString() + Buffer.from(run.stderr).toString()).toBe(0);
	const finding = JSON.parse(Buffer.from(run.stdout).toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(finding.status).toBe("UNVERIFIED");
	expect(finding.evidence.profiles.find((profile: { profile: string }) => profile.profile === "default").status).toBe("OK");
	expect(finding.evidence.profiles.find((profile: { profile: string }) => profile.profile === "work").status).toBe("DRIFT");
	expect(finding.evidence.profiles.find((profile: { profile: string }) => profile.profile === "work").keys).toContainEqual({ key: "ttsr.enabled", status: "DRIFT" });
	expect(finding.evidence.profiles.find((profile: { profile: string }) => profile.profile === "unreadable").status).toBe("UNVERIFIED");
	expect(finding.evidence.profiles.find((profile: { profile: string }) => profile.profile === "unreadable").keys).toContainEqual({ key: "ttsr.enabled", status: "UNVERIFIED" });
	expect(readFileSync(defaultPath)).toEqual(defaultBefore);
	expect(readFileSync(workPath)).toEqual(workBefore);
});

nativeTest("doctor settings reads implicit TTSR values through native OMP config get", () => {
	const baseline = fixture();
	writeProfileConfig(baseline.home, "implicit", "model: owned-by-user\n", 0o600);
	const keys = ["enabled", "repeatMode", "repeatGap", "contextMode", "disabledRules"];
	const values = new Map(keys.map(key => [key, nativeConfigValue(baseline.home, baseline.project, "implicit", "ttsr." + key)]));
	const f = fixture();
	const configPath = writeProfileConfig(f.home, "implicit", "model: owned-by-user\n", 0o600);
	const beforeDoctor = readFileSync(configPath);
	const policy: Record<string, unknown> = JSON.parse(readFileSync(join(f.root, "policy", "ttsr.json"), "utf8"));
	const expectedKeys = keys.map(key => ({ key: "ttsr." + key,
		status: JSON.stringify(values.get(key)) === JSON.stringify(policy[key]) ? "OK" : "DRIFT" }));
	const run = runSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"),
		"doctor", "--scope", "settings", "--json"], { cwd: f.project, env: nativeTestEnv(f.home), deadline_s: 120 });
	expect(run.rc, Buffer.from(run.stdout).toString() + Buffer.from(run.stderr).toString()).toBe(0);
	const result = JSON.parse(Buffer.from(run.stdout).toString());
	const finding = result.data.findings.find((item: { component: string }) => item.component === "policy");
	const profiles = finding.evidence.profiles;
	expect(Array.isArray(profiles)).toBe(true);
	const profile = profiles.find((item: { profile: string }) => item.profile === "implicit");
	expect(profile?.status).toBe(expectedKeys.some(item => item.status === "DRIFT") ? "DRIFT" : "OK");
	expect(profile?.keys).toEqual(expectedKeys);
	expect(readFileSync(configPath)).toEqual(beforeDoctor);
});

nativeTest("optional TTSR profile list controls settings diagnosis and default policy plan", () => {
	const f = fixture();
	seedProfile(f.home, "default", policyValues);
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	seedProfile(f.home, "other", { ...policyValues, enabled: false });
	const profileFile = join(f.home, "xdg-config", "omp-kit", "ttsr-profiles.json");
	mkdirSync(dirname(profileFile), { recursive: true, mode: 0o700 });
	const run = (args: string[]) => runSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"],
		{ cwd: f.project, env: nativeTestEnv(f.home), deadline_s: 120 });
	const defaultDoctor = run(["doctor", "--scope", "settings"]);
	const defaultFinding = JSON.parse(Buffer.from(defaultDoctor.stdout).toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(defaultFinding.evidence.profiles.map((item: { profile: string }) => item.profile).sort()).toEqual(["default", "other", "work"]);
	writeFileSync(profileFile, JSON.stringify(["work"]), { mode: 0o600 });
	const selectedDoctor = run(["doctor", "--scope", "settings"]);
	const selectedFinding = JSON.parse(Buffer.from(selectedDoctor.stdout).toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(selectedFinding.evidence.profiles.map((item: { profile: string }) => item.profile)).toEqual(["work"]);
	const profileConfigHome = join(f.home, "xdg-config");
	const selectedPlan = planPolicy({ ...f.input, profileConfigHome });
	expect(selectedPlan.profiles).toEqual(["work"]);
	const overridePlan = planPolicy({ ...f.input, profiles: ["other"], profileConfigHome });
	expect(overridePlan.profiles).toEqual(["other"]);
	const homeConfigDir = join(f.home, ".config", "omp-kit");
	mkdirSync(homeConfigDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(homeConfigDir, "ttsr-profiles.json"), JSON.stringify(["other"]), { mode: 0o600 });
	const homeFallback = planPolicy({ ...f.input, profileConfigHome: undefined });
	expect(homeFallback.profiles).toEqual(["other"]);
});

nativeTest("unsafe TTSR profile list makes diagnosis unverified and policy planning refuse without fallback", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const before = readFileSync(configPath);
	const profileConfigHome = join(f.home, "xdg-config");
	const profileDir = join(profileConfigHome, "omp-kit");
	mkdirSync(profileDir, { recursive: true, mode: 0o700 });
	const outside = join(f.workspace, "outside-profile-list.json");
	writeFileSync(outside, JSON.stringify(["work"]));
	symlinkSync(outside, join(profileDir, "ttsr-profiles.json"));
	const run = (args: string[]) => runSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"],
		{ cwd: f.project, env: nativeTestEnv(f.home), deadline_s: 120 });
	const doctor = run(["doctor", "--scope", "settings"]);
	const finding = JSON.parse(Buffer.from(doctor.stdout).toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(finding.status).toBe("UNVERIFIED");
	expect(() => planPolicy({ ...f.input, profileConfigHome })).toThrow(/PROFILE_LIST_UNVERIFIED/);
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});
