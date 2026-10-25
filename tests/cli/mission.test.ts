import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { validateMissionRecord } from "../../src/mission.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = ownedTmp("mission-test", { root: scratchRoot }).path;
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

test("a fully registered record validates without claiming check quality (the record lives with the tracker, not in this product repo)", () => {
	const report = validateMissionRecord(fixture("registered"));
	expect(report.overall).toBe("VALID");
	expect(report.pillars.map(pillar => [pillar.id, pillar.status])).toEqual([["learning", "REGISTERED"]]);
	expect(report.no_claim).toContain("measurement quality is not established");
	// MEASUREREG1: this repo ships no .omp/mission.toml of its own; the mission record is a per-project file.
	expect(validateMissionRecord(repoRoot).overall).not.toBe("VALID");
});

// MEASUREREG1 (ompkit-fp72.135.3.1): the fleet's registered checks are `python3 scripts/measure.py --pillar <id> --json`;
// `heavy` is an optional prefix, `--json` an optional suffix. Planted: a shell suffix or another runner stays unregistered.
function withCheck(label: string, command: string) {
	const root = fixture(label);
	const missionPath = join(root, ".omp/mission.toml");
	let mission = readFileSync(missionPath, "utf8");
	mission = mission.replace(`check = ${JSON.stringify(CHECK_COMMAND)}`, `check = ${JSON.stringify(command)}`);
	mission = mission.replace(digest(CHECK_COMMAND), digest(command));
	writeFileSync(missionPath, mission);
	return validateMissionRecord(root);
}

test("MEASUREREG1: a python3 single-runner check with --json and no heavy prefix registers", () => {
	expect(withCheck("py-runner", "python3 scripts/mission-check.ts --pillar learning --json").pillars[0]).toMatchObject({ status: "REGISTERED" });
	expect(withCheck("py-runner-heavy", "omp-kit heavy -- python3 scripts/mission-check.ts --pillar learning").pillars[0]).toMatchObject({ status: "REGISTERED" });
});

test("MEASUREREG1 planted: a shell suffix, another runner, or a mismatched pillar stays UNREGISTERED", () => {
	expect(withCheck("py-suffix", "python3 scripts/mission-check.ts --pillar learning --json; echo x").pillars[0]).toMatchObject({ status: "UNREGISTERED", reason: "CHECK_COMMAND_UNSUPPORTED" });
	expect(withCheck("node-runner", "node scripts/mission-check.ts --pillar learning").pillars[0]).toMatchObject({ status: "UNREGISTERED", reason: "CHECK_COMMAND_UNSUPPORTED" });
	expect(withCheck("py-wrong-pillar", "python3 scripts/mission-check.ts --pillar other --json").pillars[0]).toMatchObject({ status: "UNREGISTERED", reason: "CHECK_COMMAND_REGISTRATION_MISMATCH" });
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
	const valid = runMissionCli(fixture("cli-registered"));
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
