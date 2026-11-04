### Changed

- release-local now cuts `origin/main` as is when it already states the release version, and after a release is public it commits the next patch version and the release's changelog section to main, so a green main commit can be released with no bump commit. A run that fails before publishing commits nothing. (NEXTVERSION1)
- README's `Current release:` line always names the latest published release. Between releases, when `package.json` already states the next patch, the README check accepts the line only while that release's tag exists, and fails closed when tags can't be read. The release's next-version commit stamps README to the version it just published. (NEXTVERSION1)
