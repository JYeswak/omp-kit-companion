import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	applyQuarantineExpiry,
	applyScratch,
	applyUnowned,
	inspectOne,
	moveToQuarantine,
	planScratch,
	quarantineDir,
	QUARANTINE_LOCAL_DIR,
	releaseScratch,
	sameReleasedFile,
	summarizeScratch,
	type ApplyDeps,
	type InspectDeps,
} from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	applyCheckoutReap,
	archiveCheckout,
	judgeCheckoutRow,
	type CheckoutDiffInput,
	type CheckoutListRow,
} from "../../src/checkout-reap.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

afterEach(cleanupAllOwnedTmp);

const owned: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
for (const key of ["OMP_KIT_SCRATCH_ROOTS", "OMP_KIT_SCRATCH_FREE_PCT", "XDG_STATE_HOME"]) savedEnv[key] = process.env[key];
afterEach(() => {
	for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const key of Object.keys(savedEnv)) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

const GIT_ENV: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined) GIT_ENV[key] = value;
GIT_ENV.GIT_CONFIG_GLOBAL = "/dev/null";
GIT_ENV.GIT_CONFIG_NOSYSTEM = "1";
function git(repo: string, ...args: string[]): { code: number; out: string; err: string } {
	const run = runSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
		"-c", "user.name=lifecycle-test", "-c", "user.email=lifecycle-test@example.com", ...args],
	{ cwd: repo, deadline_s: fixtureDeadlineS(), max_output_bytes: 1 << 20, env: GIT_ENV });
	return { code: run.rc, out: new TextDecoder().decode(run.stdout), err: new TextDecoder().decode(run.stderr) };
}

function deadDeps(): InspectDeps {
	return {
		liveness: { signalAlive: () => false, psVisible: () => false, processStart: () => null,
			probe: (owner) => ({ state: "dead", evidence: { pid: owner.pid, recorded_start: owner.start, observed_start: null, stat: null, signal0: "esrch", reason: "planted: no such pid" } }) },
		run: () => ({ code: 1, stdout: "", stderr: "" }),
	};
}

function scratchFixture() {
	const base = ownedTmp("lifecycle", { root: join(import.meta.dir, "..", "..", "var", "agent-tmp") }).path;
	owned.push(base);
	process.env.XDG_STATE_HOME = join(base, "state");
	const repo = join(base, "project");
	const root = join(repo, "var", "agent-tmp");
	const dir = join(root, "work.999999");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const owner = { pid: 999999, process_start: "Thu Jan  1 00:00:00 1970", label: "work",
		repo, created_at: "2026-10-01T00:00:00Z", argv0: "owned-fixture" };
	writeFileSync(join(dir, ".owner"), JSON.stringify(owner), { mode: 0o600 });
	return { base, repo, root, dir, owner };
}

function fixtureBase(): string {
	const base = ownedTmp("lifecycle-misc", { root: join(import.meta.dir, "..", "..", "var", "agent-tmp") }).path;
	owned.push(base);
	return base;
}

function exdevRename(home: string) {
	return (src: string, dst: string): void => {
		if (dst === quarantineDir(home) || dst.startsWith(`${quarantineDir(home)}/`)) {
			const error = new Error(`EXDEV: cross-device link not permitted, rename '${src}' -> '${dst}'`) as NodeJS.ErrnoException;
			error.code = "EXDEV";
			throw error;
		}
		renameSync(src, dst);
	};
}

test("quarantine falls back beside the root when the global quarantine is cross-device", () => {
	const f = scratchFixture();
	const home = join(f.base, "home");
	const entry = "work.999999.q-2026-11-20T00-00-00-000Z";
	const deps = { ...deadDeps(), home, renameDir: exdevRename(home) };
	const moved = moveToQuarantine(f.dir, entry, home, f.root, deps as ApplyDeps);
	if (!("moved" in moved)) throw new Error(`expected a move, got ${JSON.stringify(moved)}`);
	expect(moved.moved).toBe(join(f.root, QUARANTINE_LOCAL_DIR, entry));
	expect(moved.fallback).toBe(true);
	expect(existsSync(f.dir)).toBe(false);
	expect(existsSync(moved.moved)).toBe(true);
});

