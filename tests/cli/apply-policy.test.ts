import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { applyPolicyPlan, planPolicy } from "../../src/apply-policy.ts";

const fixtures: string[] = [];
function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(base, { recursive: true });
	const workspace = mkdtempSync(join(base, "p12-policy-"));
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
	writeFileSync(join(root, "policy", "ttsr.json"), JSON.stringify({ enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] }));
	function profile(name = "default", disabledRules: unknown = [], policy = false) {
		const dir = name === "default" ? join(home, ".omp", "agent") : join(home, ".omp", "profiles", name, "agent");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "config.yml");
		writeFileSync(path, YAML.stringify({ model: "owned-by-user", ttsr: policy
			? { enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules }
			: { enabled: false, repeatMode: "never", repeatGap: 8, contextMode: "drop", disabledRules } }));
		return path;
	}
	return { workspace, root, home, project, profile, input: { root, home, project, stateRoot: join(home, ".local", "state", "omp-kit") } };
}
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

const config = (path: string) => YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

test("global drift on one rule refuses before changing any selected profile", () => {
	const f = fixture(), one = f.profile("work"), two = f.profile("personal");
	const before = readFileSync(one);
	writeFileSync(join(f.home, ".agents", "rules", "managed.md"), "changed by another owner\n");
	expect(() => planPolicy(f.input)).toThrow(/\.agents\/rules\/managed\.md/);
	expect(readFileSync(one)).toEqual(before);
	expect(config(two).ttsr).toEqual({ enabled: false, repeatMode: "never", repeatGap: 8, contextMode: "drop", disabledRules: [] });
	expect(existsSync(join(f.home, ".local", "state", "omp-kit"))).toBe(false);
});

test("global manifest preflight is rechecked at apply before every profile write", () => {
	const f = fixture(), first = f.profile("work"), second = f.profile("personal");
	const plan = planPolicy(f.input), original = readFileSync(first);
	writeFileSync(join(f.home, ".agents", "rules", "managed.md"), "changed after planning\n");
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(readFileSync(first)).toEqual(original);
	expect((config(second).ttsr as Record<string, unknown>).enabled).toBe(false);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});

test("a retired managed name present globally blocks the entire policy plan", () => {
	const f = fixture(); f.profile();
	writeFileSync(join(f.root, "retired", "old-kit.md"), "retired\n");
	writeFileSync(join(f.home, ".agents", "rules", "old-kit.md"), "still active\n");
	expect(() => planPolicy(f.input)).toThrow(/\.agents\/rules\/old-kit\.md/);
});

