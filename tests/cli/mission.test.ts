import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { validateMissionRecord } from "../../src/mission.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, `mission-test.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid} label=mission-test repo=${repoRoot} created=${new Date().toISOString()}\n`);
const CHECK_PATH = "scripts/mission-check.ts";
const CHECK_COMMAND = "omp-kit heavy -- bun scripts/mission-check.ts --pillar learning";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fixture(label: string): string {
	const root = join(scratch, label);
	mkdirSync(join(root, ".omp"), { recursive: true });
	mkdirSync(join(root, "scripts"), { recursive: true });
	const checkSource = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "spawn-marker"))}, "executed");\n`;
	writeFileSync(join(root, CHECK_PATH), checkSource);
	const source = `identity = "Fixture mission"\nstage = "test"\ndone_rule = "Checks pass on the wired path."\napproved_by = "Joshua"\napproved_at = "2026-10-04"\napproval_quote = "approved"\nnot_in_mission = ["unrelated work"]\nproduct_paths = ["src/**"]\npillar_ids = ["learning"]\n\n[cadence]\ndaily = "run checks"\nweekly = "review"\nexit = "all green"\n\n[blast_radius]\nbinaries = ["fixture"]\npaths = ["src"]\nsessions = ["fixture"]\n\n[[pillar]]\nid = "learning"\nclause = "learning check"\ncheck = ${JSON.stringify(CHECK_COMMAND)}\ncheck_path = ${JSON.stringify(CHECK_PATH)}\ncheck_sha256 = "${digest(checkSource)}"\ncheck_command_sha256 = "${digest(CHECK_COMMAND)}"\n`;
	writeFileSync(join(root, ".omp/mission.toml"), source);
	return root;
}

test("omp-kit mission record is fully registered without claiming check quality", () => {
	const report = validateMissionRecord(repoRoot);
	expect(report.overall).toBe("VALID");
	expect(report.pillars.map(pillar => [pillar.id, pillar.status, pillar.sha256])).toEqual([
		["current", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
		["loaded", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
		["proven", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
		["measured", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
		["learning", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
		["shareable", "REGISTERED", "3001d59a2fdc10613a00a24e9e5ae9acb7e81ae677cdbf382fb6f40003c8fa72"],
	]);
	expect(report.no_claim).toContain("measurement quality is not established");
});

test("a changed check command is unregistered and never launches its planted child", () => {
	const root = fixture("changed-command");
	const missionPath = join(root, ".omp/mission.toml");
	const original = readFileSync(missionPath, "utf8");
	writeFileSync(missionPath, original.replace("--pillar learning", "--pillar learninx"));
	const report = validateMissionRecord(root);
	expect(report.overall).toBe("UNREGISTERED");
	expect(report.pillars[0]).toMatchObject({ status: "UNREGISTERED" });
	expect(() => readFileSync(join(root, "spawn-marker"))).toThrow();
});

test("missing approval quote and unknown pillar IDs fail validation", () => {
	const missingApproval = fixture("missing-approval");
	const approvalPath = join(missingApproval, ".omp/mission.toml");
	writeFileSync(approvalPath, readFileSync(approvalPath, "utf8").replace('approval_quote = "approved"\n', ""));
	const missingReport = validateMissionRecord(missingApproval);
	expect(missingReport.overall).toBe("INVALID");
	expect(missingReport.errors).toContain("MISSION_FIELD_REQUIRED:approval_quote");

	const unknownPillar = fixture("unknown-pillar");
	const pillarPath = join(unknownPillar, ".omp/mission.toml");
	let mission = readFileSync(pillarPath, "utf8");
	mission = mission.replace('id = "learning"', 'id = "not-real"');
	mission = mission.replace(CHECK_COMMAND, "omp-kit heavy -- bun scripts/mission-check.ts --pillar not-real");
	mission = mission.replace(digest(CHECK_COMMAND), digest("omp-kit heavy -- bun scripts/mission-check.ts --pillar not-real"));
	writeFileSync(pillarPath, mission);
	const unknownReport = validateMissionRecord(unknownPillar);
	expect(unknownReport.overall).toBe("INVALID");
	expect(unknownReport.errors).toContain("MISSION_PILLAR_ID_UNKNOWN:not-real");
});

test("a missing pillar check makes the record invalid", () => {
	const root = fixture("missing-check");
	const missionPath = join(root, ".omp/mission.toml");
	writeFileSync(missionPath, readFileSync(missionPath, "utf8").replace(`check = ${JSON.stringify(CHECK_COMMAND)}`, 'check = ""'));
	const report = validateMissionRecord(root);
	expect(report.overall).not.toBe("VALID");
	expect(report.errors).toContain("MISSION_PILLAR_CHECK_MISSING:learning");
});

function runMissionCli(projectRoot: string) {
	return Bun.spawnSync([process.execPath, resolve(import.meta.dir, "../../src/cli.ts"), "mission", "validate",
		"--project", projectRoot, "--json"], { cwd: projectRoot, stdout: "pipe", stderr: "pipe" });
}

test("mission validate CLI reports registration and rejects an unknown pillar without running checks", () => {
	const valid = runMissionCli(repoRoot);
	expect(valid.exitCode).toBe(0);
	const validEnvelope = JSON.parse(valid.stdout.toString());
	expect(validEnvelope.data.overall).toBe("VALID");
	expect(validEnvelope.data.pillars.every((pillar: { status: string }) => pillar.status === "REGISTERED")).toBe(true);
	expect(validEnvelope.data.no_claim).toContain("measurement quality is not established");

	const root = fixture("cli-unknown-pillar");
	const missionPath = join(root, ".omp/mission.toml");
	let mission = readFileSync(missionPath, "utf8");
	mission = mission.replace('id = "learning"', 'id = "not-real"');
	mission = mission.replace(CHECK_COMMAND, "omp-kit heavy -- bun scripts/mission-check.ts --pillar not-real");
	mission = mission.replace(digest(CHECK_COMMAND), digest("omp-kit heavy -- bun scripts/mission-check.ts --pillar not-real"));
	writeFileSync(missionPath, mission);
	const invalid = runMissionCli(root);
	expect(invalid.exitCode).toBe(1);
	const invalidEnvelope = JSON.parse(invalid.stdout.toString());
	expect(invalidEnvelope.data.overall).toBe("INVALID");
	expect(invalidEnvelope.data.errors).toContain("MISSION_PILLAR_ID_UNKNOWN:not-real");
	expect(() => readFileSync(join(root, "spawn-marker"))).toThrow();
});
