import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runFleetWatchOnce } from "../../src/fleet-watch.ts";
import {
	applyTrackerQuarantineRetention,
	planTrackerQuarantineRetention,
	retainTrackerQuarantine,
	TRACKER_QUARANTINE_RETENTION_MS,
	type TrackerRetentionHolder,
	type TrackerRetentionPlan,
	type TrackerRetentionReason,
} from "../../src/tracker-recovery.ts";

const NOW = 1_791_276_000_000;
const OLD_MS = NOW - TRACKER_QUARANTINE_RETENTION_MS - 86_400_000;
const session = "omp-test";

const clearHolder = (_path: string): TrackerRetentionHolder => ({ state: "clear" });

function scratchRepo(name: string): { scratch: string; repo: string } {
	const parent = join(resolve(import.meta.dir, "../.."), "var/agent-tmp");
	mkdirSync(parent, { recursive: true });
	const scratch = mkdtempSync(join(parent, `tracker-retention-${name}.`));
	const repo = join(scratch, "repo");
	mkdirSync(repo, { recursive: true });
	return { scratch, repo };
}

function cleanup(scratch: string): void {
	if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
}

function br(args: readonly string[], repo: string): string {
	const out = spawnSync("br", [...args], { cwd: repo, encoding: "utf8" });
	expect(out.status).toBe(0);
	return out.stdout;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function touchOld(root: string): void {
	const dirs: string[] = [];
	const walk = (dir: string): void => {
		dirs.push(dir);
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else utimesSync(full, OLD_MS / 1000, OLD_MS / 1000);
		}
	};
	walk(root);
	for (const dir of dirs) utimesSync(dir, OLD_MS / 1000, OLD_MS / 1000);
}

function snapshotFiles(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			const info = lstatSync(full);
			if (info.isSymbolicLink()) out.set(full, `link:${readlinkSync(full)}`);
			else if (info.isDirectory()) walk(full);
			else if (info.isFile()) out.set(full, createHash("sha256").update(readFileSync(full)).digest("hex"));
			else out.set(full, "special");
		}
	};
	walk(root);
	return out;
}

function expectSameSnapshot(before: Map<string, string>, root: string): void {
	const after = snapshotFiles(root);
	expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
}

function reasonByPath(outcome: { receipt: { paths: { path: string; reason: TrackerRetentionReason }[] } }): Record<string, TrackerRetentionReason> {
	return Object.fromEntries(outcome.receipt.paths.map(entry => [entry.path, entry.reason]));
}