test("all selects existing named profiles; default requires explicit inclusion", () => {
	const f = fixture(), defaultPath = f.profile(), first = f.profile("personal"), second = f.profile("work");
	const plan = planPolicy(f.input);
	expect(plan.profiles).toEqual(["personal", "work"]);
	expect(plan.steps.map(step => step.profile)).toEqual(["personal", "work"]);
	const receipt = applyPolicyPlan(plan, { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(receipt.files).toBe(2);
	expect(readFileSync(join(f.home, ".local", "state", "omp-kit", "receipts", `${receipt.id}.json`), "utf8")).toContain(".omp/profiles/work/agent/config.yml");
	expect((config(defaultPath).ttsr as Record<string, unknown>).enabled).toBe(false);
	for (const path of [first, second]) {
		expect(config(path).ttsr).toEqual({ enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] });
		expect(config(path).model).toBe("owned-by-user");
	}
	const included = planPolicy({ ...f.input, includeDefault: true });
	expect(included.profiles).toEqual(["default", "personal", "work"]);
	expect(included.steps.map(step => step.profile)).toEqual(["default"]);
});

test("explicit XDG state root shares receipts instead of creating a second HOME state", () => {
	const f = fixture(); f.profile();
	const stateRoot = join(f.workspace, "xdg-state", "omp-kit");
	const result = applyPolicyPlan(planPolicy({ ...f.input, stateRoot }), { confirmed: true });
	expect(existsSync(join(stateRoot, "receipts", `${result.id}.json`))).toBe(true);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});

test("all selects only default in stock OMP without named profiles", () => {
	const f = fixture(); f.profile();
	expect(planPolicy(f.input).profiles).toEqual(["default"]);
});

test("missing explicit named profile fails rather than inventing a config", () => {
	const f = fixture(), defaultPath = f.profile();
	expect(() => planPolicy({ ...f.input, profiles: ["gone"] })).toThrow(/MISSING_PROFILE/);
	expect((config(defaultPath).ttsr as Record<string, unknown>).enabled).toBe(false);
	expect(existsSync(join(f.home, ".omp", "profiles", "gone"))).toBe(false);
});

test("disabled global rule refuses a profile even if generic consent is supplied", () => {
	const f = fixture(), path = f.profile("work", ["managed"]);
	const plan = planPolicy(f.input);
	expect(plan.blockedProfiles).toEqual([{ profile: "work", names: ["managed"] }]);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toEqual(["managed"]);
});

test("one disabled named profile prevents writes to otherwise safe selected profiles", () => {
	const f = fixture(), safe = f.profile("personal"), blocked = f.profile("work", ["managed"]);
	const plan = planPolicy(f.input);
	expect(plan.steps.map(step => step.profile)).toEqual(["personal"]);
	expect(plan.blockedProfiles).toEqual([{ profile: "work", names: ["managed"] }]);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect((config(safe).ttsr as Record<string, unknown>).enabled).toBe(false);
	expect((config(blocked).ttsr as Record<string, unknown>).disabledRules).toEqual(["managed"]);
	expect(existsSync(f.input.stateRoot)).toBe(false);
});

test("project-only unsafe.md refuses re-enabling while global inventory passes", () => {
	const f = fixture(), path = f.profile("work", ["unsafe"]);
	mkdirSync(join(f.project, ".omp", "rules"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "rules", "unsafe.md"), "project rule\n");
	const plan = planPolicy(f.input);
	expect(plan.blockedProfiles).toEqual([{ profile: "work", names: ["unsafe"] }]);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toEqual(["unsafe"]);
	expect(existsSync(join(f.home, ".local", "state", "omp-kit"))).toBe(false);
});

test("unknown builtin provider cannot be re-enabled from absence in inspected rule directories", () => {
	const f = fixture(), path = f.profile("work", ["builtin-name"]);
	const plan = planPolicy(f.input);
	expect(plan.blockedProfiles).toEqual([{ profile: "work", names: ["builtin-name"] }]);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toEqual(["builtin-name"]);
});

test("retirement marker and absent inspected rules do not prove every project and builtin scope", () => {
	const f = fixture(), path = f.profile("work", ["old-kit"]);
	writeFileSync(join(f.root, "retired", "old-kit.md"), "retired\n");
	const plan = planPolicy(f.input);
	expect(plan.blockedProfiles).toEqual([{ profile: "work", names: ["old-kit"] }]);
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/DISABLED_RULE_REFUSED/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toEqual(["old-kit"]);
});

test("opaque disabledRules refuses rather than treating a scalar as an empty list", () => {
	const f = fixture(), path = f.profile("work", "unknown");
	expect(() => planPolicy(f.input)).toThrow(/UNRECOGNIZED_DISABLED_RULES/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toBe("unknown");
});

test("absent disabledRules is opaque and cannot be presumed empty", () => {
	const f = fixture(), path = f.profile("work");
	writeFileSync(path, "model: user-choice\nttsr:\n  enabled: false\n");
	expect(() => planPolicy(f.input)).toThrow(/UNRECOGNIZED_DISABLED_RULES/);
	expect(readFileSync(path, "utf8")).toContain("model: user-choice");
	expect(existsSync(f.input.stateRoot)).toBe(false);
});

test("invalid release manifest and policy refuse without profile writes", () => {
	const f = fixture(), path = f.profile();
	writeFileSync(join(f.root, "rules", "managed.md"), "tampered source\n");
	expect(() => planPolicy(f.input)).toThrow(/SOURCE_INVALID/);
	expect((config(path).ttsr as Record<string, unknown>).enabled).toBe(false);
	writeFileSync(join(f.root, "rules", "managed.md"), "# Managed\nDo not leak secrets.\n");
	writeFileSync(join(f.root, "policy", "ttsr.json"), JSON.stringify({ disabledRules: [] }));
	expect(() => planPolicy(f.input)).toThrow(/INVALID_POLICY/);
});

test("deleted named profile between plan and apply is not resurrected", () => {
	const f = fixture(), path = f.profile("work"), plan = planPolicy(f.input);
	rmSync(join(f.home, ".omp", "profiles", "work"), { recursive: true });
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(existsSync(path)).toBe(false);
	expect(readdirSync(join(f.home, ".omp", "profiles"))).toEqual([]);
});

test("changed config after plan fails without writing the prior desired policy", () => {
	const f = fixture(), path = f.profile("work"), plan = planPolicy(f.input);
	writeFileSync(path, "model: new-user-model\nttsr:\n  disabledRules: [managed]\n");
	expect(() => applyPolicyPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect((config(path).ttsr as Record<string, unknown>).disabledRules).toEqual(["managed"]);
});

test("a repeated policy apply does not rewrite config or create another receipt", () => {
	const f = fixture(), path = f.profile();
	applyPolicyPlan(planPolicy(f.input), { confirmed: true });
	const before = readFileSync(path), stamp = statSync(path, { bigint: true }).mtimeNs;
	const again = planPolicy(f.input);
	expect(again.steps).toEqual([]);
	expect(applyPolicyPlan(again, { confirmed: true })).toEqual({ status: "UNCHANGED", id: null, files: 0 });
	expect(readFileSync(path)).toEqual(before);
	expect(statSync(path, { bigint: true }).mtimeNs).toBe(stamp);
	expect(readdirSync(join(f.home, ".local", "state", "omp-kit", "receipts"))).toHaveLength(1);
});

test("compiled policy plan and consented apply change only selected profile and write a shared XDG receipt", () => {
	const f = fixture(), defaultPath = f.profile(), workPath = f.profile("work");
	const release = join(f.workspace, "kit", "releases", "v1");
	mkdirSync(release, { recursive: true });
	for (const directory of ["rules", "retired", "policy"])
		cpSync(join(f.root, directory), join(release, directory), { recursive: true });
	cpSync(join(f.root, "MANIFEST.tsv"), join(release, "MANIFEST.tsv"));
	mkdirSync(join(release, "bin"), { recursive: true });
	const binary = join(release, "bin", "omp-kit"), stable = join(f.workspace, "kit", "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], {
		cwd: f.workspace, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
	mkdirSync(join(f.workspace, "kit", "bin"), { recursive: true });
	symlinkSync(binary, stable);
	const run = (args: string[]) => {
		const child = Bun.spawnSync([stable, ...args, "--json"], {
			cwd: f.project, env: { ...process.env, HOME: f.home,
				XDG_STATE_HOME: join(f.workspace, "xdg-state"), XDG_CACHE_HOME: join(f.workspace, "cache") },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: child.exitCode, raw: child.stdout.toString() + child.stderr.toString(),
			envelope: JSON.parse(child.stdout.toString()) };
	};
	writeFileSync(join(f.home, ".agents", "rules", "managed.md"), "out-of-band global drift\n");
	const globalBefore = readFileSync(workPath);
	const drifted = run(["apply", "policy", "--profiles", "work", "--plan"]);
	expect(drifted.code).toBe(2);
	expect(drifted.envelope.errors[0].code).toBe("GLOBAL_PREFLIGHT_FAILED");
	expect(drifted.envelope.data.violations).toEqual([".agents/rules/managed.md"]);
	expect(readFileSync(workPath)).toEqual(globalBefore);
	cpSync(join(f.root, "rules", "managed.md"), join(f.home, ".agents", "rules", "managed.md"));
	const before = readFileSync(workPath);
	const plan = run(["apply", "policy", "--profiles", "work", "--plan"]);
	expect(plan.code).toBe(0);
	expect(plan.envelope.data.steps).toEqual([expect.objectContaining({ profile: "work", path: ".omp/profiles/work/agent/config.yml" })]);
	expect(readFileSync(workPath)).toEqual(before);
	expect(run(["apply", "policy", "--profiles", "work", "--apply"]).envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(readFileSync(workPath)).toEqual(before);
	const result = run(["apply", "policy", "--profiles", "work", "--apply", "--yes"]);
	expect(result.code).toBe(0);
	expect(result.envelope.data.action).toBe("APPLIED");
	expect(result.raw).not.toContain(f.workspace);
	expect((config(workPath).ttsr as Record<string, unknown>).enabled).toBe(true);
	expect((config(defaultPath).ttsr as Record<string, unknown>).enabled).toBe(false);
	const id = result.envelope.data.receipt_id as string;
	expect(existsSync(join(f.workspace, "xdg-state", "omp-kit", "receipts", `${id}.json`))).toBe(true);
	expect(existsSync(join(f.home, ".local", "state"))).toBe(false);
	expect(run(["apply", "policy", "--profiles", "work", "--apply", "--yes"]).envelope.data.action).toBe("UNCHANGED");
	const projectRules = join(f.project, ".omp", "rules");
	mkdirSync(projectRules, { recursive: true });
	writeFileSync(join(projectRules, "unsafe.md"), "project-only unsafe rule\n");
	writeFileSync(workPath, YAML.stringify({ model: "owned-by-user", ttsr: {
		enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: ["unsafe"],
	} }));
	const blockedBefore = readFileSync(workPath);
	const blocked = run(["apply", "policy", "--profiles", "work", "--apply", "--yes"]);
	expect(blocked.code).toBe(2);
	expect(blocked.envelope.errors[0].code).toBe("DISABLED_RULE_REFUSED");
	expect(blocked.envelope.data.blocked_profiles).toEqual([{ profile: "work", names: ["unsafe"] }]);
	expect(readFileSync(workPath)).toEqual(blockedBefore);
	expect(readdirSync(join(f.workspace, "xdg-state", "omp-kit", "receipts"))).toEqual([`${id}.json`]);
});
