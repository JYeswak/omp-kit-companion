import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_READBACK_LABEL, liveReadback, liveReadbackAll, parseBoxes, verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { createParentTracker, runUnpinnedInitControl } from "./tracker-init-parent.ts";

/** Test bases live where the ambient br authority permits writes: a grading
 * harness designates GRADE_WAVE_SCRATCH, otherwise the default TMPDIR root. */
function testBase(label: string): string {
	const g = process.env.GRADE_WAVE_SCRATCH || undefined;
	return ownedTmp(label, g === undefined ? {} : { root: g }).path;
}

const base = testBase("verify-test");
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
	writeFileSync(join(dir, "scripts", "probe.sh"), "#!/bin/sh\ns=0\ni=1\nwhile [ $i -le 100 ]; do s=$((s + i)); i=$((i + 1)); done\nif [ $s -ne 5050 ]; then echo 'probe WRONG'; exit 1; fi\necho 'probe 5050 ok'\necho ' 0 fail'\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	return { dir, sha: (await sh(["git", "rev-parse", "HEAD"], dir)).trim() };
}

/** A fake br: `show` prints the bead; every other act appends its argv to a log file; `create` prints child id kit-1.1. */
function fakeBr(dir: string, bead: Record<string, unknown>, opts?: { failOn?: string }): { env: Record<string, string>; acts: () => string[] } {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(dir, "br-acts.log");
	const guard = opts?.failOn ? `case " $* " in *" ${opts.failOn} "*) exit 1;; esac\n` : "";
	writeFileSync(join(bin, "br"), `#!/bin/sh\nif [ "$1" = show ]; then printf '%s' '${JSON.stringify([bead]).replace(/'/g, "'\\''")}'; exit 0; fi\n${guard}printf '%s\\x1e' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = create ]; then printf '{"id":"kit-1.1"}'; fi\nexit 0\n`);
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
	// CLOSEPASS1: the unticked [v] box moves into a LIVEREADBACK child so br's close policy admits the close.
	expect(acts[0]).toStartWith("create LIVEREADBACK: kit-1 -t task -l live-readback --parent ompkit-kup44 --deps related:kit-1 --description WHAT: read back");
	expect(acts[0]).toContain("--acceptance-criteria - [ ] [v] [live] Verification: a non-author replays. --json --actor Peer");
	expect(acts[1]).toStartWith("update kit-1 --description \n\n## Original acceptance (before omp-kit verify moved [v] to kit-1.1)");
	expect(acts[1]).toEndWith("--acceptance-criteria - [ ] [a] [landed] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [landed] `sh scripts/t.sh` expect: prints 0 fail --actor Peer");
	expect(acts[2]).toBe("update kit-1 --check-acceptance 1,2 --actor Peer");
	expect(acts[3]).toBe("gate report kit-1 --gate min_reviewers --provider reviewer:Peer --status pass --to closed --actor Peer");
	expect(acts[4]).toStartWith("close kit-1 --reason verified by Peer (family: same (claude)) on export " + sha);
	expect(acts[4]).toContain("--actor Peer");
	expect(acts[4]).toContain("[a] sh scripts/t.sh -> summary 16 pass 0 fail: found");
	expect(acts[4]).toContain("deferred [v] to kit-1.1 (LIVEREADBACK, child of lane parent ompkit-kup44, because kit-1 has no active parent, related to kit-1)");
	expect(acts).toHaveLength(5);
	expect(res.child).toBe("kit-1.1");
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
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
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
	expect(acts[0]).toStartWith("update kit-1 --status rework --transition-comment REWORK kit-1: [b] output lacks \"PASS\"; child rc 1 15 chars: selftest: FAIL\n; [c] summary 99 pass: not found; child rc 0 17 chars:  16 pass\n 0 fail\n");
});

