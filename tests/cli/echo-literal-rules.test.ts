import { expect, test } from "bun:test";
import { loadRuleFile } from "../../scripts/rule-class.ts";

// kit-tool-result-is-not-json and kit-rea-runtime-shipped stay quiet when their literal sits in a
// command segment whose command word is echo/printf (the metamorphic quoting relation), through a
// lookbehind bounded at 256 segment chars. Past the bound the echo is not seen and the rule fires,
// as it did before the exclusion: the safe side. These rows pin both sides of that bound.
function firesFor(rule: string): (command: string) => boolean {
	const conditions = loadRuleFile(`rules/${rule}.md`).rule.condition ?? [];
	return command => conditions.some(pattern => new RegExp(pattern).test(command));
}
const wire = (command: string): string => JSON.stringify({ command });

const rules: { rule: string; cases: [string, boolean][] }[] = [
	{
		rule: "kit-tool-result-is-not-json",
		cases: [
			['node -e "console.log(JSON.parse(toolResult).title)"', true],
			["cat out.json | node -e 'JSON.parse(require(\"fs\").readFileSync(0))'", true],
			['echo "x" && node -e "JSON.parse(s)"', true],
			['x=$(node -e "JSON.parse(s)")', true],
			['echo "node -e \\"console.log(JSON.parse(toolResult).title)\\""', false],
			["printf '%s\\n' \"node -e \\\"console.log(JSON.parse(toolResult).title)\\\"\"", false],
			["echo 'JSON.parse(toolResult).title'", false],
			["br show <id> --json | jq '.title'", false],
		],
	},
	{
		rule: "kit-rea-runtime-shipped",
		cases: [
			["lldb /Applications/Sketch.app/Contents/MacOS/Sketch", true],
			["sudo dtruss /opt/homebrew/bin/omp --help", true],
			['echo "start" && lldb -- /usr/bin/python3 script.py', true],
			['echo "lldb /Applications/Sketch.app/Contents/MacOS/Sketch"', false],
			["printf '%s\\n' \"sudo dtruss /opt/homebrew/bin/omp --help\"", false],
			["lldb /usr/local/bin/mytool", false],
		],
	},
];

for (const { rule, cases } of rules) {
	const fires = firesFor(rule);
	for (const [command, want] of cases) {
		test(`${rule}: ${want ? "fires" : "quiet"} on ${command.slice(0, 60)}`, () => {
			// The conditions read the JSON tool-argument wire, where `\n` is an escaped newline that
			// starts a segment; raw text has no escape layer, so raw rows exclude backslashes.
			if (!command.includes("\\")) expect(fires(command)).toBe(want);
			expect(fires(wire(command))).toBe(want);
		});
	}
}

// Segment chars counted by the bound: the space after echo, the padding, and the literal itself
// up to the lookbehind (JSON.parse is 10 chars; " lldb" is 5).
test("kit-tool-result-is-not-json: an echo 256 segment chars back is seen, 257 is not and fires", () => {
	const fires = firesFor("kit-tool-result-is-not-json");
	const at = (pad: number) => `echo ${"a".repeat(pad)}JSON.parse(x)`;
	expect(fires(at(245))).toBe(false);
	expect(fires(wire(at(245)))).toBe(false);
	expect(fires(at(246))).toBe(true);
	expect(fires(wire(at(246)))).toBe(true);
});

test("kit-rea-runtime-shipped: an echo 256 segment chars back is seen, 257 is not and fires", () => {
	const fires = firesFor("kit-rea-runtime-shipped");
	const at = (pad: number) => `echo ${"a".repeat(pad)} lldb /usr/bin/x`;
	expect(fires(at(250))).toBe(false);
	expect(fires(wire(at(250)))).toBe(false);
	expect(fires(at(251))).toBe(true);
	expect(fires(wire(at(251)))).toBe(true);
});

// The unbounded echo lookbehind cost O(n) per literal: 424 ms at 16K on this shape.
test("echo-literal rules: a 64K echo string full of literals stays linear", () => {
	for (const [rule, unit] of [["kit-tool-result-is-not-json", "JSON.parse "], ["kit-rea-runtime-shipped", "lldb /usr/bin/ "]] as const) {
		const fires = firesFor(rule);
		const near = wire(`echo "${unit.repeat(Math.ceil(65536 / unit.length))}`);
		const start = performance.now();
		fires(near);
		expect(performance.now() - start).toBeLessThan(100);
	}
});
