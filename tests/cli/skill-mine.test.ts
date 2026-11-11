// SKILLMINE1 round 2: procedures only. A candidate is an ordered multi-step
// sequence (>=3 steps) recurring in >=2 sessions, an error->fix arc, a
// correction cluster, or a mail teaching thread. Single command skeletons
// never rank; kit/tool verbs are infrastructure and drop from signatures.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	clusterObservations, dedupeCandidates, fileBeads, fingerprintOf, isInfra, normalizeSkillMineSources, normalizeSkeleton,
	parseMailFile, parseSinceMs, rankClusters, readSkillMineStatus, redactedQuote, runSkillMine, skillMineBudgetShares,
	skillOverlap, stripInjected, textBlockKey, tokensOf, SKILL_MINE_GIT_BUDGET_SHARE, type SkillMineCandidate, type SkillMineOptions,
} from "../../src/skill-mine.ts";

import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

afterAll(cleanupAllOwnedTmp);

const repo = resolve(import.meta.dir, "../..");
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });

const SECRET = `ghp_${"Q".repeat(36)}`;
const COMPLAINT = `no, that's wrong, you keep missing the point: always pass the title and type, like ${SECRET}`;
const GRADER = "You are a NON-AUTHOR GRADER for one bead. Read-only review with seat isolation and verdict handoff.";

function put(path: string, content: string, mode = 0o644): void {
	mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	writeFileSync(path, content, { mode });
	if (mode === 0o755) chmodSync(path, 0o755);
}

const CASS_SH = `#!/bin/sh
here="$(dirname "$0")"
if [ "$1" = "sessions" ]; then cat "$here/../cassdata/sessions.json"; exit 0; fi
if [ "$1" = "export" ]; then cat "$here/../cassdata/exports/$(basename "$2").json"; exit 0; fi
if [ "$1" = "view" ]; then cat "$here/../cassdata/views/$(basename "$2").json"; exit 0; fi
echo "unexpected cass argv: $*" >&2; exit 2
`;

const BR_SH = `#!/bin/sh
printf '%s\\n' "$*" >> "$(dirname "$0")/../br-calls.log"
printf 'sk-test-1\\n'
`;

// Live 0.11.0 shapes: wrapped turns with toolCall content items.
const liveTurn = (role: string, content: unknown) => ({ type: "message", message: { role, content } });
const liveCall = (command: string) => ({ type: "toolCall", name: "bash", arguments: { command } });
const liveText = (text: string) => ({ type: "text", text });

const deployTriple = (call: (command: string) => unknown) => [
	call("mytool deploy --env prod"), call("mytool e2e --suite smoke"), call("mytool evidence --bead br-1"),
];
const lintFail = () => ({ role: "assistant", text: "$ mytool lint --check\nerror: rule violations, exit code 1" });
const lintFix = () => ({ role: "assistant", text: "fixed:\n$ mytool lint --strict\nexit code 0" });
const legacyCall = (command: string) => ({ role: "assistant", tool_calls: [{ name: "Bash", arguments: command }] });

interface Fixture {
	root: string; home: string; bin: string; projA: string; projB: string;
	mail: string; skills: string; sink: string; stateDir: string;
	options: SkillMineOptions;
}

