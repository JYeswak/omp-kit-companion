// Coverage: src/commands.ts, src/cli.ts, src/kitlib/tmp.ts, src/kitlib/run.ts, scripts/bead_lint.py
import { test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { run, runSync } from "../../src/kitlib/run.ts";
export type ApplyPlanItem = { slug: string; existing: string; dependsOn?: string[]; parent?: string };
export function planningFixture() {
const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("planning-convert-test", { root: scratchRoot }).path;
const cli = join(repoRoot, "src", "cli.ts");
const validPlan = join(import.meta.dir, "../fixtures/planning-convert/valid.md");
const negativePlan = join(import.meta.dir, "../fixtures/planning-convert/negative.md");
const childEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };

// A serial case between groups drains Bun's concurrent queue. Keep at most
// three private trackers active, without extending any existing test deadline.
let registeredCases = 0;
function isolatedTest(name: string, body: () => void | Promise<void>, timeout?: number) {
	const register = ++registeredCases % 4 === 0 ? test : test.concurrent;
	register(name, body, timeout);
}

type CliRunResult = { exitCode: number; stdout: string; stderr: string };

async function runCli(args: string[], overrides: Record<string, string> = {}): Promise<CliRunResult> {
	const result = await run([process.execPath, cli, ...args], { cwd: repoRoot, env: { ...childEnv, ...overrides }, deadline_s: 120 });
	const stdout = Buffer.from(result.stdout).toString(), stderr = Buffer.from(result.stderr).toString();
	if (!stdout.trim()) throw new Error("planning convert returned no stdout; stderr=" + stderr);
	if (result.rc === null) throw new Error("planning convert was not reaped");
	return { exitCode: result.rc, stdout, stderr };
}

function nativeOutput(args: string[], dbDir: string): string {
	const result = runSync(["br", ...args, "--db", join(dbDir, ".beads", "beads.db"), "--no-auto-import", "--no-auto-flush", "--no-daemon", "--json", "--no-color"], {
		cwd: dbDir, env: childEnv, deadline_s: 30,
	});
	if (result.rc !== 0) throw new Error("br command failed: " + Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString());
	return Buffer.from(result.stdout).toString();
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

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function concurrentWriteFixture(trackerRoot: string, targetId: string): Record<string, string> {
	const resolved = resolveRealBr(process.env.PATH);
	if (!resolved.ok) throw new Error(resolved.reason);
	const realBr = resolved.path;
	const bin = join(trackerRoot, "concurrent-bin");
	mkdirSync(bin, { recursive: true });
	const sentinel = join(bin, "tripped");
	const injection = join(bin, "inject.ts");
	writeFileSync(join(bin, "br"), `#!/bin/sh\nif [ "$1" = update ]; then exec ${shellQuote(process.execPath)} ${shellQuote(injection)} "$@"; fi\nexec ${shellQuote(realBr)} "$@"\n`, { mode: 0o755 });
	writeFileSync(injection, `#!/usr/bin/env bun
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
	const resolved = resolveRealBr(process.env.PATH);
	if (!resolved.ok) throw new Error(resolved.reason);
	const realBr = resolved.path;
	const bin = join(trackerRoot, "shape-bin");
	mkdirSync(bin, { recursive: true });
	const wrapper = join(bin, "br");
	const injection = join(bin, "shape.ts");
	writeFileSync(wrapper, `#!/bin/sh\ncase "$1" in list|show) exec ${shellQuote(process.execPath)} ${shellQuote(injection)} "$@" ;; esac\nexec ${shellQuote(realBr)} "$@"\n`, { mode: 0o755 });
	writeFileSync(injection, `#!/usr/bin/env bun
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

return { repoRoot, scratch, cli, validPlan, negativePlan, childEnv, isolatedTest, runCli, nativeOutput, nativeJson, issueRows, median, planSource, writePlan, initializeTracker, createNativeIssue, showNativeIssue, applyResult, applyArgs, amendPlanSource, writeAmendPlan, amendAcceptanceV1, amendAcceptanceV2, concurrentWriteFixture, nativeShapeFixture };
}
