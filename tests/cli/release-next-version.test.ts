import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { CONVERGE, ROOT, advance, advanceOnly, decode, fixture, helpers, installReadmeHook, originMain, prelude, publishEvidence, publishedFixture, readmeCheckSource, segment, showMain } from "./release-fixture.ts";
import type { Fixture } from "./release-fixture.ts";
afterAll(cleanupAllOwnedTmp);

// NEXTVERSION1 (ompkit-d8qic): see ./release-fixture.ts for the shared published-release fixture.

test("advance-only makes the same single advance commit as the full release stage and reruns ADVANCE_ALREADY_DONE", () => {
	const baseline = publishedFixture("advance-only-full", true);
	const resumed = publishedFixture("advance-only-resume", true);
	publishEvidence(resumed.f);
	for (const f of [baseline.f, resumed.f]) {
		const hooks = installReadmeHook(f, "hooks-installed", readmeCheckSource);
		copyFileSync(join(ROOT, "scripts/check-stale-worktree.sh"), join(hooks, "check-stale-worktree.sh"));
		writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\nexec sh "${join(hooks, "check-stale-worktree.sh")}" "$1"\n`);
		chmodSync(join(hooks, "commit-msg"), 0o755);
		f.env.GIT_AUTHOR_DATE = "2026-11-06T00:00:00Z";
		f.env.GIT_COMMITTER_DATE = "2026-11-06T00:00:00Z";
	}
	const full = advance(baseline.f, baseline.source, 1);
	expect(full.rc, decode(full.stdout) + decode(full.stderr)).toBe(0);
	const result = advanceOnly(resumed.f);
	expect(result.rc, decode(result.stderr)).toBe(0);
	const after = originMain(resumed.f);
	expect(resumed.f.git(resumed.f.origin, "rev-list", "--count", `${resumed.before}..${after}`)).toBe("1");
	expect(resumed.f.git(resumed.f.origin, "show", "--format=", after)).toBe(baseline.f.git(baseline.f.origin, "show", "--format=", originMain(baseline.f)));
	expect(JSON.parse(showMain(resumed.f, "package.json")).version).toBe("1.2.5");
	expect(showMain(resumed.f, "README.md")).toContain("\nCurrent release: v1.2.4\n");
	expect(showMain(resumed.f, "CHANGELOG.md")).toContain("Shipped in the tagged source.");
	expect(resumed.f.git(resumed.f.origin, "ls-tree", "-r", "--name-only", "main", "--", "changelog.d")).toBe("changelog.d/later.md");
	expect(resumed.f.git(resumed.f.origin, "log", "-1", "--format=%B")).toContain(`Supersedes: ${resumed.source}`);
	const rerun = advanceOnly(resumed.f);
	expect(rerun.rc, decode(rerun.stderr)).toBe(0);
	expect(decode(rerun.stdout)).toContain("ADVANCE_ALREADY_DONE");
	expect(originMain(resumed.f)).toBe(after);
	expect(resumed.f.git(resumed.f.repo, "diff", "--", "package.json", "README.md", "CHANGELOG.md", "changelog.d")).toBe("");
}, fixtureDeadlineS(120) * 1_000);

test("advance-only unpublished tag or missing release asset or attestation refuses without metadata or ref writes", () => {
	for (const missing of ["tag", "release", "linux-asset", "attestation"]) {
		const { f, before } = publishedFixture(`advance-only-unpublished-${missing}`);
		publishEvidence(f, missing === "linux-asset" ? "omp-kit-v1.2.4-linux-x64-gnu.tar.gz" : "");
		if (missing === "tag") f.git(f.repo, "push", "-q", "origin", ":refs/tags/v1.2.4");
		if (missing === "release") writeFileSync(join(f.work, "release.json"), '{"tagName":"v1.2.4","isDraft":true,"assets":[]}');
		if (missing === "attestation") {
			writeFileSync(join(f.work, "bin/gh"), `#!/bin/sh\ncase "$*" in "release view "*) cat "${join(f.work, "release.json")}" ;; *) echo '{"attestations":[]}' ;; esac\n`);
		}
		const refs = f.git(f.repo, "show-ref");
		const status = f.git(f.repo, "status", "--porcelain");
		const result = advanceOnly(f, missing === "tag" ? "1.2.9" : "1.2.4");
		expect(result.rc, `${missing}: ${decode(result.stdout)}${decode(result.stderr)}`).toBe(4);
		expect(decode(result.stderr)).toContain("ADVANCE_ONLY_NOT_PUBLISHED");
		expect(f.git(f.repo, "show-ref")).toBe(refs);
		// The helper copies only the untracked entrypoint before invoking it.
		expect(f.git(f.repo, "status", "--porcelain").replace("?? scripts/release-local.sh", "").trim()).toBe(status);
		expect(originMain(f)).toBe(before);
		expect(JSON.parse(showMain(f, "package.json")).version).toBe("1.2.4");
	}
}, fixtureDeadlineS(120) * 1_000);

