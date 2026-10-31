import { expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as runProcess, type RunResult } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const scratch = ownedTmp("portable-paths-test");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const baseEnvironment = Object.fromEntries(
	Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
) as Record<string, string>;
const checkerContracts = [
	"publishability.test.sh",
	"doc-drift.test.sh",
	"derived-check.test.sh",
	"dispatch-check.test.sh",
	"br-shim.test.sh",
	"public-files.test.sh",
	"commit-msg-bead.test.sh",
	"check-pushed-beads.test.sh",
	"release-train.test.sh",
	"check-staged-br-init.test.sh",
	"full-suite-verdict-incomplete.test.sh",
	"pre-push-gate.test.sh",
];

function environment(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...baseEnvironment,
		TMPDIR: scratch.path,
		GIT_CEILING_DIRECTORIES: scratch.path,
		...extra,
	};
}

function output(result: RunResult): string {
	const decoder = new TextDecoder();
	return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`;
}

async function command(
	argv: string[],
	cwd: string,
	options: { env?: Record<string, string>; stdin?: string } = {},
) {
	return runProcess(argv, {
		cwd,
		deadline_s: 120,
		env: environment(options.env),
		stdin: options.stdin,
	});
}

async function okay(argv: string[], cwd: string): Promise<void> {
	const result = await command(argv, cwd);
	if (result.rc !== 0) throw new Error(`${argv.join(" ")} failed (${result.rc})\n${output(result)}`);
}

async function git(repo: string, ...args: string[]) {
	return command(["git", "-C", repo, ...args], repo);
}

async function gitOkay(repo: string, ...args: string[]): Promise<void> {
	const result = await git(repo, ...args);
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed (${result.rc})\n${output(result)}`);
}

function baseline(counts: Record<string, number>): string {
	const sorted = Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	return `${JSON.stringify({
		about: "Pre-existing portable-path findings by shipped path; this ratchet only shrinks.",
		counts: sorted,
		schema: 1,
		totals: { "portable-paths": total },
	}, null, 2)}\n`;
}

async function newPrecommitRepo(name: string, includeBaseline = true): Promise<string> {
	const repo = join(scratch.path, name);
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "extensions"), { recursive: true });
	mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
	await okay(["git", "init", "-q"], repo);
	await gitOkay(repo, "config", "user.email", "portable-paths@example.invalid");
	await gitOkay(repo, "config", "user.name", "Portable Paths Test");
	if (includeBaseline) {
		writeFileSync(
			join(repo, "scripts", "portable-paths-baseline.json"),
			baseline({ "extensions/legacy.ts": 1 }),
		);
	}
	writeFileSync(join(repo, "extensions", "legacy.ts"), 'export const legacy = "/Users/josh/old";\n');
	writeFileSync(join(repo, "extensions", "new.ts"), "export const safe = 1;\n");
	const initialPaths = ["extensions/legacy.ts", "extensions/new.ts"];
	if (includeBaseline) initialPaths.unshift("scripts/portable-paths-baseline.json");
	await gitOkay(repo, "add", "--", ...initialPaths);
	await gitOkay(repo, "commit", "-m", "[test] fixture root");
	await okay(["sh", join(repoRoot, "scripts", "install-commit-msg-bead.sh"), repo], repo);
	return repo;
}

async function newUnbornPrecommitRepo(name: string): Promise<string> {
	const repo = join(scratch.path, name);
	mkdirSync(join(repo, "extensions"), { recursive: true });
	await okay(["git", "init", "-q"], repo);
	await gitOkay(repo, "config", "user.email", "portable-paths@example.invalid");
	await gitOkay(repo, "config", "user.name", "Portable Paths Test");
	await okay(["sh", join(repoRoot, "scripts", "install-commit-msg-bead.sh"), repo], repo);
	return repo;
}

