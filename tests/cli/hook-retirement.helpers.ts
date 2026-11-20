// hook-retirement.helpers.ts — RETIREHOOKS1 (ompkit-1ra0d.22) consumer-acceptance and owner-bytes cases,
// one case per test file (each runs four real commits through the full installed hook chain) so every
// file stays inside the per-file gate budget.
// They exercise Git's installed chains, not a source-text inventory: C and K use .git/hooks; H uses a
// worktree-relative core.hooksPath.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

export function retirementCase(site: "C" | "H" | "K", control: "gap-prose-retirement" | "citation-not-ceremony"): void {
	{
		test(`RETIREHOOKS1 ${site}: ${control} preserves consumer acceptance`, async () => {
			const scratch = ownedTmp(`retire-hooks-${site.toLowerCase()}`);
			const repo = scratch.path;
			const root = resolve(import.meta.dir, "../..");
			const env = {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				OMP_KIT_COMMIT_MSG_BEAD_SKIP_TRACKER: "1",
				OMP_KIT_GATE_EVENTS_SKIP: "1",
			};
			const exec = (argv: string[]) => runFixtureAsync(argv, { cwd: repo, env, floor_s: 60 });
			const success = async (argv: string[]) => {
				const result = await exec(argv);
				expect({ rc: result.rc, output: Buffer.from(result.stdout).toString() + Buffer.from(result.stderr).toString() })
					.toEqual({ rc: 0, output: expect.any(String) });
				return result;
			};
			const commit = (body: string) => exec(["git", "commit", "-qm", `fix: repair consumer [test]\n\n${body}\n\nBead: ompkit-1ra0d.22`]);
			try {
				await success(["git", "init", "-q", "--template="]);
				await success(["git", "config", "user.name", "Hook retirement fixture"]);
				await success(["git", "config", "user.email", "retire@invalid"]);
				if (site === "H") await success(["git", "config", "core.hooksPath", ".githooks"]);
				await success(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", repo]);
				const hooks = join(repo, site === "H" ? ".githooks" : ".git/hooks");
				const acceptance = join(hooks, "hooks.d/pre-commit/10-consumer-acceptance");
				writeFileSync(acceptance, '#!/bin/sh\n[ "$(sh ./consumer.sh)" = repaired ] || { echo CONSUMER_BROKEN >&2; exit 1; }\n');
				chmodSync(acceptance, 0o755);
				mkdirSync(join(repo, "changelog.d"));
				writeFileSync(join(repo, "changelog.d/1ra0d.22.md"), "- Repair the consumer.\n");
				writeFileSync(join(repo, "consumer.sh"), "printf '%s\\n' repaired\n");
				const gapBody = "The gap: repaired consumer output is covered by its behavior check.";
				if (control === "citation-not-ceremony") {
					mkdirSync(join(repo, ".omp"));
					writeFileSync(join(repo, ".omp/sources.toml"), 'globs = ["*.md"]\n');
					writeFileSync(join(repo, "repair.md"), "Consumer now returns repaired. Reference: https://example.org/repair\n");
					await success(["git", "add", "--", ".omp/sources.toml", "repair.md"]);
				}
				await success(["git", "add", "--", "consumer.sh", "changelog.d/1ra0d.22.md"]);
				// PASS: first attempt, with literal gap prose or without registry boilerplate.
				const passed = await commit(control === "gap-prose-retirement" ? gapBody : "Document the tested repair without a citation registry.");
				expect({ rc: passed.rc, stderr: Buffer.from(passed.stderr).toString() }).toEqual({ rc: 0, stderr: expect.any(String) });

				// FAIL plant: broken behavior cannot land, regardless of prose, registry claims, or retry.
				writeFileSync(join(repo, "consumer.sh"), "printf '%s\\n' broken\n");
				writeFileSync(join(repo, "repair.md"), "Fabricated source says the output is repaired. [src:invented]\n");
				await success(["git", "add", "--", "consumer.sh", "repair.md"]);
				const head = await success(["git", "rev-parse", "HEAD"]);
				for (const body of [gapBody, gapBody, "The source claims this works."]) {
					const broken = await commit(body);
					expect(broken.rc).not.toBe(0);
					expect(Buffer.from(broken.stderr).toString()).toContain("CONSUMER_BROKEN");
				}
				expect(Buffer.from((await success(["git", "rev-parse", "HEAD"])).stdout).toString())
					.toBe(Buffer.from(head.stdout).toString());
			} finally {
				scratch.cleanup();
			}
		}, fixtureDeadlineS(120) * 1000);
	}
}

export function ownerModifiedCases(): void {
	for (const [chain, name] of [
		["commit-msg", "47-omp-kit-gap-mention"],
		["pre-commit", "52-omp-kit-staged-sources"],
	]) {
		test(`RETIREHOOKS1 preserves owner-modified legacy ${chain} bytes`, async () => {
			const scratch = ownedTmp("retire-hooks-owner");
			const root = resolve(import.meta.dir, "../..");
			const exec = (argv: string[]) => runFixtureAsync(argv, { cwd: scratch.path, floor_s: 60 });
			try {
				expect((await exec(["git", "init", "-q", "--template="])).rc).toBe(0);
				expect((await exec(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", scratch.path])).rc).toBe(0);
				const retired = join(scratch.path, ".git/hooks/hooks.d", chain!, name!);
				const bytes = "#!/bin/sh\n# Repository owner's adapted acceptance check.\nexit 17\n";
				writeFileSync(retired, bytes);
				const sentinel = join(scratch.path, ".git/hooks/hooks.d/pre-commit/45-omp-kit-staged-imports");
				const before = readFileSync(sentinel, "utf8");
				const refused = await exec(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", scratch.path]);
				expect(refused.rc).toBe(2);
				expect(Buffer.from(refused.stderr).toString()).toContain("owner-modified retired member");
				expect(readFileSync(retired, "utf8")).toBe(bytes);
				expect(readFileSync(sentinel, "utf8")).toBe(before);
			} finally {
				scratch.cleanup();
			}
		}, fixtureDeadlineS(120) * 1000);
	}
}

// RETIRESHIPPED1 (ompkit-1ra0d.243): a repo installed from an older release holds an older
// kit-shipped copy of a retired member (localbench and zestroku held gap-mention e6e80d85). That
// copy is the kit's, so it retires; changing even one byte must preserve it and refuse refresh.
export function shippedOlderCases(): void {
	for (const [chain, name, digestPrefix] of [
		["commit-msg", "47-omp-kit-gap-mention", "e6e80d85"],
		["pre-commit", "52-omp-kit-staged-sources", "0c981262"],
	] as const) {
		test(`RETIRESHIPPED1 retires shipped ${chain} bytes but preserves a one-byte edit`, async () => {
			const scratch = ownedTmp("retire-shipped");
			const root = resolve(import.meta.dir, "../..");
			const exec = (argv: string[]) => runFixtureAsync(argv, { cwd: scratch.path, floor_s: 60 });
			try {
				expect((await exec(["git", "init", "-q", "--template="])).rc).toBe(0);
				expect((await exec(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", scratch.path])).rc).toBe(0);
				const retired = join(scratch.path, ".git/hooks/hooks.d", chain, name);
				const shipped = readFileSync(join(import.meta.dir, "fixtures/retired-shipped", name));
				const digest = Bun.CryptoHasher.hash("sha256", shipped, "hex");
				expect(digest.slice(0, 8)).toBe(digestPrefix);
				const edit = Buffer.from(shipped);
				edit[0] = edit[0]! ^ 1;
				writeFileSync(retired, edit);
				chmodSync(retired, 0o755);
				const refused = await exec(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", scratch.path]);
				const diagnostic = Buffer.from(refused.stderr).toString();
				expect(refused.rc, diagnostic).toBe(2);
				expect(diagnostic).toContain(`REFUSED owner-modified retired member: ${retired}`);
				expect(readFileSync(retired)).toEqual(edit);

				writeFileSync(retired, shipped);
				const rerun = await exec(["sh", join(root, "scripts/install-commit-msg-bead.sh"), "--no-pushed-beads", scratch.path]);
				expect(rerun.rc, Buffer.from(rerun.stderr).toString()).toBe(0);
				expect(Buffer.from(rerun.stdout).toString()).toContain(`retired kit hook member: ${retired}`);
				expect(() => readFileSync(retired)).toThrow("ENOENT");
				console.log(JSON.stringify({ scenario: "RETIRESHIPPED1", name, digest, editedOffset: 0,
					editedExit: refused.rc, shippedExit: rerun.rc, retired: true }));
			} finally {
				scratch.cleanup();
			}
		}, fixtureDeadlineS(120) * 1000);
	}
}
