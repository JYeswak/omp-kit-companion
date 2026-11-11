import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { YAML } from "bun";
import { applyPolicyPlan, planPolicy, undoPolicyReceipt } from "../../src/apply-policy.ts";
import { audit, why } from "../../src/audit.ts";
import { cleanupCompiledFixture, cleanupPolicyFixtures, compiledFixture, fixture, nativeOmp, nativeTest, nativeTestEnv, nativeConfigValue, policyValues, seedProfile, setNativeValue } from "./apply-policy.helpers.ts";
afterEach(cleanupPolicyFixtures);
afterAll(cleanupCompiledFixture);

nativeTest("policy planning is independent of the legacy ~/.agents/rules tree", () => {
	const f = fixture({ legacyRules: false });
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const before = readFileSync(configPath);
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.key)).toEqual(["enabled"]);
	expect(plan.steps[0]?.command).toBe("omp --profile work config set ttsr.enabled true");
	expect(readFileSync(configPath)).toEqual(before);
	expect(existsSync(join(f.home, ".agents", "rules"))).toBe(false);
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


nativeTest("compiled apply policy exposes native plan commands and a backup on consented apply", async () => {
	const f = fixture();
	const configPath = seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const before = readFileSync(configPath);
	const kit = join(f.workspace, "kit"), release = join(kit, "releases", "v1");
	mkdirSync(join(release, "bin"), { recursive: true });
	for (const directory of ["rules", "retired", "policy"]) cpSync(join(f.root, directory), join(release, directory), { recursive: true });
	cpSync(join(f.root, "MANIFEST.tsv"), join(release, "MANIFEST.tsv"));
	const binary = join(release, "bin", "omp-kit"), stable = join(kit, "bin", "omp-kit");
	const build = await compiledFixture(binary, f.workspace);
	expect(build.exitCode, build.stdout.toString() + build.stderr.toString()).toBe(0);
	mkdirSync(dirname(stable), { recursive: true });
	symlinkSync(binary, stable);
	const run = (args: string[], envOverrides: Record<string, string> = {}) => {
		const child = Bun.spawnSync([stable, ...args, "--json"], { cwd: f.project,
			env: { ...nativeTestEnv(f.home), ...envOverrides }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
	const noOmpPath = join(f.workspace, "no-omp-bin");
	mkdirSync(noOmpPath);
	const failedProbe = run(["apply", "policy", "--plan"], { PATH: noOmpPath });
	expect(failedProbe.exitCode).toBe(2);
	expect(failedProbe.envelope.errors[0].code).toBe("POLICY_PLAN_FAILED");
	expect(failedProbe.envelope.data.cause_code).toBe("omp executable not found on PATH");
	expect(failedProbe.envelope.data.cause_message).toBe("omp executable not found on PATH");
});

test("policy planning refuses a release whose rule bytes disagree with the manifest", () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	writeFileSync(join(f.root, "rules", "managed.md"), "tampered after release\n");
	expect(() => planPolicy({ ...f.input, profiles: ["work"] })).toThrow(/SOURCE_INVALID.*managed/);
});


nativeTest("pre-write native profile drift preserves FRESH_PLAN instead of partial apply", () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.key)).toEqual(["enabled"]);
	const injectedMarker = join(f.workspace, "external-native-writer");
	const policySetMarker = join(f.workspace, "policy-native-set");
	const originalSpawnSync = Bun.spawnSync;
	let injected = false;
	let policySetStarted = false;
	Bun.spawnSync = (args: string[], options?: { env?: Record<string, string>; cwd?: string; stdin?: string; stdout?: string; stderr?: string }) => {
		const isWorkProfile = args[0] === nativeOmp && args[1] === "--profile" && args[2] === "work";
		if (!injected && options?.env?.HOME === f.home && isWorkProfile && args[3] === "config" && args[4] === "get" && args[5] === "ttsr.enabled") {
			const externalWrite = originalSpawnSync([nativeOmp, "--profile", "work", "config", "set", "ttsr.enabled", "true", "--json"], options);
			if (externalWrite.exitCode !== 0) throw new Error("real OMP external profile write failed: " + externalWrite.stderr.toString());
			writeFileSync(injectedMarker, "external profile write observed\n");
			injected = true;
		} else if (options?.env?.HOME === f.home && isWorkProfile && args[3] === "config" && args[4] === "set") {
			policySetStarted = true;
			writeFileSync(policySetMarker, "policy set started\n");
		}
		return originalSpawnSync(args, options);
	};
	try {
		expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	} finally {
		Bun.spawnSync = originalSpawnSync;
	}
	expect(injected).toBe(true);
	expect(existsSync(injectedMarker)).toBe(true);
	expect(policySetStarted).toBe(false);
	expect(existsSync(policySetMarker)).toBe(false);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.enabled")).toBe(true);
});