function makeFixture(label: string, withCass = true): Fixture {
	const root = ownedTmp(label, { root: scratchParent }).path;
	const home = join(root, "home");
	const bin = join(root, "bin");
	const projA = join(root, "proj-a");
	const projB = join(root, "proj-b");
	mkdirSync(join(projA, ".beads"), { recursive: true });
	mkdirSync(join(projB, ".beads"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	if (withCass) put(join(bin, "cass"), CASS_SH, 0o755);
	put(join(bin, "br"), BR_SH, 0o755);

	const sessions = [
		{ source_path: "sess-a1", workspace: projA },
		{ source_path: "sess-a2", workspace: projA },
		{ source_path: "sess-b1", workspace: projB },
		{ source_path: "sess-b2", workspace: projB },
	];
	put(join(root, "cassdata", "sessions.json"), `${JSON.stringify(sessions)}\n`);
	put(join(root, "cassdata", "exports", "sess-a1.json"), `${JSON.stringify([
		{ role: "user", text: "Deploy the release and report the evidence for the bead." },
		...deployTriple(legacyCall),
		{ role: "assistant", text: GRADER },
		legacyCall("br create --title demo"),
		{ role: "user", text: COMPLAINT },
		legacyCall("git status --porcelain"),
		legacyCall("cat file.txt"),
	])}\n`);
	put(join(root, "cassdata", "exports", "sess-a2.json"), `${JSON.stringify([
		{ role: "user", text: "Grade the landed change against its original acceptance." },
		{ role: "user", text: COMPLAINT },
		legacyCall("git status"),
		legacyCall("rg pattern"),
	])}\n`);
	put(join(root, "cassdata", "exports", "sess-b1.json"), `${JSON.stringify([
		liveTurn("assistant", [liveText("deploying"), liveCall("mytool deploy --env prod")]),
		liveTurn("assistant", [liveText("testing"), liveCall("mytool e2e --suite smoke")]),
		liveTurn("assistant", [liveText("evidencing"), liveCall("mytool evidence --bead br-1")]),
		liveTurn("assistant", [liveText(GRADER)]),
		lintFail(), lintFix(),
		liveTurn("assistant", [liveText("checking"), liveCall("git status --porcelain")]),
	])}\n`);
	put(join(root, "cassdata", "exports", "sess-b2.json"), `${JSON.stringify([
		lintFail(), lintFix(),
		liveTurn("assistant", [liveText("grepping"), liveCall("rg pattern")]),
	])}\n`);

	const mail = join(root, "mail");
	const front = (id: string, subject: string, thread: string) =>
		`{"id":"${id}","from":"a","to":"b","subject":"${subject}","thread_id":"${thread}","created":"2026-11-05T10:00:00Z","project":"bravo-delta","importance":"normal","ack_required":false}`;
	put(join(mail, "projects", "bravo-delta", "messages", "2026", "11", "01__how-to__m1.md"),
		`---json ${front("m1", "How to cut a release", "t-release")} ---\nHere is the drill:\n1. Run \`br create --title x\` to file the bead.\n2. Run \`br close --reason evidence\` after landing.\n`);
	put(join(mail, "projects", "bravo-delta", "messages", "2026", "11", "02__re-how-to__m2.md"),
		`---json ${front("m2", "Re: How to cut a release", "t-release")} ---\nWorked, thanks. One addition: pass \`br close --reason evidence\` explicitly.\n`);
	put(join(mail, "projects", "bravo-delta", "messages", "2026", "11", "03__lunch__m3.md"),
		`---json ${front("m3", "lunch", "t-lunch")} ---\ntacos?\n`);
	put(join(mail, "projects", "bravo-delta", "messages", "2026", "11", "04__re-lunch__m4.md"),
		`---json ${front("m4", "Re: lunch", "t-lunch")} ---\nyes, tacos.\n`);

	const skills = join(root, "skills");
	put(join(skills, "mytool-deploy", "SKILL.md"),
		`---\nname: Mytool Deploy Loop\ndescription: mytool deploy e2e evidence loop grading lane sequence branches checks\n---\n\nDeploy loop.\n`);
	put(join(skills, "unrelated", "SKILL.md"),
		`---\nname: Unrelated Helper\ndescription: tidies temp files on weekends\n---\n\nUnrelated.\n`);

	const sink = join(root, "sink", "candidates.jsonl");
	const stateDir = join(home, ".local", "state", "omp-kit");
	const options: SkillMineOptions = {
		since: "21d", mailArchive: mail, skillsDirs: [skills], sink,
		home, pathValue: [bin, process.env.PATH ?? ""].join(delimiter), cwd: projA, stateDir, now: Date.parse("2026-11-10T00:00:00Z"),
	};
	return { root, home, bin, projA, projB, mail, skills, sink, stateDir, options };
}

function sinkLines(sink: string): string[] {
	if (!existsSync(sink)) return [];
	return readFileSync(sink, "utf8").split("\n").filter(Boolean);
}

test("SKILLMINE1: procedure shapes rank; single commands and infra never do", async () => {
	const f = makeFixture("skill-mine-rank");
	const report = await runSkillMine(f.options);
	expect(report.overall).toBe("OK");
	expect(report.sources.cass.status).toBe("OK");
	expect(report.sources.mail.status).toBe("OK");
	const workflows = report.candidates.map(candidate => candidate.workflow);
	// The deploy triple repeats cross-project (A1 legacy + B1 live) but the
	// installed skill covers it, so the shared grader text ranks first. The
	// repeated complaint and error lines cluster as text blocks too.
	expect(report.rejects.map(reject => reject.workflow)).toHaveLength(1);
	expect(report.rejects[0]!.covering_skill).toBe("Mytool Deploy Loop");
	expect(workflows).toHaveLength(6);
	expect(workflows[0]).toEqual(expect.stringContaining("non-author-grader"));
	expect(workflows).toEqual(expect.arrayContaining([
		expect.stringContaining("correction"), expect.stringContaining("recover"), expect.stringContaining("mail-cut-release"),
	]));
	expect(workflows.filter(workflow => /no-that|error-rule/.test(workflow))).toHaveLength(2);
	const [text] = report.candidates;
	expect(text!.projects).toEqual([f.projA, f.projB]);
	expect(text!.evidence[0]!.source).toBe("cass");
	expect(report.projects_with_candidates).toBe(3);
	expect(workflows.every(workflow => !/git-status|cat-file|rg-pattern/.test(workflow))).toBe(true);
	expect(report.coverage.sessions_in_window).toBe(4);
	expect(report.coverage.sessions_mined).toBe(4);
	expect(report.coverage.list_truncated).toBe(false);
});

test("SKILLMINE1: infra verbs never form signatures or sequences", () => {
	expect(isInfra("git status --porcelain")).toBe(true);
	expect(isInfra("git diff --stat")).toBe(true);
	expect(isInfra("br create --title x")).toBe(true);
	expect(isInfra("omp-kit scratch new")).toBe(true);
	expect(isInfra("cat file.txt")).toBe(true);
	expect(isInfra("mytool deploy --env prod")).toBe(false);
	expect(textBlockKey("$ git status")).toBe(null);
	expect(textBlockKey("> quoted liturgy")).toBe(null);
	expect(textBlockKey("5. numbered step here")).toBe(null);
	expect(textBlockKey("tool:bash something")).toBe(null);
	expect(textBlockKey("short")).toBe(null);
	expect(textBlockKey('{"command":"x"}')).toBe(null);
	expect(typeof textBlockKey("You are a NON-AUTHOR GRADER for one bead, read-only review.")).toBe("string");
});

test("SKILLMINE1: missing cass reports UNAVAILABLE and still mines mail", async () => {
	const f = makeFixture("skill-mine-nocass", false);
	const report = await runSkillMine({ ...f.options, pathValue: join(f.root, "emptybin") });
	mkdirSync(join(f.root, "emptybin"), { recursive: true });
	expect(report.sources.cass.status).toBe("UNAVAILABLE");
	expect(report.sources.mail.status).toBe("OK");
	expect(report.overall).toBe("OK");
	expect(report.candidates.map(candidate => candidate.workflow)).toEqual(["mail-cut-release"]);
});

test("SKILLMINE1: second run appends no duplicate fingerprint", async () => {
	const f = makeFixture("skill-mine-ledger");
	const first = await runSkillMine(f.options);
	const linesAfterFirst = sinkLines(f.sink).length;
	expect(linesAfterFirst).toBe(first.candidates.length);
	expect(linesAfterFirst).toBeGreaterThan(0);
	const second = await runSkillMine(f.options);
	expect(second.candidates).toEqual([]);
	expect(sinkLines(f.sink).length).toBe(linesAfterFirst);
});

test("SKILLMINE1: secrets never reach the sink", async () => {
	const f = makeFixture("skill-mine-secret");
	await runSkillMine(f.options);
	const body = sinkLines(f.sink).join("\n");
	expect(body.includes(SECRET)).toBe(false);
});

test("SKILLMINE1: --apply files at most max-new and never re-files", async () => {
	const f = makeFixture("skill-mine-apply");
	const first = await runSkillMine({ ...f.options, apply: true, maxNew: 3 });
	// text -> proj-a, correction capped (proj-a used), arc -> proj-b; mail has no .beads dir.
	expect(first.beads_filed.length).toBe(2);
	expect(first.unfiled.length).toBe(1);
	expect(first.unfiled[0]!.candidate).toContain("correction");
	const log = readFileSync(join(f.root, "br-calls.log"), "utf8");
	expect(log.split("\n").filter(line => line.includes("SKILLCAND")).length).toBe(2);
	expect(log.includes("--acceptance-criteria")).toBe(true);
	const second = await runSkillMine({ ...f.options, apply: true, maxNew: 3 });
	expect(second.beads_filed).toEqual([]);
	expect(second.candidates).toEqual([]);
	expect(readFileSync(join(f.root, "br-calls.log"), "utf8").split("\n").filter(line => line.includes("SKILLCAND")).length).toBe(2);
});

test("SKILLMINE1: fileBeads caps one bead per project per run", async () => {
	const f = makeFixture("skill-mine-cap");
	const candidate = (workflow: string): SkillMineCandidate => ({
		workflow, summary: "s", projects: [f.projA], occurrences: 2, why_skill: "w",
		evidence: [], nearest_existing_skill: null, fingerprint: fingerprintOf(workflow), score: 1,
		first_seen: "2026-11-10T00:00:00Z",
	});
	const result = await fileBeads([candidate("alpha-proc"), candidate("beta-proc")], { ...f.options, apply: true }, 3);
	expect(result.filed.length).toBe(1);
	expect(result.unfiled.length).toBe(1);
	expect(result.unfiled[0]!.reason).toContain("max 1 bead per project per run");
});

test("SKILLMINE1: wall budget stops the pass early with coverage reported", async () => {
	const f = makeFixture("skill-mine-budget");
	const emptyMail = join(f.root, "empty-mail", "projects");
	mkdirSync(emptyMail, { recursive: true });
	const report = await runSkillMine({ ...f.options, mailArchive: join(f.root, "empty-mail"), wallBudgetS: 0 });
	expect(report.coverage.stopped_early).toBe(true);
	expect(report.coverage.sessions_mined).toBeLessThanOrEqual(1);
	expect(report.coverage.sessions_in_window).toBe(4);
});

test("SKILLMINE1: live cass 0.11.0 envelope mines through the same path", async () => {
	const f = makeFixture("skill-mine-envelope");
	// Same sessions in the live {sessions:[...]} envelope; A1/B1 share the
	// deploy triple and grader text as live turns, the complaint spans live
	// (A1) and legacy (A2) shapes. The skill-covered triple must still reject.
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify({ sessions: [
		{ path: "sess-a1", workspace: f.projA },
		{ path: "sess-a2", workspace: f.projA },
		{ path: "sess-b1", workspace: f.projB },
		{ path: "sess-b2", workspace: f.projB },
	] })}\n`);
	put(join(f.root, "cassdata", "exports", "sess-a1.json"), `${JSON.stringify([
		...deployTriple((command: string) => liveTurn("assistant", [liveText("step"), liveCall(command)])),
		liveTurn("assistant", [liveText(GRADER)]),
		liveTurn("user", [liveText(COMPLAINT)]),
	])}\n`);
	put(join(f.root, "cassdata", "exports", "sess-b1.json"), `${JSON.stringify([
		...deployTriple((command: string) => liveTurn("assistant", [liveText("step"), liveCall(command)])),
		liveTurn("assistant", [liveText(GRADER)]),
	])}\n`);
	const report = await runSkillMine(f.options);
	expect(report.sources.cass.status).toBe("OK");
	expect(report.coverage.sessions_in_window).toBe(4);
	expect(report.coverage.sessions_mined).toBe(4);
	expect(report.rejects.map(reject => reject.workflow)).toEqual([expect.stringContaining("mytool-deploy")]);
	const workflows = report.candidates.map(candidate => candidate.workflow);
	expect(workflows).toEqual(expect.arrayContaining([expect.stringContaining("non-author-grader"), expect.stringContaining("correction")]));
	expect(sinkLines(f.sink).join("\n").includes(SECRET)).toBe(false);
});

// Live 2026-11-10 pack: kit notices, goal-continuation steers and identity prompts clustered as shared text and as
// "corrections" because oversize sessions were sampled through `cass view`, whose lines carry only a role.
test("SKILLMINE2: injected custom_message turns never cluster; a human correction in the same sessions still does", async () => {
	const f = makeFixture("skill-mine-injected");
	const notice = "kit-upgrade-notice UPGRADE_NOTICE: omp-kit 0.2.110 is installed; this seat runs 0.2.109; upgrade now.\n"
		+ "At your next turn boundary, without starting new work, restart this seat yourself:";
	const steer = "<!-- Hidden continuation steer. role=user, suppressed from visible transcript. --> Continue active goal. Do not stop until the objective is done.";
	const identity = "Continue as registered BrownPrairie under /skill:omp-kit-orchestration: do not start new work before your published beads are verified.";
	const injected = (customType: string, content: string) => ({ type: "custom_message", customType, content, display: true, attribution: "agent" });
	const records = [
		{ type: "session", id: "s" },
		liveTurn("user", [liveText("Work the milestone as the builder and report evidence.")]),
		injected("kit-upgrade-notice", notice), injected("goal-continuation", steer), injected("irc", identity),
		liveTurn("assistant", [liveText("checking"), liveCall("git status --porcelain")]),
		liveTurn("user", [liveText(COMPLAINT)]),
	];
	const sessions = ["big-a.jsonl", "big-b.jsonl"].map((name, index) => {
		const path = join(f.root, "sessions", name);
		put(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
		// What live cass view returns for the same file: every record a role, the record type gone.
		put(join(f.root, "cassdata", "views", `${name}.json`), `${JSON.stringify({ lines: records.slice(1).map(record =>
			"content" in record ? { role: "user", content: record.content } : record) })}\n`);
		return { path, workspace: index === 0 ? f.projA : f.projB, size_bytes: 64 * 1024 * 1024, message_count: records.length };
	});
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify(sessions)}\n`);
	const report = await runSkillMine(f.options);
	expect(report.coverage.sessions_mined).toBe(2);
	const quoted = report.candidates.flatMap(candidate => candidate.evidence.map(evidence => JSON.stringify(evidence))).join("\n");
	expect(quoted).not.toContain("UPGRADE_NOTICE");
	expect(quoted).not.toContain("next turn boundary");
	expect(quoted).not.toContain("Hidden continuation steer");
	expect(quoted).not.toContain("Continue as registered");
	// Record #6 is the human-typed complaint (its quote is redacted: it carries the planted secret).
	const corrections = report.candidates.filter(candidate => candidate.workflow.includes("correction"));
	expect(corrections.length).toBeGreaterThan(0);
	expect(corrections.flatMap(candidate => candidate.evidence.map(evidence => evidence.ref.split("/").at(-1))))
		.toEqual(expect.arrayContaining(["big-a.jsonl#6", "big-b.jsonl#6"]));
	expect(corrections.every(candidate => candidate.evidence.every(evidence => evidence.ref.endsWith("#6")))).toBe(true);
});

