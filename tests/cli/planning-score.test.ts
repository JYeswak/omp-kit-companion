import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { diagnose } from "../../src/diagnostics.ts";
import { renderOutput, type PresentationResult } from "../../src/output.ts";
import { record } from "../../src/mcp-sources.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("planning-score-test", { root: scratchRoot }).path;

function fixture(label: string): string {
	const path = join(scratch, label);
	mkdirSync(path, { recursive: true });
	return path;
}

async function scoreApi() {
	const module = await import("../../src/planning-score.ts").catch(() => null);
	if (!module) {
		expect(module).not.toBeNull();
		return null;
	}
	return module;
}

const tuning = {
	targets: {
		plan_present: true, plan_rounds: 4, plan_last_diff: 0.05, converted_once: 1, coverage_checks: 1,
		polish_rounds: 6, polish_last_changed: 0.05, bead_self_contained_median_chars: 300,
		bead_self_contained_acceptance_present_share: 0.4, bead_self_contained_deps_per_bead: 1,
		bead_breadth_max_files: 5, bead_breadth_max_components: 3, plan_to_code_hours: 24, plan_ship_ratio_7d: 2,
	},
	weights: { plan_present: 1, plan_rounds: 1, plan_last_diff: 1, converted_once: 1, coverage_checks: 1,
		polish_rounds: 1, polish_last_changed: 1, bead_self_contained: 1, bead_breadth: 1,
		plan_to_code_hours: 1, plan_ship_ratio_7d: 1, main_green: 1 },
};
const now = 1_800_000_000;
const day = 86_400;
function commit(sha: string, subject: string, timestamp: number, extra: Record<string, unknown> = {}) {
	return { sha, subject, timestamp, ...extra };
}
function bead(id: string, extra: Record<string, unknown> = {}) {
	return { id, title: "Mission item", description: "Plan: PLAN_demo.md section 1. " + "detail ".repeat(55) + "Names tests.",
		acceptance_criteria: "Test outcomes are verified in `src/demo/worker.ts`.", status: "open", dependencies: [{ depends_on_id: "root", type: "blocks" }], ...extra };
}
function passingSnapshot() {
	const planBeads = Array.from({ length: 20 }, (_, i) => bead("b" + i));
	const prior = planBeads.map((item) => ({ ...item }));
	const polished = planBeads.map((item, i) => i === 0 ? { ...item, notes: "last polish" } : { ...item });
	const tenDaysAgo = now - 10 * day;
	const repoCommits = [
		commit("draft", "plan(demo): draft", tenDaysAgo, { changedPaths: ["PLAN_demo.md"] }),
		commit("review1", "plan(demo): review round 1", tenDaysAgo + 600, { changedPaths: ["PLAN_demo.md"], planDiffRatio: 0.01 }),
		commit("review2", "plan(demo): review round 2", tenDaysAgo + 1200, { changedPaths: ["PLAN_demo.md"], planDiffRatio: 0.01 }),
		commit("review3", "plan(demo): review round 3", tenDaysAgo + 1800, { changedPaths: ["PLAN_demo.md"], planDiffRatio: 0.01 }),
		commit("review4", "plan(demo): review round 4", tenDaysAgo + 2400, { changedPaths: ["PLAN_demo.md"], planDiffRatio: 0.01 }),
		commit("code-first", "feat: first code", tenDaysAgo + 7200, { changedPaths: ["src/demo.ts"] }),
		commit("code-recent", "feat: recent code", now - 3600, { changedPaths: ["src/demo.ts"] }),
	];
	const trackerCommits = [
		commit("convert", "beads(demo): convert", tenDaysAgo + 3000, { changedPaths: [".beads/issues.jsonl"] }),
		commit("coverage", "beads(demo): coverage check 1", tenDaysAgo + 3600, { changedPaths: [".beads/issues.jsonl"] }),
		...Array.from({ length: 6 }, (_, i) => commit("polish" + i, "beads(demo): polish round " + (i + 1), tenDaysAgo + 4000 + i * 100, { changedPaths: [".beads/issues.jsonl"] })),
	];
	return {
		repoPath: "/fixture/repo", trackerPath: "/fixture/repo", mission: "demo", planPath: "PLAN_demo.md", planExists: true,
		repoCommits, trackerCommits, beads: planBeads, polishPreviousBeads: prior, polishCurrentBeads: polished,
		nowEpochSeconds: now, stage: "plan",
		ci: { mode: "local", check: "bun test", branchHeadSha: "code-recent", localReceipts: [{ sha: "code-recent", exit_code: 0, time: new Date(now * 1000).toISOString() }] },
	};
}


test("JSON mode emits one envelope per score row", () => {
	const result: PresentationResult = { code: 0, data: {} };
	const withRows = Object.assign(result, { jsonl: [
		{ kind: "mission", mission: "demo", status: "PASS" },
		{ kind: "overall", status: "PASS" },
	] });
	const rendered = renderOutput(withRows, { toolVersion: "test", schemaVersion: "1", json: true });
	const lines = rendered.stdout.trimEnd().split("\n");
	expect(lines).toHaveLength(2);
	expect(JSON.parse(lines[0]!).data).toMatchObject({ kind: "mission", mission: "demo" });
	expect(JSON.parse(lines[1]!).data).toMatchObject({ kind: "overall", status: "PASS" });
});

