import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

// NEXTVERSION1 (ompkit-d8qic): shared main always states the version it ships as. A published vX is followed by
// one main commit to the next patch plus the vX CHANGELOG promote; a cut tags an already-green origin commit with
// no bump commit; VERSIONSRC1 version-match still refuses a commit that states the published version.
const ROOT = join(import.meta.dir, "..", "..");
const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
function segment(start: string, end: string): string {
	const first = script.indexOf(start);
	const last = script.indexOf(end, first + start.length);
	if (first < 0 || last < 0) throw new Error(`release-local boundary missing: ${start} / ${end}`);
	return script.slice(first, last + end.length);
}
const helpers = () => segment("bounded() {", "# ---------------------------------------------------------------------------------------------- 1. preflight");
const prelude = `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"; CHILD=''
`;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
type Fixture = { work: string; origin: string; repo: string; git: (cwd: string, ...args: string[]) => string; env: Record<string, string | undefined> };
/** fullTree: the README-checked inputs (src registry, rules, skills, the real package.json) so the staged README hook can judge commits. */
function fixture(label: string, mainVersion: string, fullTree = false): Fixture {
	const work = realpathSync(ownedTmp(label, { root: process.env.TMPDIR ?? join(ROOT, "var", "agent-tmp") }).path);
	const origin = join(work, "origin.git");
	const repo = join(work, "repo");
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
	const git = (cwd: string, ...args: string[]) => {
		const result = runFixture(["git", ...args], { cwd, env, floor_s: 30 });
		if (result.rc !== 0) throw new Error(`git ${args.join(" ")}: ${decode(result.stderr)}`);
		return decode(result.stdout).trim();
	};
	git(work, "init", "-q", "--bare", "-b", "main", origin);
	git(work, "init", "-q", "-b", "main", repo);
	for (const dir of ["scripts", "changelog.d", ".github/workflows"]) mkdirSync(join(repo, dir), { recursive: true });
	for (const name of ["release-notes.sh", "release-notes.ts", "release-train.sh", "stamp-release-line.sh", "kitlib-tmp.sh"])
		copyFileSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
	// README states the latest published release (v1.2.3) while main states the next version.
	writeFileSync(join(repo, "README.md"), readFileSync(join(ROOT, "README.md"), "utf8").replace(/^Current release: v\d+\.\d+\.\d+$/m, "Current release: v1.2.3"));
	const pkg = (version: string) => `{\n  "name": "fixture",\n  "version": "${version}",\n  "omp": {\n    "version": "${version}"\n  }\n}\n`;
	writeFileSync(join(repo, "package.json"), fullTree
		? readFileSync(join(ROOT, "package.json"), "utf8").replace(/^([ \t]*"version": )"[^"\n]*"/gm, `$1"${mainVersion}"`)
		: pkg(mainVersion));
	if (fullTree) for (const path of ["src", "rules", "skills"]) cpSync(join(ROOT, path), join(repo, path), { recursive: true });
	writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-01\n\n### Changed\n\n- Base release.\n");
	writeFileSync(join(repo, "changelog.d/shipped.md"), "### Fixed\n\n- Shipped in the tagged source.\n");
	writeFileSync(join(repo, "scripts/release-signing.json"), '{"schema_version": 1, "darwin_signing": "developer-id"}\n');
	writeFileSync(join(repo, ".github/workflows/release.yml"), "jobs:\n  attest-local:\n    runs-on: ubuntu-latest\n");
	git(repo, "add", "."); git(repo, "commit", "-qm", "fixture base");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
	git(repo, "tag", "v1.2.3"); git(repo, "push", "-q", "origin", "v1.2.3");
	git(repo, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
	const bin = join(work, "bin");
	mkdirSync(bin);
	// The only GitHub read on these paths is the release listing; anything else is a test failure.
	writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$*" in\n\t"api --paginate --slurp "*) echo '[[{"tag_name":"v1.2.3","draft":false,"prerelease":false}]]' ;;\n\t*) echo "unexpected gh $*" >&2; exit 97 ;;\nesac\n`);
	chmodSync(join(bin, "gh"), 0o755);
	// README_GATE: the optional readme-update skill gate is machine state, not part of this contract.
	const runEnv = { ...env, PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: work, README_GATE: join(work, "no-readme-update-gate") };
	return { work, origin, repo, git, env: runEnv };
}

const originMain = (f: Fixture) => f.git(f.origin, "rev-parse", "refs/heads/main");
const showMain = (f: Fixture, path: string) => f.git(f.origin, "show", `refs/heads/main:${path}`);

/**
 * Install the shipped pre-commit README member (scripts/check-staged-readme.sh) as the repo's commit hook, beside the
 * given readme-check source, the way the kit installs it. Every hook run is recorded in `<hooks>/ran`.
 */
function installReadmeHook(f: Fixture, name: string, readmeCheck: string): string {
	const hooks = join(f.work, name);
	mkdirSync(hooks);
	for (const file of ["check-staged-readme.sh", "kitlib-tmp.sh"]) copyFileSync(join(ROOT, "scripts", file), join(hooks, file));
	writeFileSync(join(hooks, "readme-check.ts"), readmeCheck);
	writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho ran >>"${join(hooks, "ran")}"\nexec sh "${join(hooks, "check-staged-readme.sh")}"\n`);
	chmodSync(join(hooks, "pre-commit"), 0o755);
	f.git(f.repo, "config", "core.hooksPath", hooks);
	return hooks;
}
const readmeCheckSource = readFileSync(join(ROOT, "scripts/readme-check.ts"), "utf8");

// git_converge.py publishes when origin moved; the tests use the same default the script does.
const CONVERGE = process.env.OMP_KIT_GIT_CONVERGE ?? join(homedir(), "Developer/omp-kit/scripts/git_converge.py");
function advance(f: Fixture, source: string, installed: 0 | 1) {
	// advance_next_version is defined after the dry-run exit, so no GitHub write is reachable before it.
	const body = `${prelude}${helpers()}\n${segment("# NEXTVERSION1 (ompkit-d8qic", "\n}\n")}\nVERSION=1.2.4; SOURCE=${source}; INSTALLED=${installed}; INSTALL_PREFIX=/fixture/kit\nadvance_next_version\n`;
	writeFileSync(join(f.work, "advance.sh"), body);
	return runFixture(["bash", join(f.work, "advance.sh"), f.repo, f.work], { cwd: f.repo, env: { ...f.env, OMP_KIT_GIT_CONVERGE: CONVERGE }, floor_s: 180 });
}

function publishedFixture(label: string) {
	const f = fixture(label, "1.2.4", true);
	const source = f.git(f.repo, "rev-parse", "HEAD");
	// The tag stage of the run publishes v1.2.4 before the next-version step.
	f.git(f.repo, "tag", "v1.2.4", source); f.git(f.repo, "push", "-q", "origin", "v1.2.4");
	// Work that landed after the tagged source keeps its fragment for the next release.
	writeFileSync(join(f.repo, "changelog.d/later.md"), "### Added\n\n- Landed after the tag.\n");
	f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "later work"); f.git(f.repo, "push", "-q", "origin", "main");
	return { f, source, before: originMain(f) };
}

test("AC1: after vX publishes and installs, one shared-main commit in the checkout sets the next patch, stamps README vX and passes the installed README hook", () => {
	const { f, source, before } = publishedFixture("nextversion-ac1");
	const hooks = installReadmeHook(f, "hooks-installed", readmeCheckSource);
	const result = advance(f, source, 1);
	expect(result.rc, decode(result.stderr)).toBe(0);
	// The commit is the fixture checkout's own main, not a detached side tree.
	expect(f.git(f.repo, "rev-parse", "refs/heads/main")).toBe(originMain(f));
	expect(f.git(f.repo, "status", "--porcelain")).toBe("");
	expect(f.git(f.repo, "worktree", "list", "--porcelain").split("\n").filter(line => line.startsWith("worktree "))).toEqual([`worktree ${f.repo}`]);
	expect(readFileSync(join(hooks, "ran"), "utf8")).toBe("ran\n");
	const after = originMain(f);
	expect(f.git(f.origin, "rev-list", "--count", `${before}..${after}`)).toBe("1");
	expect(f.git(f.origin, "rev-parse", `${after}^`)).toBe(before);
	const pkg = JSON.parse(showMain(f, "package.json"));
	expect([pkg.version, pkg.omp.version]).toEqual(["1.2.5", "1.2.5"]);
	const changelog = showMain(f, "CHANGELOG.md");
	const section = changelog.slice(changelog.indexOf("## [1.2.4] - "), changelog.indexOf("## [1.2.3]"));
	expect(section).toContain("Shipped in the tagged source.");
	expect(changelog).not.toContain("Landed after the tag.");
	const files = f.git(f.origin, "ls-tree", "-r", "--name-only", "refs/heads/main", "--", "changelog.d");
	expect(files.split("\n")).toEqual(["changelog.d/later.md"]);
	expect(f.git(f.origin, "log", "-1", "--format=%B", after)).toContain("Bead: ompkit-d8qic");
	// README states v1.2.4, the release just published, beside package.json 1.2.5.
	expect(showMain(f, "README.md")).toContain("\nCurrent release: v1.2.4\n");
	expect(existsSync(join(f.work, "next"))).toBe(false);
}, fixtureDeadlineS(180) * 1_000);

test("AC1 planted old hook: a previously installed readme-check refuses the commit, main is unchanged and the error names the install", () => {
	const { f, source, before } = publishedFixture("nextversion-ac1-oldhook");
	// The pre-NEXTVERSION1 rule: the README line must equal package.json.
	const oldCheck = readmeCheckSource.replace("if (stated === undefined || releaseVersion !==", "if (stated !== undefined || releaseVersion !==");
	expect(oldCheck).not.toBe(readmeCheckSource);
	const hooks = installReadmeHook(f, "hooks-old", oldCheck);
	const result = advance(f, source, 0);
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(readFileSync(join(hooks, "ran"), "utf8")).toBe("ran\n");
	expect(stderr).toContain("staged-readme: REFUSED");
	expect(stderr).toContain("release line says `Current release: v1.2.4` but package.json is 1.2.5");
	expect(stderr).toContain("v1.2.4 is published but not installed (--no-install)");
	expect(stderr).toContain("Install it with: /fixture/kit/bin/omp-kit update --apply --yes --version 1.2.4");
	expect(originMain(f)).toBe(before);
	// Its own bytes are put back; the checkout is as it was.
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	expect(f.git(f.repo, "status", "--porcelain")).toBe("");
}, fixtureDeadlineS(180) * 1_000);

test("planted dirty path: a modified README refuses NEXT_VERSION_PATHS_DIRTY, writes nothing and leaves main unchanged", () => {
	const { f, source, before } = publishedFixture("nextversion-dirty");
	installReadmeHook(f, "hooks-installed", readmeCheckSource);
	const readme = `${readFileSync(join(f.repo, "README.md"), "utf8")}peer edit\n`;
	writeFileSync(join(f.repo, "README.md"), readme);
	const pkgBefore = readFileSync(join(f.repo, "package.json"), "utf8");
	const result = advance(f, source, 1);
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("NEXT_VERSION_PATHS_DIRTY:  M README.md;");
	expect(stderr).toContain("make the commit by hand on main");
	expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe(readme);
	expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(pkgBefore);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	expect(originMain(f)).toBe(before);
}, fixtureDeadlineS(180) * 1_000);

test.skipIf(!existsSync(CONVERGE))("planted origin move: a peer push during the release is converged, and main holds both commits", () => {
	const { f, source } = publishedFixture("nextversion-converge");
	installReadmeHook(f, "hooks-installed", readmeCheckSource);
	// A peer publishes to origin after this checkout last fetched.
	const peer = join(f.work, "peer");
	f.git(f.work, "clone", "-q", f.origin, peer);
	writeFileSync(join(peer, "peer.txt"), "peer work\n");
	f.git(peer, "add", "peer.txt"); f.git(peer, "commit", "-qm", "peer work"); f.git(peer, "push", "-q", "origin", "main");
	const peerSha = f.git(peer, "rev-parse", "HEAD");
	const result = advance(f, source, 1);
	expect(result.rc, decode(result.stderr)).toBe(0);
	const main = originMain(f);
	expect(f.git(f.origin, "merge-base", "--is-ancestor", peerSha, main)).toBe("");
	expect(f.git(f.origin, "log", "--format=%s", main)).toContain("chore(release): next version 1.2.5 after v1.2.4 ompkit-d8qic");
	expect(JSON.parse(showMain(f, "package.json")).version).toBe("1.2.5");
	expect(showMain(f, "peer.txt")).toBe("peer work");
	expect(f.git(f.repo, "rev-parse", "refs/heads/main")).toBe(main);
}, fixtureDeadlineS(240) * 1_000);

test("release-local.sh creates no git worktree (AGENTS.md: no branches, no worktrees)", () => {
	expect(script).not.toContain("git worktree");
	expect(script).not.toMatch(/(?<![-\w])worktree (?:add|remove|prune|list|move|lock|unlock|repair)\b/);
});

test("AC1 planted failure: a run refused at the tag stage commits nothing and leaves package.json and main unchanged", () => {
	const f = fixture("nextversion-ac1-fail", "1.2.4");
	writeFileSync(join(f.origin, "hooks/pre-receive"), "#!/bin/sh\nwhile read -r old new ref; do case \"$ref\" in refs/tags/*) echo 'fixture: tag refused' >&2; exit 1 ;; esac; done\n");
	chmodSync(join(f.origin, "hooks/pre-receive"), 0o755);
	const source = f.git(f.repo, "rev-parse", "HEAD");
	const before = originMain(f);
	const pkgBefore = readFileSync(join(f.repo, "package.json"), "utf8");
	// The real tail of the run, from the next-version definition and VERSIONSRC1 tag gate through its post-publish call.
	const tail = segment("# NEXTVERSION1 (ompkit-d8qic", "\nadvance_next_version\n");
	expect(tail).toContain("# VERSIONSRC1 (ompkit-fp72.135.1.14)");
	const body = `${prelude}${helpers()}\nVERSION=1.2.4; SOURCE=${source}; REPO=fixture/release; DIST="$WORK/dist"\n${tail}`;
	writeFileSync(join(f.work, "tail.sh"), body);
	const result = runFixture(["bash", join(f.work, "tail.sh"), f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 60 });
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("tag push failed");
	expect(originMain(f)).toBe(before);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(source);
	expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(pkgBefore);
	// Order contract: the next-version commit follows the public verify stage and the install stage, so the
	// just-installed hooks judge it.
	const verify = script.indexOf("stage verify\n");
	const call = script.indexOf("\nadvance_next_version\n");
	expect(verify).toBeGreaterThan(script.indexOf("stage tag\n"));
	expect(call).toBeGreaterThan(script.indexOf("verify.gatekeeper", verify));
	expect(call).toBeGreaterThan(script.indexOf('if [ "$INSTALL" = 1 ]; then install_release; fi'));
}, fixtureDeadlineS(120) * 1_000);

const preflight = () => segment('PREPARE=0\nif [ -z "$SOURCE" ]; then PREPARE=1', 'say "source $SOURCE (origin/main $MAIN) version $VERSION base $BASE_TAG mode $MODE"');
function runPreflight(f: Fixture, version: string, source: string) {
	const body = `${prelude}${helpers()}\nREPO=fixture/release; NEXT=0; VERSION='${version}'; SOURCE='${source}'\nMAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"\n${preflight()}\n`;
	writeFileSync(join(f.work, "preflight.sh"), body);
	return runFixture(["bash", join(f.work, "preflight.sh"), f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 60 });
}

test("AC2: a green origin commit that states the next version is cut as is, with no new commit", () => {
	const f = fixture("nextversion-ac2", "1.2.4");
	// RELCARD1 (ompkit-fp72.120.16.254): the preflight judges the exact source's release card before the keychain.
	mkdirSync(join(f.repo, "docs/releases"), { recursive: true });
	for (const name of ["release-card-check.py", "pysafe.py"]) copyFileSync(join(ROOT, "scripts", name), join(f.repo, "scripts", name));
	// RELRUBRIC3: v1.2.4 is above the evidence-class gate; this deterministic fixture proves only the mechanism.
	writeFileSync(join(f.repo, "docs/releases/v1.2.4.md"), "# Release card: v1.2.4\n\n## 1. Gap lane\n\n| Bead | Defect | State |\n|---|---|---|\n| fixture-1 | a fixture defect | closed |\n\n## 2. Optimization lane\n\n| # | Idea | Measure | Evidence | Decision |\n|---|---|---|---|---|\n| 1 | FIXIDEA1 a fixture idea | a measure | a profile | MECHANISM VERIFIED: 10 s → 5 s |\n\n### Prereg FIXIDEA1\n\nendpoint: fixture_s\ndirection: lower\nproducer: a fixture command\nunit: s\nmde: 1 s\nmde_source: fixture\nsigma_d: 0\nsigma_source: deterministic fixture count\nalpha: 0.05\npower: 0.80\nn_pairs: 1\nstopping: fixed-n\ncontrol: paired, same host\n\n### Result FIXIDEA1\n\nncpu: 8\n\n| Pair | before | after | load1_before | load1_after |\n|---|---|---|---|---|\n| 1 | 10 | 5 | 1.0 | 1.0 |\n\n## 3. Measures\n\n| Measure | Before | After |\n|---|---|---|\n| Change lead time | 66 min | |\n\n## 4. Error budget\n\nWithin budget.\n");
	f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "release card");
	f.git(f.repo, "push", "-q", "origin", "main");
	f.git(f.repo, "fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main");
	const main = originMain(f);
	const result = runPreflight(f, "", "");
	expect(result.rc, decode(result.stderr)).toBe(0);
	expect(decode(result.stdout)).toContain(`source ${main} (origin/main ${main}) version 1.2.4 base v1.2.3`);
	expect(decode(result.stdout)).toContain(`== RELEASE_CARD_OK docs/releases/v1.2.4.md at ${main}`);
	expect(decode(result.stdout)).toContain("FIXIDEA1 MECHANISM VERIFIED (n=1, mean d 5 s, s_d 0 s, mde 1 s)");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(main);
	expect(originMain(f)).toBe(main);
	// The explicit --source form reaches the same cut.
	const explicit = runPreflight(f, "1.2.4", main);
	expect(explicit.rc, decode(explicit.stderr)).toBe(0);
	expect(decode(explicit.stdout)).toContain("FIXIDEA1 MECHANISM VERIFIED (n=1, mean d 5 s, s_d 0 s, mde 1 s)");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(main);
}, fixtureDeadlineS(120) * 1_000);

test("AC2 planted refusal: a commit stating the published version is still refused by version-match", () => {
	const f = fixture("nextversion-ac2-refuse", "1.2.3");
	const main = originMain(f);
	const result = runPreflight(f, "1.2.4", main);
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("version-match: package.json states 1.2.3 / omp 1.2.3, not v1.2.4");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(main);
	expect(originMain(f)).toBe(main);
}, fixtureDeadlineS(120) * 1_000);
