import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { AMPLE, LOW_BASE, NEED_BYTES, affectedArchive, freeBytes, gate, gateTree, ledger, runFocused, saveFixture } from "./fresh-gate.helpers.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

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

test("CIGATE1 deletion-only (ompkit-1ra0d.66): a push that only deletes product code passes with a deleted-only note", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		rmSync(join(archive, "lib/mod.ts"));
		rmSync(join(archive, "tests/cli/mod.test.ts"));
		const passed = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod.test.ts");
		expect(passed.code, passed.out).toBe(0);
		expect(passed.out).toContain("deleted-only: 1 paths");
		expect(passed.out).toContain("FRESH-GATE: VERDICT DOCS_ONLY: no product code changed");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 0]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

test("CIGATE1 deletion-importer (ompkit-1ra0d.66): deleting a module its suite still imports selects that suite and its failure refuses", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		rmSync(join(archive, "lib/mod.ts"));
		const red = runFocused(fx, source, archive, "lib/mod.ts");
		expect(red.code).toBe(1);
		expect(red.out).toContain("affected: tests/cli/mod.test.ts <- tests/cli/mod.test.ts");
		expect(red.out).toContain("affected tests: files=1 ran=1 fail=1 rc=1");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[1, 1, 1]]);
		// Planted negative: without importer expansion the same push runs nothing
		// and passes as DOCS_ONLY.
		const old = source.replace("\texpand_changed_with_importers || return $?\n", "");
		expect(old).not.toBe(source);
		const gone = affectedArchive(fx, 42, 42);
		rmSync(join(gone, "lib/mod.ts"));
		const passed = runFocused(fx, old, gone, "lib/mod.ts");
		expect(passed.code, passed.out).toBe(0);
		expect(passed.out).toContain("deleted-only: 1 paths");
		expect(passed.out).toContain("FRESH-GATE: VERDICT DOCS_ONLY: no product code changed");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

test("CIGATE1 deletion-importer-sh (ompkit-1ra0d.66): deleting a sourced shell lib selects the suite reaching its importer", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		mkdirSync(join(archive, "scripts"));
		writeFileSync(join(archive, "scripts/lib.sh"), "#!/bin/sh\nlib_msg() { printf 'tool-ok'; }\n");
		// SC1091 disabled: the gate's pinned shellcheck cannot follow a
		// computed source, the same directive real scripts carry for it.
		writeFileSync(join(archive, "scripts/tool.sh"), '#!/bin/sh\n# shellcheck disable=SC1091\n. "$(dirname "$0")/lib.sh"\necho "tool says $(lib_msg)"\n');
		writeFileSync(join(archive, "tests/cli/tool.test.sh"), '#!/bin/sh\nROOT=$(pwd)\nout=$(sh "$ROOT/scripts/tool.sh")\n[ "$out" = "tool says tool-ok" ] || { echo "tool said $out" >&2; exit 1; }\necho "tool: 1 pass 0 fail"\n');
		rmSync(join(archive, "scripts/lib.sh"));
		const red = runFocused(fx, source, archive, "scripts/lib.sh");
		expect(red.code).toBe(1);
		// The suite is selected through its importer one hop away.
		expect(red.out).toContain("affected: tests/cli/tool.test.sh <- scripts/tool.sh (1 hops)");
		expect(red.out).toContain("RED script-suite tests/cli/tool.test.sh");
		expect(red.out).toContain("FRESH-GATE: RED: affected tests did not pass");
		// Planted negative: without importer expansion the same push runs nothing
		// and passes as DOCS_ONLY.
		const old = source.replace("\texpand_changed_with_importers || return $?\n", "");
		expect(old).not.toBe(source);
		const gone = affectedArchive(fx, 42, 42);
		const passed = runFocused(fx, old, gone, "scripts/lib.sh");
		expect(passed.code, passed.out).toBe(0);
		expect(passed.out).toContain("FRESH-GATE: VERDICT DOCS_ONLY: no product code changed");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

test("CIGATE1 deletion-mixed (ompkit-1ra0d.66): deleting one file does not excuse an uncovered file the push still changes", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		rmSync(join(archive, "lib/mod.ts"));
		rmSync(join(archive, "tests/cli/mod.test.ts"));
		writeFileSync(join(archive, "lib/orphan.ts"), "export const orphan = 1;\n");
		const refused = runFocused(fx, source, archive, "lib/mod.ts\ntests/cli/mod.test.ts\nlib/orphan.ts");
		expect(refused.code).toBe(1);
		expect(refused.out).toContain("FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=lib/orphan.ts:");
		expect(refused.out).not.toContain("lib/mod.ts");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 1]]);
		// Planted negative: the pre-fix changed-code list demanded a test for the
		// deleted file too, so the deletion-only push above was refused.
		const old = source.replace('[ -e "$ARCHIVE_DIR/$file" ] && printf \'%s\\n\' "$file" ;;', 'printf \'%s\\n\' "$file" ;;');
		expect(old).not.toBe(source);
		const gone = affectedArchive(fx, 42, 42);
		rmSync(join(gone, "lib/mod.ts"));
		rmSync(join(gone, "tests/cli/mod.test.ts"));
		const red = runFocused(fx, old, gone, "lib/mod.ts\ntests/cli/mod.test.ts");
		expect(red.code).toBe(1);
		expect(red.out).toContain("FRESH-GATE: REFUSED reason=NO_AFFECTED_TESTS code=lib/mod.ts:");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

test("focused fixture preserves an early malformed-manifest refusal and records zero executed tests", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		const scriptDir = gateTree(fx, "invalid manifest header\n");
		const refused = runFocused(fx, source, archive, "lib/mod.ts", scriptDir);
		expect(refused.code, refused.out).toBe(3);
		expect(refused.out).toContain("REFUSED reason=CI_ONLY_MANIFEST_INVALID");
		expect(refused.out).not.toContain("parameter not set");
		expect(refused.out).not.toContain("affected tests:");
		expect(ledger(fx).map((row) => [row.selected_files, row.tests_ran, row.rc])).toEqual([[0, 0, 3]]);
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(60) * 1000);

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
