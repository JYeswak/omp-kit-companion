### Fixed

- The autocut job cuts from an owned clone of origin switched to the commit being released (not from the shared working tree, which lags main), passes `--no-install` to release-local and installs from the public assets itself, and resumes a draft that release-local kept after a transient attest failure once with `--resume-from-draft`, so a cut can publish, install and land its own next-version commit without a lead.
