import { afterAll, expect, test } from "bun:test";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupAllOwnedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";
import { advance, CONVERGE, decode, fixture, originMain, publishedFixture, ROOT } from "./release-fixture.ts";
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

test.skipIf(!existsSync(CONVERGE))("subject: the advance commit carries a proof level, passes every commit-msg member, and the old subject is refused", () => {
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
