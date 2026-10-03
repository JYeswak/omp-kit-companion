import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeProfileConfig } from "./profile-fixture.ts";
import { applyExtensions, inspectExtensionGuard, planExtensions } from "../../src/apply-extensions.ts";
const fixtures: string[] = [];
function fixture() {
	const base = join(import.meta.dir, "../../var/agent-tmp");
	const workspace = mkdtempSync(join(base, "p13-extension-"));
	fixtures.push(workspace);
	const release = join(workspace, "release"), home = join(workspace, "home"), stateRoot = join(workspace, "state");
	const destination = join(home, ".omp", "omp-extensions", "kit-guard-optin.ts");
	mkdirSync(join(release, "policy"), { recursive: true });
	mkdirSync(join(release, "extensions"));
	mkdirSync(join(home, ".omp", "omp-extensions"), { recursive: true });
	writeFileSync(join(release, "policy", "extensions.json"), JSON.stringify({ extensions: ["kit-guard-optin.ts"], skipProfiles: ["ignored"] }));
	writeFileSync(join(release, "extensions", "kit-guard-optin.ts"), "export default function guard() {}\n");
	function profile(name: string, extensions: string[] = []) {
		return writeProfileConfig(home, name, "model: test\nextensions: " + JSON.stringify(extensions) + "\n", 0o666);
	}
	return { workspace, release, home, stateRoot, destination, profile, input: { root: release, home, stateRoot } };
}
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("an unmanaged kit guard collision is skipped while fleet-guard still installs", () => {
	const f = fixture(), config = f.profile("default");
	writeFileSync(f.destination, "user extension\n");
	writeFileSync(join(f.release, "policy", "extensions.json"), JSON.stringify({ extensions: ["kit-guard-optin.ts", "fleet-guard.ts"], skipProfiles: ["ignored"] }));
	writeFileSync(join(f.release, "extensions", "fleet-guard.ts"), "export default function fleet() {}\n");
	const fleetDestination = join(f.home, ".omp", "omp-extensions", "fleet-guard.ts");
	const plan = planExtensions(f.input);
	expect(plan.skippedReasons).toContainEqual({ name: "kit-guard-optin.ts", reason: "SKIPPED_UNMANAGED" });
	expect(plan.steps.map(step => step.path)).toContain(fleetDestination);
	expect(readFileSync(f.destination, "utf8")).toBe("user extension\n");
	applyExtensions(plan);
	expect(readFileSync(fleetDestination, "utf8")).toBe("export default function fleet() {}\n");
	expect(readFileSync(config, "utf8")).toContain(fleetDestination);
});

test("unresolvable fleet-guard import refuses and rolls back the complete receipt", () => {
	const f = fixture(), config = f.profile("default");
	writeFileSync(join(f.release, "policy", "extensions.json"), JSON.stringify({ extensions: ["fleet-guard.ts"], skipProfiles: [] }));
	writeFileSync(join(f.release, "extensions", "fleet-guard.ts"), "import \"./missing-fleet-dependency.ts\";\nexport default function fleet() {}\n");
	const beforeConfig = readFileSync(config);
	const plan = planExtensions(f.input);
	expect(() => applyExtensions(plan)).toThrow("EXTENSION_IMPORTS_UNRESOLVED");
	expect(existsSync(join(f.home, ".omp", "omp-extensions", "fleet-guard.ts"))).toBe(false);
	expect(readFileSync(config)).toEqual(beforeConfig);
});

test("skipProfiles excludes named profile while install and default config share one receipt", () => {
	const f = fixture(), defaultConfig = f.profile("default"), ignoredConfig = f.profile("ignored");
	const plan = planExtensions({ ...f.input, includeDefault: true });
	expect(plan.skippedProfiles).toEqual(["ignored"]);
	expect(plan.steps.map(step => step.path)).toEqual([f.destination, defaultConfig]);
	const result = applyExtensions(plan);
	expect(result.receiptId).toEqual(expect.any(String));
	expect(result.files).toBe(2);
	expect(readFileSync(f.destination, "utf8")).toBe("export default function guard() {}\n");
	expect(readFileSync(defaultConfig, "utf8")).toContain(f.destination);
	expect(readFileSync(ignoredConfig, "utf8")).toContain("extensions: []");
	expect(readFileSync(defaultConfig, "utf8")).toContain("model: test");
	expect(readdirSync(join(f.stateRoot, "receipts"))).toContain(`${result.receiptId}.json`);
});

test("all named profiles excludes default unless includeDefault is selected", () => {
	const f = fixture(), originalDefault = f.profile("default"), selected = f.profile("work");
	const plan = planExtensions({ ...f.input, profiles: "all" });
	expect(plan.steps.map(step => step.path)).toEqual([f.destination, selected]);
	applyExtensions(plan);
	expect(readFileSync(originalDefault, "utf8")).toContain("extensions: []");
	expect(readFileSync(selected, "utf8")).toContain(f.destination);
	const withDefault = planExtensions({ ...f.input, profiles: "all", includeDefault: true });
	expect(withDefault.steps.map(step => step.path)).toEqual([originalDefault]);
});

