import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRIEF_SCRATCH_CREATE, BRIEF_SCRATCH_RELEASE, BRIEF_SCRATCH_STEP, BRIEF_WINDOW_MINUTES, briefCandidates, briefContract, briefRows, checkTaskBrief, completeTaskBrief, GENERIC_COMPLY, renderBrief } from "../../src/brief.ts";
import type { BriefExec } from "../../src/brief.ts";
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

test("BRIEFSTABLE1 brief derives required rules from installed members and source checks, not repo names; a working-tree edit leaves the digest until committed", async () => {
	const repo = await fixture();
	const scripts = join(repo, "scripts");
	mkdirSync(scripts);
	for (const name of ["check-staged-tempsafe.sh", "check-staged-wallclock.sh", "check-staged-br-init.sh", "fresh-gate.sh"]) writeFileSync(join(scripts, name), readFileSync(join(source, "scripts", name)));
	await git(repo, "add", "--", "scripts");
	await git(repo, "commit", "-qm", "land checks\n\nBead: fixture-checks");
	const commit = join(repo, ".git/hooks/hooks.d/commit-msg");
	mkdirSync(commit);
	for (const [name, file] of [["49-omp-kit-stale-worktree", "check-stale-worktree.sh"]]) {
		const path = join(commit, name!);
		writeFileSync(path, readFileSync(join(source, "scripts", file!)));
		chmodSync(path, 0o755);
	}
	const contract = await briefContract(repo, execute);
	const text = renderBrief(contract);
	for (const requirement of ["runFixtureAsync", "ownedTmp", "fixtureDeadlineS", "br-init", "schema-compat", "Supersedes", "live scenario coverage", "exports are read-only", "changelog.d/<bead-without-ompkit-prefix>", "commit-preflight.sh --files", "--tests affected"]) expect(text).toContain(requirement);
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

test("BRIEFSTABLE1 build task requires the current repo-bound digest; no-change (read-only, Change: None) and ungated controls stay admitted", async () => {
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

/** BRIEFSTABLE1 fixture: a gated repo whose source check lands once per entry, committed `minutesAgo` minutes before now. */
async function landedChecks(minutesAgo: readonly number[]) {
	const repo = await fixture();
	mkdirSync(join(repo, "scripts"));
	const revs: string[] = [];
	for (const [index, minutes] of minutesAgo.entries()) {
		writeFileSync(join(repo, "scripts/check-staged-tempsafe.sh"), `${readFileSync(join(source, "scripts/check-staged-tempsafe.sh"), "utf8")}\n# landing ${index}\n`);
		await git(repo, "add", "--", "scripts");
		const at = new Date(Date.now() - minutes * 60_000).toISOString();
		const landed = await execute("git", ["commit", "-qm", `land check ${index}\n\nBead: fixture-checks`], { cwd: repo, timeout: fixtureDeadlineS() * 1000, env: { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at } });
		expect(landed.code).toBe(0);
		revs.push(await git(repo, "rev-parse", "HEAD"));
	}
	return { repo, revs };
}
const buildTasks = [{ task: "# Change\nFix scripts/check-staged-tempsafe.sh" }];

test("BRIEFSTABLE1 window: a pasted brief survives a peer's working-tree edit and a landing inside the window", async () => {
	const { repo, revs } = await landedChecks([BRIEF_WINDOW_MINUTES * 4, BRIEF_WINDOW_MINUTES * 2, 1]);
	const pasted = await briefContract(repo, execute);
	// A peer edits the referenced script in the working tree after the paste: still admitted.
	writeFileSync(join(repo, "scripts/check-staged-tempsafe.sh"), "# peer edit in flight\n");
	expect(await checkTaskBrief({ context: `Repo: ${repo}\n${renderBrief(pasted)}`, tasks: buildTasks }, repo, execute)).toBeUndefined();
	// The brief taken one landing ago, superseded 1 min ago (inside the window): admitted.
	const previous = await briefContract(repo, execute, { rev: revs[1] });
	expect(previous.marker).not.toBe(pasted.marker);
	expect(await checkTaskBrief({ context: `Repo: ${repo}\n${previous.marker}`, tasks: buildTasks }, repo, execute)).toBeUndefined();
	// The brief superseded 2 windows ago: refused, naming the current digest.
	const stale = await briefContract(repo, execute, { rev: revs[0] });
	const refused = await checkTaskBrief({ context: `Repo: ${repo}\n${stale.marker}`, tasks: buildTasks }, repo, execute);
	expect(refused).toContain("BRIEF_CONTRACT_REFUSED");
	expect(refused).toContain(pasted.marker);
});

test("BRIEFSTABLE1 window: a brief from another kit release or a changed gate contract is refused naming the current digest", async () => {
	const { repo } = await landedChecks([1]);
	const current = await briefContract(repo, execute);
	const older = await briefContract(repo, execute, { kit: "0.2.88" });
	expect(older.marker).not.toBe(current.marker);
	const fromOlder = await checkTaskBrief({ context: `Repo: ${repo}\n${older.marker}`, tasks: buildTasks }, repo, execute);
	expect(fromOlder).toContain("BRIEF_CONTRACT_REFUSED");
	expect(fromOlder).toContain(current.marker);
	const member = join(repo, ".git/hooks/hooks.d/pre-commit/51-omp-kit-staged-kitlib");
	writeFileSync(member, `${readFileSync(member, "utf8")}\n# reinstalled gate\n`);
	const changed = await briefContract(repo, execute);
	const fromChanged = await checkTaskBrief({ context: `Repo: ${repo}\n${current.marker}`, tasks: buildTasks }, repo, execute);
	expect(fromChanged).toContain("BRIEF_CONTRACT_REFUSED");
	expect(fromChanged).toContain(changed.marker);
});

test("BRIEFSTABLE1 window mutant: the old working-tree binding refuses the peer-edit case", async () => {
	const original = readFileSync(join(source, "src/brief.ts"), "utf8");
	const old = original.replace("await inspect(join(repo, rel), `source:${rel}`, readHead);", "await inspect(join(repo, rel), `source:${rel}`, readInstalled);");
	expect(old).not.toBe(original);
	const dir = join(scratch.path, `mutant-${++sequence}`);
	mkdirSync(dir);
	writeFileSync(join(dir, "brief.ts"), old.replaceAll('from "./', `from "${join(source, "src")}/`));
	// Dynamic: the mutant module is generated at test time, so no static specifier exists.
	const mutant = await import(join(dir, "brief.ts")) as { briefContract: typeof briefContract; checkTaskBrief: typeof checkTaskBrief };
	const { repo } = await landedChecks([1]);
	const pasted = await mutant.briefContract(repo, execute);
	writeFileSync(join(repo, "scripts/check-staged-tempsafe.sh"), "# peer edit in flight\n");
	expect(await mutant.checkTaskBrief({ context: `Repo: ${repo}\n${pasted.marker}`, tasks: buildTasks }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
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

/** BRIEFSCOPE1 fixture: every staged check, the fresh gate and the commit-msg/pre-push members the companion installs. */
async function fullyGated() {
	const repo = await fixture();
	mkdirSync(join(repo, "scripts"));
	const sources = ["check-staged-tempsafe.sh", "check-staged-wallclock.sh", "check-staged-br-init.sh", "check-staged-imports.sh", "check-staged-readme.sh", "check-staged-fragments.sh",
		"check-staged-regexploit.sh", "check-staged-pysafe.sh", "check-staged-kitlib.sh", "check-staged-embed.sh", "fresh-gate.sh"];
	for (const name of sources) writeFileSync(join(repo, "scripts", name), readFileSync(join(source, "scripts", name)));
	await git(repo, "add", "--", "scripts");
	await git(repo, "commit", "-qm", "land checks\n\nBead: fixture-checks");
	const install = (kind: string, name: string, file: string) => {
		mkdirSync(join(repo, ".git/hooks/hooks.d", kind), { recursive: true });
		writeFileSync(join(repo, ".git/hooks/hooks.d", kind, name), readFileSync(join(source, "scripts", file)));
		chmodSync(join(repo, ".git/hooks/hooks.d", kind, name), 0o755);
	};
	for (const [index, name] of ["check-staged-imports.sh", "check-staged-readme.sh", "check-staged-fragments.sh", "check-staged-regexploit.sh", "check-staged-pysafe.sh", "check-staged-tempsafe.sh", "check-staged-br-init.sh", "check-staged-wallclock.sh", "check-staged-embed.sh"].entries()) {
		install("pre-commit", `${60 + index}-omp-kit-${name.slice("check-".length, -".sh".length)}`, name);
	}
	install("commit-msg", "40-omp-kit-commit-msg-bead", "commit-msg-bead.sh");
	install("commit-msg", "41-omp-kit-commit-msg-vlevel", "commit-msg-verification-level.sh");
	install("commit-msg", "48-omp-kit-deploy-step", "check-deploy-step.sh");
	install("commit-msg", "49-omp-kit-stale-worktree", "check-stale-worktree.sh");
	install("commit-msg", "55-omp-kit-commit-gate", "check-commit-gate.sh");
	install("pre-push", "30-omp-kit-on-main", "check-pushed-on-main.sh");
	install("pre-push", "41-omp-kit-pushed-vlevel", "pre-push-verification-level.sh");
	install("pre-push", "40-omp-kit-fresh-gate", "fresh-gate.sh");
	return repo;
}

test("BRIEFSCOPE1 a fully gated repo renders at most 15 actionable rows with no empty, duplicate or read-the-member rows", async () => {
	const repo = await fullyGated();
	const contract = await briefContract(repo, execute);
	expect(contract.members.length).toBeGreaterThanOrEqual(25);
	const rows = briefRows(contract);
	console.log(`BRIEFSCOPE1 ${contract.rules.length} rules from ${contract.members.length} members -> ${rows.length} rows`);
	expect(rows.length).toBeLessThanOrEqual(15);
	expect(new Set(rows).size).toBe(rows.length);
	for (const row of rows) {
		expect(row).not.toMatch(/Refuses: [;.]/);
		expect(row).not.toContain(GENERIC_COMPLY);
	}
	// Every requirement the per-member brief taught is still taught.
	const text = renderBrief(contract);
	for (const requirement of ["runFixtureAsync", "ownedTmp", "fixtureDeadlineS", "schema-compat", "Supersedes", "changelog.d/<bead-without-ompkit-prefix>", "commit-preflight.sh --files", "[test], [selftest], [live] or [pending]", "Deploy-Step", "exports are read-only", "shared local main"]) expect(text).toContain(requirement);
	// Planted: the old one-row-per-member renderer exceeds the bound on the same contract.
	expect(contract.rules.length).toBeGreaterThan(15);
});

test("BRIEFSCOPE1 a READ-ONLY context covers its tasks; a Change section, reserved paths or a mid-line mention stay build tasks", async () => {
	const repo = await fixture();
	const build = { task: "# Target\nCount commits per day.\n# Acceptance\nreport" };
	expect(await checkTaskBrief({ context: `Repo: ${repo}\n# Contract\n- READ-ONLY. No edits, no git mutations.`, tasks: [build] }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context: `Repo: ${repo}\nread-only investigation`, tasks: [build] }, repo, execute)).toBeUndefined();
	expect(await checkTaskBrief({ context: `Repo: ${repo}\n- READ-ONLY.`, tasks: [{ task: "# Change\nFix src/a.ts" }] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context: `Repo: ${repo}\n- READ-ONLY.`, tasks: [{ task: "These paths are reserved for you: src/a.ts" }] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	expect(await checkTaskBrief({ context: `Repo: ${repo}\nDo not make the cache read-only.`, tasks: [build] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	// A pasted brief's own prose never declares the call read-only.
	expect(await checkTaskBrief({ context: `Repo: ${repo}\nGate contract: ${repo}\n- read-only exports\nomp-kit-brief: ${repo} ${"0".repeat(64)}`, tasks: [build] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	const nearMiss = `Repo: ${repo}\n${"- ".repeat(50_000)}not read-only`;
	const started = performance.now();
	expect(await checkTaskBrief({ context: nearMiss, tasks: [build] }, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	console.log(`BRIEFSCOPE1 ${nearMiss.length}-character read-only near-miss: ${(performance.now() - started).toFixed(3)} ms (includes git observations)`);
});

test("BRIEFSCOPE1 completion appends exactly the missing contracts, and the completed call passes the same check", async () => {
	const repo = await fixture();
	const other = await fixture();
	const input = { context: `Repo: ${repo}\nRepo: ${other}`, tasks: [{ task: "# Change\nFix work.txt in both checkouts" }] };
	const completion = await completeTaskBrief(input, repo, execute);
	expect(completion.refusal).toBeUndefined();
	expect(completion.repos.sort()).toEqual([realpathSync(repo), realpathSync(other)].sort());
	expect(completion.context).toContain((await briefContract(repo, execute)).marker);
	expect(completion.context).toContain((await briefContract(other, execute)).marker);
	expect(await checkTaskBrief({ ...input, context: completion.context }, repo, execute)).toBeUndefined();
	// Planted: the uncompleted call is still missing its contract.
	expect(await checkTaskBrief(input, repo, execute)).toContain("BRIEF_CONTRACT_REFUSED");
	// Controls: a call that already carries one contract gets only the other; a read-only call gets nothing; limits still refuse.
	const partial = await completeTaskBrief({ ...input, context: `${input.context}\n${renderBrief(await briefContract(repo, execute))}` }, repo, execute);
	expect(partial.repos).toEqual([realpathSync(other)]);
	expect(await completeTaskBrief({ context: `Repo: ${repo}`, tasks: [{ task: "Read-only: count commits" }] }, repo, execute)).toEqual({ repos: [] });
	expect((await completeTaskBrief({ context: "x".repeat(1_000_001), tasks: input.tasks }, repo, execute)).refusal).toContain("inspection limit");
});

test("BRIEFSCRATCHIO1 the brief [scratch] row teaches the passing spellings and no variable-path redirect", async () => {
	// The row keeps the fail-closed create/release forms the PRINTDIRCAP1 tests pin.
	expect(BRIEF_SCRATCH_STEP).toContain(BRIEF_SCRATCH_CREATE);
	expect(BRIEF_SCRATCH_STEP).toContain(BRIEF_SCRATCH_RELEASE);
	// The passing spellings: files via the Python kernel or the edit tool, capability never in a file, release not rm.
	for (const spelling of ["Python kernel", "edit tool", "never in a file", "never `rm -rf`"]) expect(BRIEF_SCRATCH_STEP).toContain(spelling);
	// The denied shape is named as denied: a redirect to a $VAR-built path, with no exemption offered.
	expect(BRIEF_SCRATCH_STEP).toMatch(/Never redirect.*\$VAR/);
	expect(BRIEF_SCRATCH_STEP).toContain("no exemption");
	// Still one row within the brief size budget.
	const repo = await fixture();
	const text = renderBrief(await briefContract(repo, execute));
	expect(text.split("\n").filter((line) => line.startsWith("[scratch]")).length).toBe(1);
	expect(briefRows(await briefContract(repo, execute)).length).toBeLessThanOrEqual(15);
	// Planted negative: the pre-fix row text (fail-closed create/release only) teaches none of the passing spellings.
	const oldStep = `[scratch] Hazard: a refused \`scratch new\` piped through \`jq -r .data.dir\` exports TMPDIR=null and writes ./null outside owned scratch, \`export TMPDIR=$(...) || exit 1\` never exits because export returns 0, and \`--print-dir\` returns no release capability, so a dir made that way outside a seat is left to the reaper. Comply: ${BRIEF_SCRATCH_CREATE}, run inside the owning repo; keep CAP unexported and unprinted; when done: ${BRIEF_SCRATCH_RELEASE}.`;
	for (const spelling of ["Python kernel", "edit tool", "never in a file", "never `rm -rf`", "no exemption"]) expect(oldStep).not.toContain(spelling);
});
