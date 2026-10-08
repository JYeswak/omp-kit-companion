import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appendLesson, appendLessonAndCommit, collectCheckinActivity, inspectLessons, LESSONS_RELATIVE_PATH, readLessonsLog, writeCheckin, writeCheckinAndCommit, type LessonEntry } from "../../src/lessons.ts";

const repoRoot = resolve(import.meta.dir, "../..");
const scratchRoot = join(repoRoot, "var", "agent-tmp");
const roots: string[] = [];
const identity = { repo: "lesson-fixture", agent: "OliveCedar", pane: "%42", model: "codex-test" };
const now = new Date("2026-10-05T12:00:00.000Z");

function fixture(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const root = mkdtempSync(join(scratchRoot, "lessons-test-"));
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

function privateCommitFixture(): { root: string; local: string; remote: string; base: string; baseContent: string; peerLine: string } {
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

function assertPeerRowStayedUncommitted(fixture: ReturnType<typeof privateCommitFixture>, entry: LessonEntry, commit: { base: string; commit: string }): void {
	const path = join(fixture.local, LESSONS_RELATIVE_PATH);
	const ownLine = JSON.stringify(entry);
	const remoteHead = gitIn(fixture.remote, "rev-parse", "refs/heads/main");
	const pushed = gitIn(fixture.local, "show", remoteHead + ":" + LESSONS_RELATIVE_PATH);
	expect(commit.base).toBe(fixture.base);
	expect(commit.commit).toBe(remoteHead);
	expect(gitIn(fixture.local, "show", "-s", "--format=%P", remoteHead)).toBe(fixture.base);
	expect(pushed).toBe(fixture.baseContent.trimEnd() + "\n" + ownLine);
	expect(readFileSync(path, "utf8")).toBe(fixture.baseContent + fixture.peerLine + "\n" + ownLine + "\n");
	expect(gitIn(fixture.local, "show", ":" + LESSONS_RELATIVE_PATH)).toBe(fixture.baseContent.trimEnd());
	expect(gitIn(fixture.local, "status", "--porcelain", "--", LESSONS_RELATIVE_PATH)).toContain(LESSONS_RELATIVE_PATH);
	expect(gitIn(fixture.local, "diff", "--cached", "--name-only")).toBe("");
}


afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("lesson add --commit pushes only its new row and leaves a peer row unstaged", () => {
	const fixture = privateCommitFixture();
	writeFileSync(join(fixture.local, LESSONS_RELATIVE_PATH), fixture.baseContent + fixture.peerLine + "\n");
	const result = appendLessonAndCommit(fixture.local, {
		kind: "LESSON", class: "MISSING_EDGE", what: "The caller's lesson is isolated from peer rows.", evidence: "commit lesson-caller",
	}, { identity, now: new Date("2026-10-05T11:00:00.000Z") });
	assertPeerRowStayedUncommitted(fixture, result.entry, result.commit);
});

test("checkin --commit pushes only its new row and leaves a peer row unstaged", () => {
	const fixture = privateCommitFixture();
	writeFileSync(join(fixture.local, LESSONS_RELATIVE_PATH), fixture.baseContent + fixture.peerLine + "\n");
	const result = writeCheckinAndCommit(fixture.local, { blocked: ["waiting for peer review"], next: ["finish the fleet report"] }, {
		identity, now: new Date("2026-10-05T11:00:00.000Z"), activity: [],
	});
	assertPeerRowStayedUncommitted(fixture, result.entry, result.commit);
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
