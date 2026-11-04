import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { briefCandidates, briefContract, checkTaskBrief, GENERIC_COMPLY, renderBrief, type BriefExec } from "../../src/brief.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixtureAsync } from "./fixture-process.ts";

const source = resolve(import.meta.dir, "../..");
const scratch = ownedTmp("brief-tests");
afterAll(() => scratch.cleanup());
// TMPCANON1: fixtures live under a symlinked parent so a missed canonicalization fails on every host, not only under /var/folders.
const aliased = join(scratch.path, "aliased");
mkdirSync(join(scratch.path, "physical"));
symlinkSync(join(scratch.path, "physical"), aliased);
let sequence = 0;
const execute: BriefExec = async (command, args, options) => {
	const result = await runFixtureAsync([command, ...args], { cwd: options.cwd, env: { ...process.env, ...options.env, GIT_CEILING_DIRECTORIES: scratch.path, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
	return { code: result.rc ?? 1, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
};
async function git(repo: string, ...args: string[]): Promise<string> {
	const result = await execute("git", args, { cwd: repo, timeout: fixtureDeadlineS() * 1000 });
	if (result.code !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
async function fixture(gated = true) {
	const repo = join(aliased, `repo-${++sequence}`);
	mkdirSync(repo);
	await git(repo, "init", "-q", "--template=");
	await git(repo, "config", "user.name", "Brief Fixture");
	await git(repo, "config", "user.email", "brief@invalid");
	await git(repo, "config", "core.hooksPath", ".git/hooks");
	writeFileSync(join(repo, "work.txt"), "landed feature\nkeep\n");
	await git(repo, "add", "--", "work.txt");
	await git(repo, "commit", "-qm", "land feature\n\nBead: fixture-landed");
	if (gated) {
		const chain = join(repo, ".git/hooks/hooks.d/pre-commit");
		mkdirSync(chain, { recursive: true });
		const member = join(chain, "51-omp-kit-staged-kitlib");
		writeFileSync(member, readFileSync(join(source, "scripts/check-staged-kitlib.sh")));
		chmodSync(member, 0o755);
	}
	return repo;
}

test("brief derives required rules from installed members and source checks, not repo names", async () => {
	const repo = await fixture();
	const scripts = join(repo, "scripts");
	mkdirSync(scripts);
	for (const name of ["check-staged-tempsafe.sh", "check-staged-wallclock.sh", "check-staged-br-init.sh", "fresh-gate.sh"]) writeFileSync(join(scripts, name), readFileSync(join(source, "scripts", name)));
	await git(repo, "add", "--", "scripts");
	await git(repo, "commit", "-qm", "land checks\n\nBead: fixture-checks");
	const commit = join(repo, ".git/hooks/hooks.d/commit-msg");
	mkdirSync(commit);
	for (const [name, file] of [["49-omp-kit-stale-worktree", "check-stale-worktree.sh"], ["47-omp-kit-gap-mention", "check-gap-mention.sh"]]) {
		const path = join(commit, name!);
		writeFileSync(path, readFileSync(join(source, "scripts", file!)));
		chmodSync(path, 0o755);
	}
	const contract = await briefContract(repo, execute);
	const text = renderBrief(contract);
	for (const requirement of ["runFixtureAsync", "ownedTmp", "fixtureDeadlineS", "br-init", "schema-compat", "Supersedes", "GAP_UNFILED", "live scenario coverage", "exports are read-only", "changelog.d/<bead-without-ompkit-prefix>", "commit-preflight.sh --files", "--tests <changed test files>"]) expect(text).toContain(requirement);
	expect(contract.rules.every(rule => rule.member.length > 0 && rule.refuses.length > 0 && rule.compliant.length > 0)).toBe(true);
	expect(contract.installed).toBe(true);
	expect(text.split("\n").at(-1)).toBe(contract.marker);
	// BRIEFSTABLE1 planted: peer working-tree edits to source checks (and new uncommitted ones) leave the digest unchanged; a commit moves it.
	writeFileSync(join(scripts, "check-staged-tempsafe.sh"), "# peer edit in flight\n");
	writeFileSync(join(scripts, "check-staged-new.sh"), "# uncommitted\n");
	expect((await briefContract(repo, execute)).digest).toBe(contract.digest);
	await git(repo, "add", "--", "scripts");
	await git(repo, "commit", "-qm", "change checks\n\nBead: fixture-checks");
	expect((await briefContract(repo, execute)).digest).not.toBe(contract.digest);
});

test("BRIEFSTABLE1 Comply lines come from a member's own remedy text; generic only when none exists", async () => {
	const repo = await fixture(false);
	const chain = join(repo, ".git/hooks/hooks.d/pre-commit");
	mkdirSync(chain, { recursive: true });
	const members = { "60-remedy": "#!/bin/sh\nprintf 'REFUSED: staged files hand-edit generated maps (use bun run gen:maps instead)\\n'\n", "61-fix": "#!/bin/sh\necho \"Fix: add a Sources: line naming the fetched URL\"\n", "62-silent": "#!/bin/sh\n# judges something\nexit 1\n" };
	for (const [name, body] of Object.entries(members)) { writeFileSync(join(chain, name), body); chmodSync(join(chain, name), 0o755); }
	const rules = (await briefContract(repo, execute)).rules;
	expect(rules.find(rule => rule.member.endsWith("60-remedy"))).toMatchObject({ refuses: "staged files hand-edit generated maps", compliant: "use bun run gen:maps instead" });
	expect(rules.find(rule => rule.member.endsWith("61-fix"))?.compliant).toBe("add a Sources: line naming the fetched URL");
	expect(rules.find(rule => rule.member.endsWith("62-silent"))?.compliant).toStartWith(GENERIC_COMPLY);
});

test("build task requires the current repo-bound digest; read-only and ungated controls stay admitted", async () => {
	const repo = await fixture();
	const contract = await briefContract(repo, execute);
	const context = `Repo: ${repo}`;
	const tasks = [{ task: "Implement the requested feature. Do not edit unrelated paths." }];
	expect(await checkTaskBrief({ context, tasks }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context: `${context}\n${renderBrief(contract)}`, tasks }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context, tasks: [{ task: "Read-only: analyze the requested change" }] }, repo, execute)).toBeUndefined();
	// BRIEFSTABLE1: tasks declaring no change are admitted without a marker; a planted build task with a Change section is not.
	expect(await checkTaskBrief({ context, tasks: [{ task: "# Target\nGrade bead X.\n# Change\nNone\n# Acceptance\nverdict" }] }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context, tasks: [{ task: "Verify the release. Change: none." }] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context, tasks: [{ task: "Verify bead X.\nChange: None" }] }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context, tasks: [{ task: "# Change\nFix src/a.ts" }] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context, tasks: [{ agent: "reviewer", task: "Review the implementation" }] }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context, tasks: [{ task: "Analyze the implementation and report findings" }] }, repo, execute)).toBeUndefined();
	const other = await fixture(false);
	expect(await checkTaskBrief({ context: `Repo: ${other}\n${contract.marker}`, tasks }, repo, execute)).toBeUndefined();
	const gatedOther = await fixture();
	expect(await checkTaskBrief({ context: `Repo: ${gatedOther}\n${contract.marker}`, tasks }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context: `Target ${gatedOther}/src/proposed.ts`, tasks }, other, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	const member = join(repo, ".git/hooks/hooks.d/pre-commit/51-omp-kit-staged-kitlib");
	writeFileSync(member, readFileSync(member, "utf8") + "\n# helper.py\n");
	writeFileSync(join(repo, ".git/hooks/hooks.d/pre-commit/helper.py"), "# first checker\n");
	const withHelper = await briefContract(repo, execute);
	writeFileSync(join(repo, ".git/hooks/hooks.d/pre-commit/helper.py"), "# changed checker\n");
	expect(await checkTaskBrief({ context: `${context}\n${withHelper.marker}`, tasks }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
});

test("stale and foreign deletion candidates show real hunks without granting Supersedes; only declared replacements pass", async () => {
	const repo = await fixture(false);
	const sha = await git(repo, "rev-parse", "HEAD");
	const contract = await briefContract(repo, execute);
	const indexBefore = readFileSync(join(repo, ".git/index"));
	writeFileSync(join(repo, "work.txt"), "replacement\nkeep\n");
	utimesSync(join(repo, "work.txt"), new Date(1000), new Date(1000));
	const candidates = await briefCandidates(contract, ["work.txt"], execute);
	expect(candidates).toHaveLength(1);
	expect(candidates[0]?.review).toBe(`review: would revert ${sha} fixture-landed`);
	expect(candidates[0]?.hunk).toContain("-landed feature");
	expect(candidates[0]?.hunk).toContain("+replacement");
	expect(renderBrief(contract, candidates)).not.toMatch(/^Supersedes: /m);
	expect(readFileSync(join(repo, ".git/index"))).toEqual(indexBefore);
	expect(await git(repo, "rev-parse", "HEAD")).toBe(sha);
	// Now exercise native commit admission against the same intentional replacement.
	await git(repo, "add", "--", "work.txt");
	const message = join(repo, "message");
	writeFileSync(message, "replace feature\n\nBead: fixture-replacement\n");
	const refused = await execute("sh", [join(source, "scripts/check-stale-worktree.sh"), message], { cwd: repo, timeout: fixtureDeadlineS() * 1000 });
	expect(refused.code).toBe(1);
	expect(refused.stderr).toContain("STALE_WORKTREE");
	writeFileSync(message, `deliberately replace reviewed feature\n\nBead: fixture-replacement\nSupersedes: ${sha}\n`);
	const admitted = await execute("sh", [join(source, "scripts/check-stale-worktree.sh"), message], { cwd: repo, timeout: fixtureDeadlineS() * 1000 });
	expect(admitted.code).toBe(0);
});

test("pure additions and count-aware moves remain quiet in review", async () => {
	const repo = await fixture(false);
	const contract = await briefContract(repo, execute);
	writeFileSync(join(repo, "work.txt"), "landed feature\nkeep\naddition\n");
	expect(await briefCandidates(contract, ["work.txt"], execute)).toEqual([]);
	writeFileSync(join(repo, "work.txt"), "keep\n");
	writeFileSync(join(repo, "moved.txt"), "landed feature\n");
	expect(await briefCandidates(contract, ["work.txt", "moved.txt"], execute)).toEqual([]);
});

test("brief CLI prints the digest in text and JSON; --paths accepts multiple paths", async () => {
	const repo = await fixture(false);
	writeFileSync(join(repo, "work.txt"), "landed feature\nkeep\naddition\n");
	writeFileSync(join(repo, "another.txt"), "addition\n");
	const result = await execute("bun", ["run", "--no-env-file", "--config=/dev/null", join(source, "src/cli.ts"), "brief", "--repo", repo, "--paths", "work.txt", "another.txt", "--json"], { cwd: source, timeout: fixtureDeadlineS() * 1000 });
	expect(result.code).toBe(0);
	const output = JSON.parse(result.stdout);
	expect(output.data.candidates).toEqual([]);
	expect(output.data.marker).toStartWith(`omp-kit-brief: ${realpathSync(repo)} `);
	expect(output.data.text).toContain(output.data.marker);
});

test("bounded contract parsing handles a long near-miss and rejects oversized evidence", async () => {
	const repo = await fixture(false);
	const context = "repository" + " ".repeat(100_000) + "! not a repo declaration";
	const started = performance.now();
	expect(await checkTaskBrief({ context, tasks: [{ task: "Implement requested feature" }] }, repo, execute)).toBeUndefined();
	console.log(`BRIEFCONTRACT1 ${context.length}-character near-miss: ${(performance.now() - started).toFixed(3)} ms (includes git observations)`);
	expect(await checkTaskBrief({ context: "x".repeat(1_000_001), tasks: [{ task: "Implement feature" }] }, repo, execute)).toContain("inspection limit");
});
