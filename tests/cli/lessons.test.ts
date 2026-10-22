import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendLesson, appendLessonAndCommit, collectCheckinActivity, inspectLessons, LESSONS_RELATIVE_PATH, lessonDocumentAnchors, lessonRecordId, readLessonsLog, resolveLessonCurrency, writeCheckin, writeCheckinAndCommit, type LessonEntry } from "../../src/lessons.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
const roots: string[] = [];
const identity = { repo: "lesson-fixture", agent: "OliveCedar", pane: "%42", model: "codex-test" };
const now = new Date("2026-10-05T12:00:00.000Z");

function fixture(): string {
	mkdirSync(scratchRoot, { recursive: true });
	// Archive gates put fixtures below a pre-push path; that text is not a guard verdict.
	const root = ownedTmp("lessons-test-pre-push", { root: scratchRoot }).path;
	roots.push(root);
	writeFileSync(join(root, ".owner"), `pid=${process.pid} label=lessons-test repo=${repoRoot} created=${new Date().toISOString()}\n`);
	return root;
}

function gitIn(root: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
	});
	const output = result.stdout.toString() + result.stderr.toString();
	if (result.exitCode !== 0) throw new Error("git " + args.join(" ") + " failed (" + result.exitCode + "):\n" + output);
	return result.stdout.toString().trim();
}

interface LessonCommitFixture {
	root: string;
	local: string;
	remote: string;
	base: string;
	baseContent: string;
	peerLine: string;
}

function commitFixture(): LessonCommitFixture {
	const root = fixture();
	const local = join(root, "repo");
	const remote = join(root, "origin.git");
	mkdirSync(local);
	gitIn(root, "init", "--bare", remote);
	gitIn(local, "init", "--initial-branch=main");
	gitIn(local, "config", "user.name", "LESSONS test");
	gitIn(local, "config", "user.email", "lessons-test@example.invalid");
	gitIn(local, "config", "commit.gpgsign", "false");
	const hooksPath = join(root, "hooks");
	mkdirSync(hooksPath);
	gitIn(local, "config", "core.hooksPath", hooksPath);
	writeFileSync(join(hooksPath, "pre-push"),
		`#!/bin/sh\nexec sh "${join(repoRoot, "scripts/check-pushed-on-main.sh")}" "$@"\n`, { mode: 0o755 });
	mkdirSync(join(local, ".omp"));
	const baseEntry = { ...{
		ts: "2026-10-05T10:00:00.000Z", repo: "lesson-fixture", agent: "BaseAgent", pane: null, model: "fixture",
		kind: "LESSON", class: "SCOPE_GAP", what: "Baseline lesson from origin main.", evidence: "fixture commit", cost_minutes: null,
		applies_to: "repo", proposed_fix: null, bead: null,
	} };
	const baseContent = JSON.stringify(baseEntry) + "\n";
	const peerLine = JSON.stringify({ ...baseEntry, ts: "2026-10-05T10:30:00.000Z", agent: "PeerAgent", what: "Peer uncommitted row." });
	writeFileSync(join(local, LESSONS_RELATIVE_PATH), baseContent);
	gitIn(local, "add", "--", LESSONS_RELATIVE_PATH);
	gitIn(local, "commit", "-m", "fixture baseline");
	gitIn(local, "remote", "add", "origin", remote);
	gitIn(local, "push", "--set-upstream", "origin", "main");
	const base = gitIn(local, "rev-parse", "HEAD");
	return { root, local, remote, base, baseContent, peerLine };
}

function assertSharedMain(fixture: LessonCommitFixture, entry: LessonEntry, commit: { base: string; commit: string }): void {
	const expected = fixture.baseContent + JSON.stringify(entry) + "\n";
	expect(commit.base).toBe(fixture.base);
	expect(gitIn(fixture.local, "rev-parse", "refs/heads/main")).toBe(commit.commit);
	expect(gitIn(fixture.remote, "rev-parse", "refs/heads/main")).toBe(commit.commit);
	expect(gitIn(fixture.local, "show", commit.commit + ":" + LESSONS_RELATIVE_PATH)).toBe(expected.trimEnd());
	expect(readFileSync(join(fixture.local, LESSONS_RELATIVE_PATH), "utf8")).toBe(expected);
	expect(gitIn(fixture.local, "status", "--porcelain", "--", LESSONS_RELATIVE_PATH)).toBe("");
	const subject = gitIn(fixture.local, "show", "-s", "--format=%s", commit.commit);
	expect(["[pending]", "[test]", "[selftest]", "[live]"].includes(subject.split(" ").pop() ?? "")).toBe(true);
	gitIn(fixture.local, "merge-base", "--is-ancestor", commit.commit, "refs/heads/main");
	gitIn(fixture.local, "merge-base", "--is-ancestor", commit.commit, "origin/main");
}


afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("lesson add --commit publishes shared main through PUSHGUARD1 and preserves peer index and worktree", () => {
	const f = commitFixture();
	writeFileSync(join(f.local, "peer.txt"), "peer staged\n");
	gitIn(f.local, "add", "--", "peer.txt");
	writeFileSync(join(f.local, "peer.txt"), "peer working\n");
	writeFileSync(join(f.local, "untracked.txt"), "peer untracked\n");
	const result = appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Publish the caller's lesson on shared main.", evidence: "commit lesson-caller",
		bead: "fixture-lesson",
	}, { identity, now });
	assertSharedMain(f, result.entry, result.commit);
	expect(gitIn(f.local, "show", ":peer.txt")).toBe("peer staged");
	expect(readFileSync(join(f.local, "peer.txt"), "utf8")).toBe("peer working\n");
	expect(readFileSync(join(f.local, "untracked.txt"), "utf8")).toBe("peer untracked\n");
	expect(gitIn(f.local, "diff", "--cached", "--name-only")).toBe("peer.txt");
});

test("checkin --commit publishes its record on local and remote main", () => {
	const f = commitFixture();
	const result = writeCheckinAndCommit(f.local, { blocked: ["waiting for peer review"], next: ["finish the consumer"], bead: "fixture-lesson" }, {
		identity, now, activity: [],
	});
	assertSharedMain(f, result.entry, result.commit);
});

test("lesson commit refuses a peer's dirty lesson log before appending or staging", () => {
	const f = commitFixture();
	const path = join(f.local, LESSONS_RELATIVE_PATH);
	const peerBytes = f.baseContent + f.peerLine + "\n";
	writeFileSync(path, peerBytes);
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Must not adopt a peer row.", evidence: "dirty-path control",
		bead: "fixture-lesson",
	}, { identity, now })).toThrow("LESSONS_COMMIT_LOG_DIRTY");
	expect(readFileSync(path, "utf8")).toBe(peerBytes);
	expect(gitIn(f.local, "show", ":" + LESSONS_RELATIVE_PATH)).toBe(f.baseContent.trimEnd());
	expect(gitIn(f.local, "rev-parse", "HEAD")).toBe(f.base);
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
});

test("lesson commit refuses a peer's staged lesson log without changing its bytes", () => {
	const f = commitFixture();
	const path = join(f.local, LESSONS_RELATIVE_PATH);
	const peerBytes = f.baseContent + f.peerLine + "\n";
	writeFileSync(path, peerBytes);
	gitIn(f.local, "add", "--", LESSONS_RELATIVE_PATH);
	expect(() => writeCheckinAndCommit(f.local, { next: ["keep peer ownership"], bead: "fixture-lesson" }, {
		identity, now, activity: [],
	})).toThrow("LESSONS_COMMIT_LOG_DIRTY");
	expect(readFileSync(path, "utf8")).toBe(peerBytes);
	expect(gitIn(f.local, "show", ":" + LESSONS_RELATIVE_PATH)).toBe(peerBytes.trimEnd());
	expect(gitIn(f.local, "rev-parse", "HEAD")).toBe(f.base);
});

test("lesson commit refuses detached HEAD before writing the log", () => {
	const f = commitFixture();
	gitIn(f.local, "checkout", "--detach", f.base);
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Must stay on main.", evidence: "detached control",
		bead: "fixture-lesson",
	}, { identity, now })).toThrow("LESSONS_COMMIT_NOT_ON_MAIN");
	expect(readFileSync(join(f.local, LESSONS_RELATIVE_PATH), "utf8")).toBe(f.baseContent);
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
});

