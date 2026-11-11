import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { declaresDependencies } from "../../src/verify.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

test("VERIFYNODEPS1: only a package.json with a non-empty dependency map needs a lockfile", () => {
	const dir = ownedTmp("verify-nodeps").path;
	const write = (name: string, body: string) => { mkdirSync(join(dir, name), { recursive: true }); writeFileSync(join(dir, name, "package.json"), body); return join(dir, name, "package.json"); };
	// The kit's own repo shape: scripts and metadata, no dependency maps.
	expect(declaresDependencies(write("kit", JSON.stringify({ name: "kit", private: true, scripts: { test: "bun test" } })))).toBe(false);
	expect(declaresDependencies(write("empty-maps", JSON.stringify({ dependencies: {}, devDependencies: {} })))).toBe(false);
	expect(declaresDependencies(join(dir, "absent", "package.json"))).toBe(false);
	// Planted negatives: any declared dependency, in any map, still requires a lockfile.
	for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		expect(declaresDependencies(write(key, JSON.stringify({ [key]: { greet: "1.0.0" } })))).toBe(true);
	}
	// An unparsable manifest cannot be proven dependency-free.
	expect(declaresDependencies(write("broken", "{ not json"))).toBe(true);
});
