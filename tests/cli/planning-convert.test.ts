// Coverage: src/commands.ts, src/cli.ts, src/kitlib/tmp.ts, src/kitlib/run.ts, scripts/bead_lint.py
import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/commands.ts";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { run as runBounded } from "../../src/kitlib/run.ts";
import { planningFixture, type ApplyPlanItem } from "./planning-convert.helpers.ts";
afterAll(cleanupAllOwnedTmp);
const { repoRoot, scratch, validPlan, negativePlan, childEnv, isolatedTest, runCli, nativeOutput, nativeJson, issueRows, median, planSource, writePlan, initializeTracker, createNativeIssue, showNativeIssue, applyResult, applyArgs, writeAmendPlan, amendAcceptanceV1, amendAcceptanceV2, concurrentWriteFixture } = planningFixture();

isolatedTest("planning dry-run skips the seat shim only for its isolated database; apply keeps actor admission", async () => {
	const trackerRoot = join(scratch, "shim-live-tracker");
	initializeTracker(trackerRoot);
	createNativeIssue(trackerRoot, "Untouched live issue");
	const liveDb = join(trackerRoot, ".beads", "beads.db");
	const before = readFileSync(liveDb);
	const beforeMtime = statSync(liveDb).mtimeMs;
	const shimBin = join(scratch, "seat-shim-bin");
	mkdirSync(shimBin);
	symlinkSync(join(repoRoot, "scripts", "br-shim.sh"), join(shimBin, "br"));
	const env = {
		PATH: `${shimBin}:${childEnv.PATH ?? ""}`,
		AGENT_NAME: "RealConversionSeat",
		BEADS_DB: liveDb,
	};
	const dbDir = join(scratch, "shim-dry-db");
	const dry = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"], env);
	expect(dry.exitCode, dry.stdout + dry.stderr).toBe(0);
	expect(JSON.parse(dry.stdout).data).toMatchObject({
		overall: "CLEAN", beads_created: 3, total_beads_created: 4,
		database_path: join(dbDir, ".beads", "beads.db"),
	});
	expect(readFileSync(liveDb)).toEqual(before);
	expect(statSync(liveDb).mtimeMs).toBe(beforeMtime);

	const apply = await runCli(applyArgs(validPlan, trackerRoot, "core8", "DifferentActor"), env);
	expect(apply.exitCode).not.toBe(0);
	expect(apply.stdout + apply.stderr).toContain("BR_SHIM_ACTOR_MISMATCH");
	expect(readFileSync(liveDb)).toEqual(before);
	expect(statSync(liveDb).mtimeMs).toBe(beforeMtime);
});

isolatedTest("planning convert apply preserves prior acceptance while grouping repeated contributions", async () => {
	const trackerRoot = join(scratch, "apply-grouped-tracker");
	initializeTracker(trackerRoot);
	const parentId = createNativeIssue(trackerRoot, "Existing parent", { externalRef: "core8", type: "epic" });
	const unrelatedId = createNativeIssue(trackerRoot, "Unrelated dependency");
	const firstId = createNativeIssue(trackerRoot, "Existing target", {
		externalRef: "preserved:external-ref", parent: parentId, acceptance: "- [ ] Preserve this prior acceptance.",
	});
	const secondId = createNativeIssue(trackerRoot, "Second target", { acceptance: "- [ ] Keep second prior criterion." });
	nativeOutput(["dep", "add", firstId, unrelatedId], trackerRoot);
	const plan = writePlan("apply-grouped", [
		{ slug: "first-a", existing: firstId },
		{ slug: "first-b", existing: firstId },
		{ slug: "first-c", existing: firstId },
		{ slug: "first-d", existing: firstId },
		{ slug: "second-a", existing: secondId },
		{ slug: "second-b", existing: secondId },
	]);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).toBe(0);
	const report = applyResult(result);
	expect(report.overall).toBe("CLEAN");
	expect(report.amended_targets).toHaveLength(2);
	expect(report.amended_targets.find((target: { id: string }) => target.id === firstId).slugs).toEqual(["first-a", "first-b", "first-c", "first-d"]);
	expect(report.amended_targets.find((target: { id: string }) => target.id === secondId).slugs).toEqual(["second-a", "second-b"]);

	const first = showNativeIssue(trackerRoot, firstId);
	expect(first.acceptance_criteria).toContain("Preserve this prior acceptance.");
	for (const slug of ["first-a", "first-b", "first-c", "first-d"])
		expect(first.acceptance_criteria).toContain(slug + " contributes its positive acceptance criterion.");
	expect(first.external_ref).toBe("preserved:external-ref");
	expect(first.parent).toBe(parentId);
	expect(JSON.stringify(first.dependencies)).toContain(unrelatedId);
	expect(first.notes).toContain("core8:first-a");
	expect(first.notes).toContain("core8:first-d");
});

