import { createHash } from "node:crypto";
import { mkdirSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSync } from "./kitlib/run.ts";
import { ownedTmp } from "./kitlib/tmp.ts";
import { diffOvnfsCheckout, isValidCheckoutName, listOvnfsCheckouts } from "./ovnfs-checkouts.ts";
import type { OvnfsCheckoutRow } from "./ovnfs-checkouts.ts";
import { stateRoot } from "./scratch.ts";

/**
 * Checkout lifecycle (CHECKOUTREAP1): inventory ovnfs checkouts fleet-wide and reap them by rule.
 * A checkout is eligible only when it is idle past the bar, its diff is empty (no unlanded source changes),
 * and its bytes were archived first with a verified round-trip. Active checkouts are never touched; the
 * checkout's opener remains the owner, and `ovnfs rm` is the only deleter. Archive layout matches the
 * CheckoutJanitor two-file shape (`checkout.patch` + `manifest.json`) so tooling converts trivially.
 */

export const CHECKOUT_IDLE_DAYS_DEFAULT = 7;
export const CHECKOUT_MAX_PATCH_BYTES = 100_000_000;
const DU_DEADLINE_S = 30;
const DIFF_DEADLINE_S = 30;
/** What one reap is budgeted to need (diff, archive, verify, rm); a reap is not started when less than this remains before the run deadline. */
export const CHECKOUT_REAP_RESERVE_MS_DEFAULT = 180_000;

export interface CheckoutListRow {
	name: string;
	path: string;
	source: string;
	dirty: boolean;
	created: string | null;
	touched: string | null;
}

export interface CheckoutDiffInput {
	available: boolean;
	empty?: boolean;
	unhandled?: boolean;
}

export interface CheckoutJudgment {
	eligible: boolean;
	reason: string;
	idleHours: number | null;
}

/** Idle hours since TOUCHED, or null when TOUCHED is missing or unparseable (fail closed). */
export function checkoutIdleHours(touched: string | null, now: number): number | null {
	if (touched === null) return null;
	const ms = Date.parse(touched);
	if (!Number.isFinite(ms)) return null;
	return Math.max(0, (now - ms) / 3_600_000);
}

function toListRow(row: OvnfsCheckoutRow): CheckoutListRow {
	return { name: row.name, path: row.path, source: row.source, dirty: row.dirty, created: row.created, touched: row.touched };
}

/**
 * The single safety judge for one checkout row. Eligible only when the checkout is idle past the bar and
 * its diff is proven empty; anything unprovable (unknown touch, unreadable or unhandled diff, a dirty flag
 * the empty diff does not explain) is kept and named.
 */
export function judgeCheckoutRow(row: CheckoutListRow, diff: CheckoutDiffInput, now: number, idleMs: number): CheckoutJudgment {
	const idleHours = checkoutIdleHours(row.touched, now);
	const touchedMs = row.touched === null ? NaN : Date.parse(row.touched);
	if (!isValidCheckoutName(row.name)) return { eligible: false, reason: "invalid-name", idleHours };
	if (idleHours === null || !Number.isFinite(touchedMs)) return { eligible: false, reason: "touch-unknown", idleHours };
	if (now - touchedMs < idleMs) return { eligible: false, reason: "active-touched-recently", idleHours };
	if (!diff.available) return { eligible: false, reason: "diff-unavailable", idleHours };
	if (diff.unhandled === true) return { eligible: false, reason: "diff-unhandled", idleHours };
	if (diff.empty !== true) return { eligible: false, reason: "has-unlanded-changes", idleHours };
	if (row.dirty) return { eligible: false, reason: "dirty-unverified", idleHours };
	return { eligible: true, reason: "idle-empty-eligible", idleHours };
}

