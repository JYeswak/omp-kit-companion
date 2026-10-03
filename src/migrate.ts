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

export type MigrateVerdict = "identical-to-plugin" | "identical-to-manifest" | "stale-kit-version" | "edited" | "unknown-keep";
export type OmpRunner = (args: readonly string[]) => OmpRunResult;

export interface PluginRule { name: string; path: string; sha256: string }
export interface MigrateRow { name: string; file: string; legacySha256: string; manifestSha256: string | null; pluginSha256: string | null; pluginPath: string | null; verdict: MigrateVerdict; overlay: boolean; overlayPath: string | null; unlisted: boolean; firstDiffLine: number | null; diff: string | null }
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

function releasedRuleHashes(root: string): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(root, "rules", "released-sha256.json"), "utf8"));
		const releases = parsed && typeof parsed === "object" && "releases" in parsed ? parsed.releases : null;
		if (!releases || typeof releases !== "object") return result;
		for (const rules of Object.values(releases as Record<string, unknown>)) {
			if (!rules || typeof rules !== "object") continue;
			for (const [name, value] of Object.entries(rules as Record<string, unknown>)) {
				if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) continue;
				const hashes = result.get(name) ?? new Set<string>();
				hashes.add(value);
				result.set(name, hashes);
			}
		}
	} catch {
		// Older source trees have no history artifact; they remain fail-closed.
	}
	return result;
}

function isRemovable(row: Pick<MigrateRow, "verdict">): boolean {
	return row.verdict === "identical-to-plugin" || row.verdict === "stale-kit-version";
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

type DiffOp = { kind: "equal" | "del" | "ins"; a: number; b: number };

/** Minimal unified diff for small text files (rule files, not arbitrary blobs). */
export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string): string {
	const a = aText.split("\n");
	const b = bText.split("\n");
	if (a.length * b.length > 250000) {
		return `--- ${aLabel}\n+++ ${bLabel}\n@@ -1,${a.length} +1,${b.length} @@\n(files differ; too large for a line diff)\n`;
	}
	const width = b.length + 1;
	const table = new Array<number>((a.length + 1) * width).fill(0);
	const at = (i: number, j: number): number => table[i * width + j]!;
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
		}
	}
	const ops: DiffOp[] = [];
	let i = 0, j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { ops.push({ kind: "equal", a: i, b: j }); i++; j++; }
		else if (j >= b.length || (i < a.length && at(i + 1, j) >= at(i, j + 1))) { ops.push({ kind: "del", a: i, b: j }); i++; }
		else { ops.push({ kind: "ins", a: i, b: j }); j++; }
	}
	const context = 3;
	const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
	let k = 0;
	while (k < ops.length) {
		if (ops[k]!.kind === "equal") { k++; continue; }
		const start = Math.max(0, k - context);
		let end = k + 1;
		for (;;) {
			let next = end;
			while (next < ops.length && ops[next]!.kind === "equal") next++;
			if (next >= ops.length || next - end > 2 * context) { end = Math.min(ops.length, end + context); break; }
			end = next + 1;
		}
		const body = ops.slice(start, end);
		const aCount = body.filter(op => op.kind !== "ins").length;
		const bCount = body.filter(op => op.kind !== "del").length;
		let aStart = body[0]!.a + 1;
		let bStart = body[0]!.b + 1;
		if (body[0]!.kind === "ins" && aCount === 0) aStart = body[0]!.a;
		if (body[0]!.kind === "del" && bCount === 0) bStart = body[0]!.b;
		out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
		for (const op of body) {
			const line = op.kind === "ins" ? b[op.b]! : a[op.a]!;
			out.push(`${op.kind === "equal" ? " " : op.kind === "del" ? "-" : "+"}${line}`);
		}
		k = end;
	}
	return `${out.join("\n")}\n`;
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
	const releasedByName = releasedRuleHashes(input.root);
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
		const base = { name, file: ".agents/rules/" + file, legacySha256, manifestSha256, pluginSha256, pluginPath: plugin?.path ?? null };
		const unlisted = manifestSha256 !== null && pluginSha256 === null && pluginRules.length > 0;
		const staleKitVersion = pluginSha256 !== null && (releasedByName.get(name)?.has(legacySha256) ?? false);
		if (pluginSha256 !== null && legacySha256 === pluginSha256) {
			rows.push({ ...base, verdict: "identical-to-plugin", overlay: false, overlayPath: null, unlisted: false, firstDiffLine: null, diff: null });
		} else if (staleKitVersion) {
			rows.push({ ...base, verdict: "stale-kit-version", overlay: false, overlayPath: null, unlisted, firstDiffLine: firstDiffLine(bytes, pluginBytes!), diff: null });
		} else if (manifestSha256 === null && pluginSha256 === null) {
			rows.push({ ...base, verdict: "unknown-keep", overlay: false, overlayPath: null, unlisted: false, firstDiffLine: null, diff: null });
		} else if (manifestSha256 !== null && legacySha256 === manifestSha256) {
			rows.push({ ...base, verdict: "identical-to-manifest", overlay: false, overlayPath: null, unlisted, firstDiffLine: null, diff: null });
		} else {
			const manifestBytes = readBytesNoFollow(join(input.root, "rules", name + ".md"));
			const shipped = pluginBytes ?? manifestBytes;
			rows.push({ ...base, verdict: "edited", overlay: true, overlayPath: ".omp/agent/rules/" + name + ".md", unlisted,
				firstDiffLine: pluginBytes === null ? null : firstDiffLine(bytes, pluginBytes),
				diff: shipped === null ? null : unifiedDiff(bytes.toString("utf8"), shipped.toString("utf8"),
					"a/.agents/rules/" + file + " (legacy)", pluginBytes !== null ? "b/plugin/" + name + ".md" : "b/manifest/" + name + ".md") });
		}
	}
	const removable = rows.filter(isRemovable).length;
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
		if (!isRemovable(row)) continue;
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
		removed.push(...plan.rows.filter(isRemovable).map(row => row.name));
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
	const kept = plan.rows.filter(row => !isRemovable(row)).map(row => row.name);
	return { receiptId, backupDir, removed, kept, verified };
}
