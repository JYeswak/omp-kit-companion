import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { listTreeFiles } from "../../scripts/readme-check.ts";
import { advance, decode, fixture, helpers, originMain, prelude, publishedFixture, ROOT } from "./release-fixture.ts";
import type { Fixture } from "./release-fixture.ts";
afterAll(cleanupAllOwnedTmp);

// RELADVANCE1 (ompkit-1ra0d.19): after a published release, `release-local --advance-only` commits the next version
// through the real commit hooks. On 2026-11-06 it was refused twice: the advance subject carried no proof level, and
// the commit gate's README release-line check read tags from its archive (whose initialized .git has none).

/** Install the shipped commit-msg members as the fixture repo's commit-msg hook; each run appends to `<hooks>/ran`. */
function installCommitMsgHook(f: Fixture): string {
	const hooks = join(f.work, "commit-msg-hooks");
	mkdirSync(hooks);
	for (const file of ["commit-msg-verification-level.sh", "commit-msg-bead.sh", "kitlib-tmp.sh"])
		copyFileSync(join(ROOT, "scripts", file), join(hooks, file));
	writeFileSync(join(hooks, "commit-msg"), `#!/bin/sh\necho ran >>"${join(hooks, "ran")}"\n`
		+ `bash "${join(hooks, "commit-msg-verification-level.sh")}" "$1" || exit 1\nsh "${join(hooks, "commit-msg-bead.sh")}" "$1" || exit 1\n`);
	chmodSync(join(hooks, "commit-msg"), 0o755);
	f.git(f.repo, "config", "core.hooksPath", hooks);
	return hooks;
}

/** Run one shipped commit-msg member on a message file; rc 0 admits. */
function member(f: Fixture, name: string, message: string): number {
	const file = join(f.work, `msg-${name}-${Math.random().toString(36).slice(2)}`);
	writeFileSync(file, message);
	return runFixture([name.endsWith("verification-level.sh") ? "bash" : "sh", join(ROOT, "scripts", name), file],
		{ cwd: f.repo, env: f.env, floor_s: 30 }).rc ?? -1;
}

test("subject: the advance commit carries a proof level, passes every commit-msg member, and the old subject is refused", () => {
	const { f, source } = publishedFixture("reladvance-subject");
	const hooks = installCommitMsgHook(f);
	const before = originMain(f);
	const result = advance(f, source, 1);
	expect(result.rc, decode(result.stderr)).toBe(0);
	expect(readFileSync(join(hooks, "ran"), "utf8").trim().split("\n").length).toBeGreaterThanOrEqual(1);
	const main = originMain(f);
	expect(main).not.toBe(before);
	const message = f.git(f.origin, "log", "-1", "--format=%B", main);
	const subject = message.split("\n")[0];
	expect(subject).toMatch(/^chore\(release\): next version 1\.2\.5 after v1\.2\.4 ompkit-d8qic \[[a-z]+\]$/);
	for (const name of ["commit-msg-verification-level.sh", "commit-msg-bead.sh"]) expect(member(f, name, message)).toBe(0);
	// Planted negative: the pre-RELADVANCE1 subject (no level) with the same body is refused by the level member.
	const old = message.replace(subject, subject.replace(/ \[[a-z]+\]$/, ""));
	expect(old.split("\n")[0]).toBe("chore(release): next version 1.2.5 after v1.2.4 ompkit-d8qic");
	expect(member(f, "commit-msg-verification-level.sh", old)).not.toBe(0);
}, fixtureDeadlineS(120) * 1_000);

const freshGate = readFileSync(join(ROOT, "scripts/fresh-gate.sh"), "utf8");
function gateReadme(): string {
	const start = freshGate.indexOf("\ngate_readme() {");
	const end = freshGate.indexOf("\n}\n", start);
	if (start < 0 || end < 0) throw new Error("fresh-gate.sh: gate_readme() is missing");
	return freshGate.slice(start + 1, end + 3);
}

/**
 * Run the shipped gate_readme on an archive of the fixture tree the way the commit gate does: ARCHIVE_DIR is the
 * archive (with its own initialized .git and no tags, as the focused phase leaves it), ROOT is that archive, and
 * FRESH_GATE_REPO is the canonical repository that holds the published tags.
 */
function runGateReadme(f: Fixture, readme: (text: string) => string) {
	const archive = join(f.work, "archive");
	cpSync(f.repo, archive, { recursive: true, filter: (path) => !path.endsWith("/.git") });
	mkdirSync(join(archive, "scripts"), { recursive: true });
	copyFileSync(join(ROOT, "scripts/readme-check.ts"), join(archive, "scripts/readme-check.ts"));
	writeFileSync(join(archive, "README.md"), readme(readFileSync(join(archive, "README.md"), "utf8")));
	// The archive stands in for a full git-archive export, whose README path lint
	// (DOCSHARMONY1) checks every backticked repo path against the tree: fill each
	// path the real repo tracks and the fixture lacks with the real bytes, so the
	// tree is complete and only the release line differs.
	// Listed from the filesystem, not git: the suite also runs in a git-less export.
	for (const rel of listTreeFiles(ROOT)) {
		const target = join(archive, rel);
		if (existsSync(target) || !statSync(join(ROOT, rel)).isFile()) continue;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(ROOT, rel), target);
	}
	f.git(archive, "init", "-q", "-b", "main");
	expect(f.git(archive, "tag", "-l")).toBe("");
	const body = `set -eu\nARCHIVE_DIR=${JSON.stringify(archive)}\nROOT="$ARCHIVE_DIR"\n${gateReadme()}gate_readme\n`;
	writeFileSync(join(f.work, "gate-readme.sh"), body);
	return runFixture(["sh", join(f.work, "gate-readme.sh")], { cwd: archive, env: { ...f.env, FRESH_GATE_REPO: f.repo }, floor_s: 60 });
}