test("doctor compares the kit-owned planning skill to a fixture HOME without writing either copy", async () => {
	const root = fixture("doctor-kit");
	const home = fixture("doctor-home");
	const source = join(root, "skills", "jeff-planning-enhanced", "SKILL.md");
	const copy = join(home, ".agents", "skills", "jeff-planning-enhanced", "SKILL.md");
	mkdirSync(join(root, "skills", "jeff-planning-enhanced"), { recursive: true });
	mkdirSync(join(home, ".agents", "skills", "jeff-planning-enhanced"), { recursive: true });
	const original = Buffer.from("kit-owned planning protocol\n");
	writeFileSync(source, original);
	writeFileSync(copy, original);
	const matching = await diagnose({ root, home, scope: "kit" });
	expect(matching.find((item) => item.component === "planning_skill")?.status).toBe("OK");
	const changed = Buffer.from(original);
	changed[0] = changed[0]! ^ 1;
	writeFileSync(copy, changed);
	const drifted = await diagnose({ root, home, scope: "kit" });
	expect(drifted.find((item) => item.component === "planning_skill")?.status).toBe("DRIFT");
	expect(readFileSync(source)).toEqual(original);
	expect(readFileSync(copy)).toEqual(changed);
});

test("the protocol fixture passes every planning metric", async () => {
	const api = await scoreApi();
	if (!api) return;
	const result = api.scorePlanningSnapshot(passingSnapshot(), tuning);
	expect(result.status).toBe("PASS");
	for (const metric of Object.values(result.metrics)) expect(metric.status).toBe("PASS");
	expect(result.weighted_score).toBe(100);
});

test("partial commit history reports unknown for every historical metric", async () => {
	const api = await scoreApi();
	if (!api) return;
	const result = api.scorePlanningSnapshot({ ...passingSnapshot(), repoCommits: null }, tuning);
	expect(result.metrics.plan_last_diff).toMatchObject({ value: null, status: "UNKNOWN" });
});

test("fleet weighted score includes each mission metric instance", async () => {
	const api = await scoreApi();
	if (!api) return;
	const passing = api.scorePlanningSnapshot(passingSnapshot(), tuning);
	const failing = api.scorePlanningSnapshot({ ...passingSnapshot(), mission: "broken", planExists: false }, tuning);
	const overall = api.scorePlanningFleet([passing, failing], tuning);
	expect(overall).toMatchObject({ status: "FAIL", weighted_score: 75 });
});

test("planted planning defects fail only their own metric", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const cases = [
		{ name: "plan_rounds", snapshot: { ...base, repoCommits: base.repoCommits.filter((item) => !item.subject.startsWith("plan(demo): review round 3") && !item.subject.startsWith("plan(demo): review round 4")) } },
		{ name: "plan_last_diff", snapshot: { ...base, repoCommits: base.repoCommits.map((item) => item.sha === "review4" ? { ...item, planDiffRatio: 0.4 } : item) } },
		{ name: "coverage_checks", snapshot: { ...base, trackerCommits: base.trackerCommits.filter((item) => !item.subject.startsWith("beads(demo): coverage check")) } },
		{ name: "polish_last_changed", snapshot: { ...base, polishCurrentBeads: base.polishCurrentBeads.map((item, i) => i < 8 ? { ...item, notes: "planted edit" } : item) } },
		{ name: "plan_ship_ratio_7d", snapshot: { ...base, repoCommits: base.repoCommits.filter((item) => item.sha !== "code-recent").concat(commit("code-one", "feat: one code change", now - 60, { changedPaths: ["src/demo.ts"] })), trackerCommits: base.trackerCommits.concat(Array.from({ length: 20 }, (_, i) => commit("recent-check-" + i, "beads(demo): coverage check " + (i + 2), now - 60 + i, { changedPaths: [".beads/issues.jsonl"] }))) } },
		{ name: "main_green", snapshot: { ...base, ci: { mode: "hosted" } } },
	];
	for (const item of cases) {
		const result = api.scorePlanningSnapshot(item.snapshot, tuning);
		expect(result.metrics[item.name]?.status).not.toBe("PASS");
		for (const [name, metric] of Object.entries(result.metrics)) if (name !== item.name) expect(metric.status).toBe("PASS");
	}
});

test("plan-round target override changes only that verdict", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const twoRounds = { ...base, repoCommits: base.repoCommits.filter((item) => !item.subject.startsWith("plan(demo): review round 3") && !item.subject.startsWith("plan(demo): review round 4")) };
	const defaultResult = api.scorePlanningSnapshot(twoRounds, tuning);
	const override = { ...tuning, targets: { ...tuning.targets, plan_rounds: 2 } };
	const overrideResult = api.scorePlanningSnapshot(twoRounds, override);
	expect(defaultResult.metrics.plan_rounds.status).toBe("FAIL");
	expect(overrideResult.metrics.plan_rounds.status).toBe("PASS");
});

