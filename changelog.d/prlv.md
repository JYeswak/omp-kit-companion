# Mechanical worker callbacks

The `package.json` OMP manifest declares `kit-callback` for plugin loading in worker sessions. It reports terminal DONE/BLOCKED lines, or bounded IDLE excerpts, from worker `agent_end` events to the configured fleet coordinator. It skips continuations and coordinator panes, deduplicates identical callbacks, and fails silently on missing configuration or send errors.