test("applyUnowned crosses no device boundary on EXDEV", () => {
	const f = scratchFixture();
	rmSync(join(f.dir, ".owner"));
	const old = new Date("2020-01-01T00:00:00Z");
	writeFileSync(join(f.dir, "payload"), "unowned\n");
	for (const path of [join(f.dir, "payload"), f.dir]) utimesSync(path, old, old);
	const home = join(f.base, "home");
	const deps = { ...deadDeps(), home, renameDir: exdevRename(home) };
	const planned = inspectOne(f.dir, f.root, deps as ApplyDeps);
	expect(planned?.action).toBe("QUARANTINE");
	const result = applyUnowned(f.dir, f.root, deps as ApplyDeps, planned ?? undefined);
	expect(result.action).toBe("QUARANTINE");
	expect(dirname(result.dir)).toBe(join(f.root, QUARANTINE_LOCAL_DIR));
	expect(existsSync(f.dir)).toBe(false);
});

test("scratch under an ovnfs checkout is checkout-owned, not foreign", () => {
	const f = scratchFixture();
	const coRoot = join(f.base, "checkouts", "co1", "var", "agent-tmp");
	const dir = join(coRoot, "work.999999");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, ".owner"), JSON.stringify(f.owner), { mode: 0o600 });
	const deps = { ...deadDeps(), checkoutProbe: () => "co1", checkoutNameCache: new Map<string, string | null>() };
	const verdict = inspectOne(dir, coRoot, deps as InspectDeps);
	expect(verdict?.action).toBe("SKIP");
	expect(verdict?.reason).toBe("checkout-owned-scratch");
	expect(existsSync(join(dir, ".owner"))).toBe(true);
});

// REAPTIMEOUT1: walking checkout-owned scratch (11,458 dirs, 351 GB of logical bytes over NFS in the 2026-11-21 census) cost a
// 690 s plan and held the scheduled reaper past its 30 min cap before it reaped anything. The SKIP verdict needs no size.
test("REAPTIMEOUT1: a checkout-owned verdict does not walk the dir: its bytes stay unmeasured", () => {
	const f = scratchFixture();
	const coRoot = join(f.base, "checkouts", "co1", "var", "agent-tmp");
	const dir = join(coRoot, "work.999998");
	mkdirSync(join(dir, "deep", "er"), { recursive: true, mode: 0o700 });
	writeFileSync(join(dir, ".owner"), JSON.stringify(f.owner), { mode: 0o600 });
	writeFileSync(join(dir, "deep", "er", "payload.bin"), Buffer.alloc(1 << 20, 1));
	const deps = { ...deadDeps(), checkoutProbe: () => "co1", checkoutNameCache: new Map<string, string | null>() };
	const verdict = inspectOne(dir, coRoot, deps as InspectDeps);
	expect(verdict?.reason).toBe("checkout-owned-scratch");
	expect(verdict?.sizeBytes).toBe(0);
	expect(verdict?.detail).toContain("bytes not measured");
	// Control: the same bytes under a root that is not a checkout are measured.
	const plainRoot = join(f.base, "plainproj", "var", "agent-tmp");
	const plain = join(plainRoot, "work.999997");
	mkdirSync(join(plain, "deep"), { recursive: true, mode: 0o700 });
	writeFileSync(join(plain, ".owner"), JSON.stringify(f.owner), { mode: 0o600 });
	writeFileSync(join(plain, "deep", "payload.bin"), Buffer.alloc(1 << 20, 1));
	const measured = inspectOne(plain, plainRoot, { ...deps, checkoutProbe: () => null, checkoutNameCache: new Map<string, string | null>() } as InspectDeps);
	expect(measured?.reason).not.toBe("checkout-owned-scratch");
	expect(measured?.sizeBytes ?? 0).toBeGreaterThanOrEqual(1 << 20);
});

