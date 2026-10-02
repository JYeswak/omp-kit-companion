import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readManifest } from "./diagnostics.ts";
import { applyMutation, planMutation, type FileMutation, type MutationPlan } from "./mutations.ts";
import { resolveOmpIdentity } from "./paths.ts";

/**
 * B3: migrate legacy kit rule installs (~/.agents/rules) to native plugin layering.
 *
 * The plan is read-only and lists every legacy file with its plugin equivalent and byte
 * diff. Apply backs every kit file up first, removes ONLY copies byte-identical to what
 * the installed plugin serves, keeps edited copies in place flagged for the C3 overlay,
 * and verifies with `omp ttsr list` that each removed rule still resolves from a
 * non-legacy source. Undo is the standard mutation receipt (`omp-kit undo <id>`).
 * Without an installed plugin serving the rules, apply refuses (fail-closed): removing
 * the legacy copies would orphan the rules.
 */

export type MigrateVerdict = "identical-to-plugin" | "identical-to-manifest" | "edited" | "unknown-keep";
export type OmpRunner = (args: readonly string[]) => OmpRunResult;

export interface PluginRule { name: string; path: string; sha256: string }
export type MigrateVerdict = "identical-to-plugin" | "edited" | "unknown-keep";
export interface MigrateRow { name: string; file: string; legacySha256: string; manifestSha256: string | null; pluginSha256: string | null; pluginPath: string | null; verdict: MigrateVerdict; overlay: boolean; firstDiffLine: number | null }
export interface MigratePlan { rows: readonly MigrateRow[]; pluginRules: number; pluginAbsent: boolean; backupDir: string | null; removable: number; kept: number }
export interface MigrateVerifyRow { name: string; provider: string | null; path: string | null }
export interface MigrateResult { receiptId: string | null; backupDir: string; removed: string[]; kept: string[]; verified: MigrateVerifyRow[] }

export interface MigrateInput { root: string; home: string; stateRoot?: string; ompLauncher?: string; run?: OmpRunner }

const hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function fail(code: string): never {
	throw new Error(code);
}

interface TtsrEntry { name: unknown; path: unknown; provider: unknown }

function asTtsrEntry(raw: unknown): TtsrEntry | null {
	if (!raw || typeof raw !== "object") return null;
	if (!("name" in raw) || !("path" in raw) || !("provider" in raw)) return null;
	return { name: raw.name, path: raw.path, provider: raw.provider };
}

function ttsrItems(data: unknown): unknown[] | null {
	if (Array.isArray(data)) return data;
	if (data && typeof data === "object" && "rules" in data && Array.isArray(data.rules)) return data.rules;
	return null;
}

/** Kit rules currently served by an installed plugin, with their on-disk bytes. */
function readBytesNoFollow(path: string): Buffer | null {
	try {
		if (lstatSync(path).isSymbolicLink()) return null;
		return readFileSync(path);
	} catch {
		return null;
	}
}