async function newPrepushRepo(name: string, includeBaseline = true): Promise<string> {
	const repo = join(scratch.path, name);
	mkdirSync(join(repo, "scripts"), { recursive: true });
	mkdirSync(join(repo, "extensions"), { recursive: true });
	mkdirSync(join(repo, "tests", "cli"), { recursive: true });
	mkdirSync(join(repo, "var", "agent-tmp"), { recursive: true });
	await okay(["git", "init", "-q"], repo);
	await gitOkay(repo, "config", "user.email", "portable-paths@example.invalid");
	await gitOkay(repo, "config", "user.name", "Portable Paths Test");
	if (includeBaseline) writeFileSync(join(repo, "scripts", "portable-paths-baseline.json"), baseline({}));
	writeFileSync(join(repo, "scripts", "fresh-gate.sh"), "#!/bin/sh\nexit 0\n");
	writeFileSync(join(repo, "scripts", "regexploit-gate.py"), "#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n");
	const baseScripts = [
		"check-portable-paths.sh",
		"portable_paths_check.py",
		"kitlib_ratchet_core.py",
		"pysafe.py",
		"kitlib_run.py",
		"kitlib_tmp.py",
		"suite-metrics.py",
		"suite-hermetic-env.sh",
	];
	for (const file of baseScripts) {
		const source = join(repoRoot, "scripts", file);
		if (existsSync(source)) copyFileSync(source, join(repo, "scripts", file));
	}
	if (existsSync(join(repo, "scripts", "check-portable-paths.sh"))) {
		chmodSync(join(repo, "scripts", "check-portable-paths.sh"), 0o755);
	}
	for (const name of checkerContracts) {
		writeFileSync(join(repo, "tests", "cli", name), "#!/bin/sh\nexit 0\n");
	}
	const initialPaths = [
		"scripts/fresh-gate.sh",
		"scripts/regexploit-gate.py",
		...baseScripts.filter(file => existsSync(join(repo, "scripts", file))).map(file => `scripts/${file}`),
		...checkerContracts.map(file => `tests/cli/${file}`),
	];
	if (includeBaseline) initialPaths.unshift("scripts/portable-paths-baseline.json");
	await gitOkay(repo, "add", "--", ...initialPaths);
	await gitOkay(repo, "commit", "-m", "[test] base gate");
	return repo;
}

async function runPrepush(repo: string, base: string, head: string) {
	return command(
		["sh", join(repoRoot, "scripts", "pre-push-gate.sh")],
		repo,
		{
			stdin: `refs/heads/main ${head} refs/heads/main ${base}\n`,
			env: { GIT_DIR: join(repo, ".git"), GIT_WORK_TREE: repo },
		},
	);
}

function expectRefusal(result: RunResult, file: string): void {
	const transcript = output(result);
	expect(result.rc).not.toBe(0);
	expect(transcript).toContain(file);
	expect(transcript).toContain("resolve through the installed release or a documented config/env setting");
}

test("gates: baseline-less repositories admit clean changes without losing the ratchet", async () => {
	const repo = await newPrecommitRepo("precommit-baseline-less", false);
	const baseResult = await git(repo, "rev-parse", "HEAD");
	if (baseResult.rc !== 0) throw new Error(`base lookup failed\n${output(baseResult)}`);
	const base = output(baseResult).trim();

	writeFileSync(join(repo, "extensions", "added.ts"), "export const added = true;\n");
	await gitOkay(repo, "add", "--", "extensions/added.ts");
	const accepted = await git(repo, "commit", "-m", "[test] clean baseline-less change");
	if (accepted.rc !== 0) throw new Error(`baseline-less clean commit failed\n${output(accepted)}`);

	const headResult = await git(repo, "rev-parse", "HEAD");
	if (headResult.rc !== 0) throw new Error(`head lookup failed\n${output(headResult)}`);
	const head = output(headResult).trim();
	const range = await command(
		["python3", join(repoRoot, "scripts", "portable_paths_check.py"), "--repo", repo, "--base", base, "--head", head],
		repo,
	);
	if (range.rc !== 0) throw new Error(`baseline-less range check failed (${range.rc})\n${output(range)}`);

	writeFileSync(join(repo, "extensions", "bad.ts"), 'export const bad = "/Users/josh/x";\n');
	await gitOkay(repo, "add", "--", "extensions/bad.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] reject new baseline-less path"), "extensions/bad.ts:1");
}, 120_000);