export interface CheckoutPlanDeps {
	now?: number;
	idleDays?: number;
	list?: () => { rows: CheckoutListRow[] } | { unavailable: string };
	diff?: (name: string) => CheckoutDiffInput;
	sizeBytes?: (path: string) => number | null;
	/** Size at most this many eligible rows (the idlest first); the rest stay unmeasured. Default: all. */
	sizeLimit?: number;
}

export interface CheckoutPlanRow extends CheckoutJudgment {
	name: string;
	path: string;
	source: string;
	dirty: boolean;
	touched: string | null;
	diffEmpty: boolean | null;
	bytes: number | null;
}

export interface CheckoutPlan {
	rows: CheckoutPlanRow[];
	eligible: CheckoutPlanRow[];
	eligibleBytes: number;
	unmeasuredBytes: number;
	idleDays: number;
}

/** Read-only inventory: every checkout judged, eligible first then idlest first. Never deletes. */
export function planCheckoutReap(deps: CheckoutPlanDeps = {}): CheckoutPlan {
	const now = deps.now ?? Date.now();
	const idleDays = deps.idleDays ?? CHECKOUT_IDLE_DAYS_DEFAULT;
	const idleMs = idleDays * 86_400_000;
	const listed = deps.list ? deps.list() : { unavailable: "no lister" };
	const rows: CheckoutPlanRow[] = [];
	if ("unavailable" in listed) return { rows, eligible: [], eligibleBytes: 0, unmeasuredBytes: 0, idleDays };
	for (const row of listed.rows) {
		const diffInput = row.dirty ? (deps.diff?.(row.name) ?? { available: false }) : { available: true, empty: true };
		const judged = judgeCheckoutRow(row, diffInput, now, idleMs);
		rows.push({ ...judged, name: row.name, path: row.path, source: row.source, dirty: row.dirty,
			touched: row.touched, diffEmpty: diffInput.available ? (diffInput.empty ?? null) : null, bytes: null });
	}
	rows.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.idleHours ?? -1) - (a.idleHours ?? -1));
	const eligible = rows.filter((row) => row.eligible);
	// CHECKOUTBUDGET1: `du -sk` of an NFS-served checkout runs into its deadline (30 s) nearly every time, and the
	// reaper sized every eligible row (18 rows: 540 s) to reap at most ten, so the job spent its 30 minute cap
	// measuring. Only the rows that can be acted on are sized, in reap order.
	let sized = 0;
	const sizeLimit = Math.max(0, deps.sizeLimit ?? Number.POSITIVE_INFINITY);
	for (const row of eligible) {
		if (sized >= sizeLimit) break;
		row.bytes = deps.sizeBytes?.(row.path) ?? null;
		sized += 1;
	}
	return {
		rows,
		eligible,
		eligibleBytes: eligible.reduce((n, row) => n + (row.bytes ?? 0), 0),
		unmeasuredBytes: eligible.filter((row) => row.bytes === null).length,
		idleDays,
	};
}

/** Verbatim `ovnfs diff -p --binary`: git-format patch WITH binary payloads, which plain `-p` omits. Null when unreadable or over the cap. */
export function collectOvnfsPatch(name: string, cwd: string): string | null {
	if (!isValidCheckoutName(name)) return null;
	try {
		const run = runSync(["ovnfs", "diff", "-p", "--binary", name], { cwd, deadline_s: DIFF_DEADLINE_S, max_output_bytes: CHECKOUT_MAX_PATCH_BYTES + 1024 });
		if (run.rc !== 0 || run.truncated) return null;
		return new TextDecoder().decode(run.stdout);
	} catch {
		return null;
	}
}

export interface ArchiveInput {
	name: string;
	checkoutPath: string;
	sourceRepo: string;
	sourceHead: string;
	destDir: string;
	/** Test seam: bypasses `ovnfs diff -p --binary`. Production never passes one. */
	patchText?: string;
	now?: number;
	/** Owned scratch root for the verify-tree export; defaults to the OS temp dir. */
	tmpRoot?: string;
}

export interface ArchiveResult {
	verified: boolean;
	archiveDir: string;
	patchBytes: number;
	reason: string;
}

