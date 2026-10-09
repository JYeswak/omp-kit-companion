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

function runCli(args: string[]) {
	const child = Bun.spawn([process.execPath, cli, ...args], { cwd: repoRoot, env: childEnv, stdout: "pipe", stderr: "pipe" });
	return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(([exitCode, stdout, stderr]) => {
		if (!stdout.trim()) throw new Error("planning convert returned no stdout; stderr=" + stderr);
		return { exitCode, stdout, stderr };
	});
}

function nativeOutput(args: string[], dbDir: string): string {
	const result = Bun.spawnSync(["br", ...args, "--db", join(dbDir, "beads.db"), "--no-auto-import", "--no-auto-flush", "--no-daemon", "--json", "--no-color"], {
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

test("planning convert is a public dry-run command with the required explicit flags", () => {
	const planning = COMMANDS.find((command) => command.name === "planning");
	const convert = planning?.subcommands?.find((command) => command.name === "convert");
	expect(convert?.usage).toBe("planning convert --plan PATH --mission M --dry-run --db DIR [--json]");
	expect(convert?.flags.map((flag) => flag.name)).toEqual(["--plan", "--mission", "--dry-run", "--db"]);
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

test("missing --dry-run refuses before creating the requested database directory", async () => {
	const dbDir = join(scratch, "no-dry-run-db");
	const result = await runCli(["planning", "convert", "--plan", validPlan, "--mission", "core8", "--db", dbDir, "--json"]);
	expect(result.exitCode).not.toBe(0);
	expect(JSON.parse(result.stdout).data.overall).toBe("NOT_RUN");
	expect(existsSync(dbDir)).toBe(false);
});