isolatedTest("planning convert apply second run creates no duplicate issues, notes, acceptance, or edges", async () => {
	const trackerRoot = join(scratch, "apply-idempotent-tracker");
	initializeTracker(trackerRoot);
	const existingId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [ ] Keep this criterion." });
	const plan = writePlan("apply-idempotent", [
		{ slug: "existing-target", existing: existingId, dependsOn: ["new-target"] },
		{ slug: "new-target", existing: "(new)" },
	]);

	const first = await runCli(applyArgs(plan, trackerRoot));
	expect(first.exitCode).toBe(0);
	const firstReport = applyResult(first);
	expect(firstReport.writes_landed.length).toBeGreaterThan(0);
	const rowsAfterFirst = issueRows(trackerRoot);
	const created = rowsAfterFirst.filter((row) => row.external_ref === "core8:new-target");
	expect(created).toHaveLength(1);

	const second = await runCli(applyArgs(plan, trackerRoot));
	expect(second.exitCode).toBe(0);
	const secondReport = applyResult(second);
	expect(secondReport.overall).toBe("CLEAN");
	expect(secondReport.writes_landed).toEqual([]);
	const rowsAfterSecond = issueRows(trackerRoot);
	expect(rowsAfterSecond).toHaveLength(rowsAfterFirst.length);
	expect(rowsAfterSecond.filter((row) => row.external_ref === "core8:new-target")).toHaveLength(1);
	const updated = showNativeIssue(trackerRoot, existingId);
	expect(String(updated.acceptance_criteria).split("existing-target contributes its positive acceptance criterion").length - 1).toBe(1);
	expect(updated.notes).toBe("core8:existing-target");
	const dependencies = JSON.stringify(nativeJson(["dep", "list", existingId], trackerRoot));
	expect(dependencies.split(created[0]!.id).length - 1).toBe(1);
});
isolatedTest("planning convert refuses a changed acceptance under an existing token with STALE_ACCEPTANCE", async () => {
	const trackerRoot = join(scratch, "apply-stale-tracker");
	initializeTracker(trackerRoot);
	const targetId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [x] Keep this verified criterion." });
	const first = await runCli(applyArgs(writeAmendPlan("stale-v1", "amend-target", targetId, amendAcceptanceV1), trackerRoot));
	expect(first.exitCode).toBe(0);
	expect(applyResult(first).overall).toBe("CLEAN");
	const before = showNativeIssue(trackerRoot, targetId);
	expect(String(before.notes)).toContain("core8:amend-target");
	const second = await runCli(applyArgs(writeAmendPlan("stale-v2", "amend-target", targetId, amendAcceptanceV2), trackerRoot));
	expect(second.exitCode).not.toBe(0);
	const report = applyResult(second);
	expect(report.overall).toBe("REFUSED");
	const stale = report.amended_targets.find((target: { id: string }) => target.id === targetId);
	expect(stale.status).toBe("STALE_ACCEPTANCE");
	expect(stale.slugs).toEqual(["amend-target"]);
	expect(JSON.stringify(stale.missing_acceptance)).toContain("changed acceptance criterion");
	expect(JSON.stringify(stale.stored_acceptance)).toContain("Keep this verified criterion");
	expect(String(report.apply_preflight_error)).toContain("STALE_ACCEPTANCE");
	expect(String(report.apply_preflight_error)).toContain("amend-target");
	expect(showNativeIssue(trackerRoot, targetId)).toEqual(before);
	expect(report.writes_landed.filter((write: { kind: string }) => write.kind === "AMENDED")).toEqual([]);
	expect(String(report.text)).toContain("STALE_ACCEPTANCE");
});

isolatedTest("planning convert --amend-acceptance appends changed boxes under the revision gate", async () => {
	const trackerRoot = join(scratch, "apply-amend-tracker");
	initializeTracker(trackerRoot);
	const targetId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [ ] Keep this manual criterion." });
	const first = await runCli(applyArgs(writeAmendPlan("amend-v1", "amend-target", targetId, amendAcceptanceV1), trackerRoot));
	expect(first.exitCode).toBe(0);
	const second = await runCli(applyArgs(writeAmendPlan("amend-v2", "amend-target", targetId, amendAcceptanceV2), trackerRoot, "core8", "PlanningWriter", ["--amend-acceptance"]));
	expect(second.exitCode).toBe(0);
	const report = applyResult(second);
	expect(report.overall).toBe("CLEAN");
	const amended = report.amended_targets.find((target: { id: string }) => target.id === targetId);
	expect(amended.status).toBe("AMENDED");
	expect(JSON.stringify(amended.acceptance_added)).toContain("changed acceptance criterion");
	const after = showNativeIssue(trackerRoot, targetId);
	expect(String(after.acceptance_criteria)).toContain("Keep this manual criterion.");
	expect(String(after.acceptance_criteria)).toContain("changed acceptance criterion");
	expect(after.notes).toBe("core8:amend-target");
	expect(JSON.stringify(amended.superseded_acceptance)).toContain("Keep this manual criterion.");
	const third = await runCli(applyArgs(writeAmendPlan("amend-v3", "amend-target", targetId, amendAcceptanceV2), trackerRoot, "core8", "PlanningWriter", ["--amend-acceptance"]));
	expect(third.exitCode).toBe(0);
	const thirdReport = applyResult(third);
	expect(thirdReport.overall).toBe("CLEAN");
	expect(thirdReport.amended_targets.find((target: { id: string }) => target.id === targetId).status).toBe("UNCHANGED");
	expect(thirdReport.writes_landed).toEqual([]);
	const final = showNativeIssue(trackerRoot, targetId);
	expect(String(final.acceptance_criteria).split("changed acceptance criterion").length - 1).toBe(1);
});

isolatedTest("planning convert guarded amendment refuses a concurrent target change", async () => {
	const trackerRoot = join(scratch, "apply-concurrent-tracker");
	initializeTracker(trackerRoot);
	const targetId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [ ] Keep this criterion." });
	const first = await runCli(applyArgs(writeAmendPlan("concurrent-v1", "amend-target", targetId, amendAcceptanceV1), trackerRoot));
	expect(first.exitCode).toBe(0);
	const second = await runCli(
		applyArgs(writeAmendPlan("concurrent-v2", "amend-target", targetId, amendAcceptanceV2), trackerRoot, "core8", "PlanningWriter", ["--amend-acceptance"]),
		concurrentWriteFixture(trackerRoot, targetId),
	);
	expect(second.exitCode).not.toBe(0);
	const report = applyResult(second);
	expect(report.overall).toBe("FINDINGS");
	expect(report.apply_failure.step).toBe("amend-" + targetId);
	const after = showNativeIssue(trackerRoot, targetId);
	expect(String(after.notes)).toContain("concurrent-probe");
	expect(String(after.acceptance_criteria)).not.toContain("changed acceptance criterion");
});

isolatedTest("planning convert refuses --amend-acceptance without --apply", async () => {
	const dbDir = join(scratch, "amend-flag-db");
	const result = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir, "--amend-acceptance", "--json"]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
});

isolatedTest("planning convert apply reports foreign targets without writing them", async () => {
	const trackerRoot = join(scratch, "apply-foreign-tracker");
	initializeTracker(trackerRoot);
	const plan = writePlan("apply-foreign", [{ slug: "foreign-target", existing: "uds-81kq" }]);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).toBe(0);
	const report = applyResult(result);
	expect(report.foreign_targets).toEqual([{ status: "FOREIGN", id: "uds-81kq", slug: "foreign-target" }]);
	expect(report.writes_landed).toEqual([]);
	expect(issueRows(trackerRoot)).toHaveLength(0);
});

