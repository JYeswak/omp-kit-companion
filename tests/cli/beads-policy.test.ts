import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { YAML } from "bun";

const repoRoot = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "omp-kit-beads-policy."));
let retired = false;
const cleanup = () => {
	if (retired) return;
	rmSync(scratch, { recursive: true, force: true });
	retired = true;
};
const interrupt = () => {
	cleanup();
	process.exit(130);
};
const terminate = () => {
	cleanup();
	process.exit(143);
};
process.once("exit", cleanup);
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
afterAll(() => {
	cleanup();
	process.off("exit", cleanup);
	process.off("SIGINT", interrupt);
	process.off("SIGTERM", terminate);
});

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
		const gate = gates !== null && typeof gates === "object" && !Array.isArray(gates) && edge in gates ? (gates as Record<string, unknown>)[edge] : undefined;
		const requireAll = gate !== null && typeof gate === "object" && !Array.isArray(gate) && "require_all" in gate && Array.isArray((gate as Record<string, unknown>).require_all)
			? (gate as Record<string, unknown>).require_all as unknown[]
			: [];
		const gated = requireAll.length > 0;
		return { edge, verdict: (gated ? "gated" : "open") as "gated" | "open" };
	});
}
function assertSafePolicy(policyYaml: string): void {
	const openEdges = auditEdges(policyYaml).filter((row) => row.verdict === "open").map((row) => row.edge);
	if (openEdges.length) throw new Error("unsafe close edge(s): " + openEdges.join(", "));
	const parsed: unknown = YAML.parse(policyYaml);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("allow_bypass" in parsed) || parsed.allow_bypass !== false) {
		throw new Error("allow_bypass must be false");
	}
}
test("MP3 template: every status->closed edge is gated or forbidden", () => {
	assertSafePolicy(template);
	expect(Object.fromEntries(auditEdges(template).map((row) => [row.edge, row.verdict]))).toEqual({
		"open -> closed": "gated",
		"in_progress -> closed": "forbidden",
		"in_review -> closed": "gated",
		"rework -> closed": "forbidden",
		"blocked -> closed": "forbidden",
		"deferred -> closed": "forbidden",
	});
});

test("MP3 planted: the in-tree known-bad policy is refused before an unsafe close", () => {
	const lax = template.replace("strict: true", "strict: false");
	expect(() => assertSafePolicy(lax)).toThrow(/open -> closed/);
	const ungated = template.replace('    "open -> closed":\n      require_all:\n        - min_reviewers: 1\n', "");
	expect(() => assertSafePolicy(ungated)).toThrow(/open -> closed/);
	const emptyGate = template.replace('    "open -> closed":\n      require_all:\n        - min_reviewers: 1\n', '    "open -> closed":\n      require_all: []\n');
	expect(() => assertSafePolicy(emptyGate)).toThrow(/open -> closed/);
	const knownBad = readFileSync(join(repoRoot, "tests", "fixtures", "beads-policy", "known-bad.yaml"), "utf8");
	expect(() => assertSafePolicy(knownBad)).toThrow(/open -> closed/);
	const project = scratchTracker(knownBad);
	const id = makeBead(project);
	const unsafeClose = br(project, ["close", id, "-r", "known-bad fixture", "--transition-comment", "known-bad fixture"]);
	expect(unsafeClose.rc, "the planted fixture must demonstrate an unreviewed live close").toBe(0);
}, 60000);

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
		{ cwd: project, encoding: "utf8", input: "", timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, RUST_LOG: "warn" } });
	return { rc: run.status ?? 1, out: String(run.stdout ?? "") };
}

function scratchTracker(policyYaml: string | null): string {
	const probe = spawnSync("br", ["--version"], { encoding: "utf8", input: "", timeout: 10_000 });
	if (probe.status !== 0) throw new Error("MP3 live tests need the br binary on PATH (cli-contracts installs pinned br 0.7.4); refusing to skip silently");
	const project = join(scratch, "proj-" + Math.random().toString(36).slice(2));
	mkdirSync(join(project, ".beads"), { recursive: true });
	const init = spawnSync("br", ["init", "--db", join(project, ".beads", "probe.db"), "--prefix", "t"], {
		cwd: project, encoding: "utf8", input: "", timeout: 30_000,
	});
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
	rmSync(join(project, ".beads", "policy.yaml"));
	expect(readyCount(project)).toBe(withPolicy);
}, 60000);