test("commit API requires bead linkage before writing any row", () => {
	const f = commitFixture();
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Missing commit linkage.", evidence: "bead-boundary control",
	}, { identity, now })).toThrow("LESSONS_COMMIT_BEAD_REQUIRED");
	expect(readFileSync(join(f.local, LESSONS_RELATIVE_PATH), "utf8")).toBe(f.baseContent);
	expect(gitIn(f.local, "rev-parse", "HEAD")).toBe(f.base);
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
});

test("lesson commit refuses mode-only peer dirt without changing its content", () => {
	const f = commitFixture();
	gitIn(f.local, "config", "core.filemode", "true");
	const path = join(f.local, LESSONS_RELATIVE_PATH);
	chmodSync(path, 0o755);
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Do not adopt a peer mode change.", evidence: "mode control", bead: "fixture-lesson",
	}, { identity, now })).toThrow("LESSONS_COMMIT_LOG_DIRTY");
	expect(readFileSync(path, "utf8")).toBe(f.baseContent);
	expect(gitIn(f.local, "diff", "--summary", "--", LESSONS_RELATIVE_PATH)).toContain("100644 => 100755");
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
});

test("a checkout switched by a normal commit hook never reports published lessons", () => {
	const f = commitFixture();
	gitIn(f.local, "branch", "peer-branch", f.base);
	writeFileSync(join(f.root, "hooks", "pre-commit"),
		"#!/bin/sh\ngit symbolic-ref HEAD refs/heads/peer-branch\n", { mode: 0o755 });
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Branch changed during commit.", evidence: "normal hook race", bead: "fixture-lesson",
	}, { identity, now })).toThrow("LESSONS_COMMIT_");
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(f.base);
});

test("a moved origin refuses publication and retains the lesson on local shared main", () => {
	const f = commitFixture();
	const peer = join(f.root, "peer");
	gitIn(f.root, "clone", "--branch", "main", f.remote, peer);
	gitIn(peer, "config", "user.name", "Peer");
	gitIn(peer, "config", "user.email", "peer@example.invalid");
	gitIn(peer, "config", "commit.gpgsign", "false");
	gitIn(peer, "config", "core.hooksPath", join(f.root, "hooks"));
	writeFileSync(join(peer, "peer.txt"), "independently published peer work\n");
	gitIn(peer, "add", "--", "peer.txt");
	gitIn(peer, "commit", "-m", "fixture peer advance");
	gitIn(peer, "push", "origin", "main");
	const peerHead = gitIn(peer, "rev-parse", "HEAD");
	expect(() => appendLessonAndCommit(f.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "Keep the saved lesson after contention.", evidence: "origin race", bead: "fixture-lesson",
	}, { identity, now })).toThrow("LESSONS_COMMIT_CAS_REJECTED");
	const saved = gitIn(f.local, "rev-parse", "refs/heads/main");
	expect(saved).not.toBe(f.base);
	expect(gitIn(f.remote, "rev-parse", "refs/heads/main")).toBe(peerHead);
	expect(gitIn(f.local, "show", saved + ":" + LESSONS_RELATIVE_PATH)).toContain("Keep the saved lesson after contention.");
	expect(gitIn(f.local, "status", "--porcelain", "--", LESSONS_RELATIVE_PATH)).toBe("");
});


test("lesson add appends one schema-valid JSONL record with the captured identity", () => {
	const root = fixture();
	const entry = appendLesson(root, {
		kind: "NEGATIVE", class: "SCOPE_GAP",
		what: "The command path failed after the interface reported success.",
		evidence: "command `omp-kit lesson add` exited 1",
	}, { identity, now });
	const path = join(root, ".omp", "lessons.jsonl");
	const lines = readFileSync(path, "utf8").trimEnd().split("\n");
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0]!)).toEqual(entry);
	expect(entry).toMatchObject({
		ts: "2026-10-05T12:00:00.000Z", repo: identity.repo, agent: identity.agent,
		pane: identity.pane, model: identity.model, kind: "NEGATIVE", class: "SCOPE_GAP",
		evidence: "command `omp-kit lesson add` exited 1", applies_to: "repo",
	});
	expect(readLessonsLog(root)).toMatchObject({ status: "OK", entries: [entry] });
});

