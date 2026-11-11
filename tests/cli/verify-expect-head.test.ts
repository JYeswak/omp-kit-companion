import { expect, test } from "bun:test";
import { judge } from "../../src/verify.ts";

test("VERIFYEXPECTHEAD1: a structured head followed by `:` and prose judges the head only", () => {
	const passing = "1 pass\n 100 filtered out\n 0 fail";
	const failing = "1 pass\n 1 fail";
	// `0 fail: proves X` passes against a passing bun summary with rc 0 ...
	expect(judge("0 fail: proves X", 0, passing).pass).toBe(true);
	// ... but fails against a `1 fail` summary with rc 1.
	expect(judge("0 fail: proves X", 1, failing).pass).toBe(false);
	// `exit 0: prose` judges the head.
	expect(judge("exit 0: prose", 0, "anything").pass).toBe(true);
	expect(judge("exit 0: prose", 2, "anything").pass).toBe(false);
	// `prints` with a colon in the needle is unchanged literal behavior.
	expect(judge('prints "status: ok"', 0, "status: ok").pass).toBe(true);
	expect(judge('prints "status: ok"', 0, "status: missing").pass).toBe(false);
	// Planted negative: the 0.2.118 literal judge fails the first case (the whole
	// `0 fail: proves X` clause never appears verbatim in a bun summary).
	expect(passing.includes("0 fail: proves X")).toBe(false);
});
