import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { atomicReplaceBytes } from "./kitlib/io.ts";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { parseReleaseIndexJson } from "./kit-release.ts";
import { applyKitUpdate, kitPostcheckDetail, planKitUpdate, selectUpdateOmp, undoKitUpdate, type KitPostcheck, type KitPostcheckDetail, type KitUndoResult, type KitUpdateInput, type KitUpdatePlan, type KitUpdatePreview, type KitUpdateRefusal, type KitUpdateResult, type UpdateOmpSelection } from "./kit-update.ts";
import { refreshFleetHooksLive, type HookRefreshReport } from "./hook-refresh.ts";
import { acquireKitUpdateLock, inspectPendingKitUpdate, type UpdateLockToken } from "./mutations.ts";
import { makeDirsWritable } from "./kitlib/tmp.ts";

/** The job installs the kit for the whole machine: it has no project, and its service cwd (HOME) is never watched as one. */
export type KitUpdateJobConfig = Omit<KitUpdateInput, "indexPath" | "archivePath" | "version" | "sourceTag" | "project"> & {
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
	/**
	 * HOOKREFRESH1 test seam for the post-install fleet hook refresh.
	 * Production re-runs scripts/install-commit-msg-bead.sh for every
	 * pull-enabled fleet-watch repo; hermetic when HOME names no fleet config.
	 */
	refreshHooks?: (store: string, home: string) => Promise<HookRefreshReport>;
	/** The omp the postcheck judges; production resolves the seat's omp. Tests inject a fixed selection. */
	omp?: () => UpdateOmpSelection | null;
};
export type KitUpdateJobResult = {
	status: "DISABLED" | "CURRENT" | "UPDATED" | "UNDONE" | "REFUSED" | "PENDING" | "FAILED" | "SKIPPED"; receiptId: string | null; activeVersion: string | null; notification: boolean; reason?: string;
	/** Failed, safely restored updates are compensated, never relabeled as successful postchecks. */
	receipt?: "RECONCILED" | "ABORTED_AFTER_COMPENSATION" | "PENDING";
	/** Preserve the release's full-test verdict even when the tick safely restores its prior binary. */
	postcheck?: KitPostcheck["status"]; postcheckReason?: string; postcheckDetail?: KitPostcheckDetail | null;
	relink?: "APPLIED" | "FAILED" | "NOT_RUN"; pluginReceiptId?: string; pluginUndoCommand?: string; service?: "APPLIED" | "FAILED" | "NOT_RUN";
	/**
	 * HOOKREFRESH1: fleet hook refresh after a successful install.
	 * PENDING_COMMIT counts tracked-hooks repos whose refreshed members wait
	 * for the owning director to commit (owner route); only failed > 0 is FINDINGS.
	 */
	hooks?: { status: "APPLIED" | "PENDING_COMMIT" | "FAILED" | "NOT_RUN"; repos: number; refreshed: number; fresh: number; pending_commit: number; failed: number };
	retention?: { status: "APPLIED" | "FAILED"; kept: string[]; removed: string[]; pollsRemoved: string[]; reason?: string };
	/** The release version this tick attempted; a repeat for the same target suppresses on it. */
	targetVersion?: string;
	/** Which omp pool the postcheck judged (the seat's omp), and its exact version and launcher. */
	ompResolvedFrom?: "tern-bundle" | "path"; ompVersion?: string | null; ompLauncher?: string | null;
};

