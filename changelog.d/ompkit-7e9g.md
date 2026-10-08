Add scratch-is-not-a-home to keep durable instructions and rerunnable artifacts out of var/agent-tmp; preserve throwaway output there.

RX1 permits the exact `[\s\S]` all-character condition only for literal-discriminated `tool:write`/`tool:edit` scopes below `var/agent-tmp`. It remains measured for near-miss cost, and file-only scopes do not count against the Bash stream budget; broad or unscoped match-any conditions remain rejected.