test("A1 excludes parked non-plan beads from polish change share", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const parked = { id: "parked", title: "Deferred", description: "unrelated work", acceptance_criteria: "", status: "parked", labels: ["parked", "mission:demo"], dependencies: [] };
	const parkedAfter = { ...parked, description: "changed parked work" };
	const result = api.scorePlanningSnapshot({ ...base,
		polishPreviousBeads: [...base.polishPreviousBeads, ...Array.from({ length: 20 }, (_, i) => ({ ...parked, id: "parked-" + i }))],
		polishCurrentBeads: [...base.polishCurrentBeads, ...Array.from({ length: 20 }, (_, i) => ({ ...parkedAfter, id: "parked-" + i }))],
	}, tuning);
	expect(result.metrics.polish_last_changed).toMatchObject({ value: 0.05, status: "PASS" });
});

test("A2 coverage checks are not counted as plan review rounds", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const repoCommits = base.repoCommits.filter((item) => !item.subject.startsWith("plan(demo): review round 3") && !item.subject.startsWith("plan(demo): review round 4"));
	const trackerCommits = base.trackerCommits.concat(commit("coverage-extra", "beads(demo): coverage check 2", now, { changedPaths: [".beads/issues.jsonl"] }));
	const result = api.scorePlanningSnapshot({ ...base, repoCommits, trackerCommits }, tuning);
	expect(result.metrics.plan_rounds).toMatchObject({ value: 2, status: "FAIL" });
});

test("A2b review rounds and conversions count with the commit-msg verification-level tag", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const tagged = base.repoCommits.map((item) => item.subject.startsWith("plan(demo): review round") ? { ...item, subject: item.subject + " [selftest]" } : item);
	expect(api.scorePlanningSnapshot({ ...base, repoCommits: tagged }, tuning).metrics.plan_rounds).toMatchObject({ value: 4, status: "PASS" });
	const notALevel = base.repoCommits.map((item) => item.subject.startsWith("plan(demo): review round") ? { ...item, subject: item.subject + " [wip]" } : item);
	expect(api.scorePlanningSnapshot({ ...base, repoCommits: notALevel }, tuning).metrics.plan_rounds).toMatchObject({ value: 0, status: "FAIL" });
});

test("A3 local CI is UNKNOWN without a receipt for the declared branch head", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const stale = api.scorePlanningSnapshot({ ...base, ci: { mode: "local", check: "bun test", branchHeadSha: "head", localReceipts: [{ sha: "old", exit_code: 0, time: new Date(now * 1000).toISOString() }] } }, tuning);
	expect(stale.metrics.main_green).toMatchObject({ value: null, status: "UNKNOWN" });
	const untimed = api.scorePlanningSnapshot({ ...base, ci: { mode: "local", check: "bun test", branchHeadSha: "head", localReceipts: [{ sha: "head", exit_code: 0 }] } }, tuning);
	expect(untimed.metrics.main_green).toMatchObject({ value: null, status: "UNKNOWN" });
	const noCheck = api.scorePlanningSnapshot({ ...base, ci: { mode: "local", branchHeadSha: "head", localReceipts: [{ sha: "head", exit_code: 0, time: new Date(now * 1000).toISOString() }] } }, tuning);
	expect(noCheck.metrics.main_green).toMatchObject({ value: null, status: "UNKNOWN" });
});

test("hosted CI cannot pass without completed success bound to the required workflow and exact head", async () => {
	const api = await scoreApi();
	if (!api) return;
	const ci = { mode: "hosted", requiredWorkflow: "ci.yml", workflowId: 17, workflowPath: ".github/workflows/ci.yml", branchHeadSha: "head",
		run: { databaseId: 101, workflowDatabaseId: 17, workflowName: "CI", headSha: "head", status: "completed", conclusion: "success", createdAt: "2026-10-15T01:00:00Z", attempt: 1 } };
	for (const [status, conclusion, expected] of [
		["completed", "success", "PASS"], ["completed", "failure", "FAIL"], ["completed", "cancelled", "FAIL"],
		["in_progress", "success", "UNKNOWN"], ["queued", "", "UNKNOWN"],
		["completed", "neutral", "UNKNOWN"], ["completed", "skipped", "UNKNOWN"],
	]) {
		const result = api.scorePlanningSnapshot({ ...passingSnapshot(), ci: { ...ci, run: { ...ci.run, status: status!, conclusion: conclusion! } } }, tuning);
		expect(result.metrics.main_green?.status).toBe(expected);
	}
	for (const unbound of [
		{ ...ci, requiredWorkflow: "" }, { ...ci, branchHeadSha: null }, { ...ci, run: null },
		{ ...ci, run: { ...ci.run, headSha: "old" } }, { ...ci, run: { ...ci.run, workflowDatabaseId: 99 } },
	]) expect(api.scorePlanningSnapshot({ ...passingSnapshot(), ci: unbound }, tuning).metrics.main_green?.status).toBe("UNKNOWN");
});