test("planted: a box whose first backticked span is not followed by -> or expect: is ACCEPTANCE_NOT_REPLAYABLE and never runs (quoted obligation text)", async () => {
	const { dir, sha } = await repo("exitonly");
	const br = fakeBr(dir, inReview("- [ ] [a] [landed] the seat runs `br update <id> --status in_review` after `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.replays).toEqual([]);
	expect(res.log).toContain("[a] first backticked span \"br update <id> --status in_review\" is not followed by -> or expect:");
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
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
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
	expect(res.acts).toEqual([["br", "update", "kit-1", "--status", "open", "--add-label", "needs-intake", "--actor", "Peer"]]);
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
	expect(acts[0]).toBe("update kit-1 --check-acceptance 1,2 --actor Peer");
});

test("live and after items are not executed and never passed; with an executed box passing they defer to the LIVEREADBACK child (CLOSEPASS1)", async () => {
	const { dir, sha } = await repo("pending");
	const br = fakeBr(dir, inReview("- [ ] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail"));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.index, r.letter, r.pass])).toEqual([[1, null, true], [2, "a", null], [3, null, null]]);
	expect(res.log).toContain("[a] PENDING live phase prerequisite unmet; not executed");
	expect(res.log).toContain("[3] PENDING after phase prerequisite unmet; not executed");
	expect(br.acts()[0]).toContain("--acceptance-criteria - [ ] [a] [live] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [after] `sh scripts/t.sh` -> 16 pass 0 fail --json");
	expect(br.acts()[2]).toBe("update kit-1 --check-acceptance 1 --actor Peer");
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
	const r = await run(["br", "init", "--db", join(dir, ".beads", "beads.db")], { cwd: dir, deadline_s: 60, env });
	if (r.rc !== 0) throw new Error(`br init -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return { dir, db: join(dir, ".beads", "beads.db") };
}

function trackerEnv(t: { dir: string; db: string }): Record<string, string> {
	return { ...process.env, BEADS_DB: t.db } as Record<string, string>;
}

async function createBead(t: { dir: string; db: string }, title: string): Promise<string> {
	const env = { ...process.env, BEADS_DB: t.db } as Record<string, string>;
	const created = await brun(["create", title, "--json"], t.dir, env);
	if (created.rc !== 0) throw new Error(`create -> ${created.rc}: ${created.out}`);
	const parsed: unknown = JSON.parse(created.out);
	const id = typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string" ? parsed.id : null;
	if (id === null) throw new Error(`create returned no id: ${created.out.slice(0, 200)}`);
	return id;
}

/** A second tracker bound inside the code repo itself (the same-repo control). */
async function trackerInRepo(cdir: string): Promise<{ dir: string; db: string }> {
	const env = { ...process.env } as Record<string, string>;
	delete env.BEADS_DB;
	const r = await brun(["init", "--db", join(cdir, ".beads", "beads.db")], cdir, env);
	if (r.rc !== 0) throw new Error(`in-repo init -> ${r.rc}: ${r.out}`);
	return { dir: cdir, db: join(cdir, ".beads", "beads.db") };
}

test("BRINITPIN1 verify tracker init leaves ancestor tracker unchanged; unpinned control changes it", async () => {
	const parent = await createParentTracker(base, "br-init-parent");
	const before = parent.snapshot();
	await tracker(join("br-init-parent", "nested", "child"));
	expect(parent.snapshot()).toEqual(before);
	const negative = await runUnpinnedInitControl(base, "verify-negative");
	expect(negative.rc).toBe(0);
	expect(negative.parentChanged).toBe(true);
	expect(negative.newLocks.length).toBeGreaterThan(0);
});

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

/** Read-only journal mode of a tracker db; a hot-journal recovery would itself be a mutation, so clean fixtures only. */
function journalMode(dbPath: string): string {
	const db = new Database(dbPath, { readonly: true });
	try {
		const row = db.query("PRAGMA journal_mode;").get() as Record<string, unknown> | null;
		const value = row === null ? null : Object.values(row)[0];
		if (typeof value !== "string" || value.length === 0) throw new Error(`no journal_mode for ${dbPath}`);
		return value;
	} finally {
		db.close();
	}
}

/** Whole-tracker state: journal plus the authoritative sqlite bytes plus live WAL content and journal mode, read synchronously. A mutation visible only in WAL is observed; br startup auto-import/recovery would show here too. SHM holds volatile lock state, so only its presence and size are witnessed, never its bytes. */
function stateHash(t: { dir: string }): string {
	const beadsDir = join(t.dir, ".beads");
	const h = createHash("sha256");
	h.update(readFileSync(join(beadsDir, "issues.jsonl")));
	h.update(readFileSync(join(beadsDir, "beads.db")));
	const wal = join(beadsDir, "beads.db-wal");
	h.update(existsSync(wal) ? readFileSync(wal) : "ABSENT:beads.db-wal");
	const shm = join(beadsDir, "beads.db-shm");
	h.update(existsSync(shm) ? `PRESENT:${readFileSync(shm).length}` : "ABSENT:beads.db-shm");
	h.update(`journal_mode:${journalMode(join(beadsDir, "beads.db"))}`);
	return h.digest("hex");
}

test("REPLAYBR1 AC1: intended tracker reads admitted while exact code export replays its probe; bound and same-repo reads admitted", async () => {
	const { dir: cdir, sha } = await repo("barrier-pos");
	const t = await tracker("barrier-pos-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier positive probe");
	const tin = await trackerInRepo(cdir);
	const idin = await createBead(tin, "same-repo probe");
	const ac = `- [ ] [a] [build] computed behavior probe: \`sh scripts/probe.sh\` -> probe 5050 ok\n- [ ] [b] [build] admitted explicit read: \`br --db "${t.db}" show ${id} --json\` -> ${id}\n- [ ] [c] [build] admitted bound read (never refused): \`br show ${id} --json\` -> ${id}\n- [ ] [d] [build] admitted same-repo read: \`br --db "${tin.db}" show ${idin} --json\` -> ${idin}`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const beforeHash = stateHash(t);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass, r.outcome])).toEqual([["a", true, "named"], ["b", true, "named"], ["c", true, "named"], ["d", true, "named"]]);
	expect(res.log).toContain("exported " + sha);
	expect(snap(t)).toBe(before);
	expect(stateHash(t)).toBe(beforeHash);
});

