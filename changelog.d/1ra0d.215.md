### Fixed

- `sh scripts/doc-status-check.sh .` now runs in CI's core job, and every
  status-bearing doc carries its front-matter (`README.md` is exempt:
  readme-check already guards its freshness, and the readme skill requires
  its first non-blank line to be the H1 title). `docs/INDEX.md` regenerated.
- readme-check enforces generated counts: `AGENTS.md` live scenarios against
  `tests/live/scenarios.json`'s length (70 -> 151), `docs/usage.md` install
  rules against `MANIFEST.tsv` rows (18 -> 26).
- readme-check path-lints every backticked repo-relative path in `README.md`
  and `docs/*.md` via `git ls-files`, with a reasoned allowlist; fixed the
  two dead `README` skill paths, three stale example args and one
  example path.
- readme-check tests extended with planted negatives for counts, spans,
  globs, the CLI wiring and load-bearing mutants; the staged-readme
  fixture carries the count inputs.