// ompkit-fp72.135.3.51: a finished bead stays in the plan; it must never block later intake,
// and it is never written (no amendment, no reopen, no edge from it).
function closeNative(trackerRoot: string, id: string): void {
	nativeOutput(["close", id, "--reason", "fixture: finished before this plan was applied"], trackerRoot);
}

isolatedTest("apply treats a closed reused target it would not change as satisfied and applies the rest", async () => {
	const trackerRoot = join(scratch, "apply-terminal-reused");
	initializeTracker(trackerRoot);
	const epicId = createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
	const doneId = createNativeIssue(trackerRoot, "Done target", { externalRef: "core8:done-item", parent: epicId });
	closeNative(trackerRoot, doneId);
	const plan = writePlan("apply-terminal-reused", [
		{ slug: "done-item", existing: "(new)" },
		{ slug: "next-item", existing: "(new)", dependsOn: ["done-item"] },
	]);
	const before = showNativeIssue(trackerRoot, doneId);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).toBe(0);
	const report = applyResult(result);
	expect(report.terminal_targets).toEqual([{ slug: "done-item", id: doneId, status: "SATISFIED_TERMINAL" }]);
	const next = report.created_items.find((item: { slug: string }) => item.slug === "next-item");
	expect(next).toBeDefined();
	expect(report.dependency_edges).toContainEqual({ slug: "next-item", target: "done-item", status: "ADDED", issue_id: next.id, depends_on_id: doneId });
	const after = showNativeIssue(trackerRoot, doneId);
	for (const field of ["status", "acceptance_criteria", "notes", "description", "closed_at"]) expect(after[field]).toEqual(before[field]);
});

isolatedTest("apply never adds a dependency from a closed target and reports the edge SKIPPED_TERMINAL", async () => {
	const trackerRoot = join(scratch, "apply-terminal-source-edge");
	initializeTracker(trackerRoot);
	const epicId = createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
	const doneId = createNativeIssue(trackerRoot, "Done source", { externalRef: "core8:done-source", parent: epicId });
	closeNative(trackerRoot, doneId);
	const plan = writePlan("apply-terminal-source-edge", [
		{ slug: "done-source", existing: "(new)", dependsOn: ["later-item"] },
		{ slug: "later-item", existing: "(new)" },
	]);
	const before = showNativeIssue(trackerRoot, doneId);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).toBe(0);
	const report = applyResult(result);
	const later = report.created_items.find((item: { slug: string }) => item.slug === "later-item");
	expect(later).toBeDefined();
	expect(report.dependency_edges).toContainEqual({ slug: "done-source", target: "later-item", status: "SKIPPED_TERMINAL", issue_id: doneId, depends_on_id: later.id });
	const after = showNativeIssue(trackerRoot, doneId);
	expect(after.status).toBe("closed");
	expect(after.dependency_count).toEqual(before.dependency_count);
	expect(after.dependencies).toEqual(before.dependencies);
});

isolatedTest("apply refuses to amend a closed existing target and writes nothing", async () => {
	const trackerRoot = join(scratch, "apply-terminal-amend");
	initializeTracker(trackerRoot);
	const doneId = createNativeIssue(trackerRoot, "Closed existing target");
	closeNative(trackerRoot, doneId);
	const plan = writePlan("apply-terminal-amend", [
		{ slug: "closed-existing", existing: doneId },
		{ slug: "fresh-item", existing: "(new)" },
	]);
	const before = showNativeIssue(trackerRoot, doneId);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).not.toBe(0);
	const report = applyResult(result);
	expect(String(report.apply_preflight_error)).toContain(doneId);
	expect(String(report.apply_preflight_error)).toContain("core8:closed-existing");
	expect(report.writes_landed).toEqual([]);
	expect(showNativeIssue(trackerRoot, doneId)).toEqual(before);
	// issueRows lists open issues only: nothing was created (not even a mission epic), and the target stays closed.
	expect(issueRows(trackerRoot)).toEqual([]);
});

isolatedTest("apply skips a closed existing target whose plan contribution is already recorded", async () => {
	const trackerRoot = join(scratch, "apply-terminal-satisfied");
	initializeTracker(trackerRoot);
	const targetId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [ ] Keep this criterion." });
	const plan = writePlan("apply-terminal-satisfied", [{ slug: "satisfied-item", existing: targetId }]);
	const first = await runCli(applyArgs(plan, trackerRoot));
	expect(first.exitCode).toBe(0);
	closeNative(trackerRoot, targetId);
	const before = showNativeIssue(trackerRoot, targetId);

	const second = await runCli(applyArgs(plan, trackerRoot));
	expect(second.exitCode).toBe(0);
	const report = applyResult(second);
	expect(report.terminal_targets).toEqual([{ slug: "satisfied-item", id: targetId, status: "SATISFIED_TERMINAL" }]);
	expect(report.writes_landed).toEqual([]);
	expect(showNativeIssue(trackerRoot, targetId)).toEqual(before);
});

isolatedTest("apply refuses the same closed fixture once its plan acceptance is edited and writes nothing", async () => {
	const trackerRoot = join(scratch, "apply-terminal-edited");
	initializeTracker(trackerRoot);
	const targetId = createNativeIssue(trackerRoot, "Existing target", { acceptance: "- [ ] Keep this criterion." });
	const plan = writePlan("apply-terminal-edited", [
		{ slug: "edited-item", existing: targetId },
		{ slug: "fresh-after-edit", existing: "(new)" },
	]);
	const first = await runCli(applyArgs(plan, trackerRoot));
	expect(first.exitCode).toBe(0);
	closeNative(trackerRoot, targetId);
	const source = readFileSync(plan, "utf8");
	const edited = source.replace("- [a] Planted negative: edited-item is not applied twice.",
		"- [a] Planted negative: edited-item is not applied twice.\n- [a] edited-item gains a criterion after it closed.");
	expect(edited).not.toBe(source);
	writeFileSync(plan, edited);
	const before = showNativeIssue(trackerRoot, targetId);
	const openBefore = issueRows(trackerRoot).map((row) => row.id).sort();

	const second = await runCli(applyArgs(plan, trackerRoot));
	expect(second.exitCode).not.toBe(0);
	const report = applyResult(second);
	expect(String(report.apply_preflight_error)).toContain(targetId);
	expect(String(report.apply_preflight_error)).toContain("core8:edited-item");
	expect(String(report.apply_preflight_error)).toContain("gains a criterion after it closed");
	expect(report.writes_landed).toEqual([]);
	expect(showNativeIssue(trackerRoot, targetId)).toEqual(before);
	expect(issueRows(trackerRoot).map((row) => row.id).sort()).toEqual(openBefore);
});

