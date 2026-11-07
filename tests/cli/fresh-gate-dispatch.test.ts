import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { AMPLE, LOW_BASE, NEED_BYTES, affectedArchive, freeBytes, gate, ledger, runFocused, saveFixture } from "./fresh-gate.helpers.ts";

test("CIGATE1 planted: a docs-only commit runs no suites and passes fast", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const docs = runFocused(fx, source, affectedArchive(fx, 41, 42), "docs/notes.md");
		expect(docs.code).toBe(0);
		expect(docs.out).toContain("focused suites: none selected for changed paths");
		expect(docs.out).toContain("FRESH-GATE: VERDICT DOCS_ONLY: no product code changed");
		expect(docs.out).not.toContain("affected tests:");
		expect(docs.seconds).toBeLessThan(15);
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 0]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

test("CIGATE1 planted: a product-code change that no test reaches is refused, never a bare pass", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "lib/orphan.ts"), "export const orphan = 1;\n");
		const refused = runFocused(fx, source, archive, "lib/orphan.ts\ndocs/notes.md");
		expect(refused.code).toBe(1);
		expect(refused.out).toContain("FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=lib/orphan.ts:");
		expect(refused.out).not.toContain("VERDICT");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 1]]);
		// Mutant: a gate that cannot tell code from docs passes the untested change as DOCS_ONLY.
		const blind = source.replace(`\t\t\t\t[ -e "$ARCHIVE_DIR/$file" ] && printf '%s\\n' "$file" ;;`, "\t\t\t\t: ;;");
		expect(blind).not.toBe(source);
		const passed = runFocused(fx, blind, archive, "lib/orphan.ts");
		expect(passed.code).toBe(0);
		expect(passed.out).toContain("VERDICT DOCS_ONLY");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);

test.skipIf(!AMPLE)("CIGATE1 planted: a shell suite naming a changed script runs, and its failure refuses the push (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, "scripts"));
		writeFileSync(join(archive, "scripts/tool.sh"), "#!/bin/sh\necho tool-ok\n");
		writeFileSync(join(archive, "tests/cli/tool.test.sh"), '#!/bin/sh\nROOT=$(pwd)\nout=$(sh "$ROOT/scripts/tool.sh")\n[ "$out" = tool-ok ] || { echo "tool said $out" >&2; exit 1; }\necho "tool: 1 pass 0 fail"\n');
		const green = runFocused(fx, source, archive, "scripts/tool.sh");
		expect(green.code).toBe(0);
		expect(green.out).toContain("affected: tests/cli/tool.test.sh <- scripts/tool.sh");
		expect(green.out).toContain("GREEN script-suite tests/cli/tool.test.sh");
		expect(green.out).toContain("FRESH-GATE: VERDICT TESTED files=1 ran=1");
		writeFileSync(join(archive, "scripts/tool.sh"), "#!/bin/sh\necho tool-broken\n");
		const red = runFocused(fx, source, archive, "scripts/tool.sh");
		expect(red.code).not.toBe(0);
		expect(red.out).toContain("RED script-suite tests/cli/tool.test.sh");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test.skipIf(!AMPLE)("CIGATE1 planted: sbh pressure with ample bytes runs the affected tests; the old admission refuses, never passes silently (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(1, { slots: 8, max_wait_s: 1 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		const ran = runFocused(fx, source, archive, "lib/mod.ts");
		expect(ran.code).toBe(0);
		expect(ran.out).toContain("affected tests: files=1 ran=1 fail=0 rc=0");
		// Mutant: 2026-10-19's admission (heavy's default observer, which takes sbh's verdict). The plant
		// now refuses with heavy's reason where the old gate printed "deferred to CI" and went GREEN.
		const sbhVeto = source.replace('heavy --label "fresh-gate-$step" --disk-observer statfs --', 'heavy --label "fresh-gate-$step" --no-wait --');
		expect(sbhVeto).not.toBe(source);
		const refused = runFocused(fx, sbhVeto, archive, "lib/mod.ts");
		expect(refused.code).toBe(75);
		expect(refused.out).toContain("disk low: sbh check --need 10G reports pressure");
		expect(refused.out).toContain("FRESH-GATE: RED: heavy refused admission for tests (exit 75)");
		expect(refused.out).not.toContain("deferred to CI");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);
test.skipIf(LOW_BASE === null)("CIGATE1 planted: below the 10 GiB physical floor the gate refuses naming the space needed, and no test runs", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 1 });
	fx.env.FRESH_GATE_TEST_REAL_STATFS = "1";
	const low = ownedTmp("fresh-gate-lowfs", { root: LOW_BASE as string }).path;
	try {
		writeFileSync(join(low, ".owner"), `pid=${process.pid}\nlabel=fresh-gate-lowfs\ncreated=${new Date().toISOString()}\n`);
		expect(freeBytes(low)).toBeLessThan(NEED_BYTES);
		const refused = runFocused(fx, source, affectedArchive(fx, 42, 42, low), "lib/mod.ts");
		expect(refused.code, refused.out).toBe(1);
		expect(refused.out).toMatch(/FRESH-GATE: REFUSED reason=DISK_BELOW_FLOOR need=10G need_bytes=10737418240 free_bytes=[0-9]+ observer=statfs/);
		expect(refused.out).not.toContain("affected tests:");
		expect(refused.out).not.toContain("GREEN");
	} finally {
		rmSync(low, { recursive: true, force: true });
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 60_000);
afterAll(() => cleanupAllOwnedTmp());
