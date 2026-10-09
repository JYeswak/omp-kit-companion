---
description: "A skill file must not teach agents worktrees, rebase, stash, or a bare-word bead close"
condition:
  - '(?i)-(?<![\w-]-)-worktrees?(?=[\s\x60'',;&|)\]=])(?<!(?:(?:^|[^\w-])(?:no|not|never|don[’'']?t|do[ \t]+not|avoid|without|forbid(?:s|den)?|ban(?:s|ned)?|instead[ \t]+of|rather[ \t]+than)\b|[✗❌⛔])[^\n]{0,200})'
  - '(?i)\bgit(?:[ \t]+-C[ \t]+[^\s;&|]+)?[ \t]+worktree[ \t]+add(?=[\s\x60''"])(?<!(?:(?:^|[^\w-])(?:no|not|never|don[’'']?t|do[ \t]+not|avoid|without|forbid(?:s|den)?|ban(?:s|ned)?|instead[ \t]+of|rather[ \t]+than)\b|[✗❌⛔])[^\n]{0,200})'
  - '(?i)\bgit(?:[ \t]+-C[ \t]+[^\s;&|]+)?[ \t]+(?:pull\b[^\n;&|]{0,200}?[ \t]--rebase(?=[\s\x60''"]|=(?!(?:false|no)[\s\x60''"])\w+[\s\x60''"])|rebase(?=[ \t]*[\x60''"\n;&|)]|[ \t]+[^\s-]|[ \t]+-(?!-(?:abort|quit)[\s\x60''"])[\w-]*[\s\x60''"=]))(?<!(?:(?:^|[^\w-])(?:no|not|never|don[’'']?t|do[ \t]+not|avoid|without|forbid(?:s|den)?|ban(?:s|ned)?|instead[ \t]+of|rather[ \t]+than)\b|[✗❌⛔])[^\n]{0,200})'
  - '(?i)\bgit(?:[ \t]+-C[ \t]+[^\s;&|]+)?[ \t]+stash(?=[ \t]+(?:push|save)[\s\x60''"]|[ \t]+-|[ \t]*[\x60''"\n;&|)])(?<!(?:(?:^|[^\w-])(?:no|not|never|don[’'']?t|do[ \t]+not|avoid|without|forbid(?:s|den)?|ban(?:s|ned)?|instead[ \t]+of|rather[ \t]+than)\b|[✗❌⛔])[^\n]{0,200})'
  - '(?i)\b(?:br|bd)[ \t]+close\b[^\n;&|]{0,200}?[ \t](?:--reason|-r)(?:[ \t]+|=)(?:(\\?["''])(?:done|completed?|fixed|finished|resolved|closed)[.!]?\1|(?:done|completed?|fixed|finished|resolved|closed)[.!]?(?=[\s\x60;&|)]))(?<!(?:(?:^|[^\w-])(?:no|not|never|don[’'']?t|do[ \t]+not|avoid|without|forbid(?:s|den)?|ban(?:s|ned)?|instead[ \t]+of|rather[ \t]+than)\b|[✗❌⛔])[^\n]{0,200})'
scope: "tool:write(**/SKILL.md), tool:edit(**/SKILL.md), tool:write(**/skills/**/*.md), tool:edit(**/skills/**/*.md)"
interruptMode: never
---
This skill text teaches agents an act the fleet forbids, and every agent that loads the skill will repeat it. Rewrite the line before you finish the write:

- `--worktrees` or `git worktree add` breaks **one canonical checkout on main**. Agent Mail file reservations are the isolation. Write `ntm spawn <proj> --cc=2` (no worktrees) and tell workers to reserve their exact paths.
- `git pull --rebase`, `git rebase` or `git stash` breaks **no rebase or stash in a shared checkout**: each moves or hides other agents' uncommitted work. Write the private-index landing instead: `GIT_INDEX_FILE=<scratch>.idx git read-tree origin/main`, add only your files, `write-tree`, `commit-tree -p origin/main`, push the sha.
- `br close <id> --reason "done"` (or `Completed`, `fixed`, `resolved`) breaks **director-only evidence close**: workers report, the director re-runs the check and closes with evidence. Write `br close <id> --reason "<command> -> <result>; commit <sha>"`.

A line that forbids the act stays quiet when the negation comes first on that line ("No --worktrees", "never git stash", a ✗ or ⛔ mark). A verdict after the act ("... is forbidden") does not quiet it: the reminder fires while the line streams, before the verdict exists. Only stash creation (`git stash`, `push`, `save`, or a flag) fires; subcommands that manage existing stashes (`list`, `show`, `drop`, `clear`, `pop`, `apply`) and `git rebase --abort` stay quiet. This is a reminder, not a block: the write still lands, so fix the text in the same turn.