isolatedTest("apply never reopens or writes a tombstoned target", async () => {
	const trackerRoot = join(scratch, "apply-terminal-tombstone");
	initializeTracker(trackerRoot);
	const epicId = createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
	const goneId = createNativeIssue(trackerRoot, "Deleted target", { externalRef: "core8:gone-item", parent: epicId });
	// --force: a child of an epic otherwise returns a preview and is NOT deleted (blocked_dependents).
	nativeOutput(["delete", goneId, "--reason", "fixture: deleted before this plan was applied", "--force"], trackerRoot);
	const before = showNativeIssue(trackerRoot, goneId);
	expect(before.status).toBe("tombstone");
	const plan = writePlan("apply-terminal-tombstone", [{ slug: "gone-item", existing: "(new)" }]);

	await runCli(applyArgs(plan, trackerRoot));
	// list --all omits tombstones, so read the deleted bead itself: every field is unchanged
	// (status, acceptance, notes, dependencies, updated_at), so it was neither reopened nor written.
	expect(showNativeIssue(trackerRoot, goneId)).toEqual(before);
});

isolatedTest("planning convert apply preflights every block before writing any target", async () => {
	const trackerRoot = join(scratch, "apply-preflight-tracker");
	initializeTracker(trackerRoot);
	const plan = writePlan("apply-preflight", [{ slug: "valid-new", existing: "(new)" }]);
	writeFileSync(plan, readFileSync(plan, "utf8") + [
		"",
		"```text",
		"### malformed-item — Malformed",
		"type: task priority: 1",
		"labels: plan:core8, mission:core8, test:planning-convert",
		"depends-on: (none)",
		"existing: (new)",
		"discovered-from: planning-convert-test",
		"WHAT: (a) This block has incomplete acceptance.",
		"WHY: It must refuse before creating the valid target.",
		"ACCEPTANCE:",
		"- [a] Only a positive criterion.",
		"NO-CLAIM: Planted negative is missing.",
		"```",
	].join("\n"));

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).not.toBe(0);
	const report = applyResult(result);
	expect(report.overall).toBe("REFUSED");
	expect(report.writes_landed).toEqual([]);
	expect(issueRows(trackerRoot)).toHaveLength(0);
});


isolatedTest("planning convert apply refuses a cycle introduced by the merged tracker graph before writes", async () => {
	const trackerRoot = join(scratch, "apply-cycle-tracker");
	initializeTracker(trackerRoot);
	const parentId = createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
	const existingId = createNativeIssue(trackerRoot, "Existing target", { parent: parentId, acceptance: "- [ ] Keep this criterion." });
	const reusedId = createNativeIssue(trackerRoot, "Previously created target", {
		externalRef: "core8:new-target", parent: parentId,
	});
	nativeOutput(["dep", "add", reusedId, existingId], trackerRoot);
	const plan = writePlan("apply-merged-cycle", [
		{ slug: "existing-target", existing: existingId, dependsOn: ["new-target"] },
		{ slug: "new-target", existing: "(new)" },
	]);
	const beforeExisting = showNativeIssue(trackerRoot, existingId);
	const beforeReused = showNativeIssue(trackerRoot, reusedId);

	const result = await runCli(applyArgs(plan, trackerRoot));
	expect(result.exitCode).not.toBe(0);
	const report = applyResult(result);
	expect(report.overall).toBe("REFUSED");
	expect(report.writes_landed).toEqual([]);
	expect(showNativeIssue(trackerRoot, existingId)).toEqual(beforeExisting);
	expect(showNativeIssue(trackerRoot, reusedId)).toEqual(beforeReused);
});

isolatedTest("planning convert apply creates new targets beneath one core8 epic and reports the foreign target", async () => {
	const trackerRoot = join(scratch, "apply-new-tracker");
	initializeTracker(trackerRoot);
	const result = await runCli(applyArgs(validPlan, trackerRoot));
	expect(result.exitCode).toBe(0);
	const report = applyResult(result);
	expect(report.overall).toBe("CLEAN");
	expect(report.foreign_targets).toEqual([{ status: "FOREIGN", id: "example.tracker.42", slug: "child-bug" }]);
	const rows = issueRows(trackerRoot);
	expect(rows.filter((row) => row.external_ref === "core8")).toHaveLength(1);
	expect(rows.filter((row) => row.external_ref?.startsWith("core8:"))).toHaveLength(2);
	expect(rows.some((row) => row.external_ref === "core8:child-bug")).toBe(false);
	const created = report.created_items as Array<{ id: string; slug: string }>;
	expect(created).toHaveLength(2);
	for (const item of created) expect(showNativeIssue(trackerRoot, item.id).parent).toBe(report.parent_epic_id);
	const plannedEdges = report.dependency_edges as Array<{ status: string; slug: string; target: string }>;
	expect(plannedEdges.every((edge) => edge.status !== "ADDED" || (edge.slug !== "child-bug" && edge.target !== "child-bug"))).toBe(true);
});


isolatedTest("planning convert is a public dry-run and apply command with explicit mode flags", () => {
	const planning = COMMANDS.find((command) => command.name === "planning");
	const convert = planning?.subcommands?.find((command) => command.name === "convert");
	expect(convert?.usage).toBe("planning convert --plan PATH --mission M (--dry-run --db DIR | --apply --tracker-root DIR --actor ACTOR) [--yes] [--amend-acceptance] [--json]");
	expect(convert?.flags.map((flag) => flag.name)).toEqual(["--plan", "--mission", "--dry-run", "--db", "--apply", "--tracker-root", "--actor", "--yes", "--amend-acceptance"]);
	expect(convert?.mutation).toBe(true);
});

