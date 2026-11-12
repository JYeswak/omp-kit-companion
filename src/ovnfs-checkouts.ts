import { lstatSync, realpathSync, type Stats } from "node:fs";
import { resolve } from "node:path";
import { runSync, type RunResult } from "./kitlib/run.ts";

/**
 * LANDREAPDEFAULT1 (ompkit-1ra0d.201): after a successful land publication,
 * land removes every matching checkout whose ENTIRE diff against its base is
 * contained in what was just published, unless `--keep-checkout` is passed.
 * `--checkout NAME` (or, for `land --patch`, a patch file inside a checkout's
 * path) pins the removal to one checkout; a checkout with any further change
 * is kept and named. The single judge is `judgeAndRemoveRow`, shared by the
 * named path and the default unnamed sweep.
 */

export const OVNFS_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const OVNFS_SCAN_BUDGET_MS = 2500;
const ALLOWED_DIFF_STATUS = new Set(["A", "M", "D", "T"]);

export type OvnfsCheckoutRow = {
  name: string;
  path: string;
  source: string;
  dirty: boolean;
  created: string | null;
  touched: string | null;
};

export type OvnfsKept = { name: string; unappliedPaths: string[] };

export type OvnfsPresence = "present" | "absent" | "unavailable";
export type CheckoutScanStatus = "OK" | "TIMED_OUT" | "SKIPPED" | "UNAVAILABLE";

export type ReapResult = {
  ovnfs: OvnfsPresence;
  checkoutScan: CheckoutScanStatus;
  checkoutsRemoved: string[];
  checkoutsKept: OvnfsKept[];
  checkoutsMatching: string[];
  checkout_text: string;
  elapsed_s: number;
};

export type OvnfsListOk = { rows: OvnfsCheckoutRow[] };
export type OvnfsListUnavailable = { unavailable: string };
export type OvnfsDiffChange = { path: string; status: string };
export type OvnfsDiffOk = { changes: OvnfsDiffChange[] };
export type OvnfsDiffUnavailable = { unavailable: true };
export type BlobIdentity = { present: boolean; oid: string | null; mode: string | null };

const LS_DEADLINE_S = 3;
const DIFF_DEADLINE_S = 2;
const RM_DEADLINE_S = 5;
const GIT_DEADLINE_S = 3;
const MAX_OUTPUT_BYTES = 1 << 20;

export function isValidCheckoutName(name: string): boolean {
  return OVNFS_NAME_PATTERN.test(name);
}

/** Diff paths are repository-relative source paths: never absolute, never escaping. */
export function isValidDiffPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.includes("\0") || path.includes("\n")) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (path.startsWith("./") || path === ".") return false;
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

/** Resolved checkout file stays inside the checkout root. */
export function checkoutFileInsideRoot(root: string, rel: string): string | null {
  const base = resolve(root);
  const full = resolve(base, rel);
  if (full !== base && !full.startsWith(`${base}/`)) return null;
  return full;
}
/** Realpath containment: the parent dir of each diff path must resolve inside the checkout root. Lexical `resolve` alone follows no symlinks, so a `link -> outside` dir would wrongly pass. */
function pathEscapesCheckout(root: string, rel: string): "ok" | "escapes" | "unknown" {
	const slash = rel.lastIndexOf("/");
	const absParent = slash < 0 ? resolve(root) : resolve(root, rel.slice(0, slash));
	let realParent: string;
	try {
		realParent = realpathSync(absParent);
	} catch {
		return "unknown";
	}
	let realRoot: string;
	try {
		realRoot = realpathSync(resolve(root));
	} catch {
		return "unknown";
	}
	if (realParent === realRoot || realParent.startsWith(`${realRoot}/`)) return "ok";
	return "escapes";
}

function touchedMs(row: OvnfsCheckoutRow): number {
  if (row.touched === null) return NaN;
  return Date.parse(row.touched);
}

type LsParse = { rows: OvnfsCheckoutRow[] } | { error: string };