test("plan skips the root-local quarantine directory", () => {
	const f = scratchFixture();
	const local = join(f.root, QUARANTINE_LOCAL_DIR, "work.999999.q-2020-01-01T00-00-00-000Z");
	mkdirSync(local, { recursive: true, mode: 0o700 });
	writeFileSync(join(local, ".owner"), JSON.stringify(f.owner), { mode: 0o600 });
	process.env.OMP_KIT_SCRATCH_ROOTS = f.root;
	const home = join(f.base, "home");
	const plan = planScratch(home, { ...deadDeps(), home } as unknown as InspectDeps);
	expect(plan.sessions.some((row) => row.dir.startsWith(`${local}/`) || row.dir === local)).toBe(false);
});

test("expiry drains an expired root-local quarantine entry", () => {
	const f = scratchFixture();
	const home = join(f.base, "home");
	process.env.OMP_KIT_SCRATCH_ROOTS = f.root;
	const local = join(f.root, QUARANTINE_LOCAL_DIR);
	const entry = "work.999999.q-2020-01-01T00-00-00-000Z";
	mkdirSync(join(local, entry), { recursive: true, mode: 0o700 });
	writeFileSync(join(local, entry, ".owner"), JSON.stringify(f.owner), { mode: 0o600 });
	const rows = applyQuarantineExpiry(home, { ...deadDeps(), home } as ApplyDeps);
	const row = rows.find((candidate) => candidate.dir === join(local, entry));
	expect(row?.action).toBe("DELETE");
	expect(existsSync(join(local, entry))).toBe(false);
});

function checkoutRow(touched: string | null, dirty: boolean): CheckoutListRow {
	return { name: "stale-bead", path: join("/checkouts", "stale-bead"), source: "/repo/proj", dirty, created: null, touched };
}

test("checkout reap refuses an active checkout", () => {
	const now = Date.parse("2026-11-20T04:00:00Z");
	const diff: CheckoutDiffInput = { available: true, empty: true };
	const judged = judgeCheckoutRow(checkoutRow(new Date(now - 3600_000).toISOString(), false), diff, now, 7 * 86_400_000);
	expect(judged.eligible).toBe(false);
	expect(judged.reason).toBe("active-touched-recently");
});

test("checkout reap takes an idle empty checkout first", () => {
	const now = Date.parse("2026-11-20T04:00:00Z");
	const diff: CheckoutDiffInput = { available: true, empty: true };
	const judged = judgeCheckoutRow(checkoutRow(new Date(now - 10 * 86_400_000).toISOString(), false), diff, now, 7 * 86_400_000);
	expect(judged.eligible).toBe(true);
	expect(judged.reason).toBe("idle-empty-eligible");
});

