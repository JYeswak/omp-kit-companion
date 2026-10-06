import { expect, test } from "bun:test";
import { loadRuleFile } from "../../scripts/rule-class.ts";

// Localbench finding: kit-close-needs-evidence misread `br close` when
// --reason was not the first flag — a quoted flag value's opening quote acted
// as a command terminator, so an evidenced close was blocked. The quote only
// terminates when no --reason follows on the same logical line.
const loaded = loadRuleFile("rules/kit-close-needs-evidence.md");
const conditions = loaded.rule.condition ?? [];

function fires(command: string): boolean {
	return conditions.some((pattern) => new RegExp(pattern).test(command));
}

// [command, expectFire]
const cases: [string, boolean][] = [
	['br close x --transition-comment "route PASS" --reason "cargo test -> 41 passed; commit abc1234"', false],
	['br close x --reason "cargo test -> 41 passed; commit abc1234"', false],
	['br close x --actor X --reason "cargo test -> 41 passed; commit abc1234"', false],
	['br close x --transition-comment "a;b" --reason "cargo test -> 41 passed"', false],
	['br close x -r "cargo test -> 41 passed; commit abc1234"', false],
	['bd close x --transition-comment "c" --reason "cargo test -> 41 passed; commit abc1234"', false],
	['br close x --transition-comment "route PA', true],
	['br close x --help\\n', false],
	['br close x --transition-comment "route PASS"\\n', true],
	['br close x --actor X\\n', true],
	['br close x && br list\\n', true],
	['br close x --reason ""\\n', true],
];

for (const [command, want] of cases) {
	test(`close flag order: ${want ? "fires" : "quiet"} on ${command.slice(0, 60)}`, () => {
		expect(fires(command)).toBe(want);
	});
}

test("close flag order: long quoted value without terminator stays fast", () => {
	const near = 'br close x --transition-comment "' + "a".repeat(2000);
	const start = performance.now();
	fires(near);
	const elapsed = performance.now() - start;
	expect(elapsed).toBeLessThan(100);
});
