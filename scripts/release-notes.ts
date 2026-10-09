import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Options =
	| { mode: "check"; baseTag: string; head: string }
	| { mode: "assemble"; baseTag: string; head: string; version: string; date: string; output?: string; write: boolean };
type Fragment = { path: string; content: string; pr?: string };
type UnreleasedLine = { lineNumber: number; text: string; pr?: string };
type UnreleasedSection = {
	lines: string[];
	unreleasedIndex: number;
	nextHeadingIndex: number;
	preservedComments: string[];
	entries: UnreleasedLine[];
};
type ReleaseHistory = {
	mergedPrs: string[];
	fragments: Fragment[];
	byPr: Map<string, Fragment>;
	unreleasedByPr: Map<string, UnreleasedLine>;
	directCommits: DirectCommitCoverage[];
};
type DirectCommitCoverage =
	| { hash: string; bead: string; fragment: Fragment }
	| { hash: string; noChangelogReason: string };
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
	const history = collectHistory(git, gitRaw, base, head, options.baseTag, options.head);
	if (options.mode === "check") {
		console.log(`OK: ${history.mergedPrs.length} merged PRs and ${history.directCommits.length} direct commits have release-note coverage in ${options.baseTag}..${options.head}`);
		for (const pr of history.mergedPrs) {
			const fragment = history.byPr.get(pr);
			if (fragment) {
				console.log(`PR #${pr} covered by ${fragment.path}: ${fragment.content}`);
			} else {
				const line = history.unreleasedByPr.get(pr);
				console.log(line
					? `PR #${pr} covered by CHANGELOG.md:${line.lineNumber} (Unreleased): ${line.text.trim()}`
					: `PR #${pr} covered by the release section in CHANGELOG.md`);
			}
		}
		for (const commit of history.directCommits) {
			if ("noChangelogReason" in commit) {
				console.log(`Direct commit ${commit.hash} covered by [no-changelog]: ${commit.noChangelogReason}`);
			} else {
				console.log(`Direct commit ${commit.hash} (Bead: ${commit.bead}) covered by ${commit.fragment.path}`);
			}
		}
		return;
	}
	assemble(root, options, history, gitRaw, head);
}

function parseArguments(args: string[]): Options {
	const usage = "Usage: release-notes.sh check --base-tag vX.Y.Z --head REF | assemble --base-tag vX.Y.Z --head REF --version X.Y.Z --date YYYY-MM-DD [--output PATH | --write]";
	const mode = args[0];
	if (mode === "check") {
		const values = parseFlags(args.slice(1), { "--base-tag": "value", "--head": "value" }, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		validateBaseTag(baseTag, usage);
		return { mode, baseTag, head };
	}
	if (mode === "assemble") {
		const values = parseFlags(args.slice(1), {
			"--base-tag": "value",
			"--head": "value",
			"--version": "value",
			"--date": "value",
			"--output": "value",
			"--write": "boolean",
		}, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		const version = requiredValue(values, "--version", usage);
		const date = requiredValue(values, "--date", usage);
		validateBaseTag(baseTag, usage);
		if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(usage);
		const parsedDate = new Date(`${date}T00:00:00.000Z`);
		if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) fail("release date must be a real YYYY-MM-DD date");
		const output = values.get("--output");
		const write = values.get("--write") === true;
		if (write && output !== undefined) fail("--write and --output cannot be combined");
		if (output !== undefined && typeof output !== "string") fail(usage);
		const options: Extract<Options, { mode: "assemble" }> = { mode, baseTag, head, version, date, write };
		if (typeof output === "string") options.output = output;
		return options;
	}
	return fail(usage);
}

function parseFlags(args: string[], allowed: Record<string, "value" | "boolean">, usage: string): Map<string, string | true> {
	const values = new Map<string, string | true>();
	for (let index = 0; index < args.length;) {
		const flag = args[index]!;
		if (!Object.prototype.hasOwnProperty.call(allowed, flag) || values.has(flag)) fail(usage);
		if (allowed[flag] === "boolean") {
			values.set(flag, true);
			index++;
			continue;
		}
		const value = args[index + 1];
		if (value === undefined || value.length === 0 || value.startsWith("--")) fail(usage);
		values.set(flag, value);
		index += 2;
	}
	return values;
}

function requiredValue(values: Map<string, string | true>, flag: string, usage: string): string {
	const value = values.get(flag);
	if (typeof value !== "string" || value.length === 0) fail(usage);
	return value;
}

function validateBaseTag(baseTag: string, usage: string): void {
	if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(baseTag)) fail(usage);
}