function readLsList(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === "object" && "checkouts" in parsed) {
    const holder = parsed as { checkouts?: unknown };
    return holder.checkouts;
  }
  return parsed;
}

function toCheckoutRow(entry: unknown): OvnfsCheckoutRow | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (!("name" in entry) || !("path" in entry) || !("source" in entry) || !("dirty" in entry)) return null;
  const record = entry as { name: unknown; path: unknown; source: unknown; dirty: unknown; created?: unknown; touched?: unknown };
  if (typeof record.name !== "string" || typeof record.path !== "string" || typeof record.source !== "string") return null;
  if (!isValidCheckoutName(record.name)) return null;
  if (typeof record.dirty !== "boolean") return null;
  return {
    name: record.name,
    path: record.path,
    source: record.source,
    dirty: record.dirty,
    created: typeof record.created === "string" ? record.created : null,
    touched: typeof record.touched === "string" ? record.touched : null,
  };
}

function parseLsJson(stdout: string): LsParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { error: "unparseable" };
  }
  const list = readLsList(parsed);
  if (!Array.isArray(list)) return { error: "unparseable" };
  const rows: OvnfsCheckoutRow[] = [];
  for (const entry of list) {
    const row = toCheckoutRow(entry);
    if (row !== null) rows.push(row);
  }
  return { rows };
}

function isAbsentError(message: string): boolean {
  return message.includes("ENOENT") || message.includes("not found") || message.includes("No such file");
}

export function listOvnfsCheckouts(cwd: string): OvnfsListOk | OvnfsListUnavailable {
  let run: RunResult;
  try {
    run = runSync(["ovnfs", "ls", "--json"], { cwd, deadline_s: LS_DEADLINE_S, max_output_bytes: MAX_OUTPUT_BYTES });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { unavailable: isAbsentError(message) ? "absent" : "unavailable" };
  }
  if (run.timed_out || run.killed || run.truncated || run.rc !== 0) {
    const stderr = new TextDecoder().decode(run.stderr);
    if (isAbsentError(stderr)) return { unavailable: "absent" };
    return { unavailable: "unavailable" };
  }
  const parsed = parseLsJson(new TextDecoder().decode(run.stdout));
  if ("error" in parsed) return { unavailable: "unavailable" };
  return { rows: parsed.rows };
}

type DiffParse = OvnfsDiffOk | OvnfsDiffUnavailable | { unhandled: true };

const PATH_LIKE_KEYS = new Set(["path", "old_path", "new_path", "from", "to", "src", "dst", "file"]);

function readDiffList(parsed: unknown): unknown {
  if (parsed !== null && typeof parsed === "object" && "changes" in parsed) {
    const holder = parsed as { changes?: unknown };
    return holder.changes;
  }
  return parsed;
}

function parseDiffJson(stdout: string): DiffParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { unavailable: true };
  }
  const changes = readDiffList(parsed);
  if (!Array.isArray(changes)) return { unavailable: true };
  const out: OvnfsDiffChange[] = [];
  for (const entry of changes) {
    if (typeof entry === "string") {
      const tab = entry.indexOf("\t");
      const path = tab < 0 ? entry.trim() : entry.slice(tab + 1);
      if (path.length > 0) out.push({ path, status: "M" });
      continue;
    }
    if (entry !== null && typeof entry === "object" && "path" in entry) {
      const record = entry as Record<string, unknown>;
      if (typeof record["path"] !== "string") return { unhandled: true };
      for (const key of Object.keys(record)) {
        if (key !== "path" && key !== "status" && PATH_LIKE_KEYS.has(key)) return { unhandled: true };
      }
      const status = record["status"];
      if (typeof status !== "string" || !ALLOWED_DIFF_STATUS.has(status)) return { unhandled: true };
      const path = record["path"] as string;
      out.push({ path, status: status as string });
    } else {
      return { unhandled: true };
    }
  }
  return { changes: out };
}

