import { strict as assert } from "node:assert";
import { test } from "bun:test";
import { parseSweepSchedule, planRepoSweep, reauditSweep, sweepCommittersByName, validateSweepHolds } from "./save-sweep.ts";
import type { WorkRepoReport } from "./work-doctor.ts";
function repo(overrides: Partial<WorkRepoReport> = {}): WorkRepoReport {
	return {
		name: "companion", path: "/Users/josh/Developer/omp-kit-companion",
		status: "WARN", dirty_file_count: 4, tracked_dirty_file_count: 3,
		untracked_file_count: 1, untracked_file_cap: 1000, untracked_scan_status: "OK",
		commits_ahead: 0, commits_behind: 0, unpushed_commits: 0,
		has_upstream: true, has_remote: true, no_upstream: false, no_remote: false,
		stash_count: 0, detached: false, branch: "main",
		last_commit_epoch: 1_700_000_000, last_commit_age_days: 1,
		active_worktrees: 1, worktree_paths: ["/Users/josh/Developer/omp-kit-companion"],
		reservation_scan_status: "OK", stale_uncommitted_edits: [],
		risk_score: 0, findings: ["dirty"], stranded: true, conditions: ["dirty"],
		...overrides,
	};
}

const ASSIGN = [{ repo_path: "/Users/josh/Developer/omp-kit-companion", committer: "sweep-committer" }];

test("due sweep groups eligible work, strands the live hold, permits push, releases after push", () => {
	const plan = planRepoSweep({
		repo: repo(),
		dirty: [
			{ path: "src/a.ts", size_bytes: 10, secret_flag: false },
			{ path: "src/b.ts", size_bytes: 20, secret_flag: false },
			{ path: "docs/note.md", size_bytes: 5, secret_flag: false },
			{ path: "src/held.ts", size_bytes: 30, secret_flag: false },
		],
		assignments: ASSIGN,
		holds: [{ path: "src/held.ts", bead: "br-123", holder: "WorkerBee" }],
		validator: validateSweepHolds,
		ownReservations: ["src/*.ts"],
	});
	assert.equal(plan.outcome, "plan");
	assert.equal(plan.committer, "sweep-committer");
	assert.deepEqual(plan.groups, [
		{ dir: "docs", paths: ["docs/note.md"] },
		{ dir: "src", paths: ["src/a.ts", "src/b.ts"] },
	]);
	assert.deepEqual(plan.stranded, [{ path: "src/held.ts", reason: "live-hold:br-123" }]);
	assert.equal(plan.push_permitted, true);
	assert.deepEqual(plan.releasable, ["src/*.ts"]);
	assert.deepEqual(reauditSweep(plan, ["src/held.ts"]), []);
});

test("planted negative: live-held file strands byte-identical, no-AM-id and owner holds strand, double committer refuses", () => {
	const stranded = planRepoSweep({
		repo: repo(),
		dirty: [
			{ path: "src/live.ts", size_bytes: 40, secret_flag: false },
			{ path: "src/noid.ts", size_bytes: 40, secret_flag: false },
			{ path: "src/owner.ts", size_bytes: 40, secret_flag: false },
		],
		assignments: ASSIGN,
		holds: [
			{ path: "src/live.ts", bead: "br-9", holder: "WorkerBee" },
			{ path: "src/noid.ts", bead: null, holder: "WorkerBee" },
			{ path: "src/owner.ts", bead: "br-10", holder: "Josh" },
		],
		validator: validateSweepHolds,
		ownReservations: [],
	});
	assert.equal(stranded.outcome, "plan");
	assert.deepEqual(stranded.groups, []);
	const reasons = Object.fromEntries(stranded.stranded.map((s) => [s.path, s.reason]));
	assert.equal(reasons["src/live.ts"], "live-hold:br-9");
	assert.equal(reasons["src/noid.ts"], "hold-no-am-id");
	assert.equal(reasons["src/owner.ts"], "hold-addressed-to-owner");

	const refused = planRepoSweep({
		repo: repo(), dirty: [], assignments: [...ASSIGN, { repo_path: ASSIGN[0]!.repo_path, committer: "second" }],
		holds: [], validator: validateSweepHolds, ownReservations: [],
	});
	assert.equal(refused.outcome, "refuse");
	assert.equal(refused.refusal, "two-committers-for-one-repo");
	assert.deepEqual(refused.groups, []);
	assert.equal(refused.push_permitted, false);
});

