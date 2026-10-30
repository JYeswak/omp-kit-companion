import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve(import.meta.dir, "../var/agent-tmp"), { recursive: true });
// Fixture Git processes must resolve repositories from their explicit cwd,
// not from the surrounding hook, private index, or agent environment.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_") && name !== "GIT_TERMINAL_PROMPT"
		&& name !== "GIT_CEILING_DIRECTORIES" && name !== "GIT_CONFIG_GLOBAL") delete process.env[name];
}
// Fixture file modes must not depend on the runner's umask: scripts/full-suite-verdict.sh runs every suite
// at umask 077, and the audit, migrate, repair and operator-snapshot fixtures create files that expect the
// 022 default (measured 2026-10-30: 8 mode assertions fail at 077, pass at 022). A test that needs another
// umask sets its own.
process.umask(0o022);

// GATESHIFT1 (ompkit-f2e4): tests must behave identically inside and outside
// tmux. Strip the session pin so socket discovery never resolves to the
// runner's live session; suites that need tmux pass explicit env.
for (const name of ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"]) delete process.env[name];
