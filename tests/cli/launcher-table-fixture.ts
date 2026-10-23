import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Rows that run `service run <job>` are kept only when the pid (first column) is the owner or
// one of its descendants. Every other row, column and the exit status pass through unchanged.
const OWNED_LAUNCHERS_AWK = `BEGIN {
	n = split(ENVIRON["FIXTURE_TREE"], rows, "\\n")
	for (i = 1; i <= n; i++) if (split(rows[i], f, " ") == 2) parent[f[1] + 0] = f[2] + 0
	owner = ENVIRON["FIXTURE_OWNER"] + 0
}
function owned(pid,    hops) {
	for (hops = 0; hops < 4096; hops++) {
		if (pid == owner) return 1
		if (!(pid in parent) || parent[pid] == pid) return 0
		pid = parent[pid]
	}
	return 0
}
!/(^|[ \\t])service[ \\t]+run([ \\t]|$)/ || ($1 ~ /^[0-9]+$/ && owned($1 + 0))`;

let tableBin: string | undefined;

// MAINRED1 (ompkit-kl9p3), REL75 full suite: `tableBin` is cached per test process, and every test file ends with
// `afterAll(() => cleanupAllOwnedTmp())`, which removes this registered dir too, so the next file in the same
// `bun test` process got the cached path of a deleted shim (ps ENOENT x2). A cached path whose shim is gone is now
// rebuilt. The dir stays in the per-file cleanup set on purpose: under bun 1.4.3's test runner process "exit" never
// fires (measured), so a dir kept out of that set would leak once per test process.

/**
 * Fixture-owned process table for tests that spawn a real `service run <job>`.
 * The run's launcher admission (ompkit-bj08.5 [d], src/service-run.ts
 * observeServiceLaunchers) reads the whole host `ps` table and refuses
 * SKIPPED-ADMISSION when any `service run <job>` process other than its own
 * keeper is alive. On a shared host that table also holds the same job run
 * by a parallel test file (bun test --parallel) and by live launchd/systemd
 * jobs, so an isolated HOME alone does not isolate the run. Returns a
 * directory to put first on the CLI's PATH: its `ps` runs the next `ps` on
 * PATH (the real one, or another fixture's fake behind it) and drops only
 * `service run` rows outside this test process's own tree, so the fixture's
 * own launchers, including a planted second one, stay observed.
 *
 * One shim per test process, executed once here: macOS assesses a newly
 * written executable on its first exec (0.2-2.5 s under load), which must not
 * land inside a timed run. Call it at module load, outside any test.
 */
export function fixtureLauncherTableBin(): string {
	if (tableBin !== undefined && existsSync(join(tableBin, "ps"))) return tableBin;
	const awk = Bun.which("awk");
	if (awk === null) throw new Error("fixture launcher table needs awk on the test PATH");
	const root = join(import.meta.dir, "../../var/agent-tmp");
	mkdirSync(root, { recursive: true });
	const dir = ownedTmp("fixture-launcher-table", { root }).path;
	const shim = join(dir, "ps");
	writeFileSync(shim, [
		"#!/bin/sh",
		`# Fixture-owned process table: service run rows outside test process ${process.pid}'s tree are hidden.`,
		`self=${shellQuote(dir)}`,
		"[ -z \"$FIXTURE_LAUNCHER_TABLE_NESTED\" ] || { echo \"fixture ps: the launcher table resolved itself as the next ps\" >&2; exit 1; }",
		"ps=",
		"set -f",
		"saved_ifs=$IFS",
		"IFS=:",
		"for entry in $PATH; do",
		"\t[ \"$entry\" = \"$self\" ] || [ \"$entry/ps\" -ef \"$self/ps\" ] && continue",
		"\tif [ -f \"$entry/ps\" ] && [ -x \"$entry/ps\" ]; then ps=$entry/ps; break; fi",
		"done",
		"IFS=$saved_ifs",
		"[ -n \"$ps\" ] || { echo \"ps: not found on PATH behind the fixture launcher table\" >&2; exit 127; }",
		"table=$(FIXTURE_LAUNCHER_TABLE_NESTED=1 \"$ps\" \"$@\")",
		"rc=$?",
		"tree=$(FIXTURE_LAUNCHER_TABLE_NESTED=1 \"$ps\" -axo pid=,ppid=) || { echo \"fixture ps: process tree unobservable\" >&2; exit 1; }",
		"if [ -n \"$table\" ]; then",
		`\tprintf '%s\\n' "$table" | FIXTURE_OWNER=${process.pid} FIXTURE_TREE="$tree" ${shellQuote(awk)} ${shellQuote(OWNED_LAUNCHERS_AWK)} || exit 1`,
		"fi",
		"exit \"$rc\"",
		"",
	].join("\n"), { mode: 0o700 });
	const warm = runSync([shim, "-o", "pid=", "-p", String(process.pid)], { deadline_s: 30 });
	if (warm.rc !== 0 || new TextDecoder().decode(warm.stdout).trim() !== String(process.pid)) {
		throw new Error(`fixture launcher table ps did not report its own process (rc ${warm.rc}): ${new TextDecoder().decode(warm.stderr)}`);
	}
	tableBin = dir;
	return dir;
}