test("MP3 fallback: provider evidence is recorded and same-pane close remains refused", () => {
	const project = scratchTracker(template);
	const id = makeBead(project);
	const claim = br(project, ["update", id, "--status", "in_progress", "--assignee", "ProbeWorker", "--transition-comment", "claim probe"]);
	expect(claim.rc).toBe(0);
	const marker = br(project, ["update", id, "--add-label", "reviewer-fresh-context:gpt-6-luna"]);
	expect(marker.rc).toBe(0);
	const review = br(project, ["update", id, "--status", "in_review", "--acceptance-criteria", "Review evidence recorded.", "--transition-comment", "Ready for review"]);
	expect(review.rc).toBe(0);
	const provider = "reviewer-fresh-context:gpt-6-luna";
	const gate = br(project, ["gate", "report", id, "--gate", "min_reviewers", "--provider", provider, "--status", "pass", "--to", "closed"]);
	expect(gate.rc).toBe(0);
	const gateRow: unknown = JSON.parse(gate.out);
	expect(gateRow).toMatchObject({ provider, passed: true, to_status: "closed" });
	const guard = (agent: string) => spawnSync("sh", [join(repoRoot, "scripts", "close-guard.sh"), id, "--db", join(project, ".beads", "probe.db")], {
		cwd: project, encoding: "utf8", input: "", timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, RUST_LOG: "warn", AGENT_NAME: agent },
	});
	const samePane = guard("ProbeWorker");
	expect(samePane.status, "a recorded provider must not let the implementer close their own bead").toBe(4);
	expect(samePane.stderr).toMatch(/holds the claim/);
	expect(guard("FreshContextReviewer").status).toBe(0);
	const closed = br(project, ["close", id, "--actor", "FreshContextReviewer", "-r", "fresh-context review", "--transition-comment", "reviewer pass"]);
	expect(closed.rc).toBe(0);
}, 60000);

test("MP3 bypass: every status->closed edge refuses --bypass-policy", () => {
	const project = scratchTracker(template);
	for (const row of auditEdges(template)) {
		const status = row.edge.split(" -> ")[0]!;
		const id = makeBead(project);
		walk(project, id, status);
		const bypassed = br(project, ["close", id, "--reason", "probe bypass", "--transition-comment", "probe", "--bypass-policy", "--bypass-reason", "planted bypass probe"]);
		expect(bypassed.rc, "bypass " + row.edge + " must be refused").not.toBe(0);
		expect(bypassed.out).toMatch(/allow_bypass: false|bypass-policy is disabled/);
	}
}, 60000);

