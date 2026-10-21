import { describe, expect, test } from "bun:test";
import { isSha256Hex } from "../../src/regex-guards.ts";

describe("MLPL fixed-width SHA-256 validators", () => {
	test("accepts exactly 64 lowercase hexadecimal characters", () => {
		expect(isSha256Hex("a".repeat(64))).toBe(true);
		expect(isSha256Hex("0123456789abcdef".repeat(4))).toBe(true);
	});

	test("rejects 63, 65, and uppercase digests", () => {
		expect(isSha256Hex("a".repeat(63))).toBe(false);
		expect(isSha256Hex("a".repeat(65))).toBe(false);
		expect(isSha256Hex("A".repeat(64))).toBe(false);
	});

	test("rejects non-string values and invalid alphabet", () => {
		expect(isSha256Hex("g".repeat(64))).toBe(false);
		expect(isSha256Hex(null)).toBe(false);
		expect(isSha256Hex(0)).toBe(false);
	});
});
