### Added

- Claim boundary: signing proves origin and integrity, not that the kit is safe or correct. `tests/cli/release-train.test.sh` now pins the signed-release shape: the publish job downloads each platform's SBOM and refuses a release missing one, and the attest-index job signs `release-index.json` with the workflow keyless identity. Removing either guard from the workflow turns its row red. (ompkit-rc-epic-land-fix-release-dogfood-rz5.59.3.4)
