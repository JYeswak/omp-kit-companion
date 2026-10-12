import { lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { applyKitUpdate, planKitUpdate, type KitUpdateInput, type KitUpdatePlan, type KitUpdatePreview, type KitUpdateRefusal, type KitUpdateResult } from "./kit-update.ts";

export type KitUpdateJobConfig = Omit<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag"> & {
	enabled: boolean;
	/**
	 * Certified static fallback; null when the job is poll-only (no local
	 * tuple configured). A null fallback with nothing newer published is
	 * CURRENT, not a refusal.
	 */
	pollRelease: () => Promise<Pick<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag"> | null>;
};
export type PluginRelinkResult =
	| { ok: true; detail: string; receiptId: string; undoCommand: string }
	| { ok: false; detail: string; receiptId?: string; undoCommand?: string };
export type KitUpdateJobDependencies = {
	plan?: (input: KitUpdateInput) => Promise<KitUpdatePreview>;
	apply?: (plan: KitUpdatePlan) => Promise<KitUpdateResult>;
	notify?: (message: string) => Promise<void> | void;
	/** Test seam for GitHub and plugin relink commands. Production uses spawnSync. */
	exec?: (argv: readonly string[]) => Promise<{ exit: number; stdout: string; stderr: string }>;
	relink?: (binary: string, store: string) => Promise<PluginRelinkResult>;
	/** Test seam for the new binary's `service install kit-update --apply --yes`. Production uses spawnSync. */
	reconcile?: (binary: string) => Promise<{ ok: boolean; detail: string }>;
};
export type KitUpdateJobResult = { status: "DISABLED" | "CURRENT" | "UPDATED" | "REFUSED" | "UNDONE" | "FAILED"; receiptId: string | null; activeVersion: string | null; notification: boolean; reason?: string; relink?: "APPLIED" | "FAILED" | "NOT_RUN"; pluginReceiptId?: string; pluginUndoCommand?: string; service?: "APPLIED" | "FAILED" | "NOT_RUN" };

/** owner/repo slug for OMP_KIT_UPDATE_REPO; shared by the service renderer and the CLI gate. */
export const KIT_UPDATE_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const PLATFORMS: Record<string, string> = {
	"darwin/arm64/none": "darwin-arm64-none",
	"linux/arm64/gnu": "linux-arm64-gnu",
	"linux/x64/gnu": "linux-x64-gnu",
};

function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1; }
	return 0;
}

function defaultExec(argv: readonly string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
	const child = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
	return Promise.resolve({ exit: child.status ?? 1, stdout: String(child.stdout ?? ""), stderr: String(child.stderr ?? "") });
}
type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as JsonObject
		: null;
}

function pluginSnapshotTargetsStore(value: unknown, store: string, packageHash: string): boolean {
	const snapshot = asJsonObject(value);
	if (!snapshot) return false;
	if (snapshot.link_kind === "SYMLINK") return snapshot.target === store;
	return snapshot.link_kind === "DIRECTORY" && snapshot.package_hash === packageHash;
}

