### Added

- `scripts/autocut.sh plan|run` picks the newest origin/main commit since the latest release whose exact tree has a main-role full-suite PASS and whose package.json version is newer and untagged (a FAIL or missing verdict falls back to the previous PASS), waits out the 12 h release floor unless `--now`, then runs `release-local.sh --version V --source SHA`, installs the release and reads the version back. The cut names an exact sha, so pushes are never frozen; every decision is one JSON line in `.git/omp-kit/autocut.log`.
- release-local runs its ci-only package-release and kit-update tests with the full suite's 120 s per-test budget instead of bun's 5 s default.
- A kit service job `autocut` runs the operator-configured `autocut.sh run` hourly (fleet-watch.json `autocut`: `{argv, cwd}`), with a 55-minute run cap; it stays UNCONFIGURED until that key is set.
