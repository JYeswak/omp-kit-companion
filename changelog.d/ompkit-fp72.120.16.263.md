### Fixed
- Resume a published release's next-version advance with `scripts/release-local.sh --advance-only --version X.Y.Z`, without rebuilding, signing, publishing or installing. Unpublished or unattested releases refuse before checkout writes; completed advances are idempotent. Commit refusals retain the actual hook diagnostic and retry command instead of a manual recipe.
