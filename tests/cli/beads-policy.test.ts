import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { YAML } from "bun";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "beads-policy-test." + process.pid + "."));
writeFileSync(join(scratch, ".owner"), "pid=" + process.pid + " label=beads-policy-test repo=" + repoRoot + " created=" + new Date().toISOString() + "\n");

const template = readFileSync(join(repoRoot, "config", "beads-policy.template.yaml"), "utf8");

type EdgeVerdict = { edge: string; verdict: "gated" | "forbidden" | "open" };

function auditEdges(policyYaml: string): EdgeVerdict[] {
	const parsed: unknown = YAML.parse(policyYaml);
	if (!parsed || typeof parsed !== "object" || !("workflow" in parsed)) return [];
	const workflow: unknown = parsed.workflow;
	if (!workflow || typeof workflow !== "object" || !("statuses" in workflow) || !Array.isArray(workflow.statuses)) return [];
	const statuses = workflow.statuses.filter((status): status is string => typeof status === "string");
	if (!("strict" in workflow) || workflow.strict !== true) {
		return statuses.filter((status) => status !== "closed").map((status) => ({ edge: status + " -> closed", verdict: "open" as const }));
	}
	const transitionTable: Array<[string, unknown]> = "transitions" in workflow && workflow.transitions !== null && typeof workflow.transitions === "object"
		? Object.entries(workflow.transitions)
		: [];
	const gates: unknown = "gates" in workflow ? workflow.gates : {};
	return statuses.filter((status) => status !== "closed").map((status) => {
		const edge = status + " -> closed";
		const targets: unknown = transitionTable.find(([name]) => name === status)?.[1];
		if (!Array.isArray(targets) || !targets.includes("closed")) return { edge, verdict: "forbidden" as const };
		const gated = gates !== null && typeof gates === "object" && edge in gates;
		return { edge, verdict: (gated ? "gated" : "open") as "gated" | "open" };
	});
}

test("MP3 template: every status->closed edge is gated or forbidden", () => {
	expect(Object.fromEntries(auditEdges(template).map((row) => [row.edge, row.verdict]))).toEqual({
		"open -> closed": "gated",
		"in_progress -> closed": "forbidden",
		"in_review -> closed": "gated",
		"rework -> closed": "forbidden",
		"blocked -> closed": "forbidden",
		"deferred -> closed": "forbidden",
	});
});

test("MP3 planted: template without strict, or missing one gate, reports the open edge", () => {
	const lax = template.replace("strict: true", "strict: false");
	expect(auditEdges(lax).filter((row) => row.verdict === "open").map((row) => row.edge).sort()).toEqual(
		["blocked -> closed", "deferred -> closed", "in_progress -> closed", "in_review -> closed", "open -> closed", "rework -> closed"],
	);
	const ungated = template.replace('    "open -> closed":\n      require_all:\n        - min_reviewers: 1\n', "");
	expect(Object.fromEntries(auditEdges(ungated).map((row) => [row.edge, row.verdict]))["open -> closed"]).toBe("open");
});

function br(project: string, args: string[]): { rc: number; out: string } {
	const db = join(project, ".beads", "probe.db");
	const run = spawnSync("br", [...args, "--db", db, "--json", "--no-auto-import"],
		{ cwd: project, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, RUST_LOG: "warn" } });
	return { rc: run.status ?? 1, out: String(run.stdout ?? "") };
}

function scratchTracker(policyYaml: string | null): string {
	const probe = spawnSync("br", ["--version"], { encoding: "utf8" });
	if (probe.status !== 0) throw new Error("MP3 live tests need the br binary on PATH (cli-contracts installs pinned br 0.7.4); refusing to skip silently");
	const project = join(scratch, "proj-" + Math.random().toString(36).slice(2));
	mkdirSync(join(project, ".beads"), { recursive: true });
	const init = spawnSync("br", ["init", "--db", join(project, ".beads", "probe.db"), "--prefix", "t"], { cwd: project, encoding: "utf8" });
	expect(init.status).toBe(0);
	if (policyYaml !== null) writeFileSync(join(project, ".beads", "policy.yaml"), policyYaml);
	return project;
}

function makeBead(project: string): string {
	const created = br(project, ["create", "--title", "edge probe bead"]);
	expect(created.rc).toBe(0);
	const parsed: unknown = JSON.parse(created.out);
	if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string") throw new Error("br create returned no string id");
	return parsed.id;
}

function walk(project: string, id: string, status: string): void {
	if (status === "open") return;
	const path: Record<string, string[]> = {
		in_progress: ["in_progress"],
		in_review: ["in_progress", "in_review"],
		rework: ["in_progress", "in_review", "rework"],
		blocked: ["blocked"],
		deferred: ["deferred"],
	};
	for (const step of path[status] ?? []) {
		const args = ["update", id, "--status", step, "--transition-comment", "probe places bead for edge test"];
		if (step === "in_review") args.push("--acceptance-criteria", "Probe outcome is recorded.");
		const moved = br(project, args);
		expect({ step, rc: moved.rc, out: moved.out.slice(0, 200) }).toMatchObject({ step, rc: 0 });
	}
}

function readyCount(project: string): number {
	const ready = br(project, ["ready"]);
	expect(ready.rc).toBe(0);
	const parsed: unknown = JSON.parse(ready.out);
	if (!Array.isArray(parsed)) throw new Error("br ready returned no array");
	return parsed.length;
}

test("MP3 live: close from every status is refused; a reviewer pass closes", () => {
	const project = scratchTracker(template);
	for (const status of ["open", "in_progress", "in_review", "rework", "blocked", "deferred"]) {
		const id = makeBead(project);
		walk(project, id, status);
		const closed = br(project, ["close", id, "-r", "probe close", "--transition-comment", "probe attempts close"]);
		expect(closed.rc, "close from " + status + " must be refused").not.toBe(0);
		expect(closed.out).toMatch(/POLICY_VIOLATION|VALIDATION_FAILED/);
	}
	const id = makeBead(project);
	walk(project, id, "in_review");
	const reported = br(project, ["gate", "report", id, "--gate", "min_reviewers", "--provider", "reviewer:probe", "--status", "pass", "--to", "closed"]);
	expect(reported.rc).toBe(0);
	expect(br(project, ["close", id, "-r", "probe close", "--transition-comment", "probe attempts close"]).rc).toBe(0);
}, 60000);

test("MP3 live: ready counts are unchanged by the policy file", () => {
	const project = scratchTracker(template);
	makeBead(project);
	makeBead(project);
	const withPolicy = readyCount(project);
	const removed = spawnSync("rm", [join(project, ".beads", "policy.yaml")]);
	expect(removed.status).toBe(0);
	expect(readyCount(project)).toBe(withPolicy);
}, 60000);
