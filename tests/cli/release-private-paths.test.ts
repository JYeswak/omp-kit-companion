// PRIVATELEAK1 (ompkit-jlw58): the installed release is what a stranger runs, so development files never ship. The packer
// excludes test files by rule, except the proofs the shipped flywheel-invariants registry names under a shipped root
// (`omp-kit test --full` verifies those in the installed tree), and refuses the build when any member the rule forbids is
// still present (a judging file or an installer reference can add one without going through the root walk).
import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkPackagedPrivatePaths, flywheelProofFiles, releaseExcluded } from "../../scripts/package-release.ts";

const root = resolve(import.meta.dir, "../..");
const proofs = flywheelProofFiles(root);

test("PRIVATELEAK1: every test-file spelling is excluded and a shipped extension is not", () => {
	for (const path of ["extensions/fleet-guard.test.ts", "skills/x/scripts/probe.test.sh", "a/b.test.py", "c.test.mjs", "d.test.js", "e.test.tsx"])
		expect(releaseExcluded(path, proofs), path).toBe(true);
	for (const path of ["extensions/fleet-guard.ts", "extensions/test-helper.ts", "docs/how.test.md", "scripts/attest.sh", "rules/kit-test-first.md"])
		expect(releaseExcluded(path, proofs), path).toBe(false);
});

test("PRIVATELEAK1: the proofs the shipped registry names under a shipped root are kept, and they exist", () => {
	expect([...proofs]).toContain("extensions/kit-flywheel-guard.test.ts");
	for (const file of proofs) expect(existsSync(join(root, file)), file).toBe(true);
	expect(releaseExcluded("extensions/kit-flywheel-guard.test.ts", proofs)).toBe(false);
	expect(releaseExcluded("extensions/kit-flywheel-guard.test.ts", new Set())).toBe(true);
});

test("PRIVATELEAK1 planted: a package list with one forbidden test file is refused with that path named", () => {
	const clean = ["bin/omp-kit", "extensions/fleet-guard.ts", "extensions/kit-flywheel-guard.test.ts", "rules/kit-close-needs-evidence.md"];
	expect(checkPackagedPrivatePaths(clean, proofs)).toEqual([]);
	expect(checkPackagedPrivatePaths([...clean, "extensions/fleet-guard.test.ts"], proofs)).toEqual(["extensions/fleet-guard.test.ts"]);
	expect(checkPackagedPrivatePaths(new Set([...clean, "z.test.ts", "extensions/a.test.ts"]), proofs)).toEqual(["extensions/a.test.ts", "z.test.ts"]);
});

test("PRIVATELEAK1: the source tree really has extension tests, so the exclusion is what keeps them out", () => {
	const tests = readdirSync(join(root, "extensions")).filter(name => releaseExcluded(`extensions/${name}`, proofs));
	expect(tests.length).toBeGreaterThan(30);
});
