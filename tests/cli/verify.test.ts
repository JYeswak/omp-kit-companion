import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBoxes, verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const base = ownedTmp("verify-test").path;
const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function sh(cmd: string[], cwd: string, env?: Record<string, string>): Promise<string> {
	const r = await run(cmd, { cwd, deadline_s: 60, env: env ? { ...process.env, ...env } as Record<string, string> : undefined });
	if (r.rc !== 0) throw new Error(`${cmd.join(" ")} -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return new TextDecoder().decode(r.stdout);
}

/** A repo whose HEAD carries scripts/t.sh (prints `16 pass 0 fail`, exit 0) and scripts/bad.sh (exit 1). */
async function repo(name: string): Promise<{ dir: string; sha: string }> {
	const dir = join(base, name);
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
	writeFileSync(join(dir, "scripts", "bad.sh"), "#!/bin/sh\necho 'selftest: FAIL'\nexit 1\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** A fake br: `show` prints the bead; every other act appends its argv to a log file. */
function fakeBr(dir: string, bead: Record<string, unknown>, opts?: { failOn?: string }): { env: Record<string, string>; acts: () => string[] } {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(dir, "br-acts.log");
	const guard = opts?.failOn ? `case " $* " in *" ${opts.failOn} "*) exit 1;; esac\n` : "";
	writeFileSync(join(bin, "br"), `#!/bin/sh\nif [ "$1" = show ]; then printf '%s' '${JSON.stringify([bead]).replace(/'/g, "'\\''")}'; exit 0; fi\n${guard}printf '%s\\x1e' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
	chmodSync(join(bin, "br"), 0o755);
	return { env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, acts: () => { try { return readFileSync(log, "utf8").split("\x1e").filter(Boolean); } catch { return []; } } };
}

const inReview = (ac: string) => ({ id: "kit-1", status: "in_review", assignee: "Author", updated_at: "2026-10-26T00:00:00Z", labels: [], acceptance_criteria: ac });

test("verify closes a bead whose boxes name commands with expected outcomes: replays on the export, ticks, gate, close with the command log; family disclosed", async () => {
	const { dir, sha } = await repo("good");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/t.sh` expect: prints 0 fail\n- [ ] [v] [live] Verification: a non-author replays."));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, family: "same (claude)" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass, r.outcome])).toEqual([["a", true, "named"], ["b", true, "named"]]);
	const acts = br.acts();
	expect(acts[0]).toBe("update kit-1 --check-acceptance 1,2");
	expect(acts[1]).toBe("gate report kit-1 --gate min_reviewers --provider reviewer:Peer --status pass --to closed");
	expect(acts[2]).toStartWith("close kit-1 --reason verified by Peer (family: same (claude)) on export " + sha);
	expect(acts[2]).toContain("[a] sh scripts/t.sh -> summary 16 pass 0 fail: found");
});

test("planted: a dotted bead id proceeds past scratch allocation with the exact bead identity preserved (constant label, unchanged metadata)", async () => {
	const { dir, sha } = await repo("dotted");
	const br = fakeBr(dir, { ...inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"), id: "kit-1.2" });
	const res = await verifyBead({ bead: "kit-1.2", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true]]);
	expect(res.log).toContain("exported " + sha);
});

test("planted: an unresolvable bead names the unmet tracker prerequisite and writes nothing", async () => {
	const { dir, sha } = await repo("missing");
	const bin = join(dir, "bin-noshow");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "br"), "#!/bin/sh\nprintf 'ISSUE_NOT_FOUND' >&2\nexit 3\n");
	chmodSync(join(bin, "br"), 0o755);
	const res = await verifyBead({ bead: "kit-9.9", exportSha: sha, repo: dir, actor: "Peer", env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
	expect(res.code).toBe("NOT_IN_REVIEW");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(res.log).toContain("kit-9.9");
	expect(res.log).toContain("unmet prerequisite");
});

test("planted: the author's own seat is refused NON_AUTHOR_REQUIRED and nothing is run", async () => {
	const { dir, sha } = await repo("self");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Author", env: br.env });
	expect(res.code).toBe("NON_AUTHOR_REQUIRED");
	expect(res.replays).toEqual([]);
	expect(br.acts()).toEqual([]);
});

test("planted: a box naming no command is ACCEPTANCE_NOT_REPLAYABLE and the bead is sent back to intake, not closed", async () => {
	const { dir, sha } = await repo("noreplay");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] the feature works and the UI looks right\n- [ ] [b] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[a] names no command");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake"]]);
	expect(br.acts()).toEqual([]);
});

test("planted: a box whose command fails sets REWORK naming the box; exit 0 with the wrong output also fails (named outcome beats exit code)", async () => {
	const { dir, sha } = await repo("rework");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/bad.sh` -> prints PASS\n- [ ] [c] [landed] `sh scripts/t.sh` -> 99 pass"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", false], ["c", false]]);
	const acts = br.acts();
	expect(acts).toHaveLength(1);
	expect(acts[0]).toStartWith("update kit-1 --status rework --transition-comment REWORK kit-1: [b] output lacks \"PASS\"; [c] summary 99 pass: not found");
});

