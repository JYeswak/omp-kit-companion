import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve(import.meta.dir, "../var/agent-tmp"), { recursive: true });

// GATESHIFT1 (ompkit-f2e4): tests must behave identically inside and outside
// tmux. Strip the session pin so socket discovery never resolves to the
// runner's live session; suites that need tmux pass explicit env.
for (const name of ["TMUX", "TMUX_PANE", "TMUX_TMPDIR"]) delete process.env[name];
