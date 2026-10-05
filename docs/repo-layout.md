# Standard repo layout

Every fleet repo keeps the same top-level shape so agents and checks work
without per-repo configuration:

- `src/` — product source, one canonical module per concept.
- `tests/` — permanent tests that catch user-visible bugs.
- `scripts/` — runnable checks and automation (POSIX sh plus Bun).
- `docs/` — usage, contracts and references.
- `docs/adr/` — architecture decision records; see `0000-template.md`.
- `var/agent-tmp/` — agent scratch (labelled dirs with `.owner` files).
  Always gitignored; never committed.

Deviations are reported by `scripts/repo-layout-check.sh` as WARN findings
(exit 0), or FAIL (exit 1) with `--strict` when the repo opts in.