/** Apply the installed release to every discovered OMP profile and validate its durable receipt. */
export async function relinkKitPlugin(
	binary: string,
	store: string,
	exec: (argv: readonly string[]) => Promise<{ exit: number; stdout: string; stderr: string }> = defaultExec,
): Promise<PluginRelinkResult> {
	if (resolve(store) !== store)
		return { ok: false, detail: "plugin store path is not absolute and canonical" };
	let ran: { exit: number; stdout: string; stderr: string };
	try {
		ran = await exec([binary, "apply", "plugin", "--apply", "--yes", "--store", store, "--profiles", "all", "--include-default", "--json"]);
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) };
	}
	const output = (ran.stdout + ran.stderr).replaceAll("\n", " ").replaceAll("\r", " ").trim().slice(-500);
	let envelope: JsonObject | null = null;
	try { envelope = asJsonObject(JSON.parse(ran.stdout)); } catch {}
	const data = asJsonObject(envelope?.data);
	const receiptId = typeof data?.receipt_id === "string" && data.receipt_id.length > 0 ? data.receipt_id : undefined;
	const undoCommand = receiptId ? `omp-kit undo ${receiptId} --yes` : undefined;
	const failure = (detail: string): PluginRelinkResult => ({
		ok: false,
		detail: output ? `${detail}: ${output}` : detail,
		...(receiptId && undoCommand ? { receiptId, undoCommand } : {}),
	});
	if (ran.exit !== 0 || ran.stderr.trim() !== "" || envelope?.ok !== true)
		return failure(`plugin apply exited ${ran.exit}`);
	if (!data || data.action !== "APPLIED" || data.store !== store || !receiptId || !undoCommand)
		return failure("plugin apply returned no complete applied receipt");
	const packageHash = typeof data.package_hash === "string" ? data.package_hash : null;
	const rows = Array.isArray(data.rows) ? data.rows.map(asJsonObject) : null;
	const steps = Array.isArray(data.steps) ? data.steps.map(asJsonObject) : null;
	const skipped = Array.isArray(data.skipped) ? data.skipped : null;
	if (!packageHash || !rows || rows.length === 0 || !steps || !skipped || skipped.length !== 0 ||
		rows.length !== steps.length || rows.some(row => !row) || steps.some(step => !step))
		return failure("plugin apply receipt does not cover every selected profile");
	const rowNames = rows.flatMap(row => typeof row?.profile === "string" ? [row.profile] : []);
	const stepNames = steps.flatMap(step => typeof step?.profile === "string" ? [step.profile] : []);
	const selected = new Set(stepNames);
	if (rowNames.length !== rows.length || stepNames.length !== steps.length ||
		new Set(rowNames).size !== rowNames.length || selected.size !== stepNames.length ||
		rowNames.length !== selected.size || rowNames.some(name => !selected.has(name)) || !rowNames.includes("default"))
		return failure("plugin apply receipt omits or duplicates a selected profile");
	for (const row of rows) {
		if (!row || (row.status !== "APPLIED" && row.status !== "UNCHANGED") ||
			!asJsonObject(row.before) || !pluginSnapshotTargetsStore(row.after, store, packageHash))
			return failure(`plugin apply postimage is not verified for ${String(row?.profile ?? "unknown")}`);
	}
	return { ok: true, detail: `plugin receipt ${receiptId}`, receiptId, undoCommand };
}

/** Live installed version from the stable kit symlink (prefix/bin/omp-kit -> ../releases/<v>/bin/omp-kit). */
function installedVersion(prefix: string): string | null {
	try {
		const link = join(prefix, "bin", "omp-kit");
		if (!lstatSync(link).isSymbolicLink()) return null;
		const target = readlinkSync(link);
		const match = /^\.\.\/releases\/([^/]+)\/bin\/omp-kit$/.exec(target);
		if (!match || !SEMVER.test(match[1]!)) return null;
		return match[1]!;
	} catch { return null; }
}

export type PublishedTuple = Pick<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag">;
/**
 * Install-on-publish poll (RELTRAIN1): when OMP_KIT_UPDATE_POLL=github, fetch
 * the newest published release for OMP_KIT_UPDATE_REPO and, only when it is
 * newer than the live installed version, download release-index.json plus
 * the platform archive into one directory (the update path requires
 * same-directory index/archive). Returns null when nothing newer is
 * published, so the caller falls back to the configured static tuple.
 * A failed postcheck never reaches here; apply/undo semantics are unchanged.
 */