/** OK only for a clean cycle, including postchecks, relink, service reconcile, hook refresh and release retention. */
export function kitUpdateJobOverall(result: KitUpdateJobResult): "OK" | "FINDINGS" {
	return result.status === "FAILED" || result.status === "PENDING" || (result.postcheck !== undefined && result.postcheck !== "PASS") ||
		result.relink === "FAILED" || result.service === "FAILED" || (result.hooks !== undefined && result.hooks.failed > 0) ||
		result.retention?.status === "FAILED" ? "FINDINGS" : "OK";
}

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
 * Idempotent: an earlier cycle's poll directory (a reboot or kill mid-poll) is
 * reused only when its index and archive verify; otherwise they are replaced.
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
	const indexPath = join(dir, "release-index.json");
	const stem = `omp-kit-v${version}-${target}`;
	const readAsset = (): string => {
		if (!lstatSync(indexPath).isFile()) throw new Error("index is not a regular file");
		const index = parseReleaseIndexJson(readFileSync(indexPath, "utf8"));
		const asset = index.assets[target]!.filename;
		if (index.version !== version || index.source_tag !== `v${version}` ||
			asset.length > 255 || !asset.startsWith(stem) || !/^[A-Za-z0-9_.-]+\.tar(\.gz)?$/.test(asset))
			throw new Error("invalid asset filename");
		return asset;
	};
	let asset: string | undefined;
	try { asset = readAsset(); } catch { /* Replace incomplete indexes left by an interrupted poll. */ }
	if (!asset || !pollTupleVerified(indexPath, join(dir, asset), version, target)) {
		const indexDownload = await exec(["gh", "release", "download", `v${version}`, "--repo", repo,
			"--pattern", "release-index.json", "--dir", dir, "--clobber"]);
		if (indexDownload.exit !== 0) throw new Error("KIT_UPDATE_POLL_FAILED: " + indexDownload.stderr.trim().slice(0, 200));
		try { asset = readAsset(); }
		catch { throw new Error("KIT_UPDATE_POLL_UNVERIFIED: published index or asset filename is invalid"); }
		const dl = await exec(["gh", "release", "download", `v${version}`, "--repo", repo,
			"--pattern", asset, "--dir", dir, "--clobber"]);
		if (dl.exit !== 0) throw new Error("KIT_UPDATE_POLL_FAILED: " + dl.stderr.trim().slice(0, 200));
	}
	const archivePath = join(dir, asset);
	if (resolve(indexPath) !== indexPath || dirname(indexPath) !== dirname(archivePath)) throw new Error("KIT_UPDATE_POLL_UNVERIFIED: downloaded tuple failed the same-directory file check");
	if (!pollTupleVerified(indexPath, archivePath, version, target))
		throw new Error("KIT_UPDATE_POLL_UNVERIFIED: downloaded archive does not match published index");
	// Bundles are published in GitHub's attestation store, not necessarily release assets.
	// Fetch by the archive bytes' digest on every cycle; applyKitUpdate authenticates the bundle before extraction.
	const digest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
	const bundle = await exec(["gh", "api", "--hostname", "github.com", `repos/${repo}/attestations/sha256:${digest}`, "--jq", ".attestations[].bundle | tojson"]);
	if (bundle.exit !== 0 || !bundle.stdout.trim() || Buffer.byteLength(bundle.stdout) > 16 * 1024 * 1024)
		throw new Error("KIT_ATTESTATION_BUNDLE_UNAVAILABLE: " + bundle.stderr.trim().slice(0, 1000));
	// Replace atomically: a bundle left by an interrupted cycle must neither block nor be half-read.
	atomicReplaceBytes(`${archivePath}.sigstore.json`, Buffer.from(bundle.stdout), { mode: 0o600, durability: "none" });
	return { indexPath, archivePath, version, sourceTag: `v${version}` };
}

/**
 * True when `indexPath` is this release's index for `assetKey` and `archivePath` hashes to its digest:
 * the check `planKitUpdate` applies before any activation. A missing, partial or tampered file is false.
 */
function pollTupleVerified(indexPath: string, archivePath: string, version: string, assetKey: string): boolean {
	try {
		for (const path of [indexPath, archivePath]) if (!lstatSync(path).isFile()) return false;
		const index = parseReleaseIndexJson(readFileSync(indexPath, "utf8"));
		const asset = index.assets[assetKey];
		return index.version === version && index.source_tag === `v${version}` && asset?.filename === basename(archivePath) &&
			createHash("sha256").update(readFileSync(archivePath)).digest("hex") === asset.sha256;
	} catch { return false; }
}