test("checkout archive round-trips through git apply, binaries included", () => {
	const base = ownedTmp("lifecycle-archive", { root: join(import.meta.dir, "..", "..", "var", "agent-tmp") }).path;
	owned.push(base);
	const source = join(base, "source");
	const work = join(base, "work");
	mkdirSync(source, { recursive: true });
	expect(git(source, "init", "-q").code).toBe(0);
	writeFileSync(join(source, "tracked.txt"), "one\n");
	writeFileSync(join(source, "keep.txt"), "keep\n");
	writeFileSync(join(source, "blob.bin"), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
	expect(git(source, "add", "tracked.txt", "keep.txt", "blob.bin").code).toBe(0);
	expect(git(source, "commit", "-qm", "seed the fixture [pending]").code).toBe(0);
	const head = git(source, "rev-parse", "HEAD").out.trim();
	expect(head.length).toBe(40);
	mkdirSync(work, { recursive: true });
	const clone = runSync(["git", "clone", "-q", source, work], { cwd: base, deadline_s: fixtureDeadlineS(), max_output_bytes: 1 << 20, env: GIT_ENV });
	expect(clone.rc).toBe(0);
	writeFileSync(join(work, "tracked.txt"), "one\ntwo\n");
	mkdirSync(join(work, "newdir"), { recursive: true });
	writeFileSync(join(work, "newdir", "file.txt"), "new\n");
	writeFileSync(join(work, "blob.bin"), Buffer.from([0, 1, 2, 3, 9, 9, 9, 7]));
	const trackedDiff = git(work, "diff", "--binary", "HEAD", "--", "tracked.txt", "blob.bin").out;
	const freshDiff = git(work, "diff", "--binary", "--no-index", "--", "/dev/null", "newdir/file.txt").out;
	expect(freshDiff).toContain("new file mode");
	const patchText = `${trackedDiff}${freshDiff}`;
	expect(patchText).toContain("GIT binary patch");
	const dest = join(base, "archive");
	const archived = archiveCheckout({ name: "stale-bead", checkoutPath: work, sourceRepo: source, sourceHead: head, destDir: dest, patchText, tmpRoot: base });
	expect(archived.verified).toBe(true);
	expect(archived.patchBytes).toBeGreaterThan(0);
	const patch = readFileSync(join(dest, "checkout.patch"), "utf8");
	expect(patch).toContain("tracked.txt");
	expect(patch).toContain("newdir/file.txt");
	expect(patch).toContain("GIT binary patch");
	const restore = join(base, "restore");
	mkdirSync(restore, { recursive: true });
	const got = runSync(["git", "archive", head], { cwd: source, deadline_s: fixtureDeadlineS(), max_output_bytes: 16 << 20, env: GIT_ENV });
	expect(got.rc).toBe(0);
	writeFileSync(join(base, "tree.tar"), Buffer.from(got.stdout as Uint8Array));
	const untar = runSync(["tar", "-x", "-f", join(base, "tree.tar"), "-C", restore], { cwd: base, deadline_s: fixtureDeadlineS(), max_output_bytes: 1 << 20 });
	expect(untar.rc).toBe(0);
	// git apply silently skips patches outside a repository: restore inside one.
	expect(git(restore, "init", "-q").code).toBe(0);
	const check = runSync(["git", "apply", "--check", join(dest, "checkout.patch")], { cwd: restore, deadline_s: fixtureDeadlineS(), max_output_bytes: 1 << 20, env: GIT_ENV });
	expect(check.rc).toBe(0);
	const apply = runSync(["git", "apply", join(dest, "checkout.patch")], { cwd: restore, deadline_s: fixtureDeadlineS(), max_output_bytes: 1 << 20, env: GIT_ENV });
	expect(apply.rc).toBe(0);
	expect(readFileSync(join(restore, "tracked.txt"), "utf8")).toBe("one\ntwo\n");
	expect(readFileSync(join(restore, "newdir", "file.txt"), "utf8")).toBe("new\n");
	expect(Buffer.from(readFileSync(join(restore, "blob.bin"))).equals(Buffer.from([0, 1, 2, 3, 9, 9, 9, 7]))).toBe(true);
	expect(readFileSync(join(dest, "manifest.json"), "utf8")).toContain(head);
});

test("checkout archive refuses when the diff is unreadable", () => {
	const base = ownedTmp("lifecycle-archive-negative", { root: join(import.meta.dir, "..", "..", "var", "agent-tmp") }).path;
	owned.push(base);
	const dest = join(base, "archive");
	const archived = archiveCheckout({ name: "no-such-checkout-xyz", checkoutPath: join(base, "missing"), sourceRepo: join(base, "missing"), sourceHead: "0".repeat(40), destDir: dest });
	expect(archived.verified).toBe(false);
	expect(archived.reason).toBe("archive-diff-unavailable");
});

test("sameReleasedFile tolerates a renumbered device only after a reboot", () => {
	const stat = { dev: 16777233, ino: 3123619420 };
	const marker = { device: "16777232", inode: "3123619420" };
	expect(sameReleasedFile(stat, marker, "2026-11-14T14:22:19.697Z", Date.parse("2026-11-20T04:00:00Z"))).toBe(true);
	expect(sameReleasedFile(stat, marker, "2026-11-14T14:22:19.697Z", Date.parse("2026-11-14T14:20:00Z"))).toBe(false);
	expect(sameReleasedFile(stat, marker, "2026-11-14T14:22:19.697Z", null)).toBe(false);
	expect(sameReleasedFile({ dev: 16777233, ino: 1 }, marker, "2026-11-14T14:22:19.697Z", Date.parse("2026-11-20T04:00:00Z"))).toBe(false);
	expect(sameReleasedFile({ dev: 16777232, ino: 3123619420 }, marker, "2026-11-14T14:22:19.697Z", null)).toBe(true);
});

test("release --now retires a pre-reboot marker after a reboot", () => {
	const f = scratchFixture();
	const ownerText = JSON.stringify({ ...f.owner, agent: "T", session: "01a1c7b7-4c2b-7003-a39a-aba861e7e235" });
	writeFileSync(join(f.dir, ".owner"), ownerText, { mode: 0o600 });
	writeFileSync(join(f.dir, "payload"), "retire me\n");
	const ino = lstatSync(f.dir).ino;
	const releasedAt = "2026-11-14T14:22:19.697Z";
	const markerText = `version=1\nowner_sha256=${createHash("sha256").update(ownerText).digest("hex")}\ndevice=1\ninode=${ino}\nreleased_at=${releasedAt}\nbin=throwaway\n`;
	writeFileSync(join(f.dir, ".omp-kit-release"), markerText, { mode: 0o600 });
	const home = join(f.base, "home");
	process.env.OMP_KIT_SCRATCH_ROOTS = f.root;
	const deps = {
		...deadDeps(),
		home,
		lsofSnapshot: new Set<string>(),
		bootMs: Date.parse("2026-11-20T04:00:00Z"),
		callerSeat: () => ({ agent: "T", sessions: ["01a1c7b7-4c2b-7003-a39a-aba861e7e235"], main: "01a1c7b7-4c2b-7003-a39a-aba861e7e235" }),
	};
	const result = releaseScratch(f.dir, home, deps as ApplyDeps, { now: true, bin: "throwaway" });
	expect(result.reason).toBe("owner-released-deleted");
	expect(existsSync(f.dir)).toBe(false);
});

test("receipt enumerates every failed entry with its reason", () => {
	const f = scratchFixture();
	rmSync(join(f.dir, ".owner"));
	const old = new Date("2020-01-01T00:00:00Z");
	writeFileSync(join(f.dir, "payload"), "unowned\n");
	for (const path of [join(f.dir, "payload"), f.dir]) utimesSync(path, old, old);
	const home = join(f.base, "home");
	process.env.OMP_KIT_SCRATCH_ROOTS = f.root;
	const exdev = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
	exdev.code = "EXDEV";
	const deps = { ...deadDeps(), home, renameDir: () => { throw exdev; } };
	const result = applyScratch(home, deps as ApplyDeps);
	expect(result.receipt.failed_count).toBeGreaterThan(0);
	expect(result.receipt.failures.length).toBe(result.receipt.failed_count);
	expect(result.receipt.failuresTruncated).toBe(false);
	expect(result.receipt.failures[0]?.reason).toBe("atomic-quarantine-failed");
	expect(result.receipt.failures.every((row) => typeof row.dir === "string" && typeof row.reason === "string")).toBe(true);
});

test("sizeByRoot never counts a checkout view as reclaimable", () => {
	const coRoot = join(fixtureBase(), "checkouts", "co1", "var", "agent-tmp");
	const root = join(fixtureBase(), "proj", "var", "agent-tmp");
	const totals = summarizeScratch([
		{ dir: join(coRoot, "work.1"), action: "SKIP", reason: "checkout-owned-scratch", owner: null, sizeBytes: 35_000_000_000 },
		{ dir: join(root, "work.2"), action: "SKIP", reason: "no-owner-file", owner: null, sizeBytes: 7 },
	], [coRoot, root]);
	expect(totals.sizeByRoot[coRoot] ?? 0).toBe(0);
	expect(totals.sizeByRoot[root]).toBe(7);
	expect(totals.sizeByVerdict["SKIP:checkout-owned-scratch"]).toBe(35_000_000_000);
	expect(totals.countByVerdict["SKIP:checkout-owned-scratch"]).toBe(1);
});

test("checkout apply reports df-delta beside the du estimate", () => {
	const readings = [100_000_000, 160_000_000];
	const result = applyCheckoutReap({ list: () => ({ rows: [] }), archiveRoot: fixtureBase(), freeBytes: () => readings.shift() ?? null });
	expect(result.freeBytesBefore).toBe(100_000_000);
	expect(result.freeBytesAfter).toBe(160_000_000);
	expect(result.freedBytesDf).toBe(60_000_000);
	const unmeasured = applyCheckoutReap({ list: () => ({ rows: [] }), archiveRoot: fixtureBase(), freeBytes: () => null });
	expect(unmeasured.freedBytesDf).toBe(null);
});

// CHECKOUTBUDGET1: the scheduled reaper timed out (30 min cap, interruptedAction misleadingly BROWSER_INSPECT) because the checkout
// phase ran `du -sk` on every eligible NFS checkout (30 s deadline each, 18 rows = 540 s) to reap at most ten, then archived them
// with no regard for the cap. Only reapable rows are sized, and no reap starts when it cannot finish before the run deadline.
function idleRows(count: number, now: number): CheckoutListRow[] {
	return Array.from({ length: count }, (_, index) => ({ name: `idle-${index}`, path: join("/checkouts", `idle-${index}`), source: "/repo/proj",
		dirty: false, created: null, touched: new Date(now - (10 + index) * 86_400_000).toISOString() }));
}

test("CHECKOUTBUDGET1: only the checkouts that can be reaped are sized, idlest first", () => {
	const now = Date.parse("2026-11-20T04:00:00Z");
	const sized: string[] = [];
	const result = applyCheckoutReap({ now, idleDays: 7, archiveRoot: fixtureBase(), freeBytes: () => null, rm: () => true,
		list: () => ({ rows: idleRows(5, now) }), maxReaps: 2, sizeBytes: (path) => { sized.push(path); return 1024; } });
	expect(result.eligible).toBe(5);
	expect(sized).toEqual([join("/checkouts", "idle-4"), join("/checkouts", "idle-3")]);
});

test("CHECKOUTBUDGET1: a reap that cannot finish before the run deadline is not started", () => {
	const now = Date.parse("2026-11-20T04:00:00Z");
	const started: string[] = [];
	const result = applyCheckoutReap({ now, idleDays: 7, archiveRoot: fixtureBase(), freeBytes: () => null, rm: () => true,
		list: () => ({ rows: idleRows(3, now) }), maxReaps: 10, deadlineMs: Date.now() + 60_000, reserveMs: 180_000,
		onReap: (name) => { started.push(name); } });
	expect(started).toEqual([]);
	expect(result.reaped).toEqual([]);
	expect(result.kept.map((row) => row.reason)).toEqual(["run-deadline", "run-deadline", "run-deadline"]);
});

test("CHECKOUTBUDGET1: while time remains each reap is reported before it starts, idlest first", () => {
	const now = Date.parse("2026-11-20T04:00:00Z");
	const started: string[] = [];
	const result = applyCheckoutReap({ now, idleDays: 7, archiveRoot: fixtureBase(), freeBytes: () => null, rm: () => true,
		list: () => ({ rows: idleRows(3, now) }), maxReaps: 10, deadlineMs: Date.now() + 3_600_000, reserveMs: 1_000,
		onReap: (name) => { started.push(name); } });
	expect(started).toEqual(["idle-2", "idle-1", "idle-0"]);
	expect(result.kept.some((row) => row.reason === "run-deadline")).toBe(false);
});
