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
function fakeBr(dir: string, bead: Record<string, unknown>): { env: Record<string, string>; acts: () => string[] } {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	const log = join(dir, "br-acts.log");
	writeFileSync(join(bin, "br"), `#!/bin/sh\nif [ "$1" = show ]; then printf '%s' '${JSON.stringify([bead]).replace(/'/g, "'\\''")}'; exit 0; fi\nprintf '%s\\x1e' "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
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