test("hosted collector rejects unrelated and historical greens through the public CLI", () => {
	const result = Bun.spawnSync(["sh", join(repoRoot, "scripts/e2e/planning-main-green.sh")], {
		cwd: repoRoot, env: { ...process.env, KIT: "" }, stdout: "pipe", stderr: "pipe",
	});
	const stdout = new TextDecoder().decode(result.stdout);
	if (result.exitCode !== 0) {
		console.error(stdout);
		console.error(new TextDecoder().decode(result.stderr));
	}
	const observations = new Map<string, unknown>();
	for (const line of stdout.trimEnd().split("\n")) {
		const row: unknown = JSON.parse(line);
		if (record(row) && row.kind === "case" && typeof row.fixture === "string") observations.set(row.fixture, row);
	}
	for (const [fixture, observed] of [
		["unrelated-green-required-red", "FAIL"], ["same-head-newer-red", "FAIL"], ["same-head-newer-cancelled", "FAIL"],
		["same-head-newer-pending", "UNKNOWN"], ["same-run-newer-attempt-red", "FAIL"], ["no-run-at-current-head", "UNKNOWN"],
		["newer-run-for-old-head-must-not-hide-current-green", "PASS"], ["malformed-latest-attempt-cannot-revive-green", "UNKNOWN"],
		["no-required-workflow", "UNKNOWN"], ["workflow-lookup-failed", "UNKNOWN"], ["display-name-not-identity", "UNKNOWN"],
		["required-head-green", "PASS"], ["required-numeric-id-green", "PASS"], ["required-numeric-literal-green", "PASS"],
		["required-full-path-green", "PASS"], ["unrelated-runs-cannot-hide-required-green", "PASS"],
	]) expect(observations.get(fixture!)).toMatchObject({ observed, exit_code: observed === "PASS" ? 0 : observed === "FAIL" ? 1 : 3 });
	expect(result.exitCode).toBe(0);
}, 30_000);

test("A4 uses the mission plan path from its override", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const customPath = "docs/planning/packet.md";
	const beads = base.beads.map((item, i) => i === 0 ? { ...item, description: item.description.replace("PLAN_demo.md", customPath) } : item);
	const result = api.scorePlanningSnapshot({ ...base, planPath: customPath, planExists: true, beads }, tuning);
	expect(result.metrics.plan_present).toMatchObject({ value: true, status: "PASS" });
});

test("A3 A4 and A6 read local CI, plan path and build stage from repo config", async () => {
	const api = await scoreApi();
	if (!api) return;
	expect(typeof api.loadPlanningScoreConfig).toBe("function");
	if (typeof api.loadPlanningScoreConfig !== "function") return;
	const kitRoot = fixture("score-config-kit");
	const repo = fixture("score-config-repo");
	const home = fixture("score-config-home");
	mkdirSync(join(kitRoot, "config"), { recursive: true });
	writeFileSync(join(kitRoot, "config", "planning-score.toml"), readFileSync(join(repoRoot, "config", "planning-score.toml")));
	mkdirSync(join(repo, ".omp"), { recursive: true });
	writeFileSync(join(repo, ".omp", "planning-score.toml"), "[targets]\nplan_rounds = 2\n[ci]\nmode = \"local\"\ncheck = \"sh scripts/check.sh\"\nbranch = \"develop\"\nreceipts = \"receipts\"\n[missions.demo]\nplan = \"docs/planning/packet.md\"\nstage = \"build\"\n");
	const config = api.loadPlanningScoreConfig(kitRoot, repo, home);
	expect(config.tuning.targets.plan_rounds).toBe(2);
	expect(config.raw).toMatchObject({ missions: { demo: { plan: "docs/planning/packet.md", stage: "build" } }, ci: { mode: "local", check: "sh scripts/check.sh", branch: "develop", receipts: "receipts" } });
});

for (const scope of ["base", "override"] as const) {
	for (const legacy of ["test_share", "bead_self_contained_test_share"]) {
		for (const mixed of [false, true]) {
			test(`A5 rejects ${legacy} in ${scope} targets${mixed ? " beside the new key" : ""}`, async () => {
				const api = await scoreApi();
				if (!api) return;
				const label = scope + "-" + legacy + "-" + mixed;
				const kitRoot = fixture("legacy-kit-" + label);
				const repo = fixture("legacy-repo-" + label);
				mkdirSync(join(kitRoot, "config"), { recursive: true });
				mkdirSync(join(repo, ".omp"), { recursive: true });
				const current = readFileSync(join(repoRoot, "config", "planning-score.toml"), "utf8");
				const replacement = "bead_self_contained_acceptance_present_share";
				const legacyBase = mixed
					? current.replace("[targets]", "[targets]\n" + legacy + " = 0.9")
					: current.replaceAll(replacement, legacy);
				writeFileSync(join(kitRoot, "config", "planning-score.toml"), scope === "base" ? legacyBase : current);
				if (scope === "override") writeFileSync(join(repo, ".omp", "planning-score.toml"),
					"[targets]\n" + legacy + " = 0.9\n" + (mixed ? replacement + " = 0.1\n" : ""));
				expect(() => api.loadPlanningScoreConfig(kitRoot, repo, fixture("legacy-home-" + label))).toThrow(replacement);
			});
		}
	}
}

