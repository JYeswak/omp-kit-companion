# Mechanical worker callbacks

The shipped `kit-callback` extension reports terminal DONE/BLOCKED lines, or bounded IDLE excerpts, from worker `agent_end` events to the configured fleet coordinator. It skips continuations and coordinator panes, deduplicates identical consecutive callbacks, and fails silently on missing configuration or send errors.