test("REPLAYBR1 AC2: ordinary, env-stripped and inherited writes refused with the marker; T unchanged; owned write admitted; neutralization makes it fail", async () => {
	const { dir: cdir, sha } = await repo("barrier-neg");
	const t = await tracker("barrier-neg-t");
	const envT = trackerEnv(t);
	const id = await createBead(t, "barrier negative probe");
	const ac = `- [ ] [a] [build] ordinary explicit write refused: \`br --db "${t.db}" update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [b] [build] env-stripped write refused: \`env -u BEADS_DB br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [c] [build] implicit inherited write refused: \`br update ${id} --add-label probe-label\` -> READONLY_TRACKER\n- [ ] [d] [build] admitted owned write: \`br --db "$OWNED_TRACKER_DB" create "owned probe"\` -> Created\n- [ ] [e] [build] owned readback: \`br --db "$OWNED_TRACKER_DB" list --json\` -> owned probe\n- [ ] [f] [build] export executes the computed behavior probe: \`sh scripts/probe.sh\` -> probe 5050 ok`;
	await shapeBead(t, id, ac);
	const before = snap(t);
	const beforeHash = stateHash(t);
	const beforeShow = (await brun(["show", id, "--json"], t.dir, envT)).out;
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: "same (bun)" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true], ["d", true], ["e", true], ["f", true]]);
	expect(res.log).toContain("READONLY_TRACKER");
	expect(snap(t)).toBe(before);
	expect(stateHash(t)).toBe(beforeHash);
	expect((await brun(["show", id, "--json"], t.dir, envT)).out).toBe(beforeShow);
	const causalEnv = { ...process.env, BEADS_DB: t.db } as Record<string, string>;
	const causal = await brun(["update", id, "--add-label", "causal-proof"], t.dir, causalEnv);
	expect(causal.rc).toBe(0);
	expect(causal.out).toContain("Updated");
	expect((await brun(["show", id, "--json"], t.dir, causalEnv)).out).toContain("causal-proof");
});

test("REPLAYBR1 owned tracker init leaves its nearest ancestor tracker unchanged", async () => {
	const { dir: cdir, sha } = await repo("owned-init-project");
	const t = await tracker("owned-init-source");
	const id = await createBead(t, "owned replay init");
	const ac = `- [ ] [a] [build] admitted owned write: \`br --db "$OWNED_TRACKER_DB" create "owned probe"\` -> Created`;
	await shapeBead(t, id, ac);
	const parent = await createParentTracker(base, "owned-init-parent");
	const before = parent.snapshot();
	const previous = process.env.GRADE_WAVE_SCRATCH;
	process.env.GRADE_WAVE_SCRATCH = parent.dir;
	try {
		const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: trackerEnv(t), dryRun: true, family: "same (bun)" });
		expect(res.code).toBe("DRY_RUN");
		expect(res.replays.map(replay => [replay.letter, replay.pass])).toEqual([["a", true]]);
		expect(parent.snapshot()).toEqual(before);
	} finally {
		if (previous === undefined) delete process.env.GRADE_WAVE_SCRATCH;
		else process.env.GRADE_WAVE_SCRATCH = previous;
	}
});

