import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { YAML } from "bun";
import { auditMutations, undoMutation } from "../../src/mutations.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";
import { applyRepairPlan, planDeepDoctor, planRepair } from "../../src/repair.ts";
import { writeProfileConfig } from "./profile-fixture.ts";
const nativeOmp = resolveOmpIdentity().launcher;
function nativeConfigValue(home: string, key: string): unknown {
	const tmp = join(home, "tmp");
	mkdirSync(tmp, { recursive: true, mode: 0o700 });
	const env = { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmp, TMP: tmp, TEMP: tmp, NO_COLOR: "1", TERM: "dumb" };
	const child = Bun.spawnSync([nativeOmp, "config", "get", key, "--json"], { cwd: tmp, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	if (child.exitCode !== 0) throw new Error("OMP config get failed for " + key + ": " + child.stdout.toString() + child.stderr.toString());
	const result: unknown = JSON.parse(child.stdout.toString());
	if (!result || typeof result !== "object" || !("key" in result) || result.key !== key || !("value" in result)) throw new Error("invalid OMP config get result for " + key);
	return result.value;
}
const fixtures: string[] = [];
function fixture() {
	const scratch = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(scratch, { recursive: true });
	const workspace = mkdtempSync(join(scratch, "p15-repair-"));
	fixtures.push(workspace);
	const root = join(workspace, "release"), home = join(workspace, "home"), stateRoot = join(workspace, "state"), project = join(workspace, "project");
	const rule = "Kit rule\n";
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "retired"));
	mkdirSync(join(root, "policy"));
	mkdirSync(join(root, "extensions"));
	mkdirSync(home);
	mkdirSync(project);
	writeFileSync(join(root, "rules", "managed.md"), rule);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nmanaged\t${createHash("sha256").update(rule).digest("hex")}\talways\taaaaaaa\n`);
	writeFileSync(join(root, "policy", "ttsr.json"), JSON.stringify({ enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] }));
	writeFileSync(join(root, "policy", "extensions.json"), JSON.stringify({ extensions: ["kit-guard-optin.ts"], skipProfiles: [] }));
	writeFileSync(join(root, "extensions", "kit-guard-optin.ts"), "export default function guard() {}\n");
	const profile = writeProfileConfig(home, "default", YAML.stringify({ model: "user-model", extensions: [], ttsr: { enabled: false, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] } }), 0o644);
	return { workspace, root, home, stateRoot, project, profile, rulePath: join(home, ".agents", "rules", "managed.md") };
}
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function snapshot(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	const out: Record<string, string> = {};
	for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
		const parent = entry.parentPath ?? entry.path;
		const relative = join(parent.slice(path.length + 1), entry.name);
		const absolute = join(parent, entry.name);
		out[relative] = `${statSync(absolute).mode & 0o7777}:${entry.isFile() ? readFileSync(absolute).toString("hex") : "DIR"}`;
	}
	return out;
}

test("unknown, missing, or unsupported scope refuses without changing disposable HOME or state", async () => {
	const f = fixture(), before = snapshot(f.home);
	for (const scope of [undefined, "router", "omp", "jsm", "credentials", "builtin", "project_rules", "RULES"]) {
		const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope });
		expect(decision.status).toBe("REFUSED");
		expect(decision.refusal?.code).toBeTruthy();
		expect(() => applyRepairPlan(decision, { confirmed: true })).toThrow(/REPAIR_REFUSED/);
	}
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("known rules repair is read-only until consent, yields receipt, and undo restores touched files", async () => {
	const f = fixture(), before = snapshot(f.home);
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	if (plan.status !== "READY") throw new Error(JSON.stringify(plan));
	expect(plan.scope).toBe("rules");
	expect(plan.steps).toContainEqual(expect.objectContaining({ action: "install", path: ".agents/rules/managed.md" }));
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
	expect(() => applyRepairPlan(plan, {} as { confirmed: true })).toThrow(/CONSENT_REQUIRED/);
	expect(snapshot(f.home)).toEqual(before);
	const result = applyRepairPlan(plan, { confirmed: true });
	expect(result.status).toBe("APPLIED");
	expect(readFileSync(f.rulePath, "utf8")).toBe("Kit rule\n");
	expect(auditMutations(f.stateRoot).find(row => row.id === result.receiptId)?.status).toBe("APPLIED");
	const repeated = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	if (repeated.status !== "READY") throw new Error(JSON.stringify(repeated));
	expect(repeated.changes).toBe(0);
	expect(applyRepairPlan(repeated, { confirmed: true })).toEqual({ status: "UNCHANGED", receiptId: null, backupId: null, files: 0 });
	expect(readdirSync(join(f.stateRoot, "receipts"))).toHaveLength(1);
	undoMutation(f.stateRoot, result.receiptId!, { confirmed: true });
	expect(snapshot(f.home)).toEqual(before);
});

test("a same-name unowned collision is a refusal rather than an overwrite", async () => {
	const f = fixture();
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(f.rulePath, "Private different rule\n");
	const before = snapshot(f.home);
	const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	expect(decision.status).toBe("REFUSED");
	expect(decision.refusal?.code).toMatch(/COLLISION/);
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("a stale rule plan cannot replace a file written after planning", async () => {
	const f = fixture();
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	mkdirSync(join(f.home, ".agents", "rules"), { recursive: true });
	writeFileSync(f.rulePath, "Operator arrived later\n");
	expect(() => applyRepairPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN|RULE_COLLISION/);
	expect(readFileSync(f.rulePath, "utf8")).toBe("Operator arrived later\n");
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("named policy repair uses native config commands and preserves unrelated profile settings", async () => {
	const f = fixture();
	const rules = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	applyRepairPlan(rules, { confirmed: true });
	const original = readFileSync(f.profile);
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "policy" });
	if (plan.status !== "READY") throw new Error(JSON.stringify(plan));
	expect(plan.steps).toContainEqual(expect.objectContaining({ profile: "default", command: "omp config set ttsr.enabled true" }));
	const result = applyRepairPlan(plan, { confirmed: true });
	expect(result.receiptId).toBeNull();
	expect(result.backupId).toEqual(expect.any(String));
	const backup = join(f.stateRoot, "policy-backups", result.backupId!, "profiles", "default", "config.yml");
	expect(readFileSync(backup)).toEqual(original);
	const config = YAML.parse(readFileSync(f.profile, "utf8")) as Record<string, unknown>;
	expect(config.model).toBe("user-model");
	expect(config.ttsr).toEqual({ enabled: true, repeatMode: "after-gap", repeatGap: 0, contextMode: "keep", disabledRules: [] });
	expect(nativeConfigValue(f.home, "ttsr.enabled")).toBe(true);
}, 120_000);

test("policy repair preserves project disabled-rule provider refusal beside native profile evidence", async () => {
	const f = fixture();
	mkdirSync(join(f.project, ".omp", "rules"), { recursive: true });
	writeFileSync(join(f.project, ".omp", "rules", "external.md"), "Project rule\n");
	writeFileSync(join(f.project, ".omp", "config.yml"), YAML.stringify({ ttsr: { disabledRules: ["external"] } }));
	const before = snapshot(f.home);
	const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, project: f.project, scope: "policy" });
	expect(decision.status).toBe("REFUSED");
	expect(decision.refusal?.code).toBe("DISABLED_PROVIDER_REFUSED");
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
}, 60_000);

test("disabled rule of unknown provider blocks policy without altering any profile", async () => {
	const f = fixture();
	const rules = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "rules" });
	applyRepairPlan(rules, { confirmed: true });
	writeFileSync(f.profile, YAML.stringify({ model: "user-model", ttsr: { enabled: false, repeatMode: "once", repeatGap: 8, contextMode: "discard", disabledRules: ["unknown-builtin"] } }));
	const before = snapshot(f.home);
	const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "policy" });
	expect(decision.status).toBe("REFUSED");
	expect(decision.refusal?.code).toMatch(/DISABLED|PROVIDER/);
	expect(snapshot(f.home)).toEqual(before);
}, 60_000);

test("extension repair is named, and interrupted install exposes pending receipt instead of silent retry", async () => {
	const f = fixture();
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	if (plan.status !== "READY") throw new Error(JSON.stringify(plan));
	expect(plan.steps.some(step => step.action === "install")).toBe(true);
	expect(() => applyRepairPlan(plan, { confirmed: true, onBoundary: boundary => {
		if (boundary === "renamed:0") throw new Error("crash after first rename");
	} })).toThrow();
	const states = auditMutations(f.stateRoot);
	expect(states.some(row => row.status === "PARTIAL")).toBe(true);
	const next = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	expect(next.status).toBe("REFUSED");
	expect(next.refusal?.code).toBe("PENDING_RECOVERY");
});

test("extension collision refuses instead of replacing operator bytes", async () => {
	const f = fixture(), destination = join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts");
	mkdirSync(join(f.home, ".omp", "omp-extensions"));
	writeFileSync(destination, "operator extension\n");
	const before = snapshot(f.home);
	const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	expect(decision.status).toBe("REFUSED");
	expect(decision.refusal?.code).toBe("EXTENSION_COLLISION");
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("project extension override is not silently fixed by global extension repair", async () => {
	const f = fixture(), project = join(f.workspace, "project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(join(project, ".omp", "config.yml"), "extensions: []\n");
	const before = snapshot(f.home);
	const decision = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions", project });
	expect(decision.status).toBe("REFUSED");
	expect(decision.refusal?.code).toBe("EXTENSION_PROVIDER_UNVERIFIED");
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("an extension source edit after plan refuses without writing a profile or destination", async () => {
	const f = fixture();
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	writeFileSync(join(f.root, "extensions", "kit-guard-optin.ts"), "changed release bytes\n");
	const before = snapshot(f.home);
	expect(() => applyRepairPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("a named extension repair applies only the selected files and undo restores the HOME", async () => {
	const f = fixture(), before = snapshot(f.home);
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	if (plan.status !== "READY") throw new Error(JSON.stringify(plan));
	expect(plan.steps.map(step => step.path)).toEqual([".omp/omp-extensions/kit-guard-optin.ts", ".omp/agent/config.yml"]);
	const receipt = applyRepairPlan(plan, { confirmed: true });
	expect(receipt.status).toBe("APPLIED");
	expect(readFileSync(join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts"), "utf8")).toBe("export default function guard() {}\n");
	undoMutation(f.stateRoot, receipt.receiptId!, { confirmed: true });
	expect(snapshot(f.home)).toEqual(before);
});

test("a changed extension source mode cannot silently change the planned installed mode", async () => {
	const f = fixture();
	const plan = await planRepair({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "extensions" });
	if (plan.status !== "READY") throw new Error(JSON.stringify(plan));
	const step = plan.steps.find(entry => entry.path === ".omp/omp-extensions/kit-guard-optin.ts");
	expect(step?.afterMode).toBe(0o644);
	chmodSync(join(f.root, "extensions", "kit-guard-optin.ts"), 0o600);
	expect(() => applyRepairPlan(plan, { confirmed: true })).toThrow(/FRESH_PLAN/);
	expect(existsSync(join(f.home, ".omp", "omp-extensions", "kit-guard-optin.ts"))).toBe(false);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("receipt state cannot be placed inside the release or managed profile tree", async () => {
	const f = fixture(), before = snapshot(f.home);
	for (const stateRoot of [f.root, join(f.home, ".omp"), join(f.home, ".agents", "rules")]) {
		for (const scope of ["policy", "extensions"]) {
			const decision = await planRepair({ root: f.root, home: f.home, stateRoot, scope });
			expect(decision.status).toBe("REFUSED");
			expect(decision.refusal?.code).toBe("UNSAFE_PATH");
		}
	}
	expect(snapshot(f.home)).toEqual(before);
});

test("doctor deep never runs a migratory command even with yes until safe receipt and backup exist", async () => {
	const f = fixture(), before = snapshot(f.home);
	const decision = await planDeepDoctor({ root: f.root, home: f.home, stateRoot: f.stateRoot, scope: "effective_profile", confirmed: true });
	expect(decision.status).toBe("UNVERIFIED");
	expect(decision.refusal.code).toBe("DEEP_PROBE_UNVERIFIED");
	expect(snapshot(f.home)).toEqual(before);
	expect(existsSync(f.stateRoot)).toBe(false);
});

test("compiled named repair plans without consent, applies once, and undoes exact HOME changes", () => {
	const f = fixture(), before = snapshot(f.home);
	mkdirSync(join(f.root, "bin"));
	const binary = join(f.root, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", "--no-compile-autoload-dotenv",
		"--no-compile-autoload-bunfig", resolve(import.meta.dir, "../../src/cli.ts"), "--outfile", binary], {
		cwd: f.workspace, stdout: "pipe", stderr: "pipe",
	});
	expect(build.exitCode, build.stderr.toString()).toBe(0);
	const run = (args: string[]) => {
		const result = Bun.spawnSync([binary, ...args, "--json"], {
			cwd: f.workspace, env: { ...process.env, HOME: f.home, XDG_STATE_HOME: f.workspace },
			stdout: "pipe", stderr: "pipe",
		});
		return { code: result.exitCode, envelope: JSON.parse(result.stdout.toString()) };
	};
	const capabilities = run(["capabilities"]);
	expect(capabilities.code).toBe(0);
	const repair = capabilities.envelope.data.commands.find((command: { name: string }) => command.name === "repair");
	expect(repair.usage).toContain("--scope rules|policy|extensions");

	const plan = run(["repair", "--scope", "rules", "--plan"]);
	expect(plan.code).toBe(0);
	expect(plan.envelope.data).toMatchObject({ action: "PLAN", scope: "rules", changes: 1, receipt_id: null });
	expect(snapshot(f.home)).toEqual(before);
	expect(run(["repair", "--scope", "rules", "--apply"]).envelope.errors[0].code).toBe("CONSENT_REQUIRED");
	expect(snapshot(f.home)).toEqual(before);
	const applied = run(["repair", "--scope", "rules", "--apply", "--yes"]);
	expect(applied.code).toBe(0);
	const id = applied.envelope.data.receipt_id as string;
	expect(readFileSync(f.rulePath, "utf8")).toBe("Kit rule\n");
	expect(run(["repair", "--scope", "rules", "--apply", "--yes"]).envelope.data).toMatchObject({
		action: "UNCHANGED", changes: 0, receipt_id: null,
	});
	expect(run(["audit"]).envelope.data.receipts).toEqual(expect.arrayContaining([expect.objectContaining({ id, status: "APPLIED" })]));
	expect(run(["undo", id, "--yes"]).code).toBe(0);
	expect(snapshot(f.home)).toEqual(before);
	const deep = run(["doctor", "--deep", "--yes"]);
	expect(deep.code).toBe(2);
	expect(deep.envelope.data.deep_probe.status).toBe("UNVERIFIED");
	expect(deep.envelope.errors[0].code).toBe("DEEP_PROBE_UNVERIFIED");
	expect(snapshot(f.home)).toEqual(before);
});
