import { afterAll, expect, test } from "bun:test";
import { runFixture } from "./fixture-process.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

test("doctor accepts mission scope for a valid mission fixture", () => {
	const root = ownedTmp("mission-doctor").path;
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "mission.toml"), 'name = "fixture"\n');
	const result = runFixture([process.execPath, join(import.meta.dir, "../../src/cli.ts"), "doctor", "--scope", "mission", "--json"], { cwd: root });
	const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
	expect(parsed.errors?.some((error: { code?: string; message?: string }) => error.code === "INVALID_VALUE" && error.message?.includes("Unknown scope"))).toBe(false);
});
