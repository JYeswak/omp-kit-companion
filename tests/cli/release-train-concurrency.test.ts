import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { gitFixtureEnv, seedProductBeads } from "./release-fixture.ts";
import { runFixture } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

/** Exercise the production publication step; service stubs are not certification proof. */
const WORKFLOW = process.env.RELEASE_TRAIN_PATH ?? join(import.meta.dir, "../../.github/workflows/release-train.yml");

test("actual publication step blocks incomplete SBOMs and failed repair before stable finalization", () => {
	const repo = join(import.meta.dir, "../..");
	const scratch = ownedTmp("publication-sbom", { root: process.env.TMPDIR ?? join(repo, "var/agent-tmp") }).path;
	try {
		const doc = YAML.parse(readFileSync(WORKFLOW, "utf8"));
		const body = doc.jobs.publish.steps.find((step: { name?: string }) => step.name?.startsWith("Publish the same")).run;
		mkdirSync(join(scratch, "bin"));
		mkdirSync(join(scratch, "scripts"));
		mkdirSync(join(scratch, "candidate-index"));
		mkdirSync(join(scratch, "selection"));
		symlinkSync(join(repo, "scripts/release-train.sh"), join(scratch, "scripts/release-train.sh"));
		for (const name of ["release-preflight.sh", "release-notes.sh", "release-notes.ts"])
			symlinkSync(join(repo, "scripts", name), join(scratch, "scripts", name));
		const env = { ...gitFixtureEnv(scratch), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
		const git = (args: string[]) => {
			const result = runFixture(["git", ...args], { cwd: scratch, env, floor_s: 10 });
			if (result.rc !== 0) throw new Error(new TextDecoder().decode(result.stderr));
			return new TextDecoder().decode(result.stdout).trim();
		};
		git(["init", "-q", "--template="]);
		git(["commit", "-qm", "published base", "--allow-empty"]);
		git(["tag", "v0.2.40"]);
		seedProductBeads(scratch, git);
		const source = git(["rev-parse", "HEAD"]);
		git(["tag", "v0.2.41", source]);
		writeFileSync(join(scratch, "selection/release-notes.md"), "- Fixture notes only.\n");
		// No live remote is used; the fixture already contains the exact tagged Git history.
		writeFileSync(join(scratch, "bin/git"), `#!/bin/sh\nwhile [ "$1" = "-c" ]; do shift 2; done\nif [ "$1 $2 $3" = 'fetch origin main' ]; then exit 0; fi\nexec "$RELEASE_TEST_GIT" "$@"\n`, { mode: 0o700 });
		writeFileSync(join(scratch, "bin/gh"), `#!/bin/sh
case "$1 $2" in
"api --paginate")
	if [ "$PUBLISHED_BASE_CHANGED" = 1 ]; then
		echo '[[{"tag_name":"v0.2.41","draft":false,"prerelease":false}]]'
	else
		echo '[[{"tag_name":"v0.2.40","draft":false,"prerelease":false}]]'
	fi ;;
"release create") echo DRAFT_FIXTURE_ONLY ;;
"release edit") echo PUBLICATION_FIXTURE_ONLY ;;
*) exit 99 ;;
esac
`, { mode: 0o700 });
		// The repair helper has independent native-shaped asset/authority tests.
		// This executable workflow test isolates only the SBOM/finalization seam.
		writeFileSync(join(scratch, "bin/python3"), `#!/bin/sh\ncase "$1 $2" in\n"scripts/release_reuse.py repair-release") test "\${REPAIR_FAIL:-0}" != 1;;\n"scripts/release_reuse.py latest-flag") printf '%s\\n' --latest;;\n*) exit 99;;\nesac\n`, { mode: 0o700 });
		const platforms = ["darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu"];
		const assets: Record<string, { filename: string }> = {};
		for (const platform of platforms) {
			mkdirSync(join(scratch, "archives", platform), { recursive: true });
			mkdirSync(join(scratch, "sboms", platform), { recursive: true });
			assets[platform] = { filename: `fixture-${platform}.tar` };
			writeFileSync(join(scratch, "archives", platform, assets[platform]!.filename), "SBOM gate fixture; not a certified archive");
		}
		writeFileSync(join(scratch, "candidate-index/release-index.json"), JSON.stringify({ assets }));
		const run = (extra: Record<string, string> = {}) => Bun.spawnSync(["bash", "-c", body], {
			cwd: scratch, stdout: "pipe", stderr: "pipe",
			env: { ...env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`, VERSION: "0.2.41",
				BASE_TAG: "v0.2.40", SHA: source, GITHUB_REPOSITORY: "fixture/not-a-live-release",
				RELEASE_TEST_GIT: Bun.which("git")!, REPAIR_FAIL: "0", PUBLISHED_BASE_CHANGED: "0", ...extra },
		});
		const zero = run();
		expect(zero.exitCode).not.toBe(0);
		expect(zero.stdout.toString()).not.toContain("PUBLICATION_FIXTURE_ONLY");
		expect(zero.stdout.toString()).not.toContain("DRAFT_FIXTURE_ONLY");
		for (const platform of platforms.slice(0, 2))
			writeFileSync(join(scratch, "sboms", platform, `sbom-${platform}.spdx.json`), "{}\n");
		const missingArm = run();
		expect(missingArm.exitCode).not.toBe(0);
		expect(missingArm.stdout.toString()).not.toContain("PUBLICATION_FIXTURE_ONLY");
		expect(missingArm.stdout.toString()).not.toContain("DRAFT_FIXTURE_ONLY");
		writeFileSync(join(scratch, "sboms", platforms[2]!, `sbom-${platforms[2]!}.spdx.json`), "{}\n");
		const complete = run();
		expect(complete.exitCode, complete.stderr.toString()).toBe(0);
		expect(complete.stdout.toString()).toContain("PUBLICATION_FIXTURE_ONLY");
		const failedRepair = run({ REPAIR_FAIL: "1" });
		expect(failedRepair.exitCode).not.toBe(0);
		expect(failedRepair.stdout.toString()).not.toContain("PUBLICATION_FIXTURE_ONLY");
		const moved = run({ PUBLISHED_BASE_CHANGED: "1" });
		expect(moved.exitCode).toBe(4);
		expect(moved.stderr.toString()).toContain("RELEASE_PRODUCT_BASE_MOVED");
		expect(moved.stdout.toString()).not.toContain("DRAFT_FIXTURE_ONLY");
		expect(moved.stdout.toString()).not.toContain("PUBLICATION_FIXTURE_ONLY");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("current-attempt containers normalize without admitting stale snapshots or overwriting collisions", () => {
	const repo = join(import.meta.dir, "../..");
	const scratch = ownedTmp("artifact-attempt", { root: process.env.TMPDIR ?? join(repo, "var/agent-tmp") }).path;
	try {
		const doc = YAML.parse(readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"));
		const body = doc.jobs["candidate-index"].steps.find((step: { name?: string }) => step.name === "Normalize current-attempt artifact containers").run;
		const current = join(scratch, "candidates/candidate-linux-x64-gnu-attempt-2");
		const stale = join(scratch, "candidates/candidate-linux-x64-gnu-attempt-1");
		const receipt = join(scratch, "receipts/native-receipt-linux-x64-gnu-minimum-attempt-2");
		for (const path of [current, stale, receipt]) mkdirSync(path, { recursive: true });
		writeFileSync(join(current, "asset.json"), "current");
		writeFileSync(join(stale, "asset.json"), "stale");
		writeFileSync(join(receipt, "receipt.json"), "current receipt");
		const run = () => Bun.spawnSync(["bash", "-c", body], {
			cwd: scratch, stdout: "pipe", stderr: "pipe",
			env: { ...process.env, RUNNER_TEMP: scratch, GITHUB_RUN_ATTEMPT: "2" },
		});
		const normalized = run();
		expect(normalized.exitCode, normalized.stderr.toString()).toBe(0);
		expect(readFileSync(join(scratch, "candidates/candidate-linux-x64-gnu/asset.json"), "utf8")).toBe("current");
		expect(readFileSync(join(stale, "asset.json"), "utf8")).toBe("stale");
		expect(readFileSync(join(scratch, "receipts/native-receipt-linux-x64-gnu-minimum/receipt.json"), "utf8")).toBe("current receipt");
		mkdirSync(current);
		writeFileSync(join(current, "asset.json"), "must not overwrite");
		const collision = run();
		expect(collision.exitCode).toBe(4);
		expect(readFileSync(join(scratch, "candidates/candidate-linux-x64-gnu/asset.json"), "utf8")).toBe("current");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
