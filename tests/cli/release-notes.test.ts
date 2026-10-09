import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const scratch = join(repo, "var", "agent-tmp");
const workspace = join(scratch, `release-notes.${process.pid}`);
const fixture = join(workspace, "repo");
const bead = "ompkit-rc-epic-land-fix-release-dogfood-rz5.75";
const pointer = "<!-- Add one fragment per release-note change under changelog.d/. -->";
let indexNumber = 0;
let assembledChangelog = "";
let headChangelog = "";
let releaseHead = "";

afterAll(() => {
	if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

beforeAll(() => {
	mkdirSync(scratch, { recursive: true });
	mkdirSync(workspace);
	writeFileSync(join(workspace, ".owner"), `pid=${process.pid}\nlabel=release-notes\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
	mkdirSync(fixture);
	git("init", "--initial-branch=main");
	git("config", "user.name", "Release Notes Fixture");
	git("config", "user.email", "release-notes@example.invalid");
	git("config", "commit.gpgsign", "false");
	const baseChangelog = `# Changelog

## Unreleased

- Existing in-progress release note.

${pointer}

## 0.2.2 — 2026-10-02

- Existing published note. (PR #50)
`;
	writeFileSync(join(fixture, "CHANGELOG.md"), baseChangelog);
	git("add", "CHANGELOG.md");
	git("commit", "-m", "release v0.2.2 [test]", "-m", `Bead: ${bead}`,
		"-m", "Verified: fixture baseline -> v0.2.2 changelog and tag created");
	git("tag", "v0.2.2");

	const base = git("rev-parse", "v0.2.2");
	const pr25Changelog = baseChangelog.replace(
		`${pointer}\n\n## 0.2.2`,
		`- OMP minimum and latest compatibility are certified. (PR #25)\n\n${pointer}\n\n## 0.2.2`,
	);
	const pr25 = commitWithFiles(base, "PR #25 legacy note", {
		"CHANGELOG.md": pr25Changelog,
		"legacy/pr25.txt": "merged through a nested origin/main history\n",
	});
	const merge25 = commitTree(git("rev-parse", `${pr25}^{tree}`), [base, pr25], "Merge pull request #25 from fixture/pr-25 [test]");
	const pr55Changelog = pr25Changelog.replace(
		`${pointer}\n\n## 0.2.2`,
		`- The metamorphic ratchet fails on any break. (PR #55)\n\n${pointer}\n\n## 0.2.2`,
	);
	const pr55 = commitWithFiles(merge25, "PR #55 legacy note", {
		"CHANGELOG.md": pr55Changelog,
		"legacy/pr55.txt": "merged through a nested origin/main history\n",
	});
	const merge55 = commitTree(git("rev-parse", `${pr55}^{tree}`), [merge25, pr55], "Merge pull request #55 from fixture/pr-55 [test]");
	const pr57Changelog = pr55Changelog.replace(
		`${pointer}\n\n## 0.2.2`,
		`- The work doctor inventories configured repositories. (PR #57)\n\n${pointer}\n\n## 0.2.2`,
	);
	const pr57 = commitWithFiles(merge55, "PR #57 legacy note", {
		"CHANGELOG.md": pr57Changelog,
		"legacy/pr57.txt": "merged through a nested origin/main history\n",
	});
	const merge57 = commitTree(git("rev-parse", `${pr57}^{tree}`), [merge55, pr57], "Merge pull request #57 from fixture/pr-57 [test]");
	headChangelog = pr57Changelog;

	const pr56 = commitWithFiles(base, "PR #56 fragment", {
		"changelog.d/rz5.51.md": "- Fleet-guard installation skips unmanaged extension collisions, preserves operator bytes, and continues installing the guard. (PR #56)\n",
	});
	const pr51 = commitWithFiles(base, "PR #51 fragment", {
		"changelog.d/rz5.72.md": "- CI retains ladder reports as artifacts on failure; successful runs upload nothing. (PR #51)\n",
	});
	const pr52 = commitWithFiles(base, "PR #52 fragment", {
		"changelog.d/rz5.47.md": "- `doctor --scope extensions` resolves hook imports from the extension's real path, avoiding false findings for symlinked hooks. (PR #52)\n",
	});

	const concurrentTree = git("merge-tree", "--write-tree", pr56, pr51).split("\n")[0]!;
	const concurrentFiles = git("ls-tree", "-r", "--name-only", concurrentTree).split("\n");
	expect(concurrentFiles).toContain("changelog.d/rz5.51.md");
	expect(concurrentFiles).toContain("changelog.d/rz5.72.md");

	const merge56Tree = git("rev-parse", `${pr56}^{tree}`);
	const merge56 = commitTree(merge56Tree, [base, pr56], "Merge pull request #56 from fixture/pr-56 [test]");
	const merge51Tree = git("merge-tree", "--write-tree", merge56, pr51).split("\n")[0]!;
	const merge51 = commitTree(merge51Tree, [merge56, pr51], "Merge pull request #51 from fixture/pr-51 [test]");
	const merge52Tree = git("merge-tree", "--write-tree", merge51, pr52).split("\n")[0]!;
	const merge52 = commitTree(merge52Tree, [merge51, pr52], "Merge pull request #52 from fixture/pr-52 [test]");
	const originMainTree = git("merge-tree", "--write-tree", merge52, merge57).split("\n")[0]!;
	const originMainMerge = commitTree(originMainTree, [merge52, merge57], "Merge remote-tracking branch 'origin/main' [test]");
	const releaseTree = treeWithFiles(originMainMerge, {
		"changelog.d/rz5.75.md": "- Release notes use per-bead fragments, a merge-safe assembler, and a release check for every merged PR.\n",
	});
	releaseHead = commitTree(releaseTree, [originMainMerge], "L3 release fragment [test]");
	git("update-ref", "refs/heads/main", releaseHead);
});

test("release check reports merged PRs and their fragment or legacy-line coverage", () => {
	const check = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(check.exitCode, check.output).toBe(0);
	const mergedPullRequests = git("log", "--merges", "--reverse", "--format=%s", "v0.2.2..HEAD")
		.split("\n").map(subject => subject.match(/^Merge pull request #(\d+)\b/)?.[1])
		.filter((number): number is string => number !== undefined);
	expect(mergedPullRequests.sort()).toEqual(["25", "51", "52", "55", "56", "57"]);
	expect(check.output).toContain("OK: 6 merged PRs and 0 direct commits have release-note coverage");
	for (const pr of mergedPullRequests) expect(check.output).toContain(`PR #${pr} covered by`);
	expect(check.output).toContain("PR #25 covered by CHANGELOG.md");
	expect(check.output).toContain("PR #55 covered by CHANGELOG.md");
	expect(check.output).toContain("PR #57 covered by CHANGELOG.md");
	expect(check.output).toContain("PR #51 covered by changelog.d/rz5.72.md");
	expect(check.output).toContain("PR #52 covered by changelog.d/rz5.47.md");
	expect(check.output).toContain("PR #56 covered by changelog.d/rz5.51.md");
});

test("default assembly prints a preview without changing CHANGELOG.md", () => {
	const changelogPath = join(fixture, "CHANGELOG.md");
	const sourceChangelog = readFileSync(changelogPath, "utf8");
	const assembled = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03");
	expect(assembled.exitCode, assembled.output).toBe(0);
	expect(assembled.output).toContain("## 0.2.3 — 2026-10-03");
	expect(readFileSync(changelogPath, "utf8")).toBe(sourceChangelog);
	assembledChangelog = assembled.output;

	const previewPath = join(workspace, "CHANGELOG.preview.md");
	const preview = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--output", previewPath);
	expect(preview.exitCode, preview.output).toBe(0);
	expect(readFileSync(previewPath, "utf8")).toBe(assembledChangelog);
	expect(readFileSync(changelogPath, "utf8")).toBe(sourceChangelog);

	const section = assembledChangelog.match(/## 0\.2\.3 — 2026-10-03\n([\s\S]*?)(?=\n## |$)/)?.[1];
	expect(section).toBeDefined();
	expect(section).toContain("Existing in-progress release note.");
	expect(section).toContain("OMP minimum and latest compatibility are certified. (PR #25)");
	expect(section).toContain("The metamorphic ratchet fails on any break. (PR #55)");
	expect(section).toContain("The work doctor inventories configured repositories. (PR #57)");
	expect(section).toContain("Fleet-guard installation skips unmanaged extension collisions");
	expect(section).toContain("CI retains ladder reports as artifacts on failure");
	expect(section).toContain("resolves hook imports from the extension's real path");
	expect(section).toContain("Release notes use per-bead fragments");
	expect(section).not.toContain("<!--");
	expect(assembledChangelog).toContain(`## Unreleased\n\n${pointer}`);
	expect(assembledChangelog).toContain("## 0.2.2 — 2026-10-02");

	const notedPullRequests = [...section!.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!).sort();
	expect(notedPullRequests).toEqual(["25", "51", "52", "55", "56", "57"]);
});

test("only --write updates CHANGELOG.md and it refuses local edits", () => {
	const changelogPath = join(fixture, "CHANGELOG.md");
	const notWritten = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--output", "CHANGELOG.md");
	expect(notWritten.exitCode).toBe(1);
	expect(notWritten.output).toContain("writing CHANGELOG.md requires --write");
	expect(readFileSync(changelogPath, "utf8")).not.toContain("## 0.2.3 — 2026-10-03");
	writeFileSync(changelogPath, headChangelog);

	const written = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--write");
	expect(written.exitCode, written.output).toBe(0);
	expect(readFileSync(changelogPath, "utf8")).toBe(assembledChangelog);

	const repeated = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--write");
	expect(repeated.exitCode, repeated.output).toBe(0);
	expect(readFileSync(changelogPath, "utf8")).toBe(assembledChangelog);

	writeFileSync(changelogPath, `${assembledChangelog}\n- Local uncommitted note.\n`);
	const refused = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--write");
	expect(refused.exitCode).toBe(1);
	expect(refused.output).toContain("differs from --head; refusing to overwrite local edits");
	expect(readFileSync(changelogPath, "utf8")).toContain("Local uncommitted note.");
	writeFileSync(changelogPath, headChangelog);
});

test("the tag-time check passes on the assembled release commit, as release.yml runs it", () => {
	const releaseCommit = commitWithFiles(git("rev-parse", "HEAD"), "release v0.2.3", { "CHANGELOG.md": assembledChangelog });
	git("update-ref", "refs/heads/main", releaseCommit);
	const atRelease = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(atRelease.exitCode, atRelease.output).toBe(0);
	expect(atRelease.output).toContain("covered by the release section in CHANGELOG.md");
	git("update-ref", "refs/heads/main", releaseHead);
});

test("release check rejects a merged PR without a fragment or tagged Unreleased line", () => {
	const currentHead = git("rev-parse", "HEAD");
	const missingTree = treeWithFiles(currentHead, { "fixture-change.txt": "merged change without a release note\n" });
	const missingPr = commitTree(missingTree, [currentHead], "Change without release note [test]");
	const missingMerge = commitTree(missingTree, [currentHead, missingPr], "Merge pull request #58 from fixture/pr-58 [test]");
	git("update-ref", "refs/heads/main", missingMerge);
	const missing = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain("merged PR #58 has no changelog.d fragment or tagged line in CHANGELOG.md ## Unreleased");
});

test("a single-parent squash PR is covered by its PR fragment", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);

	const squashTree = treeWithFiles(releaseHead, {
		"src/squashed.ts": "squashed source change\n",
		"changelog.d/squash-pr.md": "- The squash is documented. (PR #58)\n",
	});
	const squashCommit = commitTree(squashTree, [releaseHead], "Implement squashed change (#58)", []);
	git("update-ref", "refs/heads/main", squashCommit);

	const covered = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(covered.exitCode, covered.output).toBe(0);
	expect(covered.output).toContain("PR #58 covered by changelog.d/squash-pr.md");
});

test("release check accepts a refreshed fragment for a PR already released at the base tag", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);

	const existingTree = treeWithFiles(releaseHead, {
		"changelog.d/rz5.50.md": "- Updated published note. (PR #50)\n",
	});
	const existingCommit = commitTree(existingTree, [releaseHead], "Refresh PR #50 fragment [test]", []);
	git("update-ref", "refs/heads/main", existingCommit);

	const check = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(check.exitCode, check.output).toBe(0);
});

test("release assembly omits refreshed fragments for PRs in the base tag", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);

	const refreshedTree = treeWithFiles(releaseHead, {
		"changelog.d/rz5.50.md": "- REFRESHED PRIOR RELEASE NOTE (PR #50)\n",
	});
	const refreshedCommit = commitTree(refreshedTree, [releaseHead], "Refresh an old PR fragment [test]", []);
	git("update-ref", "refs/heads/main", refreshedCommit);

	const assembled = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD", "--version", "0.2.3", "--date", "2026-10-09", "--output", "assembled.md");
	expect(assembled.exitCode, assembled.output).toBe(0);
	const changelog = readFileSync(join(fixture, "assembled.md"), "utf8");
	expect(changelog).not.toContain("REFRESHED PRIOR RELEASE NOTE");
	expect(changelog).toContain("Fleet-guard installation skips unmanaged extension collisions");
});
test("release check rejects a fragment for an unknown PR", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);

	const unknownTree = treeWithFiles(releaseHead, {
		"changelog.d/unknown-pr.md": "- An unrelated future note. (PR #99)\n",
	});
	const unknownCommit = commitTree(unknownTree, [releaseHead], "Add unknown PR fragment [test]", []);
	git("update-ref", "refs/heads/main", unknownCommit);

	const check = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(check.exitCode).toBe(1);
	expect(check.output).toContain("fragment changelog.d/unknown-pr.md references PR #99, absent from v0.2.2..HEAD");
});