test("a lesson supersession reference survives the real append and read boundary", () => {
	const root = fixture();
	appendLesson(root, {
		kind: "LESSON", class: "STALE_TEXT", what: "Old advice is retained only as history.",
		evidence: "supersession fixture", applies_to: "fleet", superseded_by: "lesson-current-replacement",
	}, { identity, now });
	expect(readLessonsLog(root)).toMatchObject({
		status: "OK", entries: [{ superseded_by: "lesson-current-replacement" }],
	});
});

test.each([null, 17, [], {}, "", "   "].map(value => [value]))("a malformed supersession reference is reported instead of typed as advice: %j", (superseded_by) => {
	const root = fixture();
	const entry = appendLesson(root, {
		kind: "LESSON", class: "STALE_TEXT", what: "Malformed metadata cannot become current advice.",
		evidence: "invalid supersession fixture",
	}, { identity, now });
	writeFileSync(join(root, LESSONS_RELATIVE_PATH), JSON.stringify({ ...entry, superseded_by }) + "\n");
	const log = readLessonsLog(root);
	expect(log.status).toBe("INVALID");
	expect(log.invalid_lines.map(({ line, code }) => ({ line, code }))).toEqual([{
		line: 1, code: "LESSON_SUPERSEDED_BY_INVALID",
	}]);
	expect(log.entries).toEqual([]);
});

test("currency keeps replacement A and unrelated C active, with B preserved as history", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "currency fixture", applies_to: "fleet" } as const;
	const a = appendLesson(root, { ...input, what: "A: current replacement" }, { identity, now });
	const b = appendLesson(root, { ...input, what: "B: retired advice", superseded_by: lessonRecordId(a) }, { identity, now });
	const c = appendLesson(root, { ...input, what: "C: unrelated useful advice" }, { identity, now });
	const result = resolveLessonCurrency(readLessonsLog(root).entries);
	expect(result.active.map(row => row.entry)).toEqual([a, c]);
	expect(result.history.map(row => row.entry)).toEqual([b]);
	expect(result.unresolved).toEqual([]);
});

test("stable record references survive reordered persisted properties and an append-only correction", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "correction fixture", applies_to: "fleet" } as const;
	const b = appendLesson(root, { ...input, what: "B: original advice" }, { identity, now });
	const originalId = lessonRecordId(b);
	const original = JSON.stringify(Object.fromEntries(Object.entries(b).reverse())) + "\n";
	writeFileSync(join(root, LESSONS_RELATIVE_PATH), original);
	const a = appendLesson(root, { ...input, what: "A: replacement" }, { identity, now });
	const before = readFileSync(join(root, LESSONS_RELATIVE_PATH), "utf8");
	const correction = appendLesson(root, { ...input, kind: "CORRECTION", what: "Retire B in favor of A.",
		corrects: originalId, superseded_by: lessonRecordId(a) }, { identity, now: new Date(now.getTime() + 1) });
	expect(readFileSync(join(root, LESSONS_RELATIVE_PATH), "utf8")).toBe(before + JSON.stringify(correction) + "\n");
	const result = resolveLessonCurrency(readLessonsLog(root).entries);
	expect(result.active.map(row => row.entry)).toEqual([a]);
	expect(result.history.map(row => row.entry)).toEqual([b, correction]);
	expect(result.unresolved).toEqual([]);
});

test("missing replacement and applicability remain visible as unresolved, never advice", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "unresolved fixture" } as const;
	const missing = appendLesson(root, { ...input, what: "Missing replacement", superseded_by: "lesson_absent" }, { identity, now });
	const incomplete = appendLesson(root, { ...input, what: "Missing applicability" }, { identity, now });
	const { applies_to: _scope, ...withoutScope } = incomplete;
	writeFileSync(join(root, LESSONS_RELATIVE_PATH), [missing, withoutScope].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const log = readLessonsLog(root);
	expect(log.status).toBe("OK");
	const result = resolveLessonCurrency(log.entries);
	expect(result.active).toEqual([]);
	expect(result.history).toEqual([]);
	expect(result.unresolved.map(row => ({ what: row.entry.what, reason: row.reason }))).toEqual([
		{ what: "Missing replacement", reason: "SUPERSESSION_TARGET_MISSING" },
		{ what: "Missing applicability", reason: "LESSON_APPLICABILITY_MISSING" },
	]);
});