test("gates: unborn baseline-less repositories admit safe first commits and reject machine paths", async () => {
	const cleanRepo = await newUnbornPrecommitRepo("precommit-unborn-clean");
	const emptyHead = await command(
		["python3", join(repoRoot, "scripts", "portable_paths_check.py"), "--repo", cleanRepo, "--head", "HEAD"],
		cleanRepo,
	);
	expect(emptyHead.rc).toBe(0);
	writeFileSync(join(cleanRepo, "extensions", "clean.ts"), "export const clean = true;\n");
	await gitOkay(cleanRepo, "add", "--", "extensions/clean.ts");
	const accepted = await git(cleanRepo, "commit", "-m", "[test] clean unborn baseline-less commit");
	if (accepted.rc !== 0) throw new Error(`unborn clean first commit failed\n${output(accepted)}`);

	const badRepo = await newUnbornPrecommitRepo("precommit-unborn-bad");
	writeFileSync(join(badRepo, "extensions", "bad.ts"), 'export const bad = "/Users/josh/x";\n');
	await gitOkay(badRepo, "add", "--", "extensions/bad.ts");
	const rejected = await git(badRepo, "commit", "-m", "[test] reject unborn machine path");
	expectRefusal(rejected, "extensions/bad.ts:1");
	const head = await git(badRepo, "rev-parse", "--verify", "HEAD^{commit}");
	expect(head.rc).not.toBe(0);
}, 120_000);
test("planted negative: removing the installed check lets the forbidden hunk through", async () => {
	const repo = await newPrecommitRepo("precommit-deleted-check");
	const hooksResult = await git(repo, "rev-parse", "--git-path", "hooks");
	if (hooksResult.rc !== 0) throw new Error(`hooks path lookup failed\n${output(hooksResult)}`);
	const hooksPath = output(hooksResult).trim();
	const hooksRoot = hooksPath.startsWith("/") ? hooksPath : join(repo, hooksPath);
	const member = join(hooksRoot, "hooks.d", "pre-commit", "54-omp-kit-staged-portable-paths");
	writeFileSync(member, "#!/bin/sh\nexit 0\n");
	chmodSync(member, 0o755);

	writeFileSync(join(repo, "extensions", "mutant.ts"), 'export const path = "/Users/josh/x";\n');
	await gitOkay(repo, "add", "--", "extensions/mutant.ts");
	const mutantCommit = await git(repo, "commit", "-m", "[test] deleted portable-path check");
	let refusalAssertionFailed = false;
	try {
		expectRefusal(mutantCommit, "extensions/mutant.ts:1");
	} catch {
		refusalAssertionFailed = true;
	}
	expect(mutantCommit.rc).toBe(0);
	expect(refusalAssertionFailed).toBe(true);
}, 120_000);