function collectHistory(git: Git, gitRaw: Git, base: string, head: string, baseTag: string, headRef: string): ReleaseHistory {
	const log = git(["log", "--reverse", "--format=%s", `${base}..${head}`]);
	const mergedPrs: string[] = [];
	const seenPrs = new Set<string>();
	for (const subject of log.split(/\r?\n/).filter(Boolean)) {
		const match = subject.match(/^Merge pull request #(\d+)\b/) ?? subject.match(/\(#(\d+)\)$/);
		const pr = match?.[1];
		if (!pr || seenPrs.has(pr)) continue;
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

	const unreleased = readUnreleasedSection(gitRaw(["show", `${head}:CHANGELOG.md`]));
	const unreleasedByPr = new Map<string, UnreleasedLine>();
	for (const line of unreleased.entries) {
		const references = [...line.text.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!);
		if (references.length > 1) fail(`CHANGELOG.md:${line.lineNumber} names multiple PRs`);
		const pr = references[0];
		if (!pr) continue;
		if (unreleasedByPr.has(pr)) fail(`CHANGELOG.md ## Unreleased has multiple lines naming PR #${pr}`);
		if (!seenPrs.has(pr)) fail(`CHANGELOG.md:${line.lineNumber} references PR #${pr}, absent from ${baseTag}..${headRef}`);
		unreleasedByPr.set(pr, { ...line, pr });
	}

	// At the release commit, assembly has moved legacy Unreleased lines into the new version section.
	const releasedPrs = new Set<string>();
	const releaseHeading = unreleased.lines[unreleased.nextHeadingIndex]!;
	if (releaseHeading.trim() !== `## ${baseTag.replace(/^v/, "")}` && !releaseHeading.startsWith(`## ${baseTag.replace(/^v/, "")} `)) {
		const end = unreleased.lines.findIndex((line, index) => index > unreleased.nextHeadingIndex && /^##\s+/.test(line));
		for (const line of unreleased.lines.slice(unreleased.nextHeadingIndex + 1, end < 0 ? undefined : end)) {
			for (const match of line.matchAll(/\(PR #(\d+)\)/g)) releasedPrs.add(match[1]!);
		}
	}
	for (const pr of mergedPrs) {
		const fragment = byPr.get(pr);
		const line = unreleasedByPr.get(pr);
		if (fragment && line) fail(`merged PR #${pr} has both a changelog.d fragment and a tagged line in CHANGELOG.md ## Unreleased`);
		if (!fragment && !line && !releasedPrs.has(pr))
			fail(`merged PR #${pr} has no changelog.d fragment or tagged line in CHANGELOG.md ## Unreleased`);
	}
	for (const fragment of fragments) {
		if (fragment.pr && !seenPrs.has(fragment.pr))
			fail(`fragment ${fragment.path} references PR #${fragment.pr}, absent from ${baseTag}..${headRef}`);
	}
	const directCommits = collectDirectCommitCoverage(git, gitRaw, base, head, fragments);
	return { mergedPrs, fragments, byPr, unreleasedByPr, directCommits };
}
function collectDirectCommitCoverage(
	git: Git,
	gitRaw: Git,
	base: string,
	head: string,
	fragments: Fragment[],
): DirectCommitCoverage[] {
	const fields = gitRaw([
		"log", "--first-parent", "--reverse", "--format=%H%x00%P%x00%B%x00", `${base}..${head}`,
	]).split("\0");
	const coverages: DirectCommitCoverage[] = [];
	for (let index = 0; index + 2 < fields.length; index += 3) {
		const hash = fields[index]!.trim();
		const parents = fields[index + 1]!.trim().split(/\s+/).filter(Boolean);
		const body = fields[index + 2]!;
		if (!hash || parents.length !== 1) continue;
		const subject = body.split("\n", 1)[0]?.trimEnd() ?? "";
		const squashPr = subject.match(/\(#(\d+)\)$/)?.[1];
		if (squashPr && fragments.some(fragment => fragment.pr === squashPr)) continue;
		const changedPaths = git([
			"diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", hash,
		]).split(/\r?\n/).filter(Boolean);
		if (!changedPaths.some(path => /^(?:src|rules|scripts|extensions|installer)\//.test(path))) continue;

		const shortHash = hash.slice(0, 7);
		const waivers = [...body.matchAll(/^[ \t]*\[no-changelog\][ \t]*(.*)$/gm)];
		if (waivers.length > 1) fail(`direct commit ${shortHash} has multiple [no-changelog] reasons`);
		if (waivers.length === 1) {
			const reason = waivers[0]![1]!.trim();
			if (!reason) fail(`direct commit ${shortHash} has an empty [no-changelog] reason`);
			coverages.push({ hash: shortHash, noChangelogReason: reason });
			continue;
		}

		const referenced = fragments.find(candidate => candidate.content.includes(`(commit ${shortHash})`));
		const beads = [...body.matchAll(/^[ \t]*Bead:[ \t]*(\S+)[ \t]*$/gm)].map(match => match[1]!);
		if (referenced) {
			coverages.push({ hash: shortHash, bead: beads[0] ?? "-", fragment: referenced });
			continue;
		}
		if (beads.length !== 1)
			fail(`direct commit ${shortHash} touches shipped paths but must have one Bead: trailer, a [no-changelog] reason, or a fragment naming (commit ${shortHash})`);
		const bead = beads[0]!;
		const slug = bead.split("-").at(-1)!;
		if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(slug))
			fail(`direct commit ${shortHash} has an invalid Bead: trailer: ${bead}`);
		const paths = [`changelog.d/${slug}.md`, `changelog.d/${bead}.md`];
		const fragment = fragments.find(candidate => paths.includes(candidate.path));
		if (!fragment) fail(`direct commit ${shortHash} (Bead: ${bead}) has no changelog fragment: ${paths[0]}`);
		coverages.push({ hash: shortHash, bead, fragment });
	}
	return coverages;
}

function readUnreleasedSection(changelog: string): UnreleasedSection {
	const lines = changelog.split(/\r?\n/);
	const unreleasedHeadings: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (lines[index]!.trim() === "## Unreleased") unreleasedHeadings.push(index);
	}
	if (unreleasedHeadings.length !== 1) fail("CHANGELOG.md must contain exactly one ## Unreleased section");
	const unreleasedIndex = unreleasedHeadings[0]!;
	const nextHeadingIndex = lines.findIndex((line, index) => index > unreleasedIndex && /^##\s+/.test(line));
	if (nextHeadingIndex < 0) fail("CHANGELOG.md ## Unreleased section must precede a version section");

	const preservedComments: string[] = [];
	const entries: UnreleasedLine[] = [];
	let inComment = false;
	for (let index = unreleasedIndex + 1; index < nextHeadingIndex; index++) {
		const line = lines[index]!;
		if (inComment) {
			preservedComments.push(line);
			if (line.includes("-->")) inComment = false;
		} else if (line.includes("<!--")) {
			preservedComments.push(line);
			if (!line.includes("-->")) inComment = true;
		} else if (line.trim()) {
			entries.push({ lineNumber: index + 1, text: line });
		}
	}
	if (inComment) fail("CHANGELOG.md has an unclosed comment in ## Unreleased");
	return { lines, unreleasedIndex, nextHeadingIndex, preservedComments, entries };
}

function assemble(root: string, options: Extract<Options, { mode: "assemble" }>, history: ReleaseHistory, gitRaw: Git, head: string): void {
	const changelogPath = join(root, "CHANGELOG.md");
	const changelog = gitRaw(["show", `${head}:CHANGELOG.md`]);
	const section = readUnreleasedSection(changelog);
	const versionHeading = `## ${options.version} — ${options.date}`;
	if (section.lines.includes(versionHeading)) fail(`release section already exists: ${versionHeading}`);

	const releaseNotes = section.entries.map(line => line.text).join("\n").trim();
	const notes = releaseNotes ? [releaseNotes] : [];
	const emitted = new Set<string>();
	for (const pr of history.mergedPrs) {
		const fragment = history.byPr.get(pr);
		if (!fragment) continue;
		notes.push(fragment.content);
		emitted.add(fragment.path);
	}
	for (const fragment of history.fragments) {
		if (!emitted.has(fragment.path)) notes.push(fragment.content);
	}
	if (notes.length === 0) fail("no Unreleased entries or changelog fragments to assemble");

	const before = section.lines.slice(0, section.unreleasedIndex + 1).join("\n");
	const after = section.lines.slice(section.nextHeadingIndex).join("\n").replace(/^\n+/, "");
	const commentBlock = section.preservedComments.join("\n");
	const output = `${before}\n\n${commentBlock ? `${commentBlock}\n\n` : ""}${versionHeading}\n\n${notes.join("\n\n")}\n\n${after}`;
	const generated = `${output.replace(/\n+$/, "")}\n`;
	if (options.write) {
		const currentChangelog = readFileSync(changelogPath, "utf8");
		if (currentChangelog !== changelog && currentChangelog !== generated)
			fail("CHANGELOG.md differs from --head; refusing to overwrite local edits");
		writeFileSync(changelogPath, generated);
		console.error(`Assembled ${options.version}: ${history.mergedPrs.length} merged PRs, ${history.fragments.length} fragments -> CHANGELOG.md`);
		return;
	}
	if (options.output) {
		const outputPath = resolve(root, options.output);
		if (outputResolvesToChangelog(outputPath, changelogPath))
			fail("writing CHANGELOG.md requires --write");
		writeFileSync(outputPath, generated);
		console.error(`Assembled ${options.version}: ${history.mergedPrs.length} merged PRs, ${history.fragments.length} fragments -> ${options.output}`);
		return;
	}
	process.stdout.write(generated);
}

function outputResolvesToChangelog(outputPath: string, changelogPath: string): boolean {
	const canonicalChangelogPath = realpathSync(changelogPath);
	const canonicalOutputPath = existsSync(outputPath)
		? realpathSync(outputPath)
		: join(realpathSync(dirname(outputPath)), basename(outputPath));
	return canonicalOutputPath === canonicalChangelogPath;
}