test("supersession cycles are unresolved without hiding an unrelated healthy lesson", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "cycle fixture" } as const;
	const a = appendLesson(root, { ...input, what: "Cycle A" }, { identity, now });
	const b = appendLesson(root, { ...input, what: "Cycle B" }, { identity, now });
	const c = appendLesson(root, { ...input, what: "Healthy C" }, { identity, now });
	const rows = [{ ...a, superseded_by: lessonRecordId(b) }, { ...b, superseded_by: lessonRecordId(a) }, c];
	const result = resolveLessonCurrency(rows);
	expect(result.active.map(row => row.entry.what)).toEqual(["Healthy C"]);
	expect(result.history).toEqual([]);
	expect(result.unresolved.map(row => ({ what: row.entry.what, reason: row.reason }))).toEqual([
		{ what: "Cycle A", reason: "SUPERSESSION_CYCLE" }, { what: "Cycle B", reason: "SUPERSESSION_CYCLE" },
	]);
});

test("document retirement proves existence only and refuses a missing file or a symlink escaping the repo", () => {
	const root = fixture();
	const outside = fixture();
	writeFileSync(join(root, "replacement.md"), "# A different heading\n");
	writeFileSync(join(outside, "outside.md"), "outside the selected repo\n");
	symlinkSync(join(outside, "outside.md"), join(root, "escape.md"));
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "document fixture" } as const;
	const present = appendLesson(root, { ...input, what: "Replaced by an existing document", superseded_by: "replacement.md:999" }, { identity, now });
	const missing = appendLesson(root, { ...input, what: "Missing document", superseded_by: "absent.md#policy" }, { identity, now });
	const escape = appendLesson(root, { ...input, what: "Escaping document", superseded_by: "escape.md#policy" }, { identity, now });
	const entries = readLessonsLog(root).entries;
	const result = resolveLessonCurrency(entries, lessonDocumentAnchors(root, entries));
	expect(result.active).toEqual([]);
	expect(result.history.map(row => row.entry)).toEqual([present]);
	expect(result.unresolved.map(row => row.entry)).toEqual([missing, escape]);
	expect(result.anchor_notes.map(({ target, verification }) => ({ target, verification }))).toEqual([{ target: "replacement.md:999", verification: "FILE_EXISTS_ONLY" }]);
});

test("a later complete correction recovers its target without hiding an incomplete correction", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "append-only recovery", applies_to: "fleet" } as const;
	const old = appendLesson(root, { ...input, what: "Old advice needing correction" }, { identity, now });
	const current = appendLesson(root, { ...input, what: "Valid replacement" }, { identity, now });
	const incomplete = appendLesson(root, { ...input, kind: "CORRECTION", what: "Legacy correction with missing scope",
		corrects: lessonRecordId(old), superseded_by: lessonRecordId(current) }, { identity, now: new Date(now.getTime() + 1) });
	const { applies_to: _scope, ...withoutScope } = incomplete;
	writeFileSync(join(root, LESSONS_RELATIVE_PATH), [old, current, withoutScope].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const complete = appendLesson(root, { ...input, kind: "CORRECTION", what: "Complete correction after the legacy row",
		corrects: lessonRecordId(old), superseded_by: lessonRecordId(current) }, { identity, now: new Date(now.getTime() + 2) });
	const result = resolveLessonCurrency(readLessonsLog(root).entries);
	expect(result.active.map(row => row.entry)).toEqual([current]);
	expect(result.history.map(row => row.entry)).toEqual([old, complete]);
	expect(result.unresolved).toEqual([{ id: lessonRecordId(withoutScope), entry: withoutScope, reason: "LESSON_APPLICABILITY_MISSING" }]);
});

