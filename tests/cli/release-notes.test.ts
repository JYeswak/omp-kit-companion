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

// fold/promote/notes run against the working tree of their own small fixture repo.
function changelogFixture(name: string, changelog: string, fragments: Record<string, string>): string {
	const dir = join(workspace, name);
	mkdirSync(join(dir, "changelog.d"), { recursive: true });
	writeFileSync(join(dir, "CHANGELOG.md"), changelog);
	writeFileSync(join(dir, "package.json"), `{\n\t"name": "omp-kit-companion",\n\t"version": "0.2.2",\n\t"omp": {\n\t\t"name": "omp-kit-companion",\n\t\t"version": "0.2.2"\n\t}\n}\n`);
	for (const [path, content] of Object.entries(fragments)) writeFileSync(join(dir, "changelog.d", path), content);
	Bun.spawnSync(["git", "init", "-q", dir]);
	return dir;
}

function releaseIn(dir: string, ...args: string[]): { exitCode: number | null; output: string } {
	const child = Bun.spawnSync(["sh", join(repo, "scripts", "release-notes.sh"), ...args], {
		cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch },
	});
	return { exitCode: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

const releasedChangelog = `# Changelog

## [Unreleased]

### Added

- Existing unreleased addition.

## [0.2.2] - 2026-10-02

### Fixed

- Already released fix.
`;

test("fold drains fragments into [Unreleased] buckets; only --write applies and removes them", () => {
	const dir = changelogFixture("fold", releasedChangelog, {
		"a-fix.md": "### Fixed\n- The doctor no longer crashes on an empty config.\n  It reports the missing file instead.\n",
		"b-plain.md": "A paragraph fragment without a bullet\nspanning two lines.\n",
		"c-dup.md": "### Fixed\n- Already released fix.\n",
	});
	const preview = releaseIn(dir, "fold");
	expect(preview.exitCode, preview.output).toBe(0);
	expect(preview.output).toContain("### Added\n\n- Existing unreleased addition.\n\n### Changed\n\n- A paragraph fragment without a bullet spanning two lines.\n\n### Fixed\n\n- The doctor no longer crashes on an empty config.\n  It reports the missing file instead.\n\n## [0.2.2] - 2026-10-02");
	expect(preview.output).toContain("FOLDED fragments=3 entries_added=2 duplicates_dropped=1 (preview");
	expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(releasedChangelog);
	expect(existsSync(join(dir, "changelog.d/a-fix.md"))).toBe(true);

	const written = releaseIn(dir, "fold", "--write");
	expect(written.exitCode, written.output).toBe(0);
	const folded = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
	expect(folded).toContain("- The doctor no longer crashes on an empty config.");
	expect(folded.match(/Already released fix/g)?.length).toBe(1);
	for (const name of ["a-fix.md", "b-plain.md", "c-dup.md"]) expect(existsSync(join(dir, "changelog.d", name))).toBe(false);
	const again = releaseIn(dir, "fold", "--write");
	expect(again.exitCode, again.output).toBe(0);
	expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(folded);
});

test("fold refuses a fragment with an unknown category or a stray heading, naming it", () => {
	const unknown = releaseIn(changelogFixture("fold-unknown", releasedChangelog, { "x.md": "### Improved\n- Something.\n" }), "fold");
	expect(unknown.exitCode).toBe(1);
	expect(unknown.output).toContain('changelog.d/x.md: unknown category "Improved"');
	const heading = releaseIn(changelogFixture("fold-heading", releasedChangelog, { "y.md": "# Title\n- Something.\n" }), "fold");
	expect(heading.exitCode).toBe(1);
	expect(heading.output).toContain("changelog.d/y.md: only one optional leading");
});
test("pre-push notes coverage rejects unknown fragment categories before release promotion", () => {
	const checkFragment = (slug: string, category: string) => {
		const beadId = "ompkit-fp72.65.1";
		const tip = commitTree(treeWithFiles(releaseHead, {
			"scripts/release-notes-gate-fixture.ts": "export const checked = true;\n",
			[`changelog.d/${beadId}.md`]: `### ${category}\n- A release note fixture.\n`,
		}), [releaseHead], `fixture ${slug} fragment [test]`, [
			`Bead: ${beadId}`,
			"Verified: release-note gate fixture",
		]);
		const archive = join(workspace, `pushed-notes-${slug}`);
		const archiveFile = join(workspace, `pushed-notes-${slug}.tar`);
		mkdirSync(archive);
		const archived = Bun.spawnSync(["git", "-C", fixture, "archive", `--output=${archiveFile}`, tip], {
			stdout: "pipe", stderr: "pipe",
		});
		expect(archived.exitCode, archived.stderr.toString()).toBe(0);
		const extracted = Bun.spawnSync(["tar", "-xf", archiveFile, "-C", archive], {
			stdout: "pipe", stderr: "pipe",
		});
		expect(extracted.exitCode, extracted.stderr.toString()).toBe(0);
		const checked = Bun.spawnSync(["sh", join(repo, "scripts", "check-pushed-notes.sh"),
			"--repo", fixture, "--base", releaseHead, "--tip", tip, "--archive-dir", archive], {
			stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: scratch },
		});
		return { exitCode: checked.exitCode, output: `${checked.stdout.toString()}${checked.stderr.toString()}` };
	};

	const invalid = checkFragment("unknown-category", "Security");
	expect(invalid.exitCode).not.toBe(0);
	expect(invalid.output).toContain('unknown category "Security"');
	const valid = checkFragment("valid-category", "Fixed");
	expect(valid.exitCode, valid.output).toBe(0);
	expect(valid.output).toContain("covered by Bead");
});


