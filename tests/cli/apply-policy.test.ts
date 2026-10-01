import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { YAML } from "bun";
import { applyPolicyPlan, planPolicy } from "../../src/apply-policy.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { writeProfileConfig } from "./profile-fixture.ts";

const nativeOmp = resolveOmpIdentity().launcher;
const fixtures: string[] = [];
const nativeTest = (name: string, body: () => void) => test(name, body, 120_000);
type NativeConfigResult = { code: number | null; stdout: string; stderr: string };
function nativeTestEnv(home: string): Record<string, string> {
	const tmp = join(home, "tmp"), bin = join(home, "bin");
	mkdirSync(tmp, { recursive: true, mode: 0o700 });
	mkdirSync(bin, { recursive: true, mode: 0o700 });
	const launcher = join(bin, "omp");
	if (!existsSync(launcher)) symlinkSync(nativeOmp, launcher);
	return {
		HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
		XDG_CONFIG_HOME: join(home, "xdg-config"), XDG_CACHE_HOME: join(home, "xdg-cache"),
		XDG_DATA_HOME: join(home, "xdg-data"), XDG_STATE_HOME: join(home, "xdg-state"),
		PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"), NO_COLOR: "1", TERM: "dumb",
	};
}
function runNativeConfig(home: string, project: string, profile: string, args: string[]): NativeConfigResult {
	const selected = profile === "default" ? [] : ["--profile", profile];
	const child = Bun.spawnSync([nativeOmp, ...selected, "config", ...args], {
		cwd: project, env: nativeTestEnv(home), stdout: "pipe", stderr: "pipe", stdin: "ignore",
	});
	return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}