export function diffOvnfsCheckout(cwd: string, name: string): DiffParse {
  if (!isValidCheckoutName(name)) return { unavailable: true };
  let run: RunResult;
  try {
    run = runSync(["ovnfs", "diff", name, "--json"], { cwd, deadline_s: DIFF_DEADLINE_S, max_output_bytes: MAX_OUTPUT_BYTES });
  } catch {
    return { unavailable: true };
  }
  if (run.timed_out || run.killed || run.truncated || run.rc !== 0) return { unavailable: true };
  return parseDiffJson(new TextDecoder().decode(run.stdout));
}

function gitLsTreeIdentity(repo: string, rev: string, path: string): BlobIdentity | null {
  let run: RunResult;
  try {
    run = runSync(["git", "ls-tree", rev, "--", `:(literal)${path}`], { cwd: repo, deadline_s: GIT_DEADLINE_S, max_output_bytes: MAX_OUTPUT_BYTES });
  } catch {
    return null;
  }
  if (run.timed_out || run.killed || run.truncated || run.rc !== 0) return null;
  const line = new TextDecoder().decode(run.stdout).trimEnd();
  if (line.length === 0) return { present: false, oid: null, mode: null };
  const tab = line.indexOf("\t");
  if (tab < 0) return null;
  const fields = line.slice(0, tab).split(" ");
  if (fields.length !== 3 || !fields[0] || !fields[1] || !fields[2]) return null;
  if (fields[1] !== "blob") return { present: true, oid: null, mode: fields[0] ?? null };
  return { present: true, oid: fields[2] ?? null, mode: fields[0] ?? null };
}

function errnoCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error) {
    const holder = error as { code?: unknown };
    return typeof holder.code === "string" ? holder.code : null;
  }
  return null;
}

function checkoutFileOid(repo: string, absFile: string): BlobIdentity | null {
  let stat: Stats | null = null;
  try {
    stat = lstatSync(absFile);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { present: false, oid: null, mode: null };
    return null;
  }
  if (stat === null || !stat.isFile()) return null;
  let run: RunResult;
  try {
    run = runSync(["git", "hash-object", "--", absFile], { cwd: repo, deadline_s: GIT_DEADLINE_S, max_output_bytes: MAX_OUTPUT_BYTES });
  } catch {
    return null;
  }
  if (run.timed_out || run.killed || run.truncated || run.rc !== 0) return null;
  const oid = new TextDecoder().decode(run.stdout).trim();
  if (oid.length === 0) return null;
  return { present: true, oid, mode: null };
}

