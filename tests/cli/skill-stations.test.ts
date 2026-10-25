import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { applicableSkills, evaluateSkillDetector, parseSkillStations, skillStationReport } from "../../src/skill-stations.ts";

function patch(path: string, before: string, after: string) {
	const oldLines = before ? before.trimEnd().split("\n") : [];
	const newLines = after ? after.trimEnd().split("\n") : [];
	return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
		`@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`,
		...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`), ""].join("\n");
}

// Exact content of the supplied planted-bad.toml (kept inline: no scratch dependency).
const plantedBad = `# Intentionally invalid data. Four independent contract violations are expected:
# nonexistent skill, mandatory without rule, empty detector, repeated station/trigger.
schema_version = 1

[[row]]
station = "G1"
trigger = "planted-bad-row"
detector = ""
skills = ["skillstation-planted-does-not-exist-20261025"]
artifact = "Synthetic bad input; never application evidence."
mandatory = true
skill_source = "planted-bad.toml"

[[row]]
station = "G1"
trigger = "planted-bad-row"
detector = "Synthetic duplicate key; rejection is required."
skills = ["regex-engineering"]
artifact = "Synthetic duplicate; never application evidence."
mandatory = false
skill_source = "regex-engineering/SKILL.md:1-30"
`;

test("canonical map validates; missing local skills are warnings, never fatal", () => {
	const map = parseSkillStations();
	expect(map.errors).toEqual([]);
	expect(map.rows.filter(row => row.mandatory).every(row => Boolean(row.rule?.trim()))).toBe(true);
	const absent = parseSkillStations(undefined, "/nonexistent-skillstation-root");
	expect(absent.errors).toEqual([]);
	expect(absent.warnings).toContain("row[1]: MISSING_SKILL requirements-gathering");
});

test("supplied planted bad map is rejected with all four diagnostics", () => {
	const tmp = ownedTmp("skillstation-validation");
	try {
		mkdirSync(join(tmp.path, "regex-engineering"));
		writeFileSync(join(tmp.path, "regex-engineering", "SKILL.md"), "fixture installed skill\n");
		const result = parseSkillStations(plantedBad, tmp.path);
		expect(result.errors).toEqual([
			"row[1]: detector must be nonempty text",
			"row[1]: MISSING_RULE mandatory row needs rule citation",
			'row[2]: DUPLICATE station/trigger ["G1","planted-bad-row"]',
		]);
		expect(result.warnings).toEqual(["row[1]: MISSING_SKILL skillstation-planted-does-not-exist-20261025"]);
	} finally { tmp.cleanup(); }
});

test("added or changed literal regex mandates native regex engineering review", () => {
	for (const [before, after] of [["", "const pattern = /^[a-z]+$/u;"], ["const pattern = /old/;", "const pattern = /new/i;"], ["", String.raw`const pattern = /[/\\]/g;`],
		["", "const matched = text.match(/nested/g);"], ["", "function check() { return /result/i; }"], ["", "/standalone/.test(input);"]]) {
		const rows = applicableSkills(["src/check.ts"], patch("src/check.ts", before!, after!));
		expect(rows).toContainEqual({ skill: "regex-engineering", station: "Execute", mandatory: true, trigger: "regex-pattern-or-regex-command-changed", why: "src/check.ts: changed literal regex" });
	}
});

test("strings, escaped quotes, comments, division, malformed and template code never invent regex matches", () => {
	for (const source of [
		`const example = "pattern = /not-a-regex/";`,
		String.raw`const example = "escaped \" = /still-string/";`,
		"/* nested-looking { pattern = /comment/ } */ const x = 1;",
		"// pattern = /comment/\nconst x = 1;",
		"const ratio = a / b;",
		"const pattern = /accepted/; this is invalid junk !!!",
		"const template = `pattern = /not-code/`;",
	]) expect(applicableSkills(["src/check.ts"], patch("src/check.ts", "", source)).some(row => row.skill === "regex-engineering")).toBe(false);
});

test("adding a package bin string or object mandates ergonomics review; unrelated version edits do not", () => {
	const path = "packages/tool/package.json";
	for (const bin of ["cli.js", { tool: "cli.js" }]) {
		const rows = applicableSkills([path], patch(path, '{"name":"tool"}', JSON.stringify({ name: "tool", bin })));
		expect(rows.find(row => row.skill === "agent-ergonomics-and-intuitiveness-maximization-for-cli-tools")?.mandatory).toBe(true);
	}
	expect(applicableSkills([path], patch(path, '{"bin":"cli.js","version":"1"}', '{"bin":"cli.js","version":"2"}')).some(row => row.mandatory)).toBe(false);
});

test("docs-only change yields advisory prose review and no mandatory matches", () => {
	const rows = applicableSkills(["docs/guide.md"], patch("docs/guide.md", "# Before", "# After\nExample = /not-executable/"));
	expect(rows.filter(row => row.mandatory)).toEqual([]);
	expect(rows.map(row => row.skill)).toContain("de-slopify");
});

test("undecidable timing/intent stays UNKNOWN and is surfaced, not an exemption", () => {
	const row = parseSkillStations().rows.find(row => row.trigger === "performance-work-order-active");
	if (!row) throw Error("missing performance detector");
	expect(evaluateSkillDetector(row, ["src/fast.ts"], "").status).toBe("UNKNOWN");
	expect(skillStationReport(["src/fast.ts"], "").warnings.some(warning => warning.startsWith("UNKNOWN Execute/performance-work-order-active:"))).toBe(true);
});

test("a source-looking filename or partial hunk is insufficient evidence", () => {
	const row = parseSkillStations().rows.find(row => row.trigger === "regex-pattern-or-regex-command-changed");
	if (!row) throw Error("missing regex detector");
	const partial = patch("src/check.ts", "", "const pattern = /yes/;").replace("@@ -0,0 +1,1 @@", "@@ -90,0 +90,1 @@");
	expect(evaluateSkillDetector(row, ["src/check.ts"], partial).status).toBe("UNKNOWN");
	expect(applicableSkills(["docs/guide.md"], patch("src/check.ts", "", "const pattern = /yes/;"))).not.toContainEqual(expect.objectContaining({ skill: "regex-engineering" }));
});
