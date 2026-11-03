import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp";
import { runSync } from "../../src/kitlib/run";
import { AMPLE, MANIFEST_HEADER, affectedArchive, gate, gateFunctions, gateTree, isoDay, root, runFocused, saveFixture } from "./fresh-gate.helpers.ts";

test.skipIf(!AMPLE)("CIGATE1 manifest: a CI-only test is excluded and printed, and the verdict is PARTIAL naming it (needs >= 10 GiB free)", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const archive = affectedArchive(fx, 42, 42);
		writeFileSync(join(archive, "tests/cli/live.test.ts"), `import { expect, test } from "bun:test";\nimport { answer } from "../../lib/mod.ts";\ntest("needs a live service", () => { expect(answer()).toBe(0); });\n`);
		const scripts = gateTree(fx, `${MANIFEST_HEADER}tests/cli/live.test.ts\tci-only\tompkit-test.1\t-\tneeds a live service\n`);
		const partial = runFocused(fx, source, archive, "lib/mod.ts", scripts);
		expect(partial.code).toBe(0);
		expect(partial.out).toContain("focused: excluded tests/cli/live.test.ts (ci-only ompkit-test.1: needs a live service); CI runs it");
		expect(partial.out).toContain("FRESH-GATE: VERDICT PARTIAL files=1 ran=1 deferred=tests/cli/live.test.ts: CI runs the deferred files");
		expect(partial.out).not.toContain("VERDICT TESTED");
		// Mutant: no manifest filter runs the CI-only test here, and its live dependency refuses the push.
		const unfiltered = source.replace("\tfocus_tests=$(apply_ci_only $focus_tests) || return $?\n", "");
		expect(unfiltered).not.toBe(source);
		expect(runFocused(fx, unfiltered, archive, "lib/mod.ts", scripts).code).not.toBe(0);
		// Every test reaching changed code CI-only: refused, never a pass that ran nothing.
		const onlyLive = runFocused(fx, source, archive, "lib/mod.ts", gateTree(fx, `${MANIFEST_HEADER}tests/cli/live.test.ts\tci-only\tompkit-test.1\t-\tlive\ntests/cli/mod.test.ts\tci-only\tompkit-test.2\t-\tlive\n`));
		expect(onlyLive.code).toBe(1);
		expect(onlyLive.out).toContain("FRESH-GATE: REFUSED reason=NO_LOCAL_TESTS code=lib/mod.ts ci_only=tests/cli/live.test.ts,tests/cli/mod.test.ts");
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
}, 120_000);

test("CIGATE1 manifest: hermeticity rows expire within 14 days; an expired row runs; malformed rows refuse", () => {
	const source = readFileSync(gate, "utf8");
	const fx = saveFixture(0, { slots: 8, max_wait_s: 30 });
	try {
		const probe = join(fx.dir, "manifest-probe.sh");
		writeFileSync(probe, `${gateFunctions(source, ["apply_ci_only"])}apply_ci_only tests/cli/a.test.ts tests/cli/b.test.ts\n`);
		const filter = (manifest: string) => {
			const scripts = gateTree(fx, manifest);
			const result = runSync(["sh", probe], { deadline_s: 30, env: { ...process.env, SCRIPT_DIR: scripts, WORK: fx.env.WORK } });
			return { code: result.rc ?? 1, kept: Buffer.from(result.stdout).toString().split("\n").filter(Boolean), err: Buffer.from(result.stderr).toString() };
		};
		const live = filter(`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(13)}\tHOME race\n`);
		expect(live.code).toBe(0);
		expect(live.kept).toEqual(["tests/cli/b.test.ts"]);
		const expired = filter(`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(-1)}\tHOME race\n`);
		expect(expired.kept).toEqual(["tests/cli/a.test.ts", "tests/cli/b.test.ts"]);
		expect(expired.err).toContain(`ci-only manifest row for tests/cli/a.test.ts (ompkit-test.3) EXPIRED ${isoDay(-1)}; it runs`);
		for (const [manifest, why] of [
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t${isoDay(30)}\tHOME race\n`, "a hermeticity row expires by"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\thermeticity\tompkit-test.3\t-\tHOME race\n`, "a hermeticity row expires by"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\tci-only\t\t-\tno bead\n`, "needs 5 non-empty tab-separated fields"],
			[`${MANIFEST_HEADER}tests/cli/a.test.ts\tskip\tompkit-test.3\t-\twhy\n`, "kind is ci-only or hermeticity"],
			["tests/cli/a.test.ts\tci-only\tompkit-test.3\t-\tno header\n", "line 1 is not the header"],
		] as const) {
			const bad = filter(manifest);
			expect(bad.code).toBe(3);
			expect(bad.kept).toEqual([]);
			expect(bad.err).toContain("FRESH-GATE: REFUSED reason=CI_ONLY_MANIFEST_INVALID");
			expect(bad.err).toContain(why);
		}
	} finally {
		rmSync(fx.dir, { recursive: true, force: true });
	}
});

test("CIGATE1 manifest: the checked-in manifest is valid and names only existing tests", () => {
	const manifest = readFileSync(join(root, "scripts/gate-ci-only.tsv"), "utf8").trim().split("\n");
	expect(manifest[0]).toBe("path\tkind\tbead\texpires\treason");
	for (const row of manifest.slice(1)) {
		const [path, kind, bead, expires, reason] = row.split("\t");
		expect(existsSync(join(root, path as string))).toBe(true);
		expect(["ci-only", "hermeticity"]).toContain(kind as string);
		expect(bead).toStartWith("ompkit-");
		expect(reason?.length ?? 0).toBeGreaterThan(10);
		if (kind === "ci-only") expect(expires).toBe("-");
	}
	const liveReservation = manifest.slice(1).map((row) => row.split("\t"))
		.find(([path]) => path === "tests/fleet-guard/reservations.live.test.ts");
	expect(liveReservation?.[1]).toBe("ci-only");
	expect(liveReservation?.[3]).toBe("-");
	expect(liveReservation?.[4]).toContain("owner=SilverCondor");
	expect(liveReservation?.[4]).toContain("Agent Mail");
});
afterAll(() => cleanupAllOwnedTmp());