test("SKILLMINE1: CLI run renders the envelope and status reads it back", async () => {
	const f = makeFixture("skill-mine-cli");
	const tmp = join(f.root, "t");
	mkdirSync(tmp, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	Object.assign(env, {
		HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root,
		PATH: [f.bin, ...env.PATH!.split(delimiter)].join(delimiter),
	});
	const out = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", "--since", "21d",
		"--mail-archive", f.mail, "--skills-dir", f.skills, "--sink", f.sink, "--json"],
		{ cwd: f.projA, env, floor_s: 30 });
	const envelope = JSON.parse(new TextDecoder().decode(out.stdout));
	expect(envelope.errors ?? []).toEqual([]);
	expect(envelope.data.overall).toBe("OK");
	expect(envelope.data.candidates.length).toBe(6);
	expect(envelope.data.rejects.length).toBe(1);
	expect(envelope.data.coverage.sessions_in_window).toBe(4);
	expect(envelope.data.coverage.sessions_mined).toBe(4);
	expect(sinkLines(f.sink).length).toBe(6);
	const status = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", "status", "--json"],
		{ cwd: f.projA, env, floor_s: 30 });
	const statusEnvelope = JSON.parse(new TextDecoder().decode(status.stdout));
	expect(statusEnvelope.data.status.configured).toBe(true);
	expect(statusEnvelope.data.status.candidates_total).toBe(6);
});

test("SKILLMINE1: CLI --apply --yes files through the consent gate", async () => {
	const f = makeFixture("skill-mine-cliapply");
	const tmp = join(f.root, "t");
	mkdirSync(tmp, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	Object.assign(env, {
		HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root,
		PATH: [f.bin, ...env.PATH!.split(delimiter)].join(delimiter),
	});
	const out = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine",
		"--mail-archive", f.mail, "--skills-dir", f.skills, "--sink", f.sink,
		"--apply", "--yes", "--max-new", "1", "--json"],
		{ cwd: f.projA, env, floor_s: 30 });
	const envelope = JSON.parse(new TextDecoder().decode(out.stdout));
	expect(envelope.errors ?? []).toEqual([]);
	expect(envelope.data.beads_filed.length).toBe(1);
});

test("SKILLMINE1: pure units for skeletons, fingerprints, mail parsing and overlap", () => {
	expect(normalizeSkeleton("$ git status --porcelain=v1")).toBe("git status --porcelain=v1");
	expect(normalizeSkeleton('deploy "/opt/a b" 42 --id abcdef1234567')).toBe("deploy <q> <n> --id <id>");
	expect(fingerprintOf("x")).toBe(fingerprintOf("x"));
	expect(fingerprintOf("x") === fingerprintOf("y")).toBe(false);
	expect(parseSinceMs("21d", 1_000_000_000_000)).toBe(1_000_000_000_000 - 21 * 86_400_000);
	expect(() => parseSinceMs("soon", 0)).toThrow();
	const inline = parseMailFile(`---json {"id":"m1","subject":"s","thread_id":"t","created":"2026-11-01T00:00:00Z","project":"p","importance":"n","ack_required":false} ---\nbody here`);
	expect(inline?.front["id"]).toBe("m1");
	expect(inline?.body).toBe("body here");
	const nested = parseMailFile(`---json\n{"a":{"b":[1,2]},"s":"x --- y"}\n---\nrest`);
	expect(nested?.front).toEqual({ a: { b: [1, 2] }, s: "x --- y" });
	expect(nested?.body).toBe("rest");
	expect(parseMailFile("no header\nbody")).toBe(null);
	expect(parseMailFile(`---json {"a":1}\nbody without end`)).toBe(null);
	const overlap = skillOverlap(tokensOf("mytool deploy e2e evidence"), { name: "Mytool Deploy Loop", description: "mytool deploy e2e evidence loop grading lane" });
	expect(overlap).toBeGreaterThanOrEqual(0.35);
	expect(skillOverlap(tokensOf("tidy temp files weekends"), { name: "Mytool Deploy Loop", description: "mytool deploy e2e evidence loop grading lane" })).toBe(0);
	expect(redactedQuote(`leaked ${SECRET} here`).includes(SECRET)).toBe(false);
});

test("SKILLMINE1: rank keeps procedures and corrections, drops lone sequences", () => {
	const nowISO = "2026-11-10T00:00:00Z";
	const lone = clusterObservations([{
		kind: "sequence", signature: "seq:a > b > c", workflow: "seq-a-b-c", summary: "s",
		project: "p", session: "s1", ref: "s1#0", quote: "q", recent: true,
	}]);
	expect(rankClusters(lone, new Map(), nowISO).candidates).toEqual([]);
	const pair = clusterObservations([
		{
			kind: "sequence", signature: "seq:a > b > c", workflow: "seq-a-b-c", summary: "s",
			project: "p", session: "s1", ref: "s1#0", quote: "q", recent: true,
		},
		{
			kind: "sequence", signature: "seq:a > b > c", workflow: "seq-a-b-c", summary: "s",
			project: "q", session: "s2", ref: "s2#0", quote: "q", recent: true,
		},
	]);
	const kept = rankClusters(pair, new Map(), nowISO).candidates;
	expect(kept.length).toBe(1);
	expect(kept[0]!.score).toBeGreaterThan(0);
	const { kept: deduped, rejects } = dedupeCandidates(kept,
		[{ name: "Unrelated", description: "tidies temp files" }]);
	expect(deduped.length).toBe(1);
	expect(rejects).toEqual([]);
});