export function defaultOmpRunner(args: readonly string[]): OmpRunResult {
	try {
		const child = Bun.spawnSync([...args], { stdout: "pipe", stderr: "pipe" });
		return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
	} catch (error) {
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

export function resolveLauncher(input: MigrateInput): string {
	if (input.ompLauncher) return input.ompLauncher;
	try {
		return resolveOmpIdentity(process.env).launcher;
	} catch {
		fail("OMP_UNAVAILABLE");
	}
}

export function listPluginRules(launcher: string, run: OmpRunner): PluginRule[] {
	const out = run([launcher, "ttsr", "list", "--json"]);
	if (out.code !== 0) fail("PLUGIN_LIST_FAILED");
	let data: unknown;
	try {
		data = JSON.parse(out.stdout);
	} catch {
		fail("PLUGIN_LIST_FAILED");
	}
	const items = ttsrItems(data);
	if (items === null) fail("PLUGIN_LIST_FAILED");
	const rules: PluginRule[] = [];
	for (const raw of items) {
		const item = asTtsrEntry(raw);
		if (!item || item.provider !== "omp-plugins" || typeof item.name !== "string" || typeof item.path !== "string") continue;
		const bytes = readBytesNoFollow(item.path);
		if (bytes === null) continue;
		rules.push({ name: item.name, path: item.path, sha256: hex(bytes) });
	}
	return rules;
}

function firstDiffLine(a: Buffer, b: Buffer): number | null {
	if (a.equals(b)) return null;
	const linesA = a.toString("utf8").split("\n");
	const linesB = b.toString("utf8").split("\n");
	const count = Math.max(linesA.length, linesB.length);
	for (let line = 0; line < count; line++) {
		if (linesA[line] !== linesB[line]) return line + 1;
	}
	return count + 1;
}

function legacyDir(home: string): string {
	const agents = join(home, ".agents");
	const dir = join(agents, "rules");
	for (const component of [agents, dir]) {
		try {
			if (lstatSync(component).isSymbolicLink()) fail("UNSAFE_PATH");
		} catch (error) {
			if (error instanceof Error && error.message === "UNSAFE_PATH") throw error;
		}
	}
	return dir;
}

export function planMigration(input: MigrateInput): MigratePlan {
	if (!isAbsolute(input.home) || resolve(input.home) !== input.home) fail("UNSAFE_PATH");
	const run = input.run ?? defaultOmpRunner;
	const launcher = resolveLauncher(input);
	const pluginRules = listPluginRules(launcher, run);
	const pluginByName = new Map(pluginRules.map(rule => [rule.name, rule]));
	const manifest = readManifest(input.root);
	if (manifest.sourceUnverified) fail("SOURCE_INVALID");
	const manifestByName = new Map(manifest.rules.map(rule => [rule.name, rule.sha256]));
	const rulesDir = legacyDir(input.home);
	let legacyFiles: string[];
	try {
		legacyFiles = readdirSync(rulesDir).filter(name => name.endsWith(".md")).sort();
	} catch {
		legacyFiles = [];
	}
	const rows: MigrateRow[] = [];
	for (const file of legacyFiles) {
		const name = file.slice(0, -3);
		const full = join(legacyDir(input.home), file);
		try {
			if (lstatSync(full).isSymbolicLink()) fail("UNSAFE_PATH");
		} catch (error) {
			if (error instanceof Error && error.message === "UNSAFE_PATH") throw error;
		}
		const bytes = readBytesNoFollow(full);
		if (bytes === null) continue;
		const legacySha256 = hex(bytes);
		const manifestSha256 = manifestByName.get(name) ?? null;
		const plugin = pluginByName.get(name) ?? null;
		let pluginBytes: Buffer | null = null;
		if (plugin) pluginBytes = readBytesNoFollow(plugin.path);
		const pluginSha256 = pluginBytes === null ? null : hex(pluginBytes);
		if (manifestSha256 === null) {
			rows.push({ name, file: `.agents/rules/${file}`, legacySha256, manifestSha256, pluginSha256, pluginPath: plugin?.path ?? null, verdict: "unknown-keep", overlay: false, firstDiffLine: null });
		} else if (pluginSha256 !== null && legacySha256 === pluginSha256) {
			rows.push({ name, file: `.agents/rules/${file}`, legacySha256, manifestSha256, pluginSha256, pluginPath: plugin?.path ?? null, verdict: "identical-to-plugin", overlay: false, firstDiffLine: null });
		} else if (legacySha256 === manifestSha256) {
			rows.push({ name, file: `.agents/rules/${file}`, legacySha256, manifestSha256, pluginSha256, pluginPath: plugin?.path ?? null, verdict: "identical-to-manifest", overlay: false, firstDiffLine: null });
		} else {
			rows.push({ name, file: `.agents/rules/${file}`, legacySha256, manifestSha256, pluginSha256, pluginPath: plugin?.path ?? null, verdict: "edited", overlay: true,
				firstDiffLine: pluginBytes === null ? null : firstDiffLine(bytes, pluginBytes) });
		}
	}
	const removable = rows.filter(row => row.verdict === "identical-to-plugin").length;
	return { rows: Object.freeze(rows), pluginRules: pluginRules.length,
		pluginAbsent: pluginRules.length === 0, backupDir: null, removable,
		kept: rows.length - removable };
}

const preparedMutations = new WeakMap<MigratePlan, MutationPlan>();

export function planMigrationMutation(plan: MigratePlan, input: MigrateInput): void {
	if (plan.removable === 0) return;
	const stateRoot = input.stateRoot ?? join(input.home, ".local", "state", "omp-kit");
	const mutations: FileMutation[] = [];
	for (const row of plan.rows) {
		if (row.verdict !== "identical-to-plugin") continue;
		const bytes = readBytesNoFollow(join(input.home, row.file));
		if (bytes === null || hex(bytes) !== row.legacySha256) fail("FRESH_PLAN");
		mutations.push({ root: "home", relativePath: row.file,
			expectedBefore: { sha256: row.legacySha256, size: bytes.length, mode: 0o644, uid: process.getuid!(), gid: process.getgid!() },
			after: null });
	}
	if (mutations.length === 0) return;
	preparedMutations.set(plan, planMutation({ stateRoot, roots: [{ id: "home", path: input.home }], files: mutations }));
}

export function applyMigration(plan: MigratePlan, input: MigrateInput, options: { confirmed: true }): MigrateResult {
	if (options?.confirmed !== true) fail("INVALID_PLAN");
	if (plan.pluginAbsent) fail("PLUGIN_ABSENT");
	const prepared = preparedMutations.get(plan);
	if (plan.removable > 0 && !prepared) fail("FRESH_PLAN");
	const run = input.run ?? defaultOmpRunner;
	const launcher = resolveLauncher(input);
	const stateRoot = input.stateRoot ?? join(input.home, ".local", "state", "omp-kit");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupDir = join(stateRoot, "migrate-backups", stamp);
	let receiptId: string | null = null;
	const removed: string[] = [];
	if (prepared) {
		mkdirSync(backupDir, { recursive: true, mode: 0o700 });
		for (const row of plan.rows) {
			const bytes = readBytesNoFollow(join(input.home, row.file));
			if (bytes === null) fail("FRESH_PLAN");
			writeFileSync(join(backupDir, `${row.name}.md`), bytes, { mode: 0o600 });
		}
		const receipt = applyMutation(prepared);
		receiptId = receipt.id;
		removed.push(...plan.rows.filter(row => row.verdict === "identical-to-plugin").map(row => row.name));
	}
	const verifyOut = run([launcher, "ttsr", "list", "--json"]);
	if (verifyOut.code !== 0) fail("MIGRATE_VERIFY_FAILED");
	let verifyData: unknown;
	try {
		verifyData = JSON.parse(verifyOut.stdout);
	} catch {
		fail("MIGRATE_VERIFY_FAILED");
	}
	const rawItems = ttsrItems(verifyData);
	if (rawItems === null) fail("MIGRATE_VERIFY_FAILED");
	const items = rawItems.map(asTtsrEntry).filter((entry): entry is TtsrEntry => entry !== null);
	const legacyPrefix = join(input.home, ".agents", "rules") + "/";
	const verified: MigrateVerifyRow[] = [];
	for (const name of removed) {
		const matches = items.filter(entry => entry.name === name);
		const legacy = matches.filter(entry => typeof entry.path === "string" && entry.path.startsWith(legacyPrefix));
		if (legacy.length > 0 || matches.length === 0) fail("MIGRATE_VERIFY_FAILED");
		const winner = matches[0]!;
		verified.push({ name, provider: typeof winner.provider === "string" ? winner.provider : null,
			path: typeof winner.path === "string" ? winner.path : null });
	}
	const kept = plan.rows.filter(row => row.verdict !== "identical-to-plugin").map(row => row.name);
	return { receiptId, backupDir, removed, kept, verified };
}