test("release check requires direct main-commit fragments or a reasoned waiver", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);

	const directBead = "ompkit-rc-epic-land-fix-release-dogfood-rz5.99";
	const missingTree = treeWithFiles(releaseHead, { "src/direct-feature.ts": "direct main change\n" });
	const missingCommit = commitTree(missingTree, [releaseHead], "Direct source change [test]", [
		`Bead: ${directBead}`,
		"Verified: fixture direct source commit lacks a release fragment",
	]);
	git("update-ref", "refs/heads/main", missingCommit);
	const missing = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain(
		`direct commit ${missingCommit.slice(0, 7)} (Bead: ${directBead}) has no changelog fragment: changelog.d/rz5.99.md`,
	);

	const fragmentTree = treeWithFiles(missingCommit, {
		"changelog.d/rz5.99.md": "- A direct source change is documented.\n",
	});
	const fragmentCommit = commitTree(fragmentTree, [missingCommit], "Add direct source fragment [test]");
	git("update-ref", "refs/heads/main", fragmentCommit);
	const waiverTree = treeWithFiles(fragmentCommit, { "scripts/test-setup.ts": "fixture-only setup\n" });
	const waiverReason = "Test-only fixture setup; no shipped behavior changes.";
	const waiverCommit = commitTree(waiverTree, [fragmentCommit], "Test-only scripts change [test]", [
		`[no-changelog] ${waiverReason}`,
	]);
	git("update-ref", "refs/heads/main", waiverCommit);
	const covered = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(covered.exitCode, covered.output).toBe(0);
	expect(covered.output).toContain(
		`Direct commit ${missingCommit.slice(0, 7)} (Bead: ${directBead}) covered by changelog.d/rz5.99.md`,
	);
	expect(covered.output).toContain(`Direct commit ${waiverCommit.slice(0, 7)} covered by [no-changelog]: ${waiverReason}`);
	expect(covered.output).toContain("OK: 6 merged PRs and 2 direct commits have release-note coverage");
	const emptyReasonTree = treeWithFiles(waiverCommit, { "rules/no-reason.md": "fixture rule change\n" });
	const emptyReasonCommit = commitTree(emptyReasonTree, [waiverCommit], "Reasonless waiver [test]", ["[no-changelog]"]);
	git("update-ref", "refs/heads/main", emptyReasonCommit);
	const emptyReason = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(emptyReason.exitCode).toBe(1);
	expect(emptyReason.output).toContain(`direct commit ${emptyReasonCommit.slice(0, 7)} has an empty [no-changelog] reason`);
});

