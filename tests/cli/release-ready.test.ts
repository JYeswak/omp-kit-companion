import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const ROOT = resolve(import.meta.dir, "../..");
const work = ownedTmp("release-ready", { root: process.env.TMPDIR!, bead: "ompkit-1ra0d.32" });
afterAll(() => work.cleanup());
const repo = join(work.path, "repo");
mkdirSync(repo);
const env = { ...process.env, TMPDIR: work.path, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
	GIT_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined, BEADS_DB: undefined, BEADS_DIR: undefined,
	FULL_SUITE_VERDICT_CACHE_DIR: join(work.path, "cache"), GIT_AUTHOR_NAME: "fixture", GIT_COMMITTER_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function run(argv: string[], extra: Record<string, string> = {}) {
	return runFixture(argv, { cwd: repo, env: { ...env, ...extra }, floor_s: 60 });
}
function ok(argv: string[]) {
	const result = run(argv);
	expect({ rc: result.rc, out: text(result.stdout), err: text(result.stderr) }).toMatchObject({ rc: 0 });
	return text(result.stdout).trim();
}
const git = (...args: string[]) => ok(["git", ...args]);
function file(path: string, body: string) {
	mkdirSync(dirname(join(repo, path)), { recursive: true });
	writeFileSync(join(repo, path), body);
}
// Real, deliberately tiny repository: the actual suite/store produce the main PASS.
// GitHub transport is a fixture; source, runtime, suite and both release preflight predicates are real.
let source = "";
let belowFloor = "";
function setup() {
	if (source) return;
	git("init", "-q", "--template=", "-b", "main");
	git("remote", "add", "origin", repo);
	const bin = join(work.path, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$1 $2" in
  "api --paginate") printf '%s\\n' '[[{"tag_name":"v0.2.98","draft":false,"prerelease":false}]]' ;;
  "run list")
    sha=$(git rev-parse HEAD) || exit 96
    conclusion=success
    case "\${RELEASE_READY_FIXTURE_CI:-green}" in
      green) ;;
      red) conclusion=failure ;;
      missing) printf '[]\\n'; exit 0 ;;
      wrong-sha) sha=$(git rev-parse HEAD^) || exit 96 ;;
      unavailable) exit 97 ;;
      *) exit 98 ;;
    esac
    printf '[{"databaseId":42,"headSha":"%s","status":"completed","conclusion":"%s","event":"push"}]\\n' "$sha" "$conclusion"
    ;;
  *) exit 97 ;;
esac
`);
	chmodSync(join(bin, "gh"), 0o755);
	env.PATH = `${bin}:${process.env.PATH}`;
	const closure = runFixture(["python3", "-B", join(ROOT, "scripts/suite-metrics.py"), "judging-files"], { cwd: ROOT, env, floor_s: 30 });
	expect(closure.rc, text(closure.stderr)).toBe(0);
	const paths = [...text(closure.stdout).trim().split("\n"), "scripts/release-train.sh"];
	for (const path of paths) {
		if (!path || !existsSync(join(ROOT, path))) continue;
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		copyFileSync(join(ROOT, path), join(repo, path));
	}
	file("package.json", JSON.stringify({ version: "0.2.99", omp: { version: "0.2.99" }, source_revision: "$Format:%H$" }));
	file(".gitattributes", "package.json export-subst\n");
	file(".bun-version", ok(["bun", "--version"]) + "\n");
	file("README.md", "<!-- kit-release:start -->\nCurrent release: v0.2.99\n<!-- kit-release:end -->\n");
	file("scripts/release-signing.json", '{"schema_version":1,"darwin_signing":"developer-id"}\n');
	file(".github/workflows/release.yml", "jobs:\n  attest-local:\n    runs-on: ubuntu-latest\n");
	file("tests/cli/fixture.test.sh", "#!/bin/sh\n[ -f package.json ] && printf 'fixture package present\\n'\n");
	const ci = ["package-release", "kit-update", "kit-update-nplus-two", "kit-update-compiled", "kit-update-relink", "package-release-live"];
	for (const name of ci) file(`tests/cli/${name}.test.ts`, 'import { expect, test } from "bun:test"; test("candidate version", () => expect(JSON.parse(require("fs").readFileSync("package.json", "utf8")).version).toBe("0.2.99"));\n');
	copyFileSync(join(ROOT, "scripts/gate-ci-only.tsv"), join(repo, "scripts/gate-ci-only.tsv"));
	git("add", "--", "."); git("commit", "-qm", "fixture [test]");
	git("tag", "v0.2.98");
	for (let index = 1; index <= 10; index++) {
		const path = `src/product-${index}.ts`;
		const fragment = `changelog.d/ompkit-ready${index}.md`;
		file(path, `export const behavior = ${index};\n`);
		file(fragment, `### Added\n- Fixture ${index}.\n`);
		git("add", "--", path, fragment);
		git("commit", "-qm", `deliver fixture ${index}`, "-m", `Bead: ompkit-ready${index}`);
		if (index === 9) belowFloor = git("rev-parse", "HEAD");
	}
	source = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", source);
	ok(["sh", join(repo, "scripts/full-suite-verdict.sh"), "--repo", repo, "--commit", source, "--judge-role", "main"]);
}
function readiness(extra: Record<string, string> = {}) {
	const result = run(["bun", join(ROOT, "src/release-ready.ts"), "--repo", repo, "--json"], extra);
	return { rc: result.rc, out: text(result.stdout), err: text(result.stderr) };
}

