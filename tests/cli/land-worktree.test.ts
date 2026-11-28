// Affected-test source dependencies: src/land.ts
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as land from "../../src/land.ts";
import { command, git, hunkSetup, LAND_DEFAULT_TIMEOUT_MS, patchHold, remoteHead, responseCode, scratch } from "./private-index-land.helpers.ts";

setDefaultTimeout(LAND_DEFAULT_TIMEOUT_MS);

function worktreePaths(work: string): string[] {
	return git(work, ["worktree", "list", "--porcelain", "-z"]).split("\0")
		.filter(field => field.startsWith("worktree ")).map(field => field.slice("worktree ".length)).sort();
}

for (const phase of ["base", "reconstruction"] as const) {
	test(`LANDWORKTREE1: failed ${phase} checkout refuses publication, removes its own locked record and keeps unrelated worktrees`, () => {
		const { work, fakeBin, base, patch } = hunkSetup("none");
		const root = realpathSync(scratch);
		const live = join(root, `live-${globalThis.fixtureNumber++}`);
		const missing = join(root, `offline-${globalThis.fixtureNumber++}`);
		git(work, ["worktree", "add", "--detach", live, "HEAD"]);
		git(work, ["worktree", "add", "--detach", missing, "HEAD"]);
		renameSync(missing, `${missing}-offline`);
		const before = worktreePaths(work);
		expect(before).toContain(missing);
		const head = git(work, ["rev-parse", "HEAD"]).trim();
		const published = remoteHead(work);
		const tmp = join(root, `patch-tmp-${globalThis.fixtureNumber++}`);
		mkdirSync(tmp);
		const recorded = join(tmp, "registered-path");
		const realGit = Bun.which("git");
		if (!realGit) throw new Error("real Git required for the worktree failure fixture");
		// Real Git writes a locked registration; remove its work directory as a killed add can.
		// The wrapper only induces the exit boundary. Land's list/remove use real Git unchanged.
		writeFileSync(join(fakeBin, "git"), [
			"#!/bin/sh",
			"set -eu",
			'if [ "$1" = worktree ] && [ "${2:-}" = add ]; then',
			'  case "$4" in "$TEST_TMP"/omp-kit-land-patch*/work*) ;; *) exit 98 ;; esac',
			'  "$TEST_REAL_GIT" worktree add --detach --lock --reason initializing "$4" "$5"',
			'  printf "%s\\n" "$4" > "$TEST_RECORDED"',
			'  "$TEST_REAL_GIT" -C "$4" rev-parse --absolute-git-dir >> "$TEST_RECORDED"',
			'  rm -r -- "$4"',
			"  exit 1",
			"fi",
			'exec "$TEST_REAL_GIT" "$@"',
		].join("\n") + "\n", { mode: 0o755 });
		const claim = phase === "base" ? ["--base", base] : [];
		const ids = new Set<string>();
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = command(work, ["--patch", patch, ...claim, "--message", "fix: worktree fixture [test]", "--apply", "--yes"], patchHold(), {
				amDir: fakeBin,
				gitEnv: { TMPDIR: tmp, TEST_TMP: tmp, TEST_REAL_GIT: realGit, TEST_RECORDED: recorded },
			});
			expect(result.status, JSON.stringify(result.body)).toBe(77);
			expect(responseCode(result.body)).toBe("LAND_CONSTRUCTION_UNAVAILABLE");
			const [abandoned, gitDir] = readFileSync(recorded, "utf8").trimEnd().split("\n");
			if (!abandoned || !gitDir) throw new Error("the plant did not observe a real worktree registration");
			expect(basename(dirname(abandoned))).toMatch(phase === "base" ? /^omp-kit-land-patch-base\./ : /^omp-kit-land-patch\./);
			expect(worktreePaths(work)).toEqual(before);
			expect(existsSync(dirname(abandoned))).toBe(false);
			expect(existsSync(live)).toBe(true);
			expect(git(work, ["rev-parse", "HEAD"]).trim()).toBe(head);
			expect(remoteHead(work)).toBe(published);
			ids.add(basename(gitDir));
		}
		expect(ids.size).toBe(2);
	});
}

test("LANDWORKTREE1: patch checkout defaults to 300 s and accepts a clamped integer override", () => {
	const key = "OMP_KIT_LAND_WORKTREE_DEADLINE_S";
	const saved = process.env[key];
	try {
		delete process.env[key];
		expect(land.landWorktreeDeadlineSeconds()).toBe(300);
		for (const [raw, want] of [["120", 120], ["5", 30], ["99999", 1800], ["", 300], ["soon", 300], ["12.5", 300]] as const) {
			process.env[key] = raw;
			expect(land.landWorktreeDeadlineSeconds(), raw).toBe(want);
		}
	} finally {
		if (saved === undefined) delete process.env[key]; else process.env[key] = saved;
	}
});
