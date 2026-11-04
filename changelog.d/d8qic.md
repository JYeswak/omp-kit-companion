### Changed

- release-local now cuts `origin/main` as is when it already states the release version, and after a release is public it commits the next patch version and the release's changelog section to main, so a green main commit can be released with no bump commit. A run that fails before publishing commits nothing. (NEXTVERSION1)
