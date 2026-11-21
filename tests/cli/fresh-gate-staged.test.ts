// Coverage: scripts/fresh-gate.sh (gate_staged), scripts/check-staged-pysafe.sh, scripts/check-staged-tempsafe.sh,
// scripts/check-staged-imports.sh, scripts/check-staged-kitlib.sh, scripts/pysafe_check.py, scripts/tempsafe_check.py.
// STAGEDGATE1: the commit gate runs the pre-commit members over the candidate. A handoff committed in an ovnfs checkout
// has no hook, and a shell program passed as a variable in a test reached main (6e6440a0eb) and failed both hosted
// ladder jobs; the gate now refuses it, and any other member's finding, before the push.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { gate, gateFunctions, root, scratchRoot } from "./fresh-gate.helpers.ts";

const decoder = new TextDecoder();
const gitEnv = {
	PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]): string {
	const result = runSync(["git", "-C", cwd, ...args], { deadline_s: fixtureDeadlineS(30), env: gitEnv });
	expect(result.rc, decoder.decode(result.stderr)).toBe(0);
	return decoder.decode(result.stdout).trim();
}

function commitFile(repo: string, path: string, text: string): string {
	writeFileSync(join(repo, path), text);
	git(repo, ["add", "--", path]);
	git(repo, ["commit", "-q", "-m", `fixture ${path}`]);
	return git(repo, ["rev-parse", "HEAD"]);
}

// The fixture sources are generated, so this file itself carries no literal shell-program call or mktemp for the
// members to read.
const shellDashC = ["sh", "-c"].map(part => JSON.stringify(part)).join(", ");
const dynamicShell = [
	'import { run } from "../src/kitlib/run.ts";',
	'const command = process.argv[2] ?? "true";',
	`export const replay = await run([${shellDashC}, command], { cwd: ".", deadline_s: 120 });`,
	"",
].join("\n");
const scriptFile = [
	'import { writeFileSync } from "node:fs";',
	'import { run } from "../src/kitlib/run.ts";',
	'const command = process.argv[2] ?? "true";',
	'writeFileSync("replay.sh", `${command}\\n`);',
	'export const replay = await run([' + JSON.stringify("sh") + ', "replay.sh"], { cwd: ".", deadline_s: 120 });',
	"",
].join("\n");
const leakyTemp = ["#!/bin/sh", `d=$(${["mkt", "emp"].join("")} -d)`, 'echo "$d"', ""].join("\n");

/** Run the gate's real gate_staged against BASE..COMMIT in `repo`; the members come from this checkout's own tree. */
function stagedGate(repo: string, base: string, commit: string, dir: string): { rc: number | null; output: string } {
	const harness = join(dir, "staged-gate.sh");
	const work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	writeFileSync(harness, `set -eu\n${gateFunctions(readFileSync(gate, "utf8"), ["gate_staged"])}ARCHIVE_DIR=$1\nFRESH_GATE_REPO=$2\nBASE=$3\nCOMMIT=$4\nROOT=$2\nWORK=$5\ngate_staged\n`);
	const result = runSync(["sh", harness, root, repo, base, commit, work], { deadline_s: fixtureDeadlineS(120), env: gitEnv });
	rmSync(work, { recursive: true, force: true });
	return { rc: result.rc, output: decoder.decode(result.stdout) + decoder.decode(result.stderr) };
}

test("STAGEDGATE1: the gate runs the pre-commit members and refuses a hidden shell program and a leaked temp dir, and passes the clean forms", () => {
	const dir = ownedTmp("fresh-gate-staged", { root: scratchRoot }).path;
	const repo = join(dir, "repo");
	try {
		mkdirSync(join(repo, "lib"), { recursive: true });
		mkdirSync(join(repo, "src/kitlib"), { recursive: true });
		git(repo, ["init", "-q"]);
		commitFile(repo, "src/kitlib/run.ts", "export async function run(_argv: string[], _options: object): Promise<number> { return 0; }\n");
		const base = commitFile(repo, "lib/clean.ts", "export const answer = 42;\n");

		const hidden = commitFile(repo, "lib/hidden.ts", dynamicShell);
		const refusedShell = stagedGate(repo, base, hidden, dir);
		expect(refusedShell.rc, refusedShell.output).not.toBe(0);
		expect(refusedShell.output).toContain("check-staged-pysafe.sh REFUSED");
		expect(refusedShell.output).toContain("dynamic executable shell argument");

		git(repo, ["checkout", "-q", "-b", "temp", base]);
		const leaky = commitFile(repo, "lib/leaky.sh", leakyTemp);
		const refusedTemp = stagedGate(repo, base, leaky, dir);
		expect(refusedTemp.rc, refusedTemp.output).not.toBe(0);
		expect(refusedTemp.output).toContain("check-staged-tempsafe.sh REFUSED");

		// The fixed form of the same replay, committed on its own branch from the same base, passes every member.
		git(repo, ["checkout", "-q", "-b", "fixed", base]);
		const fixed = commitFile(repo, "lib/hidden.ts", scriptFile);
		const accepted = stagedGate(repo, base, fixed, dir);
		expect(accepted.rc, accepted.output).toBe(0);
		expect(accepted.output).toContain("check-staged-pysafe.sh ok");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, fixtureDeadlineS(120) * 1000);