// PLANPORT1 (ompkit-f1zn5): `planning score` finds the plan from <repo>/.omp/plan.toml and counts review rounds from review files.
function planConfigRepo(label: string, opts: { reviewFiles: boolean; config: string | null; roundCommits?: number }) {
	const repo = fixture("plan-config-" + label);
	const home = fixture("plan-config-home-" + label);
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
	};
	git(["init", "--quiet"]);
	git(["config", "user.name", "Plan Fixture"]);
	git(["config", "user.email", "plan-fixture@example.invalid"]);
	mkdirSync(join(repo, ".omp"), { recursive: true });
	mkdirSync(join(repo, ".beads"), { recursive: true });
	mkdirSync(join(repo, "docs", "stamp", "reviews"), { recursive: true });
	const planLines = Array.from({ length: 100 }, (_, i) => "line " + i);
	writeFileSync(join(repo, "docs", "stamp", "plan.md"), planLines.join("\n") + "\n");
	writeFileSync(join(repo, ".beads", "issues.jsonl"), JSON.stringify({ id: "s1", title: "Ship it", description: "Plan: docs/stamp/plan.md §1",
		acceptance_criteria: "verified", status: "open", issue_type: "task", dependencies: [] }) + "\n");
	writeFileSync(join(repo, ".omp", "planning-score.toml"), "[ci]\nmode = \"local\"\ncheck = \"true\"\nbranch = \"main\"\nreceipts = \"receipts\"\n");
	if (opts.config !== null) writeFileSync(join(repo, ".omp", "plan.toml"), opts.config);
	git(["add", "-A"]);
	git(["commit", "--quiet", "-m", "draft [test]"]);
	git(["branch", "-M", "main"]);
	if (opts.reviewFiles) {
		writeFileSync(join(repo, "docs", "stamp", "reviews", "round1-muse.md"), "R1\n");
		writeFileSync(join(repo, "docs", "stamp", "reviews", "findings.jsonl"),
			JSON.stringify({ id: "muse:C1", family: "muse", round: 1, severity: "critical" }) + "\n" +
			JSON.stringify({ id: "grok:M1", family: "grok", round: 2, severity: "minor" }) + "\n");
		git(["add", "-A"]);
		git(["commit", "--quiet", "-m", "review round 1 [test]"]);
		planLines[0] = "line 0 revised";
		writeFileSync(join(repo, "docs", "stamp", "plan.md"), planLines.join("\n") + "\n");
		writeFileSync(join(repo, "docs", "stamp", "reviews", "round2-grok.md"), "R2\n");
		writeFileSync(join(repo, "docs", "stamp", "reviews", "round2b-verify-grok.md"), "R2b\n");
		git(["add", "-A"]);
		git(["commit", "--quiet", "-m", "review round 2 [test]"]);
	}
	for (let i = 1; i <= (opts.roundCommits ?? 0); i++) git(["commit", "--quiet", "--allow-empty", "-m", "plan(stamp): review round " + i + " [test]"]);
	return { repo, home };
}
async function scoreRows(repo: string, home: string, planConfig?: string) {
	const api = await scoreApi();
	if (!api) return [];
	const result = api.runPlanningScore({ kitRoot: repoRoot, repoPath: repo, home, ...(planConfig ? { planConfig } : {}) });
	return (result.jsonl ?? []).filter((row): row is Record<string, unknown> => record(row) && row.kind === "mission");
}
const stampConfig = "[plan]\nname = \"stamp\"\npath = \"docs/stamp/plan.md\"\nreviews = \"docs/stamp/reviews\"\n";

test("PLANPORT1 plan config names the plan and review files count its rounds", async () => {
	const { repo, home } = planConfigRepo("files", { reviewFiles: true, config: stampConfig });
	const rows = await scoreRows(repo, home);
	const stamp = rows.find((row) => row.mission === "stamp");
	if (!stamp || !record(stamp.metrics)) throw new Error("plan-config mission missing: " + JSON.stringify(rows));
	expect(stamp.metrics.plan_present).toMatchObject({ value: true, status: "PASS", evidence: { plan_path: "docs/stamp/plan.md", file_exists: true, citing_beads: 1 } });
	// Files round1, round2, round2b plus findings rounds 1 and 2: three distinct rounds.
	expect(stamp.metrics.plan_rounds).toMatchObject({ value: 3, evidence: { source: "review_files", rounds: ["1", "2", "2b"], files: 3 } });
	// The commit that recorded round 2b changed 2 of 200 plan lines (1 removed + 1 added over old+new line counts).
	expect(stamp.metrics.plan_last_diff).toMatchObject({ value: 0.01, status: "PASS", evidence: { source: "review_files" } });
});

test("PLANPORT1 control: without review files, rounds come from commit subjects", async () => {
	const { repo, home } = planConfigRepo("subjects", { reviewFiles: false, config: stampConfig, roundCommits: 2 });
	const rows = await scoreRows(repo, home);
	const stamp = rows.find((row) => row.mission === "stamp");
	if (!stamp || !record(stamp.metrics)) throw new Error("plan-config mission missing");
	expect(stamp.metrics.plan_rounds).toMatchObject({ value: 2, status: "FAIL" });
	expect(record(stamp.metrics.plan_rounds) ? stamp.metrics.plan_rounds.evidence : null).toBeUndefined();
});

