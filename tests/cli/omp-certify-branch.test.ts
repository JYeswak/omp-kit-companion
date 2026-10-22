import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
afterAll(cleanupAllOwnedTmp);

// The prepare job's push step (`id: pr` in .github/workflows/omp-certify.yml), run as written against a local origin.
// Run 38182628254: force-updating a stale omp-certify/<version> branch was refused because the update carried main's
// newer workflow files and GITHUB_TOKEN lacks the workflows permission. The origin's pre-receive hook below applies
// that same rule (an omp-certify/* ref update, or creation off main, that changes .github/workflows is refused), and
// `gh` is a stub that records calls and keeps the open-PR state.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const root = ownedTmp("omp-kit-certify-branch").path;
afterAll(() => rmSync(root, { recursive: true, force: true }));
const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github", "workflows", "omp-certify.yml"), "utf8")) as { jobs: { prepare: { steps: { id?: string; run?: string }[] } } };
const STEP = workflow.jobs.prepare.steps.find(step => step.id === "pr")!.run!;
const BRANCH = "omp-certify/9.9.9";
// Isolated from the operator's git config: no global hooks (the kit's pre-push gate) on these throwaway repos.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

function git(cwd: string, ...args: string[]): string {
	const child = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
	if (child.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${child.stderr.toString()}`);
	return child.stdout.toString().trim();
}
function write(dir: string, files: Record<string, string>) {
	for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
}
const GITHUB_WORKFLOW_RULE = `#!/bin/bash
zero=0000000000000000000000000000000000000000
while read -r old new ref; do
  case "$ref" in refs/heads/omp-certify/*) ;; *) continue ;; esac
  [ "$new" = "$zero" ] && continue
  if [ "$old" = "$zero" ]; then base=$(git rev-parse refs/heads/main); else base=$old; fi
  changed=$(git diff --name-only "$base" "$new" -- .github/workflows)
  if [ -n "$changed" ]; then echo "refusing to allow a GitHub App to create or update workflow $changed without workflows permission" >&2; exit 1; fi
done
`;
const GH_STUB = `#!/bin/bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr list") case " $* " in *" --head "*) [ -f "$GH_STATE/open" ] && cat "$GH_STATE/open" ;; esac ;;
  "pr create") echo 8 > "$GH_STATE/open"; echo "https://github.com/o/r/pull/8" ;;
  "pr close") rm -f "$GH_STATE/open" ;;
esac
exit 0
`;

/** An origin whose omp-certify/9.9.9 branch (open as PR #7) was cut from main; `mainMoved` then changes a workflow on main. */
function scenario(name: string, mainMoved: boolean) {
	const dir = join(root, name), origin = join(dir, "origin.git"), seed = join(dir, "seed"), work = join(dir, "work"), bin = join(dir, "bin"), state = join(dir, "state");
	for (const path of [seed, bin, state]) mkdirSync(path, { recursive: true });
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	writeFileSync(join(origin, "hooks", "pre-receive"), GITHUB_WORKFLOW_RULE);
	chmodSync(join(origin, "hooks", "pre-receive"), 0o755);
	git(seed, "init", "-q", "-b", "main");
	write(seed, { ".github/workflows/release-train.yml": "v1\n", "scripts/omp-compat.json": "{\"certified\":\"9.9.8\"}\n", "src/memory-readiness.ts": "r\n",
		"src/memory-audit.ts": "a\n", "docs/omp-compatibility.md": "t\n", "changelog.d/.keep": "" });
	git(seed, "add", "-A"); git(seed, "commit", "-qm", "M0"); git(seed, "remote", "add", "origin", origin); git(seed, "push", "-q", "origin", "main");
	git(seed, "switch", "-qc", BRANCH);
	write(seed, { "scripts/omp-compat.json": "{\"certified\":\"9.9.9\"}\n" });
	git(seed, "commit", "-qam", "earlier certification"); git(seed, "push", "-q", "origin", BRANCH); git(seed, "switch", "-q", "main");
	if (mainMoved) { write(seed, { ".github/workflows/release-train.yml": "v2\n" }); git(seed, "commit", "-qam", "M1: workflow change"); git(seed, "push", "-q", "origin", "main"); }
	writeFileSync(join(state, "open"), "7\n");
	writeFileSync(join(bin, "gh"), GH_STUB);
	chmodSync(join(bin, "gh"), 0o755);
	git(dir, "clone", "-q", origin, work);
	write(work, { "scripts/omp-compat.json": "{\"certified\":\"9.9.9\"}\n", "src/memory-readiness.ts": "r2\n" });
	const output = join(dir, "github-output");
	const child = Bun.spawnSync(["bash", "-c", STEP], { cwd: work, stdout: "pipe", stderr: "pipe",
		env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, BRANCH, LATEST: "9.9.9", RUN_URL: "https://example.invalid/run", GITHUB_REPOSITORY: "o/r",
			GITHUB_OUTPUT: output, GH_LOG: join(dir, "gh.log"), GH_STATE: state } });
	return { code: child.exitCode, stderr: child.stderr.toString(), origin, main: git(origin, "rev-parse", "main"),
		gh: existsSync(join(dir, "gh.log")) ? readFileSync(join(dir, "gh.log"), "utf8") : "", outputs: existsSync(output) ? readFileSync(output, "utf8") : "" };
}

test("B1: a stale certification branch is recreated from main, its PR closed, instead of force-updated", () => {
	const run = scenario("b1-stale", true);
	expect(run.code, run.stderr).toBe(0);
	expect(run.stderr).not.toContain("refusing to allow");
	expect(git(run.origin, "rev-parse", `${BRANCH}^`)).toBe(run.main);
	expect(git(run.origin, "show", `${BRANCH}:.github/workflows/release-train.yml`)).toBe("v2");
	expect(run.gh).toContain("pr close 7 --repo o/r --comment Branch omp-certify/9.9.9 predates main");
	expect(run.gh).toContain("pr create --repo o/r --base main --head omp-certify/9.9.9");
	expect(run.outputs).toContain("number=8\n");
});

test("B2: a certification branch already on top of main is updated in place and keeps its PR", () => {
	const run = scenario("b2-current", false);
	expect(run.code, run.stderr).toBe(0);
	expect(git(run.origin, "rev-parse", `${BRANCH}^`)).toBe(run.main);
	expect(run.gh).not.toContain("pr close");
	expect(run.gh).not.toContain("pr create");
	expect(run.outputs).toContain("number=7\n");
});