test("advance-only dirty path names only the resume command and leaves peer bytes unchanged", () => {
	const { f, before } = publishedFixture("advance-only-dirty");
	publishEvidence(f);
	const readme = `${readFileSync(join(f.repo, "README.md"), "utf8")}peer edit\n`;
	writeFileSync(join(f.repo, "README.md"), readme);
	const result = advanceOnly(f);
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("NEXT_VERSION_PATHS_DIRTY");
	expect(stderr).toContain("release-local --advance-only --version 1.2.4");
	expect(stderr).not.toContain("make the commit by hand");
	expect(stderr).not.toContain("promote --version");
	expect(readFileSync(join(f.repo, "README.md"), "utf8")).toBe(readme);
	expect(originMain(f)).toBe(before);
}, fixtureDeadlineS(120) * 1_000);

test("advance-only commit refusal reports the actual member rather than inventing an older README cause", () => {
	const { f, before } = publishedFixture("advance-only-hook");
	publishEvidence(f);
	const hooks = join(f.work, "refusing-hooks");
	mkdirSync(hooks);
	writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'fixture-stale-member: REFUSED planted' >&2\nexit 1\n");
	chmodSync(join(hooks, "pre-commit"), 0o755);
	f.git(f.repo, "config", "core.hooksPath", hooks);
	const result = advanceOnly(f);
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("fixture-stale-member: REFUSED planted");
	expect(stderr).toContain("release-local --advance-only --version 1.2.4");
	expect(stderr).not.toContain("an older readme-check");
	expect(originMain(f)).toBe(before);
	expect(f.git(f.repo, "diff", "--", "package.json", "README.md", "CHANGELOG.md", "changelog.d")).toBe("");
}, fixtureDeadlineS(120) * 1_000);

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

test("AC1 planted old hook: its real README refusal is preserved, main stays unchanged and recovery uses advance-only", () => {
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
	expect(stderr).not.toContain("make the commit by hand on main");
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
	// RELADVANCE1: the commit-msg verification-level member refuses a subject with no proof level.
	expect(f.git(f.origin, "log", "--format=%s", main)).toMatch(/chore\(release\): next version 1\.2\.5 after v1\.2\.4 ompkit-d8qic \[(pending|selftest|test|mutation|oracle|live)\]/);
	expect(JSON.parse(showMain(f, "package.json")).version).toBe("1.2.5");
	expect(showMain(f, "peer.txt")).toBe("peer work");
	expect(f.git(f.repo, "rev-parse", "refs/heads/main")).toBe(main);
}, fixtureDeadlineS(240) * 1_000);


