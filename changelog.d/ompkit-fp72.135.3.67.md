### Changed
- The staged-kitlib ratchet limits published-origin exceptions to exact incumbent raw-spawn entries and requires a complete, named `Revert: X` parent reversal with per-path commit-msg verdicts; ordinary and non-excepted findings remain enforced.
- A `Revert:` trailer on an ordinary commit (a root, partial or multi-commit rewrite with no published-origin admission) now gets the ordinary ratchet verdict instead of the exact named-X proof, so declared rewrites judged by the stale-worktree gate are no longer refused; active ratchet findings are still refused.