function retentionVersion(value: string): boolean {
	return value.length <= 64 && !value.includes("\n") && SEMVER.test(value) &&
		value.split(".").every(part => Number.isSafeInteger(Number(part)));
}

/** A poll directory's release version: the exact semver or the leading semver of a suffixed name (poll-0.2.50.stale-interrupted-…). Null when no leading version parses. */
function pollDirVersion(entry: string): string | null {
	if (!entry.startsWith("poll-")) return null;
	const match = /^(\d+\.\d+\.\d+)(?=[.-]|$)/.exec(entry.slice(5));
	return match !== null && retentionVersion(match[1]!) ? match[1]! : null;
}

/** Operator-pinned releases survive retention: `<prefix>/releases/.pinned`, one X.Y.Z per line, `#` comments, anything else ignored. */
export const PINNED_RELEASES_FILE = ".pinned";
function readPinnedReleases(prefix: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(prefix, "releases", PINNED_RELEASES_FILE), "utf8");
	} catch {
		return [];
	}
	const pinned: string[] = [];
	for (const line of text.split("\n")) {
		const version = line.trim();
		if (version === "" || version.startsWith("#")) continue;
		if (retentionVersion(version)) pinned.push(version);
	}
	return pinned;
}

/** Capture the executable's physical release before activation can move the stable link. */
export function runningReleaseVersion(prefix: string): string | null {
	const parts = relative(join(resolve(prefix), "releases"), realpathSync(process.execPath)).split(sep);
	return parts.length === 3 && parts[1] === "bin" && parts[2] === "omp-kit" && retentionVersion(parts[0]!)
		? parts[0]! : null;
}

/** Installed releases contain 0555 directories; never follow a symlink while changing their modes. */
function writableReleaseTree(path: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || realpathSync(path) !== path) throw new Error("KIT_RETENTION_UNSAFE_DIRECTORY");
	makeDirsWritable(path);
}

/** STATERETAIN1 (ompkit-1ra0d.62): keep the active release, the last five before it, and any pinned or protected release; prune older release and poll dirs. Newer-than-active versions are never touched. The updater lock protects the active link and rollback selection for the whole destructive pass. */
export function retainReleases(prefix: string, stateRoot: string, active: string, protectedVersions: readonly (string | null)[]): NonNullable<KitUpdateJobResult["retention"]> {
	const report: NonNullable<KitUpdateJobResult["retention"]> = { status: "APPLIED", kept: [], removed: [], pollsRemoved: [] };
	let lock: UpdateLockToken | undefined;
	try {
		lock = acquireKitUpdateLock(stateRoot);
		const releases = join(prefix, "releases");
		if (!retentionVersion(active) || installedVersion(prefix) !== active ||
			realpathSync(prefix) !== prefix || !lstatSync(releases).isDirectory() || realpathSync(releases) !== releases ||
			!lstatSync(join(releases, active)).isDirectory()) throw new Error("KIT_RETENTION_ACTIVE_UNVERIFIED");
		const versions = readdirSync(releases, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && retentionVersion(entry.name)).map(entry => entry.name);
		const previous = versions.filter(version => compareSemver(version, active) < 0).sort(compareSemver).slice(-5);
		const keep = new Set([active, ...previous, ...readPinnedReleases(prefix)]);
		for (const version of protectedVersions) if (version !== null && retentionVersion(version)) keep.add(version);
		report.kept = versions.filter(version => keep.has(version) || compareSemver(version, active) > 0).sort(compareSemver);
		for (const version of versions) {
			if (keep.has(version) || compareSemver(version, active) >= 0) continue;
			const path = join(releases, version);
			writableReleaseTree(path);
			rmSync(path, { recursive: true });
			report.removed.push(version);
		}
		for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const version = pollDirVersion(entry.name);
			if (version === null || keep.has(version) || compareSemver(version, active) >= 0) continue;
			const path = join(stateRoot, entry.name);
			writableReleaseTree(path);
			rmSync(path, { recursive: true });
			report.pollsRemoved.push(entry.name);
		}
	} catch (error) {
		report.status = "FAILED";
		report.reason = error instanceof Error ? error.message : String(error);
	} finally {
		try { lock?.release(); } catch (error) {
			report.status = "FAILED";
			report.reason = error instanceof Error ? error.message : String(error);
		}
	}
	return report;
}
/**
 * KITUPDATEOMP1: the newest UNDONE-or-SKIPPED run record for one target and
 * one judged omp version. A second scheduled tick for the same target and
 * cause skips instead of reinstalling; a changed kit version (new target), a
 * changed omp version, or an operator run (`omp-kit update --apply` bypasses
 * the job entirely) retries. No new state file: the window re-arms from the
 * records the ticks already write.
 */
