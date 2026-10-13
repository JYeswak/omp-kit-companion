// ALIGN1 (ompkit-fp72.66): omp-kit align moves a shared checkout's main and index to origin/main
// without losing work. Every test builds a real bare origin plus clone under TMPDIR and drives the
// real CLI. Concurrency negatives pause the child at a named phase (OMP_KIT_ALIGN_PAUSE_AT) and act
// as a peer while the child holds .git/index.lock.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const cliPath = join(repoRoot, "src", "cli.ts");
const scratch = mkdtempSync(join(tmpdir(), `align.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=align-test\nrepo=${repoRoot}\ncreated=${new Date().toISOString()}\n`);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PATHS = ["update.txt", "adopt.txt", "gone.txt", "peer.txt", "stable.txt", "script.sh", "nested/added.txt", "local.txt"];
type Fixture = { work: string; base: string; target: string };
type Run = { status: number; body: Record<string, unknown> };
let fixtureNumber = 0;

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

function tryGit(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
	const run = spawnSync("git", ["-c", "user.name=ALIGN1 test", "-c", "user.email=align1@example.invalid", ...args], { cwd, encoding: "utf8", env: cleanEnv(extra), timeout: 20_000 });
	return { status: run.status ?? 1, stdout: String(run.stdout), stderr: String(run.stderr) };
}

function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): string {
	const run = tryGit(cwd, args, extra);
	if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed (${run.status}): ${run.stderr}`);
	return run.stdout.trim();
}

function write(root: string, path: string, content: string, mode = 0o644): void {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
	chmodSync(join(root, path), mode);
}

/** origin/main (target) differs from local main (base) by: update.txt and script.sh changed, adopt.txt changed, gone.txt deleted, nested/added.txt added. */
function fixture(): Fixture {
	const root = join(scratch, `fixture-${fixtureNumber++}`);
	const bare = join(root, "origin.git");
	const work = join(root, "work");
	const upstream = join(root, "upstream");
	mkdirSync(work, { recursive: true });
	git(root, ["init", "-q", "--bare", "--initial-branch=main", bare]);
	git(work, ["init", "-q", "--initial-branch=main"]);
	git(work, ["remote", "add", "origin", bare]);
	write(work, "update.txt", "update base\n");
	write(work, "adopt.txt", "adopt base\n");
	write(work, "gone.txt", "gone base\n");
	write(work, "peer.txt", "peer base\n");
	write(work, "stable.txt", "stable base\n");
	write(work, "script.sh", "#!/bin/sh\necho base\n", 0o755);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-q", "-m", "base [test]"]);
	git(work, ["push", "-q", "origin", "main"]);
	git(root, ["clone", "-q", bare, upstream]);
	write(upstream, "update.txt", "update target\n");
	write(upstream, "adopt.txt", "adopt target\n");
	write(upstream, "script.sh", "#!/bin/sh\necho target\n", 0o755);
	write(upstream, "nested/added.txt", "added target\n");
	unlinkSync(join(upstream, "gone.txt"));
	git(upstream, ["add", "-A"]);
	git(upstream, ["commit", "-q", "-m", "advance origin [test]"]);
	git(upstream, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
	git(work, ["fetch", "-q", "origin"]);
	return { work, base: git(work, ["rev-parse", "HEAD"]), target: git(work, ["rev-parse", "refs/remotes/origin/main"]) };
}

function localCommit(work: string): string {
	write(work, "local.txt", "local only\n");
	git(work, ["add", "local.txt"]);
	git(work, ["commit", "-q", "-m", "local-only commit [test]"]);
	return git(work, ["rev-parse", "HEAD"]);
}

function files(work: string): Record<string, string | null> {
	return Object.fromEntries(PATHS.map((path) => [path, existsSync(join(work, path)) ? readFileSync(join(work, path), "utf8") : null]));
}

function index(work: string): Buffer {
	return readFileSync(join(work, ".git", "index"));
}

function main(work: string): string {
	return git(work, ["rev-parse", "refs/heads/main"]);
}

function preserveRefs(work: string): string {
	return git(work, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/preserve/"]);
}

function parse(stdout: string, stderr: string, status: number): Run {
	try {
		return { status, body: JSON.parse(stdout) };
	} catch {
		throw new Error(`align emitted invalid JSON (status ${status}): ${stdout}\n${stderr}`);
	}
}

function align(work: string, args: string[], extra: NodeJS.ProcessEnv = {}): Run {
	const run = spawnSync(process.execPath, [cliPath, "align", "--repo", work, ...args, "--json"], { cwd: scratch, env: cleanEnv(extra), encoding: "utf8", timeout: 60_000 });
	return parse(String(run.stdout), String(run.stderr), run.status ?? 1);
}

type Phase = "snapshot" | "pre-swap" | "swap" | "post-cas";
const ALIGN_MESSAGE = "omp-kit align: main -> origin/main";
const CONSISTENCY_MESSAGE = "omp-kit align: consistency CAS after index.lock loss";

function reflog(work: string): string[] {
	return git(work, ["reflog", "show", "--format=%gs", "refs/heads/main"]).split("\n");
}

/** A peer takes the lock path: `bytes` land in a new file renamed over index.lock (another inode). */
function stealLock(work: string, bytes: Buffer): { ino: number; bytes: Buffer } {
	const lock = join(work, ".git", "index.lock");
	writeFileSync(`${lock}.peer`, bytes);
	renameSync(`${lock}.peer`, lock);
	return { ino: lstatSync(lock).ino, bytes: readFileSync(lock) };
}

/** The run's recovery file must hold exactly the snapshot index bytes. */
function expectRecovery(run: Run, snapshot: Buffer): void {
	const recovery = data(run).recovery_index;
	if (recovery === null || typeof recovery !== "object" || !("path" in recovery) || typeof recovery.path !== "string" || !("sha256" in recovery))
		throw new Error(`no recovery_index: ${JSON.stringify(run.body)}`);
	expect(readFileSync(recovery.path).equals(snapshot)).toBe(true);
	expect(recovery.sha256).toBe(sha256(snapshot));
}

/** Runs align --apply --yes and, at each phase in order, pauses it while it holds index.lock, runs that peer action, then lets it continue. */
async function alignPaused(work: string, steps: readonly (readonly [Phase, () => void])[]): Promise<Run> {
	const gate = mkdtempSync(join(scratch, "gate."));
	const child = Bun.spawn([process.execPath, cliPath, "align", "--repo", work, "--apply", "--yes", "--json"], {
		cwd: scratch, env: cleanEnv({ OMP_KIT_ALIGN_PAUSE_AT: steps.map(([phase]) => phase).join(","), OMP_KIT_ALIGN_PAUSE_DIR: gate }), stdout: "pipe", stderr: "pipe",
	});
	// The child announces each pause on stderr; await that stream event, never a guessed delay.
	const reader = child.stderr.getReader();
	const decoder = new TextDecoder();
	let stderr = "";
	for (const [phase, peer] of steps) {
		const marker = `omp-kit align: paused at ${phase}\n`;
		while (!stderr.includes(marker)) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`align never reached the ${phase} pause: ${await new Response(child.stdout).text()}\n${stderr}`);
			stderr += decoder.decode(chunk.value, { stream: true });
		}
		try {
			peer();
		} finally {
			writeFileSync(join(gate, `${phase}.go`), "");
		}
	}
	const drain = (async () => {
		for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) stderr += decoder.decode(chunk.value, { stream: true });
	})();
	const [stdout, status] = await Promise.all([new Response(child.stdout).text(), child.exited, drain]);
	return parse(stdout, stderr, status);
}

function code(run: Run): string | undefined {
	const errors = run.body.errors;
	if (!Array.isArray(errors) || errors.length === 0) return undefined;
	const first: unknown = errors[0];
	return first !== null && typeof first === "object" && "code" in first && typeof first.code === "string" ? first.code : undefined;
}

function data(run: Run): Record<string, unknown> {
	const value = run.body.data;
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`no data object: ${JSON.stringify(run.body)}`);
	return Object.fromEntries(Object.entries(value));
}

function receipt(run: Run): Record<string, unknown> {
	const value = data(run).receipt;
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`no receipt: ${JSON.stringify(run.body)}`);
	return Object.fromEntries(Object.entries(value));
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function expectUnchanged(work: string, before: { main: string; index: Buffer; files: Record<string, string | null> }): void {
	expect(main(work)).toBe(before.main);
	expect(index(work).equals(before.index)).toBe(true);
	expect(files(work)).toEqual(before.files);
	expect(preserveRefs(work)).toBe("");
	expect(existsSync(join(work, ".git", "index.lock"))).toBe(false);
}

function capture(work: string) {
	return { main: main(work), index: index(work), files: files(work) };
}

test("planted positive: preserves a local-only commit, aligns main and index, leaves peer bytes alone, logs a receipt", () => {
	const f = fixture();
	const local = localCommit(f.work);
	write(f.work, "adopt.txt", "adopt target\n");
	write(f.work, "peer.txt", "peer uncommitted edit\n");
	const adoptBefore = lstatSync(join(f.work, "adopt.txt"));
	const peerBefore = lstatSync(join(f.work, "peer.txt"));
	const indexBefore = index(f.work);

	const run = align(f.work, ["--apply", "--yes"]);
	expect(run.status).toBe(0);
	expect(data(run).verdict).toBe("ALIGNED");
	const indexAfter = index(f.work);

	const preserved = `refs/preserve/${new Date().toISOString().slice(0, 10)}-${local.slice(0, 12)}`;
	expect(preserveRefs(f.work)).toBe(`${preserved} ${local}`);
	expect(tryGit(f.work, ["merge-base", "--is-ancestor", local, preserved]).status).toBe(0);
	expect(main(f.work)).toBe(f.target);
	expect(tryGit(f.work, ["diff-index", "--cached", "--quiet", "HEAD", "--"]).status).toBe(0);
	expect(files(f.work)).toEqual({
		"update.txt": "update target\n", "adopt.txt": "adopt target\n", "gone.txt": null, "peer.txt": "peer uncommitted edit\n",
		"stable.txt": "stable base\n", "script.sh": "#!/bin/sh\necho target\n", "nested/added.txt": "added target\n", "local.txt": null,
	});
	expect(statSync(join(f.work, "script.sh")).mode & 0o100).toBe(0o100);
	for (const [path, before] of [["adopt.txt", adoptBefore], ["peer.txt", peerBefore]] as const) {
		const after = lstatSync(join(f.work, path));
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
	}
	expect(git(f.work, ["status", "--porcelain"])).toBe("M peer.txt");
	expect(existsSync(join(f.work, ".git", "index.lock"))).toBe(false);

	const entry = receipt(run);
	expect(entry.before_ref).toBe(local);
	expect(entry.after_ref).toBe(f.target);
	expect(entry.preserved).toEqual([{ ref: preserved, sha: local, commits: [local], reused: false }]);
	expect(entry.adopted).toEqual({ count: 1, paths: ["adopt.txt"] });
	expect(entry.updated).toEqual({ count: 5, paths: ["gone.txt", "local.txt", "nested/added.txt", "script.sh", "update.txt"] });
	expect(entry.stopped).toEqual({ count: 0, paths: [], reasons: [] });
	expect(entry.index_sha256_before).toBe(sha256(indexBefore));
	expect(entry.index_sha256_after).toBe(sha256(indexAfter));
	const log = readFileSync(join(f.work, ".git", "omp-kit-align.jsonl"), "utf8").trim().split("\n");
	expect(log.length).toBe(1);
	expect(JSON.parse(log[0] ?? "")).toEqual(entry);
}, 30_000);

test("--dry-run prints the full plan and touches nothing", () => {
	const f = fixture();
	const local = localCommit(f.work);
	write(f.work, "adopt.txt", "adopt target\n");
	const before = capture(f.work);
	const run = align(f.work, ["--dry-run"]);
	expect(run.status).toBe(0);
	expect(data(run).verdict).toBe("PLAN");
	const plan = receipt(run);
	expect(plan.preserved).toEqual([{ ref: `refs/preserve/${new Date().toISOString().slice(0, 10)}-${local.slice(0, 12)}`, sha: local, commits: [local], reused: false }]);
	expect(plan.adopted).toEqual({ count: 1, paths: ["adopt.txt"] });
	expect(plan.updated).toEqual({ count: 5, paths: ["gone.txt", "local.txt", "nested/added.txt", "script.sh", "update.txt"] });
	expect(plan.stopped).toEqual({ count: 0, paths: [], reasons: [] });
	expectUnchanged(f.work, before);
	expect(existsSync(join(f.work, ".git", "omp-kit-align.jsonl"))).toBe(false);
}, 30_000);

test("preserve-only pins a diverged local main and moves nothing else", () => {
	const f = fixture();
	const local = localCommit(f.work);
	const before = capture(f.work);
	const run = align(f.work, ["--preserve-only", "--apply", "--yes"]);
	expect(run.status).toBe(0);
	expect(data(run).verdict).toBe("PRESERVED");
	expect(preserveRefs(f.work)).toBe(`refs/preserve/${new Date().toISOString().slice(0, 10)}-${local.slice(0, 12)} ${local}`);
	expect(main(f.work)).toBe(before.main);
	expect(index(f.work).equals(before.index)).toBe(true);
	expect(files(f.work)).toEqual(before.files);

	const ancestor = fixture();
	const refused = align(ancestor.work, ["--preserve-only", "--apply", "--yes"]);
	expect(refused.status).toBe(2);
	expect(code(refused)).toBe("ALIGN_NOT_DIVERGED");
	expect(preserveRefs(ancestor.work)).toBe("");
}, 30_000);

test("STOP: a peer-modified or peer-created path that matches neither side refuses and changes nothing", () => {
	const f = fixture();
	write(f.work, "update.txt", "peer edit in progress\n");
	write(f.work, "nested/added.txt", "peer's own untracked file\n");
	const before = capture(f.work);
	const run = align(f.work, ["--apply", "--yes"]);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("ALIGN_STOP_PATHS");
	expect(receipt(run).stopped).toMatchObject({ count: 2, paths: ["nested/added.txt", "update.txt"] });
	expectUnchanged(f.work, before);
}, 30_000);

test("staged changes against HEAD refuse with a typed code", () => {
	const f = fixture();
	write(f.work, "stable.txt", "staged by a peer\n");
	git(f.work, ["add", "stable.txt"]);
	const before = capture(f.work);
	const run = align(f.work, ["--apply", "--yes"]);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("ALIGN_STAGED_CHANGES");
	expect(data(run).staged).toEqual(["stable.txt"]);
	expectUnchanged(f.work, before);
}, 30_000);

test("planted negative: an index.lock already held refuses with UNKNOWN and is left in place", () => {
	const f = fixture();
	writeFileSync(join(f.work, ".git", "index.lock"), "");
	const before = { main: main(f.work), index: index(f.work), files: files(f.work) };
	const run = align(f.work, ["--apply", "--yes"]);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("INDEX_LOCK_HELD");
	expect(data(run).verdict).toBe("UNKNOWN");
	expect(existsSync(join(f.work, ".git", "index.lock"))).toBe(true);
	expect(main(f.work)).toBe(before.main);
	expect(index(f.work).equals(before.index)).toBe(true);
	expect(files(f.work)).toEqual(before.files);
}, 30_000);

test("planted negative: a peer staging between snapshot and swap is refused and nothing changes", async () => {
	const f = fixture();
	const before = capture(f.work);
	let peerIndex = Buffer.alloc(0);
	const run = await alignPaused(f.work, [["snapshot", () => {
		const blocked = tryGit(f.work, ["add", "peer.txt"]);
		expect(blocked.status).not.toBe(0);
		expect(blocked.stderr).toContain("index.lock");
		write(f.work, "stable.txt", "peer staged through a private index\n");
		const privateIndex = join(scratch, `peer-${fixtureNumber}.index`);
		copyFileSync(join(f.work, ".git", "index"), privateIndex);
		git(f.work, ["add", "stable.txt"], { GIT_INDEX_FILE: privateIndex });
		renameSync(privateIndex, join(f.work, ".git", "index"));
		peerIndex = index(f.work);
	}]]);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("ALIGN_INDEX_CHANGED");
	expect(main(f.work)).toBe(before.main);
	expect(index(f.work).equals(peerIndex)).toBe(true);
	expect(files(f.work)).toEqual({ ...before.files, "stable.txt": "peer staged through a private index\n" });
	expect(preserveRefs(f.work)).toBe("");
	expect(existsSync(join(f.work, ".git", "index.lock"))).toBe(false);
}, 30_000);

test("planted negative: main advanced by a peer after the snapshot is refused", async () => {
	const f = fixture();
	const before = capture(f.work);
	const advanced = git(f.work, ["commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "peer advanced main [test]"]);
	const run = await alignPaused(f.work, [["snapshot", () => git(f.work, ["update-ref", "refs/heads/main", advanced, f.base])]]);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("ALIGN_REF_CHANGED");
	expect(main(f.work)).toBe(advanced);
	expect(index(f.work).equals(before.index)).toBe(true);
	expect(files(f.work)).toEqual(before.files);
	expect(existsSync(join(f.work, ".git", "index.lock"))).toBe(false);
}, 30_000);

test("ref CAS failure after the index swap restores the snapshot index and the updated paths", async () => {
	const f = fixture();
	const before = capture(f.work);
	const advanced = git(f.work, ["commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "peer advanced main [test]"]);
	let lockHeldAtSwap = false;
	const run = await alignPaused(f.work, [["swap", () => {
		lockHeldAtSwap = existsSync(join(f.work, ".git", "index.lock"));
		git(f.work, ["update-ref", "refs/heads/main", advanced, f.base]);
	}]]);
	expect(lockHeldAtSwap).toBe(true);
	expect(run.status).toBe(2);
	expect(code(run)).toBe("ALIGN_REF_CAS_FAILED");
	expect(data(run).index_restored).toBe(true);
	expect(index(f.work).equals(before.index)).toBe(true);
	expect(files(f.work)).toEqual(before.files);
	expect(existsSync(join(f.work, "nested"))).toBe(false);
	expect(main(f.work)).toBe(advanced);
	expect(existsSync(join(f.work, ".git", "index.lock"))).toBe(false);
	expect(receipt(run).index_sha256_after).toBe(sha256(before.index));
}, 30_000);

test("planted: after the index swap and before the CAS, the original index.lock still refuses a peer's plain git add", async () => {
	const f = fixture();
	const lock = join(f.work, ".git", "index.lock");
	const inodes: number[] = [];
	let peerAdd = { status: 0, stdout: "", stderr: "" };
	const run = await alignPaused(f.work, [
		["snapshot", () => { inodes.push(lstatSync(lock).ino); }],
		["swap", () => {
			inodes.push(lstatSync(lock).ino);
			write(f.work, "peer-new.txt", "peer's new file\n");
			peerAdd = tryGit(f.work, ["add", "peer-new.txt"]);
		}],
	]);
	expect(inodes.length).toBe(2);
	expect(inodes[1]).toBe(inodes[0]);
	expect(peerAdd.status).not.toBe(0);
	expect(peerAdd.stderr).toContain("index.lock");
	expect(run.status).toBe(0);
	expect(data(run).verdict).toBe("ALIGNED");
	expect(main(f.work)).toBe(f.target);
	expect(git(f.work, ["ls-files", "--", "peer-new.txt"])).toBe("");
	expect(readFileSync(join(f.work, "peer-new.txt"), "utf8")).toBe("peer's new file\n");
	expect(tryGit(f.work, ["diff-index", "--cached", "--quiet", "HEAD", "--"]).status).toBe(0);
	expect(files(f.work)["update.txt"]).toBe("update target\n");
	expect(existsSync(lock)).toBe(false);
}, 30_000);

test("planted (c): lock lost after the swap: index not written after the loss, main moved by the consistency CAS, peer's lock intact", async () => {
	const f = fixture();
	const before = capture(f.work);
	let swapped = Buffer.alloc(0);
	let peer = { ino: 0, bytes: Buffer.alloc(0) };
	const run = await alignPaused(f.work, [["swap", () => {
		swapped = index(f.work);
		write(f.work, "peer-new.txt", "peer's staged file\n");
		const prepared = join(scratch, `peer-lock-${fixtureNumber}.index`);
		copyFileSync(join(f.work, ".git", "index"), prepared);
		git(f.work, ["add", "peer-new.txt"], { GIT_INDEX_FILE: prepared });
		peer = stealLock(f.work, readFileSync(prepared));
		unlinkSync(prepared);
	}]]);
	expect(run.status).toBe(1);
	expect(code(run)).toBe("ALIGN_LOCK_LOST");
	expect(data(run)).toMatchObject({ verdict: "UNKNOWN", stage: "before the ref CAS", completed_under_lost_lock: true, consistency_cas: "MOVED", foreign_lock_inode: peer.ino, worktree: "LEFT_AT_TARGET" });
	const lock = join(f.work, ".git", "index.lock");
	expect(lstatSync(lock).ino).toBe(peer.ino);
	expect(readFileSync(lock).equals(peer.bytes)).toBe(true);
	expect(swapped.equals(before.index)).toBe(false);
	expect(index(f.work).equals(swapped)).toBe(true);
	expect(main(f.work)).toBe(f.target);
	expect(reflog(f.work)[0]).toBe(CONSISTENCY_MESSAGE);
	expect(reflog(f.work)).not.toContain(ALIGN_MESSAGE);
	expect(files(f.work)["update.txt"]).toBe("update target\n");
	expect(files(f.work)["gone.txt"]).toBeNull();
	expectRecovery(run, before.index);
}, 30_000);

test("planted (d): lock lost before the swap: main and index unchanged, UPDATE paths rolled back", async () => {
	const f = fixture();
	const before = capture(f.work);
	let peer = { ino: 0, bytes: Buffer.alloc(0) };
	const run = await alignPaused(f.work, [["pre-swap", () => {
		expect(files(f.work)["update.txt"]).toBe("update target\n");
		peer = stealLock(f.work, Buffer.from("peer lock\n"));
	}]]);
	expect(run.status).toBe(1);
	expect(code(run)).toBe("ALIGN_LOCK_LOST");
	expect(data(run)).toMatchObject({ verdict: "UNKNOWN", stage: "before the index swap", completed_under_lost_lock: false, consistency_cas: "NOT_NEEDED", foreign_lock_inode: peer.ino, worktree: "ROLLED_BACK", rollback_skipped: [] });
	expect(main(f.work)).toBe(before.main);
	expect(index(f.work).equals(before.index)).toBe(true);
	expect(files(f.work)).toEqual(before.files);
	expect(existsSync(join(f.work, "nested"))).toBe(false);
	expect(reflog(f.work).some((entry) => entry.startsWith("omp-kit align"))).toBe(false);
	expect(readFileSync(join(f.work, ".git", "index.lock"), "utf8")).toBe("peer lock\n");
	expectRecovery(run, before.index);
}, 30_000);

test("planted (f): lock lost after a failed CAS: no restore under the lost lock, worktree left at the target", async () => {
	const f = fixture();
	const before = capture(f.work);
	const advanced = git(f.work, ["commit-tree", `${f.base}^{tree}`, "-p", f.base, "-m", "peer advanced main [test]"]);
	let swapped = Buffer.alloc(0);
	let peer = { ino: 0, bytes: Buffer.alloc(0) };
	const run = await alignPaused(f.work, [
		["swap", () => {
			swapped = index(f.work);
			git(f.work, ["update-ref", "refs/heads/main", advanced, f.base]);
		}],
		["post-cas", () => { peer = stealLock(f.work, Buffer.from("peer lock\n")); }],
	]);
	expect(run.status).toBe(1);
	expect(code(run)).toBe("ALIGN_LOCK_LOST");
	expect(data(run)).toMatchObject({ verdict: "UNKNOWN", stage: "after the failed ref CAS", completed_under_lost_lock: true, consistency_cas: "ALREADY_RAN", foreign_lock_inode: peer.ino, worktree: "LEFT_AT_TARGET" });
	expect(main(f.work)).toBe(advanced);
	expect(index(f.work).equals(swapped)).toBe(true);
	expect(files(f.work)["update.txt"]).toBe("update target\n");
	expect(reflog(f.work).some((entry) => entry.startsWith("omp-kit align"))).toBe(false);
	expect(readFileSync(join(f.work, ".git", "index.lock"), "utf8")).toBe("peer lock\n");
	expectRecovery(run, before.index);
}, 30_000);

test("planted (g): lock lost after a successful CAS is UNKNOWN, never ALIGNED", async () => {
	const f = fixture();
	const before = capture(f.work);
	let swapped = Buffer.alloc(0);
	const run = await alignPaused(f.work, [["post-cas", () => {
		swapped = index(f.work);
		stealLock(f.work, Buffer.from("peer lock\n"));
	}]]);
	expect(run.status).toBe(1);
	expect(code(run)).toBe("ALIGN_LOCK_LOST");
	expect(data(run)).toMatchObject({ verdict: "UNKNOWN", stage: "before reporting", completed_under_lost_lock: true, consistency_cas: "ALREADY_RAN" });
	expect(main(f.work)).toBe(f.target);
	expect(reflog(f.work)[0]).toBe(ALIGN_MESSAGE);
	expect(reflog(f.work)).not.toContain(CONSISTENCY_MESSAGE);
	expect(index(f.work).equals(swapped)).toBe(true);
	expect(readFileSync(join(f.work, ".git", "index.lock"), "utf8")).toBe("peer lock\n");
	expectRecovery(run, before.index);
}, 30_000);

test("inherited GIT_* selectors are scrubbed: a leaked GIT_INDEX_FILE/GIT_DIR/GIT_COMMON_DIR leaves the decoy checkout untouched", () => {
	const decoy = fixture();
	write(decoy.work, "peer.txt", "decoy peer edit\n");
	const decoyBefore = capture(decoy.work);
	const f = fixture();
	// A commit only f has: a leaked object or ref selector cannot resolve it through the decoy.
	localCommit(f.work);
	const decoyGit = join(decoy.work, ".git");
	const run = align(f.work, ["--apply", "--yes"], {
		GIT_INDEX_FILE: join(decoyGit, "index"), GIT_DIR: decoyGit, GIT_WORK_TREE: decoy.work,
		GIT_COMMON_DIR: decoyGit, GIT_OBJECT_DIRECTORY: join(decoyGit, "objects"),
	});
	expect(run.status).toBe(0);
	expect(data(run).verdict).toBe("ALIGNED");
	expectUnchanged(decoy.work, decoyBefore);
	expect(main(f.work)).toBe(f.target);
	expect(tryGit(f.work, ["diff-index", "--cached", "--quiet", "HEAD", "--"]).status).toBe(0);
	expect(files(f.work)["update.txt"]).toBe("update target\n");
}, 30_000);
