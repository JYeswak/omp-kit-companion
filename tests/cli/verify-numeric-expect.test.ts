import { expect, test } from "bun:test";
import { judge } from "../../src/verify.ts";

// VERIFYNUMERIC1 (ompkit-1ra0d.242): live readbacks on 0.2.130 failed boxes whose output met the
// stated expectation, because prose numeric shapes were searched for literally.
test("VERIFYNUMERIC1: numeric expectation shapes judge the output's first integer", () => {
	// The four live-readback cases from 2026-11-13.
	expect(judge("prints a count", 0, "346\n").pass).toBe(true);
	expect(judge("prints a number", 0, "35132564\t/Users/x/.local/state/ovnfs/uppers\n").pass).toBe(true);
	expect(judge("prints a count above 0", 0, "173\n").pass).toBe(true);
	expect(judge("prints a count above 0", 0, "0\n").pass).toBe(false);
	// A real miss stays a miss: STATERETAIN1's 29 GB state dir against a 5 GB bound.
	expect(judge("<= 5242880", 0, "29719136\t/Users/x/.local/state/omp-kit\n").pass).toBe(false);
	expect(judge("<= 5242880", 0, "4096\t/Users/x/.local/state/omp-kit\n").pass).toBe(true);
	expect(judge("> 10", 0, "11").pass).toBe(true);
	expect(judge(">= 11", 0, "11").pass).toBe(true);
	expect(judge("< 11", 0, "11").pass).toBe(false);
	expect(judge("= 7", 0, "count 7 rows").pass).toBe(true);
	expect(judge("prints a count below 5", 0, "4").pass).toBe(true);
	// No integer in the output fails, never passes vacuously.
	expect(judge("prints a number", 0, "no digits here\n").pass).toBe(false);
	// A version string is not taken as the integer count.
	expect(judge("prints a count", 0, "omp-kit 0.2.130").pass).toBe(false);
	// Other wording keeps the literal behavior.
	expect(judge("prints 7", 0, "7").pass).toBe(true);
	expect(judge("prints a counter", 0, "a counter").pass).toBe(true);
	// Planted negative: the pre-fix literal judge failed the first case.
	expect("346\n".includes("a count")).toBe(false);
});