nativeTest("post-write native policy drift remains partial and retains the backup identity", () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, enabled: false });
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.key)).toEqual(["enabled"]);
	const originalSpawnSync = Bun.spawnSync;
	let policySetReturned = false;
	let driftInjected = false;
	Bun.spawnSync = (args: string[], options?: { env?: Record<string, string>; cwd?: string; stdin?: string; stdout?: string; stderr?: string }) => {
		const isWorkProfile = args[0] === nativeOmp && args[1] === "--profile" && args[2] === "work" && options?.env?.HOME === f.home;
		if (policySetReturned && !driftInjected && isWorkProfile && args[3] === "config" && args[4] === "get" && args[5] === "ttsr.enabled") {
			const externalWrite = originalSpawnSync([nativeOmp, "--profile", "work", "config", "set", "ttsr.enabled", "false", "--json"], options);
			if (externalWrite.exitCode !== 0) throw new Error("real OMP external profile write failed: " + externalWrite.stderr.toString());
			driftInjected = true;
		}
		const result = originalSpawnSync(args, options);
		if (isWorkProfile && args[3] === "config" && args[4] === "set" && args[5] === "ttsr.enabled" && result.exitCode === 0)
			policySetReturned = true;
		return result;
	};
	let failure = "";
	try { applyPolicyPlan(plan, { confirmed: true }); }
	catch (error) { failure = error instanceof Error ? error.message : String(error); }
	finally { Bun.spawnSync = originalSpawnSync; }
	expect(policySetReturned).toBe(true);
	expect(driftInjected).toBe(true);
	expect(failure).toMatch(/^POLICY_APPLY_PARTIAL:[0-9a-f-]+:work:enabled$/);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.enabled")).toBe(false);
});

nativeTest("OUTSIDERDOCS2: a policy apply writes a receipt that undo restores to the prior values", () => {
	const f = fixture();
	seedProfile(f.home, "work", { ...policyValues, enabled: false, repeatMode: "once", repeatGap: 8 });
	const plan = planPolicy({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.key)).toEqual(["enabled", "repeatMode", "repeatGap"]);
	const applied = applyPolicyPlan(plan, { confirmed: true });
	expect(applied.status).toBe("APPLIED");
	const receiptId = applied.backupId!;
	expect(existsSync(join(f.input.stateRoot, `policy-${receiptId}.json`))).toBe(true);
	expect(audit(f.input.stateRoot).find(row => row.id === receiptId)?.status).toBe("APPLIED");
	expect(why(f.input.stateRoot, receiptId).id).toBe(receiptId);
	expect(undoPolicyReceipt(f.input.stateRoot, receiptId, { home: f.home, ompPath: nativeOmp }))
		.toEqual(["repeatGap", "repeatMode", "enabled"].map(key => ({ profile: "work", key, status: "RESTORED" })));
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.enabled")).toBe(false);
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.repeatMode")).toBe("once");
	expect(nativeConfigValue(f.home, f.project, "work", "ttsr.repeatGap")).toBe(8);
	expect(undoPolicyReceipt(f.input.stateRoot, receiptId, { home: f.home, ompPath: nativeOmp }))
		.toEqual(["repeatGap", "repeatMode", "enabled"].map(key => ({ profile: "work", key, status: "UNCHANGED" })));
	setNativeValue(f.home, f.project, "work", "ttsr.repeatGap", 99);
	expect(undoPolicyReceipt(f.input.stateRoot, receiptId, { home: f.home, ompPath: nativeOmp }))
		.toEqual([
			{ profile: "work", key: "repeatGap", status: "REFUSED", reason: "FRESH_PLAN" },
			{ profile: "work", key: "repeatMode", status: "UNCHANGED" },
			{ profile: "work", key: "enabled", status: "UNCHANGED" },
		]);
});
