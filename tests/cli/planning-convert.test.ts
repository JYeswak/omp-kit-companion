import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "planning-convert-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=planning-convert-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");
const cli = join(repoRoot, "src", "cli.ts");
const validPlan = join(import.meta.dir, "../fixtures/planning-convert/valid.md");
const negativePlan = join(import.meta.dir, "../fixtures/planning-convert/negative.md");
const childEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };

type CliRunResult = { exitCode: number; stdout: string; stderr: string };

function runCli(args: string[]): Promise<CliRunResult> {
	const child = Bun.spawn([process.execPath, cli, ...args], { cwd: repoRoot, env: childEnv, stdout: "pipe", stderr: "pipe" });
	return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([exitCode, stdout, stderr]) => {
		if (!stdout.trim()) throw new Error("planning convert returned no stdout; stderr=" + stderr);
		return { exitCode, stdout, stderr };
	});
}

function nativeOutput(args: string[], dbDir: string): string {
	const result = Bun.spawnSync(["br", ...args, "--db", join(dbDir, ".beads", "beads.db"), "--no-auto-import", "--no-auto-flush", "--no-daemon", "--json", "--no-color"], {
		cwd: dbDir, env: childEnv, stdout: "pipe", stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error("br command failed: " + result.stdout.toString() + result.stderr.toString());
	return result.stdout.toString();
}

function nativeJson(args: string[], dbDir: string): unknown {
	return JSON.parse(nativeOutput(args, dbDir));
}

type NativeIssueRow = {
	id: string;
	title: string;
	description: string;
	acceptance_criteria: string;
	status: string;
	priority: number;
	issue_type: string;
	labels: string[];
	dependency_count: number;
	external_ref?: string;
};

function issueRows(dbDir: string): NativeIssueRow[] {
	const value = nativeJson(["list"], dbDir);
	let candidates: unknown[];
	if (Array.isArray(value)) candidates = value;
	else if (typeof value === "object" && value !== null && "issues" in value && Array.isArray(value.issues)) candidates = value.issues;
	else throw new Error("br list JSON did not contain an issue array");
	return candidates.map((row, index) => {
		if (typeof row !== "object" || row === null || Array.isArray(row) ||
			!("id" in row) || typeof row.id !== "string" ||
			!("title" in row) || typeof row.title !== "string" ||
			!("description" in row) || typeof row.description !== "string" ||
			!("acceptance_criteria" in row) || typeof row.acceptance_criteria !== "string" ||
			!("status" in row) || typeof row.status !== "string" ||
			!("priority" in row) || typeof row.priority !== "number" ||
			!("issue_type" in row) || typeof row.issue_type !== "string" ||
			!("labels" in row) || !Array.isArray(row.labels) ||
			!("dependency_count" in row) || typeof row.dependency_count !== "number")
			throw new Error("br list JSON issue " + index + " has an invalid shape");
		const labels: string[] = [];
		for (const label of row.labels) {
			if (typeof label !== "string") throw new Error("br list JSON issue " + index + " has a non-string label");
			labels.push(label);
		}
		const issue: NativeIssueRow = {
			id: row.id, title: row.title, description: row.description, acceptance_criteria: row.acceptance_criteria,
			status: row.status, priority: row.priority, issue_type: row.issue_type, labels, dependency_count: row.dependency_count,
		};
		if ("external_ref" in row && typeof row.external_ref === "string") issue.external_ref = row.external_ref;
		return issue;
	});
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}
type ApplyPlanItem = { slug: string; existing: string; dependsOn?: string[] };

function planSource(items: ApplyPlanItem[]): string {
	return items.map((item) => [
		"```text",
		"### " + item.slug + " — " + item.slug.replaceAll("-", " "),
		"type: task priority: 1",
		"labels: plan:core8, mission:core8, test:planning-convert",
		"depends-on: " + (item.dependsOn?.join(", ") || "(none)"),
		"existing: " + item.existing,
		"discovered-from: planning-convert-test",
		"WHAT: (a) " + item.slug + " is applied to the selected tracker.",
		"WHY: The selected tracker must retain unrelated state.",
		"ACCEPTANCE:",
		"- [a] " + item.slug + " contributes its positive acceptance criterion.",
		"- [a] Planted negative: " + item.slug + " is not applied twice.",
		"NO-CLAIM: This fixture does not certify unrelated tracker state.",
		"```",
	].join("\n")).join("\n\n");
}

function writePlan(name: string, items: ApplyPlanItem[]): string {
	const path = join(scratch, name + ".md");
	writeFileSync(path, planSource(items));
	return path;
}

function initializeTracker(trackerRoot: string): void {
	mkdirSync(trackerRoot, { recursive: true });
	nativeOutput(["init", "--prefix", "core8"], trackerRoot);
}

function createNativeIssue(trackerRoot: string, title: string, options: {
	externalRef?: string; parent?: string; acceptance?: string; type?: string;
} = {}): string {
	const args = ["create", "--title", title, "--type", options.type ?? "task", "--priority", "1",
		"--labels", "mission:core8,test:planning-convert", "--description", "Seeded for planning-convert apply tests",
		"--acceptance-criteria", options.acceptance ?? "- [ ] Original tracker acceptance."];
	if (options.parent) args.push("--parent", options.parent);
	if (options.externalRef) args.push("--external-ref", options.externalRef);
	const result = nativeJson(args, trackerRoot);
	const row = Array.isArray(result) ? result[0] : result;
	if (typeof row !== "object" || row === null || !("id" in row) || typeof row.id !== "string")
		throw new Error("br create did not return an issue id");
	return row.id;
}

function showNativeIssue(trackerRoot: string, id: string): Record<string, unknown> {
	const result = nativeJson(["show", id], trackerRoot);
	const row = Array.isArray(result) ? result[0] : result;
	if (typeof row !== "object" || row === null || Array.isArray(row))
		throw new Error("br show did not return an issue");
	return row as Record<string, unknown>;
}

function applyResult(result: CliRunResult): Record<string, any> {
	return JSON.parse(result.stdout).data;
}

function applyArgs(plan: string, trackerRoot: string): string[] {
	return ["planning", "convert", "--plan", plan, "--mission", "core8", "--apply", "--tracker-root", trackerRoot, "--yes", "--json"];
}

test("planning convert apply preserves prior acceptance while grouping repeated contributions", async () => {
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

test("planning convert apply second run creates no duplicate issues, notes, acceptance, or edges", async () => {
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

test("planning convert apply reports foreign targets without writing them", async () => {
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

test("planning convert apply preflights every block before writing any target", async () => {
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


test("planning convert apply refuses a cycle introduced by the merged tracker graph before writes", async () => {
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

test("planning convert apply creates new targets beneath one core8 epic and reports the foreign target", async () => {
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


test("planning convert is a public dry-run and apply command with explicit mode flags", () => {
	const planning = COMMANDS.find((command) => command.name === "planning");
	const convert = planning?.subcommands?.find((command) => command.name === "convert");
	expect(convert?.usage).toBe("planning convert --plan PATH --mission M (--dry-run --db DIR | --apply --tracker-root DIR) [--yes] [--json]");
	expect(convert?.flags.map((flag) => flag.name)).toEqual(["--plan", "--mission", "--dry-run", "--db", "--apply", "--tracker-root", "--yes"]);
	expect(convert?.mutation).toBe(true);
});

test("valid plan creates native parented beads and refuses a duplicate database", async () => {
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

test("planted negatives are named and the human report survives a nonzero exit", async () => {
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

test("planning convert rejects conflicting modes without creating either target", async () => {
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
test("missing explicit mode refuses before creating the requested database directory", async () => {
	const dbDir = join(scratch, "no-mode-db");
	const result = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--db", dbDir, "--json"]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
	expect(existsSync(dbDir)).toBe(false);
});