/* VERIFYACTOR1 (ompkit-t7cn7.24): native verify binds the explicit reviewer
   identity on every durable br mutation. The fixture tracker's default actor
   is forced away from the reviewer via USER, so the audit log distinguishes
   ambient acts from reviewer acts. These assert durable audit state, never
   argv echoes. Platform limit (probe-proven, JadeThrush 71537/71542): br
   records no audit event for --check-acceptance ticks (real or re-tick) or
   gate reports, so tick binding is evidenced by acts argv plus resulting
   state; close/status/comment/REWORK/intake/gate-provider carry durable
   reviewer proof. Fixtures pre-tick because shim lint AC_UNTICKED_BUILD_LANDED
   refuses unticked in_review entry. */

const REVIEWER = "Peer";
const AMBIENT = "AmbientDefault";

/** Env whose br default actor is ambient, never the reviewer. */
function ambientEnv(db: string): Record<string, string> {
	return { ...process.env, USER: AMBIENT, BEADS_DB: db } as Record<string, string>;
}

/** Minimal strict workflow so the close path runs: open->in_progress->in_review->closed with min_reviewers on the final edge. */
async function actorPolicy(t: { dir: string }): Promise<void> {
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), `workflow:
  strict: true
  statuses: [open, in_progress, in_review, rework, closed]
  transitions:
    initial: [open]
    open: [in_progress, closed]
    in_progress: [in_review, open]
    in_review: [closed, rework, open]
    rework: [in_progress, open]
    closed: [open]
  required_fields:
    "open -> in_progress": [acceptance_criteria_present]
    in_review: [acceptance_criteria_present, transition_comment]
    closed: [acceptance_criteria, transition_comment]
  gates:
    "in_review -> closed":
      require_all:
        - min_reviewers: 1
`);
}

/** Shape a fixture bead through the gated path as ambient/tester setup acts. */
async function shapeActorBead(t: { dir: string; db: string }, id: string, ac: string): Promise<void> {
	const env = ambientEnv(t.db);
	const desc = "WHAT: verifyactor1 fixture.\n\nWHY: proves native verify binds the reviewer identity on durable mutations.";
	const moves: string[][] = [
		["update", id, "--description", desc, "--acceptance", ac, "--add-label", "kind:fix"],
		["update", id, "--status", "in_progress", "--transition-comment", "fixture start"],
		["update", id, "--check-acceptance", "1"],
		["update", id, "--assignee", "Author"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"],
	];
	for (const m of moves) {
		const r = await brun(m, t.dir, env);
		if (r.rc !== 0) throw new Error(`${m.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out.slice(0, 300)}`);
	}
}

async function auditActors(t: { dir: string; db: string }, id: string): Promise<{ event_type: string; actor: string }[]> {
	const r = await brun(["audit", "log", id, "--json"], t.dir, ambientEnv(t.db));
	if (r.rc !== 0) throw new Error(`audit log -> ${r.rc}: ${r.out.slice(0, 300)}`);
	const doc = JSON.parse(r.out) as { events: { event_type: string; actor: string }[] };
	return doc.events.map(e => ({ event_type: e.event_type, actor: e.actor }));
}

test("VERIFYACTOR1 [a]: passing verify binds the reviewer on ticks, gate report and close; a same-tracker control bead is untouched", async () => {
	const { dir: cdir, sha } = await repo("actorpass");
	const t = await tracker("actorpass-t");
	await actorPolicy(t);
	const envT = ambientEnv(t.db);
	const id = await createBead(t, "actor close probe");
	const control = await createBead(t, "actor control probe");
	const ac = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass";
	await shapeActorBead(t, id, ac);
	await shapeActorBead(t, control, ac);
	const beforeEvents = await auditActors(t, id);
	const controlBefore = (await brun(["show", control, "--json"], t.dir, envT)).out;
	const controlEventsBefore = await auditActors(t, control);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)" });
	expect(res.code).toBe("CLOSED");
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	const fresh = afterEvents.slice(0, afterEvents.length - beforeEvents.length);
	for (const e of fresh) expect(e.actor).toBe(REVIEWER);
	const kinds = fresh.map(e => e.event_type);
	expect(kinds).toContain("closed");
	// Durable reviewer-report proof: the gate result itself names the reviewer provider (audit log carries no gate-report event; probe-proven).
	const gates = JSON.parse((await brun(["gate", "list", id, "--json"], t.dir, envT)).out) as unknown;
	const gateText = JSON.stringify(gates);
	expect(gateText).toContain(`reviewer:${REVIEWER}`);
	expect(gateText).toContain("pass");
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; notes: string }[];
	expect(shown[0]!.status).toBe("closed");
	expect((await brun(["show", control, "--json"], t.dir, envT)).out).toBe(controlBefore);
	expect(await auditActors(t, control)).toEqual(controlEventsBefore);
});

