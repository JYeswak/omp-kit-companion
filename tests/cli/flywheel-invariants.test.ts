import { afterAll, expect, test } from "bun:test";
import { CASE_HEADER } from "../../src/case-corpus.ts";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, REQUIRED_ANTI, REQUIRED_KERNEL } from "../../scripts/check-flywheel-invariants.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const scratch = ownedTmp("fw-inv", { root: process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp") }).path;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const HEADER = "id\tguide\tkind\tmechanism\tfire\tquiet";
const K = (n: string) => `complete-guide > The Flywheel Effect > The Kernel: 9 Invariants > ${n} x`;
const A = (name: string) => `complete-guide > The Complete Toolchain > Anti-Patterns to Avoid > ${name}`;

/** A minimal tree where one TTSR rule with fire/quiet corpus rows backs every required row. */
function tree(): string {
	const root = ownedTmp("tree", { root: scratch }).path;
	mkdirSync(join(root, "rules"));
	mkdirSync(join(root, "cases"));
	writeFileSync(join(root, "rules/kit-demo.md"), "---\ncondition: 'x'\n---\nbody\n");
	writeFileSync(join(root, "cases/cases.tsv"), CASE_HEADER + "\nkit-demo\tfire\ttext\t-\t-\tx\tn\t\nkit-demo\tquiet\ttext\t-\t-\ty\tn\t\n");
	return root;
}
const row = (id: string, guide: string, kind = "ttsr", mechanism = "kit-demo") =>
	`${id}\t${guide}\t${kind}\t${mechanism}\tcases/cases.tsv::kit-demo::fire\tcases/cases.tsv::kit-demo::quiet`;
function fullMap(extra: string[] = [], drop?: string): string {
	const rows = [
		...REQUIRED_KERNEL.map(n => row(`K${n}`, K(n))),
		...REQUIRED_ANTI.map((name, i) => row(`A${i}`, A(name))),
	].filter(line => !drop || !line.includes(drop));
	return [HEADER, ...rows, ...extra].join("\n") + "\n";
}

test("a complete map whose every mechanism and proof exists passes", () => {
	const result = check(tree(), fullMap());
	expect(result.failures).toEqual([]);
	expect(result.status).toBe("PASS");
});
test("fleet-pack TTSR mechanisms use their own rule and fire/quiet corpus", () => {
	const root = tree();
	mkdirSync(join(root, "rules-fleet"));
	writeFileSync(join(root, "rules-fleet/kit-demo.md"), "---\ncondition: 'x'\n---\nbody\n");
	writeFileSync(join(root, "cases/cases-fleet.tsv"), CASE_HEADER + "\nkit-demo\tfire\ttext\t-\t-\tx\tn\t\nkit-demo\tquiet\ttext\t-\t-\ty\tn\t\n");
	const fleetRow = `F1\t${K("6")}\tttsr-fleet\tkit-demo\tcases/cases-fleet.tsv::kit-demo::fire\tcases/cases-fleet.tsv::kit-demo::quiet`;
	const text = fullMap([fleetRow]);
	expect(check(root, text).failures).toEqual([]);
	expect(check(root, text, true).failures).toEqual([]);
});

test("fleet-pack TTSR proof cannot borrow a default-pack rule", () => {
	const root = tree();
	const fleetRow = `F1\t${K("6")}\tttsr-fleet\tkit-demo\tcases/cases.tsv::kit-demo::fire\tcases/cases.tsv::kit-demo::quiet`;
	const result = check(root, fullMap([fleetRow]));
	expect(result.failures.some(failure => failure.startsWith("F1 ") && failure.includes("MECHANISM_MISSING ttsr-fleet:kit-demo"))).toBe(true);
});

test("planted: an unmapped kernel invariant and an unmapped anti-pattern each fail by name", () => {
	expect(check(tree(), fullMap([], K("6"))).failures).toContain("kernel invariant 6: UNMAPPED");
	expect(check(tree(), fullMap([], A("Communication purgatory"))).failures).toContain('anti-pattern "Communication purgatory": UNMAPPED');
});

test("planted: prose is not a mechanism", () => {
	const result = check(tree(), fullMap([`P1\t${K("6")}\tdocs\tAGENTS.md\tcases/cases.tsv::kit-demo::fire\tcases/cases.tsv::kit-demo::quiet`]));
	expect(result.status).toBe("FAIL");
	expect(result.failures.some(f => f.startsWith("P1 ") && f.includes("PROSE_IS_NOT_A_MECHANISM"))).toBe(true);
	expect(result.failures.some(f => f.startsWith("P1 ") && f.includes("KIND_NOT_A_MECHANISM"))).toBe(true);
});

test("planted: a named rule deleted from the package fails its row", () => {
	const root = tree();
	rmSync(join(root, "rules/kit-demo.md"));
	const result = check(root, fullMap());
	expect(result.status).toBe("FAIL");
	expect(result.failures.some(f => f.startsWith("K1 ") && f.includes("MECHANISM_MISSING ttsr:kit-demo"))).toBe(true);
});

test("planted: a rule with no quiet corpus row, or a missing named test, fails", () => {
	const root = tree();
	writeFileSync(join(root, "cases/cases.tsv"), "rule\texpect\nkit-demo\tfire\n");
	expect(check(root, fullMap()).failures.some(f => f.includes("QUIET_PROOF_MISSING"))).toBe(true);
	const testRow = `T1\t${K("3")}\tcli\tplanning convert\ttests/x.test.ts::no such test\ttests/x.test.ts::no such test`;
	expect(check(tree(), fullMap([testRow])).failures.some(f => f.startsWith("T1 ") && f.includes("FIRE_PROOF_MISSING"))).toBe(true);
});

test("planted: duplicate ids and a malformed header are refused", () => {
	expect(check(tree(), fullMap([row("K1", K("1"))])).failures.some(f => f.includes("DUPLICATE_ID"))).toBe(true);
	expect(check(tree(), "id\tguide\n").failures).toEqual(["MAP_HEADER"]);
});

test("the shipped map passes against this tree", () => {
	const root = join(import.meta.dir, "../..");
	const result = check(root, readFileSync(join(root, "docs/flywheel-invariants.tsv"), "utf8"));
	expect(result.failures).toEqual([]);
});

afterAll(() => cleanupAllOwnedTmp());