test("gates: pre-commit rejects shipped local paths and exempts tests", async () => {
	const repo = await newPrecommitRepo("precommit-paths");
	writeFileSync(join(repo, "extensions", "foo.ts"), 'export const path = "/Users/josh/x";\n');
	await gitOkay(repo, "add", "--", "extensions/foo.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add machine path"), "extensions/foo.ts:1");

	writeFileSync(join(repo, "extensions", "foo.ts"), "export const safe = 1;\n");
	writeFileSync(join(repo, "extensions", "foo.test.ts"), 'expect("/Users/josh/x").toBeTruthy();\n');
	await gitOkay(repo, "add", "--", "extensions/foo.ts", "extensions/foo.test.ts");
	const testControl = await git(repo, "commit", "-m", "[test] test fixture control");
	if (testControl.rc !== 0) throw new Error(`test-path control failed\n${output(testControl)}`);

	writeFileSync(
		join(repo, "extensions", "joined.ts"),
		'import { join } from "node:path";\nexport const path = join(home, ".claude", "skills");\n',
	);
	await gitOkay(repo, "add", "--", "extensions/joined.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add joined machine path"), "extensions/joined.ts");
	writeFileSync(join(repo, "extensions", "joined.ts"), "export const path = \"safe\";\n");
	await gitOkay(repo, "add", "--", "extensions/joined.ts");
	const joinedControl = await git(repo, "commit", "-m", "[test] clear joined path");
	if (joinedControl.rc !== 0) throw new Error(`joined-path control failed\n${output(joinedControl)}`);

	writeFileSync(join(repo, "extensions", "tilde.ts"), 'export const path = "~/.claude/skills/tool";\n');
	await gitOkay(repo, "add", "--", "extensions/tilde.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add tilde machine path"), "extensions/tilde.ts");
	writeFileSync(join(repo, "extensions", "tilde.ts"), "export const path = \"safe\";\n");
	await gitOkay(repo, "add", "--", "extensions/tilde.ts");
	const tildeControl = await git(repo, "commit", "-m", "[test] clear tilde path");
	if (tildeControl.rc !== 0) throw new Error(`tilde-path control failed\n${output(tildeControl)}`);

	writeFileSync(join(repo, "extensions", "escaped.ts"), 'export const path = join(home, "\\x2eclaude", "skills");\n');
	await gitOkay(repo, "add", "--", "extensions/escaped.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add escaped joined path"), "extensions/escaped.ts");
	writeFileSync(join(repo, "extensions", "escaped.ts"), "export const path = \"safe\";\n");
	await gitOkay(repo, "add", "--", "extensions/escaped.ts");
	const escapedControl = await git(repo, "commit", "-m", "[test] clear escaped path");
	if (escapedControl.rc !== 0) throw new Error(`escaped-path control failed\n${output(escapedControl)}`);

	writeFileSync(join(repo, "extensions", "nested.ts"), 'export const path = join(home, join("\\x2eclaude", "skills"));\n');
	await gitOkay(repo, "add", "--", "extensions/nested.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add nested joined path"), "extensions/nested.ts");
	writeFileSync(join(repo, "extensions", "nested.ts"), "export const path = \"safe\";\n");
	await gitOkay(repo, "add", "--", "extensions/nested.ts");
	const nestedControl = await git(repo, "commit", "-m", "[test] clear nested path");
	if (nestedControl.rc !== 0) throw new Error(`nested-path control failed\n${output(nestedControl)}`);

	writeFileSync(
		join(repo, "scripts", "joined.py"),
		'from os.path import join\npath = join(home, "\\x2eclaude", "skills")\n',
	);
	await gitOkay(repo, "add", "--", "scripts/joined.py");
	expectRefusal(await git(repo, "commit", "-m", "[test] add escaped Python path"), "scripts/joined.py");
	writeFileSync(join(repo, "scripts", "joined.py"), "path = \"safe\"\n");
	await gitOkay(repo, "add", "--", "scripts/joined.py");
	const pythonControl = await git(repo, "commit", "-m", "[test] clear Python path");
	if (pythonControl.rc !== 0) throw new Error(`Python-path control failed\n${output(pythonControl)}`);

	writeFileSync(
		join(repo, "extensions", "prefix.ts"),
		'export const safe = ["/Users/joshua/x", "~/.claude/skills-old", join(home, ".claude", "skills-old")];\n',
	);
	writeFileSync(
		join(repo, "extensions", "comment.ts"),
		'// join(home, ".claude", "skills")\nexport const safe = join(home, ".claude", "themes");\n',
	);
	await gitOkay(repo, "add", "--", "extensions/prefix.ts", "extensions/comment.ts");
	const prefixControl = await git(repo, "commit", "-m", "[test] path-prefix and comment controls");
	if (prefixControl.rc !== 0) throw new Error(`path-prefix control failed\n${output(prefixControl)}`);

	writeFileSync(join(repo, "extensions", "heredoc.sh"), "cat <<'EOF'\n/Users/josh/x\nEOF\n");
	await gitOkay(repo, "add", "--", "extensions/heredoc.sh");
	expectRefusal(await git(repo, "commit", "-m", "[test] heredoc machine path"), "extensions/heredoc.sh:2");
}, 120_000);

test("allowlist ratchet permits removals but refuses new occurrences and entries", async () => {
	const repo = await newPrecommitRepo("allowlist-ratchet");
	writeFileSync(join(repo, "extensions", "legacy.ts"), "export const legacy = \"safe\";\n");
	await gitOkay(repo, "add", "--", "extensions/legacy.ts");
	const removed = await git(repo, "commit", "-m", "[test] remove legacy path");
	if (removed.rc !== 0) throw new Error(`allowlisted removal failed\n${output(removed)}`);

	writeFileSync(join(repo, "extensions", "legacy.ts"), 'export const legacy = "/Users/josh/new";\n');
	await gitOkay(repo, "add", "--", "extensions/legacy.ts");
	expectRefusal(await git(repo, "commit", "-m", "[test] add path to legacy file"), "extensions/legacy.ts");

	writeFileSync(join(repo, "extensions", "legacy.ts"), "export const legacy = \"safe\";\n");
	writeFileSync(join(repo, "scripts", "portable-paths-baseline.json"), baseline({}));
	await gitOkay(repo, "add", "--", "extensions/legacy.ts", "scripts/portable-paths-baseline.json");
	const shrunk = await git(repo, "commit", "-m", "[test] shrink path baseline");
	if (shrunk.rc !== 0) throw new Error(`allowlist shrink failed\n${output(shrunk)}`);

	writeFileSync(
		join(repo, "scripts", "portable-paths-baseline.json"),
		baseline({ "extensions/new.ts": 1 }),
	);
	await gitOkay(repo, "add", "--", "scripts/portable-paths-baseline.json");
	const raised = await git(repo, "commit", "-m", "[test] raise path baseline");
	expect(raised.rc).not.toBe(0);
	expect(output(raised)).toContain("scripts/portable-paths-baseline.json");
	expect(output(raised)).toContain("adds or raises allowlist entry extensions/new.ts");
}, 60_000);

