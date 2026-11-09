- Retire the pre-canonical commit-msg stamp pair (`10-commit-msg` plus its stale
  sibling impl) when installing hooks; the canonical `41-omp-kit-commit-msg-vlevel`
  member keeps enforcing the same rule with the same refusal text and code, so a
  stamp-less commit is now refused once instead of twice.
- Record the commit-time bead PASS verdict and reuse it at push and ref-update
  time: the commit-msg member writes a pending record, a new post-commit member
  copies it to a record keyed by the exact commit sha under
  `.git/omp-kit/bead-verdicts/`, and the pre-push and reference-transaction bead
  members admit recorded shas without re-running `br` per commit. Commits with no
  record (e.g. `commit-tree` plumbing that bypassed commit-msg) still take today's
  live `br` check and are refused at push.
