### Fixed

- A commit whose staged TypeScript files import a path that is neither staged nor committed is now refused at commit time, not first at push. `scripts/install-commit-msg-bead.sh` installs a `pre-commit` member (`scripts/check-staged-imports.sh`) that writes the staged index, including the temporary index of `git commit --only`, as an unreferenced probe commit and runs `scripts/check-commit-imports.sh` over it; no ref moves. `--check` reports the member when missing or stale. On 2026-10-16 such commits passed every commit hook twice and forced history repairs.
