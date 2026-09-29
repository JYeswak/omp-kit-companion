---
description: "Kit forbidden pattern 1 (gate self-weakening): never switch the rule pack off by changing omp settings by hand"
condition:
  # JSON-wire shell words and positive key boundaries avoid premature prefix fires.
  # Only direct HOME=<temporary path> omp receives the isolated-HOME exemption.
  # Single-quoted search substitutions are inert; unescaped double-quoted ones execute.
  # Reject non-omp positions before evaluating the quote-context lookbehinds.
  - '(?=\bomp\s)(?<!\b(?:e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?<!(?:^|"command"\s*:\s*"|[;&|(]|\\n)\s*HOME=(?:/tmp|/private/tmp|/var/folders)/[^\s;&|"''\\$\x60]+\s+)\bomp\s+(?:(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+\s+)*?(?:config|''config''|\\"config\\")(?=[\s;&|)"\x60]|\\n)\s+(?:(?:set|reset|unset)|''(?:set|reset|unset)''|\\"(?:set|reset|unset)\\")(?=[\s;&|)"\x60]|\\n)\s+(?:(?:ttsr|disabledProviders|enabledProviders|discovery|extensions|disabledExtensions)(?:\.[A-Za-z0-9_.-]+)?|''(?:ttsr|disabledProviders|enabledProviders|discovery|extensions|disabledExtensions)(?:\.[A-Za-z0-9_.-]+)?''|\\"(?:ttsr|disabledProviders|enabledProviders|discovery|extensions|disabledExtensions)(?:\.[A-Za-z0-9_.-]+)?\\")(?=[\s;&|)"\x60]|\\n)'
scope: "tool:bash"
interruptMode: always
---
**Blocked before it ran.** The `bash` call you were in the middle of writing changes an omp setting that can switch off the rule pack or its guards. It was cut off while you wrote it, so it is not in your transcript: the last `bash` call you can see ran normally and is not the blocked one. The blocked call did not execute. Do not re-issue it unchanged.

`ttsr.*` is the rule engine's policy. `disabledProviders`, `enabledProviders` and `discovery.*` decide which rule sources load; the `agents` provider is where `~/.agents/rules` comes from. `extensions` and `disabledExtensions` load kit-guard-optin and the tool bridges. Changing any of them by hand is gate self-weakening (AGENTS.md forbidden pattern 1), even when the intent is harmless, and `omp config set` writes the profile with no confirmation.

- TTSR policy: from the omp-kit checkout, edit `policy/ttsr.json`, then run `sh scripts/apply-policy.sh --dry-run --include-default`; review the plan before running without `--dry-run`, then run `sh scripts/doctor.sh`.
- Extensions: from the omp-kit checkout, edit `policy/extensions.json`, then run `sh scripts/install-extensions.sh --dry-run`; review the plan before running without `--dry-run`.
- Anything else, or a one-off change to a live profile: ask the profile owner, with the exact command.
- Testing omp's config command itself: use a direct command-local assignment, `HOME=/tmp/<dir> omp config …`, with no intervening command or second assignment. `--profile` after `omp` remains isolated under that HOME. Do not add `env -u`, another `HOME=`, or profile/agent-dir environment overrides: they can restore the live destination and are not exempt. A `PI_CODING_AGENT_DIR=/tmp/…` prefix alone is not a throwaway: an active profile ignores it, and stripping profile variables can expose an inherited live agent dir.