test("exit-only boxes are judged by rc and flagged in the close reason; --dry-run runs nothing against the tracker", async () => {
	const { dir, sha } = await repo("exitonly");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh`; planted: nothing"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays[0]).toMatchObject({ letter: "a", pass: true, outcome: "exit-only" });
	expect(res.acts[2]?.join(" ")).toContain("exit-only boxes: [a]");
	expect(br.acts()).toEqual([]);
});

test("the verify handler is registered at module load (planted: a registration left inside another function is HANDLER_UNAVAILABLE)", async () => {
	const r = await run(["bun", "run", "--silent", cliPath, "verify", "kit-1", "--json"], { cwd: base, deadline_s: 120 });
	const text = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
	expect(text).not.toContain("HANDLER_UNAVAILABLE");
	expect(text).toContain("--export");
});

test("phase-only GATESET1 boxes parse with retained order, checked state and build phase", () => {
	const boxes = parseBoxes("- [x] [build] Planted: a prompt whose lint run exits non-zero yields a FAIL receipt naming 'lint did not run: <err>' and exit 1, never a traceback (test in prompt_gate.py --selftest).\n- [x] [build] Every gate's detail is JSON-serializable: the selftest dumps every receipt it builds with json.dumps.");
	expect(boxes.map(b => [b.index, b.letter, b.checked, b.phase])).toEqual([[1, null, true, "build"], [2, null, true, "build"]]);
});

test("planted: a mandatory-letter-only parser finds no phase-only boxes (would drop them)", () => {
	const text = "- [x] [build] Planted: a prompt whose lint run exits non-zero yields a FAIL receipt naming 'lint did not run: <err>' and exit 1, never a traceback (test in prompt_gate.py --selftest).\n- [x] [build] Every gate's detail is JSON-serializable: the selftest dumps every receipt it builds with json.dumps.";
	expect(text.split("\n").filter(l => /^- \[[ xX]\] \[[a-z]\]/.test(l.trim()))).toEqual([]);
	expect(parseBoxes(text).map(b => [b.index, b.phase])).toEqual([[1, "build"], [2, "build"]]);
});

test("legacy lettered boxes keep their meaning and untagged prose stays out", () => {
	const boxes = parseBoxes("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] prose without tags is not a box\n- [x] [b] body without phase");
	expect(boxes.map(b => [b.index, b.letter, b.phase])).toEqual([[1, "a", "landed"], [2, "b", null]]);
});

test("planted: an unsupported tag is named and fails closed, never silently dropped", async () => {
	const { dir, sha } = await repo("badphase");
	const br = fakeBr(dir, inReview("- [ ] [zzz] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [build] [a] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] unsupported phase [zzz]");
	expect(res.log).toContain("[2] unsupported phase [build a]");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake"]]);
	expect(br.acts()).toEqual([]);
});

test("planted: a commandless phase-only box is named and fails closed", async () => {
	const { dir, sha } = await repo("nocommand");
	const br = fakeBr(dir, inReview("- [ ] [build] prose names no command"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] names no command");
});

test("planted: a refusal names the indexed box and leaves the tracker's bead and acceptance text untouched", async () => {
	const ac = "- [ ] [build] prose names no command";
	const bead = inReview(ac);
	const { dir, sha } = await repo("untouched");
	const br = fakeBr(dir, bead);
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.log).toContain("[1] names no command");
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake"]]);
	expect(br.acts()).toEqual([]);
	expect(bead.acceptance_criteria).toBe(ac);
});

test("phase-only boxes replay their literal command and are judged by the named outcome", async () => {
	const { dir, sha } = await repo("phaseonly");
	const br = fakeBr(dir, inReview("- [ ] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [x] [build] `sh scripts/t.sh` expect: prints 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass, r.outcome])).toEqual([[1, null, true, "named"], [2, null, true, "named"]]);
	const acts = br.acts();
	expect(acts[0]).toBe("update kit-1 --check-acceptance 1,2");
});

test("live and after items are pending: not executed, never passed, no tracker mutation", async () => {
	const { dir, sha } = await repo("pending");
	const br = fakeBr(dir, inReview("- [ ] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("PENDING");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, null, true], [2, "a", null], [3, null, null]]);
	expect(res.log).toContain("[a] PENDING live phase prerequisite unmet; not executed");
	expect(res.log).toContain("[3] PENDING after phase prerequisite unmet; not executed");
	expect(res.acts).toEqual([]);
	expect(br.acts()).toEqual([]);
});

test("a failed phase-only expectation stays REWORK even when the command exits 0", async () => {
	const { dir, sha } = await repo("phaseonlyrework");
	const br = fakeBr(dir, inReview("- [ ] [build] `sh scripts/t.sh` -> 99 pass"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.index, r.pass])).toEqual([[1, false]]);
});

test("[v] verification notes stay skipped even when they carry a phase", async () => {
	const { dir, sha } = await repo("vskip");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [v] [live] Verification: a non-author replays the original command."));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, "a", true]]);
});

test("planted: an unknown export sha fails closed as EXPORT_FAILED with no replays and no acts", async () => {
	const { dir } = await repo("badexport");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: "deadbeef".repeat(5).slice(0, 40), repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("EXPORT_FAILED");
	expect(res.replays).toEqual([]);
	expect(res.acts).toEqual([]);
	expect(br.acts()).toEqual([]);
});

test("planted: a failing reviewer-gate report fails the close as REWORK naming the act, never a silent pass", async () => {
	const { dir, sha } = await repo("gaterefail");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail"), { failOn: "gate" });
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("REWORK");
	expect(res.log).toContain("act failed");
	expect(res.log).toContain("gate report");
});

/* REPLAYBR1 (ompkit-t7cn7.21): real-tracker fixtures for the per-run read-only
   replay barrier. These use the production br binary and real trackers in
   owned scratch, never the fake br above and never the shared K tracker. */

async function brun(args: string[], cwd: string, env?: Record<string, string>): Promise<{ rc: number | null; out: string }> {
	const merged = { ...process.env, ...(env ?? {}) } as Record<string, string>;
	const r = await run(["br", ...args], { cwd, deadline_s: 60, env: merged });
	return { rc: r.rc, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

/** A real tracker in owned scratch, initialized with no inherited binding. */
async function tracker(name: string): Promise<{ dir: string; db: string }> {
	const dir = join(base, name);
	mkdirSync(dir, { recursive: true });
	const env = { ...process.env } as Record<string, string>;
	delete env.BEADS_DB;
	const r = await run(["br", "init"], { cwd: dir, deadline_s: 60, env });
	if (r.rc !== 0) throw new Error(`br init -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return { dir, db: join(dir, ".beads", "beads.db") };
}

function trackerEnv(t: { dir: string; db: string }): Record<string, string> {
	return { ...process.env, BEADS_DB: t.db } as Record<string, string>;
}

async function createBead(t: { dir: string; db: string }, title: string): Promise<string> {
	const created = await brun(["create", title, "--json"], t.dir, trackerEnv(t));
	if (created.rc !== 0) throw new Error(`create -> ${created.rc}: ${created.out}`);
	const parsed: unknown = JSON.parse(created.out);
	const id = typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string" ? parsed.id : null;
	if (id === null) throw new Error(`create returned no id: ${created.out.slice(0, 200)}`);
	return id;
}

/** Description, acceptance, label, per-box ticks and the in_review transition. */
async function shapeBead(t: { dir: string; db: string }, id: string, ac: string): Promise<void> {
	const env = trackerEnv(t);
	const desc = "WHAT: owned replay-barrier fixture.\n\nWHY: proves the per-run read-only dispatch admits intended reads and refuses production writes.";
	const shaped = await brun(["update", id, "--description", desc, "--acceptance", ac, "--add-label", "kind:fix"], t.dir, env);
	if (shaped.rc !== 0) throw new Error(`shape -> ${shaped.rc}: ${shaped.out}`);
	const n = ac.split("\n").filter(l => l.trim().startsWith("- [")).length;
	for (let i = 1; i <= n; i++) {
		const ticked = await brun(["update", id, "--check-acceptance", String(i)], t.dir, env);
		if (ticked.rc !== 0) throw new Error(`tick ${i} -> ${ticked.rc}: ${ticked.out}`);
	}
	const ready = await brun(["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"], t.dir, env);
	if (ready.rc !== 0) throw new Error(`in_review -> ${ready.rc}: ${ready.out}`);
}

function snap(t: { dir: string }): string {
	return readFileSync(join(t.dir, ".beads", "issues.jsonl"), "utf8");
}

test("REPLAYBR1 AC1: intended tracker reads admitted while exact code export replays its probe; bound read admitted", async () => {
	const { dir: cdir, sha } = await repo("barrier-pos");
	const t = await tracker("barrier-pos-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier positive probe");
	const ac = `- [ ] [a] [build] \`sh scripts/t.sh\` -> 16 pass 0 fail\n- [ ] [b] [build] admitted explicit read: \`br --db "${t.db}" show ${id} --json\` -> ${id}\n- [ ] [c] [build] admitted bound read (never refused): \`br show ${id} --json\` -> ${id}`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass, r.outcome])).toEqual([["a", true, "named"], ["b", true, "named"], ["c", true, "named"]]);
	expect(res.log).toContain("exported " + sha);
	expect(snap(t)).toBe(before);
});

