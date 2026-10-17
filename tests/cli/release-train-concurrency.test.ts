import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

/** Exercise the production publication step; service stubs are not certification proof. */
const WORKFLOW = process.env.RELEASE_TRAIN_PATH ?? join(import.meta.dir, "../../.github/workflows/release-train.yml");

test("actual publication step blocks incomplete SBOMs and failed repair before stable finalization", () => {
	const repo = join(import.meta.dir, "../..");
	const scratch = mkdtempSync(join(process.env.TMPDIR ?? join(repo, "var/agent-tmp"), "publication-sbom."));
	try {
		writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=publication-sbom\nrepo=${repo}\n`);
		const doc = YAML.parse(readFileSync(WORKFLOW, "utf8"));
		const body = doc.jobs.publish.steps.find((step: { name?: string }) => step.name?.startsWith("Publish the same")).run;
		mkdirSync(join(scratch, "bin"));
		mkdirSync(join(scratch, "scripts"));
		mkdirSync(join(scratch, "candidate-index"));
		mkdirSync(join(scratch, "selection"));
		symlinkSync(join(repo, "scripts/release-train.sh"), join(scratch, "scripts/release-train.sh"));
		writeFileSync(join(scratch, "selection/release-notes.md"), "- Fixture notes only.\n");
		writeFileSync(join(scratch, "bin/git"), `#!/bin/sh\ncase "$1" in\nfetch) exit 0;;\nrev-parse) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;;\ntag) printf '%s\\n' v0.2.41;;\n*) exit 99;;\nesac\n`, { mode: 0o700 });
		// External services are isolated only for this SBOM precondition test;
		// their successful stubs are NOT certification or signature evidence.
		writeFileSync(join(scratch, "bin/gh"), `#!/bin/sh\ncase "$1 $2" in\n"api "*) printf '%s\\n' '[]';;\n"release create") printf '%s\\n' DRAFT_FIXTURE_ONLY;;\n"release edit") printf '%s\\n' PUBLICATION_FIXTURE_ONLY;;\n*) exit 99;;\nesac\n`, { mode: 0o700 });
		// The repair helper has independent native-shaped asset/authority tests.
		// This executable workflow test isolates only the SBOM/finalization seam.
		writeFileSync(join(scratch, "bin/python3"), `#!/bin/sh\ncase "$1 $2" in\n"scripts/release_reuse.py repair-release") test "\${REPAIR_FAIL:-0}" != 1;;\n*) exit 99;;\nesac\n`, { mode: 0o700 });
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
			env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`, VERSION: "0.2.41",
				SHA: "a".repeat(40), GITHUB_REPOSITORY: "fixture/not-a-live-release", REPAIR_FAIL: "0", ...extra },
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
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("current-attempt containers normalize without admitting stale snapshots or overwriting collisions", () => {
	const repo = join(import.meta.dir, "../..");
	const scratch = mkdtempSync(join(process.env.TMPDIR ?? join(repo, "var/agent-tmp"), "artifact-attempt."));
	try {
		writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=artifact-attempt\nrepo=${repo}\n`);
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
