// mission anchor (ompkit-fp72.9 ANCHOR1): the live-doc Mission statement is the human
// source of truth for wording; .omp/mission.toml is the machine record. Planted
// negatives: every disagreement shape reports DRIFT, never AGREE.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { missionAnchorStatus } from "../../src/mission.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const scratch = mkdtempSync(join(scratchRoot, `mission-anchor-test.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=mission-anchor-test repo=${repoRoot} created=${new Date().toISOString()}\n`);

const CHECK_PATH = "scripts/mission-check.ts";
const CHECK_COMMAND = "omp-kit heavy -- bun scripts/mission-check.ts --pillar learning";
const IDENTITY = "Fixture mission guards the fleet with measured rules.";

function fixture(label: string, doc: string | null, identity: string = IDENTITY): string {
	const root = join(scratch, label);
	mkdirSync(join(root, ".omp"), { recursive: true });
	mkdirSync(join(root, "scripts"), { recursive: true });
	const checkSource = `import { writeFileSync } from "node:fs";\n`;
	writeFileSync(join(root, CHECK_PATH), checkSource);
	const source = `identity = ${JSON.stringify(identity)}\nstage = "test"\ndone_rule = "Checks pass."\napproved_by = "Joshua"\napproved_at = "2026-10-04"\napproval_quote = "approved"\nnot_in_mission = ["unrelated work"]\nproduct_paths = ["src/**"]\npillar_ids = ["learning"]\n\n[cadence]\ndaily = "run checks"\nweekly = "review"\nexit = "all green"\n\n[blast_radius]\nbinaries = ["fixture"]\npaths = ["src"]\nsessions = ["fixture"]\n\n[[pillar]]\nid = "learning"\nclause = "learning check"\ncheck = ${JSON.stringify(CHECK_COMMAND)}\ncheck_path = ${JSON.stringify(CHECK_PATH)}\ncheck_sha256 = "${digest(checkSource)}"\ncheck_command_sha256 = "${digest(CHECK_COMMAND)}"\n`;
	writeFileSync(join(root, ".omp/mission.toml"), source);
	if (doc !== null) writeFileSync(join(root, "ROADMAP.md"), doc);
	return root;
}

const AGREE_DOC = `# Roadmap\n\n## Mission (approved by the maintainer, 2026-10-04)\n\n${IDENTITY}\n\n## Next\n`;
const NO_APPROVAL_DOC = `# Roadmap\n\n## Mission\n\n${IDENTITY}\n`;
const NO_HEADING_DOC = `# Roadmap\n\n${IDENTITY}\n`;

test("agree: matching doc statement and valid record", () => {
	const status = missionAnchorStatus(fixture("agree", AGREE_DOC));
	expect(status.verdict).toBe("AGREE");
	expect(status.details).toEqual([]);
	expect(status.wordingAgrees).toBe(true);
	expect(status.record?.overall).toBe("VALID");
});

test("planted: wording drift (record identity absent from the doc) reports DRIFT", () => {
	const status = missionAnchorStatus(fixture("wording", AGREE_DOC, "A different mission nobody wrote down."));
	expect(status.verdict).toBe("DRIFT");
	expect(status.details).toContain("ANCHOR_WORDING_DRIFT");
});

test("planted: missing doc reports DRIFT, never AGREE", () => {
	const status = missionAnchorStatus(fixture("nodoc", null));
	expect(status.verdict).toBe("DRIFT");
	expect(status.details).toContain("ANCHOR_DOC_MISSING");
	expect(status.wordingAgrees).toBeNull();
});
test("planted: toml-declared doc file that does not exist reports DOC_MISSING", () => {
	const root = fixture("declaredmissing", AGREE_DOC);
	writeFileSync(join(root, ".omp/mission.toml"), "# Human text: GONE.md\n", { flag: "a" });
	rmSync(join(root, "ROADMAP.md"));
	const status = missionAnchorStatus(root);
	expect(status.verdict).toBe("DRIFT");
	expect(status.details).toContain("ANCHOR_DOC_MISSING");
});

test("planted: doc without a Mission heading or approval reports DRIFT", () => {
	const noHeading = missionAnchorStatus(fixture("noheading", NO_HEADING_DOC));
	expect(noHeading.verdict).toBe("DRIFT");
	expect(noHeading.details).toContain("ANCHOR_DOC_NO_MISSION_HEADING");
	const noApproval = missionAnchorStatus(fixture("noapproval", NO_APPROVAL_DOC));
	expect(noApproval.verdict).toBe("DRIFT");
	expect(noApproval.details).toContain("ANCHOR_DOC_APPROVAL_MISSING");
});

test("planted: invalid record reports DRIFT with the record status", () => {
	const root = fixture("badtoml", AGREE_DOC);
	writeFileSync(join(root, ".omp/mission.toml"), "identity = \n");
	const status = missionAnchorStatus(root);
	expect(status.verdict).toBe("DRIFT");
	expect(status.details.some(detail => detail.startsWith("ANCHOR_RECORD_"))).toBe(true);
});

test("planted: nothing present reports DRIFT, never AGREE", () => {
	const root = join(scratch, "empty");
	mkdirSync(root, { recursive: true });
	const status = missionAnchorStatus(root);
	expect(status.verdict).toBe("DRIFT");
	expect(status.details).toContain("ANCHOR_DOC_MISSING");
});

test("anchor heading and approval patterns: required match, rejects, bounded near-miss", () => {
	const ok = missionAnchorStatus(fixture("patterns", "# T\n\n### Mission (approved by J, 2026-01-01)\n\n" + IDENTITY + "\n"));
	expect(ok.doc.heading).toBe("### Mission (approved by J, 2026-01-01)");
	expect(ok.doc.approved).toBe(true);
	const plural = missionAnchorStatus(fixture("plural", "# T\n\n## Missions\n\n" + IDENTITY + "\n"));
	expect(plural.doc.heading).toBeNull();
	const deep = missionAnchorStatus(fixture("deep", "# T\n\n#### Mission\n\n" + IDENTITY + "\n"));
	expect(deep.doc.heading).toBeNull();
	const nearMiss = missionAnchorStatus(fixture("nearmiss", "# T\n\n## Mission\n\n" + IDENTITY + "\n" + `x ${"a-".repeat(50_000)}y\n`));
	const started = performance.now();
	expect(nearMiss.verdict).toBe("DRIFT");
	expect(nearMiss.details).toContain("ANCHOR_DOC_APPROVAL_MISSING");
	expect(performance.now() - started).toBeLessThan(500);
});
