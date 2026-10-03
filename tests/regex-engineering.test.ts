import { expect, test } from "bun:test";
import { isSha256Hex, matchesBounded } from "../src/regex-guards.ts";

const valid = "a".repeat(64);

test("SHA-256 guard accepts the valid lowercase digest shape", () => {
	expect(isSha256Hex(valid)).toBe(true);
});

test("SHA-256 guard rejects wrong length and alphabet", () => {
	expect(isSha256Hex(`${valid}!`)).toBe(false);
	expect(isSha256Hex("g".repeat(64))).toBe(false);
	expect(isSha256Hex("A".repeat(64))).toBe(false);
});

test("SHA-256 guard stays bounded on a doubled near-miss", () => {
	const nearMiss = (length: number): number => {
		const value = "a".repeat(length) + "!";
		const start = performance.now();
		for (let i = 0; i < 20_000; i++) isSha256Hex(value);
		return performance.now() - start;
	};
	nearMiss(64);
	const short = nearMiss(64);
	const long = nearMiss(128);
	expect(long / Math.max(short, 0.001)).toBeLessThan(4);
});


test("bounded external regex accepts match, rejects no-match, and rejects overlong near-miss", () => {
	const pattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
	expect(matchesBounded("codex-lean", 128, pattern)).toBe(true);
	expect(matchesBounded("not valid!", 128, pattern)).toBe(false);
	expect(matchesBounded("a".repeat(129), 128, pattern)).toBe(false);
});
