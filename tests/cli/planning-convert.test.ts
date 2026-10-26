import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { run as runBounded } from "../../src/kitlib/run.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("planning-convert-test", { root: scratchRoot }).path;
const cli = join(repoRoot, "src", "cli.ts");
const validPlan = join(import.meta.dir, "../fixtures/planning-convert/valid.md");
const negativePlan = join(import.meta.dir, "../fixtures/planning-convert/negative.md");
const childEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };

type CliRunResult = { exitCode: number; stdout: string; stderr: string };

function runCli(args: string[], overrides: Record<string, string> = {}): Promise<CliRunResult> {
	const child = Bun.spawn([process.execPath, cli, ...args], { cwd: repoRoot, env: { ...childEnv, ...overrides }, stdout: "pipe", stderr: "pipe" });
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
type ApplyPlanItem = { slug: string; existing: string; dependsOn?: string[]; parent?: string };

function planSource(items: ApplyPlanItem[], mission = "core8"): string {
	return items.map((item) => [
		"```text",
		"### " + item.slug + " — " + item.slug.replaceAll("-", " "),
		"type: task priority: 1",
		"labels: plan:" + mission + ", mission:" + mission + ", test:planning-convert",
		"depends-on: " + (item.dependsOn?.join(", ") || "(none)"),
		"existing: " + item.existing,
		...(item.parent ? ["parent: " + item.parent] : []),
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

function writePlan(name: string, items: ApplyPlanItem[], mission = "core8"): string {
	const path = join(scratch, name + ".md");
	writeFileSync(path, planSource(items, mission));
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

function applyArgs(plan: string, trackerRoot: string, mission = "core8", actor = "PlanningWriter", extra: string[] = []): string[] {
	return ["planning", "convert", "--plan", plan, "--mission", mission, "--apply", "--tracker-root", trackerRoot, "--actor", actor, "--yes", ...extra, "--json"];
}

function amendPlanSource(slug: string, existing: string, acceptance: string[], mission = "core8"): string {
	return [
		"```text",
		"### " + slug + " — " + slug.replaceAll("-", " "),
		"type: task priority: 1",
		"labels: plan:" + mission + ", mission:" + mission + ", test:planning-convert",
		"depends-on: (none)",
		"existing: " + existing,
		"discovered-from: planning-convert-test",
		"WHAT: (a) " + slug + " reconciles a changed acceptance.",
		"WHY: The selected tracker must never silently drop a changed acceptance.",
		"ACCEPTANCE:",
		...acceptance,
		"NO-CLAIM: This fixture does not certify unrelated tracker state.",
		"```",
	].join("\n");
}

function writeAmendPlan(name: string, slug: string, existing: string, acceptance: string[]): string {
	const path = join(scratch, name + ".md");
	writeFileSync(path, amendPlanSource(slug, existing, acceptance));
	return path;
}

const amendAcceptanceV1 = [
	"- [a] amend-target contributes its positive acceptance criterion.",
	"- [a] Planted negative: amend-target is not applied twice.",
];
const amendAcceptanceV2 = [
	"- [a] amend-target now requires a changed acceptance criterion.",
	"- [a] Planted negative: the changed criterion is never silently dropped.",
];

function concurrentWriteFixture(trackerRoot: string, targetId: string): Record<string, string> {
	const realBr = Bun.which("br");
	if (!realBr) throw new Error("native br unavailable");
	const bin = join(trackerRoot, "concurrent-bin");
	mkdirSync(bin, { recursive: true });
	const sentinel = join(bin, "tripped");
	writeFileSync(join(bin, "br"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
const dbIndex = args.indexOf("--db");
const db = dbIndex >= 0 ? args[dbIndex + 1] : "";
if (args[0] === "update" && args[1] === process.env.CONCURRENT_TARGET && !(await Bun.file(process.env.CONCURRENT_SENTINEL).exists())) {
	await Bun.write(process.env.CONCURRENT_SENTINEL, "tripped\\n");
	const concurrent = Bun.spawnSync([${JSON.stringify(realBr)}, "update", process.env.CONCURRENT_TARGET, "--append-notes", "concurrent-probe", "--db", db, "--actor", "ConcurrentWriter", "--no-auto-import", "--no-auto-flush", "--no-daemon", "--no-color", "--json"], { stdout: "pipe", stderr: "pipe" });
	if (concurrent.exitCode !== 0) {
		process.stderr.write("concurrent probe write failed: " + concurrent.stderr.toString());
		process.exit(1);
	}
}
const result = Bun.spawnSync([${JSON.stringify(realBr)}, ...args], { stdout: "pipe", stderr: "pipe" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode ?? 1);
`, { mode: 0o755 });
	return { PATH: bin + ":" + childEnv.PATH, CONCURRENT_TARGET: targetId, CONCURRENT_SENTINEL: sentinel };
}

function nativeShapeFixture(trackerRoot: string, targetId: string, mode: string): Record<string, string> {
	const realBr = Bun.which("br");
	if (!realBr) throw new Error("native br unavailable");
	const bin = join(trackerRoot, "shape-bin");
	mkdirSync(bin, { recursive: true });
	const wrapper = join(bin, "br");
	writeFileSync(wrapper, `#!/usr/bin/env bun
const args = process.argv.slice(2);
const result = Bun.spawnSync([${JSON.stringify(realBr)}, ...args], { stdout: "pipe", stderr: "pipe" });
process.stderr.write(result.stderr);
if (result.exitCode !== 0 || !["list", "show"].includes(args[0])) {
  process.stdout.write(result.stdout);
  process.exit(result.exitCode ?? 1);
}
const value = JSON.parse(result.stdout.toString());
const rows = Array.isArray(value) ? value : value.issues;
for (const row of rows ?? []) {
  if (row.id !== process.env.SHAPE_TARGET) continue;
  const [phase, field, kind] = process.env.SHAPE_MODE.split(":");
  if (phase !== "both" && phase !== args[0]) continue;
  if (kind === "missing") delete row[field];
  else if (kind === "null") row[field] = null;
  else if (kind === "number") row[field] = 17;
  else if (kind === "string") row[field] = "wrong-shape";
  else if (kind === "element") row[field] = [17];
  else if (kind === "identity") row[field] = "another-issue";
  else if (kind === "null-text") {
    row.description = null;
    row.acceptance_criteria = null;
    delete row.labels;
  }
}
process.stdout.write(JSON.stringify(value));
`, { mode: 0o755 });
	return { PATH: bin + ":" + childEnv.PATH, SHAPE_TARGET: targetId, SHAPE_MODE: mode };
}

for (const nullableText of [false, true]) {
	test(`planning convert applies with native sparse optional fields (${nullableText ? "null text" : "omitted"})`, async () => {
		const trackerRoot = join(scratch, "apply-sparse-" + nullableText);
		initializeTracker(trackerRoot);
		createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
		const sparse = nativeJson(["create", "--title", "Sparse native target", "--type", "task", "--priority", "1"], trackerRoot);
		if (typeof sparse !== "object" || sparse === null || !("id" in sparse) || typeof sparse.id !== "string") {
			throw new Error("native sparse create returned no id");
		}
		const before = showNativeIssue(trackerRoot, sparse.id);
		expect(before.description ?? "").toBe("");
		expect(before.acceptance_criteria ?? "").toBe("");
		expect(before.labels ?? []).toEqual([]);
		const plan = writePlan("sparse-" + nullableText, [
			{ slug: "new-sparse-neighbor", existing: "(new)" },
			{ slug: "amend-sparse-target", existing: sparse.id + " (amend)" },
		]);
		const result = await runCli(applyArgs(plan, trackerRoot),
			nullableText ? nativeShapeFixture(trackerRoot, sparse.id, "both:description:null-text") : {});
		expect(result.exitCode).toBe(0);
		expect(applyResult(result).overall).toBe("CLEAN");
		const after = showNativeIssue(trackerRoot, sparse.id);
		expect(after.title).toBe("Sparse native target");
		expect(after.description ?? "").toBe("");
		expect(after.acceptance_criteria).toContain("amend-sparse-target contributes its positive acceptance criterion");
		expect(applyResult(result).created_items).toMatchObject([{ slug: "new-sparse-neighbor" }]);
	});
}

for (const mode of [
	"list:description:number", "list:acceptance_criteria:number", "list:labels:null", "list:labels:element",
	"list:id:missing", "list:title:missing", "list:status:missing", "list:priority:string",
	"list:priority:missing",
	"list:issue_type:missing", "list:dependency_count:missing",
	"show:description:number", "show:labels:string", "show:id:identity", "show:updated_at:missing",
]) {
	test(`planning convert refuses malformed present native fields before writes (${mode})`, async () => {
		const trackerRoot = join(scratch, "bad-native-" + mode.replaceAll(":", "-"));
		initializeTracker(trackerRoot);
		createNativeIssue(trackerRoot, "Core8 epic", { externalRef: "core8", type: "epic" });
		const target = createNativeIssue(trackerRoot, "Existing target");
		const plan = writePlan("bad-native-" + mode.replaceAll(":", "-"), [
			{ slug: "new-after-preflight", existing: "(new)" },
			{ slug: "amend-after-preflight", existing: target + " (amend)" },
		]);
		const before = nativeOutput(["list", "--all", "--limit", "0"], trackerRoot);
		const result = await runCli(applyArgs(plan, trackerRoot), nativeShapeFixture(trackerRoot, target, mode));
		expect(result.exitCode).not.toBe(0);
		expect(applyResult(result).overall).toBe("REFUSED");
		expect(nativeOutput(["list", "--all", "--limit", "0"], trackerRoot)).toBe(before);
	});
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
test("planning convert refuses a changed acceptance under an existing token with STALE_ACCEPTANCE", async () => {
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

test("planning convert --amend-acceptance appends changed boxes under the revision gate", async () => {
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

test("planning convert guarded amendment refuses a concurrent target change", async () => {
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

test("planning convert refuses --amend-acceptance without --apply", async () => {
	const dbDir = join(scratch, "amend-flag-db");
	const result = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--dry-run", "--db", dbDir, "--amend-acceptance", "--json"]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
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

// ompkit-fp72.135.3.51: a finished bead stays in the plan; it must never block later intake,
// and it is never written (no amendment, no reopen, no edge from it).
function closeNative(trackerRoot: string, id: string): void {
	nativeOutput(["close", id, "--reason", "fixture: finished before this plan was applied"], trackerRoot);
}

test("apply treats a closed reused target it would not change as satisfied and applies the rest", async () => {
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

test("apply never adds a dependency from a closed target and reports the edge SKIPPED_TERMINAL", async () => {
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

test("apply refuses to amend a closed existing target and writes nothing", async () => {
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

test("apply skips a closed existing target whose plan contribution is already recorded", async () => {
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

test("apply refuses the same closed fixture once its plan acceptance is edited and writes nothing", async () => {
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

test("apply never reopens or writes a tombstoned target", async () => {
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
	expect(convert?.usage).toBe("planning convert --plan PATH --mission M (--dry-run --db DIR | --apply --tracker-root DIR --actor ACTOR) [--yes] [--amend-acceptance] [--json]");
	expect(convert?.flags.map((flag) => flag.name)).toEqual(["--plan", "--mission", "--dry-run", "--db", "--apply", "--tracker-root", "--actor", "--yes", "--amend-acceptance"]);
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

test("noncore public dry-run and native apply preserve mission, actor, amendment, parents and exporter custody", async () => {
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

test("explicit parents do not create a substitute mission epic and reapply without parent changes", async () => {
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
	test("apply refuses missing or malformed explicit actor " + JSON.stringify(actor), async () => {
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
	test("apply refuses exact native target conflict before any write: " + conflict, async () => {
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

test("native amendment context mismatch remains a refusal without retry or acceptance overwrite", async () => {
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

test("native durable creation followed by failure is reconciled, never reported as zero writes", async () => {
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

test("canonical checkbox plans retain scoped coverage and pass canonical admission", async () => {
	const plan = writePlan("canonical-checkbox", [{ slug: "canonical-checkbox", existing: "(new)" }]);
	writeFileSync(plan, readFileSync(plan, "utf8").replaceAll("- [a]", "- [ ] [a]"));
	const dbDir = join(scratch, "canonical-checkbox-db");
	const result = await runCli(["planning", "convert", "--plan", plan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(result.exitCode, result.stdout).toBe(0);
	await requireCanonicalAdmission(dbDir);
});

test("legacy lettered plans are stored as gradeable canonical criteria including the generated parent", async () => {
	const plan = writePlan("legacy-checkbox", [{ slug: "legacy-checkbox", existing: "(new)" }]);
	const dbDir = join(scratch, "legacy-checkbox-db");
	const result = await runCli(["planning", "convert", "--plan", plan, "--mission", "core8", "--dry-run", "--db", dbDir, "--json"]);
	expect(result.exitCode, result.stdout).toBe(0);
	await requireCanonicalAdmission(dbDir);
});

test("canonical acceptance amendment is idempotent and preserves checked progress", async () => {
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

test("canonical scope sets preserve explicit progress while legacy scope x remains a scope", async () => {
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