const PAGED_CASS_SH = `#!/bin/sh
here="$(dirname "$0")"
ws=""
prev=""
for a in "$@"; do
	if [ "$prev" = "--workspace" ]; then ws="$(basename "$a")"; fi
	prev="$a"
done
if [ "$1" = "sessions" ]; then
	if [ -n "$ws" ]; then cat "$here/../cassdata/sessions-$ws.json"; else cat "$here/../cassdata/sessions.json"; fi
	exit 0
fi
if [ "$1" = "export" ]; then cat "$here/../cassdata/exports/$(basename "$2").json"; exit 0; fi
echo "unexpected cass argv: $*" >&2; exit 2
`;

test("SKILLMINE1: paging merges per-workspace lists past the page cap", async () => {
	const root = ownedTmp("skill-mine-paging", { root: scratchParent }).path;
	const home = join(root, "home");
	const bin = join(root, "bin");
	const projA = join(root, "proj-a");
	const projB = join(root, "proj-b");
	mkdirSync(join(projA, ".beads"), { recursive: true });
	mkdirSync(join(projB, ".beads"), { recursive: true });
	mkdirSync(bin, { recursive: true });
	put(join(bin, "cass"), PAGED_CASS_SH, 0o755);
	const tripleJson = `${JSON.stringify([
		{ role: "assistant", tool_calls: [{ name: "Bash", arguments: "mytool alpha" }] },
		{ role: "assistant", tool_calls: [{ name: "Bash", arguments: "mytool beta" }] },
		{ role: "assistant", tool_calls: [{ name: "Bash", arguments: "mytool gamma" }] },
	])}\n`;
	const row = (name: string, workspace: string) => ({ source_path: name, workspace });
	const primary: unknown[] = [];
	const aRows: unknown[] = [];
	const bRows: unknown[] = [];
	for (let i = 1; i <= 20; i++) {
		const name = `a${String(i).padStart(2, "0")}`;
		primary.push(row(name, projA)); aRows.push(row(name, projA));
		put(join(root, "cassdata", "exports", `${name}.json`), tripleJson);
	}
	for (let i = 1; i <= 5; i++) {
		const name = `b${String(i).padStart(2, "0")}`;
		primary.push(row(name, projB)); bRows.push(row(name, projB));
		put(join(root, "cassdata", "exports", `${name}.json`), tripleJson);
	}
	for (let i = 1; i <= 4975; i++) {
		const name = `fill-${String(i).padStart(4, "0")}`;
		primary.push(row(name, projA)); aRows.push(row(name, projA));
	}
	for (let i = 6; i <= 10; i++) {
		const name = `b${String(i).padStart(2, "0")}`;
		bRows.push(row(name, projB));
		put(join(root, "cassdata", "exports", `${name}.json`), tripleJson);
	}
	put(join(root, "cassdata", "sessions.json"), `${JSON.stringify(primary.slice(0, 5000))}\n`);
	put(join(root, "cassdata", "sessions-proj-a.json"), `${JSON.stringify(aRows)}\n`);
	put(join(root, "cassdata", "sessions-proj-b.json"), `${JSON.stringify(bRows)}\n`);
	const stateDir = join(home, ".local", "state", "omp-kit");
	const report = await runSkillMine({
		since: "21d", mailArchive: join(root, "empty-mail"), skillsDirs: [join(root, "no-skills")],
		sink: join(root, "sink", "candidates.jsonl"),
		home, pathValue: [bin, process.env.PATH ?? ""].join(delimiter), cwd: projA, stateDir,
		now: Date.parse("2026-11-10T00:00:00Z"),
	});
	if (report.sources.cass.status !== "OK") throw new Error(`cass failed: ${report.sources.cass.reason}`);
	// 5010 rows in window, visible only via the per-workspace merge.
	expect(report.coverage.sessions_in_window).toBe(5005);
	expect(report.coverage.list_truncated).toBe(true);
	expect(report.coverage.sessions_mined).toBe(30);
	const seq = report.candidates.find(candidate => candidate.projects.includes(projA) && candidate.projects.includes(projB));
	expect(seq?.occurrences).toBe(30);
});

test("SKILLMINE1: boilerplate discount drops dispatch templates and seat text", () => {
	const nowISO = "2026-11-10T00:00:00Z";
	const block = (session: string, project: string, firstUser: boolean) => ({
		kind: "text-block" as const, signature: "text:do the thing", workflow: "do-the-thing",
		summary: "s", project, session, ref: `${session}#0`, quote: "q", recent: true, firstUser,
	});
	const firstUserWide = clusterObservations([
		block("s1", "/repo/a", true), block("s2", "/repo/b", true), block("s3", "/repo/c", true),
	]);
	expect(rankClusters(firstUserWide, new Map(), nowISO).candidates).toEqual([]);
	const narrow = clusterObservations([block("s1", "/repo/a", true), block("s2", "/repo/b", true)]);
	expect(rankClusters(narrow, new Map(), nowISO).candidates).toHaveLength(1);
	const seats = clusterObservations([
		block("s1", "/w/var/agent-tmp/seat.1/a", false), block("s2", "/w/var/agent-tmp/seat.2/b", false),
		block("s3", "/w/var/agent-tmp/seat.3/c", false), block("s4", "/w/var/agent-tmp/seat.4/d", false),
	]);
	expect(rankClusters(seats, new Map(), nowISO).candidates).toEqual([]);
	const pair = clusterObservations([
		block("s1", "/w/var/agent-tmp/seat.1/a", false), block("s2", "/w/var/agent-tmp/seat.2/b", false),
	]);
	expect(rankClusters(pair, new Map(), nowISO).candidates).toHaveLength(1);
	const solo = rankClusters(clusterObservations([
		block("s1", "/repo/a", false), block("s2", "/repo/a", false),
	]), new Map(), nowISO).candidates;
	const spread = rankClusters(clusterObservations([
		block("s1", "/repo/a", false), block("s2", "/repo/b", false),
	]), new Map(), nowISO).candidates;
	expect(solo).toHaveLength(1);
	expect(spread).toHaveLength(1);
	expect(solo[0]!.score).toBeLessThan(spread[0]!.score);
});

test("SKILLMINE1: evidence pack is bounded and names refs", async () => {
	const f = makeFixture("skill-mine-pack");
	const report = await runSkillMine(f.options);
	expect(typeof report.pack).toBe("string");
	expect(report.pack.endsWith(".md")).toBe(true);
	const body = readFileSync(report.pack, "utf8");
	expect(body.length).toBeGreaterThan(100);
	expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(60 * 1024);
	expect(body).toContain("## Correction clusters");
	expect(body).toContain("evidence:");
	expect(body.includes("sess-a1#") || body.includes("bravo-delta:")).toBe(true);
	// Planted: a second run sees every fingerprint already recorded, yet its pack still carries the current clusters
	// (the judging agent's daily read), while its sink rows and --apply stay limited to never-seen fingerprints.
	const second = await runSkillMine(f.options);
	expect(second.candidates).toHaveLength(0);
	expect(readFileSync(second.pack, "utf8")).toContain("## Correction clusters");
});

test("SKILLMINE1: masked stub lines never form text blocks", () => {
	expect(textBlockKey('"averylongquotedstringvaluethatislong"')).toBe(null);
	expect(textBlockKey("id: 01a18ccb7da07214b51bde1a4b4bf039")).toBe(null);
	expect(textBlockKey("/Users/josh/Developer/omp-kit-companion")).toBe(null);
	expect(typeof textBlockKey("session id opened for the bead review wave")).toBe("string");
});