test("VERIFYACTOR1 [a]: failing probe REWORK carries the reviewer identity, never the ambient default", async () => {
	const { dir: cdir, sha } = await repo("actorrework");
	const t = await tracker("actorrework-t");
	await actorPolicy(t);
	const envT = ambientEnv(t.db);
	const id = await createBead(t, "actor rework probe");
	await shapeActorBead(t, id, "- [ ] [a] [build] `sh scripts/bad.sh` -> prints PASS");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)" });
	expect(res.code).toBe("REWORK");
	expect(res.acts[0]).toEqual(["br", "update", id, "--status", "rework", "--transition-comment", expect.stringContaining(`REWORK ${id}:`), "--actor", REVIEWER]);
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
});

test("VERIFYACTOR1 [a]: explicit-author refusal and dry-run leave fixture state and audit untouched", async () => {
	const { dir: cdir, sha } = await repo("actoruntouched");
	const t = await tracker("actoruntouched-t");
	await actorPolicy(t);
	const envT = ambientEnv(t.db);
	const id = await createBead(t, "actor untouched probe");
	await shapeActorBead(t, id, "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass");
	const beforeHash = stateHash(t);
	const beforeEvents = await auditActors(t, id);
	const refused = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Author", env: envT });
	expect(refused.code).toBe("NON_AUTHOR_REQUIRED");
	expect(refused.acts).toEqual([]);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
	const dry = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, dryRun: true, family: "same (bun)" });
	expect(dry.code).toBe("DRY_RUN");
	expect(dry.acts.length).toBeGreaterThan(0);
	expect(stateHash(t)).toBe(beforeHash);
	expect(await auditActors(t, id)).toEqual(beforeEvents);
});

test("VERIFYACTOR1 [a]: intake refusal binds the reviewer on the open/needs-intake mutation (durable)", async () => {
	const { dir: cdir, sha } = await repo("actorintake");
	const t = await tracker("actorintake-t");
	await actorPolicy(t);
	const envT = ambientEnv(t.db);
	const id = await createBead(t, "actor intake probe");
	await shapeActorBead(t, id, "- [ ] [a] [build] prose names no command");
	const beforeEvents = await auditActors(t, id);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: REVIEWER, env: envT, family: "same (bun)" });
	expect(res.code).toBe("ACCEPTANCE_NOT_REPLAYABLE");
	expect(res.acts).toEqual([["br", "update", id, "--status", "open", "--add-label", "needs-intake", "--actor", REVIEWER]]);
	// verifyBead returns intake acts for the operator; execute them as the operator would, then prove durable reviewer binding.
	for (const a of res.acts) {
		const r = await run(a, { cwd: cdir, deadline_s: 60, env: envT });
		if (r.rc !== 0) throw new Error(`intake act -> ${r.rc}`);
	}
	const afterEvents = await auditActors(t, id);
	expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);
	for (const e of afterEvents.slice(0, afterEvents.length - beforeEvents.length)) expect(e.actor).toBe(REVIEWER);
	const shown = JSON.parse((await brun(["show", id, "--json"], t.dir, envT)).out) as { status: string; labels: string[] }[];
	expect(shown[0]!.status).toBe("open");
	expect(shown[0]!.labels).toContain("needs-intake");
});

test("VERIFYSCRATCH1: a replay's fixture tracker under $GRADE_WAVE_SCRATCH is admitted by the read-only br; outside the verify root it is still refused; planted: without the variable the same fixture is refused", async () => {
	const outside = testBase("verifyscratch-outside");
	const cdir = join(base, "verifyscratch");
	mkdirSync(join(cdir, "scripts"), { recursive: true });
	// grade_wave.py --selftest's shape: fixtures under GRADE_WAVE_SCRATCH when set, else a sibling dir of its own.
	writeFileSync(join(cdir, "scripts", "fx.sh"), "#!/bin/sh\nroot=\"${GRADE_WAVE_SCRATCH:-$1}\"\nd=\"$root/grade_wave_selftest.fx.$$\"\nmkdir -p \"$d\" && cd \"$d\" && br init --db \"$d/.beads/beads.db\"\n");
	await sh(["git", "init", "-q"], cdir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], cdir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], cdir);
	const sha = (await sh(["git", "rev-parse", "HEAD"], cdir)).trim();
	const t = await tracker("verifyscratch-t");
	const id = await createBead(t, "verify scratch probe");
	const ac = [
		`- [ ] [a] [build] selftest fixture under the verify scratch is admitted: \`sh scripts/fx.sh ${outside}\` -> prints Initialized`,
		`- [ ] [b] [build] the same fixture outside the verify root is refused: \`mkdir -p ${outside}/direct && cd ${outside}/direct && br init --db ${outside}/direct/.beads/beads.db\` -> prints READONLY_TRACKER`,
		`- [ ] [c] [build] planted: with GRADE_WAVE_SCRATCH removed the first fixture is refused: \`env -u GRADE_WAVE_SCRATCH sh scripts/fx.sh ${outside}\` -> prints READONLY_TRACKER`,
	].join("\n");
	await shapeBead(t, id, ac);
	const beforeHash = stateHash(t);
	const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: trackerEnv(t), dryRun: true, family: "same (bun)" });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass, r.detail.split(";")[0]])).toEqual([
		["a", true, "output contains \"Initialized\""],
		["b", true, "output contains \"READONLY_TRACKER\""],
		["c", true, "output contains \"READONLY_TRACKER\""],
	]);
	expect(existsSync(join(outside, "direct", ".beads", "beads.db"))).toBe(false);
	expect(stateHash(t)).toBe(beforeHash);
});