function checkoutFileMode(absFile: string): string | null {
  let stat: Stats;
  try {
    stat = lstatSync(absFile);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

function gitCheckIgnored(repo: string, path: string): boolean | null {
  let run: RunResult;
  try {
    run = runSync(["git", "check-ignore", "-q", "--", `:(literal)${path}`], { cwd: repo, deadline_s: GIT_DEADLINE_S, max_output_bytes: 64 * 1024 });
  } catch {
    return null;
  }
  if (run.timed_out || run.killed || run.truncated) return null;
  if (run.rc === 0) return true;
  if (run.rc === 1) return false;
  return null;
}

function removeCheckout(cwd: string, name: string): boolean {
  if (!isValidCheckoutName(name)) return false;
  try {
    const run = runSync(["ovnfs", "rm", name], { cwd, deadline_s: RM_DEADLINE_S, max_output_bytes: 256 * 1024 });
    return !run.timed_out && !run.killed && !run.truncated && run.rc === 0;
  } catch {
    return false;
  }
}

function sameDiff(a: OvnfsDiffChange[], b: OvnfsDiffChange[]): boolean {
  if (a.length !== b.length) return false;
  const key = (entry: OvnfsDiffChange): string => `${entry.status}\0${entry.path}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}

function visibleUnapplied(repo: string, paths: string[]): string[] {
  const visible: string[] = [];
  for (const path of paths) {
    const ignored = gitCheckIgnored(repo, path);
    if (ignored !== true) visible.push(path);
  }
  return visible;
}

/** Byte+mode equality for one landed path; null when unreadable. */
function pathMatchesLanded(repo: string, checkoutRoot: string, path: string, landedRev: string): boolean | null {
  const full = checkoutFileInsideRoot(checkoutRoot, path);
  if (full === null) return null;
  let stat: Stats;
  try {
    stat = lstatSync(full);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      const landed = gitLsTreeIdentity(repo, landedRev, path);
      if (landed === null) return null;
      return !landed.present;
    }
    return null;
  }
  if (!stat.isFile()) return false;
  const landed = gitLsTreeIdentity(repo, landedRev, path);
  if (landed === null) return null;
  if (!landed.present) return false;
  if (landed.mode !== null && landed.mode !== "100644" && landed.mode !== "100755") return false;
  const checkoutOid = checkoutFileOid(repo, full);
  if (checkoutOid === null) return null;
  if (!checkoutOid.present || checkoutOid.oid !== landed.oid) return false;
  if (landed.mode !== null) {
    const checkoutMode = checkoutFileMode(full);
    if (checkoutMode === null || checkoutMode !== landed.mode) return false;
  }
  return true;
}

function findPatchCheckout(rows: OvnfsCheckoutRow[], repo: string, patchFile: string): OvnfsCheckoutRow | null {
  let best: OvnfsCheckoutRow | null = null;
  for (const row of rows) {
    let sourceOk = false;
    try {
      sourceOk = resolve(row.source) === resolve(repo);
    } catch {
      continue;
    }
    if (!sourceOk) continue;
    const base = resolve(row.path);
    if (patchFile === base || patchFile.startsWith(`${base}/`)) {
      if (best === null || base.length > resolve(best.path).length) best = row;
    }
  }
  return best;
}

type RowReap = {
  removed: string[];
  kept: OvnfsKept[];
  matching: string[];
  /** The row's diff overlaps at least one landed path (or the rm itself was attempted). */
  overlaps: boolean;
  scan: CheckoutScanStatus;
  /** Single-checkout sentence; empty when the row is unrelated to this land. */
  note: string;
};

/**
 * LANDREAPDEFAULT1 (ompkit-1ra0d.201): the single safety judge for one
 * checkout row, shared by the named path and the default unnamed sweep.
 * A row is removable only when its ENTIRE diff against its base is contained
 * in what was just published (no further unlanded change, no untracked
 * non-ignored file: both surface as unapplied diff paths), every landed
 * path still matches the published bytes plus modes, and a re-check right
 * before `ovnfs rm` sees the same diff and bytes. Anything else is kept and
 * named. Never throws; fail-open keeps the land PUSHED.
 */
function judgeAndRemoveRow(args: {
  repo: string;
  row: OvnfsCheckoutRow;
  landedSet: Set<string>;
  landedRev: string;
  started: number;
  budgetMs: number;
  isNamed: boolean;
}): RowReap {
  const { repo, row, landedSet, landedRev, started, budgetMs, isNamed } = args;
  const clean = (note: string): RowReap => ({ removed: [], kept: [], matching: [], overlaps: false, scan: "OK", note });
  const keep = (unappliedPaths: string[], note: string, opts?: { matching?: string[]; overlaps?: boolean; scan?: CheckoutScanStatus }): RowReap => ({
    removed: [],
    kept: [{ name: row.name, unappliedPaths }],
    matching: opts?.matching ?? [],
    overlaps: opts?.overlaps ?? false,
    scan: opts?.scan ?? "OK",
    note,
  });
  const noChangesNote = isNamed ? `Named checkout ${row.name} has no changes; nothing removed.` : "";
  if (!row.dirty) return clean(noChangesNote);
  const first = diffOvnfsCheckout(repo, row.name);
  if ("unavailable" in first) {
    return keep(["<diff-unavailable>"], `Kept ${row.name}: checkout diff unreadable before rm.`);
  }
  if ("unhandled" in first) {
    return keep(["<unhandled-diff-shape>"], `Kept ${row.name}: unhandled diff shape.`);
  }
  const validPaths = first.changes.map((change) => change.path).filter(isValidDiffPath);
  if (validPaths.length !== first.changes.length) {
    return keep(["<invalid-path>"], `Kept ${row.name}: invalid diff path.`);
  }
  if (validPaths.length === 0) return clean(noChangesNote);
  for (const path of validPaths) {
    if (pathEscapesCheckout(row.path, path) === "escapes") {
      return keep(["<path-escapes-checkout>"], `Kept ${row.name}: a checkout path resolves outside the checkout root.`);
    }
  }
  if (!validPaths.some((path) => landedSet.has(path))) return clean("");
  const unapplied = validPaths.filter((path) => !landedSet.has(path));
  const visible = visibleUnapplied(repo, unapplied);
  if (visible.length > 0) {
    return keep(visible, `Kept ${row.name} with further changes: ${visible.join(", ")}.`, { overlaps: true });
  }
  for (const path of validPaths) {
    if (!landedSet.has(path)) continue;
    const match = pathMatchesLanded(repo, row.path, path, landedRev);
    if (match !== true) {
      return keep([path], `Kept ${row.name}: ${path} differs (bytes or mode).`, { overlaps: true });
    }
  }
  if (performance.now() - started > budgetMs) {
    return keep(["<recheck-timeout>"], `Kept ${row.name}: re-check timed out before rm.`, { overlaps: true, scan: "TIMED_OUT" });
  }
  const second = diffOvnfsCheckout(repo, row.name);
  if ("unavailable" in second || ("unhandled" in second)) {
    return keep(["<recheck-unavailable>"], `Kept ${row.name}: re-check diff unreadable before rm.`, { overlaps: true });
  }
  if (!sameDiff(first.changes, second.changes)) {
    return keep(["<changed-before-rm>"], `Kept ${row.name}: checkout changed before rm.`, { overlaps: true });
  }
  for (const path of validPaths) {
    if (!landedSet.has(path)) continue;
    const match = pathMatchesLanded(repo, row.path, path, landedRev);
    if (match !== true) {
      return keep([path], `Kept ${row.name}: ${path} changed before rm.`, { overlaps: true });
    }
  }
  // The final reads above cost wall-clock too: re-check the TOTAL budget
  // after them, immediately before `ovnfs rm`.
  if (performance.now() - started > budgetMs) {
    return keep(["<rm-timeout>"], `Kept ${row.name}: sweep budget expired before rm.`, { overlaps: true, scan: "TIMED_OUT" });
  }
  if (removeCheckout(repo, row.name)) {
    return {
      removed: [row.name],
      kept: [],
      matching: [row.name],
      overlaps: true,
      scan: "OK",
      note: `Removed ovnfs checkout ${row.name}.`,
    };
  }
  return keep(["<rm-failed>"], `Kept ${row.name}: rm failed. Land stays PUSHED; remove it with \`ovnfs rm ${row.name}\`.`, { matching: [row.name], overlaps: true });
}

/**
 * Named removal, or the default sweep removing every fully-landed match.
 * Never throws; fail-open keeps the land PUSHED.
 */
export function reapLandedCheckouts(input: {
  repo: string;
  landedPaths: string[];
  landedRev: string;
  landedBaseTimeMs?: number | null;
  namedCheckout?: string | null;
  patchFile?: string | null;
  keepCheckout?: boolean;
  budgetMs?: number;
}): ReapResult {
  const started = performance.now();
  const elapsed = (): number => (performance.now() - started) / 1000;
  const budgetMs = input.budgetMs ?? OVNFS_SCAN_BUDGET_MS;
  const repo = resolve(input.repo);
  const landedSet = new Set(input.landedPaths.filter(isValidDiffPath));
  const done = (partial: Omit<ReapResult, "elapsed_s">): ReapResult => ({ ...partial, elapsed_s: elapsed() });
  if (input.keepCheckout === true) {
    return done({
      ovnfs: "present",
      checkoutScan: "SKIPPED",
      checkoutsRemoved: [],
      checkoutsKept: [],
      checkoutsMatching: [],
      checkout_text: "Checkout retention skipped (--keep-checkout); without it land removes every matching checkout whose whole diff was published, `ovnfs rm <name>` is for abandoned ones.",
    });
  }
  if (landedSet.size === 0 || input.landedRev.trim().length === 0) {
    return done({
      ovnfs: "present",
      checkoutScan: "OK",
      checkoutsRemoved: [],
      checkoutsKept: [],
      checkoutsMatching: [],
      checkout_text: "No landed paths to match; no ovnfs checkout removed.",
    });
  }
  const listed = listOvnfsCheckouts(repo);
  if ("unavailable" in listed) {
    const absent = listed.unavailable === "absent";
    return done({
      ovnfs: absent ? "absent" : "unavailable",
      checkoutScan: "UNAVAILABLE",
      checkoutsRemoved: [],
      checkoutsKept: [],
      checkoutsMatching: [],
      checkout_text: absent
        ? "Checkout scan skipped (ovnfs absent); land published, nothing removed."
        : "Checkout scan unavailable; land published, nothing removed.",
    });
  }
  const sameRepo = listed.rows.filter((row) => {
    try {
      return resolve(row.source) === repo;
    } catch {
      return false;
    }
  });
  let namedRow: OvnfsCheckoutRow | null = null;
  if (typeof input.namedCheckout === "string" && input.namedCheckout.length > 0) {
    if (!isValidCheckoutName(input.namedCheckout)) {
      return done({
        ovnfs: "present",
        checkoutScan: "OK",
        checkoutsRemoved: [],
        checkoutsKept: [{ name: input.namedCheckout, unappliedPaths: ["<invalid-name>"] }],
        checkoutsMatching: [],
        checkout_text: `Named checkout ${input.namedCheckout} is not a valid ovnfs name; nothing removed. Land removes every matching checkout whose whole diff was published; \`ovnfs rm <name>\` is for abandoned ones.`,
      });
    }
    namedRow = sameRepo.find((row) => row.name === input.namedCheckout) ?? null;
    if (namedRow === null) {
      return done({
        ovnfs: "present",
        checkoutScan: "OK",
        checkoutsRemoved: [],
        checkoutsKept: [{ name: input.namedCheckout, unappliedPaths: ["<unknown-checkout>"] }],
        checkoutsMatching: [],
        checkout_text: `Named checkout ${input.namedCheckout} is not this repository's checkout; nothing removed.`,
      });
    }
  } else if (typeof input.patchFile === "string" && input.patchFile.length > 0) {
    namedRow = findPatchCheckout(sameRepo, repo, resolve(input.patchFile));
  }
  if (namedRow !== null) {
    const row = namedRow;
    const verdict = judgeAndRemoveRow({ repo, row, landedSet, landedRev: input.landedRev, started, budgetMs, isNamed: true });
    const text = verdict.removed.length > 0
      ? `Removed ovnfs checkout ${row.name}. All files inside it, including untracked and ignored ones, are removed with it; \`ovnfs rm <name>\` is for abandoned ones.`
      : verdict.note;
    return done({
      ovnfs: "present",
      checkoutScan: verdict.scan,
      checkoutsRemoved: verdict.removed,
      checkoutsKept: verdict.kept,
      checkoutsMatching: verdict.matching,
      checkout_text: text,
    });
  }
  // Recency orders the bounded sweep (newest first) but never excludes: a
  // fully-landed checkout is removable however old its touch time is.
  const candidates = sameRepo
    .filter((row) => row.dirty && isValidCheckoutName(row.name))
    .sort((left, right) => {
      const l = touchedMs(left);
      const r = touchedMs(right);
      if (!Number.isFinite(l) && !Number.isFinite(r)) return left.name < right.name ? -1 : 1;
      if (!Number.isFinite(l)) return 1;
      if (!Number.isFinite(r)) return -1;
      return (r as number) - (l as number);
    });
  const removed: string[] = [];
  const kept: OvnfsKept[] = [];
  const keptNotes: string[] = [];
  const matching: string[] = [];
  let timedOut = false;
  for (const row of candidates) {
    if (performance.now() - started > budgetMs) {
      timedOut = true;
      break;
    }
    const verdict = judgeAndRemoveRow({ repo, row, landedSet, landedRev: input.landedRev, started, budgetMs, isNamed: false });
    removed.push(...verdict.removed);
    kept.push(...verdict.kept);
    if (verdict.note.length > 0 && verdict.kept.length > 0) keptNotes.push(verdict.note);
    if (verdict.removed.length > 0 || verdict.overlaps) matching.push(row.name);
    if (verdict.scan === "TIMED_OUT") timedOut = true;
  }
  const lines: string[] = [];
  if (removed.length > 0) lines.push(`Removed ovnfs checkout${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}`);
  lines.push(...keptNotes);
  if (matching.length === 0) lines.push("No matching ovnfs checkouts");
  if (timedOut) lines.push(`checkoutScan TIMED_OUT after ${(budgetMs / 1000).toFixed(1)} s; sweep is partial`);
  lines.push("Land removes every matching checkout whose whole diff was published (--checkout NAME pins one; --keep-checkout keeps all); all files inside a removed checkout, including untracked and ignored ones, are removed with it. `ovnfs rm <name>` is for abandoned ones.");
  return done({
    ovnfs: "present",
    checkoutScan: timedOut ? "TIMED_OUT" : "OK",
    checkoutsRemoved: removed,
    checkoutsKept: kept,
    checkoutsMatching: matching,
    checkout_text: lines.join(". "),
  });
}

export type RepoCheckoutView = {
  name: string;
  path: string;
  dirty: boolean;
  age_s: number | null;
  touched_hours_ago: number | null;
  remove: string;
};

/**
 * Seat-relevant ovnfs checkouts for `scratch mine`: the calling repository's
 * checkouts with age, dirty flag, hours since touched and the exact rm line.
 * ovnfs records no creator, so this lists by repository, not by seat.
 * Fail-open: absent or erroring ovnfs yields an empty list with a note.
 */
export function listRepoCheckouts(repo: string, now: number = Date.now()): {
  ovnfs: OvnfsPresence;
  checkouts: RepoCheckoutView[];
  note: string;
} {
  let resolved: string | null = null;
  try {
    resolved = resolve(repo);
  } catch {
    resolved = null;
  }
  if (resolved === null) {
    return { ovnfs: "unavailable", checkouts: [], note: "ovnfs checkouts unavailable: repository could not be resolved." };
  }
  const listed = listOvnfsCheckouts(resolved);
  if ("unavailable" in listed) {
    const absent = listed.unavailable === "absent";
    return {
      ovnfs: absent ? "absent" : "unavailable",
      checkouts: [],
      note: absent
        ? "ovnfs is absent; no checkout inventory."
        : "ovnfs inventory unavailable; checkouts omitted, nothing was changed.",
    };
  }
  const views: RepoCheckoutView[] = [];
  for (const row of listed.rows) {
    let same = false;
    try {
      same = resolve(row.source) === resolved;
    } catch {
      continue;
    }
    if (!same) continue;
    const createdMs = row.created !== null ? Date.parse(row.created) : NaN;
    const touchedMsValue = row.touched !== null ? Date.parse(row.touched) : NaN;
    views.push({
      name: row.name,
      path: row.path,
      dirty: row.dirty,
      age_s: Number.isFinite(createdMs) ? Math.max(0, Math.round((now - createdMs) / 1000)) : null,
      touched_hours_ago: Number.isFinite(touchedMsValue) ? Math.max(0, Math.round(((now - touchedMsValue) / 3600000) * 10) / 10) : null,
      remove: `ovnfs rm ${row.name}`,
    });
  }
  views.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return {
    ovnfs: "present",
    checkouts: views,
    note: "ovnfs records no creator, so checkouts are listed by repository, not by seat. Land removes every matching checkout whose whole diff was published; `ovnfs rm <name>` is for abandoned ones.",
  };
}