test("same-time corrections for different targets retain their own resolved and unresolved history", () => {
	const root = fixture();
	const input = { kind: "LESSON", class: "STALE_TEXT", evidence: "distinct correction targets", applies_to: "fleet" } as const;
	const oldA = appendLesson(root, { ...input, what: "Original A" }, { identity, now });
	const oldB = appendLesson(root, { ...input, what: "Original B" }, { identity, now });
	const current = appendLesson(root, { ...input, what: "Current replacement" }, { identity, now });
	const correction = { ...input, kind: "CORRECTION", what: "Replace the original advice" } as const;
	const resolved = appendLesson(root, { ...correction, corrects: lessonRecordId(oldA), superseded_by: lessonRecordId(current) }, { identity, now });
	const unresolved = appendLesson(root, { ...correction, corrects: lessonRecordId(oldB), superseded_by: "lesson_absent" }, { identity, now });
	const result = resolveLessonCurrency(readLessonsLog(root).entries);
	expect(result.active.map(row => row.entry)).toEqual([current]);
	expect(result.history.map(row => row.entry)).toEqual([oldA, resolved]);
	expect(result.unresolved.map(row => row.entry)).toEqual([oldB, unresolved]);
});

test("lesson add refuses missing evidence without changing an existing append-only log", () => {
	const root = fixture();
	appendLesson(root, {
		kind: "LESSON", class: "MISSING_EDGE",
		what: "A missing prerequisite left the follow-up unable to run.", evidence: "commit abc1234",
	}, { identity, now });
	const path = join(root, ".omp", "lessons.jsonl");
	const before = readFileSync(path, "utf8");
	expect(() => appendLesson(root, {
		kind: "NEGATIVE", class: "FALSE_CLAIM",
		what: "A no-op result was reported as success.", evidence: "   ",
	}, { identity, now })).toThrow(/evidence/i);
	expect(readFileSync(path, "utf8")).toBe(before);
	expect(readLessonsLog(root).entries).toHaveLength(1);
});

test("successive lesson entries preserve the earlier line byte-for-byte", () => {
	const root = fixture();
	const first = appendLesson(root, {
		kind: "GAP", class: "UNDEFINED_TERM",
		what: "A command field was not executable from the worker environment.", evidence: "check command exited 127",
	}, { identity, now });
	const path = join(root, ".omp", "lessons.jsonl");
	const firstLine = readFileSync(path, "utf8");
	appendLesson(root, {
		kind: "LESSON", class: "STALE_TEXT",
		what: "The guide described a route that the current CLI no longer exposes.", evidence: "src/cli.ts:1",
	}, { identity, now: new Date(now.getTime() + 1_000) });
	const lines = readFileSync(path, "utf8").split("\n");
	expect(lines[0]).toBe(firstLine.trimEnd());
	expect(lines.filter(Boolean)).toHaveLength(2);
	expect(readLessonsLog(root).entries[0]).toEqual(first);
});

test("checkin derives only this agent's commits and closes after the last check-in", () => {
	const root = fixture();
	const path = join(root, ".omp", "lessons.jsonl");
	mkdirSync(join(root, ".omp"), { recursive: true });
	const prior = {
		ts: "2026-10-05T10:30:00.000Z", repo: identity.repo, agent: identity.agent, pane: identity.pane, model: identity.model,
		kind: "CHECKIN", class: null, what: "Earlier check-in.", evidence: null, cost_minutes: null,
		applies_to: "repo", proposed_fix: null, bead: null, done: [], blocked: [], next: [], minutes: null, tokens: null,
	};
	writeFileSync(path, JSON.stringify(prior) + "\n");
	const entry = writeCheckin(root, { blocked: ["waiting on the upstream response"], next: ["finish the report"], minutes: 15, tokens: 500 }, {
		identity, now, activity: [
			{ kind: "commit", id: "old1111", agent: identity.agent, ts: "2026-10-05T10:00:00.000Z" },
			{ kind: "close", id: "ompkit-old", agent: identity.agent, ts: "2026-10-05T10:15:00.000Z" },
			{ kind: "commit", id: "new2222", agent: identity.agent, ts: "2026-10-05T11:00:00.000Z" },
			{ kind: "close", id: "ompkit-rc-epic-land-fix-release-dogfood-rz5.124", agent: identity.agent, ts: "2026-10-05T11:30:00.000Z" },
			{ kind: "commit", id: "peer3333", agent: "AnotherAgent", ts: "2026-10-05T11:45:00.000Z" },
		],
	});
	expect(entry).toMatchObject({
		kind: "CHECKIN", class: null, done: ["new2222", "ompkit-rc-epic-land-fix-release-dogfood-rz5.124"],
		blocked: ["waiting on the upstream response"], next: ["finish the report"], minutes: 15, tokens: 500,
	});
	expect(readLessonsLog(root).entries).toHaveLength(2);
});

