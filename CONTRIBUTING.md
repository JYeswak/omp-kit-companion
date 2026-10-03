# Contributing

Bug reports and focused proposals are welcome through GitHub issues. Describe the omp version, operating system, command or rule involved, expected behavior, actual behavior, and a minimal sanitized reproduction. Do not post session logs, local absolute paths, credentials, or private model transcripts.

For a rule change, add or update a fire case and a nearby quiet case in `cases/cases.tsv` before changing `rules/*.md`. Refresh `MANIFEST.tsv` with `sh scripts/build-manifest.sh`, then run `sh scripts/ladder.sh` (which checks the manifest before the cases). From a reviewed local native archive, use the standalone `installer/install.sh` and the installed `omp-kit test --json` / `omp-kit test --full --json` to verify relocated CLI behavior. The checkout's `scripts/install.sh` is a source-maintainer rule-pack installer, **not** the binary-release installer. Describe the exact command and behavior observed, including any RED gate. Do not weaken a gate to make a change pass or regenerate evidence to hide a failure.

For a change to install, `doctor`, `repair`, `test --full`, `update` or `audit`, also run the real-HOME journey: `sh tests/e2e/real-home-journey.sh --previous-archive A --previous-index I --candidate-archive A --candidate-index I --work-dir DIR` (absolute paths; two archives built with `scripts/package-release.sh` at a lower and a higher version, each with a one-asset release index). It builds a HOME with more than 50,000 files, edited rules and a legacy 0755 state root, runs the README path against it, and writes `DIR/log/steps.jsonl` plus every step's stdout/stderr; it exits non-zero when any step differs from the expected table at the top of the script. CI runs it on macOS and Linux (`real-home-journey`). A realistic fixture is still not a real machine.

A pull request is a proposal, not an automatic merge commitment. The maintainer may independently implement the change after reviewing the report. For sensitive vulnerabilities, use [SECURITY.md](SECURITY.md) instead of a public issue.

## CI cadence

Every push to `main` runs the fast Linux gate (CLI contracts and the rule ladder); a newer push cancels an older run. The full set (macOS, the four native archives, the real-HOME journey and native certification) runs on every release, daily, or on demand (`gh workflow run ci.yml`). The latest-OMP check runs every 3 hours but only when OMP or `main` changed since its last green run. A red `main` stops everyone until whoever broke it fixes or reverts it.

## Releases

The maintainer ([JYeswak](https://github.com/JYeswak)) cuts releases. A merged user-visible change ships in a release within 7 days.

Each new merged PR adds one Markdown bullet to `changelog.d/<bead>.md`, ending in `(PR #NN)`. Keep PR notes in separate files rather than editing `CHANGELOG.md`. For a direct non-merge commit on `main`'s first-parent history since the previous tag that changes `src/`, `rules/`, `scripts/`, `extensions/`, or `installer/`, add one bullet to `changelog.d/<bead-suffix>.md`, where `<bead-suffix>` is the final component of its `Bead:` trailer (for example, `...-rz5.74` maps to `rz5.74`). Alternatively, include `[no-changelog] <reason>` in the commit body when a direct change needs no release note. The check requires coverage for every merged PR and every such direct commit, and prints each coverage source.

Before the release commit, run `sh scripts/release-notes.sh assemble --base-tag v<previous-version> --head HEAD --version <release-version> --date YYYY-MM-DD` to print the generated changelog to stdout; assembly does not modify files by default. Add `--output PATH` to save a preview elsewhere. Use `--write` only when deliberately updating `CHANGELOG.md`; it refuses local edits that differ from `--head`. Check completeness locally with `sh scripts/release-notes.sh check --base-tag v<previous-version> --head HEAD`.

A release is:

1. A commit on `main` that runs the fragment assembler, moves `CHANGELOG.md` "Unreleased" under the new version, updates the README install pin, and the package.json version (both fields).
2. A `vX.Y.Z` tag on that commit.
3. The "Unpublished release candidate" workflow (`release.yml`) run against the tag. It builds the four native archives and certifies each one on its own runner.
4. Publication of the certified archives and `release-index.json` as a GitHub release, then a fresh-HOME install from the published index.

A target that fails native certification is not published. One documented rerun of its job is allowed only when its receipt names a known, tracked upstream defect.
