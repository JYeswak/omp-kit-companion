import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

// NEXTVERSION1 (ompkit-d8qic): shared main always states the version it ships as. A published vX is followed by
// one main commit to the next patch plus the vX CHANGELOG promote; a cut tags an already-green origin commit with
// no bump commit; VERSIONSRC1 version-match still refuses a commit that states the published version.
export const ROOT = join(import.meta.dir, "..", "..");
export const script = readFileSync(join(ROOT, "scripts/release-local.sh"), "utf8");
export function segment(start: string, end: string): string {
	const first = script.indexOf(start);
	const last = script.indexOf(end, first + start.length);
	if (first < 0 || last < 0) throw new Error(`release-local boundary missing: ${start} / ${end}`);
	return script.slice(first, last + end.length);
}
export const helpers = () => segment("bounded() {", "# ---------------------------------------------------------------------------------------------- 1. preflight");
export const prelude = `set -euo pipefail
die() { echo "release-local: refused: $*" >&2; exit 4; }
say() { echo "== $*"; }
ROOT=$1; WORK=$2; STAGE_LOG="$WORK/stages"; : >"$STAGE_LOG"; CHILD=''
`;
export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
export type Fixture = { work: string; origin: string; repo: string; git: (cwd: string, ...args: string[]) => string; env: Record<string, string | undefined> };
/** fullTree: the README-checked inputs (src registry, rules, skills, the real package.json) so the staged README hook can judge commits. */
export function fixture(label: string, mainVersion: string, fullTree = false): Fixture {
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
	// release-local names the commit agent from AGENT_NAME or user.name; a grader shell may have neither.
	git(repo, "config", "user.name", "fixture");
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

export const originMain = (f: Fixture) => f.git(f.origin, "rev-parse", "refs/heads/main");
export const showMain = (f: Fixture, path: string) => f.git(f.origin, "show", `refs/heads/main:${path}`);

/**
 * Install the shipped pre-commit README member (scripts/check-staged-readme.sh) as the repo's commit hook, beside the
 * given readme-check source, the way the kit installs it. Every hook run is recorded in `<hooks>/ran`.
 */
export function installReadmeHook(f: Fixture, name: string, readmeCheck: string): string {
	const hooks = join(f.work, name);
	mkdirSync(hooks);
	for (const file of ["check-staged-readme.sh", "kitlib-tmp.sh"]) copyFileSync(join(ROOT, "scripts", file), join(hooks, file));
	writeFileSync(join(hooks, "readme-check.ts"), readmeCheck);
	writeFileSync(join(hooks, "pre-commit"), `#!/bin/sh\necho ran >>"${join(hooks, "ran")}"\nexec sh "${join(hooks, "check-staged-readme.sh")}"\n`);
	chmodSync(join(hooks, "pre-commit"), 0o755);
	f.git(f.repo, "config", "core.hooksPath", hooks);
	return hooks;
}
export const readmeCheckSource = readFileSync(join(ROOT, "scripts/readme-check.ts"), "utf8");

// git_converge.py publishes when origin moved; the tests use the same default the script does.
export const CONVERGE = process.env.OMP_KIT_GIT_CONVERGE ?? join(homedir(), "Developer/omp-kit/scripts/git_converge.py");
export function advance(f: Fixture, source: string, installed: 0 | 1) {
	// advance_next_version is defined after the dry-run exit, so no GitHub write is reachable before it.
	const body = `${prelude}${helpers()}\n${segment("# NEXTVERSION1 (ompkit-d8qic", "\n}\n")}\nVERSION=1.2.4; SOURCE=${source}; INSTALLED=${installed}; INSTALL_PREFIX=/fixture/kit\nadvance_next_version\n`;
	writeFileSync(join(f.work, "advance.sh"), body);
	return runFixture(["bash", join(f.work, "advance.sh"), f.repo, f.work], { cwd: f.repo, env: { ...f.env, OMP_KIT_GIT_CONVERGE: CONVERGE }, floor_s: 180 });
}

export function publishedFixture(label: string, fragmentOwner = false) {
	const f = fixture(label, "1.2.4", true);
	if (fragmentOwner) {
		writeFileSync(join(f.repo, "changelog.d/owned.md"), "### Fixed\n\n- Separately owned shipped fragment.\n");
		f.git(f.repo, "add", "changelog.d/owned.md");
		f.git(f.repo, "commit", "-qm", "shipped fragment\n\nBead: fixture-fragment");
	}
	const source = f.git(f.repo, "rev-parse", "HEAD");
	// The tag stage of the run publishes v1.2.4 before the next-version step.
	f.git(f.repo, "tag", "v1.2.4", source); f.git(f.repo, "push", "-q", "origin", "v1.2.4");
	// Work that landed after the tagged source keeps its fragment for the next release.
	writeFileSync(join(f.repo, "changelog.d/later.md"), "### Added\n\n- Landed after the tag.\n");
	f.git(f.repo, "add", "."); f.git(f.repo, "commit", "-qm", "later work"); f.git(f.repo, "push", "-q", "origin", "main");
	return { f, source, before: originMain(f) };
}

export function advanceOnly(f: Fixture, version = "1.2.4") {
	copyFileSync(join(ROOT, "scripts/release-local.sh"), join(f.repo, "scripts/release-local.sh"));
	return runFixture(["bash", join(f.repo, "scripts/release-local.sh"), "--advance-only", "--version", version],
		{ cwd: f.repo, env: f.env, floor_s: 180 });
}

export function publishEvidence(f: Fixture, missing = "") {
	const assets = ["SHA256SUMS", "release-index.json",
		...["darwin-arm64-none", "linux-arm64-gnu", "linux-x64-gnu"].map(p => `omp-kit-v1.2.4-${p}.tar`)]
		.filter(name => name !== missing).map(name => ({ name, digest: `sha256:${"a".repeat(64)}` }));
	writeFileSync(join(f.work, "release.json"), JSON.stringify({ tagName: "v1.2.4", isDraft: false, isPrerelease: false, assets }));
	writeFileSync(join(f.work, "bin/gh"), `#!/bin/sh
printf '%s\\n' "$*" >>"${join(f.work, "gh.calls")}"
case "$*" in
  "release view v1.2.4 "*) cat "${join(f.work, "release.json")}" ;;
  "api --hostname github.com "*"/attestations/sha256:"*) printf '%s\\n' '{"attestations":[{"bundle":{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}}]}' ;;
  *) echo "unexpected gh $*" >&2; exit 97 ;;
esac
`);
}