/** br's own close policy, as the omp-kit tracker runs it: a close needs every acceptance box ticked and one reviewer. */
const CLOSE_POLICY = [
	"workflow:", "  strict: true", "  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]", "  transitions:",
	"    initial: [open]", "    open: [in_progress, blocked, deferred, closed]", "    in_progress: [in_review, open, blocked, deferred]",
	"    in_review: [closed, rework]", "    rework: [in_progress, in_review, open]", "    blocked: [open, in_progress]", "    deferred: [open]", "    closed: [open]",
	"  required_fields:", "    \"open -> in_progress\": [acceptance_criteria_present]", "    in_review: [acceptance_criteria_present, transition_comment]",
	"    closed: [acceptance_criteria, transition_comment]", "  gates:", "    \"in_review -> closed\":", "      require_all:", "        - min_reviewers: 1",
	"    \"open -> closed\":", "      require_all:", "        - min_reviewers: 1", "",
].join("\n");

async function policyTracker(name: string): Promise<{ dir: string; db: string }> {
	const t = await tracker(name);
	writeFileSync(join(t.dir, ".beads", "policy.yaml"), CLOSE_POLICY);
	return t;
}

/** A bead Author built and moved to in_review under the policy, its boxes unticked, optionally under `parent`. */
async function reviewBead(t: { dir: string; db: string }, title: string, ac: string, parent?: string): Promise<string> {
	const env = trackerEnv(t);
	const id = await createBead(t, title);
	for (const args of [
		["update", id, "--description", "WHAT: closepass fixture.\n\nWHY: proves verify closes done work under the real close policy.", "--acceptance", ac, "--assignee", "Author", ...(parent ? ["--parent", parent] : [])],
		["update", id, "--status", "in_progress", "--actor", "Author"],
		["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "Author"],
	]) {
		const r = await brun(args, t.dir, env);
		if (r.rc !== 0) throw new Error(`${args.slice(0, 3).join(" ")} -> ${r.rc}: ${r.out}`);
	}
	return id;
}

async function row(t: { dir: string; db: string }, id: string): Promise<Record<string, unknown>> {
	const shown = await brun(["show", id, "--json"], t.dir, trackerEnv(t));
	return (JSON.parse(shown.out) as Record<string, unknown>[])[0]!;
}

const BUILD_BOXES = "- [ ] [a] [build] `sh scripts/t.sh` -> 16 pass 0 fail\n- [ ] [b] [build] `sh scripts/t.sh` -> prints 0 fail";

/** A closed bead under `epic` and its open LIVEREADBACK child, through a real non-dry verify. */
async function closedWithChild(t: { dir: string; db: string }, repoDir: { dir: string; sha: string }, title: string, live: string, epic: string): Promise<{ id: string; child: string }> {
	const id = await reviewBead(t, title, `${BUILD_BOXES}\n${live}`, epic);
	const res = await verifyBead({ bead: id, exportSha: repoDir.sha, repo: repoDir.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)" });
	if (res.code !== "CLOSED" || res.child === undefined) throw new Error(`verify ${id} -> ${res.code}: ${res.log}`);
	return { id, child: res.child };
}

test("CLOSEPASS1: two passing [build] boxes and an unticked [live] box close under br's real policy with no --force; box 3 moves word for word into one open live-readback child of the bead's active parent, related to it and named in the close reason; an all-[live] bead stays PENDING with no child", async () => {
	const code = await repo("closepass");
	const t = await policyTracker("closepass-t");
	const env = trackerEnv(t);
	const live = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const ac = `${BUILD_BOXES}\n${live}`;
	// Planted negative: closing the old way (tick the run boxes, leave box 3 in the parent) is refused by br itself.
	const planted = await reviewBead(t, "closepass planted", ac);
	expect((await brun(["update", planted, "--check-acceptance", "1,2", "--actor", "Peer"], t.dir, env)).rc).toBe(0);
	expect((await brun(["gate", "report", planted, "--gate", "min_reviewers", "--provider", "reviewer:Peer", "--status", "pass", "--to", "closed", "--actor", "Peer"], t.dir, env)).rc).toBe(0);
	const refused = await brun(["close", planted, "--reason", "r", "--transition-comment", "c", "--actor", "Peer"], t.dir, env);
	expect(refused.rc).toBe(4);
	expect(refused.out).toContain("unchecked item(s) remain");
	const epic = await createBead(t, "closepass epic");
	const id = await reviewBead(t, "closepass parent", ac, epic);
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)" });
	expect(res.code).toBe("CLOSED");
	expect(res.acts.flat()).not.toContain("--force");
	const parent = await row(t, id);
	const child = await row(t, res.child!);
	expect(parent.status).toBe("closed");
	expect(parent.acceptance_criteria).toBe(BUILD_BOXES.replaceAll("- [ ]", "- [x]"));
	expect(parent.description).toContain(`## Original acceptance (before omp-kit verify moved [c] to ${res.child})\n${ac}`);
	expect(JSON.stringify(parent)).toContain(`deferred [c] to ${res.child} (LIVEREADBACK, child of ${epic}, related to ${id})`);
	expect(child).toMatchObject({ status: "open", title: "LIVEREADBACK: closepass parent", acceptance_criteria: live, parent: epic, labels: [LIVE_READBACK_LABEL] });
	expect(child.dependencies).toContainEqual(expect.objectContaining({ id, dependency_type: "related" }));
	expect((await row(t, epic)).status).toBe("open");
	const allLive = await reviewBead(t, "closepass all live", live);
	const pending = await verifyBead({ bead: allLive, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)" });
	expect(pending.code).toBe("PENDING");
	expect(pending.child).toBeUndefined();
	expect(pending.acts).toEqual([]);
	expect((await row(t, allLive)).status).toBe("in_review");
	const children = JSON.parse((await brun(["list", "--status", "all", "--label", LIVE_READBACK_LABEL, "--limit", "0", "--json"], t.dir, env)).out) as { issues?: unknown[] } | unknown[];
	expect((Array.isArray(children) ? children : children.issues ?? []).length).toBe(1);
}, 120_000);

test("CLOSEPASS1 no active parent: the child goes under the constraint lane's parent and the close reason says so; with no readable lane parent the bead stays PENDING and nothing is written", async () => {
	const code = await repo("closepass-lane");
	const t = await policyTracker("closepass-lane-t");
	const env = trackerEnv(t);
	const live = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const lane = await createBead(t, "constraint lane parent");
	const id = await reviewBead(t, "closepass orphan", `${BUILD_BOXES}\n${live}`);
	const missing = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: "cp-nosuch" });
	expect(missing.code).toBe("PENDING");
	expect(missing.acts).toEqual([]);
	expect(missing.log).toContain(`${id} has no active parent and lane parent cp-nosuch is unreadable`);
	expect((await row(t, id)).status).toBe("in_review");
	const res = await verifyBead({ bead: id, exportSha: code.sha, repo: code.dir, actor: "Peer", env, family: "same (bun)", laneParent: lane });
	expect(res.code).toBe("CLOSED");
	expect(await row(t, res.child!)).toMatchObject({ status: "open", parent: lane, labels: [LIVE_READBACK_LABEL] });
	expect(JSON.stringify(await row(t, id))).toContain(`(LIVEREADBACK, child of lane parent ${lane}, because ${id} has no active parent, related to ${id})`);
}, 120_000);

