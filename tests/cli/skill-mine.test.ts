// SKILLMINE1 round 2: procedures only. A candidate is an ordered multi-step
// sequence (>=3 steps) recurring in >=2 sessions, an error->fix arc, a
// correction cluster, or a mail teaching thread. Single command skeletons
// never rank; kit/tool verbs are infrastructure and drop from signatures.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import {
	clusterObservations, dedupeCandidates, fileBeads, fingerprintOf, isInfra, normalizeSkeleton,
	parseMailFile, parseSinceMs, rankClusters, redactedQuote, runSkillMine, skillOverlap,
	stripInjected, textBlockKey, tokensOf, type SkillMineCandidate, type SkillMineOptions,
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