// SKILLMINE1 live noise (2026-11-10 smoke): harness render lines, injected reminders and file dumps are not anyone's
// procedure text, and they dominated the first live pack.
test("SKILLMINE1: harness render lines and injected blocks never become evidence", () => {
	for (const line of ["→ read(/a/b.ts:1-9) ⇒ ok · 9 lines", "Ran in a temporary shell while the session shell is busy",
		"Active phase 1/4 \"Red main (stop sign)\" (0/2).", "[Skill file: /a/SKILL.md] # Title of the skill", "### Session update **agent**: thinking"])
		expect(textBlockKey(line), line).toBe(null);
	expect(typeof textBlockKey("Run the gate before landing the release candidate")).toBe("string");
	expect(stripInjected("keep this <system-reminder>drop the reminder</system-reminder> and this")).toBe("keep this  and this");
	expect(stripInjected("a <files>\n# x\n</files>b <system-notice>n</system-notice>c")).toBe("a b c");
	expect(stripInjected("an unclosed <system-reminder>drops the rest")).toBe("an unclosed ");
	expect(stripInjected("<filesystem> is not a tag we strip")).toBe("<filesystem> is not a tag we strip");
	expect(stripInjected("x".repeat(40_000) + "<irc")).toBe("x".repeat(40_000) + "<irc");
});

// SKILLMINE3: every listed session is either seen or counted under exactly one
// drop reason, so sessions_in_window equals sessions_seen plus all drop counts.
test("SKILLMINE3: caps, sidecar, missing path and project filter all count and add up", async () => {
	const f = makeFixture("skill-mine-drops");
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify([
		{ source_path: "sess-a1", workspace: f.projA },
		{ source_path: "sess-a2", workspace: f.projA },
		{ source_path: "sess-a3", workspace: f.projA },
		{ source_path: "sessions/__advisor.helper.jsonl", workspace: f.projA },
		{ workspace: f.projA },
		{ source_path: "sess-b1", workspace: f.projB },
		{ source_path: "sess-b2", workspace: f.projB },
		{ source_path: "sess-c1", workspace: "/filtered-out/proj-c" },
	])}\n`);
	const report = await runSkillMine({
		...f.options, projects: [f.projA, f.projB], sessionCap: 3, perProjectCap: 2,
	});
	const c = report.coverage;
	expect(c.sessions_in_window).toBe(8);
	expect(c.sessions_mined).toBe(3);
	expect(c.sessions_seen).toBe(3);
	expect(c.project_filtered).toBe(1);
	expect(c.advisor_sidecar).toBe(1);
	expect(c.no_path).toBe(1);
	expect(c.per_project_cap).toBe(1);
	expect(c.session_cap).toBe(1);
	expect(c.not_reached).toBe(0);
	expect(c.sessions_seen + c.project_filtered + c.no_path + c.advisor_sidecar + c.per_project_cap + c.session_cap + c.not_reached).toBe(c.sessions_in_window);
	const reason = report.sources.cass.reason;
	expect(reason).toContain("1 filtered by project");
	expect(reason).toContain("1 without a session path");
	expect(reason).toContain("1 advisor sidecar(s)");
	expect(reason).toContain("1 over the per-project cap");
	expect(reason).toContain("1 over the session cap");
});

test("SKILLMINE3: wall budget exhaustion counts picked-but-unvisited sessions and still adds up", async () => {
	const f = makeFixture("skill-mine-notreached");
	const emptyMail = join(f.root, "empty-mail", "projects");
	mkdirSync(emptyMail, { recursive: true });
	const report = await runSkillMine({ ...f.options, mailArchive: join(f.root, "empty-mail"), wallBudgetS: 0 });
	const c = report.coverage;
	expect(c.stopped_early).toBe(true);
	expect(c.not_reached).toBeGreaterThanOrEqual(3);
	expect(c.sessions_seen + c.project_filtered + c.no_path + c.advisor_sidecar + c.per_project_cap + c.session_cap + c.not_reached).toBe(c.sessions_in_window);
	expect(report.sources.cass.reason).toContain("wall budget");
});

// SKILLMINEGIT1: the Git source admits failure -> correction -> outcome chains
// git can prove (sha-named fixes, revert pairs of either message form,
// break-word-follows as weak links), then emits one candidate per recurring
// shape (3+ strong chains in one repository, or chains in 2+ repositories).
// Aliases of one repository are mined once; per-repository month cursors plus
// persisted chains let a later run complete a cluster and continue; a removed
// cursor re-mines month one.
interface GitFixture extends Fixture {
	gitA: string;
	gitB: string;
}

function gitEnvFor(f: Fixture): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	mkdirSync(join(f.root, "t"), { recursive: true });
	return {
		...env, HOME: f.home, TMPDIR: join(f.root, "t"), GIT_CEILING_DIRECTORIES: f.root,
		GIT_AUTHOR_NAME: "Skill Mine", GIT_AUTHOR_EMAIL: "skill-mine@example.com",
		GIT_COMMITTER_NAME: "Skill Mine", GIT_COMMITTER_EMAIL: "skill-mine@example.com",
	};
}

function gitCommit(dir: string, env: Record<string, string>, files: Record<string, string>, subject: string, date: string, body?: string): void {
	for (const [rel, content] of Object.entries(files)) put(join(dir, rel), content);
	const add = runFixture(["git", "add", "-A"], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect(add.rc).toBe(0);
	const dated = { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
	const committed = runFixture(["git", "-c", "user.name=Skill Mine", "-c", "user.email=skill-mine@example.com",
		"commit", "--no-gpg-sign", "-m", subject, ...(body ? ["-m", body] : [])], { cwd: dir, env: dated, floor_s: fixtureDeadlineS() });
	expect(committed.rc).toBe(0);
}

function gitHead(dir: string, env: Record<string, string>): string {
	const rev = runFixture(["git", "rev-parse", "HEAD"], { cwd: dir, env, floor_s: fixtureDeadlineS() });
	expect(rev.rc).toBe(0);
	return new TextDecoder().decode(rev.stdout).trim();
}

function makeGitFixture(label: string, kind: "recurrence" | "cursor"): GitFixture {
	const f = makeFixture(label);
	const env = gitEnvFor(f);
	const gitA = join(f.root, "git-a");
	const gitB = join(f.root, "git-b");
	for (const dir of [gitA, gitB]) {
		mkdirSync(dir, { recursive: true });
		const init = runFixture(["git", "init", "-b", "main", "-q", dir], { cwd: f.root, env, floor_s: fixtureDeadlineS() });
		expect(init.rc).toBe(0);
	}
	mkdirSync(join(gitA, ".beads"), { recursive: true });
	if (kind === "recurrence") {
		// Three sha-named fix chains on the same file svc/cart.ts.
		gitCommit(gitA, env, { "svc/cart.ts": "total v1\n" }, "break cart total", "2026-10-05T12:00:00Z");
		gitCommit(gitA, env, { "svc/cart.ts": "total v2\n" }, "fix(cart): total rounding", "2026-10-06T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		gitCommit(gitA, env, { "svc/cart.ts": "coupon v1\n" }, "break cart coupon", "2026-10-07T12:00:00Z");
		gitCommit(gitA, env, { "svc/cart.ts": "coupon v2\n" }, "fix(cart): coupon stacking", "2026-10-08T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		gitCommit(gitA, env, { "svc/cart.ts": "tax v1\n" }, "break cart tax", "2026-10-09T12:00:00Z");
		gitCommit(gitA, env, { "svc/cart.ts": "tax v2\n" }, "fix(cart): tax rounding", "2026-10-10T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		// A conventional-commit revert pair (admitted as one chain, but a
		// single chain is not a candidate).
		gitCommit(gitA, env, { "svc/auth.ts": "redirect v1\n" }, "feat(auth): login redirect", "2026-10-11T12:00:00Z");
		const original = gitHead(gitA, env);
		gitCommit(gitA, env, { "svc/auth.ts": "redirect v2\n" }, "revert(auth): login redirect loop", "2026-10-12T12:00:00Z", `Revert: ${original}`);
		gitCommit(gitA, env, { "svc/auth.ts": "redirect v3\n" }, "feat(auth): re-land login redirect with guard", "2026-10-13T12:00:00Z");
		// A break-word-only pair with a unique path shape (weak, single repo:
		// admitted, never a candidate).
		gitCommit(gitA, env, { "svc/search.ts": "index v1\n" }, "break search cache", "2026-10-14T12:00:00Z");
		gitCommit(gitA, env, { "svc/search.ts": "index v2\n" }, "fix search cache TTL", "2026-10-15T12:00:00Z");
		// A break-word-only pair on scope `pay`, recurring in repo B.
		gitCommit(gitA, env, { "svc/pay.ts": "pay v1\n" }, "break pay flow", "2026-10-16T12:00:00Z");
		gitCommit(gitA, env, { "svc/pay.ts": "pay v2\n" }, "fix(pay): flow guard", "2026-10-17T12:00:00Z");
		// November: a credential-tainted break plus a clean fix on the same
		// path. The tainted endpoint is dropped, so the fix links to nothing.
		gitCommit(gitA, env, { "svc/pay2.ts": "pay v1\n" }, `break pay flow ${SECRET}`, "2026-11-04T12:00:00Z");
		gitCommit(gitA, env, { "svc/pay2.ts": "pay v2\n" }, "fix(pay): flow guard 2", "2026-11-05T12:00:00Z");
		// Repo B, October: the same `pay.ts` basename and remedy (cross-repo
		// recurrence), plus a conventional revert whose body names the sha
		// without a trailer.
		gitCommit(gitB, env, { "svc/pay.ts": "ledger v1\n" }, "break pay ledger", "2026-10-16T12:00:00Z");
		gitCommit(gitB, env, { "svc/pay.ts": "ledger v2\n" }, "fix(pay): ledger guard", "2026-10-17T12:00:00Z");
		gitCommit(gitB, env, { "svc/x.ts": "x v1\n" }, "break ledger flow", "2026-10-18T12:00:00Z");
		const flowBroken = gitHead(gitB, env);
		gitCommit(gitB, env, { "svc/x.ts": "x v2\n" }, "revert: ledger flow", "2026-10-19T12:00:00Z", `Backs out ${flowBroken}, it broke the flow.`);
		// An unrelated shallow entry (repo B's tip, not an ancestor of repo
		// A's HEAD) must not change mining: the flag alone is never a cut.
		put(join(gitA, ".git", "shallow"), `${gitHead(gitB, env)}\n`);
	} else {
		// Two sha-named `dock` chains in October, the third in November: the
		// cluster completes across runs (all on svc/dock.ts).
		gitCommit(gitA, env, { "svc/dock.ts": "a v1\n" }, "break dock pump a", "2026-10-05T12:00:00Z");
		gitCommit(gitA, env, { "svc/dock.ts": "a v2\n" }, "fix(dock): pump a guard", "2026-10-06T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		gitCommit(gitA, env, { "svc/dock.ts": "b v1\n" }, "break dock pump b", "2026-10-07T12:00:00Z");
		gitCommit(gitA, env, { "svc/dock.ts": "b v2\n" }, "fix(dock): pump b guard", "2026-10-08T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		gitCommit(gitA, env, { "svc/dock.ts": "c v1\n" }, "break dock pump c", "2026-11-03T12:00:00Z");
		gitCommit(gitA, env, { "svc/dock.ts": "c v2\n" }, "fix(dock): pump c guard", "2026-11-04T12:00:00Z", `Fixes ${gitHead(gitA, env)}.`);
		// Repo B stays chain-free so the cursor covers two repositories. Its
		// shallow file names a real ancestor: the boundary cuts the walk, is
		// reported, but months still mine.
		gitCommit(gitB, env, { "README.md": "base\n" }, "docs: readme base", "2026-10-01T12:00:00Z");
		const boundary = gitHead(gitB, env);
		gitCommit(gitB, env, { "README.md": "docs\n" }, "docs: readme touch", "2026-10-05T12:00:00Z");
		put(join(gitB, ".git", "shallow"), `${boundary}\n`);
	}
	// Alias: a symlink to repo A resolves to the same canonical repository.
	symlinkSync(gitA, join(f.root, "alias-a"));
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify([
		{ source_path: "sess-git-a", workspace: gitA },
		{ source_path: "sess-git-alias", workspace: join(f.root, "alias-a") },
		{ source_path: "sess-git-b", workspace: gitB },
	])}\n`);
	for (const sess of ["sess-git-a", "sess-git-alias", "sess-git-b"]) {
		put(join(f.root, "cassdata", "exports", `${sess}.json`), `${JSON.stringify([{ role: "user", text: "hello" }])}\n`);
	}
	return { ...f, gitA, gitB };
}