test("AC1 planted failure: a run refused at the tag stage commits nothing and leaves package.json and main unchanged", () => {
	const f = fixture("nextversion-ac1-fail", "1.2.4");
	writeFileSync(join(f.origin, "hooks/pre-receive"), "#!/bin/sh\nwhile read -r old new ref; do case \"$ref\" in refs/tags/*) echo 'fixture: tag refused' >&2; exit 1 ;; esac; done\n");
	chmodSync(join(f.origin, "hooks/pre-receive"), 0o755);
	const source = f.git(f.repo, "rev-parse", "HEAD");
	const before = originMain(f);
	const pkgBefore = readFileSync(join(f.repo, "package.json"), "utf8");
	// The real tail of the run, from the next-version definition and VERSIONSRC1 tag gate through its post-publish call.
	const tail = segment("# NEXTVERSION1 (ompkit-d8qic", "\nadvance_next_version\n");
	const body = `${prelude}${helpers()}\nVERSION=1.2.4; SOURCE=${source}; REPO=fixture/release; DIST="$WORK/dist"\n${tail}`;
	writeFileSync(join(f.work, "tail.sh"), body);
	const result = runFixture(["bash", join(f.work, "tail.sh"), f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 60 });
	const stderr = decode(result.stderr);
	expect(result.rc, stderr).toBe(4);
	expect(stderr).toContain("tag push failed");
	expect(originMain(f)).toBe(before);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(source);
	expect(readFileSync(join(f.repo, "package.json"), "utf8")).toBe(pkgBefore);
}, fixtureDeadlineS(120) * 1_000);

