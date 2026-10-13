/**
 * ALIGN1 (ompkit-fp72.66): move a shared checkout's local `main` ref and index to
 * `refs/remotes/origin/main` without losing anyone's work.
 *
 * Agents publish through private indexes, so local main never advances. Hand-run
 * alignment (`update-index`, `read-tree -m -u`, `update-ref` as separate commands)
 * races with peers who stage between those steps. This helper instead:
 *
 * 1. takes git's own `.git/index.lock` (O_EXCL create) once and holds it, never
 *    renamed or re-created, until the final release; ownership (same inode) is
 *    re-checked right before the index rename, before the ref CAS, after a failed
 *    CAS and before reporting, and `.git/index` is never written unless this run
 *    owns the lock at that moment;
 * 2. snapshots the index bytes, `refs/heads/main` and `refs/remotes/origin/main`;
 *    every later index read uses a private copy of the snapshot bytes;
 * 3. refuses on staged changes against HEAD, an in-progress operation, or any path
 *    that differs between HEAD and the target whose worktree bytes match neither
 *    side (STOP: a peer's uncommitted work);
 * 4. pins local-only commits under `refs/preserve/<ISO-date>-<shortsha>` before
 *    main moves;
 * 5. writes worktree files only for UPDATE paths (worktree == HEAD, index == HEAD),
 *    re-checks the ref, the target and the old index bytes against the snapshot,
 *    writes the new index to a separate O_EXCL file beside it, fsyncs it, renames
 *    it over `index` while `index.lock` is still held, and moves main with a
 *    compare-and-swap on the snapshot value;
 * 6. restores the snapshot index bytes (same prepared-file route, under the lock)
 *    and the UPDATE paths if that CAS fails. If the lock stops being ours, the
 *    verdict is UNKNOWN, never ALIGNED: before the swap the UPDATE paths are
 *    rolled back; after it main is moved by CAS to match the swapped index. Either
 *    way the snapshot index bytes go to a recovery file, not to `.git/index`.
 *
 * Every child git process gets an environment with all `GIT_*` variables removed
 * (an inherited `GIT_DIR`, `GIT_INDEX_FILE` or `GIT_WORK_TREE` once overwrote the
 * companion index) plus explicit `--git-dir`/`--work-tree`.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
	mkdtempSync, openSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync,
	writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { CliResult, ParsedCommand } from "./cli.ts";

const MAIN_REF = "refs/heads/main";
const TARGET_REF = "refs/remotes/origin/main";
const ABSENT = "000000";
const SYMLINK = "120000";
const GITLINK = "160000";
const RECEIPT_LOG = "omp-kit-align.jsonl";
const ALIGN_MESSAGE = "omp-kit align: main -> origin/main";
const CONSISTENCY_MESSAGE = "omp-kit align: consistency CAS after index.lock loss";
const IN_PROGRESS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"];
const REGULAR_FILE: Record<string, true> = { "100644": true, "100755": true };

type Mode = "apply" | "dry-run" | "preserve-only";
type Ctx = { repo: string; gitDir: string; indexPath: string; lockPath: string; algo: "sha1" | "sha256"; fileMode: boolean; mode: Mode };
type Side = { mode: string; sha: string };
type Change = { path: string; head: Side; target: Side };
type Stop = { path: string; reason: string };
type Plan = { adopt: string[]; update: Change[]; stop: Stop[] };
type Worktree = { kind: "absent" } | { kind: "entry"; mode: string; sha: string } | { kind: "blocked"; reason: string };
type Snapshot = { main: string; target: string; indexBytes: Buffer; indexSha: string };
type Preserved = { ref: string; sha: string; commits: string[]; reused: boolean };
type GitRun = { code: number; out: Buffer; err: string };
type Lock = { fd: number | null; path: string };

/** A child environment with every inherited GIT_* selector removed. */
function gitEnv(indexFile?: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	if (indexFile) env.GIT_INDEX_FILE = indexFile;
	return env;
}

function git(ctx: Pick<Ctx, "repo" | "gitDir">, args: string[], indexFile?: string): GitRun {
	const run = spawnSync("git", ["--git-dir", ctx.gitDir, "--work-tree", ctx.repo, "--no-optional-locks", ...args], {
		cwd: ctx.repo, env: gitEnv(indexFile), timeout: 60_000, maxBuffer: 256 * 1024 * 1024,
	});
	return { code: run.status ?? 1, out: run.stdout ?? Buffer.alloc(0), err: String(run.stderr ?? "") };
}