/**
 * Archive one checkout's unlanded work: `checkout.patch` (verbatim ovnfs --binary patch, so binary
 * changes ride along and `git apply` takes the whole thing) plus `manifest.json`. Verified by exporting
 * the recorded HEAD tree and running `git apply --check` against it — never against the live source,
 * which may have moved on. Anything unverifiable refuses the reap.
 */
export function archiveCheckout(input: ArchiveInput): ArchiveResult {
	const at = new Date(input.now ?? Date.now()).toISOString();
	const fail = (reason: string): ArchiveResult => ({ verified: false, archiveDir: input.destDir, patchBytes: 0, reason });
	const patch = input.patchText ?? collectOvnfsPatch(input.name, input.sourceRepo);
	if (patch === null) return fail("archive-diff-unavailable");
	if (Buffer.byteLength(patch, "utf8") > CHECKOUT_MAX_PATCH_BYTES) return fail("archive-too-large");
	if (patch.trim() === "") return fail("archive-empty-diff");
	try {
		mkdirSync(input.destDir, { recursive: true, mode: 0o700 });
	} catch {
		return fail("archive-mkdir-failed");
	}
	const patchPath = join(input.destDir, "checkout.patch");
	try {
		writeFileSync(patchPath, patch, { encoding: "utf8", mode: 0o600 });
	} catch {
		return fail("archive-write-failed");
	}
	const patchBytes = Buffer.byteLength(patch, "utf8");
	const patchSha256 = createHash("sha256").update(patch, "utf8").digest("hex");
	const manifest = {
		checkout: input.name,
		checkoutPath: input.checkoutPath,
		source: input.sourceRepo,
		sourceHead: input.sourceHead,
		archivedAt: at,
		patch: "checkout.patch",
		patchSha256,
		patchBytes,
		verifier: "git apply --check against the recorded HEAD tree",
	};
	try {
		writeFileSync(join(input.destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	} catch {
		return fail("archive-write-failed");
	}
	if (!verifyArchivePatch(patchPath, input.sourceRepo, input.sourceHead)) return { verified: false, archiveDir: input.destDir, patchBytes, reason: "archive-unverifiable" };
	return { verified: true, archiveDir: input.destDir, patchBytes, reason: "archive-verified" };
}

/** Export the recorded HEAD tree to owned scratch and `git apply --check` the patch against it. */
function verifyArchivePatch(patchPath: string, sourceRepo: string, sourceHead: string, tmpRoot?: string): boolean {
	if (!/^[0-9a-f]{40}$/.test(sourceHead)) return false;
	let tree: string;
	try {
		tree = ownedTmp("checkout-verify", tmpRoot === undefined ? {} : { root: tmpRoot }).path;
	} catch {
		return false;
	}
	try {
		const archived = runSync(["git", "-C", sourceRepo, "archive", sourceHead], { cwd: sourceRepo, deadline_s: DIFF_DEADLINE_S, max_output_bytes: CHECKOUT_MAX_PATCH_BYTES });
		if (archived.rc !== 0 || archived.truncated) return false;
		// The sync runner takes no stdin, so the tree transits through a temp file beside it, unlinked afterwards.
		const tarPath = join(tree, ".verify-tree.tar");
		try {
			writeFileSync(tarPath, archived.stdout);
		} catch {
			return false;
		}
		try {
			const extracted = runSync(["tar", "-x", "-f", tarPath, "-C", tree], { cwd: sourceRepo, deadline_s: DIFF_DEADLINE_S, max_output_bytes: 1 << 20 });
			if (extracted.rc !== 0) return false;
			// git apply skips patches outside a repository (rc 0, nothing applied): verify inside one.
			const initialized = runSync(["git", "init", "-q"], { cwd: tree, deadline_s: DIFF_DEADLINE_S, max_output_bytes: 1 << 20 });
			if (initialized.rc !== 0) return false;
			const checked = runSync(["git", "apply", "--check", patchPath], { cwd: tree, deadline_s: DIFF_DEADLINE_S, max_output_bytes: 1 << 20 });
			return checked.rc === 0;
		} finally {
			try {
				unlinkSync(tarPath);
			} catch { /* the verify tree is owned scratch; a leftover tar is inert */ }
		}
	} catch {
		return false;
	}
}

export interface CheckoutApplyDeps extends CheckoutPlanDeps {
	archiveRoot: string;
	maxReaps?: number;
	rm?: (name: string) => boolean;
	log?: (event: Record<string, unknown>) => void;
	/** Physical free bytes beside the archive root; defaults to a statfs probe, null fails open. A test pins both ends. */
	freeBytes?: () => number | null;
	/** Epoch ms after which no further reap may start; a reap is also not started when less than `reserveMs` remains. Unset: unbounded. */
	deadlineMs?: number;
	reserveMs?: number;
	/** Called with the checkout name just before its reap starts (the reaper forwards it as the action a timeout interrupted). */
	onReap?: (name: string) => void;
}

export interface CheckoutApplyResult {
	reaped: string[];
	kept: { name: string; reason: string }[];
	archives: string[];
	/** Logical bytes no longer pinned by the reaped checkouts (du estimates, not physical reclamation). */
	freedBytes: number;
	eligible: number;
	/** Physical free bytes beside the archive root before and after, and their delta (null when unmeasurable). */
	freeBytesBefore: number | null;
	freeBytesAfter: number | null;
	freedBytesDf: number | null;
}

/**
 * Reap eligible checkouts: re-list at apply time (a checkout touched since the plan is no longer idle),
 * re-diff before rm (a checkout changed since the plan keeps its bytes), archive with verification, then
 * `ovnfs rm`. Every refusal names its reason; every reap leaves a receipt with its archive and bytes.
 */
export function applyCheckoutReap(deps: CheckoutApplyDeps): CheckoutApplyResult {
	const now = deps.now ?? Date.now();
	const idleDays = deps.idleDays ?? CHECKOUT_IDLE_DAYS_DEFAULT;
	const measure = deps.freeBytes ?? (() => diskFreeBytes(deps.archiveRoot));
	const freeBytesBefore = measure();
	const plan = planCheckoutReap({ ...deps, sizeLimit: Math.min(deps.sizeLimit ?? Number.POSITIVE_INFINITY, deps.maxReaps ?? Number.POSITIVE_INFINITY) });
	const kept: { name: string; reason: string }[] = [];
	const reaped: string[] = [];
	const archives: string[] = [];
	let freedBytes = 0;
	const maxReaps = deps.maxReaps ?? plan.eligible.length;
	for (const row of plan.eligible.slice(0, Math.max(0, maxReaps))) {
		if (deps.deadlineMs !== undefined && Date.now() + (deps.reserveMs ?? CHECKOUT_REAP_RESERVE_MS_DEFAULT) > deps.deadlineMs) {
			kept.push({ name: row.name, reason: "run-deadline" });
			continue;
		}
		try { deps.onReap?.(row.name); } catch { /* progress reports never fail a reap */ }
		const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
		const archiveDir = join(deps.archiveRoot, stamp.slice(0, 10), `${row.name}-${stamp.slice(11, 19)}`);
		const archived = archiveCheckout({ name: row.name, checkoutPath: row.path, sourceRepo: row.source,
			sourceHead: sourceHeadOf(row.source), destDir: archiveDir, now });
		if (!archived.verified) {
			kept.push({ name: row.name, reason: archived.reason });
			continue;
		}
		const remove = deps.rm ?? removeCheckout;
		let ok = false;
		try {
			ok = remove(row.name);
		} catch {
			ok = false;
		}
		if (!ok) {
			kept.push({ name: row.name, reason: "rm-failed" });
			continue;
		}
		reaped.push(row.name);
		archives.push(archived.archiveDir);
		freedBytes += row.bytes ?? 0;
		try {
			deps.log?.({ event: "checkout-reaped", dir: row.path, at: new Date(now).toISOString(), checkout: row.name,
				source: row.source, archive: archived.archiveDir, patchBytes: archived.patchBytes, sizeBytes: row.bytes ?? 0 });
		} catch { /* receipts never fail a reap */ }
	}
	const freeBytesAfter = measure();
	const freedBytesDf = freeBytesBefore === null || freeBytesAfter === null ? null : freeBytesAfter - freeBytesBefore;
	return { reaped, kept, archives, freedBytes, eligible: plan.eligible.length, freeBytesBefore, freeBytesAfter, freedBytesDf };
}

/** Recorded HEAD of the source repo for the verify export; empty when unprovable (archive then refuses). */
function sourceHeadOf(source: string): string {
	try {
		const run = runSync(["git", "-C", source, "rev-parse", "HEAD"], { cwd: source, deadline_s: DIFF_DEADLINE_S, max_output_bytes: 1 << 20 });
		if (run.rc !== 0) return "";
		const head = new TextDecoder().decode(run.stdout).trim();
		return /^[0-9a-f]{40}$/.test(head) ? head : "";
	} catch {
		return "";
	}
}

function removeCheckout(name: string): boolean {
	try {
		const run = runSync(["ovnfs", "rm", name], { cwd: process.cwd(), deadline_s: 60, max_output_bytes: 1 << 20 });
		return run.rc === 0;
	} catch {
		return false;
	}
}

/** Production lister: server-side idle filter (fast). `--no-diff` is deliberately not passed: it makes the
 * daemon diff every checkout and times out on a fleet this size. Dirty rows get a bounded client-side diff. */
export function listIdleEmptyCheckouts(cwd: string, idleDays: number): { rows: CheckoutListRow[] } | { unavailable: string } {
	const listed = listOvnfsCheckouts(cwd, ["--idle", `${idleDays}d`]);
	if ("unavailable" in listed) return { unavailable: listed.unavailable };
	return { rows: listed.rows.map(toListRow) };
}

/** Production client diff for dirty rows: `--binary` so the archive carries binary payloads. */
export function diffCheckoutEmpty(name: string, cwd: string): CheckoutDiffInput {
	if (!isValidCheckoutName(name)) return { available: false };
	const parsed = diffOvnfsCheckout(cwd, name);
	if ("unavailable" in parsed) return { available: false };
	if ("unhandled" in parsed) return { available: true, unhandled: true };
	return { available: true, empty: parsed.changes.length === 0 };
}

/** Physical free bytes on the volume holding path; null when unprovable (fail open). */
export function diskFreeBytes(path: string): number | null {
	try {
		const stats = statfsSync(path);
		if (!Number.isFinite(stats.bavail) || !Number.isFinite(stats.bsize) || stats.bavail < 0 || stats.bsize <= 0) return null;
		return Math.round(stats.bavail * stats.bsize);
	} catch {
		return null;
	}
}
/** Production sizer: best-effort `du -sk`, null on timeout (unmeasured, never blocking). */
export function sizeCheckoutBytes(path: string): number | null {
	try {
		const run = runSync(["du", "-sk", path], { cwd: dirname(path), deadline_s: DU_DEADLINE_S, max_output_bytes: 1 << 20 });
		if (run.rc !== 0) return null;
		const kb = Number(new TextDecoder().decode(run.stdout).split("	", 1)[0]);
		if (!Number.isFinite(kb) || kb < 0) return null;
		return Math.round(kb * 1024);
	} catch {
		return null;
	}
}

/** Day-sharded archive root beside the scratch state: `<state>/omp-kit/checkout-archive`. */
export function checkoutArchiveRoot(home: string): string {
	return join(stateRoot(home), "omp-kit", "checkout-archive");
}