const preflight = () => segment('PREPARE=0\nif [ -z "$SOURCE" ]; then PREPARE=1', 'say "source $SOURCE (origin/main $MAIN) version $VERSION base $BASE_TAG mode $MODE"');
function runPreflight(f: Fixture, version: string, source: string) {
	const body = `${prelude}${helpers()}\nREPO=fixture/release; NEXT=0; DRY_RUN=0; VERSION='${version}'; SOURCE='${source}'\nMAIN="$(git -C "$ROOT" rev-parse refs/remotes/origin/main)"\n${preflight()}\n`;
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

test("CALLERCOMMIT1 prepares owned files without committing peer bytes and reuses the caller's published marker", () => {
	const { f, source } = publishedFixture("caller-commit", true);
	// The outer fresh gate runs this test from an archive with source_revision expanded.
	// Seed the inner repository's raw checkout value and its real Git export behavior.
	const packagePath = join(f.repo, "package.json");
	const seedPackage = JSON.parse(readFileSync(packagePath, "utf8"));
	writeFileSync(packagePath, JSON.stringify({ ...seedPackage, source_revision: "$Format:%H$" }, null, 2) + "\n");
	writeFileSync(join(f.repo, ".gitattributes"), "package.json export-subst\n");
	writeFileSync(join(f.repo, "changelog.d/shipped.md"), "### Fixed\n\n- Shipped in the tagged source.\n- Residual added after the tag.\n");
	f.git(f.repo, "add", "--", "changelog.d/shipped.md", "package.json", ".gitattributes");
	f.git(f.repo, "commit", "-qm", "seed raw release metadata and later fragment revision");
	f.git(f.repo, "push", "-q", "origin", "main");
	const before = originMain(f);
	writeFileSync(join(f.repo, "peer.txt"), "Unrelated staged peer bytes.\n");
	f.git(f.repo, "add", "peer.txt");
	const peerIndex = f.git(f.repo, "ls-files", "--stage", "--", "peer.txt");
	publishEvidence(f);
	copyFileSync(join(ROOT, "scripts/release-local.sh"), join(f.repo, "scripts/release-local.sh"));
	const result = runFixture(["bash", join(f.repo, "scripts/release-local.sh"), "--advance-only", "--version", "1.2.4", "--caller-commit-next-version"],
		{ cwd: f.repo, env: f.env, floor_s: 180 });
	const stdout = decode(result.stdout);
	expect(result.rc, `${stdout}\n${decode(result.stderr)}`).toBe(3);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	expect(originMain(f)).toBe(before);
	expect(f.git(f.repo, "ls-files", "--stage", "--", "peer.txt")).toBe(peerIndex);
	const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
	expect([pkg.version, pkg.omp.version]).toEqual(["1.2.5", "1.2.5"]);
	expect(pkg.source_revision).toBe("$Format:%H$");
	expect(readFileSync(join(f.repo, "README.md"), "utf8")).toContain("Current release: v1.2.4");
	const changelog = readFileSync(join(f.repo, "CHANGELOG.md"), "utf8");
	expect(changelog).toContain("## [1.2.4]");
	expect(changelog).toContain("Shipped in the tagged source.");
	expect(changelog).not.toContain("Residual added after the tag.");
	expect(readFileSync(join(f.repo, "changelog.d/shipped.md"), "utf8")).toContain("Residual added after the tag.");
	expect(readFileSync(join(f.repo, "changelog.d/shipped.md"), "utf8")).not.toContain("Shipped in the tagged source.");
	expect(existsSync(join(f.repo, "changelog.d/owned.md"))).toBe(false);
	expect(readFileSync(join(f.repo, "changelog.d/later.md"), "utf8")).toContain("Landed after the tag.");
	expect(stdout).toContain(`NEXT_VERSION_PREPARED: base=${before} source=${source} next=1.2.5`);
	const paths = ["package.json", "README.md", "CHANGELOG.md", "changelog.d/owned.md", "changelog.d/shipped.md"];
	expect(stdout.split("\n").filter(line => line.startsWith("NEXT_VERSION_PATH: ")).map(line => line.slice("NEXT_VERSION_PATH: ".length)).sort()).toEqual([...paths].sort());
	const message = stdout.split("NEXT_VERSION_COMMIT_MESSAGE_BEGIN\n")[1]?.split("NEXT_VERSION_COMMIT_MESSAGE_END\n")[0] ?? "";
	expect(message).toContain(`NEXTVERSION1: v1.2.4 is published from ${source};`);
	const messagePath = join(f.work, "caller-commit-message");
	writeFileSync(messagePath, message);
	// The fixture caller, not the release runner, owns this real selective commit.
	f.git(f.repo, "commit", "-q", "--only", "-F", messagePath, "--", ...paths);
	const callerSha = f.git(f.repo, "rev-parse", "HEAD");
	expect(f.git(f.repo, "rev-list", "--count", `${before}..${callerSha}`)).toBe("1");
	const unpublished = runFixture(["bash", join(f.repo, "scripts/release-local.sh"), "--advance-only", "--version", "1.2.4", "--caller-commit-next-version"],
		{ cwd: f.repo, env: f.env, floor_s: 180 });
	expect(unpublished.rc, `${decode(unpublished.stdout)}\n${decode(unpublished.stderr)}`).toBe(3);
	expect(decode(unpublished.stdout)).toContain(`NEXT_VERSION_PUBLICATION_PENDING: ${callerSha}`);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(callerSha);
	expect(originMain(f)).toBe(before);
	expect(f.git(f.repo, "ls-files", "--stage", "--", "peer.txt")).toBe(peerIndex);
	f.git(f.repo, "push", "-q", "origin", "main");
	writeFileSync(join(f.repo, "changelog.d/newer.md"), "### Added\n\n- Newer published main work.\n");
	f.git(f.repo, "add", "changelog.d/newer.md");
	f.git(f.repo, "commit", "-q", "--only", "-m", "newer main work", "--", "changelog.d/newer.md");
	f.git(f.repo, "push", "-q", "origin", "main");
	const newer = originMain(f);
	const retry = advanceOnly(f);
	expect(retry.rc, decode(retry.stderr)).toBe(0);
	expect(decode(retry.stdout)).toContain(`ADVANCE_ALREADY_DONE: v1.2.4 advanced in ${callerSha}`);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(newer);
	expect(originMain(f)).toBe(newer);
	expect(f.git(f.repo, "ls-files", "--stage", "--", "peer.txt")).toBe(peerIndex);
}, fixtureDeadlineS(180) * 1_000);

test("CALLERCOMMIT1 leaves the normal release receipt pending rather than claiming bookkeeping complete", () => {
	const { f, source, before } = publishedFixture("caller-pending-receipt");
	const body = `${prelude}${helpers()}
. "$ROOT/scripts/kitlib-tmp.sh"
${segment("receipt() {", "\n}\n")}
${segment("# NEXTVERSION1 (ompkit-d8qic", "\n}\n")}
VERSION=1.2.4; SOURCE=${source}; INSTALL=0; INSTALLED=0
CALLER_COMMIT_NEXT_VERSION=1; NEXT_VERSION_COMMIT_PENDING=0
STARTED=$(date +%s); BASE_TAG=v1.2.3; NOTARY_ID=fixture
TAG_PUSH_SECONDS=''; PUSH_STARTED=''; URL=https://example.invalid/release; RUN_ID=fixture
DIST="$WORK/dist"; mkdir -p "$DIST"; : >"$DIST/SHA256SUMS"
${segment("RELEASED_AT=$(date +%s)\n", '\nelse receipt released "$URL" "$RUN_ID"; fi')}
`;
	const entry = join(f.work, "caller-receipt.sh");
	writeFileSync(entry, body);
	const result = runFixture(["bash", entry, f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 180 });
	const stdout = decode(result.stdout);
	expect(result.rc, `${stdout}\n${decode(result.stderr)}`).toBe(3);
	const receiptLine = stdout.split("\n").find(line => line.startsWith("== receipt "));
	expect(receiptLine).toBeDefined();
	const receipt = JSON.parse(readFileSync((receiptLine ?? "").slice("== receipt ".length), "utf8"));
	expect(receipt.phase).toBe("released-pending-next-version-commit");
	expect(receipt.installed).toBe(false);
	expect(receipt.source_sha).toBe(source);
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	expect(originMain(f)).toBe(before);
}, fixtureDeadlineS(120) * 1_000);

test("CALLERCOMMIT1 preserves the original install-refusal exit and uncommitted next-version state", () => {
	const { f, source, before } = publishedFixture("caller-install-refusal");
	const refusal = segment("ADVANCE_PENDING=0\nadvance_after_refusal() {", "\nsay() {").slice(0, -"\nsay() {".length);
	const entry = join(f.work, "caller-refusal.sh");
	writeFileSync(entry, `${prelude}${helpers()}\n${refusal}\n${segment("# NEXTVERSION1 (ompkit-d8qic", "\n}\n")}
VERSION=1.2.4; SOURCE=${source}; INSTALLED=0; INSTALL_PREFIX=/fixture/kit; DARWIN=fixture.tar.gz
CALLER_COMMIT_NEXT_VERSION=1; NEXT_VERSION_COMMIT_PENDING=0; ADVANCE_PENDING=1
die "planted updater PARTIAL refusal"
`);
	const result = runFixture(["bash", entry, f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 180 });
	const stderr = decode(result.stderr);
	expect(result.rc, `${decode(result.stdout)}\n${stderr}`).toBe(4);
	expect(stderr).toContain("planted updater PARTIAL refusal");
	expect(stderr).toContain("next-version files are prepared but not committed");
	expect(stderr).toContain("not installed");
	expect(stderr).not.toContain("main states the next version");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	expect(originMain(f)).toBe(before);
	expect(JSON.parse(readFileSync(join(f.repo, "package.json"), "utf8")).version).toBe("1.2.5");
	const message = decode(result.stdout).split("NEXT_VERSION_COMMIT_MESSAGE_BEGIN\n")[1]?.split("NEXT_VERSION_COMMIT_MESSAGE_END\n")[0] ?? "";
	expect(message).toContain(`NEXTVERSION1: v1.2.4 is published from ${source};`);
	const messagePath = join(f.work, "refusal-caller-message");
	writeFileSync(messagePath, message);
	f.git(f.repo, "commit", "-q", "--only", "-F", messagePath, "--", "package.json", "README.md", "CHANGELOG.md", "changelog.d/shipped.md");
	const saved = f.git(f.repo, "rev-parse", "HEAD");
	const savedRefusal = runFixture(["bash", entry, f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 180 });
	const savedStderr = decode(savedRefusal.stderr);
	expect(savedRefusal.rc, `${decode(savedRefusal.stdout)}\n${savedStderr}`).toBe(4);
	expect(savedStderr).toContain(`next-version commit ${saved} awaits caller publication`);
	expect(savedStderr).toContain("not installed");
	expect(savedStderr).not.toContain("prepared but not committed");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(saved);
	expect(originMain(f)).toBe(before);
}, fixtureDeadlineS(120) * 1_000);
