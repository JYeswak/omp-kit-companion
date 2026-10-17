import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// CHANGELOG.md follows the upstream oh-my-pi shape (can1357/oh-my-pi AGENTS.md "## Changelog",
// scripts/release.ts, scripts/ci-release-notes.ts): entries live under `## [Unreleased]` in
// `### Breaking Changes|Added|Changed|Fixed|Removed` buckets; a release promotes them to
// `## [X.Y.Z] - YYYY-MM-DD`; released sections are immutable; the GitHub release body is generated
// from those sections. changelog.d/<bead>.md fragments are this fleet's merge-safe inbox for
// [Unreleased] (concurrent agents never conflict on one file): `fold` drains them into it.
type Options =
	| { mode: "check"; baseTag: string; head: string }
	| { mode: "fold"; write: boolean }
	| { mode: "promote"; version: string; date: string; write: boolean }
	| { mode: "source"; baseTag: string; head: string; version: string; output: string }
	| { mode: "notes"; version: string; floor?: string; ref?: string; output?: string };
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
/** One changelog entry: a `- ` line plus its indented continuation lines. */
type Entry = string[];
type SectionBody = { comments: string[]; leading: Entry[]; categories: Map<string, Entry[]> };

const CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;
const DEFAULT_CATEGORY = "Changed";
const UNRELEASED_HEADING = /^## (?:\[Unreleased\]|Unreleased)[ \t]*$/;
const VERSION_HEADING = /^## \[?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\]?(?:[ \t]+(?:-|—)[ \t]+(\d{4}-\d{2}-\d{2}))?[ \t]*$/;
const CATEGORY_HEADING = /^### (\S.*?)[ \t]*$/;
const FRAGMENT_NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.md$/;
const FRAGMENT_PATH = /^changelog\.d\/[a-z0-9]+(?:[.-][a-z0-9]+)*\.md$/;
const POINTER = "<!-- New notes go in changelog.d/<bead>.md (optional first line `### Added|Changed|Fixed|Removed|Breaking Changes`); the release train folds them here. -->";

/** A refusal is a verdict, not a crash: exit 4, the release train's fail-closed convention. */
class Refusal extends Error {}
const fail = (reason: string): never => { throw new Error(reason); };
const refuse = (reason: string): never => { throw new Refusal(reason); };