test("PLANPORT1 an outside plan config scores a repo without writing it; absent and escaping configs are UNKNOWN", async () => {
	const { repo, home } = planConfigRepo("override", { reviewFiles: true, config: null });
	expect(await scoreRows(repo, home)).not.toContainEqual(expect.objectContaining({ mission: "stamp" }));
	const outside = join(fixture("plan-config-outside"), "plan.toml");
	writeFileSync(outside, stampConfig);
	const stamp = (await scoreRows(repo, home, outside)).find((row) => row.mission === "stamp");
	expect(stamp).toMatchObject({ metrics: { plan_rounds: { value: 3 } } });
	const absent = await scoreRows(repo, home, join(fixture("plan-config-absent"), "plan.toml"));
	expect(absent).toEqual([expect.objectContaining({ status: "UNKNOWN", metrics: expect.objectContaining({ plan_present: expect.objectContaining({ evidence: { reason: expect.stringContaining("Plan config not found") } }) }) })]);
	writeFileSync(outside, "[plan]\nname = \"stamp\"\npath = \"../escape.md\"\n");
	const escaping = await scoreRows(repo, home, outside);
	expect(escaping).toEqual([expect.objectContaining({ status: "UNKNOWN", metrics: expect.objectContaining({ plan_present: expect.objectContaining({ evidence: { reason: expect.stringContaining("outside the repository") } }) }) })]);
});


test("A5 prose acceptance is presence, not test evidence", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const prose = { ...base.beads[0]!, description: "PLAN_demo.md " + "detail ".repeat(50), acceptance_criteria: "looks good" };
	const result = api.scorePlanningSnapshot({ ...base, beads: [prose] }, tuning);
	const quality = result.metrics.bead_self_contained;
	expect(quality.status).toBe("PASS");
	expect(quality.value).toMatchObject({ acceptance_present_share: 1 });
	expect(quality.value).not.toHaveProperty("test_share");
	expect(quality.target).not.toHaveProperty("test_share");
	const unreadable = api.scorePlanningSnapshot({ ...base, beads: null }, tuning);
	expect(unreadable.metrics.bead_self_contained.target).not.toHaveProperty("test_share");
});

test("A5 acceptance presence respects its target and excludes blank prose", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const beads = [
		{ ...base.beads[0]!, acceptance_criteria: "looks good" },
		{ ...base.beads[1]!, acceptance_criteria: " \n\t " },
	];
	const strict = { ...tuning, targets: { ...tuning.targets, bead_self_contained_acceptance_present_share: 0.75 } };
	const quality = api.scorePlanningSnapshot({ ...base, beads }, strict).metrics.bead_self_contained;
	expect(quality.value).toMatchObject({ acceptance_present_share: 0.5 });
	expect(quality.status).toBe("FAIL");
});

test("A6 build stage marks historical planning, conversion and polish metrics NOT_APPLICABLE", async () => {
	const api = await scoreApi();
	if (!api) return;
	const result = api.scorePlanningSnapshot({ ...passingSnapshot(), stage: "build" }, tuning);
	for (const name of ["plan_present", "plan_rounds", "plan_last_diff", "converted_once", "coverage_checks", "polish_rounds", "polish_last_changed", "plan_to_code_hours"])
		expect(result.metrics[name]?.status).toBe("NOT_APPLICABLE");
});

test("A7 reconcile is the one conversion event, while convert plus reconcile is two", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const reconcile = { ...base, trackerCommits: base.trackerCommits.filter((item) => !item.subject.startsWith("beads(demo): convert")).concat(commit("reconcile", "beads(demo): reconcile", now - 10 * day, { changedPaths: [".beads/issues.jsonl"] })) };
	const one = api.scorePlanningSnapshot(reconcile, tuning);
	expect(one.metrics.converted_once).toMatchObject({ value: 1, status: "PASS" });
	const two = api.scorePlanningSnapshot({ ...base, trackerCommits: [...base.trackerCommits, commit("reconcile", "beads(demo): reconcile", now - 10 * day, { changedPaths: [".beads/issues.jsonl"] })] }, tuning);
	expect(two.metrics.converted_once).toMatchObject({ value: 2, status: "FAIL" });
});

test("A8 beads doctor catches acceptance written in the description but missing from the field", async () => {
	const root = fixture("beads-project");
	const home = fixture("beads-home");
	mkdirSync(join(root, ".beads"), { recursive: true });
	const issues = [
		{ id: "bad", title: "Legacy bead", description: "## ACCEPTANCE\n- [ ] complete the live path", acceptance_criteria: "", status: "open" },
		{ id: "quiet", title: "Field is canonical", description: "Context mentions acceptance but has no section", acceptance_criteria: "- [ ] outcome is present", status: "open" },
	];
	writeFileSync(join(root, ".beads", "issues.jsonl"), issues.map((issue) => JSON.stringify(issue)).join("\n") + "\n");
	const report = await diagnose({ root, home, project: root, scope: "beads" });
	const finding = report.find((item) => item.component === "beads");
	expect(finding?.status).toBe("FAIL");
	expect(finding?.evidence?.missing_acceptance).toEqual([{ id: "bad", title: "Legacy bead" }]);
});

