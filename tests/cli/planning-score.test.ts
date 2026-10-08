import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";
import { diagnose } from "../../src/diagnostics.ts";
import { renderOutput, type PresentationResult } from "../../src/output.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "planning-score-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=planning-score-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

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
		bead_self_contained_test_share: 0.4, bead_self_contained_deps_per_bead: 1, plan_to_code_hours: 24,
		plan_ship_ratio_7d: 2,
	},
	weights: { plan_present: 1, plan_rounds: 1, plan_last_diff: 1, converted_once: 1, coverage_checks: 1,
		polish_rounds: 1, polish_last_changed: 1, bead_self_contained: 1, plan_to_code_hours: 1, plan_ship_ratio_7d: 1, main_green: 1 },
};
const now = 1_800_000_000;
const day = 86_400;
function commit(sha: string, subject: string, timestamp: number, extra: Record<string, unknown> = {}) {
	return { sha, subject, timestamp, ...extra };
}
function bead(id: string, extra: Record<string, unknown> = {}) {
	return { id, title: "Mission item", description: "Plan: PLAN_demo.md section 1. " + "detail ".repeat(55) + "Names tests.",
		acceptance_criteria: "Test outcomes are verified.", status: "open", dependencies: [{ depends_on_id: "root", type: "blocks" }], ...extra };
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

test("planning score is a visible read command with repo and fleet modes", () => {
	const planning = COMMANDS.find((command) => command.name === "planning");
	const score = planning?.subcommands?.find((command) => command.name === "score");
	expect(score).toMatchObject({ usage: "planning score [--repo PATH] [--fleet] [--json]" });
	expect(score?.flags.map((flag) => flag.name)).toContain("--repo");
	expect(score?.flags.map((flag) => flag.name)).toContain("--fleet");
	const doctor = COMMANDS.find((command) => command.name === "doctor");
	expect(doctor?.flags.some((flag) => flag.name === "--scope" && (flag.value ?? "").split("|").includes("beads"))).toBe(true);
});

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
	expect(Object.keys(result.metrics)).toHaveLength(11);
});

test("fleet weighted score includes each mission metric instance", async () => {
	const api = await scoreApi();
	if (!api) return;
	const passing = api.scorePlanningSnapshot(passingSnapshot(), tuning);
	const failing = api.scorePlanningSnapshot({ ...passingSnapshot(), mission: "broken", planExists: false }, tuning);
	const overall = api.scorePlanningFleet([passing, failing], tuning);
	expect(overall).toMatchObject({ status: "FAIL", weighted_score: 72.73 });
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
		{ name: "main_green", snapshot: { ...base, ci: { mode: "hosted", ghConclusion: null } } },
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


test("A5 filled acceptance_criteria counts as named tests", async () => {
	const api = await scoreApi();
	if (!api) return;
	const base = passingSnapshot();
	const bead = { ...base.beads[0]!, description: "PLAN_demo.md " + "detail ".repeat(50), acceptance_criteria: "A concrete acceptance outcome is recorded." };
	const result = api.scorePlanningSnapshot({ ...base, beads: [bead] }, tuning);
	expect(result.metrics.bead_self_contained.value.test_share).toBe(1);
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
