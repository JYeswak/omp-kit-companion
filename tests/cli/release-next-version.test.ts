import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
function fixture(label: string, mainVersion: string): Fixture {
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
	for (const name of ["release-notes.sh", "release-notes.ts", "release-train.sh"]) copyFileSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
	const pkg = (version: string) => `{\n  "name": "fixture",\n  "version": "${version}",\n  "omp": {\n    "version": "${version}"\n  }\n}\n`;
	writeFileSync(join(repo, "package.json"), pkg(mainVersion));
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
	const runEnv = { ...env, PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: work };
	return { work, origin, repo, git, env: runEnv };
}

const originMain = (f: Fixture) => f.git(f.origin, "rev-parse", "refs/heads/main");
const showMain = (f: Fixture, path: string) => f.git(f.origin, "show", `refs/heads/main:${path}`);

test("AC1: after vX publishes, one main commit sets the next patch and promotes only the source's fragments", () => {
	const f = fixture("nextversion-ac1", "1.2.4");
	const source = f.git(f.repo, "rev-parse", "HEAD");
	// Work that landed after the tagged source keeps its fragment for the next release.
	writeFileSync(join(f.repo, "changelog.d/later.md"), "### Added\n\n- Landed after the tag.\n");
	f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "later work"); f.git(f.repo, "push", "-q", "origin", "main");
	const before = originMain(f);
	// advance_next_version is defined after the dry-run exit, so no GitHub write is reachable before it.
	const body = `${prelude}${helpers()}\n${segment("# NEXTVERSION1 (ompkit-d8qic", "\n}\n")}\nVERSION=1.2.4; SOURCE=${source}\nadvance_next_version\n`;
	writeFileSync(join(f.work, "advance.sh"), body);
	const result = runFixture(["bash", join(f.work, "advance.sh"), f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 60 });
	expect(result.rc, decode(result.stderr)).toBe(0);
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
	expect(existsSync(join(f.work, "next"))).toBe(false);
}, fixtureDeadlineS(120) * 1_000);

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
	// Order contract: the next-version commit follows the public verify stage and precedes install.
	const verify = script.indexOf("stage verify\n");
	const call = script.indexOf("\nadvance_next_version\n");
	expect(verify).toBeGreaterThan(script.indexOf("stage tag\n"));
	expect(call).toBeGreaterThan(script.indexOf("verify.gatekeeper", verify));
	expect(call).toBeLessThan(script.indexOf('if [ "$INSTALL" = 1 ]; then install_release; fi'));
}, fixtureDeadlineS(120) * 1_000);

const preflight = () => segment('PREPARE=0\nif [ -z "$SOURCE" ]; then PREPARE=1', 'say "source $SOURCE (origin/main $MAIN) version $VERSION base $BASE_TAG mode $MODE"');
function runPreflight(f: Fixture, version: string, source: string) {
	const body = `${prelude}${helpers()}\nREPO=fixture/release; NEXT=0; VERSION='${version}'; SOURCE='${source}'\nMAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"\n${preflight()}\n`;
	writeFileSync(join(f.work, "preflight.sh"), body);
	return runFixture(["bash", join(f.work, "preflight.sh"), f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 60 });
}

test("AC2: a green origin commit that states the next version is cut as is, with no new commit", () => {
	const f = fixture("nextversion-ac2", "1.2.4");
	const main = originMain(f);
	const result = runPreflight(f, "", "");
	expect(result.rc, decode(result.stderr)).toBe(0);
	expect(decode(result.stdout)).toContain(`source ${main} (origin/main ${main}) version 1.2.4 base v1.2.3`);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(main);
	expect(originMain(f)).toBe(main);
	// The explicit --source form reaches the same cut.
	const explicit = runPreflight(f, "1.2.4", main);
	expect(explicit.rc, decode(explicit.stderr)).toBe(0);
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
