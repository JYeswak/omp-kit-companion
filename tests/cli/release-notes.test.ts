import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const scratch = join(repo, "var", "agent-tmp");
const workspace = join(scratch, `release-notes.${process.pid}`);
const fixture = join(workspace, "repo");
const bead = "ompkit-rc-epic-land-fix-release-dogfood-rz5.75";
const pointer = "<!-- Add one fragment per merged PR under changelog.d/. -->";
let indexNumber = 0;
let assembledChangelog = "";

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
	writeFileSync(join(fixture, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n- Existing in-progress release note.\n\n${pointer}\n\n## 0.2.2 — 2026-10-02\n\n- Existing published note. (PR #50)\n`);
	git("add", "CHANGELOG.md");
	git("commit", "-m", "release v0.2.2 [test]", "-m", `Bead: ${bead}`,
		"-m", "Verified: fixture baseline -> v0.2.2 changelog and tag created");
	git("tag", "v0.2.2");

	const base = git("rev-parse", "v0.2.2");
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
	const releaseTree = treeWithFiles(merge52, {
		"changelog.d/rz5.75.md": "- Release notes use per-bead fragments, a merge-safe assembler, and a release check for every merged PR.\n",
	});
	const releaseHead = commitTree(releaseTree, [merge52], "L3 release fragment [test]");
	git("update-ref", "refs/heads/main", releaseHead);
});

test("release assembly matches merged PR history", () => {
	const check = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(check.exitCode, check.output).toBe(0);

	const assembled = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03");
	expect(assembled.exitCode, assembled.output).toBe(0);
	const changelog = readFileSync(join(fixture, "CHANGELOG.md"), "utf8");
	assembledChangelog = changelog;

	const previewPath = join(workspace, "CHANGELOG.preview.md");
	const preview = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03", "--output", previewPath);
	expect(preview.exitCode, preview.output).toBe(0);
	expect(readFileSync(previewPath, "utf8")).toBe(changelog);
	expect(readFileSync(join(fixture, "CHANGELOG.md"), "utf8")).toBe(changelog);

	const section = changelog.match(/## 0\.2\.3 — 2026-10-03\n([\s\S]*?)(?=\n## |$)/)?.[1];
	expect(section).toBeDefined();
	expect(section).toContain("Existing in-progress release note.");
	expect(section).toContain("Fleet-guard installation skips unmanaged extension collisions");
	expect(section).toContain("CI retains ladder reports as artifacts on failure");
	expect(section).toContain("resolves hook imports from the extension's real path");
	expect(section).toContain("Release notes use per-bead fragments");
	expect(section).not.toContain("<!--");
	expect(changelog).toContain(`## Unreleased\n\n${pointer}`);
	expect(changelog).toContain("## 0.2.2 — 2026-10-02");

	const mergedPullRequests = git("log", "--first-parent", "--merges", "--format=%s", "v0.2.2..HEAD")
		.split("\n").map(subject => subject.match(/^Merge pull request #(\d+)\b/)?.[1])
		.filter((number): number is string => number !== undefined).sort();
	const notedPullRequests = [...section!.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!).sort();
	expect(notedPullRequests).toEqual(mergedPullRequests);
	expect(section!.indexOf("Fleet-guard installation skips unmanaged extension collisions"))
		.toBeLessThan(section!.indexOf("CI retains ladder reports as artifacts on failure"));
	expect(section!.indexOf("CI retains ladder reports as artifacts on failure"))
		.toBeLessThan(section!.indexOf("resolves hook imports from the extension's real path"));
	expect(section!.indexOf("resolves hook imports from the extension's real path"))
		.toBeLessThan(section!.indexOf("Release notes use per-bead fragments"));
});

test("assembly is idempotent and refuses to overwrite local changelog edits", () => {
	const repeated = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03");
	expect(repeated.exitCode, repeated.output).toBe(0);
	const changelogPath = join(fixture, "CHANGELOG.md");
	expect(readFileSync(changelogPath, "utf8")).toBe(assembledChangelog);
	writeFileSync(changelogPath, `${assembledChangelog}\n- Local uncommitted note.\n`);
	const refused = release("assemble", "--base-tag", "v0.2.2", "--head", "HEAD",
		"--version", "0.2.3", "--date", "2026-10-03");
	expect(refused.exitCode).toBe(1);
	expect(refused.output).toContain("differs from --head; refusing to overwrite local edits");
	expect(readFileSync(changelogPath, "utf8")).toContain("Local uncommitted note.");
	writeFileSync(changelogPath, assembledChangelog);
});

test("release check rejects merged PRs without fragments", () => {
	const currentHead = git("rev-parse", "HEAD");
	const missingTree = treeWithFiles(currentHead, { "fixture-change.txt": "merged change without a release fragment\n" });
	const missingPr = commitTree(missingTree, [currentHead], "Change without release fragment [test]");
	const missingMerge = commitTree(missingTree, [currentHead, missingPr], "Merge pull request #58 from fixture/pr-58 [test]");
	git("update-ref", "refs/heads/main", missingMerge);
	const missing = release("check", "--base-tag", "v0.2.2", "--head", "HEAD");
	expect(missing.exitCode).toBe(1);
	expect(missing.output).toContain("merged PR #58 has no changelog fragment");
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

function commitTree(tree: string, parents: string[], subject: string): string {
	const args = ["commit-tree", tree];
	for (const parent of parents) args.push("-p", parent);
	args.push("-m", subject, "-m", `Bead: ${bead}`, "-m", "Verified: fixture Git graph -> committed tree contains declared change");
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