function gitCandidatesOf(report: { candidates: SkillMineCandidate[] }): SkillMineCandidate[] {
	return report.candidates.filter(candidate => candidate.evidence.some(e => e.source === "git"));
}

test("SKILLMINEGIT1: recurring fix shapes yield one candidate per cluster with provenance", async () => {
	const f = makeGitFixture("skill-mine-git", "recurrence");
	const emptyMail = join(f.root, "empty-mail", "projects");
	mkdirSync(emptyMail, { recursive: true });
	const report = await runSkillMine({
		...f.options, since: "2026-10-01T00:00:00Z", mailArchive: join(f.root, "empty-mail"),
		apply: true, maxNew: 3,
	});
	expect(report.sources.git.status).toBe("OK");
	// The unrelated shallow entry is not an ancestor: no cut is reported.
	expect(report.sources.git.reason).not.toContain("shallow");
	const git = report.coverage.git;
	expect(git.repos).toBe(2);
	expect(git.chains).toBe(8);
	expect(git.chains_seen).toBe(8);
	expect(git.chains_unclustered).toBe(3);
	expect(git.dropped_not_a_repo).toBe(1);
	expect(git.dropped_credentials).toBe(1);
	const workflows = gitCandidatesOf(report).map(candidate => candidate.workflow).sort();
	expect(workflows).toEqual(["git-recurrence-pay-ts-pay", "git-recurrence-svc-cart-ts"]);
	const cart = gitCandidatesOf(report).find(candidate => candidate.workflow === "git-recurrence-svc-cart-ts")!;
	expect(cart.kind).toBe("git-recurrence");
	expect(cart.projects).toEqual([f.gitA]);
	expect(cart.occurrences).toBe(3);
	expect(cart.months).toEqual(["2026-10"]);
	expect(cart.evidence).toHaveLength(3);
	for (const evidence of cart.evidence) {
		expect(evidence.ref).toMatch(/^git:/);
		expect(evidence.ref).toContain(f.gitA);
		expect(evidence.ref).toMatch(/[0-9a-f]{7}$/);
		expect(evidence.quote).toContain("fix(cart)");
	}
	const pay = gitCandidatesOf(report).find(candidate => candidate.workflow === "git-recurrence-pay-ts-pay")!;
	expect(pay.kind).toBe("git-recurrence");
	expect(pay.projects).toEqual([f.gitA, f.gitB].sort());
	expect(pay.occurrences).toBe(2);
	expect(pay.months).toEqual(["2026-10"]);
	// Planted negatives: the lone conventional revert pair, the lone
	// break-word pair and the bare-sha revert pair are admitted chains, not
	// candidates — and no secret reaches the sink.
	for (const candidate of report.candidates) {
		expect(JSON.stringify(candidate)).not.toContain("search cache");
		expect(JSON.stringify(candidate)).not.toContain("login redirect");
		expect(JSON.stringify(candidate)).not.toContain("revert: ledger flow");
	}
	expect(sinkLines(f.sink).join("\n")).not.toContain(SECRET);
	const status = readSkillMineStatus(f.stateDir);
	expect(status.sources?.git.status).toBe("OK");
	expect(status.git?.repos).toBe(2);
	expect(status.git?.chains_seen).toBe(8);
	expect(status.git?.chains_unclustered).toBe(3);
	expect(Object.keys(status.git?.repos_detail ?? {}).sort()).toEqual([f.gitA, f.gitB].sort());
	// Git recurrence packets are evidence for judgement: --apply skips them
	// with a count in the report, and no bead is filed anywhere.
	expect(report.beads_filed).toEqual([]);
	expect(report.unfiled.map(row => row.candidate).sort()).toEqual(["git-recurrence-pay-ts-pay", "git-recurrence-svc-cart-ts"]);
	for (const row of report.unfiled) {
		expect(row.reason).toContain("never auto-filed");
	}
	expect(existsSync(join(f.root, "br-calls.log"))).toBe(false);
});