test("tag: the gate's README release-line check finds a published tag from the canonical repo, and an unpublished tag stays RED", () => {
	// main states 1.2.4; README names v1.2.3, which is tagged in the canonical repo but not in the archive's .git.
	const f = fixture("reladvance-tag", "1.2.4", true);
	const published = runGateReadme(f, (text) => text);
	expect(published.rc, decode(published.stdout) + decode(published.stderr)).toBe(0);
	// Planted negative: a README naming a release that was never tagged is still refused.
	const g = fixture("reladvance-tag-unpublished", "1.2.4", true);
	const unpublished = runGateReadme(g, (text) => text.replace(/^Current release: v\d+\.\d+\.\d+$/m, "Current release: v1.2.2"));
	expect(unpublished.rc).not.toBe(0);
	expect(decode(unpublished.stdout) + decode(unpublished.stderr)).toContain("v1.2.2");
}, fixtureDeadlineS(90) * 1_000);

test("NEXTVERSION1 real commit gate admits the preflighted advance but refuses an unjudged version change", () => {
	const { f, source } = publishedFixture("reladvance-preflight");
	const hooks = join(f.repo, ".git/hooks");
	const push = join(hooks, "hooks.d/pre-push");
	const commit = join(hooks, "hooks.d/commit-msg");
	mkdirSync(push, { recursive: true });
	mkdirSync(commit, { recursive: true });
	const member = join(commit, "55-omp-kit-commit-gate");
	copyFileSync(join(ROOT, "scripts/check-commit-gate.sh"), member);
	chmodSync(member, 0o755);
	copyFileSync(join(ROOT, "scripts/kitlib-tmp.sh"), join(commit, "kitlib-tmp.sh"));
	writeFileSync(join(hooks, "commit-msg"), '#!/bin/sh\nexec sh "$(dirname "$0")/hooks.d/commit-msg/55-omp-kit-commit-gate" "$1"\n');
	chmodSync(join(hooks, "commit-msg"), 0o755);
	// Isolate the downstream fresh-gate transport, not admission: inspect the actual candidate's versions.
	const gate = join(push, "40-omp-kit-fresh-gate");
	writeFileSync(gate, `#!/bin/sh
read -r local_ref candidate remote_ref base
git show "$candidate:package.json" | bun -e 'const p=await Bun.stdin.json(); if(!["1.2.5", "1.2.6"].includes(p.version) || p.omp.version !== p.version) process.exit(1)'
`);
	chmodSync(gate, 0o755);
	const before = f.git(f.repo, "rev-parse", "HEAD");
	const original = readFileSync(join(f.repo, "package.json"), "utf8");
	writeFileSync(join(f.repo, "package.json"), original.replaceAll('"1.2.4"', '"1.2.5"'));
	const refused = runFixture(["git", "commit", "--only", "-m", "chore(release): unjudged version [pending]", "--", "package.json"],
		{ cwd: f.repo, env: f.env, floor_s: 30 });
	expect(refused.rc).not.toBe(0);
	expect(decode(refused.stderr)).toContain("REFUSED unjudged tree/message");
	expect(f.git(f.repo, "rev-parse", "HEAD")).toBe(before);
	writeFileSync(join(f.repo, "package.json"), original);
	const admitted = advance(f, source, 1);
	const output = decode(admitted.stdout) + decode(admitted.stderr);
	expect(admitted.rc, output).toBe(0);
	expect(output).toContain("commit-gate: VERIFIED prepared tree");
	expect(JSON.parse(f.git(f.origin, "show", "refs/heads/main:package.json")).version).toBe("1.2.5");
	const prepare = join(f.work, "prepare.sh");
	writeFileSync(prepare, `${prelude}${helpers()}\nVERSION=1.2.6; DRY_RUN=1\nprepare_release\n`);
	const prepared = runFixture(["bash", prepare, f.repo, f.work], { cwd: f.repo, env: f.env, floor_s: 180 });
	const prepareOutput = decode(prepared.stdout) + decode(prepared.stderr);
	expect(prepared.rc, prepareOutput).toBe(0);
	expect(prepareOutput).toContain("commit-gate: VERIFIED prepared tree");
	expect(JSON.parse(readFileSync(join(f.repo, "package.json"), "utf8")).version).toBe("1.2.6");
}, fixtureDeadlineS(180) * 1_000);

test("NEXTVERSION1 without the admission member commits without invoking preflight", () => {
	const { f, source } = publishedFixture("reladvance-no-admission");
	// A planted failure proves the unused preflight is not called.
	writeFileSync(join(f.repo, "scripts/commit-preflight.sh"), "#!/bin/sh\necho unexpected-preflight >&2\nexit 97\n");
	const result = advance(f, source, 1);
	const output = decode(result.stdout) + decode(result.stderr);
	expect(result.rc, output).toBe(0);
	expect(output).not.toContain("unexpected-preflight");
	expect(JSON.parse(f.git(f.origin, "show", "refs/heads/main:package.json")).version).toBe("1.2.5");
}, fixtureDeadlineS(120) * 1_000);
