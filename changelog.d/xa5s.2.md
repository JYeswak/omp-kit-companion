### Fixed

- `ompkit-xa5s.2`: rewrote forbidden instructions in 4 skill reference files under
  `~/.claude/skills` to the fleet rule (one canonical checkout on `main`, no rebase or
  stash in a shared checkout, evidence close): `frankensqlite-mega-skill/references/REPO-WORKFLOW.md`
  (negation-first stash line, evidence-close example), `ntm/references/SPAWN.md` (TOC,
  `--worktrees` flag row, and scenario 2 redirect), `ntm/references/TROUBLESHOOTING.md`
  (worktree-identity paragraph), `world-class-doctor-mode-for-cli-tools/references/exemplars/exemplars.md`
  (dcg-redirect exemplar no longer names stash as the shared-checkout alternative).
- Classified the remaining 57 firing files as legitimate with reasons (subject-is-the-act:
  14 `git-stash-janitor`, 30 `git-worktree-branch-rationalization`, `git-worktree-manager`,
  `using-git-worktrees`; guard-policy docs: 5 `dcg`; quoted upstream text: 6 `planning-arc` ledgers).
- Verified with the shipped rule: pre-edit Triggered (1) on all 4 files, post-edit quiet,
  full rescan 61 -> 57 files (only the legitimate list), planted bare `--reason "done"`
  in a temp copy fires. Edits left uncommitted in `~/.claude` (no commit/push per worker contract).
