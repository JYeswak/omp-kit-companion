// EXPORTTEST1 [a] (ompkit-fp72.120.16.157): a planted test that passes in the checkout but fails
// in commit-preflight's export (no .git, long TMPDIR) is refused EXPORT_TEST_FAILED; the same file
// with no path-length dependence is clean. The planted file lives in a fixture repository this
// test builds, because a really failing file shipped here would fail the full-suite verdict too.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const source = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("fixture-long-path");
afterAll(() => scratch.cleanup());
const repo = join(scratch.path, "repo");
const env: Record<string, string | undefined> = {
	...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
	TMPDIR: scratch.path,
	GIT_CEILING_DIRECTORIES: scratch.path,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@invalid",
	GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@invalid",
	OMP_KIT_GATE_EVENTS_SKIP: "1",
};
const planted = "tests/cli/fixture-long-path.test.ts";

async function sh(argv: string[], floor = 20) {
	const result = await runFixtureAsync(argv, { cwd: repo, env, floor_s: floor });
	const decoder = new TextDecoder();
	return { rc: result.rc, out: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

// Bound sits 40 bytes above the checkout TMPDIR; the export adds ~100 (owned dir, export dir, archive/var/agent-tmp).
function plant(bound: number): void {
	writeFileSync(join(repo, planted), `import { expect, test } from "bun:test";\ntest("socket-length path fits", () => {\n\tconst length = (process.env["TMPDIR"] ?? "").length;\n\texpect(length).toBeLessThan(${bound});\n});\n`);
}

test("planted long-path failure is refused by the box's literal command; the passing file is clean", async () => {
	mkdirSync(join(repo, "tests/cli"), { recursive: true });
	expect((await sh(["git", "init", "-q", "--template=", repo])).rc).toBe(0);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	expect((await sh(["git", "add", "seed.txt"])).rc).toBe(0);
	expect((await sh(["git", "commit", "-qm", "seed"])).rc).toBe(0);
	const literal = ["sh", join(source, "scripts/commit-preflight.sh"), "--files", planted, "--tests", planted];

	plant(scratch.path.length + 40);
	const checkout = await sh(["bun", "test", `./${planted}`]);
	expect(checkout.rc, checkout.out).toBe(0);
	const fire = await sh(literal, 120);
	expect(fire.rc, fire.out).toBe(1);
	expect(fire.out).toContain(`REFUSED EXPORT_TEST_FAILED ${planted} (exit 1)`);
	expect(fire.out).toContain("1 refused/unjudged");

	// Control: the same file with no path-length dependence passes in the same export.
	plant(1 << 20);
	const quiet = await sh(literal, 120);
	expect(quiet.rc, quiet.out).toBe(0);
	expect(quiet.out).toContain(`PASS export-test:${planted}`);
	expect(quiet.out).toMatch(/commit-preflight: \d+ checks, 0 refused\/unjudged, [^\n]*; 1 export test file\(s\) run/);
	expect(quiet.out).not.toContain("EXPORT_TEST_FAILED");
}, fixtureDeadlineS(300) * 1000);
