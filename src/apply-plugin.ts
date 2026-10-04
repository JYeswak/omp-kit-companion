import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PluginProfile { name: string; configFiles: readonly string[]; pluginDir?: string; writable?: boolean }
export interface PluginSnapshot { installed: boolean; target: string | null; plugins_dir_hash: string | null; lock_hash: string | null }
export interface PluginStep { profile: string; command: readonly string[]; before: PluginSnapshot | null }
export interface PluginPlan { store: string; steps: readonly PluginStep[]; skipped: readonly { profile: string; reason: string }[] }
export interface PluginReceipt { schema_version: 1; id: string; store: string; created_at: string; rows: readonly { profile: string; status: "APPLIED" | "REFUSED" | "SKIPPED"; before: PluginSnapshot | null; after: PluginSnapshot | null; reason?: string }[] }
export interface PluginRunner { snapshot(profile: string): PluginSnapshot; invoke(profile: string, args: readonly string[]): { code: number; stdout: string; stderr: string } }

function profileArgs(profile: string, command: "link" | "unlink", target: string): readonly string[] {
	return ["omp", ...(profile === "default" ? [] : ["--profile", profile]), "plugin", command, target];
}

export function planPlugin(store: string, profiles: readonly PluginProfile[], snapshots: ReadonlyMap<string, PluginSnapshot> = new Map()): PluginPlan {
	if (!store.startsWith("/") || store.endsWith("/")) throw new Error("plugin store must be an absolute directory");
	const storePath = resolve(store);
	const steps: PluginStep[] = [];
	const skipped: { profile: string; reason: string }[] = [];
	for (const profile of profiles) {
		if (profile.pluginDir) {
			const pluginDir = resolve(profile.pluginDir);
			if (storePath === pluginDir || storePath.startsWith(`${pluginDir}/`)) throw new Error("STORE_INSIDE_PROFILE_PLUGIN_DIR");
		}
		if (profile.configFiles.includes("config.yml") && profile.configFiles.includes("config.yaml")) {
			skipped.push({ profile: profile.name, reason: "DUAL_CONFIG" });
			continue;
		}
		if (profile.writable === false) {
			skipped.push({ profile: profile.name, reason: "PROFILE_UNWRITABLE" });
			continue;
		}
		steps.push({ profile: profile.name, command: profileArgs(profile.name, "link", store), before: snapshots.get(profile.name) ?? null });
	}
	return { store, steps, skipped };
}

export function applyPlugin(plan: PluginPlan, runner: PluginRunner, stateRoot: string): PluginReceipt {
	const rows: Array<PluginReceipt["rows"][number]> = [...plan.skipped.map(item => ({ profile: item.profile, status: "SKIPPED" as const, before: null, after: null, reason: item.reason }))];
	for (const step of plan.steps) {
		const before = step.before ?? runner.snapshot(step.profile);
		const result = runner.invoke(step.profile, step.command.slice(1));
		if (result.code !== 0) {
			rows.push({ profile: step.profile, status: "REFUSED", before, after: runner.snapshot(step.profile), reason: result.stderr || `plugin link exited ${result.code}` });
			continue;
		}
		rows.push({ profile: step.profile, status: "APPLIED", before, after: runner.snapshot(step.profile) });
	}
	const receipt: PluginReceipt = { schema_version: 1, id: randomUUID(), store: plan.store, created_at: new Date().toISOString(), rows };
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	const path = join(stateRoot, `plugin-${receipt.id}.json`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
	return receipt;
}

export function undoPlugin(receipt: PluginReceipt, runner: PluginRunner): readonly { profile: string; status: "RESTORED" | "REFUSED"; reason?: string }[] {
	const rows: { profile: string; status: "RESTORED" | "REFUSED"; reason?: string }[] = [];
	for (const row of receipt.rows) {
		if (row.status !== "APPLIED") continue;
		const target = row.before?.target;
		const args = profileArgs(row.profile, target ? "link" : "unlink", target ?? receipt.store).slice(1);
		const result = runner.invoke(row.profile, args);
		rows.push(result.code === 0 ? { profile: row.profile, status: "RESTORED" } : { profile: row.profile, status: "REFUSED", reason: result.stderr || `plugin undo exited ${result.code}` });
	}
	return rows;
}

export function readPluginReceipt(path: string): PluginReceipt {
	return JSON.parse(readFileSync(path, "utf8")) as PluginReceipt;
}
