// EXPORTPARITY1 (ompkit-fp72.120.16.195): commit-preflight --tests runs in the verdict's layout.
// The export is a stamped archive of the HEAD commit (export-subst fills source_revision), the
// judged bytes are overlaid, and `git init -q` makes it a history-free repository root, as in
// full-suite-verdict.sh. Planted: a suite that needs all three passes. Control: the same suite
// asserting a wrong stamp is still refused EXPORT_TEST_FAILED.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const source = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("commit-preflight-export");
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
const suite = "tests/cli/layout.test.sh";

async function sh(argv: string[], floor = 20) {
	const result = await runFixtureAsync(argv, { cwd: repo, env, floor_s: floor });
	const decoder = new TextDecoder();
	return { rc: result.rc, out: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

// The suite needs the verdict layout: its own repository root, a stamped source_revision, and the overlay named.
function plant(revision: string): void {
	writeFileSync(join(repo, suite), [
		"#!/bin/sh",
		"set -eu",
		"top=$(git rev-parse --show-toplevel) || exit 1",
		"[ \"$top\" = \"$(pwd -P)\" ] || { printf 'not the repository root: %s\\n' \"$top\"; exit 1; }",
		`grep -q '"source_revision": "${revision}"' package.json || { echo 'source_revision unstamped'; exit 1; }`,
		`grep -q '"${suite}"' .git/omp-kit-export.json || { echo 'overlay unnamed'; exit 1; }`,
		"echo 'verdict layout ok'",
		"",
	].join("\n"));
}

let head = "";
beforeAll(async () => {
	mkdirSync(join(repo, "tests/cli"), { recursive: true });
	expect((await sh(["git", "init", "-q", "--template=", repo])).rc).toBe(0);
	writeFileSync(join(repo, ".gitattributes"), "package.json export-subst\n");
	writeFileSync(join(repo, "package.json"), '{\n  "source_revision": "$Format:%H$"\n}\n');
	expect((await sh(["git", "add", ".gitattributes", "package.json"])).rc).toBe(0);
	expect((await sh(["git", "commit", "-qm", "seed"])).rc).toBe(0);
	head = (await sh(["git", "rev-parse", "HEAD"])).out.trim();
	expect(head).toMatch(/^[0-9a-f]{40}$/);
});

test("--tests export carries the stamp, the overlay record and a repository root; a wrong stamp is still refused", async () => {
	const preflight = ["sh", join(source, "scripts/commit-preflight.sh"), "--files", suite, "--tests", suite];

	plant(head);
	const parity = await sh(preflight, 120);
	expect(parity.rc, parity.out).toBe(0);
	expect(parity.out).toContain("verdict layout ok");
	expect(parity.out).toContain(`export: HEAD ${head} + 1 overlaid, 0 deleted`);
	expect(parity.out).toContain(`PASS export-test:${suite}`);
	expect(parity.out).toMatch(/commit-preflight: \d+ checks, 0 refused\/unjudged, [^\n]*; 1 export test file\(s\) run/);

	// Control: a stamp the export does not carry is a real failure and stays refused.
	plant("0".repeat(40));
	const refused = await sh(preflight, 120);
	expect(refused.rc, refused.out).toBe(1);
	expect(refused.out).toContain("source_revision unstamped");
	expect(refused.out).toContain(`REFUSED EXPORT_TEST_FAILED ${suite} (exit 1)`);
}, fixtureDeadlineS(300) * 1000);

// The gate runs bun through suite-metrics.py stage with --timeout=120000; bun's own default is 5 s.
// The planted wait is real on purpose: it is bun's per-test wall-clock timeout under test.
test("a 6 s bun test the gate's runner admits is admitted by --tests too; a failing one is still refused", async () => {
	const slow = "tests/cli/slow.test.ts";
	const slowText = 'import { expect, test } from "bun:test";\ntest("six seconds", async () => {\n\tawait Bun.sleep(6000);\n\texpect(OUTCOME).toBe(true);\n});\n';
	writeFileSync(join(repo, slow), slowText.replace("OUTCOME", "true"));
	// The gate's runner on the same bytes in the checkout: fresh-gate's stage invocation.
	const records = join(scratch.path, "gate-records");
	const gate = await sh(["python3", join(source, "scripts/suite-metrics.py"), "stage", "--runner", "bun",
		"--records", records, "--cwd", repo, "--tree", head, "--summary", `${records}.summary.json`,
		"--workers", "1", "--deadline", "120", slow], 60);
	expect(gate.rc, gate.out).toBe(0);
	const preflight = ["sh", join(source, "scripts/commit-preflight.sh"), "--files", slow, "--tests", slow];
	const admitted = await sh(preflight, 120);
	expect(admitted.rc, admitted.out).toBe(0);
	expect(admitted.out).toContain(`PASS export-test:${slow}`);
	expect(admitted.out).not.toContain("timed out after 5000ms");
	// Control: the same 6 s test failing its assertion is still refused.
	writeFileSync(join(repo, slow), slowText.replace("OUTCOME", "false"));
	const refused = await sh(preflight, 120);
	expect(refused.rc, refused.out).toBe(1);
	expect(refused.out).toContain(`REFUSED EXPORT_TEST_FAILED ${slow} (exit 1)`);
}, fixtureDeadlineS(300) * 1000);