function newestRepeatForOmp(stateRoot: string, targetVersion: string, ompVersion: string): { mtime: number; postcheckReason?: string; postcheckDetail?: unknown } | null {
	let names: string[];
	try { names = readdirSync(stateRoot); } catch { return null; }
	let best: { mtime: number; postcheckReason?: string; postcheckDetail?: unknown } | null = null;
	for (const name of names) {
		if (!RUN_RECORD_NAME.test(name)) continue;
		try {
			const mtime = lstatSync(join(stateRoot, name)).mtimeMs;
			if (best && mtime <= best.mtime) continue;
			const parsed: unknown = JSON.parse(readFileSync(join(stateRoot, name), "utf8"));
			if (!parsed || typeof parsed !== "object") continue;
			const rec = parsed as Record<string, unknown>;
			if ((rec.status !== "UNDONE" && rec.status !== "SKIPPED") || rec.targetVersion !== targetVersion || rec.ompVersion !== ompVersion) continue;
			best = { mtime,
				...(typeof rec.postcheckReason === "string" ? { postcheckReason: rec.postcheckReason } : {}),
				...("postcheckDetail" in rec ? { postcheckDetail: rec.postcheckDetail } : {}) };
		} catch { continue; }
	}
	return best;
}

/** A repeat suppresses without limit only for omp-attributed deterministic causes. */
const DETERMINISTIC_OMP_REASONS: readonly string[] = ["OMP_VERSION_MISMATCH", "OMP_VERSION_UNVERIFIED"];

/** One retry per window for every other cause: a transient live/stage flake may clear on its own. */
export const KIT_UPDATE_REPEAT_WINDOW_MS = 6 * 3600 * 1000;

function repeatCauseText(detail: unknown): string {
	if (!detail || typeof detail !== "object") return "";
	const rec = detail as Record<string, unknown>;
	const cause = rec.cause;
	const message = cause !== null && typeof cause === "object" && "cause_message" in cause && typeof (cause as Record<string, unknown>).cause_message === "string"
		? (cause as Record<string, unknown>).cause_message as string : "";
	const failures = Array.isArray(rec.failures) ? rec.failures.filter((failure): failure is string => typeof failure === "string").join("\n") : "";
	return `${message}\n${failures}`;
}

