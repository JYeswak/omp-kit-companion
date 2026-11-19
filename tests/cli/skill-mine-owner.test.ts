// RULESKILL1 (ompkit-nmke9 box [a]): the owner source reads only the messages
// the owner actually typed in session journals, incrementally by cursor, and
// emits one candidate row per message with its time, seat and source line.
// Planted negatives (continuation steer, system notice, mail wake prompt,
// tool result) yield no row; a second run from the saved cursor emits nothing.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	cleanOwnerText, defaultOwnerSessionsRoots, loadOwnerCursor, ownerCursorPath, ownerMsgId, ownerSyntheticReason,
	scanOwnerSessions,
} from "../../src/skill-mine-owner.ts";
import { normalizeSkillMineSources, runSkillMine, type SkillMineOptions } from "../../src/skill-mine.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

function userLine(text: string, ts = "2026-11-19T02:00:26Z", extra?: Record<string, unknown>, n = 1): string {
	const message: Record<string, unknown> = { role: "user", content: [{ type: "text", text }] };
	if (extra) Object.assign(message, extra);
	return JSON.stringify({ type: "message", id: `t${n}`, parentId: "p", timestamp: ts, message });
}

interface OwnerFixture {
	root: string;
	home: string;
	sessions: string;
	proj: string;
	sess: string;
	sink: string;
	skills: string;
	stateDir: string;
	options: SkillMineOptions;
}

function makeOwnerFixture(label: string): OwnerFixture {
	const root = ownedTmp(label, { root: scratchParent }).path;
	const home = join(root, "home");
	const sessions = join(root, "sessions");
	const proj = join(sessions, "-Developer-cfs");
	mkdirSync(proj, { recursive: true });
	const sess = join(proj, "s1.jsonl");
	const sink = join(root, "sink", "candidates.jsonl");
	const skills = join(root, "skills");
	mkdirSync(skills, { recursive: true });
	const stateDir = join(home, ".local", "state", "omp-kit");
	const options: SkillMineOptions = {
		since: "2026-11-17T00:00:00Z", sessionsRoot: sessions, skillsDirs: [skills], sink,
		sources: ["owner"], home, pathValue: process.env.PATH ?? "", cwd: root, stateDir,
		now: Date.parse("2026-11-19T00:00:00Z"),
	};
	return { root, home, sessions, proj, sess, sink, skills, stateDir, options };
}

function writeLines(sess: string, lines: string[]): void {
	writeFileSync(sess, `${lines.join("\n")}\n`, "utf8");
}

function sinkLines(sink: string): string[] {
	if (!existsSync(sink)) return [];
	return readFileSync(sink, "utf8").split("\n").filter(Boolean);
}

test("RULESKILL1-owner: emits only the genuinely typed message with time, seat and source line", () => {
	const f = makeOwnerFixture("skill-mine-owner-real");
	// steering:true must NOT exclude: real steers carry it too.
	writeLines(f.sess, [userLine("update skills from every commit today", "2026-11-19T02:00:26Z", { steering: true, attribution: "user" })]);
	const { rows } = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(rows).toHaveLength(1);
	const row = rows[0]!;
	expect(row.text).toBe("update skills from every commit today");
	expect(row.seat_or_project_slug).toBe("-Developer-cfs");
	expect(row.line).toBe(1);
	expect(row.at).toBe("2026-11-19T02:00:26Z");
	expect(row.session_path).toBe(resolve(f.sess));
	expect(row.msg_id).toBe(ownerMsgId(row.session_path, 1));
	expect(row.msg_id).toHaveLength(64);
	expect(row.text_sha256).toBe(createHash("sha256").update(row.text, "utf8").digest("hex"));
});