test("gates: pre-push uses the base checker and rejects a planted range", async () => {
	const badRepo = await newPrepushRepo("prepush-paths-bad");
	const badBaseResult = await git(badRepo, "rev-parse", "HEAD");
	if (badBaseResult.rc !== 0) throw new Error(`base lookup failed\n${output(badBaseResult)}`);
	const badBase = output(badBaseResult).trim();
	writeFileSync(join(badRepo, "scripts", "check-portable-paths.sh"), "#!/bin/sh\nexit 0\n");
	writeFileSync(join(badRepo, "extensions", "foo.ts"), 'export const path = "/Users/josh/x";\n');
	await gitOkay(badRepo, "add", "--", "scripts/check-portable-paths.sh", "extensions/foo.ts");
	await gitOkay(badRepo, "commit", "-m", "[test] planted path range");
	const badHeadResult = await git(badRepo, "rev-parse", "HEAD");
	if (badHeadResult.rc !== 0) throw new Error(`head lookup failed\n${output(badHeadResult)}`);
	const badHead = output(badHeadResult).trim();
	const badPush = await runPrepush(badRepo, badBase, badHead);
	expectRefusal(badPush, "extensions/foo.ts");
	expect(output(badPush)).toContain("portable-paths-range");

	const cleanRepo = await newPrepushRepo("prepush-paths-clean");
	const cleanBaseResult = await git(cleanRepo, "rev-parse", "HEAD");
	if (cleanBaseResult.rc !== 0) throw new Error(`clean base lookup failed\n${output(cleanBaseResult)}`);
	const cleanBase = output(cleanBaseResult).trim();
	writeFileSync(join(cleanRepo, "extensions", "clean.ts"), "export const value = 1;\n");
	await gitOkay(cleanRepo, "add", "--", "extensions/clean.ts");
	await gitOkay(cleanRepo, "commit", "-m", "[test] clean range");
	const cleanHeadResult = await git(cleanRepo, "rev-parse", "HEAD");
	if (cleanHeadResult.rc !== 0) throw new Error(`clean head lookup failed\n${output(cleanHeadResult)}`);
	const cleanHead = output(cleanHeadResult).trim();
	const cleanPush = await runPrepush(cleanRepo, cleanBase, cleanHead);
	if (cleanPush.rc !== 0) throw new Error(`clean push control failed (${cleanPush.rc})\n${output(cleanPush)}`);
	expect(output(cleanPush)).toContain("GREEN portable-paths-range");
}, 120_000);
test("gates: pre-push admits a clean range without a baseline", async () => {
	const repo = await newPrepushRepo("prepush-paths-baseline-less", false);
	const baseResult = await git(repo, "rev-parse", "HEAD");
	if (baseResult.rc !== 0) throw new Error(`base lookup failed\n${output(baseResult)}`);
	const base = output(baseResult).trim();
	writeFileSync(join(repo, "extensions", "clean.ts"), "export const value = 1;\n");
	await gitOkay(repo, "add", "--", "extensions/clean.ts");
	await gitOkay(repo, "commit", "-m", "[test] clean baseline-less range");
	const headResult = await git(repo, "rev-parse", "HEAD");
	if (headResult.rc !== 0) throw new Error(`head lookup failed\n${output(headResult)}`);
	const head = output(headResult).trim();
	const push = await runPrepush(repo, base, head);
	if (push.rc !== 0) throw new Error(`baseline-less push failed (${push.rc})\n${output(push)}`);
	expect(output(push)).toContain("GREEN portable-paths-range");
}, 120_000);
