import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Options =
	| { mode: "check"; baseTag: string; head: string }
	| { mode: "assemble"; baseTag: string; head: string; version: string; date: string; output?: string };
type Fragment = { path: string; content: string; pr?: string };
type ReleaseHistory = { mergedPrs: string[]; fragments: Fragment[]; byPr: Map<string, Fragment> };
type Git = (args: string[]) => string;

const fail = (reason: string): never => { throw new Error(reason); };

try {
	run();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`release-notes: ${message}`);
	process.exitCode = 1;
}

function run(): void {
	const options = parseArguments(process.argv.slice(2));
	const rootResult = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
		cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
	});
	if (rootResult.exitCode !== 0) fail(`not in a Git worktree: ${rootResult.stderr.toString().trim()}`);
	const root = resolve(rootResult.stdout.toString().trim());
	const gitRaw: Git = (args) => {
		const child = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const stdout = child.stdout.toString();
		const stderr = child.stderr.toString();
		if (child.exitCode !== 0) fail(`git ${args.join(" ")} failed (${child.exitCode}): ${stdout}${stderr}`);
		return stdout;
	};
	const git: Git = (args) => gitRaw(args).trimEnd();

	const base = git(["rev-parse", "--verify", "--end-of-options", `${options.baseTag}^{commit}`]);
	const head = git(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`]);
	if (git(["merge-base", base, head]) !== base) fail(`base tag ${options.baseTag} is not an ancestor of ${options.head}`);
	const history = collectHistory(git, base, head, options.baseTag, options.head);
	if (options.mode === "check") {
		console.log(`OK: ${history.mergedPrs.length} merged PRs have fragments in ${options.baseTag}..${options.head}`);
		return;
	}
	assemble(root, options, history, gitRaw, head);
}

function parseArguments(args: string[]): Options {
	const usage = "Usage: release-notes.sh check --base-tag vX.Y.Z --head REF | assemble --base-tag vX.Y.Z --head REF --version X.Y.Z --date YYYY-MM-DD [--output PATH]";
	const mode = args[0];
	if (mode === "check") {
		const values = parseFlags(args.slice(1), { "--base-tag": true, "--head": true }, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		validateBaseTag(baseTag, usage);
		return { mode, baseTag, head };
	}
	if (mode === "assemble") {
		const values = parseFlags(args.slice(1), { "--base-tag": true, "--head": true, "--version": true, "--date": true, "--output": true }, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		const version = requiredValue(values, "--version", usage);
		const date = requiredValue(values, "--date", usage);
		validateBaseTag(baseTag, usage);
		if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(usage);
		const parsedDate = new Date(`${date}T00:00:00.000Z`);
		if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) fail("release date must be a real YYYY-MM-DD date");
		const output = values.get("--output");
		return output === undefined ? { mode, baseTag, head, version, date } : { mode, baseTag, head, version, date, output };
	}
	return fail(usage);
}

function parseFlags(args: string[], allowed: Record<string, true>, usage: string): Map<string, string> {
	const values = new Map<string, string>();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index]!;
		const value = args[index + 1];
		if (!Object.prototype.hasOwnProperty.call(allowed, flag) || value === undefined || value.length === 0 || value.startsWith("--") || values.has(flag)) fail(usage);
		values.set(flag, value);
	}
	return values;
}

function requiredValue(values: Map<string, string>, flag: string, usage: string): string {
	const value = values.get(flag);
	if (value === undefined || value.length === 0) fail(usage);
	return value!;
}

function validateBaseTag(baseTag: string, usage: string): void {
	if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(baseTag)) fail(usage);
}

function collectHistory(git: Git, base: string, head: string, baseTag: string, headRef: string): ReleaseHistory {
	const log = git(["log", "--first-parent", "--reverse", "--format=%s", `${base}..${head}`]);
	const mergedPrs: string[] = [];
	const seenPrs = new Set<string>();
	for (const subject of log.split(/\r?\n/).filter(Boolean)) {
		const match = subject.match(/^Merge pull request #(\d+)\b/) ?? subject.match(/\(#(\d+)\)$/);
		const pr = match?.[1];
		if (!pr) continue;
		if (seenPrs.has(pr)) fail(`PR #${pr} appears more than once in ${baseTag}..${headRef}`);
		seenPrs.add(pr);
		mergedPrs.push(pr);
	}

	const changedPaths = git(["diff", "--name-only", "--diff-filter=AMR", base, head, "--", "changelog.d"])
		.split(/\r?\n/).filter(Boolean);
	const fragmentPattern = /^changelog\.d\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.md$/;
	const invalidPath = changedPaths.find(path => !fragmentPattern.test(path));
	if (invalidPath) fail(`fragment path must be changelog.d/<bead>.md: ${invalidPath}`);
	const fragments: Fragment[] = changedPaths.sort().map(path => {
		const content = git(["show", `${head}:${path}`]);
		if (!content.trim()) fail(`empty changelog fragment: ${path}`);
		const references = [...content.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!);
		if (references.length > 1) fail(`fragment names multiple PRs: ${path}`);
		const fragment: Fragment = { path, content: content.trim() };
		if (references[0]) fragment.pr = references[0];
		return fragment;
	});
	const byPr = new Map<string, Fragment>();
	for (const fragment of fragments) {
		if (!fragment.pr) continue;
		if (byPr.has(fragment.pr)) fail(`multiple changelog fragments name PR #${fragment.pr}`);
		byPr.set(fragment.pr, fragment);
	}
	for (const pr of mergedPrs) {
		if (!byPr.has(pr)) fail(`merged PR #${pr} has no changelog fragment in changelog.d/`);
	}
	for (const fragment of fragments) {
		if (fragment.pr && !seenPrs.has(fragment.pr))
			fail(`fragment ${fragment.path} references PR #${fragment.pr}, absent from ${baseTag}..${headRef}`);
	}
	return { mergedPrs, fragments, byPr };
}