test("SKILLMINEGIT1-cursor: a cluster completes across monthly runs", async () => {
	const f = makeGitFixture("skill-mine-git-cursor", "cursor");
	const opts: SkillMineOptions = { ...f.options, since: "2026-10-01T00:00:00Z", gitMonthsPerRun: 1 };
	const first = await runSkillMine(opts);
	expect(first.coverage.git.months_mined).toEqual(["2026-10"]);
	// The shallow boundary in repo B cuts its walk: reported, but months still mine.
	expect(first.sources.git.reason).toContain("shallow boundary");
	expect(gitCandidatesOf(first)).toEqual([]);
	expect(first.coverage.git.chains_seen).toBe(2);
	expect(first.coverage.git.chains_unclustered).toBe(2);
	const status1 = readSkillMineStatus(f.stateDir);
	expect(status1.git?.repos_detail[f.gitA]?.months_mined).toEqual(["2026-10"]);
	expect(status1.git?.months_remaining).toBe(2);
	expect(status1.git?.chains_seen).toBe(2);
	// The third `dock` chain lands in November and completes the cluster.
	const second = await runSkillMine(opts);
	expect(second.coverage.git.months_mined).toEqual(["2026-11"]);
	const dock = gitCandidatesOf(second).map(candidate => candidate.workflow);
	expect(dock).toEqual(["git-recurrence-svc-dock-ts"]);
	expect(gitCandidatesOf(second)[0]!.occurrences).toBe(3);
	expect(gitCandidatesOf(second)[0]!.months).toEqual(["2026-10", "2026-11"]);
	const status2 = readSkillMineStatus(f.stateDir);
	expect(status2.git?.months_remaining).toBe(0);
	expect(status2.git?.chains_seen).toBe(3);
	expect(status2.git?.repos_detail[f.gitA]?.months_mined).toEqual(["2026-10", "2026-11"]);
	// Planted negative: with the cursor file removed, the next run re-mines month one.
	rmSync(join(f.stateDir, "skill-mine", "git-cursors.json"));
	const third = await runSkillMine(opts);
	expect(third.coverage.git.months_mined).toEqual(["2026-10"]);
	expect(gitCandidatesOf(third)).toEqual([]);
	expect(readSkillMineStatus(f.stateDir).git?.repos_detail[f.gitA]?.months_mined).toEqual(["2026-10"]);
});

