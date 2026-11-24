/** MINDS1-S1 (ompkit-h66sg.1): a new literal prints box needs a source line that holds the text. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeItem } from "../../scripts/box-lint.ts";
import { judge } from "../../src/verify.ts";

const root = join(import.meta.dir, "..", "..");
const passLine = readFileSync(join(root, "src/verify.ts"), "utf8").split("\n")[268];
const box = (expected: string) => `- [ ] [a] [build] the verb prints PASS \`true\` -> ${expected}`;

test("MINDS1-S1 planted negative: prints PASS with no src is refused unsourced-expectation", () => {
	expect(passLine).toContain("PASS");
	const row = judgeItem({ id: "plant", acceptance: box('prints "PASS"'), baseline: null });
	expect(row.refused.map(f => f.reason)).toEqual(["unsourced-expectation"]);
	expect(row.refused[0]?.detail).toContain("needs ; src");
});

test("MINDS1-S1 planted negative: src pointing at a line without the text is refused", () => {
	const row = judgeItem({ id: "miss", acceptance: box('prints "PASS"; src src/verify.ts:1'), baseline: null });
	expect(row.refused[0]?.detail).toContain("src src/verify.ts:1 does not contain");
});

test("MINDS1-S1 control: src whose line holds PASS is admitted, and verify ignores the citation", () => {
	const acceptance = box('prints "PASS"; src src/verify.ts:269');
	const row = judgeItem({ id: "hold", acceptance, baseline: null });
	expect(row.refused).toEqual([]);
	expect(row.replayable).toBe(true);
	expect(judge('prints "PASS"', 0, "PASS")).toEqual({ pass: true, detail: 'output contains "PASS"' });
});

test("MINDS1-S1 control: an unchanged unsourced box is legacy, and echo or rc needs no src", () => {
	const bare = box('prints "PASS"');
	expect(judgeItem({ id: "old", acceptance: bare, baseline: bare }).refused).toEqual([]);
	expect(judgeItem({ id: "echo", acceptance: '- [ ] [a] [build] echo `echo PASS` -> prints "PASS"', baseline: null }).refused).toEqual([]);
	expect(judgeItem({ id: "rc", acceptance: "- [ ] [a] [build] runs `true` -> rc 0", baseline: null }).refused).toEqual([]);
});
