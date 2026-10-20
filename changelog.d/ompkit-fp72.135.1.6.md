### Added

- README.md now states the current release in a generated `kit-release` block (`Current release: vX.Y.Z`) that the release train restamps on every version bump, so each tag's README names its own version; readme-check exempts the block from the version-literal rule and goes RED when the stamped version disagrees with `package.json`. (ompkit-fp72.135.1.6)