function makeSplitFixture(label: string): GitFixture {
	const f = makeFixture(label);
	const env = gitEnvFor(f);
	const gitS = join(f.root, "git-s");
	mkdirSync(gitS, { recursive: true });
	const init = runFixture(["git", "init", "-b", "main", "-q", gitS], { cwd: f.root, env, floor_s: fixtureDeadlineS() });
	expect(init.rc).toBe(0);
	gitCommit(gitS, env, { "README.md": "base\n" }, "docs: split base", "2026-10-01T12:00:00Z");
	const pad = (subject: string): string => `${subject} ${"padding ".repeat(18)}`;
	gitCommit(gitS, env, { "svc/widget.ts": "w1\n" }, pad("break widget flow"), "2026-11-03T12:00:00Z");
	gitCommit(gitS, env, { "svc/widget.ts": "w2\n" }, pad("fix(widget): guard widget flow"), "2026-11-04T12:00:00Z", `Fixes ${gitHead(gitS, env)}.`);
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify([{ source_path: "sess-split", workspace: gitS }])}\n`);
	put(join(f.root, "cassdata", "exports", "sess-split.json"), `${JSON.stringify([{ role: "user", text: "hello" }])}\n`);
	return { ...f, gitA: gitS, gitB: join(f.root, "git-unused") };
}

test("SKILLMINEGIT1: an over-cap month splits and mines every commit", async () => {
	const f = makeSplitFixture("skill-mine-git-split");
	const report = await runSkillMine({ ...f.options, since: "2026-10-01T00:00:00Z", gitLogBytesCap: 400 });
	expect(report.sources.git.status).toBe("OK");
	expect(report.coverage.git.months_mined).toEqual(["2026-10", "2026-11"]);
	expect(report.coverage.git.dropped_errors).toBe(0);
	expect(report.coverage.git.chains).toBe(1);
	expect(gitCandidatesOf(report)).toEqual([]);
});

test("SKILLMINEGIT1: with splitting disabled an over-cap month errors and the cursor stays", async () => {
	const f = makeSplitFixture("skill-mine-git-nosplit");
	const report = await runSkillMine({ ...f.options, since: "2026-10-01T00:00:00Z", gitLogBytesCap: 400, gitNoSplit: true });
	expect(report.sources.git.status).toBe("OK");
	expect(report.coverage.git.months_mined).toEqual(["2026-10"]);
	expect(report.coverage.git.dropped_errors).toBe(1);
	expect(report.coverage.git.chains).toBe(0);
	expect(readSkillMineStatus(f.stateDir).git?.repos_detail[f.gitA]?.months_mined).toEqual(["2026-10"]);
});

// SKILLMINEFAIR1: one wall budget shared by every source starved Git. On a
// 365d window a long cass pass consumed the whole budget, so Git mined 0 of
// 24 months while cass produced candidates. Each enabled source now gets a
// reserved share of the wall budget (Git keeps at least 40%) enforced by
// cumulative deadlines, unused time flows forward, and --source limits the
// pass. Planted negative: the old shared deadline mines 0 Git months here.
const SLOW_CASS_SH = `#!/bin/sh
here="$(dirname "$0")"
if [ "$1" = "sessions" ]; then cat "$here/../cassdata/sessions.json"; exit 0; fi
if [ "$1" = "export" ]; then sleep 3; cat "$here/../cassdata/exports/$(basename "$2").json"; exit 0; fi
if [ "$1" = "view" ]; then cat "$here/../cassdata/views/$(basename "$2").json"; exit 0; fi
echo "unexpected cass argv: $*" >&2; exit 2
`;

/** Recurrence repos with a cass shim whose exports each burn 3 s of budget. */
function makeSlowGitFixture(label: string): GitFixture {
	const f = makeGitFixture(label, "recurrence");
	put(join(f.bin, "cass"), SLOW_CASS_SH, 0o755);
	return f;
}

test("SKILLMINEFAIR1: a slow cass pass cannot starve Git of its reserved share", async () => {
	const f = makeSlowGitFixture("skill-mine-fair-share");
	// Two 3 s exports need 6 s; the 5 s budget fits one share but never the
	// whole pass, so the old shared deadline would leave Git 0 months. With
	// per-call clamping (Fix A) the first 3 s export is killed at the ~1.5 s
	// cass share, so nothing is mined and Git still gets its months.
	const report = await runSkillMine({
		...f.options, since: "365d", projects: [f.gitA, f.gitB],
		wallBudgetS: 5, gitMonthsPerRun: 2,
	});
	expect(report.overall).toBe("OK");
	expect(report.sources.cass.status).toBe("OK");
	// The slow cass pass hit its own share and stopped; it never reached Git.
	expect(report.coverage.stopped_early).toBe(true);
	expect(report.coverage.sessions_mined).toBe(0);
	expect(report.coverage.git.repos).toBe(2);
	expect(report.coverage.git.months_mined).toEqual(["2025-12", "2026-01"]);
	expect(report.coverage.git.repos_detail[f.gitA]?.months_mined).toEqual(["2025-12", "2026-01"]);
	expect(report.coverage.git.repos_detail[f.gitB]?.months_mined).toEqual(["2025-12", "2026-01"]);
	expect(report.coverage.git.stopped_early).toBe(false);
	// Per-source elapsed and budget are reported in coverage and on sources.
	expect(report.coverage.budgets.cass.budget_ms).toBe(1500);
	expect(report.coverage.budgets.mail.budget_ms).toBe(1500);
	expect(report.coverage.budgets.git.budget_ms).toBe(2000);
	expect(report.coverage.budgets.cass.elapsed_ms).toBeGreaterThan(1500);
	expect(report.coverage.budgets.git.elapsed_ms).toBeGreaterThan(0);
	expect(report.sources.git.elapsed_ms).toBe(report.coverage.budgets.git.elapsed_ms);
	expect(report.sources.git.budget_ms).toBe(2000);
}, fixtureDeadlineS() * 1000);

test("SKILLMINEFAIR1: --source git skips cass and mail entirely", async () => {
	const f = makeSlowGitFixture("skill-mine-fair-gitonly");
	const report = await runSkillMine({
		...f.options, since: "365d", sources: ["git"], projects: [f.gitA, f.gitB],
		wallBudgetS: 30, gitMonthsPerRun: 1,
	});
	expect(report.overall).toBe("OK");
	expect(report.coverage.sessions_in_window).toBe(0);
	expect(report.sources.cass.reason).toContain("skipped by --source git");
	expect(report.sources.mail.reason).toContain("skipped by --source git");
	expect(report.coverage.git.repos).toBe(2);
	expect(report.coverage.git.months_mined).toEqual(["2025-12"]);
	expect(report.coverage.git.repos_detail[f.gitA]?.months_mined).toEqual(["2025-12"]);
	expect(report.coverage.git.repos_detail[f.gitB]?.months_mined).toEqual(["2025-12"]);
	// The skipped sources spent nothing and reserved nothing; Git got it all.
	expect(report.coverage.budgets.cass).toEqual({ elapsed_ms: 0, budget_ms: 0 });
	expect(report.coverage.budgets.mail).toEqual({ elapsed_ms: 0, budget_ms: 0 });
	expect(report.coverage.budgets.git.budget_ms).toBe(30_000);
});

test("SKILLMINEFAIR1: unknown sources are refused with the valid list", async () => {
	const f = makeFixture("skill-mine-fair-unknown");
	await expect(runSkillMine({ ...f.options, sources: ["bogus"] })).rejects.toThrow("--source must be one of cass, mail, git");
	await expect(runSkillMine({ ...f.options, sources: [] })).rejects.toThrow("--source must be one of cass, mail, git");
	expect(normalizeSkillMineSources(undefined)).toEqual(["cass", "mail", "git"]);
	expect(normalizeSkillMineSources(["git", "git", "cass"])).toEqual(["cass", "git"]);
	expect(skillMineBudgetShares(["cass", "mail", "git"], 10_000)).toEqual({ cass: 3000, mail: 3000, git: 4000 });
	expect(skillMineBudgetShares(["git"], 10_000)).toEqual({ cass: 0, mail: 0, git: 10_000 });
	expect(SKILL_MINE_GIT_BUDGET_SHARE).toBeGreaterThanOrEqual(0.4);
});

test("SKILLMINEFAIR1: CLI --source git mines only Git and refuses unknown sources", async () => {
	const f = makeGitFixture("skill-mine-fair-cli", "recurrence");
	const tmp = join(f.root, "t");
	mkdirSync(tmp, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	Object.assign(env, {
		HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root,
		PATH: [f.bin, ...env.PATH!.split(delimiter)].join(delimiter),
	});
	mkdirSync(join(f.root, "empty-mail", "projects"), { recursive: true });
	const out = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine",
		"--since", "365d", "--source", "git",
		"--project", f.gitA, "--project", f.gitB,
		"--mail-archive", join(f.root, "empty-mail"), "--skills-dir", f.skills, "--sink", f.sink,
		"--wall-budget-s", "60", "--json"],
		{ cwd: f.projA, env, floor_s: fixtureDeadlineS() });
	const envelope = JSON.parse(new TextDecoder().decode(out.stdout));
	expect(envelope.errors ?? []).toEqual([]);
	expect(envelope.data.overall).toBe("OK");
	expect(envelope.data.coverage.sessions_in_window).toBe(0);
	expect(envelope.data.coverage.git.repos).toBe(2);
	expect(envelope.data.coverage.git.months_mined.length).toBe(12);
	// An unknown source is refused with the valid list, and mines nothing.
	const bad = runFixture([process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine",
		"--source", "bogus", "--json"],
		{ cwd: f.projA, env, floor_s: fixtureDeadlineS() });
	const badEnvelope = JSON.parse(new TextDecoder().decode(bad.stdout));
	expect((badEnvelope.errors ?? []).length).toBeGreaterThan(0);
	expect(JSON.stringify(badEnvelope)).toMatch(/cass.*mail.*git/);
});

// SKILLMINEFAIR1 Fix A: per-call timeouts clamp to the source's remaining
// share. A cass export that hangs past the whole wall budget is killed at the
// cass share, the next session never starts, and Git still mines its months.
// Planted negative: the fixed 30 s timeout lets both 15 s exports finish, so
// cass eats the whole budget and Git mines 0 months.
const HANG_CASS_SH = `#!/bin/sh
here="$(dirname "$0")"
if [ "$1" = "sessions" ]; then cat "$here/../cassdata/sessions.json"; exit 0; fi
if [ "$1" = "export" ]; then sleep 15; cat "$here/../cassdata/exports/$(basename "$2").json"; exit 0; fi
if [ "$1" = "view" ]; then cat "$here/../cassdata/views/$(basename "$2").json"; exit 0; fi
echo "unexpected cass argv: $*" >&2; exit 2
`;

test("SKILLMINEFAIR1: a hung cass export cannot consume Git's reserved share", async () => {
	const f = makeGitFixture("skill-mine-fair-hang", "recurrence");
	put(join(f.bin, "cass"), HANG_CASS_SH, 0o755);
	put(join(f.root, "cassdata", "sessions.json"), `${JSON.stringify([
		{ source_path: "sess-hang-a", workspace: f.gitA },
		{ source_path: "sess-hang-b", workspace: f.gitB },
	])}\n`);
	for (const sess of ["sess-hang-a", "sess-hang-b"]) {
		put(join(f.root, "cassdata", "exports", `${sess}.json`), `${JSON.stringify([{ role: "user", text: "hello" }])}\n`);
	}
	const report = await runSkillMine({
		...f.options, since: "365d", projects: [f.gitA, f.gitB],
		wallBudgetS: 6, gitMonthsPerRun: 2,
	});
	expect(report.overall).toBe("OK");
	expect(report.coverage.stopped_early).toBe(true);
	expect(report.coverage.sessions_mined).toBe(0);
	expect(report.coverage.git.months_mined.length).toBeGreaterThanOrEqual(1);
	expect(report.coverage.budgets.git.budget_ms).toBe(2400);
}, fixtureDeadlineS() * 1000);

test("SKILLMINEFAIR1: CLI --source splits commas, stays case-sensitive, and refuses a bare flag", async () => {
	const f = makeGitFixture("skill-mine-fair-source", "recurrence");
	const tmp = join(f.root, "t");
	mkdirSync(tmp, { recursive: true });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
	Object.assign(env, {
		HOME: f.home, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: f.root,
		PATH: [f.bin, ...env.PATH!.split(delimiter)].join(delimiter),
	});
	mkdirSync(join(f.root, "empty-mail", "projects"), { recursive: true });
	const argvFor = (extra: string[]): string[] => [process.execPath, resolve(repo, "src", "cli.ts"), "skill-mine", ...extra,
		"--since", "365d", "--project", f.gitA, "--project", f.gitB,
		"--mail-archive", join(f.root, "empty-mail"), "--skills-dir", f.skills, "--sink", f.sink,
		"--wall-budget-s", "60", "--json"];
	const comma = JSON.parse(new TextDecoder().decode(
		runFixture(argvFor(["--source", "git,mail"]), { cwd: f.projA, env, floor_s: fixtureDeadlineS() }).stdout));
	expect(comma.errors ?? []).toEqual([]);
	expect(comma.data.overall).toBe("OK");
	expect(comma.data.sources.cass.reason).toContain("skipped by --source");
	expect(comma.data.sources.cass.reason).toContain("cass was not mined");
	expect(comma.data.coverage.git.repos).toBe(2);
	// Values stay case-sensitive: Git is not git.
	const cased = JSON.parse(new TextDecoder().decode(
		runFixture(argvFor(["--source", "Git"]), { cwd: f.projA, env, floor_s: fixtureDeadlineS() }).stdout));
	expect((cased.errors ?? []).length).toBeGreaterThan(0);
	expect(JSON.stringify(cased)).toMatch(/must be one of cass, mail, git/);
	// A bare --source is refused and mines nothing.
	const bare = JSON.parse(new TextDecoder().decode(
		runFixture(argvFor(["--source"]), { cwd: f.projA, env, floor_s: fixtureDeadlineS() }).stdout));
	expect((bare.errors ?? []).length).toBeGreaterThan(0);
	expect(JSON.stringify(bare)).toMatch(/--source needs/);
}, fixtureDeadlineS() * 1000);
