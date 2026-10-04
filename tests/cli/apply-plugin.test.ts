import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { applyPlugin, planPlugin, undoPlugin, type PluginRunner, type PluginSnapshot } from "../../src/apply-plugin.ts";

const store = "/fixture/releases/0.2.5";
const root = join(process.cwd(), "var", "agent-tmp", "prof1-fixture");

function runner(): { runner: PluginRunner; calls: string[][] } {
	const calls: string[][] = [];
	const state = new Map<string, PluginSnapshot>();
	return { calls, runner: { snapshot: profile => state.get(profile) ?? { installed: false, target: null, plugins_dir_hash: null, lock_hash: null }, invoke: (profile, args) => { calls.push([profile, ...args]); state.set(profile, { installed: args[1] === "link", target: args[1] === "link" ? args[2]! : null, plugins_dir_hash: "after", lock_hash: "after" }); return { code: 0, stdout: "", stderr: "" }; } } };
}

test("plans all writable profiles and names DUAL_CONFIG skips", () => {
	const plan = planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }, { name: "codex", configFiles: ["config.yml"] }, { name: "claude", configFiles: ["config.yml", "config.yaml"] }]);
	expect(plan.steps.map(step => step.profile)).toEqual(["default", "codex"]);
	expect(plan.skipped).toEqual([{ profile: "claude", reason: "DUAL_CONFIG" }]);
});

test("applies per-profile links and persists one receipt", () => {
	const fake = runner();
	const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }]), fake.runner, root);
	expect(receipt.rows[0]).toMatchObject({ profile: "default", status: "APPLIED" });
	expect(fake.calls[0]).toEqual(["default", "plugin", "link", store]);
	const receiptPath = join(root, `plugin-${receipt.id}.json`);
	expect(existsSync(receiptPath)).toBe(true);
	expect(JSON.parse(readFileSync(receiptPath, "utf8")).schema_version).toBe(1);
});

test("undo restores an absent prior plugin", () => {
	const fake = runner();
	const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }]), fake.runner, root);
	const rows = undoPlugin(receipt, fake.runner);
	expect(rows).toEqual([{ profile: "default", status: "RESTORED" }]);
	expect(fake.calls).toEqual([["default", "plugin", "link", store]]);
});
test("refuses a store nested inside a profile plugin directory", () => {
	expect(() => planPlugin("/fixture/home/.omp/plugins/node_modules/omp-kit-companion", [{ name: "default", configFiles: ["config.yml"], pluginDir: "/fixture/home/.omp/plugins" }])).toThrow("STORE_INSIDE_PROFILE_PLUGIN_DIR");
});
test("names a profile when postcheck loses its plugin rules", () => {
	const fake = runner();
	const receipt = applyPlugin(planPlugin(store, [{ name: "default", configFiles: ["config.yml"] }, { name: "codex", configFiles: ["config.yml"] }]), { ...fake.runner, postcheck: profile => profile === "codex" ? { ok: false, reason: "POSTCHECK_PARTIAL:PLUGIN_RULES_DIR_MISSING" } : { ok: true } }, root);
	expect(receipt.rows.find(row => row.profile === "default")?.status).toBe("APPLIED");
	expect(receipt.rows.find(row => row.profile === "codex")).toMatchObject({ status: "REFUSED", reason: "POSTCHECK_PARTIAL:PLUGIN_RULES_DIR_MISSING" });
});
