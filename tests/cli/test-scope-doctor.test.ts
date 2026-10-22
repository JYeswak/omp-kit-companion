import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { diagnose } from "../../src/diagnostics.ts";
import { inspectTestScope } from "../../src/test-scope.ts";

test("doctor test-scope rejects a planted scratch runner copy and accepts the control", async () => {
	const base = ownedTmp("omp-kit-test-scope").path;
	try {
		const repo = join(base, "fixture-repo");
		const config = join(base, "fleet-watch.json");
		const scratchTest = join(repo, "var", "agent-tmp", "copy", "tests", "x.test.ts");
		mkdirSync(join(repo, "tests"), { recursive: true });
		mkdirSync(join(scratchTest, ".."), { recursive: true });
		writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
		writeFileSync(join(repo, "tests", "x.test.ts"), "export {};\n");
		writeFileSync(scratchTest, "export {};\n");
		writeFileSync(config, JSON.stringify({ sessions: [{ repo }] }));
		const negative = inspectTestScope(config);
		expect(negative.status).toBe("FAIL");
		expect(negative.evidence?.repos).toEqual([expect.objectContaining({ repo, runner: "bun", verdict: "FAIL" })]);
		writeFileSync(join(repo, "bunfig.toml"), `[test]\npathIgnorePatterns = ["var/agent-tmp/**", "${dirname(base)}/**"]\n`);
		const control = inspectTestScope(config);
		expect(control.status).toBe("OK");
		expect(control.evidence?.repos).toEqual([expect.objectContaining({ repo, runner: "bun", config: join(repo, "bunfig.toml"), verdict: "PASS" })]);
		const prior = process.env.OMP_KIT_FLEET_WATCH_CONFIG;
		process.env.OMP_KIT_FLEET_WATCH_CONFIG = config;
		try {
			const scoped = await diagnose({ root: base, home: base, scope: "test-scope" });
			expect(scoped).toEqual([expect.objectContaining({ component: "test-scope", status: "OK" })]);
		} finally {
			if (prior === undefined) delete process.env.OMP_KIT_FLEET_WATCH_CONFIG;
			else process.env.OMP_KIT_FLEET_WATCH_CONFIG = prior;
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