function assemble(root: string, options: Extract<Options, { mode: "assemble" }>, history: ReleaseHistory, git: Git, head: string): void {
	const changelogPath = join(root, "CHANGELOG.md");
	const changelog: string = git(["show", `${head}:CHANGELOG.md`]);
	const outputPath = options.output ? resolve(root, options.output) : changelogPath;
	const currentChangelog: string = readFileSync(changelogPath, "utf8");
	const lines = changelog.split(/\r?\n/);
	const unreleasedHeadings: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lines[index]!.trim() === "## Unreleased") unreleasedHeadings.push(index);
	}
	if (unreleasedHeadings.length !== 1) fail("CHANGELOG.md must contain exactly one ## Unreleased section");
	const unreleasedIndex = unreleasedHeadings[0]!;
	const nextHeadingIndex = lines.findIndex((line, index) => index > unreleasedIndex && /^##\s+/.test(line));
	if (nextHeadingIndex < 0) fail("CHANGELOG.md ## Unreleased section must precede a version section");
	const versionHeading = `## ${options.version} — ${options.date}`;
	if (lines.includes(versionHeading)) fail(`release section already exists: ${versionHeading}`);

	const preservedComments: string[] = [];
	const currentReleaseLines: string[] = [];
	let inComment = false;
	for (const line of lines.slice(unreleasedIndex + 1, nextHeadingIndex)) {
		if (inComment) {
			preservedComments.push(line);
			if (line.includes("-->")) inComment = false;
		} else if (line.includes("<!--")) {
			preservedComments.push(line);
			if (!line.includes("-->")) inComment = true;
		} else if (line.trim()) {
			currentReleaseLines.push(line);
		}
	}
	if (inComment) fail("CHANGELOG.md has an unclosed comment in ## Unreleased");

	const releaseNotes = currentReleaseLines.join("\n").trim();
	const notes = releaseNotes ? [releaseNotes] : [];
	const emitted = new Set<string>();
	for (const pr of history.mergedPrs) {
		const fragment = history.byPr.get(pr)!;
		notes.push(fragment.content);
		emitted.add(fragment.path);
	}
	for (const fragment of history.fragments) {
		if (!emitted.has(fragment.path)) notes.push(fragment.content);
	}
	if (notes.length === 0) fail("no Unreleased entries or changelog fragments to assemble");

	const before = lines.slice(0, unreleasedIndex + 1).join("\n");
	const after = lines.slice(nextHeadingIndex).join("\n").replace(/^\n+/, "");
	const commentBlock = preservedComments.join("\n");
	const output = `${before}\n\n${commentBlock ? `${commentBlock}\n\n` : ""}${versionHeading}\n\n${notes.join("\n\n")}\n\n${after}`;
	const generated = `${output.replace(/\n+$/, "")}\n`;
	if (outputPath === changelogPath && currentChangelog !== changelog && currentChangelog !== generated)
		fail("CHANGELOG.md differs from --head; refusing to overwrite local edits");
	writeFileSync(outputPath, generated);
	console.log(`Assembled ${options.version}: ${history.mergedPrs.length} merged PRs, ${history.fragments.length} fragments`);
}
