/** REPLAYABLE1 (ompkit-fp72.135.3.71): bead admission refuses acceptance `omp-kit verify` cannot replay.
 *
 * Every lint verdict here comes from the real seat entries (scripts/br-create-lint.py and
 * scripts/br-update-lint.py, through bead_lint.py and scripts/box-lint.ts) against a fake `br`
 * serving fixture rows; every verify verdict comes from src/verify.ts verifyBead on a fixture repo.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyBead } from "../../src/verify.ts";
import { run } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";

afterAll(cleanupAllOwnedTmp);
const harness = process.env.GRADE_WAVE_SCRATCH || undefined;
const base = ownedTmp("bead-replayable", harness === undefined ? {} : { root: harness }).path;
const scripts = join(import.meta.dir, "..", "..", "scripts");
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const DESCRIPTION = "WHAT: (a) a widget. WHY: needed.";
let serial = 0;

/** A fake `br` whose `show` and `list` print the rows in bead.json; anything else exits 2. */
function fakeBr(rows: unknown[]): { dir: string; br: string } {
	const dir = join(base, `t${++serial}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "rows.json"), JSON.stringify(rows));
	const br = join(dir, "br");
	writeFileSync(br, `#!/bin/sh\ncase " $* " in *" show "*|*" list "*) cat ${JSON.stringify(join(dir, "rows.json"))}; exit 0;; esac\nexit 2\n`);
	chmodSync(br, 0o755);
	return { dir, br };
}

async function lint(script: "br-create-lint.py" | "br-update-lint.py", argv: string[], rows: unknown[], extraEnv: Record<string, string> = {}): Promise<{ rc: number | null; err: string }> {
	const { dir, br } = fakeBr(rows);
	const prefix = script === "br-create-lint.py" ? "BR_CREATE" : "BR_UPDATE";
	const r = await run(["python3", join(scripts, script), ...argv], { cwd: dir, deadline_s: 60, env: { ...process.env, [`${prefix}_REAL`]: br, [`${prefix}_PROJECT`]: dir, ...extraEnv } as Record<string, string> });
	return { rc: r.rc, err: decode(r.stderr) };
}

const create = (acceptance: string) => lint("br-create-lint.py", ["create", "Replayable fixture", "-t", "task", "-l", "gate", "--description", DESCRIPTION, "--acceptance", acceptance], []);
const LEGACY_BOX = "- [ ] [a] [build] the old parser handles tags; planted negative: an untagged line is refused";
const stored = { id: "rp-1", title: "Legacy fixture", status: "in_progress", priority: 2, issue_type: "task", labels: ["gate"], description: DESCRIPTION, acceptance_criteria: LEGACY_BOX, created_at: "2026-10-20T00:00:00Z", dependencies: [] };
const update = (...flags: string[]) => lint("br-update-lint.py", ["update", "rp-1", ...flags], [stored]);

test("REPLAYABLE1 planted negative: a create whose non-[v] box names no backticked command is refused, naming the box and the corrected shape", async () => {
	const box = "- [ ] [a] [build] the widget builds; planted negative: bad input is refused";
	const res = await create(box);
	expect(res.rc).toBe(4);
	expect(res.err).toContain("LINT_REFUSED r-verify-replayable:ACCEPTANCE_NOT_REPLAYABLE box 1");
	expect(res.err).toContain(JSON.stringify(box));
	expect(res.err).toContain("names no backticked command; corrected shape: - [ ] [a] [build] <what it proves> `<one bounded command>` -> rc 0");
});

test("REPLAYABLE1 planted negative: a multi-letter tag [a,b] is refused as a tag run verify cannot replay", async () => {
	const res = await create("- [ ] [a,b] [build] the widget builds `true` -> rc 0; planted negative: bad input is refused");
	expect(res.rc).toBe(4);
	expect(res.err).toContain("box 1 \"- [ ] [a,b] [build]");
	expect(res.err).toContain("has a tag run that is not one scope letter a-z then one phase");
});

test("REPLAYABLE1 control: the same create with a backticked command and an arrow expected outcome is admitted", async () => {
	const res = await create("- [ ] [a] [build] the widget builds; planted negative: bad input is refused `true` -> rc 0\n- [ ] [v] [live] verification note, never replayed");
	expect(res).toEqual({ rc: 0, err: "" });
});

test("REPLAYABLE1 exit-only: a box with a command and no expected outcome is admitted and reported exit-only", async () => {
	const res = await create("- [ ] [a] [build] the widget builds `true`; planted negative: bad input is refused");
	expect(res.rc).toBe(0);
	expect(res.err).toContain("REPLAYABLE_EXIT_ONLY <new>: box 1 names a command but no expected outcome");
});

test("REPLAYABLE1 legacy: an update that leaves a non-replayable box unchanged is admitted and reports it; a new commandless box is refused", async () => {
	expect(await update("--title", "Legacy fixture, renamed")).toEqual({ rc: 0, err: "" });
	const kept = await update("--acceptance-criteria", `${LEGACY_BOX.replace("- [ ]", "- [x]")}\n- [ ] [a] [landed] the new path runs \`true\` -> rc 0`);
	expect(kept.rc).toBe(0);
	expect(kept.err).toContain("ACCEPTANCE_NOT_REPLAYABLE_LEGACY rp-1: unchanged boxes omp-kit verify cannot replay (reported, not refused): box 1");
	const added = await update("--add-acceptance", "[a] [landed] the new path runs; planted negative: bad input refused");
	expect(added.rc).toBe(4);
	expect(added.err).toContain("r-verify-replayable:ACCEPTANCE_NOT_REPLAYABLE box 2");
	// The untouched box 1 rides the legacy notice, never the refusal line.
	expect(added.err.split("\n").find(line => line.includes("LINT_REFUSED"))).not.toContain("box 1 ");
	expect(added.err).toContain("ACCEPTANCE_NOT_REPLAYABLE_LEGACY rp-1: unchanged boxes omp-kit verify cannot replay (reported, not refused): box 1");
	const changed = await update("--acceptance-criteria", LEGACY_BOX.replace("old parser", "new parser"));
	expect(changed.rc).toBe(4);
	expect(changed.err).toContain("r-verify-replayable:ACCEPTANCE_NOT_REPLAYABLE box 1");
});

/** The claim gate as each caller runs it: br-shim.sh (gate only) and the kit-flywheel-guard extension (full update lint). */
const CALLERS: [string, Record<string, string>][] = [["shim", { BR_UPDATE_REPLAYABLE_ONLY: "1" }], ["extension", {}]];
const REWRITTEN = "- [ ] [a] [build] the old parser handles tags; planted negative: an untagged line is refused `true` -> rc 0";

for (const [caller, env] of CALLERS) {
	for (const move of [["--claim"], ["--status", "in_review"]]) {
		test(`REPLAYABLE1.claim planted (${caller}, ${move.join(" ")}): a legacy bead with a commandless box is refused REFUSED_NOT_REPLAYABLE naming the box and the fix; rewritten, it is admitted`, async () => {
			const refused = await lint("br-update-lint.py", ["update", "rp-1", ...move], [stored], env);
			expect(refused.rc).toBe(4);
			expect(refused.err).toContain("LINT_REFUSED REFUSED_NOT_REPLAYABLE");
			expect(refused.err).toContain(`REFUSED_NOT_REPLAYABLE box 1 ${JSON.stringify(LEGACY_BOX)} names no backticked command; corrected shape: - [ ] [a] [build] <what it proves> \`<one bounded command>\` -> rc 0`);
			const admitted = await lint("br-update-lint.py", ["update", "rp-1", ...move], [{ ...stored, acceptance_criteria: REWRITTEN }], env);
			expect(admitted.rc).toBe(0);
			expect(admitted.err).not.toContain("REFUSED_NOT_REPLAYABLE");
		});
	}
}

test("REPLAYABLE1.claim planted: a bead with no box in the verify grammar is refused at claim; a claim that rewrites the boxes in the same command is judged on the new text", async () => {
	const untagged = { ...stored, acceptance_criteria: "- [ ] AC1: the parser handles tags" };
	const refused = await lint("br-update-lint.py", ["update", "rp-1", "--claim"], [untagged], { BR_UPDATE_REPLAYABLE_ONLY: "1" });
	expect(refused.rc).toBe(4);
	expect(refused.err).toContain("REFUSED_NOT_REPLAYABLE no acceptance box verify can replay");
	const rewritten = await lint("br-update-lint.py", ["update", "rp-1", "--claim", "--acceptance-criteria", REWRITTEN], [untagged]);
	expect(rewritten.err).not.toContain("REFUSED_NOT_REPLAYABLE");
	// Workflow moves other than a claim or review entry stay ungated.
	expect(await lint("br-update-lint.py", ["update", "rp-1", "--status", "blocked"], [untagged], { BR_UPDATE_REPLAYABLE_ONLY: "1" })).toEqual({ rc: 0, err: "" });
});

/** The fixture repo verify exports: one commit, so every replayable box has something to run. */
async function exportRepo(): Promise<{ dir: string; sha: string }> {
	const dir = join(base, "export-repo");
	mkdirSync(join(dir, "scripts"), { recursive: true });
	writeFileSync(join(dir, "scripts", "ok.sh"), "#!/bin/sh\necho ok\n");
	const git = async (...args: string[]) => {
		const r = await run(["git", "-c", "user.name=t", "-c", "user.email=t@x", ...args], { cwd: dir, deadline_s: 60 });
		if (r.rc !== 0) throw new Error(`git ${args.join(" ")}: ${decode(r.stderr)}`);
		return decode(r.stdout).trim();
	};
	await git("init", "-q");
	await git("add", "-A");
	await git("commit", "-q", "-m", "fixture [test]");
	return { dir, sha: await git("rev-parse", "HEAD") };
}

/** Does `omp-kit verify` refuse this acceptance ACCEPTANCE_NOT_REPLAYABLE? (dry run against a fake tracker). */
async function verifyRefuses(acceptance: string, repo: { dir: string; sha: string }): Promise<boolean> {
	const { dir } = fakeBr([{ id: "kit-1", status: "in_review", assignee: "Author", updated_at: "2026-10-26T00:00:00Z", labels: [], acceptance_criteria: acceptance }]);
	const res = await verifyBead({ bead: "kit-1", exportSha: repo.sha, repo: repo.dir, actor: "Peer", env: { PATH: `${dir}:${process.env.PATH ?? ""}` }, dryRun: true });
	return res.code === "ACCEPTANCE_NOT_REPLAYABLE";
}

/** Does the create lint refuse it r-verify-replayable? (other checks do not count). */
const lintRefuses = async (acceptance: string) => (await create(acceptance)).err.includes("r-verify-replayable");

const PARITY: string[] = [
	"- [ ] [a] [build] widget builds `sh scripts/ok.sh` -> prints ok; planted negative refused",
	"- [ ] [a] [build] widget builds and the UI looks right; planted negative refused",
	"- [ ] [a,b] [build] widget builds `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [ ] [a] [b] [build] widget builds `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [ ] [a] [after 7d] widget holds `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [ ] [a] `sh scripts/ok.sh` -> rc 0 letter only, no phase; planted negative refused",
	"- [ ] [build] phase only `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [ ] [a] [live] on the installed kit `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [x] [a] [build] ticked but names no command; planted negative refused",
	"- [ ] [v] [live] verification note\n- [ ] [a] [landed] widget lands `sh scripts/ok.sh` -> rc 0; planted negative refused",
	"- [ ] [a] [build] exit-only `sh scripts/ok.sh`; planted negative refused",
];

/** Fixtures on which a judge disagrees with what verify does. */
async function divergences(judge: (acceptance: string) => Promise<boolean> | boolean, repo: { dir: string; sha: string }): Promise<string[]> {
	const out: string[] = [];
	for (const acceptance of PARITY) if ((await judge(acceptance)) !== (await verifyRefuses(acceptance, repo))) out.push(acceptance);
	return out;
}

test("REPLAYABLE1 parity: on every fixture box the create lint refuses exactly what omp-kit verify refuses ACCEPTANCE_NOT_REPLAYABLE", async () => {
	const repo = await exportRepo();
	const verdicts = await Promise.all(PARITY.map(async acceptance => [await verifyRefuses(acceptance, repo), await lintRefuses(acceptance)]));
	// Both outcomes are exercised, so agreement is not vacuous.
	expect(verdicts.filter(([v]) => v).length).toBeGreaterThanOrEqual(5);
	expect(verdicts.filter(([v]) => !v).length).toBeGreaterThanOrEqual(5);
	expect(await divergences(lintRefuses, repo)).toEqual([]);
	// Planted second copy of the grammar (letter AND phase required, as the pre-REPLAYABLE1 docs read it):
	// verify replays the letter-only and phase-only boxes this judge refuses, and the parity check names them.
	const secondCopy = (acceptance: string) => !acceptance.split("\n").every(line => line.startsWith("- [ ] [v]") || /^- \[[ xX]\] \[[a-z]\] \[(?:build|landed|live|after)\] [^`]*`[^`]+`/.test(line));
	expect(await divergences(secondCopy, repo)).toEqual([PARITY[5]!, PARITY[6]!]);
}, 120_000);