isolatedTest("valid plan creates native parented beads and refuses a duplicate database", async () => {
	const dbDir = join(scratch, "valid-db");
	const first = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(first.exitCode).toBe(0);
	const report = JSON.parse(first.stdout).data;
	expect(report).toMatchObject({ kind: "planning-convert", overall: "CLEAN", items_parsed: 3, beads_created: 3, total_beads_created: 4 });
	expect(report.unparseable_blocks).toEqual([]);
	expect(report.dependency_cycles).toEqual([]);
	expect(report.uncovered_what_letters).toEqual([]);
	expect(report.br_lint_exit_code).toBe(0);
	expect(report.br_lint_finding_count).toBe(0);
	expect(report.br_lint_clean).toBe(true);
	expect(report.created_items.map((item: { slug: string }) => item.slug)).toEqual(["root-task", "child-bug", "plan-epic"]);

	const rows = issueRows(dbDir);
	expect(rows).toHaveLength(4);
	const root = rows.find((row) => row.external_ref === "core8:root-task");
	const child = rows.find((row) => row.external_ref === "core8:child-bug");
	const nestedEpic = rows.find((row) => row.external_ref === "core8:plan-epic");
	const parent = rows.find((row) => row.id === report.parent_epic_id);
	expect(root).toMatchObject({ issue_type: "task", priority: 1 });
	expect(child).toMatchObject({ issue_type: "bug", priority: 1 });
	expect(child?.labels).toContain("mission:core8");
	expect(child?.description).toContain("existing: example.tracker.42 (amend)");
	expect(child?.description).toContain("external:482");
	expect(child?.description).toContain("remove-depends-on: legacy:edge");
	expect(child?.acceptance_criteria).toContain("Planted negative: external:482");
	expect(nestedEpic?.description).toContain("## Success Criteria");
	expect(parent).toMatchObject({ issue_type: "epic" });
	expect(parent?.description).toContain("## Success Criteria");

	const edges = JSON.stringify(nativeJson(["dep", "list", String(child?.id)], dbDir));
	expect(edges).toContain(String(root?.id));
	expect(edges).toContain(String(parent?.id));
	const missionRows = rows.filter((row) => row.issue_type !== "epic" && Array.isArray(row.labels) && row.labels.includes("mission:core8"));
	const metric = report.planning_score_bead_metrics;
	expect(metric.acceptance_share).toBe(1);
	expect(metric.mission_beads).toBe(missionRows.length);
	expect(metric.deps_per_bead).toBe(missionRows.reduce((sum, row) => sum + Number(row.dependency_count ?? 0), 0) / missionRows.length);
	expect(metric.median_description_chars).toBe(median(missionRows.map((row) => String(row.description ?? "").length)));
	expect(metric.planning_score_median_chars).toBe(median(missionRows.map((row) => (String(row.title ?? "") + "\n" + String(row.description ?? "") + "\n" + String(row.acceptance_criteria ?? "")).length)));

	const before = rows.map((row) => row.id).sort();
	const second = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(second.exitCode).not.toBe(0);
	expect(JSON.parse(second.stdout).data.overall).toBe("REFUSED");
	expect(issueRows(dbDir).map((row) => row.id).sort()).toEqual(before);
});

isolatedTest("planted negatives are named and the human report survives a nonzero exit", async () => {
	const dbDir = join(scratch, "negative-db");
	const result = await runCli(["planning", "convert", "--plan", negativePlan, "--mission", "core8", "--dry-run", "--db", dbDir]);
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout).toContain("Planning conversion");
	expect(result.stdout).toContain("bad-bug");
	expect(result.stdout).toContain("## Steps to Reproduce");
	expect(result.stdout).toContain("bad-label");
	expect(result.stdout).toContain("invalid.label");
	expect(result.stdout).toContain("uncovered-letter");
	expect(result.stdout).toContain("missing positive");
	expect(result.stdout).toContain("missing planted-negative");
	expect(result.stdout).toContain("cycle-left");
	expect(result.stdout).toContain("cycle-right");
	expect(result.stdout).toContain("Dependency cycles");
	expect(result.stdout).toContain("count 1; clean false");
	expect(result.stdout).toContain("Unparseable blocks");
	const malformedLine = readFileSync(negativePlan, "utf8").split("\n").findIndex((line) => line === "### malformed-item") + 1;
	expect(result.stdout).toContain("line " + malformedLine);

	const lint = nativeOutput(["lint"], dbDir);
	expect(result.stdout).toContain(lint);
});

