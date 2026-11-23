// Coverage: scripts/bead_lint.py (priorart_failure), scripts/br_create_guard_core.py (lint_prospective), scripts/br-update-lint.py (claim gate).
import { afterAll, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { realpathSync, writeFileSync } from "node:fs";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

// PRIORART1 (ompkit-dpbsq, J-2026-11-23-12/-13): a bead is created or claimed only with the five lines that say what it adopts.
afterAll(cleanupAllOwnedTmp);

const scripts = join(import.meta.dir, "../../scripts");
const FIVE = [
	"GOAL: land gate green on the Mac; measured by land refusals per day.",
	"NATIVE: `git --version` has no hook for this; checked 2026-11-23.",
	"EXISTING: the kit bead-lint (scripts/bead_lint.py) already refuses placeholders.",
	"DECISION: EXTEND the kit bead-lint; no new tool.",
	"BEST: a bead template filled by br itself; not chosen because br has no template hook.",
];
const WHAT_WHY = "WHAT: the guard refuses a bead without prior art.\nWHY: measured 2026-11-23, 0 of 38 active beads carried it.\n";
const PITFALLS = "\n## Pitfalls\n- keep the guard read only and never raise a limit\n";
const ACCEPTANCE = "- [ ] [a] [build] the guard refuses the bare bead. `bun test tests/cli/x.test.ts -t X` -> 0 fail";

function environment(extra: Record<string, string>): Record<string, string> {
	const path = [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
	return { PATH: path, HOME: process.env.HOME ?? "/", ...extra };
}

/** A tracker stand-in: `br list` is empty and `br show` prints the stored bead, so the helpers read no real tracker. */
function stubTracker(bead: Record<string, unknown>): { br: string; dir: string } {
	const dir = realpathSync(ownedTmp("bead-lint-priorart").path);
	writeFileSync(join(dir, "show.json"), JSON.stringify([bead]));
	const br = join(dir, "br");
	writeFileSync(br, `#!/bin/sh\ncase "$1" in\n  list) echo '[]';;\n  show) cat "${dir}/show.json";;\n  *) echo "stub br: $*" >&2; exit 2;;\nesac\n`, { mode: 0o755 });
	return { br, dir };
}

function lintCreate(description: string, extra: string[] = []): { rc: number; err: string } {
	const { br, dir } = stubTracker({ id: "ompkit-none" });
	const result = runFixture(["python3", "-I", join(scripts, "br-create-lint.py"), "create", "A prior-art probe title", "-t", "bug", "-p", "2",
		"-d", description, "--acceptance-criteria", ACCEPTANCE, "-l", "bug", ...extra], {
		cwd: dir, env: environment({ BR_CREATE_REAL: br, BR_CREATE_PROJECT: dir }),
	});
	return { rc: result.rc ?? -1, err: new TextDecoder().decode(result.stderr) };
}

function lintClaim(description: string, flags: string[], type = "task"): { rc: number; err: string } {
	const { br, dir } = stubTracker({
		id: "ompkit-probe", title: "A probe bead", status: "open", priority: 2, issue_type: type, labels: ["bug"],
		created_at: "2026-11-23T00:00:00Z", description, acceptance_criteria: ACCEPTANCE, dependencies: [],
	});
	const result = runFixture(["python3", join(scripts, "br-update-lint.py"), "update", "ompkit-probe", ...flags], {
		cwd: dir, env: environment({ BR_UPDATE_REAL: br, BR_UPDATE_PROJECT: dir }),
	});
	return { rc: result.rc ?? -1, err: new TextDecoder().decode(result.stderr) };
}

test("PRIORART1: a create without the five lines is refused naming the missing fields; with all five it is admitted", () => {
	const bare = lintCreate(WHAT_WHY + PITFALLS);
	expect(bare.rc, bare.err).toBe(4);
	expect(bare.err).toContain("PRIORART_MISSING");
	for (const field of ["GOAL", "NATIVE", "EXISTING", "DECISION", "BEST"]) expect(bare.err).toContain(field);
	const full = lintCreate(`${WHAT_WHY}${FIVE.join("\n")}\n${PITFALLS}`);
	expect(full.rc, full.err).toBe(0);
	// A leading bullet, a quote and any case are the same lines.
	const dressed = lintCreate(`${WHAT_WHY}${FIVE.map((line, i) => (["- ", "> ", "* ", "", "- "][i] ?? "") + (i === 3 ? line.toLowerCase() : line)).join("\n")}\n${PITFALLS}`);
	expect(dressed.rc, dressed.err).toBe(0);
}, fixtureDeadlineS() * 1000);

test("PRIORART1 planted: four lines without BEST, or a goal: mentioned mid-line, are still refused", () => {
	const noBest = lintCreate(`${WHAT_WHY}${FIVE.slice(0, 4).join("\n")}\n${PITFALLS}`);
	expect(noBest.rc, noBest.err).toBe(4);
	expect(noBest.err).toMatch(/lacks BEST[,\s]/);
	expect(noBest.err).not.toMatch(/lacks [^,]*GOAL/);
	const midLine = lintCreate(`${WHAT_WHY}This bead moves the goal: speed, and the native: tools, existing: ones, decision: made, best: option.\n${PITFALLS}`);
	expect(midLine.rc, midLine.err).toBe(4);
	for (const field of ["GOAL", "NATIVE", "EXISTING", "DECISION", "BEST"]) expect(midLine.err).toContain(field);
}, fixtureDeadlineS() * 1000);

test("PRIORART1: an epic needs no prior-art lines; a hardstop-labelled bug does", () => {
	const epic = lintCreate(WHAT_WHY + PITFALLS, ["-t", "epic"]);
	expect(epic.err).not.toContain("PRIORART_MISSING");
	const hardstop = lintCreate(WHAT_WHY + PITFALLS, ["-l", "hardstop:money"]);
	expect(hardstop.rc, hardstop.err).toBe(4);
	expect(hardstop.err).toContain("PRIORART_MISSING");
}, fixtureDeadlineS() * 1000);

test("PRIORART1: a claim by --claim or --status in_progress of a bead without the five lines is refused; with them it is admitted", () => {
	for (const flags of [["--claim"], ["--status", "in_progress"]]) {
		const bare = lintClaim(WHAT_WHY + PITFALLS, flags);
		expect(bare.rc, bare.err).toBe(4);
		expect(bare.err).toContain("REFUSED_NO_PRIOR_ART");
		expect(bare.err).toContain("PRIORART_MISSING");
		const full = lintClaim(`${WHAT_WHY}${FIVE.join("\n")}\n${PITFALLS}`, flags);
		expect(full.rc, full.err).toBe(0);
	}
	const noBest = lintClaim(`${WHAT_WHY}${FIVE.slice(0, 4).join("\n")}\n${PITFALLS}`, ["--claim"]);
	expect(noBest.rc, noBest.err).toBe(4);
	expect(noBest.err).toMatch(/lacks BEST[,\s]/);
}, fixtureDeadlineS() * 1000);

test("PRIORART1: a claim that carries the lines in its own --description-file, and a claim of an epic, are admitted; other updates never check", () => {
	const dir = realpathSync(ownedTmp("bead-lint-priorart-file").path);
	const file = join(dir, "description.md");
	writeFileSync(file, `${WHAT_WHY}${FIVE.join("\n")}\n${PITFALLS}`);
	const viaFile = lintClaim(WHAT_WHY + PITFALLS, ["--claim", "--description-file", file]);
	expect(viaFile.rc, viaFile.err).toBe(0);
	const epic = lintClaim(WHAT_WHY + PITFALLS, ["--claim"], "epic");
	expect(epic.err).not.toContain("PRIORART_MISSING");
	const priority = lintClaim(WHAT_WHY + PITFALLS, ["--priority", "1"]);
	expect(priority.rc, priority.err).toBe(0);
}, fixtureDeadlineS() * 1000);
