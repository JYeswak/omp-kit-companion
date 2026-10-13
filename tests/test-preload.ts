import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve(import.meta.dir, "../var/agent-tmp"), { recursive: true });
// Fixture Git processes must resolve repositories from their explicit cwd,
// not from the surrounding hook, private index, or agent environment.
for (const name of Object.keys(process.env)) {
	if (name.startsWith("GIT_") && name !== "GIT_TERMINAL_PROMPT") delete process.env[name];
}


// GATESHIFT1 (ompkit-f2e4): tests must behave identically inside and outside
// tmux. Strip the session pin so socket discovery never resolves to the
// runner's live session; suites that need tmux pass explicit env.
for (const name of ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"]) delete process.env[name];
