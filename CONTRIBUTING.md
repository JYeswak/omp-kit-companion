---
status: current
---

# Contributing

Bug reports and focused proposals are welcome through GitHub issues. Describe the omp version, operating system, command or rule involved, expected behavior, actual behavior, and a minimal sanitized reproduction. Do not post session logs, local absolute paths, credentials, or private model transcripts.

For a rule change, add or update a fire case and a nearby quiet case in `cases/cases.tsv` before changing `rules/*.md`. Run `sh scripts/ladder.sh`; it derives the ignored `MANIFEST.tsv` from `rules/` before the gates, so a rule edit needs no paired manifest update. Release packaging also derives a fresh manifest; never commit `MANIFEST.tsv`. If using the source-maintainer `scripts/install.sh` or `doctor.sh` before the ladder, run `sh scripts/build-manifest.sh` to materialize the local file first. From a reviewed local native archive, use the standalone `installer/install.sh` and the installed `omp-kit test --json` / `omp-kit test --full --json` to verify relocated CLI behavior. The checkout's `scripts/install.sh` is a source-maintainer rule-pack installer, **not** the binary-release installer. Describe the exact command and behavior observed, including any RED gate. Do not weaken a gate to make a change pass or regenerate evidence to hide a failure.
Installed package roots use the ladder's manifest check, not its source-checkout regeneration path.

- Run the CLI suite through the load gate: `bun run --no-env-file --config=/dev/null src/cli.ts heavy --label cli-tests -- bun test tests/cli` (installed kits use `omp-kit heavy --label cli-tests -- bun test tests/cli`). Heavy commands use machine-wide slots, nice 10, and defer when one-minute LOAD1 exceeds 2.5 × logical cores; `scripts/ladder.sh` and the fresh pre-push gate apply the same admission path.

For a change to install, `doctor`, `repair`, `test --full`, `update` or `audit`, also run the real-HOME journey: `sh tests/e2e/real-home-journey.sh --previous-archive A --previous-index I --candidate-archive A --candidate-index I --work-dir DIR` (absolute paths; two archives built with `scripts/package-release.sh` at a lower and a higher version, each with a one-asset release index). It builds a HOME with more than 50,000 files, edited rules and a legacy 0755 state root, runs the README path against it, and writes `DIR/log/steps.jsonl` plus every step's stdout/stderr; it exits non-zero when any step differs from the expected table at the top of the script. CI runs it on macOS and Linux (`real-home-journey`). A realistic fixture is still not a real machine.

A pull request is a proposal, not an automatic merge commitment. The maintainer may independently implement the change after reviewing the report. For sensitive vulnerabilities, use [SECURITY.md](SECURITY.md) instead of a public issue.

## CI cadence

Every push to `main` runs the fast Linux gate (CLI contracts and the rule ladder); a newer push cancels an older run. The full set (macOS, the four native archives, the real-HOME journey and native certification) runs on every release and daily; there is no manual dispatch of `ci.yml`. For an intentional full run, dispatch the release-candidate workflow (`release.yml`). The latest-OMP check runs once a day, and only when OMP or `main` changed since its last green run. A red `main` stops everyone until whoever broke it fixes or reverts it.

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

## Release fallback when GitHub runners queue (dsr)

If a release run queues over 10 minutes (`dsr check`), build locally with dsr instead of waiting:

```sh
dsr repos add JYeswak/omp-kit-companion --local-path ~/Developer/omp-kit-companion
dsr health all
dsr build omp-kit-companion --dry-run --allow-dirty
```

The repo registry entry plus per-target definition lives in `~/.config/dsr/repos.yaml` and
`~/.config/dsr/repos.d/omp-kit-companion.yaml` (undo: `dsr repos remove omp-kit-companion`
and delete the repos.d file). A dsr build carries the same receipts as a CI build: run
`scripts/native-candidate.py` per platform and keep its receipts; a target without a
certification receipt is not published, same as step 4 of Releases above.

Known gaps 2026-10-05 (DS1 rz5.54): dsr targets use a fixed vocabulary (`linux/amd64`,
`linux/arm64`, `darwin/arm64`, `windows/amd64`) with one shared `build_cmd`, while the kit
needs four platform keys (`darwin-arm64-none`, `darwin-x64-none`, `linux-arm64-gnu`,
`linux-x64-gnu`) passed to `scripts/package-release.ts --platform`; the per-target mapping
is unverified, so even `dsr build --dry-run` stops at target resolution. The macOS remotes
(mmini, wlap) were unreachable so no native darwin build was possible; `api.github.com`
was unreachable; minisign key and `syft` are unconfigured, so dsr signing/SBOM output is
unavailable. Until those close, every archive still ships through the release workflow.

## Adopting the release procedure in another repo (PUB1c)

`scripts/release-notes.sh` carries no repo-specific paths: point it at any repo with a
`changelog.d/` directory and `vX.Y.Z` tags. To adopt:

1. Create `changelog.d/` and write one bullet per change in `changelog.d/<bead>.md`
   (fragment path must be `changelog.d/<bead>.md`; a direct commit on shipped paths
   needs a `Bead:` trailer, a `[no-changelog] <reason>` line, or a fragment naming
   the commit).
2. Tag the starting point (`git tag v0.0.0` on the adoption commit if the repo never
   released; later releases tag `vX.Y.Z` per semver).
3. Check coverage with `sh <kit>/scripts/release-notes.sh check --base-tag <tag>
   --head HEAD` run from the adopting repo (the script resolves its own directory,
   so it runs from any checkout).
4. Assemble with `assemble --base-tag … --head HEAD --version X.Y.Z --date YYYY-MM-DD`.

Verified 2026-10-05: `scripts/release-notes.ts` contains no repo-specific paths and
resolves its helpers from its own directory; the check flags the one uncovered direct
commit on this repo (`b82d3e5`, exit 1, names the commit). uds trial (first `v0.0.0`
tag, fragment convention, pilot transcript, pilot-script retire) is tracked on the
bead; signing stays in rz5.59.3.
