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
// Real, deliberately tiny repository: the actual suite/store produce both PASS records.
// GitHub release-list transport alone is a fixture; source, runtime and verdict checks are real.
let source = "";
function setup() {
	if (source) return;
	git("init", "-q", "--template=", "-b", "main");
	git("remote", "add", "origin", repo);
	const bin = join(work.path, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "gh"), '#!/bin/sh\ncase "$1 $2" in "api --paginate") printf \'%s\\n\' \'[[{"tag_name":"v0.2.98","draft":false,"prerelease":false}]]\' ;; *) exit 97 ;; esac\n');
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
	source = git("rev-parse", "HEAD");
	git("update-ref", "refs/remotes/origin/main", source);
	ok(["sh", join(repo, "scripts/full-suite-verdict.sh"), "--repo", repo, "--commit", source, "--judge-role", "main"]);
	ok(["sh", "-c", '. "$1/scripts/fixed-env.sh"; cd "$1/scripts" && exec python3 -B -m full-suite-verdict-store run-ci-only --repo "$1" --commit "$2" --judge-root "$1" --suite-root "$1"', "fixture", repo, source]);
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
