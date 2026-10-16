### Fixed

- `scripts/close-guard.sh` now refuses a close or grade by any earlier implementer of the bead, not only the current assignee or the first `Agent:` trailer. Every commit that names the bead id as an exact token is checked, and any `Agent:` trailer equal to the caller (case-insensitive, trimmed) refuses with that commit's sha. The id match is fixed-string and token-bounded, so a commit for `X.112` no longer counts as a commit for `X.1`. [test]
- The guard also re-reads the bead just before deciding and refuses (exit 4) when its `assignee` or `updated_at` changed since the first read, so a claim that moves mid-check is never judged on stale data. [test]
