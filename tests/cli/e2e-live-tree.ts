import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { ownedTmp } from "../../src/kitlib/tmp";
import { run } from "../../src/kitlib/run";
import { fixtureDeadlineS } from "./fixture-process.ts";

// Shared by the e2e-live suites that run the real scripts/e2e-live.sh (tests/cli/e2e-signal.test.ts, e2e-ttsr-retry.test.ts).

export const REPO_ROOT = resolve(import.meta.dir, "../..");

/** A caller work root e2e-live.sh admits: under this tree's var/agent-tmp, with an .owner naming the tree. TMPDIR
 * is not used: a gitless grader export has its own var/agent-tmp (absent until created) and TMPDIR may lie elsewhere
 * or behind a symlink (macOS /var), both of which runtime-adapter.sh correctly refuses. */
export function workRoot(label: string) {
	const root = join(REPO_ROOT, "var/agent-tmp");
	mkdirSync(root, { recursive: true });
	return ownedTmp(label, { root });
}

/** The tree whose scripts/e2e-live.sh a LIVEEVAL1 case runs. runtime-adapter.sh runs Bun scripts only from a packaged
 * tree (bin/omp-kit) or a source checkout (.git); a gitless grader export is neither, and that refusal stays. There the
 * case runs a git-initialized copy of these same bytes inside its owned fixture, so the adapter sees a real checkout;
 * the caller workspace (OMP_KIT_CASE_CWD) and its work-root ownership checks are still this tree's. */
export async function liveTree(fixture: string): Promise<string> {
	if (existsSync(join(REPO_ROOT, ".git"))) return REPO_ROOT;
	const tree = join(fixture, "tree");
	mkdirSync(tree);
	// Entry by entry: the fixture lies under this tree's var/, and cpSync refuses a destination inside its source.
	for (const entry of readdirSync(REPO_ROOT)) {
		if (entry !== "var" && entry !== "node_modules" && entry !== ".git")
			cpSync(join(REPO_ROOT, entry), join(tree, entry), { recursive: true, verbatimSymlinks: true });
	}
	const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("GIT_") && entry[1] !== undefined));
	const init = await run(["git", "init", "-q", tree], { env, deadline_s: fixtureDeadlineS(30) });
	if (init.rc !== 0) throw new Error(`git init ${tree}: ${Buffer.from(init.stderr).toString()}`);
	return tree;
}