test("RULESKILL1-owner: planted negatives yield no row", () => {
	const f = makeOwnerFixture("skill-mine-owner-negatives");
	writeLines(f.sess, [
		userLine("keep this one"),
		userLine("Complete assignment thoroughly:\n\n# Target\nOwn only var/agent-tmp/x and report the verdict with evidence."),
		userLine("[Wait interrupted by message]\n<irc from=\"parent\" agent=\"Main\">\nScope addition from Josh (verbatim): \"x\""),
		userLine("[budget notice] You have used 200 requests in this run (soft budget: 200). Wrap up now."),
		userLine("Continue active goal from your todo list and beads"),
		userLine("Design Critic (Joshua J-2026-11-17-30/-31/-32). Lane: skillgrowth judge role. Own the calibrated critic."),
		userLine("see the goal_context block below for direction"),
		userLine("You restarted onto the installed omp-kit release. Continue the work you were doing before the restart."),
		userLine("[from an unnamed agent or kit service via omp-kit send]\nMAIL 81183 from PeachLeopard: REPORT ..."),
		userLine("QUESTION cfs-x from JadeHorizon: please read Agent Mail 1"),
		JSON.stringify({ type: "message", id: "tool1", timestamp: "2026-11-19T02:01:00Z", message: { role: "toolResult", content: [{ type: "text", text: "exit=0" }] } }),
		JSON.stringify({ type: "message", id: "a1", timestamp: "2026-11-19T02:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "working on it" }] } }),
		userLine("<system>harness wrapper, not typed"),
	]);
	const { rows } = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(rows.map(row => row.text)).toEqual(["keep this one"]);
	expect(ownerSyntheticReason("keep this one")).toBeNull();
});

test("RULESKILL1-owner: attachment marker stripped, bare marker and harness wrapper dropped", () => {
	expect(cleanOwnerText("<attachment>\nupdate skills from every commit")).toBe("update skills from every commit");
	expect(cleanOwnerText("<attachment>")).toBeNull();
	expect(cleanOwnerText("<system>harness</system>")).toBeNull();
});

test("RULESKILL1-owner: cursor resume reads only new lines", () => {
	const f = makeOwnerFixture("skill-mine-owner-cursor");
	writeLines(f.sess, [userLine("first"), userLine("second")]);
	const first = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(first.rows.map(row => row.text)).toEqual(["first", "second"]);
	const second = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, first.cursor);
	expect(second.rows).toEqual([]);
	writeFileSync(f.sess, `${userLine("third", "2026-11-19T02:00:26Z", undefined, 3)}\n`, { flag: "a" });
	const third = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, second.cursor);
	expect(third.rows.map(row => row.text)).toEqual(["third"]);
	expect(third.rows[0]!.line).toBe(3);
});

test("RULESKILL1-owner: since/until window", () => {
	const f = makeOwnerFixture("skill-mine-owner-window");
	writeLines(f.sess, [
		userLine("old", "2026-11-16T23:59:59Z"),
		userLine("in-window", "2026-11-18T00:00:00Z"),
		userLine("new", "2026-11-19T00:00:01Z"),
	]);
	const { rows } = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), Date.parse("2026-11-19T00:00:00Z"), {});
	expect(rows.map(row => row.text)).toEqual(["in-window"]);
});

test("RULESKILL1-owner: deterministic across runs", () => {
	const f = makeOwnerFixture("skill-mine-owner-deterministic");
	writeLines(f.sess, [userLine("b msg"), userLine("a msg")]);
	const first = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {});
	const second = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(second).toEqual(first);
});

test("RULESKILL1-owner: chunked reads hold back partial lines and skip blob lines with their number", () => {
	const f = makeOwnerFixture("skill-mine-owner-chunks");
	const filler = "x".repeat(50);
	writeLines(f.sess, [userLine("first"), userLine(`kept across chunks ${filler}`)]);
	const opts = { chunkBytes: 37, maxLineBytes: 300 };
	const first = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, {}, opts);
	expect(first.rows.map(row => row.text)).toEqual(["first", `kept across chunks ${filler}`]);
	const blob = `{"role": "user", "y": "${"z".repeat(300)}"}`;
	writeFileSync(f.sess, `${blob}\n${userLine("after blob")}\n`, { flag: "a" });
	const second = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, first.cursor, opts);
	expect(second.rows.map(row => row.text)).toEqual(["after blob"]);
	// The blob consumed line 3: the kept message lands on line 4.
	expect(second.rows[0]!.line).toBe(4);
	writeFileSync(f.sess, '{"role": "user", "half": ', { flag: "a" });
	const third = scanOwnerSessions(f.sessions, Date.parse("2026-11-17T00:00:00Z"), null, second.cursor, opts);
	expect(third.rows).toEqual([]);
});

test("RULESKILL1-owner: runSkillMine emits one candidate row per message and no duplicates on rescan", async () => {
	const f = makeOwnerFixture("skill-mine-owner-pipeline");
	writeLines(f.sess, [userLine("first rule words"), userLine("second rule words")]);
	const first = await runSkillMine(f.options);
	expect(first.overall).toBe("OK");
	expect(first.sources.owner.status).toBe("OK");
	expect(first.candidates.filter(candidate => candidate.kind === "owner-message")).toHaveLength(2);
	expect(sinkLines(f.sink)).toHaveLength(2);
	const second = await runSkillMine(f.options);
	expect(second.candidates).toHaveLength(0);
	expect(sinkLines(f.sink)).toHaveLength(2);
});

