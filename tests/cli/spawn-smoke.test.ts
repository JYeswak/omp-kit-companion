import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSpawnSmoke, spawnSmokePrerequisites } from "../../scripts/spawn-smoke.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
const missing = spawnSmokePrerequisites().missing;
if (missing.length) console.info(`spawn-smoke: SKIP unmet prerequisite: ${missing.join(", ")}`);
const nativeTest = test.skipIf(missing.length > 0);

test("missing native executables name the unmet prerequisites", () => {
	expect(spawnSmokePrerequisites({ PATH: "" }).missing).toEqual([
		"omp executable on PATH", "native br binary (BR_REAL_ABSENT)",
	]);
});

nativeTest("fresh non-kit native build spawn admits the verbatim candidate brief", async () => {
	const result = await runSpawnSmoke();
	expect(result.childOutput).toBe("native-spawn-admitted");
}, 120_000);

nativeTest("planted predecessor lookup of brief-quoted kit ids kills the same native spawn smoke", async () => {
	const scope = ownedTmp("spawn-smoke-mutant");
	try {
		const guard = join(scope.path, "guard.ts");
		writeFileSync(guard, `import candidate from ${JSON.stringify(pathToFileURL(join(root, "extensions/kit-flywheel-guard.ts")).href)};
export default async function (pi) {
  await candidate(pi);
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "task") return;
    const text = JSON.stringify(event.input);
    const ids = [...new Set(text.match(/ompkit-[a-z0-9]+(?:\\.[a-z0-9]+)*/g) ?? [])];
    for (const id of ids) {
      const result = await pi.exec("br", ["show", id, "--json"], { cwd: ctx.cwd, timeout: ${fixtureDeadlineS(30) * 1000} });
      if (result.code !== 0) return { block: true, reason: "PRIOR_ART_SPAWN_REFUSED: " + id + " missing from target tracker" };
    }
  });
}
`);
		await expect(runSpawnSmoke({ guard })).rejects.toThrow("PRIOR_ART_SPAWN_REFUSED");
	} finally { scope.cleanup(); }
}, 120_000);