test("named control SAVE_SWEEP_HOLD_VALIDATOR: removing the validator refuses instead of sweeping", () => {
	const plan = planRepoSweep({
		repo: repo(),
		dirty: [{ path: "src/a.ts", size_bytes: 10, secret_flag: false }],
		assignments: ASSIGN,
		holds: [{ path: "src/a.ts", bead: "br-1", holder: "WorkerBee" }],
		validator: null,
		ownReservations: [],
	});
	assert.equal(plan.outcome, "refuse");
	assert.equal(plan.refusal, "SAVE_SWEEP_HOLD_VALIDATOR_REQUIRED");
	assert.deepEqual(plan.groups, []);
});

test("push withheld without remote or upstream; secrets, oversize and generated strand; unknowns re-audited", () => {
	const local = planRepoSweep({
		repo: repo({ has_remote: false, has_upstream: false, no_remote: true, no_upstream: true }),
		dirty: [
			{ path: "src/a.ts", size_bytes: 10, secret_flag: false },
			{ path: "src/cred.ts", size_bytes: 10, secret_flag: true },
			{ path: "bin/blob", size_bytes: 11 * 1024 * 1024, secret_flag: false },
			{ path: "node_modules/x.js", size_bytes: 5, secret_flag: false },
		{ path: "src/mystery.ts", size_bytes: null, secret_flag: false },
		],
		assignments: ASSIGN,
		holds: [], validator: validateSweepHolds, ownReservations: ["src/*.ts"],
	});
	assert.equal(local.outcome, "plan");
	assert.equal(local.push_permitted, false);
	assert.equal(local.push_reason, "no-remote: commit locally only");
	assert.deepEqual(local.releasable, []);
	const reasons = Object.fromEntries(local.stranded.map((s) => [s.path, s.reason]));
	assert.equal(reasons["src/cred.ts"], "secret-flagged");
	assert.equal(reasons["bin/blob"], "over-10mb");
	assert.equal(reasons["node_modules/x.js"], "generated-gitignore-candidate");
	assert.deepEqual(local.unknowns, ["src/mystery.ts"]);
	assert.deepEqual(
		reauditSweep(local, ["src/cred.ts", "bin/blob", "node_modules/x.js", "src/mystery.ts"]),
		[],
	);
	assert.deepEqual(reauditSweep(local, ["src/cred.ts", "src/sneaked.ts"]), ["src/sneaked.ts"]);
});

test("fleet overlay names one committer per repo and pins the sweep to 1-2h", () => {
	assert.deepEqual(
		sweepCommittersByName([{ name: "companion", path: "/tmp/x", committer: "sweep-committer" }]), // tempsafe: fake config path, never touched on disk
		{ companion: "sweep-committer" },
	);
	assert.deepEqual(
		sweepCommittersByName([{ name: "companion", path: "/tmp/x" }]), // tempsafe: fake config path, never touched on disk
		{},
	);
	assert.throws(
		() => sweepCommittersByName([{ name: "companion", path: "/tmp/x", committer: "two words" }]), // tempsafe: fake config path, never touched on disk
		/SAVE_SWEEP_REPO_0_COMMITTER_INVALID/,
	);
	assert.throws(() => sweepCommittersByName("nope"), /SAVE_SWEEP_REPOS_INVALID/);
	assert.deepEqual(parseSweepSchedule({}), { interval_minutes: 90 });
	assert.deepEqual(parseSweepSchedule({ sweep_interval_minutes: 60 }), { interval_minutes: 60 });
	assert.deepEqual(parseSweepSchedule({ sweep_interval_minutes: 120 }), { interval_minutes: 120 });
	assert.throws(() => parseSweepSchedule({ sweep_interval_minutes: 30 }), /LESSONS_CONFIG_SWEEP_INTERVAL_INVALID/);
	assert.throws(() => parseSweepSchedule({ sweep_interval_minutes: 180 }), /LESSONS_CONFIG_SWEEP_INTERVAL_INVALID/);
});