test("REPLAYBR1 AC2: ordinary, env-stripped and inherited writes refused with the marker; T unchanged; owned write admitted; neutralization makes it fail", async () => {
	const { dir: cdir, sha } = await repo("barrier-neg");
	const t = await tracker("barrier-neg-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier negative probe");
	const ac = `- [ ] [a] [build] ordinary explicit write refused: \`br --db "${t.db}" update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [b] [build] env-stripped write refused: \`env -u BEADS_DB br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [c] [build] implicit inherited write refused: \`br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [d] [build] admitted owned write: \`br --db "$OWNED_TRACKER_DB" create "owned probe"\` -> Created\n- [ ] [e] [build] owned readback: \`br --db "$OWNED_TRACKER_DB" list --json\` -> owned probe`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const beforeShow = (await brun(["show", id, "--json"], t.dir, envT)).out;
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true], ["d", true], ["e", true]]);
	expect(res.log).toContain("READONLY_TRACKER");
	expect(snap(t)).toBe(before);
	expect((await brun(["show", id, "--json"], t.dir, envT)).out).toBe(beforeShow);
	const causalEnv = { ...process.env, BEADS_DB: t.db } as Record<string, string>;
	const causal = await brun(["update", id, "--add-label", "causal-proof"], t.dir, causalEnv);
	expect(causal.rc).toBe(0);
	expect(causal.out).toContain("Updated");
	expect((await brun(["show", id, "--json"], t.dir, causalEnv)).out).toContain("causal-proof");
});
