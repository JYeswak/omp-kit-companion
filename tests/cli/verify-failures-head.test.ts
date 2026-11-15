import { expect, test } from "bun:test";
import { judge, verifyBead } from "../../src/verify.ts";
import { fakeBr, inReview, installFixtureIdentity, repo, restoreFixtureIdentity } from "./verify-fixture.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

test("VERIFYFAILURESHEAD1: `N failures` / `N failure` heads judge like `N fail`", () => {
	// Shape of a turnline selftest summary: ok lines ending in `0 failures`.
	const passing = ["ok dup-pair-counts-once", "ok tool-error-excluded", "ok gate-min", "0 failures"].join("\n");
	const failing = ["ok gate-min", "not ok p01", "1 failure"].join("\n");
	// `0 failures: proves X` passes against a passing summary with rc 0 ...
	expect(judge("0 failures: proves X", 0, passing).pass).toBe(true);
	// ... and bare `0 failures` too.
	expect(judge("0 failures", 0, passing).pass).toBe(true);
	// Singular `1 failure` judges the count the same way.
	expect(judge("1 failure", 1, failing).pass).toBe(true);
	expect(judge("1 failure: proves Y", 1, failing).pass).toBe(true);
	// The old `N fail` spelling keeps working against both summary shapes.
	expect(judge("0 fail", 0, passing).pass).toBe(true);
	expect(judge("0 fail: proves X", 0, passing).pass).toBe(true);
	expect(judge("0 failures", 0, "0 fail").pass).toBe(true);
	// Planted negative: a missing summary FAILs.
	expect(judge("0 failures: proves X", 0, "ok gate-min").pass).toBe(false);
	// Planted negative: nonzero rc FAILs a `0 failures` head.
	expect(judge("0 failures: proves X", 1, passing).pass).toBe(false);
	// Planted negative: a wrong count FAILs.
	expect(judge("2 failures: proves X", 0, passing).pass).toBe(false);
	expect(judge("0 failures", 1, failing).pass).toBe(false);
	// Planted negative: the pre-fix literal judge fails the head case (the whole
	// `0 failures: proves X` clause never appears verbatim in a summary).
	expect(passing.includes("0 failures: proves X")).toBe(false);
	// Planted negative (REWORK from FoggyValley): `fails` is not a summary head,
	// so `0 fails` stays a literal and does not match a `0 fail` summary ...
	expect(judge("0 fails", 0, "0 fail").pass).toBe(false);
	// ... while the literal still passes when the text really appears.
	expect(judge("0 fails", 0, "ok\n0 fails\n").pass).toBe(true);
});

test("VERIFYNODE1: Node and Bun summaries satisfy the same exact-count expectations", () => {
	for (const output of ["ℹ pass 4\nℹ fail 0\n", "# pass 4\n# fail 0\n", " 4 pass\n 0 fail\n"]) {
		expect(judge("0 fail", 0, output).pass).toBe(true);
		expect(judge("0 failures: proves the run passed", 0, output).pass).toBe(true);
		expect(judge("4 pass", 0, output).pass).toBe(true);
		expect(judge("4 pass 0 fail", 0, output).pass).toBe(true);
	}
	expect(judge("991 pass 0 fail", 0, "ℹ pass 991\nℹ fail 0\n").pass).toBe(true);
	expect(judge("1 failure", 1, "ℹ fail 1\n").pass).toBe(true);
	expect(judge("4 pass 1 fail", 1, "ℹ pass 4\nℹ fail 1\n").pass).toBe(true);
});

test("VERIFYNODE1: failure counts, exit status and literal matching stay authoritative", () => {
	for (const output of ["ℹ pass 4\nℹ fail 0\n", " 4 pass\n 0 fail\n"]) {
		expect(judge("0 fail", 1, output).pass).toBe(false);
		expect(judge("4 pass 0 fail", 1, output).pass).toBe(false);
	}
	expect(judge("0 fail", 0, "ℹ fail 1\n").pass).toBe(false);
	expect(judge("0 fail", 0, "ℹ fail 10\n").pass).toBe(false);
	expect(judge("0 fail", 0, "ℹ fail 01\n").pass).toBe(false);
	expect(judge("4 pass", 0, "ℹ pass 40\n").pass).toBe(false);
	expect(judge("4 pass", 0, "14 pass\n").pass).toBe(false);
	expect(judge("4 pass 0 fail", 0, "ℹ pass 3\nℹ fail 0\n").pass).toBe(false);
	expect(judge("0 fail", 0, "no test summary\n").pass).toBe(false);
	expect(judge("0 fail", 0, "ℹ fails 0\n").pass).toBe(false);
	expect(judge("0 fails", 0, "ℹ fail 0\n").pass).toBe(false);
	expect(judge("0 fails", 0, "literal 0 fails\n").pass).toBe(true);
});

test("VERIFYNODE1 VERIFYJUDGE1: real Node summaries close clean exports and keep failing exports in REWORK", async () => {
	installFixtureIdentity();
	try {
		const prelude = "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n";
		const { dir, sha } = await repo("verify-node-summary", {
			"node-pass.cjs": `${prelude}for (let i = 0; i < 4; i++) test('case ' + i, () => assert.equal(i, i));\n`,
			"node-fail.cjs": `${prelude}for (let i = 0; i < 4; i++) test('case ' + i, () => assert.equal(i, i === 3 ? -1 : i));\n`,
		});
		for (const [reporter, file, passes] of [
			["spec", "node-pass.cjs", true],
			["tap", "node-pass.cjs", true],
			["spec", "node-fail.cjs", false],
		] as const) {
			const command = `NODE_DISABLE_COLORS=1 node --test --test-reporter=${reporter} scripts/${file}`;
			const ac = `- [ ] [a] [build] \`${command}\` -> 0 fail\n- [ ] [b] [build] \`${command}\` -> 4 pass 0 fail`;
			const br = fakeBr(inReview(ac));
			const result = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
			expect(result.code).toBe(passes ? "CLOSED" : "REWORK");
			expect(result.replays.map(replay => replay.pass)).toEqual([passes, passes]);
			expect(result.replays.map(replay => replay.rc)).toEqual(passes ? [0, 0] : [1, 1]);
			expect(br.state().status).toBe(passes ? "closed" : "rework");
			expect(br.state().acceptance_criteria).toBe(passes ? ac.replaceAll("- [ ]", "- [x]") : ac);
		}
	} finally {
		restoreFixtureIdentity();
	}
}, fixtureDeadlineS(15) * 1_000);