test("a trailer-less direct commit is covered only by a fragment naming that commit", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);
	const bare = commitTree(treeWithFiles(releaseHead, { "src/bare.ts": "bare\n" }), [releaseHead], "Bare source change [test]", []);
	const short = bare.slice(0, 7);
	const wrongRef = commitTree(treeWithFiles(bare, { "changelog.d/bare.md": "- Bare change. (commit 0000000)\n" }), [bare], "Fragment naming another commit [test]");
	git("update-ref", "refs/heads/main", wrongRef);
	const missing = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain(`direct commit ${short} touches shipped paths but must have one Bead: trailer, a [no-changelog] reason, or a fragment naming (commit ${short})`);
	const named = commitTree(treeWithFiles(wrongRef, { "changelog.d/bare.md": `- Bare change. (commit ${short})\n` }), [wrongRef], "Fragment naming the commit [test]");
	git("update-ref", "refs/heads/main", named);
	const covered = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(covered.exitCode, covered.output).toBe(0);
	expect(covered.output).toContain(`Direct commit ${short} (Bead: -) covered by changelog.d/bare.md`);
});


function commitWithFiles(parent: string, label: string, files: Record<string, string>): string {
	const tree = treeWithFiles(parent, files);
	return commitTree(tree, [parent], `${label} [test]`);
}