isolatedTest("planning convert rejects conflicting modes without creating either target", async () => {
	const dbDir = join(scratch, "conflicting-mode-db");
	const trackerRoot = join(scratch, "conflicting-mode-tracker");
	const result = await runCli([
		"planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir,
		"--apply", "--tracker-root", trackerRoot, "--yes", "--json",
	]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
	expect(existsSync(dbDir)).toBe(false);
	expect(existsSync(trackerRoot)).toBe(false);
});
isolatedTest("missing explicit mode refuses before creating the requested database directory", async () => {
	const dbDir = join(scratch, "no-mode-db");
	const result = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--db", dbDir, "--json"]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
	expect(existsSync(dbDir)).toBe(false);
});

function nativeAuthorityRecorder(trackerRoot: string, mode = "record"): { env: Record<string, string>; log: string } {
	const realBr = Bun.which("br");
	if (!realBr) throw new Error("native br unavailable");
	const bin = join(trackerRoot, "authority-bin");
	mkdirSync(bin, { recursive: true });
	const log = join(trackerRoot, "native-argv.jsonl");
	writeFileSync(join(bin, "br"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.AUTHORITY_LOG, JSON.stringify(args) + "\\n");
if (process.env.AUTHORITY_MODE === "stale" && args[0] === "update") {
  const changed = Bun.spawnSync([${JSON.stringify(realBr)}, "update", args[1], "--append-notes", "concurrent native context change",
    "--db", args[args.indexOf("--db") + 1], "--actor", "ConcurrentWriter", "--no-auto-import", "--no-auto-flush", "--json"],
    { stdout: "pipe", stderr: "pipe" });
  if (changed.exitCode !== 0) { process.stderr.write(changed.stderr); process.exit(changed.exitCode ?? 1); }
}
const result = Bun.spawnSync([${JSON.stringify(realBr)}, ...args], { stdin: Buffer.from(await Bun.stdin.text()), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (process.env.AUTHORITY_MODE === "partial-create" && args[0] === "create" && args[args.indexOf("--type") + 1] !== "epic" && result.exitCode === 0)
  process.exit(1);
process.exit(result.exitCode ?? 1);
`, { mode: 0o755 });
	return { env: { PATH: bin + ":" + childEnv.PATH, AUTHORITY_LOG: log, AUTHORITY_MODE: mode }, log };
}

function storedParentContract(issue: Record<string, unknown>): Record<string, unknown> {
	// Native show computes these two views from children; creating the declared child must change them.
	const { dependents, rollup, ...contract } = issue;
	return contract;
}

isolatedTest("noncore public dry-run and native apply preserve mission, actor, amendment, parents and exporter custody", async () => {
	const mission = "frontier";
	const trackerRoot = join(scratch, "authority-native-smoke");
	initializeTracker(trackerRoot);
	const coreParent = createNativeIssue(trackerRoot, "Unrelated core8 epic", { externalRef: "core8", type: "epic" });
	const explicitParent = createNativeIssue(trackerRoot, "Original rollout parent", { type: "feature" });
	const oldAcceptance = "- [ ] Keep the FULL old acceptance.\n- [x] Preserve checked status and punctuation: a:b!";
	const target = createNativeIssue(trackerRoot, "Amend exactly this target", { parent: explicitParent, externalRef: "historical:identity", acceptance: oldAcceptance });
	const unrelated = createNativeIssue(trackerRoot, "Never amend this other target");
	nativeOutput(["dep", "add", target, unrelated], trackerRoot);
	const parentBefore = showNativeIssue(trackerRoot, explicitParent);
	const unrelatedBefore = showNativeIssue(trackerRoot, unrelated);
	const targetBefore = showNativeIssue(trackerRoot, target);
	const plan = writePlan("authority-native", [
		{ slug: "default-child", existing: "(new)" },
		{ slug: "explicit-child", existing: "(new)", parent: explicitParent },
		{ slug: "amend-first", existing: target + " (amend)", dependsOn: ["default-child"] },
		{ slug: "amend-second", existing: target },
	], mission);
	const dryDb = join(scratch, "authority-dry");
	const dry = await runCli(["planning", "convert", "--plan", plan, "--mission", mission, "--dry-run", "--db", dryDb, "--json"]);
	expect(dry.exitCode).toBe(0);
	const dryReport = applyResult(dry);
	expect(dryReport.br_lint_clean).toBe(true);
	expect(dryReport.br_cycle_clean).toBe(true);
	expect(issueRows(dryDb).every((row) => row.external_ref?.startsWith(mission))).toBe(true);
	expect(issueRows(dryDb).find((row) => row.external_ref === mission)?.labels).toContain("mission:" + mission);

	const exporterPath = join(trackerRoot, ".beads", "issues.jsonl");
	const exporterBytes = "Exporter-owned bytes; native auto-import/export must remain disabled.\n";
	writeFileSync(exporterPath, exporterBytes);
	const recorder = nativeAuthorityRecorder(trackerRoot);
	const first = await runCli(applyArgs(plan, trackerRoot, mission, "ActualWriter"), recorder.env);
	expect(first.exitCode).toBe(0);
	const report = applyResult(first);
	expect(report.actor).toBe("ActualWriter");
	expect(report.overall).toBe("CLEAN");
	expect(report.parent_epic_id).not.toBe(coreParent);
	const rows = issueRows(trackerRoot);
	const missionParent = rows.find((row) => row.external_ref === mission)!;
	expect(missionParent.labels).toEqual(["mission:frontier", "plan:frontier"]);
	for (const slug of ["default-child", "explicit-child"]) {
		const row = rows.find((candidate) => candidate.external_ref === mission + ":" + slug)!;
		const details = showNativeIssue(trackerRoot, row.id);
		expect(details.created_by).toBe("ActualWriter");
		expect(details.parent).toBe(slug === "default-child" ? missionParent.id : explicitParent);
		expect(row.labels).toContain("mission:frontier");
		expect(row.description).toContain("Source item: frontier:" + slug);
	}
	const amended = showNativeIssue(trackerRoot, target);
	expect(String(amended.acceptance_criteria).startsWith(String(targetBefore.acceptance_criteria))).toBe(true);
	expect(amended.external_ref).toBe("historical:identity");
	expect(amended.parent).toBe(explicitParent);
	expect(JSON.stringify(amended.dependencies)).toContain(unrelated);
	expect(amended.notes).toBe("frontier:amend-first\nfrontier:amend-second");
	expect(storedParentContract(showNativeIssue(trackerRoot, explicitParent))).toEqual(storedParentContract(parentBefore));
	expect(showNativeIssue(trackerRoot, unrelated)).toEqual(unrelatedBefore);
	expect(readFileSync(exporterPath, "utf8")).toBe(exporterBytes);
	const snapshots = rows.map((row) => showNativeIssue(trackerRoot, row.id));
	const second = await runCli(applyArgs(plan, trackerRoot, mission, "ActualWriter"), recorder.env);
	expect(second.exitCode).toBe(0);
	expect(applyResult(second).writes_landed).toEqual([]);
	expect(issueRows(trackerRoot).map((row) => showNativeIssue(trackerRoot, row.id))).toEqual(snapshots);
	expect(readFileSync(exporterPath, "utf8")).toBe(exporterBytes);
	const calls: string[][] = readFileSync(recorder.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(calls.some((args) => args[0] === "create")).toBe(true);
	expect(calls.some((args) => args[0] === "update")).toBe(true);
	expect(calls.some((args) => args[0] === "dep" && args[1] === "add")).toBe(true);
	for (const args of calls) {
		expect(args).toContain("--no-auto-import");
		expect(args).toContain("--no-auto-flush");
		expect(args).not.toContain("--allow-stale");
		expect(args[args.indexOf("--db") + 1]).toBe(join(trackerRoot, ".beads", "beads.db"));
		expect(args[args.indexOf("--actor") + 1]).toBe("ActualWriter");
	}
}, 60_000);

isolatedTest("explicit parents do not create a substitute mission epic and reapply without parent changes", async () => {
	const trackerRoot = join(scratch, "explicit-parent-only");
	initializeTracker(trackerRoot);
	const parent = createNativeIssue(trackerRoot, "Original feature", { acceptance: "- [ ] Full rollout contract remains unchanged.", type: "feature" });
	const satisfiedPrerequisite = createNativeIssue(trackerRoot, "Satisfied code prerequisite");
	nativeOutput(["dep", "add", parent, satisfiedPrerequisite], trackerRoot);
	nativeOutput(["close", satisfiedPrerequisite], trackerRoot);
	const before = showNativeIssue(trackerRoot, parent);
	const plan = writePlan("explicit-parent-only", [{ slug: "runtime-leaf", existing: "(new)", parent }], "runtime");
	const first = await runCli(applyArgs(plan, trackerRoot, "runtime"));
	expect(first.exitCode).toBe(0);
	expect(applyResult(first).parent_epic_id).toBe(null);
	expect(issueRows(trackerRoot)).toHaveLength(2);
	const child = issueRows(trackerRoot).find((row) => row.external_ref === "runtime:runtime-leaf")!;
	expect(child.id.startsWith(parent + ".")).toBe(true);
	expect(showNativeIssue(trackerRoot, child.id).parent).toBe(parent);
	expect(nativeOutput(["ready"], trackerRoot)).toContain(child.id);
	expect(storedParentContract(showNativeIssue(trackerRoot, parent))).toEqual(storedParentContract(before));
	const second = await runCli(applyArgs(plan, trackerRoot, "runtime"));
	expect(second.exitCode).toBe(0);
	expect(applyResult(second).writes_landed).toEqual([]);
});

for (const actor of [null, "", "  WrongWriter", "WrongWriter\n"]) {
	isolatedTest("apply refuses missing or malformed explicit actor " + JSON.stringify(actor), async () => {
		const trackerRoot = join(scratch, "bad-actor-" + String(actor).length);
		initializeTracker(trackerRoot);
		const plan = writePlan("bad-actor-" + String(actor).length, [{ slug: "no-write", existing: "(new)" }]);
		const args = applyArgs(plan, trackerRoot);
		const at = args.indexOf("--actor");
		if (actor === null) args.splice(at, 2);
		else args[at + 1] = actor;
		const before = nativeOutput(["list", "--all"], trackerRoot);
		const result = await runCli(args);
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain(actor === null || actor === "" ? "--actor" : "INVALID_ACTOR");
		expect(nativeOutput(["list", "--all"], trackerRoot)).toBe(before);
	});
}

for (const conflict of ["missing-parent", "closed-parent", "blocked-parent", "moved-parent", "wrong-mission", "ref-target", "note-target", "reused-parent"]) {
	isolatedTest("apply refuses exact native target conflict before any write: " + conflict, async () => {
		const trackerRoot = join(scratch, "authority-conflict-" + conflict);
		initializeTracker(trackerRoot);
		const parent = createNativeIssue(trackerRoot, "Original parent", { externalRef: "core8", type: "epic" });
		const target = createNativeIssue(trackerRoot, "Selected target", { parent });
		const other = createNativeIssue(trackerRoot, "Different target");
		let items: ApplyPlanItem[] = [{ slug: "new-before-conflict", existing: "(new)" }];
		if (conflict === "missing-parent") items.push({ slug: "conflict", existing: "(new)", parent: "other-missing" });
		if (conflict === "closed-parent") {
			nativeOutput(["close", other], trackerRoot);
			items.push({ slug: "conflict", existing: "(new)", parent: other });
		}
		if (conflict === "blocked-parent") {
			nativeOutput(["dep", "add", other, target], trackerRoot);
			items.push({ slug: "conflict", existing: "(new)", parent: other });
		}
		if (conflict === "moved-parent") items.push({ slug: "conflict", existing: target + " (amend)", parent: other });
		if (conflict === "ref-target") {
			nativeOutput(["update", other, "--external-ref", "core8:conflict"], trackerRoot);
			items.push({ slug: "conflict", existing: target + " (amend)" });
		}
		if (conflict === "note-target") {
			nativeOutput(["update", other, "--append-notes", "core8:conflict"], trackerRoot);
			items.push({ slug: "conflict", existing: target + " (amend)" });
		}
		if (conflict === "reused-parent") {
			nativeOutput(["update", other, "--external-ref", "core8:conflict"], trackerRoot);
			items.push({ slug: "conflict", existing: "(new)" });
		}
		const plan = writePlan("authority-conflict-" + conflict, items);
		const before = nativeOutput(["list", "--all"], trackerRoot);
		const result = await runCli(applyArgs(plan, trackerRoot, conflict === "wrong-mission" ? "another" : "core8"));
		expect(result.exitCode).not.toBe(0);
		expect(applyResult(result).overall).toBe("REFUSED");
		expect(applyResult(result).writes_landed).toEqual([]);
		if (conflict === "blocked-parent") expect(applyResult(result).apply_preflight_error).toBe("declared parent " + other + " is blocked by " + target);
		expect(nativeOutput(["list", "--all"], trackerRoot)).toBe(before);
	});
}

isolatedTest("native amendment context mismatch remains a refusal without retry or acceptance overwrite", async () => {
	const trackerRoot = join(scratch, "native-context-mismatch");
	initializeTracker(trackerRoot);
	const target = createNativeIssue(trackerRoot, "Concurrent amendment target");
	const before = showNativeIssue(trackerRoot, target);
	const plan = writePlan("native-context-mismatch", [{ slug: "amend", existing: target + " (amend)" }]);
	const recorder = nativeAuthorityRecorder(trackerRoot, "stale");
	const result = await runCli(applyArgs(plan, trackerRoot), recorder.env);
	expect(result.exitCode).not.toBe(0);
	const report = applyResult(result);
	expect(report.apply_failure.step).toBe("amend-" + target);
	expect(report.writes_landed).toEqual([]);
	expect(showNativeIssue(trackerRoot, target).acceptance_criteria).toBe(before.acceptance_criteria);
	const calls: string[][] = readFileSync(recorder.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(calls.filter((args) => args[0] === "update")).toHaveLength(1);
});

isolatedTest("native durable creation followed by failure is reconciled, never reported as zero writes", async () => {
	const trackerRoot = join(scratch, "authority-partial-create");
	initializeTracker(trackerRoot);
	const plan = writePlan("authority-partial-create", [{ slug: "durable-child", existing: "(new)" }]);
	const result = await runCli(applyArgs(plan, trackerRoot), nativeAuthorityRecorder(trackerRoot, "partial-create").env);
	expect(result.exitCode).not.toBe(0);
	const report = applyResult(result);
	expect(report.overall).toBe("FINDINGS");
	expect(report.apply_failure.step).toBe("create-durable-child");
	const child = issueRows(trackerRoot).find((row) => row.external_ref === "core8:durable-child")!;
	expect(report.writes_landed).toContainEqual({ kind: "ITEM_CREATED", id: child.id, slug: "durable-child", external_ref: "core8:durable-child" });
	expect(showNativeIssue(trackerRoot, child.id).created_by).toBe("PlanningWriter");
});

async function requireCanonicalAdmission(dbDir: string): Promise<void> {
	const rows = issueRows(dbDir);
	// ACPHASE1: each row is also linted as if created at the cutover, so the
	// phase-tag gate (check l) binds today and not only from 2026-10-24 on.
	const script = [
		"import json, sys",
		"sys.path.insert(0, sys.argv[1])",
		"import ac_phase, bead_lint",
		"rows = json.load(sys.stdin)",
		"ids = {row['id'] for row in rows}",
		"bad = {row['id']: failures for row in rows if (failures := bead_lint.lint_bead_failures(row, ids))}",
		"late = {row['id']: failures for row in rows if (failures := bead_lint.lint_bead_failures({**row, 'created_at': ac_phase.AC_PHASE_CUTOVER}, ids))}",
		"print(json.dumps({'stored': bad, 'enforced': late}))",
		"sys.exit(bool(bad or late))",
	].join("\n");
	const result = await runBounded(["python3", "-B", "-c", script, join(repoRoot, "scripts")], {
		deadline_s: 20, max_output_bytes: 1 << 20, stdin: JSON.stringify(rows), cwd: repoRoot, env: childEnv,
	});
	const text = new TextDecoder();
	expect(result.rc, text.decode(result.stdout) + text.decode(result.stderr)).toBe(0);
}

isolatedTest("canonical checkbox plans retain scoped coverage and pass canonical admission", async () => {
	const plan = writePlan("canonical-checkbox", [{ slug: "canonical-checkbox", existing: "(new)" }]);
	writeFileSync(plan, readFileSync(plan, "utf8").replaceAll("- [a]", "- [ ] [a]"));
	const dbDir = join(scratch, "canonical-checkbox-db");
	const result = await runCli(["planning", "convert", "--plan", plan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(result.exitCode, result.stdout).toBe(0);
	await requireCanonicalAdmission(dbDir);
});

isolatedTest("legacy lettered plans are stored as gradeable canonical criteria including the generated parent", async () => {
	const plan = writePlan("legacy-checkbox", [{ slug: "legacy-checkbox", existing: "(new)" }]);
	const dbDir = join(scratch, "legacy-checkbox-db");
	const result = await runCli(["planning", "convert", "--plan", plan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(result.exitCode, result.stdout).toBe(0);
	await requireCanonicalAdmission(dbDir);
});

isolatedTest("canonical acceptance amendment is idempotent and preserves checked progress", async () => {
	const trackerRoot = join(scratch, "canonical-amend-tracker");
	initializeTracker(trackerRoot);
	const plan = writePlan("canonical-amend", [{ slug: "canonical-amend", existing: "(new)" }]);
	writeFileSync(plan, readFileSync(plan, "utf8").replaceAll("- [a]", "- [ ] [a]"));
	const first = await runCli(applyArgs(plan, trackerRoot));
	expect(first.exitCode, first.stdout).toBe(0);
	const item = issueRows(trackerRoot).find((row) => row.external_ref === "core8:canonical-amend");
	if (!item) throw new Error("converted canonical item is missing");
	const progressed = item.acceptance_criteria.replace("- [ ]", "- [x]");
	nativeOutput(["update", item.id, "--acceptance-criteria", progressed], trackerRoot);
	writeFileSync(plan, planSource([{ slug: "canonical-amend", existing: item.id }]).replaceAll("- [a]", "- [ ] [a]"));
	const second = await runCli(applyArgs(plan, trackerRoot));
	expect(second.exitCode, second.stdout).toBe(0);
	const afterSecond = showNativeIssue(trackerRoot, item.id);
	expect(afterSecond.acceptance_criteria).toBe(progressed);
	const third = await runCli(applyArgs(plan, trackerRoot));
	expect(third.exitCode, third.stdout).toBe(0);
	const afterThird = showNativeIssue(trackerRoot, item.id);
	expect(afterThird.acceptance_criteria).toBe(progressed);
	expect(afterThird.notes).toEqual(afterSecond.notes);
});

isolatedTest("canonical scope sets preserve explicit progress while legacy scope x remains a scope", async () => {
	const plan = join(scratch, "canonical-scope-sets.md");
	let source = planSource([
		{ slug: "scope-sets", existing: "(new)" },
		{ slug: "legacy-scope-x", existing: "(new)" },
	]);
	source = source
		.replace("WHAT: (a) scope-sets is applied to the selected tracker.", "WHAT: (a) Keep the first scope; (b) keep the second scope.")
		.replace("- [a] scope-sets contributes", "- [ ] [a,b] scope-sets contributes")
		.replace("- [a] Planted negative: scope-sets", "- [x] [b; a] Planted negative: scope-sets")
		.replace("WHAT: (a) legacy-scope-x is applied to the selected tracker.", "WHAT: (x) Keep the legacy x scope.")
		.replace("- [a] legacy-scope-x contributes", "- [x] legacy-scope-x contributes")
		.replace("- [a] Planted negative: legacy-scope-x", "- [x] Planted negative: legacy-scope-x");
	writeFileSync(plan, source);
	const dbDir = join(scratch, "canonical-scope-sets-db");
	const result = await runCli(["planning", "convert", "--plan", plan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(result.exitCode, result.stdout).toBe(0);
	await requireCanonicalAdmission(dbDir);
	const rows = issueRows(dbDir);
	const scopes = rows.find((row) => row.external_ref === "core8:scope-sets");
	const legacy = rows.find((row) => row.external_ref === "core8:legacy-scope-x");
	if (!scopes || !legacy) throw new Error("scope fixture rows are missing");
	expect(scopes.acceptance_criteria.includes("- [x] [a,b] [build] Planted negative:")).toBe(true);
	expect(legacy.acceptance_criteria.includes("- [ ] [x] [build] legacy-scope-x contributes")).toBe(true);
});