function repeatSuppressesForever(postcheckReason: string | undefined, postcheckDetail: unknown, ompVersion: string): boolean {
	if (postcheckReason !== undefined && (DETERMINISTIC_OMP_REASONS.includes(postcheckReason) || postcheckReason.includes(ompVersion))) return true;
	return repeatCauseText(postcheckDetail).includes(ompVersion);
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
		// A restart has no trustworthy postcheck/OMP identity witness. Never guess an undo reason or
		// hide the receipt behind CURRENT when polling finds no newer release.
		const pending = inspectPendingKitUpdate(config.stateRoot);
		if (pending) {
			const activeVersion = installedVersion(config.prefix);
			const reason = activeVersion === null ? "KIT_ACTIVATION_UNVERIFIED" : "KIT_RECOVERY_UNVERIFIED";
			const guidance = activeVersion === null
				? "Use a known-good release binary to inspect the activation receipt and repair the stable link; keep the pending receipt until its postimage is verified."
				: `Inspect OMP and \`omp-kit audit --json\`; after verifying the recorded postimage, run \`omp-kit update --reconcile ${pending.id} --yes\`.`;
			await dependencies.notify?.(`omp-kit update PENDING: ${reason}; kit receipt ${pending.id}. ${guidance}`);
			return record(config.stateRoot, runId, { status: "PENDING", receiptId: pending.id, activeVersion,
				notification: true, reason, receipt: "PENDING", relink: "NOT_RUN", service: "NOT_RUN" });
		}
		// Install-on-publish: a newer published release replaces the static tuple.
		// Anything else (disabled poll, nothing newer) keeps today's static path.
		const published = await pollPublishedRelease(config.prefix, config.stateRoot, config.platform, dependencies);
		const source = published ?? await config.pollRelease();
		// STATERETAIN1: a CURRENT tick changes and fails nothing, so it writes no
		// per-run record; records exist for runs that change or fail something.
		// Nothing reads kit-update-job-*.json except this post-mortem scan, so
		// skipping the write loses no consumer.
		if (!source) { pruneKitUpdateRunRecords(config.stateRoot); return { status: "CURRENT", receiptId: null, activeVersion: installedVersion(config.prefix), notification: false, relink: "NOT_RUN", service: "NOT_RUN" }; }
		const preview = await plan({ prefix: config.prefix, stateRoot: config.stateRoot, home: config.home, platform: config.platform, ...source });
		if (preview.status === "CURRENT") { pruneKitUpdateRunRecords(config.stateRoot); return { status: "CURRENT", receiptId: null, activeVersion: preview.current.version, notification: false, relink: "NOT_RUN" }; }
		// Never a project: launchd runs the job from HOME, and watching HOME's .omp/.agents/.claude as one made every live postcheck fail.
		if (preview.status !== "UPDATE_AVAILABLE") { const refusal = preview as KitUpdateRefusal; return record(config.stateRoot, runId, { status: "REFUSED", receiptId: null, activeVersion: null, notification: false, reason: refusal.reason, relink: "NOT_RUN" }); }
		// KITUPDATEOMP1: after one UNDONE for this target and this cause, a
		// scheduled tick skips without unpacking or postchecking. Deterministic
		// omp-attributed causes suppress without limit; any other cause allows
		// one retry per window (timed from the newest UNDONE/SKIPPED record).
		// A newer kit, a newer omp, or an operator run retries; the skip writes
		// one small record and exits 0 without notifying (the UNDONE tick
		// already notified once).
		const judgedOmp = (dependencies.omp ?? (() => selectUpdateOmp({ ...process.env, HOME: config.home })))();
		const repeat = judgedOmp ? newestRepeatForOmp(config.stateRoot, source.version, judgedOmp.version) : null;
		const repeatForever = repeat !== null && repeatSuppressesForever(repeat.postcheckReason, repeat.postcheckDetail, judgedOmp!.version);
		const repeatWithinWindow = repeat !== null && (Date.now() - repeat.mtime) < KIT_UPDATE_REPEAT_WINDOW_MS;
		if (judgedOmp && repeat && (repeatForever || repeatWithinWindow)) {
			return record(config.stateRoot, runId, { status: "SKIPPED", receiptId: null, activeVersion: installedVersion(config.prefix),
				notification: false, reason: "KIT_UPDATE_REPEAT_SUPPRESSED", targetVersion: source.version, ...(repeat.postcheckReason !== undefined ? { postcheckReason: repeat.postcheckReason } : {}),
				ompResolvedFrom: judgedOmp.resolvedFrom, ompVersion: judgedOmp.version, ompLauncher: judgedOmp.launcher, relink: "NOT_RUN", service: "NOT_RUN" });
		}
		const runningVersion = runningReleaseVersion(config.prefix);
		const result = await apply(preview);
		if (result.status !== "UPDATED" && result.status !== "PARTIAL") return record(config.stateRoot, runId, { status: result.status, receiptId: result.receiptId, activeVersion: result.activeVersion, notification: false, relink: "NOT_RUN" });
		const postcheck: Pick<KitUpdateJobResult, "postcheck" | "postcheckReason" | "postcheckDetail"> = result.status === "UPDATED"
			? { postcheck: result.postcheck.status }
			: { postcheck: result.postcheck.status, postcheckReason: result.postcheck.reason ?? "KIT_POSTCHECK_FAILED",
				postcheckDetail: kitPostcheckDetail(result.postcheck, [config.home, config.stateRoot, config.prefix]) };
		const activeVersion = result.activeVersion;
		if (result.status === "PARTIAL") {
			// Neither a missing activation nor an OMP mutation is a kit-only, revert-safe failure.
			if (activeVersion === null || result.postcheck.reason === "OMP_CHANGED_DURING_KIT_UPDATE") {
				const reason = activeVersion === null ? "KIT_ACTIVATION_UNVERIFIED" : "OMP_CHANGED_DURING_KIT_UPDATE";
				const guidance = activeVersion === null
					? "Use a known-good release binary to inspect the activation receipt and repair the stable link before reconciling."
					: "Inspect OMP and both component postimages before choosing manual recovery.";
				await dependencies.notify?.(`omp-kit update PENDING: ${reason}; kit receipt ${result.receiptId}. ${guidance}`);
				return record(config.stateRoot, runId, { status: "PENDING", receiptId: result.receiptId, activeVersion,
					notification: true, reason, receipt: "PENDING", ...postcheck, relink: "NOT_RUN", service: "NOT_RUN" });
			}
			// Reuse manual undo's locked postimage/prior-binary checks, adding stricter unattended
			// admission. Never reconcile first: automatic compensation requires an audit PENDING.
			let restored: KitUndoResult | null = null, refusal = "KIT_RECEIPT_INVALID";
			try {
				if (result.receiptId) restored = undoKitUpdate({ stateRoot: config.stateRoot, prefix: config.prefix,
					receiptId: result.receiptId, automatic: result.postcheck });
			} catch (error) { refusal = error instanceof Error ? error.message : String(error); }
			if (!restored) {
				await dependencies.notify?.(`omp-kit update PENDING: recovery refused (${refusal}); kit receipt ${result.receiptId}. Inspect OMP and \`omp-kit audit --json\` before choosing manual recovery.`);
				return record(config.stateRoot, runId, { status: "PENDING", receiptId: result.receiptId, activeVersion,
					notification: true, reason: refusal, receipt: "PENDING", ...postcheck, relink: "NOT_RUN", service: "NOT_RUN" });
			}
			if (restored.updatePending) {
				await dependencies.notify?.(`omp-kit update PENDING: prior release ${restored.activeVersion} restored but kit receipt ${result.receiptId} still needs recovery finalization; inspect \`omp-kit audit --json\`.`);
				return record(config.stateRoot, runId, { status: "PENDING", receiptId: result.receiptId, activeVersion: restored.activeVersion,
					notification: true, reason: "KIT_UNDO_FINALIZATION_PENDING", receipt: "PENDING", ...postcheck, relink: "NOT_RUN", service: "NOT_RUN" });
			}
		await dependencies.notify?.(`omp-kit update UNDONE: restored ${restored.activeVersion}; kit receipt ${result.receiptId} compensated after ${postcheck.postcheckReason}; postcheck failure retained in the job record.`);
		// STATERETAIN1: the compensated restore is itself a successful activation of
		// the prior release, so retain on it too; otherwise a failing postcheck loops
		// forever (apply, fail, undo) while the state root keeps growing. The undone
		// new release is newer than active, so it survives as a rollback target.
		const undoneRetention = restored.activeVersion !== null
			? retainReleases(config.prefix, config.stateRoot, restored.activeVersion, [runningVersion])
			: undefined;
		return record(config.stateRoot, runId, { status: "UNDONE", receiptId: result.receiptId, activeVersion: restored.activeVersion,
			notification: true, receipt: "ABORTED_AFTER_COMPENSATION", ...postcheck, relink: "NOT_RUN", service: "NOT_RUN",
			targetVersion: source.version,
			...(result.omp ? { ompResolvedFrom: result.omp.resolvedFrom, ompVersion: result.omp.version, ompLauncher: result.omp.launcher } : {}),
			...(undoneRetention ? { retention: undoneRetention } : {}) });
		}
		// The kit symlink now points at the new release; relink every covered OMP
		// profile to that exact store and retain the plugin receipt for recovery.
		const binary = join(config.prefix, "bin", "omp-kit");
		const store = activeVersion && SEMVER.test(activeVersion)
			? join(config.prefix, "releases", activeVersion)
			: null;
		const link: PluginRelinkResult = store
			? await relink(binary, store)
			: { ok: false, detail: "updated release version is missing or invalid" };
		const pluginReceipt = link.receiptId
			? { pluginReceiptId: link.receiptId, ...(link.undoCommand ? { pluginUndoCommand: link.undoCommand } : {}) }
			: {};
		const activated = { status: "UPDATED" as const, receiptId: result.receiptId, activeVersion, notification: true, receipt: "RECONCILED" as const, ...postcheck,
			targetVersion: source.version,
			...(result.omp ? { ompResolvedFrom: result.omp.resolvedFrom, ompVersion: result.omp.version, ompLauncher: result.omp.launcher } : {}) };
		if (!link.ok) {
			const recovery = link.receiptId && link.undoCommand
				? `; plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\``
				: "";
			await dependencies.notify?.(`omp-kit update BLOCKED: plugin relink failed for ${activeVersion ?? "unknown version"} (kit receipt ${result.receiptId})${recovery}; run \`omp-kit apply plugin --plan --store <release-root> --profiles all --include-default\` before retrying: ${link.detail}`);
			return record(config.stateRoot, runId, { ...activated, reason: "PLUGIN_RELINK_FAILED", relink: "FAILED", ...pluginReceipt });
		}
		// The new release may carry a new tick interval: re-render the installed
		// plist with the new binary itself so StartInterval tracks the code.
		const reconciled = await reconcile(binary);
		if (!reconciled.ok) {
			await dependencies.notify?.(`omp-kit update BLOCKED: service reconcile failed for ${activeVersion} (kit receipt ${result.receiptId}); plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\`; kit is on ${activeVersion}, rerun \`omp-kit service install kit-update --apply --yes\`: ${reconciled.detail}`);
			return record(config.stateRoot, runId, { ...activated, reason: "SERVICE_RECONCILE_FAILED", relink: "APPLIED", service: "FAILED", ...pluginReceipt });
		}
		// HOOKREFRESH1: the kit symlink points at the new release, so re-run the
		// hook installer for every pull-enabled fleet repo. Tracked-hooks repos
		// stay PENDING_COMMIT for their director; a refresh failure never un-does
		// the update but marks the job FINDINGS. Hermetic in tests: a fixture
		// HOME names no fleet config, so zero repos refresh.
		const refresh = dependencies.refreshHooks ?? refreshFleetHooksLive;
		let hooks: KitUpdateJobResult["hooks"];
		try {
			const report = store ? await refresh(store, config.home) : null;
			hooks = report === null
				? { status: "NOT_RUN" as const, repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 0 }
				: {
					status: report.failed > 0 ? "FAILED" as const : report.pending_commit > 0 ? "PENDING_COMMIT" as const : "APPLIED" as const,
					repos: report.repos, refreshed: report.refreshed, fresh: report.fresh, pending_commit: report.pending_commit, failed: report.failed,
				};
		} catch {
			hooks = { status: "FAILED" as const, repos: 0, refreshed: 0, fresh: 0, pending_commit: 0, failed: 1 };
		}
		// STATERETAIN1: retention runs after every successful activation, even when
		// the postcheck fails: the gate that caused the deadlock (retention only on
		// postcheck PASS) let the state root grow until the postcheck could never
		// pass. Rollback targets survive: active, the five before it, pinned and
		// running releases are kept, and newer-than-active versions are untouched.
		const retention = result.status === "UPDATED" && hooks.failed === 0 && activeVersion !== null
			? retainReleases(config.prefix, config.stateRoot, activeVersion, [runningVersion])
			: undefined;
		const hookNote = hooks.repos === 0 ? "; no fleet repos to refresh hooks in"
			: `; hooks ${hooks.status}: ${hooks.refreshed} refreshed, ${hooks.fresh} fresh, ${hooks.pending_commit} pending director commit, ${hooks.failed} failed over ${hooks.repos} repo(s)`;
		const retentionNote = retention?.status === "FAILED" ? "; release retention FAILED (see job record)" : "";
		await dependencies.notify?.(`omp-kit updated to ${activeVersion} (kit receipt ${result.receiptId}); plugin receipt ${link.receiptId}; undo with \`${link.undoCommand}\`; plugin relink applied${hookNote}${retentionNote}`);
		return record(config.stateRoot, runId, { ...activated, relink: "APPLIED", service: "APPLIED", ...pluginReceipt, hooks, ...(retention ? { retention } : {}) });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		await dependencies.notify?.("omp-kit update job failed: " + reason);
		return record(config.stateRoot, runId, { status: "FAILED", receiptId: null, activeVersion: null, notification: true, reason });
	}
}