const dupA = { id: "dup-a", title: "Add deep flag to acfs doctor", description: "Context part of the enhanced doctor epic. What to do add a deep flag that runs functional tests beyond binary existence checks parsing the flag alongside json output. Files scripts lib doctor. Rationale default doctor stays fast while deep mode verifies auth and database connectivity end to end.", acceptance_criteria: "- [ ] deep flag parsed\n- [ ] default doctor unchanged\n- [ ] deep runs functional tests", status: "open" };
const dupB = { id: "dup-b", title: "Add deep flag to acfs doctor", description: "Context part of the enhanced doctor epic. What to do add a deep flag that runs functional tests beyond binary existence checks parsing the flag together with json output. Files scripts lib doctor. Rationale default doctor stays fast while deep mode verifies auth and database connectivity end to end. Document the flag in the cheatsheet.", acceptance_criteria: "- [ ] deep flag parsed\n- [ ] default doctor unchanged\n- [ ] deep runs functional tests", status: "open" };
const distinctA = { id: "distinct-a", title: "Rotate release signing keys", description: "Ceremony generates a fresh minisign keypair inside the hardware vault. Attestation reissues signatures across archived artifacts while custodians witness rotation. Old keys enter revocation quarantine after backups confirm restoration drills.", acceptance_criteria: "- [ ] fresh keypair generated\n- [ ] archives re-signed", status: "open" };
const distinctB = { id: "distinct-b", title: "Translate onboarding tutorial to Spanish", description: "Linguists rewrite the interactive lessons preserving command examples verbatim. Native speakers review idioms and screenshots refresh against the translated interface before publishing the localized learning path.", acceptance_criteria: "- [ ] lessons translated\n- [ ] native review complete", status: "open" };

function writeBeadProject(label: string, issues: unknown[]): { root: string; home: string } {
	const root = fixture(label);
	const home = fixture(label + "-home");
	mkdirSync(join(root, ".beads"), { recursive: true });
	writeFileSync(join(root, ".beads", "issues.jsonl"), (issues as Record<string, unknown>[]).map((issue) => JSON.stringify(issue)).join("\n") + "\n");
	return { root, home };
}

