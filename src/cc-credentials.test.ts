import { expect, test } from "bun:test";
import { createCcCredentialScreen, type CcCredentialCatalog } from "./cc-credentials.ts";

const letters = Array.from({ length: 16 }, (_, index) => String.fromCharCode(97 + index)).join("");
const mixed = `${letters.slice(0, 15)}1`;
function catalog(): CcCredentialCatalog {
	return {
		schema_version: "omp-kit.cc.credential-shapes.v1", regex_dialect: "ecmascript-u",
		python_digit_ranges: [[48, 57], [178, 179], [185, 185]],
		rules: [{ id: "generic-policy", regex: { pattern: "token:([^\\s]{16})", flags: "u" }, keywords: ["token:"], secret_group: 1, entropy: 3.5 }],
	};
}

test("generic credentials require both entropy above the floor and a Python-policy digit", () => {
	const screen = createCcCredentialScreen(catalog());
	expect(screen(`token:${mixed}`)).toBe("generic-policy");
	expect(screen(`token:${letters}`)).toBeNull();
	expect(screen(`token:${"a".repeat(15)}1`)).toBeNull();
	expect(screen(`token:${letters.slice(0, 15)}\u00b2`)).toBe("generic-policy");
	const equalFloor = catalog();
	equalFloor.rules[0]!.entropy = 4;
	expect(createCcCredentialScreen(equalFloor)(`token:${mixed}`)).toBeNull();
});

test("global search state cannot skip a credential on the next line", () => {
	const screen = createCcCredentialScreen(catalog());
	expect(screen(`token:${mixed}`)).toBe("generic-policy");
	expect(screen("ordinary input")).toBeNull();
	expect(screen(`token:${mixed}`)).toBe("generic-policy");
});

test("AND allowlists require both checks while unavailable path evidence cannot allow a line", () => {
	const source = catalog();
	source.rules[0]!.allowlists = [{
		condition: "AND", target: "secret", regexes: [{ pattern: "1$", flags: "u" }], stopwords: ["abcd"],
	}];
	expect(createCcCredentialScreen(source)(`token:${mixed}`)).toBeNull();
	source.rules[0]!.allowlists[0]!.stopwords = ["missing"];
	expect(createCcCredentialScreen(source)(`token:${mixed}`)).toBe("generic-policy");
	source.rules[0]!.allowlists[0]!.condition = "OR";
	expect(createCcCredentialScreen(source)(`token:${mixed}`)).toBeNull();
	source.rules[0]!.allowlists[0]!.condition = "AND";
	source.rules[0]!.allowlists[0]!.stopwords = ["abcd"];
	source.rules[0]!.allowlists[0]!.needs_path = true;
	expect(createCcCredentialScreen(source)(`token:${mixed}`)).toBe("generic-policy");
});

test("line-target global allowlists inspect the line rather than the captured value", () => {
	const source = catalog();
	source.global_allowlists = [{ target: "line", regexes: [{ pattern: "^ALLOW ", flags: "u" }] }];
	const screen = createCcCredentialScreen(source);
	expect(screen(`ALLOW token:${mixed}`)).toBeNull();
	expect(screen(`token:${mixed} ALLOW`)).toBe("generic-policy");
});

test("empty or unsupported catalogs refuse rather than silently clearing all credentials", () => {
	const empty = catalog();
	empty.rules = [];
	expect(() => createCcCredentialScreen(empty)).toThrow("CC_CREDENTIAL_CATALOG");
	const unsupported = catalog();
	unsupported.rules[0]!.regex.flags = "";
	expect(() => createCcCredentialScreen(unsupported)).toThrow("CC_CREDENTIAL_REGEX_DIALECT");
	const badRanges = catalog();
	badRanges.python_digit_ranges = [[57, 48]];
	expect(() => createCcCredentialScreen(badRanges)).toThrow("CC_CREDENTIAL_DIGIT_POLICY");
});