test("RULESKILL1-owner: a cursor reset still emits nothing new via the ledger", async () => {
	const f = makeOwnerFixture("skill-mine-owner-ledger");
	writeLines(f.sess, [userLine("one"), userLine("two")]);
	const first = await runSkillMine(f.options);
	expect(first.candidates).toHaveLength(2);
	const cursor = ownerCursorPath(f.stateDir);
	expect(existsSync(cursor)).toBe(true);
	// A cursor reset rescans the same bytes: the ledger must not re-emit.
	writeFileSync(cursor, `${JSON.stringify({ schema_version: 1, files: {} })}\n`);
	const again = await runSkillMine(f.options);
	expect(again.candidates).toHaveLength(0);
	expect(sinkLines(f.sink)).toHaveLength(2);
	expect(loadOwnerCursor(cursor)).not.toEqual({});
});

test("RULESKILL1-owner: CLI --source owner mines journals and refuses unknown sources", () => {
	const f = makeOwnerFixture("skill-mine-owner-cli");
	writeLines(f.sess, [userLine("cli owner words")]);
	const tmp = join(f.root, "t");
	mkdirSync(tmp, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	Object.assign(env, { HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root, PATH: process.env.PATH ?? "" });
	const out = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine",
		"--since", "2026-11-17T00:00:00Z", "--source", "owner",
		"--sessions-root", f.sessions, "--skills-dir", f.skills, "--sink", f.sink,
		"--wall-budget-s", "60", "--json"],
		{ cwd: f.root, env, floor_s: fixtureDeadlineS() });
	expect(out.rc).toBe(0);
	const envelope = JSON.parse(new TextDecoder().decode(out.stdout));
	expect(envelope.errors ?? []).toEqual([]);
	expect(envelope.data.overall).toBe("OK");
	expect(envelope.data.sources.owner.status).toBe("OK");
	expect(envelope.data.candidates).toHaveLength(1);
	expect(envelope.data.candidates[0].evidence[0].source).toBe("owner");
	const bad = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine",
		"--source", "bogus", "--json"],
		{ cwd: f.root, env, floor_s: fixtureDeadlineS() });
	const badEnvelope = JSON.parse(new TextDecoder().decode(bad.stdout));
	expect((badEnvelope.errors ?? []).length).toBeGreaterThan(0);
	expect(JSON.stringify(badEnvelope)).toMatch(/must be one of cass, mail, git, owner/);
	expect(normalizeSkillMineSources(["owner"])).toEqual(["owner"]);
}, fixtureDeadlineS() * 1000);

function writeProfileJournal(home: string, profile: string, slug: string, file: string, lines: string[]): string {
	const dir = join(home, ".omp", "profiles", profile, "agent", "sessions", slug);
	mkdirSync(dir, { recursive: true });
	const sess = join(dir, file);
	writeFileSync(sess, `${lines.join("\n")}\n`, "utf8");
	return sess;
}

test("RULESKILL1-owner: default roots inventory every existing profile sessions dir", () => {
	const f = makeOwnerFixture("skill-mine-owner-profiles");
	expect(defaultOwnerSessionsRoots(join(f.root, "no-home-here"))).toEqual([]);
	writeProfileJournal(f.home, "claude", "-Developer-cfs", "a.jsonl", [userLine("claude words")]);
	writeProfileJournal(f.home, "codex", "-Developer-cfs", "b.jsonl", [userLine("codex words")]);
	writeFileSync(join(f.home, ".omp", "profiles", "stray-file"), "not a dir\n", "utf8");
	mkdirSync(join(f.home, ".omp", "profiles", "empty-profile", "agent"), { recursive: true });
	expect(defaultOwnerSessionsRoots(f.home)).toEqual([
		join(f.home, ".omp", "profiles", "claude", "agent", "sessions"),
		join(f.home, ".omp", "profiles", "codex", "agent", "sessions"),
	]);
});

