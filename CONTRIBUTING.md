# Contributing

Bug reports and focused proposals are welcome through GitHub issues. Describe the omp version, operating system, command or rule involved, expected behavior, actual behavior, and a minimal sanitized reproduction. Do not post session logs, local absolute paths, credentials, or private model transcripts.

For a rule change, add or update a fire case and a nearby quiet case in `cases/cases.tsv` before changing `rules/*.md`. Refresh `MANIFEST.tsv` with `sh scripts/build-manifest.sh`, then run `sh scripts/ladder.sh` (which checks the manifest before the cases). From a reviewed local native archive, use the standalone `installer/install.sh` and the installed `omp-kit test --json` / `omp-kit test --full --json` to verify relocated CLI behavior. The checkout's `scripts/install.sh` is a source-maintainer rule-pack installer, **not** the binary-release installer. Describe the exact command and behavior observed, including any RED gate. Do not weaken a gate to make a change pass or regenerate evidence to hide a failure.

A pull request is a proposal, not an automatic merge commitment. The maintainer may independently implement the change after reviewing the report. For sensitive vulnerabilities, use [SECURITY.md](SECURITY.md) instead of a public issue.