test("A9 doctor and planning score CLI share configured bead breadth", () => {
	const { root, home } = writeBeadProject("bead-breadth-cli", []);
	const cli = join(repoRoot, "src", "cli.ts");
	mkdirSync(join(root, ".omp"), { recursive: true });
	const issue = (id: string, paths: readonly string[]) => {
		let acceptance = "- [ ] Outcome is verified";
		for (const path of paths) acceptance += " `" + path + "`";
		return {
			id, title: id, description: "Acceptance defines the affected file scope.", acceptance_criteria: acceptance,
			status: "open", issue_type: "task", labels: ["mission:demo"], dependencies: [],
		};
	};
	const issues = [
		issue("over-files", ["src/payments/a.ts", "src/payments/b.ts", "src/payments/c.ts", "src/payments/d.ts", "src/payments/e.ts"]),
		issue("over-components", ["src/capture/a.ts", "src/settlement/a.ts", "src/ledger/a.ts"]),
		issue("one-component", ["src/shared/start.ts", "src/shared/finish.ts"]),
		issue("at-limit", ["src/reports/a.ts", "src/reports/b.ts", "src/export/a.ts", "src/export/b.ts"]),
		issue("repeated", ["src/repeated/one.ts", "src/repeated/one.ts", "src/repeated/one.ts"]),
		issue("missing", []),
		issue("unparseable", ["src/unparseable"]),
	];
	const lines: string[] = [];
	for (const item of issues) lines.push(JSON.stringify(item));
	writeFileSync(join(root, ".beads", "issues.jsonl"), lines.join("\n") + "\n");
	const writeConfig = (maxFiles: number, maxComponents: number) => {
		const config = `[targets]\nbead_breadth_max_files = ${maxFiles}\nbead_breadth_max_components = ${maxComponents}\n` +
			"[missions.demo]\nstage = \"build\"\n[ci]\nmode = \"local\"\ncheck = \"true\"\nbranch = \"main\"\nreceipts = \"receipts\"\n";
		writeFileSync(join(root, ".omp", "planning-score.toml"), config);
	};
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		expect(result.exitCode, result.stderr.toString()).toBe(0);
	};
	git(["init", "--quiet"]);
	git(["config", "user.name", "Bead Fixture"]);
	git(["config", "user.email", "bead-fixture@example.invalid"]);
	git(["commit", "--allow-empty", "-m", "fixture [test]"]);
	git(["branch", "-M", "main"]);
	const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin", XDG_STATE_HOME: join(home, "state"), TMPDIR: scratch };
	for (const key of ["BEADS_DB", "OMP", "OMP_BIN", "OMP_PATH", "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR"]) delete env[key];
	const doctorBreadth = () => {
		const result = Bun.spawnSync([process.execPath, cli, "doctor", "--scope", "beads", "--project", root, "--json"], {
			cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		expect(result.exitCode, result.stderr.toString()).not.toBe(null);
		expect(result.stderr.toString()).toBe("");
		const parsed: unknown = JSON.parse(result.stdout.toString());
		if (!record(parsed) || !record(parsed.data) || !Array.isArray(parsed.data.findings)) return null;
		const findings = parsed.data.findings as unknown[];
		for (const finding of findings) if (record(finding) && finding.component === "bead_breadth") return finding;
		return null;
	};
	const planningMission = () => {
		const result = Bun.spawnSync([process.execPath, cli, "planning", "score", "--repo", root, "--json"], {
			cwd: repoRoot, env, stdout: "pipe", stderr: "pipe", timeout: 10_000,
		});
		expect(result.exitCode, result.stderr.toString()).not.toBe(null);
		const rows: Record<string, unknown>[] = [];
		for (const line of result.stdout.toString().trim().split("\n")) {
			if (!line.trim()) continue;
			const parsed: unknown = JSON.parse(line);
			if (record(parsed) && record(parsed.data)) rows.push(parsed.data);
		}
		for (const row of rows) if (row.kind === "mission") return row;
		return null;
	};
	const breadthMetric = (mission: Record<string, unknown> | null) => {
		if (!mission || !record(mission.metrics)) return null;
		const breadth = mission.metrics.bead_breadth;
		return record(breadth) ? breadth : null;
	};
	writeConfig(4, 2);
	const diagnosed = doctorBreadth();
	const scored = breadthMetric(planningMission());
	if (!diagnosed || !record(diagnosed.evidence) || !scored) throw new Error("A9 CLI output omitted bead breadth evidence");
	const diagnosedEvidence = diagnosed.evidence;
	const scoredEvidence = record(scored.evidence) ? scored.evidence : null;
	const oversizedIds = ["over-files", "over-components"];
	expect(diagnosed.status).toBe("FAIL");
	expect(diagnosedEvidence.oversized_ids).toEqual(oversizedIds);
	expect(diagnosedEvidence.unknown_ids).toEqual(["missing", "unparseable"]);
	expect(scored.status).toBe("FAIL");
	if (!record(scored.value) || !scoredEvidence) throw new Error("A9 planning score omitted breadth evidence");
	expect(scored.value.oversized_ids).toEqual(oversizedIds);
	expect(scoredEvidence.oversized_ids).toEqual(oversizedIds);
	expect(scoredEvidence.unknown_ids).toEqual(["missing", "unparseable"]);
	const details = diagnosedEvidence.oversized_beads;
	if (!Array.isArray(details)) throw new Error("A9 doctor omitted measured spans");
	let filesSuggestion = "";
	let componentsSuggestion = "";
	let fileCount = 0;
	let componentCount = 0;
	for (const item of details) {
		if (!record(item)) continue;
		if (item.id === "over-files") {
			filesSuggestion = typeof item.split_suggestion === "string" ? item.split_suggestion : "";
			fileCount = typeof item.file_count === "number" ? item.file_count : 0;
			componentCount = typeof item.component_count === "number" ? item.component_count : 0;
		}
		if (item.id === "over-components" && typeof item.split_suggestion === "string") componentsSuggestion = item.split_suggestion;
	}
	expect(fileCount).toBe(5);
	expect(componentCount).toBe(1);
	expect(filesSuggestion).toContain("src/payments");
	expect(componentsSuggestion).toContain("src/capture");
	writeConfig(5, 3);
	const relaxedDoctor = doctorBreadth();
	const relaxedMetric = breadthMetric(planningMission());
	if (!relaxedDoctor || !record(relaxedDoctor.evidence) || !relaxedMetric || !record(relaxedMetric.evidence))
		throw new Error("A9 relaxed CLI output omitted bead breadth evidence");
	expect(relaxedDoctor.status).toBe("UNVERIFIED");
	expect(relaxedDoctor.evidence.oversized_ids).toEqual([]);
	expect(relaxedDoctor.evidence.unknown_ids).toEqual(["missing", "unparseable"]);
	expect(relaxedMetric.status).toBe("UNKNOWN");
	expect(relaxedMetric.value).toBeNull();
	expect(relaxedMetric.evidence.oversized_ids).toEqual([]);
	expect(relaxedMetric.evidence.unknown_ids).toEqual(["missing", "unparseable"]);
}, 30_000);



test("FLY1 duplicates: planted near-identical pair is reported, distinct pair is not", async () => {
	const { root, home } = writeBeadProject("beads-dedup", [dupA, dupB, distinctA, distinctB]);
	const report = await diagnose({ root, home, project: root, scope: "beads" });
	const finding = report.find((item) => item.component === "beads" && item.evidence !== undefined && "duplicate_pairs" in item.evidence);
	expect(finding?.status).toBe("FAIL");
	const pairs = (finding?.evidence?.duplicate_pairs ?? []) as Array<{ a_id: string; b_id: string; similarity: number }>;
	expect(pairs.map((pair) => [pair.a_id, pair.b_id].sort().join("+"))).toContain("dup-a+dup-b");
	for (const pair of pairs) expect([pair.a_id, pair.b_id].sort().join("+")).not.toMatch(/distinct/);
});

test("FLY1 duplicates: distinct beads produce no duplicate report", async () => {
	const { root, home } = writeBeadProject("beads-dedup-clean", [distinctA, distinctB]);
	const report = await diagnose({ root, home, project: root, scope: "beads" });
	expect(report.find((item) => item.component === "beads" && item.evidence !== undefined && "duplicate_pairs" in item.evidence)?.status).toBe("OK");
});