/** Newest terminal run records kept per state root; older ones are pruned on every recording run.
 * The single newest non-terminal PENDING record is the recovery trail and always survives. */
export const KIT_UPDATE_RUN_RECORD_LIMIT = 30;

/** Run-record filenames are the uuid shape the job writes; anything else (a hand-placed backup,
 * a partial download) is never parsed or deleted. */
const RUN_RECORD_NAME = /^kit-update-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

/** Best-effort prune of kit-update-job-<uuid>.json run records: keep the newest
 * KIT_UPDATE_RUN_RECORD_LIMIT terminal records plus the single newest non-terminal receipt. */
export function pruneKitUpdateRunRecords(stateRoot: string): void {
	try {
		let names: string[];
		try { names = readdirSync(stateRoot); } catch { return; }
		const kept: { name: string; mtime: number; pending: boolean }[] = [];
		for (const name of names) {
			if (!RUN_RECORD_NAME.test(name)) continue;
			let mtime = 0, pending = false;
			try {
				mtime = lstatSync(join(stateRoot, name)).mtimeMs;
				const record: unknown = JSON.parse(readFileSync(join(stateRoot, name), "utf8"));
				if (record !== null && typeof record === "object") {
					if ("status" in record && record.status === "PENDING") pending = true;
					if ("receipt" in record && record.receipt === "PENDING") pending = true;
				}
			} catch { continue; }
			kept.push({ name, mtime, pending });
		}
		const terminal = kept.filter(entry => !entry.pending).sort((a, b) => b.mtime - a.mtime);
		const pending = kept.filter(entry => entry.pending).sort((a, b) => b.mtime - a.mtime);
		const drop = new Set(terminal.slice(KIT_UPDATE_RUN_RECORD_LIMIT).map(entry => entry.name));
		for (const entry of pending.slice(1)) drop.add(entry.name);
		for (const name of drop) {
			try { rmSync(join(stateRoot, name), { force: true }); } catch { /* one stuck record never fails the run */ }
		}
	} catch { /* pruning never fails the run */ }
}
function record(stateRoot: string, runId: string, result: KitUpdateJobResult): KitUpdateJobResult {
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	writeFileSync(join(stateRoot, `kit-update-job-${runId}.json`), JSON.stringify({ schema_version: 1, run_id: runId, ...result }) + "\n", { mode: 0o600 });
	pruneKitUpdateRunRecords(stateRoot);
	return result;
}
