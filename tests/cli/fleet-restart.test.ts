import { expect, test } from "bun:test";
import { join } from "node:path";
import { runSync } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

// ompkit-fp72.120.16.203: a kit fleet restart must relaunch omp at info, not omp's debug default,
// while the pane shell keeps an operator's explicit OMP_LOG_LEVEL.
const SCRIPTS = join(import.meta.dir, "../../skills/fleet-restart/scripts");
const decoder = new TextDecoder();

function respawnCmd(): string {
	const result = runSync(["python3", "-B", "-c", "import sys; sys.path.insert(0, sys.argv[1]); import fleet_restart as fr; print(fr.respawn_cmd({'cwd': '/w d', 'flags': ['--profile', 'claude']}))", SCRIPTS], { deadline_s: fixtureDeadlineS(30) });
	expect(result.rc).toBe(0);
	return decoder.decode(result.stdout).trim();
}

/** The launch line's env assignment before `omp`, run by /bin/sh in front of printenv. */
function levelUnder(cmd: string, level: string | undefined): string {
	const tail = cmd.split("&& ", 2)[1] ?? "";
	const assign = tail.slice(0, tail.indexOf("omp "));
	const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
	if (level !== undefined) env.OMP_LOG_LEVEL = level;
	// The pane shell expands the line's assignment; `eval` stands in for the pane typing it.
	const result = runSync(["/bin/sh", "-c", "eval \"$1/usr/bin/printenv OMP_LOG_LEVEL\"", "sh", assign], { deadline_s: fixtureDeadlineS(10), env });
	return decoder.decode(result.stdout).trim();
}

test("TTSRLOG1 respawn line launches omp at info when OMP_LOG_LEVEL is unset", () => {
	const cmd = respawnCmd();
	expect(cmd).toBe("cd '/w d' && OMP_LOG_LEVEL=${OMP_LOG_LEVEL:-info} omp --profile claude");
	expect(levelUnder(cmd, undefined)).toBe("info");
});

test("TTSRLOG1 planted: an operator's OMP_LOG_LEVEL=debug is kept", () => {
	expect(levelUnder(respawnCmd(), "debug")).toBe("debug");
});

test("TTSRLOG1 mutant: without the prefix the unset case gets no level (omp's debug default)", () => {
	const mutant = respawnCmd().replace("OMP_LOG_LEVEL=${OMP_LOG_LEVEL:-info} ", "");
	expect(levelUnder(mutant, undefined)).toBe("");
});