try {
	run();
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`release-notes: ${error instanceof Refusal ? "REFUSED: " : ""}${message}`);
	process.exitCode = error instanceof Refusal ? 4 : 1;
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
	const gitOk = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode === 0;

	if (options.mode === "fold") return runFold(root, options.write);
	if (options.mode === "promote") return runPromote(root, options);
	if (options.mode === "notes") return runNotes(root, options, gitRaw);
	if (options.mode === "source") return runSourceNotes(root, options, git, gitRaw, gitOk);

	const base = git(["rev-parse", "--verify", "--end-of-options", `${options.baseTag}^{commit}`]);
	const head = git(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`]);
	if (git(["merge-base", base, head]) !== base) fail(`base tag ${options.baseTag} is not an ancestor of ${options.head}`);
	const history = collectHistory(git, gitRaw, gitOk, base, head, options.baseTag, options.head);
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
}

function parseArguments(args: string[]): Options {
	const usage = "Usage: release-notes.sh check --base-tag vX.Y.Z --head REF | source --base-tag vX.Y.Z --head REF --version X.Y.Z --output PATH | fold [--write] | promote --version X.Y.Z --date YYYY-MM-DD [--write] | notes --version X.Y.Z [--floor X.Y.Z] [--ref REF] [--output PATH]";
	const mode = args[0];
	if (mode === "check") {
		const values = parseFlags(args.slice(1), { "--base-tag": "value", "--head": "value" }, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		validateBaseTag(baseTag, usage);
		return { mode, baseTag, head };
	}
	if (mode === "source") {
		const values = parseFlags(args.slice(1), { "--base-tag": "value", "--head": "value", "--version": "value", "--output": "value" }, usage);
		const baseTag = requiredValue(values, "--base-tag", usage);
		const head = requiredValue(values, "--head", usage);
		const version = requiredValue(values, "--version", usage);
		const output = requiredValue(values, "--output", usage);
		validateBaseTag(baseTag, usage);
		if (!isStableVersion(version)) fail(usage);
		return { mode, baseTag, head, version, output };
	}
	if (mode === "fold") {
		const values = parseFlags(args.slice(1), { "--write": "boolean" }, usage);
		return { mode, write: values.get("--write") === true };
	}
	if (mode === "promote") {
		const values = parseFlags(args.slice(1), { "--version": "value", "--date": "value", "--write": "boolean" }, usage);
		const version = requiredValue(values, "--version", usage);
		const date = requiredValue(values, "--date", usage);
		if (!isStableVersion(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(usage);
		const parsedDate = new Date(`${date}T00:00:00.000Z`);
		if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date) fail("release date must be a real YYYY-MM-DD date");
		return { mode, version, date, write: values.get("--write") === true };
	}
	if (mode === "notes") {
		const values = parseFlags(args.slice(1), { "--version": "value", "--floor": "value", "--ref": "value", "--output": "value" }, usage);
		const version = requiredValue(values, "--version", usage);
		if (!isStableVersion(version)) fail(usage);
		const options: Extract<Options, { mode: "notes" }> = { mode, version };
		const floor = values.get("--floor");
		if (typeof floor === "string") {
			if (!isStableVersion(floor)) fail(usage);
			options.floor = floor;
		}
		const ref = values.get("--ref");
		if (typeof ref === "string") options.ref = ref;
		const output = values.get("--output");
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

function isStableVersion(value: string): boolean {
	return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index++) {
		if (a[index]! !== b[index]!) return a[index]! - b[index]!;
	}
	return 0;
}

function collectHistory(git: Git, gitRaw: Git, gitOk: (args: string[]) => boolean, base: string, head: string, baseTag: string, headRef: string): ReleaseHistory {
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
	const invalidPath = changedPaths.find(path => !FRAGMENT_PATH.test(path));
	if (invalidPath) fail(`fragment path must be changelog.d/<bead>.md: ${invalidPath}`);
	const fragments: Fragment[] = changedPaths.sort().map(path => toFragment(path, git(["show", `${head}:${path}`])));
	const byPr = new Map<string, Fragment>();
	for (const fragment of fragments) {
		if (!fragment.pr) continue;
		if (byPr.has(fragment.pr)) fail(`multiple changelog fragments name PR #${fragment.pr}`);
		byPr.set(fragment.pr, fragment);
	}
	// A fragment added in this range and then folded into CHANGELOG.md (deleted by `fold` or the
	// release bump commit) still covers its direct commit; read it from just before its deletion.
	const folded: Fragment[] = [];
	const deletedPaths = new Set(git(["log", "--diff-filter=D", "--name-only", "--format=", `${base}..${head}`, "--", "changelog.d"])
		.split(/\r?\n/).filter(Boolean));
	for (const path of [...deletedPaths].sort()) {
		if (!FRAGMENT_PATH.test(path) || changedPaths.includes(path)) continue;
		if (gitOk(["cat-file", "-e", `${base}:${path}`]) || gitOk(["cat-file", "-e", `${head}:${path}`])) continue;
		const deletion = git(["log", "-1", "--diff-filter=D", "--format=%H", `${base}..${head}`, "--", path]);
		folded.push(toFragment(path, git(["show", `${deletion}^:${path}`])));
	}

	const unreleased = readUnreleasedSection(gitRaw(["show", `${head}:CHANGELOG.md`]));
	const baseReleaseSection = readUnreleasedSection(gitRaw(["show", `${base}:CHANGELOG.md`]));
	const priorUnreleased = new Set(baseReleaseSection.entries.map(line => line.text));
	const unreleasedByPr = new Map<string, UnreleasedLine>();
	for (const line of unreleased.entries) {
		const references = [...line.text.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!);
		if (references.length > 1) fail(`CHANGELOG.md:${line.lineNumber} names multiple PRs`);
		const pr = references[0];
		if (!pr) continue;
		if (!seenPrs.has(pr) && priorUnreleased.has(line.text)) continue;
		if (unreleasedByPr.has(pr)) fail(`CHANGELOG.md ## [Unreleased] has multiple lines naming PR #${pr}`);
		if (!seenPrs.has(pr)) fail(`CHANGELOG.md:${line.lineNumber} references PR #${pr}, absent from ${baseTag}..${headRef}`);
		unreleasedByPr.set(pr, { ...line, pr });
	}

	// At the release commit, promotion has moved Unreleased lines into the new version section.
	const releasedPrs = new Set<string>();
	const releaseHeading = unreleased.lines[unreleased.nextHeadingIndex]!;
	if (VERSION_HEADING.exec(releaseHeading)?.[1] !== baseTag.replace(/^v/, "")) {
		const end = unreleased.lines.findIndex((line, index) => index > unreleased.nextHeadingIndex && /^##\s+/.test(line));
		for (const line of unreleased.lines.slice(unreleased.nextHeadingIndex + 1, end < 0 ? undefined : end)) {
			for (const match of line.matchAll(/\(PR #(\d+)\)/g)) releasedPrs.add(match[1]!);
		}
	}
	for (const pr of mergedPrs) {
		const fragment = byPr.get(pr);
		const line = unreleasedByPr.get(pr);
		if (fragment && line) fail(`merged PR #${pr} has both a changelog.d fragment and a tagged line in CHANGELOG.md ## [Unreleased]`);
		if (!fragment && !line && !releasedPrs.has(pr))
			fail(`merged PR #${pr} has no changelog.d fragment or tagged line in CHANGELOG.md ## [Unreleased]`);
	}
	// Allow cleanup of fragments whose PRs are recorded in the base tag; unknown references still fail.
	const baseReleasedPrs = new Set<string>();
	for (const line of baseReleaseSection.lines.slice(baseReleaseSection.unreleasedIndex + 1)) {
		for (const match of line.matchAll(/\(PR #(\d+)\)/g)) baseReleasedPrs.add(match[1]!);
	}

	for (const fragment of fragments) {
		if (fragment.pr && !seenPrs.has(fragment.pr) && !baseReleasedPrs.has(fragment.pr))
			fail(`fragment ${fragment.path} references PR #${fragment.pr}, absent from ${baseTag}..${headRef}`);
	}
	// Do not re-emit historical notes when their fragments are edited after the base release.
	const currentFragments = fragments.filter(fragment => !fragment.pr || !baseReleasedPrs.has(fragment.pr));
	for (const pr of baseReleasedPrs) byPr.delete(pr);
	const directCommits = collectDirectCommitCoverage(git, gitRaw, base, head, [...currentFragments, ...folded]);
	return { mergedPrs, fragments: currentFragments, byPr, unreleasedByPr, directCommits };
}

function toFragment(path: string, content: string): Fragment {
	if (!content.trim()) fail(`empty changelog fragment: ${path}`);
	const references = [...content.matchAll(/\(PR #(\d+)\)/g)].map(match => match[1]!);
	if (references.length > 1) fail(`fragment names multiple PRs: ${path}`);
	const fragment: Fragment = { path, content: content.trim() };
	if (references[0]) fragment.pr = references[0];
	return fragment;
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
		if (UNRELEASED_HEADING.test(lines[index]!)) unreleasedHeadings.push(index);
	}
	if (unreleasedHeadings.length !== 1) fail("CHANGELOG.md must contain exactly one ## [Unreleased] section");
	const unreleasedIndex = unreleasedHeadings[0]!;
	const nextHeadingIndex = lines.findIndex((line, index) => index > unreleasedIndex && /^##\s+/.test(line));
	if (nextHeadingIndex < 0) fail("CHANGELOG.md ## [Unreleased] section must precede a version section");

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
	if (inComment) fail("CHANGELOG.md has an unclosed comment in ## [Unreleased]");
	return { lines, unreleasedIndex, nextHeadingIndex, preservedComments, entries };
}

// ---------------------------------------------------------------------------------------------
// fold / promote / notes
// ---------------------------------------------------------------------------------------------

/** Parse a section body (lines between headings) into comments, uncategorized entries and buckets. */
function parseBody(lines: string[], where: string): SectionBody {
	const body: SectionBody = { comments: [], leading: [], categories: new Map() };
	let bucket: Entry[] = body.leading;
	let current: Entry | undefined;
	let inComment = false;
	for (const line of lines) {
		if (inComment || line.includes("<!--")) {
			body.comments.push(line);
			inComment = inComment ? !line.includes("-->") : !line.includes("-->");
			current = undefined;
			continue;
		}
		const category = CATEGORY_HEADING.exec(line);
		if (category) {
			const title = category[1]!;
			bucket = body.categories.get(title) ?? [];
			body.categories.set(title, bucket);
			current = undefined;
			continue;
		}
		if (!line.trim()) { current = undefined; continue; }
		if (/^#/.test(line)) fail(`${where}: unexpected heading inside a changelog section: ${line}`);
		if (/^\s+\S/.test(line) && current) { current.push(line); continue; }
		current = [line.startsWith("- ") ? line : `- ${line.trim()}`];
		bucket.push(current);
	}
	if (inComment) fail(`${where}: unclosed comment`);
	return body;
}

function entryKey(entry: Entry): string {
	return entry[0]!.trim();
}

function bodyEntries(body: SectionBody): Entry[] {
	return [...body.leading, ...[...body.categories.values()].flat()];
}

function orderedCategories(body: SectionBody): string[] {
	return [...body.categories.keys()].filter(title => body.categories.get(title)!.length > 0).sort((a, b) => {
		const ai = CATEGORY_ORDER.indexOf(a as (typeof CATEGORY_ORDER)[number]);
		const bi = CATEGORY_ORDER.indexOf(b as (typeof CATEGORY_ORDER)[number]);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});
}

function renderEntries(body: SectionBody): string[] {
	const out: string[] = [];
	if (body.leading.length) out.push(...body.leading.flat(), "");
	for (const title of orderedCategories(body)) out.push(`### ${title}`, "", ...body.categories.get(title)!.flat(), "");
	return out;
}

/** A fragment: an optional first `### Category` line, then bullets (paragraphs become one bullet each). */
function parseFragment(path: string, content: string): { category: string; entries: Entry[] } {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const first = lines.findIndex(line => line.trim());
	if (first < 0) fail(`empty changelog fragment: ${path}`);
	let category = DEFAULT_CATEGORY;
	let start = first;
	const heading = CATEGORY_HEADING.exec(lines[first]!);
	if (heading) {
		if (!CATEGORY_ORDER.includes(heading[1] as (typeof CATEGORY_ORDER)[number]))
			fail(`${path}: unknown category "${heading[1]}"; use one of ${CATEGORY_ORDER.join(", ")}`);
		category = heading[1]!;
		start = first + 1;
	}
	const entries: Entry[] = [];
	let paragraph: string[] = [];
	let current: Entry | undefined;
	const flush = () => {
		if (paragraph.length) entries.push([`- ${paragraph.join(" ")}`]);
		paragraph = [];
	};
	for (const line of lines.slice(start)) {
		if (line.includes("<!--")) fail(`${path}: comments are not allowed in fragments`);
		if (/^#/.test(line)) fail(`${path}: only one optional leading "### Category" line is allowed; found ${JSON.stringify(line)}`);
		if (!line.trim()) { flush(); current = undefined; continue; }
		if (line.startsWith("- ")) { flush(); current = [line.trimEnd()]; entries.push(current); continue; }
		if (/^\s+\S/.test(line) && current) { current.push(line.trimEnd()); continue; }
		current = undefined;
		paragraph.push(line.trim());
	}
	flush();
	if (!entries.length) fail(`empty changelog fragment: ${path}`);
	return { category, entries };
}

type Changelog = { lines: string[]; unreleasedStart: number; unreleasedEnd: number };

function locateUnreleased(text: string): Changelog {
	const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
	const starts = lines.flatMap((line, index) => UNRELEASED_HEADING.test(line) ? [index] : []);
	if (starts.length !== 1) fail("CHANGELOG.md must contain exactly one ## [Unreleased] section");
	const unreleasedStart = starts[0]!;
	let unreleasedEnd = lines.findIndex((line, index) => index > unreleasedStart && /^## /.test(line));
	if (unreleasedEnd < 0) unreleasedEnd = lines.length;
	return { lines, unreleasedStart, unreleasedEnd };
}

/** Every entry already in a released section; fold drops exact duplicates (fix-changelogs dedupe). */
function releasedKeys(changelog: Changelog): Set<string> {
	const keys = new Set<string>();
	changelog.lines.forEach((line, index) => {
		if ((index < changelog.unreleasedStart || index >= changelog.unreleasedEnd) && line.startsWith("- ")) keys.add(line.trim());
	});
	return keys;
}

function listFragments(root: string): string[] {
	const dir = join(root, "changelog.d");
	if (!existsSync(dir)) return [];
	const names = readdirSync(dir).filter(name => name.endsWith(".md")).sort();
	const invalid = names.find(name => !FRAGMENT_NAME.test(name));
	if (invalid) fail(`fragment path must be changelog.d/<bead>.md: changelog.d/${invalid}`);
	return names.map(name => `changelog.d/${name}`);
}

function fold(root: string, text: string): { text: string; body: SectionBody; changelog: Changelog; folded: string[]; added: number; duplicates: number } {
	const changelog = locateUnreleased(text);
	const body = parseBody(changelog.lines.slice(changelog.unreleasedStart + 1, changelog.unreleasedEnd), "CHANGELOG.md ## [Unreleased]");
	const seen = releasedKeys(changelog);
	for (const entry of bodyEntries(body)) seen.add(entryKey(entry));
	const folded = listFragments(root);
	let added = 0;
	let duplicates = 0;
	for (const path of folded) {
		const fragment = parseFragment(path, readFileSync(join(root, path), "utf8"));
		const bucket = body.categories.get(fragment.category) ?? [];
		body.categories.set(fragment.category, bucket);
		for (const entry of fragment.entries) {
			if (seen.has(entryKey(entry))) { duplicates++; continue; }
			seen.add(entryKey(entry));
			bucket.push(entry);
			added++;
		}
	}
	const comments = body.comments.some(line => line.includes(POINTER)) ? body.comments : [POINTER, ...body.comments];
	const section = ["## [Unreleased]", "", ...comments, "", ...renderEntries(body)];
	const rest = changelog.lines.slice(changelog.unreleasedEnd);
	const output = [...changelog.lines.slice(0, changelog.unreleasedStart), ...section, ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
	return { text: `${output.replace(/\n+$/, "")}\n`, body: { ...body, comments }, changelog, folded, added, duplicates };
}

function runFold(root: string, write: boolean): void {
	const path = join(root, "CHANGELOG.md");
	const result = fold(root, readFileSync(path, "utf8"));
	if (write) {
		writeFileSync(path, result.text);
		for (const fragment of result.folded) unlinkSync(join(root, fragment));
	} else {
		process.stdout.write(result.text);
	}
	console.error(`FOLDED fragments=${result.folded.length} entries_added=${result.added} duplicates_dropped=${result.duplicates}${write ? "" : " (preview; --write applies and removes the fragments)"}`);
}

/** package.json `version` and `omp.version`, read through guards (parsed JSON is untrusted). */
function packageVersions(text: string): { version: unknown; ompVersion: unknown } {
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object") return { version: undefined, ompVersion: undefined };
	const version = "version" in parsed ? parsed.version : undefined;
	const omp = "omp" in parsed ? parsed.omp : undefined;
	const ompVersion = omp && typeof omp === "object" && "version" in omp ? omp.version : undefined;
	return { version, ompVersion };
}

function setPackageVersion(text: string, version: string): string {
	let count = 0;
	const updated = text.replace(/^([ \t]*)"version": "[^"\n]*"/gm, (_match, indent: string) => { count++; return `${indent}"version": "${version}"`; });
	const parsed = packageVersions(updated);
	if (count !== 2 || parsed.version !== version || parsed.ompVersion !== version)
		fail(`package.json must carry exactly a top-level "version" and an "omp.version" (found ${count} version fields)`);
	return updated;
}

function runPromote(root: string, options: Extract<Options, { mode: "promote" }>): void {
	const changelogPath = join(root, "CHANGELOG.md");
	const packagePath = join(root, "package.json");
	const folded = fold(root, readFileSync(changelogPath, "utf8"));
	const lines = folded.text.replace(/\n+$/, "").split("\n");
	const released = lines.flatMap(line => VERSION_HEADING.exec(line)?.[1] ?? []);
	if (released.includes(options.version)) fail(`release section already exists: ## [${options.version}]`);
	const newest = released.reduce<string | undefined>((max, version) => !max || compareVersions(version, max) > 0 ? version : max, undefined);
	if (newest && compareVersions(options.version, newest) <= 0) fail(`version ${options.version} must be greater than the newest released section ${newest}`);
	const entries = bodyEntries(folded.body);
	if (!entries.length) refuse("nothing to release: CHANGELOG.md ## [Unreleased] has no entries and changelog.d/ has no fragments");

	const changelog = locateUnreleased(folded.text);
	const section = [
		"## [Unreleased]", "", ...folded.body.comments, "",
		`## [${options.version}] - ${options.date}`, "", ...renderEntries(folded.body),
	];
	const output = [...changelog.lines.slice(0, changelog.unreleasedStart), ...section, ...changelog.lines.slice(changelog.unreleasedEnd)]
		.join("\n").replace(/\n{3,}/g, "\n\n");
	const packageText = readFileSync(packagePath, "utf8");
	const previous = String(packageVersions(packageText).version ?? "?");
	const nextPackage = setPackageVersion(packageText, options.version);
	if (options.write) {
		writeFileSync(changelogPath, `${output.replace(/\n+$/, "")}\n`);
		writeFileSync(packagePath, nextPackage);
		for (const fragment of folded.folded) unlinkSync(join(root, fragment));
	} else {
		process.stdout.write(`${[`## [${options.version}] - ${options.date}`, "", ...renderEntries(folded.body)].join("\n").replace(/\n+$/, "")}\n`);
	}
	console.log(`PROMOTED version=${options.version} date=${options.date} entries=${entries.length} fragments=${folded.folded.length} package_version=${previous}->${options.version}${options.write ? "" : " (preview; --write applies)"}`);
}

function runNotes(root: string, options: Extract<Options, { mode: "notes" }>, gitRaw: Git): void {
	const text = options.ref ? gitRaw(["show", `${options.ref}:CHANGELOG.md`]) : readFileSync(join(root, "CHANGELOG.md"), "utf8");
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const headings = lines.flatMap((line, index) => /^## /.test(line) ? [index] : []);
	const spans = headings.flatMap(index => {
		const version = VERSION_HEADING.exec(lines[index]!)?.[1];
		if (!version) return [];
		return [{ version, start: index, end: headings.find(next => next > index) ?? lines.length }];
	});
	if (!spans.some(span => span.version === options.version))
		refuse(`CHANGELOG.md${options.ref ? ` at ${options.ref}` : ""} has no ## [${options.version}] section`);
	// Like upstream ci-release-notes.ts: aggregate (floor, version] so sections of tags that never
	// got a GitHub release are not stranded; newest first, exact duplicate lines dropped.
	const selected = spans
		.filter(span => compareVersions(span.version, options.version) <= 0 &&
			(options.floor ? compareVersions(span.version, options.floor) > 0 : span.version === options.version))
		.sort((a, b) => compareVersions(b.version, a.version));
	const merged: SectionBody = { comments: [], leading: [], categories: new Map() };
	const seen = new Set<string>();
	for (const span of selected) {
		const body = parseBody(lines.slice(span.start + 1, span.end), `CHANGELOG.md ## [${span.version}]`);
		const take = (from: Entry[], into: Entry[]) => {
			for (const entry of from) {
				if (seen.has(entryKey(entry))) continue;
				seen.add(entryKey(entry));
				into.push(entry);
			}
		};
		take(body.leading, merged.leading);
		for (const [title, entries] of body.categories) {
			const bucket = merged.categories.get(title) ?? [];
			merged.categories.set(title, bucket);
			take(entries, bucket);
		}
	}
	if (!bodyEntries(merged).length) refuse(`CHANGELOG.md ## [${options.version}] has no entries; an empty release body is refused`);
	const notes = `${renderEntries(merged).join("\n").replace(/\n+$/, "")}\n`;
	if (options.output) {
		const output = resolve(root, options.output);
		if (output === join(root, "CHANGELOG.md")) fail("notes never overwrite CHANGELOG.md");
		writeFileSync(output, notes);
		console.error(`NOTES version=${options.version} sections=${selected.map(span => span.version).join(",")} entries=${seen.size} -> ${options.output}`);
		return;
	}
	process.stdout.write(notes);
}

/** Render an immutable source range without promoting or rewriting the source tree. */
function runSourceNotes(root: string, options: Extract<Options, { mode: "source" }>, git: Git, gitRaw: Git, gitOk: (args: string[]) => boolean): void {
	const base = git(["rev-parse", "--verify", "--end-of-options", `${options.baseTag}^{commit}`]);
	const head = git(["rev-parse", "--verify", "--end-of-options", `${options.head}^{commit}`]);
	if (git(["merge-base", base, head]) !== base) fail("release source must descend from the published notes floor");
	collectHistory(git, gitRaw, gitOk, base, head, options.baseTag, options.head);
	const bodies = (ref: string): SectionBody[] => {
		const text = gitRaw(["show", `${ref}:CHANGELOG.md`]);
		const section = locateUnreleased(text);
		const result = [parseBody(section.lines.slice(section.unreleasedStart + 1, section.unreleasedEnd), `${ref}:Unreleased`)];
		for (const path of git(["ls-tree", "-r", "--name-only", ref, "--", "changelog.d"]).split("\n").filter(Boolean)) {
			if (!FRAGMENT_PATH.test(path)) fail(`invalid release fragment: ${path}`);
			const fragment = parseFragment(path, gitRaw(["show", `${ref}:${path}`]));
			result.push({ comments: [], leading: [], categories: new Map([[fragment.category, fragment.entries]]) });
		}
		// Manual release bumps may have promoted notes in this range. Include new
		// sections too; pre-existing section entries remain in the baseline set.
		let start = section.unreleasedEnd;
		while (start < section.lines.length) {
			const next = section.lines.findIndex((line, index) => index > start && line.startsWith("## "));
			const end = next < 0 ? section.lines.length : next;
			if (VERSION_HEADING.test(section.lines[start]!)) result.push(parseBody(section.lines.slice(start + 1, end), `${ref}:${section.lines[start]}`));
			start = end;
		}
		return result;
	};
	const seen = new Set(bodies(base).flatMap(body => bodyEntries(body).map(entryKey)));
	const merged: SectionBody = { comments: [], leading: [], categories: new Map() };
	for (const body of bodies(head)) {
		const take = (entries: Entry[], target: Entry[]) => {
			for (const entry of entries) {
				if (seen.has(entryKey(entry))) continue;
				seen.add(entryKey(entry));
				target.push(entry);
			}
		};
		take(body.leading, merged.leading);
		for (const [category, entries] of body.categories) {
			const target = merged.categories.get(category) ?? [];
			merged.categories.set(category, target);
			take(entries, target);
		}
	}
	if (!bodyEntries(merged).length) refuse("nothing to release in the selected source range");
	const output = resolve(root, options.output);
	if (output === join(root, "CHANGELOG.md")) fail("source notes never overwrite CHANGELOG.md");
	writeFileSync(output, `${renderEntries(merged).join("\n").replace(/\n+$/, "")}\n`);
	console.log(`SOURCE_NOTES version=${options.version} source_sha=${head} base_sha=${base}`);
}