test("an explicit named selection leaves other named profiles and default untouched", () => {
	const f = fixture(), defaultConfig = f.profile("default"), selected = f.profile("work"), other = f.profile("other");
	writeFileSync(other, "extensions: [broken\n");
	const plan = planExtensions({ ...f.input, profiles: ["work"] });
	expect(plan.steps.map(step => step.path)).toEqual([f.destination, selected]);
	applyExtensions(plan);
	expect(readFileSync(defaultConfig, "utf8")).toContain("extensions: []");
	expect(readFileSync(other, "utf8")).toBe("extensions: [broken\n");
	expect(readFileSync(selected, "utf8")).toContain(f.destination);
});

test("missing explicit named profile refuses before installing bytes or changing config", () => {
	const f = fixture(), config = f.profile("default");
	expect(() => planExtensions({ ...f.input, profiles: ["gone"] })).toThrow(/MISSING_PROFILE/);
	expect(existsSync(f.destination)).toBe(false);
	expect(readFileSync(config, "utf8")).toContain("extensions: []");
	expect(readdirSync(f.workspace).sort()).toEqual(["home", "release"]);
});

test("skipProfiles wins even when the skipped named profile was explicitly selected", () => {
	const f = fixture(), ignored = f.profile("ignored");
	const plan = planExtensions({ ...f.input, profiles: ["ignored"] });
	expect(plan.skippedProfiles).toEqual(["ignored"]);
	expect(plan.steps.map(step => step.path)).toEqual([f.destination]);
	applyExtensions(plan);
	expect(readFileSync(ignored, "utf8")).toContain("extensions: []");
});

test("matching extension bytes and path are not rewritten on a repeated apply", () => {
	const f = fixture(), config = f.profile("default", ["/other/extension.ts"]);
	writeFileSync(f.destination, "export default function guard() {}\n");
	const before = statSync(f.destination, { bigint: true }).mtimeNs;
	const plan = planExtensions(f.input);
	expect(plan.steps.map(step => step.path)).toEqual([config]);
	applyExtensions(plan);
	const after = statSync(f.destination, { bigint: true }).mtimeNs;
	expect(after).toBe(before);
	const configTime = statSync(config, { bigint: true }).mtimeNs;
	const again = planExtensions(f.input);
	expect(again.steps).toEqual([]);
	expect(applyExtensions(again)).toEqual({ receiptId: null, files: 0 });
	expect(statSync(config, { bigint: true }).mtimeNs).toBe(configTime);
	expect(readFileSync(config, "utf8")).toContain("/other/extension.ts");
});

test("profile removed after planning refuses without recreating it", () => {
	const f = fixture(), config = f.profile("work");
	const plan = planExtensions(f.input);
	rmSync(join(f.home, ".omp", "profiles", "work"), { recursive: true });
	expect(() => applyExtensions(plan)).toThrow(/FRESH_PLAN/);
	expect(readdirSync(join(f.home, ".omp", "profiles"))).toEqual([]);
	expect(existsSync(config)).toBe(false);
});

test("edited profile config after planning refuses without touching the extension", () => {
	const f = fixture(), config = f.profile("default");
	const plan = planExtensions(f.input);
	writeFileSync(config, "model: user-edit\nextensions: []\n");
	expect(() => applyExtensions(plan)).toThrow(/FRESH_PLAN/);
	expect(existsSync(f.destination)).toBe(false);
	expect(readFileSync(config, "utf8")).toBe("model: user-edit\nextensions: []\n");
});

test("skipped profile with opaque config is not overwritten", () => {
	const f = fixture(); f.profile("default");
	const ignored = f.profile("ignored");
	writeFileSync(ignored, "extensions: [broken\n");
	const plan = planExtensions(f.input);
	expect(plan.skippedProfiles).toEqual(["ignored"]);
	applyExtensions(plan);
	expect(readFileSync(ignored, "utf8")).toBe("extensions: [broken\n");
});

test("failure after first rename exposes pending receipt and partial installed state", () => {
	const f = fixture(), config = f.profile("default");
	const plan = planExtensions(f.input);
	expect(() => applyExtensions(plan, { onBoundary: boundary => { if (boundary === "renamed:0") throw new Error("injected interruption"); } })).toThrow();
	expect(readFileSync(f.destination, "utf8")).toBe("export default function guard() {}\n");
	expect(readFileSync(config, "utf8")).toContain("extensions: []");
	const pending = readdirSync(join(f.stateRoot, "pending"));
	expect(pending).toHaveLength(1);
	expect(JSON.parse(readFileSync(join(f.stateRoot, "pending", pending[0]!), "utf8")).files).toHaveLength(2);
	expect(() => applyExtensions(plan)).toThrow(/PENDING_RECOVERY|FRESH_PLAN/);
});