test("activity collection filters git authors and br close actors after the cutoff", () => {
	const root = fixture();
	const trackerRoot = join(root, "tracker");
	const run = (args: readonly string[]) => {
		if (args[0] === "git") return { code: 0, stdout: [
			`older111\tOliveCedar\t2026-10-05T10:00:00+00:00`,
			`commit222\tOliveCedar\t2026-10-05T11:00:00+00:00`,
			`peer3333\tAnotherAgent\t2026-10-05T11:10:00+00:00`,
		].join("\n"), stderr: "" };
		if (args.includes("list")) return { code: 0, stdout: JSON.stringify({ issues: [
			{ id: "bead-old", closed_at: "2026-10-05T10:20:00Z" },
			{ id: "bead-new", closed_at: "2026-10-05T11:20:00Z" },
			{ id: "bead-other", closed_at: "2026-10-05T11:30:00Z" },
		] }), stderr: "" };
		if (args.includes("bead-new")) return { code: 0, stdout: JSON.stringify({ events: [
			{ event_type: "closed", actor: "OliveCedar", timestamp: "2026-10-05T11:20:00Z" },
		] }), stderr: "" };
		if (args.includes("bead-other")) return { code: 0, stdout: JSON.stringify({ events: [
			{ event_type: "closed", actor: "AnotherAgent", timestamp: "2026-10-05T11:30:00Z" },
		] }), stderr: "" };
		throw new Error(`unexpected runner command: ${args.join(" ")}`);
	};
	const result = collectCheckinActivity(root, trackerRoot, identity, "2026-10-05T10:30:00Z", { run });
	expect(result.status).toBe("OK");
	expect(result.events).toEqual([
		{ kind: "commit", id: "commit222", agent: identity.agent, ts: "2026-10-05T11:00:00.000Z" },
		{ kind: "close", id: "bead-new", agent: identity.agent, ts: "2026-10-05T11:20:00.000Z" },
	]);
});

test("doctor fails an overdue close and passes after a matching check-in", () => {
	const root = fixture();
	const activity = [{ kind: "close" as const, id: "bead-1", agent: identity.agent, ts: "2026-10-05T09:00:00.000Z" }];
	const options = { intervalMs: 2 * 60 * 60 * 1000, now, identity, activity };
	const overdue = inspectLessons(root, options);
	expect(overdue.overall).toBe("FAIL");
	expect(overdue.findings.map(finding => finding.code)).toContain("CHECKIN_OVERDUE");
	writeCheckin(root, { done: ["bead-1"] }, { identity, now: new Date("2026-10-05T11:00:00.000Z"), activity });
	const current = inspectLessons(root, options);
	expect(current.overall).toBe("OK");
	expect(current.close_followup).toEqual({ closed: 1, followed_by_checkin: 1, share: 1 });
});

test("doctor reports a planted negative lesson that has no evidence", () => {
	const root = fixture();
	const directory = join(root, ".omp");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "lessons.jsonl"), JSON.stringify({
		ts: "2026-10-05T11:00:00.000Z", repo: identity.repo, agent: identity.agent, pane: identity.pane, model: identity.model,
		kind: "NEGATIVE", class: "FALSE_CLAIM", what: "A result was reported without evidence.", evidence: "",
		cost_minutes: null, applies_to: "repo", proposed_fix: null, bead: null,
	}) + "\n");
	const report = inspectLessons(root, { intervalMs: 2 * 60 * 60 * 1000, now, identity, activity: [] });
	expect(report.overall).toBe("FAIL");
	expect(report.findings.map(finding => finding.code)).toContain("NEGATIVE_EVIDENCE_MISSING");
});

afterAll(() => cleanupAllOwnedTmp());