function verifySourceReadyContract(policyYaml: string): void {
	const project = scratchTracker(policyYaml);
	const create = () => {
		const result = br(project, ["create", "--title", "review completion probe", "--actor", "RusticPine"]);
		expect(result.rc).toBe(0);
		const parsed: unknown = JSON.parse(result.out);
		if (!parsed || typeof parsed !== "object" || !("id" in parsed) || typeof parsed.id !== "string")
			throw new Error("br create returned no string id");
		return parsed.id;
	};
	const id = create();
	const readyControl = create();
	expect(br(project, ["update", readyControl, "--acceptance-criteria", "- [ ] Ready control remains available.", "--actor", "RusticPine"]).rc).toBe(0);
	const unfinished = "- [ ] Exercise the consumer and obtain independent verification.";
	expect(br(project, ["update", id, "--status", "in_progress", "--assignee", "RusticPine", "--acceptance-criteria", unfinished, "--transition-comment", "implementation started", "--actor", "RusticPine"]).rc).toBe(0);
	const readyBefore = readyCount(project);
	expect(readyBefore, "the independent open control must be ready before submission").toBe(1);
	const submitted = br(project, ["update", id, "--status", "in_review", "--transition-comment", "implementation ready for independent verification", "--actor", "RusticPine"]);
	expect(submitted, "unchecked acceptance must not prevent its independent review").toMatchObject({ rc: 0 });
	const shown = br(project, ["show", id]);
	expect(shown.rc).toBe(0);
	expect(JSON.parse(shown.out)[0].acceptance_criteria).toBe(unfinished);
	expect(readyCount(project)).toBe(readyBefore);
	expect(br(project, ["gate", "report", id, "--gate", "min_reviewers", "--provider", "reviewer:fixture", "--status", "pass", "--to", "closed", "--actor", "FixtureIndependentReviewer"]).rc).toBe(0);
	const premature = br(project, ["close", id, "--reason", "fixture attempts incomplete closure", "--transition-comment", "review report alone is insufficient", "--actor", "RusticPine"]);
	expect(premature.rc, "a reviewer report must not bypass incomplete acceptance").not.toBe(0);
	expect(br(project, ["update", id, "--acceptance-criteria", unfinished.replace("[ ]", "[x]"), "--actor", "RusticPine"]).rc).toBe(0);
	expect(br(project, ["gate", "report", id, "--gate", "min_reviewers", "--provider", "reviewer:fixture", "--status", "pass", "--to", "closed", "--actor", "FixtureIndependentReviewer"]).rc).toBe(0);
	for (const { agent, expected } of [{ agent: "RusticPine", expected: 4 }, { agent: "FixtureCloser", expected: 0 }]) {
		const verdict = spawnSync("sh", [join(repoRoot, "scripts", "close-guard.sh"), id, "--db", join(project, ".beads", "probe.db")], {
			cwd: project, encoding: "utf8", input: "", timeout: 30_000,
			env: { ...process.env, RUST_LOG: "warn", AGENT_NAME: agent },
		});
		expect(verdict.status, "complete acceptance must preserve the implementer/reviewer distinction").toBe(expected);
		if (expected === 4) expect(verdict.stderr).toContain("holds the claim");
	}
	const closed = br(project, ["close", id, "--reason", "all original criteria verified by distinct reviewer", "--transition-comment", "independent completion control", "--actor", "FixtureCloser"]);
	expect(closed.rc, closed.out).toBe(0);
	const final = br(project, ["show", id]);
	expect(final.rc).toBe(0);
	expect(JSON.parse(final.out)[0].status).toBe("closed");

	const empty = create();
	const emptyClaim = br(project, ["update", empty, "--status", "in_progress", "--transition-comment", "empty contract control", "--actor", "RusticPine"]);
	const emptyReview = emptyClaim.rc === 0
		? br(project, ["update", empty, "--status", "in_review", "--transition-comment", "must refuse missing contract", "--actor", "RusticPine"])
		: emptyClaim;
	expect(emptyReview.rc, "an empty contract must not reach review, even when claim checks it earlier").toBe(4);
	expect(JSON.parse(emptyReview.out)).toMatchObject({
		error: {
			code: "POLICY_VIOLATION",
			context: {
				violations: expect.arrayContaining([
					expect.objectContaining({
						detail: expect.objectContaining({ required_field: "acceptance_criteria_present" }),
					}),
				]),
			},
		},
	});
}

const sourceReadyPolicy = process.env.OMP_KIT_BEADS_POLICY_FIXTURE
	? readFileSync(process.env.OMP_KIT_BEADS_POLICY_FIXTURE, "utf8")
	: template;

test("source-ready review preserves unfinished acceptance and ready supply; verified completion closes", () => {
	verifySourceReadyContract(sourceReadyPolicy);
}, 60000);

test("source-ready planted missing close completeness fails the same native consumer check", () => {
	const missingCompleteness = sourceReadyPolicy.replace(
		"closed: [acceptance_criteria, transition_comment]",
		"closed: [transition_comment]",
	);
	expect(() => verifySourceReadyContract(missingCompleteness)).toThrow(
		"a reviewer report must not bypass incomplete acceptance",
	);
}, 60000);