test("ready exact origin/main fixture reports READY; runtime-id mismatch is NOT-READY", () => {
	setup();
	const control = readiness();
	expect(control.rc, control.out + control.err).toBe(0);
	const ready = JSON.parse(control.out);
	expect(ready.status).toBe("READY");
	expect(ready.commit).toBe(source);
	expect(ready.checks).toContainEqual({ name: "hosted-ci", ok: true, detail: `CI_GREEN sha=${source} run=42 conclusion=success` });
	const floor = ready.checks.find((row: { name: string }) => row.name === "product-bead-floor");
	expect(JSON.parse(floor.detail)).toMatchObject({ count: 10, remaining: 0, source_sha: source });
	const doctor = run(["bun", join(ROOT, "src/cli.ts"), "doctor", "--scope", "release", "--project", repo, "--json"]);
	expect(doctor.rc, text(doctor.stdout) + text(doctor.stderr)).toBe(0);
	const diagnosed = JSON.parse(text(doctor.stdout)).data;
	expect(diagnosed.overall).toBe("OK");
	expect(diagnosed.findings.find((row: { component: string }) => row.component === "release").evidence.commit).toBe(source);
	const negative = readiness({ FULL_SUITE_RUNTIME_ID: "planted-runtime-change" });
	expect(negative.rc, negative.out + negative.err).toBe(1);
	expect(JSON.parse(negative.out).line).toContain("NOT-READY");
	expect(JSON.parse(negative.out).line).toContain("RUNTIME_MISMATCH");
	file("README.md", readFileSync(join(repo, "README.md"), "utf8") + "uncommitted peer edit\n");
	const dirty = JSON.parse(readiness().out);
	expect(dirty.status).toBe("NOT-READY");
	expect(dirty.line).toContain("metadata-clean: M README.md");
	file("README.md", git("show", "HEAD:README.md") + "\n");
}, fixtureDeadlineS(180) * 1000);

test("CIGATE1: release doctor names red, missing, wrong-SHA and unavailable hosted CI", () => {
	setup();
	for (const [mode, reason] of [
		["red", "run=42 status=completed conclusion=failure"],
		["missing", "reason=no-readable-push-or-scheduled-run"],
		["wrong-sha", "reason=no-readable-push-or-scheduled-run"],
		["unavailable", "reason=lookup-failed"],
	] as const) {
		const doctor = run(["bun", join(ROOT, "src/cli.ts"), "doctor", "--scope", "release", "--project", repo, "--json"],
			{ RELEASE_READY_FIXTURE_CI: mode });
		// A doctor command completing is not the release verdict.
		expect(doctor.rc, text(doctor.stdout) + text(doctor.stderr)).toBe(0);
		const diagnosed = JSON.parse(text(doctor.stdout)).data;
		const release = diagnosed.findings.find((row: { component: string }) => row.component === "release");
		expect(release, mode).toMatchObject({ status: "FAIL", evidence: { status: "NOT-READY", commit: source } });
		expect(release.evidence.checks.filter((row: { ok: boolean }) => !row.ok)).toEqual([
			{ name: "hosted-ci", ok: false, detail: `CI_NOT_GREEN sha=${source} ${reason}` },
		]);
	}
}, fixtureDeadlineS(180) * 1000);

test("release readiness names the exact product deficit on a nine-bead source", () => {
	setup();
	// The local origin advertises this exact older commit; neither revision changes release metadata.
	git("update-ref", "refs/heads/main", belowFloor, source);
	try {
		const result = readiness();
		expect(result.rc, result.out + result.err).toBe(1);
		expect(JSON.parse(result.out).commit).toBe(belowFloor);
		expect(JSON.parse(result.out).line).toContain("RELEASE_PRODUCT_FLOOR: 9/10");
	} finally {
		git("update-ref", "refs/heads/main", source, belowFloor);
	}
}, fixtureDeadlineS(60) * 1000);

test("an unqualified source without ship signing remains NOT-READY", () => {
	setup();
	file("scripts/release-signing.json", '{"schema_version":1,"darwin_signing":"none"}\n');
	git("add", "--", "scripts/release-signing.json");
	git("commit", "-qm", "plant unsigned source [test]");
	git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
	const result = readiness();
	expect(result.rc, result.out + result.err).toBe(1);
	const report = JSON.parse(result.out);
	expect(report.line).toContain("NOT-READY");
	const failed = report.checks.filter((row: { ok: boolean }) => !row.ok).map((row: { name: string }) => row.name);
	expect(failed).toContain("ship-signing");
	expect(failed).toContain("main-verdict");
}, fixtureDeadlineS(180) * 1000);

test("an already tagged main version requires the next version rather than re-cutting the published version", () => {
	setup();
	git("tag", "v0.2.99");
	const result = readiness();
	expect(result.rc, result.out + result.err).toBe(1);
	const report = JSON.parse(result.out);
	expect(report.version).toBe("0.2.100");
	expect(report.line).toContain("version: version-match: package.json states 0.2.99");
}, fixtureDeadlineS(60) * 1000);