export async function pollPublishedRelease(prefix: string, stateRoot: string, platform: KitUpdateInput["platform"], dependencies: KitUpdateJobDependencies = {}): Promise<PublishedTuple | null> {
	if (process.env.OMP_KIT_UPDATE_POLL !== "github") return null;
	const repo = process.env.OMP_KIT_UPDATE_REPO;
	if (!repo || !KIT_UPDATE_REPO_PATTERN.test(repo)) throw new Error("KIT_UPDATE_POLL_CONFIG: OMP_KIT_UPDATE_REPO must be owner/repo");
	const exec = dependencies.exec ?? defaultExec;
	const tagOut = await exec(["gh", "release", "view", "--repo", repo, "--json", "tagName", "--jq", ".tagName"]);
	if (tagOut.exit !== 0) throw new Error("KIT_UPDATE_POLL_FAILED: " + tagOut.stderr.trim().slice(0, 200));
	const tag = tagOut.stdout.trim();
	if (tag.length > 64) throw new Error("KIT_UPDATE_POLL_UNVERIFIED: latest tag over length cap");
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	if (!SEMVER.test(version)) throw new Error("KIT_UPDATE_POLL_UNVERIFIED: latest tag is not X.Y.Z: " + tag.slice(0, 40));
	const current = installedVersion(prefix);
	if (current !== null && compareSemver(version, current) <= 0) return null;
	const target = PLATFORMS[`${platform.os}/${platform.arch}/${platform.libc}`];
	if (!target) throw new Error("KIT_UPDATE_POLL_UNVERIFIED: no published asset for this platform");
	const dir = join(stateRoot, `poll-${version}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const asset = `omp-kit-v${version}-${target}.tar`;
	const dl = await exec(["gh", "release", "download", `v${version}`, "--repo", repo, "--pattern", asset, "--pattern", "release-index.json", "--dir", dir]);
	if (dl.exit !== 0) throw new Error("KIT_UPDATE_POLL_FAILED: " + dl.stderr.trim().slice(0, 200));
	const indexPath = join(dir, "release-index.json");
	const archivePath = join(dir, asset);
	for (const path of [indexPath, archivePath]) {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (!stat || !stat.isFile() || resolve(path) !== path || dirname(indexPath) !== dirname(archivePath)) throw new Error("KIT_UPDATE_POLL_UNVERIFIED: downloaded tuple failed the same-directory file check");
	}
	return { indexPath, archivePath, version, sourceTag: `v${version}` };
}

/** One opt-in poll/apply cycle. No network or service installation occurs unless the caller enables it. */
export async function runKitUpdateJob(config: KitUpdateJobConfig, dependencies: KitUpdateJobDependencies = {}): Promise<KitUpdateJobResult> {
	if (!config.enabled) return { status: "DISABLED", receiptId: null, activeVersion: null, notification: false };
	const plan = dependencies.plan ?? planKitUpdate;
	const apply = dependencies.apply ?? applyKitUpdate;
	const relink = dependencies.relink ?? ((binary: string, store: string) =>
		relinkKitPlugin(binary, store, dependencies.exec ?? defaultExec));
	const reconcile = dependencies.reconcile ?? (async (binary: string) => {
		const ran = await defaultExec([binary, "service", "install", "kit-update", "--apply", "--yes"]);
		const out = (ran.stdout + ran.stderr).trim().slice(-500);
		return ran.exit === 0 ? { ok: true, detail: out } : { ok: false, detail: `exit ${ran.exit}: ${out}` };
	});
	let runId = randomUUID();
	try {
		// Install-on-publish: a newer published release replaces the static tuple.
		// Anything else (disabled poll, nothing newer) keeps today's static path.
		const published = await pollPublishedRelease(config.prefix, config.stateRoot, config.platform, dependencies);
		const source = published ?? await config.pollRelease();
		// Poll-only with nothing newer: nothing to install, nothing to refuse.
		if (!source) return record(config.stateRoot, runId, { status: "CURRENT", receiptId: null, activeVersion: installedVersion(config.prefix), notification: false, relink: "NOT_RUN", service: "NOT_RUN" });
		const preview = await plan({ ...config, ...source });
		if (preview.status === "CURRENT") return record(config.stateRoot, runId, { status: "CURRENT", receiptId: null, activeVersion: preview.current.version, notification: false, relink: "NOT_RUN" });
		if (preview.status !== "UPDATE_AVAILABLE") { const refusal = preview as KitUpdateRefusal; return record(config.stateRoot, runId, { status: "REFUSED", receiptId: null, activeVersion: null, notification: false, reason: refusal.reason, relink: "NOT_RUN" }); }
		const result = await apply(preview);
		if (result.status === "PARTIAL") { await dependencies.notify?.("omp-kit update postcheck failed; automatic undo completed"); return record(config.stateRoot, runId, { status: "UNDONE", receiptId: result.receiptId, activeVersion: result.activeVersion, notification: true, relink: "NOT_RUN" }); }
		if (result.status !== "UPDATED") return record(config.stateRoot, runId, { status: result.status, receiptId: result.receiptId, activeVersion: result.activeVersion, notification: false, relink: "NOT_RUN" });
		// The kit symlink now points at the new release; relink every covered OMP
		// profile to that exact store and retain the plugin receipt for recovery.
		const binary = join(config.prefix, "bin", "omp-kit");
		const store = result.activeVersion && SEMVER.test(result.activeVersion)
			? join(config.prefix, "releases", result.activeVersion)
			: null;
		const link: PluginRelinkResult = store
			? await relink(binary, store)
			: { ok: false, detail: "updated release version is missing or invalid" };
		const pluginReceipt = link.receiptId
			? { pluginReceiptId: link.receiptId, ...(link.undoCommand ? { pluginUndoCommand: link.undoCommand } : {}) }
			: {};
		if (!link.ok) {
			const recovery = link.receiptId && link.undoCommand
				? `; plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\``
				: "";
			await dependencies.notify?.(`omp-kit update BLOCKED: plugin relink failed for ${result.activeVersion ?? "unknown version"} (kit receipt ${result.receiptId})${recovery}; run \`omp-kit apply plugin --plan --store <release-root> --profiles all --include-default\` before retrying: ${link.detail}`);
			return record(config.stateRoot, runId, { status: "UPDATED", receiptId: result.receiptId, activeVersion: result.activeVersion, notification: true, reason: "PLUGIN_RELINK_FAILED", relink: "FAILED", ...pluginReceipt });
		}
		// The new release may carry a new tick interval: re-render the installed
		// plist with the new binary itself so StartInterval tracks the code.
		const reconciled = await reconcile(binary);
		if (!reconciled.ok) {
			await dependencies.notify?.(`omp-kit update BLOCKED: service reconcile failed for ${result.activeVersion} (kit receipt ${result.receiptId}); plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\`; kit is on ${result.activeVersion}, rerun \`omp-kit service install kit-update --apply --yes\`: ${reconciled.detail}`);
			return record(config.stateRoot, runId, { status: "UPDATED", receiptId: result.receiptId, activeVersion: result.activeVersion, notification: true, reason: "SERVICE_RECONCILE_FAILED", relink: "APPLIED", service: "FAILED", ...pluginReceipt });
		}
		await dependencies.notify?.(`omp-kit updated to ${result.activeVersion} (kit receipt ${result.receiptId}); plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\`; plugin relink applied`);
		return record(config.stateRoot, runId, { status: "UPDATED", receiptId: result.receiptId, activeVersion: result.activeVersion, notification: true, relink: "APPLIED", service: "APPLIED", ...pluginReceipt });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await dependencies.notify?.("omp-kit update job failed: " + reason);
		return record(config.stateRoot, runId, { status: "FAILED", receiptId: null, activeVersion: null, notification: true, reason });
	}
}

function record(stateRoot: string, runId: string, result: KitUpdateJobResult): KitUpdateJobResult {
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot, `kit-update-job-${runId}.json`), JSON.stringify({ schema_version: 1, run_id: runId, ...result }) + "\n", { mode: 0o600 });
	return result;
}