test("CLOSEPASS1.live: --live-readback runs only the child's boxes on the installed tree; a pass ticks them and closes the child", async () => {
	const code = await repo("closepass-live");
	const t = await policyTracker("closepass-live-t");
	const { id, child } = await closedWithChild(t, code, "closepass live pass", "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass", await createBead(t, "closepass live epic"));
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Author", env: trackerEnv(t) })).code).toBe("NON_AUTHOR_REQUIRED");
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)" });
	expect(res.code).toBe("CLOSED");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", true]]);
	expect(await row(t, child)).toMatchObject({ status: "closed", acceptance_criteria: "- [x] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass" });
	expect((await row(t, id)).status).toBe("closed");
	expect((await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t) })).code).toBe("NOT_LIVE_READBACK");
}, 120_000);

test("CLOSEPASS1.live planted: a failing live box reopens the parent with REWORK naming the box, and the child stays open", async () => {
	const code = await repo("closepass-livefail");
	const t = await policyTracker("closepass-livefail-t");
	const epic = await createBead(t, "closepass livefail epic");
	const { id, child } = await closedWithChild(t, code, "closepass live fail", "- [ ] [c] [live] on the installed kit `sh scripts/bad.sh` -> prints PASS", epic);
	const res = await liveReadback({ bead: child, repo: code.dir, actor: "Peer", env: trackerEnv(t), family: "same (bun)" });
	expect(res.code).toBe("REWORK");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["c", false]]);
	expect((await row(t, id)).status).toBe("open");
	const comments = await brun(["comments", "list", id], t.dir, trackerEnv(t));
	expect(comments.out).toContain(`REWORK ${id}: live readback ${child} failed [c] output lacks "PASS"`);
	// The child hangs off the active epic, not the reopened bead, so the readback never holds the bead's next close.
	expect(await row(t, child)).toMatchObject({ status: "open", parent: epic });
	expect(JSON.stringify((await row(t, id)).dependents ?? [])).not.toContain("parent-child");
}, 120_000);

