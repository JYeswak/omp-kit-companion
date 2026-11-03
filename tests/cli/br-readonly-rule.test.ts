import { expect, test } from "bun:test";
import { loadRuleFile } from "../../scripts/rule-class.ts";

const rule = loadRuleFile("rules/kit-br-readonly-unsupported.md").rule;
const fires = (input: string) => (rule.condition ?? []).some(pattern => new RegExp(pattern).test(input));

// Literal argv from DAILYCLASSES inventory row 33 (the timeout label was wrong).
const bad = ["br", "--readonly", "--no-auto-import", "show", "cfs-twenty-app-portfolio-hgub5.56.8", "--json"];
test("br unsupported --readonly: actual Python argv fires; corrected read stays quiet", () => {
	expect(fires(JSON.stringify(bad))).toBe(true);
	expect(fires(`subprocess.run(${JSON.stringify(bad)})`)).toBe(true);
	expect(fires(JSON.stringify({ language: "py", code: `subprocess.run(${JSON.stringify(bad)})` }))).toBe(true);
	expect(fires(JSON.stringify(bad.filter(arg => arg !== "--readonly")))).toBe(false);
});

test("br unsupported --readonly: shell call fires; help and inert text stay quiet", () => {
	for (const command of ["br --readonly show bead --json", "true && br --readonly show bead --json"]) {
		expect(fires(command)).toBe(true);
		expect(fires(JSON.stringify({ command }))).toBe(true);
	}
	for (const command of ["br show bead --json", "br --help", "echo 'br --readonly show bead'", "printf '%s' '--readonly'"]) {
		expect(fires(command)).toBe(false);
		expect(fires(JSON.stringify({ command }))).toBe(false);
	}
	expect(rule.scope).toContain("tool:eval");
});

test("br unsupported --readonly: 64K near miss stays quiet within the native matcher budget", () => {
	const near = JSON.stringify({ code: `${'[\"br\", \"--readonlx\"],'.repeat(3500)}` });
	const start = performance.now();
	expect(fires(near)).toBe(false);
	expect(performance.now() - start).toBeLessThan(100);
});