test("project empty extension override never claims opt-in guard is active", () => {
	const f = fixture(); f.profile("default", [f.destination]);
	writeFileSync(f.destination, "export default function guard() {}\n");
	const project = join(f.workspace, "project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(join(project, ".omp", "kit-guard.json"), "{}\n");
	writeFileSync(join(project, ".omp", "config.yml"), "extensions: []\n");
	const before = readFileSync(join(project, ".omp", "config.yml"));
	const result = inspectExtensionGuard({ ...f.input, project });
	expect(result.status).toBe("FAIL");
	expect(result.loaded).toBe(false);
	expect(result.reason).toContain("extensions: []");
	const plan = planExtensions({ ...f.input, project });
	expect(plan.guard.status).toBe("FAIL");
	expect(plan.steps).toEqual([]);
	expect(applyExtensions(plan).files).toBe(0);
	expect(readFileSync(join(project, ".omp", "config.yml"))).toEqual(before);
});

test("absent extension parent is created only by guarded apply after a read-only plan", () => {
	const f = fixture(); const config = f.profile("default");
	rmSync(join(f.home, ".omp", "omp-extensions"), { recursive: true });
	const before = readFileSync(config);
	const plan = planExtensions(f.input);
	expect(existsSync(join(f.home, ".omp", "omp-extensions"))).toBe(false);
	expect(readFileSync(config)).toEqual(before);
	const result = applyExtensions(plan);
	expect(result.files).toBe(2);
	expect(readFileSync(f.destination, "utf8")).toBe("export default function guard() {}\n");
	expect(readFileSync(config, "utf8")).toContain(f.destination);
	expect(readdirSync(join(f.stateRoot, "receipts"))).toContain(`${result.receiptId}.json`);
});

test("fresh HOME creates default config and extension only after guarded apply", () => {
	const f = fixture();
	rmSync(join(f.home, ".omp"), { recursive: true });
	const config = join(f.home, ".omp", "agent", "config.yml");
	const plan = planExtensions(f.input);
	expect(plan.steps.map(step => step.path)).toEqual([f.destination, config]);
	expect(existsSync(join(f.home, ".omp"))).toBe(false);
	const receipt = applyExtensions(plan);
	expect(receipt.files).toBe(2);
	expect(readFileSync(config, "utf8")).toContain(f.destination);
	expect(readFileSync(f.destination, "utf8")).toBe("export default function guard() {}\n");
	expect(readdirSync(join(f.stateRoot, "receipts"))).toContain(`${receipt.receiptId}.json`);
});

test("compiled opt-in plans without writes, receipts exact changes, and never certifies a shadowed project guard", () => {
	const f = fixture(), config = f.profile("default");
	const shippedGuard = readFileSync(resolve(import.meta.dir, "../../extensions/kit-guard-optin.ts"));
	writeFileSync(join(f.release, "extensions", "kit-guard-optin.ts"), shippedGuard);
	const project = join(f.workspace, "project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(join(project, ".omp", "kit-guard.json"), "{}\n");
	writeFileSync(join(project, ".omp", "config.yml"), "extensions: []\n");
	mkdirSync(join(f.release, "bin"), { recursive: true });
	const binary = join(f.release, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
		resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], {
		cwd: f.workspace, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode).toBe(0);
	const run = (flags: string[]) => {
		const result = Bun.spawnSync([binary, "apply", "extensions", ...flags, "--json"], {
			cwd: project, env: { ...process.env, HOME: f.home,
				XDG_STATE_HOME: join(f.home, ".local", "state"), XDG_CACHE_HOME: join(f.workspace, "cache") },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: result.exitCode, output: JSON.parse(result.stdout.toString()) };
	};
	const oldConfig = readFileSync(config);
	const plan = run(["--plan"]);
	expect(plan.code).toBe(1);
	expect(plan.output.data.guard).toMatchObject({ status: "FAIL", loaded: false });
	expect(readFileSync(config)).toEqual(oldConfig);
	expect(existsSync(f.destination)).toBe(false);
	expect(existsSync(join(f.home, ".local"))).toBe(false);
	expect(run(["--apply"]).output.errors[0].code).toBe("CONSENT_REQUIRED");
	const applied = run(["--apply", "--yes"]);
	expect(applied.code).toBe(1);
	expect(applied.output.data.guard).toMatchObject({ status: "FAIL", loaded: false });
	expect(applied.output.data.receipt_id).toEqual(expect.any(String));
	expect(readFileSync(config, "utf8")).toContain(f.destination);
	expect(readFileSync(f.destination)).toEqual(shippedGuard);
	expect(readFileSync(join(project, ".omp", "config.yml"), "utf8")).toBe("extensions: []\n");
	const receiptDir = join(f.home, ".local", "state", "omp-kit", "receipts");
	expect(readdirSync(receiptDir)).toContain(`${applied.output.data.receipt_id}.json`);
	const appliedConfig = readFileSync(config), changedAt = statSync(config).mtimeMs, receipts = readdirSync(receiptDir);
	const repeat = run(["--apply", "--yes"]);
	expect(repeat.code).toBe(1);
	expect(repeat.output.data.receipt_id).toBeNull();
	expect(readFileSync(config)).toEqual(appliedConfig);
	expect(statSync(config).mtimeMs).toBe(changedAt);
	expect(readdirSync(receiptDir)).toEqual(receipts);
	const skippedConfig = f.profile("ignored"), selectedConfig = f.profile("work");
	const skippedBefore = readFileSync(skippedConfig);
	const selective = run(["--apply", "--yes", "--profiles", "ignored,work"]);
	expect(selective.code).toBe(1);
	expect(selective.output.data.skipped_profiles).toContain("ignored");
	expect(readFileSync(skippedConfig)).toEqual(skippedBefore);
	expect(readFileSync(selectedConfig, "utf8")).toContain(f.destination);
	expect(readFileSync(config)).toEqual(appliedConfig);
	const interruptedConfig = f.profile("later");
	const pendingPlan = planExtensions({ ...f.input, stateRoot: join(f.home, ".local", "state", "omp-kit"),
		project, profiles: ["later"] });
	expect(() => applyExtensions(pendingPlan, { onBoundary: boundary => {
		if (boundary === "renamed:0") throw new Error("synthetic crash after first rename");
	} })).toThrow();
	expect(readFileSync(interruptedConfig, "utf8")).toContain(f.destination);
	const partial = run(["--apply", "--yes", "--profiles", "later"]);
	expect(partial.code).toBe(1);
	expect(partial.output.errors[0].code).toBe("PARTIAL_APPLY");
	expect(partial.output.data.pending).toEqual([expect.objectContaining({ state: "AFTER" })]);
	expect(readFileSync(skippedConfig)).toEqual(skippedBefore);
	const collisionBefore = readFileSync(config);
	writeFileSync(f.destination, "user-replaced extension\n");
	const collision = run(["--plan"]);
	expect(collision.code).toBe(1);
	expect(collision.output.data.skipped_reasons).toContainEqual({ name: "kit-guard-optin.ts", reason: "SKIPPED_UNMANAGED" });
	expect(readFileSync(f.destination, "utf8")).toBe("user-replaced extension\n");
	expect(readFileSync(config)).toEqual(collisionBefore);
});

test("dual-config and empty profiles are skipped with named reasons while healthy profiles install", () => {
	const f = fixture();
	const good = f.profile("work");
	const dualDir = join(f.home, ".omp", "profiles", "claude", "agent");
	mkdirSync(dualDir, { recursive: true });
	const dualBefore = "model: test\nextensions: []\n";
	writeFileSync(join(dualDir, "config.yml"), dualBefore);
	writeFileSync(join(dualDir, "settings.json"), '{"model":"test"}\n');
	const emptyDir = join(f.home, ".omp", "profiles", "empty", "agent");
	mkdirSync(emptyDir, { recursive: true });
	const plan = planExtensions({ ...f.input, profiles: "all" });
	expect(plan.skippedProfiles.sort()).toEqual(["claude", "empty"]);
	const reasons = Object.fromEntries(plan.skippedReasons.map(entry => [entry.name, entry.reason]));
	expect(reasons.claude).toMatch(/^DUAL_CONFIG: config\.yml \+ settings\.json/);
	expect(reasons.empty).toMatch(/^NO_CONFIG/);
	expect(plan.steps.map(step => step.path)).toContain(good);
	applyExtensions(plan);
	expect(readFileSync(good, "utf8")).toContain(f.destination);
	expect(readFileSync(join(dualDir, "config.yml"), "utf8")).toBe(dualBefore);
	expect(readdirSync(emptyDir)).toEqual([]);
});

test("corrupt config in one profile skips with reason instead of aborting the others", () => {
	const f = fixture();
	const good = f.profile("work"), corrupt = f.profile("broken");
	writeFileSync(corrupt, "extensions: [broken\n");
	const plan = planExtensions({ ...f.input, profiles: "all" });
	expect(plan.skippedProfiles).toEqual(["broken"]);
	expect(plan.skippedReasons[0]?.reason).toMatch(/^UNPARSEABLE/);
	applyExtensions(plan);
	expect(readFileSync(good, "utf8")).toContain(f.destination);
	expect(readFileSync(corrupt, "utf8")).toBe("extensions: [broken\n");
});