/** A completed WAL-index quarantine dir mirroring the native on-disk shape. */
function plantWalIndex(repo: string, name: string, options: { inside?: boolean; complete?: boolean; prepared?: boolean; old?: boolean; extra?: Record<string, string> } = {}): string {
	const dir = join(repo, ".beads", `.br-wal-index-${name}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "poisoned-shm"), "planted-shm-payload");
	if (options.prepared !== false) {
		writeJson(join(dir, "prepared.json"), {
			schema_version: "br.wal_index.quarantine.v1",
			database_path: options.inside === false ? "/foreign/elsewhere/.beads/beads.db" : join(repo, ".beads", "beads.db"),
			reason: "initialized-zero-page-wal-index",
		});
	}
	if (options.complete !== false) {
		writeJson(join(dir, "quarantine-complete.json"), { schema_version: "br.wal_index.quarantine.v1", stage: "complete" });
	}
	for (const [file, content] of Object.entries(options.extra ?? {})) writeFileSync(join(dir, file), content);
	if (options.old !== false) touchOld(dir);
	return dir;
}

function plantMigrationRun(repo: string, name: string, options: { prepared?: boolean; failed?: boolean; complete?: boolean; appliedPair?: boolean; old?: boolean } = {}): string {
	const dir = join(repo, ".beads", ".br_recovery", "schema-migrations", name);
	mkdirSync(join(dir, "recovery-before"), { recursive: true });
	if (options.prepared !== false) {
		writeJson(join(dir, "recovery-prepared.json"), {
			schema_version: "br.doctor.schema_migration.recovery.v1",
			database_path: join(repo, ".beads", "beads.db"),
			stage: "live-preflight",
		});
	}
	if (options.failed === true) writeJson(join(dir, "recovery-failed.json"), { stage: "live-recovery" });
	if (options.complete === true) writeJson(join(dir, "recovery-complete.json"), { stage: "complete" });
	if (options.appliedPair === true) {
		writeJson(join(dir, "applied.json"), { stage: "applied" });
		writeJson(join(dir, "commit-ready.json"), { stage: "commit-ready" });
	}
	if (options.old !== false) touchOld(dir);
	return dir;
}

test("owned dead completed artifacts beyond the bound are reaped with per-path receipt; rest remain; repeat is idempotent; native records unchanged", () => {
	const { scratch, repo } = scratchRepo("positive");
	try {
		br(["init", "--actor", "retention-test"], repo);
		br(["create", "--title", "retention probe", "--actor", "retention-test"], repo);
		const listBefore = br(["list", "--json"], repo);
		const countBefore = br(["count"], repo);

		const reapedWal = plantWalIndex(repo, "old", { old: true });
		const reapedRun = plantMigrationRun(repo, "20260925T200953-old-0", { complete: true, old: true });
		const recentWal = plantWalIndex(repo, "recent", { old: false });
		const unresolvedRun = plantMigrationRun(repo, "20261002T224934-unresolved-0", { failed: true, old: true });
		const recentSnap = snapshotFiles(recentWal);
		const unresolvedSnap = snapshotFiles(unresolvedRun);

		const outcome = retainTrackerQuarantine(repo, { now: () => NOW, holderOf: clearHolder });
		expect(outcome).not.toBeNull();
		expect(outcome!.receipt.retentionBoundMs).toBe(TRACKER_QUARANTINE_RETENTION_MS);
		expect(outcome!.receipt.reapedCount).toBe(2);
		expect(outcome!.receipt.paths.filter(entry => entry.action === "REAPED").map(entry => entry.path).sort())
			.toEqual([reapedWal, reapedRun].sort());
		for (const entry of outcome!.receipt.paths) {
			if (entry.action === "REAPED") expect(entry.reason).toBe("OWNED_DEAD_COMPLETED_BEYOND_BOUND");
		}
		expect(existsSync(reapedWal)).toBe(false);
		expect(existsSync(reapedRun)).toBe(false);
		expectSameSnapshot(recentSnap, recentWal);
		expectSameSnapshot(unresolvedSnap, unresolvedRun);
		const reasons = reasonByPath(outcome!);
		expect(reasons[recentWal]).toBe("RECENT");
		expect(reasons[unresolvedRun]).toBe("UNRESOLVED");

		expect(br(["list", "--json"], repo)).toBe(listBefore);
		expect(br(["count"], repo)).toBe(countBefore);

		expect(retainTrackerQuarantine(repo, { now: () => NOW, holderOf: clearHolder })).toBeNull();
		expectSameSnapshot(recentSnap, recentWal);
		expectSameSnapshot(unresolvedSnap, unresolvedRun);
	} finally {
		cleanup(scratch);
	}
});

test("held, foreign, symlinked, ownership-unknown, live-sidecar, cert, incomplete and file-type targets stay byte-identical and reported protected", () => {
	const { scratch, repo } = scratchRepo("negatives");
	try {
		mkdirSync(join(repo, ".beads"), { recursive: true });
		const reapable = plantWalIndex(repo, "reapable", { old: true });
		const held = plantWalIndex(repo, "held", { old: true });
		const foreign = plantWalIndex(repo, "foreign", { old: true, inside: false });
		const unknown = plantWalIndex(repo, "unknown", { old: true, prepared: false });
		const liveSidecar = plantWalIndex(repo, "livesidecar", { old: true, extra: { "beads.db-wal": "live-wal-bytes" } });
		const cert = plantWalIndex(repo, "withcert", { old: true, extra: { "backup.cert": "cert-bytes" } });
		const incomplete = plantMigrationRun(repo, "20261005T005543-incomplete-0", { prepared: false, old: true });
		const failedRun = plantMigrationRun(repo, "20261002T224934-failed-0", { failed: true, old: true });
		const fileType = join(repo, ".beads", ".br-wal-index-file");
		writeFileSync(fileType, "not-a-directory");
		const linkTarget = join(repo, ".beads", "link-target.txt");
		writeFileSync(linkTarget, "link-target-bytes");
		const symlink = join(repo, ".beads", ".br-wal-index-link");
		symlinkSync(linkTarget, symlink);

		const protectedDirs = [held, foreign, unknown, liveSidecar, cert, incomplete, failedRun];
		const protectedSnaps: Record<string, Map<string, string>> = {};
		for (const dir of protectedDirs) protectedSnaps[dir] = snapshotFiles(dir);
		const fileTypeHash = createHash("sha256").update(readFileSync(fileType)).digest("hex");
		const linkPointsAt = readlinkSync(symlink);
		const holderOf = (path: string): TrackerRetentionHolder =>
			path === held ? { state: "held", pid: 424242 } : { state: "clear" };
		const outcome = retainTrackerQuarantine(repo, { now: () => NOW, holderOf });
		expect(outcome).not.toBeNull();
		expect(existsSync(reapable)).toBe(false);
		expect(outcome!.receipt.reapedCount).toBe(1);
		const reasons = reasonByPath(outcome!);
		expect(reasons[held]).toBe("HELD");
		expect(reasons[foreign]).toBe("FOREIGN");
		expect(reasons[symlink]).toBe("SYMLINK");
		expect(reasons[unknown]).toBe("OWNERSHIP_UNKNOWN");
		expect(reasons[liveSidecar]).toBe("LIVE_DB_SIDECAR");
		expect(reasons[cert]).toBe("CERT");
		expect(reasons[incomplete]).toBe("OWNERSHIP_UNKNOWN");
		expect(reasons[failedRun]).toBe("UNRESOLVED");
		expect(reasons[fileType]).toBe("UNEXPECTED_TYPE");
		for (const dir of protectedDirs) expectSameSnapshot(protectedSnaps[dir]!, dir);
		expect(createHash("sha256").update(readFileSync(fileType)).digest("hex")).toBe(fileTypeHash);
		expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
		expect(readlinkSync(symlink)).toBe(linkPointsAt);
		expect(readFileSync(linkTarget, "utf8")).toBe("link-target-bytes");
	} finally {
		cleanup(scratch);
	}
});
test("a holder appearing between plan and apply lands the path in FINAL_LIVENESS_RECHECK, byte-identical", () => {
	const { scratch, repo } = scratchRepo("plan-apply");
	try {
		mkdirSync(join(repo, ".beads"), { recursive: true });
		const dir = plantWalIndex(repo, "race", { old: true });
		const before = snapshotFiles(dir);
		const plan = planTrackerQuarantineRetention(repo, { now: () => NOW, holderOf: clearHolder });
		expect(plan?.candidates.find(entry => entry.path === dir)?.verdict).toBe("REAP");
		const result = applyTrackerQuarantineRetention(plan, repo, {
			now: () => NOW,
			holderOf: (path: string): TrackerRetentionHolder =>
				path === dir ? { state: "held", pid: 999001 } : { state: "clear" },
		});
		expect(result.applied).toBe(true);
		if (!result.applied) return;
		const entry = result.outcome.receipt.paths.find(candidate => candidate.path === dir);
		expect(entry?.action).toBe("PROTECTED");
		expect(entry?.reason).toBe("FINAL_LIVENESS_RECHECK");
		expectSameSnapshot(before, dir);
	} finally {
		cleanup(scratch);
	}
});

test("apply without an issued decision fails OWNERSHIP_DECISION_REQUIRED with zero effects", () => {
	const { scratch, repo } = scratchRepo("bypass");
	try {
		mkdirSync(join(repo, ".beads"), { recursive: true });
		const dir = plantWalIndex(repo, "owned", { old: true });
		const before = snapshotFiles(dir);

		const missing = applyTrackerQuarantineRetention(null, repo, { now: () => NOW, holderOf: clearHolder });
		expect(missing.applied).toBe(false);
		if (!missing.applied) expect(missing.control).toBe("OWNERSHIP_DECISION_REQUIRED");

		const forged: TrackerRetentionPlan = {
			schema_version: 1,
			repo: resolve(repo),
			retentionBoundMs: TRACKER_QUARANTINE_RETENTION_MS,
			nonce: "forged-nonce",
			plannedAt: NOW,
			candidates: [{ path: dir, family: "wal-index", bytes: 1, ageMs: NOW, verdict: "REAP", reason: "OWNED_DEAD_COMPLETED_BEYOND_BOUND" }],
		};
		const refused = applyTrackerQuarantineRetention(forged, repo, { now: () => NOW, holderOf: clearHolder });
		expect(refused.applied).toBe(false);
		if (!refused.applied) expect(refused.control).toBe("OWNERSHIP_DECISION_REQUIRED");
		expectSameSnapshot(before, dir);

		const plan = planTrackerQuarantineRetention(repo, { now: () => NOW, holderOf: clearHolder });
		const first = applyTrackerQuarantineRetention(plan, repo, { now: () => NOW, holderOf: clearHolder });
		expect(first.applied).toBe(true);
		expect(existsSync(dir)).toBe(false);
		const replay = applyTrackerQuarantineRetention(plan, repo, { now: () => NOW, holderOf: clearHolder });
		expect(replay.applied).toBe(false);
		if (!replay.applied) expect(replay.control).toBe("OWNERSHIP_DECISION_REQUIRED");
	} finally {
		cleanup(scratch);
	}
});

test("fleet-watch tick emits the retention action with receipt; quiet repos stay silent", () => {
	const planted = scratchRepo("wiring");
	const quiet = scratchRepo("quiet");
	try {
		mkdirSync(join(planted.repo, ".beads"), { recursive: true });
		const dir = plantWalIndex(planted.repo, "old", { old: true });
		mkdirSync(join(quiet.repo, ".beads"), { recursive: true });
		plantWalIndex(quiet.repo, "recent", { old: false });
		const logPath = join(planted.scratch, "fleet-watch.jsonl");
		const actions = runFleetWatchOnce(
			{ enabled: true, intervalSeconds: 60, noDecisionChecks: 5, sessions: [
				{ session, coordinatorPane: "%54", coordinatorSession: session, repo: planted.repo, workerPanes: [] },
				{ session: "omp-other", coordinatorPane: "%55", coordinatorSession: "omp-other", repo: quiet.repo, workerPanes: [] },
			] },
			{
				capture: () => ({ code: 0, stdout: "idle", stderr: "" }),
				send: () => { throw new Error("retention must not steer panes"); },
				sendKeys: () => { throw new Error("retention must not steer panes"); },
				logPath,
				recoverTracker: () => null,
				retainTracker: (target: string) => retainTrackerQuarantine(target, { now: () => NOW, holderOf: clearHolder }),
			},
		);
		const retention = actions.filter(action => action.kind === "TRACKER_QUARANTINE_RETENTION");
		expect(retention).toHaveLength(1);
		expect(retention[0]).toMatchObject({ session, pane: "tracker", repo: planted.repo });
		if (retention[0]?.kind !== "TRACKER_QUARANTINE_RETENTION") return;
		expect(retention[0].receipt.reapedCount).toBe(1);
		expect(retention[0].receipt.retentionBoundMs).toBe(TRACKER_QUARANTINE_RETENTION_MS);
		expect(existsSync(dir)).toBe(false);
		const logged = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		expect(logged.filter(entry => entry.kind === "TRACKER_QUARANTINE_RETENTION")).toHaveLength(1);
	} finally {
		cleanup(planted.scratch);
		cleanup(quiet.scratch);
	}
});
