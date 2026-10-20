import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("doctor accepts mission scope for a valid mission fixture", () => {
	const root = mkdtempSync(join(tmpdir(), "mission-doctor-"));
	mkdirSync(join(root, ".omp"), { recursive: true });
	writeFileSync(join(root, ".omp", "mission.toml"), 'name = "fixture"\n');
	const result = spawnSync("omp-kit", ["doctor", "--scope", "mission", "--json"], { cwd: root, encoding: "utf8" });
	const parsed = JSON.parse(result.stdout);
	expect(parsed.errors?.some((error: { code?: string; message?: string }) => error.code === "INVALID_VALUE" && error.message?.includes("Unknown scope"))).toBe(false);
});
