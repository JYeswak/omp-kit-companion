import { expect, test } from "bun:test";
import { judge } from "../../src/verify.ts";

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
});