test("CLOSEPASS1.all: --live-readback --all visits exactly the open live-readback children, and no others", async () => {
	const code = await repo("closepass-all");
	const t = await policyTracker("closepass-all-t");
	const env = trackerEnv(t);
	const box = "- [ ] [c] [live] on the installed kit `sh scripts/t.sh` -> 16 pass";
	const epic = await createBead(t, "closepass all epic");
	const open = await closedWithChild(t, code, "closepass all open", box, epic);
	const done = await closedWithChild(t, code, "closepass all done", box, epic);
	expect((await liveReadback({ bead: done.child, repo: code.dir, actor: "Peer", env })).code).toBe("CLOSED");
	const other = await createBead(t, "closepass unlabelled open bead");
	const labelled = await createBead(t, "closepass labelled but in progress");
	for (const args of [["update", labelled, "--add-label", LIVE_READBACK_LABEL, "--acceptance", box], ["update", labelled, "--status", "in_progress"]]) expect((await brun(args, t.dir, env)).rc).toBe(0);
	const res = await liveReadbackAll({ repo: code.dir, actor: "Peer", env, family: "same (bun)" });
	expect(res.visited).toEqual([open.child]);
	expect(res.visited).not.toContain(other);
	expect(res.results.map(r => [r.bead, r.code])).toEqual([[open.child, "CLOSED"]]);
	expect(res.ok).toBe(true);
}, 180_000);

test("VERIFYSCRATCH1.exportroot: the export carries var/agent-tmp (gitignored, so absent from git archive) and KITLIB_TMP_ROOT names it; planted: without the dir kitlib scratch under the repo root fails NotADirectoryError", async () => {
	const dir = join(base, "exportroot");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "kitlib_tmp.py"), readFileSync(join(import.meta.dir, "..", "..", "scripts", "kitlib_tmp.py")));
	writeFileSync(join(dir, ".gitignore"), "var/\n");
	await sh(["git", "init", "-q"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"], dir);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"], dir);
	const sha = (await sh(["git", "rev-parse", "HEAD"], dir)).trim();
	const scratch = "python3 -c 'import sys; sys.path.insert(0, \"scripts\"); import kitlib_tmp; print(\"scratch\", kitlib_tmp.owned_tmp(\"replay\", root=\"var/agent-tmp\").path)'";
	const br = fakeBr(dir, inReview([
		`- [ ] [a] [build] kitlib scratch under the export root: \`${scratch}\` -> prints var/agent-tmp/replay`,
		"- [ ] [b] [build] KITLIB_TMP_ROOT names that dir: `python3 -c 'import os; print(os.path.isdir(os.environ[\"KITLIB_TMP_ROOT\"]), os.environ[\"KITLIB_TMP_ROOT\"].endswith(\"/export/var/agent-tmp\"))'` -> prints True True",
		`- [ ] [c] [build] planted: without the dir the same call fails: \`rmdir var/agent-tmp && ${scratch}\` -> prints NotADirectoryError`,
	].join("\n")));
	const res = await verifyBead({ bead: "kit-1", exportSha: sha, repo: dir, actor: "Peer", env: br.env, dryRun: true });
	expect(res.code).toBe("DRY_RUN");
	expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true]]);
	expect(br.acts()).toEqual([]);
});