function text(run: GitRun): string {
	return run.out.toString("utf8").trim();
}

function zList(run: GitRun): string[] {
	return run.out.toString("utf8").split("\0").filter((entry) => entry.length > 0);
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function blobId(ctx: Ctx, bytes: Buffer): string {
	return createHash(ctx.algo).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function errno(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function refusal(ctx: Pick<Ctx, "mode">, code: string, message: string, remediation: string, data: Record<string, unknown> = {}, verdict = "REFUSED"): CliResult {
	return { code: 2, data: { overall: "NOT_RUN", verdict, mode: ctx.mode, ...data }, errors: [{ code, message, remediation }], verification: "NOT_RUN" };
}

function readRef(ctx: Ctx, ref: string): string | null {
	const run = git(ctx, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
	return run.code === 0 ? text(run) : null;
}

function headIsMain(ctx: Ctx): boolean {
	const run = git(ctx, ["symbolic-ref", "-q", "HEAD"]);
	return run.code === 0 && text(run) === MAIN_REF;
}

/** Test barrier: for each phase listed in OMP_KIT_ALIGN_PAUSE_AT (comma-separated) with an absolute OMP_KIT_ALIGN_PAUSE_DIR, announce the pause on stderr and wait (max 30s) for <dir>/<phase>.go. */
function pause(phase: "snapshot" | "pre-swap" | "swap" | "post-cas"): void {
	if (!(process.env.OMP_KIT_ALIGN_PAUSE_AT ?? "").split(",").includes(phase)) return;
	const dir = process.env.OMP_KIT_ALIGN_PAUSE_DIR;
	if (!dir || !isAbsolute(dir)) return;
	writeSync(2, `omp-kit align: paused at ${phase}\n`);
	const cell = new Int32Array(new SharedArrayBuffer(4));
	const deadline = Date.now() + 30_000;
	while (!existsSync(join(dir, `${phase}.go`)) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 20);
}

function acquire(path: string): number | "HELD" | "ERROR" {
	try {
		return openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
	} catch (error) {
		return errno(error) === "EEXIST" ? "HELD" : "ERROR";
	}
}

/** True when the lock path still names the file this process created. */
function ownsLock(lock: Lock): boolean {
	if (lock.fd === null) return false;
	try {
		const held = fstatSync(lock.fd);
		const named = lstatSync(lock.path);
		return held.ino === named.ino && held.dev === named.dev;
	} catch {
		return false;
	}
}

function release(lock: Lock): void {
	if (lock.fd === null) return;
	const owned = ownsLock(lock);
	closeSync(lock.fd);
	lock.fd = null;
	if (owned) unlinkSync(lock.path);
}

/**
 * Replace .git/index with `bytes` through a separate prepared file (O_EXCL, fsync, rename).
 * index.lock itself is never written or renamed, so peers' git keeps refusing to write.
 * Ownership is checked right before the rename; false means the lock was lost and the index is untouched.
 */
function replaceIndex(ctx: Ctx, bytes: Buffer, lock: Lock): boolean {
	const prepared = join(ctx.gitDir, `index.omp-align.${process.pid}.${randomBytes(6).toString("hex")}`);
	const fd = openSync(prepared, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o666);
	try {
		try {
			let offset = 0;
			while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		if (!ownsLock(lock)) {
			unlinkSync(prepared);
			return false;
		}
		renameSync(prepared, ctx.indexPath);
		return true;
	} catch (error) {
		rmSync(prepared, { force: true });
		throw error;
	}
}

function readIndex(ctx: Ctx): Buffer | null {
	try {
		return readFileSync(ctx.indexPath);
	} catch {
		return null;
	}
}

function takeSnapshot(ctx: Ctx): Snapshot | CliResult {
	const indexBytes = readIndex(ctx);
	if (indexBytes === null) return refusal(ctx, "ALIGN_INDEX_UNREADABLE", "The shared .git/index could not be read", "Repair the index first; nothing was changed.");
	if (!headIsMain(ctx)) return refusal(ctx, "ALIGN_HEAD_NOT_MAIN", "HEAD is not the symbolic ref refs/heads/main", "Align only a checkout whose HEAD is main; nothing was changed.");
	const main = readRef(ctx, MAIN_REF);
	if (main === null) return refusal(ctx, "ALIGN_MAIN_MISSING", "refs/heads/main does not name a commit", "Repair the main ref; nothing was changed.");
	const target = readRef(ctx, TARGET_REF);
	if (target === null) return refusal(ctx, "ALIGN_TARGET_MISSING", "refs/remotes/origin/main does not name a commit", "Run git fetch origin (safe in a shared checkout) and retry; nothing was changed.");
	return { main, target, indexBytes, indexSha: sha256(indexBytes) };
}

/** Compares the live ref, target and index bytes with the snapshot; null when nothing moved. */
function recheck(ctx: Ctx, snap: Snapshot): { code: string; message: string } | null {
	if (!headIsMain(ctx)) return { code: "ALIGN_HEAD_CHANGED", message: "HEAD stopped pointing at refs/heads/main after the snapshot" };
	if (readRef(ctx, MAIN_REF) !== snap.main) return { code: "ALIGN_REF_CHANGED", message: "refs/heads/main changed after the snapshot (a peer advanced it)" };
	if (readRef(ctx, TARGET_REF) !== snap.target) return { code: "ALIGN_TARGET_CHANGED", message: "refs/remotes/origin/main changed after the snapshot" };
	const live = readIndex(ctx);
	if (live === null || !live.equals(snap.indexBytes)) return { code: "ALIGN_INDEX_CHANGED", message: "The shared index bytes changed after the snapshot (a peer staged without git's lock)" };
	return null;
}

function indexEntries(ctx: Ctx, snapshotIndex: string): Map<string, Side> | null {
	const run = git(ctx, ["ls-files", "-s", "-z"], snapshotIndex);
	if (run.code !== 0) return null;
	const entries = new Map<string, Side>();
	for (const row of zList(run)) {
		const tab = row.indexOf("\t");
		const [mode, sha, stage] = row.slice(0, tab).split(" ");
		if (tab < 0 || !mode || !sha || stage !== "0") return null;
		entries.set(row.slice(tab + 1), { mode, sha });
	}
	return entries;
}

function changedPaths(ctx: Ctx, snap: Snapshot): Change[] | null {
	const run = git(ctx, ["diff-tree", "-r", "-z", "--no-renames", snap.main, snap.target]);
	if (run.code !== 0) return null;
	const tokens = run.out.toString("utf8").split("\0");
	const changes: Change[] = [];
	for (let at = 0; at + 1 < tokens.length; at += 2) {
		const header = tokens[at] ?? "";
		const path = tokens[at + 1] ?? "";
		const [headMode, targetMode, headSha, targetSha] = header.slice(1).split(" ");
		if (!header.startsWith(":") || !headMode || !targetMode || !headSha || !targetSha || path.length === 0) return null;
		changes.push({ path, head: { mode: headMode, sha: headSha }, target: { mode: targetMode, sha: targetSha } });
	}
	return changes;
}

function worktreeState(ctx: Ctx, path: string): Worktree {
	const parts = path.split("/");
	let dir = ctx.repo;
	for (const part of parts.slice(0, -1)) {
		dir = join(dir, part);
		try {
			const stat = lstatSync(dir);
			if (!stat.isDirectory()) return { kind: "blocked", reason: `parent ${dir.slice(ctx.repo.length + 1)} is not a directory` };
		} catch (error) {
			if (errno(error) === "ENOENT") return { kind: "absent" };
			return { kind: "blocked", reason: `parent ${dir.slice(ctx.repo.length + 1)} is unreadable` };
		}
	}
	const full = join(ctx.repo, path);
	try {
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) return { kind: "entry", mode: SYMLINK, sha: blobId(ctx, readlinkSync(full, { encoding: "buffer" })) };
		if (stat.isFile()) return { kind: "entry", mode: (stat.mode & 0o100) !== 0 ? "100755" : "100644", sha: blobId(ctx, readFileSync(full)) };
		return { kind: "blocked", reason: stat.isDirectory() ? "a directory occupies the path" : "a special file occupies the path" };
	} catch (error) {
		return errno(error) === "ENOENT" ? { kind: "absent" } : { kind: "blocked", reason: "the worktree path is unreadable" };
	}
}

function sameAs(ctx: Ctx, state: Worktree, side: Side): boolean {
	if (side.mode === ABSENT) return state.kind === "absent";
	if (state.kind !== "entry" || state.sha !== side.sha) return false;
	return state.mode === side.mode || (!ctx.fileMode && REGULAR_FILE[state.mode] === true && REGULAR_FILE[side.mode] === true);
}

/** ADOPT: worktree == target; UPDATE: worktree == HEAD and index == HEAD; STOP: anything else. */
function classify(ctx: Ctx, changes: Change[], index: Map<string, Side>): Plan {
	const plan: Plan = { adopt: [], update: [], stop: [] };
	for (const change of changes) {
		if (change.head.mode === GITLINK || change.target.mode === GITLINK) {
			plan.stop.push({ path: change.path, reason: "submodule (gitlink) entries are never aligned automatically" });
			continue;
		}
		const state = worktreeState(ctx, change.path);
		if (state.kind === "blocked") {
			plan.stop.push({ path: change.path, reason: state.reason });
			continue;
		}
		if (sameAs(ctx, state, change.target)) {
			plan.adopt.push(change.path);
			continue;
		}
		const staged = index.get(change.path);
		const indexIsHead = change.head.mode === ABSENT ? staged === undefined : staged?.mode === change.head.mode && staged.sha === change.head.sha;
		if (sameAs(ctx, state, change.head) && indexIsHead) plan.update.push(change);
		else plan.stop.push({ path: change.path, reason: "worktree bytes match neither HEAD nor origin/main (uncommitted work)" });
	}
	return plan;
}

function pruneEmpty(ctx: Ctx, relative: string): void {
	for (let dir = relative; dir !== "." && dir !== "" && dir !== "/"; dir = dirname(dir)) {
		try {
			rmdirSync(join(ctx.repo, dir));
		} catch {
			return;
		}
	}
}

/** Replace one worktree path with a blob (or remove it) via a sibling temp file and rename. */
function place(ctx: Ctx, path: string, side: Side, blobs: Map<string, Buffer>): void {
	const full = join(ctx.repo, path);
	if (side.mode === ABSENT) {
		try {
			unlinkSync(full);
		} catch (error) {
			if (errno(error) !== "ENOENT") throw error;
		}
		pruneEmpty(ctx, dirname(path));
		return;
	}
	const bytes = blobs.get(side.sha);
	if (!bytes) throw new Error(`blob ${side.sha} was not loaded`);
	mkdirSync(dirname(full), { recursive: true });
	const temp = join(dirname(full), `.${basename(full)}.omp-kit-align.${process.pid}`);
	if (side.mode === SYMLINK) symlinkSync(bytes, temp);
	else writeFileSync(temp, bytes, { flag: "wx", mode: side.mode === "100755" ? 0o777 : 0o666 });
	try {
		renameSync(temp, full);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
}

/** Put HEAD content back on paths this run wrote, only where the worktree still holds what was written. */
function rollback(ctx: Ctx, applied: Change[], blobs: Map<string, Buffer>): string[] {
	const skipped: string[] = [];
	for (const change of [...applied].reverse()) {
		if (!sameAs(ctx, worktreeState(ctx, change.path), change.target)) {
			skipped.push(change.path);
			continue;
		}
		try {
			place(ctx, change.path, change.head, blobs);
		} catch {
			skipped.push(change.path);
		}
	}
	return sorted(skipped);
}

function preserveName(main: string): string {
	return `refs/preserve/${new Date().toISOString().slice(0, 10)}-${main.slice(0, 12)}`;
}

function preserve(ctx: Ctx, snap: Snapshot, commits: string[]): Preserved | { error: string } {
	const ref = preserveName(snap.main);
	const zero = "0".repeat(snap.main.length);
	const create = git(ctx, ["update-ref", "-m", "omp-kit align: preserve local-only main commits", ref, snap.main, zero]);
	if (create.code === 0) return { ref, sha: snap.main, commits, reused: false };
	if (readRef(ctx, ref) === snap.main) return { ref, sha: snap.main, commits, reused: true };
	return { error: create.err.trim() || `could not create ${ref}` };
}

function planData(plan: Plan | null): Record<string, unknown> {
	return {
		adopted: { count: plan?.adopt.length ?? 0, paths: sorted(plan?.adopt ?? []) },
		updated: { count: plan?.update.length ?? 0, paths: sorted((plan?.update ?? []).map((change) => change.path)) },
		stopped: {
			count: plan?.stop.length ?? 0, paths: sorted((plan?.stop ?? []).map((stop) => stop.path)),
			reasons: [...(plan?.stop ?? [])].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
		},
	};
}

function receipt(ctx: Ctx, snap: Snapshot, plan: Plan | null, preserved: Preserved[], afterRef: string, indexAfter: string, outcome: string): Record<string, unknown> {
	return {
		outcome, at: new Date().toISOString(), repo: ctx.repo, target_ref: TARGET_REF, target: snap.target,
		before_ref: snap.main, after_ref: afterRef, preserved, ...planData(plan),
		index_sha256_before: snap.indexSha, index_sha256_after: indexAfter,
	};
}

function logReceipt(ctx: Ctx, entry: Record<string, unknown>): string {
	const path = join(ctx.gitDir, RECEIPT_LOG);
	appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	return path;
}

function context(request: ParsedCommand, mode: Mode): Ctx | CliResult {
	const repo = request.flags.get("--repo");
	if (typeof repo !== "string" || !isAbsolute(repo) || resolve(repo) !== repo)
		return refusal({ mode }, "ALIGN_REPO_REQUIRED", "align needs --repo ABSOLUTE_DIR naming the checkout root", "Pass the canonical absolute checkout path; nothing was changed.");
	const gitDir = join(repo, ".git");
	let isDir = false;
	try {
		isDir = lstatSync(gitDir).isDirectory();
	} catch { /* reported below */ }
	if (!isDir) return refusal({ mode }, "ALIGN_REPO_UNSUPPORTED", "--repo must be a primary checkout root holding a .git directory", "Run align against the checkout's own root (not a linked worktree or bare repository); nothing was changed.");
	const probe = { repo, gitDir };
	const format = git(probe, ["rev-parse", "--show-object-format"]);
	const algo = text(format);
	if (format.code !== 0 || (algo !== "sha1" && algo !== "sha256"))
		return refusal({ mode }, "ALIGN_REPO_UNSUPPORTED", "The repository object format could not be read", "Repair the repository; nothing was changed.");
	const fileMode = text(git(probe, ["config", "--type=bool", "--get", "core.filemode"])) !== "false";
	return { repo, gitDir, indexPath: join(gitDir, "index"), lockPath: join(gitDir, "index.lock"), algo, fileMode, mode };
}

type Analysis = { local: string[]; staged: string[]; plan: Plan | null };

function analyze(ctx: Ctx, snap: Snapshot, scratch: string, withPlan: boolean): Analysis | CliResult {
	const snapshotIndex = join(scratch, "snapshot.index");
	writeFileSync(snapshotIndex, snap.indexBytes);
	const local = git(ctx, ["rev-list", `${snap.target}..${snap.main}`]);
	if (local.code !== 0) return refusal(ctx, "ALIGN_HISTORY_UNREADABLE", "Local-only commits could not be listed", "Repair object access; nothing was changed.");
	const staged = git(ctx, ["diff-index", "--cached", "--name-only", "-z", snap.main, "--"], snapshotIndex);
	if (staged.code !== 0) return refusal(ctx, "ALIGN_INDEX_UNREADABLE", "The snapshot index could not be compared with HEAD", "Repair the index; nothing was changed.");
	const commits = text(local).length ? text(local).split("\n") : [];
	if (!withPlan) return { local: commits, staged: sorted(zList(staged)), plan: null };
	const entries = indexEntries(ctx, snapshotIndex);
	const changes = changedPaths(ctx, snap);
	if (entries === null || changes === null) return refusal(ctx, "ALIGN_TREE_UNREADABLE", "HEAD, origin/main or the index could not be listed", "Repair object access; nothing was changed.");
	return { local: commits, staged: sorted(zList(staged)), plan: classify(ctx, changes, entries) };
}

function dryRun(ctx: Ctx): CliResult {
	const scratch = mkdtempSync(join(tmpdir(), "omp-kit-align."));
	try {
		const snap = takeSnapshot(ctx);
		if (!("main" in snap)) return snap;
		const analysis = analyze(ctx, snap, scratch, true);
		if (!("local" in analysis)) return analysis;
		const lockHeld = existsSync(ctx.lockPath);
		const blocked = analysis.staged.length > 0 || (analysis.plan?.stop.length ?? 0) > 0 || lockHeld;
		return { code: blocked ? 1 : 0, data: {
			overall: blocked ? "FINDINGS" : "OK", verdict: "PLAN", mode: ctx.mode, lock_held: lockHeld,
			staged: analysis.staged,
			receipt: receipt(ctx, snap, analysis.plan, analysis.local.length ? [{ ref: preserveName(snap.main), sha: snap.main, commits: analysis.local, reused: false }] : [], snap.target, "", "PLAN"),
		}, verification: "PERFORMED" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function locked(ctx: Ctx, lock: Lock, scratch: string): CliResult {
	const snap = takeSnapshot(ctx);
	if (!("main" in snap)) return snap;
	const analysis = analyze(ctx, snap, scratch, ctx.mode === "apply");
	if (!("local" in analysis)) return analysis;
	if (ctx.mode === "preserve-only") {
		if (analysis.local.length === 0)
			return refusal(ctx, "ALIGN_NOT_DIVERGED", "Local main is an ancestor of origin/main: there is nothing to preserve", "Run align --apply --yes to fast-forward; nothing was changed.");
		const moved = recheck(ctx, snap);
		if (moved) return refusal(ctx, moved.code, moved.message, "Re-run align after the concurrent writer finishes; nothing was changed.");
		const pinned = preserve(ctx, snap, analysis.local);
		if ("error" in pinned) return refusal(ctx, "ALIGN_PRESERVE_FAILED", `Local-only commits could not be pinned: ${pinned.error}`, "Inspect refs/preserve/; nothing else was changed.");
		const entry = receipt(ctx, snap, null, [pinned], snap.main, snap.indexSha, "PRESERVED");
		const log = logReceipt(ctx, entry);
		return { code: 0, data: { overall: "CHANGED", verdict: "PRESERVED", mode: ctx.mode, receipt: entry, receipt_log: log }, verification: "PERFORMED" };
	}
	if (analysis.staged.length)
		return refusal(ctx, "ALIGN_STAGED_CHANGES", `The shared index has staged changes against HEAD: ${analysis.staged.join(", ")}`,
			"Leave the staging owner to commit or unstage; align never discards staged work. Nothing was changed.", { staged: analysis.staged });
	const plan = analysis.plan ?? { adopt: [], update: [], stop: [] };
	if (snap.main === snap.target)
		return { code: 0, data: { overall: "OK", verdict: "NO_CHANGE", mode: ctx.mode, receipt: receipt(ctx, snap, plan, [], snap.main, snap.indexSha, "NO_CHANGE") }, verification: "PERFORMED" };
	if (plan.stop.length)
		return refusal(ctx, "ALIGN_STOP_PATHS", `Paths hold uncommitted work that matches neither HEAD nor origin/main: ${sorted(plan.stop.map((stop) => stop.path)).join(", ")}`,
			"Ask the owners to land or move that work, then re-run; nothing was changed.", { receipt: receipt(ctx, snap, plan, [], snap.main, snap.indexSha, "REFUSED") });

	const newIndexPath = join(scratch, "new.index");
	writeFileSync(newIndexPath, snap.indexBytes);
	const build = git(ctx, ["read-tree", "-m", "-i", snap.main, snap.target], newIndexPath);
	const tree = git(ctx, ["write-tree"], newIndexPath);
	const targetTree = git(ctx, ["rev-parse", "--verify", `${snap.target}^{tree}`]);
	if (build.code !== 0 || tree.code !== 0 || targetTree.code !== 0 || text(tree) !== text(targetTree))
		return refusal(ctx, "ALIGN_INDEX_BUILD_FAILED", "The private replacement index did not reproduce the origin/main tree", "Repair object access; nothing was changed.");
	const newIndex = readFileSync(newIndexPath);
	const blobs = new Map<string, Buffer>();
	for (const change of plan.update) for (const side of [change.head, change.target]) {
		if (side.mode === ABSENT || blobs.has(side.sha)) continue;
		const blob = git(ctx, ["cat-file", "blob", side.sha]);
		if (blob.code !== 0) return refusal(ctx, "ALIGN_TREE_UNREADABLE", `Blob ${side.sha} for ${change.path} could not be read`, "Repair object access; nothing was changed.");
		blobs.set(side.sha, blob.out);
	}

	pause("snapshot");
	const early = recheck(ctx, snap);
	if (early) return refusal(ctx, early.code, early.message, "Re-run align after the concurrent writer finishes; nothing was changed.");
	const preserved: Preserved[] = [];
	if (analysis.local.length) {
		const pinned = preserve(ctx, snap, analysis.local);
		if ("error" in pinned) return refusal(ctx, "ALIGN_PRESERVE_FAILED", `Local-only commits could not be pinned: ${pinned.error}`, "Main was not moved; inspect refs/preserve/ and retry.");
		preserved.push(pinned);
	}
	const applied: Change[] = [];
	for (const change of plan.update) {
		if (!sameAs(ctx, worktreeState(ctx, change.path), change.head)) {
			const skipped = rollback(ctx, applied, blobs);
			return refusal(ctx, "ALIGN_WORKTREE_CHANGED", `${change.path} changed in the worktree during alignment`, "Re-run align once the peer edit lands; main and the index were not changed.", { preserved, rollback_skipped: skipped });
		}
		try {
			place(ctx, change.path, change.target, blobs);
		} catch (error) {
			const skipped = rollback(ctx, applied, blobs);
			return refusal(ctx, "ALIGN_WORKTREE_WRITE_FAILED", `Could not write ${change.path}: ${String(error)}`, "Main and the index were not changed; repair the path and retry.", { preserved, rollback_skipped: skipped });
		}
		applied.push(change);
	}
	const final = recheck(ctx, snap);
	if (final) {
		const skipped = rollback(ctx, applied, blobs);
		return refusal(ctx, final.code, final.message, "Re-run align after the concurrent writer finishes; main and the index were not changed.", { preserved, rollback_skipped: skipped });
	}
	const progress: Progress = { plan, preserved, applied, blobs, swapped: false, casRan: false };
	pause("pre-swap");
	try {
		progress.swapped = replaceIndex(ctx, newIndex, lock);
	} catch (error) {
		const skipped = rollback(ctx, applied, blobs);
		return refusal(ctx, "ALIGN_INDEX_SWAP_FAILED", `The prepared index could not be written or renamed: ${String(error)}`, "Main and the index were not changed; check .git for space and permissions.", { preserved, rollback_skipped: skipped });
	}
	if (!progress.swapped) return abandon(ctx, snap, progress, "before the index swap");
	pause("swap");
	if (!ownsLock(lock)) return abandon(ctx, snap, progress, "before the ref CAS");
	const cas = git(ctx, ["update-ref", "-m", ALIGN_MESSAGE, MAIN_REF, snap.target, snap.main]);
	progress.casRan = true;
	pause("post-cas");
	if (cas.code !== 0) {
		let restored = false;
		try {
			restored = readIndex(ctx)?.equals(newIndex) === true && replaceIndex(ctx, snap.indexBytes, lock);
		} catch { /* reported as index_restored: false */ }
		if (restored) progress.swapped = false;
		if (!ownsLock(lock)) return abandon(ctx, snap, progress, "after the failed ref CAS");
		const skipped = restored ? rollback(ctx, applied, blobs) : [];
		const indexAfter = sha256(readIndex(ctx) ?? Buffer.alloc(0));
		const entry = receipt(ctx, snap, plan, preserved, readRef(ctx, MAIN_REF) ?? "", indexAfter, restored ? "CAS_FAILED_RESTORED" : "CAS_FAILED_UNRESTORED");
		logReceipt(ctx, entry);
		if (!restored)
			return { code: 1, data: { overall: "FINDINGS", verdict: "UNKNOWN", mode: ctx.mode, receipt: entry, index_restored: false, rollback_skipped: skipped },
				errors: [{ code: "ALIGN_REF_CAS_FAILED", message: "The main CAS failed and the index no longer held the swapped bytes, so neither the index nor the worktree was restored", remediation: `Inspect the index; the snapshot index sha256 is ${snap.indexSha} and main was ${snap.main}.` }], verification: "UNVERIFIED" };
		return refusal(ctx, "ALIGN_REF_CAS_FAILED", `refs/heads/main moved before the compare-and-swap: ${cas.err.trim()}`,
			"The snapshot index and UPDATE paths were restored; re-run align.", { receipt: entry, index_restored: indexAfter === snap.indexSha, rollback_skipped: skipped });
	}
	if (!ownsLock(lock)) return abandon(ctx, snap, progress, "before reporting");
	const entry = receipt(ctx, snap, plan, preserved, snap.target, sha256(newIndex), "ALIGNED");
	const log = logReceipt(ctx, entry);
	return { code: 0, data: { overall: "CHANGED", verdict: "ALIGNED", mode: ctx.mode, receipt: entry, receipt_log: log }, verification: "PERFORMED" };
}

type Progress = { plan: Plan; preserved: Preserved[]; applied: Change[]; blobs: Map<string, Buffer>; swapped: boolean; casRan: boolean };

/**
 * index.lock stopped naming this run's file, so `.git/index` and everything else the foreign holder guards stay untouched.
 * Before the swap: roll back UPDATE paths that still hold this run's bytes. After it: keep HEAD consistent with the
 * swapped index by running the main CAS if it has not run, and leave the worktree at the target. The snapshot index
 * bytes go to a recovery file. The verdict is UNKNOWN, never ALIGNED.
 */
function abandon(ctx: Ctx, snap: Snapshot, progress: Progress, stage: string): CliResult {
	const recoveryPath = join(ctx.gitDir, `omp-kit-align.recovery.${Date.now()}.${process.pid}.index`);
	let recovery: { path: string; sha256: string } | null = null;
	try {
		writeFileSync(recoveryPath, snap.indexBytes, { flag: "wx", mode: 0o600 });
		recovery = { path: recoveryPath, sha256: snap.indexSha };
	} catch { /* reported as recovery_index: null */ }
	let foreignLockInode: number | null = null;
	try {
		foreignLockInode = lstatSync(ctx.lockPath).ino;
	} catch { /* no lock file present */ }
	let consistency = progress.casRan ? "ALREADY_RAN" : "NOT_NEEDED";
	if (progress.swapped && !progress.casRan)
		consistency = git(ctx, ["update-ref", "-m", CONSISTENCY_MESSAGE, MAIN_REF, snap.target, snap.main]).code === 0 ? "MOVED" : "FAILED";
	const skipped = progress.swapped ? [] : rollback(ctx, progress.applied, progress.blobs);
	const entry = receipt(ctx, snap, progress.plan, progress.preserved, readRef(ctx, MAIN_REF) ?? "", sha256(readIndex(ctx) ?? Buffer.alloc(0)), "LOCK_LOST");
	logReceipt(ctx, entry);
	return { code: 1, data: { overall: "FINDINGS", verdict: "UNKNOWN", mode: ctx.mode, stage, receipt: entry,
		completed_under_lost_lock: progress.swapped, consistency_cas: consistency, foreign_lock_inode: foreignLockInode,
		recovery_index: recovery, worktree: progress.swapped ? "LEFT_AT_TARGET" : "ROLLED_BACK", rollback_skipped: skipped },
	errors: [{ code: "ALIGN_LOCK_LOST", message: `.git/index.lock stopped naming this run's lock ${stage}; inode ${foreignLockInode ?? "none"} now holds that path`,
		remediation: progress.swapped
			? "The index already holds the origin/main tree and was not written after the loss; main was moved to match it (see consistency_cas). Find the lock's holder before re-running."
			: "The index and main were not changed. Find the lock's holder, then re-run align --dry-run." }], verification: "UNVERIFIED" };
}

export function alignCommand(request: ParsedCommand): CliResult {
	const dry = request.flags.has("--dry-run");
	const apply = request.flags.has("--apply");
	const mode: Mode = dry ? "dry-run" : request.flags.has("--preserve-only") ? "preserve-only" : "apply";
	if (dry && apply) return refusal({ mode }, "CONFLICTING_FLAGS", "--dry-run and --apply cannot be combined", "Choose --dry-run to inspect or --apply --yes to align.");
	if (!dry && !apply) return refusal({ mode }, "ALIGN_APPLY_REQUIRED", "align is a mutation and requires --apply (or --dry-run to inspect)", "Review align --dry-run, then pass --apply --yes; nothing was changed.");
	const ctx = context(request, mode);
	if (!("gitDir" in ctx)) return ctx;
	const busy = IN_PROGRESS.filter((name) => existsSync(join(ctx.gitDir, name)));
	if (busy.length) return refusal(ctx, "ALIGN_OPERATION_IN_PROGRESS", `An in-progress git operation was found: ${busy.join(", ")}`, "Let its owner finish or abort it; nothing was changed.");
	if (dry) return dryRun(ctx);
	const fd = acquire(ctx.lockPath);
	if (fd === "HELD")
		return refusal(ctx, "INDEX_LOCK_HELD", ".git/index.lock already exists; its holder and intent are unknown",
			"Wait for the holder and retry; diagnose with omp-kit scratch index-lock --repo DIR. Never delete the lock by hand. Nothing was changed.", {}, "UNKNOWN");
	if (fd === "ERROR") return refusal(ctx, "INDEX_LOCK_UNAVAILABLE", ".git/index.lock could not be created", "Check .git permissions; nothing was changed.");
	const lock: Lock = { fd, path: ctx.lockPath };
	const scratch = mkdtempSync(join(tmpdir(), "omp-kit-align."));
	try {
		return locked(ctx, lock, scratch);
	} finally {
		release(lock);
		rmSync(scratch, { recursive: true, force: true });
	}
}
