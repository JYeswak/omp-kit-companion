import { expect, test } from "bun:test";
import { repeatTestCommand } from "../../src/cli.ts";
import { findCommand } from "../../src/commands.ts";
import { clopperPearson, cohensH, fisherExact, repeatVerdict, sampleSize } from "../../src/repeat-stats.ts";

test("Clopper-Pearson matches textbook bounds", () => {
	const clean = clopperPearson(0, 20);
	expect(clean.lower).toBe(0);
	expect(Math.abs(clean.upper - 0.1684)).toBeLessThan(0.002);
	const two = clopperPearson(2, 20);
	expect(Math.abs(two.lower - 0.0123)).toBeLessThan(0.003);
	expect(Math.abs(two.upper - 0.3173)).toBeLessThan(0.003);
	const all = clopperPearson(20, 20);
	expect(all.upper).toBe(1);
	expect(Math.abs(all.lower - 0.8316)).toBeLessThan(0.002);
	expect(() => clopperPearson(21, 20)).toThrow(/INVALID_REPEAT_COUNTS/);
	expect(() => clopperPearson(1, 0)).toThrow(/INVALID_REPEAT_COUNTS/);
});

test("Fisher separates signal from noise on small counts", () => {
	expect(fisherExact(2, 20, 1, 20)).toBeGreaterThan(0.5);
	expect(fisherExact(1, 20, 10, 20)).toBeLessThan(0.01);
	expect(fisherExact(0, 20, 0, 20)).toBe(1);
	expect(() => fisherExact(3, 2, 1, 20)).toThrow(/INVALID_REPEAT_COUNTS/);
});

test("sample size matches the two-proportion anchor", () => {
	const n = sampleSize(0.5, 0.4);
	expect(Math.abs(n! - 387)).toBeLessThan(10);
	expect(sampleSize(0.1, 0.1)).toBeNull();
	expect(() => sampleSize(-0.1, 0.5)).toThrow(/INVALID_POWER_INPUTS/);
	expect(Math.abs(cohensH(0.1, 0.05) - 0.19)).toBeLessThan(0.02);
});

test("zero failures in twenty runs does not prove a five percent target", () => {
	const thin = repeatVerdict({ version: 1, runs: 20, failures: 0 }, { target: 0.05 });
	expect(thin.kind).toBe("above-target");
	expect(thin.failure_rate).toBe(0);
	const thick = repeatVerdict({ version: 1, runs: 300, failures: 0 }, { target: 0.05 });
	expect(thick.kind).toBe("below-target");
	expect(thick.n_needed_post_hoc).toBe(152);
});

test("baseline verdicts follow Fisher, not raw counts", () => {
	const noise = repeatVerdict({ version: 1, runs: 20, failures: 1 }, { baseline: { version: 1, runs: 20, failures: 2 } });
	expect(noise.kind).toBe("not-distinguishable");
	expect(noise.p_value!).toBeGreaterThan(0.05);
	const bad = JSON.parse(JSON.stringify({ version: 2, runs: 20, failures: 2 }));
	expect(() => repeatVerdict({ version: 1, runs: 20, failures: 1 }, { baseline: bad })).toThrow(/INVALID_REPEAT_RECEIPT/);
	const fixed = repeatVerdict({ version: 1, runs: 20, failures: 0 }, { baseline: { version: 1, runs: 20, failures: 8 } });
	expect(fixed.kind).toBe("improved");
	expect(fixed.p_value!).toBeLessThan(0.05);
	expect(fixed.effect_size_h!).toBeLessThan(0);
	const worse = repeatVerdict({ version: 1, runs: 20, failures: 8 }, { baseline: { version: 1, runs: 20, failures: 0 } });
	expect(worse.kind).toBe("regressed");
	const plain = repeatVerdict({ version: 1, runs: 20, failures: 2 });
	expect(plain.kind).toBe("unjudged");
	expect(plain.p_value).toBeNull();
});

test("repeat handler refuses bad counts, clashing flags, and bad selections before any run", async () => {
	const command = findCommand("test");
	if (!command) throw new Error("test command missing");
	const call = (flags: [string, string | true][]) => repeatTestCommand({ command, flags: new Map(flags), json: true, robot: false });
	for (const bad of ["0", "abc", "1001", ""]) {
		const result = await call([["--repeat", bad]]);
		expect(result.errors?.[0]?.code).toBe("INVALID_REPEAT");
	}
	expect((await call([["--repeat", "5"], ["--full", true]])).errors?.[0]?.code).toBe("INVALID_FLAG");
	expect((await call([["--repeat", "5"], ["--scenario", ""]])).errors?.[0]?.code).toBe("INVALID_SCENARIO");
	expect((await call([["--repeat", "5"], ["--baseline", "relative/path.json"]])).errors?.[0]?.code).toBe("INVALID_BASELINE");
});
