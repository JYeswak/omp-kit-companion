### Added
- `scripts/release-notes.sh fold`, `promote` and `notes`: drain fragments into `[Unreleased]`, cut a release section, and print a release body from `CHANGELOG.md`.
- `bun scripts/readme-check.ts` fails the pre-push gate and CI when README.md misses a registry command or doctor scope or pins a release version.