test("RULESKILL1-owner: default run finds both profiles and replays the shared cursor", async () => {
	const f = makeOwnerFixture("skill-mine-owner-multiprofile");
	writeProfileJournal(f.home, "claude", "-Developer-cfs", "a.jsonl", [userLine("claude rule words")]);
	writeProfileJournal(f.home, "codex", "-Developer-cfs", "b.jsonl", [userLine("codex rule words")]);
	const { sessionsRoot: _dropped, ...rest } = f.options;
	const first = await runSkillMine({ ...rest, sources: ["owner"] });
	expect(first.overall).toBe("OK");
	expect(first.sources.owner.status).toBe("OK");
	expect(first.candidates).toHaveLength(2);
	const refs = first.candidates.map(candidate => candidate.evidence[0]!.ref).sort();
	expect(refs[0]).toContain(join(".omp", "profiles", "claude"));
	expect(refs[1]).toContain(join(".omp", "profiles", "codex"));
	const second = await runSkillMine({ ...rest, sources: ["owner"] });
	expect(second.candidates).toHaveLength(0);
	expect(sinkLines(f.sink)).toHaveLength(2);
});

function profileSessionsRoot(home: string, profile: string): string {
	return join(home, ".omp", "profiles", profile, "agent", "sessions");
}

test("RULESKILL1-owner: a profile symlink to a sibling tree is not scanned", async () => {
	const f = makeOwnerFixture("skill-mine-owner-alias");
	writeProfileJournal(f.home, "claude", "-Developer-cfs", "a.jsonl", [userLine("claude words")]);
	const foreign = join(f.root, "foreign-tree", "agent", "sessions", "-Developer-cfs");
	mkdirSync(foreign, { recursive: true });
	writeFileSync(join(foreign, "f.jsonl"), `${userLine("-fixture-foreign-")}\n`, "utf8");
	symlinkSync(join(f.root, "foreign-tree"), join(f.home, ".omp", "profiles", "foreign-link"), "dir");
	expect(defaultOwnerSessionsRoots(f.home)).toEqual([profileSessionsRoot(f.home, "claude")]);
	const { sessionsRoot: _droppedAlias, ...rest } = f.options;
	const report = await runSkillMine({ ...rest, sources: ["owner"] });
	expect(report.sources.owner.status).toBe("OK");
	expect(report.sources.owner.reason).toContain("scanned 1 file(s)");
	expect(report.candidates).toHaveLength(1);
	expect(report.candidates.every(candidate => !candidate.evidence[0]!.ref.includes("foreign"))).toBe(true);
});

test("RULESKILL1-owner: nested symlinked dir and file are not scanned", () => {
	const f = makeOwnerFixture("skill-mine-owner-nested");
	writeProfileJournal(f.home, "claude", "-Developer-cfs", "a.jsonl", [userLine("real words")]);
	const slugDir = join(profileSessionsRoot(f.home, "claude"), "-Developer-cfs");
	const elsewhere = join(f.root, "elsewhere");
	mkdirSync(elsewhere, { recursive: true });
	writeFileSync(join(elsewhere, "e.jsonl"), `${userLine("nested foreign words")}\n`, "utf8");
	symlinkSync(elsewhere, join(slugDir, "linked-dir"), "dir");
	symlinkSync(join(elsewhere, "e.jsonl"), join(slugDir, "linked-file.jsonl"));
	const { rows } = scanOwnerSessions(profileSessionsRoot(f.home, "claude"), Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(rows.map(row => row.text)).toEqual(["real words"]);
});

test("RULESKILL1-owner: a symlink loop terminates without scanning", () => {
	const f = makeOwnerFixture("skill-mine-owner-loop");
	writeProfileJournal(f.home, "claude", "-Developer-cfs", "a.jsonl", [userLine("loop real words")]);
	const slugDir = join(profileSessionsRoot(f.home, "claude"), "-Developer-cfs");
	symlinkSync(slugDir, join(slugDir, "loop"), "dir");
	const { rows } = scanOwnerSessions(profileSessionsRoot(f.home, "claude"), Date.parse("2026-11-17T00:00:00Z"), null, {});
	expect(rows.map(row => row.text)).toEqual(["loop real words"]);
});

test("RULESKILL1-owner: an expired wall deadline stops enumeration early", () => {
	const f = makeOwnerFixture("skill-mine-owner-deadline");
	const slugDir = join(profileSessionsRoot(f.home, "claude"), "-Developer-cfs");
	mkdirSync(slugDir, { recursive: true });
	symlinkSync(slugDir, join(slugDir, "loop"), "dir");
	const scanned = scanOwnerSessions(profileSessionsRoot(f.home, "claude"), Date.parse("2026-11-17T00:00:00Z"), null, {}, { deadlineMs: Date.now() - 1 });
	expect(scanned.stoppedEarly).toBe(true);
	expect(scanned.rows).toEqual([]);
	expect(scanned.files).toBe(0);
});
