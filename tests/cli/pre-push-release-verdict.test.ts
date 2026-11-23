// Coverage: scripts/release-verdict-start.py, scripts/pre-push-gate.sh.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// AUTOCUTVERDICT1 (ompkit-hbt6q): the detached release qualification child shared by the pre-push hook member and by omp land.
// It waits the quiet interval, fetches origin/main, runs scripts/release-verdict.sh only when the settled head is still the
// scheduled sha, and logs why otherwise. The suite is a stub, the quiet interval is 0, and the repository is a local fixture.
afterAll(cleanupAllOwnedTmp);
const REPO_ROOT = resolve(import.meta.dir, "../..");

function git(repo: string, args: string[]): string {
	const result = runSync(["git", "-C", repo, "-c", "user.name=AUTOCUTVERDICT1 test", "-c", "user.email=autocutverdict1@example.invalid", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { deadline_s: fixtureDeadlineS(20) });
	if (result.rc !== 0) throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(result.stderr).toString()}`);
	return Buffer.from(result.stdout).toString().trim();
}

function fixture(): { work: string; sha: string; marker: string; log: string } {
	const dir = ownedTmp("pre-push-release-verdict").path;
	const origin = join(dir, "origin.git");
	const work = join(dir, "work");
	git(dir, ["init", "-q", "--bare", "-b", "main", origin]);
	git(dir, ["init", "-q", "-b", "main", work]);
	mkdirSync(join(work, "scripts"), { recursive: true });
	mkdirSync(join(work, "src"), { recursive: true });
	for (const name of ["release-verdict-start.py", "kitlib_run.py", "pysafe.py"]) copyFileSync(join(REPO_ROOT, "scripts", name), join(work, "scripts", name));
	const marker = join(dir, "verdict-argv.txt");
	writeFileSync(join(work, "scripts/release-verdict.sh"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(marker)}\necho "stub verdict ran"\nexit 0\n`);
	writeFileSync(join(work, "src/release-ready.ts"), 'console.log("stub release-ready");\n');
	git(work, ["add", "-A"]);
	git(work, ["commit", "-q", "-m", "fixture head"]);
	git(work, ["remote", "add", "origin", origin]);
	git(work, ["push", "-q", "origin", "main"]);
	return { work, sha: git(work, ["rev-parse", "HEAD"]), marker, log: join(dir, "release-verdict.log") };
}

/** Start the child the way both callers do: output to a log file, so no pipe stays open for the detached child. */
function start(work: string, sha: string, log: string, quiet: string): number {
	const result = runSync(["sh", "-c", '"$1" "$2" "$3" </dev/null >>"$4" 2>&1', "sh", join(work, "scripts/release-verdict-start.py"), work, sha, log], {
		env: { ...process.env, OMP_KIT_RELEASE_VERDICT_QUIET_S: quiet } as Record<string, string>,
		deadline_s: fixtureDeadlineS(30),
	});
	return result.rc ?? -1;
}

// The child is a detached session of its own, so no handle exists to await: its log is the only completion signal, and
// deterministic time control cannot drive another process. The wait is bounded by the fixture deadline and exits on the
// condition, never on a guessed duration.
async function logContains(log: string, text: string): Promise<boolean> {
	const deadline = Date.now() + fixtureDeadlineS(30) * 1000;
	while (Date.now() < deadline) {
		if (existsSync(log) && readFileSync(log, "utf8").includes(text)) return true;
		await Bun.sleep(100);
	}
	return false;
}

test("AUTOCUTVERDICT1: the child runs the release verdict for the settled head and says it finished", async () => {
	const { work, sha, marker, log } = fixture();
	expect(start(work, sha, log, "0")).toBe(0);
	expect(await logContains(log, `qualification finished for ${sha} rc=0`)).toBe(true);
	expect(readFileSync(log, "utf8")).toContain(`quiet interval 0s for ${sha}`);
	expect(readFileSync(marker, "utf8")).toBe(`--commit\n${sha}\n--no-fetch\n`);
}, fixtureDeadlineS(60) * 1000);

test("AUTOCUTVERDICT1 planted: a head that moved on is superseded, logged, and no verdict runs for the old sha", async () => {
	const { work, sha, marker, log } = fixture();
	writeFileSync(join(work, "newer.txt"), "newer\n");
	git(work, ["add", "newer.txt"]);
	git(work, ["commit", "-q", "-m", "newer head"]);
	git(work, ["push", "-q", "origin", "main"]);
	const newer = git(work, ["rev-parse", "HEAD"]);
	expect(start(work, sha, log, "0")).toBe(0);
	expect(await logContains(log, `${sha} superseded by ${newer}`)).toBe(true);
	expect(existsSync(marker)).toBe(false);
}, fixtureDeadlineS(60) * 1000);

test("AUTOCUTVERDICT1 planted: a quiet interval outside 0..86400 is refused before anything forks", () => {
	const { work, sha, marker, log } = fixture();
	expect(start(work, sha, log, "90000")).not.toBe(0);
	expect(readFileSync(log, "utf8")).toContain("quiet interval must be 0..86400 seconds");
	expect(existsSync(marker)).toBe(false);
});
