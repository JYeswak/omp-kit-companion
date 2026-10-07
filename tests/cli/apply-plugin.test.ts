import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { analyzeRegexBudgetOutput, applyPlugin, planPlugin, pluginPackageHash, pluginProfileHashes, undoPlugin, type PluginRunner, type PluginSnapshot } from "../../src/apply-plugin.ts";

const store = "/fixture/releases/0.2.5";
const scratchRoot = join(process.cwd(), "var", "agent-tmp");

function makeStateRoot(label: string): string {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, `prof1-${label}-`));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=prof1-${label}\nrepo=${process.cwd()}\ncreated=${new Date().toISOString()}\n`);
	return dir;
}
function filesystemKind(path: string): "ABSENT" | "FILE" | "DIRECTORY" | "SYMLINK" | "OTHER" {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return "SYMLINK";
		if (stat.isFile()) return "FILE";
		if (stat.isDirectory()) return "DIRECTORY";
		return "OTHER";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "ABSENT";
		throw error;
	}
}

function runner(): { runner: PluginRunner; calls: string[][]; state: Map<string, PluginSnapshot> } {
	const calls: string[][] = [];
	const state = new Map<string, PluginSnapshot>();
	const initial = (profile: string): PluginSnapshot => ({
		installed: false, target: null, link_path: `/fixture/user-home/${profile}/plugins/node_modules/omp-kit-companion`,
		plugins_dir_hash: "before-tree", lock_hash: "before-lock", disabled_rules: [], link_kind: "ABSENT",
	});
	const snapshot = (profile: string) => state.get(profile) ?? initial(profile);
	return { calls, state, runner: {
		snapshot,
		invoke: (profile, args) => {
			calls.push([profile, ...args]);
			const before = snapshot(profile);
			const action = args[1];
			state.set(profile, action === "link"
				? { ...before, installed: true, target: args[2]!, version: "0.2.5", link_kind: "SYMLINK", plugins_dir_hash: "after-tree", lock_hash: "after-lock" }
				: { ...initial(profile), disabled_rules: before.disabled_rules });
			return { code: 0, stdout: "", stderr: "" };
		},
		setDisabledRules: (profile, rules) => {
			calls.push([profile, "config", "set", "ttsr.disabledRules", JSON.stringify(rules)]);
			state.set(profile, { ...snapshot(profile), disabled_rules: [...rules] });
			return { code: 0, stdout: "", stderr: "" };
		},
	} };
}

test("plans all writable profiles and names DUAL_CONFIG skips", () => {
	const plan = planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }, { name: "codex", configFiles: ["config.yml"] }, { name: "claude", configFiles: ["config.yml", "config.yaml"] }]);
	expect(plan.steps.map(step => step.profile)).toEqual(["default", "codex"]);
	expect(plan.skipped).toEqual([{ profile: "claude", reason: "DUAL_CONFIG" }]);
});

test("applies per-profile links and persists one receipt", () => {
	const fake = runner();
	const stateRoot = makeStateRoot("apply");
	try {
		const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }]), fake.runner, stateRoot);
		expect(receipt.rows[0]).toMatchObject({ profile: "default", status: "APPLIED" });
		expect(fake.calls[0]).toEqual(["default", "plugin", "link", store]);
		const receiptPath = join(stateRoot, `plugin-${receipt.id}.json`);
		expect(existsSync(receiptPath)).toBe(true);
		expect(JSON.parse(readFileSync(receiptPath, "utf8")).schema_version).toBe(1);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("undo restores an absent prior plugin", () => {
	const fake = runner();
	const stateRoot = makeStateRoot("undo-absent");
	try {
		const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }]), fake.runner, stateRoot);
		const rows = undoPlugin(receipt, fake.runner);
		expect(rows).toEqual([{ profile: "default", status: "RESTORED" }]);
		expect(fake.calls).toEqual([["default", "plugin", "link", store], ["default", "plugin", "uninstall", "omp-kit-companion"]]);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("refuses a store nested inside a profile plugin directory", () => {
	expect(() => planPlugin("/fixture/user-home/.omp/plugins/node_modules/omp-kit-companion", [{ name: "default", configFiles: ["config.yml"], pluginDir: "/fixture/user-home/.omp/plugins" }])).toThrow("STORE_INSIDE_PROFILE_PLUGIN_DIR");
});
test("names a profile when postcheck loses its plugin rules", () => {
	const fake = runner();
	const stateRoot = makeStateRoot("postcheck");
	try {
		const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }, { name: "codex", configFiles: ["config.yml"] }]), { ...fake.runner, postcheck: profile => profile === "codex" ? { ok: false, reason: "POSTCHECK_PARTIAL:PLUGIN_RULES_DIR_MISSING" } : { ok: true } }, stateRoot);
		expect(receipt.rows.find(row => row.profile === "default")?.status).toBe("APPLIED");
		expect(receipt.rows.find(row => row.profile === "codex")).toMatchObject({ status: "PARTIAL", reason: "POSTCHECK_PARTIAL:PLUGIN_RULES_DIR_MISSING" });
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("plugin profile hashes cover the plugin tree and lock and record absence", () => {
	const scratchRoot = join(process.cwd(), "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(join(scratchRoot, "plugin-hash-test-"));
	writeFileSync(join(dir, ".owner"), `pid=${process.pid}\nlabel=plugin-hash-test\nrepo=${process.cwd()}\ncreated=${new Date().toISOString()}\n`);
	const plugins = join(dir, "plugins");
	mkdirSync(plugins);
	const lock = join(plugins, "omp-plugins.lock.json");
	writeFileSync(lock, "{}\n");
	try {
		const before = pluginProfileHashes(plugins);
		expect(before.plugins_dir_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(before.lock_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(pluginProfileHashes(plugins)).toEqual(before);

		writeFileSync(join(plugins, "installed_plugins.json"), "{}\n");
		const changedTree = pluginProfileHashes(plugins);
		expect(changedTree.plugins_dir_hash).not.toBe(before.plugins_dir_hash);
		expect(changedTree.lock_hash).toBe(before.lock_hash);

		writeFileSync(lock, "{\"plugins\":[]}\n");
		const changedLock = pluginProfileHashes(plugins);
		expect(changedLock.plugins_dir_hash).not.toBe(changedTree.plugins_dir_hash);
		expect(changedLock.lock_hash).not.toBe(changedTree.lock_hash);

		const absent = pluginProfileHashes(join(dir, "absent"));
		expect(absent.plugins_dir_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(absent.lock_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(pluginProfileHashes(join(dir, "absent"))).toEqual(absent);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
test("plugin package identity covers its manifest, rules, and extensions", () => {
	const stateRoot = makeStateRoot("package-hash");
	try {
		const packageDir = join(stateRoot, "package");
		mkdirSync(join(packageDir, "rules"), { recursive: true });
		mkdirSync(join(packageDir, "extensions"));
		writeFileSync(join(packageDir, "package.json"), "{\"name\":\"omp-kit-companion\"}\n");
		writeFileSync(join(packageDir, "rules", "rule.md"), "first\n");
		writeFileSync(join(packageDir, "extensions", "guard.ts"), "export default {};\n");
		const initial = pluginPackageHash(packageDir);
		expect(initial).toMatch(/^[0-9a-f]{64}$/);
		writeFileSync(join(packageDir, "README.md"), "not loaded by OMP\n");
		expect(pluginPackageHash(packageDir)).toBe(initial);
		writeFileSync(join(packageDir, "rules", "rule.md"), "changed\n");
		expect(pluginPackageHash(packageDir)).not.toBe(initial);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
const budgetReport = (status: "PASS" | "FAIL", stream: { complete: boolean; total_ms: number; budget_ms: number; by_rule: Array<{ rule: string; condition_index: number; ms: number }> }, measurements: Array<Record<string, unknown>>, lint_violations: Array<Record<string, unknown>> = []) =>
	`REGEX-BUDGET: ${status}\nJSON_REPORT=${JSON.stringify({
		status, engine: { bun: "1.4.0", omp_source: "/omp/src" }, load_average_before: [], load_average_after: [],
		rules_loaded: 2, conditions_measured: measurements.length,
		stream: { ...stream, file: "/fixture/stream", wire_bytes: 16, chunk_bytes: 16, deltas: 1 },
		measurements, lint_violations, gate_elapsed_ms: 1,
	})}\n`;

test("regex-budget output identifies failing rules and binds the exclusions to report bytes", () => {
	const output = budgetReport("FAIL", { complete: false, total_ms: 250, budget_ms: 500,
		by_rule: [{ rule: "rule-b", condition_index: 0, ms: 250 }] }, [
		{ rule: "rule-a", condition_index: 0, status: "TIMEOUT", literal: "needle", samples: [],
			failures: [{ code: "NEAR_MISS_TIMEOUT", message: "timeout" }] },
		{ rule: "rule-b", condition_index: 0, status: "MEASURED", literal: "needle", samples: [], stream_ms: 250, failures: [] },
	]);
	const result = analyzeRegexBudgetOutput(output);
	expect(result).toMatchObject({ status: "FAIL", excluded_rules: ["rule-a"], stream_total_ms: 250, stream_budget_ms: 500 });
	expect(result.report_sha256).toBe(createHash("sha256").update(output).digest("hex"));
});

test("regex-budget output attributes aggregate stream overage to measured contributors", () => {
	const result = analyzeRegexBudgetOutput(budgetReport("FAIL", { complete: true, total_ms: 550, budget_ms: 500,
		by_rule: [{ rule: "rule-a", condition_index: 0, ms: 300 }, { rule: "rule-b", condition_index: 0, ms: 250 }] }, [
		{ rule: "rule-a", condition_index: 0, status: "MEASURED", literal: "needle", samples: [], stream_ms: 300, failures: [] },
		{ rule: "rule-b", condition_index: 0, status: "MEASURED", literal: "needle", samples: [], stream_ms: 250, failures: [] },
	]));
	expect(result.excluded_rules).toEqual(["rule-a"]);
});

test("regex-budget output rejects missing reports and passes with no exclusions", () => {
	expect(() => analyzeRegexBudgetOutput("REGEX-BUDGET: PASS\n")).toThrow("REGEX_BUDGET_REPORT_MISSING");
	const result = analyzeRegexBudgetOutput(budgetReport("PASS", { complete: true, total_ms: 400, budget_ms: 500,
		by_rule: [{ rule: "rule-a", condition_index: 0, ms: 200 }, { rule: "rule-b", condition_index: 0, ms: 200 }] }, [
		{ rule: "rule-a", condition_index: 0, status: "MEASURED", literal: "needle", samples: [], stream_ms: 200, failures: [] },
		{ rule: "rule-b", condition_index: 0, status: "MEASURED", literal: "needle", samples: [], stream_ms: 200, failures: [] },
	]));
	expect(result.excluded_rules).toEqual([]);
});
test("runtime budget exclusions affect named profiles only and preserve user-disabled rules", () => {
	const output = budgetReport("FAIL", { complete: true, total_ms: 250, budget_ms: 500,
		by_rule: [{ rule: "rule-a", condition_index: 0, ms: 250 }] }, [
		{ rule: "rule-a", condition_index: 0, status: "TIMEOUT", literal: "needle", samples: [],
			stream_ms: 250, failures: [{ code: "NEAR_MISS_TIMEOUT", message: "timeout" }] },
	]);
	const budget = analyzeRegexBudgetOutput(output);
	const fake = runner();
	const defaultBefore = { ...fake.runner.snapshot("default"), installed: true, target: "/fixture/default-kit",
		version: "0.2.5", link_kind: "DIRECTORY" as const, package_hash: "same-content", disabled_rules: ["default-rule"] };
	const namedBefore = { ...fake.runner.snapshot("codex"), disabled_rules: ["user-rule"] };
	fake.state.set("default", defaultBefore);
	fake.state.set("codex", namedBefore);
	const plan = planPlugin(store, [
		{ name: "default", configFiles: ["config.yml"], pluginDir: "/fixture/default/plugins" },
		{ name: "codex", configFiles: ["config.yml"], pluginDir: "/fixture/codex/plugins" },
	], new Map([["default", defaultBefore], ["codex", namedBefore]]), {
		regex_budget: budget, store_version: "0.2.5", package_hash: "same-content", available_rules: ["rule-a"],
	});
	expect(plan.steps.map(step => [step.profile, step.action])).toEqual([["default", "UNCHANGED"], ["codex", "LINK"]]);
	expect(plan.steps[0]?.disabled_rules_after).toBeUndefined();
	expect(plan.steps[1]?.disabled_rules_after).toEqual(["user-rule", "rule-a"]);
	expect(plan.regex_budget?.report_sha256).toBe(budget.report_sha256);
});
test("same version with different package contents is not treated as loaded", () => {
	const before = { ...runner().runner.snapshot("default"), installed: true, target: "/fixture/old-kit",
		version: "0.2.5", package_hash: "old-content", link_kind: "DIRECTORY" as const };
	const plan = planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }],
		new Map([["default", before]]), { store_version: "0.2.5", package_hash: "new-content" });
	expect(plan.steps[0]?.action).toBe("LINK");
	expect(plan.steps[0]?.refusal_reason).toBeUndefined();
});

test("receipt undo restores runtime exclusions and refuses changed postimages", () => {
	const stateRoot = makeStateRoot("policy-undo");
	try {
		const output = budgetReport("FAIL", { complete: true, total_ms: 250, budget_ms: 500,
			by_rule: [{ rule: "rule-a", condition_index: 0, ms: 250 }] }, [
			{ rule: "rule-a", condition_index: 0, status: "TIMEOUT", literal: "needle", samples: [],
				stream_ms: 250, failures: [{ code: "NEAR_MISS_TIMEOUT", message: "timeout" }] },
		]);
		const budget = analyzeRegexBudgetOutput(output);
		const fake = runner();
		const before = { ...fake.runner.snapshot("codex"), disabled_rules: ["user-rule"] };
		fake.state.set("codex", before);
		const receipt = applyPlugin(planPlugin(store, [{ name: "codex", configFiles: ["config.yml"], pluginDir: "/fixture/codex/plugins" }],
			new Map([["codex", before]]), { regex_budget: budget, available_rules: ["rule-a"] }), fake.runner, stateRoot, output);
		expect(receipt.regex_budget?.report_sha256).toBe(budget.report_sha256);
		expect(receipt.regex_budget_report_file).toBe(`plugin-${receipt.id}.regex-budget.out`);
		expect(readFileSync(join(stateRoot, receipt.regex_budget_report_file!), "utf8")).toBe(output);
		expect(receipt.rows[0]).toMatchObject({ profile: "codex", status: "APPLIED", after: { disabled_rules: ["user-rule", "rule-a"] } });
		expect(undoPlugin(receipt, fake.runner)).toEqual([{ profile: "codex", status: "RESTORED" }]);
		expect(fake.runner.snapshot("codex")).toEqual(before);
		expect(fake.calls).toContainEqual(["codex", "config", "set", "ttsr.disabledRules", "[\"user-rule\",\"rule-a\"]"]);
		expect(fake.calls).toContainEqual(["codex", "config", "set", "ttsr.disabledRules", "[\"user-rule\"]"]);

		const secondReceipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }]), fake.runner, stateRoot);
		const postimage = fake.runner.snapshot("default");
		fake.state.set("default", { ...postimage, lock_hash: "concurrent-change" });
		expect(undoPlugin(secondReceipt, fake.runner)).toEqual([{ profile: "default", status: "REFUSED", reason: "POSTIMAGE_CHANGED" }]);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("budgeted apply requires the exact captured report before mutation", () => {
	const stateRoot = makeStateRoot("budget-report-required");
	try {
		const output = budgetReport("FAIL", { complete: true, total_ms: 250, budget_ms: 500,
			by_rule: [{ rule: "rule-a", condition_index: 0, ms: 250 }] }, [
			{ rule: "rule-a", condition_index: 0, status: "TIMEOUT", literal: "needle", samples: [],
				stream_ms: 250, failures: [{ code: "NEAR_MISS_TIMEOUT", message: "timeout" }] },
		]);
		const budget = analyzeRegexBudgetOutput(output);
		const fake = runner();
		const before = fake.runner.snapshot("codex");
		const plan = planPlugin(store, [{ name: "codex", configFiles: ["config.yml"], pluginDir: "/fixture/codex/plugins" }],
			new Map([["codex", before]]), { regex_budget: budget, available_rules: ["rule-a"] });
		expect(() => applyPlugin(plan, fake.runner, stateRoot)).toThrow("REGEX_BUDGET_REPORT_OUTPUT_REQUIRED");
		expect(() => applyPlugin(plan, fake.runner, stateRoot, `${output}\nchanged`)).toThrow("REGEX_BUDGET_PLAN_REPORT_MISMATCH");
		expect(fake.calls).toEqual([]);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("filesystem undo restores absent directories and exact plugin-lock bytes", () => {
	const stateRoot = makeStateRoot("filesystem-undo");
	try {
		const storePath = join(stateRoot, "store");
		mkdirSync(join(storePath, "rules"), { recursive: true });
		mkdirSync(join(storePath, "extensions"));
		writeFileSync(join(storePath, "package.json"), "{\"name\":\"omp-kit-companion\",\"version\":\"0.2.5\"}\n");
		writeFileSync(join(storePath, "rules", "rule.md"), "rule\n");
		const packageHash = pluginPackageHash(storePath);

		for (const initialLock of [null, "{\"plugins\":[\"other\"]}\n"] as const) {
			const profile = initialLock ? "codex-lock" : "codex-empty";
			const pluginDir = join(stateRoot, profile, "plugins");
			const nodeModulesDir = join(pluginDir, "node_modules");
			const linkPath = join(nodeModulesDir, "omp-kit-companion");
			const lockPath = join(pluginDir, "omp-plugins.lock.json");
			if (initialLock) {
				mkdirSync(nodeModulesDir, { recursive: true });
				writeFileSync(lockPath, initialLock);
			}

			const snapshot = (): PluginSnapshot => {
				const hashes = pluginProfileHashes(pluginDir);
				const linkKind = filesystemKind(linkPath);
				const target = linkKind === "SYMLINK" ? resolve(readlinkSync(linkPath)) : null;
				const lockKind = filesystemKind(lockPath);
				return {
					installed: linkKind === "SYMLINK" || linkKind === "DIRECTORY",
					target,
					link_path: linkPath,
					...hashes,
					package_hash: target ? pluginPackageHash(target) : null,
					link_target_text: linkKind === "SYMLINK" ? readlinkSync(linkPath) : null,
					version: target ? "0.2.5" : null,
					link_kind: linkKind,
					lock_kind: lockKind === "ABSENT" || lockKind === "FILE" || lockKind === "SYMLINK" ? lockKind : "OTHER",
					plugin_dir_present: filesystemKind(pluginDir) === "DIRECTORY",
					node_modules_present: filesystemKind(nodeModulesDir) === "DIRECTORY",
					disabled_rules: [],
				};
			};
			const testRunner: PluginRunner = {
				snapshot,
				invoke: (_name, args) => {
					mkdirSync(nodeModulesDir, { recursive: true });
					symlinkSync(args.at(-1)!, linkPath, "dir");
					writeFileSync(lockPath, "{\"plugins\":[\"omp-kit-companion\"]}\n");
					return { code: 0, stdout: "", stderr: "" };
				},
				postcheck: () => ({ ok: true }),
			};
			const before = snapshot();
			const receipt = applyPlugin(planPlugin(storePath, [{ name: profile, configFiles: ["config.yml"], pluginDir }],
				new Map([[profile, before]]), { package_hash: packageHash }), testRunner, stateRoot);
			expect(receipt.rows[0]).toMatchObject({
				status: "APPLIED",
				backup: { lock_state: initialLock ? "FILE" : "ABSENT" },
			});
			expect(undoPlugin(receipt, testRunner, stateRoot)).toEqual([{ profile, status: "RESTORED" }]);
			const restored = snapshot();
			expect(restored.plugins_dir_hash).toBe(before.plugins_dir_hash);
			expect(restored.lock_hash).toBe(before.lock_hash);
			expect(restored.lock_kind).toBe(before.lock_kind);
			expect(restored.plugin_dir_present).toBe(before.plugin_dir_present);
			expect(restored.node_modules_present).toBe(before.node_modules_present);
			if (initialLock) expect(readFileSync(lockPath, "utf8")).toBe(initialLock);
		}
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
test("directory-backed default plugin is replaced with an exact reversible backup", () => {
	const stateRoot = makeStateRoot("directory-undo");
	try {
		const storePath = join(stateRoot, "store");
		mkdirSync(join(storePath, "rules"), { recursive: true });
		mkdirSync(join(storePath, "extensions"));
		writeFileSync(join(storePath, "package.json"), "{\"name\":\"omp-kit-companion\",\"version\":\"0.2.5\"}\n");
		writeFileSync(join(storePath, "rules", "new.md"), "new rule\n");
		writeFileSync(join(storePath, "extensions", "guard.ts"), "export default {};\n");

		const profile = "default";
		const pluginDir = join(stateRoot, "home", "plugins");
		const nodeModulesDir = join(pluginDir, "node_modules");
		const linkPath = join(nodeModulesDir, "omp-kit-companion");
		const lockPath = join(pluginDir, "omp-plugins.lock.json");
		mkdirSync(join(linkPath, "rules"), { recursive: true });
		mkdirSync(join(linkPath, "extensions"));
		writeFileSync(join(linkPath, "package.json"), "{\"name\":\"omp-kit-companion\",\"version\":\"0.2.5\"}\n");
		writeFileSync(join(linkPath, "rules", "old.md"), "old rule\n");
		writeFileSync(join(linkPath, "extensions", "guard.ts"), "export default {};\n");
		const originalLock = "{\"plugins\":{\"other\":{\"version\":\"1\"}}}\n";
		writeFileSync(lockPath, originalLock);

		const snapshot = (): PluginSnapshot => {
			const hashes = pluginProfileHashes(pluginDir);
			const linkKind = filesystemKind(linkPath);
			const target = linkKind === "SYMLINK" ? resolve(readlinkSync(linkPath)) : null;
			const packageRoot = target ?? (linkKind === "DIRECTORY" ? linkPath : null);
			const lockKind = filesystemKind(lockPath);
			return {
				installed: packageRoot !== null,
				target,
				link_path: linkPath,
				...hashes,
				package_hash: packageRoot ? pluginPackageHash(packageRoot) : null,
				link_target_text: linkKind === "SYMLINK" ? readlinkSync(linkPath) : null,
				version: packageRoot ? JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version : null,
				link_kind: linkKind,
				lock_kind: lockKind === "ABSENT" || lockKind === "FILE" || lockKind === "SYMLINK" ? lockKind : "OTHER",
				plugin_dir_present: filesystemKind(pluginDir) === "DIRECTORY",
				node_modules_present: filesystemKind(nodeModulesDir) === "DIRECTORY",
				disabled_rules: [],
			};
		};
		const runnerWithFilesystem: PluginRunner = {
			snapshot,
			invoke: (_name, args) => {
				rmSync(linkPath, { recursive: true, force: true });
				symlinkSync(args.at(-1)!, linkPath, "dir");
				writeFileSync(lockPath, "{\"plugins\":{\"omp-kit-companion\":{\"version\":\"0.2.5\"}}}\n");
				return { code: 0, stdout: "", stderr: "" };
			},
			postcheck: () => ({ ok: true }),
		};
		const before = snapshot();
		const storePackageHash = pluginPackageHash(storePath);
		const plan = planPlugin(storePath, [{ name: profile, configFiles: ["config.yml"], pluginDir }],
			new Map([[profile, before]]), { package_hash: storePackageHash });
		expect(plan.steps[0]?.action).toBe("LINK");
		const receipt = applyPlugin(plan, runnerWithFilesystem, stateRoot);
		expect(receipt.rows[0]).toMatchObject({
			status: "APPLIED",
			backup: { package_state: "DIRECTORY", lock_state: "FILE" },
		});
		expect(undoPlugin(receipt, runnerWithFilesystem, stateRoot)).toEqual([{ profile, status: "RESTORED" }]);
		const restored = snapshot();
		expect(restored.plugins_dir_hash).toBe(before.plugins_dir_hash);
		expect(restored.lock_hash).toBe(before.lock_hash);
		expect(restored.package_hash).toBe(before.package_hash);
		expect(restored.link_kind).toBe("DIRECTORY");
		expect(readFileSync(join(linkPath, "rules", "old.md"), "utf8")).toBe("old rule\n");
		expect(readFileSync(lockPath, "utf8")).toBe(originalLock);
	} finally {
		rmSync(stateRoot, { recursive: true, force: true });
	}
});