function setNativeValue(home: string, project: string, profile: string, key: string, value: unknown): void {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	const result = runNativeConfig(home, project, profile, ["set", key, text, "--json"]);
	if (result.code !== 0) throw new Error(`OMP config set failed for ${profile}/${key}: rc=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`);
}
function nativeConfigValue(home: string, project: string, profile: string, key: string): unknown {
	const result = runNativeConfig(home, project, profile, ["get", key, "--json"]);
	if (result.code !== 0) throw new Error(`OMP config get failed for ${profile}/${key}: rc=${result.code}; stdout=${result.stdout}; stderr=${result.stderr}`);
	const value: unknown = JSON.parse(result.stdout);
	if (!value || typeof value !== "object" || !("key" in value) || value.key !== key || !("value" in value))
		throw new Error(`OMP config get returned invalid JSON for ${profile}/${key}`);
	return value.value;
}
function seedProfile(home: string, name: string, values: Record<string, unknown>): string {
	return writeProfileConfig(home, name, YAML.stringify({ model: "owned-by-user", ttsr: values }), 0o600);
}
const policyValues = { enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] };
function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const workspace = mkdtempSync(join(base, "p12-policy-native-"));
	fixtures.push(workspace);
	const root = join(workspace, "release"), home = join(workspace, "home"), project = join(workspace, "project");
	const body = "# Managed\nDo not leak secrets.\n";
	const digest = createHash("sha256").update(body).digest("hex");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(join(root, "policy"));
	mkdirSync(join(home, ".agents", "rules"), { recursive: true });
	mkdirSync(project);
	writeFileSync(join(root, "rules", "managed.md"), body);
	writeFileSync(join(home, ".agents", "rules", "managed.md"), body);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nmanaged\t${digest}\talways\taaaaaaa\n`);
	writeFileSync(join(root, "policy", "ttsr.json"), JSON.stringify(policyValues));
	return { workspace, root, home, project, input: { root, home, project, ompPath: nativeOmp, stateRoot: join(home, ".local", "state", "omp-kit") } };
}
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

nativeTest("global rule drift refuses native profile planning without creating policy state", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", policyValues);
	const before = readFileSync(configPath);
	writeFileSync(join(f.home, ".agents", "rules", "managed.md"), "changed by another owner\n");
	expect(() => planPolicy({ ...f.input, profiles: ["work"] })).toThrow(/GLOBAL_PREFLIGHT_FAILED/);
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});

nativeTest("plan emits only explicit native per-profile TTSR config-set commands without writing", () => {
	const f = fixture();
	writeFileSync(join(f.root, "policy", "ttsr.json"), JSON.stringify({ ...policyValues, disabledRules: ["managed"] }));
	const configPath = seedProfile(f.home, "work", { enabled: false, repeatMode: "once", repeatGap: 8, contextMode: "discard", disabledRules: [] });
	const before = readFileSync(configPath);
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.command)).toEqual([
		"omp --profile work config set ttsr.enabled true",
		"omp --profile work config set ttsr.repeatMode after-gap",
		"omp --profile work config set ttsr.repeatGap 0",
		"omp --profile work config set ttsr.contextMode keep",
		"omp --profile work config set ttsr.disabledRules '[\"managed\"]'",
	]);
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});


nativeTest("compiled apply policy exposes native plan commands and a backup on consented apply", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const before = readFileSync(configPath);
	const kit = join(f.workspace, "kit"), release = join(kit, "releases", "v1");
	mkdirSync(join(release, "bin"), { recursive: true });
	for (const directory of ["rules", "retired", "policy"]) cpSync(join(f.root, directory), join(release, directory), { recursive: true });
	cpSync(join(f.root, "MANIFEST.tsv"), join(release, "MANIFEST.tsv"));
	const binary = join(release, "bin", "omp-kit"), stable = join(kit, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], { cwd: f.workspace, stdout: "pipe", stderr: "pipe" });
	expect(build.exitCode, build.stdout.toString() + build.stderr.toString()).toBe(0);
	mkdirSync(dirname(stable), { recursive: true });
	symlinkSync(binary, stable);
	const run = (args: string[]) => {
		const child = Bun.spawnSync([stable, ...args, "--json"], { cwd: f.project, env: nativeTestEnv(f.home), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const stdout = child.stdout.toString();
		return { exitCode: child.exitCode, output: stdout + child.stderr.toString(), envelope: JSON.parse(stdout) };
	};
	const configDir = join(f.home, "xdg-config", "omp-kit");
	mkdirSync(configDir, { recursive: true, mode: 0o700 });
	const profileList = join(configDir, "ttsr-profiles.json"), outsideList = join(f.workspace, "outside-profiles.json");
	writeFileSync(outsideList, JSON.stringify(["work"]));
	symlinkSync(outsideList, profileList);
	const unsafe = run(["apply", "policy", "--apply", "--yes"]);
	expect(unsafe.exitCode).toBe(2);
	expect(unsafe.envelope.errors[0].code).toBe("PROFILE_LIST_UNVERIFIED");
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(join(f.home, "xdg-state", "omp-kit"))).toBe(false);
	rmSync(profileList);
	writeFileSync(profileList, JSON.stringify(["work"]), { mode: 0o600 });
	const defaultPlan = run(["apply", "policy", "--plan"]);
	expect(defaultPlan.exitCode, defaultPlan.output).toBe(0);
	expect(defaultPlan.envelope.data.profiles).toEqual(["work"]);
	const unconfirmed = run(["apply", "policy", "--profiles", "work", "--apply"]);
	expect(unconfirmed.envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(readFileSync(configPath)).toEqual(before);
	const applied = run(["apply", "policy", "--profiles", "work", "--apply", "--yes"]);
	expect(applied.exitCode, applied.output).toBe(0);
	expect(applied.envelope.data.action).toBe("APPLIED");
	expect(applied.envelope.data.steps).toEqual([{ profile: "work", path: ".omp/profiles/work/agent/config.yml", key: "ttsr.enabled", command: "omp --profile work config set ttsr.enabled true" }]);
	const backupDir = join(f.home, "xdg-state", "omp-kit", "policy-backups", applied.envelope.data.backup_id);
	const backupFile = join(backupDir, "profiles", "work", "config.yml");
	expect(readFileSync(backupFile)).toEqual(before);
	expect(statSync(backupDir).mode & 0o777).toBe(0o700);
	expect(statSync(backupFile).mode & 0o777).toBe(0o600);
	const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
	expect(manifest.profiles[0].mode).toBe(statSync(configPath).mode & 0o7777);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.enabled")).toBe(true);
	expect((YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>).model).toBe("owned-by-user");
});

nativeTest("apply rechecks global rule inventory and refuses a stale native policy plan", () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const before = readFileSync(configPath);
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	writeFileSync(join(f.home, ".agents", "rules", "managed.md"), "changed after plan\n");
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});
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
	const run = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "settings", "--json"], {
		cwd: f.project, env: nativeTestEnv(f.home), stdout: "pipe", stderr: "pipe", stdin: "ignore",
	});
	expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
	const finding = JSON.parse(run.stdout.toString()).data.findings.find((item: { component: string }) => item.component === "policy");
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
	const run = Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"),
		"doctor", "--scope", "settings", "--json"], { cwd: f.project, env: nativeTestEnv(f.home), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
	const result = JSON.parse(run.stdout.toString());
	const finding = result.data.findings.find((item: { component: string }) => item.component === "policy");
	const profiles = finding.evidence.profiles;
	expect(Array.isArray(profiles)).toBe(true);
	const profile = profiles.find((item: { profile: string }) => item.profile === "implicit");
	expect(profile?.status).toBe(expectedKeys.some(item => item.status === "DRIFT") ? "DRIFT" : "OK");
	expect(profile?.keys).toEqual(expectedKeys);
	expect(readFileSync(configPath)).toEqual(beforeDoctor);
});

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

nativeTest("optional TTSR profile list controls settings diagnosis and default policy plan", () => {
	const f = fixture();
	seedProfile(f.home, "default", policyValues);
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	seedProfile(f.home, "other", { ...policyValues, enabled: false });
	const profileFile = join(f.home, "xdg-config", "omp-kit", "ttsr-profiles.json");
	mkdirSync(dirname(profileFile), { recursive: true, mode: 0o700 });
	const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"],
		{ cwd: f.project, env: nativeTestEnv(f.home), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const defaultDoctor = run(["doctor", "--scope", "settings"]);
	const defaultFinding = JSON.parse(defaultDoctor.stdout.toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(defaultFinding.evidence.profiles.map((item: { profile: string }) => item.profile).sort()).toEqual(["default", "other", "work"]);
	writeFileSync(profileFile, JSON.stringify(["work"]), { mode: 0o600 });
	const selectedDoctor = run(["doctor", "--scope", "settings"]);
	const selectedFinding = JSON.parse(selectedDoctor.stdout.toString()).data.findings.find((item: { component: string }) => item.component === "policy");
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
	const run = (args: string[]) => Bun.spawnSync([process.execPath, "run", resolve(import.meta.dir, "../../src/cli.ts"), ...args, "--json"],
		{ cwd: f.project, env: nativeTestEnv(f.home), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const doctor = run(["doctor", "--scope", "settings"]);
	const finding = JSON.parse(doctor.stdout.toString()).data.findings.find((item: { component: string }) => item.component === "policy");
	expect(finding.status).toBe("UNVERIFIED");
	expect(() => planPolicy({ ...f.input, profileConfigHome })).toThrow(/PROFILE_LIST_UNVERIFIED/);
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});