function treeWithFiles(parent: string, files: Record<string, string>): string {
	const index = join(workspace, `index.${++indexNumber}`);
	gitWithEnv({ GIT_INDEX_FILE: index }, "read-tree", parent);
	for (const [path, content] of Object.entries(files)) {
		const blobPath = join(workspace, `blob.${indexNumber}.${path.replace(/\//g, "_")}`);
		writeFileSync(blobPath, content);
		const blob = git("hash-object", "-w", blobPath);
		gitWithEnv({ GIT_INDEX_FILE: index }, "update-index", "--add", "--cacheinfo", "100644", blob, path);
	}
	return gitWithEnv({ GIT_INDEX_FILE: index }, "write-tree");
}

function commitTree(
	tree: string,
	parents: string[],
	subject: string,
	body = [`Bead: ${bead}`, "Verified: fixture Git graph -> committed tree contains declared change"],
): string {
	const args = ["commit-tree", tree];
	for (const parent of parents) args.push("-p", parent);
	args.push("-m", subject);
	for (const paragraph of body) args.push("-m", paragraph);
	return git(...args);
}

function git(...args: string[]): string {
	return runGit({}, ...args);
}

function gitWithEnv(extra: Record<string, string>, ...args: string[]): string {
	return runGit(extra, ...args);
}

function runGit(extra: Record<string, string>, ...args: string[]): string {
	const child = Bun.spawnSync(["git", "-C", fixture, ...args], {
		stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...extra },
	});
	const output = `${child.stdout.toString()}${child.stderr.toString()}`;
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${child.exitCode}):\n${output}`);
	return child.stdout.toString().trim();
}

function release(...args: string[]): { exitCode: number | null; output: string } {
	const child = Bun.spawnSync(["sh", join(repo, "scripts", "release-notes.sh"), ...args], {
		cwd: fixture, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch },
	});
	return { exitCode: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}