test("promote refuses (exit 4) when there is nothing to release: no Unreleased entries and no fragments", () => {
	const empty = releasedChangelog.replace("### Added\n\n- Existing unreleased addition.\n\n", "");
	const dir = changelogFixture("promote-empty", empty, {});
	const refused = releaseIn(dir, "promote", "--version", "0.2.3", "--date", "2026-10-12", "--write");
	expect(refused.exitCode).toBe(4);
	expect(refused.output).toContain("REFUSED: nothing to release");
	expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(empty);
	expect(readFileSync(join(dir, "package.json"), "utf8")).toContain('"version": "0.2.2"');
	const notes = releaseIn(dir, "notes", "--version", "0.2.3");
	expect(notes.exitCode).toBe(4);
	expect(notes.output).toContain("REFUSED: CHANGELOG.md has no ## [0.2.3] section");
});

test("promote folds, cuts ## [X.Y.Z] - DATE under a fresh [Unreleased], bumps package.json and refuses reuse", () => {
	const dir = changelogFixture("promote", releasedChangelog, { "z.md": "### Fixed\n- Promoted fix.\n" });
	const preview = releaseIn(dir, "promote", "--version", "0.2.3", "--date", "2026-10-12");
	expect(preview.exitCode, preview.output).toBe(0);
	expect(preview.output).toContain("PROMOTED version=0.2.3 date=2026-10-12 entries=2 fragments=1 package_version=0.2.2->0.2.3 (preview");
	expect(readFileSync(join(dir, "CHANGELOG.md"), "utf8")).toBe(releasedChangelog);

	const written = releaseIn(dir, "promote", "--version", "0.2.3", "--date", "2026-10-12", "--write");
	expect(written.exitCode, written.output).toBe(0);
	const promoted = readFileSync(join(dir, "CHANGELOG.md"), "utf8");
	expect(promoted).toMatch(/^# Changelog\n\n## \[Unreleased\]\n\n<!-- New notes go in changelog\.d\/<bead>\.md[^\n]*-->\n\n## \[0\.2\.3\] - 2026-10-12\n\n### Added\n\n- Existing unreleased addition\.\n\n### Fixed\n\n- Promoted fix\.\n\n## \[0\.2\.2\] - 2026-10-02\n/);
	const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	expect([pkg.version, pkg.omp.version]).toEqual(["0.2.3", "0.2.3"]);
	expect(existsSync(join(dir, "changelog.d/z.md"))).toBe(false);

	const reused = releaseIn(dir, "promote", "--version", "0.2.3", "--date", "2026-10-12");
	expect(reused.exitCode).toBe(1);
	expect(reused.output).toContain("release section already exists: ## [0.2.3]");
	const older = releaseIn(dir, "promote", "--version", "0.2.1", "--date", "2026-10-12");
	expect(older.exitCode).toBe(1);
	expect(older.output).toContain("must be greater than the newest released section 0.2.3");
});

test("notes renders the release body from CHANGELOG sections; --floor aggregates unpublished tags", () => {
	const changelog = `# Changelog\n\n## [Unreleased]\n\n## [0.2.4] - 2026-10-13\n\n### Fixed\n\n- Fix in four.\n- Shared line.\n\n## [0.2.3] - 2026-10-12\n\n### Added\n\n- Add in three.\n\n### Fixed\n\n- Shared line.\n\n## [0.2.2] - 2026-10-02\n\n### Fixed\n\n- Old fix.\n\n## [0.2.1] - 2026-10-01\n\n<!-- nothing -->\n`;
	const dir = changelogFixture("notes", changelog, {});
	const single = releaseIn(dir, "notes", "--version", "0.2.4");
	expect(single.exitCode, single.output).toBe(0);
	expect(single.output).toBe("### Fixed\n\n- Fix in four.\n- Shared line.\n");
	const aggregated = releaseIn(dir, "notes", "--version", "0.2.4", "--floor", "0.2.2", "--output", "notes.md");
	expect(aggregated.exitCode, aggregated.output).toBe(0);
	expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("### Added\n\n- Add in three.\n\n### Fixed\n\n- Fix in four.\n- Shared line.\n");
	const empty = releaseIn(dir, "notes", "--version", "0.2.1");
	expect(empty.exitCode).toBe(4);
	expect(empty.output).toContain("REFUSED: CHANGELOG.md ## [0.2.1] has no entries; an empty release body is refused");
});

test("the tag-time check passes on a promoted bump commit whose fragments were folded away", () => {
	writeFileSync(join(fixture, "CHANGELOG.md"), headChangelog);
	git("update-ref", "refs/heads/main", releaseHead);
	const directBead = "ompkit-rc-epic-land-fix-release-dogfood-rz5.98";
	const direct = commitTree(treeWithFiles(releaseHead, {
		"src/folded.ts": "folded\n",
		"changelog.d/rz5.98.md": "### Fixed\n- A folded direct change.\n",
	}), [releaseHead], "Direct change with fragment [test]", [`Bead: ${directBead}`]);
	const promoted = headChangelog.replace(`## Unreleased\n\n- Existing in-progress release note.\n`, `## [Unreleased]\n\n## [0.2.3] - 2026-10-12\n\n- Existing in-progress release note.\n\n### Fixed\n\n- A folded direct change.\n`);
	expect(promoted).not.toBe(headChangelog);
	const index = join(workspace, `index.${++indexNumber}`);
	gitWithEnv({ GIT_INDEX_FILE: index }, "read-tree", direct);
	gitWithEnv({ GIT_INDEX_FILE: index }, "rm", "--cached", "-q", "changelog.d/rz5.98.md");
	const blob = join(workspace, `blob.${indexNumber}.changelog`);
	writeFileSync(blob, promoted);
	gitWithEnv({ GIT_INDEX_FILE: index }, "update-index", "--add", "--cacheinfo", "100644", git("hash-object", "-w", blob), "CHANGELOG.md");
	const bump = commitTree(gitWithEnv({ GIT_INDEX_FILE: index }, "write-tree"), [direct], "chore: bump version to 0.2.3", ["[no-changelog] release bump"]);
	git("update-ref", "refs/heads/main", bump);
	const atRelease = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(atRelease.exitCode, atRelease.output).toBe(0);
	expect(atRelease.output).toContain(`Direct commit ${direct.slice(0, 7)} (Bead: ${directBead}) covered by changelog.d/rz5.98.md`);
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
	expect(missing.output).toContain("merged PR #58 has no changelog.d fragment or tagged line in CHANGELOG.md ## [Unreleased]");
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

test("rolling source notes release a green ancestor without consuming newer main notes", () => {
	const dir = changelogFixture("rolling-source", releasedChangelog, { "old.md": "- Already present at the release floor.\n" });
	const localGit = (...args: string[]) => {
		const child = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		return child.stdout.toString().trim();
	};
	localGit("config", "user.name", "Rolling Notes Fixture");
	localGit("config", "user.email", "rolling@example.invalid");
	localGit("config", "commit.gpgsign", "false");
	localGit("config", "core.hooksPath", "/dev/null");
	localGit("add", ".");
	localGit("commit", "-qm", "published baseline [test]");
	localGit("tag", "v0.2.2");
	writeFileSync(join(dir, "changelog.d", "green.md"), "### Fixed\n- Qualified source fix.\n");
	localGit("add", ".");
	localGit("commit", "-qm", "qualified green [test]");
	const green = localGit("rev-parse", "HEAD");
	localGit("tag", "v0.2.3", green);
	writeFileSync(join(dir, "changelog.d", "running.md"), "### Added\n- Newer main is still running.\n");
	localGit("add", ".");
	localGit("commit", "-qm", "newer running source [test]");
	const output = join(workspace, "green-notes.md");
	const before = localGit("rev-parse", "HEAD");
	const rendered = releaseIn(dir, "source", "--base-tag", "v0.2.2", "--head", green, "--version", "0.2.3", "--output", output);
	expect(rendered.exitCode, rendered.output).toBe(0);
	expect(readFileSync(output, "utf8")).toBe("### Fixed\n\n- Qualified source fix.\n");
	expect(localGit("rev-parse", "HEAD")).toBe(before);
	expect(localGit("status", "--porcelain")).toBe("");
	expect(existsSync(join(dir, "changelog.d", "green.md"))).toBe(true);
	expect(existsSync(join(dir, "changelog.d", "running.md"))).toBe(true);
	// The next source release includes only the delta, even though the prior
	// source tag contains unpromoted fragments and package.json stayed unchanged.
	const next = releaseIn(dir, "source", "--base-tag", "v0.2.3", "--head", before, "--version", "0.2.4", "--output", output);
	expect(next.exitCode, next.output).toBe(0);
	expect(readFileSync(output, "utf8")).toBe("### Added\n\n- Newer main is still running.\n");
	expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("0.2.2");
	const empty = releaseIn(dir, "source", "--base-tag", "v0.2.3", "--head", green, "--version", "0.2.4", "--output", output);
	expect(empty.exitCode).toBe(4);
	expect(empty.output).toContain("nothing to release");
});
